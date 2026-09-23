import type { DatabasePool, SqlExecutor } from "../database.js";
import { canonicalFingerprint } from "../trading/replay.js";
import {
  BTC_RETENTION_POLICY as policy,
  validateRetentionObject,
  assertEvidenceJson,
  type RetentionObject,
} from "../trading/retention.js";

type StorePool = Pick<DatabasePool, "transaction">;
async function locked<T>(
  pool: StorePool,
  run: (tx: SqlExecutor) => Promise<T>,
): Promise<T> {
  return pool.transaction(async (tx) => {
    await tx.query("SET LOCAL statement_timeout = '5s'");
    await tx.query("SET LOCAL lock_timeout = '2s'");
    await tx.query("SET LOCAL TIME ZONE 'UTC'");
    await tx.query("SELECT pg_advisory_xact_lock(741044, 4)");
    return run(tx);
  });
}
async function capacity(tx: SqlExecutor) {
  const result = await tx.query<{
    policy_version: string;
    hold: boolean;
    raw_bytes: string;
    total_bytes: string;
    raw_quota_bytes: string;
    total_quota_bytes: string;
    allocated_bytes: string;
  }>(
    `SELECT policy_version, hold, raw_bytes::text, total_bytes::text,
      raw_quota_bytes::text, total_quota_bytes::text,
      (pg_total_relation_size('btc_retention_objects') + pg_total_relation_size('btc_retention_dependencies')
        + pg_total_relation_size('btc_retention_pins'))::text AS allocated_bytes
      FROM btc_retention_policy WHERE dataset_id = $1`,
    [policy.datasetId],
  );
  const row = result.rows[0];
  if (!row || row.policy_version !== policy.version)
    throw new Error("BTC_RETENTION_POLICY_MISMATCH");
  return {
    ...row,
    nonessentialBlocked:
      BigInt(row.raw_bytes) >= BigInt(row.raw_quota_bytes) ||
      BigInt(row.total_bytes) >= BigInt(row.total_quota_bytes) ||
      BigInt(row.allocated_bytes) >= 14n * 1024n ** 3n,
  };
}
export async function retentionCapacity(pool: StorePool) {
  return locked(pool, capacity);
}
/** Capacity failures roll back the whole capture. Callers must mark a gap/stop
 * admission; never silently truncate payload, skip dependencies or retry as financial. */
export async function storeRetentionObject(
  pool: StorePool,
  object: RetentionObject,
): Promise<{
  status: "stored" | "duplicate";
  chargedBytes: string;
  nonessentialBlocked: boolean;
}> {
  validateRetentionObject(object);
  assertEvidenceJson(object.payload);
  assertEvidenceJson(object.identity);
  // JSON serialization has been checked for lossy values before the transaction.
  const payload = JSON.parse(JSON.stringify(object.payload)) as unknown;
  const dependencies = [...object.dependencies].sort();
  return locked(pool, async (tx) => {
    const prior = await tx.query(
      `SELECT class, identity, recorded_at, payload, dependencies, charged_bytes::text
      FROM btc_retention_objects WHERE object_id = $1`,
      [object.id],
    );
    const row = prior.rows[0];
    if (row) {
      if (
        row.class !== object.class ||
        new Date(row.recorded_at).getTime() !== object.recordedAt.getTime() ||
        canonicalFingerprint(row.identity) !==
          canonicalFingerprint(object.identity) ||
        canonicalFingerprint(row.payload) !== canonicalFingerprint(payload) ||
        canonicalFingerprint(row.dependencies) !==
          canonicalFingerprint(dependencies)
      ) {
        throw new Error("BTC_RETENTION_IDEMPOTENCY_CONFLICT");
      }
      return {
        status: "duplicate",
        chargedBytes: row.charged_bytes as string,
        nonessentialBlocked: (await capacity(tx)).nonessentialBlocked,
      };
    }
    const result = await tx.query(
      `INSERT INTO btc_retention_objects
      (object_id, dataset_id, policy_version, class, identity, recorded_at, payload, dependencies, charged_bytes)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8::text[],1) RETURNING charged_bytes::text`,
      [
        object.id,
        policy.datasetId,
        policy.version,
        object.class,
        JSON.stringify(object.identity),
        object.recordedAt,
        JSON.stringify(payload),
        dependencies,
      ],
    );
    return {
      status: "stored",
      chargedBytes: result.rows[0]!.charged_bytes as string,
      nonessentialBlocked: (await capacity(tx)).nonessentialBlocked,
    };
  });
}
/** Pins are permanent in v1. Releasing evidence requires a future explicit procedure. */
export async function pinRetentionObject(
  pool: StorePool,
  pinId: string,
  objectId: string,
  reason: string,
) {
  return locked(pool, async (tx) => {
    const prior = await tx.query(
      "SELECT object_id, reason FROM btc_retention_pins WHERE pin_id = $1",
      [pinId],
    );
    if (prior.rows[0]) {
      if (
        prior.rows[0].object_id !== objectId ||
        prior.rows[0].reason !== reason
      )
        throw new Error("BTC_RETENTION_PIN_CONFLICT");
      return;
    }
    await tx.query(
      "INSERT INTO btc_retention_pins(pin_id, object_id, reason) VALUES ($1,$2,$3)",
      [pinId, objectId, reason],
    );
  });
}
const candidates = `WITH RECURSIVE protected(object_id) AS (
    SELECT object_id FROM btc_retention_objects WHERE expires_at IS NULL
    UNION
    SELECT object_id FROM btc_retention_pins
    UNION
    SELECT d.dependency_id FROM btc_retention_dependencies d JOIN protected p ON p.object_id = d.object_id
  ) SELECT o.object_id, o.class, o.charged_bytes::text FROM btc_retention_objects o
  JOIN btc_retention_policy p ON p.dataset_id = o.dataset_id
  WHERE o.dataset_id = $1 AND o.policy_version = $2 AND NOT p.hold
    AND o.expires_at <= clock_timestamp() AND NOT EXISTS (SELECT 1 FROM protected x WHERE x.object_id = o.object_id)
    AND NOT EXISTS (SELECT 1 FROM btc_retention_dependencies d WHERE d.dependency_id = o.object_id)
  ORDER BY o.expires_at, o.object_id LIMIT $3`;
/** One leaf batch only. Incoming edges preserve transitive evidence, including
 * unexpired aggregates. Repeating the executor can remove newly unreferenced leaves. */
export async function retainBtcBatch(
  pool: StorePool,
  options: {
    readonly datasetId: string;
    readonly policyVersion: string;
    readonly limit: number;
    readonly execute: boolean;
  },
) {
  if (
    options.datasetId !== policy.datasetId ||
    options.policyVersion !== policy.version ||
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > policy.maxBatch
  ) {
    throw new Error("BTC_RETENTION_SCOPE_REFUSED");
  }
  return locked(pool, async (tx) => {
    const selected = await tx.query(candidates, [
      options.datasetId,
      options.policyVersion,
      options.limit,
    ]);
    if (options.execute && selected.rows.length) {
      await tx.query(
        "SELECT set_config('ganso.btc_retention_policy', $1, true)",
        [policy.version],
      );
      await tx.query(
        "DELETE FROM btc_retention_objects WHERE object_id = ANY($1::text[])",
        [selected.rows.map((row) => row.object_id)],
      );
    }
    return {
      policyVersion: policy.version,
      executed: options.execute,
      objects: selected.rows,
    };
  });
}
