import { loadClosedPositions } from "../../../src/polymarket/portfolio/gatestore.js";
// FIN-07 permanent regression, incorporating the independent EXEC-05 oracle.
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
    VALUES ('paper', 'main', '500.000000000', 'QA01:synthetic-fixture')`);
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
        taker_fee_bps, tick_size, min_order_size, neg_risk, valid_from, source_ts, received_at)
     VALUES ($1, 1, $2, '400', '0', '400', '0.01', '1', FALSE, $3, $3, $3)`,
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
      JSON.stringify([{ price: "0.49", size: "500" }]),
      JSON.stringify([{ price: "0.50", size: "500" }]),
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

import Fastify from "fastify";
import { registerPaperRoutes } from "../../../src/polymarket/paper/api.js";
import { registerResolutionRoutes } from "../../../src/polymarket/resolution/api.js";
import { writeFileSync } from "node:fs";
import {
  brokerTick,
  acceptPaperOrder,
  requestCancel,
  settlementTick,
  markTick,
} from "../../../src/polymarket/paper/brokerstore.js";
import {
  evaluateFinalEntry,
  type FinalOrderInput,
} from "../../../src/polymarket/paper/finalorder.js";
import { isFillDegraded } from "../../../src/polymarket/paper/broker.js";
import {
  appendLedgerEvent,
  loadLedgerEvents,
} from "../../../src/polymarket/paper/ledger.js";
import {
  reserveOrder,
  reconcileReservations,
} from "../../../src/polymarket/paper/reservations.js";
import { loadOwnerFinancialState } from "../../../src/polymarket/paper/financialstore.js";
import { financialOwnerKey } from "../../../src/polymarket/paper/financial.js";
import { buildPerformanceReport } from "../../../src/polymarket/paper/performance.js";
import { stampExitOrders } from "../../../src/polymarket/portfolio/exitstore.js";
import {
  parseScaled,
  formatScaled,
} from "../../../src/polymarket/fundamental/fixed.js";
const observations: any = {
  checkpoints: [],
  logs: [],
  limitations: [
    "Second strategy is a SQL reservation/ledger fixture, not a fast worker. Runtime broker ignores source=fast.",
  ],
};
const dec = (v: string) => formatScaled(parseScaled(v)!, 9);
const clock = () => NOW;
const deps = () => ({
  clock,
  logSink: (s: string) => observations.logs.push(JSON.parse(s)),
});
const advance = (ms = 100) => NOW.setTime(NOW.getTime() + ms);
const rows = async (sql: string, args: any[] = []) =>
  (await instance().query(sql, args)).rows;
