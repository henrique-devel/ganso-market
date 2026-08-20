import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryResult, SqlExecutor } from "../../src/database.js";
import { OrderBook } from "../../src/polymarket/book.js";
import {
  createBookPipeline,
  localBookHash,
} from "../../src/polymarket/bookpipe.js";
import { parseMarketFrame } from "../../src/polymarket/messages.js";
import type {
  BookMessage,
  MarketMessage,
  PriceChangeMessage,
  PriceLevel,
} from "../../src/polymarket/types.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

const bookMessage = parseMarketFrame(
  fixture("bookpipe-book.json"),
)[0] as BookMessage;
const priceChangeMessages = parseMarketFrame(
  fixture("bookpipe-price-change.json"),
) as PriceChangeMessage[];
const tickSizeMessage = parseMarketFrame(
  fixture("bookpipe-tick-size-change.json"),
)[0] as MarketMessage;

const TOKEN = bookMessage.asset_id;

interface CapturedQuery {
  readonly text: string;
  readonly params: unknown[];
}

function makePool(options?: { failing?: boolean }): {
  pool: SqlExecutor;
  captured: CapturedQuery[];
} {
  const captured: CapturedQuery[] = [];
  const pool: SqlExecutor = {
    query<R extends Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      if (options?.failing === true) {
        return Promise.reject(new Error("db down"));
      }
      captured.push({ text, params: [...(params ?? [])] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  return { pool, captured };
}

function ofTable(captured: CapturedQuery[], table: string): CapturedQuery[] {
  return captured.filter((entry) => entry.text.includes(table));
}

interface DeltaRow {
  readonly tokenId: string;
  readonly side: "BUY" | "SELL";
  readonly price: string;
  readonly size: string;
}

function deltaRows(captured: CapturedQuery[]): DeltaRow[] {
  const rows: DeltaRow[] = [];
  for (const insert of ofTable(captured, "polymarket_book_deltas")) {
    for (let i = 0; i < insert.params.length; i += 7) {
      rows.push({
        tokenId: insert.params[i] as string,
        side: insert.params[i + 1] as "BUY" | "SELL",
        price: insert.params[i + 2] as string,
        size: insert.params[i + 3] as string,
      });
    }
  }
  return rows;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("book pipeline: snapshot + deltas recomposition", () => {
  it("recomposes the book byte-for-byte from the persisted snapshot and deltas", async () => {
    const { pool, captured } = makePool();
    let now = 1_787_098_643_500;
    const pipeline = createBookPipeline({ pool, clock: () => now });

    await pipeline.handleMessage(bookMessage);
    for (const msg of priceChangeMessages) {
      now += 1_000;
      await pipeline.handleMessage(msg);
    }
    await pipeline.flushDeltas();

    // Full snapshot persisted with reason 'subscribe' and the venue hash.
    const fullInserts = ofTable(captured, "polymarket_book_snapshots_full");
    expect(fullInserts).toHaveLength(1);
    const snapshot = fullInserts[0];
    expect(snapshot?.params[1]).toBe("subscribe");
    expect(snapshot?.params[2]).toBe(bookMessage.hash);
    expect(snapshot?.params[5]).toBeInstanceOf(Date);
    expect((snapshot?.params[5] as Date).getTime()).toBe(1_787_098_643_398);

    // Recompose: stored snapshot + stored deltas, applied in order.
    const recomposed = new OrderBook();
    recomposed.replace(
      JSON.parse(snapshot?.params[3] as string) as PriceLevel[],
      JSON.parse(snapshot?.params[4] as string) as PriceLevel[],
    );
    for (const row of deltaRows(captured)) {
      recomposed.applyPriceChange({
        asset_id: row.tokenId,
        price: row.price,
        size: row.size,
        side: row.side,
      });
    }

    // Reference: an OrderBook fed the same messages directly.
    const reference = OrderBook.fromMessage(bookMessage);
    for (const msg of priceChangeMessages) {
      for (const change of msg.price_changes) {
        reference.applyPriceChange(change);
      }
    }

    const depth = Number.MAX_SAFE_INTEGER;
    expect(
      localBookHash(recomposed.topBids(depth), recomposed.topAsks(depth)),
    ).toBe(localBookHash(reference.topBids(depth), reference.topAsks(depth)));
    const cached = pipeline.getCachedBook(TOKEN);
    expect(cached).not.toBeNull();
    expect(
      localBookHash(cached?.topBids(depth) ?? [], cached?.topAsks(depth) ?? []),
    ).toBe(localBookHash(reference.topBids(depth), reference.topAsks(depth)));
    expect(pipeline.cachedTokens()).toEqual([TOKEN]);
  });

  it("handles duplicated, out-of-order and size=0 deltas idempotently", async () => {
    const { pool } = makePool();
    const pipeline = createBookPipeline({ pool, clock: () => 0 });
    await pipeline.handleMessage(bookMessage);

    const scrambled: PriceChangeMessage = {
      event_type: "price_change",
      market: bookMessage.market,
      timestamp: "1787098646789",
      price_changes: [
        // Out of order relative to the fixture, plus a duplicate.
        { asset_id: TOKEN, price: "0.51", size: "12.5", side: "BUY" },
        { asset_id: TOKEN, price: "0.52", size: "0", side: "SELL" },
        { asset_id: TOKEN, price: "0.50", size: "0", side: "BUY" },
        { asset_id: TOKEN, price: "0.51", size: "12.5", side: "BUY" },
      ],
    };
    await pipeline.handleMessage(scrambled);

    const reference = OrderBook.fromMessage(bookMessage);
    for (const msg of priceChangeMessages) {
      for (const change of msg.price_changes) {
        reference.applyPriceChange(change);
      }
    }
    const cached = pipeline.getCachedBook(TOKEN);
    const depth = Number.MAX_SAFE_INTEGER;
    expect(
      localBookHash(cached?.topBids(depth) ?? [], cached?.topAsks(depth) ?? []),
    ).toBe(localBookHash(reference.topBids(depth), reference.topAsks(depth)));
    // The size=0 deltas removed their levels.
    expect(cached?.topBids(depth).some((level) => level.price === "0.50")).toBe(
      false,
    );
    expect(cached?.topAsks(depth).some((level) => level.price === "0.52")).toBe(
      false,
    );
  });

  it("ignores tick_size_change without touching the cache", async () => {
    const { pool, captured } = makePool();
    const pipeline = createBookPipeline({ pool, clock: () => 0 });
    await pipeline.handleMessage(bookMessage);
    const before = captured.length;
    await pipeline.handleMessage(tickSizeMessage);
    expect(captured.length).toBe(before);
  });
});

describe("book pipeline: delta batching", () => {
  it("flushes one multi-VALUES insert when the batch size is reached", async () => {
    const { pool, captured } = makePool();
    const pipeline = createBookPipeline({
      pool,
      clock: () => 0,
      deltaBatchSize: 3,
      deltaFlushMs: 60_000,
    });
    await pipeline.handleMessage(bookMessage);

    const msg: PriceChangeMessage = {
      event_type: "price_change",
      market: bookMessage.market,
      timestamp: "1787098645123",
      price_changes: [
        { asset_id: TOKEN, price: "0.47", size: "1", side: "BUY" },
        { asset_id: TOKEN, price: "0.46", size: "2", side: "BUY" },
        { asset_id: TOKEN, price: "0.45", size: "3", side: "BUY" },
      ],
    };
    await pipeline.handleMessage(msg);
    await pipeline.flushDeltas();

    const inserts = ofTable(captured, "polymarket_book_deltas");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.params).toHaveLength(21);
    expect(inserts[0]?.text).toContain("$15");
    expect(pipeline.stats().deltasFlushed).toBe(3);
  });

  it("flushes by timer when the batch stays under the size threshold", async () => {
    const { pool, captured } = makePool();
    const pipeline = createBookPipeline({
      pool,
      clock: () => 0,
      deltaBatchSize: 100,
      deltaFlushMs: 250,
    });
    await pipeline.handleMessage(bookMessage);
    await pipeline.handleMessage(priceChangeMessages[0] as PriceChangeMessage);
    expect(ofTable(captured, "polymarket_book_deltas")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(250);
    expect(ofTable(captured, "polymarket_book_deltas")).toHaveLength(1);
    expect(pipeline.stats().deltasQueued).toBe(0);
  });

  it("sheds the oldest entries on overflow and reports the exact count", async () => {
    const { pool, captured } = makePool();
    let dropped = 0;
    let overflowCalls = 0;
    const pipeline = createBookPipeline({
      pool,
      clock: () => 0,
      deltaBatchSize: 100,
      deltaFlushMs: 60_000,
      deltaQueueMax: 5,
      onOverflow: (count) => {
        dropped += count;
        overflowCalls += 1;
      },
    });
    await pipeline.handleMessage(bookMessage);

    const changes = Array.from({ length: 8 }, (_, i) => ({
      asset_id: TOKEN,
      price: `0.4${i}`,
      size: String(i + 1),
      side: "BUY" as const,
    }));
    await pipeline.handleMessage({
      event_type: "price_change",
      market: bookMessage.market,
      timestamp: "1787098645123",
      price_changes: changes,
    });

    expect(dropped).toBe(3);
    expect(overflowCalls).toBe(3);
    expect(pipeline.stats().overflowDropped).toBe(3);

    await pipeline.flushDeltas();
    // The 5 NEWEST deltas survive; the 3 oldest were shed.
    const rows = deltaRows(captured);
    expect(rows.map((row) => row.price)).toEqual([
      "0.43",
      "0.44",
      "0.45",
      "0.46",
      "0.47",
    ]);
  });
});

describe("book pipeline: anchors, resync and divergence", () => {
  it("persists a periodic 'anchor' full snapshot per active token", async () => {
    const { pool, captured } = makePool();
    let now = 0;
    const pipeline = createBookPipeline({
      pool,
      clock: () => now,
      anchorIntervalMs: 60_000,
      deltaFlushMs: 60_000,
    });
    await pipeline.handleMessage(bookMessage);
    expect(ofTable(captured, "polymarket_book_snapshots_full")).toHaveLength(1);

    now = 61_000;
    await pipeline.handleMessage(priceChangeMessages[0] as PriceChangeMessage);
    const fullInserts = ofTable(captured, "polymarket_book_snapshots_full");
    expect(fullInserts).toHaveLength(2);
    const anchor = fullInserts[1];
    expect(anchor?.params[1]).toBe("anchor");
    // Anchor hash is the local canonical hash of the cached book.
    const cached = pipeline.getCachedBook(TOKEN);
    const depth = Number.MAX_SAFE_INTEGER;
    expect(anchor?.params[2]).toBe(
      localBookHash(cached?.topBids(depth) ?? [], cached?.topAsks(depth) ?? []),
    );

    // runAnchorPass anchors overdue tokens too.
    now = 130_000;
    await pipeline.runAnchorPass();
    expect(ofTable(captured, "polymarket_book_snapshots_full")).toHaveLength(3);
  });

  it("marks the next book after requestResync with reason 'resync'", async () => {
    const { pool, captured } = makePool();
    const pipeline = createBookPipeline({ pool, clock: () => 0 });
    pipeline.requestResync(TOKEN);
    await pipeline.handleMessage(bookMessage);
    const fullInserts = ofTable(captured, "polymarket_book_snapshots_full");
    expect(fullInserts[0]?.params[1]).toBe("resync");
  });

  it("counts a divergence when the cached book differs from a fresh book event", async () => {
    const { pool } = makePool();
    const pipeline = createBookPipeline({ pool, clock: () => 0 });
    await pipeline.handleMessage(bookMessage);
    await pipeline.handleMessage(priceChangeMessages[0] as PriceChangeMessage);
    // The venue resends the original book: our cache diverged (we applied a
    // delta the snapshot does not include).
    await pipeline.handleMessage(bookMessage);
    expect(pipeline.stats().hashDivergences).toBe(1);
    // Identical re-book right after: no divergence.
    await pipeline.handleMessage(bookMessage);
    expect(pipeline.stats().hashDivergences).toBe(1);
  });

  it("asks for a resync when a delta arrives for a token with no cached book", async () => {
    const { pool } = makePool();
    const requested: string[] = [];
    const pipeline = createBookPipeline({
      pool,
      clock: () => 0,
      onResyncNeeded: (tokenId) => {
        requested.push(tokenId);
      },
    });
    const msg = priceChangeMessages[1] as PriceChangeMessage;
    await pipeline.handleMessage(msg);
    await pipeline.handleMessage(msg);
    // Signalled once per token until a book event restores the cache.
    expect(requested).toEqual([TOKEN]);
  });
});

describe("book pipeline: 1-minute aggregates", () => {
  it("computes OHLC mid, close best bid/ask, spread and depth for a synthetic minute", async () => {
    const { pool, captured } = makePool();
    let now = 1_000;
    const pipeline = createBookPipeline({
      pool,
      clock: () => now,
      anchorIntervalMs: 600_000,
      deltaFlushMs: 60_000,
      deltaBatchSize: 1_000,
    });

    // t=1s: bb 0.50 / ba 0.52 -> mid 0.51 (open).
    await pipeline.handleMessage(bookMessage);
    // t=2s: remove bid 0.50 -> bb 0.49, mid 0.505 (low).
    now = 2_000;
    await pipeline.handleMessage(priceChangeMessages[0] as PriceChangeMessage);
    // t=3s: add bid 0.51 and remove ask 0.52 -> bb 0.51 / ba 0.53, mid 0.52
    // (high, close).
    now = 3_000;
    await pipeline.handleMessage(priceChangeMessages[1] as PriceChangeMessage);

    now = 5_000;
    await pipeline.flushMinute();

    const upserts = ofTable(captured, "polymarket_series_1m");
    expect(upserts).toHaveLength(1);
    const params = upserts[0]?.params ?? [];
    expect(params[0]).toBe(TOKEN);
    expect((params[1] as Date).getTime()).toBe(0);
    expect(params[2]).toBe("0.51"); // mid_open
    expect(params[3]).toBe("0.52"); // mid_high
    expect(params[4]).toBe("0.505"); // mid_low
    expect(params[5]).toBe("0.52"); // mid_close
    expect(params[6]).toBe("0.51"); // best_bid
    expect(params[7]).toBe("0.53"); // best_ask
    expect(params[8]).toBe("0.02"); // spread
    // Bids at close: 0.51/12.5, 0.49/20, 0.48/30.
    expect(params[9]).toBe("12.5");
    expect(params[10]).toBe("62.5");
    expect(params[11]).toBe("62.5");
    // Asks at close: 0.53/60, 0.54/10.
    expect(params[12]).toBe("60");
    expect(params[13]).toBe("70");
    expect(params[14]).toBe("70");
    expect(params[15]).toBe(3); // updates_count
  });

  it("seals the previous bucket on rollover and starts a fresh one", async () => {
    const { pool, captured } = makePool();
    let now = 1_000;
    const pipeline = createBookPipeline({
      pool,
      clock: () => now,
      anchorIntervalMs: 600_000,
      deltaFlushMs: 600_000,
      deltaBatchSize: 1_000,
    });
    await pipeline.handleMessage(bookMessage);

    // Next minute: the first update flushes bucket 0 and opens bucket 60s.
    now = 61_000;
    await pipeline.handleMessage(priceChangeMessages[0] as PriceChangeMessage);
    const upserts = ofTable(captured, "polymarket_series_1m");
    expect(upserts).toHaveLength(1);
    expect((upserts[0]?.params[1] as Date).getTime()).toBe(0);
    expect(upserts[0]?.params[15]).toBe(1);

    await pipeline.flushMinute();
    const all = ofTable(captured, "polymarket_series_1m");
    expect(all).toHaveLength(2);
    expect((all[1]?.params[1] as Date).getTime()).toBe(60_000);
    // New bucket opened at the post-delta mid (0.49+0.52)/2.
    expect(all[1]?.params[2]).toBe("0.505");
  });
});

describe("book pipeline: persistence failures never propagate", () => {
  it("resolves handleMessage and counts failures when every insert rejects", async () => {
    const { pool } = makePool({ failing: true });
    const pipeline = createBookPipeline({
      pool,
      clock: () => 0,
      deltaBatchSize: 1,
    });
    await expect(pipeline.handleMessage(bookMessage)).resolves.toBeUndefined();
    await expect(
      pipeline.handleMessage(priceChangeMessages[0] as PriceChangeMessage),
    ).resolves.toBeUndefined();
    await pipeline.flushDeltas();
    await pipeline.flushMinute();
    expect(pipeline.stats().insertFailures).toBeGreaterThanOrEqual(3);
    // The cache stays usable despite the failures.
    expect(pipeline.getCachedBook(TOKEN)).not.toBeNull();
  });
});
