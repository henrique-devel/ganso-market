// RFC-010 task 4: the uncertainty interval [q_lo, q_hi]. Deterministic and
// versioned: the same inputs and the same INTERVAL_VERSION always produce the
// same bytes. The interval combines, in this order:
//
//   1. a structural floor — half the executable spread at S_ref. The interval
//      can never be narrower than the price at which the market can actually
//      be traded;
//   2. model dispersion — z(90%) x sigma, where sigma is the ensemble/block
//      bootstrap standard deviation reported by the category model;
//   3. multiplicative widening for data staleness and for the time-to-
//      resolution bucket (market miscalibration grows with horizon, Page &
//      Clemen 2013, so our own uncertainty must grow with it too);
//   4. truncation into [0.001, 0.999] with q_lo <= q <= q_hi enforced last.
//
// In the fallback the baseline interval is widened by FALLBACK_WIDEN_FACTOR:
// the fallback is always MORE uncertain than the baseline, never less.

import {
  SCALE,
  divRound,
  maxScaled,
  minScaled,
  mul,
  probabilityToScaled,
} from "./fixed.js";

export const INTERVAL_VERSION = "1.0.0";

/** Phi^-1(0.95): half-width multiplier of a central 90% interval. */
export const Z_90 = 1.6448536269514722;

/** The fallback interval is this much wider than the raw baseline interval. */
export const FALLBACK_WIDEN_FACTOR = 1.5;

/** Staleness widening reaches this multiplier at the invalidation threshold. */
export const MAX_STALENESS_MULTIPLIER = 1.5;

export const MIN_PROBABILITY = 0.001;
export const MAX_PROBABILITY = 0.999;

export type HorizonBucket = "lt_1h" | "1h_6h" | "6h_24h" | "1d_7d" | "gt_7d";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Horizon buckets, shared by the interval and by the walk-forward slices. */
export const HORIZON_BUCKETS: readonly HorizonBucket[] = [
  "lt_1h",
  "1h_6h",
  "6h_24h",
  "1d_7d",
  "gt_7d",
];

/** Widening applied per horizon bucket; monotonically non-decreasing. */
export const HORIZON_MULTIPLIERS: Readonly<Record<HorizonBucket, number>> = {
  lt_1h: 1.0,
  "1h_6h": 1.15,
  "6h_24h": 1.3,
  "1d_7d": 1.5,
  gt_7d: 1.8,
};

/**
 * Bucket of a time-to-resolution in milliseconds. A null or negative horizon
 * (unknown or already past) is treated as the widest bucket: unknown horizon
 * is never rewarded with a narrow interval.
 */
export function horizonBucket(
  timeToResolutionMs: number | null,
): HorizonBucket {
  if (timeToResolutionMs === null || !Number.isFinite(timeToResolutionMs)) {
    return "gt_7d";
  }
  if (timeToResolutionMs < 0) {
    return "gt_7d";
  }
  if (timeToResolutionMs < HOUR_MS) {
    return "lt_1h";
  }
  if (timeToResolutionMs < 6 * HOUR_MS) {
    return "1h_6h";
  }
  if (timeToResolutionMs < DAY_MS) {
    return "6h_24h";
  }
  if (timeToResolutionMs < 7 * DAY_MS) {
    return "1d_7d";
  }
  return "gt_7d";
}

export interface IntervalInputs {
  /** Point estimate at the working scale. */
  readonly qScaled: bigint;
  /** Executable spread at S_ref, at the working scale. */
  readonly execSpreadScaled: bigint;
  /** Model dispersion in probability units; 0 for the pure baseline. */
  readonly sigma: number;
  readonly bookAgeMs: number;
  readonly maxBookAgeMs: number;
  /** Age of the external feed sample, or null when no feed was used. */
  readonly feedAgeMs: number | null;
  readonly maxFeedAgeMs: number;
  /** Milliseconds from the decision instant to resolution, when known. */
  readonly timeToResolutionMs: number | null;
  /** Extra multiplicative widening (FALLBACK_WIDEN_FACTOR in the fallback). */
  readonly widenFactor: number;
}

