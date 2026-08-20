// Deterministic statistical primitives for RFC-010. Everything here is a pure
// function of its arguments: no clock, no randomness other than the explicitly
// seeded generator below, no I/O. Same inputs => same doubles => same bytes
// after quantization.
//
// These internals are the one place where IEEE-754 doubles are used (tail
// probabilities, volatility, regression). That is deliberate: they are
// statistics, not money. Every value that leaves the model is quantized back
// to exact fixed-point before it is stored (see fixed.ts).

/**
 * Standard normal CDF, Hart's double-precision rational approximation
 * (|error| < 1e-15 over the useful range). Chosen over the classic
 * Abramowitz-Stegun 7.1.26 (error ~1.2e-7) because estimates are quantized at
 * 1e-6 and a 1e-7 error could move the last stored digit.
 */
export function normalCdf(x: number): number {
  if (!Number.isFinite(x)) {
    return x > 0 ? 1 : 0;
  }
  const absX = Math.abs(x);
  let upperTail: number;
  if (absX > 37) {
    upperTail = 0;
  } else {
    const density = Math.exp((-absX * absX) / 2);
    if (absX < 7.07106781186547) {
      let numerator = 3.52624965998911e-2 * absX + 0.700383064443688;
      numerator = numerator * absX + 6.37396220353165;
      numerator = numerator * absX + 33.912866078383;
      numerator = numerator * absX + 112.079291497871;
      numerator = numerator * absX + 221.213596169931;
      numerator = numerator * absX + 220.206867912376;
      let denominator = 8.83883476483184e-2 * absX + 1.75566716318264;
      denominator = denominator * absX + 16.064177579207;
      denominator = denominator * absX + 86.7807322029461;
      denominator = denominator * absX + 296.564248779674;
      denominator = denominator * absX + 637.333633378831;
      denominator = denominator * absX + 793.826512519948;
      denominator = denominator * absX + 440.413735824752;
      upperTail = (density * numerator) / denominator;
    } else {
      let build = absX + 0.65;
      build = absX + 4 / build;
      build = absX + 3 / build;
      build = absX + 2 / build;
      build = absX + 1 / build;
      upperTail = density / (build * 2.506628274631);
    }
  }
  return x > 0 ? 1 - upperTail : upperTail;
}

const LOG_GAMMA_COEFFICIENTS = [
  76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
  0.1208650973866179e-2, -0.5395239384953e-5,
];

/** Lanczos log-gamma; used only by the Student-t tail. */
export function logGamma(x: number): number {
  let y = x;
  const temp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let series = 1.000000000190015;
  for (const coefficient of LOG_GAMMA_COEFFICIENTS) {
    y += 1;
    series += coefficient / y;
  }
  return -temp + Math.log((2.5066282746310005 * series) / x);
}

const BETA_CF_MAX_ITERATIONS = 200;
const BETA_CF_EPSILON = 3e-16;
const BETA_CF_TINY = 1e-300;

/** Continued-fraction expansion of the incomplete beta (modified Lentz). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < BETA_CF_TINY) {
    d = BETA_CF_TINY;
  }
  d = 1 / d;
  let result = d;
  for (let m = 1; m <= BETA_CF_MAX_ITERATIONS; m += 1) {
    const m2 = 2 * m;
    let numerator = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < BETA_CF_TINY) {
      d = BETA_CF_TINY;
    }
    c = 1 + numerator / c;
    if (Math.abs(c) < BETA_CF_TINY) {
      c = BETA_CF_TINY;
    }
    d = 1 / d;
    result *= d * c;
    numerator = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < BETA_CF_TINY) {
      d = BETA_CF_TINY;
    }
    c = 1 + numerator / c;
    if (Math.abs(c) < BETA_CF_TINY) {
      c = BETA_CF_TINY;
    }
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < BETA_CF_EPSILON) {
      break;
    }
  }
  return result;
}

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  const front = Math.exp(
    logGamma(a + b) -
      logGamma(a) -
      logGamma(b) +
      a * Math.log(x) +
      b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** CDF of a Student-t with `df` degrees of freedom. */
export function studentTCdf(t: number, df: number): number {
  if (!Number.isFinite(t)) {
    return t > 0 ? 1 : 0;
  }
  if (!(df > 0)) {
    return normalCdf(t);
  }
  const x = df / (df + t * t);
  const tail = 0.5 * incompleteBeta(df / 2, 0.5, x);
  return t > 0 ? 1 - tail : tail;
}

export function sigmoid(x: number): number {
  if (x >= 0) {
    return 1 / (1 + Math.exp(-x));
  }
  const exponential = Math.exp(x);
  return exponential / (1 + exponential);
}

export function logit(p: number, epsilon = 1e-6): number {
  const bounded = Math.min(Math.max(p, epsilon), 1 - epsilon);
  return Math.log(bounded / (1 - bounded));
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

/** Sample standard deviation (n-1); 0 for fewer than two points. */
export function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const average = mean(values);
  let total = 0;
  for (const value of values) {
    const deviation = value - average;
    total += deviation * deviation;
  }
  return Math.sqrt(total / (values.length - 1));
}

/**
 * EWMA volatility of log returns: sigma^2_t = lambda * sigma^2_{t-1} +
 * (1 - lambda) * r_t^2, seeded with the sample variance of the first
 * observations. Returns the per-step volatility (same period as the returns).
 */
