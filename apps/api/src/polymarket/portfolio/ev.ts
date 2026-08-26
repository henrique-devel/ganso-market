// RFC-013 task 1: EV per share, with the cost decomposition the panel and the
// decision log both publish.
//
//   EV_yes = q - ask_exec_yes - costs
//   EV_no  = (1 - q) - ask_exec_no - costs
//   costs  = expected_fee + bookwalk_slippage + capital_cost + resolution_buffer
//
// All money math is scaled bigint (fundamental/fixed.ts), never float: a
// half-cent rounding error is a quarter of the RFC's minimum net edge.
//
// The executable price is ALWAYS a book-walk over the recorded raw book for the
// candidate size. Never a midpoint: the interface switches to the last trade
// when the spread exceeds $0.10, so a mid-derived price is not a price anyone
// could have traded at.

import {
  div,
  formatScaled,
  mul,
  parseScaled,
  SCALE,
} from "../fundamental/fixed.js";
import type { BookLevel, MarketSide } from "./types.js";

/** One day, in seconds — the unit E[lockup] arrives in. */
const DAY_S = 86_400;
const YEAR_DAYS = 365n;

export interface BookWalk {
  /** Volume-weighted average price actually paid for the walked size. */
  readonly vwapScaled: bigint;
  /** Price of the deepest level consumed: the executable worst price. */
  readonly worstScaled: bigint;
  /** Best (top-of-book) price on the walked side. */
  readonly bestScaled: bigint;
  /** Shares the book could actually supply, capped at the requested size. */
  readonly filledScaled: bigint;
  /** True when the book supplied the whole requested size. */
  readonly complete: boolean;
}

/**
 * Walk `sizeScaled` shares through best-first levels. Returns null when a level
 * is malformed — a book we cannot parse is a book we do not trade against.
 */
export function bookWalk(
  levels: readonly BookLevel[],
  sizeScaled: bigint,
): BookWalk | null {
  if (sizeScaled <= 0n) {
    return null;
  }
  let remaining = sizeScaled;
  let notional = 0n;
  let taken = 0n;
  let worst = 0n;
  let best = 0n;
  for (const level of levels) {
    const price = parseScaled(level.price);
    const size = parseScaled(level.size);
    if (price === null || size === null || price <= 0n || size < 0n) {
      return null;
    }
    if (best === 0n) {
      best = price;
    }
    if (remaining <= 0n) {
      break;
    }
    const take = size < remaining ? size : remaining;
    if (take > 0n) {
      notional += mul(price, take);
      taken += take;
      worst = price;
      remaining -= take;
    }
  }
  if (taken === 0n) {
    return null;
  }
  return {
    vwapScaled: div(notional, taken),
    worstScaled: worst,
    bestScaled: best,
    filledScaled: taken,
    complete: remaining <= 0n,
  };
}

/**
 * Total executable depth up to (and including) a limit price. This is what the
 * depth_take_pct limiter is a fraction of — depth and effective spread, never
 * volume: roughly 25% of platform volume is estimated wash (Columbia), so a
 * volume-derived size is a size nobody can actually fill.
 */
export function depthUpTo(
  levels: readonly BookLevel[],
  limitScaled: bigint,
  side: "ask" | "bid",
): bigint {
  let total = 0n;
  for (const level of levels) {
    const price = parseScaled(level.price);
    const size = parseScaled(level.size);
    if (price === null || size === null || price <= 0n || size < 0n) {
      return total;
    }
    const withinLimit =
      side === "ask" ? price <= limitScaled : price >= limitScaled;
    if (!withinLimit) {
      break;
    }
    total += size;
  }
  return total;
}

/**
 * Per-share taker fee at price p: rate x p x (1 - p) (V2, taker only). Maker
 * quotes pay zero, which is why the engine's default intent is a passive
 * post-only quote.
 */
export function takerFeePerShare(
  rateScaled: bigint,
  priceScaled: bigint,
): bigint {
  return mul(rateScaled, mul(priceScaled, SCALE - priceScaled));
}

export interface CapitalCostInput {
  /** Entry price per share (the capital actually tied up). */
  readonly priceScaled: bigint;
  /** Expected lockup, seconds, from the RFC-012 bimodal model. */
  readonly expectedLockupS: number;
  /** Annual cost of capital, scaled. */
  readonly annualRateScaled: bigint;
  /**
   * Per-day capital hurdle the RFC-012 resolution buffer ALREADY charges. The
   * two overlap: bufferBase adds capitalDailyHurdle x lockupDays, and this
   * function would otherwise charge the same lockup a second time. Charging the
   * excess only keeps the total at max(the two) instead of their sum — never
   * less than either, never both.
   */
  readonly bufferDailyHurdleScaled: bigint;
}

export function capitalCostPerShare(input: CapitalCostInput): bigint {
  const lockupDaysScaled =
    (BigInt(Math.max(Math.round(input.expectedLockupS), 0)) * SCALE) /
    BigInt(DAY_S);
  const own = mul(
    mul(input.annualRateScaled, div(lockupDaysScaled, YEAR_DAYS * SCALE)),
    input.priceScaled,
  );
  const alreadyCharged = mul(input.bufferDailyHurdleScaled, lockupDaysScaled);
  const excess = own - alreadyCharged;
  return excess > 0n ? excess : 0n;
}

