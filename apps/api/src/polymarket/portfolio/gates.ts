// RFC-013 task 9: the six gates that would unlock RFC-009, measured — never
// judged.
//
// Every gate returns PASS, FAIL or INSUFFICIENT_DATA with the numbers that
// produced it. There is no path here that a human can talk past: a gate is a
// computation over recorded evidence, and the endpoint publishes the same
// numbers the report does.
//
// INSUFFICIENT_DATA is deliberately distinct from FAIL. "We have not measured
// enough yet" and "we measured and it did not work" are different states, and
// collapsing them would let a young, empty track record look like a rejection —
// or worse, let a rejection look like youth.

import type { GateConfig } from "./config.js";
import {
  blockBootstrapMean,
  brierScore,
  brierSkillScore,
  logLoss,
  type BootstrapResult,
} from "./bootstrap.js";
import type { GateId, GateReasonCode, GateStatus } from "./types.js";

export interface GateResult {
  readonly gate: GateId;
  readonly status: GateStatus;
  readonly reasonCode: GateReasonCode | null;
  readonly metrics: Readonly<Record<string, unknown>>;
}

export interface ClosedPosition {
  /** Realized PnL in USD. */
  readonly pnl: number;
  readonly conditionId: string;
  readonly category: string | null;
  readonly closedAt: Date;
}

export interface ResolvedForecast {
  readonly conditionId: string;
  /** The model probability used at decision time. */
  readonly modelProbability: number;
  /** The executable market probability at the same instant. */
  readonly marketProbability: number;
  readonly outcome: 0 | 1;
  /**
   * Instant the outcome became publicly verifiable. NOT `closedTime`, which
   * postdates it — a label built from closedTime leaks the answer backwards.
   */
  readonly outcomeKnownAt: Date;
  /** Instant the forecast was made. Must precede outcomeKnownAt. */
  readonly forecastAt: Date;
}

export interface G1Input {
  readonly forecasts: readonly ResolvedForecast[];
  readonly config: GateConfig;
}

/**
 * G1 — model calibration. Walk-forward over resolved markets, never k-fold:
 * shuffling time would train on the future.
 *
 * Two bars, both required: the promoted model must not be WORSE than the price
 * itself (a model that cannot beat the market price is not a model), and the
 * signal actually used for entries must score under the RFC's Brier ceiling.
 */
export function evaluateG1(input: G1Input): GateResult {
  // Leakage guard first: a forecast made at or after the outcome was knowable
  // is not a forecast, and one such row poisons the whole score.
  const leaking = input.forecasts.filter(
    (point) => point.forecastAt.getTime() >= point.outcomeKnownAt.getTime(),
  );
  if (leaking.length > 0) {
    return {
      gate: "G1",
      status: "FAIL",
      reasonCode: "G1_CALIBRATION_NOT_MET",
      metrics: {
        leaking_forecasts: leaking.length,
        detail: "forecast timestamps at or after the outcome became knowable",
      },
    };
  }

  const distinctMarkets = new Set(
    input.forecasts.map((point) => point.conditionId),
  ).size;
  if (distinctMarkets < input.config.g1MinResolvedMarkets) {
    return {
      gate: "G1",
      status: "INSUFFICIENT_DATA",
      reasonCode: "G1_CALIBRATION_NOT_MET",
      metrics: {
        resolved_markets: distinctMarkets,
        required: input.config.g1MinResolvedMarkets,
      },
    };
  }

  const modelPoints = input.forecasts.map((point) => ({
    probability: point.modelProbability,
    outcome: point.outcome,
  }));
  const marketPoints = input.forecasts.map((point) => ({
    probability: point.marketProbability,
    outcome: point.outcome,
  }));

  const modelBrier = brierScore(modelPoints);
  const marketBrier = brierScore(marketPoints);
  const modelLogLoss = logLoss(modelPoints);
  const marketLogLoss = logLoss(marketPoints);
  const bss = brierSkillScore(modelBrier, marketBrier);

  const beatsPrice = modelBrier <= marketBrier && modelLogLoss <= marketLogLoss;
  const underCeiling = modelBrier < input.config.g1MaxBrier;
  const passed = beatsPrice && underCeiling;

  return {
    gate: "G1",
    status: passed ? "PASS" : "FAIL",
    reasonCode: passed ? null : "G1_CALIBRATION_NOT_MET",
    metrics: {
      resolved_markets: distinctMarkets,
      forecasts: input.forecasts.length,
      model_brier: modelBrier,
      market_brier: marketBrier,
      model_log_loss: modelLogLoss,
      market_log_loss: marketLogLoss,
      brier_skill_score: bss,
      beats_price: beatsPrice,
      under_ceiling: underCeiling,
      ceiling: input.config.g1MaxBrier,
    },
  };
}

