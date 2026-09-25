import type { TradingInstrumentMetadata } from "@ganso-market/contracts/trading";
import type { BtcMarketBatch } from "../storage/btc-marketstore.js";
import type { startHyperliquidBtcFeed } from "../venues/hyperliquid/feed.js";
import { contextSnapshotTime } from "../trading/valuation.js";

// Bounded operational capture on existing capacity, below the unchanged SQL quotas.
// Capacity/rate rationale and limited horizon: docs/runbooks/btc-collector.md.
// Reaching any ceiling stops collection; it never deletes evidence or restarts.
export const COLLECTOR_LIMITS = Object.freeze({
  intervalMs: 1000,
  diskReserveBytes: 1024 ** 3,
  rawBytes: 4 * 1024 ** 3,
  totalBytes: 6 * 1024 ** 3,
  physicalBytes: 4 * 1024 ** 3,
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
  if (
    [sample.rawBytes, sample.totalBytes, sample.physicalBytes].some(
      (v) => BigInt(v) < 0n,
    )
  )
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
  let baselineAt: number | null = null;
  let latestBook: BtcMarketBatch["events"][number] | undefined;
  let latestMark: BtcMarketBatch["events"][number] | undefined;
  const counters = {
    captures: 0,
    events: 0,
    duplicates: 0,
    bars: 0,
    snapshots_coalesced: 0,
  };
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
        baselineAt ??= Date.parse(deps.now());
        assertCollectorCapacity(sample);
        const before = deps.feed.status();
        if (before.stopped) throw new Error("BTC_COLLECTOR_FEED_TERMINAL");
        if (before.counters.dropped > 0)
          throw new Error("BTC_COLLECTOR_BUFFER_OVERFLOW");
        const drained = deps.feed.drain();
        // Only current-state snapshots not yet exposed to any consumer are
        // coalesced. Every trade and every selected full-depth snapshot survives.
        const events = drained.filter(
          (event, i) =>
            event.channel === "trades" ||
            !drained
              .slice(i + 1)
              .some((next) => next.channel === event.channel),
        );
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
          capturePolicy: {
            version: "btc-current-state.v1",
            snapshotsCoalesced: drained.length - events.length,
            trades: "all_observed",
            book: "latest_full_top_20_per_capture",
          },
        });
        pendingEvents = 0;
        lastCaptureAt = at;
        latestBook = events.findLast((e) => e.channel === "book") ?? latestBook;
        latestMark =
          events.findLast((e) => e.channel === "context") ?? latestMark;
        counters.captures++;
        counters.events += result.stored;
        counters.duplicates += result.duplicates;
        counters.snapshots_coalesced += drained.length - events.length;
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
      const feed = deps.feed.status(),
        now = Date.parse(deps.now());
      const readiness = (
        event: typeof latestBook,
        channel: "book" | "context",
        limit: number,
      ) => {
        const stamp =
          channel === "book"
            ? (event?.source_timestamp ?? null)
            : event?.payload.kind === "mark_funding" &&
                event.source_id === "hyperliquid:mainnet:info"
              ? contextSnapshotTime(event.payload.snapshot, event.received_at)
              : null;
        const age = stamp ? now - Date.parse(stamp) : null;
        const h = feed.channels[channel];
        return {
          available:
            !stopped &&
            age !== null &&
            age >= 0 &&
            age <= limit &&
            !!event &&
            event.received_at <= deps.now() &&
            now - Date.parse(event.received_at) <= limit &&
            h.status === "healthy" &&
            !h.needs_revalidation &&
            event.gap_epoch === h.gap_epoch &&
            feed.socket.alive,
          freshness_timestamp: stamp,
          source_timestamp: event?.source_timestamp ?? null,
          timestamp_basis:
            channel === "book"
              ? "venue_event"
              : stamp
                ? "http_response_date"
                : "unknown",
          age_ms: age,
          limit_ms: limit,
        };
      };
      return {
        status: stopped ? "stopped" : "collecting",
        reason,
        gap_open: stopped,
        pending_events: pendingEvents,
        last_capture_at: lastCaptureAt,
        counters: { ...counters },
        capacity: sample,
        consumer_freshness: {
          book: readiness(latestBook, "book", 2000),
          mark: readiness(latestMark, "context", 5000),
        },
        growth:
          baseline && sample
            ? {
                logical_bytes: (
                  BigInt(sample.totalBytes) - BigInt(baseline.totalBytes)
                ).toString(),
                raw_bytes: (
                  BigInt(sample.rawBytes) - BigInt(baseline.rawBytes)
                ).toString(),
                elapsed_ms: Date.parse(deps.now()) - baselineAt!,
                horizon: collectorHorizon(
                  baseline,
                  sample,
                  Date.parse(deps.now()) - baselineAt!,
                ),
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
        feed,
      };
    },
  };
}

/** Linear short-sample estimate, never a retention/sustainability guarantee.
 * Includes filesystem growth (whole host) separately from BTC table allocation. */
export function collectorHorizon(
  before: CapacitySample,
  after: CapacitySample,
  elapsedMs: number,
) {
  if (elapsedMs < 60_000) return null;
  const axes = [
    [
      "raw",
      BigInt(before.rawBytes),
      BigInt(after.rawBytes),
      BigInt(COLLECTOR_LIMITS.rawBytes),
    ],
    [
      "logical",
      BigInt(before.totalBytes),
      BigInt(after.totalBytes),
      BigInt(COLLECTOR_LIMITS.totalBytes),
    ],
    [
      "physical",
      BigInt(before.physicalBytes),
      BigInt(after.physicalBytes),
      BigInt(COLLECTOR_LIMITS.physicalBytes),
    ],
    [
      "filesystem",
      0n,
      BigInt(before.diskAvailableBytes) - BigInt(after.diskAvailableBytes),
      BigInt(before.diskAvailableBytes) -
        (BigInt(after.diskTotalBytes) + 3n) / 4n -
        BigInt(COLLECTOR_LIMITS.diskReserveBytes),
    ],
  ] as const;
  return Object.fromEntries(
    axes.map(([name, initial, current, limit]) => [
      name,
      current > initial
        ? {
            remaining_seconds: Math.max(
              0,
              Number(
                ((limit - current) * BigInt(Math.floor(elapsedMs))) /
                  (current - initial) /
                  1000n,
              ),
            ),
            bytes_per_hour: (Number(current - initial) * 3600000) / elapsedMs,
          }
        : null,
    ]),
  );
}