export interface EvInput {
  readonly side: MarketSide;
  /** Point estimate of P(YES), scaled. Panel only — never the entry gate. */
  readonly qScaled: bigint;
  /** Lower bound of P(YES), scaled. */
  readonly qLoScaled: bigint;
  /** Upper bound of P(YES), scaled. */
  readonly qHiScaled: bigint;
  /** Book-walk over the side being bought, for the candidate size. */
  readonly walk: BookWalk;
  /** Venue taker fee rate for the category, scaled; null = unknown. */
  readonly takerFeeRateScaled: bigint | null;
  /** True when the intent is a passive post-only quote (fee is zero). */
  readonly maker: boolean;
  readonly expectedLockupS: number;
  readonly capitalAnnualRateScaled: bigint;
  readonly bufferDailyHurdleScaled: bigint;
  /** RFC-012 resolution buffer at this entry price, scaled. */
  readonly resolutionBufferScaled: bigint;
  /** Safety margin floor and edge fraction, scaled. */
  readonly safetyMarginMinScaled: bigint;
  readonly safetyMarginEdgeFractionScaled: bigint;
}

export interface EvBreakdown {
  /** The probability the side is paid on: q for YES, 1 - q for NO. */
  readonly probScaled: bigint;
  /** The CONSERVATIVE probability the entry gate uses. */
  readonly probLowerScaled: bigint;
  readonly execPriceScaled: bigint;
  readonly worstPriceScaled: bigint;
  readonly bestPriceScaled: bigint;
  readonly feeScaled: bigint;
  readonly slippageScaled: bigint;
  readonly capitalCostScaled: bigint;
  readonly resolutionBufferScaled: bigint;
  readonly costsTotalScaled: bigint;
  readonly safetyMarginScaled: bigint;
  /** Gross edge on the point estimate — reporting only. */
  readonly edgeGrossScaled: bigint;
  /** Net edge on the LOWER BOUND, after every cost. This is the decision. */
  readonly edgeNetScaled: bigint;
}

function complement(scaled: bigint): bigint {
  return SCALE - scaled;
}

/**
 * The RFC's central asymmetry: the gate uses the LOWER bound of the estimate,
 * never the mean. For a NO position the conservative bound is 1 - q_hi, not
 * 1 - q_lo — flipping the side flips which end of the interval is pessimistic.
 * There is no "high conviction" exception anywhere in this module.
 */
export function computeEv(input: EvInput): EvBreakdown {
  const probScaled =
    input.side === "YES" ? input.qScaled : complement(input.qScaled);
  const probLowerScaled =
    input.side === "YES" ? input.qLoScaled : complement(input.qHiScaled);

  const execPriceScaled = input.walk.vwapScaled;
  // Slippage is what the walk cost beyond the best level — the real cost of
  // taking size, measured on the recorded book rather than assumed.
  const slippageScaled =
    execPriceScaled > input.walk.bestScaled
      ? execPriceScaled - input.walk.bestScaled
      : 0n;

  const feeScaled =
    input.maker || input.takerFeeRateScaled === null
      ? 0n
      : takerFeePerShare(input.takerFeeRateScaled, execPriceScaled);

  const capitalCostScaled = capitalCostPerShare({
    priceScaled: execPriceScaled,
    expectedLockupS: input.expectedLockupS,
    annualRateScaled: input.capitalAnnualRateScaled,
    bufferDailyHurdleScaled: input.bufferDailyHurdleScaled,
  });

  const costsTotalScaled =
    feeScaled +
    slippageScaled +
    capitalCostScaled +
    input.resolutionBufferScaled;

  const edgeGrossScaled = probScaled - execPriceScaled;
  // The margin is a fraction of the gross edge on the LOWER bound, floored at
  // the absolute minimum. Paper-to-live degradation is expected at 20-50%, so
  // the margin exists to be paid out of the edge, not out of hope.
  const lowerGross = probLowerScaled - execPriceScaled;
  const marginFromEdge =
    lowerGross > 0n
      ? mul(input.safetyMarginEdgeFractionScaled, lowerGross)
      : 0n;
  const safetyMarginScaled =
    marginFromEdge > input.safetyMarginMinScaled
      ? marginFromEdge
      : input.safetyMarginMinScaled;

  const edgeNetScaled = lowerGross - costsTotalScaled;

  return {
    probScaled,
    probLowerScaled,
    execPriceScaled,
    worstPriceScaled: input.walk.worstScaled,
    bestPriceScaled: input.walk.bestScaled,
    feeScaled,
    slippageScaled,
    capitalCostScaled,
    resolutionBufferScaled: input.resolutionBufferScaled,
    costsTotalScaled,
    safetyMarginScaled,
    edgeGrossScaled,
    edgeNetScaled,
  };
}

/**
 * The entry criterion (task 2), stated exactly as the RFC states it:
 *
 *   q_lo - executable_price > fees + slippage + capital_cost + safety_margin
 *
 * `edgeNetScaled` already carries the left side minus the first three costs, so
 * what remains is the margin. Returned separately from computeEv because the
 * panel shows near-misses and the log records why each one missed.
 */
export function clearsEntryCriterion(ev: EvBreakdown): boolean {
  return ev.edgeNetScaled > ev.safetyMarginScaled;
}

/** Format a scaled value as the canonical 6-decimal string the tables store. */
export function money(scaled: bigint): string {
  return formatScaled(scaled, 6);
}
