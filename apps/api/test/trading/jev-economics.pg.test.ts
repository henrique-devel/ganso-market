import { afterEach, beforeEach, describe, it, expect } from "vitest";
import Fastify from "fastify";
import { riskFixture } from "./risk-fixture.js";
import { jevIdentity, iso, start } from "./jev-v2-fixture.js";
import { metadata } from "./bars-fixture.js";
import { jevScope } from "../../src/storage/jev-ledger.js";
import {
  registerJevPair,
  readJevAccount,
} from "../../src/storage/jev-store.js";
import { jevHash } from "../../src/storage/jev-hash.js";
import { initialJevManifest } from "../../src/storage/jev-manifest.js";
import {
  captureJevMetrics,
  readJevMetrics,
} from "../../src/storage/jev-metrics.js";
import {
  captureJevBenchmark,
  readJevBenchmark,
  readJevResult,
} from "../../src/storage/jev-benchmarkstore.js";
import {
  withBtcRetentionTransaction,
  storeRetentionObjectTx,
} from "../../src/storage/btc-retention.js";
import { registerExperimentRoutes } from "../../src/experiments-api.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let f: Awaited<ReturnType<typeof riskFixture>>;
const manifest = initialJevManifest(1),
  paper = jevIdentity(),
  stress = jevIdentity("stress");
for (const i of [paper, stress])
  i.bindings[0]!.profile.manifest_hash = jevHash(manifest);
