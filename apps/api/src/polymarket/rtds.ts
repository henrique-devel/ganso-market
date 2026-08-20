import type { DatabasePool } from "../database.js";
import { comparePriceStrings } from "./book.js";
import type { MarketSocket, MarketSocketFactory } from "./recorder.js";

// RFC-007 task 8: continuous recording of Polymarket RTDS crypto feeds
// (Chainlink TWAP 30/60 that resolves the crypto markets, plus Binance spot).
// RTDS has no replay: a disconnect is a real hole and is recorded as a row in
// polymarket_data_gaps. Public data only; no auth material.

export const RTDS_WS_URL = "wss://ws-live-data.polymarket.com";

export const RTDS_TOPICS = [
  "crypto_prices",
  "crypto_prices_twap_thirty",
  "crypto_prices_twap_sixty",
] as const;

export type RtdsFeed = "spot" | "twap30" | "twap60";

const TOPIC_TO_FEED = new Map<string, RtdsFeed>([
  ["crypto_prices", "spot"],
  ["crypto_prices_twap_thirty", "twap30"],
  ["crypto_prices_twap_sixty", "twap60"],
]);

const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_PING_INTERVAL_MS = 5_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MINUTE_MS = 60_000;

function logLine(
  level: "info" | "warn" | "error",
  reasonCode: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  process.stderr.write(
    `${JSON.stringify({
      level,
      service: "polymarket-recorder",
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      message,
      ...extra,
    })}\n`,
  );
}

// Accepts canonical decimal strings as-is; JSON numbers are converted through
// their shortest round-trip representation (never re-parsed as a float again).
function toDecimalString(value: unknown): string | null {
  if (typeof value === "string") {
    return /^-?\d+(\.\d+)?$/.test(value) ? value : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const text = String(value);
    if (/^-?\d+(\.\d+)?$/.test(text)) {
      return text;
    }
    // Exponent notation (very small/large): expand without losing digits we
    // never had; reject if still not a plain decimal.
    const expanded = value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
    return /^-?\d+(\.\d+)?$/.test(expanded) ? expanded : null;
  }
  return null;
}

// RTDS timestamps are not firmly documented; accept epoch-ms, epoch-seconds
// and ISO strings, defensively. Anything else becomes null (row still gets
// received_at).
function toSourceDate(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 1e12) {
      return new Date(value);
    }
    if (value >= 1e9) {
      return new Date(value * 1_000);
    }
    return null;
  }
  if (typeof value === "string") {
    if (/^\d{1,15}$/.test(value)) {
      return toSourceDate(Number(value));
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed);
  }
  return null;
}

export interface RtdsPriceSample {
  readonly feed: RtdsFeed;
  readonly symbol: string;
  readonly price: string;
  readonly sourceTs: Date | null;
  readonly receivedAtMs: number;
}

export interface RtdsFrameResult {
  readonly samples: RtdsPriceSample[];
  /** False when the frame shape/topic was not recognized (counted, not fatal). */
  readonly recognized: boolean;
}

// Signed E18 fixed-point integer string -> canonical decimal string.
function e18ToDecimalString(value: unknown): string | null {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    return null;
  }
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const padded = digits.padStart(19, "0");
  const intPart = padded.slice(0, -18);
  const fracPart = padded.slice(-18).replace(/0+$/, "");
  const abs = fracPart === "" ? intPart : `${intPart}.${fracPart}`;
  return negative ? `-${abs}` : abs;
}

function parsePayloadItem(
  feed: RtdsFeed,
  item: unknown,
  receivedAtMs: number,
): RtdsPriceSample | null {
  if (typeof item !== "object" || item === null) {
    return null;
  }
  const record = item as Record<string, unknown>;
  const symbolRaw = record.symbol ?? record.pair ?? record.asset;
  const symbol =
    typeof symbolRaw === "string" && symbolRaw.length > 0
      ? symbolRaw.toLowerCase()
      : null;
  // Chainlink/TWAP updates carry full_accuracy_value as a signed E18
  // fixed-point string; prefer it over the display `value` (exact math).
  const price =
    e18ToDecimalString(record.full_accuracy_value) ??
    toDecimalString(record.price ?? record.value ?? record.p);
  if (symbol === null || price === null) {
    return null;
  }
  const sourceTs = toSourceDate(record.timestamp ?? record.ts ?? record.time);
  return { feed, symbol, price, sourceTs, receivedAtMs };
}

/**
 * Defensive parse of an RTDS frame. The exact wire shape is not fully
 * documented, so this accepts a single object or an array of objects shaped
 * like `{topic, payload|data|message}` where the payload is one price item or
 * an array of items (`{symbol, price|value, timestamp?}`). Unknown frames are
 * reported as unrecognized and never throw.
 */
