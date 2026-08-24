// RFC-011 Part B1–B5: the deterministic order-type policy, a pure function
// with zero discretion. Every decision carries policy_reason and — by type
// and by property test — a limit price: no code path can emit an order
// without one. Marketable orders (FAK) exist only when the LOWER bound of the
// probability estimate beats the book-walk worst price by more than the taker
// fee plus a safety margin; everything else rests passive post-only, where
// the maker fee is zero.
//
// The external fair signal and the catalyst clock are DEFENSIVE inputs only
// (Glosten-Milgrom: adverse selection worsens near information events): they
// widen or pull quotes, they never trigger taker aggression — the measured
// taker markout at +1s is negative across every symbol.

import type { PriceLevel } from "../types.js";
import {
  SCALE,
  div,
  formatScaled,
  mul,
  parseScaled,
} from "../fundamental/fixed.js";
import type { OrderSide, OrderType } from "./validator.js";

export const POLICY_VERSION = "1.0.0";

/** Marketable orders in crypto/finance suffer this match delay (B5). */
export const TAKER_DELAY_MS = 250;

/** Default safety margin over the taker fee, in price units (100 bps). */
export const DEFAULT_TAKER_MARGIN = "0.01";

/** Default catalyst proximity (minutes) below which quotes widen (B4). */
export const DEFAULT_CATALYST_THRESHOLD_MIN = 30;

/** Default widening, in ticks, applied by the B4 retreat rules. */
export const DEFAULT_WIDEN_TICKS = 2n;

export interface PolicyContext {
  readonly side: OrderSide;
  /** Lower bound of the fundamental probability (q_lo), decimal string. */
  readonly qLo: string;
  /** Desired size in shares, decimal string. */
  readonly size: string;
  /** Top-10 book at the decision instant. */
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
  readonly tickSize: string;
  /**
   * Venue fee rate for takers in this market's category (e.g. "0.07" for
   * crypto). Null = unknown, which conservatively disables taker orders.
   * The fee formula is per share: rate x p x (1 - p).
   */
  readonly takerFeeRate: string | null;
  /** Minutes until the next known catalyst; null = none known. */
  readonly minsToCatalyst: number | null;
  /** Defensive external-fair signal: the fair moved against our quote. */
  readonly externalFairAgainst: boolean;
  /** Desired resting life in seconds; presence selects GTD over GTC. */
  readonly ttlS?: number | null;
  readonly catalystThresholdMin?: number;
  readonly takerMargin?: string;
}

export interface PolicyDecision {
  readonly orderType: OrderType;
  /** ALWAYS present: the policy cannot emit an order without a limit. */
  readonly limitPrice: string;
  readonly postOnly: boolean;
  readonly worstPrice: string | null;
  readonly ttlS: number | null;
  /** Simulator input (B5): marketable orders match against t+delay. */
  readonly expectedTakerDelayMs: number;
  readonly policyReason: string;
}

export type PolicyResult =
  | { readonly ok: true; readonly value: PolicyDecision }
  | { readonly ok: false; readonly reason: string };

interface BookWalk {
  /** Price of the deepest level consumed (the executable worst price). */
  readonly worstScaled: bigint;
  /** VWAP of the walk, scaled. */
  readonly vwapScaled: bigint;
  readonly filled: boolean;
}

