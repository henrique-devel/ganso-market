import { createHash } from "node:crypto";

import type { DatabasePool, SqlExecutor } from "../database.js";
import { sourceTsToDate } from "./recorder.js";

// RFC-007 tasks 2 and 3: versioned rules and versioned market parameters.
// Each condition_id has a chain of versions with validity [valid_from,
// valid_to); the open version has valid_to NULL. A new version is inserted
// only when the normative content hash changes. A rules change additionally
// records an immutable `rule_change` row in polymarket_resolution_events
// (clarifications have no official feed; the diff is the detection).
//
// All monetary/size values are canonical decimal strings, never floats.

export interface RuleObservation {
  readonly conditionId: string;
  readonly description: string;
  readonly resolutionSource: string | null;
  readonly resolvedBy: string | null;
  readonly endDate: Date | null;
  readonly umaEndDate: Date | null;
  readonly umaBond: string | null;
  readonly umaReward: string | null;
  readonly customLiveness: string | null;
  readonly automaticallyResolved: boolean | null;
  readonly sourceTs: Date | null;
}

export interface ParamObservation {
  readonly conditionId: string;
  readonly feeBaseBps: string | null;
  readonly makerFeeBps: string | null;
  readonly takerFeeBps: string | null;
  readonly feeCurveJson: unknown;
  readonly tickSize: string | null;
  readonly minOrderSize: string | null;
  readonly negRisk: boolean | null;
  readonly sourceTs: Date | null;
}

export interface ApplyResult {
  readonly version: number;
  readonly changed: boolean;
  readonly changedFields: readonly string[];
}

export interface RuleVersionRow {
  readonly version: number;
  readonly contentHash: string;
  readonly description: string;
  readonly resolutionSource: string | null;
  readonly resolvedBy: string | null;
  readonly endDate: Date | null;
  readonly umaEndDate: Date | null;
  readonly umaBond: string | null;
  readonly umaReward: string | null;
  readonly customLiveness: string | null;
  readonly automaticallyResolved: boolean | null;
}

export interface ParamVersionRow {
  readonly version: number;
  readonly contentHash: string;
  readonly feeBaseBps: string | null;
  readonly makerFeeBps: string | null;
  readonly takerFeeBps: string | null;
  readonly feeCurveJson: unknown;
  readonly tickSize: string | null;
  readonly minOrderSize: string | null;
  readonly negRisk: boolean | null;
}

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function sha256(fields: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function logJson(
  level: "error" | "warn" | "info",
  reasonCode: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  process.stderr.write(
    `${JSON.stringify({
      level,
      service: "polymarket-recorder",
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      message,
      ...extra,
    })}\n`,
  );
}

// jsonb round-trips reorder object keys; the content hash must be computed
// over a canonical form (recursively sorted keys) so a re-read of the same
// curve never opens a spurious new version.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

/** Canonical JSON text (sorted keys, recursively) or null for null/undefined. */
export function canonicalJson(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return JSON.stringify(canonicalize(value));
}

// Executors: callers may hand us a plain SqlExecutor or a DatabasePool. When
// the pool is available, close+insert runs in one transaction so a partial
// failure can never leave a chain without an open version.
export type VersioningExecutor = SqlExecutor | DatabasePool;

function hasTransaction(db: VersioningExecutor): db is DatabasePool {
  return typeof (db as Partial<DatabasePool>).transaction === "function";
}

async function inTransaction<T>(
  db: VersioningExecutor,
  run: (tx: SqlExecutor) => Promise<T>,
): Promise<T> {
  return hasTransaction(db) ? db.transaction(run) : run(db);
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code === "23505") {
    return true;
  }
  return (
    typeof candidate.message === "string" &&
    candidate.message.includes("duplicate key value violates unique")
  );
}

// Repair fallback: a chain left without an open version (e.g. a historical
// close+insert partial failure) resumes at MAX(version)+1 instead of 1, which
// would violate the (condition_id, version) UNIQUE constraint forever.
async function nextVersionAfterGap(
  db: SqlExecutor,
  table: "polymarket_rule_versions" | "polymarket_param_versions",
  conditionId: string,
): Promise<number> {
  const result = await db.query<{ max_version: number | string | null }>(
    `SELECT COALESCE(MAX(version), 0) AS max_version
       FROM ${table}
      WHERE condition_id = $1`,
    [conditionId],
  );
  const max = Number(result.rows[0]?.max_version ?? 0);
  return (Number.isFinite(max) ? max : 0) + 1;
}

