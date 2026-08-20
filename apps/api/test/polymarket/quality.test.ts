import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryResult } from "../../src/database.js";
import {
  BUDGET_BYTES,
  createFeedHealth,
  createGapWriter,
  createReconciler,
  metricsSnapshot,
  type CachedBook,
} from "../../src/polymarket/quality.js";

interface CapturedQuery {
  readonly text: string;
  readonly params: unknown[];
}

type Responder = (
  text: string,
  params: readonly unknown[],
) => QueryResult<never> | null;

function fakePool(responder?: Responder): {
  captured: CapturedQuery[];
  query: <R extends Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ) => Promise<QueryResult<R>>;
} {
  const captured: CapturedQuery[] = [];
  return {
    captured,
    query<R extends Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      captured.push({ text, params: [...(params ?? [])] });
      const canned = responder?.(text, params ?? []);
      return Promise.resolve(
        (canned as QueryResult<R> | null) ?? { rows: [], rowCount: 0 },
      );
    },
  };
}

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

describe("gap writer", () => {
  it("opens a gap and returns the gap_id from RETURNING", async () => {
    const pool = fakePool((text) =>
      text.includes("RETURNING gap_id")
        ? ({
            rows: [{ gap_id: "77" }],
            rowCount: 1,
          } as unknown as QueryResult<never>)
        : null,
    );
    const writer = createGapWriter(pool);
    const start = new Date("2026-08-19T00:00:00Z");
    const gapId = await writer.openGap({
      source: "clob_ws",
      tokenId: "111",
      cause: "ws_disconnect",
      details: { conn: 1 },
      start,
    });
    expect(gapId).toBe(77);
    const insert = pool.captured[0];
    expect(insert?.text).toContain("INSERT INTO polymarket_data_gaps");
    expect(insert?.params).toEqual([
      "clob_ws",
      "111",
      start,
      "ws_disconnect",
      JSON.stringify({ conn: 1 }),
    ]);
  });

  it("closes a gap with an UPDATE on gap_end", async () => {
    const pool = fakePool();
    const writer = createGapWriter(pool);
    const end = new Date("2026-08-19T01:00:00Z");
    await writer.closeGap(42, end);
    const update = pool.captured[0];
    expect(update?.text).toContain("UPDATE polymarket_data_gaps");
    expect(update?.text).toContain("SET gap_end");
    expect(update?.params).toEqual([end, 42].reverse());
  });

  it("records an instant gap with start = end", async () => {
    const pool = fakePool((text) =>
      text.includes("RETURNING gap_id")
        ? ({
            rows: [{ gap_id: 5 }],
            rowCount: 1,
          } as unknown as QueryResult<never>)
        : null,
    );
    const writer = createGapWriter(pool);
    const at = new Date("2026-08-19T02:00:00Z");
    const gapId = await writer.recordInstantGap({
      source: "rtds",
      cause: "backpressure_drop",
      at,
    });
    expect(gapId).toBe(5);
    const insert = pool.captured[0];
    // start and end share the same parameter ($3 used twice).
    expect(insert?.text).toContain("VALUES ($1, $2, $3, $3, $4, $5::jsonb)");
    expect(insert?.params).toEqual([
      "rtds",
      null,
      at,
      "backpressure_drop",
      null,
    ]);
  });
});

describe("feed health", () => {
  it("reports ~100% uptime for a continuously heartbeating source", () => {
    let now = 0;
    const health = createFeedHealth(() => now, 60_000);
    for (let t = 0; t <= 600_000; t += 30_000) {
      now = t;
      health.heartbeat("clob_ws");
    }
    now = 600_000;
    const snapshot = health.snapshot();
    expect(snapshot.clob_ws?.uptimePct).toBeCloseTo(100, 5);
    expect(snapshot.clob_ws?.lastSeenMs).toBe(600_000);
  });

  it("counts a silence longer than the stale threshold as downtime", () => {
    let now = 0;
    const health = createFeedHealth(() => now, 60_000);
    health.heartbeat("rtds"); // covers [0, 60s)
    now = 300_000;
    health.heartbeat("rtds"); // covers [300s, 360s)
    now = 360_000;
    const snapshot = health.snapshot();
    // 120s covered out of 360s.
    expect(snapshot.rtds?.uptimePct).toBeCloseTo((120_000 / 360_000) * 100, 5);
    expect(snapshot.rtds?.lastSeenMs).toBe(300_000);
    expect(snapshot.rtds?.heartbeats).toBe(2);
  });

  it("tracks sources independently", () => {
    let now = 0;
    const health = createFeedHealth(() => now, 60_000);
    health.heartbeat("gamma");
    now = 30_000;
    const snapshot = health.snapshot();
    expect(snapshot.gamma).toBeDefined();
    expect(snapshot.rtds).toBeUndefined();
  });
});

