import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLedgerAccount,
  appendLedgerBatch,
  readLedgerAccount,
} from "../../src/storage/ledgerstore.js";
import {
  applyReservation,
  readReservationsTx,
} from "../../src/storage/reservationstore.js";
import { applyRisk, readRiskTx } from "../../src/storage/riskstore.js";
import { identity, command, usd } from "./ledger-fixture.js";
import { seedMarginMetadata } from "./margin-fixture.js";
import {
  riskFixture,
  riskOrder,
  seedRiskFunding,
  scope,
} from "./risk-fixture.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let f: Awaited<ReturnType<typeof riskFixture>>;
const reserve = (
  id = "one",
  changes: Partial<ReturnType<typeof riskOrder>> = {},
) =>
  applyReservation(f.poolAdapter, scope, {
    action: "reserve",
    operation_id: `r:${id}`,
    order: riskOrder(id, changes),
  });
const consume = (id = "one", q = "100000") =>
  applyReservation(f.poolAdapter, scope, {
    action: "consume",
    operation_id: `c:${id}:${q}`,
    order_id: id,
    quantity_btc_raw: q,
    price_usd_raw: "65000000000",
    fee_usd_raw: "65000",
  });
const risk = (
  action: "observe" | "rearm" | "halt" | "reduce_only" = "observe",
  id: string = crypto.randomUUID(),
) =>
  applyRisk(f.poolAdapter, scope, {
    action,
    operation_id: id,
    reason: "test operator action",
  });
const state = () =>
  f.poolAdapter.transaction((tx) => readRiskTx(tx, scope.account_id));
const orders = () =>
  f.poolAdapter.transaction((tx) => readReservationsTx(tx, scope.account_id));
