// RFC-010 task 11: the daily calibration report, and the gate evaluation that
// reads from it. Everything here is reproducible FROM THE TABLES: the report is
// a pure function of the stored estimates and the stored labels, with no hidden
// state, so re-running the job on the same data reproduces the same numbers.
//
// The report is descriptive. It never asserts edge: a model that is not worse
// than the market baseline has only earned the right to be considered, and the
// gate says exactly that and nothing more.

import type { FundamentalConfig } from "./config.js";
import type { QueryPool } from "./features.js";
import { runGate, type GateThresholds } from "./gate.js";
import { listModels } from "./registry.js";
import type {
  CalibrationMetrics,
  GateResult,
  ModelRecord,
  ScoredObservation,
} from "./types.js";
import { computeCalibrationMetrics } from "./walkforward.js";

const SERVICE = "polymarket-fundamental";

/** Below this the market price is degenerate and the observation is annex-only. */
/**
 * Upper bound on the observations one gate evaluation loads. At the RFC's
 * volumetry a wide window holds millions of rows and the estimator runs in a
 * 384 MiB container; the cap is a memory bound, and hitting it is logged.
 */
export const MAX_SCORED_OBSERVATIONS = 400_000;

export const DEGENERATE_LOW = 0.01;
export const DEGENERATE_HIGH = 0.99;

function logJson(
  level: "info" | "warn" | "error",
  reasonCode: string,
  extra: Record<string, unknown> = {},
): void {
  process.stderr.write(
    `${JSON.stringify({
      level,
      service: SERVICE,
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      ...extra,
    })}\n`,
  );
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

/**
 * Paired model-vs-baseline observations for one model, joined to the label
 * store. The baseline is the executable microprice recorded ON THE SAME ROW at
 * the same decision instant, so the comparison is per-observation and cannot
 * drift into an aggregate-vs-aggregate comparison.
 *
 * `decision_ts < publicly_knowable_ts` is the honesty filter: an estimate made
 * after the outcome became public is not a forecast.
 */
export async function loadScoredObservations(
  pool: QueryPool,
  modelId: string,
  from: Date,
  to: Date,
): Promise<ScoredObservation[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT e.token_id, e.market_id, e.decision_ts, e.q, e.q_lo, e.q_hi,
            e.market_prob, l.label, l.publicly_knowable_ts, l.disputed
       FROM fundamental_estimates e
       JOIN fundamental_labels l ON l.token_id = e.token_id
      WHERE e.model_id = $1
        AND e.source = 'MODEL'
        AND e.market_prob IS NOT NULL
        AND l.is_final IS TRUE
        AND l.publicly_knowable_ts IS NOT NULL
        AND e.decision_ts < l.publicly_knowable_ts
        AND e.decision_ts >= $2
        AND e.decision_ts < $3
      ORDER BY e.decision_ts ASC, e.token_id ASC
      LIMIT $4`,
    [modelId, from, to, MAX_SCORED_OBSERVATIONS + 1],
  );
  if (result.rows.length > MAX_SCORED_OBSERVATIONS) {
    // No silent caps: a truncated evidence set is reported, never quietly
    // scored as if it were the whole window.
    logJson("warn", "OBSERVATIONS_TRUNCATED", {
      model_id: modelId,
      limit: MAX_SCORED_OBSERVATIONS,
      window_from: from.toISOString(),
      window_to: to.toISOString(),
    });
    result.rows.length = MAX_SCORED_OBSERVATIONS;
  }

  const observations: ScoredObservation[] = [];
  for (const row of result.rows) {
    const decisionTs = toDate(row.decision_ts);
    const knowableTs = toDate(row.publicly_knowable_ts);
    const label = Number(row.label);
    const modelQ = Number(row.q);
    const baselineQ = Number(row.market_prob);
    if (
      decisionTs === null ||
      knowableTs === null ||
      !Number.isFinite(label) ||
      !Number.isFinite(modelQ) ||
      !Number.isFinite(baselineQ)
    ) {
      continue;
    }
    observations.push({
      tokenId: String(row.token_id),
      conditionId: String(row.market_id),
      decisionTs,
      label,
      modelQ,
      baselineQ,
      modelLo: Number(row.q_lo),
      modelHi: Number(row.q_hi),
      horizonMs: knowableTs.getTime() - decisionTs.getTime(),
      disputed: row.disputed === true,
      degenerate: baselineQ > DEGENERATE_HIGH || baselineQ < DEGENERATE_LOW,
    });
  }
  return observations;
}

export interface FallbackRates {
  readonly total: number;
  readonly fallbacks: number;
  /** null for an empty window: "no data" is not the same as "0% fallback". */
  readonly rate: number | null;
  readonly byReason: Record<string, number>;
}

/** Share of consumer rows that degraded to the baseline, and why. */
export async function loadFallbackRates(
  pool: QueryPool,
  category: string,
  from: Date,
  to: Date,
): Promise<FallbackRates> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT COALESCE(fallback_reason, 'NONE') AS reason, count(*) AS rows_count
       FROM fundamental_estimates
      WHERE category = $1
        AND status = 'active'
        AND decision_ts >= $2
        AND decision_ts < $3
      GROUP BY 1`,
    [category, from, to],
  );
  const byReason: Record<string, number> = {};
  let total = 0;
  let fallbacks = 0;
  for (const row of result.rows) {
    const reason = String(row.reason);
    const count = Number(row.rows_count);
    if (!Number.isFinite(count)) {
      continue;
    }
    total += count;
    if (reason !== "NONE") {
      byReason[reason] = count;
      fallbacks += count;
    }
  }
  return {
    total,
    fallbacks,
    rate: total === 0 ? null : fallbacks / total,
    byReason,
  };
}

