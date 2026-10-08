import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import type { SqlExecutor } from "../../src/database.js";
import { createPgFixture } from "../pg-fixture.js";
import { capacityFixture } from "./jev-capacity-fixture.js";
import { registerJevPair } from "../../src/storage/jev-store.js";
import {
  storeJevEvidence,
  readJevEvidence,
} from "../../src/storage/jev-evidence.js";
import {
  estimateJevFeasibility,
  type JevCorpusSample,
} from "../../src/storage/jev-feasibility.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let fixture: Awaited<ReturnType<typeof createPgFixture>>;
const pool = {
  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>) {
    const c = await fixture.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await run({
        async query(sql, params) {
          const x = await c.query(sql, params ? [...params] : []);
          return { rows: x.rows, rowCount: x.rowCount ?? 0 };
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
describe.skipIf(!url)("bounded three-pair corpus, no paid JEV", () => {
  beforeEach(async () => {
    fixture = await createPgFixture(url);
  });
  afterEach(async () => {
    await fixture?.dispose();
  });
  it("measures logical charge and physical growth, then projects 90d + 180d without certifying runtime", async () => {
    for (const [slot, h] of [1, 3, 5].entries()) {
      const f = capacityFixture(h as 1 | 3 | 5, `registry:${h}`);
      await registerJevPair(pool, slot + 1, f.paper, f.stress, f.manifest);
    }
    const measure = async () =>
      (
        await fixture.pool.query(
          "SELECT total_bytes::text logical,jev_evidence_allocated_bytes()::text allocated FROM btc_retention_policy",
        )
      ).rows[0];
    const before = await measure();
    let requestBytes = 0,
      calls = 0;
    const started = performance.now();
    for (let cycle = 0; cycle < 10; cycle++)
      for (const h of [1, 3, 5] as const) {
        const f = capacityFixture(h, `cycle:${cycle}:h${h}`);
        requestBytes = Math.max(
          requestBytes,
          Buffer.byteLength(JSON.stringify(f.request)),
        );
        await storeJevEvidence(pool, f.artifacts);
        calls++;
      }
    const elapsed = performance.now() - started,
      after = await measure();
    const sample: JevCorpusSample = {
      schema_version: "jev.corpus-sample.v1",
      origin: "disposable_postgres_fixture",
      calls,
      logical_bytes: (
        BigInt(after.logical) - BigInt(before.logical)
      ).toString(),
      allocated_growth_bytes: (
        BigInt(after.allocated) - BigInt(before.allocated)
      ).toString(),
      request_utf8_bytes: requestBytes,
    };
    const r = estimateJevFeasibility(sample, "15395962266", "9706037248");
    expect(calls).toBe(30);
    expect(r.admitted).toBe(false);
    expect(r.paid_calls).toBe(0);
    const replay = await readJevEvidence(
      pool,
      "operator",
      "cycle:9:h5:stress:hold",
    );
    expect(replay.objects.some((e) => e.kind === "response")).toBe(true);
    expect(replay.objects.some((e) => e.kind === "inputs")).toBe(true);
    const report = {
      ...r,
      fixture_measurement: {
        cycles_per_profile: 10,
        profiles: 3,
        accounts: 6,
        objects: (
          await fixture.pool.query(
            "SELECT count(*)::int n FROM jev_evidence_objects",
          )
        ).rows[0].n,
        elapsed_ms: elapsed,
        postgres: (await fixture.pool.query("SELECT version() v")).rows[0].v,
        resource_limit:
          process.env.GANSO_JE03_FIXTURE_RESOURCES ??
          "disposable_harness_not_resource_capped",
        latency_origin: "local_fixture_not_provider_or_production",
      },
    };
    if (process.env.GANSO_JE03_ESTIMATE_PATH)
      writeFileSync(
        process.env.GANSO_JE03_ESTIMATE_PATH,
        JSON.stringify(report, null, 2) + "\n",
      );
    console.log("JE03 corpus sample", JSON.stringify(sample));
  }, 30000);
});