// Normative rule fields in a fixed order; the hash is over this tuple.
function ruleNormativeFields(
  obs: Omit<RuleObservation, "conditionId" | "sourceTs">,
): Record<string, unknown> {
  return {
    description: obs.description,
    resolution_source: obs.resolutionSource,
    resolved_by: obs.resolvedBy,
    end_date: isoOrNull(obs.endDate),
    uma_end_date: isoOrNull(obs.umaEndDate),
    uma_bond: obs.umaBond,
    uma_reward: obs.umaReward,
    custom_liveness: obs.customLiveness,
    automatically_resolved: obs.automaticallyResolved,
  };
}

export function ruleContentHash(obs: RuleObservation): string {
  const fields = ruleNormativeFields(obs);
  return sha256(Object.values(fields));
}

function paramNormativeFields(
  obs: Omit<ParamObservation, "conditionId" | "sourceTs">,
): Record<string, unknown> {
  return {
    fee_base_bps: obs.feeBaseBps,
    maker_fee_bps: obs.makerFeeBps,
    taker_fee_bps: obs.takerFeeBps,
    fee_curve_json:
      obs.feeCurveJson === null || obs.feeCurveJson === undefined
        ? null
        : JSON.stringify(obs.feeCurveJson),
    tick_size: obs.tickSize,
    min_order_size: obs.minOrderSize,
    neg_risk: obs.negRisk,
  };
}

export function paramContentHash(obs: ParamObservation): string {
  const fields = paramNormativeFields(obs);
  return sha256(Object.values(fields));
}

function changedFieldNames(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] {
  const names: string[] = [];
  for (const key of Object.keys(next)) {
    if (previous[key] !== next[key]) {
      names.push(key);
    }
  }
  return names;
}

interface OpenRuleRow {
  readonly version: number;
  readonly content_hash: string;
  readonly description: string;
  readonly resolution_source: string | null;
  readonly resolved_by: string | null;
  readonly end_date: Date | null;
  readonly uma_end_date: Date | null;
  readonly uma_bond: string | null;
  readonly uma_reward: string | null;
  readonly custom_liveness: string | null;
  readonly automatically_resolved: boolean | null;
}

async function openRuleVersion(
  db: SqlExecutor,
  conditionId: string,
): Promise<OpenRuleRow | null> {
  const result = await db.query<OpenRuleRow>(
    `SELECT version, content_hash, description, resolution_source, resolved_by,
            end_date, uma_end_date, uma_bond, uma_reward, custom_liveness,
            automatically_resolved
       FROM polymarket_rule_versions
      WHERE condition_id = $1 AND valid_to IS NULL
      ORDER BY version DESC
      LIMIT 1`,
    [conditionId],
  );
  return result.rows[0] ?? null;
}

async function insertRuleVersion(
  db: SqlExecutor,
  obs: RuleObservation,
  version: number,
  contentHash: string,
  now: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO polymarket_rule_versions
       (condition_id, version, content_hash, description, resolution_source,
        resolved_by, end_date, uma_end_date, uma_bond, uma_reward,
        custom_liveness, automatically_resolved, valid_from, source_ts, received_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      obs.conditionId,
      version,
      contentHash,
      obs.description,
      obs.resolutionSource,
      obs.resolvedBy,
      obs.endDate,
      obs.umaEndDate,
      obs.umaBond,
      obs.umaReward,
      obs.customLiveness,
      obs.automaticallyResolved,
      now,
      obs.sourceTs,
      now,
    ],
  );
}

/**
 * Compare a fresh Gamma rules observation against the open version. First
 * observation inserts version 1 (no event); a chain left without an open
 * version resumes at MAX(version)+1. A content change closes the open version
 * at `now` and inserts version n+1 plus one immutable `rule_change`
 * resolution event, atomically when the executor is a pool. A concurrent
 * writer's UNIQUE violation is retried once after a re-read.
 */
export async function applyRuleObservation(
  db: VersioningExecutor,
  obs: RuleObservation,
  now: Date,
): Promise<ApplyResult> {
  try {
    return await applyRuleObservationOnce(db, obs, now);
  } catch (error: unknown) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    logJson("warn", "VERSION_RACE_RETRY", "polymarket_rule_version_retry", {
      condition_id: obs.conditionId,
    });
    return applyRuleObservationOnce(db, obs, now);
  }
}

