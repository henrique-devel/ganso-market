// DATA-02: one bounded selection contract. No deletion implementation exists.
// Evidence is held; legacy Solana rows are only candidates for later review.
import { createHash } from "node:crypto";
import type { DatabasePool, SqlExecutor } from "../database.js";
import { RETENTION_TABLES } from "./retention.js";
import {
  EVIDENCE_TABLES,
  getRetentionProtection,
  RESIDUAL_TABLES,
  RETENTION_OBJECTS,
  RETENTION_POLICY_VERSION,
} from "./retention-policy.js";

export interface RetentionManifestRequest {
  readonly tables: readonly string[];
  readonly cutoffUtc: string;
  readonly generatedAtUtc: string;
  readonly gitSha: string;
  readonly validForSeconds?: number;
  readonly limit?: number;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function retentionHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function utc(value: string): string {
  // Millisecond precision for supplied boundaries; database row times preserve
  // microseconds in SQL. Never silently round a user-provided cutoff.
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) {
    throw new Error("RETENTION_FIXED_UTC_REQUIRED");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new Error("RETENTION_INVALID_TIME");
  const normalized = date.toISOString();
  if (normalized !== value && normalized !== value.replace("Z", ".000Z")) {
    throw new Error("RETENTION_INVALID_TIME");
  }
  return normalized;
}

const POLICY_HASH = retentionHash({
  version: RETENTION_POLICY_VERSION,
  evidence: EVIDENCE_TABLES,
  residual: RESIDUAL_TABLES,
  declaredBudgets: RETENTION_TABLES,
  executionAllowed: false,
  pins: "whole_table",
});

interface CatalogTable {
  name: string;
  keys: string[];
  columns: unknown;
  constraints: unknown;
  triggers: {
    name: string;
    enabled: string;
    type: number;
    function: string;
    definition: string;
  }[];
}

// Catalog-only: no COUNT over live evidence and no relation-size/reltuples
// estimates in the schema hash. ANALYZE can change estimated counts in the full
// manifest body, but cannot change schemaHash by itself.
const CATALOG_SQL = `SELECT c.relname AS name,
  COALESCE((SELECT array_agg(a.attname::text ORDER BY k.ordinality)
    FROM pg_constraint p CROSS JOIN LATERAL unnest(p.conkey) WITH ORDINALITY k(attnum, ordinality)
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
    WHERE p.conrelid = c.oid AND p.contype = 'p'), ARRAY[]::text[]) AS keys,
  (SELECT jsonb_agg(jsonb_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
      'notNull', a.attnotnull, 'collation', a.attcollation::text) ORDER BY a.attnum)
    FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
  (SELECT jsonb_agg(pg_get_constraintdef(p.oid) ORDER BY p.conname)
    FROM pg_constraint p WHERE p.conrelid = c.oid OR p.confrelid = c.oid) AS constraints,
  (SELECT jsonb_agg(jsonb_build_object('definition', pg_get_indexdef(i.indexrelid),
      'valid', i.indisvalid, 'ready', i.indisready) ORDER BY ci.relname)
    FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid WHERE i.indrelid = c.oid) AS indexes,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('name', t.tgname, 'enabled', t.tgenabled,
      'type', t.tgtype, 'function', p.proname, 'definition', pg_get_triggerdef(t.oid)) ORDER BY t.tgname)
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = c.oid AND NOT t.tgisinternal), '[]'::jsonb) AS triggers
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relname = ANY($1::text[])
    AND c.relkind = 'r' ORDER BY c.relname`;

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export interface RetentionCandidate {
  readonly key: string;
  readonly timestampUtc: string;
  readonly rowHash: string;
  readonly logicalRowBytes: number;
}

export interface RetentionSelection {
  readonly table: string;
  readonly disposition: "held" | "review_only";
  readonly reason: string;
  readonly stableKey: readonly string[];
  readonly watermark: string | null;
  readonly predicate: {
    readonly sql: string;
    readonly parameters: readonly unknown[];
  };
  readonly inspectionQuery: {
    readonly sql: string;
    readonly parameters: readonly unknown[];
  } | null;
  readonly inspectedRows: number;
  readonly candidateCount: {
    readonly value: number;
    readonly exact: true;
    readonly scope: "bounded_primary_key_slice" | "policy_empty_set";
  };
  readonly entireCutoffCount: number | null;
  readonly hasMore: boolean;
  readonly candidates: readonly RetentionCandidate[];
  readonly pins: readonly Record<string, unknown>[];
  readonly declaredTtlDays: number | null;
  readonly declaredQuotaBytes: number | null;
  readonly effectiveTtlDays: null;
  readonly quotaCanOverrideProtection: false;
  readonly bytes: {
    readonly candidateLogicalRows: number;
    readonly recoverablePhysical: null;
    readonly tableRowsEstimate: number | null;
  };
  readonly invariants: readonly string[];
}

// The only row selector: scans at most limit+1 primary-key entries BEFORE any
// time filter. A sparse cutoff therefore cannot turn into an unbounded scan.
// Future consumers must use this result and revalidate in the same locked txn;
// DATA-02 grants no executable set, even for residual review candidates.
export async function selectRetentionCandidates(
  tx: SqlExecutor,
  schema: string,
  table: string,
  keys: readonly string[],
  cutoffUtc: string,
  limit: number,
): Promise<RetentionSelection> {
  const policy = getRetentionProtection(table);
  const config = RETENTION_TABLES.find((entry) => entry.table === table);
  const pins = await tx.query<Record<string, unknown>>(
    `SELECT to_jsonb(p) AS pin FROM ${identifier(schema)}.retention_evidence_pins p
     WHERE table_name = $1 ORDER BY pin_id LIMIT 1001`,
    [table],
  );
  if (pins.rows.length > 1000) throw new Error("RETENTION_PIN_BUDGET_EXCEEDED");
  const pinValues = pins.rows.map(
    (row) => row["pin"] as Record<string, unknown>,
  );
  const common = {
    table,
    reason: policy.reason,
    stableKey: keys,
    pins: pinValues,
    declaredTtlDays: config?.ttlDays ?? null,
    declaredQuotaBytes: config?.quotaBytes ?? null,
    effectiveTtlDays: null,
    quotaCanOverrideProtection: false,
    invariants: [
      "DELETE_AND_TRUNCATE_DENIED_IN_DATABASE",
      "ECONOMY_OPEN_POSITIONS_LOGICAL_REFERENCES_AND_RAW_HELD",
      "UNKNOWN_HORIZON_AND_L2_ANCHOR_BLOCK_RELEASE",
      "PINS_AND_REFERENCE_WRITERS_COORDINATED_UNTIL_COMMIT",
      "AGGREGATE_OR_REPORT_IS_NOT_RAW_EVIDENCE",
    ],
  } as const;
  if (policy.protected || pins.rows.length > 0) {
    return {
      ...common,
      disposition: "held",
      reason: pins.rows.length > 0 ? "DATASET_PIN" : policy.reason,
      watermark: null,
      predicate: { sql: "FALSE", parameters: [] },
      inspectionQuery: null,
      inspectedRows: 0,
      candidateCount: { value: 0, exact: true, scope: "policy_empty_set" },
      entireCutoffCount: 0,
      hasMore: false,
      candidates: [],
      bytes: {
        candidateLogicalRows: 0,
        recoverablePhysical: null,
        tableRowsEstimate: null,
      },
    };
  }
  const residual = RESIDUAL_TABLES[table as keyof typeof RESIDUAL_TABLES];
  if (!residual || keys.length !== 1 || keys[0] !== residual.key) {
    throw new Error("RETENTION_STABLE_KEY_DRIFT");
  }
  const qualified = `${identifier(schema)}.${identifier(table)}`;
  const key = identifier(residual.key);
  const time = identifier(residual.time);
  const upper = await tx.query<{ key: string }>(
    `SELECT ${key}::text AS key FROM ${qualified} ORDER BY ${key} DESC LIMIT 1`,
  );
  const watermark = upper.rows[0]?.key ?? null;
  const sql = `WITH bounded AS MATERIALIZED (
    SELECT r.*, pg_column_size(r)::integer AS original_row_bytes, ${key} AS stable_key FROM ${qualified} r
    WHERE ${key} <= $1::${residual.keyType} ORDER BY ${key} ASC LIMIT $3
  ) SELECT stable_key::text AS key,
    to_char(${time} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS timestamp_utc,
    (${time} < $2::timestamptz) AS before_cutoff,
    (to_jsonb(bounded) - 'stable_key' - 'original_row_bytes')::text AS row_value,
    original_row_bytes AS logical_bytes
    FROM bounded ORDER BY stable_key ASC`;
  const parameters = [watermark, cutoffUtc, limit + 1];
  const rows = await tx.query<{
    key: string;
    timestamp_utc: string;
    before_cutoff: boolean;
    row_value: string;
    logical_bytes: number;
  }>(sql, parameters);
  const inspected = rows.rows.slice(0, limit);
  const candidates = inspected
    .filter((row) => row.before_cutoff)
    .map((row) => ({
      key: row.key,
      timestampUtc: row.timestamp_utc,
      rowHash: retentionHash(row.row_value),
      logicalRowBytes: row.logical_bytes,
    }));
  const stats = await tx.query<{ estimate: number }>(
    `SELECT reltuples::float8 AS estimate FROM pg_class WHERE oid = $1::regclass`,
    [qualified],
  );
  const estimate = stats.rows[0]?.estimate;
  const hasMore = rows.rows.length > limit;
  return {
    ...common,
    disposition: "review_only",
    watermark,
    inspectionQuery: { sql, parameters },
    predicate: {
      sql: `SELECT ${key}::text AS key FROM ${qualified}
        WHERE ${key} = ANY($1::${residual.keyType}[]) AND ${time} < $2::timestamptz
          AND ${key} <= $3::${residual.keyType}
          AND NOT EXISTS (SELECT 1 FROM ${identifier(schema)}.retention_evidence_pins WHERE table_name = $4)
        ORDER BY ${key} ASC`,
      parameters: [
        candidates.map((row) => row.key),
        cutoffUtc,
        watermark,
        table,
      ],
    },
    inspectedRows: inspected.length,
    candidateCount: {
      value: candidates.length,
      exact: true,
      scope: "bounded_primary_key_slice",
    },
    entireCutoffCount: hasMore ? null : candidates.length,
    hasMore,
    candidates,
    bytes: {
      candidateLogicalRows: candidates.reduce(
        (sum, row) => sum + row.logicalRowBytes,
        0,
      ),
      recoverablePhysical: null,
      tableRowsEstimate:
        estimate !== undefined && estimate >= 0 ? estimate : null,
    },
  };
}

export async function createRetentionDryRun(
  pool: Pick<DatabasePool, "transaction">,
  request: RetentionManifestRequest,
) {
  const cutoffUtc = utc(request.cutoffUtc);
  const generatedAtUtc = utc(request.generatedAtUtc);
  const limit = request.limit ?? 100;
  const validity = request.validForSeconds ?? 900;
  if (!/^[a-f0-9]{40}$/.test(request.gitSha))
    throw new Error("RETENTION_SHA_REQUIRED");
  if (cutoffUtc > generatedAtUtc) throw new Error("RETENTION_FUTURE_CUTOFF");
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isSafeInteger(validity) ||
    validity < 1 ||
    validity > 900
  ) {
    throw new Error("RETENTION_BUDGET_INVALID");
  }
  if (
    request.tables.length < 1 ||
    request.tables.length > 4 ||
    new Set(request.tables).size !== request.tables.length ||
    request.tables.some((table) => !RETENTION_OBJECTS.includes(table))
  ) {
    throw new Error("RETENTION_EXPLICIT_ALLOWLIST_REQUIRED");
  }
  const objects = [...request.tables].sort();
  return pool.transaction(async (tx) => {
    // READ COMMITTED deliberately takes its first data snapshot AFTER acquiring
    // the lock. Repeatable-read before a waiting lock could preserve stale pins.
    await tx.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ ONLY");
    await tx.query("SET LOCAL statement_timeout = '500ms'");
    await tx.query("SET LOCAL lock_timeout = '100ms'");
    await tx.query("SET LOCAL transaction_timeout = '2s'");
    await tx.query("SET LOCAL TIME ZONE 'UTC'");
    await tx.query("SELECT retention_evidence_lock()");
    const meta = await tx.query<{
      schema: string;
      policy: string;
      tables: string[];
    }>(
      "SELECT current_schema() AS schema, retention_evidence_policy_version() AS policy, retention_evidence_tables() AS tables",
    );
    const metadata = meta.rows[0];
    if (
      !metadata ||
      metadata.policy !== RETENTION_POLICY_VERSION ||
      canonical([...metadata.tables].sort()) !== canonical(RETENTION_OBJECTS)
    ) {
      throw new Error("RETENTION_SCHEMA_POLICY_DRIFT");
    }
    const catalog = await tx.query<CatalogTable & Record<string, unknown>>(
      CATALOG_SQL,
      [
        [
          ...RETENTION_OBJECTS,
          "retention_evidence_pins",
          "retention_pin_events",
        ],
      ],
    );
    for (const table of RETENTION_OBJECTS) {
      const entry = catalog.rows.find((row) => row.name === table);
      for (const [name, type, fn] of [
        [
          "retention_evidence_write_lock_trg",
          22,
          "retention_evidence_writer_lock",
        ],
        [
          "retention_evidence_delete_guard_trg",
          42,
          "retention_evidence_delete_guard",
        ],
      ] as const) {
        if (
          !entry?.triggers.some(
            (trigger) =>
              trigger.name === name &&
              ["O", "A"].includes(trigger.enabled) &&
              trigger.type === type &&
              trigger.function === fn,
          )
        ) {
          throw new Error(`RETENTION_PROTECTION_NOT_APPLIED:${table}:${name}`);
        }
      }
    }
    for (const [table, name, type, fn] of [
      [
        "retention_evidence_pins",
        "retention_evidence_pins_lock_trg",
        62,
        "retention_evidence_pins_lock",
      ],
      [
        "retention_evidence_pins",
        "retention_evidence_pins_audit_trg",
        13,
        "retention_evidence_pins_audit",
      ],
      [
        "retention_pin_events",
        "retention_pin_events_guard_trg",
        58,
        "retention_evidence_delete_guard",
      ],
    ] as const) {
      const entry = catalog.rows.find((row) => row.name === table);
      if (
        !entry?.triggers.some(
          (trigger) =>
            trigger.name === name &&
            ["O", "A"].includes(trigger.enabled) &&
            trigger.type === type &&
            trigger.function === fn,
        )
      ) {
        throw new Error(`RETENTION_PROTECTION_NOT_APPLIED:${table}:${name}`);
      }
    }
    const functions = await tx.query(
      `SELECT p.proname, pg_get_functiondef(p.oid) AS definition FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = current_schema()
       AND p.proname LIKE 'retention\\_%' ESCAPE '\\' ORDER BY p.proname, p.oid`,
    );
    const migrations = await tx.query(
      "SELECT component, version, checksum_sha256 FROM schema_versions ORDER BY component, version",
    );
    if (
      !migrations.rows.some(
        (row) => row["component"] === "foundation" && row["version"] === 23,
      )
    ) {
      throw new Error("RETENTION_MIGRATION_23_REQUIRED");
    }
    const selections: RetentionSelection[] = [];
    for (const table of objects) {
      const entry = catalog.rows.find((row) => row.name === table);
      if (!entry?.keys.length) throw new Error("RETENTION_STABLE_KEY_MISSING");
      selections.push(
        await selectRetentionCandidates(
          tx,
          metadata.schema,
          table,
          entry.keys,
          cutoffUtc,
          limit,
        ),
      );
    }
    const body = {
      formatVersion: "data-02-manifest-v1",
      policyVersion: RETENTION_POLICY_VERSION,
      policyHash: POLICY_HASH,
      gitSha: request.gitSha,
      schema: metadata.schema,
      schemaHash: retentionHash({
        catalog: catalog.rows,
        functions: functions.rows,
        migrations: migrations.rows,
      }),
      schemaVersions: migrations.rows,
      generatedAtUtc,
      expiresAtUtc: new Date(
        Date.parse(generatedAtUtc) + validity * 1000,
      ).toISOString(),
      cutoffUtc,
      allowlist: objects,
      primaryKeySliceLimit: limit,
      isolation: "read_committed_after_exclusive_transaction_lock",
      executionAllowed: false,
      executionBlockers: [
        "DATA_02_DRY_RUN_ONLY",
        "NO_EXPORT_RESTORE_OR_DELETION_APPROVAL",
        "RAW_HORIZON_AND_DATASET_CLOSURE_UNRESOLVED",
      ],
      selections,
    } as const;
    const hash = retentionHash(body);
    return freeze({ id: `sha256:${hash}`, hash, ...body });
  });
}