export interface G2Input {
  readonly closed: readonly ClosedPosition[];
  /** Start of the continuous paper run, after any G5 reset. */
  readonly clockStart: Date | null;
  readonly now: Date;
  readonly config: GateConfig;
}

export interface G2Result extends GateResult {
  readonly bootstrap: BootstrapResult | null;
}

const DAY_MS = 24 * 3_600_000;

/**
 * G2 — paper with realism. Volume, breadth and a bootstrapped interval that
 * clears zero AFTER the 50% haircut.
 *
 * The haircut is not pessimism for its own sake: paper-to-live degradation of
 * 20-50% is the documented expectation, so an edge that only survives at full
 * strength has not shown it would survive at all.
 */
export function evaluateG2(input: G2Input): G2Result {
  const days =
    input.clockStart === null
      ? 0
      : (input.now.getTime() - input.clockStart.getTime()) / DAY_MS;
  const distinctMarkets = new Set(
    input.closed.map((position) => position.conditionId),
  ).size;
  const distinctCategories = new Set(
    input.closed.map((position) => position.category ?? "unknown"),
  ).size;

  const shortfalls: Record<string, unknown> = {};
  if (days < input.config.g2MinDays) {
    shortfalls.days = { have: days, need: input.config.g2MinDays };
  }
  if (input.closed.length < input.config.g2MinClosedPositions) {
    shortfalls.closed_positions = {
      have: input.closed.length,
      need: input.config.g2MinClosedPositions,
    };
  }
  if (distinctMarkets < input.config.g2MinDistinctMarkets) {
    shortfalls.distinct_markets = {
      have: distinctMarkets,
      need: input.config.g2MinDistinctMarkets,
    };
  }
  if (distinctCategories < input.config.g2MinCategories) {
    shortfalls.categories = {
      have: distinctCategories,
      need: input.config.g2MinCategories,
    };
  }

  if (Object.keys(shortfalls).length > 0) {
    return {
      gate: "G2",
      status: "INSUFFICIENT_DATA",
      reasonCode: "G2_INSUFFICIENT_PAPER",
      metrics: {
        days,
        closed_positions: input.closed.length,
        distinct_markets: distinctMarkets,
        categories: distinctCategories,
        shortfalls,
      },
      bootstrap: null,
    };
  }

  const ordered = [...input.closed].sort(
    (a, b) => a.closedAt.getTime() - b.closedAt.getTime(),
  );
  const bootstrap = blockBootstrapMean({
    samples: ordered.map((position) => position.pnl),
    resamples: input.config.bootstrapResamples,
    blockSize: input.config.bootstrapBlockSize,
    seed: input.config.bootstrapSeed,
    haircut: input.config.g2EdgeHaircut,
  });

  return {
    gate: "G2",
    status: bootstrap.aboveZero ? "PASS" : "FAIL",
    // The RFC names this code specifically: a measured, honest "no alpha here".
    reasonCode: bootstrap.aboveZero ? null : "NO_EVIDENCE_OF_ALPHA",
    metrics: {
      days,
      closed_positions: input.closed.length,
      distinct_markets: distinctMarkets,
      categories: distinctCategories,
      mean_pnl: bootstrap.mean,
      mean_pnl_after_haircut: bootstrap.haircutMean,
      ci95_low: bootstrap.ciLow,
      ci95_high: bootstrap.ciHigh,
      haircut: input.config.g2EdgeHaircut,
      resamples: bootstrap.resamples,
      block_size: bootstrap.blockSize,
      seed: bootstrap.seed,
    },
    bootstrap,
  };
}

