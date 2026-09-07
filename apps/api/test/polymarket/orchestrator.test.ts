import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGapRetryQueue,
  createJobScheduler,
  DatabaseUnavailableError,
  waitForDatabase,
} from "../../src/polymarket/orchestrator.js";

describe("createJobScheduler", () => {
  let timers: NodeJS.Timeout[];

  beforeEach(() => {
    vi.useFakeTimers();
    timers = [];
  });

  afterEach(() => {
    for (const timer of timers) {
      clearInterval(timer);
    }
    vi.useRealTimers();
  });

  it("does not run a job before its first interval by default", () => {
    const schedule = createJobScheduler(timers);
    const job = vi.fn(async () => {});

    schedule("plain", 1_000, job);

    expect(job).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    expect(job).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(job).toHaveBeenCalledTimes(1);
  });

  it("runs a runAtBoot job immediately AND keeps the interval", async () => {
    // The retention regression this guards: with a 24h interval and a process
    // that restarts on every deploy, the timer never elapsed and the job never
    // ran. A boot tick is what makes the daily prune reachable at all.
    const schedule = createJobScheduler(timers);
    const job = vi.fn(async () => {});

    schedule("retention", 86_400_000, job, { runAtBoot: true });

    expect(job).toHaveBeenCalledTimes(1);
    // Async advance so the boot run's .finally() releases the safeJob latch
    // before the interval fires.
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(job).toHaveBeenCalledTimes(2);
  });

  it("registers the interval so shutdown can clear it", () => {
    const schedule = createJobScheduler(timers);
    schedule("a", 1_000, async () => {});
    schedule("b", 1_000, async () => {}, { runAtBoot: true });

    expect(timers).toHaveLength(2);
  });

  it("never starts a second copy of a job that is still running", async () => {
    // A retention run over a 76 GB table takes far longer than any sane
    // interval; overlapping runs would double the delete pressure.
    const schedule = createJobScheduler(timers);
    let release: (() => void) | undefined;
    const started = vi.fn();
    const job = vi.fn(async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    schedule("slow", 1_000, job, { runAtBoot: true });
    expect(started).toHaveBeenCalledTimes(1);

    // Five interval ticks pass while the first run is still in flight.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(started).toHaveBeenCalledTimes(1);

    release?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toHaveBeenCalledTimes(2);
  });

  it("logs and swallows a boot-run failure instead of crashing the process", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const schedule = createJobScheduler(timers);
    const job = vi.fn(async () => {
      throw new TypeError("boom");
    });

    schedule("retention", 1_000, job, { runAtBoot: true });
    await vi.waitFor(() => {
      expect(
        stderr.mock.calls.some((call: unknown[]) =>
          String(call[0]).includes("JOB_FAILED"),
        ),
      ).toBe(true);
    });
    const line = stderr.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .find((text) => text.includes("JOB_FAILED"));
    expect(line).toContain('"job":"retention"');
    expect(line).toContain('"error_name":"TypeError"');
    stderr.mockRestore();
  });
});

describe("waitForDatabase", () => {
  it("returns on the first answer without sleeping", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    };
    const sleep = vi.fn(async () => {});

    await waitForDatabase(pool, { sleep });

    expect(pool.query).toHaveBeenCalledExactlyOnceWith("SELECT 1");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("backs off and returns once the database comes back", async () => {
    const pool = {
      query: vi
        .fn()
        .mockRejectedValueOnce(new Error("getaddrinfo EAI_AGAIN postgres"))
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValue({ rows: [], rowCount: 0 }),
    };
    const slept: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      slept.push(ms);
    });

    await waitForDatabase(pool, { sleep, initialDelayMs: 250 });

    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([250, 500]);
  });

  it("gives up inside the 60s ceiling with its own reason code", async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error("EAI_AGAIN")) };
    // A clock that advances by the delay each sleep, so the ceiling is what
    // ends the loop rather than an attempt count.
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });

    const failure = await waitForDatabase(pool, {
      sleep,
      clock: () => now,
      initialDelayMs: 1_000,
      maxDelayMs: 5_000,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DatabaseUnavailableError);
    expect((failure as DatabaseUnavailableError).reasonCode).toBe(
      "RECORDER_DATABASE_UNAVAILABLE",
    );
    expect(now).toBeLessThanOrEqual(60_000);
  });

  it("never subscribes anything: it only ever runs SELECT 1", async () => {
    const pool = {
      query: vi
        .fn()
        .mockRejectedValueOnce(new Error("down"))
        .mockResolvedValue({ rows: [], rowCount: 0 }),
    };

    await waitForDatabase(pool, { sleep: async () => {} });

    for (const call of pool.query.mock.calls) {
      expect(call[0]).toBe("SELECT 1");
    }
  });
});