export function parseRtdsFrame(
  raw: string,
  receivedAtMs: number,
): RtdsFrameResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { samples: [], recognized: false };
  }
  const frames = Array.isArray(parsed) ? parsed : [parsed];
  const samples: RtdsPriceSample[] = [];
  let recognized = false;
  for (const frame of frames) {
    if (typeof frame !== "object" || frame === null) {
      continue;
    }
    const record = frame as Record<string, unknown>;
    const topic = typeof record.topic === "string" ? record.topic : null;
    const feed = topic === null ? undefined : TOPIC_TO_FEED.get(topic);
    if (feed === undefined) {
      continue;
    }
    const payload = record.payload ?? record.data ?? record.message;
    if (payload === undefined || payload === null) {
      // Control/ack frame for a known topic: recognized, no samples.
      recognized = true;
      continue;
    }
    const items = Array.isArray(payload) ? payload : [payload];
    for (const item of items) {
      const sample = parsePayloadItem(feed, item, receivedAtMs);
      if (sample !== null) {
        samples.push(sample);
        recognized = true;
      }
    }
  }
  return { samples, recognized };
}

/**
 * Official RTDS subscribe frame (docs: market-data/realtime-data and
 * market-data/chainlink-twap). Binance (`crypto_prices`) takes a
 * comma-separated list of exchange symbols ("btcusdt,ethusdt"); the Chainlink
 * TWAP topics take exactly one lowercase slash symbol per subscription as a
 * compact JSON string ('{"symbol":"btc/usd"}', no spaces). Symbols are
 * configured in slash form ("btc/usd") and mapped for Binance here.
 */
export function buildRtdsSubscribeFrame(
  topics: readonly string[],
  symbols: readonly string[],
): string {
  const binance = symbols
    .map((symbol) => symbol.replace("/usd", "usdt").replace("/", ""))
    .join(",");
  const subscriptions: Array<Record<string, string>> = [];
  for (const topic of topics) {
    if (topic === "crypto_prices") {
      subscriptions.push({ topic, type: "update", filters: binance });
    } else {
      for (const symbol of symbols) {
        subscriptions.push({
          topic,
          type: "*",
          filters: JSON.stringify({ symbol }),
        });
      }
    }
  }
  return JSON.stringify({ action: "subscribe", subscriptions });
}

export interface RtdsMinuteBucket {
  readonly feed: RtdsFeed;
  readonly symbol: string;
  readonly bucketStart: Date;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly samples: number;
}

interface OpenBucket {
  feed: RtdsFeed;
  symbol: string;
  bucketStartMs: number;
  open: string;
  high: string;
  low: string;
  close: string;
  samples: number;
}

function toMinuteBucket(bucket: OpenBucket): RtdsMinuteBucket {
  return {
    feed: bucket.feed,
    symbol: bucket.symbol,
    bucketStart: new Date(bucket.bucketStartMs),
    open: bucket.open,
    high: bucket.high,
    low: bucket.low,
    close: bucket.close,
    samples: bucket.samples,
  };
}

/**
 * In-memory 1-minute OHLC aggregation per (feed, symbol). Buckets on the
 * source timestamp when available (received_at otherwise). `add` returns the
 * closed bucket when a sample rolls to a newer minute; late samples for an
 * already-closed minute are dropped (no replay upstream either).
 */
export class RtdsMinuteAggregator {
  readonly #buckets = new Map<string, OpenBucket>();

  public add(sample: RtdsPriceSample): RtdsMinuteBucket | null {
    const tsMs = sample.sourceTs?.getTime() ?? sample.receivedAtMs;
    const bucketStartMs = Math.floor(tsMs / MINUTE_MS) * MINUTE_MS;
    const key = `${sample.feed}|${sample.symbol}`;
    const current = this.#buckets.get(key);
    if (current === undefined) {
      this.#buckets.set(key, {
        feed: sample.feed,
        symbol: sample.symbol,
        bucketStartMs,
        open: sample.price,
        high: sample.price,
        low: sample.price,
        close: sample.price,
        samples: 1,
      });
      return null;
    }
    if (bucketStartMs === current.bucketStartMs) {
      current.close = sample.price;
      if (comparePriceStrings(sample.price, current.high) > 0) {
        current.high = sample.price;
      }
      if (comparePriceStrings(sample.price, current.low) < 0) {
        current.low = sample.price;
      }
      current.samples += 1;
      return null;
    }
    if (bucketStartMs < current.bucketStartMs) {
      return null;
    }
    const closed = toMinuteBucket(current);
    this.#buckets.set(key, {
      feed: sample.feed,
      symbol: sample.symbol,
      bucketStartMs,
      open: sample.price,
      high: sample.price,
      low: sample.price,
      close: sample.price,
      samples: 1,
    });
    return closed;
  }

  /** Close and return every open bucket (used on stop/final flush). */
  public drain(): RtdsMinuteBucket[] {
    const closed = [...this.#buckets.values()].map(toMinuteBucket);
    this.#buckets.clear();
    return closed;
  }
}

