import { claimExecutionWorker } from "../../src/storage/execution-worker-lease.js";
import { storeRetentionObjectTx } from "../../src/storage/btc-retention.js";
import { market } from "./valuation-fixture.js";
import { scope as retentionScope } from "./risk-fixture.js";
import {
  generateJevProposal,
  closedGenerationSourceTx,
} from "../../src/storage/jev-generator.js";
import {
  deriveProposalResult,
  type ProposalTransport,
} from "../../src/models/jev-proposal.js";
import {
  seedDispatchCapacityTx,
  dispatchCapacity,
} from "./jev-dispatch-fixture.js";
import { mockTariff } from "./jev-fixture.js";
import { provisionJevCostPool } from "../../src/storage/jev-decision-store.js";
import {
  appendJevLedgerBatch,
  readJevAccount,
} from "../../src/storage/jev-store.js";
import { jevCommand, fill, usd, start } from "./jev-v2-fixture.js";
import { jevScope } from "../../src/storage/jev-ledger.js";
import {
  makeJevEvidence,
  storeJevEvidence,
  closeJevEvidence,
} from "../../src/storage/jev-evidence.js";
import {
  readJevQueueTx,
  queueSnapshotTx,
  commandJevQueue,
} from "../../src/storage/jev-queue.js";
import {
  retireFailedJevPairs,
  admitJevSuccessor,
} from "../../src/storage/jev-successions.js";
import { readJevCostsTx } from "../../src/storage/jev-metrics.js";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { registerJevPanelRoutes } from "../../src/jev-panel-api.js";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { createPgFixture } from "../pg-fixture.js";
import type { DatabasePool, SqlExecutor } from "../../src/database.js";
import { registerJevPair } from "../../src/storage/jev-store.js";
import { initialJevManifest } from "../../src/storage/jev-manifest.js";
import { jevHash } from "../../src/storage/jev-hash.js";
import {
  storeJevProposal,
  proposalEventTx,
  type JevProposal,
} from "../../src/storage/jev-proposals.js";
import { withBtcRetentionTransaction } from "../../src/storage/btc-retention.js";
import { jevIdentity } from "./jev-v2-fixture.js";
let fixture: Awaited<ReturnType<typeof createPgFixture>>;
const store: Pick<DatabasePool, "transaction"> = {
  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>) {
    const c = await fixture.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await run({
        async query<R extends Record<string, unknown>>(
          sql: string,
          params?: readonly unknown[],
        ) {
          const r = await c.query<R>(sql, params ? [...params] : undefined);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        },
      });
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  },
};
const proposal = (id = "proposal:1"): JevProposal => {
  const m = initialJevManifest(1);
  return {
    owner_id: "operator",
    proposal_id: id,
    parent_profile_id: "h1",
    parent_profile_version: "v1",
    profile_id: id,
    profile_version: "v2",
    manifest: { ...m, context: { ...m.context, trade_window_seconds: 30 } },
    reason: "Compare janela aprovada de fluxo",
  };
};

