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
  reconnect: vi.fn(),
  metadata: vi.fn(),
  config: vi.fn(),
  capacity: vi.fn(),
  closeBars: vi.fn(),
  bootstrapMetadata: vi.fn(),
}));
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
}));
vi.mock("node:fs/promises", () => ({
  readFile: async () => JSON.stringify(mocks.config()),
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
  retentionCapacity: mocks.capacity,
}));
vi.mock("../src/venues/hyperliquid/public.js", () => ({
  createHyperliquidPublicAdapter: () => ({
    getBtcMetadata: mocks.bootstrapMetadata,
  }),
}));
vi.mock("../src/venues/hyperliquid/context-snapshot.js", async (original) => ({
  ...(await original<object>()),
  fetchBtcBookSnapshot: mocks.book,
  fetchBtcContextSnapshot: mocks.context,
  fetchBtcMetadataSnapshot: mocks.metadata,
}));
vi.mock("../src/storage/btc-marketstore.js", () => ({
  captureBtcMarketBatch: mocks.capture,
  closeBtcMarketBars: mocks.closeBars,
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
      mocks.unavailable.mockImplementation((channel = "context") =>
        machine.invalid(channel, Date.now()),
      );
      let generation = 1;
      mocks.reconnect.mockImplementation(() => {
        machine.disconnect(Date.now());
        generation++;
        machine.open(Date.now());
      });
      return {
        status: () => ({ ...machine.status(Date.now()), stopped, generation }),
        reconnect: mocks.reconnect,
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
import { SnapshotTransportError } from "../src/venues/hyperliquid/recovery.js";
import { PILOT_PROFILE } from "../src/btc/collector-policy.js";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  vi.spyOn(Math, "random").mockReturnValue(1);
  vi.stubEnv("GANSO_BTC_WORKER_CONFIG_FILE", "/fixture.json");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.config.mockReturnValue({
    schema_version: 1,
    execution_mode: "paper",
    enabled: true,
  });
  mocks.capacity.mockResolvedValue({
    raw_bytes: "0",
    total_bytes: "0",
    allocated_bytes: "0",
    raw_quota_bytes: String(10 * 1024 ** 3),
    total_quota_bytes: String(12 * 1024 ** 3),
    nonessentialBlocked: false,
    hold: true,
  });
  mocks.closeBars.mockResolvedValue({ closed: 0 });
  mocks.bootstrapMetadata.mockResolvedValue(metadata);
  mocks.capture.mockResolvedValue({ stored: 1, duplicates: 0 });
  mocks.metadata.mockResolvedValue(metadata);
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
  mocks.book.mockRejectedValue(new SyntaxError("private detail"));
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
        error_type: "SyntaxError",
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
function pilot(stopsAt = start + 3000, startsAt = start) {
  mocks.config.mockReturnValue({
    schema_version: 2,
    execution_mode: "paper",
    enabled: true,
    capacity_profile: PILOT_PROFILE,
    starts_at: iso(startsAt),
    stops_at: iso(stopsAt),
  });
}
it("expires the pilot autonomously and preserves the last committed capture", async () => {
  pilot();
  const worker = runBtcWorker();
  await vi.advanceTimersByTimeAsync(4000);
  await worker;
  expect(mocks.capture).toHaveBeenCalledTimes(3);
  expect(publications().at(-1)).toMatchObject({
    status: "stopped",
    reason: "BTC_COLLECTOR_PILOT_EXPIRED",
    last_capture_at: iso(start + 2000),
    limits: { totalBytes: 16 * 1024 ** 3, physicalBytes: 12 * 1024 ** 3 },
    effective_limits: { totalBytes: 12 * 1024 ** 3 },
    pilot: { stops_at: iso(start + 3000) },
  });
  expect(process.exitCode ?? 0).toBe(0);
  expect(mocks.end).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("rejects an expired restart before any database or public read and publishes the refusal", async () => {
  pilot();
  vi.setSystemTime(start + 3000);
  await expect(runBtcWorker()).rejects.toThrow("PILOT_EXPIRED");
  expect(mocks.capacity).not.toHaveBeenCalled();
  expect(mocks.bootstrapMetadata).not.toHaveBeenCalled();
  expect(publications().at(-1)).toMatchObject({
    status: "stopped",
    reason: "BTC_COLLECTOR_PILOT_EXPIRED",
  });
});
it("keeps the original end on a restart inside the window", async () => {
  pilot();
  vi.setSystemTime(start + 2500);
  const worker = runBtcWorker();
  await vi.advanceTimersByTimeAsync(2000);
  await worker;
  expect(mocks.capture).toHaveBeenCalledOnce();
  expect(publications().at(-1)).toMatchObject({
    reason: "BTC_COLLECTOR_PILOT_EXPIRED",
    pilot: { stops_at: iso(start + 3000) },
  });
});
it("does not extend the in-process deadline when the wall clock moves backwards", async () => {
  pilot(start + 3000, start - 3600_000);
  const worker = runBtcWorker();
  await vi.advanceTimersByTimeAsync(1000);
  vi.setSystemTime(start + 500);
  await vi.advanceTimersByTimeAsync(3000);
  await worker;
  expect(publications().at(-1)).toMatchObject({
    reason: "BTC_COLLECTOR_PILOT_EXPIRED",
  });
  expect(mocks.end).toHaveBeenCalledOnce();
});
it("does not start the feed if the deadline passes during capacity preflight", async () => {
  pilot();
  const capacity = await mocks.capacity();
  mocks.capacity.mockClear();
  mocks.capacity.mockImplementationOnce(async () => {
    await new Promise((r) => setTimeout(r, 4000));
    return capacity;
  });
  const worker = runBtcWorker();
  await vi.advanceTimersByTimeAsync(4000);
  await worker;
  expect(mocks.bootstrapMetadata).not.toHaveBeenCalled();
  expect(mocks.capture).not.toHaveBeenCalled();
  expect(publications().at(-1)).toMatchObject({
    reason: "BTC_COLLECTOR_PILOT_EXPIRED",
    last_capture_at: null,
  });
  expect(mocks.end).toHaveBeenCalledOnce();
});
it("publishes expiry even during metadata bootstrap before a collector exists", async () => {
  pilot();
  mocks.bootstrapMetadata.mockImplementationOnce(async () => {
    await new Promise((r) => setTimeout(r, 4000));
    return metadata;
  });
  const worker = runBtcWorker();
  await vi.advanceTimersByTimeAsync(4000);
  await worker;
  expect(mocks.capture).not.toHaveBeenCalled();
  expect(publications().at(-1)).toMatchObject({
    reason: "BTC_COLLECTOR_PILOT_EXPIRED",
    last_capture_at: null,
  });
  expect(mocks.end).toHaveBeenCalledOnce();
});
it("discards a late HTTP result after pilot expiry", async () => {
  pilot();
  const normal = mocks.book.getMockImplementation()!;
  mocks.book.mockImplementationOnce(async (...args) => {
    const event = await normal(...args);
    await new Promise((r) => setTimeout(r, 4000));
    return event;
  });
  const worker = runBtcWorker();
  await vi.advanceTimersByTimeAsync(4000);
  await worker;
  expect(mocks.capture).not.toHaveBeenCalled();
  expect(publications().at(-1)).toMatchObject({
    reason: "BTC_COLLECTOR_PILOT_EXPIRED",
  });
});
it.each([false, true])(
  "drains an in-flight transaction without a new bar write or retry; failure=%s",
  async (fail) => {
    pilot();
    mocks.capture.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 4000));
      if (fail) throw new Error("BTC_RETENTION_CAPACITY_REFUSED");
      return { stored: 1, duplicates: 0 };
    });
    const worker = runBtcWorker();
    await vi.advanceTimersByTimeAsync(4000);
    await worker;
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(mocks.closeBars).not.toHaveBeenCalled();
    expect(publications().at(-1)).toMatchObject({
      reason: fail
        ? "BTC_RETENTION_CAPACITY_REFUSED"
        : "BTC_COLLECTOR_PILOT_EXPIRED",
      counters: { captures: fail ? 0 : 1 },
      last_capture_at: fail ? null : iso(start),
    });
    expect(process.exitCode ?? 0).toBe(fail ? 1 : 0);
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("persists a book gap through a transient failure while context and trades continue", async () => {
  mocks.book.mockRejectedValueOnce(new SnapshotTransportError("network"));
  const worker = runBtcWorker();
  await vi.advanceTimersByTimeAsync(2000);
  process.emit("SIGTERM");
  await vi.advanceTimersByTimeAsync(1000);
  await worker;
  const initial = publications().find((p) => p.last_capture_at === iso(start));
  expect(initial).toMatchObject({
    failure: null,
    book_http: { recovery: { total_retries: 1 } },
    consumer_freshness: {
      book: { available: false },
      mark: { available: true },
    },
  });
  expect(
    publications().find((p) => p.last_capture_at === iso(start + 1000)),
  ).toMatchObject({ consumer_freshness: { book: { available: true } } });
});
it("discards responses started on an old socket generation before revalidation", async () => {
  const normal = mocks.book.getMockImplementation()!;
  mocks.book.mockImplementationOnce(async (...args) => {
    const event = await normal(...args);
    process.emit("SIGUSR1");
    return event;
  });
  const worker = runBtcWorker();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.reconnect).toHaveBeenCalledOnce();
  expect(mocks.observe).not.toHaveBeenCalled();
  expect(publications()[0]).toMatchObject({
    consumer_freshness: {
      book: { available: false },
      mark: { available: false },
    },
  });
  process.emit("SIGTERM");
  await vi.advanceTimersByTimeAsync(1000);
  await worker;
});
it("revalidates metadata after transient loss before accepting more book/context observations", async () => {
  mocks.metadata.mockRejectedValueOnce(new SnapshotTransportError("network"));
  const worker = runBtcWorker();
  await vi.advanceTimersByTimeAsync(63_000);
  process.emit("SIGTERM");
  await vi.advanceTimersByTimeAsync(1000);
  await worker;
  expect(
    publications().find((p) => p.last_capture_at === iso(start + 60_000)),
  ).toMatchObject({
    failure: null,
    consumer_freshness: {
      book: { available: false },
      mark: { available: false },
    },
    metadata_http: { recovery: { total_retries: 1 } },
  });
  expect(
    publications().find((p) => p.last_capture_at === iso(start + 62_000)),
  ).toMatchObject({
    consumer_freshness: {
      book: { available: true },
      mark: { available: true },
    },
  });
  expect(mocks.metadata).toHaveBeenCalledTimes(2);
});
it("makes a changed metadata identity terminal without retrying or writing that cycle", async () => {
  mocks.metadata.mockResolvedValue({
    ...metadata,
    instrument: { ...metadata.instrument, instrument_version: "changed" },
  });
  const worker = runBtcWorker();
  await vi.advanceTimersByTimeAsync(60_000);
  await worker;
  expect(mocks.metadata).toHaveBeenCalledOnce();
  expect(publications().at(-1)).toMatchObject({
    reason: "BTC_COLLECTOR_METADATA_CHANGED",
    failure: { stage: "metadata" },
  });
  expect(publications().at(-1).last_capture_at).toBe(iso(start + 59_000));
});
it("a rate limit delays every public HTTP poll, including the periodic metadata read", async () => {
  const normal = mocks.context.getMockImplementation()!;
  mocks.context.mockImplementation(async (...args) => {
    if (Date.now() === start + 58_000)
      throw new SnapshotTransportError("rate_limited", 60_000);
    return normal(...args);
  });
  const worker = runBtcWorker();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.metadata).not.toHaveBeenCalled();
  const count = mocks.book.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(mocks.book).toHaveBeenCalledTimes(count);
  expect(mocks.metadata).not.toHaveBeenCalled();
  process.emit("SIGTERM");
  await vi.advanceTimersByTimeAsync(1000);
  await worker;
});
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
  await vi.advanceTimersByTimeAsync(91_000);
  await worker;
  expect(mocks.context).toHaveBeenCalledTimes(7);
  expect(publications().at(-1)).toMatchObject({
    status: "stopped",
    gap_open: true,
    failure: { stage: "context_snapshot", error_type: "TimeoutError" },
    context_http: { timeouts: 7, exhausted: true },
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

it("aligns capture and book deadlines after small pre-poll jitter without skipping or bursting", async () => {
  pilot(start + 65000);
  const times: number[] = [];
  const normal = mocks.book.getMockImplementation()!;
  mocks.book.mockImplementation(async (...args) => {
    times.push(Date.now());
    return normal(...args);
  });
  mocks.metadata.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return metadata;
  });
  const worker = runBtcWorker();
  await vi.advanceTimersByTimeAsync(66000);
  await worker;
  expect(mocks.metadata).toHaveBeenCalledOnce();
  expect(times).toHaveLength(65);
  const gaps = times.slice(1).map((at, i) => at - times[i]!);
  expect(gaps.every((gap) => gap >= 1000 && gap <= 1005)).toBe(true);
  expect(publications().at(-1).reason).toBe("BTC_COLLECTOR_PILOT_EXPIRED");
  expect(vi.getTimerCount()).toBe(0);
});
