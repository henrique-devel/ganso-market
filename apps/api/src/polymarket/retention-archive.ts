// DATA-03: bounded preservation rehearsal. No deletion or production connection.
import type { DatabasePool, SqlExecutor } from "../database.js";
import {
  type RetentionManifest,
  readRetentionSchema,
  retentionHash,
  selectRetentionCandidates,
  verifyRetentionManifest,
} from "./retention-manifest.js";
import { verifyArchiveReplay } from "./retention-archive-replay.js";
import {
  assertArchiveCapacity,
  DATA03_MAX_ARCHIVE_BYTES,
} from "./retention-archive-storage.js";

type Pool = Pick<DatabasePool, "transaction">;
export type ArchiveProfile = "raw-l2" | "paper-ledger" | "residual";
export interface PreservationPlan {
  formatVersion: "data-03-fixture-plan-v1";
  fixtureOnly: true;
  datasetId: string;
  manifestHash: string;
  profile: ArchiveProfile;
  // Independent explicit row inventory; a DATA-02 HOLD selection supplies none.
  rows: Record<string, { key: string; rowHash: string }[]>;
  historicalCompleteness: "unknown";
}
export interface RestoreCapacity {
  database: string;
  systemIdentifier: string;
  measuredAtUtc: string;
  freeBytes: number;
  totalBytes: number;
  // Measured on the PostgreSQL data volume, including any WAL volume.
  method: "disposable-postgres-volume-df";
}
export interface ArchiveBudget {
  maxBytes: number;
  capacity: RestoreCapacity;
}
interface Identity {
  database: string;
  systemIdentifier: string;
}
const TABLES: Record<string, { key: string; type: "text" | "bigint" }> = {
  polymarket_book_snapshots_full: { key: "snapshot_id", type: "bigint" },
  polymarket_book_deltas: { key: "delta_id", type: "bigint" },
  paper_orders: { key: "order_id", type: "text" },
  paper_ledger_events: { key: "event_id", type: "bigint" },
  paper_positions: { key: "token_id", type: "text" },
  bonding_curve_state: { key: "mint", type: "text" },
  event_quarantine: { key: "quarantine_id", type: "bigint" },
  domain_events: { key: "domain_event_id", type: "bigint" },
  pumpswap_pool_state: { key: "pool", type: "text" },
};
const PROFILES: Record<Exclude<ArchiveProfile, "residual">, string[]> = {
  "raw-l2": ["polymarket_book_deltas", "polymarket_book_snapshots_full"],
  "paper-ledger": ["paper_ledger_events", "paper_orders", "paper_positions"],
};
function fail(reason: string): never {
  throw new Error(`DATA03_${reason}`);
}
const now = () => new Date();
const digest = /^[a-f0-9]{64}$/;

