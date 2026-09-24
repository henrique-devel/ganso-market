import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlExecutor } from "../../src/database.js";
import { liquidateIsolatedPosition } from "../../src/storage/marginstore.js";
import {
  createLedgerAccount,
  appendLedgerBatch,
  readLedgerAccount,
} from "../../src/storage/ledgerstore.js";
import { readLedgerValuation } from "../../src/storage/valuationstore.js";
import {
  applyReservation,
  readReservationsTx,
} from "../../src/storage/reservationstore.js";
import { applyIoc } from "../../src/storage/brokerstore.js";
import {
  reconcileFunding,
  type FundingCommand,
} from "../../src/storage/fundingstore.js";
import { FUNDING_SOURCE } from "../../src/venues/hyperliquid/funding.js";
import {
  withBtcRetentionTransaction,
  storeRetentionObjectTx,
} from "../../src/storage/btc-retention.js";
import { ledgerScope } from "../../src/trading/ledger.js";
import { createPgFixture } from "../pg-fixture.js";
import { command, identity, iso, usd } from "./ledger-fixture.js";
import { market, pricedFill } from "./valuation-fixture.js";
import { riskOrder as order, seedRiskFunding } from "./risk-fixture.js";
import { seedMarginMetadata, marginMetadata } from "./margin-fixture.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let fixture: Awaited<ReturnType<typeof createPgFixture>>;
let hook: ((sql: string, tx: SqlExecutor) => Promise<void>) | null;
const scope = ledgerScope(identity());
let sequence: number;
let metaId: string;
const pool = {
  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>) {
    const client = await fixture.pool.connect();
    const raw: SqlExecutor = {
      async query(sql, params) {
        const r = await client.query(sql, params ? [...params] : []);
        return { rows: r.rows, rowCount: r.rowCount ?? 0 };
      },
    };
    try {
      await client.query("BEGIN");
      const result = await run({
        async query(sql, params) {
          await hook?.(sql, raw);
          return raw.query(sql, params);
        },
      });
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
const request = (id = "liq", position_id = "position:1") => ({
  operation_id: id,
  position_id,
});
const apply = (id = "liq", owner = scope, position = "position:1") =>
  liquidateIsolatedPosition(pool, owner, request(id, position));
async function seed(
  side: "buy" | "sell" = "sell",
  owner = scope,
  position = "position:1",
  fee = "0",
  at = Date.now() - 2000,
  q = "1000000",
) {
  const p = pricedFill(`seed:${position}`, side, q);
  if (p.event_type !== "fill") throw new Error("fixture");
  await appendLedgerBatch(pool, owner, {
    transaction_id: `seed:${position}`,
    events: [
      command(`seed:${position}`, { ...p, position_id: position }, owner, at),
      command(
        `fee:${position}`,
        { event_type: "fee", execution_id: p.execution_id, delta: usd(fee) },
        owner,
        at,
      ),
    ],
  });
}
async function capture(
  options: {
    mark?: string;
    bid?: string;
    ask?: string;
    depth?: string;
    quality?: "unknown" | "stale";
    bookGap?: boolean;
    bookBeforeMark?: boolean;
    at?: number;
  } = {},
) {
  if (options.at === undefined)
    await fixture.pool.query("SELECT pg_sleep(0.002)");
  const at = options.at ?? Date.now(),
    m = market(at);
  if (
    m.context!.payload.payload.kind !== "mark_funding" ||
    m.book!.payload.payload.kind !== "book"
  )
    throw new Error("fixture");
  Object.assign(m.context!.payload.payload.mark_price, {
    raw: options.mark ?? "128000000000",
  });
  Object.assign(m.context!.payload.payload.oracle_price, {
    raw: "64000000000",
  });
  if (options.quality)
    Object.assign(m.context!.payload, {
      quality: options.quality,
      source_timestamp: options.quality === "unknown" ? null : iso(at - 11000),
    });
  if (options.bookBeforeMark)
    Object.assign(m.book!.payload, { source_timestamp: iso(at - 1000) });
  if (options.bookGap)
    m.capture!.health.channels.book.needs_revalidation = true;
  const level = (raw: string) => ({
    price: { unit: "USD_PER_BTC", decimals: 6, raw },
    quantity: { unit: "BTC", decimals: 8, raw: options.depth ?? "1000000" },
    orders: 1,
  });
  Object.assign(m.book!.payload.payload, {
    bids: [level(options.bid ?? "127900000000")],
    asks: [level(options.ask ?? "129000000000")],
  });
  const ids: string[] = [];
  await withBtcRetentionTransaction(pool, async (tx) => {
    for (const [kind, payload] of [
      ["context", m.context!.payload],
      ["book", m.book!.payload],
      ["capture", m.capture],
    ] as const) {
      const id = `margin:${kind}:${++sequence}`;
      ids.push(id);
      await storeRetentionObjectTx(tx, {
        id,
        class: "raw",
        identity: scope,
        recordedAt: new Date(at),
        payload,
        dependencies: [],
      });
      await tx.query(
        "INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES($1,$2,$3,$3)",
        [id, kind, iso(at)],
      );
    }
  });
  return ids;
}
async function snapshot() {
  const rows = [];
  for (const table of [
    "btc_ledger_events",
    "btc_ledger_transactions",
    "btc_ledger_projections",
    "btc_margin_results",
    "btc_reservation_events",
    "btc_retention_objects",
    "btc_retention_pins",
    "btc_retention_dependencies",
  ])
    rows.push(
      (
        await fixture.pool.query(
          `SELECT to_jsonb(t) value FROM ${table} t ORDER BY to_jsonb(t)::text`,
        )
      ).rows,
    );
  return rows;
}
async function value(owner = scope) {
  return readLedgerValuation(pool, owner, iso(Date.now()));
}
describe.skipIf(!url)(
  "S7 isolated margin on real disposable PostgreSQL",
  () => {
    beforeEach(async () => {
      fixture = await createPgFixture(url);
      hook = null;
      sequence = 0;
      await createLedgerAccount(pool, identity());
      metaId = await seedMarginMetadata(pool);
    });
    afterEach(async () => {
      hook = null;
      await fixture?.dispose();
    });
    it("liquidates a short after a mark jump with exact fee, residual/deficit and pinned evidence", async () => {
      await seed();
      const deps = await capture();
      const r = await apply();
      expect(r.status).toBe("closed");
      expect(r.fills).toEqual([
        {
          quantity_btc_raw: "1000000",
          price_usd_raw: "129000000000",
          fee_usd_raw: "580500",
        },
      ]);
      expect(r.after).toMatchObject({
        free_cash_usd_raw: "360000000",
        closed_deficit_usd_raw: "10580500",
        balance_usd_raw: "349419500",
        rounding_residual_usd_raw: "0",
      });
      const v = await value();
      expect(v.isolation).toEqual(r.after);
      expect(v.positions[0]!.quantity_btc_raw).toBe("0");
      const events = (await readLedgerAccount(pool, scope)).events;
      expect(
        events.filter((e) => e.payload.event_type === "liquidation"),
      ).toHaveLength(1);
      expect(
        events.filter((e) => e.payload.event_type === "fill"),
      ).toHaveLength(2);
      expect(events.filter((e) => e.payload.event_type === "fee")).toHaveLength(
        2,
      );
      const links = (
        await fixture.pool.query(
          "SELECT dependency_id FROM btc_retention_dependencies WHERE object_id=$1",
          [r.evidence_id],
        )
      ).rows.map((r) => r.dependency_id);
      expect(links).toEqual(expect.arrayContaining([...deps, metaId]));
    });
    it("liquidates a near-zero long after opening fees with no stop-price fill", async () => {
      await seed("buy", scope, "position:1", "-300000");
      await capture({ mark: "10000000", bid: "5000000", ask: "11000000" });
      const r = await apply();
      expect(r.status).toBe("closed");
      expect(r.fills[0]!.price_usd_raw).toBe("5000000");
      expect(r.after.closed_deficit_usd_raw).toBe("250023");
    });
    it("charges observed funding once to its isolated budget and can then liquidate a long", async () => {
      const cutoff = Date.now() - 500;
      await seed("buy", scope, "position:1", "0", cutoff - 1000);
      const ids = await capture({
        at: cutoff,
        mark: "1000000000",
        bid: "900000000",
        ask: "1100000000",
      });
      const cmd: FundingCommand = {
        operation_id: "fund",
        period_hour: iso(Math.floor(cutoff / 3600000) * 3600000),
        oracle_object_id: ids[0]!,
        observation: {
          source: FUNDING_SOURCE,
          received_at: iso(cutoff + 100),
          row: { coin: "BTC", time: cutoff, fundingRate: "0.04", premium: "0" },
        },
      };
      expect((await reconcileFunding(pool, scope, cmd)).status).toBe("settled");
      await reconcileFunding(pool, scope, cmd);
      const r = await apply();
      expect(r.status).toBe("closed");
      expect(r.before.positions[0]!.collateral_usd_raw).toBe("614400000");
      expect(
        (await readLedgerAccount(pool, scope)).events.filter(
          (e) => e.payload.event_type === "funding",
        ),
      ).toHaveLength(1);
    });
    it("partial depth leaves inventory and no full-close marker; identical book cannot be reused", async () => {
      await seed();
      await capture({ depth: "400000" });
      const r = await apply();
      expect(r.status).toBe("partial");
      expect(r.after.positions[0]!.quantity_btc_raw).toBe("-600000");
      const before = await snapshot();
      expect(await apply()).toEqual(r);
      expect(await snapshot()).toEqual(before);
      expect((await apply("next")).fills).toEqual([]);
      expect(
        (await readLedgerAccount(pool, scope)).events.some(
          (e) => e.payload.event_type === "liquidation",
        ),
      ).toBe(false);
      await capture();
      expect((await apply("new-book")).status).toBe("closed");
    });
    it("stops forced liquidation after a partial improves maintenance", async () => {
      await seed();
      await capture({
        bid: "99900000000",
        ask: "100000000000",
        depth: "400000",
      });
      const r = await apply();
      expect(r.status).toBe("partial");
      expect(r.after.positions[0]!.liquidatable).toBe(false);
      expect((await apply("again")).status).toBe("healthy");
    });
    it("records a gap beyond bankruptcy without consuming a different position's collateral", async () => {
      await seed("sell", scope, "position:1", "0", Date.now() - 2000, "500000");
      await seed("buy", scope, "other", "0", Date.now() - 1900, "500000");
      await capture({
        mark: "150000000000",
        bid: "149900000000",
        ask: "160000000000",
      });
      const r = await apply();
      expect(r.after.closed_deficit_usd_raw).toBe("160360000");
      expect(r.after.free_cash_usd_raw).toBe("360000000");
      expect(
        r.after.positions.find((p) => p.position_id === "other")!
          .collateral_usd_raw,
      ).toBe("320000000");
      expect(r.after.balance_usd_raw).toBe("519640000");
    });
    it("isolates identical order/operation IDs and liquidity by independent account", async () => {
      const other = ledgerScope(identity("other"));
      await createLedgerAccount(pool, identity("other"));
      await seed();
      await seed("sell", other);
      await capture();
      const [a, b] = await Promise.all([apply(), apply("liq", other)]);
      expect(a.fills).toEqual(b.fills);
      expect(a.market_id).not.toBe(b.market_id);
      expect(a.after).toEqual(b.after);
    });
    it("concurrent retries never duplicate fills/fees and a second worker is excluded", async () => {
      await seed();
      await capture();
      const [a, b, c] = await Promise.all([apply(), apply(), apply("another")]);
      expect(a).toEqual(b);
      expect(c.status).toBe("flat");
      const saved = await snapshot();
      await expect(
        liquidateIsolatedPosition(
          { transaction: pool.transaction },
          { ...scope },
          { ...request() },
        ),
      ).rejects.toThrow("BTC_RECOVERY_OWNED");
      expect(
        await liquidateIsolatedPosition(pool, { ...scope }, { ...request() }),
      ).toEqual(a);
      expect(await snapshot()).toEqual(saved);
    });
    it("rejects foreign ownership and idempotency collision before effects", async () => {
      await seed();
      await capture();
      await apply();
      const saved = await snapshot();
      await expect(
        liquidateIsolatedPosition(
          pool,
          { ...scope, experiment_id: "foreign" },
          request(),
        ),
      ).rejects.toThrow("OWNERSHIP");
      await expect(apply("liq", scope, "other")).rejects.toThrow(
        "IDEMPOTENCY_COLLISION",
      );
      expect(await snapshot()).toEqual(saved);
    });
    it.each(["unknown", "stale"] as const)(
      "does not trigger using a %s mark",
      async (quality) => {
        await seed();
        await capture({ quality });
        expect((await apply()).status).toBe("unavailable");
        expect((await readLedgerAccount(pool, scope)).events).toHaveLength(3);
      },
    );
    it("records unfilled exposure on a book gap; no backstop invented", async () => {
      await seed();
      await capture({ bookGap: true });
      const r = await apply();
      expect(r.status).toBe("unfilled");
      expect(r.fills).toEqual([]);
      expect(r.after.positions[0]!.quantity_btc_raw).toBe("-1000000");
    });
    it("does not liquidate at fresh but pre-trigger book prices", async () => {
      await seed();
      await capture({
        bookBeforeMark: true,
        bid: "63900000000",
        ask: "64100000000",
      });
      const r = await apply();
      expect(r.status).toBe("unfilled");
      expect(r.reason).toBe("book_before_trigger");
      expect(r.fills).toEqual([]);
      expect((await readLedgerAccount(pool, scope)).events).toHaveLength(3);
      await capture();
      expect((await apply("post-trigger")).status).toBe("closed");
    });
    it("returns positive residual collateral only on full close", async () => {
      await seed();
      await capture({ bid: "125900000000", ask: "126000000000" });
      const r = await apply();
      expect(r.after.positions[0]!.residual_usd_raw).toBe("19433000");
      expect(r.after.free_cash_usd_raw).toBe("379433000");
    });
    it("cancels reservations of the liquidated position atomically, preserving other reduce-only exits", async () => {
      await seed();
      await seed("sell", scope, "other", "0", Date.now() - 1900, "100000");
      await capture({
        mark: "64000000000",
        bid: "63900000000",
        ask: "64100000000",
      });
      await applyReservation(pool, scope, {
        action: "reserve",
        operation_id: "reserve-reduce",
        order: order("reduce", {
          intent: "reduce",
          side: "buy",
          quantity_btc_raw: "400000",
          price_cap_usd_raw: "200000000000",
        }),
      });
      await applyReservation(pool, scope, {
        action: "reserve",
        operation_id: "reserve-other",
        order: order("other", {
          position_id: "other",
          intent: "reduce",
          side: "buy",
          quantity_btc_raw: "100000",
        }),
      });
      await capture();
      await apply();
      const reservations = await pool.transaction((tx) =>
        readReservationsTx(tx, scope.account_id),
      );
      expect(
        reservations.find((r) => r.order.order_id === "reduce")!.status,
      ).toBe("cancelled");
      expect(
        reservations.find((r) => r.order.order_id === "other")!.status,
      ).toBe("active");
      await applyReservation(pool, scope, {
        action: "consume",
        operation_id: "late",
        order_id: "other",
        quantity_btc_raw: "100000",
        price_usd_raw: "65000000000",
        fee_usd_raw: "0",
      });
      expect(
        (await readLedgerAccount(pool, scope)).projection.positions.find(
          (p) => p.position_id === "other",
        )!.quantity_btc_raw,
      ).toBe("0");
    });
    it.each(["missing", "old", "version"])(
      "blocks opening without usable %s margin metadata",
      async (kind) => {
        await capture({ mark: "64000000000" });
        // A newer observation cannot fall back to the valid prior one.
        const at = Date.now();
        const m = marginMetadata(at);
        if (kind === "missing") Object.assign(m, { margin: null });
        if (kind === "old")
          m.instrument.origin = {
            ...m.instrument.origin,
            received_at: iso(at - 86_400_001),
          };
        if (kind === "version")
          m.instrument = { ...m.instrument, instrument_version: "new-version" };
        await seedMarginMetadata(pool, at, m);
        await expect(
          applyReservation(pool, scope, {
            action: "reserve",
            operation_id: "open",
            order: order(),
          }),
        ).rejects.toThrow("METADATA_UNAVAILABLE");
        expect(
          (
            await fixture.pool.query(
              "SELECT count(*)::int n FROM btc_order_acceptances",
            )
          ).rows[0].n,
        ).toBe(0);
      },
    );
    it("rechecks metadata on fill after a valid acceptance", async () => {
      await seedRiskFunding(pool);
      await capture({ mark: "64000000000" });
      await applyReservation(pool, scope, {
        action: "reserve",
        operation_id: "open",
        order: order(),
      });
      const at = Date.now(),
        m = marginMetadata(at);
      Object.assign(m.margin, { tiers: [] });
      await seedMarginMetadata(pool, at, m);
      await expect(
        applyReservation(pool, scope, {
          action: "consume",
          operation_id: "fill",
          order_id: "order:1",
          quantity_btc_raw: "100000",
          price_usd_raw: "65000000000",
          fee_usd_raw: "0",
        }),
      ).rejects.toThrow("METADATA_UNAVAILABLE");
      expect((await readLedgerAccount(pool, scope)).events).toHaveLength(1);
    });
    it("shares depth consumed by liquidation with subsequent IOC close", async () => {
      await seed("sell", scope, "position:1", "0", Date.now() - 2000, "500000");
      await seed("sell", scope, "other", "0", Date.now() - 1900, "500000");
      await capture({ depth: "700000" });
      const r = await apply();
      expect(r.fills[0]!.quantity_btc_raw).toBe("500000");
      await applyIoc(pool, scope, {
        action: "submit",
        operation_id: "submit",
        order: order("reduce-other", {
          position_id: "other",
          intent: "reduce",
          side: "buy",
          quantity_btc_raw: "500000",
          price_cap_usd_raw: "200000000000",
        }),
        intent: {
          schema_version: "btc.ioc.v1",
          decision_at: iso(Number(metaId.split(":").at(-1))),
          latency_ms: 0,
          limit_price_usd_raw: "200000000000",
          fee_metadata_id: metaId,
        },
      });
      const result = await applyIoc(pool, scope, {
        action: "execute",
        operation_id: "execute",
        order_id: "reduce-other",
      });
      expect(
        result.fills.reduce((n, f) => n + BigInt(f.quantity_btc_raw), 0n),
      ).toBe(200000n);
    });
    it.each([
      "INSERT INTO btc_ledger_events",
      "INSERT INTO btc_margin_results",
      "INSERT INTO btc_retention_pins",
    ])("rolls all effects back on failure at %s", async (fail) => {
      await seed();
      await capture();
      const saved = await snapshot();
      hook = async (sql, tx) => {
        if (sql.startsWith(fail)) await tx.query("SELECT 1/0");
      };
      await expect(apply()).rejects.toThrow("division by zero");
      hook = null;
      expect(await snapshot()).toEqual(saved);
      expect((await apply()).status).toBe("closed");
    });
    it("rolls back a fill if feed quality changes during execution", async () => {
      await seed();
      await capture();
      const saved = await snapshot();
      hook = async (sql, tx) => {
        if (sql.startsWith("INSERT INTO btc_ledger_transactions")) {
          hook = null;
          // Simulate a latest persisted capture showing an unresolved gap on this same transaction.
          const now = (
            await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
          ).rows[0]!.now.getTime();
          const m = market(now);
          m.capture!.health.channels.book.needs_revalidation = true;
          await storeRetentionObjectTx(tx, {
            id: "gap",
            class: "raw",
            identity: scope,
            recordedAt: new Date(now),
            payload: m.capture,
            dependencies: [],
          });
          await tx.query(
            "INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES('gap','capture',$1,$1)",
            [iso(now)],
          );
        }
      };
      await expect(apply()).rejects.toThrow("EVIDENCE_CHANGED_OR_STALE");
      expect(await snapshot()).toEqual(saved);
    });
    it("keeps results immutable and accounts disabled", async () => {
      await seed();
      await capture();
      await apply();
      for (const sql of [
        "UPDATE btc_margin_results SET result='{}'",
        "DELETE FROM btc_margin_results",
        "TRUNCATE btc_margin_results CASCADE",
      ])
        await expect(fixture.pool.query(sql)).rejects.toThrow("APPEND_ONLY");
      expect(
        (await fixture.pool.query("SELECT status FROM btc_ledger_accounts"))
          .rows,
      ).toEqual([{ status: "disabled" }]);
    });
  },
);
