import { createHash } from "node:crypto";

import type { SqlExecutor } from "../database.js";
import { OrderBook } from "./book.js";
import { SnapshotThrottle, sourceTsToDate } from "./recorder.js";
import type { MarketMessage, PriceLevel } from "./types.js";

// RFC-007 tasks 4 + 6: full L2 book pipeline. Persists full-depth snapshots
// (replay anchors), every price_change delta (append-only, batched), the
// existing top-10 snapshot series (compatibility), and 1-minute aggregates
// derived from the in-memory book cache. Prices/sizes are canonical decimal
// strings; all money math is fixed-point bigint, never floats.

export const DEFAULT_ANCHOR_INTERVAL_MS = 60_000;
export const DEFAULT_DELTA_BATCH_SIZE = 200;
export const DEFAULT_DELTA_FLUSH_MS = 250;
export const DEFAULT_DELTA_QUEUE_MAX = 10_000;
const MINUTE_MS = 60_000;
const FULL_DEPTH = Number.MAX_SAFE_INTEGER;

// Fixed-point decimal helpers (scale 9, mirroring book.ts's comparator).
const SCALE_DIGITS = 9;
const SCALE = 10n ** BigInt(SCALE_DIGITS);

function toScaled(value: string): bigint {
  const [intPart, fracPart = ""] = value.split(".");
  const fraction = (fracPart + "0".repeat(SCALE_DIGITS)).slice(0, SCALE_DIGITS);
  return BigInt((intPart === "" ? "0" : intPart) + fraction);
}

/** Canonical decimal string from a scaled bigint (trailing zeros trimmed). */
function fromScaled(value: bigint, scale: bigint = SCALE): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const intPart = abs / scale;
  const fracRaw = (abs % scale)
    .toString()
    .padStart(scale.toString().length - 1, "0");
  const frac = fracRaw.replace(/0+$/, "");
  const body =
    frac === "" ? intPart.toString() : `${intPart.toString()}.${frac}`;
  return negative ? `-${body}` : body;
}

// Mid = (bid + ask) / 2 kept exact by working at scale 10 (an odd scale-9 sum
// halves without remainder at one extra digit).
const MID_SCALE = SCALE * 10n;

function midScaled10(bestBid: string, bestAsk: string): bigint {
  return (toScaled(bestBid) + toScaled(bestAsk)) * 5n;
}

/** Local canonical hash of book content (sorted levels), used to detect
 * divergence between the delta-maintained cache and a fresh `book` event, and
 * stored as book_hash on anchor snapshots (venue hash is unavailable there). */
export function localBookHash(
  bids: readonly PriceLevel[],
  asks: readonly PriceLevel[],
): string {
  const canonical = JSON.stringify({ bids, asks });
  return createHash("sha256").update(canonical).digest("hex");
}

