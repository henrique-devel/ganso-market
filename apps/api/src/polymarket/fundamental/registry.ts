// RFC-010 task 1 (model registry) and the database half of task 9 (promotion
// gate). This module owns every write to `fundamental_models`,
// `fundamental_model_events` and every read of `fundamental_gate_reports`.
// It stores and moves METADATA ONLY: there is no order, signal, wallet or
// trading credential anywhere in this file, and none may be added.
//
// Migration 0006 already enforces the hard rules in the database (regime
// boundary, regime_mix never active, one active model per category, immutable
// identity columns). Every one of them is ALSO enforced here, before the
// statement is sent, so a caller gets a stable reason code instead of a raw
// constraint violation — and so the refusal is observable in the log even when
// the database would have rejected it anyway.
//
// Lifecycle, in full:
//   registerModel  -> always `shadow` (a new training run is a new version)
//   runGate (gate.ts) -> writes the report, points the model at it
//   promoteModel   -> shadow -> active ONLY on a PASS report, never for a
//                     regime-mixed model
//   demoteModel    -> immediate manual kill back to the market baseline
//   enforceRevalidation -> a rule/fee change sends the category's active model
//                     back to shadow automatically

import { gammaCategoryToModelCategory, type QueryPool } from "./features.js";
import {
  FUNDAMENTAL_CATEGORIES,
  REGIME_V2_CUTOVER,
  type FundamentalCategory,
  type GateVerdict,
  type ModelRecord,
  type ModelStatus,
} from "./types.js";

export { REGIME_V2_CUTOVER };

const SERVICE = "polymarket-fundamental";

/** Default page size of the audit trail reader. */
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 1_000;

const MODEL_COLUMNS =
  "model_id, model_family, category, version, git_sha, feature_set_version, " +
  "hyperparams_json, seed, train_window_start, train_window_end, regime_mix, " +
  "status, last_gate_report_id, created_at, promoted_at, demoted_at, retired_at";

const GATE_REPORT_COLUMNS =
  "gate_report_id, model_id, category, verdict, markets_covered, observations, " +
  "window_from, window_to, metrics_json, failures_json, git_sha, " +
  "feature_set_version, evaluated_at";

const MODEL_EVENT_COLUMNS =
  "model_event_id, model_id, event_type, gate_report_id, payload_json, at";

function logJson(
  level: "info" | "warn" | "error",
  reasonCode: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  process.stderr.write(
    `${JSON.stringify({
      level,
      service: SERVICE,
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      message,
      ...extra,
    })}\n`,
  );
}

/**
 * Raised when a declared training window is inadmissible: it straddles the
 * CLOB V2 cutover without an explicit `regime_mix` flag, or its bounds are not
 * ordered. Both are also database CHECK constraints; refusing here gives the
 * caller a reason code instead of a constraint violation.
 */
export class RegimeBoundaryError extends Error {
  public readonly reasonCode: string;

  public constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "RegimeBoundaryError";
    this.reasonCode = reasonCode;
  }
}

/**
 * Throws RegimeBoundaryError when the training window straddles the CLOB V2
 * cutover without an explicit regime_mix flag. A window that merely touches the
 * boundary (ends exactly at it, or starts exactly at it) does not straddle it —
 * the same arithmetic as the `fundamental_models_regime_boundary` constraint.
 */
export function assertRegimeBoundary(
  trainWindowStart: Date | null,
  trainWindowEnd: Date | null,
  regimeMix: boolean,
): void {
  if (regimeMix || trainWindowStart === null || trainWindowEnd === null) {
    return;
  }
  const cutover = REGIME_V2_CUTOVER.getTime();
  if (
    trainWindowStart.getTime() < cutover &&
    trainWindowEnd.getTime() > cutover
  ) {
    throw new RegimeBoundaryError(
      "REGIME_BOUNDARY_STRADDLED",
      "training window crosses the 2026-04-28 CLOB V2 cutover without regime_mix",
    );
  }
}

