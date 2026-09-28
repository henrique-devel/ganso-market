import { riskOrder } from "./risk-fixture.js";
import { reservationHold } from "../../src/trading/reservations.js";
import { seedPaperOracle } from "./funding-fixture.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlExecutor } from "../../src/database.js";
import { createPgFixture } from "../pg-fixture.js";
import {
  createLedgerAccount,
  appendLedgerBatch,
  appendLedgerBatchTx,
} from "../../src/storage/ledgerstore.js";
import {
  sampleEquityAccount,
  verifyEquityObservation,
} from "../../src/storage/equity-history.js";
import { captureBtcMarketBatch } from "../../src/storage/btc-marketstore.js";
import { ledgerScope } from "../../src/trading/ledger.js";
import { command, identity, iso, usd, funding } from "./ledger-fixture.js";
import { metadata, health } from "./bars-fixture.js";
import { market, pricedFill } from "./valuation-fixture.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let fixture: Awaited<ReturnType<typeof createPgFixture>>;
const pool = {
  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await fixture.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run({
        async query(sql, params) {
          const r = await client.query(sql, params ? [...params] : []);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        },
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};

async function setup(
  side: "buy" | "sell" = "buy",
  capture = true,
  gap = false,
) {
  const id = identity();
  await createLedgerAccount(pool, id);
  await appendLedgerBatch(pool, ledgerScope(id), {
    transaction_id: "open",
    events: [command("open", pricedFill("open", side))],
  });
  await fixture.pool.query(
    `INSERT INTO btc_equity_admissions(account_id,created_at,start_at,end_at,capacity_basis) VALUES('manual',clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 day','disposable fixture capacity only')`,
  );
  if (capture) {
    const at = Date.now(),
      m = market(at),
      h = health(at);
    Object.assign(h.channels, m.capture!.health.channels);
    if (gap) h.channels.context.needs_revalidation = true;
    // Synthetic HTTP Date proof only, never a venue recording.
    await captureBtcMarketBatch(
      pool,
      {
        sessionId: "equity",
        capturedAt: iso(at),
        metadata,
        events: [],
        health: h,
      },
      true,
    );
    await seedPaperOracle(pool, ledgerScope(id), "mark", at);
  }
}
async function payload() {
  return (
    await fixture.pool.query(
      `SELECT o.payload,o.charged_bytes::text FROM btc_equity_observations e JOIN btc_retention_objects o ON o.object_id=e.evidence_id`,
    )
  ).rows[0];
}
describe.skipIf(!url)(
  "equity temporal observations on disposable PostgreSQL",
  () => {
    beforeEach(async () => {
      fixture = await createPgFixture(url);
    });
    afterEach(async () => {
      await fixture?.dispose();
    });
    for (const side of ["buy", "sell"] as const)
      it(`persists ${side} open equity with bounded charges and pinned temporal evidence`, async () => {
        await setup(side);
        const walBefore = (
          await fixture.pool.query(
            "SELECT pg_current_wal_insert_lsn()::text AS lsn",
          )
        ).rows[0].lsn;
        const result = await sampleEquityAccount(pool, "manual");
        expect(result.status).toBe("stored");
        const p = await payload();
        expect(p.payload.equity_usd_raw).toBe(
          side === "buy" ? "1010000000" : "990000000",
        );
        expect(BigInt(p.charged_bytes)).toBeLessThanOrEqual(12288n);
        expect(p.payload.mark.timestamp_basis).toBe("http_response_date");
        const pins = await fixture.pool.query(
          `SELECT count(*)::int AS n FROM btc_retention_pins p JOIN btc_equity_observations e ON p.object_id=e.evidence_id`,
        );
        expect(pins.rows[0].n).toBe(1);
        const deps = await fixture.pool.query(
          `SELECT count(*)::int AS n FROM btc_retention_dependencies d JOIN btc_equity_observations e ON d.object_id=e.evidence_id`,
        );
        expect(deps.rows[0].n).toBe(2);
        const footprint = (
          await fixture.pool.query(
            `WITH RECURSIVE closure AS (SELECT evidence_id AS object_id FROM btc_equity_observations UNION SELECT d.dependency_id FROM btc_retention_dependencies d JOIN closure c ON d.object_id=c.object_id) SELECT sum(o.charged_bytes)::text AS closure_charge,sum(pg_column_size(o))::text AS row_bytes FROM closure c JOIN btc_retention_objects o USING(object_id)`,
          )
        ).rows[0];
        const wal = (
          await fixture.pool.query(
            "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1)::text AS bytes",
            [walBefore],
          )
        ).rows[0].bytes;
        process.stdout.write(
          `equity measured root ${p.charged_bytes} closure ${footprint.closure_charge} row_bytes ${footprint.row_bytes} WAL ${wal}\n`,
        );
      });
    it("missing mark is unavailable, no invented current or future price", async () => {
      await setup("buy", false);
      await sampleEquityAccount(pool, "manual");
      expect((await payload()).payload).toMatchObject({
        status: "unavailable",
        equity_usd_raw: null,
        unrealized_pnl_usd_raw: null,
      });
    });
    it("partial close, fee and external flow are counted once; reservations are not expenses", async () => {
      await setup();
      await appendLedgerBatch(pool, ledgerScope(identity()), {
        transaction_id: "reduce",
        events: [
          command(
            "reduce",
            pricedFill("reduce", "sell", "500000", "66000000000"),
          ),
          command("fee", {
            event_type: "fee",
            execution_id: "reduce",
            delta: usd("-100000"),
          }),
          command("transfer", {
            event_type: "cash",
            reason: "transfer",
            delta: usd("50000000"),
          }),
        ],
      });
      await sampleEquityAccount(pool, "manual");
      expect((await payload()).payload).toMatchObject({
        realized_pnl_usd_raw: "10000000",
        unrealized_pnl_usd_raw: "5000000",
        fees_usd_raw: "-100000",
        external_flows_usd_raw: "50000000",
        equity_usd_raw: "1064900000",
      });
    });
    it("duplicate after a late fee preserves the earlier knowledge cut", async () => {
      await setup();
      await sampleEquityAccount(pool, "manual");
      const before = await payload();
      await appendLedgerBatch(pool, ledgerScope(identity()), {
        transaction_id: "late",
        events: [
          command("late", {
            event_type: "fee",
            execution_id: "open",
            delta: usd("-1000000"),
          }),
        ],
      });
      expect((await sampleEquityAccount(pool, "manual")).status).toBe(
        "duplicate",
      );
      expect(await payload()).toEqual(before);
      expect(
        await verifyEquityObservation(pool, "manual", before.payload.slot),
      ).toEqual(before.payload);
    });
    it("crash before commit leaves neither sample nor pins, retry succeeds", async () => {
      await setup();
      const before = (
        await fixture.pool.query(
          "SELECT total_bytes::text FROM btc_retention_policy",
        )
      ).rows;
      const crashing = {
        transaction: <T>(run: (tx: SqlExecutor) => Promise<T>) =>
          pool.transaction<T>(async (tx) => {
            await run(tx);
            throw new Error("crash");
          }),
      };
      await expect(sampleEquityAccount(crashing, "manual")).rejects.toThrow(
        "crash",
      );
      expect(await payload()).toBeUndefined();
      expect(
        (
          await fixture.pool.query(
            "SELECT total_bytes::text FROM btc_retention_policy",
          )
        ).rows,
      ).toEqual(before);
      expect((await sampleEquityAccount(pool, "manual")).status).toBe("stored");
    });
    it("default is not admitted and historical rows cannot be rewritten", async () => {
      expect((await sampleEquityAccount(pool, "manual")).status).toBe(
        "not_admitted",
      );
      await setup();
      await sampleEquityAccount(pool, "manual");
      await expect(
        fixture.pool.query("DELETE FROM btc_equity_observations"),
      ).rejects.toThrow("APPEND_ONLY");
    });

    it("late funding cannot alter the earlier persisted prefix", async () => {
      await setup();
      await sampleEquityAccount(pool, "manual");
      const before = await payload();
      await pool.transaction((tx) =>
        appendLedgerBatchTx(
          tx,
          identity(),
          {
            transaction_id: "late-funding",
            events: [command("late-funding", funding())],
          },
          new Date().toISOString(),
          false,
          true,
        ),
      );
      expect(
        await verifyEquityObservation(pool, "manual", before.payload.slot),
      ).toEqual(before.payload);
      expect((await payload()).payload.funding_usd_raw).toBe("0");
    });
    it("channel gap cannot yield marked equity", async () => {
      await setup("buy", true, true);
      await sampleEquityAccount(pool, "manual");
      expect((await payload()).payload).toMatchObject({
        equity_usd_raw: null,
        status: "unavailable",
        mark: { quality: "feed_unavailable" },
      });
    });
    it("guard exhaustion rolls back and does not consume an observation slot", async () => {
      await setup();
      const guarded = {
        transaction: <T>(run: (tx: SqlExecutor) => Promise<T>) =>
          pool.transaction((tx) =>
            run({
              query: async (sql, params) => {
                if (
                  sql ===
                  "SELECT total_bytes::text FROM btc_retention_policy WHERE dataset_id='btc-paper-v1'"
                )
                  return {
                    rows: [{ total_bytes: String(6n * 1024n ** 3n) }] as any,
                    rowCount: 1,
                  };
                return tx.query(sql, params);
              },
            }),
          ),
      };
      await expect(sampleEquityAccount(guarded, "manual")).rejects.toThrow(
        "BTC_EQUITY_CAPACITY",
      );
      expect(await payload()).toBeUndefined();
    });

    it("fixed hashes bound history size and reserved collateral is not deducted from equity", async () => {
      await setup();
      await appendLedgerBatch(pool, ledgerScope(identity()), {
        transaction_id: "many-transfers",
        events: Array.from({ length: 30 }, (_, i) =>
          command(`transfer:${i}`, {
            event_type: "cash",
            reason: "transfer",
            delta: usd("1"),
          }),
        ),
      });
      const order = riskOrder();
      const reservation = reservationHold(
        order,
        BigInt(order.quantity_btc_raw),
      );
      await fixture.pool.query(
        `INSERT INTO btc_order_acceptances(account_id,order_id,request,accepted_at) VALUES('manual',$1,$2,clock_timestamp())`,
        [order.order_id, JSON.stringify(order)],
      );
      await fixture.pool.query(
        `INSERT INTO btc_reservation_events(account_id,sequence,operation_id,order_id,action,request,reservation,recorded_at) VALUES('manual',1,'reserved',$1,'reserve','{"action":"reserve","operation_id":"reserved"}',$2,clock_timestamp())`,
        [order.order_id, JSON.stringify(reservation)],
      );
      await sampleEquityAccount(pool, "manual");
      const p = await payload();
      expect(p.payload.ledger.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(p.payload.reservations.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(p.payload.reservations.held_usd_raw).toBe(
        (
          BigInt(reservation.margin_usd_raw) + BigInt(reservation.fee_usd_raw)
        ).toString(),
      );
      expect(p.payload.equity_usd_raw).toBe("1010000030");
      expect(
        await verifyEquityObservation(pool, "manual", p.payload.slot),
      ).toEqual(p.payload);
    });
  },
);