/** Walk the opposing side for `sizeScaled` shares; best-first levels. */
function walkForSize(
  levels: readonly PriceLevel[],
  sizeScaled: bigint,
): BookWalk | null {
  let remaining = sizeScaled;
  let notional = 0n;
  let taken = 0n;
  let worst = 0n;
  for (const level of levels) {
    const price = parseScaled(level.price);
    const size = parseScaled(level.size);
    if (price === null || size === null || price <= 0n || size < 0n) {
      return null;
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
    return { worstScaled: 0n, vwapScaled: 0n, filled: false };
  }
  return {
    worstScaled: worst,
    vwapScaled: div(notional, taken),
    filled: remaining <= 0n,
  };
}

/** Per-share taker fee at price p: rate x p x (1 - p). */
export function takerFeePerShare(
  rateScaled: bigint,
  priceScaled: bigint,
): bigint {
  return mul(rateScaled, mul(priceScaled, SCALE - priceScaled));
}

/**
 * The deterministic decision. Every returned order has a limit price; the
 * only marketable output is FAK with an explicit worst price, and only when
 * q_lo clears the executable worst price by fee + margin.
 */
export function decideOrderType(context: PolicyContext): PolicyResult {
  const tick = parseScaled(context.tickSize);
  const qLo = parseScaled(context.qLo);
  const size = parseScaled(context.size);
  if (tick === null || tick <= 0n) {
    return { ok: false, reason: "UNKNOWN_TICK_SIZE" };
  }
  if (qLo === null || qLo <= 0n || qLo >= SCALE) {
    return { ok: false, reason: "INVALID_Q_LO" };
  }
  if (size === null || size <= 0n) {
    return { ok: false, reason: "INVALID_SIZE" };
  }
  const bestBid = parseScaled(context.bids[0]?.price ?? "");
  const bestAsk = parseScaled(context.asks[0]?.price ?? "");
  if (bestBid === null || bestAsk === null || bestBid >= bestAsk) {
    return { ok: false, reason: "NO_TRADABLE_BOOK" };
  }

  const priceDigits = 6;
  const fmt = (value: bigint): string => formatScaled(value, priceDigits);
  const ttlS = context.ttlS ?? null;
  const restingType: OrderType = ttlS === null ? "GTC" : "GTD";

  // B4 retreat rules come FIRST: near a catalyst or against a moving external
  // fair, the policy only quotes wider — it never turns aggressive.
  const threshold =
    context.catalystThresholdMin ?? DEFAULT_CATALYST_THRESHOLD_MIN;
  const widen = DEFAULT_WIDEN_TICKS * tick;
  if (context.externalFairAgainst) {
    const limit = context.side === "BUY" ? bestBid - widen : bestAsk + widen;
    if (limit <= 0n || limit >= SCALE) {
      return { ok: false, reason: "NO_SAFE_QUOTE" };
    }
    return {
      ok: true,
      value: {
        orderType: restingType,
        limitPrice: fmt(limit),
        postOnly: true,
        worstPrice: null,
        ttlS,
        expectedTakerDelayMs: 0,
        policyReason: "EXTERNAL_FAIR_AGAINST_WIDEN",
      },
    };
  }
  if (context.minsToCatalyst !== null && context.minsToCatalyst <= threshold) {
    const limit = context.side === "BUY" ? bestBid - widen : bestAsk + widen;
    if (limit <= 0n || limit >= SCALE) {
      return { ok: false, reason: "NO_SAFE_QUOTE" };
    }
    return {
      ok: true,
      value: {
        orderType: restingType,
        limitPrice: fmt(limit),
        postOnly: true,
        worstPrice: null,
        ttlS,
        expectedTakerDelayMs: 0,
        policyReason: "CATALYST_NEAR_WIDEN",
      },
    };
  }

  // B3 taker eligibility: only with a known fee, enough visible depth, and
  // q_lo beating the book-walk worst price by fee + margin. Anything short
  // of all three rests passive.
  const rate =
    context.takerFeeRate === null ? null : parseScaled(context.takerFeeRate);
  if (rate !== null && rate >= 0n) {
    const opposing = context.side === "BUY" ? context.asks : context.bids;
    const walk = walkForSize(opposing, size);
    if (walk !== null && walk.filled) {
      const worst = walk.worstScaled;
      const fee = takerFeePerShare(rate, worst);
      const margin =
        parseScaled(context.takerMargin ?? DEFAULT_TAKER_MARGIN) ?? 0n;
      // BUY edge: q_lo - worst; SELL edge: worst - q_lo (selling above value).
      const edge = context.side === "BUY" ? qLo - worst : worst - qLo;
      if (edge > fee + margin) {
        return {
          ok: true,
          value: {
            orderType: "FAK",
            // The limit IS the worst price: the book-walk beyond it leaves
            // the remainder unfilled (FAK semantics, C1).
            limitPrice: fmt(worst),
            postOnly: false,
            worstPrice: fmt(worst),
            ttlS: null,
            expectedTakerDelayMs: TAKER_DELAY_MS,
            policyReason: "TAKER_EDGE_EXCEEDS_FEE",
          },
        };
      }
    }
  }

  // B1 default: passive post-only joining the touch on our own side. The
  // maker fee is zero and the taker fee in crypto is the most expensive leg,
  // so resting is the economic default.
  const join = context.side === "BUY" ? bestBid : bestAsk;
  return {
    ok: true,
    value: {
      orderType: restingType,
      limitPrice: fmt(join),
      postOnly: true,
      worstPrice: null,
      ttlS,
      expectedTakerDelayMs: 0,
      policyReason:
        context.takerFeeRate === null
          ? "DEFAULT_PASSIVE_TAKER_FEE_UNKNOWN"
          : "DEFAULT_PASSIVE_MAKER_FEE_ZERO",
    },
  };
}
