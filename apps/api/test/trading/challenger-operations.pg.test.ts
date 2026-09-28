import {
  operateBaseline,
  BASELINE_PERIOD_MS,
} from "../../src/storage/baseline-periods.js";
import { withDeskWorker } from "../../src/storage/desk-worker.js";
import { challengerReadinessTx } from "../../src/storage/challenger-operations.js";
import { captureReplayDataset } from "../../src/storage/replaystore.js";
import { compareWindowArtifacts } from "../../src/storage/window-metrics.js";
import { readFileSync } from "node:fs";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import type { SqlExecutor } from "../../src/database.js";
import { SecretValue } from "../../src/config.js";
import { registerTradingReadRoutes } from "../../src/trading-readapi.js";
import { activateBaseline } from "../../src/baseline-activate-cli.js";
import { activateChallenger } from "../../src/challenger-activate-cli.js";
import {
  disabledChallengerConfig,
  type ChallengerConfig,
} from "../../src/models/jev-config.js";
import {
  challengerGateTx,
  readChallengerStatusTx,
} from "../../src/storage/challenger-operations.js";
import { createOperationalChallenger } from "../../src/storage/challenger-operations.js";
import { consumeBaselineAccount } from "../../src/storage/baseline-runtime.js";
import {
  withBtcRetentionTransaction,
  storeRetentionObjectTx,
} from "../../src/storage/btc-retention.js";
import { jevHash } from "../../src/models/jev-contract.js";
import { acceptanceFixture } from "./acceptance-fixture.js";
import { fixture, T } from "./baseline-fixture.js";
import { mockTariff } from "./jev-fixture.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
const manifest = readFileSync(
  new URL("../../../../config/trading/baseline.json", import.meta.url),
  "utf8",
);
const contract = readFileSync(
  new URL(
    "../../../../docs/contracts/btc-baseline-manifest-v1.md",
    import.meta.url,
  ),
  "utf8",
);
let f: Awaited<ReturnType<typeof acceptanceFixture>>, now: number;
const makePool = () => {
  const p = f.worker().pool;
  return Object.assign(p, {
    readOnly: <U>(_ms: number, run: (tx: SqlExecutor) => Promise<U>) =>
      p.transaction(async (tx) => {
        await tx.query("SET TRANSACTION READ ONLY");
        return run(tx);
      }),
  });
};
let pool: ReturnType<typeof makePool>, config: ChallengerConfig;
const activate = (c = config, owner = "owner") =>
  activateChallenger(
    pool,
    owner,
    "c".repeat(40),
    manifest,
    contract,
    c,
    "mock",
    {
      start_at: new Date(T).toISOString(),
      end_at: new Date(T + 86400000).toISOString(),
      purpose: "operational_pilot",
    },
  );
