import { describe, expect, it, vi } from "vitest";
import { inspectBtcWorkerConfig } from "../src/btc-worker.js";
import {
  assertCollectorCapacity,
  COLLECTOR_LIMITS,
  createCollector,
  walBytesBetween,
  collectorHorizon,
  type CapacitySample,
} from "../src/btc/collector.js";
import { health, metadata, start, iso, trade } from "./trading/bars-fixture.js";
import { HYPERLIQUID_FEED_LIMITS } from "../src/venues/hyperliquid/feed-normalizer.js";
import { normalizeHyperliquidFeed } from "../src/venues/hyperliquid/feed-normalizer.js";

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
    subscriptions_expected: 3,
    context_mode: "ws" as const,
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
  it("resumes above the old ceiling, with the measured corpus still charged", () => {
    expect(() =>
      assertCollectorCapacity({
        ...sample,
        rawBytes: "536909884",
        totalBytes: "798752769",
        physicalBytes: "473636864",
      }),
    ).not.toThrow();
    expect(COLLECTOR_LIMITS.rawBytes).toBeLessThan(10 * 1024 ** 3);
    expect(COLLECTOR_LIMITS.totalBytes).toBeLessThan(12 * 1024 ** 3);
  });
  it("estimates each ceiling independently and refuses a premature sustainability claim", () => {
    expect(collectorHorizon(sample, sample, 59999)).toBeNull();
    const after = {
      ...sample,
      totalBytes: "3600000",
      rawBytes: "1800000",
      physicalBytes: "1865536",
      diskAvailableBytes: String(90 * 1024 ** 3 - 7200000),
    };
    expect(collectorHorizon(sample, after, 3600000)).toMatchObject({
      logical: {
        bytes_per_hour: 3600000,
        remaining_seconds: Math.floor(
          (COLLECTOR_LIMITS.totalBytes - 3600000) / 1000,
        ),
      },
      raw: { bytes_per_hour: 1800000 },
      filesystem: { bytes_per_hour: 7200000 },
    });
  });
  it("coalesces only unexposed snapshots, persists the policy, and preserves every trade", async () => {
    const { deps, collector } = fixture();
    const book = (at: number) => ({
      ...normalizeHyperliquidFeed(
        "book",
        {
          coin: "BTC",
          time: at,
          levels: [
            [{ px: "64000", sz: "1", n: 1 }],
            [{ px: "64001", sz: "1", n: 1 }],
          ],
        },
        iso(at),
        metadata.instrument.instrument_version,
        "fixture",
      )[0]!,
      quality: "fresh" as const,
      gap_epoch: 0,
      revalidation: "none" as const,
      continuity: "unproven" as const,
    });
    const events = [
      book(start),
      trade(),
      book(start + 1000),
      trade(start + 1500, 2),
    ];
    deps.feed.drain.mockReturnValue(events);
    await collector.tick();
    expect(deps.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        events: events.slice(1),
        capturePolicy: {
          version: "btc-current-state.v1",
          snapshotsCoalesced: 1,
          trades: "all_observed",
          book: "latest_full_top_20_per_capture",
        },
      }),
    );
    expect(collector.status().counters.snapshots_coalesced).toBe(1);
  });
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
  it("timestamps a capture after health discovers a gap at a clock boundary", async () => {
    const { deps, state } = fixture();
    let clock = start;
    deps.feed.status = () => {
      state.gaps = [
        {
          epoch: 1,
          channel: "trades",
          reason: "silence",
          detected_at: ++clock,
          after_source_at: null,
          resumed_at: null,
          recovery: "pending",
        },
      ];
      return state;
    };
    deps.now = () => iso(clock);
    const capture = vi.fn(
      async (batch: {
        capturedAt: string;
        health: { gaps: { detected_at: number }[] };
      }) => {
        expect(batch.health.gaps[0]!.detected_at).toBeLessThanOrEqual(
          Date.parse(batch.capturedAt),
        );
        return { stored: 1, duplicates: 0 };
      },
    );
    await createCollector({ ...deps, capture }).tick();
    expect(capture).toHaveBeenCalledOnce();
  });
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