async function applyRuleObservationOnce(
  db: VersioningExecutor,
  obs: RuleObservation,
  now: Date,
): Promise<ApplyResult> {
  const nextFields = ruleNormativeFields(obs);
  const contentHash = sha256(Object.values(nextFields));
  const open = await openRuleVersion(db, obs.conditionId);

  if (open === null) {
    const version = await nextVersionAfterGap(
      db,
      "polymarket_rule_versions",
      obs.conditionId,
    );
    await insertRuleVersion(db, obs, version, contentHash, now);
    return { version, changed: true, changedFields: [] };
  }
  if (open.content_hash === contentHash) {
    return { version: open.version, changed: false, changedFields: [] };
  }

  const previousFields: Record<string, unknown> = {
    description: open.description,
    resolution_source: open.resolution_source,
    resolved_by: open.resolved_by,
    end_date: isoOrNull(open.end_date),
    uma_end_date: isoOrNull(open.uma_end_date),
    uma_bond: open.uma_bond,
    uma_reward: open.uma_reward,
    custom_liveness: open.custom_liveness,
    automatically_resolved: open.automatically_resolved,
  };
  const changedFields = changedFieldNames(previousFields, nextFields);
  const nextVersion = open.version + 1;

  // Close + insert + event atomically: a partial failure must never leave
  // the chain without an open version.
  await inTransaction(db, async (tx) => {
    await tx.query(
      `UPDATE polymarket_rule_versions
          SET valid_to = $2
        WHERE condition_id = $1 AND valid_to IS NULL`,
      [obs.conditionId, now],
    );
    await insertRuleVersion(tx, obs, nextVersion, contentHash, now);
    await tx.query(
      `INSERT INTO polymarket_resolution_events
         (condition_id, event_type, payload_json, source_ts, received_at)
       VALUES ($1, 'rule_change', $2::jsonb, $3, $4)`,
      [
        obs.conditionId,
        JSON.stringify({
          changed_fields: changedFields,
          previous_version: open.version,
          new_version: nextVersion,
          previous_hash: open.content_hash,
          new_hash: contentHash,
        }),
        obs.sourceTs,
        now,
      ],
    );
  });
  return { version: nextVersion, changed: true, changedFields };
}

interface OpenParamRow {
  readonly version: number;
  readonly content_hash: string;
  readonly fee_base_bps: string | null;
  readonly maker_fee_bps: string | null;
  readonly taker_fee_bps: string | null;
  readonly fee_curve_json: unknown;
  readonly tick_size: string | null;
  readonly min_order_size: string | null;
  readonly neg_risk: boolean | null;
}

async function openParamVersion(
  db: SqlExecutor,
  conditionId: string,
): Promise<OpenParamRow | null> {
  const result = await db.query<OpenParamRow>(
    `SELECT version, content_hash, fee_base_bps, maker_fee_bps, taker_fee_bps,
            fee_curve_json, tick_size, min_order_size, neg_risk
       FROM polymarket_param_versions
      WHERE condition_id = $1 AND valid_to IS NULL
      ORDER BY version DESC
      LIMIT 1`,
    [conditionId],
  );
  return result.rows[0] ?? null;
}

