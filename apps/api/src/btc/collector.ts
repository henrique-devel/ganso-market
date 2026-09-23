import type { TradingInstrumentMetadata } from "@ganso-market/contracts/trading";
import type { BtcMarketBatch } from "../storage/btc-marketstore.js";
import type { startHyperliquidBtcFeed } from "../venues/hyperliquid/feed.js";

// A conservative initial envelope on existing capacity, below the SQL quotas.
// Reaching any ceiling stops collection; it never deletes evidence or restarts.
export const COLLECTOR_LIMITS = Object.freeze({
  intervalMs: 2000,
  diskReserveBytes: 1024 ** 3,
  rawBytes: 512 * 1024 ** 2,
  totalBytes: 768 * 1024 ** 2,
  physicalBytes: 1024 ** 3,
  connectionReserve: 8,
});
export interface CapacitySample {
  diskTotalBytes: string;
  diskAvailableBytes: string;
  rawBytes: string;
  totalBytes: string;
  physicalBytes: string;
  databaseBytes: string;
  walLsn: string;
  connections: number;
  maxConnections: number;
  retentionBlocked: boolean;
  hold: boolean;
}
export function assertCollectorCapacity(sample: CapacitySample): void {
  const total = BigInt(sample.diskTotalBytes);
  const available = BigInt(sample.diskAvailableBytes);
  if (total <= 0n || available < 0n || available > total)
    throw new Error("BTC_COLLECTOR_CAPACITY_UNKNOWN");
  if (available * 4n <= total + 4n * BigInt(COLLECTOR_LIMITS.diskReserveBytes))
    throw new Error("BTC_COLLECTOR_DISK_RESERVE");
  if (
    sample.retentionBlocked ||
    BigInt(sample.rawBytes) >= BigInt(COLLECTOR_LIMITS.rawBytes) ||
    BigInt(sample.totalBytes) >= BigInt(COLLECTOR_LIMITS.totalBytes) ||
    BigInt(sample.physicalBytes) >= BigInt(COLLECTOR_LIMITS.physicalBytes)
  )
    throw new Error("BTC_COLLECTOR_STORAGE_LIMIT");
  if (
    !Number.isInteger(sample.connections) ||
    !Number.isInteger(sample.maxConnections) ||
    sample.connections < 0 ||
    Math.max(sample.connections, 7) + COLLECTOR_LIMITS.connectionReserve >
      sample.maxConnections
  )
    throw new Error("BTC_COLLECTOR_CONNECTION_RESERVE");
}
export function walBytesBetween(before: string, after: string): string {
  const value = (lsn: string) => {
    if (!/^[0-9A-F]+\/[0-9A-F]+$/i.test(lsn))
      throw new Error("BTC_COLLECTOR_INVALID_WAL_LSN");
    const [high, low] = lsn.split("/");
    return (BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`);
  };
  return (value(after) - value(before)).toString();
}

type Feed = Pick<
  ReturnType<typeof startHyperliquidBtcFeed>,
  "status" | "drain" | "stop"
>;
export function createCollector(deps: {
  feed: Feed;
  sessionId: string;
  metadata: () => TradingInstrumentMetadata;
  now: () => string;
  capacity: () => Promise<CapacitySample>;
  capture: (
    batch: BtcMarketBatch,
  ) => Promise<{ stored: number; duplicates: number }>;
  closeBars: (at: string) => Promise<{ closed: number }>;
}) {
  let stopped = false;
  let reason: string | null = null;
  let pendingEvents = 0;
  let baseline: CapacitySample | null = null;
  let sample: CapacitySample | null = null;
  let lastCaptureAt: string | null = null;
  const counters = { captures: 0, events: 0, duplicates: 0, bars: 0 };
  function stop(code: string) {
    stopped = true;
    reason = code;
    deps.feed.stop();
  }
  return {
    stop,
    async tick() {
      if (stopped) throw new Error("BTC_COLLECTOR_STOPPED");
      try {
        sample = await deps.capacity();
        baseline ??= sample;
        assertCollectorCapacity(sample);
        const before = deps.feed.status();
        if (before.stopped) throw new Error("BTC_COLLECTOR_FEED_TERMINAL");
        if (before.counters.dropped > 0)
          throw new Error("BTC_COLLECTOR_BUFFER_OVERFLOW");
        const events = deps.feed.drain();
        pendingEvents = events.length;
        // status() can discover a silence gap. Stamp the capture afterwards so
        // newly detected gaps never appear to come from its future.
        const health = deps.feed.status();
        const at = deps.now();
        const result = await deps.capture({
          sessionId: deps.sessionId,
          capturedAt: at,
          metadata: deps.metadata(),
          events,
          health,
        });
        pendingEvents = 0;
        lastCaptureAt = at;
        counters.captures++;
        counters.events += result.stored;
        counters.duplicates += result.duplicates;
        // Recheck real disk allocation before the separate bar transaction.
        sample = await deps.capacity();
        assertCollectorCapacity(sample);
        counters.bars += (await deps.closeBars(at)).closed;
      } catch (error) {
        stop(
          error instanceof Error && /^BTC_[A-Z_]+$/.test(error.message)
            ? error.message
            : "BTC_COLLECTOR_WRITE_OR_CAPACITY_FAILED",
        );
        throw error;
      }
    },
    status() {
      return {
        status: stopped ? "stopped" : "collecting",
        reason,
        gap_open: stopped,
        pending_events: pendingEvents,
        last_capture_at: lastCaptureAt,
        counters: { ...counters },
        capacity: sample,
        growth:
          baseline && sample
            ? {
                logical_bytes: (
                  BigInt(sample.totalBytes) - BigInt(baseline.totalBytes)
                ).toString(),
                physical_bytes: (
                  BigInt(sample.physicalBytes) - BigInt(baseline.physicalBytes)
                ).toString(),
                disk_consumed_bytes: (
                  BigInt(baseline.diskAvailableBytes) -
                  BigInt(sample.diskAvailableBytes)
                ).toString(),
                wal_bytes_cluster: walBytesBetween(
                  baseline.walLsn,
                  sample.walLsn,
                ),
              }
            : null,
        feed: deps.feed.status(),
      };
    },
  };
}