describe.skipIf(!url)(
  "S8 operational limits on real disposable PostgreSQL",
  () => {
    beforeEach(async () => {
      f = await riskFixture(url);
      await createLedgerAccount(f.poolAdapter, identity());
      await seedMarginMetadata(f.poolAdapter);
      await seedRiskFunding(f.poolAdapter);
      await f.capture();
    });
    afterEach(async () => {
      vi.useRealTimers();
      await f?.dispose();
    });
    it.each(["manual", "strategy"] as const)(
      "enforces identical caps for %s and refuses caller policy override",
      async (source) => {
        await expect(
          reserve("large", { source, quantity_btc_raw: "400000" }),
        ).rejects.toThrow("EXPOSURE_LIMIT");
        await expect(
          reserve("plan", {
            source,
            quantity_btc_raw: "300000",
            risk_plan: {
              entry_floor_usd_raw: "64000000000",
              stop_price_usd_raw: "63900000000",
            },
          }),
        ).rejects.toThrow("PLANNED_LIMIT");
        const missing = riskOrder("missing", { source });
        delete missing.risk_plan;
        await expect(
          applyReservation(f.poolAdapter, scope, {
            action: "reserve",
            operation_id: "missing",
            order: missing,
          }),
        ).rejects.toThrow("PLAN_REQUIRED");
        expect(await orders()).toEqual([]);
      },
    );
    it("serializes simultaneous entries under the owner lock and forbids pyramiding", async () => {
      const r = await Promise.allSettled([
        reserve("a", { quantity_btc_raw: "200000" }),
        reserve("b", { source: "strategy", quantity_btc_raw: "200000" }),
      ]);
      expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      expect(
        String(
          (r.find((x) => x.status === "rejected") as PromiseRejectedResult)
            .reason,
        ),
      ).toContain("NO_PYRAMIDING");
      expect(
        (await orders()).filter((o) => o.status === "active"),
      ).toHaveLength(1);
    });
    it("partial fill replaces only consumed hold, actual fee once, then blocks a second entry", async () => {
      await reserve("one", { quantity_btc_raw: "200000" });
      await consume("one");
      const ledger = await readLedgerAccount(f.poolAdapter, scope);
      expect(ledger.projection.cash_usd_raw).toBe("999935000");
      expect((await orders())[0]!.remaining_btc_raw).toBe("100000");
      await expect(reserve("two")).rejects.toThrow("NO_PYRAMIDING");
      expect((await consume("one")).status).toBe("duplicate");
    });
    it("mark loss latches pause, cancels remaining increases, survives restart and rejects rearm", async () => {
      await reserve("one", { quantity_btc_raw: "200000" });
      await consume("one");
      await f.capture({ mark: "49000000000" });
      const paused = await risk();
      expect(paused.state).toBe("REDUCE_ONLY");
      expect(paused.reasons).toContain("daily_loss");
      expect((await orders())[0]!.status).toBe("cancelled");
      await expect(risk("rearm")).rejects.toThrow("REARM_CONDITIONS");
      expect((await state())!.daily_anchor_usd_raw).toBe(
        paused.daily_anchor_usd_raw,
      );
      await f.capture();
      const recovered = await applyRisk(
        { transaction: f.poolAdapter.transaction },
        { ...scope },
        { action: "observe", operation_id: "restart", reason: "restart" },
      );
      expect(recovered.state).toBe("REDUCE_ONLY");
      expect((await risk("rearm", "operator")).state).toBe("NORMAL");
      expect((await state())!.high_water_usd_raw).toBe("1000000000");
    });
    it.each(["49000000000", "1000000"])(
      "consume rechecks mark %s and commits pause/cancel even on insolvency",
      async (mark) => {
        await reserve("one", { quantity_btc_raw: "200000" });
        await consume("one");
        await f.capture({ mark });
        await expect(
          applyReservation(f.poolAdapter, scope, {
            action: "consume",
            operation_id: "second",
            order_id: "one",
            quantity_btc_raw: "100000",
            price_usd_raw: "65000000000",
            fee_usd_raw: "65000",
          }),
        ).rejects.toThrow("REDUCE_ONLY");
        expect((await state())!.state).toBe("REDUCE_ONLY");
        expect((await orders())[0]!.status).toBe("cancelled");
        expect(
          (await readLedgerAccount(f.poolAdapter, scope)).events,
        ).toHaveLength(3);
      },
    );
    it("allows bounded reduce-only exit and cancellation in pause, prevents inversion", async () => {
      await reserve();
      await consume();
      await risk("reduce_only");
      await reserve("exit", { intent: "reduce", side: "sell" });
      await expect(
        reserve("over", {
          intent: "reduce",
          side: "sell",
          quantity_btc_raw: "1000",
        }),
      ).rejects.toThrow("INVENTORY_UNAVAILABLE");
      await consume("exit");
      expect(
        (await readLedgerAccount(f.poolAdapter, scope)).projection.positions[0]!
          .quantity_btc_raw,
      ).toBe("0");
      expect((await state())!.state).toBe("REDUCE_ONLY");
    });
    it("a reduction cancels an old opening remainder even in NORMAL", async () => {
      await reserve("one", { quantity_btc_raw: "200000" });
      await consume();
      await reserve("exit", { intent: "reduce", side: "sell" });
      expect(
        (await orders()).find((o) => o.order.order_id === "one")!.status,
      ).toBe("cancelled");
      expect((await state())!.state).toBe("NORMAL");
      await expect(
        applyReservation(f.poolAdapter, scope, {
          action: "consume",
          operation_id: "late-entry",
          order_id: "one",
          quantity_btc_raw: "100000",
          price_usd_raw: "65000000000",
          fee_usd_raw: "0",
        }),
      ).rejects.toThrow("ORDER_CLOSED");
    });
    it("HALTED permits cancellation only and explicit eligible rearm", async () => {
      await reserve();
      await consume();
      await reserve("exit", { intent: "reduce", side: "sell" });
      await risk("halt");
      await expect(consume("exit")).rejects.toThrow("HALTED");
      await applyReservation(f.poolAdapter, scope, {
        action: "release",
        operation_id: "cancel",
        order_id: "exit",
        reason: "cancelled",
      });
      expect((await risk("rearm")).state).toBe("NORMAL");
    });
    it.each(["mark", "book", "unknown"])(
      "missing freshness (%s) cannot be supplied by caller and latches pause",
      async (kind) => {
        await f.capture(
          kind === "mark"
            ? { markStale: true }
            : kind === "book"
              ? { bookStale: true }
              : { unknown: true },
        );
        await expect(reserve()).rejects.toThrow("REDUCE_ONLY");
        expect((await state())!.state).toBe("REDUCE_ONLY");
      },
    );
    it("external capital scales anchors without concealing an already triggered loss", async () => {
      await reserve();
      await consume();
      await f.capture({ mark: "49000000000" });
      await risk();
      const before = (await state())!;
      await appendLedgerBatch(f.poolAdapter, scope, {
        transaction_id: "deposit",
        events: [
          command(
            "deposit",
            { event_type: "cash", reason: "transfer", delta: usd("983935000") },
            scope,
            Date.now(),
          ),
        ],
      });
      const after = (await state())!;
      expect(after.daily_anchor_usd_raw).toBe(
        (BigInt(before.daily_anchor_usd_raw!) * 2n).toString(),
      );
      expect(after.high_water_usd_raw).toBe(
        (BigInt(before.high_water_usd_raw) * 2n).toString(),
      );
      expect(after.state).toBe("REDUCE_ONLY");
      await expect(risk("rearm")).rejects.toThrow("REARM_CONDITIONS");
    });

    it("drawdown uses the persisted maximum even without a daily loss", async () => {
      await reserve();
      await consume();
      await f.capture({ mark: "120000000000" });
      const high = await risk();
      expect(high.high_water_usd_raw).toBe("1054935000");
      await f.capture();
      const paused = await risk();
      expect(paused.reasons).toContain("drawdown");
      expect(paused.reasons).not.toContain("daily_loss");
      expect(paused.high_water_usd_raw).toBe(high.high_water_usd_raw);
      await expect(risk("rearm")).rejects.toThrow("REARM_CONDITIONS");
    });
    it("permits the exact reserved exposure cap but rolls back a fee that would cross it on fill", async () => {
      await f.capture({ mark: "62500000000" });
      const changes = {
        quantity_btc_raw: "400000",
        price_cap_usd_raw: "62500000000",
        risk_plan: {
          entry_floor_usd_raw: "62500000000",
          stop_price_usd_raw: "62490000000",
        },
      };
      await expect(
        reserve("above", { ...changes, quantity_btc_raw: "401000" }),
      ).rejects.toThrow("EXPOSURE_LIMIT");
      await reserve("edge", changes);
      await expect(
        applyReservation(f.poolAdapter, scope, {
          action: "consume",
          operation_id: "edge-fill",
          order_id: "edge",
          quantity_btc_raw: "400000",
          price_usd_raw: "62500000000",
          fee_usd_raw: "250000",
        }),
      ).rejects.toThrow("EXPOSURE_LIMIT");
      expect(
        (await readLedgerAccount(f.poolAdapter, scope)).events,
      ).toHaveLength(1);
      expect((await orders())[0]!.remaining_btc_raw).toBe("400000");
    });
    it("missing executable evidence blocks exit fills while cancellation stays available", async () => {
      await reserve();
      await consume();
      await risk("reduce_only");
      await reserve("exit", { intent: "reduce", side: "sell" });
      await f.capture({ bookStale: true });
      await expect(consume("exit")).rejects.toThrow("EXIT_BOOK_UNAVAILABLE");
      await applyReservation(f.poolAdapter, scope, {
        action: "release",
        operation_id: "exit-cancel",
        order_id: "exit",
        reason: "cancelled",
      });
      expect(
        (await readLedgerAccount(f.poolAdapter, scope)).events,
      ).toHaveLength(3);
    });
    it("accounting mismatch durably halts and still permits a reduce-order cancellation", async () => {
      await reserve();
      await consume();
      await reserve("exit", { intent: "reduce", side: "sell" });
      await f.pool.query(
        "UPDATE btc_ledger_projections SET projection=jsonb_set(projection,'{cash_usd_raw}','\"1\"'::jsonb) WHERE account_id=$1",
        [scope.account_id],
      );
      await expect(consume("exit")).rejects.toThrow("ACCOUNTING_INCONSISTENT");
      expect((await state())!.state).toBe("HALTED");
      await applyReservation(f.poolAdapter, scope, {
        action: "release",
        operation_id: "corrupt-cancel",
        order_id: "exit",
        reason: "cancelled",
      });
      expect(
        (await orders()).find((o) => o.order.order_id === "exit")!.status,
      ).toBe("cancelled");
      await expect(risk("rearm")).rejects.toThrow("ACCOUNTING_INCONSISTENT");
    });
    it("observed funding triggers the daily limit once, without waiting for an order", async () => {
      const { ledgerScope } = await import("../../src/trading/ledger.js");
      const { pricedFill } = await import("./valuation-fixture.js");
      const { reconcileFunding } =
        await import("../../src/storage/fundingstore.js");
      const { market } = await import("./valuation-fixture.js");
      const { withBtcRetentionTransaction, storeRetentionObjectTx } =
        await import("../../src/storage/btc-retention.js");
      const owner = ledgerScope(identity("funding")),
        at = Date.now() - 500;
      await createLedgerAccount(f.poolAdapter, identity("funding"));
      await appendLedgerBatch(f.poolAdapter, owner, {
        transaction_id: "seed",
        events: [
          command(
            "seed",
            pricedFill("seed", "buy", "300000", "68000000000"),
            owner,
            at - 100,
          ),
        ],
      });
      const before = await applyRisk(f.poolAdapter, owner, {
        action: "observe",
        operation_id: "before",
        reason: "funding observation",
      });
      expect(before.reasons).not.toContain("daily_loss");
      const id = "funding-limit-oracle";
      await withBtcRetentionTransaction(f.poolAdapter, async (tx) => {
        await storeRetentionObjectTx(tx, {
          id,
          class: "raw",
          identity: owner,
          recordedAt: new Date(at),
          payload: market(at).context!.payload,
          dependencies: [],
        });
        await tx.query(
          "INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES($1,'context',$2,$2)",
          [id, new Date(at).toISOString()],
        );
      });
      const cmd = {
        operation_id: "funding-limit",
        period_hour: new Date(Math.floor(at / 3600000) * 3600000).toISOString(),
        oracle_object_id: id,
        observation: {
          source: "hyperliquid:mainnet:fundingHistory" as const,
          received_at: new Date(at + 100).toISOString(),
          row: { coin: "BTC", time: at, fundingRate: "0.04", premium: "0" },
        },
      };
      expect((await reconcileFunding(f.poolAdapter, owner, cmd)).status).toBe(
        "settled",
      );
      const after = await f.poolAdapter.transaction((tx) =>
        readRiskTx(tx, owner.account_id),
      );
      expect(after!.reasons).toContain("daily_loss");
      expect(after!.equity_usd_raw).toBe("983201200");
      await reconcileFunding(f.poolAdapter, owner, cmd);
      expect(
        (await readLedgerAccount(f.poolAdapter, owner)).events.filter(
          (e) => e.payload.event_type === "funding",
        ),
      ).toHaveLength(1);
    });

    it.each([true, false])(
      "UTC anchor uses only evidence at midnight; available=%s",
      async (available) => {
        // SQL persistence and guards are real. Only the test adapter's DB-clock
        // query is controlled to exercise a historical UTC boundary without wait.
        const { ledgerScope } = await import("../../src/trading/ledger.js");
        const midnight = Date.parse(
            new Date().toISOString().slice(0, 10) + "T00:00:00.000Z",
          ),
          before = midnight - 6000;
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(before);
        f.setClock(new Date(before).toISOString());
        const owner = ledgerScope(identity("utc"));
        await createLedgerAccount(f.poolAdapter, identity("utc"));
        await seedMarginMetadata(f.poolAdapter, before - 500);
        await seedRiskFunding(f.poolAdapter, owner);
        await f.capture({ at: before });
        await applyReservation(f.poolAdapter, owner, {
          action: "reserve",
          operation_id: "utc-open",
          order: riskOrder("utc"),
        });
        await applyReservation(f.poolAdapter, owner, {
          action: "consume",
          operation_id: "utc-fill",
          order_id: "utc",
          quantity_btc_raw: "100000",
          price_usd_raw: "65000000000",
          fee_usd_raw: "0",
        });
        if (available) await f.capture({ at: midnight - 1 });
        vi.setSystemTime(midnight + 1000);
        f.setClock(new Date(midnight + 1000).toISOString());
        await f.capture({ at: midnight + 1000, mark: "50000000000" });
        const checkpoint = await applyRisk(f.poolAdapter, owner, {
          action: "observe",
          operation_id: "utc-observe",
          reason: "UTC boundary",
        });
        expect(checkpoint.daily_anchor_usd_raw).toBe(
          available ? "1000000000" : null,
        );
        expect(checkpoint.reasons).toContain(
          available ? "daily_loss" : "utc_anchor_unavailable",
        );
        expect(checkpoint.high_water_usd_raw).toBe("1000000000");
        await expect(
          applyRisk(f.poolAdapter, owner, {
            action: "rearm",
            operation_id: "utc-rearm",
            reason: "do not reset",
          }),
        ).rejects.toThrow("REARM_CONDITIONS");
      },
    );
    it("keeps ownership, immutable journals and operator action idempotency", async () => {
      const paused = await risk("halt", "pause");
      expect(await risk("halt", "pause")).toEqual(paused);
      await expect(risk("rearm", "pause")).rejects.toThrow(
        "IDEMPOTENCY_COLLISION",
      );
      await expect(
        applyRisk(
          f.poolAdapter,
          { ...scope, experiment_id: "foreign" },
          { operation_id: "bad", action: "rearm", reason: "bad" },
        ),
      ).rejects.toThrow("OWNERSHIP");
      for (const sql of [
        "UPDATE btc_risk_events SET evidence='{}'",
        "DELETE FROM btc_risk_events",
        "TRUNCATE btc_risk_events CASCADE",
      ])
        await expect(f.pool.query(sql)).rejects.toThrow("APPEND_ONLY");
    });
    it("rolls back a fill if its book expires during SQL and commits the pause", async () => {
      await reserve();
      f.setHook(async (sql, tx) => {
        if (sql.startsWith("INSERT INTO btc_ledger_transactions"))
          await tx.query("SELECT pg_sleep(2.05)");
      });
      await expect(consume()).rejects.toThrow("EXECUTION_DATA_CHANGED");
      f.setHook(null);
      expect(
        (await readLedgerAccount(f.poolAdapter, scope)).events,
      ).toHaveLength(1);
      expect((await state())!.state).toBe("REDUCE_ONLY");
      expect((await orders())[0]!.status).toBe("cancelled");
    });
    it("rolls journal, acceptance and fill back on SQL failure", async () => {
      f.setHook(async (sql, tx) => {
        if (sql.startsWith("INSERT INTO btc_risk_events"))
          await tx.query("SELECT 1/0");
      });
      await expect(reserve()).rejects.toThrow("division by zero");
      f.setHook(null);
      expect(await state()).toBeNull();
      expect(await orders()).toEqual([]);
      await reserve();
    });
  },
);
