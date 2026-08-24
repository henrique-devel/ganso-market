// RFC-011 Part C: the pessimistic execution engine as pure functions. In any
// ambiguity — queue position, latency, partial fill, fee — the outcome is the
// WORST one for the bot: passive orders join behind all visible depth, cancels
// ahead never improve the queue, taker orders execute against the book of
// t + latency (+250 ms for marketable), and a deterministic 30% of passive
// fills are denied outright (the base-conservative column of the report).
// Optimistic fills exist only as diagnostic denial events, never as state.

import type { PriceLevel } from "../types.js";
import {
  SCALE,
  div,
  formatScaled,
  mul,
  parseScaled,
} from "../fundamental/fixed.js";
import { takerFeePerShare } from "./policy.js";
import type { OrderSide } from "./validator.js";

/** Conservative default simulated latency until a measured distribution exists. */
export const DEFAULT_LATENCY_MS = 1_000;

/** Marketable orders in crypto/finance match only after this delay (B5/C1). */
export const TAKER_DELAY_MS = 250;

/** Fraction (percent) of passive fills deterministically denied (C6). */
export const FILL_DEGRADATION_PERCENT = 30;

/** Stress haircut applied per taker fill in the report's base column (C6). */
export const STRESS_SLIPPAGE_TICKS = 1n;

export interface BookSliceLevel {
  readonly price: string;
  readonly size: string;
}

export interface TakerFill {
  readonly price: string;
  readonly size: string;
  readonly feeUsd: string;
}

export interface TakerExecution {
  readonly fills: readonly TakerFill[];
  readonly filledSize: string;
  /** The exact levels consumed — persisted inside the fill event so the
   * ledger replay outlives the book_deltas TTL. */
  readonly consumedSlice: readonly BookSliceLevel[];
  /** FOK only: true when the whole size could not fill within worst_price. */
  readonly killed: boolean;
}

/**
 * C1 book-walk: execute `size` against the opposing side recorded at
 * t_decision + latency (+ taker delay), consuming levels best-first, never
 * beyond `worstPrice`. FAK leaves the remainder unfilled; FOK kills the whole
 * order when the size cannot fill inside the worst price.
 */
export function executeTaker(
  side: OrderSide,
  sizeStr: string,
  worstPriceStr: string,
  opposingLevels: readonly PriceLevel[],
  takerFeeRate: string | null,
  fillOrKill: boolean,
): TakerExecution | null {
  const size = parseScaled(sizeStr);
  const worst = parseScaled(worstPriceStr);
  const rate = takerFeeRate === null ? 0n : (parseScaled(takerFeeRate) ?? 0n);
  if (size === null || size <= 0n || worst === null || worst <= 0n) {
    return null;
  }
  let remaining = size;
  const fills: TakerFill[] = [];
  const consumed: BookSliceLevel[] = [];
  for (const level of opposingLevels) {
    if (remaining <= 0n) {
      break;
    }
    const price = parseScaled(level.price);
    const levelSize = parseScaled(level.size);
    if (price === null || levelSize === null || price <= 0n) {
      return null;
    }
    // Beyond the worst price the walk stops: FAK leaves the rest unfilled.
    const beyond = side === "BUY" ? price > worst : price < worst;
    if (beyond) {
      break;
    }
    const take = levelSize < remaining ? levelSize : remaining;
    if (take <= 0n) {
      continue;
    }
    const fee = mul(takerFeePerShare(rate, price), take);
    fills.push({
      price: formatScaled(price, 6),
      size: formatScaled(take, 6),
      feeUsd: formatScaled(fee, 6),
    });
    consumed.push({
      price: formatScaled(price, 6),
      size: formatScaled(take, 6),
    });
    remaining -= take;
  }
  const filled = size - remaining;
  if (fillOrKill && remaining > 0n) {
    // FOK: all or nothing — the whole order dies, nothing is consumed.
    return {
      fills: [],
      filledSize: "0.000000",
      consumedSlice: [],
      killed: true,
    };
  }
  return {
    fills,
    filledSize: formatScaled(filled, 6),
    consumedSlice: consumed,
    killed: false,
  };
}

/**
 * C2 conservative passive queue. The order joins BEHIND all visible depth at
 * its level; only observed traded volume at the level moves the queue, and
 * cancels ahead never help. Given the cumulative traded volume since accept,
 * the filled quantity is a pure function — recomputable and idempotent.
 */
