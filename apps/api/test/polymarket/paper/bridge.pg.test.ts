// The RFC-013 bridge end to end, against real PostgreSQL. Skipped in the
// source-only gate; point GANSO_TEST_DATABASE_URL at a migrated throwaway
// database to run it.
//
// SIMULAÇÃO — SEM EXECUÇÃO REAL: every order here is a row in paper_orders.
//
// Why this file exists as well as bridge.test.ts: the unit suite proves what the
// bridge DECIDES with a fake pool, and a fake pool cannot prove that an order
// comes out the other end. The acceptance path locks the resolution inputs,
// re-reads the runtime under `FOR SHARE`, evaluates the veto policy twice around
// the write and runs inside a transaction — none of which a substring-matching
// fake exercises. Production is the only other place that would have found a
// mistake here, and the bridge exists precisely because production had two
// accepted entries and zero positions.

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SqlExecutor } from "../../../src/database.js";
import { bridgeTick } from "../../../src/polymarket/paper/bridge.js";
import type { PaperPool } from "../../../src/polymarket/paper/brokerstore.js";

const DATABASE_URL = process.env.GANSO_TEST_DATABASE_URL;
const RUN = `${String(process.pid)}-${String(Date.now())}`;
const CONDITION = `0xbridge-${RUN}`;
const TOKEN = `tok-bridge-${RUN}`;
const NOW = new Date();
const DECIDED_AT = new Date(NOW.getTime() - 5_000);

let raw: pg.Pool | null = null;

function instance(): pg.Pool {
  if (raw === null) {
    throw new Error("pool not initialised");
  }
  return raw;
}

function wrap(client: pg.PoolClient | pg.Pool): SqlExecutor {
  return {
    async query<R extends Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ) {
      const result = await client.query<R>(text, params as unknown[]);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
  };
}

/**
 * A pool that can open a transaction, which the acceptance path requires: with
 * only `query` it refuses every order with
 * PAPER_BROKER_TRANSACTION_UNAVAILABLE, and the test would be asserting a
 * refusal it caused itself.
 */
