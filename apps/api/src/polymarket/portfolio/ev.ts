// RFC-013 task 1: EV per share, with the cost decomposition the panel and the
// decision log both publish.
//
//   EV_yes = q - ask_exec_yes - costs
//   EV_no  = (1 - q) - ask_exec_no - costs
//   costs  = expected_fee + capital_cost + resolution_buffer + maker_adverse_selection
//
// All money math is scaled bigint (fundamental/fixed.ts), never float: a
// half-cent rounding error is a quarter of the RFC's minimum net edge.
//
// Taker price is a book-walk; an explicit maker quote uses its limit price.
// The legacy candidate calculation retains its book-walk price proxy. Never a midpoint: the interface switches to the last trade
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

/** v2 excludes diagnostic slippage from costsTotalScaled (USD/share, 1e9). */
export const EV_MODEL_VERSION = "ev-costs-v2";

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
    if (
      price === null ||
      size === null ||
      price <= 0n ||
      price >= SCALE ||
      size < 0n
    ) {
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
    if (
      price === null ||
      size === null ||
      price <= 0n ||
      price >= SCALE ||
      size < 0n
    ) {
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
  /** Annual cost of capital, dimensionless fraction/year, scaled by 1e9. */
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
  /** True for a passive post-only quote; legacy candidate fee defaults to zero. */
  readonly maker: boolean;
  /** Maker limit in USD/share, 1e9. Absent = legacy candidate VWAP proxy. */
  readonly makerLimitPriceScaled?: bigint;
  /** Explicit maker fee in USD/share, 1e9; no rebate is assumed. */
  readonly makerFeeScaled?: bigint;
  /** Conditional-on-fill adverse selection cost, USD/share, 1e9. */
  readonly makerAdverseSelectionScaled?: bigint;
  /** Expected remaining lockup in seconds. */
  readonly expectedLockupS: number;
  /** Dimensionless annual fraction, 1e9. */
  readonly capitalAnnualRateScaled: bigint;
  /** USD/share/day already included in resolutionBufferScaled, 1e9. */
  readonly bufferDailyHurdleScaled: bigint;
  /** RFC-012 resolution buffer at this entry price, USD/share, 1e9. */
  readonly resolutionBufferScaled: bigint;
  /** Safety margin floor, USD/share, 1e9; compared separately, not a cost. */
  readonly safetyMarginMinScaled: bigint;
  /** Dimensionless fraction of conservative gross edge, 1e9. */
  readonly safetyMarginEdgeFractionScaled: bigint;
}

/** Monetary fields are USD/share scaled by 1e9, probabilities dimensionless. */
export interface EvBreakdown {
  readonly modelVersion: typeof EV_MODEL_VERSION;
  readonly priceBasis: "taker-vwap" | "maker-limit" | "candidate-vwap";
  /** False means feeScaled=0 is only an unavailable-cost placeholder. */
  readonly feeKnown: boolean;
  readonly bookComplete: boolean;
  /** The probability the side is paid on: q for YES, 1 - q for NO. */
  readonly probScaled: bigint;
  /** The CONSERVATIVE probability the entry gate uses. */
  readonly probLowerScaled: bigint;
  readonly execPriceScaled: bigint;
  readonly worstPriceScaled: bigint;
  readonly bestPriceScaled: bigint;
  readonly feeScaled: bigint;
  /** Walk VWAP minus best ask: diagnostic only, even for a maker quote. */
  readonly slippageScaled: bigint;
  readonly makerAdverseSelectionScaled: bigint;
  readonly capitalCostScaled: bigint;
  readonly resolutionBufferScaled: bigint;
  /** v2: fee + capital excess + resolution buffer + maker adverse selection. */
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

  const execPriceScaled = input.maker
    ? (input.makerLimitPriceScaled ?? input.walk.vwapScaled)
    : input.walk.vwapScaled;
  // Preserve the walk diagnostic. VWAP already includes this price impact;
  // adding it to costs would charge it twice. It is not a maker fill forecast.
  const slippageScaled =
    input.walk.vwapScaled > input.walk.bestScaled
      ? input.walk.vwapScaled - input.walk.bestScaled
      : 0n;

  const feeKnown = input.maker
    ? (input.makerFeeScaled ?? 0n) >= 0n
    : input.takerFeeRateScaled !== null && input.takerFeeRateScaled >= 0n;
  const feeScaled = input.maker
    ? (input.makerFeeScaled ?? 0n)
    : feeKnown
      ? takerFeePerShare(input.takerFeeRateScaled!, execPriceScaled)
      : 0n;
  const makerAdverseSelectionScaled = input.maker
    ? (input.makerAdverseSelectionScaled ?? 0n)
    : 0n;

  const capitalCostScaled = capitalCostPerShare({
    priceScaled: execPriceScaled,
    expectedLockupS: input.expectedLockupS,
    annualRateScaled: input.capitalAnnualRateScaled,
    bufferDailyHurdleScaled: input.bufferDailyHurdleScaled,
  });

  const costsTotalScaled =
    feeScaled +
    capitalCostScaled +
    input.resolutionBufferScaled +
    makerAdverseSelectionScaled;

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
    modelVersion: EV_MODEL_VERSION,
    priceBasis: input.maker
      ? input.makerLimitPriceScaled === undefined
        ? "candidate-vwap"
        : "maker-limit"
      : "taker-vwap",
    feeKnown,
    bookComplete: input.walk.complete,
    probScaled,
    probLowerScaled,
    execPriceScaled,
    worstPriceScaled: input.walk.worstScaled,
    bestPriceScaled: input.walk.bestScaled,
    feeScaled,
    slippageScaled,
    makerAdverseSelectionScaled,
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
 *   conservative_payoff - price > fee + capital_excess + buffer
 *                                 + maker_adverse_selection + safety_margin
 *
 * `edgeNetScaled` already carries the left side minus the additional costs, so
 * what remains is the margin. Returned separately from computeEv because the
 * panel shows near-misses and the log records why each one missed.
 */
export function clearsEntryCriterion(ev: EvBreakdown): boolean {
  return (
    ev.feeKnown && ev.bookComplete && ev.edgeNetScaled > ev.safetyMarginScaled
  );
}

/** Format a scaled value as the canonical 6-decimal string the tables store. */
export function money(scaled: bigint): string {
  return formatScaled(scaled, 6);
}

export type ExecutionEvResult =
  | { readonly ok: true; readonly value: EvBreakdown }
  | { readonly ok: false; readonly reason: string };

/**
 * EXEC-02's pure cost contract; no broker/sizing integration here.
 * Taker requires a complete BUY-side walk and a known fee rate. Maker requires
 * explicit limit/fee/adverse-selection evidence; EV is CONDITIONAL on fill,
 * not a fill probability or permission to aggress. The supplied walk remains
 * a diagnostic reference, not evidence that a maker quote will fill.
 * Fee provenance/age and matching the final order remain the caller's duty.
 */
export function computeExecutionEv(input: EvInput): ExecutionEvResult {
  const validPrice = (price: bigint): boolean => price > 0n && price < SCALE;
  if (
    input.qLoScaled < 0n ||
    input.qHiScaled > SCALE ||
    input.qLoScaled > input.qScaled ||
    input.qScaled > input.qHiScaled ||
    !Number.isFinite(input.expectedLockupS) ||
    input.expectedLockupS < 0 ||
    input.capitalAnnualRateScaled < 0n ||
    input.bufferDailyHurdleScaled < 0n ||
    input.resolutionBufferScaled < 0n ||
    input.safetyMarginMinScaled < 0n ||
    input.safetyMarginEdgeFractionScaled < 0n
  ) {
    return { ok: false, reason: "INVALID_EV_INPUT" };
  }
  if (
    !validPrice(input.walk.vwapScaled) ||
    !validPrice(input.walk.bestScaled) ||
    !validPrice(input.walk.worstScaled) ||
    input.walk.bestScaled > input.walk.vwapScaled ||
    input.walk.vwapScaled > input.walk.worstScaled ||
    input.walk.filledScaled <= 0n
  ) {
    return { ok: false, reason: "INVALID_BUY_WALK" };
  }
  if (input.maker) {
    if (
      input.makerLimitPriceScaled === undefined ||
      !validPrice(input.makerLimitPriceScaled) ||
      input.makerLimitPriceScaled >= input.walk.bestScaled
    ) {
      return { ok: false, reason: "INVALID_MAKER_LIMIT" };
    }
    if (input.makerFeeScaled === undefined || input.makerFeeScaled < 0n) {
      return { ok: false, reason: "MAKER_FEE_UNKNOWN" };
    }
    if (
      input.makerAdverseSelectionScaled === undefined ||
      input.makerAdverseSelectionScaled < 0n
    ) {
      return { ok: false, reason: "MAKER_SELECTION_COST_UNKNOWN" };
    }
  } else {
    if (!input.walk.complete) {
      return { ok: false, reason: "BOOK_WALK_INCOMPLETE" };
    }
    if (input.takerFeeRateScaled === null || input.takerFeeRateScaled < 0n) {
      return { ok: false, reason: "TAKER_FEE_UNKNOWN" };
    }
  }
  return { ok: true, value: computeEv(input) };
}