export function passiveFilledFromVolume(
  queueAheadStr: string,
  orderSizeStr: string,
  cumulativeVolumeStr: string,
): string {
  const queue = parseScaled(queueAheadStr) ?? 0n;
  const size = parseScaled(orderSizeStr) ?? 0n;
  const volume = parseScaled(cumulativeVolumeStr) ?? 0n;
  const beyondQueue = volume - queue;
  if (beyondQueue <= 0n) {
    return "0.000000";
  }
  const filled = beyondQueue < size ? beyondQueue : size;
  return formatScaled(filled, 6);
}

/**
 * C6 deterministic fill degradation: a stable hash of order id and fill
 * sequence denies FILL_DEGRADATION_PERCENT of passive fills. Deterministic so
 * the ledger replay reproduces the same denials bit for bit.
 */
export function isFillDegraded(orderId: string, fillSeq: string): boolean {
  const key = `${orderId}:${fillSeq}`;
  let hash = 5381;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 33 + key.charCodeAt(i)) >>> 0;
  }
  return hash % 100 < FILL_DEGRADATION_PERCENT;
}

/** Maker fee is zero on Polymarket V2; passive fills only pay if that changes. */
export function makerFeeUsd(): string {
  return "0.000000";
}

export interface ResolutionOutcome {
  /** "1", "0" or "0.5" per share. */
  readonly outcomePrice: string;
}

/**
 * C5 trinary resolution. outcomePrices arrives as an array aligned with the
 * market's clobTokenIds; 0.5 pays US$ 0.50 per share — except in negRisk
 * markets, where a 50/50 outcome is structurally impossible (the
 * NegRiskAdapter reverts [1,1]) and MUST be treated as a data error.
 */
export function resolveOutcomeForToken(
  tokenId: string,
  clobTokenIds: readonly string[],
  outcomePrices: readonly string[],
  negRisk: boolean,
): { ok: true; value: ResolutionOutcome } | { ok: false; reason: string } {
  const index = clobTokenIds.indexOf(tokenId);
  if (index === -1 || index >= outcomePrices.length) {
    return { ok: false, reason: "TOKEN_NOT_IN_MARKET" };
  }
  const raw = outcomePrices[index];
  const parsed = raw === undefined ? null : parseScaled(raw);
  if (parsed === null) {
    return { ok: false, reason: "UNPARSEABLE_OUTCOME" };
  }
  const half = SCALE / 2n;
  if (parsed !== 0n && parsed !== SCALE && parsed !== half) {
    return { ok: false, reason: "OUTCOME_NOT_TRINARY" };
  }
  if (parsed === half && negRisk) {
    // Never a silent liquidation: a 50/50 in negRisk is corrupt data.
    return { ok: false, reason: "NEGRISK_HALF_OUTCOME" };
  }
  return {
    ok: true,
    value: { outcomePrice: formatScaled(parsed, 6) },
  };
}

/**
 * D2 mark to executable bid: the proceeds of walking the EXIT side with the
 * WHOLE position size (bids for a long, asks for a short — the cost to buy
 * back). Insufficient depth or an empty side yields null: the caller freezes
 * the previous value under STALE_MARK semantics rather than inventing one.
 */
export function markToExecutable(
  sharesStr: string,
  exitLevels: readonly PriceLevel[],
): string | null {
  const shares = parseScaled(sharesStr);
  if (shares === null || shares === 0n) {
    return null;
  }
  let remaining = shares < 0n ? -shares : shares;
  let proceeds = 0n;
  for (const level of exitLevels) {
    if (remaining <= 0n) {
      break;
    }
    const price = parseScaled(level.price);
    const size = parseScaled(level.size);
    if (price === null || size === null) {
      return null;
    }
    const take = size < remaining ? size : remaining;
    proceeds += mul(price, take);
    remaining -= take;
  }
  if (remaining > 0n) {
    // The visible book cannot absorb the position: no executable mark.
    return null;
  }
  return formatScaled(proceeds, 6);
}

/** VWAP helper for report columns. */
export function vwapOfFills(fills: readonly TakerFill[]): string | null {
  let notional = 0n;
  let shares = 0n;
  for (const fill of fills) {
    const price = parseScaled(fill.price);
    const size = parseScaled(fill.size);
    if (price === null || size === null) {
      return null;
    }
    notional += mul(price, size);
    shares += size;
  }
  if (shares === 0n) {
    return null;
  }
  return formatScaled(div(notional, shares), 6);
}
