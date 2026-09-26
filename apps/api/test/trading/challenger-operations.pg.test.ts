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