export interface G3Input {
  /** Cap breaches that were NOT blocked automatically. */
  readonly unblockedBreaches: number;
  readonly maxDrawdown: number;
  readonly drawdownMax: number;
  /** Breaker kinds proven to fire in an injected scenario. */
  readonly breakersExercised: readonly string[];
  readonly breakersRequired: readonly string[];
}

/** G3 — risk survival: no unblocked breach, drawdown inside the limit, and
 * every circuit breaker demonstrated in an injected scenario. */
export function evaluateG3(input: G3Input): GateResult {
  const missing = input.breakersRequired.filter(
    (kind) => !input.breakersExercised.includes(kind),
  );
  const passed =
    input.unblockedBreaches === 0 &&
    input.maxDrawdown < input.drawdownMax &&
    missing.length === 0;
  return {
    gate: "G3",
    status: passed ? "PASS" : "FAIL",
    reasonCode: passed ? null : "G3_RISK_BREACH",
    metrics: {
      unblocked_breaches: input.unblockedBreaches,
      max_drawdown: input.maxDrawdown,
      drawdown_max: input.drawdownMax,
      breakers_exercised: input.breakersExercised,
      breakers_missing: missing,
    },
  };
}

export interface G4Input {
  /** Median relative error between simulated and real fee, in [0, 1]. */
  readonly feeMedianError: number | null;
  /** Mean of (simulated slippage - realized slippage). Negative = optimistic. */
  readonly slippageBias: number | null;
  readonly soakDays: number;
  readonly killSwitchExercised: boolean;
  readonly reduceOnlyExercised: boolean;
  readonly config: GateConfig;
}

/**
 * G4 — reconciliation and operation. The slippage check is one-sided on
 * purpose: simulating MORE slippage than reality is conservative and fine;
 * simulating less is the optimistic bias the RFC forbids.
 */
export function evaluateG4(input: G4Input): GateResult {
  if (input.feeMedianError === null || input.slippageBias === null) {
    return {
      gate: "G4",
      status: "INSUFFICIENT_DATA",
      reasonCode: "G4_RECONCILIATION_OFF",
      metrics: {
        fee_median_error: input.feeMedianError,
        slippage_bias: input.slippageBias,
        detail: "no reconciled fills yet",
      },
    };
  }
  const feeOk = input.feeMedianError < input.config.g4MaxFeeMedianError;
  const slippageOk = input.slippageBias >= 0;
  const soakOk = input.soakDays >= input.config.g4MinSoakDays;
  const passed =
    feeOk &&
    slippageOk &&
    soakOk &&
    input.killSwitchExercised &&
    input.reduceOnlyExercised;
  return {
    gate: "G4",
    status: passed ? "PASS" : "FAIL",
    reasonCode: passed ? null : "G4_RECONCILIATION_OFF",
    metrics: {
      fee_median_error: input.feeMedianError,
      fee_ceiling: input.config.g4MaxFeeMedianError,
      slippage_bias: input.slippageBias,
      slippage_optimistic: !slippageOk,
      soak_days: input.soakDays,
      soak_required: input.config.g4MinSoakDays,
      kill_switch_exercised: input.killSwitchExercised,
      reduce_only_exercised: input.reduceOnlyExercised,
    },
  };
}

export interface CategoryClock {
  readonly category: string;
  readonly clockStart: Date;
  readonly regimeFingerprint: string;
  readonly lastResetReason: string | null;
}

export interface G5Input {
  readonly clocks: readonly CategoryClock[];
  /** Current regime fingerprint per category, recomputed from live params. */
  readonly currentFingerprints: Readonly<Record<string, string>>;
  readonly now: Date;
  readonly config: GateConfig;
}