export interface IntervalResult {
  readonly qScaled: bigint;
  readonly qLoScaled: bigint;
  readonly qHiScaled: bigint;
  readonly halfWidthScaled: bigint;
  readonly structuralHalfScaled: bigint;
  readonly horizon: HorizonBucket;
  readonly stalenessMultiplier: number;
  readonly horizonMultiplier: number;
  readonly version: string;
}

function toScaledFactor(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) {
    return SCALE;
  }
  return BigInt(Math.round(value * Number(SCALE)));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value > 1 ? 1 : value;
}

/**
 * Staleness multiplier: 1.0 for perfectly fresh data, rising linearly to
 * MAX_STALENESS_MULTIPLIER as the oldest input approaches its invalidation
 * threshold. Book and feed staleness compose multiplicatively.
 */
export function stalenessMultiplier(inputs: IntervalInputs): number {
  const bookRatio =
    inputs.maxBookAgeMs > 0
      ? clamp01(inputs.bookAgeMs / inputs.maxBookAgeMs)
      : 0;
  const feedRatio =
    inputs.feedAgeMs === null || inputs.maxFeedAgeMs <= 0
      ? 0
      : clamp01(inputs.feedAgeMs / inputs.maxFeedAgeMs);
  const span = MAX_STALENESS_MULTIPLIER - 1;
  return (1 + span * bookRatio) * (1 + span * feedRatio);
}

/**
 * Build [q_lo, q_hi] around q. Guarantees, in order of precedence:
 *   - half-width >= half the executable spread (structural floor);
 *   - q_lo <= q <= q_hi;
 *   - every bound inside [0.001, 0.999].
 */
export function buildInterval(inputs: IntervalInputs): IntervalResult {
  const structuralHalfScaled = divRound(
    inputs.execSpreadScaled < 0n ? 0n : inputs.execSpreadScaled,
    2n,
  );
  const sigma =
    Number.isFinite(inputs.sigma) && inputs.sigma > 0 ? inputs.sigma : 0;
  const modelHalfScaled = probabilityToScaled(Z_90 * sigma);

  const horizon = horizonBucket(inputs.timeToResolutionMs);
  const horizonMultiplier = HORIZON_MULTIPLIERS[horizon];
  const staleness = stalenessMultiplier(inputs);
  const widen =
    Number.isFinite(inputs.widenFactor) && inputs.widenFactor > 0
      ? inputs.widenFactor
      : 1;

  const combinedFactor = toScaledFactor(staleness * horizonMultiplier * widen);
  const widenedModelHalf = mul(modelHalfScaled, combinedFactor);
  const widenedStructuralHalf = mul(structuralHalfScaled, combinedFactor);

  // The structural floor is never widened away and never shrunk: the interval
  // is at least half the executable spread, and at least the widened
  // dispersion / widened structural width, whichever is larger.
  const halfWidthScaled = maxScaled(
    structuralHalfScaled,
    maxScaled(widenedModelHalf, widenedStructuralHalf),
  );

  const minScaledValue = probabilityToScaled(MIN_PROBABILITY);
  const maxScaledValue = probabilityToScaled(MAX_PROBABILITY);
  const truncate = (value: bigint): bigint =>
    minScaled(maxScaled(value, minScaledValue), maxScaledValue);

  const qLoScaled = truncate(inputs.qScaled - halfWidthScaled);
  const qHiScaled = truncate(inputs.qScaled + halfWidthScaled);
  const qScaled = minScaled(
    maxScaled(truncate(inputs.qScaled), qLoScaled),
    qHiScaled,
  );

  return {
    qScaled,
    qLoScaled,
    qHiScaled,
    halfWidthScaled,
    structuralHalfScaled,
    horizon,
    stalenessMultiplier: staleness,
    horizonMultiplier,
    version: INTERVAL_VERSION,
  };
}