describe("reconciler", () => {
  const cachedBook: CachedBook = {
    bids: [
      { price: "0.40", size: "10" },
      { price: "0.39", size: "5" },
    ],
    asks: [{ price: "0.60", size: "7" }],
    hashOf: "hash-a",
  };

  function restResponse(hash: string, bids: unknown, asks: unknown) {
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ hash, bids, asks }),
    };
  }

  it("does nothing when the REST book matches the cache by hash", async () => {
    const pool = fakePool();
    const resyncs: string[] = [];
    const reconciler = createReconciler({
      pool,
      fetcher: () =>
        Promise.resolve(
          restResponse("hash-a", cachedBook.bids, cachedBook.asks),
        ),
      getCachedBook: () => cachedBook,
      requestResync: (tokenId) => resyncs.push(tokenId),
      clock: () => 1_000,
    });
    const stats = await reconciler.reconcileOnce(["111"]);
    expect(stats).toEqual({ checked: 1, divergent: 0, skipped: 0 });
    expect(resyncs).toEqual([]);
    expect(pool.captured).toHaveLength(0);
  });

  it("requests a resync and records an instant gap on divergence", async () => {
    const pool = fakePool((text) =>
      text.includes("RETURNING gap_id")
        ? ({
            rows: [{ gap_id: 9 }],
            rowCount: 1,
          } as unknown as QueryResult<never>)
        : null,
    );
    const resyncs: string[] = [];
    const reconciler = createReconciler({
      pool,
      fetcher: () =>
        Promise.resolve(
          restResponse("hash-b", [{ price: "0.41", size: "10" }], []),
        ),
      getCachedBook: () => cachedBook,
      requestResync: (tokenId) => resyncs.push(tokenId),
      clock: () => 5_000,
    });
    const stats = await reconciler.reconcileOnce(["111"]);
    expect(stats).toEqual({ checked: 1, divergent: 1, skipped: 0 });
    expect(resyncs).toEqual(["111"]);
    const gapInsert = pool.captured[0];
    expect(gapInsert?.text).toContain("INSERT INTO polymarket_data_gaps");
    expect(gapInsert?.params?.[0]).toBe("clob_ws");
    expect(gapInsert?.params?.[1]).toBe("111");
    expect(gapInsert?.params?.[3]).toBe("reconcile_divergence");
  });

  it("compares top-10 levels when no hash is available", async () => {
    const pool = fakePool();
    const resyncs: string[] = [];
    const noHashCache: CachedBook = {
      bids: cachedBook.bids,
      asks: cachedBook.asks,
    };
    const reconciler = createReconciler({
      pool,
      fetcher: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              // Same levels, different order: still equal after sorting.
              bids: [
                { price: "0.39", size: "5" },
                { price: "0.40", size: "10" },
              ],
              asks: [{ price: "0.60", size: "7" }],
            }),
        }),
      getCachedBook: () => noHashCache,
      requestResync: (tokenId) => resyncs.push(tokenId),
      clock: () => 0,
    });
    const stats = await reconciler.reconcileOnce(["111"]);
    expect(stats.divergent).toBe(0);
    expect(resyncs).toEqual([]);
  });

  it("backs off on 429 and skips the next round without fetching", async () => {
    const pool = fakePool();
    let fetches = 0;
    let now = 0;
    const reconciler = createReconciler({
      pool,
      fetcher: () => {
        fetches += 1;
        return Promise.resolve({
          ok: false,
          status: 429,
          json: () => Promise.resolve({}),
        });
      },
      getCachedBook: () => cachedBook,
      requestResync: () => undefined,
      clock: () => now,
    });
    await reconciler.reconcileOnce(["111", "222"]);
    expect(fetches).toBe(1);
    // Within the backoff window nothing is fetched.
    now = 1_000;
    const stats = await reconciler.reconcileOnce(["111", "222"]);
    expect(fetches).toBe(1);
    expect(stats.checked).toBe(0);
    expect(stats.skipped).toBeGreaterThan(0);
  });

  it("samples at most 20 tokens per round, round-robin", async () => {
    const pool = fakePool();
    const fetched: string[] = [];
    const tokens = Array.from({ length: 25 }, (_, i) => `t${i}`);
    const reconciler = createReconciler({
      pool,
      fetcher: (url: string) => {
        fetched.push(url);
        return Promise.resolve(
          restResponse("hash-a", cachedBook.bids, cachedBook.asks),
        );
      },
      getCachedBook: () => cachedBook,
      requestResync: () => undefined,
      clock: () => 0,
    });
    await reconciler.reconcileOnce(tokens);
    expect(fetched).toHaveLength(20);
    expect(fetched[0]).toContain("token_id=t0");
    fetched.length = 0;
    await reconciler.reconcileOnce(tokens);
    // Second round starts where the first stopped.
    expect(fetched[0]).toContain("token_id=t20");
  });
});