async function provision() {
  await f.pool.query(
    "INSERT INTO btc_jev_budgets(origin,month,enabled,provision_reference,tariff_hash,limit_usd6) VALUES('mock',$1,true,$2,$3,10000)",
    [
      new Date(now).toISOString().slice(0, 7),
      config.provisionReference,
      jevHash(config.tariff),
    ],
  );
}
describe.skipIf(!url)(
  "prospective Jev operations: disposable PostgreSQL and MOCK configuration only",
  () => {
    beforeEach(async () => {
      now = T - 1000;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      f = await acceptanceFixture(url, () => now, true);
      pool = makePool();
      await f.pool.query(
        "INSERT INTO auth_accounts(username,password_hash) VALUES('owner','MOCK-only')",
      );
      const input = fixture(),
        meta = input.metadata!;
      await withBtcRetentionTransaction(pool, async (tx) => {
        await storeRetentionObjectTx(tx, {
          id: meta.object_id,
          class: "raw",
          identity: input.registration.scope,
          recordedAt: new Date(meta.recorded_at),
          payload: meta.payload,
          dependencies: [],
        });
        await tx.query(
          "INSERT INTO btc_market_records(object_id,kind,received_at) VALUES($1,'metadata',$2)",
          [meta.object_id, meta.recorded_at],
        );
      });
      await activateBaseline(pool, "owner", "b".repeat(40), manifest, contract);
      config = {
        enabled: true,
        key: new SecretValue("MOCK-only"),
        credentialPresent: true,
        tariff: mockTariff(),
        provisionReference: "MOCK-existing-credit",
        billingBoundReference: "MOCK-total-bound",
        reasons: [],
      };
    });
    afterEach(async () => {
      vi.useRealTimers();
      await f?.dispose();
    });
    it.each([
      "defaultoff",
      "credential",
      "coverage",
      "bound",
      "tariff",
      "exhausted",
      "circuit",
      "month",
    ])(
      "%s refuses registration without creating account, genesis, credit or requests",
      async (failure) => {
        if (failure !== "coverage") await provision();
        if (failure === "defaultoff") config = disabledChallengerConfig();
        if (failure === "credential")
          Object.assign(config, { key: null, credentialPresent: false });
        if (failure === "bound") config.billingBoundReference = null;
        if (failure === "tariff")
          config.tariff = { ...config.tariff!, version: "mock-mismatch.v2" };
        if (failure === "exhausted")
          await f.pool.query(
            "UPDATE btc_jev_budgets SET committed_usd6=limit_usd6",
          );
        if (failure === "circuit")
          await f.pool.query("UPDATE btc_jev_budgets SET circuit_open=true");
        if (failure === "month")
          await f.pool.query("UPDATE btc_jev_budgets SET month='2000-01'");
        expect(await activate()).toMatchObject({ status: "disabled" });
        expect(
          (
            await f.pool.query(
              "SELECT 1 FROM btc_ledger_accounts WHERE account_id='challenger'",
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (await f.pool.query("SELECT 1 FROM btc_jev_calls")).rowCount,
        ).toBe(0);
        expect(
          (
            await f.pool.query(
              "SELECT 1 FROM btc_jev_budgets WHERE origin='real'",
            )
          ).rowCount,
        ).toBe(0);
      },
    );
    it("refuses retroactive and uncovered thirty-day windows before creating challenger", async () => {
      await provision();
      now = T + 1000;
      vi.setSystemTime(now);
      for (const window of [
        {
          start_at: new Date(T).toISOString(),
          end_at: new Date(T + 86400000).toISOString(),
          purpose: "operational_pilot" as const,
        },
        {
          start_at: new Date(T + 900000).toISOString(),
          end_at: new Date(T + 900000 + BASELINE_PERIOD_MS).toISOString(),
          purpose: "economic_evaluation" as const,
        },
      ])
        await expect(
          activateChallenger(
            pool,
            "owner",
            "c".repeat(40),
            manifest,
            contract,
            config,
            "mock",
            window,
          ),
        ).rejects.toThrow("PROSPECTIVE_WINDOW");
      expect(
        (
          await f.pool.query(
            "SELECT 1 FROM btc_ledger_accounts WHERE account_id='challenger'",
          )
        ).rowCount,
      ).toBe(0);
    });
    it("pins a prospectively registered successor for thirty days without moving baseline genesis or rearming", async () => {
      await provision();
      now = T;
      vi.setSystemTime(now);
      await consumeBaselineAccount(pool, "baseline");
      const before = (
        await f.pool.query(
          "SELECT registration FROM btc_baseline_registrations WHERE account_id='baseline'",
        )
      ).rows[0].registration;
      await withDeskWorker(pool, "baseline", (w) =>
        operateBaseline(
          Object.assign(w, { readOnly: pool.readOnly }),
          "owner",
          "c".repeat(40),
          {
            action: "register_period",
            operation_id: "evaluation",
            reason: "MOCK future evaluation",
            purpose: "economic_evaluation",
            start_at: new Date(T + BASELINE_PERIOD_MS).toISOString(),
          },
        ),
      );
      const window = {
        start_at: new Date(T + BASELINE_PERIOD_MS).toISOString(),
        end_at: new Date(T + 2 * BASELINE_PERIOD_MS).toISOString(),
        purpose: "economic_evaluation" as const,
      };
      const result = await activateChallenger(
        pool,
        "owner",
        "c".repeat(40),
        manifest,
        contract,
        config,
        "mock",
        window,
      );
      expect(result.status).toBe("registered");
      expect(result.binding?.evaluation?.source_period?.purpose).toBe(
        "economic_evaluation",
      );
      expect(result.registration?.schema_version).toBe(
        "btc.baseline-registration.v2",
      );
      expect(result.registration?.start_at).toBe(window.start_at);
      expect(
        (
          await f.pool.query(
            "SELECT registration FROM btc_baseline_registrations WHERE account_id='baseline'",
          )
        ).rows[0].registration,
      ).toEqual(before);
      expect(
        (
          await f.pool.query(
            "SELECT 1 FROM btc_ledger_events WHERE account_id='challenger'",
          )
        ).rowCount,
      ).toBe(0);
      const bound = result.binding!.evaluation!.source_period_evidence_id;
      expect(
        (
          await f.pool.query(
            "SELECT 1 FROM btc_retention_pins WHERE object_id=$1",
            [bound],
          )
        ).rowCount,
      ).toBeGreaterThan(0);
      await expect(
        activateChallenger(
          pool,
          "owner",
          "c".repeat(40),
          manifest,
          contract,
          config,
          "mock",
          {
            ...window,
            end_at: new Date(T + 2 * BASELINE_PERIOD_MS - 900000).toISOString(),
          },
        ),
      ).rejects.toThrow("REGISTRATION_CONFLICT");
    });
    it("exports persisted v2 registration and compares different starts; expiry never rearms or calls Jev", async () => {
      await provision();
      now = T;
      vi.setSystemTime(now);
      await consumeBaselineAccount(pool, "baseline");
      now = T + 1000;
      vi.setSystemTime(now);
      const window = {
        start_at: new Date(T + 900000).toISOString(),
        end_at: new Date(T + 1800000).toISOString(),
        purpose: "operational_pilot" as const,
      };
      const r = await activateChallenger(
        pool,
        "owner",
        "c".repeat(40),
        manifest,
        contract,
        config,
        "mock",
        window,
      );
      now = T + 900000;
      vi.setSystemTime(now);
      const runtime = createOperationalChallenger(
        pool,
        disabledChallengerConfig(),
      );
      await runtime.tick("challenger");
      await runtime.stop();
      now = T + 1800000;
      vi.setSystemTime(now);
      const gate = await pool.readOnly(1500, (tx) =>
        challengerReadinessTx(tx, config, "challenger", "mock"),
      );
      expect(gate.reasons).toContain("comparison_period_expired_or_missing");
      const a = await captureReplayDataset(
          pool,
          "baseline",
          "c".repeat(40),
          undefined,
          "references",
        ),
        b = await captureReplayDataset(
          pool,
          "challenger",
          "c".repeat(40),
          undefined,
          "references",
        );
      const id = (
        await f.pool.query(
          "SELECT evidence_id FROM btc_baseline_registrations WHERE account_id='challenger'",
        )
      ).rows[0].evidence_id;
      const report = compareWindowArtifacts(a, b, {
        schema_version: "btc.economic-comparison.v2",
        baseline_dataset_id: a.dataset_id,
        challenger_dataset_id: b.dataset_id,
        registration_evidence_id: id,
        market_dataset_hash: "sha256:" + "a".repeat(64),
        baseline_risk_hash: "sha256:" + "b".repeat(64),
        challenger_risk_hash: "sha256:" + "b".repeat(64),
        declared_version_differences: ["code_sha"],
      });
      expect(report.status).toBe("observational_comparison");
      expect(report.delta?.trading_usd_raw).toBe("0");
      expect(report.window.start_at).toBe(r.binding?.comparison_start_at);
      expect((await f.pool.query("SELECT 1 FROM btc_jev_calls")).rowCount).toBe(
        0,
      );
    });
    it("registers once concurrently and prospectively, isolates genesis, pins comparison, and never rearms on duplicate", async () => {
      await provision();
      const before = (
        await f.pool.query(
          "SELECT * FROM btc_baseline_registrations WHERE account_id='baseline'",
        )
      ).rows;
      const results = await Promise.all([activate(), activate()]);
      expect(results.map((r) => r.status).sort()).toEqual([
        "duplicate",
        "registered",
      ]);
      const registration = results[0].registration!;
      expect(registration.start_at).toBe(new Date(T).toISOString());
      expect(Date.parse(registration.registered_at)).toBeLessThan(
        Date.parse(registration.start_at),
      );
      expect(
        (
          await f.pool.query(
            "SELECT 1 FROM btc_ledger_events WHERE account_id='challenger'",
          )
        ).rowCount,
      ).toBe(0);
      await expect(activate(config, "other")).rejects.toThrow(
        "BTC_CHALLENGER_OWNER_REQUIRED",
      );
      now = T;
      vi.setSystemTime(now);
      await consumeBaselineAccount(pool, "baseline");
      const runtime = createOperationalChallenger(
        pool,
        disabledChallengerConfig(),
      );
      try {
        await runtime.tick("challenger");
        await runtime.tick("challenger");
      } finally {
        await runtime.stop();
      }
      expect(
        (
          await f.pool.query(
            "SELECT account_id,projection->>'cash_usd_raw' AS cash FROM btc_ledger_projections ORDER BY account_id",
          )
        ).rows,
      ).toEqual([
        { account_id: "baseline", cash: "1000000000" },
        { account_id: "challenger", cash: "1000000000" },
      ]);
      await f.pool.query(
        "UPDATE btc_desk_controls SET enabled=false WHERE account_id='challenger'",
      );
      expect(await activate()).toMatchObject({
        status: "duplicate",
        registration,
      });
      expect(
        (
          await f.pool.query(
            "SELECT enabled FROM btc_desk_controls WHERE account_id='challenger'",
          )
        ).rows[0].enabled,
      ).toBe(false);
      expect(
        (
          await f.pool.query(
            "SELECT * FROM btc_baseline_registrations WHERE account_id='baseline'",
          )
        ).rows,
      ).toEqual(before);
      await expect(
        f.pool.query(
          "UPDATE btc_baseline_registrations SET registration='{}' WHERE account_id='challenger'",
        ),
      ).rejects.toThrow();
    });
    it("read endpoint is authenticated, uses original comparison, and never calls missing coverage a mock response", async () => {
      const app = Fastify();
      registerTradingReadRoutes(app, {
        pool,
        authService: {
          session: async (token) => ({
            status: token === "MOCK-session" ? "ok" : "unauthenticated",
          }),
        },
        clock: () => new Date(now),
        challengerConfig: disabledChallengerConfig(),
      });
      try {
        expect((await app.inject({ url: "/trading/jev" })).statusCode).toBe(
          401,
        );
        const response = await app.inject({
          url: "/trading/jev",
          headers: { authorization: "Bearer MOCK-session" },
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.json()).toMatchObject({
          enabled: false,
          registration: null,
          recent: [],
          real_api_cost: { calls: "0", measured_usd6: "0", limit_usd6: null },
        });
        expect(response.json().reasons).toContain("coverage_unavailable");
        await provision();
        await activate();
        const status = await pool.readOnly(1500, (tx) =>
          readChallengerStatusTx(tx, config),
        );
        expect(status.registration).toMatchObject({
          source_account: "baseline",
          comparison_start_at: new Date(T).toISOString(),
          origin: "mock",
        });
        expect(status.recent).toEqual([]);
        const gate = await pool.readOnly(1500, (tx) =>
          challengerGateTx(tx, config),
        );
        expect(gate.reasons).toContain("coverage_unavailable"); // mock credit is never real coverage
      } finally {
        await app.close();
      }
    });
  },
);