export type RetentionManifest = Awaited<
  ReturnType<typeof createRetentionDryRun>
>;

/** Integrity/validity check only, NEVER an execution grant. */
export function verifyRetentionManifest(
  manifest: RetentionManifest,
  now: Date,
): void {
  const { id, hash, ...body } = manifest;
  if (retentionHash(body) !== hash || id !== `sha256:${hash}`)
    throw new Error("RETENTION_MANIFEST_HASH_MISMATCH");
  if (
    manifest.policyVersion !== RETENTION_POLICY_VERSION ||
    manifest.policyHash !== POLICY_HASH
  ) {
    throw new Error("RETENTION_MANIFEST_POLICY_DRIFT");
  }
  const generated = utc(manifest.generatedAtUtc);
  const expires = utc(manifest.expiresAtUtc);
  const cutoff = utc(manifest.cutoffUtc);
  if (
    manifest.formatVersion !== "data-02-manifest-v1" ||
    cutoff > generated ||
    expires <= generated ||
    Date.parse(expires) - Date.parse(generated) > 900_000
  ) {
    throw new Error("RETENTION_MANIFEST_VALIDITY_INVALID");
  }
  if (
    !Number.isFinite(now.getTime()) ||
    now.getTime() < Date.parse(manifest.generatedAtUtc) ||
    now.getTime() >= Date.parse(manifest.expiresAtUtc)
  )
    throw new Error("RETENTION_MANIFEST_EXPIRED_OR_FUTURE");
  if (manifest.executionAllowed !== false)
    throw new Error("RETENTION_MANIFEST_NOT_EXECUTABLE");
}
