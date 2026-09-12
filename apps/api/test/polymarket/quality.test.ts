import { randomUUID } from "node:crypto";

import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { QueryResult } from "../../src/database.js";
import {
  BUDGET_BYTES,
  createFeedHealth,
  createGapWriter,
  createReconciler,
  createTokenGapTracker,
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
  it("loads bounded open CLOB silence episodes with their original identities", async () => {
    const details = { episode_id: "prior", control: "blind" };
    const pool = fakePool(
      () =>
        ({
          rows: [
            {
              token_id: "token",
              gap_start: "2026-09-10T12:00:00Z",
              details_json: details,
            },
          ],
          rowCount: 1,
        }) as unknown as QueryResult<never>,
    );
    const boot = new Date("2026-09-10T12:05:00Z");
    expect(await createGapWriter(pool).loadOpenSilenceGaps(boot, 65)).toEqual([
      {
        episodeId: "prior",
        tokenId: "token",
        start: new Date("2026-09-10T12:00:00Z"),
        end: null,
        details,
      },
    ]);
    expect(pool.captured[0]?.text).toContain(
      "source = 'clob_ws' AND cause = 'stream_silent' AND gap_end IS NULL",
    );
    expect(pool.captured[0]?.params).toEqual([boot, 65]);
  });

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

  it("saves a complete silence snapshot with a stable episode identity", async () => {
    const pool = fakePool();
    const start = new Date("2026-09-10T12:00:00Z");
    const end = new Date("2026-09-10T12:03:00Z");
    const episodeId = "a9f5c53b-a882-4c70-8b2f-44cc060bb498";
    await createGapWriter(pool).saveSilenceGap({
      episodeId,
      tokenId: "active-token",
      start,
      end,
      details: { control: "blind", episode_id: "ignored" },
    });

    expect(pool.captured[0]?.params).toEqual([
      "active-token",
      start,
      end,
      JSON.stringify({ control: "blind", episode_id: episodeId }),
    ]);
    expect(pool.captured[0]?.text).toContain(
      "ON CONFLICT ((details_json->>'episode_id'))",
    );
    expect(pool.captured[0]?.text).toContain(
      "gap_end = COALESCE(polymarket_data_gaps.gap_end, EXCLUDED.gap_end)",
    );
  });

  it("keeps a global silence token and unfinished end null", async () => {
    const pool = fakePool();
    await createGapWriter(pool).saveSilenceGap({
      episodeId: randomUUID(),
      start: new Date("2026-09-10T12:00:00Z"),
      end: null,
      details: {},
    });
    expect(pool.captured[0]?.params[0]).toBeNull();
    expect(pool.captured[0]?.params[2]).toBeNull();
  });

  it("propagates silence persistence failure so the journal can retry", async () => {
    const failure = new Error("connection lost after INSERT");
    const pool = { query: vi.fn().mockRejectedValue(failure) };
    await expect(
      createGapWriter(pool).saveSilenceGap({
        episodeId: randomUUID(),
        start: new Date("2026-09-10T12:00:00Z"),
        end: null,
        details: {},
      }),
    ).rejects.toBe(failure);
  });
});

