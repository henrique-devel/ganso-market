// Exact decimal working arithmetic extracted from the integrated legacy model.
// The nine-digit scale is an internal representation, not a trading.v1 unit:
// USD/BTC contract amounts keep their own explicit scales and reject inexact
// conversion. No probability clamps or floating-point model conversions here.
export const SCALE_DIGITS = 9;
export const SCALE = 1_000_000_000n;

const DECIMAL_PATTERN = /^-?(?:\d+)(?:\.\d+)?$/;

/**
 * Parse a plain signed decimal string into a BigInt scaled by
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

export function maxScaled(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function minScaled(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
