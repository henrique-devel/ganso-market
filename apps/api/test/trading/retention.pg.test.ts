import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlExecutor } from "../../src/database.js";
import { createPgFixture } from "../pg-fixture.js";
import {
  BTC_RETENTION_POLICY as policy,
  type RetentionObject,
} from "../../src/trading/retention.js";
import {
  pinRetentionObject,
  retainBtcBatch,
  retentionCapacity,
  storeRetentionObject,
} from "../../src/storage/btc-retention.js";

const url = process.env.GANSO_TEST_DATABASE_URL;
let fixture: Awaited<ReturnType<typeof createPgFixture>>;
const pool = {
  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await fixture.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await run({
        async query(text, params) {
          const result = await client.query(text, params ? [...params] : []);
          return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        },
      });
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
const identity = {
  mode: "paper",
  instrument_id: "hyperliquid:BTC",
  instrument_version: "v1",
  account_id: "paper",
  experiment_id: "fixture",
} as const;
function object(
  id: string,
  kind: RetentionObject["class"] = "raw",
  dependencies: string[] = [],
  age = 800,
): RetentionObject {
  return {
    id,
    class: kind,
    identity,
    recordedAt: new Date(Date.now() - age * 86_400_000),
    payload: { value: "complete-evidence" },
    dependencies,
  };
}
const options = {
  datasetId: policy.datasetId,
  policyVersion: policy.version,
  limit: 500,
  execute: true,
};
async function releaseHold() {
  await fixture.pool.query("UPDATE btc_retention_policy SET hold = false");
}
async function ids() {
  return (
    await fixture.pool.query(
      "SELECT object_id FROM btc_retention_objects ORDER BY object_id",
    )
  ).rows.map((r) => r.object_id);
}

describe.skipIf(!url)("new BTC retention on real PostgreSQL", () => {
  beforeEach(async () => {
    fixture = await createPgFixture(url);
  });
  afterEach(async () => {
    await fixture?.dispose();
  });

  it("validates a full 36,865-input bar inside the existing SQL write budget", async () => {
    // Worst permitted builder fan-in: 32,768 trades + 4,096 captures + metadata.
    // Realistic incompressible event IDs expose repeated array detoasting/scanning.
    const size = 36_865;
    for (let start = 0; start < size; start += 1000) {
      await fixture.pool.query(
        `INSERT INTO btc_retention_objects
        (object_id,dataset_id,policy_version,class,identity,recorded_at,payload,charged_bytes)
        SELECT 'fixture:event:' || md5(i::text) || md5(('second:' || i)::text),
          'btc-paper-v1','btc-retention-v1','raw',$1,clock_timestamp(),'{}',1
        FROM generate_series($2::int,$3::int) i`,
        [identity, start, Math.min(start + 999, size - 1)],
      );
    }
    const dependencies = (
      await fixture.pool.query(
        "SELECT object_id FROM btc_retention_objects ORDER BY object_id",
      )
    ).rows.map((r) => r.object_id as string);
    // Production statistics mostly see raw envelopes with 0/1 edges. Analyze
    // that distribution: a missing-stats fixture hides the nested anti-join
    // chosen for the rare large array (estimated as a single declared edge).
    await fixture.pool.query("ANALYZE btc_retention_objects");
    const before = await retentionCapacity(pool);
    const started = performance.now();
    // storeRetentionObject sets the unchanged server statement_timeout='5s'.
    const result = await storeRetentionObject(pool, {
      ...object("large-bar", "bar", dependencies),
      payload: { input_ids: dependencies, source: "disposable-fan-in-fixture" },
    });
    console.info(
      `retention large-bar: inputs=${size}, elapsed_ms=${Math.round(performance.now() - started)}`,
    );
    expect(result.status).toBe("stored");
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int n FROM btc_retention_dependencies WHERE object_id='large-bar'",
        )
      ).rows[0]!.n,
    ).toBe(size);
    expect(
      BigInt((await retentionCapacity(pool)).total_bytes) -
        BigInt(before.total_bytes),
    ).toBe(BigInt(result.chargedBytes));
    expect(
      (
        await storeRetentionObject(pool, {
          ...object("large-bar", "bar", dependencies),
          // The exact retry timestamp is taken from the immutable committed envelope.
          recordedAt: (
            await fixture.pool.query(
              "SELECT recorded_at FROM btc_retention_objects WHERE object_id='large-bar'",
            )
          ).rows[0]!.recorded_at,
          payload: {
            input_ids: dependencies,
            source: "disposable-fan-in-fixture",
          },
        })
      ).status,
    ).toBe("duplicate");
    await expect(
      fixture.pool.query(
        "DELETE FROM btc_retention_dependencies WHERE object_id='large-bar'",
      ),
    ).rejects.toThrow("IMMUTABLE");
  }, 30_000);
  it("checks each owner's declared edges in multi-row inserts without allowing forged links", async () => {
    await storeRetentionObject(pool, object("a"));
    await storeRetentionObject(pool, object("b"));
    await storeRetentionObject(pool, object("pa", "bar", ["a"]));
    await storeRetentionObject(pool, object("pb", "bar", ["b"]));
    const before = await retentionCapacity(pool);
    await expect(
      fixture.pool.query(
        "INSERT INTO btc_retention_dependencies(object_id,dependency_id) VALUES('pa','b'),('pb','a')",
      ),
    ).rejects.toThrow("UNKNOWN_DEPENDENCY");
    expect(
      (
        await fixture.pool.query(
          "SELECT object_id,dependency_id FROM btc_retention_dependencies ORDER BY object_id",
        )
      ).rows,
    ).toEqual([
      { object_id: "pa", dependency_id: "a" },
      { object_id: "pb", dependency_id: "b" },
    ]);
    await fixture.pool.query(
      "INSERT INTO btc_retention_dependencies(object_id,dependency_id) VALUES('pa','a') ON CONFLICT DO NOTHING",
    );
    expect((await retentionCapacity(pool)).total_bytes).toBe(
      before.total_bytes,
    );
  });

  it("starts empty with versioned defaults and HOLD, preserving all rows until explicit release", async () => {
    expect(await retentionCapacity(pool)).toMatchObject({
      policy_version: policy.version,
      hold: true,
      raw_quota_bytes: "10737418240",
      total_quota_bytes: "12884901888",
    });
    await storeRetentionObject(pool, object("held"));
    expect((await retainBtcBatch(pool, options)).objects).toHaveLength(0);
    expect(await ids()).toEqual(["held"]);
  });
  it("pins the transitive raw/anchor closure and repeats pins idempotently", async () => {
    await storeRetentionObject(pool, object("anchor"));
    await storeRetentionObject(pool, object("delta", "raw", ["anchor"]));
    await storeRetentionObject(pool, object("dataset", "bar", ["delta"]));
    await pinRetentionObject(pool, "replay", "dataset", "research evidence");
    await pinRetentionObject(pool, "replay", "dataset", "research evidence");
    await expect(
      pinRetentionObject(pool, "replay", "delta", "research evidence"),
    ).rejects.toThrow("PIN_CONFLICT");
    await releaseHold();
    expect((await retainBtcBatch(pool, options)).objects).toHaveLength(0);
    await expect(
      fixture.pool.query("DELETE FROM btc_retention_pins"),
    ).rejects.toThrow("IMMUTABLE");
    await expect(
      fixture.pool.query("DELETE FROM btc_retention_dependencies"),
    ).rejects.toThrow("IMMUTABLE");
    expect(await ids()).toEqual(["anchor", "dataset", "delta"]);
  });
  it("preserves decisions and financial dependencies regardless of age or quota", async () => {
    await storeRetentionObject(pool, object("raw"));
    await storeRetentionObject(pool, object("decision", "decision", ["raw"]));
    await fixture.pool.query(
      "UPDATE btc_retention_policy SET total_quota_bytes = 1",
    );
    await storeRetentionObject(
      pool,
      object("ledger", "financial", ["decision"]),
    );
    expect((await retentionCapacity(pool)).nonessentialBlocked).toBe(true);
    await releaseHold();
    expect((await retainBtcBatch(pool, options)).objects).toHaveLength(0);
    await expect(
      pool.transaction(async (tx) => {
        await tx.query(
          "SELECT set_config('ganso.btc_retention_policy', $1, true)",
          [policy.version],
        );
        await tx.query(
          "DELETE FROM btc_retention_objects WHERE object_id = 'ledger'",
        );
      }),
    ).rejects.toThrow("PROTECTED");
    expect(await ids()).toEqual(["decision", "ledger", "raw"]);
  });
  it("prunes only expired leaves in a bounded batch; dry run and repetition are safe", async () => {
    await storeRetentionObject(pool, object("raw"));
    await storeRetentionObject(pool, object("bar", "bar", ["raw"]));
    await storeRetentionObject(pool, object("log", "log"));
    await storeRetentionObject(pool, object("fresh", "raw", [], 1));
    await releaseHold();
    const dry = await retainBtcBatch(pool, {
      ...options,
      execute: false,
      limit: 1,
    });
    expect(dry.objects).toHaveLength(1);
    expect(await ids()).toHaveLength(4);
    expect(
      (await retainBtcBatch(pool, { ...options, limit: 1 })).objects,
    ).toEqual(dry.objects);
    for (let i = 0; i < 3; i++) await retainBtcBatch(pool, options);
    expect(await ids()).toEqual(["fresh"]);
    expect((await retainBtcBatch(pool, options)).objects).toEqual([]);
    const count = await fixture.pool.query(
      "SELECT sum(charged_bytes)::text AS bytes FROM btc_retention_objects",
    );
    expect((await retentionCapacity(pool)).total_bytes).toBe(
      count.rows[0]!.bytes,
    );
  });
  it("keeps unexpired bar evidence and applies UTC calendar months including leap day", async () => {
    await storeRetentionObject(pool, object("raw"));
    await storeRetentionObject(pool, object("bar", "bar", ["raw"], 1));
    await storeRetentionObject(pool, {
      ...object("leap", "bar"),
      recordedAt: new Date("2024-02-29T12:00:00Z"),
    });
    await releaseHold();
    const row = await fixture.pool.query(
      "SELECT expires_at FROM btc_retention_objects WHERE object_id='leap'",
    );
    expect(row.rows[0]!.expires_at.toISOString()).toBe(
      "2025-02-28T12:00:00.000Z",
    );
    await retainBtcBatch(pool, options);
    expect(await ids()).toEqual(["bar", "raw"]);
  });
  it("refuses a whole oversized capture and new experiment without dropping pins", async () => {
    const item = object("pinned");
    await storeRetentionObject(pool, item);
    await pinRetentionObject(pool, "keep", item.id, "pin wins quota");
    await fixture.pool.query(
      "UPDATE btc_retention_policy SET raw_quota_bytes = raw_bytes",
    );
    await expect(
      storeRetentionObject(pool, object("oversize")),
    ).rejects.toThrow("CAPACITY_REFUSED");
    await expect(
      storeRetentionObject(pool, object("new-experiment", "experiment")),
    ).rejects.toThrow("CAPACITY_REFUSED");
    await expect(storeRetentionObject(pool, item)).resolves.toMatchObject({
      status: "duplicate",
    });
    await releaseHold();
    expect((await retainBtcBatch(pool, options)).objects).toEqual([]);
    expect(await ids()).toEqual(["pinned"]);
  });
  it("serializes concurrent admission so only one capture fits", async () => {
    await fixture.pool.query(
      "UPDATE btc_retention_policy SET raw_quota_bytes = 2000",
    );
    const results = await Promise.allSettled([
      storeRetentionObject(pool, object("a")),
      storeRetentionObject(pool, object("b")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await ids()).toHaveLength(1);
    expect(
      BigInt((await retentionCapacity(pool)).raw_bytes),
    ).toBeLessThanOrEqual(2000n);
  });
  it("is idempotent under concurrent retries and rejects changed payload/provenance", async () => {
    const input = object("a");
    const results = await Promise.all([
      storeRetentionObject(pool, input),
      storeRetentionObject(pool, input),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "duplicate",
      "stored",
    ]);
    expect((await retentionCapacity(pool)).raw_bytes).toBe(
      results[0]!.chargedBytes,
    );
    await expect(
      storeRetentionObject(pool, { ...input, payload: { altered: true } }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    await expect(
      storeRetentionObject(pool, {
        ...input,
        identity: { ...identity, instrument_version: "v2" },
      }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  });
  it("rejects missing/cross-instrument evidence atomically without consuming quota", async () => {
    await expect(
      storeRetentionObject(pool, object("bad", "bar", ["absent"])),
    ).rejects.toThrow("MISSING_EVIDENCE");
    await storeRetentionObject(pool, object("btc"));
    await expect(
      storeRetentionObject(pool, {
        ...object("other", "bar", ["btc"]),
        identity: { ...identity, instrument_id: "other" },
      }),
    ).rejects.toThrow("MISSING_EVIDENCE");
    expect(await ids()).toEqual(["btc"]);
  });
  it("rejects unknown scope/version/oversized batches and preserves legacy HOLD triggers", async () => {
    for (const change of [
      { datasetId: "polymarket" },
      { policyVersion: "next" },
      { limit: 501 },
      { limit: 0 },
    ]) {
      await expect(
        retainBtcBatch(pool, { ...options, ...change }),
      ).rejects.toThrow("SCOPE_REFUSED");
    }
    await expect(
      fixture.pool.query("DELETE FROM polymarket_trades"),
    ).rejects.toThrow();
    await expect(
      fixture.pool.query("TRUNCATE btc_retention_objects CASCADE"),
    ).rejects.toThrow("IMMUTABLE");
  });
  it("charges only committed inserts and rejects a multi-row SQL capture atomically", async () => {
    await fixture.pool.query(
      "UPDATE btc_retention_policy SET raw_quota_bytes = 2000",
    );
    const sql = `INSERT INTO btc_retention_objects
      (object_id,dataset_id,policy_version,class,identity,recorded_at,payload,charged_bytes)
      SELECT id,'btc-paper-v1','btc-retention-v1','raw',$1,now(),'{}',1 FROM unnest($2::text[]) id`;
    await expect(
      fixture.pool.query(sql, [identity, ["a", "b"]]),
    ).rejects.toThrow("CAPACITY_REFUSED");
    expect(await ids()).toEqual([]);
    expect((await retentionCapacity(pool)).total_bytes).toBe("0");
    await fixture.pool.query(sql, [identity, ["a"]]);
    const before = await retentionCapacity(pool);
    await fixture.pool.query(sql + " ON CONFLICT DO NOTHING", [
      identity,
      ["a"],
    ]);
    expect((await retentionCapacity(pool)).total_bytes).toBe(
      before.total_bytes,
    );
  });
  it("uses the raw and log TTL boundaries and refuses premature direct pruning", async () => {
    for (const [id, kind, age] of [
      ["raw-young", "raw", 6],
      ["raw-old", "raw", 8],
      ["log-young", "log", 13],
      ["log-old", "log", 15],
    ] as const) {
      await storeRetentionObject(pool, object(id, kind, [], age));
    }
    await releaseHold();
    await expect(
      pool.transaction(async (tx) => {
        await tx.query(
          "SELECT set_config('ganso.btc_retention_policy', $1, true)",
          [policy.version],
        );
        await tx.query(
          "DELETE FROM btc_retention_objects WHERE object_id = 'raw-young'",
        );
      }),
    ).rejects.toThrow("PROTECTED");
    await retainBtcBatch(pool, options);
    expect(await ids()).toEqual(["log-young", "raw-young"]);
  });
  it("guards direct deletes, updates and quota even without the TypeScript adapter", async () => {
    await storeRetentionObject(pool, object("raw"));
    await expect(
      fixture.pool.query("DELETE FROM btc_retention_objects"),
    ).rejects.toThrow("PROTECTED");
    await expect(
      fixture.pool.query("UPDATE btc_retention_objects SET payload = '{}'"),
    ).rejects.toThrow("IMMUTABLE");
    await fixture.pool.query(
      "UPDATE btc_retention_policy SET raw_quota_bytes = raw_bytes",
    );
    await expect(
      fixture.pool.query(
        `INSERT INTO btc_retention_objects
      (object_id,dataset_id,policy_version,class,identity,recorded_at,payload,charged_bytes)
      VALUES ('b','btc-paper-v1','btc-retention-v1','raw',$1,now(),'{}',1)`,
        [identity],
      ),
    ).rejects.toThrow("CAPACITY_REFUSED");
    expect(await ids()).toEqual(["raw"]);
  });
});
