// RFC-010 task 8: the walk-forward calibration pipeline — temporal splits,
// scoring metrics, reliability curve and block bootstrap.
//
// PURE module: no database, no clock, no randomness other than the explicitly
// seeded generator from ./stats.js. Every returned value is a function of the
// arguments alone, which is what makes a calibration report reproducible from
// the stored tables with no hidden state. The only side effect is a one-line
// JSON observability record on stderr when an input has to be dropped: a
// silent drop is forbidden.
//
// Three rules from the evidence the RFC cites are structural here, not
// optional knobs:
//
//   - headline metrics EXCLUDE degenerate observations (executable baseline
//     outside [0.01, 0.99]) and disputed markets. Including them inflates the
//     skill score (BSS 0.231 -> 0.428 in the cited 2024 study), so the
//     inflated number exists only as the `withDegenerate` annex and is never
//     the headline;
//   - metrics are stratified by horizon bucket, because market miscalibration
//     grows with time-to-expiration (Page & Clemen, EJ 2013). Each slice
//     carries the relative Brier degradation of model vs baseline, which is
//     exactly what the promotion gate reads;
//   - the baseline is the executable microprice at the SAME decision_ts as the
//     model estimate. The comparison is paired per observation, never one
//     aggregate against another aggregate.
//
// Validation is walk-forward only: validation windows are always strictly in
// the future of their training window. k-fold and shuffling are forbidden by
// the RFC and are deliberately not implemented here.

import type { WalkForwardConfig } from "./config.js";
import {
  HORIZON_BUCKETS,
  MAX_PROBABILITY,
  MIN_PROBABILITY,
  horizonBucket,
} from "./interval.js";
import { createSeededRandom, hashSeed, quantile } from "./stats.js";
import type {
  CalibrationMetrics,
  ConfidenceInterval,
  HorizonSlice,
  ReliabilityBin,
  ScoreSummary,
  ScoredObservation,
} from "./types.js";

/**
 * All windows are measured in fixed 86 400 000 ms days. Every timestamp in
 * this module is UTC (the recorder stores TIMESTAMPTZ), so there is no DST
 * arithmetic to get wrong.
 */
const DAY_MS = 86_400_000;

/**
 * Log loss clamps predictions into [EPS, 1 - EPS]. EPS is 1e-6 because that is
 * the storage resolution of a probability (six fraction digits, see fixed.ts):
 * the clamp can never move a value that could actually have been stored, and a
 * single confident miss can no longer return Infinity and swamp the mean.
 */
export const LOG_LOSS_EPSILON = 1e-6;

/** Executable baseline below this is degenerate (annex only, never headline). */
export const DEGENERATE_BASELINE_LOW = 0.01;
/** Executable baseline above this is degenerate (annex only, never headline). */
export const DEGENERATE_BASELINE_HIGH = 0.99;

/** Reliability curve resolution; ten equal-width bins over [0, 1]. */
export const DEFAULT_RELIABILITY_BINS = 10;

/** Percentile bounds of the reported 95% bootstrap CI. */
const CI_LOWER_QUANTILE = 0.025;
const CI_UPPER_QUANTILE = 0.975;

/**
 * Namespace mixed into the bootstrap seed. It keeps this pipeline's random
 * stream distinct from any other seeded stream derived from the same
 * configured seed, without making the stream depend on anything but the seed.
 */
const BOOTSTRAP_SEED_NAMESPACE = "rfc010-walkforward";

/** A daily batch job must stay bounded even if handed an absurd window. */
const MAX_SPLITS = 10_000;

const EMPTY_SUMMARY: ScoreSummary = {
  brier: Number.NaN,
  logLoss: Number.NaN,
  count: 0,
};

const EMPTY_INTERVAL: ConfidenceInterval = {
  point: Number.NaN,
  lower: Number.NaN,
  upper: Number.NaN,
};

