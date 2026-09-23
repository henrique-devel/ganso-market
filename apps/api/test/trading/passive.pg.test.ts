import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlExecutor } from "../../src/database.js";
import { applyIoc } from "../../src/storage/brokerstore.js";
import { applyPassive } from "../../src/storage/passivestore.js";
import type { PassiveCommand } from "../../src/storage/passive-contract.js";
import { health, trade } from "./bars-fixture.js";
import { applyReservation } from "../../src/storage/reservationstore.js";
import {
  appendLedgerBatch,
  createLedgerAccount,
  readLedgerAccount,
} from "../../src/storage/ledgerstore.js";
import { readLedgerValuation } from "../../src/storage/valuationstore.js";
import {
  storeRetentionObjectTx,
  withBtcRetentionTransaction,
} from "../../src/storage/btc-retention.js";
import { ledgerScope } from "../../src/trading/ledger.js";
import { createPgFixture } from "../pg-fixture.js";
import { command, identity, iso } from "./ledger-fixture.js";
import { metadata } from "./bars-fixture.js";
import { market, pricedFill } from "./valuation-fixture.js";
import { order } from "./reservation-fixture.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let fixture: Awaited<ReturnType<typeof createPgFixture>>;
let hook: ((sql: string, tx: SqlExecutor) => Promise<void>) | null;
const scope = ledgerScope(identity());
const pool = {
  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>) {
    const client = await fixture.pool.connect();
    try {
      await client.query("BEGIN");
      const tx: SqlExecutor = {
        async query(sql, params) {
          await hook?.(sql, {
            async query(s, p) {
              const r = await client.query(s, p ? [...p] : []);
              return { rows: r.rows, rowCount: r.rowCount ?? 0 };
            },
          });
          const r = await client.query(sql, params ? [...params] : []);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        },
      };
      const value = await run(tx);
      await client.query("COMMIT");
      return value;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  },
};
const submit = (
  id = "p1",
  changes: Partial<ReturnType<typeof order>> = {},
  limit = "64900000000",
): Extract<PassiveCommand, { action: "submit" }> => ({
  action: "submit",
  operation_id: `submit:${id}`,
  order: order(id, {
    quantity_btc_raw: "500000",
    price_cap_usd_raw: "67000000000",
    ...changes,
  }),
  intent: {
    schema_version: "btc.passive.v1",
    limit_price_usd_raw: limit,
    fee_metadata_id: "fixture:metadata",
  },
});
const advance = (operation_id = "advance:1"): PassiveCommand => ({
  action: "advance",
  operation_id,
});
const cancel = (order_id = "p1"): PassiveCommand => ({
  action: "cancel",
  operation_id: `cancel:${order_id}`,
  order_id,
});
const apply = (r: PassiveCommand) => applyPassive(pool, scope, r);
let captureSequence: number, lastCapture: number;
// Independent arithmetic fixtures, exclusively in disposable PG. Source time
// is deliberately supplied here; production unknown context never opens risk.
async function capture(
  options: {
    quantity?: string;
    side?: "buy" | "sell";
    price?: string;
    tradeAt?: number;
    receivedAt?: number;
    tid?: number;
    session?: string;
    gaps?: number;
    gap?: boolean;
    quality?: "stale" | "unknown";
    contextUnknown?: boolean;
    bookTouch?: boolean;
    from?: number;
  } = {},
) {
  const at = Date.now(),
    m = market(at),
    id = ++captureSequence;
  if (options.bookTouch && m.book!.payload.payload.kind === "book")
    Object.assign(m.book!.payload.payload, {
      asks: [
        {
          price: { unit: "USD_PER_BTC", decimals: 6, raw: "64900000000" },
          quantity: { unit: "BTC", decimals: 8, raw: "900000" },
          orders: 1,
        },
      ],
      bids: [
        {
          price: { unit: "USD_PER_BTC", decimals: 6, raw: "64800000000" },
          quantity: { unit: "BTC", decimals: 8, raw: "800000" },
          orders: 1,
        },
      ],
    });
  if (options.contextUnknown)
    Object.assign(m.context!.payload, {
      source_timestamp: null,
      quality: "unknown",
    });
  if (options.quality)
    Object.assign(m.book!.payload, { quality: options.quality });
  if (options.gap) m.capture!.health.channels.book.needs_revalidation = true;
  const h = health(at);
  Object.assign(h.channels, m.capture!.health.channels);
  const c = {
    ...m.capture!,
    health: h,
    id: `capture:${id}`,
    session: options.session ?? "fixture",
    from: options.from ?? lastCapture,
    history_truncated: false,
    restarted: false,
  };
  c.health.counters.gaps = options.gaps ?? 0;
  const events: Array<[string, unknown, string | null, string]> = [
    ["context", m.context!.payload, iso(at), iso(at)],
    ["book", m.book!.payload, iso(at), iso(at)],
    ["capture", c, iso(c.from), iso(at)],
  ];
  if (options.quantity) {
    const t = trade(
      options.tradeAt ?? at,
      options.tid ?? id,
      options.price ?? "64900",
      options.quantity,
      options.receivedAt ?? at,
    );
    if (t.payload.kind !== "trade") throw new Error("fixture");
    Object.assign(t.payload, { side: options.side ?? "sell" });
    events.push(["trades", t, t.source_timestamp, t.received_at]);
  }
  const ids: string[] = [];
  await withBtcRetentionTransaction(pool, async (tx) => {
    for (const [kind, payload, sourceAt, received] of events) {
      const key = `fixture:${kind}:${id}`;
      ids.push(key);
      await storeRetentionObjectTx(tx, {
        id: key,
        class: "raw",
        identity: scope,
        recordedAt: new Date(received),
        payload,
        dependencies: [],
      });
      await tx.query(
        "INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES($1,$2,$3,$4)",
        [key, kind, sourceAt, received],
      );
    }
  });
  lastCapture = at;
  return ids;
}
async function count(table: string) {
  return (await fixture.pool.query(`SELECT count(*)::int n FROM ${table}`))
    .rows[0].n;
}
async function snapshot() {
  const out = [];
  for (const table of [
    "btc_passive_events",
    "btc_passive_results",
    "btc_passive_trades",
    "btc_order_acceptances",
    "btc_ioc_intents",
    "btc_ioc_results",
    "btc_reservation_events",
    "btc_ledger_events",
    "btc_ledger_transactions",
    "btc_ledger_projections",
    "btc_retention_objects",
    "btc_retention_pins",
    "btc_retention_dependencies",
  ])
    out.push(
      (
        await fixture.pool.query(
          `SELECT to_jsonb(t) value FROM ${table} t ORDER BY to_jsonb(t)::text`,
        )
      ).rows,
    );
  return out;
}
describe.skipIf(!url)("S5 passive atomic SQL", () => {
  beforeEach(async () => {
    fixture = await createPgFixture(url);
    hook = null;
    captureSequence = 0;
    lastCapture = Date.now() - 20;
    await createLedgerAccount(pool, identity());
    await withBtcRetentionTransaction(pool, (tx) =>
      storeRetentionObjectTx(tx, {
        id: "fixture:metadata",
        class: "raw",
        identity: scope,
        recordedAt: new Date(metadata.instrument.origin.received_at),
        payload: metadata,
        dependencies: [],
      }),
    );
    await capture();
  });
  afterEach(async () => {
    hook = null;
    await fixture?.dispose();
  });
  it("rejects crossing acceptance atomically", async () => {
    const before = await snapshot();
    await expect(apply(submit("p1", {}, "65100000000"))).rejects.toThrow(
      "POST_ONLY_CROSS",
    );
    expect(await snapshot()).toEqual(before);
  });
  it("touch and refreshed books alone never fill or reduce queue", async () => {
    await apply(submit());
    await capture({ bookTouch: true });
    const r = await apply(advance());
    expect(r.fills).toEqual([]);
    expect(r.orders[0]!.queue.ahead_btc_raw).toBe("600000");
    expect(await count("btc_ledger_events")).toBe(1);
  });
  it("requires strictly posterior source AND receipt times", async () => {
    const s = await apply(submit());
    const at = Date.parse(s.orders[0]!.accepted_at);
    await capture({ quantity: "0.02", tradeAt: at, receivedAt: at });
    expect((await apply(advance())).fills).toEqual([]);
    await capture({ quantity: "0.02", tradeAt: at - 1 });
    expect((await apply(advance("a2"))).fills).toEqual([]);
  });
  it("burns queue on insufficient trade then persists a partial fill with fee and pins", async () => {
    await apply(submit());
    await capture({ quantity: "0.004" });
    const zero = await apply(advance());
    expect(zero.fills).toEqual([]);
    expect(zero.orders[0]!.queue.ahead_btc_raw).toBe("200000");
    const ids = await capture({ quantity: "0.003" });
    const r = await apply(advance("a2"));
    expect(r.fills).toMatchObject([
      {
        order_id: "p1",
        price_usd_raw: "64900000000",
        quantity_btc_raw: "100000",
        fee_usd_raw: "9735",
      },
    ]);
    expect(r.orders[0]!.reservation).toMatchObject({
      status: "active",
      remaining_btc_raw: "400000",
      margin_usd_raw: "268000000",
    });
    const v = await readLedgerValuation(pool, scope, iso(Date.now()));
    expect(v.balance_usd_raw).toBe("999990265");
    expect(v.positions[0]!.quantity_btc_raw).toBe("100000");
    const deps = (
      await fixture.pool.query(
        "SELECT dependency_id FROM btc_retention_dependencies WHERE object_id=$1",
        [r.evidence_id],
      )
    ).rows.map((r) => r.dependency_id);
    expect(deps).toEqual(expect.arrayContaining(ids));
    expect(await count("btc_retention_pins")).toBe(3);
  });
  it("deduplicates retries, new operations and same economic trade under a new observation", async () => {
    await apply(submit());
    const at = Date.now();
    await capture({ quantity: "0.007", tradeAt: at, tid: 42 });
    const a = await apply(advance());
    const before = await snapshot();
    expect(await apply(advance())).toEqual(a);
    expect(await snapshot()).toEqual(before);
    await capture({ quantity: "0.007", tradeAt: at, tid: 42 });
    expect((await apply(advance("restart"))).fills).toEqual([]);
    expect(await count("btc_passive_trades")).toBe(1);
    expect((await readLedgerAccount(pool, scope)).events).toHaveLength(3);
  });
  it("shares queue burn and volume FIFO across all same-account orders and concurrent callers", async () => {
    await apply(submit("p1"));
    await apply(submit("p2"));
    await capture({ quantity: "0.018" });
    const [a, b] = await Promise.all([apply(advance()), apply(advance("a2"))]);
    expect(a.fills.map((f) => [f.order_id, f.quantity_btc_raw])).toEqual([
      ["p1", "500000"],
      ["p2", "100000"],
    ]);
    expect(b.fills).toEqual([]);
    expect(await count("btc_passive_trades")).toBe(1);
  });
  it("late cancellation reports filled state and cannot duplicate execution", async () => {
    await apply(submit());
    await capture({ quantity: "0.02" });
    const r = await apply(advance());
    expect(r.orders[0]!.reservation.status).toBe("filled");
    expect(await apply(cancel())).toMatchObject({
      reason: "already_terminal",
      fills: [],
      orders: [{ reservation: { status: "filled" } }],
    });
    expect(await count("btc_ledger_events")).toBe(3);
  });
  it("cancel first wins the serialized race with advance", async () => {
    await apply(submit());
    await capture({ quantity: "0.02" });
    const rs = await Promise.all([apply(cancel()), apply(advance())]);
    expect(rs.flatMap((r) => r.fills)).toEqual([]);
    expect(await count("btc_ledger_events")).toBe(1);
  });
  it("replace loses priority even for size reduction and excludes old trade evidence", async () => {
    await apply(submit("p1"));
    await apply(submit("p2"));
    await capture({ quantity: "0.02" });
    const next = submit("p3", { quantity_btc_raw: "300000" });
    const r = await apply({
      ...next,
      action: "replace",
      order_id: "p1",
      operation_id: "replace",
    });
    expect(r.orders.map((s) => s.reservation.status)).toEqual([
      "cancelled",
      "active",
    ]);
    const old = await apply(advance());
    expect(old.fills.map((f) => f.order_id)).toEqual(["p2"]);
    expect(
      old.orders.find((s) => s.reservation.order.order_id === "p3")!.queue
        .ahead_btc_raw,
    ).toBe("600000");
    await capture({ quantity: "0.009" });
    expect((await apply(advance("a2"))).fills.map((f) => f.order_id)).toEqual([
      "p3",
    ]);
  });
  it("failed crossing replacement preserves the original reservation and priority", async () => {
    await apply(submit());
    const before = await snapshot();
    await expect(
      apply({
        ...submit("p2", {}, "65100000000"),
        action: "replace",
        order_id: "p1",
        operation_id: "replace",
      }),
    ).rejects.toThrow("POST_ONLY_CROSS");
    expect(await snapshot()).toEqual(before);
  });
  it.each([
    { gap: true },
    { gaps: 1 },
    { session: "new-session" },
    { quality: "stale" as const },
    { quality: "unknown" as const },
    { from: Date.now() - 30000 },
  ])("invalidates the queue on gap/restart/stale proof %j", async (options) => {
    await apply(submit());
    await capture({ ...options, quantity: "0.02" });
    const r = await apply(advance());
    expect(r.fills).toEqual([]);
    expect(r.orders[0]!.reservation.status).toBe("cancelled");
    await capture({ quantity: "0.02" });
    expect((await apply(advance("restart"))).fills).toEqual([]);
    expect(await count("btc_ledger_events")).toBe(1);
  });
  it("unknown finance never fabricates risk capacity", async () => {
    await apply(submit());
    await capture({ quantity: "0.02", contextUnknown: true });
    expect((await apply(advance())).reason).toBe("finance_unavailable");
    await expect(apply(submit("p2"))).rejects.toThrow("FINANCE_UNAVAILABLE");
  });
  it("expires without using already stored negotiations", async () => {
    await apply(submit("p1", { valid_until: iso(Date.now() + 180) }));
    await capture({ quantity: "0.02" });
    await fixture.pool.query("SELECT pg_sleep(0.2)");
    const r = await apply(advance());
    expect(r.fills).toEqual([]);
    expect(r.orders[0]!.reservation.status).toBe("expired");
  });
  it("expiry after tentative fill rolls back ledger, queue and trade claims", async () => {
    await apply(submit("p1", { valid_until: iso(Date.now() + 300) }));
    await capture({ quantity: "0.007" });
    hook = async (sql, tx) => {
      if (sql.startsWith("INSERT INTO btc_reservation_events")) {
        hook = null;
        await tx.query("SELECT pg_sleep(0.35)");
      }
    };
    const r = await apply(advance());
    expect(r.fills).toEqual([]);
    expect(r.orders[0]!.reservation.status).toBe("expired");
    expect(await count("btc_ledger_events")).toBe(1);
    expect(await count("btc_passive_trades")).toBe(0);
  });
  it("rolls back all financial effects and pins if the final trade claim fails", async () => {
    await apply(submit());
    await capture({ quantity: "0.007" });
    const before = await snapshot();
    hook = async (sql, tx) => {
      if (sql.startsWith("INSERT INTO btc_passive_trades"))
        await tx.query("SELECT 1/0");
    };
    await expect(apply(advance())).rejects.toThrow();
    hook = null;
    expect(await snapshot()).toEqual(before);
    expect((await apply(advance())).fills).toHaveLength(1);
  });
  it("requires broker consumption, enforces owner identity and detects collisions", async () => {
    const req = submit();
    await apply(req);
    await expect(
      applyReservation(pool, scope, {
        action: "consume",
        operation_id: "bypass",
        order_id: "p1",
        quantity_btc_raw: "100000",
        price_usd_raw: "64900000000",
        fee_usd_raw: "0",
      }),
    ).rejects.toThrow("PASSIVE_BROKER_REQUIRED");
    await expect(
      apply({ ...cancel(), operation_id: req.operation_id }),
    ).rejects.toThrow("IDEMPOTENCY_COLLISION");
    await expect(
      applyPassive(pool, { ...scope, experiment_id: "another" }, advance()),
    ).rejects.toThrow();
  });
  it("counterfactual accounts independently consume prints, without pooled capital", async () => {
    const other = ledgerScope(identity("alternative"));
    await createLedgerAccount(pool, identity("alternative"));
    await apply(submit());
    await applyPassive(pool, other, submit());
    await capture({ quantity: "0.02" });
    const a = await apply(advance()),
      b = await applyPassive(pool, other, advance());
    expect(a.fills).toEqual(b.fills);
    expect(a.market_id).not.toBe(b.market_id);
  });
  it.each(["buy", "sell"] as const)(
    "reduce-only %s closes inventory without reversal using maker fees",
    async (side) => {
      await appendLedgerBatch(pool, scope, {
        transaction_id: "seed",
        events: [
          command(
            "seed",
            pricedFill(
              "seed",
              side === "sell" ? "buy" : "sell",
              "500000",
              side === "sell" ? "64000000000" : "66000000000",
            ),
          ),
        ],
      });
      await apply(
        submit(
          "p1",
          { intent: "reduce", side },
          side === "sell" ? "65100000000" : "64900000000",
        ),
      );
      await capture({
        quantity: "0.02",
        side: side === "sell" ? "buy" : "sell",
        price: side === "sell" ? "65100" : "64900",
        contextUnknown: true,
      });
      const r = await apply(advance());
      expect(r.orders[0]!.reservation.status).toBe("filled");
      const v = await readLedgerValuation(pool, scope, iso(Date.now()));
      expect(v.positions[0]!.quantity_btc_raw).toBe("0");
      expect(v.realized_pnl_usd_raw).toBe("5500000");
    },
  );
  it("rejects mixing IOC and passive liquidity models in either order", async () => {
    const ioc = {
      action: "submit" as const,
      operation_id: "ioc",
      order: order("ioc", {
        quantity_btc_raw: "100000",
        price_cap_usd_raw: "67000000000",
      }),
      intent: {
        schema_version: "btc.ioc.v1" as const,
        decision_at: iso(Date.now()),
        latency_ms: 0,
        limit_price_usd_raw: "66000000000",
        fee_metadata_id: "fixture:metadata",
      },
    };
    await apply(submit());
    await expect(applyIoc(pool, scope, ioc)).rejects.toThrow(
      "SEPARATE_PASSIVE_SCENARIO_REQUIRED",
    );
    const other = ledgerScope(identity("ioc-account"));
    await createLedgerAccount(pool, identity("ioc-account"));
    await applyIoc(pool, other, ioc);
    await expect(applyPassive(pool, other, submit())).rejects.toThrow(
      "SEPARATE_IOC_SCENARIO_REQUIRED",
    );
  });
  it("accumulates rounding across SQL partials instead of charging each poll", async () => {
    await apply(submit());
    await capture({ quantity: "0.00601" });
    const first = await apply(advance());
    await capture({ quantity: "0.00001" });
    const next = await apply(advance("next"));
    expect(first.fills[0]!.fee_usd_raw).toBe("98");
    expect(next.fills[0]!.fee_usd_raw).toBe("97");
    expect(next.orders[0]!.queue.charged_usd_raw).toBe("195");
    expect(next.orders[0]!.reservation.remaining_btc_raw).toBe("498000");
  });
  it("does not infer continuity across a missing capture interval", async () => {
    await apply(submit());
    await capture({ quantity: "0.02", from: Date.now() + 1 });
    const result = await apply(advance());
    expect(result.fills).toEqual([]);
    expect(result.reason).toBe("capture_history_missing");
  });
  it("refuses missing fee provenance before accepting or reserving", async () => {
    const req = submit();
    req.intent.fee_metadata_id = "missing";
    const before = await snapshot();
    await expect(apply(req)).rejects.toThrow("FEE_METADATA_UNAVAILABLE");
    expect(await snapshot()).toEqual(before);
  });
  it("protects queue, result and trade receipts against mutation and truncation", async () => {
    await apply(submit());
    await capture({ quantity: "0.007" });
    await apply(advance());
    const before = await snapshot();
    for (const table of [
      "btc_passive_results",
      "btc_passive_events",
      "btc_passive_trades",
    ]) {
      await expect(
        fixture.pool.query(`DELETE FROM ${table}`),
      ).rejects.toThrow();
      await expect(
        fixture.pool.query(`UPDATE ${table} SET account_id=account_id`),
      ).rejects.toThrow();
      await expect(
        fixture.pool.query(`TRUNCATE ${table} CASCADE`),
      ).rejects.toThrow();
    }
    expect(await snapshot()).toEqual(before);
  });
  it("honors external reservation cancellation and never revives its queue", async () => {
    await apply(submit());
    await applyReservation(pool, scope, {
      action: "release",
      operation_id: "external",
      order_id: "p1",
      reason: "cancelled",
    });
    await capture({ quantity: "0.02" });
    expect((await apply(advance())).fills).toEqual([]);
    expect(await apply(cancel())).toMatchObject({
      reason: "already_terminal",
      orders: [{ reservation: { status: "cancelled" } }],
    });
    expect(await count("btc_ledger_events")).toBe(1);
  });
});
