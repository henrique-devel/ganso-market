import { afterEach, beforeEach, describe, it, expect } from "vitest";
import Fastify from "fastify";
import { riskFixture } from "./risk-fixture.js";
import { jevIdentity, jevCommand, fill, usd, iso } from "./jev-v2-fixture.js";
import {
  registerJevPair,
  appendJevLedgerBatch,
  readJevAccount,
} from "../../src/storage/jev-store.js";
import { initialJevManifest } from "../../src/storage/jev-manifest.js";
import { jevHash } from "../../src/storage/jev-hash.js";
import { jevScope } from "../../src/storage/jev-ledger.js";
import {
  captureJevCoverage,
  readJevCoverageTx,
  captureJevEvaluation,
  readJevEvaluation,
  runJevContinuousEvaluation,
} from "../../src/storage/jev-evaluationstore.js";
import {
  storeRetentionObjectTx,
  withBtcRetentionTransaction,
} from "../../src/storage/btc-retention.js";
import { observeJevRisk } from "../../src/storage/jev-riskstore.js";
import { registerExperimentRoutes } from "../../src/experiments-api.js";
const url = process.env.GANSO_TEST_DATABASE_URL,
  day = 86400000;
let f: Awaited<ReturnType<typeof riskFixture>>;
const end = Math.floor(Date.now() / day) * day - day,
  begun = end - 2 * day;
const manifest = initialJevManifest(1),
  paper = jevIdentity(),
  stress = jevIdentity("stress");
