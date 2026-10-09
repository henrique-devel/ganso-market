import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { setTimeout } from "node:timers/promises";
import { riskFixture } from "../trading/risk-fixture.js";
import { jevIdentity } from "../trading/jev-v2-fixture.js";
import { registerJevLiveIdentity } from "../../src/storage/jev-store.js";
import { initialJevManifest } from "../../src/storage/jev-manifest.js";
import { jevHash } from "../../src/storage/jev-hash.js";
import { PgLiveStore } from "../../src/storage/jev-live-store.js";
import { jevEntryEventTx } from "../../src/storage/jev-riskstore.js";
import { commandJevPilot } from "../../src/storage/jev-pilotstore.js";
import { liveEntryCommand, venueFill } from "./live-fixture.js";
import { parseLiveFill } from "../../src/venues/hyperliquid/live-reconcile.js";
import { buildLiveAction } from "../../src/venues/hyperliquid/live-execution.js";
import { liveIdentity, liveScope, liveSnapshot } from "./live-fixture.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let fixtureAt: number;
let f: Awaited<ReturnType<typeof riskFixture>>, store: PgLiveStore;
describe.skipIf(!url)("JE13 journals on disposable PostgreSQL", () => {
  beforeEach(async () => {
    f = await riskFixture(url);
    fixtureAt = Date.now();
    const i = jevIdentity("live"),
      m = initialJevManifest(1);
    i.bindings[0]!.profile.manifest_hash = jevHash(m);
    await registerJevLiveIdentity(f.poolAdapter, i, m);
    store = new PgLiveStore(f.poolAdapter, liveIdentity);
    await store.register();
  });
  afterEach(async () => {
    await f?.dispose();
  });
  function request(
    operation_id: string,
    lease: Awaited<ReturnType<PgLiveStore["claim"]>>,
    payload: unknown = { fixture: true },
  ) {
    const c = liveEntryCommand(fixtureAt);
    const command = {
      version: c.version,
      kind: "close" as const,
      scope: liveScope,
      operation_id,
      metadata: c.metadata,
      metadata_at: fixtureAt,
      snapshot: liveSnapshot(fixtureAt),
      limit_price_raw: "60000000000",
      cause: JSON.stringify(payload),
    };
    return {
      scope: liveScope,
      operation_id,
      kind: command.kind,
      request: command,
      lease,
      action: (cloid: `0x${string}`) =>
        buildLiveAction(liveIdentity, command, cloid, fixtureAt),
    };
  }
  it("creates no activation or cash, persists signer-owned unique nonces and duplicate reservations", async () => {
    expect((await store.latest()).snapshot).toBeNull();
    expect((await store.latest()).pending).toBe(true);
    const lease = await store.claim("fixture-process");
    const out = await Promise.all(
      Array.from({ length: 4 }, (_, n) =>
        store.reserve(request(`cancel:${n}`, lease)),
      ),
    );
    expect(new Set(out.map((r) => r.reservation.nonce)).size).toBe(4);
    const again = await store.reserve(request("cancel:0", lease));
    expect(again.fresh).toBe(false);
    expect(again.reservation).toEqual(out[0]!.reservation);
    await expect(
      store.reserve(request("cancel:0", lease, { changed: true })),
    ).rejects.toThrow("IDEMPOTENCY_COLLISION");
    expect((await store.gate(out[0]!.reservation)).signer_enabled).toBe(false);
    expect(
      (
        await Promise.all([
          store.claimSubmission(out[0]!.reservation),
          store.claimSubmission(out[0]!.reservation),
        ])
      ).sort(),
    ).toEqual([false, true]);
    expect(await store.events("receipt")).toHaveLength(1);
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM jev_ledger_events WHERE account_id='live:h1'",
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("never doubles fill fees/funding on replay, leaves collisions pending and preserves old events", async () => {
    const s = liveSnapshot();
    await store.save(s);
    await store.save(s);
    expect(await store.accountView(s.received_at)).toMatchObject({
      trading_balance_raw: "250000000",
      fees_raw: "10000",
      funding_raw: "-1000",
      pending: true,
      balance_proof: {
        reason: "INITIAL_CAPITAL_UNKNOWN",
        expected_trading_balance_raw: null,
      },
    });
    expect(
      (
        await f.pool.query(
          "SELECT kind,count(*)::int n FROM jev_live_events GROUP BY kind ORDER BY kind",
        )
      ).rows,
    ).toEqual([
      { kind: "balance", n: 1 },
      { kind: "fill", n: 1 },
      { kind: "funding", n: 1 },
      { kind: "snapshot", n: 1 },
    ]);
    const changed = liveSnapshot(s.received_at + 1);
    changed.fills[0]!.fee_raw = "999";
    await expect(store.save(changed)).rejects.toThrow("SOURCE_COLLISION");
    await store.append("gap", "gap:collision", { reason: "SOURCE_COLLISION" });
    expect((await store.latest()).pending).toBe(true);
    await expect(
      f.pool.query("UPDATE jev_live_events SET payload='{}'::jsonb"),
    ).rejects.toThrow();
    await expect(f.pool.query("TRUNCATE jev_live_events")).rejects.toThrow();
    expect((await store.latest()).snapshot?.trading_balance_raw).toBe(
      "250000000",
    );
  });
  it("requires the approved financial plan, freezes entry identity, and releases no admission after cancellation or a gap", async () => {
    const c = liveEntryCommand(Date.now()),
      lease = await store.claim("execution-fixture");
    const input = {
      scope: c.scope,
      operation_id: c.operation_id,
      kind: c.kind,
      request: c,
      lease,
      action: (cloid: `0x${string}`) =>
        buildLiveAction(liveIdentity, c, cloid, c.metadata_at),
    };
    await expect(store.reserve(input)).rejects.toThrow("FINANCIAL_RESERVATION");
    await f.poolAdapter.transaction((tx) =>
      jevEntryEventTx(tx, c.plan, "reserved", "reserve:fixture"),
    );
    await store.save(c.snapshot);
    const r = await store.reserve(input);
    expect(r.fresh).toBe(true);
    await expect(
      store.reserve({
        ...input,
        operation_id: "entry:other",
        request: { ...c, operation_id: "entry:other" },
      }),
    ).rejects.toThrow("ENTRY_ALREADY_SENT");
    await f.poolAdapter.transaction((tx) =>
      jevEntryEventTx(tx, c.plan, "cancel_requested", "cancel:fixture"),
    );
    expect((await store.gate(r.reservation)).entries_allowed).toBe(false);
    expect(await store.observeExistingPilot(c.snapshot)).toBeNull();
    expect((await store.accountView(c.metadata_at + 2001)).pending).toBe(true);
  });
  it("preserves ownership and burns the nonce across crash/takeover rather than resending", async () => {
    const lease = await store.claim("old-process", 2000);
    const r = await store.reserve(request("lost-response", lease));
    await expect(store.claim("new-process")).rejects.toThrow("OWNERSHIP_BUSY");
    await setTimeout(2050);
    const next = await store.claim("new-process");
    expect(BigInt(next.generation)).toBe(BigInt(lease.generation) + 1n);
    await expect(
      store.reserve(request("new-old-owner", lease)),
    ).rejects.toThrow("FENCE");
    expect((await store.reserve(request("lost-response", next))).fresh).toBe(
      false,
    );
    expect((await store.gate(r.reservation)).generation).toBe(next.generation);
  });
  async function admitFixture(at: number) {
    const initial = liveSnapshot(at, {
      position_raw: "0",
      flat: true,
      fills: [],
      funding: [],
    });
    await commandJevPilot(f.poolAdapter, "operator", "live:h1", {
      operation_id: "fixture:funded",
      expected_sequence: "0",
      action: "observe",
      observation: {
        version: "btc.jev-pilot-reconciliation.v1",
        source: "hyperliquid:mainnet:reconciliation",
        evidence_id: initial.snapshot_id,
        observed_at: new Date(at).toISOString(),
        received_at: new Date(at).toISOString(),
        funded_capital_usd_raw: "250000000",
        trading_balance_usd_raw: "250000000",
        open_pnl_usd_raw: "0",
        flat: true,
        reconciled: true,
        original: initial,
        utc_anchor: null,
      },
    });
    return initial;
  }
  it("feeds only an existing admitted pilot, retains lifetime HWM through receipted growth/loss and replays without resetting it", async () => {
    const now = Date.now(),
      initial = await admitFixture(now - 1000);
    const profit = [
      parseLiveFill(venueFill(now, { fee: "0", time: initial.venue_at + 100 })),
      parseLiveFill(
        venueFill(now, {
          fee: "0",
          time: initial.venue_at + 200,
          side: "A",
          startPosition: "0.0001",
          px: "264000",
          closedPnl: "20",
          tid: 2,
          hash: `0x${"c".repeat(64)}`,
        }),
      ),
    ];
    const peak = liveSnapshot(now, {
      position_raw: "0",
      flat: true,
      fills: profit,
      funding: [],
      equity_raw: "270000000",
      trading_balance_raw: "270000000",
    });
    await store.save(peak);
    expect((await store.latest()).pending).toBe(false);
    expect(
      (await store.observeExistingPilot(peak))!.checkpoint.risk
        .high_water_usd_raw,
    ).toBe("270000000");
    const count = await f.pool.query(
      "SELECT count(*)::int n FROM jev_pilot_events",
    );
    expect(
      (await store.observeExistingPilot(peak))!.checkpoint.risk
        .high_water_usd_raw,
    ).toBe("270000000");
    expect(
      (await f.pool.query("SELECT count(*)::int n FROM jev_pilot_events")).rows,
    ).toEqual(count.rows);
    const loss = liveSnapshot(now + 1, {
      position_raw: "0",
      flat: true,
      funding: [],
      fills: [
        ...profit,
        parseLiveFill(
          venueFill(now, {
            sz: "0.001",
            fee: "0",
            time: initial.venue_at + 300,
            tid: 3,
            hash: `0x${"d".repeat(64)}`,
          }),
        ),
        parseLiveFill(
          venueFill(now, {
            sz: "0.001",
            fee: "0",
            time: initial.venue_at + 400,
            side: "A",
            startPosition: "0.001",
            px: "51400",
            closedPnl: "-12.6",
            tid: 4,
            hash: `0x${"e".repeat(64)}`,
          }),
        ),
      ],
      equity_raw: "257400000",
      trading_balance_raw: "257400000",
    });
    await store.save(loss);
    const checkpoint = (await store.observeExistingPilot(loss))!.checkpoint;
    expect(checkpoint.risk.high_water_usd_raw).toBe("270000000");
    expect(checkpoint.risk.drawdown_blocked).toBe(true);
    expect(checkpoint.executor_enabled).toBe(false);
    expect(checkpoint.capital_admitted_usd_raw).toBe("250000000");
  });
  it("requires lifetime cash proof, recovers a missing funding receipt once, and never admits unexplained cash into HWM", async () => {
    const now = Date.now();
    await admitFixture(now - 1000);
    const full = liveSnapshot(now, {
      trading_balance_raw: "249989000",
      equity_raw: "249989000",
    });
    const missing = liveSnapshot(now, { ...full, funding: [] });
    await store.save(missing);
    expect((await store.accountView(now)).balance_proof).toMatchObject({
      expected_trading_balance_raw: "249990000",
      observed_trading_balance_raw: "249989000",
      reconciled: false,
      reason: "BALANCE_UNEXPLAINED",
    });
    await expect(store.observeExistingPilot(missing)).rejects.toThrow(
      "CASH_RECONCILIATION_REQUIRED",
    );
    const recovered = liveSnapshot(now + 1, {
      ...full,
      started_at: now + 1,
      received_at: now + 1,
      venue_at: now + 1,
    });
    await store.save(recovered);
    await store.save(recovered);
    expect(await store.accountView(now + 1)).toMatchObject({
      pending: false,
      fees_raw: "10000",
      funding_raw: "-1000",
      balance_proof: {
        reconciled: true,
        expected_trading_balance_raw: "249989000",
      },
    });
    expect(
      (await store.observeExistingPilot(recovered))!.checkpoint.risk
        .high_water_usd_raw,
    ).toBe("250000000");
    await expect(
      store.observeExistingPilot({
        ...recovered,
        trading_balance_raw: "999000000",
      }),
    ).rejects.toThrow("OBSERVATION_SOURCE");
    const changed = liveSnapshot(now + 2, {
      ...recovered,
      started_at: now + 2,
      received_at: now + 2,
      venue_at: now + 2,
      trading_balance_raw: "269989000",
      equity_raw: "269989000",
    });
    await store.save(changed);
    expect((await store.latest()).pending).toBe(true);
    await expect(store.observeExistingPilot(changed)).rejects.toThrow(
      "CASH_RECONCILIATION_REQUIRED",
    );
    expect(
      (
        await f.pool.query(
          "SELECT checkpoint->'risk'->>'high_water_usd_raw' hwm FROM jev_pilot_events ORDER BY sequence DESC LIMIT 1",
        )
      ).rows[0].hwm,
    ).toBe("250000000");
    const unknown = liveSnapshot(now + 3, {
      ...changed,
      started_at: now + 3,
      received_at: now + 3,
      venue_at: now + 3,
      trading_balance_raw: "249988000",
      equity_raw: "249988000",
    });
    await store.save(unknown);
    expect((await store.latest()).pending).toBe(true);
    await expect(store.observeExistingPilot(unknown)).rejects.toThrow(
      "CASH_RECONCILIATION_REQUIRED",
    );
  });
  it("rejects wrong account/environment, old observations and mutation of nonce/signing identity", async () => {
    await expect(
      new PgLiveStore(f.poolAdapter, {
        ...liveIdentity,
        environment: "testnet",
      }).register(),
    ).rejects.toThrow("ACCOUNT_ENVIRONMENT");
    const s = liveSnapshot();
    await store.save(s);
    await expect(store.save(liveSnapshot(s.received_at - 10))).rejects.toThrow(
      "OUT_OF_ORDER",
    );
    await expect(
      f.pool.query("UPDATE jev_live_identities SET signer_address=$1", [
        `0x${"4".repeat(40)}`,
      ]),
    ).rejects.toThrow();
    const lease = await store.claim("fixture-process");
    await store.reserve(request("cancel:1", lease));
    await expect(
      f.pool.query("DELETE FROM jev_live_requests"),
    ).rejects.toThrow();
  });
});
