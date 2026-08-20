// RFC-010 task 9: the promotion gate and its auditable NO_EVIDENCE_OF_ALPHA
// event.
//
// The market price is a brutally strong baseline (Brier ~0.074 in 2024 with a
// calibration term of ~0.0005). The gate therefore does NOT ask "is the model
// better?" — it asks the only question the evidence can answer: "has the model
// been shown NOT to be worse than the executable market baseline, on enough
// resolved markets, in every horizon slice?".
//
// PASS means exactly that and nothing more. It is NOT evidence of a
// net-of-cost edge: costs, fees, slippage and portfolio construction are
// decided downstream (RFC-013), and nothing in this module may be read as a
// claim about profit.
//
// The thresholds are a FLOOR, never a ceiling. A caller that passes a weaker
// threshold gets the RFC value instead: the gate can be made stricter from
// configuration, never softer.

import { demoteModel, recordModelEvent } from "./registry.js";
import type { QueryPool } from "./features.js";
import type {
  CalibrationMetrics,
  ConfidenceInterval,
  GateResult,
  ModelRecord,
} from "./types.js";

const SERVICE = "polymarket-fundamental";

/** RFC-010: at least 100 resolved markets covered in shadow/walk-forward. */
const RFC_MIN_MARKETS = 100;

/** RFC-010: no horizon slice may degrade the Brier score by more than 20%. */
const RFC_MAX_HORIZON_DEGRADATION = 0.2;

export interface GateThresholds {
  /** Minimum resolved markets covered; 100 from the RFC, never lower it. */
  readonly minMarkets: number;
  /** Relative Brier degradation that fails a horizon slice (0.20 = 20%). */
  readonly maxHorizonDegradation: number;
}

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
 * Non-inferiority test on a delta (model - baseline) where LOWER IS BETTER:
 * the whole 95% block-bootstrap interval must sit at or below zero, so that
 * "the model is worse" is excluded rather than merely unproven. A non-finite
 * bound fails: a metric that cannot be read is never evidence.
 */
function nonInferior(interval: ConfidenceInterval | undefined): boolean {
  return interval !== undefined && Number.isFinite(interval.upper)
    ? interval.upper <= 0
    : false;
}

