// RFC-011 Part A: microstructure features as pure functions. Everything here
// is computed from values the caller already loaded with an explicit upper
// time bound (featurestore.ts); no function reads a clock or the database, so
// the same inputs always produce the same bytes — the look-ahead property is
// tested by recomputing with later data appended and asserting equality.
//
// Price/size math is exact fixed-point (shared fixed.ts, the same library the
// executable microprice uses). Volatility uses IEEE doubles internally — the
// same documented exception the fundamental model makes — and quantizes back
// to a canonical decimal string on the way out.

import type { PriceLevel } from "../types.js";
import {
  SCALE,
  div,
  divRound,
  formatScaled,
  mul,
  parseScaled,
  scaledToNumber,
} from "../fundamental/fixed.js";
import { computeMicroprice, isThinBook } from "../fundamental/microprice.js";
import type { BookView } from "../fundamental/types.js";

export const FEATURES_VERSION = "1.0.0";

/** Executable-depth distances, in ticks from the touch (RFC-011 A2). */
export const DEPTH_TICKS = [1, 2, 5, 10] as const;

/** A mid move larger than this many ticks between snapshots is a jump (A6). */
export const JUMP_TICKS = 2n;

/** Output precision for feature decimal strings. */
const OUT_DIGITS = 6;

export type WindowKind = "1s" | "10s" | "1m";

export const WINDOW_MS: Readonly<Record<WindowKind, number>> = {
  "1s": 1_000,
  "10s": 10_000,
  "1m": 60_000,
};

export interface FeatureBook {
  readonly tokenId: string;
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
  readonly sourceTs: Date | null;
  readonly observedAt: Date;
}

export interface WindowTrade {
  readonly price: string;
  readonly size: string | null;
}

export interface DeltaStats {
  readonly cancelEvents: number;
  readonly updateEvents: number;
  readonly levelsTouched: number;
}

export interface FeatureInputs {
  readonly windowStart: Date;
  /** The decision instant: no input may postdate it. */
  readonly windowEnd: Date;
  /** Latest recorded top-10 book received at or before windowEnd. */
  readonly book: FeatureBook | null;
  /** Tick size in force at windowEnd (param versions as-of). */
  readonly tickSize: string | null;
  /** Trades with effective ts inside [windowStart, windowEnd). */
  readonly trades: readonly WindowTrade[];
  /** Effective ts of the newest trade at or before windowEnd (any age). */
  readonly lastTradeTs: Date | null;
  /** L2 delta counts inside the window. */
  readonly deltaStats: DeltaStats;
  /** 1-minute mid closes of buckets ENTIRELY before windowEnd, oldest first. */
  readonly midCloses1m: readonly string[];
  /** Mids of the snapshots inside the window, in time order (for jumps). */
  readonly snapshotMids: readonly string[];
  /** Next known macro catalyst strictly after windowEnd. */
  readonly nextCatalystAt: Date | null;
  /** Rule end dates in force at windowEnd. */
  readonly endDateAt: Date | null;
  readonly umaEndDateAt: Date | null;
}

export interface FeatureRow {
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly sourceTs: Date | null;
  readonly bookValid: boolean;
  readonly bookInvalidReason: string | null;
  readonly bestBid: string | null;
  readonly bestAsk: string | null;
  readonly mid: string | null;
  readonly spreadQuoted: string | null;
  readonly halfSpreadBps: string | null;
  readonly execSpreadSref: string | null;
  readonly microprice: string | null;
  readonly thinBook: boolean | null;
  readonly bidDepthTop1: string | null;
  readonly askDepthTop1: string | null;
  readonly bidDepthTop10: string | null;
  readonly askDepthTop10: string | null;
  readonly topFracBid: string | null;
  readonly topFracAsk: string | null;
  readonly depthTicks: Record<string, { bid: string; ask: string }> | null;
  readonly imbalanceTop1: string | null;
  readonly imbalanceTop10: string | null;
  readonly tradesCount: number;
  readonly volumeUnsigned: string | null;
  /** Always null until the onchain OrderFilled reconciliation exists. */
  readonly volumeSigned: null;
  readonly flowDirectionStatus: "UNAVAILABLE";
  readonly cancelEvents: number;
  readonly updateEvents: number;
  readonly levelsTouched: number;
  readonly vol1m: string | null;
  readonly vol5m: string | null;
  readonly vol30m: string | null;
  readonly jumpCount: number;
  readonly lastTradeAgeMs: number | null;
  readonly bookStalenessMs: number | null;
  readonly minsToCatalyst: number | null;
  readonly minsToEndDate: number | null;
  readonly minsToUmaEnd: number | null;
}

