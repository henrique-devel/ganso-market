import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { riskFixture } from "./risk-fixture.js";
import { jevIdentity, iso } from "./jev-v2-fixture.js";
import { metadata, trade, health } from "./bars-fixture.js";
import { market } from "./valuation-fixture.js";
import { sizingInput } from "./jev-risk-fixture.js";
import { initialJevManifest } from "../../src/storage/jev-manifest.js";
import {
  registerJevPair,
  readJevAccount,
} from "../../src/storage/jev-store.js";
import { jevScope } from "../../src/storage/jev-ledger.js";
import { jevHash } from "../../src/storage/jev-hash.js";
import {
  reserveJevEntry,
  reconcileJevRisk,
} from "../../src/storage/jev-riskstore.js";
import { applyJevExecution } from "../../src/storage/jev-executionstore.js";
import {
  quoteJevMaker,
  type JevExecutionCommand,
} from "../../src/storage/jev-execution-contract.js";
import {
  withBtcRetentionTransaction,
  storeRetentionObjectTx,
} from "../../src/storage/btc-retention.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
const manifest = initialJevManifest(1);
let f: Awaited<ReturnType<typeof riskFixture>>,
  base: number,
  at: number,
  n: number;
const owner = jevIdentity(),
  stress = jevIdentity("stress");
for (const i of [owner, stress])
  i.bindings[0]!.profile.manifest_hash = jevHash(manifest);
const scope = jevScope(owner.bindings[0]!.binding, owner.instrument),
  stressScope = jevScope(stress.bindings[0]!.binding, stress.instrument);
async function record(kind: string, payload: unknown, time = at) {
  await withBtcRetentionTransaction(f.poolAdapter, async (tx) => {
    const id = `execution-fixture:${kind}:${++n}`;
    await storeRetentionObjectTx(tx, {
      id,
      class: "raw",
      identity: { ...scope, mode: "paper" },
      recordedAt: new Date(time),
      payload,
      dependencies: [],
    });
    await tx.query(
      "INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES($1,$2,$3,$3)",
      [id, kind, iso(time)],
    );
  });
}
async function capture(
  ms: number,
  options: {
    bid?: string;
    ask?: string;
    quantity?: string;
    mark?: string;
    session?: string;
    stale?: boolean;
    gap?: number;
  } = {},
) {
  const previous = at;
  at = base + ms;
  f.setClock(iso(at));
  const m = market(at),
    book = m.book!.payload;
  if (
    book.payload.kind !== "book" ||
    m.context!.payload.payload.kind !== "mark_funding"
  )
    throw new Error("fixture");
  const amount = (raw: string, unit: "BTC" | "USD_PER_BTC") =>
    ({
      unit,
      decimals: unit === "BTC" ? (8 as const) : (6 as const),
      raw,
    }) as never;
  const b = options.bid ?? "64900000000",
    a = options.ask ?? "65100000000";
  const payload = {
    ...book,
    payload: {
      ...book.payload,
      bids: [
        {
          price: amount(b, "USD_PER_BTC"),
          quantity: amount(options.quantity ?? "600000", "BTC"),
        },
      ],
      asks: [
        {
          price: amount(a, "USD_PER_BTC"),
          quantity: amount(options.quantity ?? "600000", "BTC"),
        },
      ],
    },
    source_timestamp: iso(options.stale ? at - 3000 : at),
  };
  await record("book", payload);
  await record("context", {
    ...m.context!.payload,
    payload: {
      ...m.context!.payload.payload,
      mark_price: amount(options.mark ?? "65000000000", "USD_PER_BTC"),
    },
  });
  const h = health(at);
  for (const k of ["book", "context", "trades"] as const)
    h.channels[k] = {
      status: "healthy",
      last_received_at: at,
      last_source_at: at,
      source_quality: "fresh",
      gap_epoch: options.gap ?? 0,
      needs_revalidation: false,
    };
  await record("capture", {
    from: Math.min(previous, at),
    at,
    session: options.session ?? "execution-session",
    health: h,
  });
}
async function ready(s = scope) {
  const l = await readJevAccount(f.poolAdapter, s.owner_id, s.account_id);
  await reconcileJevRisk(f.poolAdapter, s.owner_id, s.account_id, {
    operation_id: `reconcile:${++n}`,
    ledger_sequence: l.projection.last_sequence,
    observed_at: iso(at),
    funding_through_at: iso(Math.floor(at / 3600000) * 3600000),
    evidence: { fixture: true },
  });
}
async function submit(s = scope, direction: "long" | "short" = "long") {
  await ready(s);
  const input = {
    ...sizingInput,
    scope: s,
    decision_at: iso(at),
    atr_captured_at: iso(at - 1000),
    direction,
    entry_price_raw: quoteJevMaker(
      direction === "long" ? "buy" : "sell",
      "64900000000",
      "65100000000",
      metadata,
    ),
  };
  const r = await reserveJevEntry(f.poolAdapter, manifest, metadata, input);
  expect(r.status).toBe("reserved");
  return applyJevExecution(f.poolAdapter, s, {
    action: "submit",
    operation_id: `submit:${s.account_id}`,
    order_id: input.order_id,
    plan_hash: jevHash(r.plan),
  });
}
const command = (
  action: JevExecutionCommand["action"] = "advance",
  s = scope,
) =>
  applyJevExecution(f.poolAdapter, s, {
    action,
    operation_id: `command:${++n}`,
  } as JevExecutionCommand);