/** Non-negative integer for a column the schema constrains to >= 0. */
function toCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * Pure evaluation. PASS requires ALL of:
 *   - marketsCovered >= minMarkets;
 *   - the 95% block-bootstrap CI UPPER bound of (model - baseline) <= 0 for
 *     BOTH Brier and log loss (non-inferiority: the CI must exclude "the model
 *     is worse");
 *   - at least one horizon slice, and no slice with relative Brier degradation
 *     above maxHorizonDegradation. The stratification itself is required: the
 *     market's miscalibration grows with time-to-expiration, so an unstratified
 *     comparison hides exactly the slices where the model is most likely to be
 *     worse.
 * Any failure yields NO_EVIDENCE_OF_ALPHA with every failed criterion listed.
 */
export function evaluateGate(
  metrics: CalibrationMetrics,
  marketsCovered: number,
  observations: number,
  windowFrom: Date,
  windowTo: Date,
  thresholds: GateThresholds,
): GateResult {
  // Thresholds may only be tightened. A configuration that tried to lower the
  // sample floor or raise the tolerated degradation is silently overruled here
  // — this is the last line before a model becomes visible to consumers.
  const minMarkets = Number.isFinite(thresholds.minMarkets)
    ? Math.max(Math.trunc(thresholds.minMarkets), RFC_MIN_MARKETS)
    : RFC_MIN_MARKETS;
  const maxHorizonDegradation = Number.isFinite(
    thresholds.maxHorizonDegradation,
  )
    ? Math.min(thresholds.maxHorizonDegradation, RFC_MAX_HORIZON_DEGRADATION)
    : RFC_MAX_HORIZON_DEGRADATION;

  const failures: string[] = [];

  if (!(windowTo.getTime() > windowFrom.getTime())) {
    failures.push("INVALID_WINDOW");
  }
  if (!(observations > 0)) {
    failures.push("NO_OBSERVATIONS");
  }
  if (!(marketsCovered >= minMarkets)) {
    failures.push("INSUFFICIENT_MARKETS");
  }
  if (!nonInferior(metrics.deltaBrier)) {
    failures.push("BRIER_NOT_NON_INFERIOR");
  }
  if (!nonInferior(metrics.deltaLogLoss)) {
    failures.push("LOG_LOSS_NOT_NON_INFERIOR");
  }

  const slices = metrics.horizonSlices;
  if (slices.length === 0) {
    failures.push("HORIZON_SLICES_MISSING");
  }
  for (const slice of slices) {
    if (slice.count <= 0) {
      // An empty bucket carries no evidence of degradation either way.
      continue;
    }
    // Non-finite degradation counts as degraded: the gate never passes on a
    // slice metric it cannot read.
    if (!(slice.relativeBrierDegradation <= maxHorizonDegradation)) {
      failures.push(`HORIZON_DEGRADATION:${slice.bucket}`);
    }
  }

  return {
    verdict: failures.length === 0 ? "PASS" : "NO_EVIDENCE_OF_ALPHA",
    failures,
    metrics,
    marketsCovered,
    observations,
    windowFrom,
    windowTo,
  };
}

export interface RunGateDeps {
  readonly pool: QueryPool;
  readonly model: ModelRecord;
  readonly metrics: CalibrationMetrics;
  readonly marketsCovered: number;
  readonly observations: number;
  readonly windowFrom: Date;
  readonly windowTo: Date;
  readonly thresholds: GateThresholds;
  readonly gitSha: string;
  readonly at: Date;
}

/**
 * Evaluate, persist the gate report, point the model at it, and record either a
 * gate_pass or a no_evidence_of_alpha event with the report attached. A model
 * that is ACTIVE and fails is demoted back to shadow in the same call — the
 * category returns to the market baseline immediately, before anyone has to
 * read the report.
 *
 * The report is written FIRST: `fundamental_models.last_gate_report_id` has a
 * foreign key to it, and an event that pointed at a report that does not exist
 * would not be an audit trail.
 */
export async function runGate(
  deps: RunGateDeps,
): Promise<{ readonly result: GateResult; readonly gateReportId: number }> {
  const result = evaluateGate(
    deps.metrics,
    deps.marketsCovered,
    deps.observations,
    deps.windowFrom,
    deps.windowTo,
    deps.thresholds,
  );

  const inserted = await deps.pool.query<Record<string, unknown>>(
    `INSERT INTO fundamental_gate_reports
       (model_id, category, verdict, markets_covered, observations,
        window_from, window_to, metrics_json, failures_json, git_sha,
        feature_set_version, evaluated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12)
     RETURNING gate_report_id`,
    [
      deps.model.modelId,
      deps.model.category,
      result.verdict,
      toCount(deps.marketsCovered),
      toCount(deps.observations),
      deps.windowFrom,
      deps.windowTo,
      JSON.stringify(deps.metrics),
      JSON.stringify(result.failures),
      deps.gitSha,
      deps.model.featureSetVersion,
      deps.at,
    ],
  );
  const rawId: unknown = inserted.rows[0]?.gate_report_id;
  const gateReportId = Number(
    typeof rawId === "string" || typeof rawId === "number" ? rawId : Number.NaN,
  );
  if (!Number.isFinite(gateReportId)) {
    logJson("error", "GATE_REPORT_NOT_PERSISTED", "fundamental_gate_failed", {
      model_id: deps.model.modelId,
      verdict: result.verdict,
    });
    throw new Error(
      `GATE_REPORT_NOT_PERSISTED: ${deps.model.modelId} gate report was not written`,
    );
  }

  await deps.pool.query(
    `UPDATE fundamental_models SET last_gate_report_id = $2 WHERE model_id = $1`,
    [deps.model.modelId, gateReportId],
  );

  await recordModelEvent(deps.pool, {
    modelId: deps.model.modelId,
    eventType: result.verdict === "PASS" ? "gate_pass" : "no_evidence_of_alpha",
    gateReportId,
    payload: {
      verdict: result.verdict,
      failures: result.failures,
      category: deps.model.category,
      markets_covered: deps.marketsCovered,
      observations: deps.observations,
      window_from: deps.windowFrom.toISOString(),
      window_to: deps.windowTo.toISOString(),
      git_sha: deps.gitSha,
    },
    at: deps.at,
  });

  if (result.verdict === "PASS") {
    logJson("info", "GATE_PASS", "fundamental_gate_pass", {
      model_id: deps.model.modelId,
      category: deps.model.category,
      gate_report_id: gateReportId,
      markets_covered: deps.marketsCovered,
    });
  } else {
    logJson(
      "warn",
      "NO_EVIDENCE_OF_ALPHA",
      "fundamental_gate_no_evidence_of_alpha",
      {
        model_id: deps.model.modelId,
        category: deps.model.category,
        gate_report_id: gateReportId,
        failures: result.failures,
      },
    );
    if (deps.model.status === "active") {
      // A promoted model that stops clearing the gate goes back to shadow at
      // once; the category serves the market baseline again.
      await demoteModel(
        deps.pool,
        deps.model.modelId,
        deps.at,
        "NO_EVIDENCE_OF_ALPHA",
      );
    }
  }

  return { result, gateReportId };
}