for (const i of [paper, stress]) {
  i.account.started_at = iso(begun);
  i.bindings[0]!.binding.started_at = iso(begun);
  i.bindings[0]!.profile.manifest_hash = jevHash(manifest);
}
const s = jevScope(paper.bindings[0]!.binding, paper.instrument);
const readPool = {
  readOnly: async <T>(
    _ms: number,
    run: Parameters<typeof f.poolAdapter.transaction<T>>[0],
  ) =>
    f.poolAdapter.transaction(async (tx) => {
      await tx.query("SET TRANSACTION READ ONLY");
      return run(tx);
    }),
};
async function captures(minute: number, offset = 0) {
  await withBtcRetentionTransaction(f.poolAdapter, async (tx) => {
    for (let n = offset ? 0 : 1; n <= 60; n++) {
      const at = minute - 60000 + n * 1000 + offset,
        from = at - 1000,
        id = `evaluation-capture:${at}`;
      const payload = {
        id,
        from,
        at,
        session: "evaluation",
        health: {
          socket: { connected: true, alive: true },
          channels: Object.fromEntries(
            ["book", "context", "trades"].map((k) => [
              k,
              {
                status: "healthy",
                needs_revalidation: false,
                last_source_at: from,
                last_received_at: from,
                source_quality: "fresh",
              },
            ]),
          ),
          gaps: [],
        },
      };
      await storeRetentionObjectTx(tx, {
        id,
        class: "log",
        identity: {
          mode: "paper",
          instrument_id: s.instrument_id,
          instrument_version: s.instrument_version,
        },
        recordedAt: new Date(at),
        payload,
        dependencies: [],
      });
      await tx.query(
        "INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES($1,'capture',$2,$2)",
        [id, iso(at)],
      );
    }
  });
}
describe.skipIf(!url)(
  "JE09 append-only duration proof and daily profile state on PostgreSQL",
  () => {
    beforeEach(async () => {
      f = await riskFixture(url);
      f.setClock(iso(begun));
      await registerJevPair(f.poolAdapter, 1, paper, stress, manifest);
      f.setClock(iso(end + 62000));
    });
    afterEach(async () => {
      await f?.dispose();
    });
    it("seeds no qualification/evaluation/admission and the worker writes nothing when not admitted", async () => {
      const before = await readJevAccount(
        f.poolAdapter,
        "operator",
        s.account_id,
      );
      expect(await runJevContinuousEvaluation(f.poolAdapter)).toEqual({
        admitted_accounts: 0,
      });
      for (const table of [
        "jev_coverage_segments",
        "jev_engine_qualifications",
        "jev_evaluation_cuts",
      ]) {
        expect(
          (await f.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]
            .n,
        ).toBe(0);
      }
      expect(
        await readJevAccount(f.poolAdapter, "operator", s.account_id),
      ).toEqual(before);
    });
    it("stores original clocks, serializes duplicate segments, clips boundaries and never repairs downtime", async () => {
      await captures(end + 60000);
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          captureJevCoverage(f.poolAdapter, "operator", s.account_id),
        ),
      );
      expect(results.filter((r) => r.status === "captured")).toHaveLength(1);
      const q = await readPool.readOnly(1500, (tx) =>
        readJevCoverageTx(tx, s.account_id, {
          start_at: iso(end),
          end_at: iso(end + 60000),
        }),
      );
      expect(q).toMatchObject({
        denominator_ms: 60000,
        covered_ms: 60000,
        coverage_ppm: 1000000,
      });
      const clipped = await readPool.readOnly(1500, (tx) =>
        readJevCoverageTx(tx, s.account_id, {
          start_at: iso(end + 100),
          end_at: iso(end + 59900),
        }),
      );
      expect(clipped.covered_ms).toBe(59800);
      const evidence = (
        await f.pool.query(
          "SELECT envelope FROM jev_evidence_objects WHERE object_id=$1",
          [results.find((r) => r.status === "captured")!.evidence_id],
        )
      ).rows[0].envelope;
      expect(
        evidence.payload.records[0].payload.health.channels.book.last_source_at,
      ).toBe(end);
      f.setClock(iso(end + 182000));
      await captures(end + 180000);
      await captureJevCoverage(f.poolAdapter, "operator", s.account_id);
      const restarted = await readPool.readOnly(1500, (tx) =>
        readJevCoverageTx(tx, s.account_id, {
          start_at: iso(end),
          end_at: iso(end + 180000),
        }),
      );
      expect(restarted).toMatchObject({
        covered_ms: 120000,
        missing_ms: 60000,
      });
      for (const sql of [
        "UPDATE jev_coverage_segments SET covered_ms=0",
        "DELETE FROM jev_coverage_segments",
        "TRUNCATE jev_coverage_segments",
      ]) {
        await expect(f.pool.query(sql)).rejects.toThrow(/APPEND_ONLY/);
      }
      await expect(
        captureJevCoverage(f.poolAdapter, "other", s.account_id),
      ).rejects.toThrow(/NOT_FOUND/);
    });
    it("waits for bounded post-cut proof, keeps original clocks and covers an offset collector at the minute edge", async () => {
      await captures(end + 60000, 100);
      f.setClock(iso(end + 61999));
      const early = await captureJevCoverage(
        f.poolAdapter,
        "operator",
        s.account_id,
      );
      expect(early).toMatchObject({
        status: "captured",
        quality: { window: { end_at: iso(end) } },
      });
      f.setClock(iso(end + 62000));
      const settled = await captureJevCoverage(
        f.poolAdapter,
        "operator",
        s.account_id,
      );
      expect(settled).toMatchObject({
        status: "captured",
        quality: {
          window: { start_at: iso(end), end_at: iso(end + 60000) },
          knowledge_at: iso(end + 62000),
          covered_ms: 60000,
          coverage_ppm: 1000000,
        },
      });
      const envelope = (
        await f.pool.query(
          "SELECT envelope FROM jev_evidence_objects WHERE object_id=$1",
          [settled.status === "captured" ? settled.evidence_id : "missing"],
        )
      ).rows[0].envelope;
      expect(envelope.payload.records.at(-1)).toMatchObject({
        recorded_at: iso(end + 60100),
        received_at: iso(end + 60100),
        payload: { at: end + 60100, from: end + 59100 },
      });
      expect(
        await captureJevCoverage(f.poolAdapter, "operator", s.account_id),
      ).toEqual({ status: "already_captured" });
      expect(
        (
          await f.pool.query(
            "SELECT max(received_at) AS at FROM btc_market_records WHERE kind='capture'",
          )
        ).rows[0].at.toISOString(),
      ).toBe(iso(end + 60100));
    });
    it("persists a daily versioned inconclusion without qualification, and GET is owned, immutable and read-only", async () => {
      f.setClock(iso(end + 59999));
      expect(
        await captureJevEvaluation(f.poolAdapter, "operator", "h1", "v1"),
      ).toBeNull();
      expect(
        (await f.pool.query("SELECT count(*)::int n FROM jev_evaluation_cuts"))
          .rows[0].n,
      ).toBe(0);
      f.setClock(iso(end + 60000));
      const result = await captureJevEvaluation(
        f.poolAdapter,
        "operator",
        "h1",
        "v1",
      );
      expect(result).toMatchObject({
        state: "validating",
        engine_qualified: false,
        operational_admission: false,
        window: { start_at: iso(begun), end_at: iso(end) },
      });
      expect(result!.accounts[0]!.reasons).toContain("insufficient_episodes");
      f.setClock(iso(end + 120000));
      expect(
        await captureJevEvaluation(f.poolAdapter, "operator", "h1", "v1"),
      ).toEqual(result);
      const app = Fastify();
      registerExperimentRoutes(app, {
        pool: readPool,
        clock: () => new Date(end),
        authService: {
          session: async (token) => ({ status: "ok", username: token }),
        },
      });
      const route = "/trading/jev/evaluations?profile_id=h1&profile_version=v1";
      expect((await app.inject({ url: route })).statusCode).toBe(401);
      const read = await app.inject({
        url: route,
        headers: { authorization: "Bearer operator" },
      });
      expect(read.statusCode).toBe(200);
      expect(read.headers["cache-control"]).toBe("no-store");
      expect(
        (
          await app.inject({
            url: route,
            headers: { authorization: "Bearer other" },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            url: route + "&tune=true",
            headers: { authorization: "Bearer operator" },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ url: route, method: "POST" })).statusCode,
      ).toBe(404);
      await app.close();
      expect(
        (await f.pool.query("SELECT count(*)::int n FROM jev_evaluation_cuts"))
          .rows[0].n,
      ).toBe(1);
      for (const table of [
        "jev_evaluation_cuts",
        "jev_engine_qualifications",
      ]) {
        await expect(f.pool.query(`TRUNCATE ${table}`)).rejects.toThrow();
      }
      await expect(
        f.pool.query("UPDATE jev_evaluation_cuts SET state='eligible'"),
      ).rejects.toThrow(/APPEND_ONLY/);
    });
    it("a proven loss remains failed after restart and future windows even with insufficient sample", async () => {
      f.setClock(iso(end - 1000));
      await f.capture({ at: end - 1000, mark: "64000000000" });
      const entry = fill("evaluation-loss", "buy", "1000");
      await appendJevLedgerBatch(f.poolAdapter, "operator", s.account_id, {
        transaction_id: "loss",
        events: [
          jevCommand(paper, "entry", entry, end - 1000),
          jevCommand(
            paper,
            "fee",
            {
              event_type: "fee",
              execution_id: "evaluation-loss",
              delta: usd("-13000000"),
            },
            end - 1000,
          ),
        ],
      });
      f.setClock(iso(end + 60000));
      const first = await captureJevEvaluation(
        f.poolAdapter,
        "operator",
        "h1",
        "v1",
      );
      expect(first!.state).toBe("failed");
      const before = await readJevAccount(
        f.poolAdapter,
        "operator",
        s.account_id,
      );
      f.setClock(iso(end + day + 60000));
      const second = await captureJevEvaluation(
        f.poolAdapter,
        "operator",
        "h1",
        "v1",
      );
      expect(second).toMatchObject({ state: "failed", previous_failed: true });
      expect(
        await readJevAccount(f.poolAdapter, "operator", s.account_id),
      ).toEqual(before);
      expect(
        (await readJevEvaluation(readPool, "operator", "h1", "v1")).evaluations,
      ).toHaveLength(2);
    });
    it("retains an irrecoverable financial gap after restart instead of turning it into an economic failure", async () => {
      f.setClock(iso(end - 1000));
      const observed = await observeJevRisk(
        f.poolAdapter,
        "operator",
        s.account_id,
      );
      const checkpoint = {
        ...observed.checkpoint,
        history_complete: false,
        reasons: ["HISTORY_UNOBSERVED"],
        entries_paused: true,
        cancel_entries: true,
      };
      await f.pool.query(
        "INSERT INTO jev_risk_events(account_id,sequence,operation_id,checkpoint,evidence) SELECT $1,MAX(sequence)+1,'fixture-financial-gap',$2::jsonb,$3::jsonb FROM jev_risk_events WHERE account_id=$1",
        [
          s.account_id,
          JSON.stringify(checkpoint),
          JSON.stringify({
            source: "irrecoverable_fixture_gap",
            financial_continuity: false,
          }),
        ],
      );
      f.setClock(iso(end + 60000));
      const first = await captureJevEvaluation(
        f.poolAdapter,
        "operator",
        "h1",
        "v1",
      );
      expect(first!.state).toBe("validating");
      expect(
        first!.accounts.find((a) => a.mode === "paper")!.reasons,
      ).toContain("irrecoverable_financial_gap");
      f.setClock(iso(end + day + 60000));
      const second = await captureJevEvaluation(
        f.poolAdapter,
        "operator",
        "h1",
        "v1",
      );
      expect(
        second!.accounts.find((a) => a.mode === "paper")!.reasons,
      ).toContain("irrecoverable_financial_gap");
      expect(second!.state).not.toBe("failed");
    });
    it("rejects retrospective window selection and leaves no partial result on transaction failure", async () => {
      await expect(
        captureJevEvaluation(f.poolAdapter, "operator", "h1", "v1", {
          phase: "initial",
          window: { start_at: iso(begun + day), end_at: iso(end) },
        }),
      ).rejects.toThrow(/SCHEDULE/);
      f.setHook(async (sql) => {
        if (sql.startsWith("INSERT INTO jev_evaluation_cuts"))
          throw new Error("injected_failure");
      });
      await expect(
        captureJevEvaluation(f.poolAdapter, "operator", "h1", "v1"),
      ).rejects.toThrow("injected_failure");
      f.setHook(null);
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int n FROM jev_evidence_objects WHERE object_id LIKE 'jev-evaluation:%'",
          )
        ).rows[0].n,
      ).toBe(0);
    });
  },
);