function response(choice = "adequate", cost = true) {
  return JSON.stringify({
    model: "jev-1.13.0",
    usage: cost ? { input_tokens: 1000, output_tokens: 10 } : null,
    answers: {
      aptitude: {
        type: "choice",
        choice,
        confidence: 1,
        probabilities: Object.fromEntries(
          ["strong", "adequate", "veto", "abstain"].map((k) => [
            k,
            k === choice ? 1 : 0,
          ]),
        ),
      },
    },
  });
}
async function enable(origin: "mock" | "real" = "mock", tariff = mockTariff()) {
  await provisionJevCostPool(store, {
    origin,
    purpose: "generation_validation",
    month: new Date().toISOString().slice(0, 7),
    tariff,
    provision_reference: "fixture_only",
    billing_bound_reference: "fixture_only",
    enabled: true,
  });
  await withBtcRetentionTransaction(store, async (tx) => {
    const cap = await seedDispatchCapacityTx(tx, Date.now() - 5);
    await tx.query(
      "INSERT INTO jev_generator_controls(owner_id,enabled,admission_reference,capacity_evidence_id) VALUES('operator',true,'fixture_only',$1)",
      [cap],
    );
  });
  return tariff;
}
async function closedSource(closed = true) {
  const now = new Date().toISOString();
  for (const mode of ["paper", "stress"] as const) {
    const i = jevIdentity(mode);
    i.bindings[0]!.profile.manifest_hash = jevHash(initialJevManifest(1));
    await appendJevLedgerBatch(store, "operator", i.account.account_id, {
      transaction_id: `round:${mode}`,
      events: [
        jevCommand(
          i,
          `entry:${mode}`,
          fill(`entry:${mode}`, "buy", "1000"),
          start + 1000,
        ),
        jevCommand(
          i,
          `exit:${mode}`,
          fill(`exit:${mode}`, "sell", "1000"),
          start + 2000,
        ),
      ],
    });
    const l = await readJevAccount(store, "operator", i.account.account_id);
    await fixture.pool.query(
      "INSERT INTO jev_risk_reconciliations(account_id,operation_id,ledger_sequence,observed_at,funding_through_at,request) VALUES($1,'fixture_reconciliation',$2,clock_timestamp(),clock_timestamp(),'{}')",
      [i.account.account_id, l.projection.last_sequence],
    );
    if (closed)
      await closeJevEvidence(
        store,
        "operator",
        i.bindings[0]!.binding.experiment_id,
        now,
        "fixture_only",
      );
  }
  const i = jevIdentity(),
    scope = jevScope(i.bindings[0]!.binding, i.instrument),
    at = new Date().toISOString();
  await storeJevEvidence(store, [
    makeJevEvidence({
      object_id: "failure:fixture",
      scope,
      kind: "result",
      recorded_at: at,
      payload: {
        artifact_id: "failure:fixture",
        original: {
          schema_version: "jev.evaluation.v1",
          state: "failed",
          phase: "initial",
          as_of: at,
          manifest_hash: jevHash(initialJevManifest(1)),
          operational_admission: false,
          accounts: [{ episodes: 1 }, { episodes: 1 }],
        },
      },
      dependencies: [],
      sources: [],
    }),
  ]);
  await fixture.pool.query(
    "INSERT INTO jev_evaluation_cuts(evidence_id,owner_id,profile_id,profile_version,as_of,phase,state) VALUES('failure:fixture','operator','h1','v1',$1,'initial','failed')",
    [at],
  );
}
const transport = (
  choice = "adequate",
  bill = true,
  hook?: () => Promise<void>,
): ProposalTransport => ({
  origin: "mock",
  model: "jev-1.13.0",
  async evaluate() {
    await hook?.();
    return {
      body: response(choice, bill),
      status: 200,
      received_at: new Date().toISOString(),
    };
  },
});
async function approveAndEnqueue(
  p: JevProposal,
  origin: "real" | "mock" = "mock",
) {
  await storeJevProposal(store, p);
  const tariff = mockTariff(),
    body = response(),
    r = deriveProposalResult(
      { body, status: 200, received_at: new Date().toISOString() },
      tariff,
      new Date(Date.now() + 10000).toISOString(),
    );
  await withBtcRetentionTransaction(store, async (tx) => {
    const id = `fixture:${p.proposal_id}`;
    await tx.query(
      "INSERT INTO jev_proposal_requests(origin,request_id,owner_id,proposal_id,pool_month,token,model,tariff,payload,reserved_usd6,deadline_at) VALUES($1,$2,'operator',$3,$4,gen_random_uuid(),$5,$6,$7,3000,clock_timestamp()+interval '10 seconds')",
      [
        origin,
        id,
        p.proposal_id,
        new Date().toISOString().slice(0, 7),
        tariff.model,
        tariff,
        { state: { proposal: p.manifest } },
      ],
    );
    await tx.query(
      "INSERT INTO jev_proposal_results(origin,request_id,cost_usd6,reason,rank,original_response,response_hash,usage,judgment) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        origin,
        id,
        r.cost_usd6,
        r.reason,
        r.rank,
        body,
        createHash("sha256").update(body).digest("hex"),
        r.usage,
        r.judgment,
      ],
    );
    await proposalEventTx(
      tx,
      "operator",
      p.proposal_id,
      `approve:${p.proposal_id}`,
      "approved",
      "fixture_only",
      { request_id: id, origin },
    );
    const q = await readJevQueueTx(tx, "operator");
    await queueSnapshotTx(
      tx,
      "operator",
      `enqueue:${p.proposal_id}`,
      q.revision,
      "enqueue",
      { proposal_id: p.proposal_id },
      [...q.proposal_ids, p.proposal_id],
    );
  });
}
describe.skipIf(!process.env.GANSO_TEST_DATABASE_URL)(
  "JE12 immutable proposals",
  () => {
    beforeEach(async () => {
      fixture = await createPgFixture(process.env.GANSO_TEST_DATABASE_URL);
      const m = initialJevManifest(1),
        p = jevIdentity(),
        s = jevIdentity("stress");
      for (const i of [p, s]) i.bindings[0]!.profile.manifest_hash = jevHash(m);
      await registerJevPair(store, 1, p, s, m);
    });
    afterEach(async () => {
      await fixture?.dispose();
    });
    it("canonicalizes keys, serializes retries and refuses renaming a withdrawn fingerprint", async () => {
      const p = proposal();
      const r = await Promise.all([
        storeJevProposal(store, p),
        storeJevProposal(store, p),
      ]);
      expect(r.map((v) => v.status).sort()).toEqual(["duplicate", "stored"]);
      await withBtcRetentionTransaction(store, (tx) =>
        proposalEventTx(
          tx,
          "operator",
          p.proposal_id,
          "remove:1",
          "withdrawn",
          "operador",
        ),
      );
      await expect(
        storeJevProposal(store, {
          ...p,
          proposal_id: "renamed",
          profile_id: "renamed",
        }),
      ).rejects.toThrow(/FINGERPRINT/);
      expect(
        (await fixture.pool.query("SELECT count(*)::int n FROM jev_proposals"))
          .rows[0].n,
      ).toBe(1);
      expect(
        (await fixture.pool.query("SELECT manifest FROM jev_profiles")).rows[0]
          .manifest,
      ).toEqual(initialJevManifest(1));
    });
    it("rejects no change, two components and arbitrary risk/code in library and SQL", async () => {
      const p = proposal();
      await expect(
        storeJevProposal(store, { ...p, manifest: initialJevManifest(1) }),
      ).rejects.toThrow(/ONE_COMPONENT/);
      await expect(
        storeJevProposal(store, {
          ...p,
          manifest: { ...p.manifest, horizon_minutes: 3 },
        }),
      ).rejects.toThrow(/ONE_COMPONENT/);
      const bad = {
        ...p.manifest,
        risk: { ...p.manifest.risk, entry_risk_bps: 200 },
      };
      await expect(
        storeJevProposal(store, { ...p, manifest: bad as never }),
      ).rejects.toThrow(/FROZEN/);
      await expect(
        fixture.pool.query(
          "INSERT INTO jev_proposals(owner_id,proposal_id,fingerprint,parent_profile_id,parent_profile_version,profile_id,profile_version,manifest,reason) VALUES('operator','bad',$1,'h1','v1','bad','v1',$2,'bad')",
          [jevHash(bad), bad],
        ),
      ).rejects.toThrow(/ONE_COMPONENT/);
    });
    it("rejects forged hash, history changes and terminal revival", async () => {
      const p = proposal();
      await storeJevProposal(store, p);
      await expect(
        fixture.pool.query("UPDATE jev_proposals SET reason='changed'"),
      ).rejects.toThrow(/APPEND_ONLY/);
      await expect(
        fixture.pool.query("TRUNCATE jev_proposal_events"),
      ).rejects.toThrow(/APPEND_ONLY/);
      await withBtcRetentionTransaction(store, (tx) =>
        proposalEventTx(
          tx,
          "operator",
          p.proposal_id,
          "reject:1",
          "rejected",
          "reprovada",
        ),
      );
      await expect(
        withBtcRetentionTransaction(store, (tx) =>
          proposalEventTx(
            tx,
            "operator",
            p.proposal_id,
            "approve:1",
            "unavailable",
            "aptidão",
          ),
        ),
      ).rejects.toThrow(/TERMINAL/);
      await expect(
        fixture.pool.query(
          "UPDATE jev_profiles SET manifest=manifest||'{\"risk\":{}}'::jsonb",
        ),
      ).rejects.toThrow(/APPEND_ONLY/);
    });

    it("requires explicit activation, closed ledger episodes, credit and unique request on competing generators", async () => {
      const t = await enable();
      expect(
        await generateJevProposal(store, "operator", t, transport(), {
          enabled: false,
        }),
      ).toEqual({ status: "disabled" });
      expect(
        await generateJevProposal(store, "operator", t, transport(), {
          enabled: true,
        }),
      ).toEqual({ status: "waiting" });
      await closedSource();
      expect(
        await store.transaction((tx) =>
          closedGenerationSourceTx(tx, "operator"),
        ),
      ).not.toBeNull();
      let calls = 0;
      const wire = transport("adequate", true, async () => {
        calls++;
      });
      const r = await Promise.all([
        generateJevProposal(store, "operator", t, wire, { enabled: true }),
        generateJevProposal(store, "operator", t, wire, { enabled: true }),
      ]);
      expect(r.some((x) => x.status === "approved")).toBe(true);
      expect(calls).toBeLessThanOrEqual(2);
      expect(
        (
          await fixture.pool.query(
            "SELECT count(*)::int n FROM jev_proposal_requests",
          )
        ).rows[0].n,
      ).toBe(calls);
      const q = await store.transaction((tx) => readJevQueueTx(tx, "operator"));
      expect(q.proposals.length).toBe(calls);
      expect(q.proposals.every((p) => p.cost_usd6 === "42")).toBe(true);
      const i = jevIdentity();
      const costs = await store.transaction((tx) =>
        readJevCostsTx(
          tx,
          jevScope(i.bindings[0]!.binding, i.instrument),
          "mock",
          new Date().toISOString(),
        ),
      );
      expect(costs.platform.known_jev_usd6).toBe(String(calls * 42));
    });
    it.each(["veto", "abstain"])(
      "keeps %s out of the queue",
      async (choice) => {
        const t = await enable();
        await closedSource();
        const r = await generateJevProposal(
          store,
          "operator",
          t,
          transport(choice),
          {
            enabled: true,
          },
        );
        expect(r.status).toBe("vetoed");
        expect(
          (await store.transaction((tx) => readJevQueueTx(tx, "operator")))
            .proposal_ids,
        ).toEqual([]);
      },
    );
    it("unknown consumption opens circuit and a restart never sends another request", async () => {
      const t = await enable();
      await closedSource();
      let calls = 0;
      const wire = transport("adequate", false, async () => {
        calls++;
      });
      expect(
        (
          await generateJevProposal(store, "operator", t, wire, {
            enabled: true,
          })
        ).status,
      ).toBe("unavailable");
      expect(
        (
          await generateJevProposal(store, "operator", t, wire, {
            enabled: true,
          })
        ).status,
      ).toBe("waiting");
      expect(calls).toBe(1);
      expect(
        (await fixture.pool.query("SELECT circuit_open FROM jev_cost_pools"))
          .rows[0].circuit_open,
      ).toBe(true);
      expect(
        (await fixture.pool.query("SELECT cost_usd6 FROM jev_proposal_results"))
          .rows[0].cost_usd6,
      ).toBeNull();
    });
    it("persists billed veto and retries cannot erase its fingerprint", async () => {
      const t = await enable();
      await closedSource();
      await generateJevProposal(store, "operator", t, transport("veto"), {
        enabled: true,
      });
      const p = (
        await fixture.pool.query(
          "SELECT owner_id,proposal_id,parent_profile_id,parent_profile_version,profile_id,profile_version,manifest,reason FROM jev_proposals",
        )
      ).rows[0];
      await expect(
        storeJevProposal(store, {
          ...p,
          proposal_id: "renamed",
          profile_id: "renamed",
        } as JevProposal),
      ).rejects.toThrow(/FINGERPRINT/);
      expect(
        (
          await fixture.pool.query(
            "SELECT jev_generation_consumed('mock',$1)::text used",
            [new Date().toISOString().slice(0, 7)],
          )
        ).rows[0].used,
      ).toBe("42");
    });
    it("budget bound is checked before network and shared journal remains counted", async () => {
      const t = mockTariff();
      t.input_usd6_per_million = "40000000";
      await enable("mock", t);
      await closedSource();
      let calls = 0;
      expect(
        (
          await generateJevProposal(
            store,
            "operator",
            t,
            transport("adequate", true, async () => {
              calls++;
            }),
            { enabled: true },
          )
        ).status,
      ).toBe("waiting");
      expect(calls).toBe(0);
    });
    it("recovers a persisted expired attempt without resending or converting uncertainty to zero", async () => {
      const t = await enable();
      await closedSource();
      await storeJevProposal(store, proposal());
      await fixture.pool.query(
        "INSERT INTO jev_proposal_requests(origin,request_id,owner_id,proposal_id,pool_month,token,model,tariff,payload,reserved_usd6,started_at,deadline_at) VALUES('mock','crashed','operator','proposal:1',$1,gen_random_uuid(),$2,$3,$4,3000,clock_timestamp()-interval '2 seconds',clock_timestamp()-interval '1 second')",
        [
          new Date().toISOString().slice(0, 7),
          t.model,
          t,
          { state: { proposal: proposal().manifest } },
        ],
      );
      let calls = 0;
      expect(
        (
          await generateJevProposal(
            store,
            "operator",
            t,
            transport("adequate", true, async () => {
              calls++;
            }),
            { enabled: true },
          )
        ).status,
      ).toBe("waiting");
      expect(calls).toBe(0);
      expect(
        (
          await fixture.pool.query(
            "SELECT reason,cost_usd6 FROM jev_proposal_results",
          )
        ).rows,
      ).toEqual([{ reason: "recovered_uncertain", cost_usd6: null }]);
      expect(
        (
          await fixture.pool.query(
            "SELECT jev_generation_consumed('mock',$1)::text used",
            [new Date().toISOString().slice(0, 7)],
          )
        ).rows[0].used,
      ).toBe("3000");
    });
    it("lost vacancy during validation cannot enqueue, and its actual bill survives", async () => {
      const t = await enable();
      await closedSource();
      const wire = transport("adequate", true, async () => {
        await fixture.pool.query(
          "UPDATE jev_generator_controls SET enabled=false",
        );
      });
      expect(
        (
          await generateJevProposal(store, "operator", t, wire, {
            enabled: true,
          })
        ).status,
      ).toBe("approved");
      expect(
        (await store.transaction((tx) => readJevQueueTx(tx, "operator")))
          .proposal_ids,
      ).toEqual([]);
      expect(
        (
          await fixture.pool.query(
            "SELECT cost_usd6::text FROM jev_proposal_results",
          )
        ).rows[0].cost_usd6,
      ).toBe("42");
    });
    it("reuses an approved result after its gate returns, without another provider call", async () => {
      const t = await enable();
      await closedSource();
      let calls = 0;
      const wire = transport("adequate", true, async () => {
        calls++;
        await fixture.pool.query(
          "UPDATE jev_generator_controls SET enabled=false",
        );
      });
      await generateJevProposal(store, "operator", t, wire, { enabled: true });
      await fixture.pool.query(
        "UPDATE jev_generator_controls SET enabled=true",
      );
      await generateJevProposal(store, "operator", t, wire, { enabled: true });
      expect(calls).toBe(1);
      expect(
        (await store.transaction((tx) => readJevQueueTx(tx, "operator")))
          .proposal_ids,
      ).toHaveLength(1);
    });
    it("allows three queued proposals, preserves operator priority and rejects stale edits and reinsertion", async () => {
      await enable();
      const a = proposal("a"),
        b = proposal("b"),
        c = proposal("c"),
        m = initialJevManifest(1);
      b.manifest = {
        ...m,
        context: { ...m.context, trade_window_seconds: 120 },
      };
      c.manifest = {
        ...m,
        context: {
          ...m.context,
          information_set: m.generator.information_sets[1],
        },
      };
      await approveAndEnqueue(a);
      await approveAndEnqueue(b);
      await approveAndEnqueue(c);
      const q = await store.transaction((tx) => readJevQueueTx(tx, "operator"));
      expect(q.proposal_ids).toEqual(["a", "b", "c"]);
      const fourth = proposal("d");
      fourth.manifest = { ...m, horizon_minutes: 3 };
      await expect(approveAndEnqueue(fourth)).rejects.toThrow();
      expect(
        (await store.transaction((tx) => readJevQueueTx(tx, "operator")))
          .proposal_ids,
      ).toEqual(["a", "b", "c"]);
      const command = {
        action: "reorder",
        revision: q.revision,
        proposal_ids: ["c", "a", "b"],
      };
      const r = await Promise.all([
        commandJevQueue(store, "operator", command, "reorder"),
        commandJevQueue(store, "operator", command, "reorder"),
      ]);
      expect(r.map((v) => v.status).sort()).toEqual(["accepted", "duplicate"]);
      await expect(
        commandJevQueue(
          store,
          "operator",
          { action: "remove", revision: q.revision, proposal_id: "a" },
          "stale",
        ),
      ).rejects.toThrow(/CHANGED/);
      const next = await store.transaction((tx) =>
        readJevQueueTx(tx, "operator"),
      );
      await commandJevQueue(
        store,
        "operator",
        { action: "remove", revision: next.revision, proposal_id: "a" },
        "remove",
      );
      expect(
        (await store.transaction((tx) => readJevQueueTx(tx, "operator")))
          .proposal_ids,
      ).toEqual(["c", "b"]);
      await expect(
        storeJevProposal(store, {
          ...a,
          proposal_id: "a:again",
          profile_id: "a:again",
        }),
      ).rejects.toThrow(/FINGERPRINT/);
      await expect(
        commandJevQueue(
          store,
          "someone",
          { action: "reorder", revision: "0", proposal_ids: ["c"] },
          "steal",
        ),
      ).rejects.toThrow(/CHANGED/);
    });
    it("does not free a failed pair before reconciliation, keeps permanent losses and refuses mock admission", async () => {
      await closedSource(false);
      await fixture.pool.query(
        "INSERT INTO jev_worker_controls(account_id,admitted,entries_paused,admission_reference) SELECT account_id,true,false,'fixture_only' FROM jev_accounts",
      );
      // A post-reconciliation ledger fee invalidates the exact sequence; no reset is possible.
      const i = jevIdentity();
      await appendJevLedgerBatch(store, "operator", i.account.account_id, {
        transaction_id: "late-fee",
        events: [
          jevCommand(
            i,
            "late-fee",
            {
              event_type: "fee",
              execution_id: "exit:paper",
              delta: usd("-1000"),
            },
            start + 2000,
          ),
        ],
      });
      expect(
        (await retireFailedJevPairs(store, "operator")).retired_slots,
      ).toEqual([]);
      const l = await readJevAccount(store, "operator", i.account.account_id);
      await fixture.pool.query(
        "INSERT INTO jev_risk_reconciliations(account_id,operation_id,ledger_sequence,observed_at,funding_through_at,request) VALUES($1,'final',$2,clock_timestamp(),clock_timestamp(),'{}')",
        [i.account.account_id, l.projection.last_sequence],
      );
      expect(
        (await retireFailedJevPairs(store, "operator")).retired_slots,
      ).toEqual([1]);
      expect(
        (await retireFailedJevPairs(store, "operator")).retired_slots,
      ).toEqual([]);
      expect(
        (await fixture.pool.query("SELECT * FROM jev_active_pairs")).rows,
      ).toEqual([]);
      expect(
        (await readJevAccount(store, "operator", i.account.account_id))
          .projection.cash_usd_raw,
      ).toBe("249999000");
      await enable();
      await approveAndEnqueue(proposal());
      expect(
        (await admitJevSuccessor(store, "operator", "jev-1.13.0")).status,
      ).toBe("validation_unavailable");
    });
    it("keeps a partially closed failed account protected until its remaining inventory is reconciled", async () => {
      await closedSource(false);
      await fixture.pool.query(
        "INSERT INTO jev_worker_controls(account_id,admitted,entries_paused,admission_reference) SELECT account_id,true,false,'fixture_only' FROM jev_accounts",
      );
      const i = jevIdentity();
      i.bindings[0]!.profile.manifest_hash = jevHash(initialJevManifest(1));
      await appendJevLedgerBatch(store, "operator", i.account.account_id, {
        transaction_id: "partial",
        events: [
          jevCommand(
            i,
            "partial-entry",
            fill("partial-entry", "buy", "1000"),
            start + 3000,
          ),
          jevCommand(
            i,
            "partial-exit",
            fill("partial-exit", "sell", "750"),
            start + 4000,
          ),
        ],
      });
      const l = await readJevAccount(store, "operator", i.account.account_id);
      await fixture.pool.query(
        "INSERT INTO jev_risk_reconciliations(account_id,operation_id,ledger_sequence,observed_at,funding_through_at,request) VALUES($1,'partial',$2,clock_timestamp(),clock_timestamp(),'{}')",
        [i.account.account_id, l.projection.last_sequence],
      );
      expect(
        (await retireFailedJevPairs(store, "operator")).retired_slots,
      ).toEqual([]);
      expect(
        (
          await fixture.pool.query(
            "SELECT admitted,entries_paused,operator_close_requested FROM jev_worker_controls WHERE account_id=$1",
            [i.account.account_id],
          )
        ).rows[0],
      ).toEqual({
        admitted: true,
        entries_paused: true,
        operator_close_requested: true,
      });
      expect(
        (await fixture.pool.query("SELECT slot FROM jev_active_pairs")).rows,
      ).toEqual([{ slot: 1 }]);
    });
    it("atomically admits only the current operator priority with a fresh prospective capacity proof, preserving the old ledger", async () => {
      await closedSource(false);
      await fixture.pool.query(
        "INSERT INTO jev_worker_controls(account_id,admitted,entries_paused,admission_reference,funding_debit_rate9_raw,cost_evidence_id) SELECT account_id,true,false,'fixture_only',0,'fixture:capacity:usage' FROM jev_accounts",
      );
      await retireFailedJevPairs(store, "operator");
      expect(
        (await admitJevSuccessor(store, "operator", "jev-1.13.0")).status,
      ).toBe("waiting");
      await enable("real");
      const a = proposal("first"),
        b = proposal("priority"),
        m = initialJevManifest(1);
      b.manifest = {
        ...m,
        context: { ...m.context, trade_window_seconds: 120 },
      };
      await approveAndEnqueue(a, "real");
      await approveAndEnqueue(b, "real");
      const q = await store.transaction((tx) => readJevQueueTx(tx, "operator"));
      await commandJevQueue(
        store,
        "operator",
        {
          action: "reorder",
          revision: q.revision,
          proposal_ids: [b.proposal_id, a.proposal_id],
        },
        "priority",
      );
      expect(
        (await admitJevSuccessor(store, "operator", "jev-1.13.0")).status,
      ).toBe("capacity_pending");
      const hash = jevHash(b.manifest),
        pair = {
          slot: 1,
          owner_id: "operator",
          profile_id: b.profile_id,
          profile_version: b.profile_version,
          paper_account_id: `paper:${hash}`,
          stress_account_id: `stress:${hash}`,
          paper_experiment_id: `experiment:paper:${hash}`,
          stress_experiment_id: `experiment:stress:${hash}`,
        };
      const at = Date.now() - 10;
      await withBtcRetentionTransaction(store, async (tx) => {
        const proof = dispatchCapacity(jevHash([pair]), at);
        await storeRetentionObjectTx(tx, {
          id: "fixture:successor-capacity",
          class: "raw",
          identity: retentionScope,
          recordedAt: new Date(at),
          payload: proof,
          dependencies: [
            proof.sustained_resources_reference,
            proof.reconciled_usage_reference,
            proof.protected_evidence_reference,
          ],
        });
        await tx.query(
          "UPDATE jev_generator_controls SET successor_capacity_evidence_id='fixture:successor-capacity'",
        );
      });
      expect(
        (await admitJevSuccessor(store, "operator", "jev-1.13.0")).status,
      ).toBe("readiness_pending");
      const lease = await claimExecutionWorker(store, "a".repeat(40));
      await fixture.pool.query(
        "INSERT INTO jev_worker_observation(singleton,generation,observed_at,payload) VALUES(true,$1,clock_timestamp(),$2)",
        [lease.generation, { backend_ready: true }],
      );
      await withBtcRetentionTransaction(store, async (tx) => {
        const captureAt = Date.now() - 1,
          m = market(captureAt);
        const capture = {
          ...m.capture!,
          history_truncated: false,
          health: {
            ...m.capture!.health,
            channels: {
              ...m.capture!.health.channels,
              trades: m.capture!.health.channels.book,
            },
          },
        };
        for (const [kind, payload] of [
          ["book", m.book!.payload],
          ["context", m.context!.payload],
          ["capture", capture],
        ] as const) {
          const id = `fixture:successor:${kind}`;
          await storeRetentionObjectTx(tx, {
            id,
            class: "raw",
            identity: retentionScope,
            recordedAt: new Date(captureAt),
            payload,
            dependencies: [],
          });
          await tx.query(
            "INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES($1,$2,$3,$3)",
            [id, kind, new Date(captureAt).toISOString()],
          );
        }
      });
      const failing: Pick<DatabasePool, "transaction"> = {
        transaction: (run) =>
          store.transaction((tx) =>
            run({
              async query(sql, params) {
                if (sql.startsWith("INSERT INTO jev_pair_epochs"))
                  throw new Error("fixture handoff crash");
                return tx.query(sql, params);
              },
            }),
          ),
      };
      await expect(
        admitJevSuccessor(failing, "operator", "jev-1.13.0"),
      ).rejects.toThrow("fixture handoff crash");
      expect(
        (await fixture.pool.query("SELECT count(*)::int n FROM jev_accounts"))
          .rows[0].n,
      ).toBe(2);
      expect(
        (await store.transaction((tx) => readJevQueueTx(tx, "operator")))
          .proposal_ids,
      ).toEqual([b.proposal_id, a.proposal_id]);
      const before = (await readJevAccount(store, "operator", "paper:h1"))
        .events;
      const results = await Promise.all([
        admitJevSuccessor(store, "operator", "jev-1.13.0"),
        admitJevSuccessor(store, "operator", "jev-1.13.0"),
      ]);
      expect(results.filter((r) => r.status === "admitted")).toHaveLength(1);
      expect(
        (await store.transaction((tx) => readJevQueueTx(tx, "operator")))
          .proposal_ids,
      ).toEqual([a.proposal_id]);
      expect(
        (await readJevAccount(store, "operator", "paper:h1")).events,
      ).toEqual(before);
      expect(
        (await readJevAccount(store, "operator", pair.paper_account_id))
          .projection,
      ).toMatchObject({ cash_usd_raw: "250000000", last_sequence: "1" });
      expect(
        (await fixture.pool.query("SELECT profile_id FROM jev_active_pairs"))
          .rows,
      ).toEqual([{ profile_id: b.profile_id }]);
      expect(
        (
          await fixture.pool.query(
            "SELECT count(*)::int n FROM jev_accounts WHERE mode='live'",
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it("a completing generator appends after concurrent operator reordering without restoring a removed fingerprint", async () => {
      const t = await enable();
      await closedSource();
      const a = proposal("a"),
        b = proposal("b"),
        m = initialJevManifest(1);
      b.manifest = {
        ...m,
        context: { ...m.context, trade_window_seconds: 120 },
      };
      await approveAndEnqueue(a);
      await approveAndEnqueue(b);
      const wire = transport("adequate", true, async () => {
        const q = await store.transaction((tx) =>
          readJevQueueTx(tx, "operator"),
        );
        await commandJevQueue(
          store,
          "operator",
          { action: "reorder", revision: q.revision, proposal_ids: ["b", "a"] },
          "concurrent-reorder",
        );
      });
      await generateJevProposal(store, "operator", t, wire, { enabled: true });
      const q = await store.transaction((tx) => readJevQueueTx(tx, "operator"));
      expect(q.proposal_ids.slice(0, 2)).toEqual(["b", "a"]);
      expect(q.proposal_ids).toHaveLength(3);
      await commandJevQueue(
        store,
        "operator",
        { action: "remove", revision: q.revision, proposal_id: "a" },
        "concurrent-remove",
      );
      await generateJevProposal(store, "operator", t, transport(), {
        enabled: true,
      });
      expect(
        (await store.transaction((tx) => readJevQueueTx(tx, "operator")))
          .proposal_ids,
      ).not.toContain("a");
    });
    it("API protects queue edits with auth, origin, CSRF and exact ownership", async () => {
      const app = Fastify();
      registerJevPanelRoutes(app, {
        pool: { ...store, readOnly: (_ms, run) => store.transaction(run) },
        authService: {
          session: async () => ({ status: "ok", username: "operator" }),
        } as never,
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/trading/jev/queue",
            payload: {},
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/trading/jev/queue",
            headers: {
              authorization: "Bearer fixture",
              origin: "https://foreign.example",
            },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      const csrf = "a".repeat(64),
        headers = {
          authorization: "Bearer fixture",
          host: "localhost",
          origin: "http://localhost",
          "x-csrf-token": csrf,
          cookie: `ganso_csrf=${csrf}`,
          "idempotency-key": "queue-http",
        };
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/trading/jev/queue",
            headers: { authorization: "Bearer fixture" },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/trading/jev/queue?owner=foreign",
            headers,
            payload: { action: "reorder", revision: "0", proposal_ids: [] },
          })
        ).statusCode,
      ).toBe(400);
      const accepted = await app.inject({
        method: "POST",
        url: "/trading/jev/queue",
        headers,
        payload: { action: "reorder", revision: "0", proposal_ids: [] },
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.headers["cache-control"]).toBe("no-store");
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/trading/jev/queue",
            headers,
            payload: { action: "reorder", revision: "0", proposal_ids: [] },
          })
        ).json().status,
      ).toBe("duplicate");
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/trading/jev/queue",
            headers,
            payload: {
              action: "reorder",
              revision: "0",
              proposal_ids: [],
              owner_id: "foreign",
            },
          })
        ).statusCode,
      ).toBe(400);
      await app.close();
    });
  },
);