async function book(bid: string, ask: string, depth = "100") {
  await instance().query(
    `INSERT INTO polymarket_book_snapshots(token_id,condition_id,received_at,source_ts,bids_json,asks_json)
  VALUES($1,$2,$3,$3,$4,$5)`,
    [
      TOKEN,
      CONDITION,
      NOW,
      JSON.stringify([{ price: bid, size: "100" }]),
      JSON.stringify([{ price: ask, size: depth }]),
    ],
  );
}
async function checkpoint(label: string, strategy: string, expected: string[]) {
  // Read physical projection before any consumer can repair it.
  if (label === "exit_partial" || label === "settled") {
    const c = (
      await rows(
        "SELECT shares,cost_basis_usd,fees_paid_usd,realized_pnl_usd FROM paper_owner_positions WHERE account_id='paper' AND strategy_id=$1 AND token_id=$2",
        [strategy, TOKEN],
      )
    )[0];
    expect(c).toMatchObject({
      shares: dec(expected[1]!),
      cost_basis_usd: dec(expected[2]!),
      fees_paid_usd: dec(expected[3]!),
      realized_pnl_usd: dec(expected[4]!),
    });
  }
  const f = await loadOwnerFinancialState(
    pool(),
    { accountId: "paper", strategyId: strategy },
    NOW,
  );
  const o = f.owners.get(financialOwnerKey("paper", strategy))!;
  const pos = o.positions.get(TOKEN);
  const r = (
    await rows(
      `SELECT coalesce(sum(cash_remaining_usd),0)::text cash,
  coalesce(sum(shares_remaining) FILTER(WHERE inventory_side IS NOT NULL),0)::text inventory
  FROM paper_order_reservations WHERE account_id='paper' AND strategy_id=$1 AND state='active'`,
      [strategy],
    )
  )[0];
  const actual = [
    o.cashUsd,
    pos?.shares ?? dec("0"),
    pos?.costBasisUsd ?? dec("0"),
    o.feesPaidUsd,
    o.realizedPnlUsd,
    o.equityUsd,
    dec(r.cash),
    dec(r.inventory),
  ];
  observations.checkpoints.push({
    label,
    strategy,
    fields: [
      "cash",
      "shares",
      "basis",
      "fees",
      "realized",
      "equity",
      "reserved_cash",
      "reserved_inventory",
    ],
    actual,
    expected: expected.map(dec),
  });
  expect(actual, label + ":" + strategy).toEqual(expected.map(dec));
  expect(
    parseScaled(o.cashUsd!)! - parseScaled(r.cash)!,
  ).toBeGreaterThanOrEqual(0n);
  if (pos) {
    const c = (
      await rows(
        `SELECT shares,cost_basis_usd,fees_paid_usd,realized_pnl_usd FROM paper_owner_positions WHERE account_id='paper' AND strategy_id=$1 AND token_id=$2`,
        [strategy, TOKEN],
      )
    )[0];
    expect(c).toMatchObject({
      shares: pos.shares,
      cost_basis_usd: pos.costBasisUsd,
      fees_paid_usd: pos.feesPaidUsd,
      realized_pnl_usd: pos.realizedPnlUsd,
    });
  }
}
async function otherOrder(
  id: string,
  size: string,
  side = "BUY",
  price = "0.60",
) {
  return pool().transaction!(async (tx) => {
    await tx.query(
      `INSERT INTO paper_orders(order_id,token_id,condition_id,side,order_type,limit_price,size,source,strategy_id,status,decided_at,accepted_at)
    VALUES($1,$2,$3,$4,'GTC',$5,$6,'fast','B','open',$7,$7)`,
      [id, TOKEN, CONDITION, side, price, size, NOW],
    );
    const reservation = await reserveOrder(tx, id, NOW);
    await appendLedgerEvent(tx, {
      idempotencyKey: id + ":accepted",
      eventType: "order_accepted",
      orderId: id,
      tokenId: TOKEN,
      conditionId: CONDITION,
      eventTs: new Date(NOW),
      payload: { side, reservation, fixture: "EXEC05:SQL seam, no worker" },
    });
  });
}
async function exitDecision() {
  return Number(
    (
      await rows(
        `INSERT INTO portfolio_decisions(decision_kind,condition_id,token_id,market_side,order_side,decision_ts,
  binding_constraint,limiters_json,config_version,config_hash,factor_map_version,oldest_input_ts,newest_input_ts,book_json,inputs_json,outcome,portfolio_state,received_at)
  VALUES('EXIT',$1,$2,'YES','SELL',$3,'NOT_SIZED','[]','fixture',$4,'fixture',$3,$3,'{}',$5,'ACCEPTED','REDUCE_ONLY',$3) RETURNING decision_id`,
        [
          CONDITION,
          TOKEN,
          NOW,
          "0".repeat(64),
          JSON.stringify({
            exit_contract_version: 1,
            account_id: "paper",
            strategy_id: "main",
            exit: {
              signature: "PORTFOLIO_LIMIT",
              signals: [{ reason: "PORTFOLIO_LIMIT" }],
            },
          }),
        ],
      )
    )[0].decision_id,
  );
}
async function durable() {
  return {
    events: await rows("SELECT * FROM paper_ledger_events ORDER BY event_id"),
    reserves: await rows(
      "SELECT to_jsonb(r)-'updated_at' AS r FROM paper_order_reservations r ORDER BY order_id",
    ),
  };
}
beforeAll(async () => {
  if (!DATABASE_URL) return;
  raw = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  await seed();
  await instance().query(
    `INSERT INTO paper_financial_owners(account_id,strategy_id,initial_cash_usd,capital_source_ref) VALUES('paper','B','500.000000000','EXEC05:synthetic partition of 1000')`,
  );
  // Fixture readiness is seeded after every input; no operational runtime is touched.
  await instance().query(`UPDATE resolution_runtime_state SET
    processed_rule_version_id=(SELECT coalesce(max(rule_version_id),0) FROM polymarket_rule_versions),
    processed_input_change_id=(SELECT coalesce(max(input_change_id),0) FROM polymarket_resolution_input_changes)`);
});
afterAll(async () => {
  if (process.env.EXEC05_OBSERVATIONS)
    writeFileSync(
      process.env.EXEC05_OBSERVATIONS,
      JSON.stringify(observations, null, 2) + "\n",
    );
  await raw?.end();
  raw = null;
});
describe.skipIf(!DATABASE_URL)(
  "FIN-07 broker, canonical cache and readers",
  () => {
    it("decision, final quantity, EV, reserve, broker partial, two owners, exit, settlement, retry/restart", async () => {
      await checkpoint("initial", "main", [
        "500",
        "0",
        "0",
        "0",
        "0",
        "500",
        "0",
        "0",
      ]);
      await checkpoint("initial", "B", [
        "500",
        "0",
        "0",
        "0",
        "0",
        "500",
        "0",
        "0",
      ]);
      const empty = await buildPerformanceReport(pool(), { now: NOW });
      expect(empty.execution.maker.sample).toBe("no_evidence");
      expect(empty.execution.taker.sample).toBe("no_evidence");
      observations.emptyPerformance = empty.execution;
      const entry = await acceptedEntry("BUY", NOW, NOW, "YES", "10.019000");
      let entryId = `portfolio:${entry}`;
      expect(
        (await bridgeTick(pool(), { ...deps(), latencyMs: 250 })).accepted,
      ).toBe(1);
      const audit = (
        await rows(
          `SELECT payload_json FROM paper_ledger_events WHERE order_id=$1 AND event_type='order_accepted'`,
          [entryId],
        )
      )[0].payload_json;
      expect(audit.final_entry_evaluation).toMatchObject({
        order: { tokenId: TOKEN, size: "10.01", side: "BUY", orderType: "FAK" },
        breakdown: {
          execPriceScaled: "0.500000000",
          feeScaled: "0.010000000",
          edgeNetScaled: "0.239000000",
        },
      });
      observations.entryAudit = audit;
      // Independent size-sensitive EV case: all 100 shares fit the limit, but the final EV fails.
      advance();
      await instance().query(
        `INSERT INTO polymarket_book_snapshots(token_id,condition_id,received_at,source_ts,bids_json,asks_json)
    VALUES($1,$2,$3,$3,'[{"price":"0.49","size":"100"}]','[{"price":"0.50","size":"1"},{"price":"0.74","size":"99"}]')`,
        [TOKEN, CONDITION, NOW],
      );
      const poor = await acceptedEntry("BUY", NOW, NOW, "YES", "100.000000");
      const poorId = `portfolio:${poor}`;
      const refusal = await acceptPaperOrder(
        pool(),
        {
          orderId: poorId,
          decisionId: poor,
          source: "portfolio",
          conditionId: CONDITION,
          draft: {
            tokenId: TOKEN,
            side: "BUY",
            orderType: "FAK",
            limitPrice: "0.74",
            worstPrice: "0.74",
            size: "100",
          },
        },
        deps(),
      );
      expect(refusal).toMatchObject({
        status: "rejected",
        reason: "FINAL_ENTRY_EV_BELOW_MARGIN",
      });
      const rejected = (
        await rows(
          `SELECT payload_json FROM paper_ledger_events WHERE order_id=$1 AND event_type='order_rejected'`,
          [poorId],
        )
      )[0].payload_json;
      expect(rejected.final_entry_evaluation).toMatchObject({
        walk: { complete: true, vwapScaled: "0.737600000" },
        breakdown: { edgeNetScaled: "0.003658150" },
      });
      const oneInput = rejected.final_entry_evaluation as FinalOrderInput;
      const one = evaluateFinalEntry({
        ...oneInput,
        order: { ...oneInput.order, size: "1.00", amountUsd: "0.7400" },
      });
      expect(one.ok).toBe(true);
      expect(one.evidence.breakdown).toMatchObject({
        edgeNetScaled: "0.239000000",
      });
      expect(
        await rows("SELECT order_id FROM paper_orders WHERE order_id=$1", [
          poorId,
        ]),
      ).toEqual([]);
      expect(
        await rows(
          "SELECT order_id FROM paper_order_reservations WHERE order_id=$1",
          [poorId],
        ),
      ).toEqual([]);
      observations.sizeRefusal = { one: one.evidence, hundred: rejected };
      advance();
      await book("0.49", "0.50");

      await checkpoint("entry_reserved", "main", [
        "500",
        "0",
        "0",
        "0",
        "0",
        "500",
        "5.1051",
        "0",
      ]);
      // FAK liquidity falls after acceptance. Fill only the six shares available at its latency instant.
      advance(50);
      await book("0.49", "0.50", "6");
      advance(260);
      const beforeFailure = {
        ...(await durable()),
        orders: await rows("SELECT * FROM paper_orders ORDER BY order_id"),
        cache: await rows(
          "SELECT * FROM paper_owner_positions ORDER BY account_id,strategy_id,token_id",
        ),
      };
      await instance()
        .query(`CREATE FUNCTION fin07_fail_cache() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'FIN07_CACHE_FAILURE'; END $$;
        CREATE TRIGGER fin07_fail_cache BEFORE INSERT OR UPDATE ON paper_owner_positions FOR EACH ROW EXECUTE FUNCTION fin07_fail_cache()`);
      const failures: string[] = [];
      await brokerTick(pool(), {
        ...deps(),
        logSink: (line) => failures.push(line),
      });
      expect(
        failures.some((line) => line.includes("FIN07_CACHE_FAILURE")),
      ).toBe(true);
      // Fill/cache transaction rolled back; the existing fail-closed handler
      // then cancels the order in a separate, audited transaction.
      const afterFailure = await durable();
      expect(afterFailure.events.slice(0, beforeFailure.events.length)).toEqual(
        beforeFailure.events,
      );
      expect(
        afterFailure.events.slice(beforeFailure.events.length),
      ).toMatchObject([{ event_type: "cancel_effective", order_id: entryId }]);
      expect(
        await rows(
          "SELECT * FROM paper_owner_positions ORDER BY account_id,strategy_id,token_id",
        ),
      ).toEqual(beforeFailure.cache);
      expect(
        (
          await rows(
            "SELECT filled_size,status FROM paper_orders WHERE order_id=$1",
            [entryId],
          )
        )[0],
      ).toEqual({ filled_size: "0", status: "canceled" });
      expect(
        (
          await rows(
            "SELECT state,cash_remaining_usd,shares_remaining FROM paper_order_reservations WHERE order_id=$1",
            [entryId],
          )
        )[0],
      ).toMatchObject({
        state: "released",
        cash_remaining_usd: "0.000000000",
        shares_remaining: "0",
      });
      await instance().query(
        "DROP TRIGGER fin07_fail_cache ON paper_owner_positions; DROP FUNCTION fin07_fail_cache()",
      );
      advance();
      await book("0.49", "0.50");
      const replacement = await acceptedEntry(
        "BUY",
        NOW,
        NOW,
        "YES",
        "10.019000",
      );
      entryId = `portfolio:${replacement}`;
      expect(
        (await bridgeTick(pool(), { ...deps(), latencyMs: 250 })).accepted,
      ).toBe(1);
      advance(50);
      await book("0.49", "0.50", "6");
      advance(510);
      await brokerTick(pool(), deps());
      expect(
        (
          await rows(
            "SELECT size,filled_size,status FROM paper_orders WHERE order_id=$1",
            [entryId],
          )
        )[0],
      ).toEqual({ size: "10.01", filled_size: "6.000000", status: "canceled" });
      await checkpoint("taker_partial_FAK", "main", [
        "496.94",
        "6",
        "3",
        "0.06",
        "-0.06",
        "499.88",
        "0",
        "0",
      ]);
      await checkpoint("taker_partial_FAK", "B", [
        "500",
        "0",
        "0",
        "0",
        "0",
        "500",
        "0",
        "0",
      ]);
      // No new shorts and no borrowing of A's inventory by B.
      await expect(otherOrder("B-oversell", "1", "SELL")).rejects.toThrow(
        "FIN05_INVENTORY_UNAVAILABLE",
      );
      await expect(otherOrder("B-overcash", "1000", "BUY")).rejects.toThrow(
        "FIN05_CASH_UNAVAILABLE",
      );
      await otherOrder("B-entry", "5");
      await checkpoint("B_reserved", "B", [
        "500",
        "0",
        "0",
        "0",
        "0",
        "500",
        "3",
        "0",
      ]);
      advance();
      const bFill = {
        idempotencyKey: "B-entry:fill",
        eventType: "fill" as const,
        orderId: "B-entry",
        tokenId: TOKEN,
        conditionId: CONDITION,
        eventTs: new Date(NOW),
        payload: {
          side: "BUY",
          price: "0.6",
          size: "5",
          fee: "0",
          taker: false,
          fee_model: "synthetic-maker-zero",
          fee_source: "EXEC05 independent fixture",
        },
      };
      await appendLedgerEvent(pool(), bFill);
      await instance().query(
        "UPDATE paper_orders SET filled_size='5',status='filled' WHERE order_id='B-entry'",
      );
      await checkpoint("B_filled", "B", [
        "497",
        "5",
        "3",
        "0",
        "0",
        "499.45",
        "0",
        "0",
      ]);
      await checkpoint("B_filled", "main", [
        "496.94",
        "6",
        "3",
        "0.06",
        "-0.06",
        "499.88",
        "0",
        "0",
      ]);
      // Fresh bid reprices both independent portfolios; it does not realize PnL.
      advance();
      await book("0.60", "0.62");
      await checkpoint("mark_060", "main", [
        "496.94",
        "6",
        "3",
        "0.06",
        "-0.06",
        "500.54",
        "0",
        "0",
      ]);
      await checkpoint("mark_060", "B", [
        "497",
        "5",
        "3",
        "0",
        "0",
        "500",
        "0",
        "0",
      ]);
      const exit = await exitDecision();
      const exitId = `portfolio:${exit}`;
      expect(
        (await bridgeTick(pool(), { ...deps(), latencyMs: 0 })).accepted,
      ).toBe(1);
      await checkpoint("exit_reserved", "main", [
        "496.94",
        "6",
        "3",
        "0.06",
        "-0.06",
        "500.54",
        "0",
        "6",
      ]);
      const competitor = await exitDecision();
      await bridgeTick(pool(), { ...deps(), latencyMs: 0 });
      expect(
        (
          await rows(
            `SELECT payload_json->>'reason' reason FROM paper_ledger_events WHERE order_id=$1 AND event_type='order_rejected'`,
            [`portfolio:${competitor}`],
          )
        ).map((r) => r.reason),
      ).toContain("EXIT_ORDER_ALREADY_OPEN");
      // Pick a reproducible nondegraded branch; no claim about empirical fill probability.
      let trade = 10000;
      while (isFillDegraded(exitId, String(trade))) trade++;
      observations.queueTrade = {
        trade,
        queue: "100",
        volume: "102",
        fill: "2",
        selection: "deterministic nondegraded branch",
      };
      advance();
      await instance().query(
        `INSERT INTO polymarket_trades(trade_id,token_id,condition_id,price,size,provenance,trade_ts,received_at) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,'0.62','102','ws',$4,$4)`,
        [trade, TOKEN, CONDITION, NOW],
      );
      advance();
      await brokerTick(pool(), deps());
      expect(
        (
          await rows("SELECT filled_size FROM paper_orders WHERE order_id=$1", [
            exitId,
          ])
        )[0].filled_size,
      ).toBe("2.000000");
      await checkpoint("exit_partial", "main", [
        "498.18",
        "4",
        "2",
        "0.06",
        "0.18",
        "500.58",
        "0",
        "4",
      ]);
      await checkpoint("exit_partial", "B", [
        "497",
        "5",
        "3",
        "0",
        "0",
        "500",
        "0",
        "0",
      ]);
      await markTick(pool(), deps());
      observations.legacyAtPartial = (
        await rows(
          "SELECT shares,cost_usd,realized_pnl_usd,fees_paid_usd FROM paper_positions WHERE token_id=$1",
          [TOKEN],
        )
      )[0];
      observations.performanceAtPartial = await buildPerformanceReport(pool(), {
        now: NOW,
      });
      const api = Fastify({ logger: false });
      const authService = { session: async () => ({ status: "ok" }) };
      registerPaperRoutes(api, {
        pool: pool() as any,
        authService,
        broker: { clock },
      });
      registerResolutionRoutes(api, {
        pool: pool() as any,
        authService,
        clock,
      });
      await api.ready();
      const physicalBeforeReads = await rows(
        "SELECT * FROM paper_owner_positions ORDER BY account_id,strategy_id,token_id",
      );
      try {
        for (const url of [
          "/polymarket/paper/positions",
          "/polymarket/resolution-risk/pipeline",
        ]) {
          const response = await api.inject({
            method: "GET",
            url,
            headers: { authorization: "Bearer fixture" },
          });
          expect(response.statusCode, response.body).toBe(200);
          const body = response.json();
          expect(body.accounting_version).toBe("financial-v2");
          const positions = body.positions.filter(
            (p: any) => p.token_id === TOKEN,
          );
          expect(positions).toHaveLength(2);
          expect(
            positions.find((p: any) => p.strategy_id === "main")
              .realized_pnl_usd,
          ).toBe("0.180000000");
          expect(
            positions.find((p: any) => p.strategy_id === "B").realized_pnl_usd,
          ).toBe("0.000000000");
        }
        const selected = await api.inject({
          method: "GET",
          url: "/polymarket/paper/positions?account_id=paper&strategy_id=main",
          headers: { authorization: "Bearer fixture" },
        });
        expect(selected.statusCode).toBe(200);
        expect(
          selected.json().positions.every((p: any) => p.strategy_id === "main"),
        ).toBe(true);
        const diagnostic = await api.inject({
          method: "GET",
          url: "/polymarket/paper/positions?accounting_version=ledger-v1",
          headers: { authorization: "Bearer fixture" },
        });
        expect(diagnostic.json().diagnostic_only).toBe(true);
      } finally {
        await api.close();
      }
      expect(
        await rows(
          "SELECT * FROM paper_owner_positions ORDER BY account_id,strategy_id,token_id",
        ),
      ).toEqual(physicalBeforeReads);
      // Preserve ledger/cache discrepancy for a separate, deliberately strict acceptance assertion.
      observations.expectedLegacyRealized = "0.180000";
      await expect(
        appendLedgerEvent(pool(), {
          ...bFill,
          idempotencyKey: "B-excess",
          payload: { ...bFill.payload, size: "1" },
        }),
      ).rejects.toThrow("FIN05_FILL_OUTSIDE_RESERVATION");
      await requestCancel(pool(), exitId, { clock });
      await checkpoint("cancel_requested", "main", [
        "498.18",
        "4",
        "2",
        "0.06",
        "0.18",
        "500.58",
        "0",
        "4",
      ]);
      const stable = await durable();
      await raw!.end();
      raw = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
      for (const strategy of ["main", "B"])
        await pool().transaction!((tx) =>
          reconcileReservations(tx, {
            accountId: "paper",
            strategyId: strategy,
          }),
        );
      const all = await loadLedgerEvents(pool());
      for (const e of [...all].reverse())
        expect(await appendLedgerEvent(pool(), e)).toBe(false);
      await brokerTick(pool(), deps());
      expect(await durable()).toEqual(stable);
      await checkpoint("restart_pending_cancel", "main", [
        "498.18",
        "4",
        "2",
        "0.06",
        "0.18",
        "500.58",
        "0",
        "4",
      ]);
      advance(1500);
      await brokerTick(pool(), { ...deps(), latencyMs: 1000 });
      await checkpoint("cancel_effective", "main", [
        "498.18",
        "4",
        "2",
        "0.06",
        "0.18",
        "500.58",
        "0",
        "0",
      ]);
      await expect(
        appendLedgerEvent(pool(), {
          ...bFill,
          idempotencyKey: "late-exit",
          orderId: exitId,
          payload: { side: "SELL", price: "0.62", size: "1", fee: "0" },
          eventTs: new Date(NOW),
        }),
      ).rejects.toThrow("FIN05_FILL_OUTSIDE_RESERVATION");
      advance();
      await instance().query(
        `INSERT INTO polymarket_markets(condition_id,question,clob_token_ids) VALUES($1,'EXEC05 synthetic',$2)`,
        [CONDITION, JSON.stringify([TOKEN, TOKEN + "-no"])],
      );
      await instance().query(
        `INSERT INTO polymarket_resolution_events(condition_id,event_type,payload_json,source_ts,received_at) VALUES($1,'market_resolved','{"outcomePrices":["1","0"]}',$2,$2)`,
        [CONDITION, NOW],
      );
      await settlementTick(pool(), deps());
      await checkpoint("settled", "main", [
        "502.18",
        "0",
        "0",
        "0.06",
        "2.18",
        "502.18",
        "0",
        "0",
      ]);
      await checkpoint("settled", "B", [
        "502",
        "0",
        "0",
        "0",
        "2",
        "502",
        "0",
        "0",
      ]);
      expect(await loadClosedPositions(pool())).toMatchObject([
        { conditionId: CONDITION, pnl: 2.18 },
      ]);
      expect(
        await loadClosedPositions(pool(), {
          accountId: "paper",
          strategyId: "B",
        }),
      ).toMatchObject([{ conditionId: CONDITION, pnl: 2 }]);
      const settled = await durable();
      await settlementTick(pool(), deps());
      await brokerTick(pool(), deps());
      expect(await durable()).toEqual(settled);
      await stampExitOrders(pool());
      const coverage =
        await rows(`SELECT d.decision_id,d.decision_kind,EXISTS(SELECT 1 FROM paper_orders o WHERE o.decision_id=d.decision_id) AS linked,
    EXISTS(SELECT 1 FROM paper_ledger_events e WHERE e.event_type='order_rejected' AND e.payload_json->>'decision_id'=d.decision_id::text AND e.payload_json->>'reason' IS NOT NULL) AS explained
    FROM portfolio_decisions d WHERE outcome='ACCEPTED'`);
      expect(coverage.length).toBe(5);
      expect(coverage.every((r) => r.linked || r.explained)).toBe(true);
      observations.decisionCoverage = coverage;
      const overflow = await rows(
        `SELECT o.order_id FROM paper_orders o JOIN paper_ledger_events e USING(order_id) WHERE event_type='fill' GROUP BY o.order_id,o.size HAVING sum((payload_json->>'size')::numeric)>o.size::numeric`,
      );
      expect(overflow).toEqual([]);
      observations.finalPerformance = await buildPerformanceReport(pool(), {
        now: NOW,
      });
      expect(observations.finalPerformance.execution.taker.fees_paid_usd).toBe(
        "0.060000",
      );
      expect(observations.finalPerformance.execution.maker.fees_paid_usd).toBe(
        "0.000000",
      );
      expect(
        observations.finalPerformance.execution.taker.realized_pnl_usd,
      ).toBe(null);
      expect(
        observations.finalPerformance.execution.maker.realized_pnl_usd,
      ).toBe("2.000000000");
    }, 30000);
    it("canonical cache/readers reconcile while v1 stays explicitly diagnostic", () => {
      expect(observations.legacyAtPartial?.realized_pnl_usd).toBe("0.089090");
      expect(observations.performanceAtPartial.accounting_version).toBe(
        "financial-v2",
      );
      expect(
        observations.performanceAtPartial.owners.find(
          (o: any) => o.strategy_id === "main",
        ).realized_pnl_usd,
      ).toBe("0.180000000");
      expect(
        observations.performanceAtPartial.owners.find(
          (o: any) => o.strategy_id === "B",
        ).realized_pnl_usd,
      ).toBe("0.000000000");
    });
  },
);
