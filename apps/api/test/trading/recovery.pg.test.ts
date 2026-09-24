import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlExecutor } from "../../src/database.js";
import {
  recoverAccount,
  recoveryTransaction,
} from "../../src/storage/recoverystore.js";
import { recoverySnapshotTx } from "../../src/storage/recovery-audit.js";
import {
  createLedgerAccount,
  appendLedgerBatch,
  readLedgerAccount,
} from "../../src/storage/ledgerstore.js";
import {
  applyReservation,
  readReservationsTx,
} from "../../src/storage/reservationstore.js";
import {
  reconcileFunding,
  type FundingCommand,
} from "../../src/storage/fundingstore.js";
import { applyRisk, readRiskTx } from "../../src/storage/riskstore.js";
import { applyIoc } from "../../src/storage/brokerstore.js";
import { applyPassive } from "../../src/storage/passivestore.js";
import {
  withBtcRetentionTransaction,
  storeRetentionObjectTx,
} from "../../src/storage/btc-retention.js";
import { replayLedger } from "../../src/trading/ledger.js";
import { identity, iso, command, fill } from "./ledger-fixture.js";
import {
  riskFixture,
  riskOrder,
  seedRiskFunding,
  scope,
} from "./risk-fixture.js";
import { seedMarginMetadata } from "./margin-fixture.js";
import { market } from "./valuation-fixture.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let f: Awaited<ReturnType<typeof riskFixture>>;
// Independent worker identities use real clients in the same disposable PG.
function worker() {
  let failure: "before" | "after" | null = null;
  let clock: string | null = null;
  let hook: ((sql: string, tx: SqlExecutor) => Promise<void>) | null = null;
  const pool = {
    async transaction<T>(run: (tx: SqlExecutor) => Promise<T>) {
      const c = await f.pool.connect();

      let broken = false;
      const tx: SqlExecutor = {
        async query(sql, params) {
          const r =
            clock && sql === "SELECT clock_timestamp() AS now"
              ? await c.query("SELECT $1::timestamptz AS now", [clock])
              : await c.query(sql, params ? [...params] : []);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        },
      };
      try {
        await c.query("BEGIN");
        const value = await run({
          async query(sql, params) {
            await hook?.(sql, tx);
            return tx.query(sql, params);
          },
        });
        const crash = async () => {
          const pid = (await c.query("SELECT pg_backend_pid() AS pid")).rows[0]
            .pid;
          const terminated = new Promise<void>((resolve) =>
            c.once("error", () => resolve()),
          );
          await f.pool.query("SELECT pg_terminate_backend($1)", [pid]);
          await terminated;
          broken = true;
          failure = null;
          throw new Error("simulated worker connection loss");
        };
        if (failure === "before") await crash();
        await c.query("COMMIT");
        if (failure === "after") await crash();
        return value;
      } catch (e) {
        if (!broken) await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release(broken);
      }
    },
  };
  return {
    pool,
    clock: (at: string) => {
      clock = at;
    },
    fail: (when: typeof failure) => {
      failure = when;
    },
    hook: (fn: typeof hook) => {
      hook = fn;
    },
  };
}
let w: ReturnType<typeof worker>, metadataId: string;
let stableOrder: ReturnType<typeof riskOrder>;
const reserveCommand = () => ({
  action: "reserve" as const,
  operation_id: "reserve:one",
  order: stableOrder,
});
const fillCommand = {
  action: "consume" as const,
  operation_id: "fill:one",
  order_id: "one",
  quantity_btc_raw: "100000",
  price_usd_raw: "65000000000",
  fee_usd_raw: "65000",
};
const cancelCommand = {
  action: "release" as const,
  operation_id: "cancel:one",
  order_id: "one",
  reason: "cancelled" as const,
};
const reserve = () => applyReservation(w.pool, scope, reserveCommand());
const fillOne = () => applyReservation(w.pool, scope, fillCommand);
const expire = () =>
  f.pool.query(
    "UPDATE btc_recovery_heads SET lease_until=clock_timestamp()-interval '1 second'",
  );
const snapshot = () =>
  w.pool.transaction((tx) => recoverySnapshotTx(tx, scope.account_id));
const ledger = () => readLedgerAccount(w.pool, scope);
const orders = () =>
  w.pool.transaction((tx) => readReservationsTx(tx, scope.account_id));
