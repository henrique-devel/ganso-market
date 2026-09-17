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
import {
  DEFAULT_PORTFOLIO_CONFIG,
  portfolioConfigHash,
} from "../../../src/polymarket/portfolio/config.js";
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
    `INSERT INTO portfolio_config_versions (version,config_hash,content_json,valid_from)
    VALUES ($1,$2,$3::jsonb,$4)`,
    [
      DEFAULT_PORTFOLIO_CONFIG.version,
      portfolioConfigHash(DEFAULT_PORTFOLIO_CONFIG),
      JSON.stringify(DEFAULT_PORTFOLIO_CONFIG),
      new Date(NOW.getTime() - 86400000),
    ],
  );
  await p.query(`INSERT INTO paper_financial_owners
    (account_id, strategy_id, initial_cash_usd, capital_source_ref)
    VALUES ('paper', 'main', '1000.000000000', 'QA01:synthetic-fixture')`);
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
    `INSERT INTO polymarket_book_snapshots
       (token_id, condition_id, received_at, source_ts, bids_json, asks_json)
     VALUES ($1,$2,$3,$3,$4::jsonb,$5::jsonb)`,
    [
      `${TOKEN}-no`,
      CONDITION,
      new Date(NOW.getTime() - 2_000),
      JSON.stringify([{ price: "0.12", size: "500" }]),
      JSON.stringify([{ price: "0.15", size: "500" }]),
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
  receivedAt: Date = new Date(decidedAt.getTime() + 1_000),
  marketSide: "YES" | "NO" = side === "BUY" ? "YES" : "NO",
  size = "20.000000",
): Promise<number> {
  const result = await pool().query<{ decision_id: string | number }>(
    `INSERT INTO portfolio_decisions
       (decision_kind, condition_id, token_id, market_side, order_side,
        decision_ts, q, q_lo, q_hi, estimate_source, exec_price, worst_price,
        best_price, size_shares, kelly_cap_shares, notional_usd,
        binding_constraint, limiters_json, config_version, config_hash,
        factor_map_version, rule_version, param_version, resolution_action,
        oldest_input_ts, newest_input_ts, book_json, inputs_json, outcome,
        portfolio_state, received_at)
     VALUES ('ENTRY',$1,$2,$3,$4,$5,'0.800000','0.750000','0.850000',
             'MARKET_BASELINE','0.620000','0.620000','0.620000',$10,
             '40.000000','12.400000','CAP_ENTRADA','[]'::jsonb,$11,$6,
             '1.0.0',1,1,'NONE',$7,$7,'{}'::jsonb,$8::jsonb,'ACCEPTED','NORMAL',
             $9)
     RETURNING decision_id`,
    [
      CONDITION,
      marketSide === "NO" && side === "BUY" ? `${TOKEN}-no` : TOKEN,
      marketSide,
      side,
      decidedAt,
      portfolioConfigHash(DEFAULT_PORTFOLIO_CONFIG),
      new Date(decidedAt.getTime() - 1_000),
      JSON.stringify({
        entry_contract_version: 2,
        account_id: "paper",
        strategy_id: "main",
        panel: {
          resolution_source: "UMA:0xadapter",
          invalidation: { prob_lower_below: "0.621000" },
        },
        replay: {
          rule_precision_multiplier: 0.9,
          expected_lockup_s: 0,
          buffer_daily_hurdle: 0,
          resolution_buffer: "0.001",
        },
      }),
      receivedAt,
      size,
      DEFAULT_PORTFOLIO_CONFIG.version,
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
  // The runner drops this isolated database; HOLD forbids row cleanup.
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
      expect(payload.final_entry_evaluation).toMatchObject({
        version: "final-entry-v1",
        reason: "FINAL_ENTRY_ACCEPTED",
        order: { tokenId: TOKEN, size: "20.00", orderType: "FAK" },
        breakdown: {
          execPriceScaled: "0.620000000",
          feeScaled: "0.016492000",
          edgeNetScaled: "0.112508000",
        },
      });
      expect(payload.reservation).toMatchObject({
        account_id: "paper",
        strategy_id: "main",
        price_bound: "0.620000000",
        fee_per_share: "0.017500000",
      });
      const reserve = await pool().query(
        `SELECT cash_remaining_usd FROM paper_order_reservations WHERE order_id=$1`,
        [`portfolio:${String(decisionId)}`],
      );
      expect(reserve.rows[0]?.cash_remaining_usd).toBe("12.750000000");
      expect(payload.source).toBe("portfolio");
      expect(Number(payload.decision_id)).toBe(decisionId);
    });

    it("buys the real NO token against 1 - q_hi using its own book", async () => {
      // q_hi YES = 0.85 gives a NO bound of 0.15. At ask 0.15 the fee
      // prevents a take; the passive BUY must stay inside that bound.
      const decisionId = await acceptedEntry(
        "BUY",
        DECIDED_AT,
        new Date(DECIDED_AT.getTime() + 1_000),
        "NO",
      );
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
        `SELECT token_id, side, order_type, limit_price, post_only, policy_reason
           FROM paper_orders WHERE decision_id = $1`,
        [decisionId],
      );
      expect(order.rows[0]).toMatchObject({
        token_id: `${TOKEN}-no`,
        side: "BUY",
        order_type: "GTC",
        post_only: true,
        limit_price: "0.12",
      });
      expect(String(order.rows[0]?.policy_reason)).toContain("DEFAULT_PASSIVE");
    });

    it("refuses legacy synthetic NO entries without creating a SELL order", async () => {
      const decisionId = await acceptedEntry("SELL");
      const lines: string[] = [];
      await bridgeTick(pool(), {
        clock: () => NOW,
        logSink: (line) => lines.push(line),
      });
      expect(
        logsOf(lines).find((line) => line.decision_id === decisionId),
      ).toMatchObject({
        reason_code: "BRIDGE_DECISION_SKIPPED",
        reason: "FIN06_LEGACY_ENTRY_REQUIRES_REEVALUATION",
      });
      const orders = await pool().query(
        "SELECT order_id FROM paper_orders WHERE decision_id=$1",
        [decisionId],
      );
      expect(orders.rows).toEqual([]);
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

    it("acts on the production shape: decided 45 s ago, logged 5 s ago", async () => {
      // RFC-022 D1 against the server, which is the only place the two new
      // bounds are really a WHERE clause. Under the 30 s bound on `decision_ts`
      // this row was invisible; production lost 86 of 94 accepted entries this
      // way, with the two clocks phase-locked so that the one tick able to see
      // the row always saw it already expired.
      const decisionId = await acceptedEntry(
        "BUY",
        new Date(NOW.getTime() - 45_000),
        new Date(NOW.getTime() - 5_000),
      );
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
      const order = await pool().query<{ count: string }>(
        `SELECT count(*) AS count FROM paper_orders WHERE decision_id = $1`,
        [decisionId],
      );
      expect(order.rows[0]?.count).toBe("1");
      expect(outcome.accepted).toBeGreaterThanOrEqual(1);
    });

    it("refuses a decision past the 90 s ceiling however fresh the log entry is", async () => {
      // A wedged portfolio cycle unwedging must not dump old decisions on a
      // live book: `received_at` is brand new here and the row is still refused.
      const decisionId = await acceptedEntry(
        "BUY",
        new Date(NOW.getTime() - 95_000),
        new Date(NOW.getTime() - 1_000),
      );
      await bridgeTick(pool(), {
        clock: () => NOW,
        logSink: () => undefined,
      });
      const order = await pool().query<{ count: string }>(
        `SELECT count(*) AS count FROM paper_orders WHERE decision_id = $1`,
        [decisionId],
      );
      expect(order.rows[0]?.count).toBe("0");
    });

    it("keeps decisions received before this process booted out of aged_out", async () => {
      // One planted row, aged out, received 5 minutes ago. Asserted as a
      // difference and not as an absolute zero: AGED_OUT_SQL is not scoped to a
      // token, so a shared test database contributes rows this suite does not
      // own.
      const receivedAt = new Date(NOW.getTime() - 300_000);
      await acceptedEntry("BUY", new Date(NOW.getTime() - 301_000), receivedAt);
      const tick = async (bootAt: Date): Promise<number> =>
        (
          await bridgeTick(pool(), {
            clock: () => NOW,
            bootAt,
            logSink: () => undefined,
          })
        ).agedOut;

      const bootAfterTheRow = await tick(
        new Date(receivedAt.getTime() + 1_000),
      );
      const bootBeforeTheRow = await tick(
        new Date(receivedAt.getTime() - 1_000),
      );
      expect(bootBeforeTheRow).toBe(bootAfterTheRow + 1);
    });
    function onlyDecision(id: number): PaperPool {
      const base = pool();
      return {
        ...base,
        query(text, params) {
          return base.query(
            text.replace(
              "WHERE d.outcome",
              `WHERE d.decision_id=${id} AND d.outcome`,
            ),
            params,
          );
        },
      };
    }
    async function snapshot(
      asks: { price: string; size: string }[],
      bid = "0.49",
    ) {
      NOW.setTime(NOW.getTime() + 100);
      await pool().query(
        `INSERT INTO polymarket_book_snapshots
        (token_id,condition_id,received_at,source_ts,bids_json,asks_json)
        VALUES ($1,$2,$3,$3,$4::jsonb,$5::jsonb)`,
        [
          TOKEN,
          CONDITION,
          NOW,
          JSON.stringify([{ price: bid, size: "500" }]),
          JSON.stringify(asks),
        ],
      );
    }
    async function audit(decisionId: number, type: string) {
      const rows = await pool().query(
        `SELECT payload_json FROM paper_ledger_events
        WHERE order_id=$1 AND event_type=$2 ORDER BY event_id DESC LIMIT 1`,
        [`portfolio:${decisionId}`, type],
      );
      return rows.rows[0]?.payload_json as Record<string, any>;
    }
    async function noReservation(decisionId: number) {
      const rows = await pool().query(
        `SELECT order_id FROM paper_order_reservations WHERE order_id=$1`,
        [`portfolio:${decisionId}`],
      );
      expect(rows.rowCount).toBe(0);
      expect(
        (
          await pool().query(
            `SELECT order_id FROM paper_orders WHERE decision_id=$1`,
            [decisionId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await pool().query(
            `SELECT outcome, paper_order_id FROM portfolio_decisions WHERE decision_id=$1`,
            [decisionId],
          )
        ).rows[0],
      ).toMatchObject({ outcome: "ACCEPTED", paper_order_id: null });
    }
    it("EXEC-02 refuses the final 100-share maker fallback on a one-share book before reserving", async () => {
      await snapshot([{ price: "0.50", size: "1" }]);
      const id = await acceptedEntry("BUY", NOW, NOW, "YES", "100.000000");
      await bridgeTick(onlyDecision(id), {
        clock: () => NOW,
        logSink: () => undefined,
      });
      await noReservation(id);
      const event = await audit(id, "order_rejected");
      expect(event.reason).toBe("BOOK_WALK_INCOMPLETE");
      expect(event.final_entry_evaluation).toMatchObject({
        order: { size: "100.00", postOnly: true },
        book: { tokenId: TOKEN, asks: [{ price: "0.50", size: "1" }] },
      });
    });
    it("EXEC-02 refuses a book changed after quoting; the refused snapshot is persisted", async () => {
      await snapshot([{ price: "0.50", size: "500" }]);
      const id = await acceptedEntry("BUY", NOW, NOW, "YES", "5.000000");
      const base = onlyDecision(id);
      let changed = false;
      await bridgeTick(
        {
          ...base,
          async transaction(run) {
            if (!changed) {
              changed = true;
              await snapshot([
                { price: "0.50", size: "1" },
                { price: "0.60", size: "499" },
              ]);
            }
            return base.transaction!(run);
          },
        },
        { clock: () => NOW, logSink: () => undefined },
      );
      await noReservation(id);
      const event = await audit(id, "order_rejected");
      expect(event.reason).toBe("FINAL_ENTRY_PRICE_BOUND");
      expect(event.intent.quote.book.asks).toEqual([
        { price: "0.50", size: "500" },
      ]);
      expect(event.final_entry_evaluation.book.asks).toEqual([
        { price: "0.50", size: "1" },
        { price: "0.60", size: "499" },
      ]);
      expect(event.final_entry_evaluation.evaluation_id).toMatch(
        /^[a-f0-9]{64}$/,
      );
    });
    it("EXEC-02 re-evaluates an improved book and reserves the exact normalized order", async () => {
      await snapshot([{ price: "0.62", size: "500" }], "0.60");
      const id = await acceptedEntry("BUY", NOW, NOW, "YES", "5.019000");
      const base = onlyDecision(id);
      let changed = false;
      await bridgeTick(
        {
          ...base,
          async transaction(run) {
            if (!changed) {
              changed = true;
              await snapshot([{ price: "0.61", size: "500" }], "0.60");
            }
            return base.transaction!(run);
          },
        },
        { clock: () => NOW, logSink: () => undefined },
      );
      const event = await audit(id, "order_accepted");
      expect(event.intent.quote.book.asks).toEqual([
        { price: "0.62", size: "500" },
      ]);
      expect(event.final_entry_evaluation).toMatchObject({
        order: { size: "5.01", limitPrice: "0.62" },
        book: { asks: [{ price: "0.61", size: "500" }] },
        breakdown: {
          execPriceScaled: "0.610000000",
          feeScaled: "0.016653000",
          edgeNetScaled: "0.122347000",
        },
      });
      const reserved = await pool().query(
        `SELECT shares_remaining,cash_remaining_usd FROM paper_order_reservations WHERE order_id=$1`,
        [`portfolio:${id}`],
      );
      expect(reserved.rows[0]).toMatchObject({
        shares_remaining: "5.01",
        cash_remaining_usd: "3.193875000",
      });
    });
    it("EXEC-02 refuses final EV below the unchanged margin even when policy chose taker", async () => {
      await snapshot([{ price: "0.72", size: "500" }], "0.71");
      const id = await acceptedEntry("BUY", NOW, NOW, "YES", "5.000000");
      await bridgeTick(onlyDecision(id), {
        clock: () => NOW,
        logSink: () => undefined,
      });
      await noReservation(id);
      const event = await audit(id, "order_rejected");
      // .75 - .72 - (.07*.72*.28) - .001 = .014888 < existing .02 floor.
      expect(event.reason).toBe("FINAL_ENTRY_EV_BELOW_MARGIN");
      expect(event.final_entry_evaluation).toMatchObject({
        order: { orderType: "FAK" },
        breakdown: { feeScaled: "0.014112000", edgeNetScaled: "0.014888000" },
      });
    });
    it("EXEC-02 pins the fee through reservation without deadlocking a source writer", async () => {
      await snapshot([{ price: "0.50", size: "500" }]);
      const id = await acceptedEntry("BUY", NOW, NOW, "YES", "5.000000");
      const base = onlyDecision(id);
      const writer = await instance().connect();
      await writer.query("BEGIN");
      const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid;
      let pending: Promise<unknown> | null = null;
      const lines: string[] = [];
      try {
        await bridgeTick(
          {
            ...base,
            transaction(run) {
              return base.transaction!((tx) =>
                run({
                  async query<R extends Record<string, unknown>>(
                    text: string,
                    params: readonly unknown[] = [],
                  ) {
                    const result = await tx.query<R>(text, params);
                    if (
                      text ===
                        "LOCK TABLE polymarket_resolution_input_changes IN SHARE MODE" &&
                      pending === null
                    ) {
                      // The writer owns its source table, then waits on the journal
                      // held by acceptance. Acceptance must never wait on that source.
                      pending = writer
                        .query(
                          `INSERT INTO polymarket_param_versions
                (condition_id,version,content_hash,maker_fee_bps,taker_fee_bps,tick_size,min_order_size,neg_risk,valid_from)
                VALUES ($1,2,$2,'0','400','0.01','5',FALSE,$3)`,
                          [CONDITION, "e".repeat(64), NOW],
                        )
                        .then(
                          () => null,
                          (error) => error,
                        );
                      const deadline = Date.now() + 5000;
                      let blocked = false;
                      while (Date.now() < deadline) {
                        blocked =
                          (
                            await instance().query(
                              `SELECT 1 FROM pg_locks WHERE pid=$1
                  AND relation='polymarket_resolution_input_changes'::regclass AND NOT granted`,
                              [pid],
                            )
                          ).rowCount! > 0;
                        if (blocked) break;
                        await new Promise((resolve) => setTimeout(resolve, 10));
                      }
                      expect(blocked).toBe(true);
                    }
                    return result;
                  },
                }),
              );
            },
          },
          { clock: () => NOW, logSink: (line) => lines.push(line) },
        );
        expect(await pending).toBeNull();
        await writer.query("COMMIT");
        const event = await audit(id, "order_accepted");
        expect(event, lines.join("\n")).toBeDefined();
        expect(event.final_entry_evaluation.fee.rate).toBe("0.070000000");
        expect(event.final_entry_evaluation.breakdown.feeScaled).toBe(
          "0.017500000",
        );
        expect(event.reservation.fee_per_share).toBe("0.017500000");
        expect(
          (
            await pool().query(
              `SELECT cash_remaining_usd FROM paper_order_reservations WHERE order_id=$1`,
              [`portfolio:${id}`],
            )
          ).rows[0]?.cash_remaining_usd,
        ).toBe("2.587500000");
      } finally {
        await pending;
        await writer.query("ROLLBACK");
        writer.release();
        await pool()
          .query(`UPDATE resolution_runtime_state SET processed_input_change_id=
          (SELECT COALESCE(max(input_change_id),0) FROM polymarket_resolution_input_changes)`);
      }
    });

    it("EXEC-02 refuses fee lost between the taker quote and acceptance", async () => {
      await snapshot([{ price: "0.50", size: "500" }]);
      const id = await acceptedEntry("BUY", NOW, NOW, "YES", "5.000000");
      const lines: string[] = [];
      const base = onlyDecision(id);
      let changed = false;
      await bridgeTick(
        {
          ...base,
          async transaction(run) {
            if (!changed) {
              changed = true;
              NOW.setTime(NOW.getTime() + 100);
              await pool().query(
                `INSERT INTO polymarket_param_versions
            (condition_id,version,content_hash,maker_fee_bps,taker_fee_bps,tick_size,min_order_size,neg_risk,valid_from)
            VALUES ($1,3,$2,'0',NULL,'0.01','5',FALSE,$3)`,
                [CONDITION, "d".repeat(64), NOW],
              );
              await pool()
                .query(`UPDATE resolution_runtime_state SET processed_input_change_id=
                (SELECT COALESCE(max(input_change_id),0) FROM polymarket_resolution_input_changes)`);
            }
            return base.transaction!(run);
          },
        },
        { clock: () => NOW, logSink: (line) => lines.push(line) },
      );
      await noReservation(id);
      const event = await audit(id, "order_rejected");
      expect(event, lines.join("\n")).toBeDefined();
      expect(event.reason).toBe("TAKER_FEE_UNVERIFIED");
      expect(event.intent.quote.policy.orderType).toBe("FAK");
      expect(event.final_entry_evaluation.fee.rate).toBeNull();
    });
  },
);
