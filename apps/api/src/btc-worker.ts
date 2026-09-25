import { createCollectorRuntimeDiagnostics } from "./btc/runtime-diagnostics.js";
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

export const BTC_HEALTH_PATH = "/tmp/ganso-btc-health.json";
export function inspectBtcWorkerConfig(value: unknown): { enabled: boolean } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schema_version" in value) ||
    value.schema_version !== 1 ||
    !("execution_mode" in value) ||
    value.execution_mode !== "paper" ||
    !("enabled" in value) ||
    typeof value.enabled !== "boolean" ||
    Object.keys(value).some(
      (key) => !["schema_version", "execution_mode", "enabled"].includes(key),
    )
  ) {
    throw new Error("BTC_WORKER_INVALID_CONFIG");
  }
  return { enabled: value.enabled };
}
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
  const runtime = await loadConfig();
  if (runtime.executionMode !== "paper")
    throw new Error("BTC_WORKER_PAPER_REQUIRED");
  const pool = createDatabasePool(runtime, {
    max: 2,
    queryTimeoutMs: 6000,
    applicationName: "ganso-btc-collector",
  });
  const diagnostics = createCollectorRuntimeDiagnostics();
  const observe = diagnostics.run;
  const publishStatus = (state: unknown) =>
    observe("publish", () =>
      publish({ ...(state as object), failure: diagnostics.failure() }),
    );
  let collector: ReturnType<typeof createCollector> | undefined;
  let stopRequested = false;
  let feed: ReturnType<typeof startHyperliquidBtcFeed> | undefined;
  const shutdown = () => {
    stopRequested = true;
    feed?.stop();
  };
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
        databaseBytes: row.database_bytes as string,
        walLsn: row.wal_lsn as string,
        connections: row.used as number,
        maxConnections: row.maximum as number,
        retentionBlocked: retention.nonessentialBlocked,
        hold: retention.hold,
      };
    }
    const checkedCapacity = () =>
      observe("capacity", async () => {
        const sample = await capacity();
        assertCollectorCapacity(sample);
        return sample;
      });
    await checkedCapacity();
    const adapter = createHyperliquidPublicAdapter();
    let metadata = await observe("metadata", () => adapter.getBtcMetadata());
    if (stopRequested) return;
    feed = startHyperliquidBtcFeed(metadata, "http_snapshot");
    collector = createCollector({
      feed,
      sessionId: randomUUID(),
      metadata: () => metadata,
      now: () => new Date().toISOString(),
      capacity: checkedCapacity,
      capture: (batch) =>
        observe("capture", () => captureBtcMarketBatch(pool, batch, true)),
      closeBars: (at) =>
        observe("close_bars", () => closeBtcMarketBars(pool, at, true)),
    });
    let refreshed = Date.now(),
      logged = 0,
      contextRefreshed = 0;
    while (!stopRequested) {
      const cycleStarted = Date.now();
      if (feed.status().socket.connected) {
        const contextDue = Date.now() - contextRefreshed >= 2000;
        const [book, context] = await Promise.all([
          observe("book_snapshot", () => fetchBtcBookSnapshot(metadata)),
          contextDue
            ? observe("context_snapshot", () =>
                fetchBtcContextSnapshot(metadata),
              )
            : Promise.resolve(null),
        ]);
        feed.observeSnapshot(book);
        if (context) {
          feed.observeSnapshot(context);
          contextRefreshed = Date.now();
        }
      }
      if (Date.now() - refreshed >= 60_000) {
        const current = await observe("metadata", async () => {
          const next = await adapter.getBtcMetadata();
          if (
            next.instrument.instrument_version !==
            metadata.instrument.instrument_version
          )
            throw new Error("BTC_COLLECTOR_METADATA_CHANGED");
          return next;
        });
        metadata = current;
        refreshed = Date.now();
      }
      if (stopRequested) break;
      await collector.tick();
      await publishStatus(collector.status());
      if (Date.now() - logged >= 30_000) {
        console.info(JSON.stringify(collector.status()));
        logged = Date.now();
      }
      // Start-to-start cadence: IO time must not add another full interval
      // to the age of a persisted book. Never catch up with a burst.
      await delay(
        Math.max(0, COLLECTOR_LIMITS.intervalMs - (Date.now() - cycleStarted)),
      );
    }
    collector.stop("BTC_COLLECTOR_OPERATOR_STOP");
  } catch (error) {
    const reason =
      error instanceof Error && /^BTC_[A-Z_]+$/.test(error.message)
        ? error.message
        : "BTC_COLLECTOR_RUNTIME_FAILED";
    if (!collector?.status().gap_open) collector?.stop(reason);
    process.exitCode = 1;
    console.error(
      JSON.stringify({
        ...(collector?.status() ?? { status: "stopped", reason }),
        failure: diagnostics.failure(),
      }),
    );
    await publishStatus(
      collector?.status() ?? { status: "stopped", gap_open: true, reason },
    );
  } finally {
    feed?.stop();
    try {
      if (collector) await publishStatus(collector.status());
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