/** Distinct resolved markets covered by a set of observations. */
export function marketsCovered(
  observations: readonly ScoredObservation[],
): number {
  return new Set(
    observations
      .filter((observation) => !observation.disputed && !observation.degenerate)
      .map((observation) => observation.conditionId),
  ).size;
}

export interface CalibrationReportRow {
  readonly calibrationReportId: number;
  readonly category: string;
  readonly modelId: string | null;
  readonly windowFrom: Date;
  readonly windowTo: Date;
  readonly observations: number;
  readonly marketsCovered: number;
  readonly payload: Record<string, unknown>;
  readonly generatedAt: Date;
}

export async function insertCalibrationReport(
  pool: QueryPool,
  input: {
    readonly category: string;
    readonly modelId: string | null;
    readonly windowFrom: Date;
    readonly windowTo: Date;
    readonly observations: number;
    readonly marketsCovered: number;
    readonly payload: Record<string, unknown>;
    readonly gitSha: string | null;
    readonly generatedAt: Date;
  },
): Promise<number> {
  const result = await pool.query<{ calibration_report_id: number | string }>(
    `INSERT INTO fundamental_calibration_reports (
       category, model_id, window_from, window_to, observations,
       markets_covered, payload_json, git_sha, generated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING calibration_report_id`,
    [
      input.category,
      input.modelId,
      input.windowFrom,
      input.windowTo,
      input.observations,
      input.marketsCovered,
      JSON.stringify(input.payload),
      input.gitSha,
      input.generatedAt,
    ],
  );
  return Number(result.rows[0]?.calibration_report_id ?? 0);
}

/**
 * When the calibration last produced a report, from the reports themselves.
 * The daily job is scheduled against THIS, not against a timer started at
 * boot: a timer is reset by every deploy, so a week of frequent deploys would
 * silently starve the job that produces the only evidence a gate can read.
 */
export async function lastCalibrationAt(pool: QueryPool): Promise<Date | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT max(generated_at) AS last_at FROM fundamental_calibration_reports`,
  );
  return toDate(result.rows[0]?.last_at);
}

export async function latestCalibrationReport(
  pool: QueryPool,
  modelId: string,
): Promise<CalibrationReportRow | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT calibration_report_id, category, model_id, window_from, window_to,
            observations, markets_covered, payload_json, generated_at
       FROM fundamental_calibration_reports
      WHERE model_id = $1
      ORDER BY generated_at DESC, calibration_report_id DESC
      LIMIT 1`,
    [modelId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  let payload: unknown = row.payload_json;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = {};
    }
  }
  return {
    calibrationReportId: Number(row.calibration_report_id),
    category: String(row.category),
    modelId: row.model_id === null ? null : String(row.model_id),
    windowFrom: toDate(row.window_from) ?? new Date(0),
    windowTo: toDate(row.window_to) ?? new Date(0),
    observations: Number(row.observations),
    marketsCovered: Number(row.markets_covered),
    payload:
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {},
    generatedAt: toDate(row.generated_at) ?? new Date(0),
  };
}

export interface CalibrationJobDeps {
  readonly pool: QueryPool;
  readonly config: FundamentalConfig;
  readonly gitSha: string | null;
  readonly clock?: () => Date;
  /** How far back the daily report looks; defaults to 180 days. */
  readonly windowDays?: number;
}