function fmt(scaled: bigint): string {
  return formatScaled(scaled, OUT_DIGITS);
}

function sumSizes(levels: readonly PriceLevel[], count: number): bigint | null {
  let total = 0n;
  for (const level of levels.slice(0, count)) {
    const size = parseScaled(level.size);
    if (size === null || size < 0n) {
      return null;
    }
    total += size;
  }
  return total;
}

/** Cumulative size resting within `ticks` ticks of the side's best price. */
function depthWithinTicks(
  levels: readonly PriceLevel[],
  side: "bid" | "ask",
  tickScaled: bigint,
  ticks: number,
): bigint | null {
  const best = parseScaled(levels[0]?.price ?? "");
  if (best === null) {
    return null;
  }
  const band = tickScaled * BigInt(ticks);
  let total = 0n;
  for (const level of levels) {
    const price = parseScaled(level.price);
    const size = parseScaled(level.size);
    if (price === null || size === null) {
      return null;
    }
    const distance = side === "bid" ? best - price : price - best;
    if (distance < 0n || distance > band) {
      continue;
    }
    total += size;
  }
  return total;
}

/** (a − b) / (a + b), or null when both are zero. */
function ratioImbalance(a: bigint, b: bigint): string | null {
  const total = a + b;
  if (total === 0n) {
    return null;
  }
  return fmt(div(a - b, total));
}

interface BookFeatures {
  readonly bookValid: boolean;
  readonly bookInvalidReason: string | null;
  readonly bestBid: string | null;
  readonly bestAsk: string | null;
  readonly mid: string | null;
  readonly spreadQuoted: string | null;
  readonly halfSpreadBps: string | null;
  readonly execSpreadSref: string | null;
  readonly microprice: string | null;
  readonly thinBook: boolean | null;
  readonly bidDepthTop1: string | null;
  readonly askDepthTop1: string | null;
  readonly bidDepthTop10: string | null;
  readonly askDepthTop10: string | null;
  readonly topFracBid: string | null;
  readonly topFracAsk: string | null;
  readonly depthTicks: Record<string, { bid: string; ask: string }> | null;
  readonly imbalanceTop1: string | null;
  readonly imbalanceTop10: string | null;
}

const EMPTY_BOOK_FEATURES: BookFeatures = {
  bookValid: false,
  bookInvalidReason: "NO_BOOK",
  bestBid: null,
  bestAsk: null,
  mid: null,
  spreadQuoted: null,
  halfSpreadBps: null,
  execSpreadSref: null,
  microprice: null,
  thinBook: null,
  bidDepthTop1: null,
  askDepthTop1: null,
  bidDepthTop10: null,
  askDepthTop10: null,
  topFracBid: null,
  topFracAsk: null,
  depthTicks: null,
  imbalanceTop1: null,
  imbalanceTop10: null,
};