function log(
  level: "info" | "warn" | "error",
  reasonCode: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  process.stderr.write(
    `${JSON.stringify({
      level,
      service: "polymarket-fundamental",
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      message,
      ...extra,
    })}\n`,
  );
}

// ---------------------------------------------------------------------------
// Temporal splits
// ---------------------------------------------------------------------------

export interface WalkForwardSplit {
  readonly trainFrom: Date;
  readonly trainTo: Date;
  readonly validationFrom: Date;
  readonly validationTo: Date;
}

/**
 * Sliding temporal windows over [from, to): train [t, t + trainDays), then
 * validation [t + trainDays, t + trainDays + validationDays), advancing by
 * stepDays. Validation is ALWAYS strictly in the future of train — that is the
 * entire point of the method, and k-fold or shuffled variants are forbidden by
 * the RFC.
 *
 * Only complete folds are emitted: a truncated final validation window would
 * carry fewer observations than every other fold and would silently skew the
 * pooled metrics. An empty result means "this window cannot be validated",
 * which the caller must treat as absence of evidence, never as a pass.
 *
 * The 2026-04-28 CLOB V2 regime boundary is NOT applied here: whether a
 * training set may straddle it is a property of the model registry
 * (`regime_mix`), not of the window generator, and hiding it inside the split
 * generator would make a regime-mixed set look impossible instead of flagged.
 */
export function walkForwardSplits(
  from: Date,
  to: Date,
  config: WalkForwardConfig,
): WalkForwardSplit[] {
  const splits: WalkForwardSplit[] = [];
  const start = from.getTime();
  const end = to.getTime();
  const trainMs = config.trainDays * DAY_MS;
  const validationMs = config.validationDays * DAY_MS;
  const stepMs = config.stepDays * DAY_MS;

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    log("warn", "WALKFORWARD_WINDOW_INVALID", "walkforward_window_invalid", {
      from: Number.isFinite(start) ? from.toISOString() : null,
      to: Number.isFinite(end) ? to.toISOString() : null,
    });
    return splits;
  }
  if (!(trainMs > 0) || !(validationMs > 0) || !(stepMs > 0)) {
    log("warn", "WALKFORWARD_CONFIG_INVALID", "walkforward_config_invalid", {
      train_days: config.trainDays,
      validation_days: config.validationDays,
      step_days: config.stepDays,
    });
    return splits;
  }

  for (let trainFrom = start; splits.length < MAX_SPLITS; trainFrom += stepMs) {
    const trainTo = trainFrom + trainMs;
    const validationTo = trainTo + validationMs;
    if (validationTo > end) {
      return splits;
    }
    splits.push({
      trainFrom: new Date(trainFrom),
      trainTo: new Date(trainTo),
      // Validation starts exactly where training ends: no gap to hide a leak
      // in, and no overlap that would let a validation row train the model.
      validationFrom: new Date(trainTo),
      validationTo: new Date(validationTo),
    });
  }

  log("warn", "WALKFORWARD_SPLITS_TRUNCATED", "walkforward_splits_truncated", {
    max_splits: MAX_SPLITS,
  });
  return splits;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Bound a probability into [0, 1]; a non-finite input stays NaN on purpose. */
function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return Number.NaN;
  }
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function squaredError(prediction: number, label: number): number {
  const error = clamp01(prediction) - clamp01(label);
  return error * error;
}

/**
 * Cross-entropy generalized to the {0, 0.5, 1} label set: a 0.5 resolution
 * contributes half of each side, which is the correct scoring rule for a
 * market that pays both outcomes.
 */
function crossEntropy(prediction: number, label: number): number {
  const bounded = Math.min(
    Math.max(prediction, LOG_LOSS_EPSILON),
    1 - LOG_LOSS_EPSILON,
  );
  const y = clamp01(label);
  return -(y * Math.log(bounded) + (1 - y) * Math.log(1 - bounded));
}

/** Brier contribution of one observation under an arbitrary prediction. */
export function brierTerm(
  observation: ScoredObservation,
  prediction: number,
): number {
  return squaredError(prediction, observation.label);
}