function logJson(
  level: "info" | "warn" | "error",
  reasonCode: string,
  message: string,
  extra?: Record<string, unknown>,
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

export interface BookPipelineDeps {
  readonly pool: SqlExecutor;
  readonly clock?: () => number;
  /** Throttle for the existing top-10 snapshot series (2-5s). */
  readonly snapshotIntervalMs?: number;
  readonly anchorIntervalMs?: number;
  readonly deltaBatchSize?: number;
  readonly deltaFlushMs?: number;
  readonly deltaQueueMax?: number;
  /** A delta arrived for a token with no cached book: the caller should
   * re-sync via REST /book (the next `book` event will be reason 'resync'). */
  readonly onResyncNeeded?: (tokenId: string) => void;
  /** Delta queue overflow: `count` oldest entries were dropped. The caller
   * records a data gap with source 'internal' — never a silent discard. */
  readonly onOverflow?: (count: number) => void;
  /** A delta batch was lost definitively (its INSERT failed and the batch is
   * not retried). Called after the failure log with the exact received_at
   * window of the lost rows so the caller can record a data gap. */
  readonly onPersistFailure?: (info: {
    count: number;
    firstReceivedAt: Date;
    lastReceivedAt: Date;
  }) => void;
}

export interface BookPipelineStats {
  readonly insertFailures: number;
  readonly hashDivergences: number;
  readonly overflowDropped: number;
  readonly deltasFlushed: number;
  readonly deltasQueued: number;
  readonly fullSnapshots: number;
  readonly topSnapshots: number;
  readonly minuteUpserts: number;
}

export interface BookPipeline {
  handleMessage(msg: MarketMessage): Promise<void>;
  /** Replace the cached book with a REST /book result, persist it as a
   * snapshot_full with reason 'resync' (no venue hash, never deduped) and
   * clear the pending-resync state. Serialized with handleMessage. */
  seedBook(
    tokenId: string,
    bids: PriceLevel[],
    asks: PriceLevel[],
    sourceTs: Date | null,
  ): Promise<void>;
  /** Force the pending delta batch out now (also runs on N/T triggers). */
  flushDeltas(): Promise<void>;
  /** UPSERT current 1-minute accumulators; call from the orchestrator timer. */
  flushMinute(): Promise<void>;
  /** Insert 'anchor' full snapshots for every cached token that is overdue. */
  runAnchorPass(): Promise<void>;
  /** The next `book` event for this token persists with reason 'resync'. */
  requestResync(tokenId: string): void;
  getCachedBook(tokenId: string): OrderBook | null;
  cachedTokens(): string[];
  stats(): BookPipelineStats;
}

interface QueuedDelta {
  readonly tokenId: string;
  readonly side: "BUY" | "SELL";
  readonly price: string;
  readonly size: string;
  readonly sourceTs: Date | null;
  readonly receivedAt: Date;
  readonly ingestLagMs: number | null;
}

interface MinuteAccumulator {
  bucketStartMs: number;
  open: bigint; // mid, scale 10
  high: bigint;
  low: bigint;
  close: bigint;
  hasMid: boolean;
  bestBid: string | null;
  bestAsk: string | null;
  spread: string | null;
  bidDepth: readonly [string, string, string] | null; // top1/5/10
  askDepth: readonly [string, string, string] | null;
  updates: number;
}

function depthSums(
  levels: readonly PriceLevel[],
): readonly [string, string, string] {
  let sum = 0n;
  let top1 = 0n;
  let top5 = 0n;
  for (let i = 0; i < levels.length && i < 10; i += 1) {
    sum += toScaled(levels[i]?.size ?? "0");
    if (i === 0) {
      top1 = sum;
    }
    if (i === 4) {
      top5 = sum;
    }
  }
  if (levels.length < 5) {
    top5 = sum;
  }
  return [fromScaled(top1), fromScaled(top5), fromScaled(sum)];
}

export function createBookPipeline(deps: BookPipelineDeps): BookPipeline {
  const pool = deps.pool;
  const clock = deps.clock ?? ((): number => Date.now());
  const anchorIntervalMs = deps.anchorIntervalMs ?? DEFAULT_ANCHOR_INTERVAL_MS;
  const deltaBatchSize = deps.deltaBatchSize ?? DEFAULT_DELTA_BATCH_SIZE;
  const deltaFlushMs = deps.deltaFlushMs ?? DEFAULT_DELTA_FLUSH_MS;
  const deltaQueueMax = deps.deltaQueueMax ?? DEFAULT_DELTA_QUEUE_MAX;
  const throttle = new SnapshotThrottle(deps.snapshotIntervalMs);

  const books = new Map<string, OrderBook>();
  const conditionByToken = new Map<string, string>();
  const seenTokens = new Set<string>();
  const lastPersistedVenueHash = new Map<string, string>();
  const resyncSignaled = new Set<string>();
  const lastAnchorMs = new Map<string, number>();
  const minuteAccs = new Map<string, MinuteAccumulator>();

  let deltaQueue: QueuedDelta[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  // Serializes async flushes so batches never interleave.
  let flushChain: Promise<void> = Promise.resolve();
  // Serializes message processing (handleMessage/seedBook) so cache and
  // accumulator mutations always apply in arrival order, even when the
  // orchestrator fires handleMessage without awaiting it. flushDeltas and
  // flushMinute stay OFF this chain (they only read/persist), so awaiting a
  // flush from inside the chain can never deadlock.
  let messageChain: Promise<void> = Promise.resolve();

  function enqueueOnMessageChain(task: () => Promise<void>): Promise<void> {
    // Every task already catches internally; this catch is a belt-and-braces
    // guard so the chain (and thus handleMessage's result) NEVER rejects.
    messageChain = messageChain.then(task).catch((error: unknown) => {
      logJson(
        "error",
        "BOOKPIPE_CHAIN_FAILED",
        "polymarket_bookpipe_chain_failed",
        {
          error_name: error instanceof Error ? error.name : "UnknownError",
        },
      );
    });
    return messageChain;
  }

  let insertFailures = 0;
  let hashDivergences = 0;
  let overflowDropped = 0;
  let deltasFlushed = 0;
  let fullSnapshots = 0;
  let topSnapshots = 0;
  let minuteUpserts = 0;

  function ingestLag(sourceTs: Date | null, nowMs: number): number | null {
    if (sourceTs === null) {
      return null;
    }
    return Math.trunc(nowMs - sourceTs.getTime());
  }

  async function persist(
    label: string,
    text: string,
    params: readonly unknown[],
  ): Promise<boolean> {
    // A persistence failure must never take the pipeline down (regression of
    // the source_ts crash-loop, commit 350d3c9): log, count, keep going.
    try {
      await pool.query(text, params);
      return true;
    } catch (error) {
      insertFailures += 1;
      logJson(
        "error",
        "BOOKPIPE_PERSIST_FAILED",
        "polymarket_bookpipe_persist_failed",
        {
          insert: label,
          error_name: error instanceof Error ? error.name : "UnknownError",
        },
      );
      return false;
    }
  }

  async function insertFullSnapshot(
    tokenId: string,
    reason: "subscribe" | "resync" | "anchor",
    bookHash: string | null,
    bids: readonly PriceLevel[],
    asks: readonly PriceLevel[],
    sourceTs: Date | null,
  ): Promise<void> {
    const nowMs = clock();
    const ok = await persist(
      "polymarket_book_snapshots_full",
      `INSERT INTO polymarket_book_snapshots_full
         (token_id, reason, book_hash, bids_json, asks_json, source_ts, received_at, ingest_lag_ms)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)`,
      [
        tokenId,
        reason,
        bookHash,
        JSON.stringify(bids),
        JSON.stringify(asks),
        sourceTs,
        new Date(nowMs),
        ingestLag(sourceTs, nowMs),
      ],
    );
    if (ok) {
      fullSnapshots += 1;
    }
    lastAnchorMs.set(tokenId, nowMs);
  }

  async function insertTopSnapshot(
    tokenId: string,
    sourceTsRaw: string | null,
  ): Promise<void> {
    const book = books.get(tokenId);
    if (book === undefined || !throttle.shouldPersist(tokenId, clock())) {
      return;
    }
    const ok = await persist(
      "polymarket_book_snapshots",
      `INSERT INTO polymarket_book_snapshots
         (token_id, condition_id, source_ts, bids_json, asks_json)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)`,
      [
        tokenId,
        conditionByToken.get(tokenId) ?? null,
        sourceTsToDate(sourceTsRaw),
        JSON.stringify(book.topBids()),
        JSON.stringify(book.topAsks()),
      ],
    );
    if (ok) {
      topSnapshots += 1;
    }
  }

  async function flushDeltaBatch(): Promise<void> {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const batch = deltaQueue;
    const first = batch[0];
    if (first === undefined) {
      return;
    }
    const last = batch[batch.length - 1] ?? first;
    deltaQueue = [];
    const values: string[] = [];
    const params: unknown[] = [];
    for (const delta of batch) {
      const base = params.length;
      values.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`,
      );
      params.push(
        delta.tokenId,
        delta.side,
        delta.price,
        delta.size,
        delta.sourceTs,
        delta.receivedAt,
        delta.ingestLagMs,
      );
    }
    const ok = await persist(
      "polymarket_book_deltas",
      `INSERT INTO polymarket_book_deltas
         (token_id, side, price, size, source_ts, received_at, ingest_lag_ms)
       VALUES ${values.join(",")}`,
      params,
    );
    if (ok) {
      deltasFlushed += batch.length;
    } else {
      // The batch is lost definitively (no retry): after the persist-failure
      // log above, hand the caller the exact window so a gap gets recorded.
      deps.onPersistFailure?.({
        count: batch.length,
        firstReceivedAt: first.receivedAt,
        lastReceivedAt: last.receivedAt,
      });
    }
  }

  function scheduleFlush(): Promise<void> {
    flushChain = flushChain.then(() => flushDeltaBatch());
    return flushChain;
  }

  function enqueueDelta(delta: QueuedDelta): Promise<void> {
    deltaQueue.push(delta);
    if (deltaQueue.length > deltaQueueMax) {
      // Backpressure: shed the OLDEST entries and tell the caller exactly how
      // many were lost so a data gap (source 'internal') gets recorded.
      const excess = deltaQueue.length - deltaQueueMax;
      deltaQueue.splice(0, excess);
      overflowDropped += excess;
      logJson(
        "warn",
        "BOOKPIPE_DELTA_OVERFLOW",
        "polymarket_bookpipe_delta_overflow",
        {
          dropped: excess,
        },
      );
      deps.onOverflow?.(excess);
    }
    if (deltaQueue.length >= deltaBatchSize) {
      return scheduleFlush();
    }
    if (flushTimer === null) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void scheduleFlush();
      }, deltaFlushMs);
    }
    return Promise.resolve();
  }

  async function upsertMinute(
    tokenId: string,
    acc: MinuteAccumulator,
  ): Promise<void> {
    const ok = await persist(
      "polymarket_series_1m",
      `INSERT INTO polymarket_series_1m
         (token_id, bucket_start, mid_open, mid_high, mid_low, mid_close,
          best_bid, best_ask, spread,
          bid_depth_top1, bid_depth_top5, bid_depth_top10,
          ask_depth_top1, ask_depth_top5, ask_depth_top10, updates_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (token_id, bucket_start) DO UPDATE SET
         mid_open = EXCLUDED.mid_open,
         mid_high = EXCLUDED.mid_high,
         mid_low = EXCLUDED.mid_low,
         mid_close = EXCLUDED.mid_close,
         best_bid = EXCLUDED.best_bid,
         best_ask = EXCLUDED.best_ask,
         spread = EXCLUDED.spread,
         bid_depth_top1 = EXCLUDED.bid_depth_top1,
         bid_depth_top5 = EXCLUDED.bid_depth_top5,
         bid_depth_top10 = EXCLUDED.bid_depth_top10,
         ask_depth_top1 = EXCLUDED.ask_depth_top1,
         ask_depth_top5 = EXCLUDED.ask_depth_top5,
         ask_depth_top10 = EXCLUDED.ask_depth_top10,
         updates_count = EXCLUDED.updates_count,
         received_at = CURRENT_TIMESTAMP`,
      [
        tokenId,
        new Date(acc.bucketStartMs),
        acc.hasMid ? fromScaled(acc.open, MID_SCALE) : null,
        acc.hasMid ? fromScaled(acc.high, MID_SCALE) : null,
        acc.hasMid ? fromScaled(acc.low, MID_SCALE) : null,
        acc.hasMid ? fromScaled(acc.close, MID_SCALE) : null,
        acc.bestBid,
        acc.bestAsk,
        acc.spread,
        acc.bidDepth?.[0] ?? null,
        acc.bidDepth?.[1] ?? null,
        acc.bidDepth?.[2] ?? null,
        acc.askDepth?.[0] ?? null,
        acc.askDepth?.[1] ?? null,
        acc.askDepth?.[2] ?? null,
        acc.updates,
      ],
    );
    if (ok) {
      minuteUpserts += 1;
    }
  }

  async function updateMinute(tokenId: string): Promise<void> {
    const book = books.get(tokenId);
    if (book === undefined) {
      return;
    }
    const nowMs = clock();
    const bucketStartMs = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;
    const previous = minuteAccs.get(tokenId);
    let acc: MinuteAccumulator;
    let sealed: MinuteAccumulator | undefined;
    if (previous !== undefined && previous.bucketStartMs === bucketStartMs) {
      acc = previous;
    } else {
      // Bucket rollover (or first update): install the new accumulator
      // SYNCHRONOUSLY — before any await — so a concurrent flushMinute never
      // observes a window where the current bucket is missing. The previous
      // minute is sealed (upserted) after the mutations below.
      sealed = previous;
      acc = {
        bucketStartMs,
        open: 0n,
        high: 0n,
        low: 0n,
        close: 0n,
        hasMid: false,
        bestBid: null,
        bestAsk: null,
        spread: null,
        bidDepth: null,
        askDepth: null,
        updates: 0,
      };
      minuteAccs.set(tokenId, acc);
    }
    const bestBid = book.bestBid();
    const bestAsk = book.bestAsk();
    if (bestBid !== null && bestAsk !== null) {
      const mid = midScaled10(bestBid.price, bestAsk.price);
      if (!acc.hasMid) {
        acc.open = mid;
        acc.high = mid;
        acc.low = mid;
        acc.hasMid = true;
      } else {
        if (mid > acc.high) {
          acc.high = mid;
        }
        if (mid < acc.low) {
          acc.low = mid;
        }
      }
      acc.close = mid;
      acc.spread = fromScaled(
        toScaled(bestAsk.price) - toScaled(bestBid.price),
      );
    }
    acc.bestBid = bestBid?.price ?? null;
    acc.bestAsk = bestAsk?.price ?? null;
    acc.bidDepth = depthSums(book.topBids());
    acc.askDepth = depthSums(book.topAsks());
    acc.updates += 1;
    if (sealed !== undefined) {
      // Seal the previous minute (all cache/accumulator mutations are done).
      await upsertMinute(tokenId, sealed);
    }
  }

  async function handleBook(
    msg: Extract<MarketMessage, { event_type: "book" }>,
  ): Promise<void> {
    const tokenId = msg.asset_id;
    conditionByToken.set(tokenId, msg.market);
    const cached = books.get(tokenId);
    if (cached !== undefined) {
      // Consistency check: the delta-maintained cache vs the fresh snapshot.
      // A mismatch means we missed deltas; the incoming book IS the re-sync,
      // so we count the divergence and let it replace the cache.
      const localHash = localBookHash(
        cached.topBids(FULL_DEPTH),
        cached.topAsks(FULL_DEPTH),
      );
      const incoming = OrderBook.fromMessage(msg);
      const incomingHash = localBookHash(
        incoming.topBids(FULL_DEPTH),
        incoming.topAsks(FULL_DEPTH),
      );
      if (localHash !== incomingHash) {
        hashDivergences += 1;
        logJson("warn", "BOOK_DIVERGENCE", "polymarket_bookpipe_divergence", {
          token_id: tokenId,
        });
      }
    }
    const book = OrderBook.fromMessage(msg);
    books.set(tokenId, book);
    resyncSignaled.delete(tokenId);

    let reason: "subscribe" | "resync" | "anchor";
    if (!seenTokens.has(tokenId)) {
      reason = "subscribe";
      seenTokens.add(tokenId);
    } else {
      // Requested re-syncs and unsolicited re-books both replace the cache.
      reason = "resync";
    }
    // The dual connections (and venue re-sends) deliver identical books with
    // the same venue hash; persist each distinct book once per token. Books
    // without a venue hash are never deduped.
    const duplicateBook =
      reason === "resync" &&
      msg.hash !== "" &&
      lastPersistedVenueHash.get(tokenId) === msg.hash;
    if (!duplicateBook) {
      await insertFullSnapshot(
        tokenId,
        reason,
        msg.hash,
        book.topBids(FULL_DEPTH),
        book.topAsks(FULL_DEPTH),
        sourceTsToDate(msg.timestamp),
      );
      if (msg.hash !== "") {
        lastPersistedVenueHash.set(tokenId, msg.hash);
      }
    }
    await insertTopSnapshot(tokenId, msg.timestamp);
    await updateMinute(tokenId);
  }

  async function anchorIfDue(tokenId: string): Promise<void> {
    const book = books.get(tokenId);
    if (book === undefined) {
      return;
    }
    const last = lastAnchorMs.get(tokenId);
    if (last !== undefined && clock() - last < anchorIntervalMs) {
      return;
    }
    const bids = book.topBids(FULL_DEPTH);
    const asks = book.topAsks(FULL_DEPTH);
    await insertFullSnapshot(
      tokenId,
      "anchor",
      localBookHash(bids, asks),
      bids,
      asks,
      null,
    );
  }

  async function handlePriceChange(
    msg: Extract<MarketMessage, { event_type: "price_change" }>,
  ): Promise<void> {
    const nowMs = clock();
    const sourceTs = sourceTsToDate(msg.timestamp);
    const lag = ingestLag(sourceTs, nowMs);
    const touched = new Set<string>();
    for (const change of msg.price_changes) {
      await enqueueDelta({
        tokenId: change.asset_id,
        side: change.side,
        price: change.price,
        size: change.size,
        sourceTs,
        receivedAt: new Date(nowMs),
        ingestLagMs: lag,
      });
      const book = books.get(change.asset_id);
      if (book === undefined) {
        // No anchor to apply against: ask the caller for a REST re-sync
        // (signal once per token until a book event restores the cache).
        if (!resyncSignaled.has(change.asset_id)) {
          resyncSignaled.add(change.asset_id);
          deps.onResyncNeeded?.(change.asset_id);
        }
        continue;
      }
      conditionByToken.set(change.asset_id, msg.market);
      book.applyPriceChange(change);
      touched.add(change.asset_id);
    }
    for (const tokenId of touched) {
      await insertTopSnapshot(tokenId, msg.timestamp);
      await updateMinute(tokenId);
      await anchorIfDue(tokenId);
    }
  }

  async function processMessage(msg: MarketMessage): Promise<void> {
    // The pipeline never throws upward: every persist path already catches,
    // and this guard covers anything unexpected in the bookkeeping itself.
    try {
      if (msg.event_type === "book") {
        await handleBook(msg);
      } else if (msg.event_type === "price_change") {
        await handlePriceChange(msg);
      }
      // last_trade_price / tick_size_change belong to other RFC-007 modules.
    } catch (error) {
      insertFailures += 1;
      logJson(
        "error",
        "BOOKPIPE_HANDLE_FAILED",
        "polymarket_bookpipe_handle_failed",
        {
          event_type: msg.event_type,
          error_name: error instanceof Error ? error.name : "UnknownError",
        },
      );
    }
  }

  return {
    handleMessage(msg: MarketMessage): Promise<void> {
      // Serialized on a single chain: the orchestrator calls this
      // fire-and-forget, and processing has awaits, so without the chain two
      // price_changes could apply to the cache out of arrival order. The
      // returned promise is this message's slot in the queue; it never
      // rejects (processMessage catches, plus the chain's own guard).
      return enqueueOnMessageChain(() => processMessage(msg));
    },
    seedBook(
      tokenId: string,
      bids: PriceLevel[],
      asks: PriceLevel[],
      sourceTs: Date | null,
    ): Promise<void> {
      // REST /book re-sync: replaces the cache, persists a 'resync' full
      // snapshot WITHOUT a venue hash (so it is never deduped) and clears
      // the pending-resync state. Runs on the message chain so it cannot
      // interleave with in-flight WS messages.
      return enqueueOnMessageChain(async () => {
        try {
          const book = new OrderBook();
          book.replace(bids, asks);
          books.set(tokenId, book);
          seenTokens.add(tokenId);
          resyncSignaled.delete(tokenId);
          // No venue hash on a REST seed: drop the dedup marker so the next
          // venue book event always persists.
          lastPersistedVenueHash.delete(tokenId);
          await insertFullSnapshot(
            tokenId,
            "resync",
            null,
            book.topBids(FULL_DEPTH),
            book.topAsks(FULL_DEPTH),
            sourceTs,
          );
        } catch (error) {
          insertFailures += 1;
          logJson(
            "error",
            "BOOKPIPE_SEED_FAILED",
            "polymarket_bookpipe_seed_failed",
            {
              token_id: tokenId,
              error_name: error instanceof Error ? error.name : "UnknownError",
            },
          );
        }
      });
    },
    async flushDeltas(): Promise<void> {
      await scheduleFlush();
    },
    async flushMinute(): Promise<void> {
      const currentBucket = Math.floor(clock() / MINUTE_MS) * MINUTE_MS;
      for (const [tokenId, acc] of [...minuteAccs.entries()]) {
        await upsertMinute(tokenId, acc);
        // Delete only sealed PAST buckets, and only while the map still
        // holds this exact accumulator: during the await above a concurrent
        // rollover (on the message chain) may have installed the current
        // minute's fresh accumulator under the same key — deleting by key
        // alone would silently drop that bucket's mid_open.
        if (
          acc.bucketStartMs < currentBucket &&
          minuteAccs.get(tokenId) === acc
        ) {
          minuteAccs.delete(tokenId);
        }
      }
    },
    async runAnchorPass(): Promise<void> {
      for (const tokenId of books.keys()) {
        await anchorIfDue(tokenId);
      }
    },
    requestResync(tokenId: string): void {
      // Force the token out of "first time" mode so the next book is 'resync'.
      seenTokens.add(tokenId);
    },
    getCachedBook(tokenId: string): OrderBook | null {
      return books.get(tokenId) ?? null;
    },
    cachedTokens(): string[] {
      return [...books.keys()];
    },
    stats(): BookPipelineStats {
      return {
        insertFailures,
        hashDivergences,
        overflowDropped,
        deltasFlushed,
        deltasQueued: deltaQueue.length,
        fullSnapshots,
        topSnapshots,
        minuteUpserts,
      };
    },
  };
}