/**
 * G5 — regime freshness. The G2 window must lie entirely after the venue's
 * last relevant change, PER CATEGORY: fees differ by category, and V2 killed
 * strategies that were live under V1.
 *
 * A fingerprint mismatch means the clock has not been reset for a change that
 * already happened, which is itself a failure — the evidence being counted was
 * gathered under a regime that no longer exists.
 */
export function evaluateG5(input: G5Input): GateResult {
  const stale: string[] = [];
  const tooYoung: string[] = [];
  for (const clock of input.clocks) {
    const current = input.currentFingerprints[clock.category];
    if (current !== undefined && current !== clock.regimeFingerprint) {
      stale.push(clock.category);
    }
    const days = (input.now.getTime() - clock.clockStart.getTime()) / DAY_MS;
    if (days < input.config.g2MinDays) {
      tooYoung.push(clock.category);
    }
  }
  if (input.clocks.length === 0) {
    return {
      gate: "G5",
      status: "INSUFFICIENT_DATA",
      reasonCode: "G5_REGIME_STALE",
      metrics: { detail: "no category clock started yet" },
    };
  }
  const passed = stale.length === 0 && tooYoung.length === 0;
  return {
    gate: "G5",
    status: passed ? "PASS" : stale.length > 0 ? "FAIL" : "INSUFFICIENT_DATA",
    reasonCode: passed ? null : "G5_REGIME_STALE",
    metrics: {
      categories: input.clocks.length,
      fingerprint_mismatch: stale,
      below_minimum_days: tooYoung,
      required_days: input.config.g2MinDays,
    },
  };
}

export interface G6Input {
  /** The owner's written review, or null when none exists. */
  readonly approval: {
    readonly reviewedAt: Date;
    readonly reviewer: string;
    readonly note: string;
    /** Which gate report the review was written against. */
    readonly reportId: number;
  } | null;
  /** The report currently being assembled. */
  readonly currentReportId: number | null;
}

/**
 * G6 — approval. A human act, and the only gate a computation cannot pass.
 *
 * A review of an OLDER report does not carry: the numbers it approved are not
 * the numbers on the table. That is why the approval records which report it
 * was written against.
 */
export function evaluateG6(input: G6Input): GateResult {
  if (input.approval === null) {
    return {
      gate: "G6",
      status: "INSUFFICIENT_DATA",
      reasonCode: "G6_NOT_REVIEWED",
      metrics: { detail: "no written owner review on record" },
    };
  }
  const matchesCurrent =
    input.currentReportId === null ||
    input.approval.reportId === input.currentReportId;
  return {
    gate: "G6",
    status: matchesCurrent ? "PASS" : "INSUFFICIENT_DATA",
    reasonCode: matchesCurrent ? null : "G6_NOT_REVIEWED",
    metrics: {
      reviewed_at: input.approval.reviewedAt.toISOString(),
      reviewer: input.approval.reviewer,
      report_id: input.approval.reportId,
      current_report_id: input.currentReportId,
      matches_current_report: matchesCurrent,
    },
  };
}

/**
 * The overall verdict. BLOCKED unless EVERY gate is PASS.
 *
 * There is no weighting, no "mostly passing", and no override. RFC-009 stays
 * blocked while any gate is anything other than PASS.
 */
export function overallStatus(
  results: readonly GateResult[],
): "BLOCKED" | "READY_FOR_OWNER_REVIEW" {
  const allPass = results.every((result) => result.status === "PASS");
  return allPass ? "READY_FOR_OWNER_REVIEW" : "BLOCKED";
}

/**
 * The expectation the RFC requires printed on every report, so nobody reads a
 * passing gate as a promise.
 */
export const CALIBRATED_EXPECTATION =
  "~84% das carteiras rastreáveis perdem dinheiro. O gate exige evidência de " +
  "decil superior, não 'parece bom'. Passar os gates não promete lucro.";
