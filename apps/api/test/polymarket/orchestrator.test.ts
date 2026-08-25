import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createJobScheduler } from "../../src/polymarket/orchestrator.js";

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