// Run only against an explicitly selected, migrated disposable PostgreSQL.
// Unit mocks cannot prove partial-index inference or concurrent UPSERTs.
const SILENCE_TEST_DATABASE_URL = process.env.GANSO_TEST_DATABASE_URL;
describe.skipIf(SILENCE_TEST_DATABASE_URL === undefined)(
  "silence gap writer against PostgreSQL",
  () => {
    let database: pg.Pool;
    const episodes: string[] = [];
    const newEpisode = (): string => {
      const id = randomUUID();
      episodes.push(id);
      return id;
    };
    beforeAll(() => {
      database = new pg.Pool({
        connectionString: SILENCE_TEST_DATABASE_URL,
        max: 2,
      });
    });
    afterAll(async () => {
      try {
        await database.query(
          `DELETE FROM polymarket_data_gaps
           WHERE source = 'clob_ws' AND cause = 'stream_silent'
             AND details_json->>'episode_id' = ANY($1::text[])`,
          [episodes],
        );
      } finally {
        await database.end();
      }
    });

    function writer(): ReturnType<typeof createGapWriter> {
      return createGapWriter({
        async query<R extends Record<string, unknown>>(
          text: string,
          params?: readonly unknown[],
        ): Promise<QueryResult<R>> {
          const result = await database.query<R>(
            text,
            params === undefined ? undefined : [...params],
          );
          return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        },
      });
    }

    it("restores only pre-boot open episodes and closes their existing rows", async () => {
      const gaps = writer();
      const ids = [newEpisode(), newEpisode(), newEpisode()];
      const boot = new Date("2026-09-10T12:05:00Z");
      const start = new Date("2026-09-10T12:00:00Z");
      await gaps.saveSilenceGap({
        episodeId: ids[0]!,
        tokenId: "restore-token",
        start,
        end: null,
        details: { control: "blind" },
      });
      await gaps.saveSilenceGap({
        episodeId: ids[1]!,
        start,
        end: boot,
        details: { control: "unavailable" },
      });
      await gaps.saveSilenceGap({
        episodeId: ids[2]!,
        start: new Date(boot.getTime() + 1),
        end: null,
        details: {},
      });
      const restored = (await gaps.loadOpenSilenceGaps(boot, 65)).filter(
        (row) => ids.includes(row.episodeId),
      );
      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject({
        episodeId: ids[0],
        tokenId: "restore-token",
        start,
        end: null,
      });
      const end = new Date(boot.getTime() + 1_000);
      await gaps.saveSilenceGap({
        ...restored[0]!,
        end,
        details: { ...restored[0]!.details, closed_by: "ws_book_frame" },
      });
      const result = await database.query(
        "SELECT gap_start, gap_end FROM polymarket_data_gaps WHERE details_json->>'episode_id' = $1",
        [ids[0]],
      );
      expect(result.rows).toEqual([{ gap_start: start, gap_end: end }]);
      expect(
        (await gaps.loadOpenSilenceGaps(boot, 65)).some(
          (row) => row.episodeId === ids[0],
        ),
      ).toBe(false);
    });

    it("deduplicates concurrent replay and never reopens a closed episode", async () => {
      const episodeId = newEpisode();
      const start = new Date("2026-09-10T12:00:00Z");
      const end = new Date("2026-09-10T12:03:00Z");
      const gap = {
        episodeId,
        start,
        end: null,
        details: { control: "pending" },
      };
      const gaps = writer();
      await Promise.all([gaps.saveSilenceGap(gap), gaps.saveSilenceGap(gap)]);
      await gaps.saveSilenceGap({
        ...gap,
        end,
        details: { control: "blind" },
      });
      // Simulate a replay after the acknowledgement of the close was lost.
      await gaps.saveSilenceGap({
        ...gap,
        start: new Date("2026-09-10T12:01:00Z"),
        details: { control: "blind", attempts: 2 },
      });
      const result = await database.query(
        `SELECT token_id, gap_start, gap_end, details_json
         FROM polymarket_data_gaps WHERE details_json->>'episode_id' = $1`,
        [episodeId],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toEqual({
        token_id: null,
        gap_start: start,
        gap_end: end,
        details_json: { episode_id: episodeId, control: "blind", attempts: 2 },
      });
    });

    it("persists the first snapshot already closed and keeps episodes distinct", async () => {
      const episodesForToken = [newEpisode(), newEpisode()];
      const start = new Date("2026-09-10T12:00:00Z");
      const end = new Date("2026-09-10T12:03:00Z");
      const gaps = writer();
      for (const episodeId of episodesForToken) {
        await gaps.saveSilenceGap({
          episodeId,
          tokenId: "ops02-integration-token",
          start,
          end,
          details: { control: "unavailable" },
        });
      }
      const result = await database.query(
        `SELECT gap_start, gap_end FROM polymarket_data_gaps
         WHERE details_json->>'episode_id' = ANY($1::text[])`,
        [episodesForToken],
      );
      expect(result.rows).toHaveLength(2);
      expect(result.rows).toEqual([
        { gap_start: start, gap_end: end },
        { gap_start: start, gap_end: end },
      ]);
    });
  },
);

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
              // 4 GiB of file, half of it dead tuples: 2 GiB retained.
              bytes: String(4 * 1024 ** 3),
              reltuples: "50",
              live_tup: "50",
              dead_tup: "50",
              toast_live_tup: "0",
              heap_width: null,
              index_count: null,
              index_key_width: null,
            },
            {
              // Not a `polymarket_%` table: under the old definition this
              // contributed nothing (RFC-015 §9).
              table_name: "portfolio_decisions",
              bytes: String(1024 ** 3),
              reltuples: "10",
              live_tup: "10",
              dead_tup: "0",
              toast_live_tup: "0",
              heap_width: null,
              index_count: null,
              index_key_width: null,
            },
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
    // LIVE bytes over the retention list — the same measurement
    // QUOTA_GLOBAL_ALARM makes (RFC-015 §9). 2 GiB retained of 4 GiB of file,
    // plus 1 GiB from a table the old `polymarket_%` predicate never saw.
    expect(metrics.totalBytes).toBe(3 * 1024 ** 3);
    expect(metrics.physicalBytes).toBe(5 * 1024 ** 3);
    expect(metrics.bytesByTable["portfolio_decisions"]).toBe(1024 ** 3);
    expect(metrics.bytesByTable["polymarket_book_deltas"]).toBe(2 * 1024 ** 3);
    expect(metrics.budgetBytes).toBe(BUDGET_BYTES);
    // Budget raised from 40 to 110 GB by the owner on 2026-08-25 (RFC-007
    // amendment); derived from the constant so the two cannot drift.
    expect(metrics.budgetUsedPct).toBeCloseTo((3 / 110) * 100, 6);

    // Every retention table is asked for by name; nothing matches by pattern.
    const sizeQuery = pool.captured.find((q) =>
      q.text.includes("pg_total_relation_size"),
    );
    expect(sizeQuery?.text).not.toContain("LIKE");
    expect(sizeQuery?.params?.[0]).toContain("resolution_scores");

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

