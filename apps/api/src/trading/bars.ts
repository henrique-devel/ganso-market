/** Pure, versioned aggregation of observed trades. No clock, SQL, I/O or signals. */
export const BAR_BUILD_VERSION = "btc-observed-bars.v1";
export const BAR_LIMITS = Object.freeze({
  latenessMs: 10_000,
  captureSilenceMs: 10_000,
  trades: 32_768,
  captures: 4096,
  closeBatch: 8,
  readBars: 200,
});
export type BarInterval = 900_000 | 3_600_000;
/** Structural inputs keep the pure core independent of adapter/runtime packages. */
export interface MarketHealth {
  socket: { connected: boolean };
  channels: { trades: { status: string } };
  counters: { gaps: number };
  gaps: {
    epoch: number;
    channel: string;
    reason: string;
    detected_at: number;
    after_source_at: number | null;
    resumed_at: number | null;
    recovery: string;
  }[];
}
interface BarTradeObservation {
  key: string;
  source_id: string;
  source_timestamp: string | null;
  received_at: string;
  payload_hash: string;
  instrument_version: string;
  quality: string;
  revalidation: string;
  payload:
    | {
        kind: "trade";
        price: { raw: string; unit: string; decimals: number };
        quantity: { raw: string; unit: string; decimals: number };
      }
    | { kind: "book" | "mark_funding" };
}
export interface CaptureEvidence {
  id: string;
  from: number;
  at: number;
  session: string;
  health: MarketHealth;
  restarted?: boolean;
  history_truncated?: boolean;
}
export interface TradeEvidence {
  id: string;
  event: BarTradeObservation;
}
export interface ClosedBar {
  schema_version: "trading.closed-bar.v1";
  build_version: typeof BAR_BUILD_VERSION;
  instrument_id: "hyperliquid:mainnet:BTC";
  instrument_version: string;
  source_id: "hyperliquid:mainnet:ws";
  interval_ms: BarInterval;
  start_at: string;
  end_at: string;
  closed_at: string;
  ohlc: null | {
    open: string;
    high: string;
    low: string;
    close: string;
    unit: "USD_PER_BTC";
    decimals: 6;
  };
  volume: { raw: string; unit: "BTC"; decimals: 8 };
  trade_count: number;
  quality: {
    state: "observed_no_known_gap" | "incomplete";
    reasons: string[];
    continuity: "unproven";
  };
  input_ids: string[];
}
export function barStart(at: number, interval: BarInterval): number {
  if (
    !Number.isSafeInteger(at) ||
    at < 0 ||
    ![900_000, 3_600_000].includes(interval)
  )
    throw new TypeError("BTC_BAR_INVALID_TIME");
  return Math.floor(at / interval) * interval;
}
export function tradeGapRange(gap: MarketHealth["gaps"][number], at: number) {
  return {
    from: Math.min(gap.after_source_at ?? gap.detected_at, gap.detected_at),
    to: gap.resumed_at ?? at,
  };
}
export function buildClosedBar(input: {
  start: number;
  interval: BarInterval;
  asOf: number;
  instrumentVersion: string;
  metadataId: string;
  trades: readonly TradeEvidence[];
  captures: readonly CaptureEvidence[];
}): ClosedBar {
  const { start, interval, asOf } = input;
  const end = start + interval;
  if (
    barStart(start, interval) !== start ||
    !Number.isSafeInteger(asOf) ||
    asOf < end + BAR_LIMITS.latenessMs
  )
    throw new Error("BTC_BAR_NOT_CLOSED");
  if (
    input.trades.length > BAR_LIMITS.trades ||
    input.captures.length > BAR_LIMITS.captures
  )
    throw new Error("BTC_BAR_INPUT_LIMIT");
  const reasons = new Set<string>();
  const ids = new Set([input.metadataId]);
  const seen = new Map<string, string>();
  const trades = input.trades
    .filter(({ id, event }) => {
      const ts = Date.parse(event.source_timestamp ?? "");
      if (
        event.payload.kind !== "trade" ||
        !Number.isFinite(ts) ||
        ts < start ||
        ts >= end
      )
        throw new Error("BTC_BAR_INPUT_OUTSIDE_WINDOW");
      const key = `${event.source_id}:${event.key}`;
      const prior = seen.get(key);
      if (prior && prior !== event.payload_hash)
        throw new Error("BTC_BAR_TRADE_CONFLICT");
      if (prior) return false;
      seen.set(key, event.payload_hash);
      ids.add(id);
      if (event.quality !== "fresh") reasons.add("input_not_fresh");
      if (event.revalidation !== "none") reasons.add("feed_gap");
      if (event.instrument_version !== input.instrumentVersion)
        reasons.add("metadata_changed");
      if (Date.parse(event.received_at) >= end + BAR_LIMITS.latenessMs)
        reasons.add("late_input");
      return true;
    })
    .sort(
      (a, b) =>
        Date.parse(a.event.source_timestamp!) -
          Date.parse(b.event.source_timestamp!) ||
        (a.event.key < b.event.key ? -1 : a.event.key > b.event.key ? 1 : 0),
    );
  if (!trades.length) reasons.add("no_trades");
  let coveredUntil = start;
  const captures = [...input.captures].sort((a, b) => a.at - b.at);
  for (const capture of captures) {
    ids.add(capture.id);
    if (capture.from < end && capture.at >= start) {
      if (capture.restarted) reasons.add("restart");
      if (capture.history_truncated) reasons.add("gap_history_truncated");
    }
    if (capture.from > coveredUntil) reasons.add("capture_gap");
    if (capture.at - capture.from > BAR_LIMITS.captureSilenceMs)
      reasons.add("capture_silence");
    coveredUntil = Math.max(coveredUntil, capture.at);
    for (const gap of capture.health.gaps) {
      if (gap.channel !== "trades") continue;
      const range = tradeGapRange(gap, capture.at);
      if (range.from < end && range.to >= start) reasons.add("feed_gap");
    }
    if (
      capture.at < end &&
      capture.at >= start &&
      (!capture.health.socket.connected ||
        capture.health.channels.trades.status !== "healthy")
    )
      reasons.add("channel_unhealthy");
  }
  if (
    !captures.length ||
    captures[0]!.from > start ||
    coveredUntil < end + BAR_LIMITS.latenessMs
  )
    reasons.add("warmup_incomplete");
  let ohlc: ClosedBar["ohlc"] = null;
  let volume = 0n;
  for (const { event } of trades) {
    if (event.payload.kind !== "trade") continue;
    const { price, quantity } = event.payload;
    if (
      price.unit !== "USD_PER_BTC" ||
      price.decimals !== 6 ||
      quantity.unit !== "BTC" ||
      quantity.decimals !== 8 ||
      !/^[1-9]\d*$/.test(price.raw) ||
      !/^[1-9]\d*$/.test(quantity.raw)
    )
      throw new Error("BTC_BAR_INVALID_AMOUNT");
    const px = BigInt(price.raw);
    volume += BigInt(quantity.raw);
    if (ohlc === null) {
      ohlc = {
        open: price.raw,
        high: price.raw,
        low: price.raw,
        close: price.raw,
        unit: "USD_PER_BTC",
        decimals: 6,
      };
    } else {
      if (px > BigInt(ohlc.high)) ohlc.high = price.raw;
      if (px < BigInt(ohlc.low)) ohlc.low = price.raw;
      ohlc.close = price.raw;
    }
  }
  return {
    schema_version: "trading.closed-bar.v1",
    build_version: BAR_BUILD_VERSION,
    instrument_id: "hyperliquid:mainnet:BTC",
    instrument_version: input.instrumentVersion,
    source_id: "hyperliquid:mainnet:ws",
    interval_ms: interval,
    start_at: new Date(start).toISOString(),
    end_at: new Date(end).toISOString(),
    closed_at: new Date(asOf).toISOString(),
    ohlc,
    volume: { raw: volume.toString(), unit: "BTC", decimals: 8 },
    trade_count: trades.length,
    quality: {
      state: reasons.size ? "incomplete" : "observed_no_known_gap",
      reasons: [...reasons].sort(),
      continuity: "unproven",
    },
    input_ids: [...ids].sort(),
  };
}
/** Newest first. Readiness is observed coverage, never a venue completeness claim.
 * Strategies must also apply their own market freshness/execution gates. */
export function barWarmup(
  bars: readonly ClosedBar[],
  required: number,
  asOf: number,
  interval: BarInterval,
) {
  if (
    !Number.isInteger(required) ||
    required < 1 ||
    required > BAR_LIMITS.readBars
  )
    throw new Error("BTC_BAR_INVALID_WARMUP");
  let expectedEnd = barStart(asOf - BAR_LIMITS.latenessMs, interval);
  const version = bars[0]?.instrument_version;
  for (const bar of bars.slice(0, required)) {
    if (
      bar.interval_ms !== interval ||
      Date.parse(bar.end_at) !== expectedEnd ||
      bar.quality.state !== "observed_no_known_gap" ||
      bar.instrument_version !== version ||
      bar.build_version !== BAR_BUILD_VERSION
    )
      return {
        ready: false,
        reason: "incomplete_or_discontinuous",
        continuity: "unproven" as const,
      };
    expectedEnd -= interval;
  }
  return {
    ready: bars.length >= required,
    reason: bars.length >= required ? "observed_window" : "insufficient_bars",
    continuity: "unproven" as const,
  };
}