export interface RtdsGapInfo {
  readonly source: "rtds";
  readonly start: Date;
  readonly end: Date;
}

export interface RtdsRecorderDeps {
  readonly pool: DatabasePool;
  readonly socketFactory: MarketSocketFactory;
  readonly url?: string;
  /** Symbols referenced by the tracked universe, e.g. ["btc/usd", "eth/usd"]. */
  readonly symbols: readonly string[];
  readonly clock?: () => number;
  readonly onGap?: (info: RtdsGapInfo) => void;
  readonly flushIntervalMs?: number;
  readonly pingIntervalMs?: number;
  readonly reconnectBaseMs?: number;
  readonly buildSubscribeFrame?: (
    topics: readonly string[],
    symbols: readonly string[],
  ) => string;
}

export interface RtdsRecorder {
  start(): void;
  stop(): Promise<void>;
  setSymbols(symbols: readonly string[]): void;
  /** Force a flush of buffered raw prices and closed 1-min buckets. */
  flushNow(): Promise<void>;
  /** Frames received that no parser recognized (diagnostic counter). */
  unknownFrames(): number;
}

export function createRtdsRecorder(deps: RtdsRecorderDeps): RtdsRecorder {
  const clock = deps.clock ?? Date.now;
  const url = deps.url ?? RTDS_WS_URL;
  const build = deps.buildSubscribeFrame ?? buildRtdsSubscribeFrame;
  const flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const pingIntervalMs = deps.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const reconnectBaseMs = deps.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;

  let symbols = deps.symbols.map((symbol) => symbol.toLowerCase());
  let running = false;
  let socketOpen = false;
  let socket: MarketSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let disconnectedAtMs: number | null = null;
  let unknownFrameCount = 0;
  let flushing: Promise<void> = Promise.resolve();

  const buffer: RtdsPriceSample[] = [];
  const closedBuckets: RtdsMinuteBucket[] = [];
  const aggregator = new RtdsMinuteAggregator();

  async function insertGap(
    start: Date,
    end: Date | null,
    cause: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await deps.pool.query(
        `INSERT INTO polymarket_data_gaps (source, gap_start, gap_end, cause, details_json)
         VALUES ('rtds', $1, $2, $3, $4::jsonb)`,
        [start, end, cause, JSON.stringify(details)],
      );
    } catch (error: unknown) {
      logLine("error", "RTDS_GAP_PERSIST_FAILED", "rtds_gap_persist_failed", {
        error_name: error instanceof Error ? error.name : "UnknownError",
        cause,
      });
    }
  }

  async function doFlush(): Promise<void> {
    const pending = buffer.splice(0, buffer.length);
    const buckets = closedBuckets.splice(0, closedBuckets.length);
    if (pending.length > 0) {
      const params: unknown[] = [];
      const tuples: string[] = [];
      for (const [index, sample] of pending.entries()) {
        const base = index * 6;
        tuples.push(
          `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`,
        );
        const ingestLagMs =
          sample.sourceTs === null
            ? null
            : Math.round(sample.receivedAtMs - sample.sourceTs.getTime());
        params.push(
          sample.feed,
          sample.symbol,
          sample.price,
          sample.sourceTs,
          new Date(sample.receivedAtMs),
          ingestLagMs,
        );
      }
      try {
        await deps.pool.query(
          `INSERT INTO polymarket_rtds_prices
             (feed, symbol, price, source_ts, received_at, ingest_lag_ms)
           VALUES ${tuples.join(",")}`,
          params,
        );
      } catch (error: unknown) {
        // Never crash on persistence failures: the batch is lost, so record
        // it as a data gap and keep the socket alive.
        logLine("error", "RTDS_PERSIST_FAILED", "rtds_persist_failed", {
          error_name: error instanceof Error ? error.name : "UnknownError",
          dropped: pending.length,
        });
        const startMs = Math.min(
          ...pending.map((sample) => sample.receivedAtMs),
        );
        const endMs = Math.max(...pending.map((sample) => sample.receivedAtMs));
        await insertGap(new Date(startMs), new Date(endMs), "persist_failed", {
          dropped: pending.length,
        });
      }
    }
    for (const bucket of buckets) {
      try {
        await deps.pool.query(
          `INSERT INTO polymarket_rtds_1m
             (feed, symbol, bucket_start, open, high, low, close, samples)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (feed, symbol, bucket_start) DO UPDATE SET
             open = EXCLUDED.open,
             high = EXCLUDED.high,
             low = EXCLUDED.low,
             close = EXCLUDED.close,
             samples = EXCLUDED.samples,
             received_at = CURRENT_TIMESTAMP`,
          [
            bucket.feed,
            bucket.symbol,
            bucket.bucketStart,
            bucket.open,
            bucket.high,
            bucket.low,
            bucket.close,
            bucket.samples,
          ],
        );
      } catch (error: unknown) {
        logLine("error", "RTDS_1M_PERSIST_FAILED", "rtds_1m_persist_failed", {
          error_name: error instanceof Error ? error.name : "UnknownError",
          feed: bucket.feed,
          symbol: bucket.symbol,
        });
      }
    }
  }

  function flushNow(): Promise<void> {
    flushing = flushing.then(doFlush);
    return flushing;
  }

  function connect(): void {
    const current = deps.socketFactory(url);
    socket = current;
    current.onOpen(() => {
      if (!running) {
        return;
      }
      socketOpen = true;
      reconnectAttempt = 0;
      if (disconnectedAtMs !== null) {
        const gap: RtdsGapInfo = {
          source: "rtds",
          start: new Date(disconnectedAtMs),
          end: new Date(clock()),
        };
        disconnectedAtMs = null;
        // No replay exists on RTDS: the hole is real, so record it.
        void insertGap(gap.start, gap.end, "ws_disconnect", { symbols });
        deps.onGap?.(gap);
        logLine("warn", "RTDS_GAP_RECORDED", "rtds_gap_recorded", {
          gap_start: gap.start.toISOString(),
          gap_end: gap.end.toISOString(),
        });
      }
      current.send(build([...RTDS_TOPICS], symbols));
      pingTimer = setInterval(() => {
        current.send("PING");
      }, pingIntervalMs);
    });
    current.onMessage((raw) => {
      if (raw === "PONG" || raw === "PING") {
        return;
      }
      const result = parseRtdsFrame(raw, clock());
      if (!result.recognized) {
        unknownFrameCount += 1;
        if (unknownFrameCount === 1 || unknownFrameCount % 100 === 0) {
          logLine("warn", "RTDS_UNKNOWN_FRAME", "rtds_unknown_frame", {
            unknown_frames: unknownFrameCount,
          });
        }
        return;
      }
      for (const sample of result.samples) {
        buffer.push(sample);
        const closed = aggregator.add(sample);
        if (closed !== null) {
          closedBuckets.push(closed);
        }
      }
    });
    current.onClose(() => {
      socketOpen = false;
      if (pingTimer !== undefined) {
        clearInterval(pingTimer);
        pingTimer = undefined;
      }
      if (!running) {
        return;
      }
      if (disconnectedAtMs === null) {
        disconnectedAtMs = clock();
      }
      const delay = Math.min(
        reconnectBaseMs * 2 ** reconnectAttempt,
        MAX_RECONNECT_DELAY_MS,
      );
      reconnectAttempt += 1;
      logLine("warn", "RTDS_DISCONNECTED", "rtds_disconnected", {
        reconnect_in_ms: delay,
        attempt: reconnectAttempt,
      });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        if (running) {
          connect();
        }
      }, delay);
    });
  }

  return {
    start(): void {
      if (running) {
        return;
      }
      running = true;
      connect();
      flushTimer = setInterval(() => {
        void flushNow();
      }, flushIntervalMs);
    },
    async stop(): Promise<void> {
      running = false;
      if (flushTimer !== undefined) {
        clearInterval(flushTimer);
        flushTimer = undefined;
      }
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      if (socket !== null) {
        try {
          socket.close();
        } catch {
          // A close failure must not block shutdown.
        }
        socket = null;
      }
      closedBuckets.push(...aggregator.drain());
      await flushNow();
    },
    setSymbols(next: readonly string[]): void {
      symbols = next.map((symbol) => symbol.toLowerCase());
      if (socket !== null && socketOpen) {
        // Assumption: a new subscribe frame replaces the previous filter set
        // (validate live; see module notes).
        socket.send(build([...RTDS_TOPICS], symbols));
      }
    },
    flushNow,
    unknownFrames(): number {
      return unknownFrameCount;
    },
  };
}