// ---------------------------------------------------------------------------
// RFC-024 D3 — o rastreador de lacuna por token
// ---------------------------------------------------------------------------

describe("createTokenGapTracker (RFC-024 D3)", () => {
  /** A gap writer whose open resolves only when the test says so. */
  function controllableGaps() {
    const opened: Array<{
      source: string;
      tokenId: string | null | undefined;
      cause: string;
      start: Date;
    }> = [];
    const closed: Array<{ gapId: number; end: Date }> = [];
    let releaseOpen: ((gapId: number) => void) | null = null;
    let nextId = 100;
    const gaps = {
      openGap: (input: {
        source: string;
        tokenId?: string | null;
        cause: string;
        start: Date;
      }): Promise<number> => {
        opened.push({
          source: input.source,
          tokenId: input.tokenId,
          cause: input.cause,
          start: input.start,
        });
        return new Promise<number>((resolve) => {
          releaseOpen = resolve;
        });
      },
      closeGap: (gapId: number, end: Date): Promise<void> => {
        closed.push({ gapId, end });
        return Promise.resolve();
      },
    };
    return {
      gaps,
      opened,
      closed,
      release: (): void => {
        releaseOpen?.(nextId);
        nextId += 1;
      },
    };
  }

  const AT = new Date("2026-09-08T02:00:00.000Z");
  const LATER = new Date("2026-09-08T02:01:00.000Z");

  it("abre a lacuna com fonte, causa e token", () => {
    const { gaps, opened } = controllableGaps();
    const tracker = createTokenGapTracker({ gaps, log: () => {} });
    tracker.open({
      tokenId: "tok",
      source: "clob_ws",
      cause: "subscribe_book_missing",
      at: AT,
    });
    expect(opened).toEqual([
      {
        source: "clob_ws",
        tokenId: "tok",
        cause: "subscribe_book_missing",
        start: AT,
      },
    ]);
    expect(tracker.openTokens()).toEqual(["tok"]);
  });

  it("uma lacuna por episódio: reabrir com uma aberta não abre a segunda", () => {
    const { gaps, opened } = controllableGaps();
    const tracker = createTokenGapTracker({ gaps, log: () => {} });
    tracker.open({
      tokenId: "tok",
      source: "clob_ws",
      cause: "subscribe_book_missing",
      at: AT,
    });
    tracker.open({
      tokenId: "tok",
      source: "clob_ws",
      cause: "subscribe_book_missing",
      at: LATER,
    });
    expect(opened).toHaveLength(1);
  });

  it("o book chegando ANTES do id voltar: a lacuna fecha, não vaza aberta", async () => {
    // This is the reason the tracker holds a promise rather than a number.
    const { gaps, closed, release } = controllableGaps();
    const tracker = createTokenGapTracker({ gaps, log: () => {} });
    tracker.open({
      tokenId: "tok",
      source: "clob_ws",
      cause: "subscribe_book_missing",
      at: AT,
    });
    // The book arrives while the INSERT is still in flight.
    tracker.close("tok", LATER);
    expect(closed).toEqual([]);
    expect(tracker.openTokens()).toEqual([]);
    // Now the INSERT returns its id, and the close finally lands on it.
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toEqual([{ gapId: 100, end: LATER }]);
  });

  it("fechar sem lacuna aberta não faz nada", () => {
    const { gaps, closed } = controllableGaps();
    const tracker = createTokenGapTracker({ gaps, log: () => {} });
    tracker.close("tok", LATER);
    expect(closed).toEqual([]);
  });

  it("fechar duas vezes fecha uma vez", async () => {
    const { gaps, closed, release } = controllableGaps();
    const tracker = createTokenGapTracker({ gaps, log: () => {} });
    tracker.open({
      tokenId: "tok",
      source: "clob_ws",
      cause: "subscribe_book_missing",
      at: AT,
    });
    release();
    tracker.close("tok", LATER);
    tracker.close("tok", LATER);
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toHaveLength(1);
  });

  it("abandon esquece a lacuna SEM fechá-la — ela é a medição", async () => {
    const { gaps, closed, release } = controllableGaps();
    const tracker = createTokenGapTracker({ gaps, log: () => {} });
    tracker.open({
      tokenId: "tok",
      source: "clob_ws",
      cause: "subscribe_book_missing",
      at: AT,
    });
    release();
    tracker.abandon("tok");
    await Promise.resolve();
    expect(closed).toEqual([]);
    expect(tracker.openTokens()).toEqual([]);
  });

  it("o open falhando é logado e não deixa o token travado", async () => {
    const logged: string[] = [];
    const tracker = createTokenGapTracker({
      gaps: {
        openGap: () => Promise.reject(new Error("db down")),
        closeGap: () => Promise.resolve(),
      },
      log: (_level, reasonCode) => logged.push(reasonCode),
    });
    tracker.open({
      tokenId: "tok",
      source: "clob_ws",
      cause: "subscribe_book_missing",
      at: AT,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(logged).toEqual(["GAP_PERSIST_FAILED"]);
    // The close of a gap that never got an id is a no-op, not a crash.
    tracker.close("tok", LATER);
    await Promise.resolve();
    expect(tracker.openTokens()).toEqual([]);
  });
});
