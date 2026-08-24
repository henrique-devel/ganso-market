// RFC-011 Part B6: the local order validator — the precondition of ANY paper
// order. It replicates the venue's official rounding sequence and per-tick
// precisions, enforces min_order_size and tick alignment, and refuses any
// order without an explicit limit price (there is no market order in the
// paper broker, and FAK/FOK additionally require worst_price). An order that
// fails here never reaches the ledger.
//
// Arithmetic is exact: prices and sizes parse into BigInt at 9 fraction
// digits; the USD amount is computed at 18 fraction digits so the official
// "round up at amount+4 digits, then down at amount digits" sequence never
// loses a digit to intermediate rounding.

import { SCALE, formatScaled, parseScaled } from "../fundamental/fixed.js";

export type OrderSide = "BUY" | "SELL";
export type OrderType = "GTC" | "GTD" | "FAK" | "FOK";

/** GTD semantics (B2): the venue expires 1 minute BEFORE the declared time. */
export const GTD_EXPIRY_BUFFER_S = 60;
/** GTD declared expiration must be at least this far in the future. */
export const GTD_MIN_FUTURE_S = 180;

/**
 * Official per-tick precisions: decimal digits allowed for the price, the
 * share size and the USD amount, keyed by the market's tick_size.
 */
export const TICK_PRECISIONS: ReadonlyMap<
  string,
  { readonly price: number; readonly size: number; readonly amount: number }
> = new Map([
  ["0.1", { price: 1, size: 2, amount: 3 }],
  ["0.01", { price: 2, size: 2, amount: 4 }],
  ["0.005", { price: 3, size: 2, amount: 5 }],
  ["0.0025", { price: 4, size: 2, amount: 6 }],
  ["0.001", { price: 3, size: 2, amount: 5 }],
  ["0.0001", { price: 4, size: 2, amount: 6 }],
]);

export interface OrderDraft {
  readonly tokenId: string;
  readonly side: OrderSide;
  readonly orderType: OrderType;
  /** Mandatory for every order type; the API answers 422 without it. */
  readonly limitPrice: string;
  readonly size: string;
  /** post-only flag; defaults to true for GTC/GTD (B1). */
  readonly postOnly?: boolean;
  /** Mandatory for FAK/FOK (B3); forbidden semantics without it. */
  readonly worstPrice?: string | null;
  /** GTD useful life in seconds (B2). */
  readonly ttlS?: number | null;
}

export interface MarketOrderParams {
  readonly tickSize: string;
  readonly minOrderSize: string;
  readonly negRisk: boolean;
}

export interface NormalizedOrder {
  readonly tokenId: string;
  readonly side: OrderSide;
  readonly orderType: OrderType;
  /** Rounded DOWN to the tick's price digits, aligned to the tick grid. */
  readonly limitPrice: string;
  /** Rounded DOWN to the tick's size digits. */
  readonly size: string;
  /** price x size, rounded UP at amount+4 digits then DOWN at amount digits. */
  readonly amountUsd: string;
  readonly postOnly: boolean;
  readonly worstPrice: string | null;
  /**
   * GTD only: declared expiration in Unix SECONDS (the venue struct uses ms
   * timestamps but the expiration field is seconds), already carrying the
   * +60 s venue buffer: for a useful life of N s this is now + 60 + N.
   */
  readonly expirationS: number | null;
}

export type ValidationResult =
  | { readonly ok: true; readonly value: NormalizedOrder }
  | { readonly ok: false; readonly reason: ValidationReason };

export type ValidationReason =
  | "MISSING_LIMIT_PRICE"
  | "MISSING_WORST_PRICE"
  | "INVALID_PRICE"
  | "PRICE_OUT_OF_RANGE"
  | "TICK_MISALIGNED"
  | "INVALID_SIZE"
  | "SIZE_BELOW_MIN"
  | "INVALID_WORST_PRICE"
  | "WORST_PRICE_INCOHERENT"
  | "INVALID_TTL"
  | "UNKNOWN_TICK_SIZE"
  | "INVALID_MIN_ORDER_SIZE";

// ---------------------------------------------------------------------------
// 18-digit fixed point (product of two 9-digit values), used only for the
// USD amount so the official +4-digit rounding never truncates early.
const SCALE18_DIGITS = 18;

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/** Round a scaled value DOWN to `digits` fraction digits (non-negative input). */
function floorToDigits(
  value: bigint,
  scaleDigits: number,
  digits: number,
): bigint {
  const unit = pow10(scaleDigits - digits);
  return (value / unit) * unit;
}

/** Round a scaled value UP to `digits` fraction digits (non-negative input). */
function ceilToDigits(
  value: bigint,
  scaleDigits: number,
  digits: number,
): bigint {
  const unit = pow10(scaleDigits - digits);
  const remainder = value % unit;
  return remainder === 0n ? value : (value / unit + 1n) * unit;
}

