import { seedDispatchCapacityTx } from "./jev-dispatch-fixture.js";
import {
  readJevDispatchCapacityTx,
  jevDispatchRegistryHashTx,
} from "../../src/storage/jev-dispatch-capacity.js";
import {
  makeJevEvidence,
  storeJevEvidence,
} from "../../src/storage/jev-evidence.js";
import {
  createJevEngineMonitor,
  readJevReadinessTx,
} from "../../src/storage/jev-readiness.js";
import { claimExecutionWorker } from "../../src/storage/execution-worker-lease.js";
import { commandJevOperator } from "../../src/storage/jev-operator.js";
import { recordJevInfrastructure } from "../../src/storage/jev-infrastructure.js";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import Fastify from "fastify";
import { riskFixture } from "./risk-fixture.js";
import { jevIdentity, iso, start } from "./jev-v2-fixture.js";
import { initialJevManifest } from "../../src/storage/jev-manifest.js";
import { registerJevPair } from "../../src/storage/jev-store.js";
import { readJevPanel } from "../../src/storage/jev-panel.js";
import { registerJevPanelRoutes } from "../../src/jev-panel-api.js";
import { jevHash } from "../../src/storage/jev-hash.js";
import type { DatabasePool } from "../../src/database.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let f: Awaited<ReturnType<typeof riskFixture>>;
const readPool: Pick<DatabasePool, "readOnly"> = {
  readOnly: <T>(
    _ms: number,
    run: (tx: import("../../src/database.js").SqlExecutor) => Promise<T>,
  ) =>
    f.poolAdapter.transaction(async (tx) => {
      await tx.query("SET TRANSACTION READ ONLY");
      return run(tx);
    }),
};
describe.skipIf(!url)(
  "JE11 panel owner and consistent financial snapshot on disposable PostgreSQL",
  () => {
    beforeEach(async () => {
      f = await riskFixture(url);
      f.setClock(iso(start));
      const manifest = initialJevManifest(1),
        paper = jevIdentity(),
        stress = jevIdentity("stress");
      for (const i of [paper, stress])
        i.bindings[0]!.profile.manifest_hash = jevHash(manifest);
      await registerJevPair(f.poolAdapter, 1, paper, stress, manifest);
      await f.capture({ at: start + 10000 });
      f.setClock(iso(start + 10000));
    });
    afterEach(async () => {
      await f?.dispose();
    });
    it("reads independent fictitious accounts on one cut with known zero flat results and no writes", async () => {
      const before = await f.pool.query(
        "SELECT count(*) FROM jev_ledger_events",
      );
      const result = await readJevPanel(readPool, "operator");
      expect(result.accounts).toHaveLength(2);
      expect(result.accounts.map((a) => a.mode).sort()).toEqual([
        "paper",
        "stress",
      ]);
      for (const a of result.accounts) {
        expect(a.metrics).toMatchObject({
          as_of: result.as_of,
          capital_usd6: "250000000",
          strategy_after_jev_usd6: "0",
        });
        expect(a.admitted).toBe(false);
        expect(a.risk).toBeNull();
      }
      expect(
        (await f.pool.query("SELECT count(*) FROM jev_ledger_events")).rows,
      ).toEqual(before.rows);
      expect((await readJevPanel(readPool, "someone-else")).accounts).toEqual(
        [],
      );
    });
    it("records manual monthly infrastructure once under concurrent retries without changing strategy metrics", async () => {
      const before = await readJevPanel(readPool, "operator");
      const month = before.as_of.slice(0, 7),
        command = { month, usd6: "12000000" };
      const results = await Promise.all([
        recordJevInfrastructure(
          f.poolAdapter,
          "operator",
          command,
          "infra-one",
        ),
        recordJevInfrastructure(
          f.poolAdapter,
          "operator",
          command,
          "infra-one",
        ),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([
        "duplicate",
        "recorded",
      ]);
      const after = await readJevPanel(readPool, "operator");
      expect(
        after.accounts.map((a) => a.metrics?.strategy_after_jev_usd6),
      ).toEqual(before.accounts.map((a) => a.metrics?.strategy_after_jev_usd6));
      expect(after.platform).toMatchObject({
        infrastructure_usd6: "12000000",
        captured_total_usd6: "12000000",
        invoice_complete: false,
      });
      await expect(
        recordJevInfrastructure(
          f.poolAdapter,
          "operator",
          { month, usd6: "13000000" },
          "infra-one",
        ),
      ).rejects.toThrow("IDEMPOTENCY_COLLISION");
      await recordJevInfrastructure(
        f.poolAdapter,
        "operator",
        { month, usd6: "13000000" },
        "infra-two",
      );
      expect(
        (await readJevPanel(readPool, "operator")).platform
          ?.infrastructure_usd6,
      ).toBe("13000000");
      await expect(
        f.pool.query("DELETE FROM jev_infrastructure_events"),
      ).rejects.toThrow();
    });
    it("latches pause/emergency once, rejects unadmitted/foreign accounts and records pending reconciliation", async () => {
      await expect(
        commandJevOperator(
          f.poolAdapter,
          "operator",
          { account_id: "all", action: "emergency" },
          "operator-one",
        ),
      ).rejects.toThrow("NOT_ADMITTED");
      await f.pool.query(
        "INSERT INTO jev_worker_controls(account_id,admitted,entries_paused,admission_reference) SELECT account_id,true,false,'fixture_only' FROM jev_accounts",
      );
      const request = { account_id: "all", action: "emergency" };
      const results = await Promise.all([
        commandJevOperator(f.poolAdapter, "operator", request, "operator-one"),
        commandJevOperator(f.poolAdapter, "operator", request, "operator-one"),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([
        "accepted",
        "duplicate",
      ]);
      const rows = (
        await f.pool.query(
          "SELECT revision::text,entries_paused,operator_close_requested FROM jev_worker_controls",
        )
      ).rows;
      expect(rows).toHaveLength(2);
      for (const row of rows)
        expect(row).toMatchObject({
          revision: "2",
          entries_paused: true,
          operator_close_requested: true,
        });
      expect(
        (await readJevPanel(readPool, "operator")).accounts.every(
          (a) => a.intervention?.status === "pending_reconciliation",
        ),
      ).toBe(true);
      await expect(
        commandJevOperator(f.poolAdapter, "foreign", request, "foreign-one"),
      ).rejects.toThrow("NOT_ADMITTED");
      await expect(
        commandJevOperator(
          f.poolAdapter,
          "operator",
          { account_id: "all", action: "pause" },
          "operator-one",
        ),
      ).rejects.toThrow("IDEMPOTENCY_COLLISION");
      await expect(
        f.pool.query("TRUNCATE jev_operator_commands"),
      ).rejects.toThrow();
    });
    it("observes worker health separately from admission and never manufactures qualification when dormant", async () => {
      const lease = await claimExecutionWorker(f.poolAdapter, "a".repeat(40));
      const monitor = createJevEngineMonitor(
        f.poolAdapter,
        lease,
        "a".repeat(40),
        null,
        false,
      );
      const now = Date.now();
      await monitor.tick(now);
      await monitor.tick(now + 61000);
      const readiness = await f.poolAdapter.transaction((tx) =>
        readJevReadinessTx(tx, "operator", new Date(now + 61000).toISOString()),
      );
      expect(readiness).toMatchObject({
        status: "not_ready",
        operational_admission: false,
        qualification: { qualified: false, status: "not_started" },
      });
      expect(readiness.reasons).toContain("not_admitted");
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM jev_engine_qualifications",
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it("persists actual invalid timeline evidence without manufacturing a seven-day qualification or changing admission", async () => {
      await f.pool.query(
        "INSERT INTO jev_worker_controls(account_id,admitted,entries_paused,admission_reference) SELECT account_id,true,true,'fixture_only' FROM jev_accounts",
      );
      const lease = await claimExecutionWorker(f.poolAdapter, "a".repeat(40)),
        monitor = createJevEngineMonitor(
          f.poolAdapter,
          lease,
          "a".repeat(40),
          "jev-1.13.0",
          false,
        ),
        now = Date.now() - 61000;
      for (let n = 0; n <= 60; n++) await monitor.tick(now + n * 1000);
      const observations = (
        await f.pool.query("SELECT original,valid FROM jev_engine_observations")
      ).rows;
      expect(observations).toHaveLength(1);
      expect(observations[0].valid).toBe(false);
      expect(observations[0].original.reasons).toContain("backend_unavailable");
      expect(
        (await f.pool.query("SELECT qualified FROM jev_engine_qualifications"))
          .rows,
      ).toEqual([{ qualified: false }]);
      const evidence = (
        await f.pool.query("SELECT evidence_id FROM jev_engine_observations")
      ).rows[0].evidence_id;
      const envelope = (
        await f.pool.query(
          "SELECT envelope FROM jev_evidence_objects WHERE object_id=$1",
          [evidence],
        )
      ).rows[0].envelope;
      for (const origin of ["fixture", "observed_runtime"]) {
        const id = "unobserved:" + origin,
          end_at = new Date(now + 60000).toISOString(),
          start_at = new Date(now + 60000 - 7 * 86400000).toISOString();
        await storeJevEvidence(f.poolAdapter, [
          makeJevEvidence({
            object_id: id,
            scope: envelope.scope,
            kind: "result",
            recorded_at: end_at,
            dependencies: [evidence],
            sources: [],
            payload: {
              artifact_id: id,
              original: {
                schema_version: "jev.engine-qualification.v1",
                engine_version: "jev.scheduler.v2",
                engine_fingerprint:
                  envelope.payload.original.engine_fingerprint,
                origin,
                start_at,
                end_at,
                qualified: true,
                financial_continuity_proven: true,
                execution_costs_funding_risk_recovery_proven: true,
              },
            },
          }),
        ]);
        await expect(
          f.pool.query(
            "INSERT INTO jev_engine_qualifications(evidence_id,owner_id,engine_version,start_at,end_at,qualified) VALUES($1,'operator','jev.scheduler.v2',$2,$3,true)",
            [id, start_at, end_at],
          ),
        ).rejects.toThrow("JEV_QUALIFICATION_UNOBSERVED");
      }
      await expect(
        f.pool.query("DELETE FROM jev_engine_observations"),
      ).rejects.toThrow();
      expect(
        (
          await f.pool.query("SELECT entries_paused FROM jev_worker_controls")
        ).rows.every((r) => r.entries_paused),
      ).toBe(true);
    });
    it.each([
      {},
      { host_cpu_busy_ppm: 750001 },
      { db_write_max_ms: 1001 },
      { host_ram_used_bytes: "13000000001" },
      { host_cpu_busy_ppm: null },
    ])(
      "gates entry dispatch using retained resource measurements %j",
      async (override) => {
        const at = start + 10000;
        const ready = await f.poolAdapter.transaction(async (tx) => {
          const id = await seedDispatchCapacityTx(tx, at, override);
          return readJevDispatchCapacityTx(
            tx,
            id,
            await jevDispatchRegistryHashTx(tx),
            "jev-1.13.0",
            at,
          );
        });
        expect(ready).toBe(Object.keys(override).length === 0);
      },
    );
    it("keeps auth no-store and rejects caller-selected owners or query overrides", async () => {
      const app = Fastify();
      registerJevPanelRoutes(app, {
        pool: { ...readPool, transaction: f.poolAdapter.transaction },
        authService: {
          session: async (token: string) =>
            token === "ok"
              ? {
                  status: "ok",
                  username: "operator",
                  expiresAt: new Date(start + 20000),
                }
              : { status: "unauthenticated" },
        },
      });
      expect((await app.inject({ url: "/trading/jev/panel" })).statusCode).toBe(
        401,
      );
      const good = await app.inject({
        url: "/trading/jev/panel",
        headers: { authorization: "Bearer ok" },
      });
      expect(good.statusCode).toBe(200);
      expect(good.headers["cache-control"]).toBe("no-store");
      expect(
        (
          await app.inject({
            url: "/trading/jev/panel?owner=someone-else",
            headers: { authorization: "Bearer ok" },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/trading/jev/infrastructure",
            headers: { authorization: "Bearer ok" },
            payload: { month: "2026-10", usd6: "1" },
          })
        ).statusCode,
      ).toBe(403);
      const csrf = "a".repeat(64);
      const write = await app.inject({
        method: "POST",
        url: "/trading/jev/infrastructure",
        headers: {
          authorization: "Bearer ok",
          host: "localhost",
          origin: "http://localhost",
          "x-csrf-token": csrf,
          cookie: `ganso_csrf=${csrf}`,
          "idempotency-key": "http-infra",
        },
        payload: { month: "2026-10", usd6: "1" },
      });
      expect(write.statusCode).toBe(200);
      const commandHeaders = {
        authorization: "Bearer ok",
        host: "localhost",
        origin: "http://localhost",
        "x-csrf-token": csrf,
        cookie: `ganso_csrf=${csrf}`,
        "idempotency-key": "http-control",
      };
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/trading/jev/control",
            headers: { authorization: "Bearer ok" },
            payload: { account_id: "all", action: "pause" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/trading/jev/control",
            headers: commandHeaders,
            payload: { account_id: "all", action: "pause" },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/trading/jev/control?owner=foreign",
            headers: commandHeaders,
            payload: { account_id: "all", action: "pause" },
          })
        ).statusCode,
      ).toBe(400);
      await app.close();
    });
  },
);
