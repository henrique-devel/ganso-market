// RFC-010 "API mínima": the read and lifecycle endpoints of the fundamental
// model. Every route is a SELECT over this module's own tables plus the two
// lifecycle transitions the registry itself performs. There is no order,
// signal, wallet, signer or trading-credential path in this file, and none may
// be added — RFC-010 produces estimates and nothing else.
//
// All routes sit behind the RFC-002 bearer-token auth. Probabilities travel as
// the canonical six-fraction-digit decimal strings they are stored as: they are
// never parsed into a float on the way out. Timestamps are ISO 8601 (UTC).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { DatabasePool } from "../../database.js";
import { FUNDAMENTAL_CATEGORIES } from "./types.js";
import type { FundamentalCategory, GateVerdict, ModelRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Contract with the model registry (./registry.js), which is written in
// parallel with this file. The shapes below mirror what that module returns;
// every registry call is an injectable seam and the real module is imported
// lazily, so this file compiles and its tests run independently of it — the
// same arrangement readapi.ts uses for ./replay.js.
// ---------------------------------------------------------------------------

/** One row of `fundamental_gate_reports` as the registry hands it over. */
export interface GateReportRecord {
  readonly gateReportId: number;
  readonly modelId: string;
  readonly category: string;
  readonly verdict: GateVerdict;
  readonly marketsCovered: number;
  readonly observations: number;
  readonly windowFrom: Date | null;
  readonly windowTo: Date | null;
  /** Brier/log loss vs baseline with CI, horizon slices, reliability bins. */
  readonly metrics: Record<string, unknown>;
  readonly failures: readonly string[];
  readonly gitSha: string;
  readonly featureSetVersion: string | null;
  readonly evaluatedAt: Date | null;
}

export type GetModelFn = (
  pool: DatabasePool,
  modelId: string,
) => Promise<ModelRecord | null>;

export type ListModelsFn = (
  pool: DatabasePool,
) => Promise<readonly ModelRecord[]>;

export type LatestGateReportFn = (
  pool: DatabasePool,
  modelId: string,
) => Promise<GateReportRecord | null>;

/**
 * A refused lifecycle transition always names the reason it refused and
 * carries the gate report that blocked it, when one exists.
 */
export interface LifecycleRefusal {
  readonly ok: false;
  readonly reasonCode: string;
  readonly gateReport: GateReportRecord | null;
}

export type LifecycleResult =
  { readonly ok: true; readonly model: ModelRecord } | LifecycleRefusal;

export type PromoteModelFn = (
  pool: DatabasePool,
  modelId: string,
  at: Date,
) => Promise<LifecycleResult>;

export type DemoteModelFn = (
  pool: DatabasePool,
  modelId: string,
  at: Date,
  reason: string,
) => Promise<LifecycleResult>;

interface FundamentalRegistryModule {
  readonly getModel: GetModelFn;
  readonly listModels: ListModelsFn;
  readonly latestGateReport: LatestGateReportFn;
  readonly promoteModel: PromoteModelFn;
  readonly demoteModel: DemoteModelFn;
}

let cachedRegistryModule: FundamentalRegistryModule | null = null;

async function loadRegistryModule(): Promise<FundamentalRegistryModule> {
  if (cachedRegistryModule === null) {
    // Non-literal specifier on purpose: the registry module is developed in
    // parallel and this file must compile and test before it exists.
    const specifier = "./registry.js";
    cachedRegistryModule = (await import(
      specifier
    )) as FundamentalRegistryModule;
  }
  return cachedRegistryModule;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface FundamentalRoutesDeps {
  readonly pool: DatabasePool;
  readonly authService: {
    session(token: string): Promise<{ readonly status: string }>;
  };
  /** Injected clock (defaults to the system clock). */
  readonly clock?: () => Date;
  /** Test seam: replaces ./registry.js getModel. */
  readonly getModelFn?: GetModelFn;
  /** Test seam: replaces ./registry.js listModels. */
  readonly listModelsFn?: ListModelsFn;
  /** Test seam: replaces ./registry.js latestGateReport. */
  readonly latestGateReportFn?: LatestGateReportFn;
  /** Test seam: replaces ./registry.js promoteModel. */
  readonly promoteModelFn?: PromoteModelFn;
  /** Test seam: replaces ./registry.js demoteModel. */
  readonly demoteModelFn?: DemoteModelFn;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ESTIMATES_DEFAULT_LIMIT = 1_000;
const ESTIMATES_MAX_LIMIT = 5_000;
/** The universe is 50-100 markets (two tokens each); this is a safety net. */
const LATEST_LIMIT = 5_000;

/**
 * How old the newest estimate of a token may be and still be served as its
 * "latest". Five minutes is five estimation cycles at the default cadence: it
 * absorbs a slow cycle without ever presenting a stale number as current.
 */
const LATEST_MAX_AGE_MS = 5 * 60_000;
const MAX_DEMOTE_REASON_LENGTH = 500;
/** The registry records a reason for every kill; an omitted one is not blank. */
const DEFAULT_DEMOTE_REASON = "manual demote via API";

const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Registry refusals that mean "the last gate did not say PASS". RFC-010 names
 * that outcome NO_EVIDENCE_OF_ALPHA, so the code is translated at this
 * boundary and answered together with the blocking report; every other refusal
 * keeps the registry's own code.
 */
const GATE_REFUSAL_REASON_CODES: readonly string[] = [
  "GATE_NOT_PASSED",
  "NO_EVIDENCE_OF_ALPHA",
  // A model that was never gated has no evidence either, and the RFC names
  // that outcome NO_EVIDENCE_OF_ALPHA too. So does a model whose only PASS
  // predates the change that forced it back to shadow.
  "NO_GATE_REPORT",
  "REVALIDATION_REQUIRED",
];

function jsonError(
  reply: FastifyReply,
  statusCode: number,
  reasonCode: string,
): FastifyReply {
  return reply
    .code(statusCode)
    .send({ reason_code: reasonCode, correlation_id: reply.request.id });
}

function logFundamentalApiError(reasonCode: string, error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      service: "polymarket-fundamental",
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      error_name: error instanceof Error ? error.name : "UnknownError",
      message: "polymarket_fundamental_api_failed",
    })}\n`,
  );
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") {
    return null;
  }
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1] ?? null;
}

function queryParams(request: FastifyRequest): Record<string, unknown> {
  const query: unknown = request.query;
  return typeof query === "object" && query !== null
    ? (query as Record<string, unknown>)
    : {};
}

function stringParam(
  source: Record<string, unknown>,
  name: string,
): string | null {
  const value = source[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ISO 8601 date or date-time; anything else is rejected with 400.
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?([Zz]|[+-]\d{2}:?\d{2})?)?$/;

function parseIsoTimestamp(value: string): Date | null {
  if (!ISO_TIMESTAMP_PATTERN.test(value)) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false };

/** Optional ISO timestamp query param: absent -> null, invalid -> not ok. */
function parseOptionalAt(
  source: Record<string, unknown>,
  name: string,
): Parsed<Date | null> {
  const raw = stringParam(source, name);
  if (raw === null) {
    return source[name] === undefined
      ? { ok: true, value: null }
      : { ok: false };
  }
  const parsed = parseIsoTimestamp(raw);
  return parsed === null ? { ok: false } : { ok: true, value: parsed };
}

/** Optional positive-integer query param, clamped into [min, max]. */
function parseClampedInt(
  source: Record<string, unknown>,
  name: string,
  min: number,
  max: number,
  fallback: number,
): Parsed<number> {
  const raw = source[name];
  if (raw === undefined) {
    return { ok: true, value: fallback };
  }
  if (typeof raw !== "string" || !/^\d{1,10}$/.test(raw)) {
    return { ok: false };
  }
  return { ok: true, value: Math.min(max, Math.max(min, Number(raw))) };
}

/** Optional "true"/"false" query flag; anything else is a client error. */
function parseBooleanFlag(
  source: Record<string, unknown>,
  name: string,
): Parsed<boolean> {
  const raw = source[name];
  if (raw === undefined) {
    return { ok: true, value: false };
  }
  if (raw !== "true" && raw !== "false") {
    return { ok: false };
  }
  return { ok: true, value: raw === "true" };
}

function isFundamentalCategory(value: string): boolean {
  return FUNDAMENTAL_CATEGORIES.some((candidate) => candidate === value);
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return null;
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

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
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

/**
 * Reason code of a refused lifecycle transition. The registry is written in
 * parallel, so a refusal whose code is missing or malformed still gets a
 * stable, observable code here instead of leaking `undefined` to the operator.
 */
function refusalReasonCode(refusal: LifecycleRefusal): string {
  const candidate: unknown = refusal.reasonCode;
  return typeof candidate === "string" && REASON_CODE_PATTERN.test(candidate)
    ? candidate
    : "REGISTRY_REFUSED";
}

// ---------------------------------------------------------------------------
// Row serializers (defensive: unexpected payloads become nulls, never throws
// that would surface as an unhandled 500).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/**
 * One estimate with COMPLETE provenance. Every provenance column is echoed as
 * stored, including the nulls of a MARKET_BASELINE row: a consumer must be
 * able to tell a model estimate from a fallback without a second query.
 */
function serializeEstimate(row: Row): Row {
  return {
    estimate_id: row["estimate_id"] ?? null,
    market_id: row["market_id"] ?? null,
    token_id: row["token_id"] ?? null,
    category: row["category"] ?? null,
    decision_ts: toIso(row["decision_ts"]),
    q: row["q"] ?? null,
    q_lo: row["q_lo"] ?? null,
    q_hi: row["q_hi"] ?? null,
    source: row["source"] ?? null,
    status: row["status"] ?? null,
    model_id: row["model_id"] ?? null,
    model_version: row["model_version"] ?? null,
    feature_set_version: row["feature_set_version"] ?? null,
    git_sha: row["git_sha"] ?? null,
    data_refs: row["data_refs"] ?? null,
    market_prob: row["market_prob"] ?? null,
    exec_spread: row["exec_spread"] ?? null,
    book_stale: row["book_stale"] ?? null,
    feed_stale: row["feed_stale"] ?? null,
    thin_book: row["thin_book"] ?? null,
    rule_changed_recently: row["rule_changed_recently"] ?? null,
    fallback_reason: row["fallback_reason"] ?? null,
    interval_version: row["interval_version"] ?? null,
    microprice_version: row["microprice_version"] ?? null,
    received_at: toIso(row["received_at"]),
  };
}

function serializeModel(model: ModelRecord): Row {
  return {
    model_id: model.modelId ?? null,
    model_family: model.modelFamily ?? null,
    category: model.category ?? null,
    version: model.version ?? null,
    git_sha: model.gitSha ?? null,
    feature_set_version: model.featureSetVersion ?? null,
    hyperparams: model.hyperparams ?? null,
    seed: model.seed ?? null,
    train_window_start: toIso(model.trainWindowStart),
    train_window_end: toIso(model.trainWindowEnd),
    // A regime-mixed model is never promotable; the flag travels with the row
    // so the operator sees why before trying.
    regime_mix: model.regimeMix ?? null,
    status: model.status ?? null,
    last_gate_report_id: model.lastGateReportId ?? null,
    created_at: toIso(model.createdAt),
    promoted_at: toIso(model.promotedAt),
    demoted_at: toIso(model.demotedAt),
    retired_at: toIso(model.retiredAt),
  };
}

function serializeGateReport(report: GateReportRecord): Row {
  return {
    gate_report_id: report.gateReportId ?? null,
    model_id: report.modelId ?? null,
    category: report.category ?? null,
    verdict: report.verdict ?? null,
    failures: report.failures ?? [],
    markets_covered: report.marketsCovered ?? null,
    observations: report.observations ?? null,
    window_from: toIso(report.windowFrom),
    window_to: toIso(report.windowTo),
    metrics: report.metrics ?? null,
    git_sha: report.gitSha ?? null,
    feature_set_version: report.featureSetVersion ?? null,
    evaluated_at: toIso(report.evaluatedAt),
  };
}

function serializeCalibrationReport(row: Row): Row {
  return {
    calibration_report_id: row["calibration_report_id"] ?? null,
    category: row["category"] ?? null,
    model_id: row["model_id"] ?? null,
    window_from: toIso(row["window_from"]),
    window_to: toIso(row["window_to"]),
    observations: row["observations"] ?? null,
    markets_covered: row["markets_covered"] ?? null,
    // Brier/log loss with CI, interval coverage, horizon slices and
    // reliability bins, exactly as the daily job materialized them.
    metrics: row["payload_json"] ?? null,
    git_sha: row["git_sha"] ?? null,
    generated_at: toIso(row["generated_at"]),
  };
}

function serializeLastGate(row: Row): Row {
  return {
    gate_report_id: row["gate_report_id"] ?? null,
    verdict: row["verdict"] ?? null,
    failures: row["failures_json"] ?? [],
    markets_covered: row["markets_covered"] ?? null,
    observations: row["observations"] ?? null,
    window_from: toIso(row["window_from"]),
    window_to: toIso(row["window_to"]),
    evaluated_at: toIso(row["evaluated_at"]),
  };
}

// ---------------------------------------------------------------------------
// Shared SQL fragments
// ---------------------------------------------------------------------------

const ESTIMATE_COLUMNS =
  "estimate_id, market_id, token_id, category, decision_ts, q, q_lo, q_hi, " +
  "source, status, model_id, model_version, feature_set_version, git_sha, " +
  "data_refs, market_prob, exec_spread, book_stale, feed_stale, thin_book, " +
  "rule_changed_recently, fallback_reason, interval_version, " +
  "microprice_version, received_at";

const CALIBRATION_REPORT_COLUMNS =
  "calibration_report_id, category, model_id, window_from, window_to, " +
  "observations, markets_covered, payload_json, git_sha, generated_at";

// Latest gate evaluation per model, one round trip for the whole listing.
const LATEST_GATE_BY_MODEL_SQL = `SELECT DISTINCT ON (model_id)
          model_id, gate_report_id, verdict, failures_json, markets_covered,
          observations, window_from, window_to, evaluated_at
     FROM fundamental_gate_reports
    WHERE model_id = ANY($1::text[])
    ORDER BY model_id, evaluated_at DESC, gate_report_id DESC`;

// Fallback accounting over a report window: every consumer-visible row of the
// category, split by source and (for the baseline) by the reason the
// deterministic fallback fired. Shadow rows are excluded because they never
// served a consumer.
const FALLBACK_BREAKDOWN_SQL = `SELECT source, fallback_reason,
          COUNT(*)::bigint AS estimate_count
     FROM fundamental_estimates
    WHERE category = $1
      AND status = 'active'
      AND decision_ts >= $2
      AND decision_ts < $3
    GROUP BY source, fallback_reason
    ORDER BY source, estimate_count DESC, fallback_reason`;

interface FallbackBreakdown {
  readonly window_from: string;
  readonly window_to: string;
  readonly category: string;
  readonly estimates: number;
  readonly fallback_estimates: number;
  readonly fallback_rate: number | null;
  readonly reasons: readonly Row[];
}

async function fallbackBreakdown(
  pool: DatabasePool,
  category: FundamentalCategory,
  windowFrom: Date,
  windowTo: Date,
): Promise<FallbackBreakdown> {
  const result = await pool.query<Row>(FALLBACK_BREAKDOWN_SQL, [
    category,
    windowFrom,
    windowTo,
  ]);
  let estimates = 0;
  let fallbacks = 0;
  const reasons: Row[] = [];
  for (const row of result.rows) {
    const count = toFiniteNumber(row["estimate_count"]) ?? 0;
    estimates += count;
    if (row["source"] !== "MARKET_BASELINE") {
      continue;
    }
    fallbacks += count;
    reasons.push({
      fallback_reason:
        typeof row["fallback_reason"] === "string"
          ? row["fallback_reason"]
          : null,
      count,
    });
  }
  return {
    window_from: windowFrom.toISOString(),
    window_to: windowTo.toISOString(),
    category,
    estimates,
    fallback_estimates: fallbacks,
    // An empty window has no rate. Reporting 0 would be a fabricated metric.
    fallback_rate:
      estimates === 0 ? null : Math.round((fallbacks / estimates) * 1e6) / 1e6,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

type RouteHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown>;

export function registerFundamentalRoutes(
  app: FastifyInstance,
  deps: FundamentalRoutesDeps,
): void {
  const { pool, authService } = deps;
  const clock = deps.clock ?? ((): Date => new Date());

  const getModelFn: GetModelFn =
    deps.getModelFn ??
    (async (poolArg, modelId) => {
      const registry = await loadRegistryModule();
      return registry.getModel(poolArg, modelId);
    });
  const listModelsFn: ListModelsFn =
    deps.listModelsFn ??
    (async (poolArg) => {
      const registry = await loadRegistryModule();
      return registry.listModels(poolArg);
    });
  const latestGateReportFn: LatestGateReportFn =
    deps.latestGateReportFn ??
    (async (poolArg, modelId) => {
      const registry = await loadRegistryModule();
      return registry.latestGateReport(poolArg, modelId);
    });
  const promoteModelFn: PromoteModelFn =
    deps.promoteModelFn ??
    (async (poolArg, modelId, at) => {
      const registry = await loadRegistryModule();
      return registry.promoteModel(poolArg, modelId, at);
    });
  const demoteModelFn: DemoteModelFn =
    deps.demoteModelFn ??
    (async (poolArg, modelId, at, reason) => {
      const registry = await loadRegistryModule();
      return registry.demoteModel(poolArg, modelId, at, reason);
    });

  // Local auth guard: Bearer token validated against the RFC-002 auth
  // service. Anything but an explicit "ok" is a 401.
  async function guard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const token = bearerToken(request);
      if (token === null) {
        await jsonError(reply, 401, "AUTH_UNAUTHENTICATED");
        return;
      }
      const result = await authService.session(token);
      if (result.status !== "ok") {
        await jsonError(reply, 401, "AUTH_UNAUTHENTICATED");
      }
    } catch (error) {
      logFundamentalApiError("FUNDAMENTAL_API_FAILED", error);
      await jsonError(reply, 500, "FUNDAMENTAL_API_FAILED");
    }
  }

  // A database, registry or payload failure must never surface as an unhandled
  // 500: catch, log a structured line, answer with a stable reason code.
  function wrap(handler: RouteHandler): RouteHandler {
    return async (request, reply) => {
      try {
        return await handler(request, reply);
      } catch (error) {
        logFundamentalApiError("FUNDAMENTAL_API_FAILED", error);
        return jsonError(reply, 500, "FUNDAMENTAL_API_FAILED");
      }
    };
  }

  function pathParam(request: FastifyRequest, name: string): string {
    const params: unknown = request.params;
    const value =
      typeof params === "object" && params !== null
        ? (params as Record<string, unknown>)[name]
        : undefined;
    return typeof value === "string" ? value : "";
  }

  /** Optional JSON body { reason } of the demote call. */
  function parseReasonBody(request: FastifyRequest): Parsed<string | null> {
    const body: unknown = request.body;
    if (body === undefined || body === null) {
      return { ok: true, value: null };
    }
    if (typeof body !== "object" || Array.isArray(body)) {
      return { ok: false };
    }
    const raw = (body as Record<string, unknown>)["reason"];
    if (raw === undefined || raw === null) {
      return { ok: true, value: null };
    }
    if (
      typeof raw !== "string" ||
      raw.length === 0 ||
      raw.length > MAX_DEMOTE_REASON_LENGTH
    ) {
      return { ok: false };
    }
    return { ok: true, value: raw };
  }

  /**
   * Answer a refused lifecycle transition. An unknown model is a 404 (the same
   * code the calibration route uses); a gate that did not say PASS is the
   * RFC's 409 NO_EVIDENCE_OF_ALPHA carrying the blocking report; every other
   * refusal is a 409 keeping the registry's own reason code. Either way the
   * refusal is auditable from the response alone.
   */
  async function refuse(
    reply: FastifyReply,
    modelId: string,
    refusal: LifecycleRefusal,
  ): Promise<FastifyReply> {
    const reasonCode = refusalReasonCode(refusal);
    if (reasonCode === "MODEL_NOT_FOUND") {
      return jsonError(reply, 404, reasonCode);
    }
    if (!GATE_REFUSAL_REASON_CODES.includes(reasonCode)) {
      return jsonError(reply, 409, reasonCode);
    }
    // The blocking evidence must travel with the refusal. The registry
    // normally attaches it; when it does not, the latest gate report for the
    // model is exactly the report the gate refused on.
    const gate =
      refusal.gateReport ?? (await latestGateReportFn(pool, modelId));
    return reply.code(409).send({
      reason_code: "NO_EVIDENCE_OF_ALPHA",
      // The registry's own code says WHICH kind of missing evidence it is:
      // never gated, gated and failed, or gated before a forced re-validation.
      detail: reasonCode,
      correlation_id: reply.request.id,
      gate_report: gate === null ? null : serializeGateReport(gate),
    });
  }

  // GET /polymarket/estimates?market_id=&from=&to=&limit=&include_shadow=
  // History with complete provenance. Shadow rows are gate material, not
  // consumer material, so they are opt-in.
  app.get(
    "/polymarket/estimates",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const query = queryParams(request);
      const marketId = stringParam(query, "market_id");
      if (marketId === null) {
        return jsonError(reply, 400, "MARKET_ID_REQUIRED");
      }
      const from = parseOptionalAt(query, "from");
      const to = parseOptionalAt(query, "to");
      if (!from.ok || !to.ok) {
        return jsonError(reply, 400, "INVALID_TIMESTAMP");
      }
      const limit = parseClampedInt(
        query,
        "limit",
        1,
        ESTIMATES_MAX_LIMIT,
        ESTIMATES_DEFAULT_LIMIT,
      );
      if (!limit.ok) {
        return jsonError(reply, 400, "INVALID_LIMIT");
      }
      const includeShadow = parseBooleanFlag(query, "include_shadow");
      if (!includeShadow.ok) {
        return jsonError(reply, 400, "INVALID_INCLUDE_SHADOW");
      }

      const conditions = ["market_id = $1"];
      const params: unknown[] = [marketId];
      if (!includeShadow.value) {
        conditions.push("status = 'active'");
      }
      if (from.value !== null) {
        params.push(from.value);
        conditions.push(`decision_ts >= $${params.length}`);
      }
      if (to.value !== null) {
        params.push(to.value);
        conditions.push(`decision_ts < $${params.length}`);
      }
      const result = await pool.query<Row>(
        `SELECT ${ESTIMATE_COLUMNS}
           FROM fundamental_estimates
          WHERE ${conditions.join(" AND ")}
          ORDER BY decision_ts, estimate_id
          LIMIT ${limit.value}`,
        params,
      );
      return reply.code(200).send({
        market_id: marketId,
        include_shadow: includeShadow.value,
        limit: limit.value,
        estimates: result.rows.map(serializeEstimate),
      });
    }),
  );

  // GET /polymarket/estimates/latest?category=
  // The consumer surface: the latest VALID estimate per token. `status =
  // 'active'` is what makes shadow rows invisible here — a model still proving
  // itself must never reach a consumer.
  app.get(
    "/polymarket/estimates/latest",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const category = stringParam(queryParams(request), "category");
      if (category !== null && !isFundamentalCategory(category)) {
        return jsonError(reply, 400, "INVALID_CATEGORY");
      }
      // Freshness bound. "Latest" must not mean "whatever we last managed to
      // write": an estimate older than the staleness horizon is an ABSENCE,
      // and the consumer treats absence as a veto. Serving a day-old row here
      // would turn a veto into a stale opinion.
      const maxAgeMs = LATEST_MAX_AGE_MS;
      const params: unknown[] = [new Date(clock().getTime() - maxAgeMs)];
      const conditions = ["status = 'active'", "decision_ts >= $1"];
      if (category !== null) {
        params.push(category);
        conditions.push(`category = $${params.length}`);
      }
      const result = await pool.query<Row>(
        `SELECT DISTINCT ON (token_id) ${ESTIMATE_COLUMNS}
           FROM fundamental_estimates
          WHERE ${conditions.join(" AND ")}
          ORDER BY token_id, decision_ts DESC, estimate_id DESC
          LIMIT ${LATEST_LIMIT}`,
        params,
      );
      return reply.code(200).send({
        as_of: clock().toISOString(),
        category,
        max_age_ms: maxAgeMs,
        estimates: result.rows.map(serializeEstimate),
      });
    }),
  );

  // GET /polymarket/models — the registry with its latest gate verdict.
  app.get(
    "/polymarket/models",
    { preHandler: guard },
    wrap(async (_request, reply) => {
      const models = await listModelsFn(pool);
      const modelIds = models.map((model) => model.modelId);
      const verdicts = new Map<string, Row>();
      if (modelIds.length > 0) {
        const gates = await pool.query<Row>(LATEST_GATE_BY_MODEL_SQL, [
          modelIds,
        ]);
        for (const row of gates.rows) {
          const modelId = row["model_id"];
          if (typeof modelId === "string") {
            verdicts.set(modelId, serializeLastGate(row));
          }
        }
      }
      return reply.code(200).send({
        as_of: clock().toISOString(),
        models: models.map((model) => ({
          ...serializeModel(model),
          last_gate: verdicts.get(model.modelId) ?? null,
        })),
      });
    }),
  );

  // GET /polymarket/models/:modelId/calibration — the latest gate report and
  // the latest calibration report, plus the fallback accounting over the same
  // window. Everything here is materialized from the tables; there is no
  // hidden state and no metric computed on the fly.
  app.get(
    "/polymarket/models/:modelId/calibration",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const modelId = pathParam(request, "modelId");
      const model = await getModelFn(pool, modelId);
      if (model === null) {
        return jsonError(reply, 404, "MODEL_NOT_FOUND");
      }
      const [gate, calibrationResult] = await Promise.all([
        latestGateReportFn(pool, modelId),
        pool.query<Row>(
          `SELECT ${CALIBRATION_REPORT_COLUMNS}
             FROM fundamental_calibration_reports
            WHERE model_id = $1
            ORDER BY generated_at DESC, calibration_report_id DESC
            LIMIT 1`,
          [modelId],
        ),
      ]);
      const calibration = calibrationResult.rows[0] ?? null;
      if (gate === null && calibration === null) {
        // No gate evaluation and no calibration report: there is nothing to
        // report yet, and inventing an empty one would look like evidence.
        return jsonError(reply, 404, "NO_CALIBRATION_REPORT");
      }

      // Prefer the calibration report's window; fall back to the gate window
      // so the fallback rate always refers to the window being reported.
      const windowFrom =
        toDate(calibration?.["window_from"]) ??
        (gate === null ? null : toDate(gate.windowFrom));
      const windowTo =
        toDate(calibration?.["window_to"]) ??
        (gate === null ? null : toDate(gate.windowTo));
      const fallback =
        windowFrom === null || windowTo === null
          ? null
          : await fallbackBreakdown(pool, model.category, windowFrom, windowTo);

      return reply.code(200).send({
        model: serializeModel(model),
        gate_report: gate === null ? null : serializeGateReport(gate),
        calibration_report:
          calibration === null ? null : serializeCalibrationReport(calibration),
        fallback,
      });
    }),
  );

  // POST /polymarket/models/:modelId/promote — shadow -> active, and only when
  // the registry's own gate says PASS. This route creates no order, no signal
  // and touches no wallet: it flips a status column.
  app.post(
    "/polymarket/models/:modelId/promote",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const modelId = pathParam(request, "modelId");
      const result = await promoteModelFn(pool, modelId, clock());
      if (!result.ok) {
        return refuse(reply, modelId, result);
      }
      return reply.code(200).send({ model: serializeModel(result.model) });
    }),
  );

  // POST /polymarket/models/:modelId/demote — the manual kill switch back to
  // the market baseline, with an optional operator reason recorded by the
  // registry. Demotion is never refused for lack of evidence.
  app.post(
    "/polymarket/models/:modelId/demote",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const modelId = pathParam(request, "modelId");
      const reason = parseReasonBody(request);
      if (!reason.ok) {
        return jsonError(reply, 400, "INVALID_REASON");
      }
      const result = await demoteModelFn(
        pool,
        modelId,
        clock(),
        reason.value ?? DEFAULT_DEMOTE_REASON,
      );
      if (!result.ok) {
        return refuse(reply, modelId, result);
      }
      return reply.code(200).send({ model: serializeModel(result.model) });
    }),
  );
}