export function validateArchiveEndpoint(
  value: string,
  role: "source" | "restore",
): void {
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !new RegExp(`^/ganso_data03_${role}_[a-z0-9_]+$`).test(url.pathname) ||
    url.search ||
    url.hash ||
    !url.port
  )
    fail("DISPOSABLE_LOCAL_DATABASE_REQUIRED");
}
async function identity(
  tx: SqlExecutor,
  role: "source" | "restore",
): Promise<Identity> {
  const result = await tx.query<{
    database: string;
    system_identifier: string;
    schema: string;
  }>(
    `SELECT current_database() AS database, system_identifier::text,
       current_schema() AS schema FROM pg_control_system()`,
  );
  const row = result.rows[0];
  if (
    !row ||
    !new RegExp(`^ganso_data03_${role}_[a-z0-9_]+$`).test(row.database) ||
    row.schema !== "public"
  )
    fail("DISPOSABLE_DATABASE_IDENTITY");
  return { database: row.database, systemIdentifier: row.system_identifier };
}
async function begin(tx: SqlExecutor, readOnly: boolean): Promise<void> {
  await tx.query(
    `SET TRANSACTION ISOLATION LEVEL READ COMMITTED${readOnly ? ", READ ONLY" : ""}`,
  );
  await tx.query("SET LOCAL statement_timeout = '500ms'");
  await tx.query("SET LOCAL lock_timeout = '100ms'");
  await tx.query("SET LOCAL transaction_timeout = '2s'");
  await tx.query("SET LOCAL TIME ZONE 'UTC'");
  await tx.query("SELECT retention_evidence_lock()");
}
async function schema(
  tx: SqlExecutor,
  manifest: RetentionManifest,
): Promise<void> {
  const { metadata, catalog, functions, migrations } =
    await readRetentionSchema(tx);
  if (
    metadata.schema !== manifest.schema ||
    retentionHash({
      catalog: catalog.rows,
      functions: functions.rows,
      migrations: migrations.rows,
    }) !== manifest.schemaHash
  )
    fail("SCHEMA_DRIFT");
}
function validatePlan(
  manifest: RetentionManifest,
  plan: PreservationPlan,
): string[] {
  verifyRetentionManifest(manifest, now());
  const tables = Object.keys(plan.rows).sort();
  if (
    plan.formatVersion !== "data-03-fixture-plan-v1" ||
    plan.fixtureOnly !== true ||
    plan.historicalCompleteness !== "unknown" ||
    plan.manifestHash !== manifest.hash ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(plan.datasetId) ||
    tables.length < 1 ||
    tables.length > 4 ||
    retentionHash(tables) !== retentionHash(manifest.allowlist)
  )
    fail("EXPLICIT_FIXTURE_PLAN_REQUIRED");
  if (plan.profile === "residual") {
    if (
      manifest.selections.some((s) => s.disposition !== "review_only") ||
      manifest.selections.reduce((n, s) => n + s.candidates.length, 0) === 0
    )
      fail("EMPTY_OR_HELD_MANIFEST");
  } else if (
    !PROFILES[plan.profile] ||
    retentionHash(tables) !== retentionHash(PROFILES[plan.profile])
  ) {
    fail("UNSUPPORTED_CLOSURE_PROFILE");
  }
  for (const table of tables) {
    const info = TABLES[table];
    const rows = plan.rows[table]!;
    const selection = manifest.selections.find((s) => s.table === table);
    if (
      !info ||
      !selection ||
      retentionHash(selection.stableKey) !== retentionHash([info.key]) ||
      rows.length < 1 ||
      rows.length > manifest.primaryKeySliceLimit ||
      rows.length > 1000 ||
      new Set(rows.map((r) => r.key)).size !== rows.length ||
      rows.some(
        (r) =>
          !digest.test(r.rowHash) ||
          typeof r.key !== "string" ||
          !r.key.length ||
          r.key.length > 256 ||
          (info.type === "bigint" && !/^[0-9]{1,19}$/.test(r.key)),
      )
    )
      fail("ROW_BUDGET_OR_KEY_INVALID");
    if (
      plan.profile === "residual" &&
      retentionHash(rows) !==
        retentionHash(
          selection.candidates.map((r) => ({ key: r.key, rowHash: r.rowHash })),
        )
    )
      fail("CANDIDATE_SET_MISMATCH");
  }
  return tables;
}
function capacity(budget: ArchiveBudget, target: Identity): void {
  const c = budget.capacity;
  if (
    !Number.isSafeInteger(budget.maxBytes) ||
    budget.maxBytes < 1024 ||
    budget.maxBytes > DATA03_MAX_ARCHIVE_BYTES ||
    c.database !== target.database ||
    c.systemIdentifier !== target.systemIdentifier ||
    c.method !== "disposable-postgres-volume-df" ||
    !Number.isFinite(Date.parse(c.measuredAtUtc)) ||
    Date.parse(c.measuredAtUtc) > Date.now() ||
    Date.now() - Date.parse(c.measuredAtUtc) > 60_000
  )
    fail("CAPACITY_RECEIPT_INVALID_OR_STALE");
  // Conservative rehearsal ceiling for heap/index/WAL; does not estimate reclaimable bytes.
  assertArchiveCapacity(
    c.freeBytes,
    c.totalBytes,
    budget.maxBytes * 8 + 64 * 1024 * 1024,
  );
}
export async function preflightRestore(
  target: Pool,
  budget: ArchiveBudget,
): Promise<Identity> {
  return target.transaction(async (tx) => {
    await begin(tx, true);
    const id = await identity(tx, "restore");
    capacity(budget, id);
    return id;
  });
}
async function readRows(
  tx: SqlExecutor,
  table: string,
  keys: string[],
  maxBytes: number,
) {
  const info = TABLES[table];
  if (!info) return fail("TABLE_NOT_ALLOWED");
  // Names/types come only from this source allowlist. Never execute manifest SQL.
  const sql = `SELECT "${info.key}"::text AS key, to_jsonb(r)::text AS value
    FROM public."${table}" r WHERE "${info.key}" = ANY($1::${info.type}[])
    ORDER BY "${info.key}" LIMIT 1001`;
  const size = await tx.query<{ bytes: string }>(
    `SELECT COALESCE(sum(octet_length(value)),0)::text AS bytes FROM (${sql}) bounded`,
    [keys],
  );
  if (BigInt(size.rows[0]?.bytes ?? "0") > BigInt(maxBytes))
    fail("ROW_BYTES_BUDGET");
  const result = await tx.query<{ key: string; value: string }>(sql, [keys]);
  if (result.rows.length !== keys.length) fail("PARTIAL_EXPORT");
  return result.rows;
}
function replay(profile: ArchiveProfile, rows: Record<string, string[]>) {
  return profile === "residual"
    ? {
        fixtureOnly: true,
        reconciliation: "exact_residual_rows",
        executionAllowed: false,
      }
    : verifyArchiveReplay(profile, rows);
}
export async function exportRetentionArchive(
  source: Pool,
  target: Pool,
  manifest: RetentionManifest,
  plan: PreservationPlan,
  budget: ArchiveBudget,
) {
  const tables = validatePlan(manifest, plan);
  const targetIdentity = await preflightRestore(target, budget); // before source transfer
  const data = await source.transaction(async (tx) => {
    await begin(tx, true);
    const sourceIdentity = await identity(tx, "source");
    await schema(tx, manifest);
    const rows: Record<string, string[]> = {};
    let used = 0;
    for (const table of tables) {
      const selection = manifest.selections.find((s) => s.table === table)!;
      const selected = await selectRetentionCandidates(
        tx,
        manifest.schema,
        table,
        selection.stableKey,
        manifest.cutoffUtc,
        manifest.primaryKeySliceLimit,
      );
      // Statistics may change; all authoritative set/pin/watermark fields must agree.
      for (const key of [
        "pins",
        "candidates",
        "watermark",
        "predicate",
        "disposition",
      ] as const)
        if (retentionHash(selected[key]) !== retentionHash(selection[key]))
          fail("MANIFEST_SET_DRIFT");
      const actual = await readRows(
        tx,
        table,
        plan.rows[table]!.map((r) => r.key),
        budget.maxBytes - used,
      );
      for (const row of actual) {
        if (
          retentionHash(row.value) !==
          plan.rows[table]!.find((r) => r.key === row.key)?.rowHash
        )
          fail("ROW_DRIFT");
        used += Buffer.byteLength(row.value);
      }
      if (used > budget.maxBytes) fail("ROW_BYTES_BUDGET");
      rows[table] = actual.map((r) => r.value);
    }
    const result = replay(plan.profile, rows);
    verifyRetentionManifest(manifest, now());
    return { sourceIdentity, rows, result };
  });
  const body = {
    formatVersion: "data-03-archive-v1",
    fixtureOnly: true,
    executionAllowed: false,
    manifest,
    plan,
    planHash: retentionHash(plan),
    targetIdentity,
    ...data,
    counts: Object.fromEntries(tables.map((t) => [t, data.rows[t]!.length])),
    rowChecksums: Object.fromEntries(
      tables.map((t) => [t, data.rows[t]!.map(retentionHash)]),
    ),
    generatedAtUtc: now().toISOString(),
    expiresAtUtc: manifest.expiresAtUtc,
    // Rehearsal files expire with this manifest; they are not routine backups.
    expiryRule: "invalid_after_expiry_manual_exact_path_removal_only",
    historicalCompleteness: "unknown",
    sequenceStateRestored: false,
  } as const;
  const archive = { hash: retentionHash(body), ...body };
  if (Buffer.byteLength(JSON.stringify(archive)) + 8192 > budget.maxBytes)
    fail("SERIALIZED_BYTES_BUDGET");
  return archive;
}
export type RetentionArchive = Awaited<
  ReturnType<typeof exportRetentionArchive>
