// RFC-010 task 3: the executable microprice — the market prior, the permanent
// baseline and the fallback. It is computed from the RAW RECORDED BOOK only.
// The UI price is never an input: above a $0.10 spread the Polymarket UI shows
// the last trade, which is not an executable quantity.
//
// This library is shared with RFC-011/013, so its formula and its invalidation
// rules are versioned: any change to either bumps MICROPRICE_VERSION.
//
// Definition (MICROPRICE_VERSION 1.0.0), all arithmetic exact fixed-point:
//   bidExec = VWAP of the shares needed to sell S_ref of notional into the bids
//   askExec = VWAP of the shares needed to buy  S_ref of notional from the asks
//   Qb, Qa  = total shares resting on the bid / ask side of the recorded depth
//   microprice = (bidExec*Qa + askExec*Qb) / (Qa + Qb), clamped to
//                [bidExec, askExec]
// The classic imbalance weighting: a heavy bid queue (large Qb) pulls the
// estimate toward the ask, and vice versa.
//
// The baseline is never switchable off: whenever the book is valid, this value
// exists. When it is not valid, NO estimate is emitted — an explicit absence,
// never a stale or defaulted number.

import type { PriceLevel } from "../types.js";
import {
  SCALE,
  div,
  divRound,
  mul,
  maxScaled,
  minScaled,
  parseScaled,
} from "./fixed.js";
import type { BookView, Microprice, MicropriceResult } from "./types.js";

export const MICROPRICE_VERSION = "1.0.0";

/** Reference size: US$ 100 of notional on each side, configurable. */
export const DEFAULT_S_REF_USD = 100;

/** A book view older than this at the decision instant is invalid. */
export const DEFAULT_MAX_BOOK_AGE_MS = 30_000;

/** An executable spread wider than 10c at S_ref invalidates the book. */
export const DEFAULT_MAX_EXEC_SPREAD = 0.1;

/** Depth (in multiples of S_ref) below which the book is flagged thin. */
export const DEFAULT_THIN_BOOK_MULTIPLE = 3;

/**
 * Resting depth beyond this many multiples of S_ref stops adding weight to the
 * imbalance. Without a cap, one large order far from the touch would decide the
 * microprice of every subsequent estimate.
 */
export const DEPTH_CAP_MULTIPLE = 10n;

function microCap(sRefScaled: bigint): bigint {
  return sRefScaled * DEPTH_CAP_MULTIPLE;
}

export interface MicropriceOptions {
  /** Reference notional in USD (default 100). */
  readonly sRefUsd?: number;
  /** Maximum book age at the decision instant (default 30 s). */
  readonly maxBookAgeMs?: number;
  /** Maximum executable spread at S_ref (default 0.10). */
  readonly maxExecSpread?: number;
  /** Depth levels considered; the recorder stores the top 10. */
  readonly depth?: number;
}

interface SideFill {
  /** VWAP paid/received across the consumed levels, scaled. */
  readonly vwapScaled: bigint;
  /** Total notional resting on this side, scaled. */
  readonly notionalScaled: bigint;
  /** Total shares resting on this side, scaled. */
  readonly sharesScaled: bigint;
  /** True when the side could fill the whole reference size. */
  readonly filled: boolean;
}

/**
 * Walk one side of the book accumulating notional until `sRefScaled` is
 * reached, returning the size-weighted average price of exactly that fill.
 * Levels must already be ordered best-first. A malformed level (unparseable
 * price or size) aborts the walk: a partially understood book is not a book.
 */
function fillSide(
  levels: readonly PriceLevel[],
  sRefScaled: bigint,
): SideFill | null {
  let filledNotional = 0n;
  let filledShares = 0n;
  let totalNotional = 0n;
  let totalShares = 0n;
  let filled = false;

  for (const level of levels) {
    const price = parseScaled(level.price);
    const size = parseScaled(level.size);
    if (price === null || size === null || price < 0n || size < 0n) {
      return null;
    }
    const levelNotional = mul(price, size);
    totalNotional += levelNotional;
    totalShares += size;

    if (!filled) {
      const remaining = sRefScaled - filledNotional;
      if (levelNotional >= remaining) {
        // Consume only the fraction of this level that completes S_ref.
        const sharesNeeded = price === 0n ? size : div(remaining, price);
        const takenShares = sharesNeeded > size ? size : sharesNeeded;
        filledShares += takenShares;
        filledNotional += mul(price, takenShares);
        filled = true;
      } else {
        filledShares += size;
        filledNotional += levelNotional;
      }
    }
  }

  if (!filled || filledShares === 0n) {
    return {
      vwapScaled: 0n,
      notionalScaled: totalNotional,
      sharesScaled: totalShares,
      filled: false,
    };
  }

  return {
    vwapScaled: div(filledNotional, filledShares),
    notionalScaled: totalNotional,
    sharesScaled: totalShares,
    filled: true,
  };
}

/**
 * Executable microprice of `book` at `decisionTs`, or the reason the book is
 * not usable. The caller must treat `ok: false` as "no estimate at all", never
 * as a degraded value.
 */