function pool(): PaperPool {
  const base = wrap(instance());
  return {
    query: base.query.bind(base),
    async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const client = await instance().connect();
      try {
        await client.query("BEGIN");
        const out = await run(wrap(client));
        await client.query("COMMIT");
        return out;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function seed(): Promise<void> {
  const p = pool();
  await p.query(
    `INSERT INTO polymarket_market_metadata_versions
       (condition_id, version, question, category, clob_token_ids,
        affirmative_token_id, valid_from)
     VALUES ($1, 1, $2, 'crypto', $3::jsonb, $4, $5)`,
    [
      CONDITION,
      "Will ETH be above $4,000?",
      JSON.stringify([TOKEN, `${TOKEN}-no`]),
      TOKEN,
      new Date(NOW.getTime() - 86_400_000),
    ],
  );
  await p.query(
    `INSERT INTO polymarket_rule_versions
       (condition_id, version, content_hash, description, resolution_source,
        resolved_by, end_date, valid_from)
     VALUES ($1, 1, $2, 'Resolves YES above $4,000.', NULL, 'UMA:0xadapter',
             $3, $4)`,
    [
      CONDITION,
      "a".repeat(64),
      new Date(NOW.getTime() + 86_400_000),
      new Date(NOW.getTime() - 86_400_000),
    ],
  );
  await p.query(
    `INSERT INTO polymarket_param_versions
       (condition_id, version, content_hash, fee_base_bps, maker_fee_bps,
        taker_fee_bps, tick_size, min_order_size, neg_risk, valid_from)
     VALUES ($1, 1, $2, '700', '0', '700', '0.01', '5', FALSE, $3)`,
    [CONDITION, "b".repeat(64), new Date(NOW.getTime() - 86_400_000)],
  );
  await p.query(
    `INSERT INTO polymarket_book_snapshots
       (token_id, condition_id, received_at, source_ts, bids_json, asks_json)
     VALUES ($1, $2, $3, $3, $4::jsonb, $5::jsonb)`,
    [
      TOKEN,
      CONDITION,
      new Date(NOW.getTime() - 2_000),
      JSON.stringify([{ price: "0.61", size: "500" }]),
      JSON.stringify([{ price: "0.62", size: "500" }]),
    ],
  );
  await p.query(
    `INSERT INTO resolution_market_state
       (condition_id, action, effective_action, resolution_buffer, p_5050,
        expected_lockup_s, dispute_active, computed_at)
     VALUES ($1, 'NONE', 'NONE', '0.001000', '0.010000', 3600, FALSE, $2)`,
    [CONDITION, new Date(NOW.getTime() - 60_000)],
  );
  // The runtime handshake goes in LAST, and its processed cursors are read from
  // the live heads: every fixture above moves a head, and a runtime behind a
  // head is a LAGGING refusal rather than a bridge failure.
  await p.query(
    `INSERT INTO resolution_runtime_state
       (runtime_id, generation, score_version, ready, started_at, ready_at,
        last_success_at, heartbeat_at, lease_expires_at, graph_evaluated_at,
        graph_valid_until, processed_resolution_event_id,
        processed_rule_version_id, processed_input_change_id)
     SELECT 1, gen_random_uuid(), '1.0.0', TRUE, now(), now(), now(), now(),
            now() + interval '1 hour', now(), now() + interval '1 hour',
            (SELECT COALESCE(MAX(resolution_event_id), 0)
               FROM polymarket_resolution_events),
            (SELECT COALESCE(MAX(rule_version_id), 0)
               FROM polymarket_rule_versions),
            (SELECT COALESCE(MAX(input_change_id), 0)
               FROM polymarket_resolution_input_changes)
     ON CONFLICT (runtime_id) DO UPDATE SET
       ready = TRUE,
       ready_at = now(),
       last_success_at = now(),
       stopped_at = NULL,
       lease_expires_at = now() + interval '1 hour',
       graph_evaluated_at = now(),
       graph_valid_until = now() + interval '1 hour',
       processed_resolution_event_id = EXCLUDED.processed_resolution_event_id,
       processed_rule_version_id = EXCLUDED.processed_rule_version_id,
       processed_input_change_id = EXCLUDED.processed_input_change_id`,
  );
}

/**
 * An accepted ENTRY, written the way the portfolio runner writes one.
 *
 * `decidedAt` is a parameter and not something a test can adjust afterwards: the
 * decision log is append-only by trigger, and only `paper_order_id` may ever be
 * written to an existing row. Aging a decision means inserting it aged.
 */
async function acceptedEntry(
  side: "BUY" | "SELL" = "BUY",
  decidedAt: Date = DECIDED_AT,
): Promise<number> {
  const result = await pool().query<{ decision_id: string | number }>(
    `INSERT INTO portfolio_decisions
       (decision_kind, condition_id, token_id, market_side, order_side,
        decision_ts, q, q_lo, q_hi, estimate_source, exec_price, worst_price,
        best_price, size_shares, kelly_cap_shares, notional_usd,
        binding_constraint, limiters_json, config_version, config_hash,
        factor_map_version, rule_version, param_version, resolution_action,
        oldest_input_ts, newest_input_ts, book_json, inputs_json, outcome,
        portfolio_state)
     VALUES ('ENTRY',$1,$2,$3,$4,$5,'0.800000','0.750000','0.850000',
             'MARKET_BASELINE','0.620000','0.620000','0.620000','20.000000',
             '40.000000','12.400000','CAP_ENTRADA','[]'::jsonb,'1.2.0',$6,
             '1.0.0',1,1,'NONE',$7,$7,'{}'::jsonb,$8::jsonb,'ACCEPTED','NORMAL')
     RETURNING decision_id`,
    [
      CONDITION,
      TOKEN,
      side === "BUY" ? "YES" : "NO",
      side,
      decidedAt,
      "c".repeat(64),
      new Date(decidedAt.getTime() - 1_000),
      JSON.stringify({
        panel: {
          resolution_source: "UMA:0xadapter",
          invalidation: { prob_lower_below: "0.621000" },
        },
        replay: { rule_precision_multiplier: 0.9 },
      }),
    ],
  );
  return Number(result.rows[0]?.decision_id ?? 0);
}

function logsOf(lines: string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeAll(async () => {
  if (DATABASE_URL === undefined) {
    return;
  }
  raw = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  await seed();
});

afterAll(async () => {
  // The decision log is append-only for UPDATE, not for DELETE — retention
  // prunes it. Cleaning up this run's rows keeps the shared test database from
  // accumulating accepted entries that other suites would then read.
  if (raw !== null) {
    const p = pool();
    // The ledger is immutable for DELETE as well as UPDATE, so its acceptance
    // events stay. They are harmless: no fill was ever appended, so nothing
    // reconstructs a position or a P&L from them.
    await p.query(`DELETE FROM paper_orders WHERE token_id = $1`, [TOKEN]);
    await p.query(`DELETE FROM portfolio_decisions WHERE token_id = $1`, [
      TOKEN,
    ]);
  }
  await raw?.end();
  raw = null;
});

describe.skipIf(DATABASE_URL === undefined)(
  "RFC-013 bridge against real PostgreSQL",
  () => {
    it("turns an accepted entry into a simulated order that names its decision", async () => {
      const decisionId = await acceptedEntry();
      const lines: string[] = [];
      const outcome = await bridgeTick(pool(), {
        clock: () => NOW,
        logSink: (line) => lines.push(line),
      });
      const logs = logsOf(lines);
      const skipped = logs.find(
        (line) =>
          line.reason_code === "BRIDGE_DECISION_SKIPPED" &&
          line.decision_id === decisionId,
      );
      // Assert the reason before anything else: a refusal here would otherwise
      // show up only as a missing order, with no clue which gate refused.
      expect(skipped).toBeUndefined();
      expect(outcome.accepted).toBeGreaterThanOrEqual(1);

      const order = await pool().query<Record<string, unknown>>(
        `SELECT order_id, source, decision_id, side, order_type, limit_price,
                worst_price, size, post_only, status, policy_reason
           FROM paper_orders WHERE decision_id = $1`,
        [decisionId],
      );
      expect(order.rows[0]).toMatchObject({
        order_id: `portfolio:${String(decisionId)}`,
        source: "portfolio",
        side: "BUY",
        status: "open",
        size: "20.00",
        // The bridge handed the policy q_lo = 0.75 against an ask of 0.62, so
        // the taker branch clears fee plus margin and the order is an FAK whose
        // limit IS the book-walk's worst price. This is the assertion that
        // proves the conservative bound actually reached the policy: with a
        // bound below the ask the same book would have produced a passive quote.
        order_type: "FAK",
        limit_price: "0.62",
        worst_price: "0.62",
        post_only: false,
        policy_reason: "TAKER_EDGE_EXCEEDS_FEE",
      });

      // The acceptance is in the ledger too, carrying the decision, which is
      // what makes the audit trail survive the decision log's own pruning.
      const ledger = await pool().query<Record<string, unknown>>(
        `SELECT payload_json FROM paper_ledger_events
          WHERE order_id = $1 AND event_type = 'order_accepted'`,
        [`portfolio:${String(decisionId)}`],
      );
      const payload = ledger.rows[0]?.payload_json as Record<string, unknown>;
      expect(payload.source).toBe("portfolio");
      expect(Number(payload.decision_id)).toBe(decisionId);
    });

    it("quotes the NO leg against q_hi, so the same book does not take", async () => {
      // The NO leg is a SELL of the affirmative token. Its conservative bound is
      // q_hi = 0.85, and selling at a bid of 0.61 does not beat 0.85 — so the
      // taker branch must NOT fire, and the order rests. Under the old-style
      // mistake of passing q_lo for a sell, the bound would be 0.75 and this
      // book would look like a profitable take.
      const decisionId = await acceptedEntry("SELL");
      const lines: string[] = [];
      const outcome = await bridgeTick(pool(), {
        clock: () => NOW,
        logSink: (line) => lines.push(line),
      });
      const skipped = logsOf(lines).find(
        (line) =>
          line.reason_code === "BRIDGE_DECISION_SKIPPED" &&
          line.decision_id === decisionId,
      );
      expect(skipped).toBeUndefined();
      expect(outcome.accepted).toBeGreaterThanOrEqual(1);
      const order = await pool().query<Record<string, unknown>>(
        `SELECT order_type, limit_price, post_only, policy_reason
           FROM paper_orders WHERE decision_id = $1`,
        [decisionId],
      );
      expect(order.rows[0]).toMatchObject({
        order_type: "GTC",
        post_only: true,
        limit_price: "0.62",
      });
      expect(String(order.rows[0]?.policy_reason)).toContain("DEFAULT_PASSIVE");
    });

    it("does not act twice on the same decision, even before the stamp lands", async () => {
      // The portfolio stamps `paper_order_id` on its own next cycle, up to a
      // minute later. Until then the decision still looks unstamped, so a second
      // tick in that window is the realistic case and must be a no-op.
      const count = async (): Promise<string | undefined> =>
        (
          await pool().query<{ count: string }>(
            `SELECT count(*) AS count FROM paper_orders WHERE token_id = $1`,
            [TOKEN],
          )
        ).rows[0]?.count;
      const before = await count();
      await bridgeTick(pool(), { clock: () => NOW, logSink: () => undefined });
      expect(await count()).toBe(before);
    });

    it("drops a decision that aged out instead of executing it late", async () => {
      const stale = await acceptedEntry(
        "BUY",
        new Date(NOW.getTime() - 600_000),
      );
      const lines: string[] = [];
      const outcome = await bridgeTick(pool(), {
        clock: () => NOW,
        logSink: (line) => lines.push(line),
      });
      expect(outcome.agedOut).toBeGreaterThanOrEqual(1);
      const tick = logsOf(lines).find(
        (line) => line.reason_code === "BRIDGE_TICK",
      );
      expect(tick).toMatchObject({ level: "warn" });
      const orders = await pool().query<{ count: string }>(
        `SELECT count(*) AS count FROM paper_orders WHERE decision_id = $1`,
        [stale],
      );
      expect(orders.rows[0]?.count).toBe("0");
    });
  },
);