/** Log-loss contribution of one observation; clamped by LOG_LOSS_EPSILON. */
export function logLossTerm(
  observation: ScoredObservation,
  prediction: number,
): number {
  return crossEntropy(prediction, observation.label);
}

/**
 * Brier and log loss of a set of (prediction, label) pairs.
 *
 * An empty set reports NaN, never a flattering zero: a metric with no
 * observations behind it must fail every comparison it is fed into, which is
 * what the promotion gate needs it to do.
 */
export function scoreSummary(
  pairs: ReadonlyArray<{ readonly prediction: number; readonly label: number }>,
): ScoreSummary {
  let brierTotal = 0;
  let logLossTotal = 0;
  let count = 0;
  let dropped = 0;

  for (const pair of pairs) {
    if (!Number.isFinite(pair.prediction) || !Number.isFinite(pair.label)) {
      dropped += 1;
      continue;
    }
    brierTotal += squaredError(pair.prediction, pair.label);
    logLossTotal += crossEntropy(pair.prediction, pair.label);
    count += 1;
  }

  if (dropped > 0) {
    log("warn", "WALKFORWARD_PAIR_DROPPED", "walkforward_pair_dropped", {
      dropped,
      scored: count,
    });
  }
  if (count === 0) {
    return EMPTY_SUMMARY;
  }
  return {
    brier: brierTotal / count,
    logLoss: logLossTotal / count,
    count,
  };
}

/**
 * Reliability curve: equal-width bins over [0, 1] with the mean prediction and
 * the mean outcome inside each. A perfectly calibrated set sits on the
 * diagonal.
 *
 * Empty bins are omitted rather than reported with a zero mean — a bin with no
 * observations has no calibration point, and inventing (0, 0) for it would
 * draw a curve the data does not support.
 */
export function reliabilityBins(
  pairs: ReadonlyArray<{ readonly prediction: number; readonly label: number }>,
  binCount = DEFAULT_RELIABILITY_BINS,
): ReliabilityBin[] {
  const bins = Number.isFinite(binCount)
    ? Math.max(1, Math.floor(binCount))
    : DEFAULT_RELIABILITY_BINS;
  const counts = new Array<number>(bins).fill(0);
  const predictedTotals = new Array<number>(bins).fill(0);
  const observedTotals = new Array<number>(bins).fill(0);

  for (const pair of pairs) {
    if (!Number.isFinite(pair.prediction) || !Number.isFinite(pair.label)) {
      continue;
    }
    const prediction = clamp01(pair.prediction);
    // A prediction of exactly 1 belongs to the last bin, not to a phantom
    // bin above it.
    const index = Math.min(bins - 1, Math.floor(prediction * bins));
    counts[index] = (counts[index] ?? 0) + 1;
    predictedTotals[index] = (predictedTotals[index] ?? 0) + prediction;
    observedTotals[index] = (observedTotals[index] ?? 0) + clamp01(pair.label);
  }

  const result: ReliabilityBin[] = [];
  for (let index = 0; index < bins; index += 1) {
    const count = counts[index] ?? 0;
    if (count === 0) {
      continue;
    }
    result.push({
      lower: index / bins,
      upper: (index + 1) / bins,
      count,
      meanPredicted: (predictedTotals[index] ?? 0) / count,
      meanObserved: (observedTotals[index] ?? 0) / count,
    });
  }
  return result;
}

/**
 * Empirical coverage of the 90% interval: the share of outcomes that fall
 * inside [q_lo, q_hi]. A 0.5 resolution is covered when 0.5 itself is inside.
 *
 * Bounds sitting on the truncation limits count as reaching certainty:
 * buildInterval truncates every bound into [0.001, 0.999], so a literal
 * comparison against a label of 1 could never succeed and the metric would be
 * a constant zero — worse than useless. A bound at 0.999 therefore covers the
 * outcome 1, and a bound at 0.001 covers the outcome 0.
 *
 * An empty set reports NaN rather than a coverage of zero or one.
 */
