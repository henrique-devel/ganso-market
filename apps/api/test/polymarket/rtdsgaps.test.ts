import { randomUUID } from "node:crypto";

import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { QueryResult } from "../../src/database.js";
import {
  createRtdsGapJournal,
  RTDS_GAP_PROBE_INTERVAL_MS,
  RTDS_GAP_SHUTDOWN_GRACE_MS,
  RTDS_MAX_PENDING_GAPS,
} from "../../src/polymarket/rtdsgaps.js";

const start = new Date("2026-09-11T10:00:00Z");
const end = new Date("2026-09-11T10:02:00Z");

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  let now = start.getTime();
  const calls: { text: string; params: readonly unknown[] }[] = [];
  const log = vi.fn();
  const run = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const journal = createRtdsGapJournal({
    clock: () => now,
    log,
    pool: {
      async query<R extends Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ): Promise<QueryResult<R>> {
        calls.push({ text, params: params ?? [] });
        await run();
        return { rows: [], rowCount: 1 };
      },
    },
  });
  return {
    journal,
    calls,
    log,
    run,
    advance: (ms: number): void => {
      now += ms;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RTDS gap journal", () => {
  it("retains a failed open through recovery and saves its close with the same identity", async () => {
    const { journal, calls, log, run, advance } = fixture();
    run.mockRejectedValueOnce(new Error("database unavailable"));
    const id = journal.record(start, null, "stream_silent", { feed: "twap30" });
    await journal.flush();
    expect(journal.stats()).toEqual({
      pendingGapWrites: 1,
      gapPersistFailures: 1,
      lastGapPersistErrorMs: start.getTime(),
      gapJournalOverflow: 0,
      gapRetryExhausted: 0,
    });
    expect(log.mock.calls.map((call) => call[1])).toEqual([
      "RTDS_GAP_PERSIST_FAILED",
    ]);
    journal.update(id, end, { recovered_by: "valid_price", attempts: 1 });
    await journal.flush();
    expect(calls).toHaveLength(1);
    advance(1_000);
    await journal.flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.params.slice(0, 3)).toEqual([start, end, "stream_silent"]);
    expect(JSON.parse(calls[1]?.params[3] as string)).toEqual({
      episode_id: id,
      feed: "twap30",
      recovered_by: "valid_price",
      attempts: 1,
    });
    expect(journal.stats()).toMatchObject({
      pendingGapWrites: 0,
      gapPersistFailures: 1,
      lastGapPersistErrorMs: start.getTime(),
    });
    expect(log).toHaveBeenLastCalledWith(
      "info",
      "RTDS_GAP_PERSISTED",
      expect.objectContaining({ episode_id: id, gap_end: end.toISOString() }),
    );
    await journal.stop();
  });

  it("serializes flushes without losing a close received during an open write", async () => {
    const { journal, calls, run } = fixture();
    const write = deferred();
    run.mockImplementationOnce(() => write.promise);
    const id = journal.record(start, null, "stream_silent", {});
    const first = journal.flush();
    expect(journal.flush()).toBe(first);
    journal.update(id, end, { recovered_by: "valid_price" });
    journal.update(id, null, { attempts: 1 });
    expect(calls).toHaveLength(1);
    write.resolve();
    await first;
    expect(journal.stats().pendingGapWrites).toBe(1);
    await journal.flush();
    expect(calls.map((call) => call.params[1])).toEqual([null, end]);
    expect(journal.stats().pendingGapWrites).toBe(0);
    await journal.flush();
    expect(calls).toHaveLength(2);
    await journal.stop();
  });

  it("bounds retry bursts despite updates and can recover on a later slow probe", async () => {
    const { journal, calls, run, advance } = fixture();
    run.mockRejectedValue(new Error("offline"));
    const id = journal.record(start, null, "stream_silent", {});
    await journal.flush();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000]) {
      journal.update(id, null, { reconnecting: true });
      advance(delay - 1);
      const before = calls.length;
      await journal.flush();
      expect(calls).toHaveLength(before);
      advance(1);
      await journal.flush();
      expect(calls).toHaveLength(before + 1);
    }
    expect(journal.stats()).toMatchObject({
      pendingGapWrites: 1,
      gapPersistFailures: 8,
      gapRetryExhausted: 1,
    });
    run.mockResolvedValue(undefined);
    journal.update(id, end, { recovered_by: "valid_price" });
    advance(RTDS_GAP_PROBE_INTERVAL_MS - 1);
    await journal.flush();
    expect(calls).toHaveLength(8);
    advance(1);
    await journal.flush();
    expect(calls).toHaveLength(9);
    expect(calls[8]?.params[1]).toEqual(end);
    expect(journal.stats()).toMatchObject({
      pendingGapWrites: 0,
      gapPersistFailures: 8,
      gapRetryExhausted: 1,
    });
    await journal.stop();
  });

  it("preserves unresolved entries at capacity and frees space only after a saved close", async () => {
    const { journal, calls, log } = fixture();
    const ids = Array.from({ length: RTDS_MAX_PENDING_GAPS }, (_, index) =>
      journal.record(start, null, "stream_silent", { sequence: index }),
    );
    const overflowId = journal.record(start, null, "stream_silent", {});
    expect(journal.stats()).toMatchObject({
      pendingGapWrites: RTDS_MAX_PENDING_GAPS,
      gapJournalOverflow: 1,
    });
    expect(log).toHaveBeenCalledWith(
      "error",
      "RTDS_GAP_JOURNAL_FULL",
      expect.objectContaining({ episode_id: overflowId }),
    );
    await journal.flush();
    expect(calls).toHaveLength(RTDS_MAX_PENDING_GAPS);
    expect(
      calls.map((call) => JSON.parse(call.params[3] as string).episode_id),
    ).toEqual(ids);
    journal.record(start, null, "stream_silent", {});
    expect(journal.stats().gapJournalOverflow).toBe(2);
    journal.update(ids[0]!, end, {});
    await journal.flush();
    journal.record(start, null, "stream_silent", {});
    expect(journal.stats()).toMatchObject({
      pendingGapWrites: 1,
      gapJournalOverflow: 2,
    });
    await journal.stop();
  });

  it("stops within five seconds of a hung write and never dispatches later queued writes", async () => {
    vi.useFakeTimers();
    const { journal, calls, log, run } = fixture();
    const write = deferred();
    run.mockImplementationOnce(() => write.promise);
    journal.record(start, null, "stream_silent", { feed: "twap30" });
    journal.record(start, null, "stream_silent", { feed: "twap60" });
    const flush = journal.flush();
    const stop = journal.stop();
    expect(journal.stop()).toBe(stop);
    await vi.advanceTimersByTimeAsync(RTDS_GAP_SHUTDOWN_GRACE_MS);
    await stop;
    expect(log).toHaveBeenLastCalledWith(
      "error",
      "RTDS_GAP_SHUTDOWN_UNFLUSHED",
      {
        pending: 2,
      },
    );
    write.resolve();
    await flush;
    await journal.flush();
    journal.record(start, end, "stream_silent", {});
    await vi.advanceTimersByTimeAsync(10 * RTDS_GAP_PROBE_INTERVAL_MS);
    expect(calls).toHaveLength(1);
    expect(journal.stats().pendingGapWrites).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains every pending close during graceful shutdown", async () => {
    const { journal, calls } = fixture();
    const ids = ["spot", "twap30", "twap60"].map((feed) =>
      journal.record(start, null, "stream_silent", { feed }),
    );
    await journal.flush();
    for (const id of ids)
      journal.update(id, end, { recovered_by: "valid_price" });
    await journal.drainAndStop();
    expect(calls).toHaveLength(6);
    expect(calls.slice(3).map((call) => call.params[1])).toEqual([
      end,
      end,
      end,
    ]);
    expect(journal.stats().pendingGapWrites).toBe(0);
  });

  it("drains a close queued behind its in-flight open snapshot", async () => {
    const { journal, calls, run } = fixture();
    const write = deferred();
    run.mockImplementationOnce(() => write.promise);
    const id = journal.record(start, null, "stream_silent", {});
    const flush = journal.flush();
    journal.update(id, end, { recovered_by: "valid_price" });
    const stop = journal.drainAndStop();
    expect(journal.drainAndStop()).toBe(stop);
    write.resolve();
    await Promise.all([flush, stop]);
    expect(calls.map((call) => call.params[1])).toEqual([null, end]);
    expect(journal.stats().pendingGapWrites).toBe(0);
  });

  it("bounds a hung graceful drain and freezes external writes immediately", async () => {
    vi.useFakeTimers();
    const { journal, calls, run } = fixture();
    const write = deferred();
    run.mockImplementationOnce(() => write.promise);
    journal.record(start, end, "stream_silent", { feed: "twap30" });
    const second = journal.record(start, end, "stream_silent", {
      feed: "twap60",
    });
    const stop = journal.drainAndStop();
    journal.update(second, end, { ignored: true });
    journal.record(start, end, "stream_silent", { ignored: true });
    await journal.flush();
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RTDS_GAP_SHUTDOWN_GRACE_MS);
    await stop;
    write.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(journal.stats().pendingGapWrites).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// An explicit disposable database must already have migration 0022 applied.
const TEST_DATABASE_URL = process.env.GANSO_TEST_DATABASE_URL;
describe.skipIf(TEST_DATABASE_URL === undefined)(
  "RTDS gap journal against PostgreSQL",
  () => {
    let database: pg.Pool;
    const episodeIds: string[] = [];
    beforeAll(() => {
      database = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
    });
    afterAll(async () => {
      try {
        await database.query(
          `DELETE FROM polymarket_data_gaps
         WHERE source = 'rtds' AND details_json->>'episode_id' = ANY($1::text[])`,
          [episodeIds],
        );
      } finally {
        await database.end();
      }
    });

    const newJournal = () =>
      createRtdsGapJournal({
        log: vi.fn(),
        pool: {
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
        },
      });

    it("deduplicates concurrent inserts and preserves a saved close on a stale replay", async () => {
      const episodeId = randomUUID();
      episodeIds.push(episodeId);
      const first = newJournal();
      const second = newJournal();
      for (const journal of [first, second])
        journal.record(start, null, "stream_silent", {
          episode_id: episodeId,
          feed: "twap30",
        });
      await Promise.all([first.flush(), second.flush()]);
      first.update(episodeId, end, { recovered_by: "valid_price" });
      await first.flush();
      second.update(episodeId, null, { attempts: 2 });
      await second.flush();
      expect(first.stats().gapPersistFailures).toBe(0);
      expect(second.stats().gapPersistFailures).toBe(0);
      const result = await database.query(
        `SELECT gap_start, gap_end, details_json FROM polymarket_data_gaps
       WHERE source = 'rtds' AND details_json->>'episode_id' = $1`,
        [episodeId],
      );
      expect(result.rows).toEqual([
        {
          gap_start: start,
          gap_end: end,
          details_json: {
            episode_id: episodeId,
            feed: "twap30",
            recovered_by: "valid_price",
            attempts: 2,
          },
        },
      ]);
      await Promise.all([first.stop(), second.stop()]);
    });
  },
);
