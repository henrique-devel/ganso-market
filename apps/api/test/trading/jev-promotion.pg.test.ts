import { LiveSuccessionCoordinator } from "../../src/venues/hyperliquid/live-succession.js";
import {
  buildLiveAction,
  type LiveCommand,
} from "../../src/venues/hyperliquid/live-execution.js";
import type { LiveSnapshot } from "../../src/venues/hyperliquid/live-reconcile.js";
import { parseLiveFill } from "../../src/venues/hyperliquid/live-reconcile.js";
import { venueFill } from "../venues/live-fixture.js";
import Fastify from "fastify";
import { registerJevPanelRoutes } from "../../src/jev-panel-api.js";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { riskFixture } from "./risk-fixture.js";
import { jevIdentity } from "./jev-v2-fixture.js";
import {
  registerJevPair,
  registerJevLiveIdentity,
  readJevAccount,
} from "../../src/storage/jev-store.js";
import { initialJevManifest } from "../../src/storage/jev-manifest.js";
import { jevHash } from "../../src/storage/jev-hash.js";
import { jevScope } from "../../src/storage/jev-ledger.js";
import { withBtcRetentionTransaction } from "../../src/storage/btc-retention.js";
import {
  makeJevEvidence,
  storeJevEvidenceTx,
} from "../../src/storage/jev-evidence.js";
import { commandJevPilot } from "../../src/storage/jev-pilotstore.js";
import { PgLiveStore } from "../../src/storage/jev-live-store.js";
import {
  liveEntryCommand,
  liveIdentity,
  liveSnapshot,
} from "../venues/live-fixture.js";
import {
  activateJevLive,
  advanceJevPromotion,
  readJevLivePanelTx,
  jevLiveAuthorityTx,
  rearmJevLive,
} from "../../src/storage/jev-promotion.js";
const flags = vi.hoisted(() => ({
  qualified: true,
  eligible: true,
  failed: "",
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
          : flags.eligible
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
  const now = Date.now() - 10,
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
async function failActive() {
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
describe.skipIf(!url)("JE14 singleton handoff on disposable PostgreSQL", () => {
  beforeEach(async () => {
    flags.qualified = true;
    flags.eligible = true;
    flags.failed = "";
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
  it("does not activate from deployment/identity/credentials and closed engine, stress or venue gates prevent authority", async () => {
    expect((await panel()).activated).toBe(false);
    flags.qualified = false;
    await expect(
      activateJevLive(f.poolAdapter, "operator", await body(), "a"),
    ).rejects.toThrow("GATE_CLOSED");
    flags.qualified = true;
    flags.eligible = false;
    await expect(
      activateJevLive(f.poolAdapter, "operator", await body(), "b"),
    ).rejects.toThrow("GATE_CLOSED");
    flags.eligible = true;
    await f.pool.query("DELETE FROM jev_live_venue_validations").then(
      () => {
        throw new Error("immutable guard absent");
      },
      () => {},
    );
    expect(
      (await f.pool.query("SELECT count(*)::int n FROM jev_live_activations"))
        .rows[0].n,
    ).toBe(0);
  });
  it("two concurrent operator activations produce one live; retry and restart preserve cash, HWM and the original operator act", async () => {
    await refresh();
    const request = await body(),
      before = await readJevAccount(f.poolAdapter, "operator", "live:h1");
    const out = await Promise.allSettled([
      activateJevLive(f.poolAdapter, "operator", request, "same"),
      activateJevLive(f.poolAdapter, "operator", request, "same"),
    ]);
    expect(out.every((r) => r.status === "fulfilled")).toBe(true);
    expect(
      (await f.pool.query("SELECT count(*)::int n FROM jev_live_activations"))
        .rows[0].n,
    ).toBe(1);
    expect(
      (await f.pool.query("SELECT count(*)::int n FROM jev_live_promotions"))
        .rows[0].n,
    ).toBe(1);
    expect(await advanceJevPromotion(f.poolAdapter, "operator")).toMatchObject({
      status: "healthy",
    });
    expect(await readJevAccount(f.poolAdapter, "operator", "live:h1")).toEqual(
      before,
    );
    await expect(
      activateJevLive(
        f.poolAdapter,
        "operator",
        { ...request, expected_pilot_sequence: "900" },
        "same",
      ),
    ).rejects.toThrow("COLLISION");
    expect((await panel()).high_water_usd6).toBe("250000000");
  });
  it("rejects a gate changing during the click, invalid capital and global DD without resetting its latch", async () => {
    const request = await body();
    await refresh();
    await expect(
      activateJevLive(f.poolAdapter, "operator", request, "stale"),
    ).rejects.toThrow("GATE_CLOSED");
    await expect(
      activateJevLive(
        f.poolAdapter,
        "operator",
        { ...(await body()), confirmed_capital_usd6: "251000000" },
        "capital",
      ),
    ).rejects.toThrow("INVALID_COMMAND");
    await refresh("observe", "237500000");
    expect((await panel()).global_blocked).toBe(true);
    await expect(
      activateJevLive(f.poolAdapter, "operator", await body(), "dd"),
    ).rejects.toThrow("GATE_CLOSED");
    expect((await panel()).high_water_usd6).toBe("250000000");
  });
  it("API requires the authenticated owner, same origin and CSRF, rejecting caller-supplied money or identity acts", async () => {
    const app = Fastify();
    registerJevPanelRoutes(app, {
      pool: {
        ...f.poolAdapter,
        readOnly: (_ms, run) => f.poolAdapter.transaction(run),
      },
      authService: {
        session: async (token) => ({
          status: "ok",
          username: token,
          expiresAt: new Date(Date.now() + 60000),
        }),
      },
    });
    const request = await body(),
      headers = {
        authorization: "Bearer operator",
        host: "localhost",
        origin: "http://localhost",
        "x-csrf-token": "fixture",
        cookie: "ganso_csrf=fixture",
        "idempotency-key": "api-activation",
      };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/trading/jev/activate",
          payload: request,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/trading/jev/activate",
          payload: request,
          headers: { ...headers, origin: "https://other.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/trading/jev/activate",
          payload: request,
          headers: { ...headers, "x-csrf-token": "other" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/trading/jev/activate",
          payload: { ...request, actor_id: "operator" },
          headers,
        })
      ).statusCode,
    ).toBe(400);
    const out = await app.inject({
      method: "POST",
      url: "/trading/jev/activate",
      payload: request,
      headers,
    });
    expect(out.statusCode).toBe(200);
    expect(out.headers["cache-control"]).toBe("no-store");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/trading/jev/activate",
          payload: request,
          headers,
        })
      ).json().status,
    ).toBe("duplicate");
    await app.close();
  });
  it("switches only after durable reproval and flat reconciliation, preserving the live cash, HWM and immutable attribution", async () => {
    const manifest = initialJevManifest(3),
      paper = jevIdentity("paper", "h2"),
      stress = jevIdentity("stress", "h2");
    for (const i of [paper, stress]) {
      i.bindings[0]!.profile.manifest_hash = jevHash(manifest);
      i.bindings[0]!.profile.horizon_minutes = 3;
    }
    await registerJevPair(f.poolAdapter, 2, paper, stress, manifest);
    await refresh();
    await activateJevLive(f.poolAdapter, "operator", await body(), "initial");
    expect((await advanceJevPromotion(f.poolAdapter, "operator")).status).toBe(
      "healthy",
    );
    const priorAt = Date.parse(
      (
        await f.pool.query(
          "SELECT checkpoint->'observation'->>'observed_at' AS observed FROM jev_pilot_events ORDER BY sequence DESC LIMIT 1",
        )
      ).rows[0].observed,
    );
    const gain = parseLiveFill(
      venueFill(Date.now(), {
        time: priorAt + 1,
        closedPnl: "20",
        fee: "0",
      }),
    );
    await store.append("fill", gain.key, gain);
    await refresh("observe", "270000000");
    const before = await readJevAccount(f.poolAdapter, "operator", "live:h1");
    await failActive();
    flags.failed = "h1";
    expect((await advanceJevPromotion(f.poolAdapter, "operator")).status).toBe(
      "draining",
    );
    flags.eligible = false;
    expect((await advanceJevPromotion(f.poolAdapter, "operator")).status).toBe(
      "waiting",
    );
    flags.eligible = true;
    const out = await Promise.all([
      advanceJevPromotion(f.poolAdapter, "operator"),
      advanceJevPromotion(f.poolAdapter, "operator"),
    ]);
    expect(out.filter((r) => r.status === "promoted")).toHaveLength(1);
    expect((await panel()).promotion?.profile_id).toBe("h2");
    expect((await panel()).high_water_usd6).toBe("270000000");
    expect((await panel()).equity_usd6).toBe("270000000");
    const after = await readJevAccount(f.poolAdapter, "operator", "live:h1");
    expect(after.events).toEqual(before.events);
    expect(after.projection).toEqual(before.projection);
    expect(after.identity.bindings).toHaveLength(2);
    const oldScope = jevScope(
        before.identity.bindings[0]!.binding,
        before.identity.instrument,
      ),
      newScope = jevScope(
        after.identity.bindings.find((b) => b.binding.profile_id === "h2")!
          .binding,
        after.identity.instrument,
      );
    expect(
      await f.poolAdapter.transaction((tx) =>
        jevLiveAuthorityTx(tx, "operator", oldScope, false),
      ),
    ).toMatchObject({ activation_id: null, entries_allowed: false });
    expect(
      await f.poolAdapter.transaction((tx) =>
        jevLiveAuthorityTx(tx, "operator", newScope, false),
      ),
    ).toMatchObject({ activation_id: "initial", entries_allowed: false });
    const c = liveEntryCommand(Date.now() - 10),
      lease = await store.claim("late-profile-process");
    const request: LiveCommand = {
      version: c.version,
      kind: "close",
      scope: oldScope,
      operation_id: "late-old-exit",
      metadata: c.metadata,
      metadata_at: c.metadata_at,
      snapshot: liveSnapshot(Date.now() - 10),
      limit_price_raw: "60000000000",
      cause: "delayed_old_profile",
    };
    await expect(
      store.reserve({
        scope: oldScope,
        operation_id: request.operation_id,
        kind: "close",
        request,
        lease,
        action: (cloid) =>
          buildLiveAction(liveIdentity, request, cloid, Date.now()),
      }),
    ).rejects.toThrow("PROFILE_FENCE");
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM jev_live_requests WHERE operation_id='late-old-exit'",
        )
      ).rows[0].n,
    ).toBe(0);

    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM jev_evidence_closures WHERE experiment_id='experiment:live:h1'",
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("DD rearm is a new authenticated decision, cannot lower HWM or release the daily latch, and is idempotent", async () => {
    await activateJevLive(f.poolAdapter, "operator", await body(), "initial");
    await refresh("observe", "237500000");
    const request = async () => {
      const v = await panel();
      return {
        version: "jev.live-rearm.v1",
        identity_hash: v.identity_hash,
        expected_pilot_sequence: v.pilot_sequence,
        confirmed_high_water_usd6: v.high_water_usd6,
      };
    };
    expect((await panel()).can_rearm).toBe(false);
    await expect(
      rearmJevLive(f.poolAdapter, "operator", await request(), "unsafe"),
    ).rejects.toThrow("GATE_CLOSED");
    await refresh();
    expect((await panel()).can_rearm).toBe(true);
    const b = await request();
    await refresh();
    await expect(
      rearmJevLive(f.poolAdapter, "operator", b, "stale"),
    ).rejects.toThrow("GATE_CLOSED");
    const valid = await request();
    const out = await Promise.all([
      rearmJevLive(f.poolAdapter, "operator", valid, "new-human-act"),
      rearmJevLive(f.poolAdapter, "operator", valid, "new-human-act"),
    ]);
    expect(out.map((r) => r.status).sort()).toEqual(["duplicate", "rearmed"]);
    const v = await panel();
    expect(v.global_blocked).toBe(false);
    expect(v.high_water_usd6).toBe("250000000");
    expect(v.reasons).toContain("daily_or_global_risk_paused");
    expect(
      (
        await f.pool.query(
          "SELECT request->'operator_decision'->>'actor_id' actor FROM jev_pilot_events WHERE request->>'action'='rearm'",
        )
      ).rows[0].actor,
    ).toBe("operator");
  });
  it("a residual or inconclusive position survives restart and requests reduce-only closure even when candidate gates close", async () => {
    await activateJevLive(f.poolAdapter, "operator", await body(), "initial");
    await failActive();
    flags.eligible = false;
    const authority = await f.poolAdapter.transaction((tx) =>
      jevLiveAuthorityTx(tx, "operator", liveEntryCommand(Date.now()).scope),
    );
    expect(authority).toMatchObject({
      activation_id: "initial",
      entries_allowed: false,
    });
    expect(
      await f.poolAdapter.transaction((tx) =>
        jevLiveAuthorityTx(
          tx,
          "operator",
          liveEntryCommand(Date.now()).scope,
          false,
        ),
      ),
    ).toMatchObject({ activation_id: "initial", entries_allowed: false });
    flags.qualified = false;
    const s = await refresh("observe", "250000000", {
      flat: false,
      position_raw: "10000",
    });
    const lease = await store.claim("fixture-process"),
      c = liveEntryCommand(Date.now());
    const execute = vi.fn(
      async (_request: LiveCommand, _lease: typeof lease) => {
        throw new Error("unavailable");
      },
    );
    const coordinator = new LiveSuccessionCoordinator(
      store,
      { execute },
      async () => ({ snapshot: s, pending: true }),
    );
    const input = {
      metadata: c.metadata,
      metadata_at: c.metadata_at,
      close_limit_price_raw: "60000000000",
      lease,
    };
    expect((await coordinator.reconcile(input)).status).toBe("draining");
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      kind: "close",
      cause: "profile_failed",
      snapshot: { position_raw: "10000" },
    });
    expect((await coordinator.reconcile(input)).status).toBe("draining");
    expect((await panel()).promotion?.state).toBe("draining");
    await refresh();
    expect((await advanceJevPromotion(f.poolAdapter, "operator")).status).toBe(
      "waiting",
    );
    expect((await panel()).promotion?.profile_id).toBe("h1");
  });
  it("a flat snapshot with an uncertain signed operation cannot enable a successor; global DD keeps precedence", async () => {
    await activateJevLive(f.poolAdapter, "operator", await body(), "initial");
    const c = liveEntryCommand(Date.now()),
      lease = await store.claim("fixture-process"),
      s = liveSnapshot(Date.now() - 10, { consistent: true });
    const request: LiveCommand = {
      version: c.version,
      kind: "close",
      scope: c.scope,
      operation_id: "pending-close",
      metadata: c.metadata,
      metadata_at: c.metadata_at,
      snapshot: s,
      limit_price_raw: "60000000000",
      cause: "fixture",
    };
    await store.reserve({
      scope: c.scope,
      operation_id: request.operation_id,
      kind: "close",
      request,
      lease,
      action: (cloid) =>
        buildLiveAction(liveIdentity, request, cloid, Date.now()),
    });
    await failActive();
    await refresh();
    expect((await advanceJevPromotion(f.poolAdapter, "operator")).status).toBe(
      "draining",
    );
    expect((await advanceJevPromotion(f.poolAdapter, "operator")).status).toBe(
      "draining",
    );
    await refresh("observe", "237500000");
    expect((await panel()).global_blocked).toBe(true);
    expect((await advanceJevPromotion(f.poolAdapter, "operator")).status).toBe(
      "draining",
    );
    expect((await panel()).promotion?.profile_id).toBe("h1");
  });
  it("SQL rejects out-of-order, reinitialization, a healthy replacement and irreversible journal edits", async () => {
    await refresh();
    await activateJevLive(f.poolAdapter, "operator", await body(), "valid");
    await expect(
      f.pool.query(
        "INSERT INTO jev_live_promotions SELECT account_id,owner_id,sequence+1,'active',profile_id,profile_version,experiment_id,proof,recorded_at,mode FROM jev_live_promotions",
      ),
    ).rejects.toThrow("PROMOTION_GATE");
    await expect(
      f.pool.query("UPDATE jev_live_activations SET actor_id='other'"),
    ).rejects.toThrow();
    await expect(
      f.pool.query("TRUNCATE jev_live_promotions"),
    ).rejects.toThrow();
  });
});