const scope = jevScope(paper.bindings[0]!.binding, paper.instrument);
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
async function market(at = start + 10000) {
  f.setClock(iso(at));
  await f.capture({ at });
}
describe.skipIf(!url)(
  "JE08 immutable economic cuts and inactive references on PostgreSQL",
  () => {
    beforeEach(async () => {
      f = await riskFixture(url);
      f.setClock(iso(start));
      await registerJevPair(f.poolAdapter, 1, paper, stress, manifest);
      await withBtcRetentionTransaction(f.poolAdapter, async (tx) => {
        await storeRetentionObjectTx(tx, {
          id: "benchmark:metadata",
          class: "raw",
          identity: { ...scope, mode: "paper" },
          recordedAt: new Date(start),
          payload: metadata,
          dependencies: [],
        });
        await tx.query(
          "INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES('benchmark:metadata','metadata',$1,$1)",
          [iso(start)],
        );
      });
      await market();
    });
    afterEach(async () => {
      await f?.dispose();
    });
    it("publishes known-zero flat results without infra and captures idempotent permanent cuts", async () => {
      const read = await readJevMetrics(readPool, "operator", scope.account_id);
      expect(read).toMatchObject({
        risk_equity_usd6: "250000000",
        strategy_after_jev_usd6: "0",
        conservative_result_usd6: "0",
        costs: { platform: { infrastructure_usd6: null } },
        operational_admission: false,
      });
      const cut = await captureJevMetrics(
        f.poolAdapter,
        "operator",
        scope.account_id,
        "one",
      );
      await market(start + 11000);
      expect(
        await captureJevMetrics(
          f.poolAdapter,
          "operator",
          scope.account_id,
          "one",
        ),
      ).toEqual(cut);
      expect(
        await readJevResult(readPool, "operator", "jev-metrics:paper:h1:one"),
      ).toEqual(cut);
      await expect(
        readJevMetrics(readPool, "other", scope.account_id),
      ).rejects.toThrow(/NOT_FOUND/);
      await expect(
        captureJevMetrics(
          f.poolAdapter,
          "operator",
          scope.account_id,
          "one",
          "mock",
        ),
      ).rejects.toThrow(/OWNER/);
      await expect(
        f.pool.query("UPDATE jev_result_cuts SET as_of=clock_timestamp()"),
      ).rejects.toThrow(/APPEND_ONLY/);
      await expect(f.pool.query("TRUNCATE jev_result_cuts")).rejects.toThrow(
        /APPEND_ONLY/,
      );
    });
    it("executes only a separate virtual reference, preserves ledger and sources, and never restarts at a cut", async () => {
      const before = await readJevAccount(
        f.poolAdapter,
        "operator",
        scope.account_id,
      );
      const first = await captureJevBenchmark(f.poolAdapter, scope, "start");
      expect(first.state.events).toEqual([]);
      await market(start + 11000);
      const second = await captureJevBenchmark(
        f.poolAdapter,
        scope,
        "arrival",
        [
          {
            period_hour: iso(start),
            received_at: iso(start + 11000),
            row: { coin: "BTC", time: start, fundingRate: "0", premium: "0" },
            oracle: null,
          },
        ],
      );
      expect(second.state.phase).toBe("holding");
      expect(second.state.initial_quantity_btc8).toBe("192000");
      expect(second.parent_id).toBe("jev-benchmark:paper:h1:start");
      await market(start + 12000);
      const third = await captureJevBenchmark(f.poolAdapter, scope, "next");
      expect(third.state.initial_quantity_btc8).toBe("192000");
      expect(third.state.events).toEqual(second.state.events);
      expect(
        await readJevAccount(f.poolAdapter, "operator", scope.account_id),
      ).toEqual(before);
      expect(
        await readJevBenchmark(readPool, "operator", scope.account_id),
      ).toMatchObject({ status: "captured", real_capital_reserved_usd6: "0" });
      const rows = (
        await f.pool.query(
          "SELECT * FROM jev_evidence_sources WHERE object_id='jev-benchmark:paper:h1:arrival'",
        )
      ).rows;
      expect(rows.length).toBeGreaterThanOrEqual(3);
      await expect(
        f.pool.query(
          "DELETE FROM jev_evidence_objects WHERE object_id='jev-benchmark:paper:h1:start'",
        ),
      ).rejects.toThrow();
      await expect(f.pool.query("DELETE FROM jev_result_cuts")).rejects.toThrow(
        /APPEND_ONLY/,
      );
    });
    it("serializes concurrent duplicates and rolls back result/index together after failure", async () => {
      const [a, b] = await Promise.all([
        captureJevBenchmark(f.poolAdapter, scope, "same"),
        captureJevBenchmark(f.poolAdapter, scope, "same"),
      ]);
      expect(a).toEqual(b);
      expect(
        (await f.pool.query("SELECT count(*)::int n FROM jev_result_cuts"))
          .rows[0].n,
      ).toBe(1);
      f.setHook(async (sql) => {
        if (sql.startsWith("INSERT INTO jev_result_cuts"))
          throw new Error("synthetic index failure");
      });
      await expect(
        captureJevMetrics(
          f.poolAdapter,
          "operator",
          scope.account_id,
          "rollback",
        ),
      ).rejects.toThrow(/index failure/);
      expect(
        (
          await f.pool.query(
            "SELECT 1 FROM jev_evidence_objects WHERE object_id='jev-metrics:paper:h1:rollback'",
          )
        ).rows,
      ).toEqual([]);
      f.setHook(null);
      await captureJevMetrics(
        f.poolAdapter,
        "operator",
        scope.account_id,
        "rollback",
      );
      await expect(
        captureJevBenchmark(f.poolAdapter, { ...scope, mode: "live" }, "live"),
      ).rejects.toThrow(/COMMAND/);
    });
    it("protects DTO reads, scopes ownership and keeps GET free of financial writes", async () => {
      const app = Fastify();
      registerExperimentRoutes(app, {
        pool: readPool,
        authService: {
          session: async (token) => ({
            status: "ok",
            username: token === "foreign" ? "other" : "operator",
          }),
        },
        clock: () => new Date(),
      });
      for (const endpoint of ["metrics", "benchmarks", "results"])
        expect(
          (await app.inject({ url: `/trading/jev/${endpoint}` })).statusCode,
        ).toBe(401);
      const headers = { authorization: "Bearer valid" };
      const r = await app.inject({
        url: "/trading/jev/metrics?account_id=paper:h1",
        headers,
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().schema_version).toBe("jev.metrics.v1");
      expect(r.headers["cache-control"]).toBe("no-store");
      for (const endpoint of ["metrics", "benchmarks"])
        expect(
          (
            await app.inject({
              url: `/trading/jev/${endpoint}?account_id=paper:h1`,
              headers: { authorization: "Bearer foreign" },
            })
          ).statusCode,
        ).toBe(404);
      await captureJevMetrics(
        f.poolAdapter,
        "operator",
        scope.account_id,
        "owned",
      );
      expect(
        (
          await app.inject({
            url: "/trading/jev/results?evidence_id=jev-metrics:paper:h1:owned",
            headers: { authorization: "Bearer foreign" },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            url: "/trading/jev/results?evidence_id=jev-metrics:paper:h1:owned",
            headers,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            url: "/trading/jev/metrics?account_id=absent",
            headers,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            url: "/trading/jev/benchmarks?account_id=absent",
            headers,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (await f.pool.query("SELECT count(*)::int n FROM jev_result_cuts"))
          .rows[0].n,
      ).toBe(1);
      await app.close();
    });
  },
);