export function computeMicroprice(
  book: BookView,
  decisionTs: Date,
  options: MicropriceOptions = {},
): MicropriceResult {
  const sRefUsd = options.sRefUsd ?? DEFAULT_S_REF_USD;
  const maxBookAgeMs = options.maxBookAgeMs ?? DEFAULT_MAX_BOOK_AGE_MS;
  const maxExecSpread = options.maxExecSpread ?? DEFAULT_MAX_EXEC_SPREAD;
  const depth = options.depth ?? 10;
  const sRefScaled = BigInt(Math.round(sRefUsd * Number(SCALE)));

  const bids = book.bids.slice(0, depth);
  const asks = book.asks.slice(0, depth);
  if (bids.length === 0 || asks.length === 0) {
    return { ok: false, reason: "NO_BOOK" };
  }

  // Staleness is measured against the venue clock when the venue gave us one,
  // and against the local observation clock otherwise (never the other way
  // round: an absent source_ts must not make a stale book look fresh).
  const reference = book.sourceTs ?? book.observedAt;
  const bookAgeMs = decisionTs.getTime() - reference.getTime();
  // A small negative age is venue/host clock skew and is tolerated (the
  // staleness multiplier clamps it to zero). A book stamped further in the
  // future than the whole staleness budget is not skew, it is a corrupt or
  // mis-parsed timestamp, and it must not be priced.
  if (
    !Number.isFinite(bookAgeMs) ||
    bookAgeMs > maxBookAgeMs ||
    bookAgeMs < -maxBookAgeMs
  ) {
    return { ok: false, reason: "BOOK_STALE" };
  }

  const bestBid = parseScaled(bids[0]?.price ?? "");
  const bestAsk = parseScaled(asks[0]?.price ?? "");
  if (bestBid === null || bestAsk === null) {
    return { ok: false, reason: "NO_BOOK" };
  }
  if (bestBid >= bestAsk) {
    // Crossed or locked: the recorded state is not a tradable book.
    return { ok: false, reason: "BOOK_CROSSED" };
  }

  const bidFill = fillSide(bids, sRefScaled);
  const askFill = fillSide(asks, sRefScaled);
  if (bidFill === null || askFill === null) {
    return { ok: false, reason: "NO_BOOK" };
  }
  if (!bidFill.filled || !askFill.filled) {
    return { ok: false, reason: "DEPTH_BELOW_SREF" };
  }

  const execSpreadScaled = askFill.vwapScaled - bidFill.vwapScaled;
  const maxExecSpreadScaled = BigInt(Math.round(maxExecSpread * Number(SCALE)));
  if (execSpreadScaled > maxExecSpreadScaled) {
    return { ok: false, reason: "SPREAD_TOO_WIDE" };
  }

  // Imbalance weights are resting NOTIONAL, bounded to DEPTH_CAP_MULTIPLE x
  // S_ref, not raw share counts. Two failure modes are ruled out by that:
  //   - share counting lets a cheap level far from the touch dominate (5 000
  //     shares at $0.01 is $50 of real depth but would outweigh 100 shares at
  //     $0.50, which is $50 too);
  //   - weighting by the quantities that fill S_ref is degenerate: those
  //     quantities are notional/price, so the weights cancel and the imbalance
  //     signal disappears entirely.
  // The cap keeps a whale resting far from the touch from pinning the estimate
  // to one side while leaving the executable band's own imbalance intact.
  const depthCap = microCap(sRefScaled);
  const bidWeight = minScaled(bidFill.notionalScaled, depthCap);
  const askWeight = minScaled(askFill.notionalScaled, depthCap);
  const totalWeight = bidWeight + askWeight;
  // A heavy resting bid queue pushes the estimate toward the ask, and the
  // reverse: each executable price is weighted by the OPPOSITE side's depth.
  const weighted =
    totalWeight === 0n
      ? divRound(bidFill.vwapScaled + askFill.vwapScaled, 2n)
      : divRound(
          bidFill.vwapScaled * askWeight + askFill.vwapScaled * bidWeight,
          totalWeight,
        );
  const micropriceScaled = minScaled(
    maxScaled(weighted, bidFill.vwapScaled),
    askFill.vwapScaled,
  );

  const value: Microprice = {
    micropriceScaled,
    bidExecScaled: bidFill.vwapScaled,
    askExecScaled: askFill.vwapScaled,
    execSpreadScaled,
    bidNotionalScaled: bidFill.notionalScaled,
    askNotionalScaled: askFill.notionalScaled,
    bookAgeMs,
    sRefScaled,
    version: MICROPRICE_VERSION,
  };
  return { ok: true, value };
}

/**
 * A book is "thin" when either side rests less than `multiple` x S_ref of
 * notional. Thin books are still valid — q is a pure probability — but the
 * consumer must know that the executable price diverges from the mid.
 */
export function isThinBook(
  microprice: Microprice,
  multiple = DEFAULT_THIN_BOOK_MULTIPLE,
): boolean {
  const threshold = microprice.sRefScaled * BigInt(multiple);
  return (
    microprice.bidNotionalScaled < threshold ||
    microprice.askNotionalScaled < threshold
  );
}