async function print(
  ms: number,
  quantity = "1000",
  side: "buy" | "sell" = "sell",
  price = "64901000000",
  tid = ++n,
) {
  const event = trade(
    base + ms,
    tid,
    "64901",
    (BigInt(quantity) * 10n ** 0n).toString(),
  );
  if (event.payload.kind !== "trade") throw new Error("fixture");
  await record(
    "trades",
    {
      ...event,
      payload: {
        ...event.payload,
        side,
        price: { unit: "USD_PER_BTC", decimals: 6, raw: price },
        quantity: { unit: "BTC", decimals: 8, raw: quantity },
      },
    },
    base + ms,
  );
}
describe.skipIf(!url)("JE06 unified execution on disposable PostgreSQL", () => {
  beforeEach(async () => {
    f = await riskFixture(url);
    base = Date.now() - 86400000 - 60000;
    at = base;
    n = 0;
    f.setClock(iso(at));
    await registerJevPair(f.poolAdapter, 1, owner, stress, manifest);
    await record("metadata", metadata);
    await capture(0);
  });
  afterEach(async () => {
    await f?.dispose();
  });
  it("single account trade/depth budgets reject SQL double-consumption and preserve owner isolation", async () => {
    await submit();
    const claim = {
      account_id: scope.account_id,
      liquidity_key: "trade:fixture",
      operation_id: "a",
      quantity_raw: "1000",
      capacity_raw: "2000",
      original: { fixture: true },
    };
    const insert = (op: string, q: string) =>
      f.pool.query(
        "INSERT INTO jev_liquidity_claims(account_id,liquidity_key,operation_id,quantity_raw,capacity_raw,original) VALUES($1,$2,$3,$4,$5,$6)",
        [
          claim.account_id,
          claim.liquidity_key,
          op,
          q,
          claim.capacity_raw,
          claim.original,
        ],
      );
    await insert("a", "1000");
    await insert("b", "1000");
    await expect(insert("c", "1000")).rejects.toThrow(/CONSERVATION/);
    await expect(
      command("advance", { ...scope, owner_id: "intruder" }),
    ).rejects.toThrow(/ACCOUNT/);
    await expect(
      f.pool.query("UPDATE jev_liquidity_claims SET quantity_raw=1"),
    ).rejects.toThrow(/APPEND_ONLY/);
  });
  it.each(["long", "short"] as const)(
    "%s: partial/cancel race/restart and concurrent IOC never reverse or charge twice",
    async (direction) => {
      const side = direction === "long" ? "sell" : "buy",
        price = direction === "long" ? "64901000000" : "65099000000";
      await submit(scope, direction);
      await capture(999);
      expect((await command()).state.maker!.ack_at).toBeNull();
      await capture(1000);
      let r = await command();
      expect(r.state.maker!.ack_at).toBe(iso(base + 1000));
      await print(1100, "1000", side, price);
      await capture(1200);
      r = await command();
      expect(r.fills).toHaveLength(1);
      expect(r.state.protection!.quantity_btc_raw).toBe("1000");
      const anchors = { ...r.state.protection };
      expect(r.state.close).toBeNull();
      await command("cancel");
      await print(1500, "1000", side, price);
      await capture(2200);
      r = await command();
      expect(r.state.maker!.status).toBe("cancelled");
      expect(r.state.protection!.quantity_btc_raw).toBe("2000");
      expect({ ...r.state.protection, quantity_btc_raw: "1000" }).toEqual(
        anchors,
      );
      const before = await readJevAccount(
        f.poolAdapter,
        "operator",
        scope.account_id,
      );
      const fee = before.events
        .filter((e) => e.payload.event_type === "fee")
        .reduce(
          (sum, e) =>
            sum +
            (e.payload.event_type === "fee" ? BigInt(e.payload.delta.raw) : 0n),
          0n,
        );
      const expected =
        -(2000n * BigInt(price) * 150000n + 100000000000000000n - 1n) /
        100000000000000000n;
      expect(fee).toBe(expected);
      await command("recover");
      const closeRequest = {
        action: "close" as const,
        operation_id: "close",
        limit_price_raw: direction === "long" ? "58000000000" : "72000000000",
      };
      await applyJevExecution(f.poolAdapter, scope, closeRequest);
      await capture(3199, { quantity: "1000" });
      expect((await command()).fills).toHaveLength(0);
      await capture(3200, { quantity: "1000" });
      const outputs = await Promise.all([command(), command()]);
      expect(outputs.flatMap((x) => x.fills)).toHaveLength(1);
      expect(outputs.at(-1)!.state.protection!.quantity_btc_raw).toBe("1000");
      await capture(4200, { quantity: "1000", stale: true });
      expect((await command()).reconciled_flat).toBe(false);
      await capture(5200, { quantity: "1000" });
      r = await command();
      expect(r.reconciled_flat).toBe(true);
      expect(
        (
          await readJevAccount(f.poolAdapter, "operator", scope.account_id)
        ).projection.positions.filter((p) => p.quantity_btc_raw !== "0"),
      ).toEqual([]);
      const receipt = await applyJevExecution(
        f.poolAdapter,
        scope,
        closeRequest,
      );
      expect(receipt.state.close!.pending).toBe(true); // original retry receipt, not a new order
      expect(
        (await readJevAccount(f.poolAdapter, "operator", scope.account_id))
          .events.length,
      ).toBe(before.events.length + 4);
    },
  );
  it("rejects post-only crossing at arrival and cannot turn rejection into taker", async () => {
    await submit();
    await capture(1000, { ask: "64901000000" });
    const r = await command();
    expect(r.state.maker!.status).toBe("rejected");
    expect(r.fills).toEqual([]);
    expect(r.reconciled_flat).toBe(true);
    expect(
      (
        await f.pool.query(
          "SELECT status FROM jev_entry_events ORDER BY sequence DESC LIMIT 1",
        )
      ).rows[0].status,
    ).toBe("released");
  });
  it("stress waits 2s, keeps independent liquidity and doubles only trading fees", async () => {
    await submit();
    await submit(stressScope);
    await capture(1000);
    await command();
    expect(
      (await command("advance", stressScope)).state.maker!.ack_at,
    ).toBeNull();
    await capture(2000);
    await command("advance", stressScope);
    await print(2100);
    await capture(2200);
    const p = await command(),
      s = await command("advance", stressScope);
    expect(p.fills[0]!.quantity_btc_raw).toBe("1000");
    expect(s.fills[0]!.quantity_btc_raw).toBe("1000");
    expect(p.fills[0]!.fee_usd_raw).toBe("98");
    expect(s.fills[0]!.fee_usd_raw).toBe("195");
  });
  it("wait is 2s from ACK; prints in cancel transit reconcile, later prints cannot fill", async () => {
    await submit();
    await capture(1000);
    await command();
    await capture(3000);
    let r = await command();
    expect(r.state.maker!.cancel_at).toBe(iso(base + 4000));
    await print(3500);
    await print(4100);
    await capture(4200);
    r = await command();
    expect(r.state.maker!.status).toBe("cancelled");
    expect(r.state.maker!.filled_btc_raw).toBe("1000");
  });
  it.each(["session", "gap", "recover"])(
    "%s loses priority permanently without manufacturing fills",
    async (kind) => {
      await submit();
      await capture(1000);
      await command();
      await print(1100);
      await capture(1200, {
        session: kind === "session" ? "restarted" : "execution-session",
        gap: kind === "gap" ? 1 : 0,
      });
      let r = await command(kind === "recover" ? "recover" : "advance");
      expect(r.fills).toEqual([]);
      expect(r.state.maker!.queue).toBeNull();
      await capture(2400);
      r = await command();
      expect(r.state.maker!.status).toBe("cancelled");
      expect(r.reconciled_flat).toBe(true);
    },
  );
  it("first partial owns mark stop and deadline; cancellation/close does not remove anchors", async () => {
    await submit();
    await capture(1000);
    await command();
    await print(1100);
    await capture(1200);
    let r = await command();
    const p = r.state.protection!;
    await capture(1500, { mark: p.stop_price_raw });
    r = await command();
    expect(r.state.close!.causes).toContain("FIXED_STOP");
    expect(r.fills).toHaveLength(0);
    const row = (
      await f.pool.query(
        "SELECT * FROM jev_execution_events ORDER BY sequence DESC LIMIT 1",
      )
    ).rows[0];
    const changed = {
      ...row.state,
      protection: { ...p, maximum_exit_at: iso(base + 21600000 + 1500) },
    };
    await expect(
      f.pool.query(
        "INSERT INTO jev_execution_events(account_id,owner_id,mode,profile_id,profile_version,experiment_id,sequence,operation_id,request,state,result,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,'reset',$8,$9,$10,$11)",
        [
          scope.account_id,
          scope.owner_id,
          scope.mode,
          scope.profile_id,
          scope.profile_version,
          scope.experiment_id,
          String(BigInt(row.sequence) + 1n),
          row.request,
          changed,
          { ...row.result, state: changed },
          JSON.stringify(row.evidence),
        ],
      ),
    ).rejects.toThrow(/PROTECTION|ANCHOR/);
    await capture(21601100, { stale: true });
    r = await command();
    expect(r.state.close!.causes).toContain("MAXIMUM_HOLDING_TIME");
    expect(r.state.protection!.first_fill_at).toBe(p.first_fill_at);
    expect(r.reconciled_flat).toBe(false);
  });
  it("transaction failure after tentative fill rolls back money, claims, fees and protection; retry uses original priority", async () => {
    await submit();
    await capture(1000);
    await command();
    await print(1100);
    await capture(1200);
    f.setHook(async (sql) => {
      if (sql.includes("INSERT INTO jev_execution_events"))
        throw new Error("fixture crash before commit");
    });
    await expect(command()).rejects.toThrow(/crash/);
    f.setHook(null);
    expect(
      (await f.pool.query("SELECT count(*)::int n FROM jev_liquidity_claims"))
        .rows[0].n,
    ).toBe(0);
    expect(
      (await readJevAccount(f.poolAdapter, "operator", scope.account_id))
        .events,
    ).toHaveLength(1);
    const r = await command();
    expect(r.fills).toHaveLength(1);
    expect(r.state.protection!.first_fill_at).toBe(iso(base + 1100));
  });
  it("ACK cannot refresh stale/unknown book and fills need opposing sufficient prints", async () => {
    await submit();
    await capture(1000, { stale: true });
    let r = await command();
    expect(r.state.maker!.ack_at).toBeNull();
    expect(r.state.maker!.status).toBe("cancel_pending");
    await capture(2000);
    r = await command();
    expect(r.state.maker!.status).toBe("cancelled");
    expect(r.fills).toEqual([]);
  });
  it("a maker fully fills once, releases only the residual hold and owns its deadline", async () => {
    const sent = await submit();
    const q = sent.state.maker!.plan.quantity_btc_raw;
    await capture(1000);
    await command();
    await print(1100, q);
    await capture(1200);
    let r = await command();
    expect(r.state.maker!.status).toBe("filled");
    expect(r.state.protection!.quantity_btc_raw).toBe(q);
    await print(1300, q);
    await capture(1400);
    r = await command();
    expect(r.fills).toEqual([]);
    expect(r.state.protection!.quantity_btc_raw).toBe(q);
    await expect(
      applyJevExecution(f.poolAdapter, scope, {
        action: "submit",
        operation_id: "another-send",
        order_id: "entry",
        plan_hash: sent.state.maker!.plan_hash,
      }),
    ).rejects.toThrow(/RESERVATION/);
  });
  it("prints at ACK, on the wrong side, or below a lot never create fills", async () => {
    await submit();
    await capture(1000);
    await command();
    await print(1000);
    await print(1100, "1000", "buy");
    await print(1200, "999");
    await capture(1300);
    const r = await command();
    expect(r.fills).toEqual([]);
    expect(r.state.protection).toBeNull();
  });
  it("daily risk preempts JEV and a deadline without resetting the stop or first fill", async () => {
    await submit();
    await capture(1000);
    await command();
    await print(1100);
    await capture(1200);
    let r = await command();
    const p = r.state.protection!,
      ledger = await readJevAccount(
        f.poolAdapter,
        "operator",
        scope.account_id,
      );
    const risk = (
      await f.pool.query(
        "SELECT checkpoint,evidence FROM jev_risk_events WHERE account_id=$1 ORDER BY sequence DESC LIMIT 1",
        [scope.account_id],
      )
    ).rows[0];
    // Preserve exact observed HWM/clock; add the already-proven daily loss latch.
    const next = {
      ...risk.checkpoint,
      daily_pause_day: iso(at).slice(0, 10),
      entries_paused: true,
      cancel_entries: true,
      request_close: true,
      reasons: ["DAILY_LOSS"],
    };
    await f.pool.query(
      "INSERT INTO jev_risk_events(account_id,sequence,operation_id,checkpoint,evidence) SELECT $1,max(sequence)+1,'fixture-daily',$2,$3 FROM jev_risk_events WHERE account_id=$1",
      [scope.account_id, next, risk.evidence],
    );
    await capture(1400);
    r = await command();
    expect(r.state.close!.causes).toContain("RISK_BLOCKED");
    expect(r.state.protection!.first_fill_at).toBe(p.first_fill_at);
    expect(r.state.protection!.stop_price_raw).toBe(p.stop_price_raw);
    expect(ledger.events).toHaveLength(3);
  });
  it("execution freshness is rechecked after slow SQL and all tentative effects roll back", async () => {
    await submit();
    await capture(1000);
    await command();
    await print(1100);
    await capture(1200);
    f.setHook(async (sql) => {
      if (sql.includes("INSERT INTO jev_risk_reconciliations"))
        f.setClock(iso(at + 3000));
    });
    await expect(command()).rejects.toThrow(/MARKET_CHANGED/);
    f.setHook(null);
    f.setClock(iso(at));
    expect(
      (await readJevAccount(f.poolAdapter, "operator", scope.account_id))
        .events,
    ).toHaveLength(1);
  });
  it("late prints cannot move the first-fill anchor backwards or restore consumed priority", async () => {
    await submit();
    await capture(1000);
    await command();
    await print(1400);
    await capture(1500);
    const first = await command();
    expect(first.state.protection!.first_fill_at).toBe(iso(base + 1400));
    const old = trade(base + 1300, 99999, "64901", "0.00001", base + 1600);
    if (old.payload.kind !== "trade") throw new Error("fixture");
    await record(
      "trades",
      { ...old, payload: { ...old.payload, side: "sell" } },
      base + 1600,
    );
    await capture(1700);
    const r = await command();
    expect(r.fills).toEqual([]);
    expect(r.state.maker!.queue).toBeNull();
    expect(r.state.protection).toEqual(first.state.protection);
    expect(r.state.reason).toBe("late_trade_priority_unknown");
  });
});
