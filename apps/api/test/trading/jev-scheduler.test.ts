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

it("dispatches three coincident pairs and protects all six during slow or failed inference", async () => {
  const accounts = [1, 3, 5].flatMap((h) => [`h${h}:paper`, `h${h}:stress`]);
  const complete = vi.fn(async () => {}),
    failed = vi.fn(async () => {}),
    protect = vi.fn(async () => {});
  let resolve!: (r: JevBatchResult) => void;
  const evaluate = vi.fn(async (batch: JevBatch) => {
    if (batch.request_id === "h1")
      return new Promise<JevBatchResult>((r) => {
        resolve = r;
      });
    if (batch.request_id === "h3") throw Error("PROVIDER_UNAVAILABLE");
    return { batch } as JevBatchResult;
  });
  const prepare = vi.fn(async (group: string[]) => ({
    batch: {
      ...decisionFixture(start).batch,
      request_id: group[0]!.split(":")[0]!,
    },
    tokens: {},
  }));
  const s = createJevScheduler({
    now: () => now,
    accounts: async () => accounts,
    profile: (a) => a.split(":")[0]!,
    accountKey: (a) => a,
    protect,
    prepare,
    evaluate,
    complete,
    failed,
  });
  await s.tick();
  await vi.advanceTimersByTimeAsync(0);
  expect(evaluate).toHaveBeenCalledTimes(3);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(failed).toHaveBeenCalledTimes(1);
  expect(s.metrics.max_active_lanes).toBe(3);
  now += 1000;
  await s.tick();
  await vi.advanceTimersByTimeAsync(0);
  expect(protect).toHaveBeenCalledTimes(12);
  expect(
    prepare.mock.calls.filter((c) => c[0][0]!.startsWith("h1")),
  ).toHaveLength(1);
  now += 1000;
  resolve({} as JevBatchResult);
  await s.stop();
  expect(complete.mock.calls).toHaveLength(2);
  expect(s.active()).toBe(0);
});
it("isolates a failed account and attempts other protections while one account is slow", async () => {
  const accounts = [
    "h1:paper",
    "h1:stress",
    "h3:paper",
    "h3:stress",
    "h5:paper",
    "h5:stress",
  ];
  let release!: () => void;
  const protectedKeys: string[] = [],
    unavailable = vi.fn(async () => {});
  const prepare = vi.fn(async () => null);
  const s = createJevScheduler({
    now: () => now,
    accounts: async () => accounts,
    profile: (a) => a.split(":")[0]!,
    accountKey: (a) => a,
    protect: async (a) => {
      if (a === "h1:paper")
        await new Promise<void>((r) => {
          release = r;
        });
      if (a === "h1:stress") throw Error("ACCOUNT_LOCAL");
      protectedKeys.push(a);
    },
    unavailable,
    prepare,
    evaluate: async () => {
      throw Error("unexpected");
    },
    complete: async () => {},
    failed: async () => {},
  });
  const tick = s.tick();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(protectedKeys).toEqual([
    "h3:paper",
    "h3:stress",
    "h5:paper",
    "h5:stress",
  ]);
  release();
  await tick;
  await vi.advanceTimersByTimeAsync(0);
  expect(unavailable).toHaveBeenCalledTimes(1);
  expect(s.metrics.protected_accounts).toBe(5);
  expect(
    prepare.mock.calls.flatMap((c) => (c as unknown as [string[]])[0]),
  ).not.toContain("h1:stress");
  await s.stop();
});
it("keeps slow preparation bounded to its profile while other profiles and risk continue", async () => {
  let release!: (r: null) => void;
  const protect = vi.fn(async () => {}),
    prepare = vi.fn(async (group: string[]) =>
      group[0] === "h1"
        ? new Promise<null>((r) => {
            release = r;
          })
        : null,
    );
  const s = createJevScheduler({
    now: () => now,
    accounts: async () => ["h1", "h3", "h5"],
    profile: (a) => a,
    accountKey: (a) => a,
    protect,
    prepare,
    evaluate: async () => {
      throw Error("unexpected");
    },
    complete: async () => {},
    failed: async () => {},
  });
  await s.tick();
  await vi.advanceTimersByTimeAsync(0);
  now += 1000;
  await s.tick();
  await vi.advanceTimersByTimeAsync(0);
  expect(protect).toHaveBeenCalledTimes(6);
  expect(prepare.mock.calls.filter((c) => c[0][0] === "h1")).toHaveLength(1);
  release(null);
  await s.stop();
});
it("rejects oversized or duplicate registry and fails closed after a lost lease", async () => {
  const protect = vi.fn(async () => {
      throw Error("EXECUTION_WORKER_FENCED");
    }),
    prepare = vi.fn(async () => null),
    unavailable = vi.fn(async () => {});
  let accounts = ["h1", "h3", "h5"];
  const s = createJevScheduler({
    now: () => now,
    accounts: async () => accounts,
    profile: (a) => a,
    accountKey: (a) => a,
    protect,
    prepare,
    unavailable,
    evaluate: async () => {
      throw Error("unexpected");
    },
    complete: async () => {},
    failed: async () => {},
  });
  await expect(s.tick()).rejects.toThrow("FENCED");
  expect(protect).toHaveBeenCalledTimes(3);
  expect(unavailable).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  accounts = ["h1", "h1"];
  await expect(s.tick()).rejects.toThrow("REGISTRY");
  accounts = ["h1", "h3", "h5", "h7"];
  await expect(s.tick()).rejects.toThrow("REGISTRY");
  await s.stop();
});

it("isolates preparation failure and caps lanes during a profile replacement", async () => {
  let release!: (r: null) => void;
  let accounts = ["old", "h3", "h5"];
  const unavailable = vi.fn(async () => {}),
    prepare = vi.fn(async (g: string[]) => {
      if (g[0] === "old")
        return new Promise<null>((r) => {
          release = r;
        });
      if (g[0] === "h3") throw Error("CONTEXT_LOCAL");
      return null;
    });
  const s = createJevScheduler({
    now: () => now,
    accounts: async () => accounts,
    profile: (a) => a,
    accountKey: (a) => a,
    protect: async () => {},
    prepare,
    unavailable,
    evaluate: async () => {
      throw Error("unexpected");
    },
    complete: async () => {},
    failed: async () => {},
  });
  await s.tick();
  await vi.advanceTimersByTimeAsync(0);
  expect(unavailable).toHaveBeenCalledTimes(1);
  accounts = ["new", "h3", "h5"];
  now += 1000;
  await s.tick();
  await vi.advanceTimersByTimeAsync(0);
  expect(s.metrics.max_active_lanes).toBeLessThanOrEqual(3);
  expect(s.metrics.preparation_failures).toBe(2);
  release(null);
  await s.stop();
});