export function intervalCoverage(
  observations: readonly ScoredObservation[],
): number {
  let covered = 0;
  let count = 0;
  for (const observation of observations) {
    if (
      !Number.isFinite(observation.modelLo) ||
      !Number.isFinite(observation.modelHi) ||
      !Number.isFinite(observation.label)
    ) {
      continue;
    }
    const lower =
      observation.modelLo <= MIN_PROBABILITY ? 0 : observation.modelLo;
    const upper =
      observation.modelHi >= MAX_PROBABILITY ? 1 : observation.modelHi;
    if (observation.label >= lower && observation.label <= upper) {
      covered += 1;
    }
    count += 1;
  }
  return count === 0 ? Number.NaN : covered / count;
}

// ---------------------------------------------------------------------------
// Block bootstrap
// ---------------------------------------------------------------------------

export interface BootstrapOptions {
  readonly resamples: number;
  readonly seed: number;
  readonly blockDays: number;
}

interface Block {
  readonly deltas: readonly number[];
  readonly sum: number;
}

/**
 * Group the paired deltas into contiguous blocks of `blockMs`, one block per
 * (market, time block). Observations of the same market inside the same block
 * are serially dependent — consecutive 60 s estimates of one market are close
 * to the previous one — so they must be resampled together or the CI collapses
 * to the width an i.i.d. sample would have.
 *
 * The observations are sorted first, so the blocks (and therefore the CI) do
 * not depend on the order the caller happened to read the rows in.
 */
