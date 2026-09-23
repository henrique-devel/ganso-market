// Probability formatting and statistical conversions belong to the legacy model.
// Keep the old import surface so every existing consumer uses the same arithmetic.
import { SCALE, divRound } from "../../trading/fixed.js";
export {
  SCALE_DIGITS,
  SCALE,
  parseScaled,
  formatScaled,
  mul,
  div,
  divRound,
  maxScaled,
  minScaled,
} from "../../trading/fixed.js";

/** Output scale of every probability: exactly six fraction digits. */
export const PROB_DIGITS = 6;
export const PROB_SCALE = 1_000_000n;

/** Probabilities are truncated into this closed interval before formatting. */
export const MIN_PROB_SCALED = 1_000n; // 0.001 at PROB_SCALE
export const MAX_PROB_SCALED = 999_000n; // 0.999 at PROB_SCALE

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
