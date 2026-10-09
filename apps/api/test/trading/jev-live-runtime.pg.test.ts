import { runtimeVenue } from "../venues/live-runtime-wire.js";
import { seedRuntimeMarket } from "./jev-runtime-market-fixture.js";
import { seedDispatchCapacityTx } from "./jev-dispatch-fixture.js";
import { createJevDecisionAdapter } from "../../src/models/jev-decision.js";
import {
  createJevDecisionStore,
  provisionJevCostPool,
} from "../../src/storage/jev-decision-store.js";
import { mockTariff } from "./jev-fixture.js";
import { decisionResponse } from "./jev-decision-fixture.js";
import type { JevBatch } from "../../src/models/jev-decision-contract.js";
import { runExecutionWorker } from "../../src/execution-worker.js";
import { loadJevLiveRuntime } from "../../src/jev-live-runtime.js";
import {
  claimExecutionWorker,
  executionFencedPool,
  releaseExecutionWorker,
} from "../../src/storage/execution-worker-lease.js";
import { SecretValue, type ApiConfig } from "../../src/config.js";
import type { DatabasePool } from "../../src/database.js";
import type { LiveSnapshot } from "../../src/venues/hyperliquid/live-reconcile.js";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { riskFixture } from "./risk-fixture.js";
import { jevIdentity } from "./jev-v2-fixture.js";
import {
  registerJevPair,
  registerJevLiveIdentity,
} from "../../src/storage/jev-store.js";
import { initialJevManifest } from "../../src/storage/jev-manifest.js";
import { jevHash } from "../../src/storage/jev-hash.js";
import { jevScope } from "../../src/storage/jev-ledger.js";
import {
  initialJevCadence,
  recordJevDecision,
} from "../../src/storage/jev-policy.js";
import { withBtcRetentionTransaction } from "../../src/storage/btc-retention.js";
import {
  makeJevEvidence,
  storeJevEvidenceTx,
} from "../../src/storage/jev-evidence.js";
import { commandJevPilot } from "../../src/storage/jev-pilotstore.js";
import { PgLiveStore } from "../../src/storage/jev-live-store.js";
import { liveIdentity, liveSnapshot } from "../venues/live-fixture.js";
import {
  activateJevLive,
  advanceJevPromotion,
  readJevLivePanelTx,
} from "../../src/storage/jev-promotion.js";
const flags = vi.hoisted(() => ({
  qualified: true,
  eligible: true,
  failed: "",
  integrated: true,
  rejected: "",
}));
// JE14 contracts under an integrated future build; JE15 separately verifies the
// actual build's missing JE16/JE17 gate, which configuration cannot override.
vi.mock("../../src/storage/jev-live-capabilities.js", async (original) => ({
  ...(await original<object>()),
  jevLiveIntegrationReady: () => flags.integrated,
}));
// Financial qualification and evaluation have their own real PG/algorithm suites.
// These synthetic adapters isolate the transaction handoff; they certify no
// observed runtime/venue qualification and are absent from production code.
vi.mock("../../src/storage/jev-readiness.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readJevReadinessTx: async () => ({
    qualification: {
      qualified: flags.qualified,
      evidence_id: null,
    },
  }),
}));
vi.mock("../../src/storage/jev-evaluationstore.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assessJevProfileTx: async (
    _tx: unknown,
    _owner: string,
    profile: string,
  ) => ({
    result: {
      state:
        profile === flags.failed
          ? "failed"
          : flags.eligible && profile !== flags.rejected
            ? "eligible"
            : "inconclusive",
      accounts: [
        {
          mode: "paper",
          episodes: 60,
          coverage_ppm: 990000,
          conservative_usd6: "1000000",
        },
        {
          mode: "stress",
          episodes: 60,
          coverage_ppm: 990000,
          conservative_usd6: flags.eligible ? "1000000" : null,
        },
      ],
    },
    dependencies: [],
    sources: [],
  }),
}));
const url = process.env.GANSO_TEST_DATABASE_URL;
let f: Awaited<ReturnType<typeof riskFixture>>, store: PgLiveStore;
async function refresh(
  action: "observe" | "authorize_supervisor" = "observe",
  balance = "250000000",
  changes: Partial<LiveSnapshot> = {},
) {
  const now =
      (
        await f.pool.query("SELECT clock_timestamp() AS now")
      ).rows[0].now.getTime() - 50,
    s = liveSnapshot(now, {
      flat: true,
      position_raw: "0",
      open_pnl_raw: "0",
      trading_balance_raw: balance,
      equity_raw: balance,
      orders: [],
      fills: [],
      funding: [],
      snapshot_id: `fixture:${now}`,
      ...changes,
    });
  const p = (
    await f.pool.query(
      "SELECT sequence::text FROM jev_pilot_events ORDER BY sequence DESC LIMIT 1",
    )
  ).rows[0];
  await commandJevPilot(f.poolAdapter, "operator", "live:h1", {
    operation_id: s.snapshot_id,
    expected_sequence: p?.sequence ?? "0",
    action,
    ...(action === "authorize_supervisor"
      ? {
          operator_decision: {
            actor_id: "operator",
            decision_id: "synthetic-operator",
            reason: "disposable fixture",
          },
        }
      : {}),
    observation: {
      version: "btc.jev-pilot-reconciliation.v1",
      source: "hyperliquid:mainnet:reconciliation",
      evidence_id: s.snapshot_id,
      observed_at: new Date(s.venue_at).toISOString(),
      received_at: new Date(s.received_at).toISOString(),
      funded_capital_usd_raw: "250000000",
      trading_balance_usd_raw: balance,
      open_pnl_usd_raw: s.open_pnl_raw,
      flat: s.flat,
      reconciled: true,
      original: s,
      utc_anchor: !p
        ? {
            at: new Date().toISOString().slice(0, 10) + "T00:00:00.000Z",
            equity_usd_raw: "250000000",
            evidence_id: "synthetic-utc",
            original: { fixture: true },
          }
        : null,
    },
  });
  await store.save(s);
  return s;
}
async function panel() {
  return f.poolAdapter.transaction((tx) => readJevLivePanelTx(tx, "operator"));
}
async function body() {
  const v = await panel();
  return {
    version: "jev.live-activation.v1",
    confirmed_capital_usd6: "250000000",
    expected_pilot_sequence: v.pilot_sequence,
    identity_hash: v.identity_hash,
  };
}
export async function failActive() {
  await withBtcRetentionTransaction(f.poolAdapter, async (tx) => {
    const at = (
      await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
    ).rows[0]!.now.toISOString();
    const identity = jevIdentity(),
      manifest = initialJevManifest(1);
    await storeJevEvidenceTx(
      tx,
      makeJevEvidence({
        object_id: "synthetic-failed",
        scope: jevScope(identity.bindings[0]!.binding, identity.instrument),
        kind: "result",
        recorded_at: at,
        payload: {
          artifact_id: "synthetic-failed",
          original: {
            schema_version: "jev.evaluation.v1",
            manifest_hash: jevHash(manifest),
            profile_id: "h1",
            profile_version: "v1",
            state: "failed",
            phase: "initial",
            operational_admission: false,
            as_of: at,
          },
        },
        dependencies: [],
        sources: [],
      }),
    );
    await tx.query(
      "INSERT INTO jev_evaluation_cuts(evidence_id,owner_id,profile_id,profile_version,as_of,phase,state) VALUES('synthetic-failed','operator','h1','v1',$1,'initial','failed')",
      [at],
    );
  });
  flags.failed = "h1";
}
describe.skipIf(!url)(
  "JE15 actual execution entrypoint on disposable PostgreSQL",
  () => {
    beforeEach(async () => {
      flags.qualified = true;
      flags.eligible = true;
      flags.failed = "";
      flags.integrated = true;
      flags.rejected = "";
      f = await riskFixture(url);
      const manifest = initialJevManifest(1),
        paper = jevIdentity(),
        stress = jevIdentity("stress"),
        live = jevIdentity("live");
      for (const i of [paper, stress, live])
        i.bindings[0]!.profile.manifest_hash = jevHash(manifest);
      await registerJevPair(f.poolAdapter, 1, paper, stress, manifest);
      await registerJevLiveIdentity(f.poolAdapter, live, manifest);
      store = new PgLiveStore(f.poolAdapter, liveIdentity);
      await store.register();
      await refresh("authorize_supervisor");
      await withBtcRetentionTransaction(f.poolAdapter, async (tx) => {
        const evidenceAt = (
          await tx.query<{ at: Date }>("SELECT clock_timestamp() AS at")
        ).rows[0]!.at.toISOString();
        await storeJevEvidenceTx(
          tx,
          makeJevEvidence({
            object_id: "synthetic-venue-trial",
            scope: jevScope(live.bindings[0]!.binding, live.instrument),
            kind: "quality",
            recorded_at: evidenceAt,
            payload: {
              start_at: evidenceAt,
              end_at: evidenceAt,
              gaps: [],
              counters: {},
              original: {
                version: "jev.venue-validation.v1",
                identity_hash: store.identityHash,
                origin: "observed_venue_trial",
                verified: true,
                fixture_only: true,
              },
            },
            dependencies: [],
            sources: [],
          }),
        );
        await tx.query(
          "INSERT INTO jev_live_venue_validations(identity_hash,evidence_id,verified) VALUES($1,'synthetic-venue-trial',true)",
          [store.identityHash],
        );
      });
    });
    afterEach(async () => {
      await f?.dispose();
    });
    const configuration: ApiConfig = {
      executionMode: "paper",
      server: { host: "127.0.0.1", port: 3000 },
      database: {
        host: "fixture",
        port: 5432,
        name: "fixture_test",
        user: "fixture",
        password: new SecretValue("fixture"),
        ssl: false,
        connectTimeoutMs: 1000,
      },
      statementBudgets: { ceilingMs: 4000, defaultMs: 2000, routes: {} },
      log: { level: "error" },
    };
    const pool = (): DatabasePool => ({
      ...f.poolAdapter,
      query: async (sql, params) => {
        const r = await f.pool.query(sql, params ? [...params] : []);
        return { rows: r.rows, rowCount: r.rowCount ?? 0 };
      },
      readOnly: (_ms, run) => f.poolAdapter.transaction(run),
      end: async () => {},
    });
    const liveConfig = () =>
      Promise.resolve({
        version: "jev.live-runtime.v1" as const,
        identity_hash: store.identityHash,
        environment: "mainnet" as const,
      });
    const signer = () =>
      Promise.resolve({
        address: liveIdentity.signer_address,
        signTypedData: vi.fn(
          async (_data: unknown) => `0x${"1".repeat(128)}1b` as `0x${string}`,
        ),
      });
    async function boot(
      live: NonNullable<Parameters<typeof runExecutionWorker>[0]>["live"],
    ) {
      const controller = new AbortController();
      const health: Record<string, unknown>[] = [];
      await runExecutionWorker({
        configuration,
        pool: pool(),
        sha: "a".repeat(40),
        signal: controller.signal,
        ...(live ? { live } : {}),
        publish: async (state) => {
          health.push(state as Record<string, unknown>);
          if ((state as { ready: boolean }).ready) controller.abort();
        },
      });
      return health.find((h) => h.ready)!.live;
    }
    it("boots the published entrypoint closed without configuration or human activation", async () => {
      const key = vi.fn(signer),
        wire = { isTestnet: false, request: vi.fn() };
      expect(
        await boot({ configuration: async () => null, signer: key, wire }),
      ).toMatchObject({ connected: false, signer_loaded: false });
      expect(
        await boot({ configuration: liveConfig, signer: key, wire }),
      ).toMatchObject({
        connected: false,
        entries_ready: false,
        reasons: ["JEV_LIVE_IDENTITY_OR_ACTIVATION_MISSING"],
      });
      expect(key).not.toHaveBeenCalled();
      expect(wire.request).not.toHaveBeenCalled();
      expect(
        (await f.pool.query("SELECT count(*)::int n FROM jev_live_activations"))
          .rows[0].n,
      ).toBe(0);
      expect(
        (await f.pool.query("SELECT count(*)::int n FROM jev_accounts")).rows[0]
          .n,
      ).toBe(3);
    });
    it("constructs the adapter only for a previously authorized matching identity, retains the integration gate, and fences two workers", async () => {
      await activateJevLive(
        f.poolAdapter,
        "operator",
        await body(),
        "fixture-operator",
      );
      flags.integrated = false;
      const wire = { isTestnet: false, request: vi.fn() };
      expect(
        await boot({ configuration: liveConfig, signer, wire }),
      ).toMatchObject({
        connected: true,
        signer_loaded: true,
        entries_ready: false,
        reasons: expect.arrayContaining(["live_integration_pending"]),
      });
      expect(wire.request.mock.calls.every((c) => c[0] !== "exchange")).toBe(
        true,
      );
      const lease = await claimExecutionWorker(pool(), "b".repeat(40));
      await expect(
        claimExecutionWorker(pool(), "c".repeat(40)),
      ).rejects.toThrow("OWNED");
      const owned = executionFencedPool(pool(), lease);
      await releaseExecutionWorker(pool(), lease);
      const key = vi.fn(signer);
      const runtime = await loadJevLiveRuntime({
        pool: owned,
        lease,
        sha: "b".repeat(40),
        configuration: liveConfig,
        signer: key,
        wire,
      });
      expect(runtime.adapter).toBeNull();
      expect(key).not.toHaveBeenCalled();
    });
    it("retires a boot encountering another live owner instead of remaining disconnected for an activated pilot", async () => {
      await activateJevLive(
        f.poolAdapter,
        "operator",
        await body(),
        "fixture-operator",
      );
      await store.claim("retiring-fixture");
      const wire = { isTestnet: false, request: vi.fn() };
      await expect(
        boot({ configuration: liveConfig, signer, wire }),
      ).rejects.toThrow("JEV_LIVE_RUNTIME_OWNERSHIP_BUSY");
      expect(wire.request).not.toHaveBeenCalled();
      expect(
        (
          await f.pool.query(
            "SELECT lease_until<=clock_timestamp() expired FROM execution_worker_head",
          )
        ).rows[0].expired,
      ).toBe(true);
    });
    it("refuses a wrong signer, secret failure, transport environment or config identity without sending", async () => {
      await activateJevLive(
        f.poolAdapter,
        "operator",
        await body(),
        "fixture-operator",
      );
      const wire = { isTestnet: false, request: vi.fn() };
      expect(
        await boot({
          configuration: liveConfig,
          signer: async () => {
            throw new Error("synthetic secret failure");
          },
          wire,
        }),
      ).toMatchObject({ connected: false });
      expect(
        await boot({
          configuration: liveConfig,
          signer: async () => ({
            ...(await signer()),
            address: liveIdentity.account_address,
          }),
          wire,
        }),
      ).toMatchObject({ connected: false });
      expect(
        await boot({
          configuration: liveConfig,
          signer,
          wire: { ...wire, isTestnet: true },
        }),
      ).toMatchObject({ connected: false });
      expect(wire.request).not.toHaveBeenCalled();
    });

    async function setupLive() {
      for (const [slot, h] of [3, 5].entries()) {
        const m = initialJevManifest(h as 3 | 5),
          p = jevIdentity("paper", `h${h}`),
          s = jevIdentity("stress", `h${h}`);
        for (const i of [p, s]) {
          i.bindings[0]!.profile.horizon_minutes = h as 3 | 5;
          i.bindings[0]!.profile.manifest_hash = jevHash(m);
        }
        await registerJevPair(f.poolAdapter, slot + 2, p, s, m);
      }
      await f.pool.query(
        "INSERT INTO jev_worker_controls(account_id,admitted,entries_paused,admission_reference,funding_debit_rate9_raw,cost_evidence_id) SELECT account_id,true,false,'synthetic-fixture',0,'fixture:capacity' FROM jev_accounts WHERE mode<>'live'",
      );
      await activateJevLive(
        f.poolAdapter,
        "operator",
        await body(),
        "fixture-operator",
      );
      const at = Date.now() - 50;
      await seedRuntimeMarket(f.poolAdapter, at, true);
      await withBtcRetentionTransaction(f.poolAdapter, async (tx) => {
        const capacity = await seedDispatchCapacityTx(tx, Date.now() - 50);
        await tx.query(
          "UPDATE jev_worker_controls SET capacity_evidence_id=$1",
          [capacity],
        );
      });
      const tariff = mockTariff();
      await provisionJevCostPool(f.poolAdapter, {
        origin: "mock",
        purpose: "operation",
        month: new Date().toISOString().slice(0, 7),
        tariff,
        provision_reference: "synthetic-fixture",
        billing_bound_reference: "synthetic-fixture",
        enabled: true,
      });
      return tariff;
    }
    async function exercise(
      venue: ReturnType<typeof runtimeVenue>,
      mode:
        | "partial"
        | "rejected"
        | "uncertain"
        | "uncertain_restart"
        | "uncertain_cancel"
        | "starved"
        | "unsent"
        | "jev_close",
      maxMs = 12000,
    ) {
      const tariff = await setupLive(),
        batches: JevBatch[] = [];
      await f.pool.query("UPDATE jev_worker_controls SET entries_paused=true");
      const controller = new AbortController();
      if (mode === "unsent") {
        let paused = false;
        f.setHook(async (sql, tx) => {
          if (!paused && sql.startsWith("INSERT INTO jev_live_requests")) {
            paused = true;
            await tx.query(
              "UPDATE jev_worker_controls SET entries_paused=true WHERE account_id='live:h1'",
            );
          }
        });
      }
      const adapter = createJevDecisionAdapter({
        store: createJevDecisionStore(f.poolAdapter),
        enabled: true,
        tariff,
        transport: {
          origin: "mock",
          model: tariff.model,
          evaluate: async (batch, signal) => {
            batches.push(batch);
            if (mode === "starved" && batch.manifest.horizon_minutes !== 1) {
              // Deliberately ignores the provider deadline to prove lane isolation.
              await new Promise<void>((resolve) =>
                controller.signal.aborted
                  ? resolve()
                  : controller.signal.addEventListener(
                      "abort",
                      () => resolve(),
                      { once: true },
                    ),
              );
              throw new Error(
                "synthetic transport hung until process shutdown",
              );
            }
            const response = decisionResponse(batch);
            // Paper accounts hold; only the fixture's authorized live pilot enters.
            for (const [i, p] of batch.participants.entries())
              if (p.context.scope.mode !== "live") {
                const a = response.answers[`a${i}_intent`];
                if (a)
                  Object.assign(a, {
                    choice: "hold",
                    probabilities: { open: 0, hold: 1, close: 0 },
                  });
              }
            if (
              mode !== "jev_close" &&
              batches.some((b) =>
                b.participants.some(
                  (p) =>
                    p.context.scope.mode === "live" &&
                    p.context.account?.position,
                ),
              )
            ) {
              await new Promise<void>((resolve) => {
                if (signal.aborted) resolve();
                else
                  signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
              });
              throw new Error("synthetic JEV unavailable");
            }
            return {
              body: JSON.stringify(response),
              status: 200,
              received_at: new Date().toISOString(),
            };
          },
        },
      });
      const health: Record<string, unknown>[] = [];
      const began = Date.now();
      let warmed = false,
        jointlyDue = false,
        closeDue = false,
        marketAt = -Infinity;
      const timeout = setTimeout(() => controller.abort(), maxMs);
      try {
        await runExecutionWorker({
          configuration,
          pool: pool(),
          sha: "a".repeat(40),
          signal: controller.signal,
          backend: {
            status: {
              enabled: true,
              origin: "real",
              model: tariff.model,
              credential_present: true,
              reasons: [],
            },
            evaluate: adapter.evaluate,
          },
          live: { configuration: liveConfig, signer, wire: venue.wire },
          publish: async (raw) => {
            const state = raw as Record<string, unknown>;
            health.push(structuredClone(state));
            if (!state.ready) return;
            if (!warmed) {
              warmed = true;
              const at = new Date(Date.now() - 50).toISOString();
              // Synthetic jointly-due cut after recovery, with the real cadence policy.
              for (const row of (
                await f.pool.query(
                  "SELECT a.identity,b.binding,p.manifest FROM jev_accounts a JOIN jev_bindings b USING(account_id) JOIN jev_profiles p ON p.owner_id=b.owner_id AND p.profile_id=b.profile_id AND p.profile_version=b.profile_version",
                )
              ).rows) {
                const cadence = recordJevDecision(
                  initialJevCadence(
                    row.manifest,
                    jevScope(row.binding, row.identity.instrument),
                    at,
                  ),
                  at,
                  "101000000",
                );
                await f.pool.query(
                  "INSERT INTO jev_worker_cadences(account_id,generation,state) VALUES($1,$2,$3) ON CONFLICT(account_id) DO UPDATE SET state=EXCLUDED.state",
                  [row.binding.account_id, state.generation, cadence],
                );
              }
              await f.pool.query(
                "UPDATE jev_worker_controls SET entries_paused=false WHERE account_id='live:h1'",
              );
            }
            if (Date.now() - marketAt >= 750) {
              marketAt = Date.now();
              await seedRuntimeMarket(f.poolAdapter, marketAt - 50);
            }
            if (
              !jointlyDue &&
              (state.metrics as { accounts: number }).accounts === 7 &&
              (state.metrics as { protected_accounts: number })
                .protected_accounts === 7 &&
              (state.live as { entries_ready: boolean }).entries_ready &&
              !(state.live as { metrics: { running: boolean } }).metrics.running
            ) {
              jointlyDue = true;
              marketAt = Date.now();
              await seedRuntimeMarket(f.poolAdapter, marketAt - 50);
              await f.poolAdapter.transaction(async (tx) => {
                await tx.query(
                  "SELECT 1 FROM execution_worker_head FOR UPDATE",
                );
                await tx.query(
                  "UPDATE jev_worker_controls SET entries_paused=false",
                );
                await tx.query(
                  "UPDATE jev_worker_cadences SET state=jsonb_set(state,'{last_decision_at}','null')",
                );
              });
            }
            const actions = venue.exchanges;
            if (
              mode === "unsent" &&
              (
                await store.events<{ original?: { reason?: string } }>(
                  "receipt",
                )
              ).some(
                (r) => r.original?.reason === "INTENT_EXPIRED_WITHOUT_SEND",
              )
            )
              controller.abort();
            const cancels = actions.filter((a) => a.type === "cancelByCloid");
            const stops = actions.filter((a) =>
              (a.orders as { t?: { trigger?: unknown } }[] | undefined)?.some(
                (o) => o.t?.trigger,
              ),
            );
            const closes = actions.filter((a) =>
              (
                a.orders as
                  | { r?: boolean; t?: { limit?: { tif?: string } } }[]
                  | undefined
              )?.some((o) => o.r && o.t?.limit?.tif === "Ioc"),
            );
            if (
              mode === "jev_close" &&
              !closeDue &&
              stops.length &&
              (
                await store.events<
                  import("../../src/venues/hyperliquid/live-protection.js").LiveProtectionRecord
                >("protection")
              ).some((r) => r.state === "confirmed")
            ) {
              closeDue = true;
              await f.poolAdapter.transaction(async (tx) => {
                await tx.query(
                  "SELECT 1 FROM execution_worker_head FOR UPDATE",
                );
                await tx.query(
                  "UPDATE jev_worker_cadences SET state=jsonb_set(state,'{last_decision_at}','null') WHERE account_id='live:h1'",
                );
              });
            }
            if (
              mode === "jev_close" &&
              closes.length >= 2 &&
              (await store.latest()).snapshot?.flat
            )
              controller.abort();
            if (
              (mode === "partial" || mode === "starved") &&
              cancels.length &&
              stops.length >= 2
            )
              controller.abort();
            if (
              mode === "uncertain_restart" &&
              actions.some((a) =>
                (a.orders as { r: boolean }[] | undefined)?.some((o) => !o.r),
              )
            )
              controller.abort();
            if (
              mode === "rejected" &&
              closes.length >= 2 &&
              venue.position() === 0n
            )
              controller.abort();
            if (
              mode === "uncertain" &&
              cancels.length &&
              Date.now() - began > 4500
            )
              controller.abort();
            if (
              mode === "uncertain_cancel" &&
              cancels.length >= 2 &&
              (await store.latest()).snapshot?.flat
            )
              controller.abort();
          },
        });
      } finally {
        clearTimeout(timeout);
        f.setHook(null);
      }
      if (mode !== "unsent")
        expect(
          venue.exchanges.some((a) =>
            (a.orders as { r: boolean }[] | undefined)?.some((o) => !o.r),
          ),
          JSON.stringify({
            mode,
            batches: batches.map((b) => ({
              modes: b.participants.map((p) => p.context.scope.mode),
              cut: b.cut_at,
            })),
            receipts: await store.events("receipt"),
            entries: (
              await f.pool.query(
                "SELECT status,recorded_at FROM jev_entry_events WHERE account_id='live:h1' ORDER BY recorded_at",
              )
            ).rows,
            cycles: (
              await f.pool.query(
                "SELECT phase,data FROM jev_worker_cycles WHERE account_id='live:h1' ORDER BY recorded_at",
              )
            ).rows,
            live: health.at(-2)?.live,
          }),
        ).toBe(true);
      return { batches, health, elapsed: Date.now() - began };
    }
    it("dispatches all seven accounts, bills a three-participant lot once and protects late partials across cancellation", async () => {
      const venue = runtimeVenue();
      venue.configure({ partial: true, late_fill: true });
      const r = await exercise(venue, "partial");
      const batch = r.batches.find((b) => b.participants.length === 3);
      expect(
        batch?.participants.map((p) => p.context.scope.mode).sort(),
        JSON.stringify({
          batches: r.batches.map((b) => ({
            modes: b.participants.map((p) => p.context.scope.mode),
            quality: b.participants.map((p) => p.context.quality),
          })),
          health: r.health.at(-2),
        }),
      ).toEqual(["live", "paper", "stress"]);
      expect(
        new Set(
          r.batches.flatMap((b) =>
            b.participants.map((p) => p.context.scope.account_id),
          ),
        ).size,
      ).toBe(7);
      expect(
        venue.exchanges.filter((a) =>
          (a.orders as { r: boolean }[] | undefined)?.some((o) => !o.r),
        ),
        JSON.stringify({
          receipts: await store.events("receipt"),
          requests: (await store.operations()).map((r) => ({
            operation_id: r.operation_id,
            kind: r.kind,
          })),
          cycles: (
            await f.pool.query(
              "SELECT phase,data FROM jev_worker_cycles WHERE account_id='live:h1' ORDER BY recorded_at",
            )
          ).rows,
          live: r.health.at(-2)?.live,
        }),
      ).toHaveLength(1);
      const stops = venue.exchanges
        .flatMap(
          (a) =>
            (a.orders as
              | { r: boolean; t: { trigger?: unknown }; s: string }[]
              | undefined) ?? [],
        )
        .filter((o) => o.t.trigger);
      expect(stops.length).toBeGreaterThanOrEqual(2);
      expect(stops.every((o) => o.r)).toBe(true);
      const fees = await store.accountView();
      expect(fees.fees_raw).toBe("2000");
      const invoice = (
        await f.pool.query(
          "SELECT result FROM jev_decision_results WHERE request_id=$1",
          [batch!.request_id],
        )
      ).rows[0]?.result;
      expect(invoice.cost_usd6).toBe("42");
      expect(invoice.decisions).toHaveLength(3);
      expect(
        invoice.decisions.every(
          (d: { attributed_cost_usd6: string }) =>
            d.attributed_cost_usd6 === "42",
        ),
      ).toBe(true);
      expect(
        (await f.pool.query("SELECT count(*)::int n FROM jev_live_activations"))
          .rows[0].n,
      ).toBe(1);
    }, 20000);
    it("replaces an expired uncertain cancellation only after a fresh query proves its parent still open, with a new nonce and no entry replay", async () => {
      const venue = runtimeVenue();
      venue.configure({ lost_cancel: true });
      await exercise(venue, "uncertain_cancel");
      const requests = await store.operations();
      const cancels = requests.filter((r) => r.kind === "cancel");
      expect(cancels).toHaveLength(2);
      expect(cancels[1]!.nonce).toBeGreaterThan(cancels[0]!.nonce);
      expect(cancels[1]!.operation_id).not.toBe(cancels[0]!.operation_id);
      const parent = requests.find((r) => r.kind === "entry")!;
      expect(
        (await store.events<LiveSnapshot>("snapshot")).some(
          (s) =>
            s.venue_at > cancels[0]!.expires_after &&
            s.received_at < cancels[1]!.nonce &&
            s.orders.some((o) => o.cloid === parent.cloid),
        ),
      ).toBe(true);
      expect(requests.filter((r) => r.kind === "entry")).toHaveLength(1);
      expect(venue.position()).toBe(0n);
      expect(venue.orders).toHaveLength(0);
      const sent = venue.exchanges.length;
      await resume(
        venue,
        async (state) =>
          (state.live as { metrics: { cycles: number } }).metrics.cycles >= 2,
      );
      expect(venue.exchanges.length).toBe(sent);
      expect(
        (await f.pool.query("SELECT count(*)::int n FROM jev_live_activations"))
          .rows[0].n,
      ).toBe(1);
    }, 25000);
    it("reduces a partial after stop rejection without JEV, queries residuals and never declares flat from ACK", async () => {
      const venue = runtimeVenue();
      venue.configure({ partial: true, reject_stop: true });
      await exercise(venue, "rejected");
      const closes = venue.exchanges
        .flatMap(
          (a) =>
            (a.orders as
              { r: boolean; t: { limit?: { tif?: string } } }[] | undefined) ??
            [],
        )
        .filter((o) => o.t.limit?.tif === "Ioc");
      expect(closes.length).toBeGreaterThanOrEqual(2);
      expect(closes.every((o) => o.r)).toBe(true);
      expect(venue.position()).toBe(0n);
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int n FROM jev_live_requests WHERE reservation->>'kind'='entry'",
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await f.pool.query(
            "SELECT checkpoint FROM jev_pilot_events ORDER BY sequence DESC LIMIT 1",
          )
        ).rows[0].checkpoint.risk.high_water_usd_raw,
      ).toBe("250000000");
    }, 20000);
    it("recovers loss after a send without re-signing, cancels from queried ACK and retains the lifetime activation", async () => {
      const venue = runtimeVenue();
      venue.configure({ lost_ack: true });
      await exercise(venue, "uncertain");
      expect(
        venue.exchanges.filter((a) =>
          (a.orders as { r: boolean }[] | undefined)?.some((o) => !o.r),
        ),
      ).toHaveLength(1);
      expect(venue.exchanges.some((a) => a.type === "cancelByCloid")).toBe(
        true,
      );
      const attempts = (
        await f.pool.query(
          "SELECT count(*)::int n FROM jev_live_events WHERE event_key LIKE 'receipt:attempt:%'",
        )
      ).rows[0].n;
      expect(attempts).toBe(2);
    }, 20000);
    async function resume(
      venue: ReturnType<typeof runtimeVenue>,
      until: (state: Record<string, unknown>) => Promise<boolean>,
      maxMs = 9000,
    ) {
      const controller = new AbortController(),
        health: Record<string, unknown>[] = [];
      let marketAt = -Infinity;
      const adapter = createJevDecisionAdapter({
        store: createJevDecisionStore(f.poolAdapter),
        enabled: false,
        tariff: mockTariff(),
        transport: {
          origin: "mock",
          model: mockTariff().model,
          evaluate: async () => {
            throw new Error("synthetic provider down");
          },
        },
      });
      const timeout = setTimeout(() => controller.abort(), maxMs);
      try {
        await runExecutionWorker({
          configuration,
          pool: pool(),
          sha: "b".repeat(40),
          signal: controller.signal,
          backend: {
            status: {
              enabled: false,
              origin: "real",
              model: mockTariff().model,
              credential_present: false,
              reasons: ["synthetic-provider-down"],
            },
            evaluate: adapter.evaluate,
          },
          live: { configuration: liveConfig, signer, wire: venue.wire },
          publish: async (raw) => {
            const state = raw as Record<string, unknown>;
            health.push(structuredClone(state));
            if (!state.ready) return;
            if (Date.now() - marketAt >= 750) {
              marketAt = Date.now();
              await seedRuntimeMarket(f.poolAdapter, marketAt - 50);
            }
            if (await until(state)) controller.abort();
          },
        });
      } finally {
        clearTimeout(timeout);
      }
      return health;
    }
    it("restarts with native protection, deduplicates signed late funding and preserves lifetime HWM and first fill with JEV disabled", async () => {
      const venue = runtimeVenue();
      venue.configure({ partial: true, late_fill: true });
      await exercise(venue, "partial");
      const previous = (
        await store.events<
          import("../../src/venues/hyperliquid/live-protection.js").LiveProtectionRecord
        >("protection")
      )
        .filter((r) => r.protection)
        .at(-1)!.protection!;
      const sent = venue.exchanges.length;
      venue.addFunding(3000000n);
      flags.integrated = false; // The current build's gate never suspends protection.
      const health = await resume(
        venue,
        async (state) =>
          Number(
            (state.live as { metrics: { cycles: number } }).metrics.cycles,
          ) >= 3,
      );
      expect(
        health
          .filter((h) => h.ready)
          .every(
            (h) =>
              (h.live as { entries_ready: boolean }).entries_ready === false,
          ),
      ).toBe(true);
      expect(health.find((h) => h.ready)!.generation).toBe("2");
      expect(venue.exchanges.length).toBe(sent);
      const view = await store.accountView();
      expect(view.funding_raw).toBe("3000000");
      expect(view.fees_raw).toBe("2000");
      const current = (
        await store.events<
          import("../../src/venues/hyperliquid/live-protection.js").LiveProtectionRecord
        >("protection")
      )
        .filter((r) => r.protection)
        .at(-1)!.protection!;
      expect(current.first_fill_at).toBe(previous.first_fill_at);
      expect(current.maximum_exit_at).toBe(previous.maximum_exit_at);
      const pilot = (
        await f.pool.query(
          "SELECT sequence::text,checkpoint FROM jev_pilot_events ORDER BY jev_pilot_events.sequence DESC LIMIT 1",
        )
      ).rows[0];
      expect(BigInt(pilot.sequence)).toBeGreaterThan(9n);
      expect(pilot.checkpoint.risk.high_water_usd_raw).toBe("252998000");
      expect(
        (await f.pool.query("SELECT count(*)::int n FROM jev_live_activations"))
          .rows[0].n,
      ).toBe(1);
    }, 30000);
    it("keeps an inconclusive pilot, restarts during draining, rejects the stale candidate and promotes only after queried flat without resetting capital or pause", async () => {
      const venue = runtimeVenue();
      venue.configure({ partial: true, late_fill: true });
      await exercise(venue, "partial");
      flags.eligible = false;
      const sent = venue.exchanges.length;
      await resume(
        venue,
        async (state) =>
          Number(
            (state.live as { metrics: { cycles: number } }).metrics.cycles,
          ) >= 2,
      );
      expect(venue.exchanges.length).toBe(sent);
      expect(
        (
          await f.pool.query(
            "SELECT state,profile_id FROM jev_live_promotions ORDER BY sequence DESC LIMIT 1",
          )
        ).rows[0],
      ).toMatchObject({ state: "active", profile_id: "h1" });
      await f.pool.query(
        "UPDATE jev_worker_controls SET entries_paused=true WHERE account_id='live:h1'",
      );
      await failActive();
      flags.eligible = true;
      flags.rejected = "h3";
      // A persisted drain survives a process restart before any successor.
      expect(
        (await advanceJevPromotion(f.poolAdapter, "operator")).status,
      ).toBe("draining");
      expect(venue.position()).not.toBe(0n);
      expect(
        (
          await f.pool.query(
            "SELECT state FROM jev_live_promotions ORDER BY sequence DESC LIMIT 1",
          )
        ).rows[0].state,
      ).toBe("draining");
      await resume(
        venue,
        async () =>
          (
            await f.pool.query(
              "SELECT profile_id,state FROM jev_live_promotions ORDER BY sequence DESC LIMIT 1",
            )
          ).rows[0].profile_id === "h5",
      );
      expect(venue.position()).toBe(0n);
      expect(venue.orders).toHaveLength(0);
      expect(
        (
          await f.pool.query(
            "SELECT profile_id,state FROM jev_live_promotions ORDER BY sequence DESC LIMIT 1",
          )
        ).rows[0],
      ).toMatchObject({ profile_id: "h5", state: "active" });
      expect(
        (
          await f.pool.query(
            "SELECT entries_paused FROM jev_worker_controls WHERE account_id='live:h1'",
          )
        ).rows[0].entries_paused,
      ).toBe(true);
      expect(
        (await f.pool.query("SELECT count(*)::int n FROM jev_live_activations"))
          .rows[0].n,
      ).toBe(1);
      const pilot = (
        await f.pool.query(
          "SELECT checkpoint FROM jev_pilot_events ORDER BY sequence DESC LIMIT 1",
        )
      ).rows[0].checkpoint;
      expect(pilot.capital_admitted_usd_raw).toBe("250000000");
      expect(pilot.risk.high_water_usd_raw).toBe("250000000");
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int n FROM jev_accounts WHERE mode='live'",
          )
        ).rows[0].n,
      ).toBe(1);
    }, 45000);
    it("closes readiness on stale venue data while retaining native stops and making no new entry", async () => {
      const venue = runtimeVenue();
      venue.configure({ partial: true, late_fill: true });
      await exercise(venue, "partial");
      const sent = venue.exchanges.length;
      venue.configure({ stale: true });
      const h = await resume(
        venue,
        async (state) =>
          Number(
            (state.live as { metrics: { failures: number } }).metrics.failures,
          ) >= 2,
      );
      expect(
        h
          .filter((x) => x.ready)
          .every(
            (x) =>
              (x.live as { entries_ready: boolean }).entries_ready === false,
          ),
      ).toBe(true);
      expect(venue.exchanges.length).toBe(sent);
      expect(venue.orders.some((o) => o.isTrigger)).toBe(true);
      expect((await store.events("gap")).length).toBeGreaterThan(0);
    }, 30000);
    it("keeps protection and cancellation progressing while unrelated JEV transports ignore their deadlines", async () => {
      const venue = runtimeVenue();
      venue.configure({ partial: true, late_fill: true });
      const r = await exercise(venue, "starved");
      expect(
        venue.exchanges
          .flatMap(
            (a) =>
              (a.orders as { t: { trigger?: unknown } }[] | undefined) ?? [],
          )
          .filter((o) => o.t.trigger).length,
      ).toBeGreaterThanOrEqual(2);
      expect(venue.exchanges.some((a) => a.type === "cancelByCloid")).toBe(
        true,
      );
      const h = r.health.filter((h) => h.ready).at(-1)!;
      expect(
        Number((h.live as { metrics: { cycles: number } }).metrics.cycles),
      ).toBeGreaterThanOrEqual(3);
      expect(
        Number((h.metrics as { risk_cycles: number }).risk_cycles),
      ).toBeGreaterThanOrEqual(3);
      expect(r.elapsed).toBeLessThan(12000);
    }, 20000);
    it("takes over an uncertain send after restart, queries its venue identity and cancels without duplicating the original order", async () => {
      const venue = runtimeVenue();
      venue.configure({ lost_ack: true });
      await exercise(venue, "uncertain_restart");
      expect(
        venue.exchanges.filter((a) =>
          (a.orders as { r: boolean }[] | undefined)?.some((o) => !o.r),
        ),
      ).toHaveLength(1);
      flags.integrated = false;
      const h = await resume(
        venue,
        async () =>
          venue.exchanges.some((a) => a.type === "cancelByCloid") &&
          venue.orders.length === 0,
      );
      expect(h.find((s) => s.ready)!.generation).toBe("2");
      expect(
        venue.exchanges.filter((a) =>
          (a.orders as { r: boolean }[] | undefined)?.some((o) => !o.r),
        ),
      ).toHaveLength(1);
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int n FROM jev_live_events WHERE event_key LIKE 'receipt:attempt:%'",
          )
        ).rows[0].n,
      ).toBe(2);
      expect(
        (await f.pool.query("SELECT count(*)::int n FROM jev_live_activations"))
          .rows[0].n,
      ).toBe(1);
    }, 30000);
    it("routes a JEV close through the live binding and continues partial IOC reduction to confirmed flat independently of another decision", async () => {
      const venue = runtimeVenue();
      venue.configure({ partial: true });
      const r = await exercise(venue, "jev_close");
      expect(
        r.batches.some((b) =>
          b.participants.some(
            (p) =>
              p.context.scope.mode === "live" && p.context.account?.position,
          ),
        ),
      ).toBe(true);
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int n FROM jev_live_requests WHERE reservation->'request'->>'cause'='jev_close'",
          )
        ).rows[0].n,
      ).toBe(1);
      const closes = venue.exchanges
        .flatMap(
          (a) =>
            (a.orders as
              { r: boolean; t: { limit?: { tif: string } } }[] | undefined) ??
            [],
        )
        .filter((o) => o.t.limit?.tif === "Ioc");
      expect(closes.length).toBeGreaterThanOrEqual(2);
      expect(closes.every((o) => o.r)).toBe(true);
      expect((await store.latest()).snapshot).toMatchObject({
        flat: true,
        position_raw: "0",
        orders: [],
      });
      expect(
        venue.exchanges.filter((a) =>
          (a.orders as { r: boolean }[] | undefined)?.some((o) => !o.r),
        ),
      ).toHaveLength(1);
    }, 20000);
    it("expires a persisted intent paused before its send claim without signing, sending or replaying it after restart", async () => {
      const venue = runtimeVenue();
      await exercise(venue, "unsent");
      const request = (await store.operations()).find(
        (r) => r.kind === "entry",
      )!;
      expect(request).toBeDefined();
      expect(venue.exchanges).toHaveLength(0);
      const receipt = await store.expiredUnsent(request);
      expect(receipt).toMatchObject({
        state: "rejected",
        original: { reason: "INTENT_EXPIRED_WITHOUT_SEND" },
      });
      expect(await store.expiredUnsent(request)).toEqual(receipt);
      await resume(
        venue,
        async (state) =>
          Number(
            (state.live as { metrics: { cycles: number } }).metrics.cycles,
          ) >= 2,
      );
      expect(venue.exchanges).toHaveLength(0);
      expect(
        (
          await f.pool.query(
            "SELECT status FROM jev_entry_events ORDER BY sequence DESC LIMIT 1",
          )
        ).rows[0].status,
      ).toBe("released");
      expect(
        (
          await store.events<{ original?: { reason?: string } }>("receipt")
        ).filter((r) => r.original?.reason === "SEND_RESERVED"),
      ).toHaveLength(0);
    }, 20000);
  },
);