>;
export async function restoreRetentionArchive(
  target: Pool,
  archive: RetentionArchive,
  budget: ArchiveBudget,
  expected: { archiveHash: string; planHash: string; gitSha: string },
) {
  if (
    archive.hash !== expected.archiveHash ||
    archive.planHash !== expected.planHash ||
    archive.manifest.gitSha !== expected.gitSha
  )
    fail("INDEPENDENT_HASH_ANCHOR_MISMATCH");
  const { hash, ...body } = archive;
  if (
    retentionHash(body) !== hash ||
    archive.formatVersion !== "data-03-archive-v1" ||
    archive.fixtureOnly !== true ||
    archive.executionAllowed !== false ||
    archive.planHash !== retentionHash(archive.plan) ||
    archive.expiresAtUtc !== archive.manifest.expiresAtUtc ||
    Buffer.byteLength(JSON.stringify(archive)) + 8192 > budget.maxBytes
  )
    fail("ARCHIVE_CORRUPT_OR_OVERSIZE");
  const tables = validatePlan(archive.manifest, archive.plan);
  if (retentionHash(Object.keys(archive.rows).sort()) !== retentionHash(tables))
    fail("PARTIAL_EXPORT");
  for (const table of tables) {
    const values = archive.rows[table]!;
    if (
      values.length !== archive.plan.rows[table]!.length ||
      archive.counts[table] !== values.length ||
      retentionHash(values.map(retentionHash)) !==
        retentionHash(archive.rowChecksums[table])
    )
      fail("PARTIAL_EXPORT");
  }
  const verified = await target.transaction(async (tx) => {
    await begin(tx, false); // exclusive lock BEFORE any INSERT; held through commit
    const targetIdentity = await identity(tx, "restore");
    if (
      retentionHash(targetIdentity) !== retentionHash(archive.targetIdentity) ||
      retentionHash(targetIdentity) === retentionHash(archive.sourceIdentity)
    )
      fail("RESTORE_TARGET_MISMATCH");
    capacity(budget, targetIdentity);
    await schema(tx, archive.manifest);
    const rows: Record<string, string[]> = {};
    // No SQL from the artifact, DDL, disabled triggers, or source mutation.
    for (const table of tables) {
      const existing = await tx.query(
        `SELECT 1 FROM public."${table}" LIMIT 1`,
      );
      if (existing.rows.length) fail("TARGET_NOT_EMPTY");
      const info = TABLES[table]!;
      const columns = await tx.query<{ name: string }>(
        `SELECT attname::text AS name FROM pg_attribute
        WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`,
        [`public.${table}`],
      );
      const names = columns.rows
        .map((c) => `"${c.name.replaceAll('"', '""')}"`)
        .join(",");
      await tx.query(
        `INSERT INTO public."${table}" (${names}) OVERRIDING SYSTEM VALUE
        SELECT ${names} FROM unnest($1::text[]) value
        CROSS JOIN LATERAL jsonb_populate_record(NULL::public."${table}", value::jsonb) r`,
        [archive.rows[table]],
      );
      const restored = await readRows(
        tx,
        table,
        archive.plan.rows[table]!.map((r) => r.key),
        budget.maxBytes,
      );
      const wanted = new Map(
        archive.plan.rows[table]!.map((r) => [r.key, r.rowHash]),
      );
      if (restored.some((r) => retentionHash(r.value) !== wanted.get(r.key)))
        fail("RESTORED_ROW_MISMATCH");
      const total = await tx.query<{
        n: number;
      }>(`SELECT count(*)::int AS n FROM
        (SELECT "${info.key}" FROM public."${table}" LIMIT 1001) bounded`);
      if (total.rows[0]?.n !== restored.length) fail("RESTORED_COUNT_MISMATCH");
      rows[table] = restored.map((r) => r.value);
    }
    const result = replay(archive.plan.profile, rows);
    if (retentionHash(result) !== retentionHash(archive.result))
      fail("REPLAY_MISMATCH");
    verifyRetentionManifest(archive.manifest, now());
    return { targetIdentity, result };
  });
  // Only after COMMIT. Failure/expiry may leave rehearsal rows, never a certificate.
  verifyRetentionManifest(archive.manifest, now());
  const certificate = {
    formatVersion: "data-03-restore-certificate-v1",
    fixtureOnly: true,
    manifestHash: archive.manifest.hash,
    archiveHash: archive.hash,
    planHash: archive.planHash,
    datasetId: archive.plan.datasetId,
    schemaHash: archive.manifest.schemaHash,
    schemaVersions: archive.manifest.schemaVersions,
    gitSha: archive.manifest.gitSha,
    policyHash: archive.manifest.policyHash,
    cutoffUtc: archive.manifest.cutoffUtc,
    counts: archive.counts,
    rowChecksums: archive.rowChecksums,
    ...verified,
    restoredAtUtc: now().toISOString(),
    expiresAtUtc: archive.expiresAtUtc,
    executionAllowed: false,
    deletionEligibility: false,
    historicalCompleteness: "unknown",
    targetUse: "verification_only_sequences_not_reseeded",
    capacity: budget.capacity,
  } as const;
  return { hash: retentionHash(certificate), ...certificate };
}
export type RestoreCertificate = Awaited<
  ReturnType<typeof restoreRetentionArchive>