describe("createGapRetryQueue", () => {
  const windowStart = new Date("2026-09-02T14:47:00.000Z");
  const windowEnd = new Date("2026-09-02T14:47:12.700Z");

  it("keeps the gap alive across a failing pool and writes it once", async () => {
    // The measured shape: 63 GAP_PERSIST_FAILED against ONE surviving row.
    const record = vi
      .fn()
      .mockRejectedValueOnce(new Error("EAI_AGAIN postgres"))
      .mockRejectedValueOnce(new Error("EAI_AGAIN postgres"))
      .mockRejectedValueOnce(new Error("EAI_AGAIN postgres"))
      .mockResolvedValue(100512);
    const log = vi.fn();
    const queue = createGapRetryQueue({ record, log });

    queue.enqueue({
      source: "internal",
      cause: "delta_persist_failed",
      dropped: 86,
      windowStart,
      windowEnd,
    });
    await queue.flushOnce();
    await queue.flushOnce();
    await queue.flushOnce();
    expect(queue.size()).toBe(1);
    await queue.flushOnce();

    expect(queue.size()).toBe(0);
    expect(record).toHaveBeenCalledTimes(4);
    const written = record.mock.calls.at(-1)?.[0] as {
      details: Record<string, unknown>;
      cause: string;
      source: string;
    };
    expect(written.source).toBe("internal");
    expect(written.cause).toBe("delta_persist_failed");
    expect(written.details.dropped).toBe(86);
    expect(written.details.window_start).toBe(windowStart.toISOString());
    expect(written.details.window_end).toBe(windowEnd.toISOString());
    expect(log).not.toHaveBeenCalled();
  });

  it("coalesces the batches of one outage into a single honest row", async () => {
    const record = vi.fn().mockResolvedValue(1);
    const queue = createGapRetryQueue({ record });

    queue.enqueue({
      source: "internal",
      cause: "delta_persist_failed",
      dropped: 200,
      windowStart,
      windowEnd: new Date("2026-09-02T14:47:05.000Z"),
    });
    queue.enqueue({
      source: "internal",
      cause: "delta_persist_failed",
      dropped: 150,
      windowStart: new Date("2026-09-02T14:47:06.000Z"),
      windowEnd,
    });
    expect(queue.size()).toBe(1);
    await queue.flushOnce();

    expect(record).toHaveBeenCalledTimes(1);
    const written = record.mock.calls[0]?.[0] as {
      details: Record<string, unknown>;
    };
    expect(written.details.dropped).toBe(350);
    expect(written.details.window_start).toBe(windowStart.toISOString());
    expect(written.details.window_end).toBe(windowEnd.toISOString());
  });

  it("does not merge different causes", async () => {
    const record = vi.fn().mockResolvedValue(1);
    const queue = createGapRetryQueue({ record });

    queue.enqueue({
      source: "internal",
      cause: "delta_persist_failed",
      dropped: 10,
      windowStart,
      windowEnd,
    });
    queue.enqueue({
      source: "internal",
      cause: "delta_queue_overflow",
      dropped: 5,
      windowStart,
      windowEnd,
    });

    expect(queue.size()).toBe(2);
    await queue.flushOnce();
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("carries dropped and the window into the log when it gives up", async () => {
    // The number stops being irrecoverable: this is the line an operator reads.
    const record = vi.fn().mockRejectedValue(new Error("still down"));
    const log = vi.fn();
    const queue = createGapRetryQueue({ record, log, maxAttempts: 3 });

    queue.enqueue({
      source: "internal",
      cause: "delta_persist_failed",
      dropped: 4_400,
      windowStart,
      windowEnd,
    });
    await queue.flushOnce();
    await queue.flushOnce();
    expect(queue.size()).toBe(1);
    await queue.flushOnce();

    expect(queue.size()).toBe(0);
    expect(log).toHaveBeenCalledWith(
      "error",
      "GAP_PERSIST_FAILED",
      expect.objectContaining({
        cause: "delta_persist_failed",
        dropped: 4_400,
        window_start: windowStart.toISOString(),
        window_end: windowEnd.toISOString(),
        attempts: 3,
      }),
    );
  });

  it("spends one query per tick while the pool is down, not one per entry", async () => {
    const record = vi.fn().mockRejectedValue(new Error("down"));
    const queue = createGapRetryQueue({ record, log: vi.fn() });

    for (let index = 0; index < 20; index += 1) {
      queue.enqueue({
        source: "internal",
        cause: `cause_${index}`,
        dropped: 1,
        windowStart,
        windowEnd,
      });
    }
    await queue.flushOnce();

    expect(queue.size()).toBe(20);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("sheds the oldest entry when full, still logging its number", async () => {
    const log = vi.fn();
    const queue = createGapRetryQueue({
      record: vi.fn().mockRejectedValue(new Error("down")),
      log,
      maxEntries: 2,
    });

    queue.enqueue({
      source: "internal",
      cause: "first",
      dropped: 7,
      windowStart,
      windowEnd,
    });
    queue.enqueue({
      source: "internal",
      cause: "second",
      dropped: 8,
      windowStart,
      windowEnd,
    });
    queue.enqueue({
      source: "internal",
      cause: "third",
      dropped: 9,
      windowStart,
      windowEnd,
    });

    expect(queue.size()).toBe(2);
    expect(log).toHaveBeenCalledWith(
      "error",
      "GAP_PERSIST_FAILED",
      expect.objectContaining({
        cause: "first",
        dropped: 7,
        reason: "queue_full",
      }),
    );
  });
});