// ---------------------------------------------------------------------------
// Row types and mapping
// ---------------------------------------------------------------------------

/** One row of `fundamental_gate_reports`. */
export interface GateReportRow {
  readonly gateReportId: number;
  readonly modelId: string;
  readonly category: string;
  readonly verdict: GateVerdict;
  readonly marketsCovered: number;
  readonly observations: number;
  readonly windowFrom: Date | null;
  readonly windowTo: Date | null;
  readonly metrics: Record<string, unknown>;
  readonly failures: readonly string[];
  readonly gitSha: string;
  readonly featureSetVersion: string | null;
  readonly evaluatedAt: Date | null;
}

/** One row of `fundamental_model_events` (the immutable audit trail). */
export interface ModelEventRow {
  readonly modelEventId: number;
  readonly modelId: string;
  readonly eventType: string;
  readonly gateReportId: number | null;
  readonly payload: Record<string, unknown>;
  readonly at: Date | null;
}

function invalidRow(table: string, key: string): Error {
  logJson("error", "FUNDAMENTAL_ROW_INVALID", "fundamental_row_invalid", {
    table,
    key,
  });
  return new Error(`FUNDAMENTAL_ROW_INVALID: unreadable ${table} row ${key}`);
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** BIGINT arrives as a string from the driver; INTEGER as a number. */
function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toJsonObject(value: unknown): Record<string, unknown> {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function toStringArray(value: unknown): string[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function asCategory(value: unknown): FundamentalCategory | null {
  return FUNDAMENTAL_CATEGORIES.find((category) => category === value) ?? null;
}

function asStatus(value: unknown): ModelStatus | null {
  return value === "shadow" || value === "active" || value === "retired"
    ? value
    : null;
}

/**
 * Booleans are read strictly: a regime flag that cannot be read is a refusal,
 * never a `false`. Guessing "false" here would make an unreadable row eligible
 * for promotion, which is exactly the wrong direction to fail.
 */
function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "t" || value === "true") {
    return true;
  }
  if (value === "f" || value === "false") {
    return false;
  }
  return null;
}

function mapModelRow(row: Record<string, unknown>): ModelRecord {
  const modelId = typeof row.model_id === "string" ? row.model_id : "";
  const category = asCategory(row.category);
  const status = asStatus(row.status);
  const regimeMix = asBoolean(row.regime_mix);
  const createdAt = toDate(row.created_at);
  if (
    modelId === "" ||
    category === null ||
    status === null ||
    regimeMix === null ||
    createdAt === null
  ) {
    throw invalidRow("fundamental_models", modelId);
  }
  return {
    modelId,
    modelFamily: String(row.model_family ?? ""),
    category,
    version: String(row.version ?? ""),
    gitSha: String(row.git_sha ?? ""),
    featureSetVersion: String(row.feature_set_version ?? ""),
    hyperparams: toJsonObject(row.hyperparams_json),
    seed: toNullableNumber(row.seed) ?? 0,
    trainWindowStart: toDate(row.train_window_start),
    trainWindowEnd: toDate(row.train_window_end),
    regimeMix,
    status,
    lastGateReportId: toNullableNumber(row.last_gate_report_id),
    createdAt,
    promotedAt: toDate(row.promoted_at),
    demotedAt: toDate(row.demoted_at),
    retiredAt: toDate(row.retired_at),
  };
}

function mapGateReportRow(row: Record<string, unknown>): GateReportRow {
  const gateReportId = toNullableNumber(row.gate_report_id);
  const verdict =
    row.verdict === "PASS" || row.verdict === "NO_EVIDENCE_OF_ALPHA"
      ? row.verdict
      : null;
  if (gateReportId === null || verdict === null) {
    throw invalidRow("fundamental_gate_reports", String(row.model_id ?? ""));
  }
  return {
    gateReportId,
    modelId: String(row.model_id ?? ""),
    category: String(row.category ?? ""),
    verdict,
    marketsCovered: toNullableNumber(row.markets_covered) ?? 0,
    observations: toNullableNumber(row.observations) ?? 0,
    windowFrom: toDate(row.window_from),
    windowTo: toDate(row.window_to),
    metrics: toJsonObject(row.metrics_json),
    failures: toStringArray(row.failures_json),
    gitSha: String(row.git_sha ?? ""),
    featureSetVersion:
      typeof row.feature_set_version === "string"
        ? row.feature_set_version
        : null,
    evaluatedAt: toDate(row.evaluated_at),
  };
}

function mapModelEventRow(row: Record<string, unknown>): ModelEventRow {
  const modelEventId = toNullableNumber(row.model_event_id);
  if (modelEventId === null) {
    throw invalidRow("fundamental_model_events", String(row.model_id ?? ""));
  }
  return {
    modelEventId,
    modelId: String(row.model_id ?? ""),
    eventType: String(row.event_type ?? ""),
    gateReportId: toNullableNumber(row.gate_report_id),
    payload: toJsonObject(row.payload_json),
    at: toDate(row.at),
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface RegisterModelInput {
  readonly modelId: string;
  readonly modelFamily: string;
  readonly category: FundamentalCategory;
  readonly version: string;
  readonly gitSha: string;
  readonly featureSetVersion: string;
  readonly hyperparams: Record<string, unknown>;
  readonly seed: number;
  readonly trainWindowStart: Date | null;
  readonly trainWindowEnd: Date | null;
  readonly regimeMix: boolean;
}

/**
 * Every training run creates a NEW version; versions are immutable and are
 * always born in shadow. A model_id that already exists is refused rather than
 * updated — re-registering an id would silently rewrite the provenance of the
 * estimates that already point at it.
 */
export async function registerModel(
  pool: QueryPool,
  input: RegisterModelInput,
  at: Date,
): Promise<ModelRecord> {
  assertRegimeBoundary(
    input.trainWindowStart,
    input.trainWindowEnd,
    input.regimeMix,
  );
  if (
    input.trainWindowStart !== null &&
    input.trainWindowEnd !== null &&
    input.trainWindowEnd.getTime() < input.trainWindowStart.getTime()
  ) {
    throw new RegimeBoundaryError(
      "TRAIN_WINDOW_OUT_OF_ORDER",
      "train_window_end precedes train_window_start",
    );
  }

  const result = await pool.query<Record<string, unknown>>(
    `INSERT INTO fundamental_models
       (model_id, model_family, category, version, git_sha,
        feature_set_version, hyperparams_json, seed, train_window_start,
        train_window_end, regime_mix, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, 'shadow', $12)
     ON CONFLICT (model_id) DO NOTHING
     RETURNING ${MODEL_COLUMNS}`,
    [
      input.modelId,
      input.modelFamily,
      input.category,
      input.version,
      input.gitSha,
      input.featureSetVersion,
      JSON.stringify(input.hyperparams),
      input.seed,
      input.trainWindowStart,
      input.trainWindowEnd,
      input.regimeMix,
      at,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    logJson("error", "MODEL_VERSION_EXISTS", "fundamental_model_exists", {
      model_id: input.modelId,
    });
    throw new Error(
      `MODEL_VERSION_EXISTS: ${input.modelId} is already registered and model versions are immutable`,
    );
  }
  const model = mapModelRow(row);

  await recordModelEvent(pool, {
    modelId: model.modelId,
    eventType: "registered",
    payload: {
      category: model.category,
      version: model.version,
      git_sha: model.gitSha,
      feature_set_version: model.featureSetVersion,
      seed: model.seed,
      regime_mix: model.regimeMix,
      train_window_start:
        model.trainWindowStart === null
          ? null
          : model.trainWindowStart.toISOString(),
      train_window_end:
        model.trainWindowEnd === null
          ? null
          : model.trainWindowEnd.toISOString(),
    },
    at,
  });
  logJson("info", "MODEL_REGISTERED", "fundamental_model_registered", {
    model_id: model.modelId,
    category: model.category,
    version: model.version,
    regime_mix: model.regimeMix,
  });
  return model;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function selectModels(
  pool: QueryPool,
  category: string | null,
  status: string | null,
): Promise<ModelRecord[]> {
  // Both filters are bound parameters and the SQL text is constant: no branch
  // of this query is ever assembled from caller-supplied strings.
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${MODEL_COLUMNS}
       FROM fundamental_models
      WHERE ($1::text IS NULL OR category = $1)
        AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at ASC, model_id ASC`,
    [category, status],
  );
  return result.rows.map(mapModelRow);
}

export async function getModel(
  pool: QueryPool,
  modelId: string,
): Promise<ModelRecord | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${MODEL_COLUMNS} FROM fundamental_models WHERE model_id = $1`,
    [modelId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapModelRow(row);
}

export async function listModels(
  pool: QueryPool,
  filter?: { readonly category?: string; readonly status?: string },
): Promise<ModelRecord[]> {
  return selectModels(pool, filter?.category ?? null, filter?.status ?? null);
}

/** The single promoted model of a category, or null (the category then runs on
 *  the market baseline, which is never switchable off). */
export async function activeModelFor(
  pool: QueryPool,
  category: FundamentalCategory,
): Promise<ModelRecord | null> {
  const models = await selectModels(pool, category, "active");
  // The partial unique index guarantees at most one; taking the first is a
  // read, not a tie-break.
  return models[0] ?? null;
}

export async function shadowModelsFor(
  pool: QueryPool,
  category: FundamentalCategory,
): Promise<ModelRecord[]> {
  return selectModels(pool, category, "shadow");
}

export async function latestGateReport(
  pool: QueryPool,
  modelId: string,
): Promise<GateReportRow | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${GATE_REPORT_COLUMNS}
       FROM fundamental_gate_reports
      WHERE model_id = $1
      ORDER BY evaluated_at DESC, gate_report_id DESC
      LIMIT 1`,
    [modelId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapGateReportRow(row);
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

export type PromoteOutcome =
  | { readonly ok: true; readonly model: ModelRecord }
  | {
      readonly ok: false;
      readonly reasonCode:
        | "MODEL_NOT_FOUND"
        | "NO_GATE_REPORT"
        | "GATE_NOT_PASSED"
        | "REGIME_MIX_INELIGIBLE"
        | "ALREADY_ACTIVE"
        | "MODEL_RETIRED";
      readonly gateReport: GateReportRow | null;
    };

function refuse(
  reasonCode:
    | "MODEL_NOT_FOUND"
    | "NO_GATE_REPORT"
    | "GATE_NOT_PASSED"
    | "REGIME_MIX_INELIGIBLE"
    | "ALREADY_ACTIVE"
    | "MODEL_RETIRED",
  gateReport: GateReportRow | null,
  modelId: string,
): PromoteOutcome {
  logJson("warn", reasonCode, "fundamental_model_transition_refused", {
    model_id: modelId,
    gate_report_id: gateReport?.gateReportId ?? null,
    gate_verdict: gateReport?.verdict ?? null,
  });
  return { ok: false, reasonCode, gateReport };
}

/** shadow -> active. The regime_mix guard is repeated in the WHERE clause so a
 *  row that changed under us can never become active. */
async function updateToActive(
  pool: QueryPool,
  modelId: string,
  at: Date,
): Promise<ModelRecord | null> {
  const result = await pool.query<Record<string, unknown>>(
    `UPDATE fundamental_models
        SET status = 'active', promoted_at = $2, demoted_at = NULL
      WHERE model_id = $1 AND status = 'shadow' AND regime_mix = FALSE
      RETURNING ${MODEL_COLUMNS}`,
    [modelId, at],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapModelRow(row);
}

/** active -> shadow. `promoted_at` is left as the instant of the promotion
 *  that just ended; `demoted_at` carries the kill instant. */
async function updateToShadow(
  pool: QueryPool,
  modelId: string,
  at: Date,
): Promise<ModelRecord | null> {
  const result = await pool.query<Record<string, unknown>>(
    `UPDATE fundamental_models
        SET status = 'shadow', demoted_at = $2
      WHERE model_id = $1 AND status = 'active'
      RETURNING ${MODEL_COLUMNS}`,
    [modelId, at],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapModelRow(row);
}

/**
 * shadow -> active ONLY when the latest gate report for this model is PASS.
 * Anything else refuses and returns the blocking gate report.
 *
 * Passing the gate means only that the model was not shown to be worse than the
 * executable market baseline on the evaluated window. It is not evidence of a
 * net-of-cost edge, and promotion here makes no such claim.
 */
export async function promoteModel(
  pool: QueryPool,
  modelId: string,
  at: Date,
): Promise<PromoteOutcome> {
  const model = await getModel(pool, modelId);
  if (model === null) {
    return refuse("MODEL_NOT_FOUND", null, modelId);
  }
  const gateReport = await latestGateReport(pool, modelId);
  if (model.status === "retired") {
    return refuse("MODEL_RETIRED", gateReport, modelId);
  }
  if (model.status === "active") {
    return refuse("ALREADY_ACTIVE", gateReport, modelId);
  }
  // A regime-mixed model is disqualified before its metrics are even read: no
  // gate report can make a set that straddles the V2 cutover promotable.
  if (model.regimeMix) {
    return refuse("REGIME_MIX_INELIGIBLE", gateReport, modelId);
  }
  if (gateReport === null) {
    return refuse("NO_GATE_REPORT", null, modelId);
  }
  if (gateReport.verdict !== "PASS") {
    return refuse("GATE_NOT_PASSED", gateReport, modelId);
  }

  // Exactly one active model per category (partial unique index). The incumbent
  // steps down FIRST: the gap between the two statements leaves the category on
  // the market baseline, which is the safe direction to fail.
  const incumbent = await activeModelFor(pool, model.category);
  if (incumbent !== null && incumbent.modelId !== model.modelId) {
    const steppedDown = await updateToShadow(pool, incumbent.modelId, at);
    if (steppedDown !== null) {
      await recordModelEvent(pool, {
        modelId: incumbent.modelId,
        eventType: "demoted",
        payload: {
          reason: "SUPERSEDED_BY_PROMOTION",
          superseded_by: model.modelId,
        },
        at,
      });
      logJson("info", "MODEL_SUPERSEDED", "fundamental_model_superseded", {
        model_id: incumbent.modelId,
        superseded_by: model.modelId,
        category: model.category,
      });
    }
  }

  const promoted = await updateToActive(pool, modelId, at);
  if (promoted === null) {
    // The row moved between the read and the write; report what it is now.
    const current = await getModel(pool, modelId);
    if (current === null) {
      return refuse("MODEL_NOT_FOUND", gateReport, modelId);
    }
    if (current.regimeMix) {
      return refuse("REGIME_MIX_INELIGIBLE", gateReport, modelId);
    }
    return refuse(
      current.status === "retired" ? "MODEL_RETIRED" : "ALREADY_ACTIVE",
      gateReport,
      modelId,
    );
  }

  await recordModelEvent(pool, {
    modelId,
    eventType: "promoted",
    gateReportId: gateReport.gateReportId,
    payload: {
      category: promoted.category,
      version: promoted.version,
      markets_covered: gateReport.marketsCovered,
      observations: gateReport.observations,
    },
    at,
  });
  logJson("info", "MODEL_PROMOTED", "fundamental_model_promoted", {
    model_id: modelId,
    category: promoted.category,
    gate_report_id: gateReport.gateReportId,
  });
  return { ok: true, model: promoted };
}

/**
 * Immediate manual kill back to the fallback. Always allowed for an active
 * model, and idempotent for one that is already in shadow: the requested end
 * state (the model is not serving) is what matters, not the transition.
 */
export async function demoteModel(
  pool: QueryPool,
  modelId: string,
  at: Date,
  reason: string,
): Promise<PromoteOutcome> {
  const model = await getModel(pool, modelId);
  if (model === null) {
    return refuse("MODEL_NOT_FOUND", null, modelId);
  }
  if (model.status === "retired") {
    const gateReport = await latestGateReport(pool, modelId);
    return refuse("MODEL_RETIRED", gateReport, modelId);
  }
  if (model.status !== "active") {
    logJson("info", "MODEL_DEMOTE_NOOP", "fundamental_model_demote_noop", {
      model_id: modelId,
      status: model.status,
      reason,
    });
    return { ok: true, model };
  }

  const demoted = await updateToShadow(pool, modelId, at);
  if (demoted === null) {
    // Someone else already took it out of `active`; the kill is satisfied.
    const current = await getModel(pool, modelId);
    return { ok: true, model: current ?? model };
  }
  await recordModelEvent(pool, {
    modelId,
    eventType: "demoted",
    payload: { reason, category: demoted.category },
    at,
  });
  logJson("warn", "MODEL_DEMOTED", "fundamental_model_demoted", {
    model_id: modelId,
    category: demoted.category,
    reason,
  });
  return { ok: true, model: demoted };
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export async function recordModelEvent(
  pool: QueryPool,
  input: {
    readonly modelId: string;
    readonly eventType:
      | "registered"
      | "gate_pass"
      | "no_evidence_of_alpha"
      | "promoted"
      | "demoted"
      | "revalidation_required"
      | "retired";
    readonly gateReportId?: number | null;
    readonly payload?: Record<string, unknown>;
    readonly at: Date;
  },
): Promise<number> {
  const result = await pool.query<Record<string, unknown>>(
    `INSERT INTO fundamental_model_events
       (model_id, event_type, gate_report_id, payload_json, at)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING model_event_id`,
    [
      input.modelId,
      input.eventType,
      input.gateReportId ?? null,
      JSON.stringify(input.payload ?? {}),
      input.at,
    ],
  );
  const modelEventId = toNullableNumber(result.rows[0]?.model_event_id);
  if (modelEventId === null) {
    logJson("error", "MODEL_EVENT_NOT_RECORDED", "fundamental_event_failed", {
      model_id: input.modelId,
      event_type: input.eventType,
    });
    throw new Error(
      `MODEL_EVENT_NOT_RECORDED: ${input.eventType} for ${input.modelId}`,
    );
  }
  return modelEventId;
}

export async function listModelEvents(
  pool: QueryPool,
  modelId: string,
  limit = DEFAULT_EVENT_LIMIT,
): Promise<ModelEventRow[]> {
  const bounded = Number.isFinite(limit)
    ? Math.min(Math.max(Math.trunc(limit), 1), MAX_EVENT_LIMIT)
    : DEFAULT_EVENT_LIMIT;
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${MODEL_EVENT_COLUMNS}
       FROM fundamental_model_events
      WHERE model_id = $1
      ORDER BY at DESC, model_event_id DESC
      LIMIT $2`,
    [modelId, bounded],
  );
  return result.rows.map(mapModelEventRow);
}

// ---------------------------------------------------------------------------
// Mandatory re-validation
// ---------------------------------------------------------------------------

/** Newest rule/param change per fundamental category, at or before `at`. */
interface CategoryChange {
  readonly cause: string;
  readonly changedAt: Date;
}

async function categoryChanges(
  pool: QueryPool,
  at: Date,
): Promise<Map<FundamentalCategory, CategoryChange>> {
  // Only version > 1 counts: version 1 is the first observation of a market's
  // rules/params, not a CHANGE to them. This is the same test the feature layer
  // uses for its `rule_changed_recently` flag.
  const result = await pool.query<Record<string, unknown>>(
    `SELECT kind, gamma_category, changed_at
       FROM (
         SELECT 'RULE_VERSION_CHANGED' AS kind,
                m.category AS gamma_category,
                MAX(v.valid_from) AS changed_at
           FROM polymarket_rule_versions v
           JOIN polymarket_markets m ON m.condition_id = v.condition_id
          WHERE v.version > 1 AND v.valid_from <= $1
          GROUP BY m.category
         UNION ALL
         SELECT 'PARAM_VERSION_CHANGED' AS kind,
                m.category AS gamma_category,
                MAX(p.valid_from) AS changed_at
           FROM polymarket_param_versions p
           JOIN polymarket_markets m ON m.condition_id = p.condition_id
          WHERE p.version > 1 AND p.valid_from <= $1
          GROUP BY m.category
       ) changes
      WHERE changed_at IS NOT NULL`,
    [at],
  );

  const changes = new Map<FundamentalCategory, CategoryChange>();
  for (const row of result.rows) {
    const category = gammaCategoryToModelCategory(
      typeof row.gamma_category === "string" ? row.gamma_category : null,
    );
    const changedAt = toDate(row.changed_at);
    if (category === null || changedAt === null) {
      continue;
    }
    const cause = String(row.kind ?? "VERSION_CHANGED");
    const existing = changes.get(category);
    if (
      existing === undefined ||
      existing.changedAt.getTime() < changedAt.getTime()
    ) {
      changes.set(category, { cause, changedAt });
    }
  }
  return changes;
}

/**
 * RFC-010 acceptance criterion: a change of venue, fee schedule, market rule or
 * regime sends every active model of the affected category BACK TO SHADOW,
 * recording a revalidation_required event. The V2 migration killed live
 * strategies within a week, so this is automatic and unconditional — an active
 * model whose promotion predates the newest rule/param version of its category
 * has not been proven under the current rules.
 *
 * A model whose `promoted_at` is unreadable is revalidated too: it cannot be
 * shown to postdate the change, so it fails closed.
 *
 * Never throws: a failure on one model is logged and the loop continues, so the
 * supervised job that calls this cannot be brought down by one bad row.
 */
export async function enforceRevalidation(
  pool: QueryPool,
  at: Date,
): Promise<Array<{ readonly modelId: string; readonly cause: string }>> {
  const changes = await categoryChanges(pool, at);
  const active = await selectModels(pool, null, "active");
  const revalidated: Array<{
    readonly modelId: string;
    readonly cause: string;
  }> = [];

  for (const model of active) {
    const change = changes.get(model.category);
    if (change === undefined) {
      continue;
    }
    if (
      model.promotedAt !== null &&
      model.promotedAt.getTime() >= change.changedAt.getTime()
    ) {
      continue;
    }
    try {
      const demoted = await updateToShadow(pool, model.modelId, at);
      if (demoted === null) {
        continue;
      }
      await recordModelEvent(pool, {
        modelId: model.modelId,
        eventType: "revalidation_required",
        payload: {
          cause: change.cause,
          category: model.category,
          changed_at: change.changedAt.toISOString(),
          promoted_at:
            model.promotedAt === null ? null : model.promotedAt.toISOString(),
        },
        at,
      });
      logJson(
        "warn",
        "MODEL_REVALIDATION_REQUIRED",
        "fundamental_model_revalidation_required",
        {
          model_id: model.modelId,
          category: model.category,
          cause: change.cause,
          changed_at: change.changedAt.toISOString(),
        },
      );
      revalidated.push({ modelId: model.modelId, cause: change.cause });
    } catch (error: unknown) {
      logJson(
        "error",
        "MODEL_REVALIDATION_FAILED",
        "fundamental_model_revalidation_failed",
        {
          model_id: model.modelId,
          error_name: error instanceof Error ? error.name : "UnknownError",
        },
      );
    }
  }
  return revalidated;
}
