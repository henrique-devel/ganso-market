// RFC-013 task 9, gate G2: the block bootstrap that decides whether the paper
// PnL is distinguishable from zero.
//
// Two properties the RFC demands explicitly:
//
//  1. REPRODUCIBLE. A fixed seed and a deterministic generator, so the same
//     inputs always produce the same interval. An irreproducible gate is not a
//     gate: it is a number nobody can check.
//
//  2. BLOCK bootstrap, not i.i.d. Consecutive paper trades are not independent
//     — they share a market, a regime and often a factor — so resampling one
//     observation at a time would understate the variance and manufacture a
//     confidence interval that excludes zero when it should not.
//
// The haircut is applied BEFORE the interval is taken, not after: the RFC
// requires the realized edge to survive a 50% degradation, and haircutting the
// bound instead of the data would answer a different question.

/**
 * mulberry32: a small, fast, well-distributed 32-bit PRNG.
 *
 * Written out rather than pulled from a dependency because reproducibility is
 * the point: the sequence must not change when a package does.
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapInput {
  /** Realized PnL per closed position, in chronological order. */
  readonly samples: readonly number[];
  readonly resamples: number;
  readonly blockSize: number;
  readonly seed: number;
  /** Fraction of the realized edge to discard before measuring. */
  readonly haircut: number;
}

export interface BootstrapResult {
  readonly n: number;
  readonly mean: number;
  /** Mean after the haircut — what the gate actually judges. */
  readonly haircutMean: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  readonly resamples: number;
  readonly blockSize: number;
  readonly seed: number;
  /** True when the whole 95% interval sits above zero. */
  readonly aboveZero: boolean;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowValue = sorted[lower] ?? 0;
  const highValue = sorted[upper] ?? lowValue;
  if (lower === upper) {
    return lowValue;
  }
  return lowValue + (highValue - lowValue) * (index - lower);
}

/**
 * Moving-block bootstrap of the mean, with a 95% percentile interval.
 *
 * Blocks are drawn with replacement from all overlapping windows of
 * `blockSize` consecutive observations, and concatenated until the resample is
 * at least as long as the original series. That preserves the short-range
 * dependence between neighbouring trades, which is exactly what an i.i.d.
 * bootstrap throws away.
 */
export function blockBootstrapMean(input: BootstrapInput): BootstrapResult {
  const n = input.samples.length;
  const haircut = Math.min(Math.max(input.haircut, 0), 1);
  const haircutSamples = input.samples.map((value) => value * (1 - haircut));
  const observedMean = mean(input.samples);
  const observedHaircutMean = mean(haircutSamples);

  if (n === 0) {
    return {
      n: 0,
      mean: 0,
      haircutMean: 0,
      ciLow: 0,
      ciHigh: 0,
      resamples: input.resamples,
      blockSize: input.blockSize,
      seed: input.seed,
      aboveZero: false,
    };
  }

  const blockSize = Math.min(Math.max(Math.floor(input.blockSize), 1), n);
  const blockStarts = n - blockSize + 1;
  const random = createSeededRandom(input.seed);
  const means: number[] = [];

  for (let draw = 0; draw < input.resamples; draw += 1) {
    let total = 0;
    let count = 0;
    while (count < n) {
      const start = Math.floor(random() * blockStarts);
      for (let offset = 0; offset < blockSize && count < n; offset += 1) {
        total += haircutSamples[start + offset] ?? 0;
        count += 1;
      }
    }
    means.push(total / n);
  }

  means.sort((a, b) => a - b);
  const ciLow = percentile(means, 0.025);
  const ciHigh = percentile(means, 0.975);

  return {
    n,
    mean: observedMean,
    haircutMean: observedHaircutMean,
    ciLow,
    ciHigh,
    resamples: input.resamples,
    blockSize,
    seed: input.seed,
    // The RFC's bar: the whole interval above zero, not merely the point
    // estimate. A lower bound at exactly zero does not clear it.
    aboveZero: ciLow > 0,
  };
}

/**
 * Brier score: mean squared error of a probabilistic forecast.
 *
 * The RFC's reference points: the market price alone scores ~0.074, and the
 * signal used for entries must come in under 0.20. Lower is better, and a
 * forecast that cannot beat the price is not evidence of anything.
 */
export function brierScore(
  forecasts: readonly {
    readonly probability: number;
    readonly outcome: 0 | 1;
  }[],
): number {
  if (forecasts.length === 0) {
    return Number.NaN;
  }
  let total = 0;
  for (const point of forecasts) {
    const diff = point.probability - point.outcome;
    total += diff * diff;
  }
  return total / forecasts.length;
}

/** Log loss, clamped so a confident miss is finite rather than infinite. */
export function logLoss(
  forecasts: readonly {
    readonly probability: number;
    readonly outcome: 0 | 1;
  }[],
  epsilon = 1e-6,
): number {
  if (forecasts.length === 0) {
    return Number.NaN;
  }
  let total = 0;
  for (const point of forecasts) {
    const p = Math.min(Math.max(point.probability, epsilon), 1 - epsilon);
    total += point.outcome === 1 ? -Math.log(p) : -Math.log(1 - p);
  }
  return total / forecasts.length;
}

/**
 * Brier skill score against a reference forecast (here: the market price).
 * Positive means the forecast beat the reference; zero or negative means it did
 * not, and the RFC treats "did not beat the price" as no evidence at all.
 */
export function brierSkillScore(
  forecastBrier: number,
  referenceBrier: number,
): number {
  if (!Number.isFinite(referenceBrier) || referenceBrier <= 0) {
    return Number.NaN;
  }
  return 1 - forecastBrier / referenceBrier;
}