/** A1–A3: spread, depth and imbalance from the book state at windowEnd. */
export function computeBookFeatures(
  book: FeatureBook | null,
  tickSize: string | null,
  windowEnd: Date,
): BookFeatures {
  if (book === null || book.bids.length === 0 || book.asks.length === 0) {
    return EMPTY_BOOK_FEATURES;
  }

  const bestBid = parseScaled(book.bids[0]?.price ?? "");
  const bestAsk = parseScaled(book.asks[0]?.price ?? "");
  const bidTop1 = sumSizes(book.bids, 1);
  const askTop1 = sumSizes(book.asks, 1);
  const bidTop10 = sumSizes(book.bids, 10);
  const askTop10 = sumSizes(book.asks, 10);
  if (
    bestBid === null ||
    bestAsk === null ||
    bidTop1 === null ||
    askTop1 === null ||
    bidTop10 === null ||
    askTop10 === null
  ) {
    return EMPTY_BOOK_FEATURES;
  }

  // The executable microprice carries the validity verdict (stale, crossed,
  // thin, too wide); quoted-level features are still published when the book
  // is readable but not executable, with book_valid=false telling the consumer
  // which regime it is looking at.
  const view: BookView = {
    tokenId: book.tokenId,
    bids: book.bids,
    asks: book.asks,
    sourceTs: book.sourceTs,
    observedAt: book.observedAt,
  };
  const micro = computeMicroprice(view, windowEnd);

  const spread = bestAsk - bestBid;
  const mid = divRound(bestBid + bestAsk, 2n);
  // half-spread in basis points of the mid: (spread/2) / mid * 10_000.
  const halfSpreadBps =
    mid === 0n
      ? null
      : fmt(mul(div(divRound(spread, 2n), mid), 10_000n * SCALE));

  const tickScaled = tickSize === null ? null : parseScaled(tickSize);
  let depthTicks: Record<string, { bid: string; ask: string }> | null = null;
  if (tickScaled !== null && tickScaled > 0n) {
    depthTicks = {};
    for (const k of DEPTH_TICKS) {
      const bid = depthWithinTicks(book.bids, "bid", tickScaled, k);
      const ask = depthWithinTicks(book.asks, "ask", tickScaled, k);
      if (bid === null || ask === null) {
        depthTicks = null;
        break;
      }
      depthTicks[String(k)] = { bid: fmt(bid), ask: fmt(ask) };
    }
  }

  return {
    bookValid: micro.ok,
    bookInvalidReason: micro.ok ? null : micro.reason,
    bestBid: fmt(bestBid),
    bestAsk: fmt(bestAsk),
    mid: fmt(mid),
    spreadQuoted: fmt(spread),
    halfSpreadBps,
    execSpreadSref: micro.ok ? fmt(micro.value.execSpreadScaled) : null,
    microprice: micro.ok ? fmt(micro.value.micropriceScaled) : null,
    thinBook: micro.ok ? isThinBook(micro.value) : null,
    bidDepthTop1: fmt(bidTop1),
    askDepthTop1: fmt(askTop1),
    bidDepthTop10: fmt(bidTop10),
    askDepthTop10: fmt(askTop10),
    topFracBid: bidTop10 === 0n ? null : fmt(div(bidTop1, bidTop10)),
    topFracAsk: askTop10 === 0n ? null : fmt(div(askTop1, askTop10)),
    depthTicks,
    imbalanceTop1: ratioImbalance(bidTop1, askTop1),
    imbalanceTop10: ratioImbalance(bidTop10, askTop10),
  };
}

/**
 * A4: aggressor flow. The WS direction field is a FORBIDDEN source (it agrees
 * with the real onchain aggressor only ~59% of the time), so until the
 * OrderFilled reconciliation pipeline exists this publishes unsigned volume
 * only, with the direction explicitly UNAVAILABLE — never silently degraded.
 */
export function computeFlowFeatures(trades: readonly WindowTrade[]): {
  tradesCount: number;
  volumeUnsigned: string | null;
  volumeSigned: null;
  flowDirectionStatus: "UNAVAILABLE";
} {
  let volume = 0n;
  let sized = 0;
  for (const trade of trades) {
    if (trade.size === null) {
      continue;
    }
    const size = parseScaled(trade.size);
    if (size === null || size < 0n) {
      continue;
    }
    volume += size;
    sized += 1;
  }
  return {
    tradesCount: trades.length,
    volumeUnsigned: sized === 0 ? null : fmt(volume),
    volumeSigned: null,
    flowDirectionStatus: "UNAVAILABLE",
  };
}

/**
 * A6: realized volatility of the mid over the trailing `lookbackMinutes`,
 * from fully-past 1-minute closes: sqrt of the sum of squared 1-minute log
 * returns, annualization deliberately omitted (windows are compared to each
 * other, not to other assets). Needs at least two closes in the lookback.
 */
