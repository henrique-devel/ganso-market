import { describe, expect, it, vi } from "vitest";
import { inspectBtcWorkerConfig } from "../src/btc-worker.js";
import {
  assertCollectorCapacity,
  COLLECTOR_LIMITS,
  createCollector,
  walBytesBetween,
  type CapacitySample,
} from "../src/btc/collector.js";
import { health, metadata, start, iso, trade } from "./trading/bars-fixture.js";
import { HYPERLIQUID_FEED_LIMITS } from "../src/venues/hyperliquid/feed-normalizer.js";

const sample: CapacitySample = {
  diskTotalBytes: String(300 * 1024 ** 3),
  diskAvailableBytes: String(90 * 1024 ** 3),
  rawBytes: "0",
  totalBytes: "0",
  physicalBytes: "65536",
  databaseBytes: "200000000000",
  walLsn: "224/9A37E488",
  connections: 2,
  maxConnections: 40,
  retentionBlocked: false,
  hold: true,
};
function fixture() {
  const state = {
    ...health(start),
    retries: 0,
    stopped: false,
    terminal_reason: null,
    subscriptions_confirmed: 3,
    transport_limits: HYPERLIQUID_FEED_LIMITS,
  };
  const feed = {
    status: () => state,
    drain: vi.fn(() => [trade()]),
    stop: vi.fn(() => {
      state.stopped = true;
    }),
  };
  const deps = {
    feed,
    sessionId: "collector-test",
    metadata: () => metadata,
    now: () => iso(start + 2000),
    capacity: vi.fn(async () => ({ ...sample })),
    capture: vi.fn(async () => ({ stored: 1, duplicates: 0 })),
    closeBars: vi.fn(async () => ({ closed: 0 })),
  };
  return { state, deps, collector: createCollector(deps) };
}
describe("BTC collector admission and terminal refusal", () => {
  it.each([false, true])("accepts explicit paper enabled=%s", (enabled) => {
    expect(
      inspectBtcWorkerConfig({
        schema_version: 1,
        execution_mode: "paper",
        enabled,
      }),
    ).toEqual({ enabled });
  });
  it.each([
    null,
    {},
    { schema_version: 1, execution_mode: "live", enabled: true },
    { schema_version: 2, execution_mode: "paper", enabled: false },
    {
      schema_version: 1,
      execution_mode: "paper",
      enabled: true,
      strategy: true,
    },
  ])("rejects incompatible configuration %j", (value) => {
    expect(() => inspectBtcWorkerConfig(value)).toThrow(
      "BTC_WORKER_INVALID_CONFIG",
    );
  });
  it.each([
    [{ diskAvailableBytes: String(75 * 1024 ** 3) }, "DISK_RESERVE"],
    [{ diskAvailableBytes: String(76 * 1024 ** 3) }, "DISK_RESERVE"],
    [{ rawBytes: String(COLLECTOR_LIMITS.rawBytes) }, "STORAGE_LIMIT"],
    [{ totalBytes: String(COLLECTOR_LIMITS.totalBytes) }, "STORAGE_LIMIT"],
    [
      { physicalBytes: String(COLLECTOR_LIMITS.physicalBytes) },
      "STORAGE_LIMIT",
    ],
    [{ retentionBlocked: true }, "STORAGE_LIMIT"],
    [{ connections: 33 }, "CONNECTION_RESERVE"],
    [{ maxConnections: 14 }, "CONNECTION_RESERVE"],
  ] as const)(
    "refuses before draining or writing: %j",
    async (delta, reason) => {
      const { deps, collector } = fixture();
      deps.capacity.mockResolvedValue({ ...sample, ...delta });
      await expect(collector.tick()).rejects.toThrow(`BTC_COLLECTOR_${reason}`);
      expect(deps.feed.drain).not.toHaveBeenCalled();
      expect(deps.capture).not.toHaveBeenCalled();
      expect(deps.feed.stop).toHaveBeenCalledOnce();
      await expect(collector.tick()).rejects.toThrow("STOPPED");
    },
  );
  it("keeps HOLD and reports logical, physical and cluster WAL separately", async () => {
    const { deps, collector } = fixture();
    deps.capacity.mockResolvedValueOnce(sample).mockResolvedValueOnce({
      ...sample,
      totalBytes: "1000",
      physicalBytes: "131072",
      walLsn: "224/9A37F488",
    });
    await collector.tick();
    expect(collector.status()).toMatchObject({
      status: "collecting",
      capacity: { hold: true },
      growth: {
        logical_bytes: "1000",
        physical_bytes: "65536",
        wal_bytes_cluster: "4096",
      },
      counters: { captures: 1, events: 1, bars: 0 },
      pending_events: 0,
    });
    expect(deps.capture).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "collector-test", metadata }),
    );
  });
  it("stops before closing bars when disk crosses the guard after capture", async () => {
    const { deps, collector } = fixture();
    deps.capacity
      .mockResolvedValueOnce(sample)
      .mockResolvedValueOnce({ ...sample, diskAvailableBytes: "0" });
    await expect(collector.tick()).rejects.toThrow("DISK_RESERVE");
    expect(deps.closeBars).not.toHaveBeenCalled();
    expect(collector.status().counters.events).toBe(1);
  });
  it.each(["BTC_RETENTION_CAPACITY_REFUSED", "timeout with private context"])(
    "preserves a failed batch as an explicit unresolved gap: %s",
    async (message) => {
      const { deps, collector } = fixture();
      deps.capture.mockRejectedValue(new Error(message));
      await expect(collector.tick()).rejects.toThrow(message);
      expect(collector.status()).toMatchObject({
        status: "stopped",
        gap_open: true,
        pending_events: 1,
        last_capture_at: null,
        counters: { captures: 0, events: 0 },
      });
      expect(JSON.stringify(collector.status())).not.toContain(
        "private context",
      );
      expect(deps.closeBars).not.toHaveBeenCalled();
    },
  );
  it("stops on lost buffer admission without persisting a truncated batch", async () => {
    const { deps, collector, state } = fixture();
    state.counters.dropped = 1;
    await expect(collector.tick()).rejects.toThrow("BUFFER_OVERFLOW");
    expect(deps.capture).not.toHaveBeenCalled();
  });
  it("persists a transient reconnect gap, but stops exhausted retries", async () => {
    const { deps, collector, state } = fixture();
    state.socket.connected = false;
    state.retries = 1;
    await collector.tick();
    expect(deps.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        health: expect.objectContaining({ retries: 1 }),
      }),
    );
    state.stopped = true;
    await expect(collector.tick()).rejects.toThrow("FEED_TERMINAL");
  });
  it("rejects unknown disk capacity and counts WAL across a segment rollover", () => {
    expect(() =>
      assertCollectorCapacity({ ...sample, diskTotalBytes: "0" }),
    ).toThrow("CAPACITY_UNKNOWN");
    expect(walBytesBetween("1/FFFFFFF0", "2/10")).toBe("32");
  });
});
