import { createCollectorRuntimeDiagnostics } from "./btc/runtime-diagnostics.js";
import { createContextPoll } from "./btc/context-poll.js";
import type {
  TradingInstrumentMetadata,
  TradingMarketObservation,
} from "@ganso-market/contracts/trading";
import { randomUUID } from "node:crypto";
import { readFile, rename, statfs, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import { createHyperliquidPublicAdapter } from "./venues/hyperliquid/public.js";
import { startHyperliquidBtcFeed } from "./venues/hyperliquid/feed.js";
import {
  fetchBtcContextSnapshot,
  fetchBtcBookSnapshot,
  fetchBtcMetadataSnapshot,
} from "./venues/hyperliquid/context-snapshot.js";
import {
  captureBtcMarketBatch,
  closeBtcMarketBars,
} from "./storage/btc-marketstore.js";
import { retentionCapacity } from "./storage/btc-retention.js";
import {
  assertCollectorCapacity,
  COLLECTOR_LIMITS,
  createCollector,
} from "./btc/collector.js";
import {
  assertPilotActive,
  inspectBtcWorkerConfig,
  PILOT_LIMITS,
} from "./btc/collector-policy.js";
export { inspectBtcWorkerConfig } from "./btc/collector-policy.js";

export const BTC_HEALTH_PATH = "/tmp/ganso-btc-health.json";
async function publish(value: unknown) {
  const text = JSON.stringify({
    service: "btc-worker",
    execution_mode: "paper",
    timestamp: new Date().toISOString(),
    limits: COLLECTOR_LIMITS,
    ...(value as object),
  });
  await writeFile(`${BTC_HEALTH_PATH}.tmp`, text, { mode: 0o600 });
  await rename(`${BTC_HEALTH_PATH}.tmp`, BTC_HEALTH_PATH);
}
export async function runBtcWorker() {
  if (process.argv.includes("--health")) {
    const state = JSON.parse(await readFile(BTC_HEALTH_PATH, "utf8"));
    assertPilotActive(state.pilot, Date.now());
    if (
      state.status !== "collecting" ||
      !state.last_capture_at ||
      !state.feed?.socket?.alive ||
      state.feed.subscriptions_confirmed !==
        state.feed.subscriptions_expected ||
      state.feed.channels.book.status !== "healthy" ||
      state.feed.channels.context.status !== "healthy" ||
      Date.now() - Date.parse(state.timestamp) > 15_000 ||
      Date.now() - Date.parse(state.last_capture_at) > 15_000
    )
      throw new Error("BTC_COLLECTOR_NOT_READY");
    return;
  }
  const file = process.env.GANSO_BTC_WORKER_CONFIG_FILE;
  if (!file) throw new Error("BTC_WORKER_CONFIG_REQUIRED");
  const config = inspectBtcWorkerConfig(
    JSON.parse(await readFile(file, "utf8")),
  );
  if (!config.enabled) {
    console.info(
      JSON.stringify({
        service: "btc-worker",
        status: "disabled",
        execution_mode: "paper",
      }),
    );
    return;
  }
  const limits = config.pilot ? PILOT_LIMITS : COLLECTOR_LIMITS;
  // Refuse an expired/replayed window before opening a pool or a public feed.
  try {
    assertPilotActive(config.pilot, Date.now());
  } catch (error) {
    await publish({
      status: "stopped",
      gap_open: true,
      last_capture_at: null,
      reason: (error as Error).message,
      pilot: config.pilot,
      limits,
    });
    throw error;
  }
  const runtime = await loadConfig();
  if (runtime.executionMode !== "paper")
    throw new Error("BTC_WORKER_PAPER_REQUIRED");
  const pool = createDatabasePool(runtime, {
    max: 2,
    queryTimeoutMs: 6000,
    applicationName: "ganso-btc-collector",
  });
  const diagnostics = createCollectorRuntimeDiagnostics();
  const stopSignal = new AbortController();
  let contextPoll:
    ReturnType<typeof createContextPoll<TradingMarketObservation>> | undefined;
  let bookPoll:
    ReturnType<typeof createContextPoll<TradingMarketObservation>> | undefined;
  let metadataPoll:
    ReturnType<typeof createContextPoll<TradingInstrumentMetadata>> | undefined;
  const observe = diagnostics.run;
  const publishStatus = (state: unknown) =>
    observe("publish", () =>
      publish({
        ...(state as object),
        failure: diagnostics.failure(),
        context_http: contextPoll?.status(),
        book_http: bookPoll?.status(),
        metadata_http: metadataPoll?.status(),
        limits,
        pilot: config.pilot ?? null,
      }),
    );
  let collector: ReturnType<typeof createCollector> | undefined;
  let stopRequested = false;
  let stopReason = "BTC_COLLECTOR_OPERATOR_STOP";
  let feed: ReturnType<typeof startHyperliquidBtcFeed> | undefined;
  const shutdown = () => {
    stopRequested = true;
    stopSignal.abort();
    feed?.stop();
  };
  const assertActive = () => {
    if (stopRequested) throw new Error(stopReason);
    assertPilotActive(config.pilot, Date.now());
  };
  // Absolute UTC window survives a restart. The timer also bounds this process
  // if the wall clock moves backwards. In-flight SQL keeps its existing budget;
  // confirmed commits are preserved, never retried or fabricated as rolled back.
  const pilotTimer = config.pilot
    ? setTimeout(
        () => {
          stopReason = "BTC_COLLECTOR_PILOT_EXPIRED";
          shutdown();
          collector?.stop(stopReason);
        },
        Math.max(0, Date.parse(config.pilot.stops_at) - Date.now()),
      )
    : undefined;
  const reconnect = () => feed?.reconnect();
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGUSR1", reconnect);
  try {
    async function capacity() {
      // /capacity is an empty read-only bind on the SAME host filesystem as PG.
      // The activation runbook verifies device identity; never inspect overlayfs.
      const disk = await statfs("/capacity", { bigint: true });
      const retention = await retentionCapacity(pool);
      const row = (
        await pool.query(`SELECT pg_database_size(current_database())::text AS database_bytes,
        pg_current_wal_lsn()::text AS wal_lsn, current_setting('max_connections')::int AS maximum,
        (SELECT count(*)::int FROM pg_stat_activity WHERE backend_type='client backend') AS used`)
      ).rows[0]!;
      return {
        diskTotalBytes: (disk.blocks * disk.bsize).toString(),
        diskAvailableBytes: (disk.bavail * disk.bsize).toString(),
        rawBytes: retention.raw_bytes,
        totalBytes: retention.total_bytes,
        physicalBytes: retention.allocated_bytes,
        rawQuotaBytes: retention.raw_quota_bytes,
        totalQuotaBytes: retention.total_quota_bytes,
        physicalQuotaBytes: String(14 * 1024 ** 3),
        databaseBytes: row.database_bytes as string,
        walLsn: row.wal_lsn as string,
        connections: row.used as number,
        maxConnections: row.maximum as number,
        retentionBlocked: retention.nonessentialBlocked,
        hold: retention.hold,
      };
    }
    await observe("capacity", async () => {
      assertActive();
      assertCollectorCapacity(await capacity(), limits);
      assertActive();
    });
    const adapter = createHyperliquidPublicAdapter();
    let metadata = await observe("metadata", () => adapter.getBtcMetadata());
    if (stopRequested) return;
    feed = startHyperliquidBtcFeed(metadata, "http_snapshot");
    const cooldown = { until: 0 };
    bookPoll = createContextPoll({
      now: Date.now,
      signal: stopSignal.signal,
      fetch: () => fetchBtcBookSnapshot(metadata, stopSignal.signal),
      unavailable: () => feed!.contextUnavailable("book"),
      intervalMs: limits.intervalMs,
      startToStart: true,
      stage: "book_snapshot",
      cooldown,
    });
    contextPoll = createContextPoll({
      now: Date.now,
      signal: stopSignal.signal,
      fetch: () => fetchBtcContextSnapshot(metadata, stopSignal.signal),
      unavailable: () => feed!.contextUnavailable(),
      cooldown,
    });
    collector = createCollector({
      limits,
      assertActive,
      feed,
      sessionId: randomUUID(),
      metadata: () => metadata,
      now: () => new Date().toISOString(),
      capacity: () => observe("capacity", capacity),
      capture: (batch) =>
        observe("capture", () => captureBtcMarketBatch(pool, batch, true)),
      closeBars: (at) =>
        observe("close_bars", () => closeBtcMarketBars(pool, at, true)),
    });
    let refreshed = Date.now(),
      logged = 0;
    let metadataUnavailable = false;
    metadataPoll = createContextPoll({
      now: Date.now,
      signal: stopSignal.signal,
      stage: "metadata",
      deadlineMs: 8000,
      cooldown,
      unavailable: () => {
        metadataUnavailable = true;
        feed!.contextUnavailable("book");
        feed!.contextUnavailable("context");
      },
      fetch: async () => {
        const next = await fetchBtcMetadataSnapshot(stopSignal.signal);
        if (
          next.instrument.instrument_version !==
          metadata.instrument.instrument_version
        )
          throw new Error("BTC_COLLECTOR_METADATA_CHANGED");
        return next;
      },
    });
    while (!stopRequested) {
      assertActive();
      const cycleStarted = Date.now();
      if (Date.now() - refreshed >= 60_000) {
        const next = await observe("metadata", () => metadataPoll!.poll());
        if (stopRequested) break;
        if (next) {
          metadata = next;
          metadataUnavailable = false;
          refreshed = Date.now();
        }
      }
      if (
        !metadataUnavailable &&
        !stopRequested &&
        feed.status().socket.connected
      ) {
        const generation = feed.status().generation;
        const results = await Promise.allSettled([
          observe("book_snapshot", () => bookPoll!.poll()),
          observe("context_snapshot", () => contextPoll!.poll()),
        ]);
        for (const result of results) {
          if (result.status === "rejected") throw result.reason;
        }
        if (stopRequested) break;
        // A completed read from before a disconnect cannot revalidate its
        // successor, even if the new connection opened while HTTP was pending.
        if (
          feed.status().socket.connected &&
          feed.status().generation === generation
        )
          for (const result of results)
            if (result.status === "fulfilled" && result.value)
              feed.observeSnapshot(result.value);
      }
      if (stopRequested) break;
      await collector.tick();
      await publishStatus(collector.status());
      if (Date.now() - logged >= 30_000) {
        console.info(
          JSON.stringify({
            ...collector.status(),
            context_http: contextPoll.status(),
            book_http: bookPoll.status(),
            metadata_http: metadataPoll.status(),
          }),
        );
        logged = Date.now();
      }
      // Start-to-start cadence: IO time must not add another full interval
      // to the age of a persisted book. Never catch up with a burst.
      // The book poll has its own start-to-start deadline. A few milliseconds
      // spent before that poll (for example refreshing metadata) must not make
      // the next cycle arrive early and skip an entire book request. Preserve
      // both minimum intervals; cap this alignment wait during HTTP backoff so
      // capacity, context, status and the absolute pilot deadline keep running.
      const completed = Date.now();
      await delay(
        Math.max(
          0,
          cycleStarted + limits.intervalMs - completed,
          Math.min(
            limits.intervalMs,
            Date.parse(bookPoll.status().next_attempt_at) - completed,
          ),
        ),
      );
    }
    collector.stop(stopReason);
  } catch (error) {
    const reason =
      error instanceof Error && /^BTC_[A-Z_]+$/.test(error.message)
        ? error.message
        : "BTC_COLLECTOR_RUNTIME_FAILED";
    // Expiry is an expected terminal stop. A concurrent real failure keeps its
    // own reason and nonzero exit instead of being hidden by the deadline.
    if (
      !collector?.status().gap_open ||
      stopReason === "BTC_COLLECTOR_PILOT_EXPIRED"
    )
      collector?.stop(reason);
    if (stopRequested) stopReason = reason;
    process.exitCode = [
      "BTC_COLLECTOR_PILOT_EXPIRED",
      "BTC_COLLECTOR_OPERATOR_STOP",
    ].includes(reason)
      ? 0
      : 1;
    console.error(
      JSON.stringify({
        ...(collector?.status() ?? { status: "stopped", reason }),
        failure: diagnostics.failure(),
        context_http: contextPoll?.status(),
        book_http: bookPoll?.status(),
        metadata_http: metadataPoll?.status(),
      }),
    );
    await publishStatus(
      collector?.status() ?? { status: "stopped", gap_open: true, reason },
    );
  } finally {
    if (pilotTimer) clearTimeout(pilotTimer);
    stopSignal.abort();
    feed?.stop();
    try {
      if (collector) await publishStatus(collector.status());
      else if (stopRequested)
        await publishStatus({
          status: "stopped",
          gap_open: true,
          last_capture_at: null,
          reason: stopReason,
        });
    } finally {
      await pool.end();
      process.off("SIGTERM", shutdown);
      process.off("SIGINT", shutdown);
      process.off("SIGUSR1", reconnect);
    }
  }
}
if (process.argv[1]?.endsWith("/btc-worker.js")) {
  await runBtcWorker().catch(() => {
    console.error("BTC_WORKER_STARTUP_FAILED");
    process.exitCode = 1;
  });
}
