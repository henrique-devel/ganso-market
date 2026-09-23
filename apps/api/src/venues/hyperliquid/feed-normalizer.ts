import { createHash } from "node:crypto";
import {
  parseTradingAmount,
  TRADING_DECIMALS,
  type TradingUnit,
  type TradingAmount,
  type TradingBookLevel,
  type TradingMarketObservation,
} from "@ganso-market/contracts/trading";
import { canonicalFingerprint } from "../../trading/replay.js";
import type { FeedChannel } from "../../trading/feed.js";

/** Official contracts reviewed 2026-09-23; SDK 0.33.3 types are not validators.
 * https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions
 * https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding
 * l2Book = full top-20 snapshots; trades have no sequence or replay-complete flag;
 * activeAssetCtx = current mark/funding observation WITHOUT a venue timestamp.
 */
export const HYPERLIQUID_FEED_LIMITS = Object.freeze({
  maxPayloadBytes: 262_144,
  maxTradesPerFrame: 512,
  maxBookLevels: 20,
  maxDecimalPlaces: 18,
  maxRetries: 3,
  handshakeMs: 8000,
  heartbeatMs: 5000,
  pongTimeoutMs: 10_000,
  outboundBytes: 4096,
});
export const WIRE_CHANNELS = {
  l2Book: "book",
  trades: "trades",
  activeAssetCtx: "context",
} as const;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid feed object");
  return value as Record<string, unknown>;
}
function integer(value: unknown, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    throw new TypeError("Invalid feed integer");
  return value;
}
function decimal(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 48 ||
    !/^-?\d+(?:\.\d+)?$/.test(value)
  )
    throw new TypeError("Invalid feed decimal");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > HYPERLIQUID_FEED_LIMITS.maxDecimalPlaces)
    throw new TypeError("Feed decimal precision exceeds limit");
  return {
    raw: BigInt(`${whole}${fraction}`).toString(),
    decimals: fraction.length,
  };
}
function amount<U extends TradingUnit>(
  unit: U,
  value: unknown,
): TradingAmount<U> {
  const exact = decimal(value);
  const target = TRADING_DECIMALS[unit];
  const divisor = 10n ** BigInt(Math.max(0, exact.decimals - target));
  const raw = BigInt(exact.raw);
  if (raw <= 0n || raw % divisor !== 0n)
    throw new TypeError("Inexact or non-positive feed amount");
  return parseTradingAmount(unit, {
    unit,
    decimals: target,
    raw: (
      (raw / divisor) *
      10n ** BigInt(Math.max(0, target - exact.decimals))
    ).toString(),
  });
}
function time(value: unknown): string {
  return new Date(integer(value, 1)).toISOString();
}
function btc(value: unknown) {
  const data = record(value);
  if (data.coin !== "BTC") throw new TypeError("Unexpected feed instrument");
  return data;
}
function levels(value: unknown, descending: boolean): TradingBookLevel[] {
  if (
    !Array.isArray(value) ||
    value.length > HYPERLIQUID_FEED_LIMITS.maxBookLevels
  )
    throw new TypeError("Invalid book depth");
  const result = value.map((item) => {
    const level = record(item);
    return {
      price: amount("USD_PER_BTC", level.px),
      quantity: amount("BTC", level.sz),
      orders: integer(level.n, 1),
    };
  });
  for (let i = 1; i < result.length; i++) {
    const prev = BigInt(result[i - 1]!.price.raw),
      next = BigInt(result[i]!.price.raw);
    if (descending ? prev <= next : prev >= next)
      throw new TypeError("Unordered book levels");
  }
  return result;
}
export function normalizeHyperliquidFeed(
  channel: FeedChannel,
  value: unknown,
  receivedAt: string,
  instrumentVersion: string,
  observationId: string,
): TradingMarketObservation[] {
  if (new Date(receivedAt).toISOString() !== receivedAt)
    throw new TypeError("Invalid receipt time");
  function event(
    sourceTime: string | null,
    identity: string,
    payload: TradingMarketObservation["payload"],
  ): TradingMarketObservation {
    const hash = createHash("sha256")
      .update(canonicalFingerprint(payload))
      .digest("hex");
    return {
      schema_version: "trading.market-data.v1",
      instrument_id: "hyperliquid:mainnet:BTC",
      instrument_version: instrumentVersion,
      source_id: "hyperliquid:mainnet:ws",
      parser_version: "hyperliquid.feed.v1",
      channel,
      key: identity || `${sourceTime}:${hash}`,
      source_timestamp: sourceTime,
      received_at: receivedAt,
      payload_hash: hash,
      payload,
    };
  }
  if (channel === "book") {
    const data = btc(value);
    if (!Array.isArray(data.levels) || data.levels.length !== 2)
      throw new TypeError("Invalid book sides");
    const bids = levels(data.levels[0], true),
      asks = levels(data.levels[1], false);
    if (
      bids.length &&
      asks.length &&
      BigInt(bids[0]!.price.raw) >= BigInt(asks[0]!.price.raw)
    )
      throw new TypeError("Crossed book");
    return [
      event(time(data.time), "", {
        kind: "book",
        semantics: "full_snapshot_top_20",
        bids,
        asks,
      }),
    ];
  }
  if (channel === "trades") {
    if (
      !Array.isArray(value) ||
      value.length > HYPERLIQUID_FEED_LIMITS.maxTradesPerFrame
    )
      throw new TypeError("Invalid trade batch");
    // Validate entire bounded batch before exposing any part of an invalid frame.
    return value.map((item) => {
      const data = btc(item),
        sourceTime = time(data.time);
      if (data.side !== "B" && data.side !== "A")
        throw new TypeError("Unknown trade side");
      const id = `${data.time}:BTC:${integer(data.tid)}`;
      return event(sourceTime, id, {
        kind: "trade",
        side: data.side === "B" ? "buy" : "sell",
        price: amount("USD_PER_BTC", data.px),
        quantity: amount("BTC", data.sz),
        venue_trade_id: id,
      });
    });
  }
  const data = btc(value),
    ctx = record(data.ctx);
  const funding = decimal(ctx.funding);
  if (
    BigInt(funding.raw) > 10n ** BigInt(funding.decimals) ||
    BigInt(funding.raw) < -(10n ** BigInt(funding.decimals))
  )
    throw new TypeError("Invalid funding rate");
  // No fabricated source event ID: local receipt identity is explicitly namespaced.
  return [
    event(null, `observation:${observationId}`, {
      kind: "mark_funding",
      mark_price: amount("USD_PER_BTC", ctx.markPx),
      oracle_price: amount("USD_PER_BTC", ctx.oraclePx),
      funding_rate: funding,
      funding_semantics: "current_context_not_settled_payment",
      funding_interval_seconds: 3600,
      settlement_timestamp: null,
    }),
  ];
}
