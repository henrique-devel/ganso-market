import type { TradingMarketData } from "@ganso-market/contracts/trading";
import { FeedQualityMachine } from "../../src/trading/feed.js";
import type { CaptureEvidence } from "../../src/trading/bars.js";
import { parseHyperliquidBtcMetadata } from "../../src/venues/hyperliquid/metadata.js";
import { normalizeHyperliquidFeed } from "../../src/venues/hyperliquid/feed-normalizer.js";

export const start = Date.parse("2024-01-01T00:00:00.000Z");
export const iso = (at: number) => new Date(at).toISOString();
export const metadata = parseHyperliquidBtcMetadata(
  {
    universe: [
      { name: "BTC", szDecimals: 5, maxLeverage: 40, marginTableId: 40 },
    ],
    marginTables: [],
    collateralToken: 0,
  },
  iso(start - 10_000),
);
export function trade(
  at = start + 1000,
  tid = 1,
  px = "64000.1",
  sz = "0.00001",
  received = at,
): TradingMarketData {
  return {
    ...normalizeHyperliquidFeed(
      "trades",
      [{ coin: "BTC", time: at, tid, side: "B", px, sz }],
      iso(received),
      metadata.instrument.instrument_version,
      "fixture",
    )[0]!,
    quality: "fresh",
    gap_epoch: 0,
    revalidation: "none",
    continuity: "unproven",
  };
}
export function health(at: number) {
  const result = new FeedQualityMachine<TradingMarketData>().status(at);
  result.socket = { connected: true, alive: true, last_message_at: at };
  result.channels.trades = {
    status: "healthy",
    last_received_at: at,
    last_source_at: at,
    source_quality: "fresh",
    gap_epoch: 0,
    needs_revalidation: false,
  };
  return result;
}
export function captures(
  from = start,
  end = start + 910_000,
): CaptureEvidence[] {
  const out = [];
  for (let at = from + 10_000; at <= end; at += 10_000)
    out.push({
      id: `capture:${at}`,
      from: at - 10_000,
      at,
      session: "fixture",
      health: health(at),
    });
  return out;
}