export const EWMA_SEED_WINDOW = 30;

export function ewmaVolatility(
  returns: readonly number[],
  lambda: number,
): number {
  if (returns.length === 0) {
    return 0;
  }
  // Seed with the mean square of the first EWMA_SEED_WINDOW returns rather
  // than with a single squared return: one outlier in position zero would
  // otherwise dominate the estimate for dozens of steps at lambda = 0.94.
  const seedCount = Math.min(returns.length, EWMA_SEED_WINDOW);
  let seed = 0;
  for (let index = 0; index < seedCount; index += 1) {
    const value = returns[index] ?? 0;
    seed += value * value;
  }
  let variance = seed / seedCount;
  for (let index = seedCount; index < returns.length; index += 1) {
    const value = returns[index] ?? 0;
    variance = lambda * variance + (1 - lambda) * value * value;
  }
  return Math.sqrt(Math.max(variance, 0));
}

/** Log returns of a price series; non-positive or non-finite points are skipped. */
export function logReturns(prices: readonly number[]): number[] {
  const returns: number[] = [];
  for (let index = 1; index < prices.length; index += 1) {
    const previous = prices[index - 1];
    const current = prices[index];
    if (
      previous === undefined ||
      current === undefined ||
      !(previous > 0) ||
      !(current > 0)
    ) {
      continue;
    }
    returns.push(Math.log(current / previous));
  }
  return returns;
}

/**
 * Deterministic 32-bit PRNG (mulberry32 seeded through splitmix32). Uses only
 * exact integer operations, so it produces the identical stream on every
 * platform — a requirement for reproducible bootstrap confidence intervals.
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  // splitmix32 warm-up so nearby seeds do not produce correlated streams.
  state = (state + 0x9e3779b9) >>> 0;
  let mixed = state;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97) >>> 0;
  let internal = (mixed ^ (mixed >>> 15)) >>> 0;
  return function next(): number {
    internal = (internal + 0x6d2b79f5) >>> 0;
    let value = internal;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a string (FNV-1a); used to derive per-model seeds. */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Empirical quantile with linear interpolation; `values` need not be sorted. */
export function quantile(
  values: readonly number[],
  probability: number,
): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * Math.min(Math.max(probability, 0), 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex] ?? 0;
  const upper = sorted[upperIndex] ?? lower;
  return lower + (upper - lower) * (position - lowerIndex);
}

export interface LogisticFit {
  readonly intercept: number;
  readonly coefficients: readonly number[];
  readonly iterations: number;
  readonly converged: boolean;
}

/**
 * L2-regularized logistic regression by batch gradient descent with a fixed
 * iteration budget and a fixed learning rate. No randomness, no shuffling:
 * the fit is a pure function of (rows, labels, hyperparameters), which is what
 * makes a trained model version reproducible from the registry alone.
 */
export function fitLogistic(
  rows: readonly (readonly number[])[],
  labels: readonly number[],
  options: {
    readonly l2?: number;
    readonly learningRate?: number;
    readonly iterations?: number;
    readonly tolerance?: number;
  } = {},
): LogisticFit {
  const l2 = options.l2 ?? 1;
  const learningRate = options.learningRate ?? 0.1;
  const maxIterations = options.iterations ?? 500;
  const tolerance = options.tolerance ?? 1e-9;
  const width = rows[0]?.length ?? 0;
  const coefficients = new Array<number>(width).fill(0);
  let intercept = 0;
  const count = rows.length;
  if (count === 0 || width === 0) {
    return { intercept: 0, coefficients, iterations: 0, converged: true };
  }

  let converged = false;
  let iteration = 0;
  for (; iteration < maxIterations; iteration += 1) {
    const gradient = new Array<number>(width).fill(0);
    let interceptGradient = 0;
    for (let rowIndex = 0; rowIndex < count; rowIndex += 1) {
      const row = rows[rowIndex] ?? [];
      let z = intercept;
      for (let column = 0; column < width; column += 1) {
        z += (coefficients[column] ?? 0) * (row[column] ?? 0);
      }
      const error = sigmoid(z) - (labels[rowIndex] ?? 0);
      interceptGradient += error;
      for (let column = 0; column < width; column += 1) {
        gradient[column] = (gradient[column] ?? 0) + error * (row[column] ?? 0);
      }
    }
    let maximumStep = Math.abs((learningRate * interceptGradient) / count);
    intercept -= (learningRate * interceptGradient) / count;
    for (let column = 0; column < width; column += 1) {
      const penalized =
        (gradient[column] ?? 0) / count +
        (l2 * (coefficients[column] ?? 0)) / count;
      const step = learningRate * penalized;
      maximumStep = Math.max(maximumStep, Math.abs(step));
      coefficients[column] = (coefficients[column] ?? 0) - step;
    }
    if (maximumStep < tolerance) {
      converged = true;
      iteration += 1;
      break;
    }
  }
  return { intercept, coefficients, iterations: iteration, converged };
}

/** Apply a logistic fit to one feature row. */
export function applyLogistic(
  fit: { readonly intercept: number; readonly coefficients: readonly number[] },
  row: readonly number[],
): number {
  let z = fit.intercept;
  for (let index = 0; index < fit.coefficients.length; index += 1) {
    z += (fit.coefficients[index] ?? 0) * (row[index] ?? 0);
  }
  return sigmoid(z);
}
