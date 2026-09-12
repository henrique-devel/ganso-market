import type { DatabasePool } from "../database.js";
import { comparePriceStrings } from "./book.js";
import type { MarketSocket, MarketSocketFactory } from "./recorder.js";
import { errorFields } from "../errors.js";
import { createRtdsGapJournal } from "./rtdsgaps.js";
import {
  createRtdsSilenceMonitor,
  rtdsSilenceMs,
  rtdsMaxReconnects,
  RTDS_WATCHDOG_INTERVAL_MS,
} from "./rtdssilence.js";

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
    if (value >= 1e12 && value <= 8.64e15) {
      return new Date(value);
    }
    if (value >= 1e9 && value < 1e12) {
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
    // Topic acknowledgements/heartbeats never carry a price observation.
    if (record.type !== undefined && record.type !== "update") {
      recognized = true;
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
  /** Validated arrival watchdog, 30 seconds to 1 hour; default 120 seconds. */
  readonly silenceMs?: number;
  /** Reconnect budget per overlapping silence episode; default 3, range 0..10. */
  readonly recoveryMaxReconnects?: number;
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
  health(): ReturnType<ReturnType<typeof createRtdsSilenceMonitor>["stats"]> &
    ReturnType<ReturnType<typeof createRtdsGapJournal>["stats"]> & {
      socketOpen: boolean;
      pricePersistFailures: number;
      bucketPersistFailures: number;
      lastPricePersistMs: number | null;
      lastPricePersistErrorMs: number | null;
      lastBucketPersistErrorMs: number | null;
    };
}

export function createRtdsRecorder(deps: RtdsRecorderDeps): RtdsRecorder {
  const clock = deps.clock ?? Date.now;
  const url = deps.url ?? RTDS_WS_URL;
  const build = deps.buildSubscribeFrame ?? buildRtdsSubscribeFrame;
  const flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const pingIntervalMs = deps.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const reconnectBaseMs = deps.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
  const silenceMs = rtdsSilenceMs(deps.silenceMs);
  const maxReconnects = rtdsMaxReconnects(deps.recoveryMaxReconnects);

  let symbols = [
    ...new Set(deps.symbols.map((symbol) => symbol.toLowerCase())),
  ];
  let running = false;
  let socketOpen = false;
  let socket: MarketSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  let watchdogTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let disconnectedAtMs: number | null = null;
  let unknownFrameCount = 0;
  let flushing: Promise<void> = Promise.resolve();
  let pricePersistFailures = 0;
  let bucketPersistFailures = 0;
  let lastPricePersistMs: number | null = null;
  let lastPricePersistErrorMs: number | null = null;
  let lastBucketPersistErrorMs: number | null = null;
  let stopPromise: Promise<void> | null = null;
  let generation = 0;
  // Bounded recent wire identities survive reconnects. Duplicate replay is still
  // visible as an arrival, but cannot count a second time in raw/minute buckets.
  const recent = new Map<string, Map<string, number>>();

  const buffer: RtdsPriceSample[] = [];
  const closedBuckets: RtdsMinuteBucket[] = [];
  const aggregator = new RtdsMinuteAggregator();
  const journal = createRtdsGapJournal({
    pool: deps.pool,
    clock,
    log: (level, code, details) =>
      logLine(level, code, code.toLowerCase(), details),
  });
  const silence = createRtdsSilenceMonitor({
    pool: deps.pool,
    journal,
    clock,
    silenceMs,
    maxReconnects,
    socketOpen: () => socketOpen,
    resubscribe: () => replaceSubscriptions(symbols),
    reconnect: () => {
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      retireSocket();
      disconnectedAtMs ??= clock();
      connect();
    },
    log: (level, code, details) =>
      logLine(level, code, code.toLowerCase(), details),
  });
  silence.setSymbols(symbols);

  function insertGap(
    start: Date,
    end: Date | null,
    cause: string,
    details: Record<string, unknown>,
  ): void {
    journal.record(start, end, cause, details);
    void journal.flush();
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
        lastPricePersistMs = clock();
        silence.persisted(pending);
      } catch (error: unknown) {
        pricePersistFailures += 1;
        lastPricePersistErrorMs = clock();
        // Never crash on persistence failures: the batch is lost, so record
        // it as a data gap and keep the socket alive.
        logLine("error", "RTDS_PERSIST_FAILED", "rtds_persist_failed", {
          ...errorFields(error),
          dropped: pending.length,
        });
        const startMs = Math.min(
          ...pending.map((sample) => sample.receivedAtMs),
        );
        const endMs = Math.max(...pending.map((sample) => sample.receivedAtMs));
        insertGap(new Date(startMs), new Date(endMs), "persist_failed", {
          dropped: pending.length,
          series: [
            ...new Set(
              pending.map((sample) => `${sample.feed}|${sample.symbol}`),
            ),
          ],
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
        bucketPersistFailures += 1;
        lastBucketPersistErrorMs = clock();
        logLine("error", "RTDS_1M_PERSIST_FAILED", "rtds_1m_persist_failed", {
          ...errorFields(error),
          feed: bucket.feed,
          symbol: bucket.symbol,
        });
        insertGap(
          bucket.bucketStart,
          new Date(bucket.bucketStart.getTime() + MINUTE_MS),
          "persist_failed",
          {
            table: "polymarket_rtds_1m",
            feed: bucket.feed,
            symbol: bucket.symbol,
          },
        );
      }
    }
  }

  function flushNow(): Promise<void> {
    flushing = flushing.then(doFlush);
    return flushing;
  }

  function clearPing(): void {
    if (pingTimer !== undefined) clearInterval(pingTimer);
    pingTimer = undefined;
  }

  function retireSocket(): void {
    const previous = socket;
    socket = null;
    socketOpen = false;
    clearPing();
    // Detach before close: sync, delayed, duplicate and missing close callbacks
    // must all have the same lifecycle semantics.
    try {
      previous?.close();
    } catch {
      /* shutdown/recovery still proceeds */
    }
  }

  function replaceSubscriptions(next: readonly string[]): void {
    if (socket === null || !socketOpen) return;
    // Official client uses identical SubscriptionMessage for both actions.
    // Unsubscribe first; another subscribe alone is not a replacement contract.
    if (symbols.length > 0) {
      const previous = JSON.parse(build([...RTDS_TOPICS], symbols)) as Record<
        string,
        unknown
      >;
      socket.send(JSON.stringify({ ...previous, action: "unsubscribe" }));
    }
    if (next.length > 0) socket.send(build([...RTDS_TOPICS], next));
  }

  function scheduleReconnect(): void {
    if (!running || reconnectTimer !== undefined || silence.hasOpenGaps())
      return;
    const delay = Math.min(
      reconnectBaseMs * 2 ** Math.min(reconnectAttempt, 30),
      MAX_RECONNECT_DELAY_MS,
    );
    reconnectAttempt += 1;
    logLine("warn", "RTDS_DISCONNECTED", "rtds_disconnected", {
      reconnect_in_ms: delay,
      attempt: reconnectAttempt,
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (running && !silence.hasOpenGaps()) connect();
    }, delay);
  }

  function connect(): void {
    if (!running) return;
    let current: MarketSocket;
    try {
      current = deps.socketFactory(url);
    } catch (error) {
      logLine("error", "RTDS_CONNECT_FAILED", "rtds_connect_failed", {
        ...errorFields(error),
      });
      scheduleReconnect();
      return;
    }
    const currentGeneration = ++generation;
    socket = current;
    current.onOpen(() => {
      if (!running || socket !== current || socketOpen) return;
      socketOpen = true;
      if (disconnectedAtMs !== null) {
        const gap: RtdsGapInfo = {
          source: "rtds",
          start: new Date(disconnectedAtMs),
          end: new Date(clock()),
        };
        disconnectedAtMs = null;
        // Transport gap ends here; price-silence gaps end only on valid prices.
        insertGap(gap.start, gap.end, "ws_disconnect", { symbols });
        deps.onGap?.(gap);
      }
      try {
        if (symbols.length > 0) current.send(build([...RTDS_TOPICS], symbols));
        silence.subscribed();
      } catch (error) {
        logLine("error", "RTDS_SUBSCRIBE_FAILED", "rtds_subscribe_failed", {
          ...errorFields(error),
        });
        disconnectedAtMs ??= clock();
        retireSocket();
        scheduleReconnect();
        return;
      }
      pingTimer = setInterval(() => {
        if (!running || socket !== current || !socketOpen) return;
        try {
          current.send("PING");
        } catch (error) {
          logLine("error", "RTDS_PING_FAILED", "rtds_ping_failed", {
            ...errorFields(error),
          });
          disconnectedAtMs ??= clock();
          retireSocket();
          scheduleReconnect();
        }
      }, pingIntervalMs);
    });
    current.onMessage((raw) => {
      if (!running || socket !== current || !socketOpen) return;
      silence.frame();
      if (raw === "PONG" || raw === "PING") return;
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
        if (
          sample.price.startsWith("-") ||
          !/[1-9]/.test(sample.price) ||
          !silence.observe(sample)
        )
          continue;
        reconnectAttempt = 0;
        if (sample.sourceTs !== null) {
          const seriesKey = `${sample.feed}|${sample.symbol}`;
          const identities = recent.get(seriesKey) ?? new Map<string, number>();
          recent.set(seriesKey, identities);
          const identity = `${sample.sourceTs.getTime()}|${sample.price}`;
          const seenGeneration = identities.get(identity);
          if (
            seenGeneration !== undefined &&
            seenGeneration !== currentGeneration
          )
            continue;
          identities.set(identity, currentGeneration);
          if (identities.size > 128) {
            const oldest = identities.keys().next().value;
            if (oldest !== undefined) identities.delete(oldest);
          }
        }
        buffer.push(sample);
        const closed = aggregator.add(sample);
        if (closed !== null) closedBuckets.push(closed);
      }
      void journal.flush();
    });
    current.onClose(() => {
      if (socket !== current) return;
      socket = null;
      socketOpen = false;
      clearPing();
      if (!running) return;
      disconnectedAtMs ??= clock();
      scheduleReconnect();
    });
  }

  return {
    start(): void {
      if (running || stopPromise !== null) return;
      running = true;
      void silence.restore();
      connect();
      flushTimer = setInterval(() => {
        void flushNow();
      }, flushIntervalMs);
      watchdogTimer = setInterval(() => {
        if (!running) return;
        void silence.restore();
        silence.tick();
        void journal.flush();
      }, RTDS_WATCHDOG_INTERVAL_MS);
    },
    stop(): Promise<void> {
      if (stopPromise !== null) return stopPromise;
      running = false;
      silence.stop();
      if (flushTimer !== undefined) clearInterval(flushTimer);
      if (watchdogTimer !== undefined) clearInterval(watchdogTimer);
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      flushTimer = undefined;
      watchdogTimer = undefined;
      reconnectTimer = undefined;
      retireSocket();
      closedBuckets.push(...aggregator.drain());
      stopPromise = (async () => {
        await flushNow();
        // Drain every final due close within the journal shutdown budget.
        await journal.drainAndStop();
      })();
      return stopPromise;
    },
    setSymbols(next: readonly string[]): void {
      if (stopPromise !== null) return;
      const normalized = [
        ...new Set(next.map((symbol) => symbol.toLowerCase())),
      ];
      if (
        normalized.length === symbols.length &&
        normalized.every((symbol) => symbols.includes(symbol))
      )
        return;
      replaceSubscriptions(normalized);
      symbols = normalized;
      silence.setSymbols(symbols);
      if (socketOpen) silence.subscribed();
      // Retire identities only for removed subscriptions, avoiding unbounded
      // storage if the caller changes the symbol set over time.
      recent.clear();
      void journal.flush();
    },
    flushNow,
    unknownFrames(): number {
      return unknownFrameCount;
    },
    health() {
      return {
        socketOpen,
        ...silence.stats(),
        ...journal.stats(),
        pricePersistFailures,
        bucketPersistFailures,
        lastPricePersistMs,
        lastPricePersistErrorMs,
        lastBucketPersistErrorMs,
      };
    },
  };
}
