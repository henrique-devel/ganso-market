// Exact fixed-point arithmetic for the fundamental model's price and depth
// math. Prices, sizes and notionals never pass through a float: they are
// parsed from their canonical decimal strings straight into scaled BigInt, as
// required by the project's money rules and by RFC-010's byte-determinism
// requirement. Statistical model internals (normal/Student-t tails, EWMA,
// logistic regression) do use IEEE-754 doubles — that is deliberate and
// documented — but every value that leaves this module is quantized back to a
// canonical decimal string first.

/** Working scale: nine fraction digits, matching the order book's precision. */
export const SCALE_DIGITS = 9;
export const SCALE = 1_000_000_000n;

/** Output scale of every probability: exactly six fraction digits. */
export const PROB_DIGITS = 6;
export const PROB_SCALE = 1_000_000n;

/** Probabilities are truncated into this closed interval before formatting. */
export const MIN_PROB_SCALED = 1_000n; // 0.001 at PROB_SCALE
export const MAX_PROB_SCALED = 999_000n; // 0.999 at PROB_SCALE

const DECIMAL_PATTERN = /^-?(?:\d+)(?:\.\d+)?$/;

/**
 * Parse a canonical non-negative decimal string into a BigInt scaled by
 * 10^SCALE_DIGITS. Returns null for anything that is not a plain decimal
 * number (no exponent form, no whitespace, no NaN/Infinity), so callers fail
 * closed instead of silently coercing.
 */
export function parseScaled(value: string): bigint | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  if (!DECIMAL_PATTERN.test(value)) {
    return null;
  }
  const negative = value.startsWith("-");
  const body = negative ? value.slice(1) : value;
  const [intPart = "0", fracPart = ""] = body.split(".");
  if (fracPart.length > SCALE_DIGITS) {
    // More precision than the working scale would silently truncate; refuse.
    const extra = fracPart.slice(SCALE_DIGITS);
    if (/[^0]/.test(extra)) {
      return null;
    }
  }
  const fraction = (fracPart + "0".repeat(SCALE_DIGITS)).slice(0, SCALE_DIGITS);
  const magnitude = BigInt(intPart + fraction);
  return negative ? -magnitude : magnitude;
}

/** Format a scaled BigInt with exactly `digits` fraction digits (truncating). */
export function formatScaled(value: bigint, digits: number): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / SCALE;
  const fraction = (magnitude % SCALE)
    .toString()
    .padStart(SCALE_DIGITS, "0")
    .slice(0, digits);
  const sign = negative ? "-" : "";
  return digits === 0
    ? `${sign}${whole.toString()}`
    : `${sign}${whole.toString()}.${fraction}`;
}

/** (a * b) / SCALE, rounded half away from zero. */
export function mul(a: bigint, b: bigint): bigint {
  return divRound(a * b, SCALE);
}

/** (a * SCALE) / b, rounded half away from zero. Division by zero yields 0n. */
export function div(a: bigint, b: bigint): bigint {
  if (b === 0n) {
    return 0n;
  }
  return divRound(a * SCALE, b);
}

/** Integer division rounded half away from zero. */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    return 0n;
  }
  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * Quantize a scaled value to the probability output scale, truncating into
 * [0.001, 0.999], and format it as a canonical six-digit decimal string.
 * Deterministic: the same scaled input always produces the same bytes.
 */
export function formatProbabilityScaled(value: bigint): string {
  const atProbScale = divRound(value, SCALE / PROB_SCALE);
  const clamped =
    atProbScale < MIN_PROB_SCALED
      ? MIN_PROB_SCALED
      : atProbScale > MAX_PROB_SCALED
        ? MAX_PROB_SCALED
        : atProbScale;
  const whole = clamped / PROB_SCALE;
  const fraction = (clamped % PROB_SCALE).toString().padStart(PROB_DIGITS, "0");
  return `${whole.toString()}.${fraction}`;
}

/**
 * Convert a double in [0, 1] into the working scale. The double is rounded at
 * the working scale, which is the single point where statistical model output
 * becomes exact again.
 */
export function probabilityToScaled(value: number): bigint {
  if (!Number.isFinite(value)) {
    return 0n;
  }
  const bounded = value < 0 ? 0 : value > 1 ? 1 : value;
  return BigInt(Math.round(bounded * Number(SCALE)));
}

/** Convert a scaled value into a double (for statistical model internals). */
export function scaledToNumber(value: bigint): number {
  return Number(value) / Number(SCALE);
}

export function maxScaled(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function minScaled(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