async function insertParamVersion(
  db: SqlExecutor,
  obs: ParamObservation,
  version: number,
  contentHash: string,
  now: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO polymarket_param_versions
       (condition_id, version, content_hash, fee_base_bps, maker_fee_bps,
        taker_fee_bps, fee_curve_json, tick_size, min_order_size, neg_risk,
        valid_from, source_ts, received_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)`,
    [
      obs.conditionId,
      version,
      contentHash,
      obs.feeBaseBps,
      obs.makerFeeBps,
      obs.takerFeeBps,
      obs.feeCurveJson === null || obs.feeCurveJson === undefined
        ? null
        : JSON.stringify(obs.feeCurveJson),
      obs.tickSize,
      obs.minOrderSize,
      obs.negRisk,
      now,
      obs.sourceTs,
      now,
    ],
  );
}

/**
 * Compare a fresh market-parameter observation (fees/tick/min size/negRisk)
 * against the open version; insert version n+1 with validity starting at
 * `now` only when the content hash changes.
 */
export async function applyParamObservation(
  db: SqlExecutor,
  obs: ParamObservation,
  now: Date,
): Promise<ApplyResult> {
  const nextFields = paramNormativeFields(obs);
  const contentHash = sha256(Object.values(nextFields));
  const open = await openParamVersion(db, obs.conditionId);

  if (open === null) {
    await insertParamVersion(db, obs, 1, contentHash, now);
    return { version: 1, changed: true, changedFields: [] };
  }
  if (open.content_hash === contentHash) {
    return { version: open.version, changed: false, changedFields: [] };
  }

  const previousFields: Record<string, unknown> = {
    fee_base_bps: open.fee_base_bps,
    maker_fee_bps: open.maker_fee_bps,
    taker_fee_bps: open.taker_fee_bps,
    fee_curve_json:
      open.fee_curve_json === null || open.fee_curve_json === undefined
        ? null
        : JSON.stringify(open.fee_curve_json),
    tick_size: open.tick_size,
    min_order_size: open.min_order_size,
    neg_risk: open.neg_risk,
  };
  const changedFields = changedFieldNames(previousFields, nextFields);
  const nextVersion = open.version + 1;

  await db.query(
    `UPDATE polymarket_param_versions
        SET valid_to = $2
      WHERE condition_id = $1 AND valid_to IS NULL`,
    [obs.conditionId, now],
  );
  await insertParamVersion(db, obs, nextVersion, contentHash, now);
  return { version: nextVersion, changed: true, changedFields };
}

/** Partial parameter update: only the provided fields override the ones on
 * the currently open version (a source that knows only fees must not blank
 * out tick size, and vice versa). Absent open version, missing fields are
 * null. */
export interface ParamFieldPatch {
  readonly feeBaseBps?: string | null;
  readonly makerFeeBps?: string | null;
  readonly takerFeeBps?: string | null;
  readonly feeCurveJson?: unknown;
  readonly tickSize?: string | null;
  readonly minOrderSize?: string | null;
  readonly negRisk?: boolean | null;
}

export async function applyParamFields(
  db: SqlExecutor,
  conditionId: string,
  patch: ParamFieldPatch,
  now: Date,
  sourceTs: Date | null = null,
): Promise<ApplyResult> {
  const open = await openParamVersion(db, conditionId);
  const merged: ParamObservation = {
    conditionId,
    feeBaseBps:
      patch.feeBaseBps !== undefined
        ? patch.feeBaseBps
        : (open?.fee_base_bps ?? null),
    makerFeeBps:
      patch.makerFeeBps !== undefined
        ? patch.makerFeeBps
        : (open?.maker_fee_bps ?? null),
    takerFeeBps:
      patch.takerFeeBps !== undefined
        ? patch.takerFeeBps
        : (open?.taker_fee_bps ?? null),
    feeCurveJson:
      patch.feeCurveJson !== undefined
        ? patch.feeCurveJson
        : (open?.fee_curve_json ?? null),
    tickSize:
      patch.tickSize !== undefined ? patch.tickSize : (open?.tick_size ?? null),
    minOrderSize:
      patch.minOrderSize !== undefined
        ? patch.minOrderSize
        : (open?.min_order_size ?? null),
    negRisk:
      patch.negRisk !== undefined ? patch.negRisk : (open?.neg_risk ?? null),
    sourceTs,
  };
  return applyParamObservation(db, merged, now);
}

/** WS `tick_size_change`: open a new param version with the new tick size,
 * carrying every other field over from the currently open version. */
export async function applyTickSizeChange(
  db: SqlExecutor,
  msg: {
    readonly market: string;
    readonly asset_id: string;
    readonly new_tick_size: string;
    readonly timestamp: string | null;
  },
  now: Date,
): Promise<ApplyResult> {
  return applyParamFields(
    db,
    msg.market,
    { tickSize: msg.new_tick_size },
    now,
    sourceTsToDate(msg.timestamp),
  );
}

/** Rule version in force at `at` ([valid_from, valid_to) semantics). */
export async function ruleAt(
  db: SqlExecutor,
  conditionId: string,
  at: Date,
): Promise<RuleVersionRow | null> {
  const result = await db.query<OpenRuleRow>(
    `SELECT version, content_hash, description, resolution_source, resolved_by,
            end_date, uma_end_date, uma_bond, uma_reward, custom_liveness,
            automatically_resolved
       FROM polymarket_rule_versions
      WHERE condition_id = $1
        AND valid_from <= $2
        AND (valid_to IS NULL OR valid_to > $2)
      ORDER BY version DESC
      LIMIT 1`,
    [conditionId, at],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    version: row.version,
    contentHash: row.content_hash,
    description: row.description,
    resolutionSource: row.resolution_source,
    resolvedBy: row.resolved_by,
    endDate: row.end_date,
    umaEndDate: row.uma_end_date,
    umaBond: row.uma_bond,
    umaReward: row.uma_reward,
    customLiveness: row.custom_liveness,
    automaticallyResolved: row.automatically_resolved,
  };
}

/** Parameter version in force at `at` ([valid_from, valid_to) semantics). */
export async function paramsAt(
  db: SqlExecutor,
  conditionId: string,
  at: Date,
): Promise<ParamVersionRow | null> {
  const result = await db.query<OpenParamRow>(
    `SELECT version, content_hash, fee_base_bps, maker_fee_bps, taker_fee_bps,
            fee_curve_json, tick_size, min_order_size, neg_risk
       FROM polymarket_param_versions
      WHERE condition_id = $1
        AND valid_from <= $2
        AND (valid_to IS NULL OR valid_to > $2)
      ORDER BY version DESC
      LIMIT 1`,
    [conditionId, at],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    version: row.version,
    contentHash: row.content_hash,
    feeBaseBps: row.fee_base_bps,
    makerFeeBps: row.maker_fee_bps,
    takerFeeBps: row.taker_fee_bps,
    feeCurveJson: row.fee_curve_json,
    tickSize: row.tick_size,
    minOrderSize: row.min_order_size,
    negRisk: row.neg_risk,
  };
}
