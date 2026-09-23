import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlExecutor } from "../../src/database.js";
import { applyIoc } from "../../src/storage/brokerstore.js";
import type { IocCommand } from "../../src/storage/broker-contract.js";
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
  id = "o1",
  changes: Partial<ReturnType<typeof order>> = {},
  latency = 0,
): IocCommand => ({
  action: "submit",
  operation_id: `submit:${id}`,
  order: order(id, { price_cap_usd_raw: "67000000000", ...changes }),
  intent: {
    schema_version: "btc.ioc.v1",
    decision_at: iso(Date.now()),
    latency_ms: latency,
    limit_price_usd_raw: "66000000000",
    fee_metadata_id: "fixture:metadata",
  },
});
const execute = (id = "o1", op = `execute:${id}`): IocCommand => ({
  action: "execute",
  operation_id: op,
  order_id: id,
});
const cancel = (id = "o1"): IocCommand => ({
  action: "cancel",
  operation_id: `cancel:${id}`,
  order_id: id,
});
const apply = (r: IocCommand) => applyIoc(pool, scope, r);
let captureSequence: number;
/** Explicit synthetic arithmetic evidence only in disposable PG. Production
 * activeAssetCtx lacks source time and remains unusable for opening risk. */
async function capture(
  options: {
    at?: number;
    depth?: string;
    price?: string;
    quality?: string;
    context?: "unknown";
    gap?: boolean;
  } = {},
) {
  const at = options.at ?? Date.now(),
    m = market(at);
  const book = m.book!.payload;
  if (book.payload.kind !== "book") throw new Error("fixture");
  Object.assign(book.payload, {
    asks: [
      {
        price: {
          unit: "USD_PER_BTC",
          decimals: 6,
          raw: options.price ?? "65100000000",
        },
        quantity: { unit: "BTC", decimals: 8, raw: options.depth ?? "600000" },
        orders: 1,
      },
    ],
  });
  if (options.quality) Object.assign(book, { quality: options.quality });
  if (options.context) {
    Object.assign(m.context!.payload, {
      source_timestamp: null,
      quality: "unknown",
    });
  }
  if (options.gap) m.capture!.health.channels.book.needs_revalidation = true;
  const ids: string[] = [];
  await withBtcRetentionTransaction(pool, async (tx) => {
    for (const [kind, payload] of [
      ["context", m.context!.payload],
      ["book", book],
      ["capture", m.capture],
    ] as const) {
      const id = `fixture:${kind}:${++captureSequence}`;
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
async function count(table: string) {
  return (await fixture.pool.query(`SELECT count(*)::int n FROM ${table}`))
    .rows[0].n;
}
async function snapshot() {
  const out = [];
  for (const table of [
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
describe.skipIf(!url)("S4 IOC atomic SQL", () => {
  beforeEach(async () => {
    fixture = await createPgFixture(url);
    hook = null;
    captureSequence = 0;
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
    await capture({ at: Date.now() - 20 });
  });
  afterEach(async () => {
    hook = null;
    await fixture?.dispose();
  });
  it("commits partial IOC, fee, remaining release and pinned evidence together", async () => {
    await apply(submit());
    const ids = await capture();
    const result = await apply(execute());
    expect(result.status).toBe("cancelled");
    expect(result.fills).toEqual([
      {
        price_usd_raw: "65100000000",
        quantity_btc_raw: "600000",
        fee_usd_raw: "175770",
      },
    ]);
    expect(result.reservation).toMatchObject({
      margin_usd_raw: "0",
      fee_usd_raw: "0",
      remaining_btc_raw: "0",
    });
    const v = await readLedgerValuation(pool, scope, iso(Date.now()));
    expect(v.balance_usd_raw).toBe("999824230");
    expect(v.positions[0]!.quantity_btc_raw).toBe("600000");
    expect(v.positions[0]!.cost_usd14_raw).toBe("39060000000000000");
    const deps = (
      await fixture.pool.query(
        "SELECT dependency_id FROM btc_retention_dependencies WHERE object_id=$1",
        [result.evidence_id],
      )
    ).rows.map((r) => r.dependency_id);
    expect(deps).toEqual(expect.arrayContaining(ids));
    expect(await count("btc_retention_pins")).toBe(2);
    const before = await snapshot();
    expect(await apply(execute())).toEqual(result);
    expect(await snapshot()).toEqual(before);
  });
  it("has no fill past a buy price limit and releases all collateral", async () => {
    await apply(submit());
    await capture({ price: "66100000000" });
    const result = await apply(execute());
    expect(result.fills).toEqual([]);
    expect(result.status).toBe("cancelled");
    expect(await count("btc_ledger_events")).toBe(1);
  });
  it("fills full IOC and cancel afterward reports effective filled state", async () => {
    await apply(submit());
    await capture({ depth: "2000000" });
    expect((await apply(execute())).status).toBe("filled");
    expect(await apply(cancel())).toMatchObject({
      status: "filled",
      reason: "already_terminal",
      fills: [],
    });
    expect(await count("btc_ledger_events")).toBe(3);
  });
  it("waits for configured latency and never uses a pre-arrival book", async () => {
    await apply(submit("o1", {}, 150));
    expect((await apply(execute())).status).toBe("waiting");
    await fixture.pool.query("SELECT pg_sleep(0.17)");
    expect(await apply(execute())).toMatchObject({
      status: "cancelled",
      reason: "book_before_eligible_time",
      fills: [],
    });
  });
  it("can retry a waiting operation with a newly observed eligible book", async () => {
    await apply(submit("o1", {}, 120));
    expect((await apply(execute())).status).toBe("waiting");
    await fixture.pool.query("SELECT pg_sleep(0.14)");
    await capture();
    expect((await apply(execute())).fills).toHaveLength(1);
  });
  it.each(["stale", "unknown"])(
    "refuses %s book without inventing freshness",
    async (quality) => {
      await apply(submit());
      await capture({ quality });
      expect((await apply(execute())).fills).toEqual([]);
      expect(await count("btc_ledger_events")).toBe(1);
    },
  );
  it("refuses a book when the latest capture records an unresolved gap", async () => {
    await apply(submit());
    await capture({ gap: true });
    expect((await apply(execute())).reason).toBe("book_feed_unavailable");
  });
  it("blocks opening when source-less financial observations replace the mark", async () => {
    await apply(submit());
    await capture({ context: "unknown" });
    expect((await apply(execute())).reason).toBe("finance_unavailable");
    await expect(apply(submit("o2"))).rejects.toThrow("FINANCE_UNAVAILABLE");
  });
  it("expires during SQL processing and rolls back an already written fill/fee", async () => {
    await apply(submit("o1", { valid_until: iso(Date.now() + 350) }));
    await capture();
    hook = async (sql, tx) => {
      if (sql.startsWith("INSERT INTO btc_reservation_events")) {
        hook = null;
        await tx.query("SELECT pg_sleep(0.4)");
      }
    };
    expect(await apply(execute())).toMatchObject({
      status: "expired",
      fills: [],
    });
    expect(await count("btc_ledger_events")).toBe(1);
    expect(await count("btc_ledger_transactions")).toBe(1);
  });
  it("expires between the broker guard and the reservation clock", async () => {
    await apply(submit("o1", { valid_until: iso(Date.now() + 350) }));
    await capture();
    let clocks = 0;
    hook = async (sql, tx) => {
      if (sql === "SELECT clock_timestamp() AS now" && ++clocks === 3) {
        hook = null;
        await tx.query("SELECT pg_sleep(0.4)");
      }
    };
    expect(await apply(execute())).toMatchObject({
      status: "expired",
      fills: [],
      reservation: { margin_usd_raw: "0", fee_usd_raw: "0" },
    });
    expect(await count("btc_ledger_events")).toBe(1);
  });
  it("serializes cancel first against execution using effective state", async () => {
    await apply(submit());
    await capture();
    const results = await Promise.all([apply(cancel()), apply(execute())]);
    expect(
      results.every((r) => r.status === "cancelled" && !r.fills.length),
    ).toBe(true);
    expect(await count("btc_ledger_events")).toBe(1);
  });
  it("serializes execution first against cancellation without reversing the fill", async () => {
    await apply(submit());
    await capture({ depth: "1000000" });
    const results = await Promise.all([apply(execute()), apply(cancel())]);
    expect(results.every((r) => r.status === "filled")).toBe(true);
    expect(await count("btc_ledger_events")).toBe(3);
  });
  it("shares finite depth across competing same-account orders and retries", async () => {
    await apply(submit("o1", { quantity_btc_raw: "600000" }));
    await apply(submit("o2", { quantity_btc_raw: "600000" }));
    await capture({ depth: "900000" });
    const results = await Promise.all([
      apply(execute("o1")),
      apply(execute("o2")),
      apply(execute("o1")),
    ]);
    expect(results[0]).toEqual(results[2]);
    const q = results
      .slice(0, 2)
      .flatMap((r) => r.fills)
      .reduce((n, f) => n + BigInt(f.quantity_btc_raw), 0n);
    expect(q).toBe(900000n);
    expect(results[0]!.book_key).toBe(results[1]!.book_key);
    expect(
      (await readLedgerValuation(pool, scope, iso(Date.now()))).balance_usd_raw,
    ).toBe("999736345");
  });
  it("makes independently funded alternate markets explicit", async () => {
    const other = ledgerScope(identity("alternate"));
    await createLedgerAccount(pool, identity("alternate"));
    await apply(submit());
    await applyIoc(pool, other, submit());
    await capture();
    const a = await apply(execute()),
      b = await applyIoc(pool, other, execute());
    expect(a.market_id).toBe("counterfactual:manual");
    expect(b.market_id).toBe("counterfactual:alternate");
    expect(a.fills).toEqual(b.fills);
  });
  it("reduce-only long exit realizes PnL and fee without reversing inventory", async () => {
    await appendLedgerBatch(pool, scope, {
      transaction_id: "seed",
      events: [
        command("seed", pricedFill("seed", "buy", "600000", "64000000000")),
      ],
    });
    const request = submit("o1", {
      intent: "reduce",
      side: "sell",
      quantity_btc_raw: "600000",
    });
    if (request.action !== "submit") throw new Error("fixture");
    request.intent.limit_price_usd_raw = "64900000000";
    await apply(request);
    await capture({ context: "unknown" });
    const r = await apply(execute());
    expect(r.status).toBe("filled");
    expect(r.fills[0]!.fee_usd_raw).toBe("175230");
    const v = await readLedgerValuation(pool, scope, iso(Date.now()));
    expect(v.positions[0]!.quantity_btc_raw).toBe("0");
    expect(v.realized_pnl_usd_raw).toBe("5400000");
    expect(v.balance_usd_raw).toBe("1005224770");
    await expect(
      apply(
        submit("o2", {
          intent: "reduce",
          side: "sell",
          quantity_btc_raw: "100000",
        }),
      ),
    ).rejects.toThrow("INVENTORY_UNAVAILABLE");
  });
  it("requires the broker for consuming its managed reservation", async () => {
    await apply(submit());
    await expect(
      applyReservation(pool, scope, {
        action: "consume",
        operation_id: "bypass",
        order_id: "o1",
        quantity_btc_raw: "100000",
        price_usd_raw: "65100000000",
        fee_usd_raw: "29295",
      }),
    ).rejects.toThrow("IOC_BROKER_REQUIRED");
    expect(await count("btc_ledger_events")).toBe(1);
  });
  it("reduce-only short exit realizes independent PnL and clears all inventory", async () => {
    await appendLedgerBatch(pool, scope, {
      transaction_id: "seed",
      events: [
        command("seed", pricedFill("seed", "sell", "600000", "66000000000")),
      ],
    });
    await apply(
      submit("o1", {
        intent: "reduce",
        side: "buy",
        quantity_btc_raw: "600000",
      }),
    );
    await capture({ context: "unknown" });
    const result = await apply(execute());
    expect(result.status).toBe("filled");
    const v = await readLedgerValuation(pool, scope, iso(Date.now()));
    expect(v.positions[0]!.quantity_btc_raw).toBe("0");
    expect(v.realized_pnl_usd_raw).toBe("5400000");
    expect(v.balance_usd_raw).toBe("1005224230");
  });
  it("rolls back ledger, reservation, depth and evidence on an insert failure", async () => {
    await apply(submit());
    await capture();
    const before = await snapshot();
    hook = async (sql, tx) => {
      if (sql.startsWith("INSERT INTO btc_ioc_results"))
        await tx.query("SELECT 1/0");
    };
    await expect(apply(execute())).rejects.toThrow();
    hook = null;
    expect(await snapshot()).toEqual(before);
    expect((await apply(execute())).fills).toHaveLength(1);
  });
  it("rejects missing fee metadata and detects idempotency collisions", async () => {
    const request = submit();
    if (request.action !== "submit") throw new Error("fixture");
    request.intent.fee_metadata_id = "missing";
    await expect(apply(request)).rejects.toThrow("FEE_METADATA_UNAVAILABLE");
    expect(await count("btc_order_acceptances")).toBe(0);
    const valid = submit();
    await apply(valid);
    expect(await apply(valid)).toMatchObject({ status: "accepted" });
    await expect(
      apply({ ...cancel(), operation_id: valid.operation_id }),
    ).rejects.toThrow("IDEMPOTENCY_COLLISION");
  });
  it("honors cancellation through the reservation adapter before IOC processing", async () => {
    await apply(submit());
    await applyReservation(pool, scope, {
      action: "release",
      order_id: "o1",
      operation_id: "external:cancel",
      reason: "cancelled",
    });
    expect((await apply(execute())).reason).toBe("already_terminal");
    expect((await readLedgerAccount(pool, scope)).events).toHaveLength(1);
  });
});
