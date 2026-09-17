// EXEC-04: real PostgreSQL transactions, production guards, nonempty EXIT sample.
import { setTimeout } from "node:timers/promises";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import type pg from "pg";
import type { SqlExecutor } from "../../../src/database.js";
import { createPgFixture } from "../../pg-fixture.js";
import {
  bridgeTick,
  bridgeOrderId,
} from "../../../src/polymarket/paper/bridge.js";
import {
  acceptPaperOrder,
  brokerTick,
  requestCancel,
  exitInventory,
  type PaperPool,
  type AcceptInput,
} from "../../../src/polymarket/paper/brokerstore.js";
import { appendLedgerEvent } from "../../../src/polymarket/paper/ledger.js";
import {
  stampExitOrders,
  lastExitSignature,
  entryProvenanceFor,
} from "../../../src/polymarket/portfolio/exitstore.js";

const url = process.env.GANSO_TEST_DATABASE_URL;
const now = new Date();
const earlier = new Date(now.getTime() - 10000);
let fixture: Awaited<ReturnType<typeof createPgFixture>>;
let raw: pg.Pool;
let pool: PaperPool;
function wrap(db: pg.Pool | pg.PoolClient): SqlExecutor {
  return {
    async query<R extends Record<string, unknown>>(
      sql: string,
      args: readonly unknown[] = [],
    ) {
      const r = await db.query<R>(sql, [...args]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
  };
}
const clock = () => now;
const quiet = () => undefined;

async function book(token: string) {
  await raw.query(
    `INSERT INTO polymarket_book_snapshots(token_id,condition_id,received_at,source_ts,bids_json,asks_json)
    VALUES ($1,'market',$2,$2,'[{"price":"0.60","size":"100"}]','[{"price":"0.62","size":"100"}]')`,
    [token, now],
  );
}
async function decision(
  token = "yes",
  side = "SELL",
  owner = "main",
  accepted = true,
) {
  const row = await raw.query(
    `INSERT INTO portfolio_decisions
    (decision_kind,condition_id,token_id,market_side,order_side,decision_ts,
    binding_constraint,limiters_json,config_version,config_hash,factor_map_version,
    oldest_input_ts,newest_input_ts,book_json,inputs_json,outcome,reason_code,portfolio_state,received_at)
    VALUES ('EXIT','market',$1,$2,$3,$4,'NOT_SIZED','[]','fixture',$5,'fixture',$4,$4,'{}',$6,$7,$8,'REDUCE_ONLY',$4)
    RETURNING decision_id`,
    [
      token,
      token === "yes" ? "YES" : "NO",
      side,
      now,
      "0".repeat(64),
      JSON.stringify({
        exit_contract_version: 1,
        account_id: "paper",
        strategy_id: owner,
        exit: {
          signature: accepted ? "PORTFOLIO_LIMIT" : "hold",
          signals: accepted ? [{ reason: "PORTFOLIO_LIMIT" }] : [],
        },
      }),
      accepted ? "ACCEPTED" : "REJECTED",
      accepted ? null : "HOLD_NO_EXIT_SIGNAL",
    ],
  );
  return Number(row.rows[0].decision_id);
}
async function position(
  token = "yes",
  side = "BUY",
  size = "8.11",
  owner = "main",
) {
  const id = `seed-${token}-${owner}`;
  await raw.query(
    `INSERT INTO paper_orders(order_id,token_id,condition_id,side,order_type,limit_price,size,source,strategy_id,status,decided_at,accepted_at)
    VALUES ($1,$2,'market',$3,'GTC','0.8',$4,$5,$6,'filled',$7,$7)`,
    [
      id,
      token,
      side,
      size,
      owner === "main" ? "manual" : "fast",
      owner === "main" ? null : owner,
      earlier,
    ],
  );
  // Explicit historical signed position, predating reservations. No live entry path creates shorts.
  await appendLedgerEvent(pool, {
    idempotencyKey: `${id}:fill`,
    eventType: "fill",
    orderId: id,
    tokenId: token,
    conditionId: "market",
    eventTs: earlier,
    payload: { side, size, price: "0.8", fee: "0" },
  });
}
function input(
  id: number,
  token = "yes",
  side: "BUY" | "SELL" = "SELL",
): AcceptInput {
  return {
    orderId: bridgeOrderId(id),
    decisionId: id,
    conditionId: "market",
    source: "portfolio",
    policyReason: "EXIT_REDUCE_ONLY",
    draft: {
      tokenId: token,
      side,
      orderType: "GTC",
      postOnly: true,
      limitPrice: side === "SELL" ? "0.62" : "0.60",
      size: "8.11",
    },
  };
}
async function bridge(at = now) {
  return bridgeTick(pool, { clock: () => at, logSink: quiet, latencyMs: 0 });
}
async function order(id: number) {
  return (
    await raw.query("SELECT * FROM paper_orders WHERE decision_id=$1", [id])
  ).rows[0];
}
async function reasons(id: number) {
  return (
    await raw.query(
      `SELECT payload_json->>'reason' AS reason FROM paper_ledger_events
  WHERE event_type='order_rejected' AND payload_json->>'decision_id'=$1`,
      [String(id)],
    )
  ).rows.map((r) => r.reason);
}
async function fill(
  id: number,
  size: string,
  side = "SELL",
  token = "yes",
  at = now,
) {
  await appendLedgerEvent(pool, {
    idempotencyKey: `${bridgeOrderId(id)}:fixture-fill:${size}`,
    eventType: "fill",
    orderId: bridgeOrderId(id),
    tokenId: token,
    conditionId: "market",
    eventTs: at,
    payload: { side, size, price: side === "SELL" ? "0.62" : "0.60", fee: "0" },
  });
  await raw.query(
    "UPDATE paper_orders SET filled_size=$2 WHERE decision_id=$1",
    [id, size],
  );
}

describe.skipIf(url === undefined)(
  "EXEC-04 EXIT reduce-only PostgreSQL",
  () => {
    beforeEach(async () => {
      fixture = await createPgFixture(url);
      raw = fixture.pool;
      pool = {
        ...wrap(raw),
        async transaction(run) {
          const client = await raw.connect();
          try {
            await client.query("BEGIN");
            const result = await run(wrap(client));
            await client.query("COMMIT");
            return result;
          } catch (e) {
            await client.query("ROLLBACK");
            throw e;
          } finally {
            client.release();
          }
        },
      };
      await raw.query(`INSERT INTO paper_financial_owners(account_id,strategy_id,initial_cash_usd,capital_source_ref)
      VALUES ('paper','main','1000.000000000','EXEC04:synthetic'),('paper','other','1000.000000000','EXEC04:synthetic')`);
      await raw.query(
        `INSERT INTO polymarket_market_metadata_versions(condition_id,version,question,category,clob_token_ids,affirmative_token_id,valid_from)
      VALUES ('market',1,'Synthetic EXIT market','crypto','["yes","no"]','yes',$1)`,
        [earlier],
      );
      await raw.query(
        `INSERT INTO polymarket_param_versions(condition_id,version,content_hash,tick_size,min_order_size,taker_fee_bps,valid_from)
      VALUES ('market',1,'synthetic','0.01','1',NULL,$1)`,
        [earlier],
      );
      await book("yes");
      await raw.query(
        `INSERT INTO resolution_market_state(condition_id,action,effective_action,computed_at)
      VALUES ('market','NONE','NONE',$1)`,
        [now],
      );
      await raw.query(`INSERT INTO resolution_runtime_state(runtime_id,generation,score_version,ready,started_at,ready_at,
      heartbeat_at,lease_expires_at,last_success_at,graph_evaluated_at,graph_valid_until,
      processed_resolution_event_id,processed_rule_version_id,processed_input_change_id)
      SELECT 1,gen_random_uuid(),'fixture',true,now(),now(),now(),now()+interval '1 hour',now(),now(),now()+interval '1 hour',
      (SELECT COALESCE(max(resolution_event_id),0) FROM polymarket_resolution_events),
      (SELECT COALESCE(max(rule_version_id),0) FROM polymarket_rule_versions),
      (SELECT COALESCE(max(input_change_id),0) FROM polymarket_resolution_input_changes)`);
    });
    afterEach(async () => {
      try {
        await stampExitOrders(pool);
        const sample = (
          await raw.query(`SELECT d.decision_id,d.paper_order_id,
        EXISTS(SELECT 1 FROM paper_ledger_events e WHERE e.event_type='order_rejected'
          AND e.payload_json->>'decision_id'=d.decision_id::text AND e.payload_json->>'reason' IS NOT NULL) AS explained
        FROM portfolio_decisions d WHERE d.decision_kind='EXIT' AND d.outcome='ACCEPTED'`)
        ).rows;
        expect(sample.length).toBeGreaterThan(0);
        expect(
          sample.every((r) => r.paper_order_id !== null || r.explained),
        ).toBe(true);
      } finally {
        await fixture.dispose();
      }
    });

    it.each(["yes", "no"])(
      "sells only the owner's 8.11 real %s tokens, at a loss and without a taker fee",
      async (token) => {
        if (token === "no") await book(token);
        await position(token);
        await position(token, "BUY", "40", "other");
        const id = await decision(token);
        expect((await bridge()).accepted).toBe(1);
        expect(await order(id)).toMatchObject({
          side: "SELL",
          token_id: token,
          size: "8.11",
          limit_price: "0.62",
          post_only: true,
        });
        const e = (
          await raw.query(
            "SELECT payload_json FROM paper_ledger_events WHERE order_id=$1 AND event_type='order_accepted'",
            [bridgeOrderId(id)],
          )
        ).rows[0].payload_json;
        expect(e.reservation.inventory_side).toBe("SELL");
        expect(e.exit_evaluation).toMatchObject({
          version: "exit-reduce-only-v1",
          fee_per_share: "0",
          side: "SELL",
        });
        expect(e.final_entry_evaluation).toBeNull();
      },
    );
    it("covers -8.11 with BUY, rejects overfill and never crosses zero", async () => {
      await position("yes", "SELL");
      const id = await decision("yes", "BUY");
      expect((await bridge()).accepted).toBe(1);
      expect(await order(id)).toMatchObject({
        side: "BUY",
        size: "8.11",
        limit_price: "0.60",
      });
      await expect(fill(id, "8.12", "BUY")).rejects.toThrow(
        "FIN05_FILL_OUTSIDE_RESERVATION",
      );
      await fill(id, "8.11", "BUY");
      expect((await exitInventory(pool, "yes", now)).shares).toBe(0n);
      const again = await decision("yes", "BUY");
      await bridge();
      expect(await reasons(again)).toContain("EXIT_INVENTORY_UNAVAILABLE");
    });
    it("does not sell another owner's inventory and refuses an unproven owner", async () => {
      await position("yes", "BUY", "8.11", "other");
      const id = await decision();
      const other = await decision("yes", "SELL", "other");
      await bridge();
      expect(await order(id)).toBeUndefined();
      expect(await reasons(id)).toContain("EXIT_INVENTORY_UNAVAILABLE");
      expect(await reasons(other)).toContain("EXIT_OWNER_UNPROVEN");
    });
    it("deduplicates concurrent retries of one decision", async () => {
      await position();
      const id = await decision();
      const result = await Promise.all([
        acceptPaperOrder(pool, input(id), { clock }),
        acceptPaperOrder(pool, input(id), { clock }),
      ]);
      expect(result.map((r) => r.status)).toEqual(["accepted", "accepted"]);
      expect(
        (
          await raw.query(
            "SELECT * FROM paper_order_reservations WHERE order_id=$1",
            [bridgeOrderId(id)],
          )
        ).rows,
      ).toHaveLength(1);
      expect((await bridge()).accepted).toBe(0);
    });
    it("serializes two different EXIT decisions against the same 8.11 shares", async () => {
      await position();
      const a = await decision();
      const b = await decision();
      const result = await Promise.all([
        acceptPaperOrder(pool, input(a), { clock }),
        acceptPaperOrder(pool, input(b), { clock }),
      ]);
      expect(result.filter((r) => r.status === "accepted")).toHaveLength(1);
      expect(result.find((r) => r.status === "rejected")).toMatchObject({
        reason: "EXIT_ORDER_ALREADY_OPEN",
      });
      await bridge(); // durable refusal for the losing eligible decision
      expect(
        (
          await raw.query(
            "SELECT sum(shares_remaining)::text AS shares FROM paper_order_reservations WHERE state='active'",
          )
        ).rows[0].shares,
      ).toBe("8.11");
    });
    it.each(["SELL", "BUY"] as const)(
      "partial %s, pending cancel, effective cancel, then only 6.11 can be reserved",
      async (side) => {
        await position("yes", side === "SELL" ? "BUY" : "SELL");
        const id = await decision("yes", side);
        await bridge();
        // The other owner has the opposite exposure; aggregate inventory is unusable.
        await position("yes", side, "40", "other");
        await raw.query(
          "UPDATE resolution_market_state SET action='CIRCUIT_BREAKER',effective_action='CIRCUIT_BREAKER' WHERE condition_id='market'",
        );
        await raw.query(
          `INSERT INTO polymarket_trades(trade_id,token_id,condition_id,price,size,provenance,trade_ts,received_at)
          OVERRIDING SYSTEM VALUE VALUES (10000,'yes','market',$1,'102','ws',$2,$2)`,
          [side === "SELL" ? "0.62" : "0.60", new Date(now.getTime() + 100)],
        );
        await brokerTick(pool, {
          clock: () => new Date(now.getTime() + 200),
          logSink: quiet,
        });
        expect((await order(id)).filled_size).toBe("2.000000");
        await raw.query(
          "UPDATE resolution_market_state SET action='NONE',effective_action='NONE' WHERE condition_id='market'",
        );
        await requestCancel(pool, bridgeOrderId(id), {
          clock: () => new Date(now.getTime() + 300),
        });
        const next = await decision("yes", side);
        await bridge(new Date(now.getTime() + 400));
        expect(await reasons(next)).toContain("EXIT_ORDER_ALREADY_OPEN");
        await brokerTick(pool, {
          clock: () => new Date(now.getTime() + 1500),
          latencyMs: 1000,
          logSink: quiet,
        });
        expect((await order(id)).status).toBe("canceled");
        await bridge(new Date(now.getTime() + 2000));
        expect(await order(next)).toMatchObject({ side, size: "6.11" });
        await expect(
          fill(id, "1", side, "yes", new Date(now.getTime() + 3000)),
        ).rejects.toThrow("FIN05_FILL_OUTSIDE_RESERVATION");
      },
    );
    it("a later HOLD preserves the existing EXIT and owner signatures stay isolated", async () => {
      await position();
      const id = await decision();
      await bridge();
      await decision("yes", "SELL", "other", false);
      expect(
        await lastExitSignature(pool, "yes", {
          accountId: "paper",
          strategyId: "main",
        }),
      ).toBe("PORTFOLIO_LIMIT");
      await decision("yes", "SELL", "main", false);
      await bridge();
      expect((await order(id)).status).toBe("open");
      expect(
        await entryProvenanceFor(pool, "yes", {
          accountId: "paper",
          strategyId: "main",
        }),
      ).toBeNull();
    });
    it("allows reevaluation of the same exit verdict after effective cancellation", async () => {
      await position();
      const id = await decision();
      await bridge();
      await requestCancel(pool, bridgeOrderId(id), { clock });
      await brokerTick(pool, {
        clock: () => new Date(now.getTime() + 1000),
        latencyMs: 1000,
        logSink: quiet,
      });
      expect((await order(id)).status).toBe("canceled");
      expect(
        await lastExitSignature(pool, "yes", {
          accountId: "paper",
          strategyId: "main",
        }),
      ).toBeNull();
    });
    it("records a refusal when the book is absent", async () => {
      await position("no");
      const id = await decision("no");
      await bridge();
      expect(await reasons(id)).toContain("NO_FRESH_BOOK");
    });
    it("rejects a changed passive quote at the actual acceptance", async () => {
      await position();
      const id = await decision();
      const changed = {
        ...input(id),
        draft: { ...input(id).draft, limitPrice: "0.63" },
      };
      expect(await acceptPaperOrder(pool, changed, { clock })).toMatchObject({
        status: "rejected",
        reason: "EXIT_PASSIVE_QUOTE_CHANGED",
      });
      await bridge(); // a correctly quoted request can still reduce the same inventory
      expect((await order(id)).limit_price).toBe("0.62");
    });
    it("keeps kill-switch and resolution veto protections", async () => {
      await position();
      const id = await decision();
      await raw.query(
        "UPDATE paper_kill_switch SET engaged=true WHERE kill_switch_id=1",
      );
      await bridge();
      expect(await reasons(id)).toContain("KILL_SWITCH_ENGAGED");
      await raw.query(
        "UPDATE paper_kill_switch SET engaged=false WHERE kill_switch_id=1",
      );
      await raw.query(
        "UPDATE resolution_market_state SET action='VETO',effective_action='VETO' WHERE condition_id='market'",
      );
      await bridge();
      expect(await order(id)).toBeUndefined();
      expect((await reasons(id)).some((r) => r.includes("VETO"))).toBe(true);
    });
    it("resolution wins a real concurrent inventory lock and EXIT cannot reopen the token", async () => {
      await position();
      const id = await decision();
      const client = await raw.connect();
      try {
        await client.query("BEGIN");
        await appendLedgerEvent(wrap(client), {
          idempotencyKey: "resolution-wins",
          eventType: "resolution",
          tokenId: "yes",
          conditionId: "market",
          eventTs: now,
          payload: { outcome_price: "1" },
        });
        const pending = acceptPaperOrder(pool, input(id), { clock });
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          blocked =
            (
              await raw.query(
                "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted",
              )
            ).rowCount! > 0;
          if (blocked) break;
          await setTimeout(10);
        }
        expect(blocked).toBe(true);
        await client.query("COMMIT");
        expect(await pending).toMatchObject({
          status: "rejected",
          reason: "EXIT_INVENTORY_UNAVAILABLE",
        });
        await bridge();
        expect(await order(id)).toBeUndefined();
        expect((await exitInventory(pool, "yes", now)).shares).toBe(0n);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
    it("settles only the remaining shares after a partial exit and releases its reservation", async () => {
      await position();
      const id = await decision();
      await bridge();
      await fill(id, "2");
      await appendLedgerEvent(pool, {
        idempotencyKey: "settle-after-partial",
        eventType: "resolution",
        tokenId: "yes",
        conditionId: "market",
        eventTs: new Date(now.getTime() + 1),
        payload: { outcome_price: "1" },
      });
      expect(
        (
          await raw.query(
            "SELECT state,shares_remaining FROM paper_order_reservations WHERE order_id=$1",
            [bridgeOrderId(id)],
          )
        ).rows[0],
      ).toMatchObject({ state: "released", shares_remaining: "0" });
      await expect(
        fill(id, "6.11", "SELL", "yes", new Date(now.getTime() + 2)),
      ).rejects.toThrow();
      expect(
        (await exitInventory(pool, "yes", new Date(now.getTime() + 3))).shares,
      ).toBe(0n);
    });
  },
);