function format18(value: bigint, digits: number): string {
  const whole = value / pow10(SCALE18_DIGITS);
  const fraction = (value % pow10(SCALE18_DIGITS))
    .toString()
    .padStart(SCALE18_DIGITS, "0")
    .slice(0, digits);
  return digits === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/**
 * The official amount sequence on the ROUNDED price and size: compute the raw
 * product exactly, round UP at (amount digits + 4), then DOWN at amount
 * digits. Exposed for the byte-for-byte fixture tests.
 */
export function officialAmountUsd(
  priceScaled: bigint,
  sizeScaled: bigint,
  amountDigits: number,
): string {
  // Product of two 9-digit-scaled values is exact at 18 fraction digits.
  const product18 = priceScaled * sizeScaled;
  const up = ceilToDigits(product18, SCALE18_DIGITS, amountDigits + 4);
  const down = floorToDigits(up, SCALE18_DIGITS, amountDigits);
  return format18(down, amountDigits);
}

/**
 * Validate one order draft against the market's tick/min-size parameters at
 * the decision instant. `nowMs` anchors the GTD expiration math.
 */
export function validateOrder(
  draft: OrderDraft,
  params: MarketOrderParams,
  nowMs: number,
): ValidationResult {
  const precision = TICK_PRECISIONS.get(params.tickSize);
  if (precision === undefined) {
    return { ok: false, reason: "UNKNOWN_TICK_SIZE" };
  }
  const tickScaled = parseScaled(params.tickSize);
  if (tickScaled === null || tickScaled <= 0n) {
    return { ok: false, reason: "UNKNOWN_TICK_SIZE" };
  }

  // No order — paper included — without an explicit price limit.
  if (typeof draft.limitPrice !== "string" || draft.limitPrice.length === 0) {
    return { ok: false, reason: "MISSING_LIMIT_PRICE" };
  }
  const rawPrice = parseScaled(draft.limitPrice);
  if (rawPrice === null || rawPrice <= 0n) {
    return { ok: false, reason: "INVALID_PRICE" };
  }
  // Official sequence step 1: price rounds DOWN to the tick's price digits.
  const price = floorToDigits(rawPrice, 9, precision.price);
  // Prices live strictly inside (0, 1): the venue clamps to [tick, 1 - tick].
  if (price < tickScaled || price > SCALE - tickScaled) {
    return { ok: false, reason: "PRICE_OUT_OF_RANGE" };
  }
  if (price % tickScaled !== 0n) {
    return { ok: false, reason: "TICK_MISALIGNED" };
  }

  const rawSize = parseScaled(draft.size);
  if (rawSize === null || rawSize <= 0n) {
    return { ok: false, reason: "INVALID_SIZE" };
  }
  // Official sequence step 2: shares round DOWN to the tick's size digits.
  const size = floorToDigits(rawSize, 9, precision.size);
  if (size <= 0n) {
    return { ok: false, reason: "INVALID_SIZE" };
  }
  const minSize = parseScaled(params.minOrderSize);
  if (minSize === null || minSize < 0n) {
    return { ok: false, reason: "INVALID_MIN_ORDER_SIZE" };
  }
  if (size < minSize) {
    return { ok: false, reason: "SIZE_BELOW_MIN" };
  }

  // FAK/FOK are the only marketable types and demand an explicit worst price.
  let worstPrice: string | null = null;
  const marketable = draft.orderType === "FAK" || draft.orderType === "FOK";
  if (marketable) {
    if (
      draft.worstPrice === undefined ||
      draft.worstPrice === null ||
      draft.worstPrice.length === 0
    ) {
      return { ok: false, reason: "MISSING_WORST_PRICE" };
    }
    const rawWorst = parseScaled(draft.worstPrice);
    if (rawWorst === null || rawWorst <= 0n || rawWorst >= SCALE) {
      return { ok: false, reason: "INVALID_WORST_PRICE" };
    }
    const worst = floorToDigits(rawWorst, 9, precision.price);
    // The worst price bounds the walk AWAY from the limit: a BUY may fill up
    // to worst >= limit, a SELL down to worst <= limit.
    const coherent = draft.side === "BUY" ? worst >= price : worst <= price;
    if (!coherent) {
      return { ok: false, reason: "WORST_PRICE_INCOHERENT" };
    }
    worstPrice = formatScaled(worst, precision.price);
  }

  // GTD (B2): declared expiration = now + 60 + N seconds, never under 3
  // minutes in the future — replicating the venue's early-expiry buffer.
  let expirationS: number | null = null;
  if (draft.orderType === "GTD") {
    const ttl = draft.ttlS;
    if (
      ttl === undefined ||
      ttl === null ||
      !Number.isInteger(ttl) ||
      ttl <= 0
    ) {
      return { ok: false, reason: "INVALID_TTL" };
    }
    const nowS = Math.floor(nowMs / 1_000);
    expirationS = nowS + GTD_EXPIRY_BUFFER_S + ttl;
    if (expirationS < nowS + GTD_MIN_FUTURE_S) {
      // A declared expiration under 3 minutes away is refused by the venue;
      // the buffer plus a >= 120 s ttl clears it, anything shorter fails.
      return { ok: false, reason: "INVALID_TTL" };
    }
  }

  return {
    ok: true,
    value: {
      tokenId: draft.tokenId,
      side: draft.side,
      orderType: draft.orderType,
      limitPrice: formatScaled(price, precision.price),
      size: formatScaled(size, precision.size),
      amountUsd: officialAmountUsd(price, size, precision.amount),
      postOnly: marketable ? false : (draft.postOnly ?? true),
      worstPrice,
      expirationS,
    },
  };
}