describe("metrics snapshot", () => {
  it("aggregates gaps, lag percentiles, updates and table sizes", async () => {
    const now = new Date("2026-08-19T12:00:00Z");
    const pool = fakePool((text) => {
      if (text.includes("FROM polymarket_data_gaps")) {
        return {
          rows: [
            { source: "clob_ws", gap_count: "3", total_seconds: "120.5" },
            { source: "rtds", gap_count: "1", total_seconds: "10" },
          ],
          rowCount: 2,
        } as unknown as QueryResult<never>;
      }
      if (text.includes("percentile_cont")) {
        return {
          rows: [{ p50: "12", p99: "250", updates: "4200" }],
          rowCount: 1,
        } as unknown as QueryResult<never>;
      }
      if (text.includes("pg_total_relation_size")) {
        return {
          rows: [
            {
              table_name: "polymarket_book_deltas",
              bytes: String(2 * 1024 ** 3),
            },
            { table_name: "polymarket_trades", bytes: String(1024 ** 3) },
          ],
          rowCount: 2,
        } as unknown as QueryResult<never>;
      }
      return null;
    });

    const metrics = await metricsSnapshot(pool, () => now);

    expect(metrics.gapsLast24h.clob_ws).toEqual({
      count: 3,
      totalSeconds: 120.5,
    });
    expect(metrics.gapsLast24h.rtds).toEqual({ count: 1, totalSeconds: 10 });
    expect(metrics.ingestLagLastHour).toEqual({ p50Ms: 12, p99Ms: 250 });
    expect(metrics.updatesLastHour).toBe(4200);
    expect(metrics.totalBytes).toBe(3 * 1024 ** 3);
    expect(metrics.budgetBytes).toBe(BUDGET_BYTES);
    expect(metrics.budgetUsedPct).toBeCloseTo((3 / 40) * 100, 6);

    // The lag query covers both raw feeds with percentile_cont.
    const lagQuery = pool.captured.find((q) =>
      q.text.includes("percentile_cont"),
    );
    expect(lagQuery?.text).toContain("polymarket_book_deltas");
    expect(lagQuery?.text).toContain("polymarket_rtds_prices");
    expect(lagQuery?.params?.[0]).toEqual(new Date(now.getTime() - 3_600_000));

    // The gap window is the last 24h.
    const gapQuery = pool.captured.find((q) =>
      q.text.includes("FROM polymarket_data_gaps"),
    );
    expect(gapQuery?.params?.[0]).toEqual(new Date(now.getTime() - 86_400_000));
  });
});
