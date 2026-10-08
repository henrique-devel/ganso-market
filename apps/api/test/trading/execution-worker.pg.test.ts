import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { createPgFixture } from "../pg-fixture.js";
import type { DatabasePool, SqlExecutor } from "../../src/database.js";
import {
  claimExecutionWorker,
  executionFencedPool,
  releaseExecutionWorker,
} from "../../src/storage/execution-worker-lease.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let f: Awaited<ReturnType<typeof createPgFixture>>;
let lost = false;
const pool: Pick<DatabasePool, "transaction" | "readOnly"> = {
  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>) {
    const c = await f.pool.connect();
    try {
      await c.query("BEGIN");
      const v = await run({
        async query(sql, params) {
          const r = await c.query(sql, params ? [...params] : []);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        },
      });
      await c.query("COMMIT");
      if (lost) {
        lost = false;
        throw new Error("lost commit ACK");
      }
      return v;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  },
  readOnly(_ms, run) {
    return this.transaction(run);
  },
};
describe.skipIf(!url)("JE07 process ownership", () => {
  beforeEach(async () => {
    f = await createPgFixture(url);
    lost = false;
  });
  afterEach(async () => {
    await f.dispose();
  });
  it("allows exactly one of two simultaneous process owners", async () => {
    const r = await Promise.allSettled([
      claimExecutionWorker(pool, "a".repeat(40)),
      claimExecutionWorker(pool, "b".repeat(40)),
    ]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM execution_worker_owners",
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("retires old generations permanently and fences their effects", async () => {
    const a = await claimExecutionWorker(pool, "a".repeat(40));
    await releaseExecutionWorker(pool, a);
    const b = await claimExecutionWorker(pool, "b".repeat(40));
    expect(b.generation).toBe("2");
    await expect(
      claimExecutionWorker(pool, "a".repeat(40), a.worker_id),
    ).rejects.toThrow("FENCED");
    await expect(
      executionFencedPool(pool, a).transaction((tx) => tx.query("SELECT 1")),
    ).rejects.toThrow("FENCED");
  });
  it("rolls back the entire transaction when the lease expires before commit", async () => {
    const a = await claimExecutionWorker(pool, "a".repeat(40));
    await f.pool.query(
      "UPDATE execution_worker_head SET lease_until=clock_timestamp()+interval '50 milliseconds'",
    );
    await expect(
      executionFencedPool(pool, a).transaction(async (tx) => {
        await tx.query("CREATE TABLE je07_rolled_back(n int)");
        await delay(100);
      }),
    ).rejects.toThrow("FENCED");
    expect(
      (await f.pool.query("SELECT to_regclass('je07_rolled_back') AS x"))
        .rows[0].x,
    ).toBeNull();
  });
  it("recovers a lost owner commit ACK without creating a second generation", async () => {
    const worker = "12345678-1234-1234-1234-123456789012";
    lost = true;
    await expect(
      claimExecutionWorker(pool, "a".repeat(40), worker),
    ).rejects.toThrow("lost commit");
    expect(
      (await claimExecutionWorker(pool, "a".repeat(40), worker)).generation,
    ).toBe("1");
  });
  it("never extends an already expired same-owner lease", async () => {
    const a = await claimExecutionWorker(pool, "a".repeat(40));
    await releaseExecutionWorker(pool, a);
    await expect(
      executionFencedPool(pool, a).transaction((tx) => tx.query("SELECT 1")),
    ).rejects.toThrow("FENCED");
  });
  it("keeps owner history immutable", async () => {
    await claimExecutionWorker(pool, "a".repeat(40));
    await expect(
      f.pool.query("DELETE FROM execution_worker_owners"),
    ).rejects.toThrow("IMMUTABLE");
  });
});
