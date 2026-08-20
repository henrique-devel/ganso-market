// RFC-010 task 5: the `crypto_updown` model — "asset above/below K at T".
//
// This module is a PURE FUNCTION of its arguments: no database, no clock, no
// fetch. The caller reads the resolving feed and its 1-minute series through
// features.ts and hands them over, which is what makes (q, sigma) reproducible
// from the stored `data_refs` alone. The single exception is the one-line
// stderr log in the hyperparameter parser, which exists so that a malformed
// registry row degrades observably instead of silently.
//
// The primary input is the Chainlink TWAP 30/60 s — the feed that RESOLVES
// these markets. Using it removes the basis risk of a spot feed. A spot feed
// (Binance `crypto_prices`) is deliberately NOT read here and must never be
// mixed into the same quantity: the documented ~0.12% structural Binance vs
// Chainlink offset in ETH already produced one false positive. If a cross-feed
// signal is ever wanted, the offset has to be MEASURED PER SYMBOL and corrected
// first, as its own versioned feature — not assumed away here.
//
// Base map: driftless distribution of log returns over the remaining horizon.
// No drift term is estimated on purpose: over horizons of hours to days the
// drift is statistically indistinguishable from zero at these sample sizes, and
// pretending to know its sign would be fabricating alpha. The map exists in two
// versioned variants (normal and Student-t) and is evaluated once per
// configured EWMA lambda, so the spread of that ensemble is the model's own
// admission of how little it knows.
//
// Before any walk-forward evidence exists, `hyperparams.calibration` is null and
// q is the raw base map. That is the honest state, not a degradation.
//
// Nothing here creates an order, a signal, a wallet or any trading credential,
// and nothing here may.

import {
  DEFAULT_FUNDAMENTAL_CONFIG,
  type FundamentalConfig,
} from "../config.js";
import type {
  AsOfGuard,
  FeedSample,
  FeedSeries,
  MarketContext,
} from "../features.js";
import {
  applyLogistic,
  ewmaVolatility,
  fitLogistic,
  logit,
  logReturns,
  mean,
  normalCdf,
  standardDeviation,
  studentTCdf,
} from "../stats.js";
import type { DataRefs, ModelResult } from "../types.js";

export const CRYPTO_MODEL_FAMILY = "crypto_updown_gbm";
export const CRYPTO_MODEL_VERSION = "1.0.0";

/**
 * Version of the feature vector produced by `cryptoFeatureRow`. It is tracked
 * separately from the shared feature layer's FEATURE_SET_VERSION because a
 * calibration fitted on this row is only replayable against this exact row:
 * any change to the row's contents or order must bump this string, which
 * invalidates every stored calibration that quoted the old one.
 */
export const CRYPTO_FEATURE_SET_VERSION = "1.0.0";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const MINUTES_PER_DAY = 1_440;
/** The model's time unit is the day; the closes arrive per minute. */
const SQRT_MINUTES_PER_DAY = Math.sqrt(MINUTES_PER_DAY);

/** Number of columns in `cryptoFeatureRow`; a calibration must match it. */
const CRYPTO_FEATURE_WIDTH = 4;

/**
 * Floor of the reported dispersion, in probability units. The ensemble is small
 * (variants x lambdas) and its members can agree by coincidence — most obviously
 * exactly at the money, where every variant returns 0.5. A sigma of zero would
 * claim perfect knowledge of a crypto price hours away, so the reported
 * dispersion never goes below half a probability point.
 */
const MIN_SIGMA = 0.005;

/** q never leaves this module as exactly 0 or 1: ModelOutput.q lives in (0, 1). */
const Q_EPSILON = 1e-6;

const DEFAULT_TRAIN_L2 = 1;
const DEFAULT_TRAIN_LEARNING_RATE = 0.5;
const DEFAULT_TRAIN_ITERATIONS = 2_000;

