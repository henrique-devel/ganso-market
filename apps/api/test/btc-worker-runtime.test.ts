import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { metadata, start, iso, trade } from "./trading/bars-fixture.js";
const mocks = vi.hoisted(() => ({
  write: vi.fn(async () => {}),
  end: vi.fn(async () => {}),
  book: vi.fn(),
  context: vi.fn(),
  capture: vi.fn(),
  stop: vi.fn(),
  observe: vi.fn(),
  unavailable: vi.fn(),
}));
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
}));
vi.mock("node:fs/promises", () => ({
  readFile: async () =>
    JSON.stringify({
      schema_version: 1,
      execution_mode: "paper",
      enabled: true,
    }),
  rename: async () => {},
  writeFile: mocks.write,
  statfs: async () => ({
    blocks: 300n * 1024n ** 3n,
    bavail: 90n * 1024n ** 3n,
    bsize: 1n,
  }),
}));
vi.mock("../src/config.js", () => ({
  loadConfig: async () => ({ executionMode: "paper" }),
}));
vi.mock("../src/database.js", () => ({
  createDatabasePool: () => ({
    query: async () => ({
      rows: [{ database_bytes: "100", wal_lsn: "0/1", maximum: 40, used: 2 }],
    }),
    end: mocks.end,
  }),
}));
vi.mock("../src/storage/btc-retention.js", () => ({
  retentionCapacity: async () => ({
    raw_bytes: "0",
    total_bytes: "0",
    allocated_bytes: "0",
    nonessentialBlocked: false,
    hold: true,
  }),
}));
vi.mock("../src/venues/hyperliquid/public.js", () => ({
  createHyperliquidPublicAdapter: () => ({
    getBtcMetadata: async () => metadata,
  }),
}));
vi.mock("../src/venues/hyperliquid/context-snapshot.js", async (original) => ({
  ...(await original<object>()),
  fetchBtcBookSnapshot: mocks.book,
  fetchBtcContextSnapshot: mocks.context,
}));
vi.mock("../src/storage/btc-marketstore.js", () => ({
  captureBtcMarketBatch: mocks.capture,
  closeBtcMarketBars: vi.fn(async () => ({ closed: 0 })),
}));
vi.mock("../src/venues/hyperliquid/feed.js", async () => {
  const { FeedQualityMachine } = await import("../src/trading/feed.js");
  return {
    startHyperliquidBtcFeed: () => {
      const machine = new FeedQualityMachine<TradingMarketObservation>();
      machine.open(Date.now());
      let stopped = false;
      mocks.stop.mockImplementation(() => {
        stopped = true;
        machine.disconnect(Date.now());
      });
      mocks.observe.mockImplementation((event) => machine.accept(event));
      mocks.unavailable.mockImplementation(() =>
        machine.invalid("context", Date.now()),
      );
      return {
        status: () => ({ ...machine.status(Date.now()), stopped }),
        stop: mocks.stop,
        observeSnapshot: mocks.observe,
        contextUnavailable: mocks.unavailable,
        drain: () => {
          machine.message(Date.now());
          machine.accept(trade(Date.now(), Date.now()));
          return machine.drain(Date.now());
        },
      };
    },
  };
});
import type { TradingMarketObservation } from "@ganso-market/contracts/trading";
import { normalizeBtcContextSnapshot } from "../src/venues/hyperliquid/context-snapshot.js";
import { normalizeHyperliquidFeed } from "../src/venues/hyperliquid/feed-normalizer.js";
import { runBtcWorker } from "../src/btc-worker.js";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  vi.stubEnv("GANSO_BTC_WORKER_CONFIG_FILE", "/fixture.json");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.capture.mockResolvedValue({ stored: 1, duplicates: 0 });
  mocks.book.mockImplementation(async () => ({
    ...normalizeHyperliquidFeed(
      "book",
      {
        coin: "BTC",
        time: Date.now(),
        levels: [
          [{ px: "64000", sz: "1", n: 1 }],
          [{ px: "64001", sz: "1", n: 1 }],
        ],
      },
      iso(Date.now()),
      metadata.instrument.instrument_version,
      `book-${Date.now()}`,
    )[0]!,
    source_id: "hyperliquid:mainnet:info",
  }));
  mocks.context.mockImplementation(async () =>
    normalizeBtcContextSnapshot(
      [
        {
          universe: [
            { name: "BTC", szDecimals: 5, maxLeverage: 40, marginTableId: 40 },
          ],
          marginTables: [],
          collateralToken: 0,
        },
        [
          {
            markPx: "65000",
            oraclePx: "64990",
            funding: "0.0001",
            openInterest: "25",
          },
        ],
      ],
      {
        requestedAt: iso(Date.now()),
        receivedAt: iso(Date.now()),
        serverDate: new Date(Date.now()).toUTCString(),
        cacheStatus: "Miss from cloudfront",
        age: null,
      },
      metadata,
      `context-${Date.now()}`,
    ),
  );
});
afterEach(() => {
  vi.useRealTimers();
  process.exitCode = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
it("keeps the failed operation in both terminal publications, stops admission and releases the pool", async () => {
  vi.stubEnv("GANSO_BTC_WORKER_CONFIG_FILE", "/fixture.json");
  mocks.book.mockRejectedValue(
    new DOMException("private detail", "TimeoutError"),
  );
  mocks.context.mockResolvedValue(null);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await runBtcWorker();
  expect(process.exitCode).toBe(1);
  expect(mocks.capture).not.toHaveBeenCalled();
  expect(mocks.book).toHaveBeenCalledOnce();
  expect(mocks.stop).toHaveBeenCalled();
  expect(mocks.end).toHaveBeenCalledOnce();
  expect(mocks.write).toHaveBeenCalledTimes(2);
  for (const call of mocks.write.mock.calls as unknown as [string, string][]) {
    expect(JSON.parse(call[1])).toMatchObject({
      status: "stopped",
      gap_open: true,
      last_capture_at: null,
      reason: "BTC_COLLECTOR_RUNTIME_FAILED",
      failure: {
        stage: "book_snapshot",
        error_type: "TimeoutError",
        error_code: null,
      },
    });
    expect(call[1]).not.toContain("private");
  }
  expect(log.mock.calls[0]![0]).not.toContain("private");
});

function publications() {
  return (mocks.write.mock.calls as unknown as [string, string][]).map((call) =>
    JSON.parse(call[1]),
  );
}
it("persists unavailable context and continuing books/trades, then new evidence closes only its current gap", async () => {
  const normalContext = mocks.context.getMockImplementation()!;
  mocks.context
    .mockImplementationOnce(normalContext)
    .mockRejectedValueOnce(new DOMException("private", "TimeoutError"));
  const worker = runBtcWorker();
  await vi.advanceTimersByTimeAsync(5000);
  process.emit("SIGTERM");
  await vi.advanceTimersByTimeAsync(1000);
  await worker;
  const batches = mocks.capture.mock.calls.map((call) => call[1] ?? call[0]);
  const missing = batches.find(
    (batch) => batch.health.channels.context.status === "invalid",
  );
  expect(missing).toBeDefined();
  expect(
    missing.events.map((e: TradingMarketObservation) => e.channel).sort(),
  ).toEqual(["book", "trades"]);
  const recovering = batches.find(
    (batch) => batch.capturedAt === iso(start + 4000),
  );
  expect(recovering.health.channels.context.needs_revalidation).toBe(false);
  const recovered = recovering.events.find(
    (e: TradingMarketObservation) => e.channel === "context",
  );
  expect(recovered).toMatchObject({
    received_at: iso(start + 4000),
    source_timestamp: null,
    quality: "unknown",
    revalidation: "current_state_only",
    continuity: "unproven",
  });
  expect(
    recovering.health.gaps.find(
      (g: { epoch: number }) => g.epoch === recovered.gap_epoch,
    ),
  ).toMatchObject({
    detected_at: start + 2000,
    resumed_at: start + 4000,
    recovery: "current_state_only",
  });
  expect(
    publications().find((p) => p.last_capture_at === missing.capturedAt),
  ).toMatchObject({
    failure: null,
    consumer_freshness: { mark: { available: false } },
    context_http: { timeouts: 1 },
  });
  expect(
    publications().find((p) => p.last_capture_at === recovering.capturedAt),
  ).toMatchObject({
    failure: null,
    consumer_freshness: { mark: { available: true } },
    context_http: { timeouts: 1, consecutive_timeouts: 0 },
  });
  const times = batches.map((batch) => Date.parse(batch.capturedAt));
  expect(times.slice(1).every((at, i) => at - times[i]! === 1000)).toBe(true);
  expect(mocks.context).toHaveBeenCalledTimes(3);
  expect(mocks.end).toHaveBeenCalledOnce();
  expect(process.exitCode ?? 0).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
it("exhausts consecutive timeouts terminally with diagnostics, no extra request and pool cleanup", async () => {
  mocks.context.mockRejectedValue(new DOMException("private", "TimeoutError"));
  const worker = runBtcWorker();
  await vi.advanceTimersByTimeAsync(12000);
  await worker;
  expect(mocks.context).toHaveBeenCalledTimes(4);
  expect(publications().at(-1)).toMatchObject({
    status: "stopped",
    gap_open: true,
    failure: { stage: "context_snapshot", error_type: "TimeoutError" },
    context_http: { timeouts: 4, exhausted: true },
  });
  expect(process.exitCode).toBe(1);
  expect(mocks.end).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("keeps a later fatal context error terminal instead of pinning the earlier recoverable timeout", async () => {
  mocks.context
    .mockRejectedValueOnce(new DOMException("private", "TimeoutError"))
    .mockRejectedValueOnce(new Error("BTC_CONTEXT_TIME_UNPROVEN"));
  const worker = runBtcWorker();
  await vi.advanceTimersByTimeAsync(3000);
  await worker;
  expect(mocks.context).toHaveBeenCalledTimes(2);
  expect(publications().at(-1)).toMatchObject({
    reason: "BTC_CONTEXT_TIME_UNPROVEN",
    failure: { stage: "context_snapshot", error_type: "Error" },
    context_http: { timeouts: 1 },
  });
  expect(mocks.end).toHaveBeenCalledOnce();
});
it("aborts an in-flight context on operator stop without capture or late revival", async () => {
  let requestSignal: AbortSignal | undefined;
  mocks.context.mockImplementationOnce(
    async (_metadata, signal: AbortSignal) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  );
  const listeners = process.listenerCount("SIGTERM");
  const worker = runBtcWorker();
  await vi.advanceTimersByTimeAsync(0);
  expect(requestSignal?.aborted).toBe(false);
  process.emit("SIGTERM");
  await worker;
  expect(requestSignal?.aborted).toBe(true);
  expect(mocks.capture).not.toHaveBeenCalled();
  expect(mocks.observe).not.toHaveBeenCalled();
  expect(publications().at(-1)).toMatchObject({
    status: "stopped",
    reason: "BTC_COLLECTOR_OPERATOR_STOP",
    failure: null,
  });
  expect(mocks.end).toHaveBeenCalledOnce();
  expect(process.listenerCount("SIGTERM")).toBe(listeners);
  expect(vi.getTimerCount()).toBe(0);
});
