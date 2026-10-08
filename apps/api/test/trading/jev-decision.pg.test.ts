import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabasePool, SqlExecutor } from "../../src/database.js";
import { createPgFixture } from "../pg-fixture.js";
import { decisionFixture, decisionResponse } from "./jev-decision-fixture.js";
import { buildJevContext } from "../../src/storage/jev-context.js";
import {
  buildJevBatch,
  type JevBatch,
  type JevBatchResult,
} from "../../src/models/jev-decision-contract.js";
import { createJevDecisionAdapter } from "../../src/models/jev-decision.js";
import { loadJevDecisionBackend } from "../../src/models/jev-decision-runtime.js";
import { SecretValue } from "../../src/config.js";
import { deriveJevResult } from "../../src/models/jev-decision-replay.js";
import {
  createJevDecisionStore,
  provisionJevCostPool,
  readJevDecision,
  readJevCosts,
  type JevDecisionReservation,
} from "../../src/storage/jev-decision-store.js";
import {
  registerJevPair,
  readJevAccount,
} from "../../src/storage/jev-store.js";
import {
  storeJevEvidence,
  makeJevEvidence,
  retainJevEvidence,
} from "../../src/storage/jev-evidence.js";
import { jevHash } from "../../src/storage/jev-hash.js";
import { mockTariff } from "./jev-fixture.js";
import { readJevCostsTx } from "../../src/storage/jev-metrics.js";
import type { JevTariff } from "../../src/models/jev-contract.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let fixture: Awaited<ReturnType<typeof createPgFixture>>;
let loseCommit = false;
const pool: Pick<DatabasePool, "transaction"> = {
  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>) {
    const c = await fixture.pool.connect();
    try {
      await c.query("BEGIN");
      const value = await run({
        async query(sql, params) {
          const r = await c.query(sql, params ? [...params] : []);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        },
      });
      await c.query("COMMIT");
      if (loseCommit) {
        loseCommit = false;
        throw new Error("lost acknowledgement");
      }
      return value;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  },
};
let template: JevBatch, tariff: JevTariff;
async function prepare() {
  const f = decisionFixture(Date.now());
  await registerJevPair(pool, 1, f.identity, f.stress, f.manifest);
  const cut = f.input.cut_at;
  for (const [i, input] of [f.input, f.accountInput].entries()) {
    input.cut_at = cut;
    input.account.payload.observed_at = cut;
    input.coverage!.payload.end_at = cut;
    input.coverage!.payload.start_at = new Date(
      Date.parse(cut) - 60000,
    ).toISOString();
    for (const r of [
      input.account,
      input.book!,
      input.mark_funding!,
      input.coverage!,
    ]) {
      r.recorded_at = cut;
      r.received_at = cut;
      if ("source_timestamp" in r.payload) {
        r.payload = { ...r.payload, source_timestamp: cut, received_at: cut };
      }
      r.payload_hash = jevHash(r.payload);
    }
    for (const r of input.bars) {
      r.payload.closed_at = r.payload.end_at;
      r.recorded_at = r.payload.end_at;
      r.received_at = r.payload.end_at;
      r.payload_hash = jevHash(r.payload);
    }
    const depRecords = input.dependencies.map((r) => ({
      ...r,
      recorded_at: input.bars.find((b) =>
        b.payload.input_ids.includes(r.object_id),
      )!.recorded_at,
      received_at: input.bars.find((b) =>
        b.payload.input_ids.includes(r.object_id),
      )!.received_at,
      payload: { synthetic: r.object_id },
      payload_hash: jevHash({ synthetic: r.object_id }),
    }));
    input.dependencies = depRecords;
    const context = buildJevContext(
      f.manifest,
      i === 0 ? f.identity : f.stress,
      input,
    );
    const records = [
      input.account,
      input.book!,
      input.mark_funding!,
      ...input.trades,
      ...input.bars,
      input.coverage!,
      ...depRecords,
    ];
    await storeJevEvidence(pool, [
      makeJevEvidence({
        object_id: `inputs:${i}`,
        scope: context.scope,
        kind: "inputs",
        recorded_at: cut,
        payload: { records },
        dependencies: [],
        sources: [],
      }),
      makeJevEvidence({
        object_id: `context:${i}`,
        scope: context.scope,
        kind: "context",
        recorded_at: cut,
        payload: { context, input_bundle_id: `inputs:${i}` },
        dependencies: [`inputs:${i}`],
        sources: [],
      }),
    ]);
    f.batch.participants[i]!.context = context;
  }
  template = buildJevBatch({
    ...f.batch,
    cut_at: cut,
    deadline_at: new Date(Date.parse(cut) + 1500).toISOString(),
    participants: f.batch.participants,
  });
}
function batch(id = "request:1", purpose: JevBatch["purpose"] = "operation") {
  const {
    schema_version: _s,
    questions_version: _q,
    questions: _qs,
    expires_at: _e,
    ...input
  } = template;
  return buildJevBatch({
    ...input,
    request_id: id,
    purpose,
    proposal_id: purpose === "operation" ? null : "proposal:1",
    deadline_at: new Date(Date.parse(template.cut_at) + 1500).toISOString(),
  });
}
async function provision(
  purpose: JevBatch["purpose"] = "operation",
  origin: "mock" | "real" = "mock",
) {
  await provisionJevCostPool(pool, {
    origin,
    purpose,
    month: new Date().toISOString().slice(0, 7),
    tariff,
    enabled: true,
    provision_reference: "fixture:coverage",
    billing_bound_reference: "fixture:bound",
  });
}
function settle(
  r: JevDecisionReservation,
  body = JSON.stringify(decisionResponse(r.result.batch)),
  status = 200,
): JevBatchResult {
  return deriveJevResult({
    ...r.result,
    reason: status === 429 ? "rate_limited" : "ok",
    http_status: status,
    original_response: body,
    response_received_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  });
}
describe.skipIf(!url)(
  "JE04 decisions and pools on disposable PostgreSQL",
  () => {
    beforeEach(async () => {
      fixture = await createPgFixture(url);
      loseCommit = false;
      tariff = mockTariff();
      await prepare();
    });
    afterEach(async () => {
      await fixture?.dispose();
    });
    it("JE08 conserves the platform journal while charging full operation and linked generation to both alternatives", async () => {
      await provision();
      await provision("generation_validation");
      const store = createJevDecisionStore(pool);
      for (const purpose of ["operation", "generation_validation"] as const) {
        const r = await store.reserve(
          batch(`economics:${purpose}`, purpose),
          "mock",
          tariff,
        );
        if (!("token" in r)) throw new Error(r.reason);
        await store.finish(r, settle(r));
      }
      const end = new Date(Date.now() + 1).toISOString(),
        s = template.participants[0]!.context.scope;
      const a = await pool.transaction((tx) =>
          readJevCostsTx(tx, s, "mock", end),
        ),
        b = await pool.transaction((tx) =>
          readJevCostsTx(
            tx,
            { ...s, account_id: "stress:h1", mode: "stress" },
            "mock",
            end,
          ),
        );
      expect(a.platform.unknown_requests).toBe(0);
      expect(BigInt(a.platform.jev_usd6!)).toBeGreaterThan(0n);
      expect(a.evaluation.jev_usd6).toBe(a.platform.jev_usd6);
      expect(b.evaluation.jev_usd6).toBe(a.evaluation.jev_usd6);
      expect(
        (await pool.transaction((tx) => readJevCostsTx(tx, s, "real", end)))
          .platform.jev_usd6,
      ).toBe("0");
      expect(a.platform.infrastructure_usd6).toBeNull();
    });
    it("JE08 unfinished billing stays unavailable rather than using a reservation as expense", async () => {
      await provision();
      const r = await createJevDecisionStore(pool).reserve(
        batch("unknown:economics"),
        "mock",
        tariff,
      );
      expect("token" in r).toBe(true);
      const c = await pool.transaction((tx) =>
        readJevCostsTx(
          tx,
          template.participants[0]!.context.scope,
          "mock",
          new Date(Date.now() + 1).toISOString(),
        ),
      );
      expect(c.platform.jev_usd6).toBeNull();
      expect(c.evaluation.jev_usd6).toBeNull();
      expect(c.platform.known_jev_usd6).toBe("0");
    });
    it("seeds no budgets, journals disabled absence, replays it and preserves financial ledger", async () => {
      expect(
        (await fixture.pool.query("SELECT count(*)::int n FROM jev_cost_pools"))
          .rows[0].n,
      ).toBe(0);
      const before = await readJevAccount(pool, "operator", "paper:h1");
      let calls = 0;
      const adapter = createJevDecisionAdapter({
        store: createJevDecisionStore(pool),
        transport: {
          origin: "mock",
          model: tariff.model,
          async evaluate() {
            calls++;
            throw Error();
          },
        },
      });
      const r = await adapter.evaluate(batch());
      expect(r.reason).toBe("disabled");
      expect(calls).toBe(0);
      expect(
        await readJevDecision(pool, "operator", "mock", "request:1"),
      ).toEqual(r);
      expect(await readJevAccount(pool, "operator", "paper:h1")).toEqual(
        before,
      );
      await expect(
        readJevDecision(pool, "another", "mock", "request:1"),
      ).rejects.toThrow(/NOT_FOUND/);
    });
    it("serializes concurrent reservations and bounds operation/generation across every participant", async () => {
      tariff.input_usd6_per_million = "20000000";
      tariff.max_billable_input_tokens = 100000;
      await provision();
      await provision("generation_validation");
      const store = createJevDecisionStore(pool);
      const first = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          store.reserve(batch(`parallel:${i}`), "mock", tariff),
        ),
      );
      expect(first.filter((r) => "token" in r)).toHaveLength(3);
      expect(first.flatMap((r) => ("token" in r ? [] : [r.reason]))).toEqual([
        "concurrency_limit",
      ]);
      for (const r of first)
        if ("token" in r)
          await store.finish(r, {
            ...r.result,
            reason: "timeout",
            finished_at: new Date().toISOString(),
          });
      expect(await store.reserve(batch("four"), "mock", tariff)).toHaveProperty(
        "reason",
        "circuit_open",
      );
      const generation = await store.reserve(
        batch("generation", "generation_validation"),
        "mock",
        tariff,
      );
      expect("token" in generation).toBe(true);
      const next = await store.reserve(
        batch("generation:2", "generation_validation"),
        "mock",
        tariff,
      );
      expect(next).toHaveProperty("reason", "budget_exhausted");
      expect(
        (await readJevCosts(pool, "mock", new Date().toISOString().slice(0, 7)))
          .committed_usd6,
      ).toBe("8000000");
    });
    it("bills a partial response once, attributes the full cost to each account, deduplicates and restarts", async () => {
      await provision();
      const store = createJevDecisionStore(pool),
        b = batch();
      const reservation = await store.reserve(b, "mock", tariff);
      expect("token" in reservation).toBe(true);
      if (!("token" in reservation)) throw Error();
      const raw = decisionResponse(b);
      delete raw.answers.a1_intent;
      const original = ` {\n${JSON.stringify(raw).slice(1, -1)}\n} `;
      const r = await store.finish(reservation, settle(reservation, original));
      expect(r.reason).toBe("partial_error");
      expect(r.cost_usd6).toBe("42");
      expect(r.decisions.map((d) => d.reason)).toEqual([
        "ok",
        "malformed_response",
      ]);
      expect(await store.reserve(b, "mock", tariff)).toHaveProperty(
        "reason",
        "duplicate",
      );
      expect(
        await createJevDecisionStore(pool).finish(reservation, {
          ...settle(reservation),
          reason: "provider_error",
        }),
      ).toEqual(r);
      expect(
        (await readJevDecision(pool, "operator", "mock", b.request_id))
          .original_response,
      ).toBe(original);
      const costs = await readJevCosts(
        pool,
        "mock",
        new Date().toISOString().slice(0, 7),
        b.participants[0]!.context.scope,
      );
      expect(costs).toMatchObject({
        requests: 1,
        known_cost_usd6: "42",
        account_attributed_known_usd6: "42",
        unknown_requests: 0,
      });
      expect(
        await store.reserve(
          { ...b, purpose: "generation_validation", proposal_id: "proposal:1" },
          "mock",
          tariff,
        ),
      ).toHaveProperty("reason", "idempotency_conflict");
    });
    it("retains unknown timeout charge after crash and lost COMMIT, never resends", async () => {
      await provision();
      loseCommit = true;
      let calls = 0;
      const adapter = createJevDecisionAdapter({
        enabled: true,
        tariff,
        store: createJevDecisionStore(pool),
        transport: {
          origin: "mock",
          model: tariff.model,
          async evaluate() {
            calls++;
            throw Error();
          },
        },
      });
      expect(await adapter.evaluate(batch())).toHaveProperty(
        "reason",
        "storage_error",
      );
      expect(calls).toBe(0);
      const restarted = createJevDecisionStore(pool);
      expect(await restarted.reserve(batch(), "mock", tariff)).toHaveProperty(
        "reason",
        "duplicate",
      );
      await new Promise((r) => setTimeout(r, 1600));
      const recovery = await restarted.reserve(
        batch("recover"),
        "mock",
        tariff,
      );
      expect(recovery).toHaveProperty("reason", "timeout");
      expect(
        await readJevDecision(pool, "operator", "mock", "request:1"),
      ).toMatchObject({
        reason: "recovered_uncertain",
        cost_usd6: null,
        original_response: null,
      });
      expect(
        (await readJevCosts(pool, "mock", new Date().toISOString().slice(0, 7)))
          .committed_usd6,
      ).toBe("2753");
    });
    it("validates usage separately from malformed JSON/binding, opens circuit on unknown cost and protects provenance", async () => {
      await provision();
      const store = createJevDecisionStore(pool),
        reservation = await store.reserve(batch(), "mock", tariff);
      if (!("token" in reservation)) throw Error();
      const r = await store.finish(
        reservation,
        settle(reservation, " { malformed "),
      );
      expect(r.cost_usd6).toBeNull();
      expect(r.decisions.every((d) => d.action === null)).toBe(true);
      expect(
        await store.reserve(batch("blocked"), "mock", tariff),
      ).toHaveProperty("reason", "circuit_open");
      for (const t of [
        "jev_decision_profile_contracts",
        "jev_decision_requests",
        "jev_decision_results",
        "jev_decision_participants",
      ]) {
        await expect(fixture.pool.query(`DELETE FROM ${t}`)).rejects.toThrow(
          /APPEND_ONLY/,
        );
        await expect(
          fixture.pool.query(`TRUNCATE ${t} CASCADE`),
        ).rejects.toThrow(/APPEND_ONLY/);
      }
      await expect(
        fixture.pool.query("UPDATE jev_cost_pools SET limit_usd6=16000000"),
      ).rejects.toThrow();
      await expect(
        retainJevEvidence(pool, {
          policy_version: "jev-evidence-v1",
          limit: 100,
          execute: true,
        }),
      ).resolves.toBeDefined();
      const tampered = { ...r, original_response: "{}" };
      await expect(
        Promise.resolve().then(() => deriveJevResult(tampered)),
      ).resolves.toBeDefined();
    });
    it("retains a known bill and original after deadline while refusing every action", async () => {
      await provision();
      const store = createJevDecisionStore(pool),
        reservation = await store.reserve(batch(), "mock", tariff);
      if (!("token" in reservation)) throw Error();
      const captured = settle(reservation);
      await new Promise((r) => setTimeout(r, 1600));
      const result = await store.finish(reservation, captured);
      expect(result).toMatchObject({
        reason: "timeout",
        cost_usd6: "42",
        original_response: captured.original_response,
      });
      expect(result.decisions.every((d) => d.action === null)).toBe(true);
      expect(
        await readJevDecision(pool, "operator", "mock", "request:1"),
      ).toEqual(result);
    });
    it("separates real/mock bills, rejects rollover and prevents parallel legacy funding", async () => {
      await provision("operation", "mock");
      await provision("operation", "real");
      const store = createJevDecisionStore(pool),
        b = batch();
      for (const origin of ["mock", "real"] as const) {
        const r = await store.reserve(b, origin, tariff);
        if (!("token" in r)) throw Error();
        await store.finish(r, settle(r));
      }
      expect(
        (await readJevCosts(pool, "real", new Date().toISOString().slice(0, 7)))
          .known_cost_usd6,
      ).toBe("42");
      expect(
        (await readJevCosts(pool, "mock", new Date().toISOString().slice(0, 7)))
          .known_cost_usd6,
      ).toBe("42");
      await expect(
        fixture.pool.query(
          "UPDATE jev_cost_pools SET month='2020-01' WHERE origin='mock'",
        ),
      ).rejects.toThrow(/IMMUTABLE/);
      await expect(
        fixture.pool.query(
          "INSERT INTO btc_jev_budgets(origin,month,enabled,provision_reference,tariff_hash,limit_usd6) VALUES('real',to_char(clock_timestamp(),'YYYY-MM'),true,'fixture',$1,5000000)",
          [`sha256:${jevHash(tariff)}`],
        ),
      ).rejects.toThrow(/PRINCIPAL_POOL_ACTIVE/);
      const old = await store.reserve(
        batch("old", "generation_validation"),
        "mock",
        tariff,
      );
      expect(old).toHaveProperty("reason", "budget_unavailable");
      await expect(
        provisionJevCostPool(pool, {
          origin: "mock",
          purpose: "operation",
          month: new Date().toISOString().slice(0, 7),
          tariff: { ...tariff, input_usd6_per_million: "43000" },
          enabled: true,
          provision_reference: "fixture:coverage",
          billing_bound_reference: "fixture:bound",
        }),
      ).rejects.toThrow(/COLLISION/);
    });
    it("keeps a committed successful result when its acknowledgement is lost", async () => {
      await provision();
      const store = createJevDecisionStore(pool),
        r = await store.reserve(batch(), "mock", tariff);
      if (!("token" in r)) throw Error();
      loseCommit = true;
      await expect(store.finish(r, settle(r))).rejects.toThrow(
        /acknowledgement/,
      );
      const recovered = await readJevDecision(
        pool,
        "operator",
        "mock",
        "request:1",
      );
      expect(recovered.cost_usd6).toBe("42");
      expect(
        await store.finish(r, { ...r.result, reason: "provider_error" }),
      ).toEqual(recovered);
      expect(
        (await readJevCosts(pool, "mock", new Date().toISOString().slice(0, 7)))
          .known_cost_usd6,
      ).toBe("42");
    });
    it("refuses expired months and missing tariff without zeroing uncertain charges", async () => {
      await provisionJevCostPool(pool, {
        origin: "mock",
        purpose: "operation",
        month: "2020-01",
        tariff,
        enabled: true,
        provision_reference: "fixture:coverage",
        billing_bound_reference: "fixture:bound",
      });
      const store = createJevDecisionStore(pool);
      expect(await store.reserve(batch(), "mock", tariff)).toHaveProperty(
        "reason",
        "budget_unavailable",
      );
      expect(
        await store.reserve(batch("no-tariff"), "mock", null),
      ).toMatchObject({
        reason: "cost_unknown",
        attempted: false,
        cost_usd6: "0",
      });
    });
    it("finding a protected credential never admits the principal backend", async () => {
      const backend = await loadJevDecisionBackend(pool, {
        configuration: {
          enabled: true,
          credentialPresent: true,
          key: new SecretValue("synthetic-test-key"),
          tariff,
          provisionReference: "fixture:coverage",
          billingBoundReference: "fixture:bound",
          reasons: [],
        },
      });
      expect(backend.status).toMatchObject({
        enabled: false,
        credential_present: true,
        reasons: ["admission_pending"],
      });
      expect(await backend.evaluate(batch())).toHaveProperty(
        "reason",
        "disabled",
      );
      expect(await backend.read("operator", "request:1")).toHaveProperty(
        "original_response",
        null,
      );
    });
    it("three known-billed transport failures open the circuit without retry or budget reset", async () => {
      await provision();
      const store = createJevDecisionStore(pool);
      for (let i = 0; i < 3; i++) {
        const r = await store.reserve(batch(`rate:${i}`), "mock", tariff);
        if (!("token" in r)) throw Error();
        const result = await store.finish(r, settle(r, undefined, 429));
        expect(result).toMatchObject({
          reason: "rate_limited",
          cost_usd6: "42",
        });
      }
      expect(
        await store.reserve(batch("circuit"), "mock", tariff),
      ).toHaveProperty("reason", "circuit_open");
      expect(
        (await readJevCosts(pool, "mock", new Date().toISOString().slice(0, 7)))
          .known_cost_usd6,
      ).toBe("126");
      await expect(
        fixture.pool.query("UPDATE jev_cost_pools SET circuit_open=false"),
      ).rejects.toThrow(/IMMUTABLE/);
    });
    it("capacity refusal rolls back a hold before transport; unknown account cost remains null", async () => {
      await provision();
      await fixture.pool.query(
        "UPDATE btc_retention_policy SET total_bytes=storage_stop_bytes WHERE dataset_id='btc-paper-v1'",
      );
      await expect(
        createJevDecisionStore(pool).reserve(batch(), "mock", tariff),
      ).rejects.toThrow(/CAPACITY_REFUSED/);
      expect(
        (
          await fixture.pool.query(
            "SELECT count(*)::int n FROM jev_decision_requests",
          )
        ).rows[0].n,
      ).toBe(0);
      await fixture.pool.query(
        "UPDATE btc_retention_policy SET total_bytes=0 WHERE dataset_id='btc-paper-v1'",
      );
      const store = createJevDecisionStore(pool),
        r = await store.reserve(batch(), "mock", tariff);
      if (!("token" in r)) throw Error();
      await store.finish(r, { ...r.result, reason: "provider_error" });
      expect(
        await readJevCosts(
          pool,
          "mock",
          new Date().toISOString().slice(0, 7),
          template.participants[0]!.context.scope,
        ),
      ).toMatchObject({
        cost_usd6: null,
        account_attributed_cost_usd6: null,
        account_unknown_requests: 1,
        committed_usd6: "2753",
      });
    });
    it("pins model/questions to the profile before sending and preserves them across restart", async () => {
      await provision();
      const store = createJevDecisionStore(pool),
        r = await store.reserve(batch(), "mock", tariff);
      if (!("token" in r)) throw Error();
      await store.finish(r, settle(r));
      const changed = buildJevBatch({
        ...batch("new-model"),
        model: "jev-1.13.1",
      });
      const result = await createJevDecisionStore(pool).reserve(
        changed,
        "mock",
        { ...tariff, model: changed.model },
      );
      expect(result).toHaveProperty("reason", "binding_error");
      expect(
        (
          await fixture.pool.query(
            "SELECT model,questions_version FROM jev_decision_profile_contracts",
          )
        ).rows,
      ).toEqual([
        {
          model: "jev-1.13.0",
          questions_version: "jev.principal-questions.v1",
        },
      ]);
      await expect(
        fixture.pool.query(
          "UPDATE jev_decision_profile_contracts SET model='jev-1.13.1'",
        ),
      ).rejects.toThrow(/APPEND_ONLY/);
    });
    it("rejects wrong profile/context ownership and rolls back the entire reservation", async () => {
      await provision();
      const b = batch();
      b.participants[0]!.context_id = "context:1";
      // Duplicate context is rejected before SQL; a missing same-owner context fails inside transaction.
      b.participants[0]!.context_id = "context:missing";
      const rebuild = buildJevBatch(b);
      await expect(
        createJevDecisionStore(pool).reserve(rebuild, "mock", tariff),
      ).rejects.toThrow();
      expect(
        (
          await fixture.pool.query(
            "SELECT count(*)::int n FROM jev_decision_requests",
          )
        ).rows[0].n,
      ).toBe(0);
    });
  },
);