function buildBlocks(
  observations: readonly ScoredObservation[],
  blockMs: number,
  metric: (observation: ScoredObservation, prediction: number) => number,
): { readonly blocks: Block[]; readonly total: number; readonly sum: number } {
  const sorted = [...observations].sort((left, right) => {
    const byTime = left.decisionTs.getTime() - right.decisionTs.getTime();
    if (byTime !== 0) {
      return byTime;
    }
    if (left.conditionId !== right.conditionId) {
      return left.conditionId < right.conditionId ? -1 : 1;
    }
    if (left.tokenId !== right.tokenId) {
      return left.tokenId < right.tokenId ? -1 : 1;
    }
    return 0;
  });

  const byKey = new Map<string, number[]>();
  const order: string[] = [];
  let total = 0;
  let sum = 0;
  let dropped = 0;

  for (const observation of sorted) {
    // Paired delta: the model and the baseline are scored on the SAME
    // observation, so the difference of the two means is exactly the mean of
    // the per-observation differences. Precomputing it here is not an
    // approximation, and it evaluates the metric 2n times in total instead of
    // 2n times per resample.
    const delta =
      metric(observation, observation.modelQ) -
      metric(observation, observation.baselineQ);
    if (!Number.isFinite(delta)) {
      dropped += 1;
      continue;
    }
    const bucket = Math.floor(observation.decisionTs.getTime() / blockMs);
    const key = `${observation.conditionId}|${bucket}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, [delta]);
      order.push(key);
    } else {
      existing.push(delta);
    }
    total += 1;
    sum += delta;
  }

  if (dropped > 0) {
    log(
      "warn",
      "WALKFORWARD_OBSERVATION_DROPPED",
      "walkforward_bootstrap_observation_dropped",
      { dropped, kept: total },
    );
  }

  const blocks: Block[] = [];
  for (const key of order) {
    const deltas = byKey.get(key);
    if (deltas === undefined || deltas.length === 0) {
      continue;
    }
    let blockSum = 0;
    for (const delta of deltas) {
      blockSum += delta;
    }
    blocks.push({ deltas, sum: blockSum });
  }
  return { blocks, total, sum };
}

/**
 * Block bootstrap of (model - baseline) for one metric. Returns the point
 * estimate on the full sample and the 95% percentile CI of the resampled
 * deltas.
 *
 * Reproducibility is a hard requirement of the RFC: the stream comes from
 * createSeededRandom seeded through hashSeed, blocks are built from sorted
 * observations, and blocks are drawn WITH replacement until the resample holds
 * at least as many observations as the original, then truncated to the
 * original length. Same observations + same seed => byte-identical CI.
 *
 * A negative delta means the model scores BETTER than the market baseline
 * (both metrics are losses). An empty or unusable sample reports NaN, so every
 * downstream comparison fails closed.
 */
export function blockBootstrapDelta(
  observations: readonly ScoredObservation[],
  metric: (observation: ScoredObservation, prediction: number) => number,
  options: BootstrapOptions,
): ConfidenceInterval {
  const resamples = Number.isFinite(options.resamples)
    ? Math.floor(options.resamples)
    : 0;
  const blockMs = options.blockDays * DAY_MS;
  if (observations.length === 0 || !(resamples > 0) || !(blockMs > 0)) {
    log(
      "warn",
      "WALKFORWARD_BOOTSTRAP_UNAVAILABLE",
      "walkforward_bootstrap_unavailable",
      {
        observations: observations.length,
        resamples: options.resamples,
        block_days: options.blockDays,
      },
    );
    return EMPTY_INTERVAL;
  }

  const { blocks, total, sum } = buildBlocks(observations, blockMs, metric);
  if (total === 0 || blocks.length === 0) {
    log(
      "warn",
      "WALKFORWARD_BOOTSTRAP_UNAVAILABLE",
      "walkforward_bootstrap_no_usable_observations",
      { observations: observations.length },
    );
    return EMPTY_INTERVAL;
  }

  const point = sum / total;
  const random = createSeededRandom(
    hashSeed(`${BOOTSTRAP_SEED_NAMESPACE}:${options.seed}`),
  );
  const estimates: number[] = [];
  for (let resample = 0; resample < resamples; resample += 1) {
    let resampleSum = 0;
    let taken = 0;
    while (taken < total) {
      const block = blocks[Math.floor(random() * blocks.length)];
      if (block === undefined) {
        break;
      }
      if (taken + block.deltas.length <= total) {
        resampleSum += block.sum;
        taken += block.deltas.length;
        continue;
      }
      // Last block of this resample overshoots: keep only the observations
      // that fit, so every resample has exactly the original length.
      const needed = total - taken;
      for (let index = 0; index < needed; index += 1) {
        resampleSum += block.deltas[index] ?? 0;
      }
      taken = total;
    }
    estimates.push(resampleSum / total);
  }

  return {
    point,
    lower: quantile(estimates, CI_LOWER_QUANTILE),
    upper: quantile(estimates, CI_UPPER_QUANTILE),
  };
}

// ---------------------------------------------------------------------------
// Calibration metrics
// ---------------------------------------------------------------------------

/** Horizon bucket of an observation; shared with the interval layer. */
export const HORIZON_BUCKET_OF: (observation: ScoredObservation) => string = (
  observation,
) => horizonBucket(observation.horizonMs);

function toPairs(
  observations: readonly ScoredObservation[],
  pick: (observation: ScoredObservation) => number,
): Array<{ prediction: number; label: number }> {
  return observations.map((observation) => ({
    prediction: pick(observation),
    label: observation.label,
  }));
}

const modelPrediction = (observation: ScoredObservation): number =>
  observation.modelQ;
const baselinePrediction = (observation: ScoredObservation): number =>
  observation.baselineQ;

/**
 * An observation whose executable baseline is outside [0.01, 0.99] is
 * degenerate. The stored flag is trusted, but the baseline is re-checked here
 * as well: a producer that forgot to set the flag must not be able to inflate
 * the headline (the cited study's BSS goes from 0.231 to 0.428 on exactly this
 * mistake).
 */
function isDegenerate(observation: ScoredObservation): boolean {
  return (
    observation.degenerate ||
    !Number.isFinite(observation.baselineQ) ||
    observation.baselineQ < DEGENERATE_BASELINE_LOW ||
    observation.baselineQ > DEGENERATE_BASELINE_HIGH
  );
}

function isUsable(observation: ScoredObservation): boolean {
  return (
    Number.isFinite(observation.modelQ) &&
    Number.isFinite(observation.baselineQ) &&
    Number.isFinite(observation.label) &&
    observation.label >= 0 &&
    observation.label <= 1
  );
}

function relativeBrierDegradation(
  model: ScoreSummary,
  baseline: ScoreSummary,
): number {
  if (!Number.isFinite(model.brier) || !Number.isFinite(baseline.brier)) {
    return Number.NaN;
  }
  if (baseline.brier === 0) {
    // A flawless baseline cannot be improved on; anything worse is an
    // unbounded degradation, which is the honest answer for the gate.
    return model.brier === 0 ? 0 : Number.POSITIVE_INFINITY;
  }
  return (model.brier - baseline.brier) / baseline.brier;
}

function horizonSlices(
  observations: readonly ScoredObservation[],
): HorizonSlice[] {
  const grouped = new Map<string, ScoredObservation[]>();
  for (const observation of observations) {
    const bucket = HORIZON_BUCKET_OF(observation);
    const existing = grouped.get(bucket);
    if (existing === undefined) {
      grouped.set(bucket, [observation]);
    } else {
      existing.push(observation);
    }
  }

  const slices: HorizonSlice[] = [];
  // Iterate the canonical bucket order, not the map's insertion order, so two
  // runs over the same data produce byte-identical reports.
  for (const bucket of HORIZON_BUCKETS) {
    const sliceObservations = grouped.get(bucket);
    if (sliceObservations === undefined || sliceObservations.length === 0) {
      continue;
    }
    const model = scoreSummary(toPairs(sliceObservations, modelPrediction));
    const baseline = scoreSummary(
      toPairs(sliceObservations, baselinePrediction),
    );
    slices.push({
      bucket,
      count: sliceObservations.length,
      model,
      baseline,
      relativeBrierDegradation: relativeBrierDegradation(model, baseline),
    });
  }
  return slices;
}

/**
 * Full calibration report for one model over one validation window.
 *
 * Headline metrics are computed on the observations that survive the RFC's
 * exclusions (no degenerate baselines, no disputed markets); the same metrics
 * over the unfiltered sample are reported as `withDegenerate`, an annex whose
 * only job is to make the inflation visible.
 */
export function computeCalibrationMetrics(
  observations: readonly ScoredObservation[],
  options: BootstrapOptions,
): CalibrationMetrics {
  const usable = observations.filter(isUsable);
  const unusable = observations.length - usable.length;
  if (unusable > 0) {
    log(
      "warn",
      "WALKFORWARD_OBSERVATION_DROPPED",
      "walkforward_observation_unusable",
      { dropped: unusable, kept: usable.length },
    );
  }

  const headline = usable.filter(
    (observation) => !isDegenerate(observation) && !observation.disputed,
  );

  const model = scoreSummary(toPairs(headline, modelPrediction));
  const baseline = scoreSummary(toPairs(headline, baselinePrediction));
  const markets = new Set(
    headline.map((observation) => observation.conditionId),
  );

  return {
    observations: headline.length,
    marketsCovered: markets.size,
    model,
    baseline,
    deltaBrier: blockBootstrapDelta(headline, brierTerm, options),
    deltaLogLoss: blockBootstrapDelta(headline, logLossTerm, options),
    horizonSlices: horizonSlices(headline),
    reliabilityModel: reliabilityBins(toPairs(headline, modelPrediction)),
    reliabilityBaseline: reliabilityBins(toPairs(headline, baselinePrediction)),
    intervalCoverage: intervalCoverage(headline),
    withDegenerate: {
      observations: usable.length,
      model: scoreSummary(toPairs(usable, modelPrediction)),
      baseline: scoreSummary(toPairs(usable, baselinePrediction)),
    },
    bootstrapResamples: options.resamples,
    bootstrapSeed: options.seed,
    blockLength: options.blockDays,
  };
}
