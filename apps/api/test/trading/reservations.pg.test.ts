import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlExecutor } from "../../src/database.js";
import { applyReservation } from "../../src/storage/reservationstore.js";
import type { ReservationCommand } from "../../src/storage/reservation-contract.js";
import {
  appendLedgerBatch,
  createLedgerAccount,
  readLedgerAccount,
} from "../../src/storage/ledgerstore.js";
import { readLedgerValuation } from "../../src/storage/valuationstore.js";
import { captureBtcMarketBatch } from "../../src/storage/btc-marketstore.js";
import {
  storeRetentionObjectTx,
  withBtcRetentionTransaction,
} from "../../src/storage/btc-retention.js";
import { ledgerScope } from "../../src/trading/ledger.js";
import { positionMargin } from "../../src/trading/reservations.js";
import { createPgFixture } from "../pg-fixture.js";
import { command, fill, identity, iso, usd } from "./ledger-fixture.js";
import { health, metadata } from "./bars-fixture.js";
import { market, pricedFill } from "./valuation-fixture.js";
import { order } from "./reservation-fixture.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let fixture: Awaited<ReturnType<typeof createPgFixture>>;
let failure: string | null = null;
const pool = {
  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>) {
    const client = await fixture.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout='3000ms'");
      const result = await run({
        async query(sql, params) {
          if (failure && sql.startsWith(failure))
            await client.query("SELECT 1/0");
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
const scope = ledgerScope(identity());
const accept = (
  o = order(),
  operation_id = `reserve:${o.order_id}`,
): ReservationCommand => ({ action: "reserve", operation_id, order: o });
const take = (
  order_id = "order:1",
  operation_id = "fill:1",
  quantity_btc_raw = "400000",
): ReservationCommand => ({
  action: "consume",
  operation_id,
  order_id,
  quantity_btc_raw,
  price_usd_raw: "65000000000",
  fee_usd_raw: "260000",
});
const apply = (r: ReservationCommand) => applyReservation(pool, scope, r);
async function capture(quality = "fresh") {
  const at = Date.now() - (quality === "stale" ? 11_000 : 0),
    m = market(at),
    h = health(at);
  Object.assign(h.channels, m.capture!.health.channels);
  const context =
    quality === "degraded"
      ? {
          ...m.context!.payload,
          source_timestamp: null,
          quality: "unknown" as const,
        }
      : m.context!.payload;
  if (quality === "degraded") {
    await captureBtcMarketBatch(
      pool,
      {
        sessionId: "reservation-fixture",
        capturedAt: iso(at),
        metadata,
        events: [m.book!.payload, context],
        health: h,
      },
      true,
    );
    return;
  }
  // Arithmetic/concurrency fixture only. The real context adapter correctly
  // refuses a made-up source timestamp, so seed explicit independent evidence
  // via the retention store in the disposable DB; never weaken that adapter.
  await withBtcRetentionTransaction(pool, async (tx) => {
    for (const [kind, payload] of [
      ["context", context],
      ["book", m.book!.payload],
      ["capture", m.capture],
    ] as const) {
      const id = `synthetic:${kind}:${at}`;
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
}
async function snapshot() {
  const result = [];
  for (const table of [
    "btc_order_acceptances",
    "btc_reservation_events",
    "btc_ledger_events",
    "btc_ledger_transactions",
    "btc_ledger_projections",
  ])
    result.push(
      (
        await fixture.pool.query(
          `SELECT to_jsonb(t) value FROM ${table} t ORDER BY to_jsonb(t)::text`,
        )
      ).rows,
    );
  return result;
}
describe.skipIf(!url)("S3 atomic reservations on real PostgreSQL", () => {
  beforeEach(async () => {
    fixture = await createPgFixture(url);
    failure = null;
    await createLedgerAccount(pool, identity());
  });
  afterEach(async () => {
    await fixture?.dispose();
  });
  it("serializes simultaneous orders that together exceed capital, including pending fees", async () => {
    await capture();
    const attempts = await Promise.allSettled([
      apply(accept()),
      apply(accept(order("order:2", { source: "strategy" }))),
    ]);
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      attempts
        .filter((r) => r.status === "rejected")
        .map((r) => String(r.reason)),
    ).toEqual([expect.stringContaining("MARGIN_UNAVAILABLE")]);
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int n FROM btc_order_acceptances",
        )
      ).rows[0].n,
    ).toBe(1);
    expect((await readLedgerAccount(pool, scope)).projection.cash_usd_raw).toBe(
      "1000000000",
    );
    const before = await snapshot();
    await expect(
      apply(
        accept(
          order("fees", {
            quantity_btc_raw: "100000",
            price_cap_usd_raw: "349350000000",
          }),
        ),
      ),
    ).rejects.toThrow("MARGIN_UNAVAILABLE");
    expect(await snapshot()).toEqual(before);
  });
  it("retries acceptance/consumption once and refuses collisions and foreign owners", async () => {
    await capture();
    const request = accept();
    expect(
      (await Promise.all([apply(request), apply(request)]))
        .map((r) => r.status)
        .sort(),
    ).toEqual(["applied", "duplicate"]);
    const consumed = take();
    expect(
      (await Promise.all([apply(consumed), apply(consumed)]))
        .map((r) => r.status)
        .sort(),
    ).toEqual(["applied", "duplicate"]);
    const before = await snapshot();
    await expect(
      apply({ ...consumed, fee_usd_raw: "1" } as ReservationCommand),
    ).rejects.toThrow("IDEMPOTENCY_COLLISION");
    await expect(
      applyReservation(pool, { ...scope, experiment_id: "wrong" }, request),
    ).rejects.toThrow("OWNERSHIP");
    expect(await snapshot()).toEqual(before);
    expect((await readLedgerAccount(pool, scope)).events).toHaveLength(3);
  });
  it("never borrows between experiments and scopes identical IDs to their owner", async () => {
    await capture();
    await createLedgerAccount(pool, identity("other"));
    const other = ledgerScope(identity("other")),
      request = accept();
    await Promise.all([apply(request), applyReservation(pool, other, request)]);
    await expect(apply(accept(order("more")))).rejects.toThrow(
      "MARGIN_UNAVAILABLE",
    );
    await applyReservation(pool, other, {
      action: "release",
      operation_id: "cancel",
      order_id: "order:1",
      reason: "cancelled",
    });
    await expect(apply(accept(order("more")))).rejects.toThrow(
      "MARGIN_UNAVAILABLE",
    );
    await expect(applyReservation(pool, other, take())).rejects.toThrow(
      "ORDER_CLOSED",
    );
  });
  it.each(["buy", "sell"] as const)(
    "serializes two exits against the same %s inventory even with degraded marks",
    async (side) => {
      await appendLedgerBatch(pool, scope, {
        transaction_id: "initial",
        events: [command("initial", pricedFill("initial", side))],
      });
      await capture("degraded");
      const a = order("a", {
        intent: "reduce",
        side: side === "buy" ? "sell" : "buy",
        quantity_btc_raw: "600000",
      });
      const results = await Promise.allSettled([
        apply(accept(a)),
        apply(accept({ ...a, order_id: "b" })),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        results
          .filter((r) => r.status === "rejected")
          .map((r) => String(r.reason)),
      ).toEqual([expect.stringContaining("INVENTORY_UNAVAILABLE")]);
      const winner = results[0]!.status === "fulfilled" ? "a" : "b";
      await apply(take(winner, "partial", "400000"));
      await expect(
        apply(
          accept(
            order("too-much", {
              ...a,
              order_id: "too-much",
              quantity_btc_raw: "500000",
            }),
          ),
        ),
      ).rejects.toThrow("INVENTORY_UNAVAILABLE");
    },
  );
  it("atomically exchanges a partial hold for a position and charges only the actual fee", async () => {
    await capture();
    await apply(accept());
    const b = await apply(take());
    expect(b.reservation).toMatchObject({
      margin_usd_raw: "390000000",
      fee_usd_raw: "390000",
      remaining_btc_raw: "600000",
    });
    const f = await readLedgerValuation(pool, scope, iso(Date.now()));
    expect(positionMargin(f)).toBe(260_000_000n);
    expect(f.balance_usd_raw).toBe("999740000");
    expect(f.ledger.positions[0]!.quantity_btc_raw).toBe("400000");
    await apply({
      action: "release",
      operation_id: "cancel",
      order_id: "order:1",
      reason: "cancelled",
    });
    expect((await readLedgerAccount(pool, scope)).projection).toEqual(f.ledger);
    await expect(
      appendLedgerBatch(pool, scope, {
        transaction_id: "bypass",
        events: [command("bypass", fill("bypass"))],
      }),
    ).rejects.toThrow("RESERVATION_REQUIRED");
  });
  it("rolls back acceptance and fill/fee/projection when journal INSERT fails, then retries cleanly", async () => {
    await capture();
    let before = await snapshot();
    const a = accept();
    failure = "INSERT INTO btc_reservation_events";
    await expect(apply(a)).rejects.toThrow("division by zero");
    expect(await snapshot()).toEqual(before);
    failure = null;
    await apply(a);
    before = await snapshot();
    failure = "INSERT INTO btc_reservation_events";
    await expect(apply(take())).rejects.toThrow("division by zero");
    expect(await snapshot()).toEqual(before);
    failure = null;
    expect((await apply(take())).status).toBe("applied");
  });
  it("retains expired holds until an explicit expiry transition commits", async () => {
    await capture();
    await apply(
      accept(order("order:1", { valid_until: iso(Date.now() + 400) })),
    );
    await expect(
      apply({
        action: "release",
        operation_id: "early",
        order_id: "order:1",
        reason: "expired",
      }),
    ).rejects.toThrow("NOT_EXPIRED");
    await new Promise((r) => setTimeout(r, 450));
    await expect(apply(accept(order("b")))).rejects.toThrow(
      "MARGIN_UNAVAILABLE",
    );
    await expect(apply(take())).rejects.toThrow("EXPIRED");
    const expiry: ReservationCommand = {
      action: "release",
      operation_id: "expiry",
      order_id: "order:1",
      reason: "expired",
    };
    await apply(expiry);
    expect((await apply(expiry)).status).toBe("duplicate");
    await apply(accept(order("b")));
  });
  it.each(["missing", "stale", "degraded"])(
    "fails closed for %s financial evidence without persisting acceptance",
    async (quality) => {
      if (quality !== "missing") await capture(quality);
      const before = await snapshot();
      await expect(apply(accept())).rejects.toThrow("FINANCE_UNAVAILABLE");
      expect(await snapshot()).toEqual(before);
    },
  );
  it("checks fill quantum, price, fee and post-fill capacity inside the same rollback boundary", async () => {
    await capture();
    await apply(accept());
    const before = await snapshot();
    await expect(
      apply({
        ...take(),
        quantity_btc_raw: "1",
        fee_usd_raw: "0",
      } as ReservationCommand),
    ).rejects.toThrow("INEXACT_FILL");
    await expect(
      apply({ ...take(), price_usd_raw: "66000000000" } as ReservationCommand),
    ).rejects.toThrow("PRICE_CAP");
    await expect(
      apply({ ...take(), fee_usd_raw: "260001" } as ReservationCommand),
    ).rejects.toThrow("FEE_CAP");
    expect(await snapshot()).toEqual(before);
    // A subsequent loss cannot be ignored because the earlier reservation succeeded.
    await appendLedgerBatch(pool, scope, {
      transaction_id: "loss",
      events: [
        command("loss", {
          event_type: "cash",
          reason: "transfer",
          delta: usd("-900000000"),
        }),
      ],
    });
    const loss = await snapshot();
    await expect(apply(take())).rejects.toThrow("MARGIN_UNAVAILABLE");
    expect(await snapshot()).toEqual(loss);
  });
  it("takes the owner lock before any order lock; concurrent fill/cancel/accept terminate without deadlock", async () => {
    await capture();
    await apply(accept());
    const locker = await fixture.pool.connect();
    await locker.query("BEGIN");
    await locker.query(
      "SELECT 1 FROM btc_ledger_accounts WHERE account_id=$1 FOR UPDATE",
      [scope.account_id],
    );
    let settled = false;
    const running = Promise.allSettled([
      apply(take()),
      apply({
        action: "release",
        operation_id: "cancel",
        order_id: "order:1",
        reason: "cancelled",
      }),
      apply(accept(order("small", { quantity_btc_raw: "100000" }))),
    ]).then((r) => {
      settled = true;
      return r;
    });
    try {
      let observed = false;
      for (let i = 0; i < 50; i++) {
        await locker.query("SELECT pg_stat_clear_snapshot()");
        const blocked = await locker.query(
          "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT identity FROM btc_ledger_accounts%'",
        );
        if (blocked.rows[0].n === 3) {
          observed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(observed).toBe(true);
      expect(settled).toBe(false);
    } finally {
      await locker.query("COMMIT");
      locker.release();
    }
    const results = await running;
    expect(
      results.filter((r) => r.status === "fulfilled").length,
    ).toBeGreaterThanOrEqual(2);
    for (const r of results)
      if (r.status === "rejected")
        expect(String(r.reason)).toContain("ORDER_CLOSED");
    const latest = (
      await fixture.pool.query(
        "SELECT reservation FROM btc_reservation_events WHERE order_id='order:1' ORDER BY sequence DESC LIMIT 1",
      )
    ).rows[0].reservation;
    expect(latest.status).toBe("cancelled");
  });
  it("keeps acceptance and journal append-only and creates no runtime activation", async () => {
    await capture();
    await apply(accept());
    for (const table of ["btc_order_acceptances", "btc_reservation_events"]) {
      await expect(fixture.pool.query(`DELETE FROM ${table}`)).rejects.toThrow(
        "APPEND_ONLY",
      );
      await expect(
        fixture.pool.query(`TRUNCATE ${table} CASCADE`),
      ).rejects.toThrow("APPEND_ONLY");
    }
    expect(
      (await fixture.pool.query("SELECT status FROM btc_ledger_accounts")).rows,
    ).toEqual([{ status: "disabled" }]);
  });
});
