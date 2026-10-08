import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { createJevScheduler } from "../../src/storage/jev-scheduler.js";
import { decisionFixture } from "./jev-decision-fixture.js";
import type {
  JevBatch,
  JevBatchResult,
} from "../../src/models/jev-decision-contract.js";
import { inspectExecutionHealth } from "../../src/execution-worker.js";
const start = Date.parse("2026-10-08T10:00:00.000Z");
let now = start;
beforeEach(() => {
  now = start;
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());
function harness() {
  const order: string[] = [],
    batch = decisionFixture(start).batch;
  let resolve!: (r: JevBatchResult) => void;
  const protect = vi.fn(async () => {
    order.push("risk");
  });
  const prepare = vi.fn(async () => {
    order.push("decision");
    return { batch, tokens: {} };
  });
  const evaluate = vi.fn(
    (_batch: JevBatch, _signal: AbortSignal) =>
      new Promise<JevBatchResult>((r) => {
        resolve = r;
      }),
  );
  const complete = vi.fn(async () => {}),
    failed = vi.fn(async () => {});
  const scheduler = createJevScheduler({
    now: () => now,
    accounts: async () => ["paper", "stress"],
    profile: () => "h1",
    accountKey: (a) => a,
    protect,
    prepare,
    evaluate,
    complete,
    failed,
  });
  return {
    scheduler,
    order,
    protect,
    prepare,
    evaluate,
    complete,
    failed,
    resolve: (r = {} as JevBatchResult) => resolve(r),
  };
}
it("prioritizes risk/reconciliation and continues them during slow inference without backlog", async () => {
  const h = harness();
  await h.scheduler.tick();
  await Promise.resolve();
  expect(h.order).toEqual(["risk", "risk", "decision"]);
  now += 1000;
  await h.scheduler.tick();
  expect(h.protect).toHaveBeenCalledTimes(4);
  expect(h.prepare).toHaveBeenCalledTimes(1);
  expect(h.scheduler.active()).toBe(1);
  now += 1000;
  await h.scheduler.tick();
  expect(h.prepare).toHaveBeenCalledTimes(1);
  expect(h.scheduler.metrics.busy_skips).toBe(2);
  h.resolve();
  await h.scheduler.stop();
  expect(h.complete).not.toHaveBeenCalled();
  expect(h.failed).toHaveBeenCalledTimes(1);
});
it("cancels at the deadline and absorbs noncooperative late replies", async () => {
  const h = harness();
  await h.scheduler.tick();
  await vi.advanceTimersByTimeAsync(1500);
  now += 1500;
  expect(h.evaluate.mock.calls[0]?.[1]?.aborted).toBe(true);
  h.resolve();
  await h.scheduler.stop();
  expect(h.complete).not.toHaveBeenCalled();
});
it("does not add a fixed post-inference delay", async () => {
  const h = harness();
  await h.scheduler.tick();
  await Promise.resolve();
  h.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  // Completion settles the lane; the next current tick may prepare immediately.
  await vi.advanceTimersByTimeAsync(0);
  await h.scheduler.tick();
  expect(h.prepare).toHaveBeenCalledTimes(2);
  h.resolve();
  await h.scheduler.stop();
});
it("makes no inference for a closed admission or absent fresh context", async () => {
  const h = harness();
  h.prepare.mockResolvedValue(null as never);
  await h.scheduler.tick();
  expect(h.evaluate).not.toHaveBeenCalled();
  await h.scheduler.stop();
});
it("stops healthy ticks when durable failure finalization cannot commit", async () => {
  const h = harness();
  h.failed.mockRejectedValue(new Error("PERSISTENCE_UNAVAILABLE"));
  await h.scheduler.tick();
  now += 2000;
  h.resolve();
  await vi.advanceTimersByTimeAsync(0);
  await expect(h.scheduler.tick()).rejects.toThrow("PERSISTENCE_UNAVAILABLE");
  expect(h.complete).not.toHaveBeenCalled();
  await h.scheduler.stop();
});
it("recovers each newly seen account even within an already recovered profile", async () => {
  const protect = vi.fn(async () => {});
  let accounts = ["paper"];
  const s = createJevScheduler({
    now: () => now,
    accounts: async () => accounts,
    accountKey: (a) => a,
    profile: () => "h1",
    protect,
    prepare: async () => null,
    evaluate: async () => {
      throw Error("unexpected");
    },
    complete: async () => {},
    failed: async () => {},
  });
  await s.tick();
  accounts = ["paper", "stress"];
  now += 1000;
  await s.tick();
  expect(protect.mock.calls).toEqual([
    ["paper", true],
    ["paper", false],
    ["stress", true],
  ]);
  await s.stop();
});
it("checks the correct process, timestamp and readiness", () => {
  const health = {
    service: "execution-worker",
    pid: process.pid,
    timestamp: new Date(start).toISOString(),
    ready: true,
  };
  expect(() => inspectExecutionHealth(health, start)).not.toThrow();
  for (const change of [
    { service: "api" },
    { ready: false },
    { timestamp: new Date(start - 5001).toISOString() },
    { timestamp: new Date(start + 1).toISOString() },
    { timestamp: "invalid" },
    { pid: 0 },
  ])
    expect(() =>
      inspectExecutionHealth({ ...health, ...change }, start),
    ).toThrow("NOT_READY");
});