export interface CalibrationJobEntry {
  readonly modelId: string;
  readonly category: string;
  readonly observations: number;
  readonly marketsCovered: number;
  readonly metrics: CalibrationMetrics | null;
  readonly gate: GateResult | null;
  readonly gateReportId: number | null;
  readonly calibrationReportId: number;
}

export interface CalibrationJobReport {
  readonly generatedAt: Date;
  readonly entries: readonly CalibrationJobEntry[];
}

/**
 * Daily job: for every non-retired model, materialize the calibration report
 * and evaluate the gate. A model with too little coverage still gets a report
 * (with the coverage stated) and a NO_EVIDENCE_OF_ALPHA verdict — silence would
 * look like success.
 */
export async function runCalibrationJob(
  deps: CalibrationJobDeps,
): Promise<CalibrationJobReport> {
  const clock = deps.clock ?? ((): Date => new Date());
  const generatedAt = clock();
  const windowDays = deps.windowDays ?? 180;
  const windowFrom = new Date(
    generatedAt.getTime() - windowDays * 24 * 3_600_000,
  );
  const thresholds: GateThresholds = {
    minMarkets: deps.config.gate.minMarkets,
    maxHorizonDegradation: deps.config.gate.maxHorizonDegradation,
  };

  const models: ModelRecord[] = (await listModels(deps.pool)).filter(
    (model) => model.status !== "retired",
  );
  const entries: CalibrationJobEntry[] = [];

  for (const model of models) {
    try {
      const observations = await loadScoredObservations(
        deps.pool,
        model.modelId,
        windowFrom,
        generatedAt,
      );
      const metrics = computeCalibrationMetrics(observations, {
        resamples: deps.config.gate.bootstrapResamples,
        seed: deps.config.gate.bootstrapSeed,
        blockDays: deps.config.gate.blockDays,
      });
      const covered = marketsCovered(observations);
      // The requested window is 180 days, but the estimates table is pruned by
      // TTL and quota long before that. Reporting the requested window as if it
      // were backed by data would overstate the evidence, so the report also
      // carries the window the observations actually span.
      const observedFrom = observations[0]?.decisionTs ?? null;
      const observedTo =
        observations[observations.length - 1]?.decisionTs ?? null;
      const fallbacks = await loadFallbackRates(
        deps.pool,
        model.category,
        windowFrom,
        generatedAt,
      );

      const gate = await runGate({
        pool: deps.pool,
        model,
        metrics,
        marketsCovered: covered,
        observations: metrics.observations,
        windowFrom: observedFrom ?? windowFrom,
        windowTo: observedTo ?? generatedAt,
        thresholds,
        gitSha: deps.gitSha ?? model.gitSha,
        at: generatedAt,
      });

      const calibrationReportId = await insertCalibrationReport(deps.pool, {
        category: model.category,
        modelId: model.modelId,
        windowFrom,
        windowTo: generatedAt,
        observations: metrics.observations,
        marketsCovered: covered,
        payload: {
          metrics: metrics as unknown as Record<string, unknown>,
          fallbacks,
          data_window: {
            requested_from: windowFrom.toISOString(),
            requested_to: generatedAt.toISOString(),
            observed_from:
              observedFrom === null ? null : observedFrom.toISOString(),
            observed_to: observedTo === null ? null : observedTo.toISOString(),
          },
          gate: {
            verdict: gate.result.verdict,
            failures: gate.result.failures,
            gate_report_id: gate.gateReportId,
          },
          model: {
            model_id: model.modelId,
            version: model.version,
            status: model.status,
            feature_set_version: model.featureSetVersion,
            git_sha: model.gitSha,
            regime_mix: model.regimeMix,
          },
        },
        gitSha: deps.gitSha,
        generatedAt,
      });

      entries.push({
        modelId: model.modelId,
        category: model.category,
        observations: metrics.observations,
        marketsCovered: covered,
        metrics,
        gate: gate.result,
        gateReportId: gate.gateReportId,
        calibrationReportId,
      });
    } catch (error: unknown) {
      // A failing report must never take the estimator down; it is logged and
      // the next model is evaluated.
      logJson("error", "CALIBRATION_REPORT_FAILED", {
        model_id: model.modelId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  logJson("info", "CALIBRATION_JOB_DONE", {
    generated_at: generatedAt.toISOString(),
    models: entries.length,
  });
  return { generatedAt, entries };
}