>;
export function verifyRestoreCertificate(
  certificate: RestoreCertificate,
  archive: RetentionArchive,
): void {
  const { hash, ...body } = certificate;
  verifyRetentionManifest(archive.manifest, now());
  const { hash: archiveHash, ...archiveBody } = archive;
  if (
    retentionHash(archiveBody) !== archiveHash ||
    retentionHash(body) !== hash ||
    certificate.formatVersion !== "data-03-restore-certificate-v1" ||
    certificate.fixtureOnly !== true ||
    certificate.archiveHash !== archive.hash ||
    certificate.manifestHash !== archive.manifest.hash ||
    certificate.planHash !== archive.planHash ||
    certificate.expiresAtUtc !== archive.expiresAtUtc ||
    certificate.schemaHash !== archive.manifest.schemaHash ||
    certificate.policyHash !== archive.manifest.policyHash ||
    certificate.gitSha !== archive.manifest.gitSha ||
    certificate.cutoffUtc !== archive.manifest.cutoffUtc ||
    retentionHash(certificate.schemaVersions) !==
      retentionHash(archive.manifest.schemaVersions) ||
    certificate.historicalCompleteness !== "unknown" ||
    certificate.targetUse !== "verification_only_sequences_not_reseeded" ||
    !Number.isFinite(Date.parse(certificate.restoredAtUtc)) ||
    certificate.datasetId !== archive.plan.datasetId ||
    retentionHash(certificate.counts) !== retentionHash(archive.counts) ||
    retentionHash(certificate.rowChecksums) !==
      retentionHash(archive.rowChecksums) ||
    retentionHash(certificate.result) !== retentionHash(archive.result) ||
    retentionHash(certificate.targetIdentity) !==
      retentionHash(archive.targetIdentity) ||
    Date.parse(certificate.restoredAtUtc) <
      Date.parse(archive.generatedAtUtc) ||
    Date.parse(certificate.restoredAtUtc) > Date.now() ||
    certificate.executionAllowed !== false ||
    certificate.deletionEligibility !== false
  )
    fail("CERTIFICATE_MISMATCH");
}