export function realizedVol(
  midCloses: readonly string[],
  lookbackMinutes: number,
): string | null {
  const closes = midCloses.slice(-Math.max(lookbackMinutes + 1, 2));
  const values: number[] = [];
  for (const close of closes) {
    const scaled = parseScaled(close);
    if (scaled === null || scaled <= 0n) {
      continue;
    }
    values.push(scaledToNumber(scaled));
  }
  const window = values.slice(-(lookbackMinutes + 1));
  if (window.length < 2) {
    return null;
  }
  let sumSquares = 0;
  for (let i = 1; i < window.length; i += 1) {
    const prev = window[i - 1];
    const curr = window[i];
    if (prev === undefined || curr === undefined || prev <= 0 || curr <= 0) {
      return null;
    }
    const r = Math.log(curr / prev);
    sumSquares += r * r;
  }
  const vol = Math.sqrt(sumSquares);
  if (!Number.isFinite(vol)) {
    return null;
  }
  return fmt(BigInt(Math.round(vol * Number(SCALE))));
}

/** A6: mid moves larger than JUMP_TICKS between consecutive snapshots. */
export function countJumps(
  snapshotMids: readonly string[],
  tickSize: string | null,
): number {
  const tickScaled = tickSize === null ? null : parseScaled(tickSize);
  if (tickScaled === null || tickScaled <= 0n) {
    return 0;
  }
  const threshold = tickScaled * JUMP_TICKS;
  let jumps = 0;
  let previous: bigint | null = null;
  for (const mid of snapshotMids) {
    const scaled = parseScaled(mid);
    if (scaled === null) {
      continue;
    }
    if (previous !== null) {
      const move = scaled > previous ? scaled - previous : previous - scaled;
      if (move > threshold) {
        jumps += 1;
      }
    }
    previous = scaled;
  }
  return jumps;
}

function minutesUntil(at: Date | null, windowEnd: Date): number | null {
  if (at === null) {
    return null;
  }
  return Math.floor((at.getTime() - windowEnd.getTime()) / 60_000);
}

/** The whole Part A row for one window, from bounded inputs only. */
export function computeFeatureRow(inputs: FeatureInputs): FeatureRow {
  const bookFeatures = computeBookFeatures(
    inputs.book,
    inputs.tickSize,
    inputs.windowEnd,
  );
  const flow = computeFlowFeatures(inputs.trades);

  const end = inputs.windowEnd.getTime();
  const bookReference =
    inputs.book === null
      ? null
      : (inputs.book.sourceTs ?? inputs.book.observedAt);

  return {
    windowStart: inputs.windowStart,
    windowEnd: inputs.windowEnd,
    sourceTs: inputs.book?.sourceTs ?? null,
    ...bookFeatures,
    ...flow,
    cancelEvents: inputs.deltaStats.cancelEvents,
    updateEvents: inputs.deltaStats.updateEvents,
    levelsTouched: inputs.deltaStats.levelsTouched,
    vol1m: realizedVol(inputs.midCloses1m, 1),
    vol5m: realizedVol(inputs.midCloses1m, 5),
    vol30m: realizedVol(inputs.midCloses1m, 30),
    jumpCount: countJumps(inputs.snapshotMids, inputs.tickSize),
    lastTradeAgeMs:
      inputs.lastTradeTs === null
        ? null
        : Math.max(0, end - inputs.lastTradeTs.getTime()),
    bookStalenessMs:
      bookReference === null
        ? null
        : Math.max(0, end - bookReference.getTime()),
    minsToCatalyst: minutesUntil(inputs.nextCatalystAt, inputs.windowEnd),
    minsToEndDate: minutesUntil(inputs.endDateAt, inputs.windowEnd),
    minsToUmaEnd: minutesUntil(inputs.umaEndDateAt, inputs.windowEnd),
  };
}

/**
 * Cadence gate, mirroring the owner's per-horizon estimator cadence: fine
 * windows only where a decision can actually happen. Tokens with no known end
 * date get the coarse cadence.
 */
export function windowKindsForHorizon(msToEnd: number | null): WindowKind[] {
  if (msToEnd !== null && msToEnd <= 60 * 60_000) {
    return ["1s", "10s", "1m"];
  }
  if (msToEnd !== null && msToEnd <= 6 * 60 * 60_000) {
    return ["10s", "1m"];
  }
  return ["1m"];
}