function logLine(
  level: "info" | "warn" | "error",
  reasonCode: string,
  message: string,
  extra: Record<string, unknown> = {},
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

export interface CryptoMarketSpec {
  /** RTDS symbol of the resolving feed, e.g. "btc/usd". */
  readonly symbol: string;
  /** Strike K, in USD. */
  readonly strike: number;
  readonly direction: "above" | "below";
  /** T, the resolution instant. */
  readonly deadline: Date;
}

// Only these four symbols exist in the RTDS recorder, so only these four can be
// modelled; anything else stays on the baseline forever.
const SYMBOL_ALIASES: ReadonlyArray<{
  readonly symbol: string;
  readonly pattern: RegExp;
}> = [
  { symbol: "btc/usd", pattern: /\b(?:btc|bitcoin)\b/ },
  { symbol: "eth/usd", pattern: /\b(?:eth|ether|ethereum)\b/ },
  { symbol: "sol/usd", pattern: /\b(?:sol|solana)\b/ },
  { symbol: "xrp/usd", pattern: /\b(?:xrp|ripple)\b/ },
];

// "over"/"under"/"at least"/"at most" only count as a direction when they sit
// immediately in front of an amount: "over the next month" is a horizon, not a
// direction, and reading it as one would invert half the universe.
const ABOVE_PATTERNS: readonly RegExp[] = [
  /\b(?:above|greater than|higher than|exceeds?)\b/,
  /\b(?:over|at least)\s+\$?\s*\d/,
];
const BELOW_PATTERNS: readonly RegExp[] = [
  /\b(?:below|less than|lower than)\b/,
  /\b(?:under|at most)\s+\$?\s*\d/,
];

// Barrier phrasings ("hit", "touch", "ever") pay on the PATH, not on the level
// at T. The driftless terminal map would systematically understate them, so
// they are refused rather than mis-modelled. Ranges ("between") are not a
// single-threshold payoff either.
const AMBIGUOUS_PATTERNS: readonly RegExp[] = [
  /\b(?:hits?|reach(?:es)?|touch(?:es)?|ever|anytime|all-time high|ath)\b/,
  /\bany time\b/,
  /\bbetween\b/,
];

// A strike is only recognized with a currency marker ($) or a magnitude suffix
// (k/m/b). That is what keeps "on August 30" and "at 12pm ET" out of the strike
// set: a bare integer in a question is far more often a date than a price.
const STRIKE_PATTERN =
  /\$\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([kmb])?|\b(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([km])\b/g;

const MAGNITUDE: Readonly<Record<string, number>> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
};

function parseStrikes(text: string): number[] {
  const strikes: number[] = [];
  for (const match of text.matchAll(STRIKE_PATTERN)) {
    const digits = match[1] ?? match[3];
    const suffix = match[2] ?? match[4];
    if (digits === undefined) {
      continue;
    }
    const magnitude = suffix === undefined ? 1 : (MAGNITUDE[suffix] ?? 1);
    const value = Number(digits.replace(/,/g, "")) * magnitude;
    if (Number.isFinite(value) && value > 0 && !strikes.includes(value)) {
      strikes.push(value);
    }
  }
  return strikes;
}

/**
 * Deterministic parse of a market into a crypto spec, or null when the market
 * is not an unambiguous "asset above/below K at T". Only the question is read:
 * the rules prose carries incidental amounts (fees, tick sizes, example
 * figures) that would manufacture phantom strikes. Refusing is always safe —
 * the market simply stays on the market baseline forever, which is the RFC's
 * default state, so this parser is deliberately biased towards refusal.
 */
export function parseCryptoMarket(
  context: MarketContext,
): CryptoMarketSpec | null {
  const deadline = context.endDate;
  if (deadline === null || Number.isNaN(deadline.getTime())) {
    // Without T there is no horizon, and a horizon guessed from prose would be
    // a fabricated input to every downstream probability.
    return null;
  }
  const text = context.question.toLowerCase();
  if (text.length === 0) {
    return null;
  }
  if (AMBIGUOUS_PATTERNS.some((pattern) => pattern.test(text))) {
    return null;
  }

  const symbols = SYMBOL_ALIASES.filter((alias) =>
    alias.pattern.test(text),
  ).map((alias) => alias.symbol);
  if (symbols.length !== 1) {
    // Zero: not one of the four recorded feeds. Two or more: the question
    // compares assets, which is not this model's payoff.
    return null;
  }
  const symbol = symbols[0];
  if (symbol === undefined) {
    return null;
  }

  const above = ABOVE_PATTERNS.some((pattern) => pattern.test(text));
  const below = BELOW_PATTERNS.some((pattern) => pattern.test(text));
  if (above === below) {
    // Neither word, or both of them: the direction is not established.
    return null;
  }

  const strikes = parseStrikes(text);
  if (strikes.length !== 1) {
    return null;
  }
  const strike = strikes[0];
  if (strike === undefined) {
    return null;
  }

  return {
    symbol,
    strike,
    direction: above ? "above" : "below",
    deadline,
  };
}

export type CryptoVariant = "normal" | "student_t";

export interface CryptoHyperparams {
  readonly variant: CryptoVariant;
  readonly ewmaLambdas: readonly number[];
  readonly studentDf: number;
  /** Walk-forward calibration correction; null means "no correction yet". */
  readonly calibration: {
    readonly intercept: number;
    readonly coefficients: readonly number[];
  } | null;
}

/**
 * The state of a freshly registered model: the raw base map with the module's
 * default ensemble and no calibration. Derived from the config defaults so the
 * two can never drift apart.
 */
export const DEFAULT_CRYPTO_HYPERPARAMS: CryptoHyperparams = Object.freeze({
  variant: "normal",
  ewmaLambdas: DEFAULT_FUNDAMENTAL_CONFIG.crypto.ewmaLambdas,
  studentDf: DEFAULT_FUNDAMENTAL_CONFIG.crypto.studentDf,
  calibration: null,
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Registry rows are written in camelCase; hand-edited JSON tends to snake. */
function pick(
  raw: Record<string, unknown>,
  camel: string,
  snake: string,
): unknown {
  return raw[camel] ?? raw[snake];
}

function parseCalibration(
  value: unknown,
): { readonly intercept: number; readonly coefficients: number[] } | undefined {
  const record = asRecord(value);
  if (record === null) {
    return undefined;
  }
  const intercept = record.intercept;
  const coefficients = record.coefficients;
  if (typeof intercept !== "number" || !Number.isFinite(intercept)) {
    return undefined;
  }
  if (
    !Array.isArray(coefficients) ||
    coefficients.length !== CRYPTO_FEATURE_WIDTH ||
    !coefficients.every(
      (item): item is number =>
        typeof item === "number" && Number.isFinite(item),
    )
  ) {
    // A correction of the wrong width cannot be replayed against this feature
    // row; applying it would quietly read zeros for the missing columns.
    return undefined;
  }
  return { intercept, coefficients: [...coefficients] };
}

/**
 * Parse the hyperparameters stored with a model version. Every field falls back
 * to the module/config default when it is absent or invalid, and every FALLBACK
 * IS LOGGED with a stable reason code: a registry row that does not parse is an
 * operational fault that must be visible, not a silent change of model.
 */
export function parseCryptoHyperparams(
  raw: unknown,
  config: FundamentalConfig,
): CryptoHyperparams {
  const defaults: CryptoHyperparams = {
    variant: DEFAULT_CRYPTO_HYPERPARAMS.variant,
    ewmaLambdas: config.crypto.ewmaLambdas,
    studentDf: config.crypto.studentDf,
    calibration: null,
  };
  const record = asRecord(raw);
  if (record === null) {
    // No stored hyperparameters at all is the legitimate "defaults" case, not
    // a fault: a model registered without overrides gets the config values.
    return defaults;
  }

  let variant = defaults.variant;
  const rawVariant = record.variant;
  if (rawVariant !== undefined) {
    if (rawVariant === "normal" || rawVariant === "student_t") {
      variant = rawVariant;
    } else {
      logLine(
        "warn",
        "CRYPTO_HYPERPARAM_INVALID",
        "crypto_hyperparam_invalid",
        {
          field: "variant",
        },
      );
    }
  }

  let ewmaLambdas = defaults.ewmaLambdas;
  const rawLambdas = pick(record, "ewmaLambdas", "ewma_lambdas");
  if (rawLambdas !== undefined) {
    const valid =
      Array.isArray(rawLambdas) &&
      rawLambdas.length > 0 &&
      rawLambdas.every(
        (item): item is number =>
          typeof item === "number" &&
          Number.isFinite(item) &&
          item >= 0.5 &&
          item <= 0.9999,
      );
    if (valid) {
      ewmaLambdas = [...rawLambdas];
    } else {
      logLine(
        "warn",
        "CRYPTO_HYPERPARAM_INVALID",
        "crypto_hyperparam_invalid",
        {
          field: "ewma_lambdas",
        },
      );
    }
  }

  let studentDf = defaults.studentDf;
  const rawDf = pick(record, "studentDf", "student_df");
  if (rawDf !== undefined) {
    // df <= 2 has infinite variance, so the variance-matched scaling below
    // would not exist; the config's own floor (2.1) is enforced here too.
    if (
      typeof rawDf === "number" &&
      Number.isFinite(rawDf) &&
      rawDf >= 2.1 &&
      rawDf <= 200
    ) {
      studentDf = rawDf;
    } else {
      logLine(
        "warn",
        "CRYPTO_HYPERPARAM_INVALID",
        "crypto_hyperparam_invalid",
        {
          field: "student_df",
        },
      );
    }
  }

  let calibration = defaults.calibration;
  const rawCalibration = record.calibration;
  if (rawCalibration !== undefined && rawCalibration !== null) {
    const parsed = parseCalibration(rawCalibration);
    if (parsed === undefined) {
      logLine(
        "warn",
        "CRYPTO_HYPERPARAM_INVALID",
        "crypto_hyperparam_invalid",
        {
          field: "calibration",
        },
      );
    } else {
      calibration = parsed;
    }
  }

  return { variant, ewmaLambdas, studentDf, calibration };
}

export interface CryptoModelInput {
  readonly spec: CryptoMarketSpec;
  readonly decisionTs: Date;
  /** The resolving TWAP sample as-of the decision instant. */
  readonly feed: FeedSample | null;
  /** 1-minute closes of the SAME feed, all buckets already closed. */
  readonly series: FeedSeries;
  readonly config: FundamentalConfig;
  readonly hyperparams: CryptoHyperparams;
  readonly guard: AsOfGuard;
}

/**
 * Probability that the terminal level is above the strike, under a driftless
 * log-return distribution of standard deviation `sigma * sqrt(tau)`:
 *
 *   z = ln(S/K) / (sigma * sqrt(tau))
 *   normal    -> Phi(z)
 *   student_t -> F_t(z * sqrt(df/(df-2)), df)
 *
 * The Student-t argument is scaled by the t's own standard deviation so that
 * BOTH variants describe a distribution of the same width — they differ only in
 * tail shape, which is exactly the disagreement the ensemble is meant to price.
 */
function baseMapAbove(z: number, variant: CryptoVariant, df: number): number {
  if (variant === "student_t") {
    return studentTCdf(z * Math.sqrt(df / (df - 2)), df);
  }
  return normalCdf(z);
}

/**
 * Feature row used both at inference and at training, so the two can never
 * drift. Column order is part of CRYPTO_FEATURE_SET_VERSION:
 *   0: logit(q_base) — the base map is the prior the correction adjusts;
 *   1: ln(K/S)       — signed log distance to the strike;
 *   2: sqrt(tau)     — tau in days, the natural scale of the diffusion;
 *   3: EWMA vol      — per-day realized volatility of the resolving feed.
 * Every column is O(1) in magnitude, which matters for a fixed-learning-rate
 * gradient descent.
 */
export function cryptoFeatureRow(base: {
  qBase: number;
  logDistance: number;
  sqrtTau: number;
  volEwma: number;
}): number[] {
  return [logit(base.qBase), base.logDistance, base.sqrtTau, base.volEwma];
}

interface EnsembleMember {
  readonly volDaily: number;
  readonly variant: CryptoVariant;
  readonly q: number;
}

/**
 * Estimate q for one crypto up/down market at one decision instant, or abstain.
 * The model never returns a poisoned number: a missing or stale feed, too
 * little history, a dead feed, an expired horizon or a malformed spec all
 * degrade explicitly, and the caller turns that into the market baseline.
 */
export function estimateCryptoUpdown(input: CryptoModelInput): ModelResult {
  const { spec, decisionTs, series, config, hyperparams, guard } = input;

  // The spec is metadata derived from the question, and its deadline is a
  // SCHEDULED FUTURE instant rather than an observation, so it is recorded with
  // a null source_ts (recording the deadline itself would trip the as-of guard
  // for exactly the wrong reason).
  guard.record("crypto_spec", null, spec);

  if (!Number.isFinite(spec.strike) || spec.strike <= 0) {
    return { ok: false, reason: "MODEL_ERROR" };
  }

  const feed = guard.record(
    "crypto_feed_twap",
    input.feed?.sourceTs ?? null,
    input.feed,
  );
  if (
    feed === null ||
    feed.stale ||
    !Number.isFinite(feed.price) ||
    feed.price <= 0
  ) {
    return { ok: false, reason: "FEED_STALE" };
  }

  // A 1-minute aggregate is knowable only once its bucket has closed, so the
  // as-of stamp of the series is the END of its newest bucket.
  const seriesSourceTs =
    series.lastBucket === null
      ? null
      : new Date(series.lastBucket.getTime() + MINUTE_MS);
  const history = guard.record("crypto_feed_series_1m", seriesSourceTs, series);

  if (feed.symbol !== spec.symbol || history.symbol !== spec.symbol) {
    // Wrong symbol: abstain rather than price one asset off another's level.
    return { ok: false, reason: "MODEL_ABSTAINED" };
  }
  if (history.feed !== feed.feed) {
    // Level and series must come from the SAME feed. Mixing a spot series with
    // a TWAP level injects the structural inter-feed offset straight into the
    // volatility and the log distance.
    return { ok: false, reason: "MODEL_ABSTAINED" };
  }
  if (history.closes.length < config.crypto.minHistoryMinutes) {
    return { ok: false, reason: "MODEL_ABSTAINED" };
  }

  const tauMs = spec.deadline.getTime() - decisionTs.getTime();
  if (!Number.isFinite(tauMs) || tauMs <= 0) {
    // At or past T there is no horizon left to diffuse over.
    return { ok: false, reason: "MODEL_ABSTAINED" };
  }
  const tauDays = tauMs / DAY_MS;
  const sqrtTau = Math.sqrt(tauDays);

  const returns = logReturns(history.closes);
  if (returns.length === 0) {
    return { ok: false, reason: "MODEL_ABSTAINED" };
  }

  const logDistance = Math.log(spec.strike / feed.price);
  const members: EnsembleMember[] = [];
  for (const lambda of hyperparams.ewmaLambdas) {
    // Per-minute EWMA volatility scaled to the model's day unit. The sqrt-of-
    // time scaling is exact under the same driftless i.i.d. assumption the base
    // map already makes; it introduces no extra hypothesis.
    const volDaily = ewmaVolatility(returns, lambda) * SQRT_MINUTES_PER_DAY;
    if (!Number.isFinite(volDaily) || volDaily <= 0) {
      // A frozen feed has zero realized volatility, and a zero-volatility map
      // claims certainty about a future price. Abstain instead.
      return { ok: false, reason: "MODEL_ABSTAINED" };
    }
    const z = -logDistance / (volDaily * sqrtTau);
    if (!Number.isFinite(z)) {
      return { ok: false, reason: "MODEL_ERROR" };
    }
    for (const variant of ["normal", "student_t"] as const) {
      const above = baseMapAbove(z, variant, hyperparams.studentDf);
      members.push({
        volDaily,
        variant,
        q: spec.direction === "above" ? above : 1 - above,
      });
    }
  }

  const point = members.filter(
    (member) => member.variant === hyperparams.variant,
  );
  if (point.length === 0) {
    return { ok: false, reason: "MODEL_ERROR" };
  }
  // Averaging the configured variant across lambdas beats picking one lambda
  // arbitrarily; the FULL ensemble (both variants x every lambda) is what the
  // dispersion below is measured on.
  const qBase = mean(point.map((member) => member.q));
  const volEwma = mean(point.map((member) => member.volDaily));

  const row = cryptoFeatureRow({ qBase, logDistance, sqrtTau, volEwma });
  let qCorrected = qBase;
  if (hyperparams.calibration !== null) {
    if (hyperparams.calibration.coefficients.length !== row.length) {
      // Caught in the parser as well; a mismatch here means the correction was
      // built against a different feature set version.
      return { ok: false, reason: "MODEL_ERROR" };
    }
    qCorrected = applyLogistic(hyperparams.calibration, row);
  }

  const sigma = Math.max(
    standardDeviation(members.map((member) => member.q)),
    MIN_SIGMA,
  );
  if (!Number.isFinite(qCorrected) || !Number.isFinite(sigma)) {
    return { ok: false, reason: "MODEL_ERROR" };
  }
  const q = Math.min(Math.max(qCorrected, Q_EPSILON), 1 - Q_EPSILON);

  // Provenance of THIS estimate: the exact feed sample and the exact window of
  // closes it was computed from. The two book keys are required by the pinned
  // DataRefs contract but this model never reads a book, so it states that
  // plainly (null venue stamp, the decision instant as the as-of instant); the
  // estimator adds the executable-book refs of the same row alongside them.
  const dataRefs: DataRefs = {
    bookSourceTs: null,
    bookObservedAt: decisionTs.toISOString(),
    feedSourceTs: feed.sourceTs === null ? null : feed.sourceTs.toISOString(),
    feedName: feed.feed,
    feedSymbol: feed.symbol,
    windowFrom:
      history.firstBucket === null ? null : history.firstBucket.toISOString(),
    windowTo:
      history.lastBucket === null ? null : history.lastBucket.toISOString(),
    sampleCount: history.closes.length,
    feedAgeMs: feed.ageMs,
    strike: spec.strike,
    direction: spec.direction,
    tauDays,
    variant: hyperparams.variant,
    ewmaLambdas: [...hyperparams.ewmaLambdas],
    calibrated: hyperparams.calibration !== null,
    modelFamily: CRYPTO_MODEL_FAMILY,
  };

  return {
    ok: true,
    value: {
      q,
      sigma,
      featureSetVersion: CRYPTO_FEATURE_SET_VERSION,
      dataRefs,
      // Staleness of the resolving feed is an abstention above, never a served
      // estimate; the book is not an input to this model at all.
      feedStale: false,
      thinBook: false,
    },
  };
}

export interface CryptoCalibrationFit {
  readonly intercept: number;
  readonly coefficients: readonly number[];
  readonly converged: boolean;
}

/**
 * The refusal fit: the identity map on logit(q_base), i.e. exactly the
 * uncorrected base map. A refusal must never be the all-zero fit, which would
 * collapse every market to 0.5 if it were ever stored and applied.
 */
function identityFit(width: number): CryptoCalibrationFit {
  const coefficients = new Array<number>(Math.max(width, 1)).fill(0);
  coefficients[0] = 1;
  return { intercept: 0, coefficients, converged: false };
}

/**
 * Deterministic walk-forward calibration fit. The caller owns the temporal
 * split (train strictly before validation, never k-fold, never shuffled); this
 * function only turns the rows it is given into coefficients, with no
 * randomness and a fixed iteration budget, so the same samples always produce
 * the same model version.
 *
 * Labels are the resolved outcome in [0, 1]; a 50/50 resolution enters as 0.5,
 * which the logistic loss handles as a half-weight observation of each class.
 */
export function trainCryptoCalibration(
  samples: ReadonlyArray<{
    readonly row: readonly number[];
    readonly label: number;
  }>,
  options: {
    readonly l2?: number;
    readonly iterations?: number;
    readonly learningRate?: number;
  } = {},
): CryptoCalibrationFit {
  const width = samples[0]?.row.length ?? CRYPTO_FEATURE_WIDTH;
  const usable =
    samples.length > 0 &&
    samples.every(
      (sample) =>
        sample.row.length === width &&
        sample.row.every((value) => Number.isFinite(value)) &&
        Number.isFinite(sample.label) &&
        sample.label >= 0 &&
        sample.label <= 1,
    );
  if (!usable) {
    // A malformed training set does not produce a "best effort" correction:
    // it produces the identity, and `converged: false` says so.
    return identityFit(width);
  }

  const fit = fitLogistic(
    samples.map((sample) => [...sample.row]),
    samples.map((sample) => sample.label),
    {
      l2: options.l2 ?? DEFAULT_TRAIN_L2,
      learningRate: options.learningRate ?? DEFAULT_TRAIN_LEARNING_RATE,
      iterations: options.iterations ?? DEFAULT_TRAIN_ITERATIONS,
    },
  );
  if (
    !Number.isFinite(fit.intercept) ||
    !fit.coefficients.every((value) => Number.isFinite(value))
  ) {
    return identityFit(width);
  }
  return {
    intercept: fit.intercept,
    coefficients: [...fit.coefficients],
    converged: fit.converged,
  };
}
