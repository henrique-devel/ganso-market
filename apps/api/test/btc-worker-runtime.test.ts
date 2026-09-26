import { afterEach, expect, it, vi } from "vitest";
import { metadata, health, start } from "./trading/bars-fixture.js";
const mocks = vi.hoisted(() => ({
  write: vi.fn(async () => {}),
  end: vi.fn(async () => {}),
  book: vi.fn(),
  context: vi.fn(),
  capture: vi.fn(),
  stop: vi.fn(),
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
vi.mock("../src/venues/hyperliquid/context-snapshot.js", () => ({
  fetchBtcBookSnapshot: mocks.book,
  fetchBtcContextSnapshot: mocks.context,
}));
vi.mock("../src/storage/btc-marketstore.js", () => ({
  captureBtcMarketBatch: mocks.capture,
  closeBtcMarketBars: vi.fn(),
}));
vi.mock("../src/venues/hyperliquid/feed.js", () => ({
  startHyperliquidBtcFeed: () => ({
    status: () => ({ ...health(start), stopped: false }),
    stop: mocks.stop,
    observeSnapshot: vi.fn(),
    drain: () => [],
  }),
}));
import { runBtcWorker } from "../src/btc-worker.js";
afterEach(() => {
  process.exitCode = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
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