async function fundingCommand(): Promise<FundingCommand> {
  // A real committed position predates this synthetic settlement. No backdated
  // fill and no S8 cap bypass is used to manufacture the case.
  vi.setSystemTime(Date.now() + 3600000);
  w.clock(iso(Date.now()));
  const at = Date.now(),
    m = market(at),
    id = `oracle:${at}`;
  await withBtcRetentionTransaction(w.pool, async (tx) => {
    await storeRetentionObjectTx(tx, {
      id,
      class: "raw",
      identity: scope,
      recordedAt: new Date(at),
      payload: m.context!.payload,
      dependencies: [],
    });
    await tx.query(
      "INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES($1,'context',$2,$2)",
      [id, iso(at)],
    );
  });
  return {
    operation_id: "funding:next",
    period_hour: iso(Math.floor(at / 3600000) * 3600000),
    oracle_object_id: id,
    observation: {
      source: "hyperliquid:mainnet:fundingHistory",
      received_at: iso(at),
      row: { coin: "BTC", time: at, fundingRate: "0.0001", premium: "0" },
    },
  };
}

describe.skipIf(!url)("S9 durable recovery on disposable PostgreSQL", () => {
  beforeEach(async (context) => {
    if (context.task.name.includes("funding loss")) {
      const at = Date.now() - 7200000;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(at);
    }
    f = await riskFixture(url);
    w = worker();
    if (context.task.name.includes("funding loss")) w.clock(iso(Date.now()));
    await createLedgerAccount(w.pool, identity());
    metadataId = await seedMarginMetadata(w.pool);
    await seedRiskFunding(w.pool);
    stableOrder = riskOrder("one", { quantity_btc_raw: "200000" });
    await f.capture();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await f?.dispose();
  });
  it("claims one account exactly once under two concurrent workers and fences the loser", async () => {
    await expire();
    const a = worker(),
      b = worker();
    const r = await Promise.allSettled([
      recoverAccount(a.pool, scope),
      recoverAccount(b.pool, scope),
    ]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(
      String(
        (r.find((x) => x.status === "rejected") as PromiseRejectedResult)
          .reason,
      ),
    ).toContain("OWNED");
    await expect(reserve()).rejects.toThrow("OWNED");
    await expire();
    await expect(reserve()).rejects.toThrow("FENCED");
    const head = (
      await f.pool.query("SELECT generation FROM btc_recovery_heads")
    ).rows[0];
    expect(head.generation).toBe("2");
  });
  it("refuses a foreign owner and a missing account without a durable mutation", async () => {
    const before = await snapshot();
    await expect(
      recoverAccount(w.pool, { ...scope, experiment_id: "foreign" }),
    ).rejects.toThrow("OWNERSHIP");
    await expect(
      recoverAccount(w.pool, { ...scope, account_id: "missing" }),
    ).rejects.toThrow("NOT_FOUND");
    expect(await snapshot()).toEqual(before);
  });
  it("fences in-flight writes if the lease expires before commit", async () => {
    const before = await snapshot();
    let fired = false;
    w.hook(async (sql, tx) => {
      if (!fired && sql.includes("INSERT INTO btc_order_acceptances")) {
        fired = true;
        await tx.query(
          "UPDATE btc_recovery_heads SET lease_until=clock_timestamp()-interval '1 second'",
        );
      }
    });
    await expect(reserve()).rejects.toThrow("FENCED");
    expect(await snapshot()).toEqual(before);
    expect(await orders()).toEqual([]);
  });
  it.each(["reserve", "fill", "cancel"] as const)(
    "rolls back %s when connection dies before COMMIT; replay is identical after boot",
    async (action) => {
      if (action !== "reserve") await reserve();
      const run = () =>
        action === "reserve"
          ? reserve()
          : action === "fill"
            ? fillOne()
            : applyReservation(w.pool, scope, cancelCommand);
      const before = await snapshot();
      w.fail("before");
      await expect(run()).rejects.toThrow("connection loss");
      expect(await snapshot()).toEqual(before);
      await expire();
      w = worker();
      await recoverAccount(w.pool, scope);
      await f.capture();
      await run();
      const committed = await snapshot(),
        l = await ledger();
      expect(replayLedger(l.identity, l.events)).toEqual(l.projection);
      await run();
      expect(await snapshot()).toEqual(committed);
    },
  );
  it.each(["reserve", "fill", "cancel"] as const)(
    "retries %s after an ambiguous committed response without duplicate effects",
    async (action) => {
      if (action !== "reserve") await reserve();
      const run = () =>
        action === "reserve"
          ? reserve()
          : action === "fill"
            ? fillOne()
            : applyReservation(w.pool, scope, cancelCommand);
      w.fail("after");
      await expect(run()).rejects.toThrow("connection loss");
      const committed = await snapshot();
      await expire();
      w = worker();
      await recoverAccount(w.pool, scope);
      await run();
      expect(await snapshot()).toEqual(committed);
      const l = await ledger();
      expect(replayLedger(l.identity, l.events)).toEqual(l.projection);
    },
  );
  it("rebuilds a tampered projection from authority without resetting a pause or anchors", async () => {
    await reserve();
    await fillOne();
    await applyRisk(w.pool, scope, {
      operation_id: "pause",
      action: "reduce_only",
      reason: "operator",
    });
    const before = await snapshot(),
      correct = (await ledger()).projection;
    const risk = await w.pool.transaction((tx) =>
      readRiskTx(tx, scope.account_id),
    );
    await f.pool.query(
      "UPDATE btc_ledger_projections SET projection=jsonb_set(projection,'{cash_usd_raw}','\"9\"')",
    );
    await expect(ledger()).rejects.toThrow("PROJECTION_MISMATCH");
    await expire();
    w = worker();
    await recoverAccount(w.pool, scope);
    expect((await ledger()).projection).toEqual(correct);
    expect(await snapshot()).toEqual(before);
    expect(
      await w.pool.transaction((tx) => readRiskTx(tx, scope.account_id)),
    ).toEqual(risk);
    await expect(reserve()).resolves.toMatchObject({ status: "duplicate" });
  });
  it("blocks divergence of an authoritative event; preserves history and ownership without rearming", async () => {
    await reserve();
    await applyRisk(w.pool, scope, {
      operation_id: "pause",
      action: "halt",
      reason: "operator",
    });
    // Corruption injection is limited to this disposable clone. Production
    // append-only guards remain unchanged and are independently asserted below.
    await f.pool.query(
      "ALTER TABLE btc_reservation_events DISABLE TRIGGER btc_reservation_events_immutable",
    );
    await f.pool.query(
      "UPDATE btc_reservation_events SET reservation=jsonb_set(reservation,'{margin_usd_raw}','\"1\"') WHERE action='reserve'",
    );
    await f.pool.query(
      "ALTER TABLE btc_reservation_events ENABLE TRIGGER btc_reservation_events_immutable",
    );
    const before = await snapshot(),
      risk = await w.pool.transaction((tx) => readRiskTx(tx, scope.account_id));
    await expire();
    w = worker();
    await expect(recoverAccount(w.pool, scope)).rejects.toThrow(
      "AUTHORITATIVE_DIVERGENCE",
    );
    await expect(
      applyRisk(w.pool, scope, {
        operation_id: "rearm",
        action: "rearm",
        reason: "test",
      }),
    ).rejects.toThrow("BLOCKED");
    expect(await snapshot()).toEqual(before);
    expect(
      await w.pool.transaction((tx) => readRiskTx(tx, scope.account_id)),
    ).toEqual(risk);
    expect(
      (
        await f.pool.query(
          "SELECT status,generation,reason FROM btc_recovery_heads",
        )
      ).rows[0],
    ).toMatchObject({
      status: "blocked",
      generation: "2",
      reason: "BTC_RECOVERY_AUTHORITATIVE_DIVERGENCE",
    });
  });
  it("preserves append-only guards on checkpoints and ownership history", async () => {
    for (const table of ["btc_recovery_owners", "btc_recovery_checkpoints"])
      for (const sql of [`DELETE FROM ${table}`, `TRUNCATE ${table} CASCADE`])
        await expect(f.pool.query(sql)).rejects.toThrow("APPEND_ONLY");
  });
  it.each(["before", "after"] as const)(
    "funding loss %s COMMIT keeps ledger, receipt, pins and risk atomic",
    async (when) => {
      await reserve();
      await fillOne();
      const request = await fundingCommand(),
        before = await snapshot();
      w.fail(when);
      await expect(reconcileFunding(w.pool, scope, request)).rejects.toThrow(
        "connection loss",
      );
      if (when === "before") expect(await snapshot()).toEqual(before);
      const result = await reconcileFunding(w.pool, scope, request);
      expect(result.status).toBe("settled");
      expect(result.positions).toHaveLength(1);
      expect(BigInt(result.positions[0]!.delta_usd_raw)).toBeLessThan(0n);
      const committed = await snapshot();
      await expire();
      w = worker();

      await recoverAccount(w.pool, scope);
      expect(await reconcileFunding(w.pool, scope, request)).toEqual(result);
      expect(await snapshot()).toEqual(committed);
      // A late historical fill cannot change the already settled position basis.
      await expect(
        appendLedgerBatch(w.pool, scope, {
          transaction_id: "late",
          events: [
            command(
              "late",
              fill("late", "buy", "100000"),
              scope,
              Date.parse(request.observation!.received_at) - 1,
            ),
          ],
        }),
      ).rejects.toThrow("SETTLED_FUNDING_CUTOFF");
      expect(await snapshot()).toEqual(committed);
    },
  );
  it.each(["before", "after"] as const)(
    "IOC fill loss %s COMMIT keeps reservation, ledger, risk, receipt and pins atomic",
    async (when) => {
      const order = riskOrder("ioc", { price_cap_usd_raw: "67000000000" });
      await applyIoc(w.pool, scope, {
        action: "submit",
        operation_id: "submit",
        order,
        intent: {
          schema_version: "btc.ioc.v1",
          decision_at: (
            await f.pool.query("SELECT clock_timestamp() AS now")
          ).rows[0].now.toISOString(),
          latency_ms: 0,
          limit_price_usd_raw: "66000000000",
          fee_metadata_id: metadataId,
        },
      });
      await f.capture();
      const before = await snapshot();
      const command = {
        action: "execute" as const,
        operation_id: "execute",
        order_id: "ioc",
      };
      w.fail(when);
      await expect(applyIoc(w.pool, scope, command)).rejects.toThrow(
        "connection loss",
      );
      if (when === "before") expect(await snapshot()).toEqual(before);
      const result = await applyIoc(w.pool, scope, command);
      expect(result.fills).toHaveLength(1);
      expect((await orders())[0]!.remaining_btc_raw).toBe("0");
      const committed = await snapshot();
      await expire();
      w = worker();
      await recoverAccount(w.pool, scope);
      expect(await applyIoc(w.pool, scope, command)).toEqual(result);
      expect(await snapshot()).toEqual(committed);
    },
  );
  it("cancels the observed passive queue on restart, preserving its receipts and pins", async () => {
    const at = (
        await f.pool.query("SELECT clock_timestamp() AS now")
      ).rows[0].now.getTime(),
      m = market(at),
      capture = { ...m.capture, session: "s9", gaps: 0 };
    await withBtcRetentionTransaction(w.pool, async (tx) => {
      await storeRetentionObjectTx(tx, {
        id: "s9:capture",
        class: "raw",
        identity: scope,
        recordedAt: new Date(at),
        payload: capture,
        dependencies: [],
      });
      await tx.query(
        "INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES('s9:capture','capture',$1,$1)",
        [iso(at)],
      );
    });
    const command = {
      action: "submit" as const,
      operation_id: "passive",
      order: riskOrder("p".repeat(160)),
      intent: {
        schema_version: "btc.passive.v1" as const,
        limit_price_usd_raw: "64900000000",
        fee_metadata_id: metadataId,
      },
    };
    const receipt = await applyPassive(w.pool, scope, command);
    expect((await orders())[0]!.status).toBe("active");
    await expire();
    w = worker();
    await recoverAccount(w.pool, scope);
    expect((await orders())[0]!.status).toBe("cancelled");
    // A second boot validates the durable recovery release, including ID bounds.
    await expire();
    w = worker();
    await recoverAccount(w.pool, scope);
    expect(await applyPassive(w.pool, scope, command)).toEqual(receipt);
    const current = await snapshot();
    const advanced = await applyPassive(w.pool, scope, {
      action: "advance",
      operation_id: "late-replay",
    });
    expect(advanced.fills).toEqual([]);
    expect((await ledger()).projection.last_sequence).toBe("1");
    expect(current.cursors.btc_passive_events).toBe(1);
  });
  it("does not accept transaction seams as boot evidence or a caller-supplied ready flag", async () => {
    await expire();
    await expect(
      recoveryTransaction(w.pool, scope, async () => true),
    ).rejects.toThrow("FENCED");
    await expect(
      applyReservation(w.pool, scope, {
        ...reserveCommand(),
        ready: true,
      } as ReturnType<typeof reserveCommand>),
    ).rejects.toThrow("FENCED");
    expect(await orders()).toEqual([]);
  });
  it("two workers cannot accept or reserve the same owner concurrently", async () => {
    await expire();
    const a = worker(),
      b = worker();
    const results = await Promise.allSettled([
      applyReservation(a.pool, scope, reserveCommand()),
      applyReservation(b.pool, scope, reserveCommand()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      String(
        (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
          .reason,
      ),
    ).toContain("OWNED");
    expect((await orders()).filter((r) => r.status === "active")).toHaveLength(
      1,
    );
    expect((await ledger()).projection.cash_usd_raw).toBe("1000000000");
  });
  it("an unavailable evidence pin blocks boot and cannot be repaired by inventing evidence", async () => {
    const count = async () =>
      (await f.pool.query("SELECT count(*)::int n FROM btc_ledger_events"))
        .rows[0].n;
    const before = await count();
    // Only corruption injection in this throw-away database may bypass guards.
    await f.pool.query("ALTER TABLE btc_retention_pins DISABLE TRIGGER USER");
    await f.pool.query(
      "DELETE FROM btc_retention_pins WHERE pin_id LIKE 'btc-funding:%'",
    );
    await f.pool.query("ALTER TABLE btc_retention_pins ENABLE TRIGGER USER");
    await expire();
    w = worker();
    await expect(recoverAccount(w.pool, scope)).rejects.toThrow(
      "EVIDENCE_MISSING",
    );
    await expect(reserve()).rejects.toThrow("BLOCKED");
    expect(await count()).toBe(before);
    expect(
      (await f.pool.query("SELECT count(*)::int n FROM btc_retention_pins"))
        .rows[0].n,
    ).toBe(0);
  });
  it("failure while checkpointing rolls back the financial command and its risk journal", async () => {
    const before = await snapshot();
    w.hook(async (sql, tx) => {
      if (sql.includes("INSERT INTO btc_recovery_checkpoints"))
        await tx.query("SELECT 1/0");
    });
    await expect(reserve()).rejects.toThrow("division by zero");
    expect(await snapshot()).toEqual(before);
    expect(await orders()).toEqual([]);
  });
  it("detects divergence before an existing worker can bless it as a new checkpoint", async () => {
    await reserve();
    await f.pool.query(
      "ALTER TABLE btc_order_acceptances DISABLE TRIGGER btc_order_acceptances_immutable",
    );
    await f.pool.query(
      "UPDATE btc_order_acceptances SET request=jsonb_set(request,'{quantity_btc_raw}','\"1000\"')",
    );
    await f.pool.query(
      "ALTER TABLE btc_order_acceptances ENABLE TRIGGER btc_order_acceptances_immutable",
    );
    await expect(fillOne()).rejects.toThrow("AUTHORITATIVE_DIVERGENCE");
    expect((await ledger()).projection.last_sequence).toBe("1");
  });
  it("an explicit boot check on the same worker cannot report a corrupt projection ready", async () => {
    await recoverAccount(w.pool, scope);
    await f.pool.query(
      "UPDATE btc_ledger_projections SET projection=jsonb_set(projection,'{cash_usd_raw}','\"0\"')",
    );
    await expect(recoverAccount(w.pool, scope)).rejects.toThrow(
      "PROJECTION_MISMATCH",
    );
  });
  it("releases expired holds on boot through a durable transition and retries it once", async () => {
    stableOrder = { ...stableOrder, valid_until: iso(Date.now() + 1500) };
    await reserve();
    await f.pool.query("SELECT pg_sleep(1.6)");
    await expire();
    w = worker();
    await recoverAccount(w.pool, scope);
    expect((await orders())[0]).toMatchObject({
      status: "expired",
      remaining_btc_raw: "0",
      margin_usd_raw: "0",
      fee_usd_raw: "0",
    });
    const saved = await snapshot();
    await expire();
    w = worker();
    await recoverAccount(w.pool, scope);
    expect(await snapshot()).toEqual(saved);
    expect((await ledger()).projection.last_sequence).toBe("1");
  });
});
