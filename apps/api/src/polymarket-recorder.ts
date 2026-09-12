import { randomUUID } from "node:crypto";
import {
  closeSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { ConfigError, loadConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import {
  createOrchestrator,
  waitForDatabase,
} from "./polymarket/orchestrator.js";
import { errorFields } from "./errors.js";

export const RECORDER_HEARTBEAT_PATH = "/tmp/ganso-recorder-heartbeat.json";
export const RECORDER_HEARTBEAT_INTERVAL_MS = 10_000;

/** Event-loop progress only; persistence is checked independently by the host. */
export function createRecorderHeartbeat(path = RECORDER_HEARTBEAT_PATH): {
  markRunning(): void;
  stop(): void;
} {
  let phase: "starting" | "running" | "stopping" = "starting";
  let seq = 0;
  let stopped = false;
  let writeFailed = false;
  const publish = (): void => {
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    let created = false;
    try {
      // An exclusive temporary file avoids following a pre-existing symlink.
      // Rename publishes a complete, small document with private permissions.
      descriptor = openSync(temporaryPath, "wx", 0o600);
      created = true;
      writeFileSync(
        descriptor,
        `${JSON.stringify({
          version: 1,
          pid: process.pid,
          seq: ++seq,
          timestamp: new Date().toISOString(),
          uptime_ms: Math.floor(process.uptime() * 1_000),
          phase,
        })}\n`,
      );
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, path);
      writeFailed = false;
    } catch {
      // Never log filesystem errors/paths or config. A failed write leaves the
      // previous heartbeat stale, allowing the external observer to detect it.
      if (!writeFailed) {
        process.stderr.write(
          `${JSON.stringify({
            level: "warn",
            service: "polymarket-recorder",
            timestamp: new Date().toISOString(),
            reason_code: "RECORDER_HEARTBEAT_WRITE_FAILED",
          })}\n`,
        );
        writeFailed = true;
      }
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Best effort after a filesystem failure.
        }
      }
      if (created) {
        try {
          unlinkSync(temporaryPath);
        } catch {
          // Normally absent after rename; never remove an unowned file.
        }
      }
    }
  };
  publish();
  const timer = setInterval(publish, RECORDER_HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return {
    markRunning(): void {
      if (!stopped) {
        phase = "running";
        publish();
      }
    },
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      phase = "stopping";
      publish();
    },
  };
}

export async function run(
  heartbeat = createRecorderHeartbeat(),
): Promise<void> {
  // Publish before database/config initialization so a booting process is
  // distinguishable from one whose event loop stopped making progress.
  try {
    const config = await loadConfig();
    // The recorder is a burst writer (L2 deltas + trades + RTDS): it needs a
    // larger pool and a forgiving query timeout, unlike the request-path API.
    const pool = createDatabasePool(config, {
      max: 10,
      queryTimeoutMs: 30_000,
      applicationName: "ganso-market-polymarket-recorder",
    });
    // RFC-007 data foundation: every collector is supervised inside the
    // orchestrator with its own backoff. Public data only — no trading, wallet,
    // or auth material.
    const orchestrator = createOrchestrator({ pool });

    let shuttingDown = false;
    const shutdown = (signal: string): void => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      heartbeat.stop();
      process.stderr.write(
        `${JSON.stringify({
          level: "info",
          service: "polymarket-recorder",
          timestamp: new Date().toISOString(),
          reason_code: `${signal}_RECEIVED`,
          message: "polymarket_recorder_shutdown",
        })}\n`,
      );
      orchestrator
        .stop()
        .then(() => pool.end())
        .finally(() => {
          process.exit(0);
        });
    };
    process.on("SIGTERM", () => {
      shutdown("SIGTERM");
    });
    process.on("SIGINT", () => {
      shutdown("SIGINT");
    });

    // RFC-020 D4.1: nothing is subscribed before the database answers. Booting
    // into a database that is still coming back is what produced 100
    // RETENTION_STEP_FAILED (EAI_AGAIN postgres) on the 14:47 and 14:51 boots of
    // 2026-09-02. If it never answers, this throws DatabaseUnavailableError and
    // the catch below exits non-zero so Docker restarts the container.
    await waitForDatabase(pool);
    await orchestrator.start();
    heartbeat.markRunning();
    // The orchestrator owns timers and sockets; keep the process alive.
    await new Promise<void>(() => undefined);
  } finally {
    heartbeat.stop();
  }
}

/** ConfigError and DatabaseUnavailableError both carry their own code. */
function reasonCodeOf(error: unknown): string {
  if (error instanceof ConfigError) {
    return error.reasonCode;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "reasonCode" in error &&
    typeof (error as { reasonCode: unknown }).reasonCode === "string"
  ) {
    return (error as { reasonCode: string }).reasonCode;
  }
  return "RECORDER_FAILED";
}

if (import.meta.main) {
  void run().catch((error: unknown) => {
    const reasonCode = reasonCodeOf(error);
    process.stderr.write(
      `${JSON.stringify({
        level: "fatal",
        service: "polymarket-recorder",
        timestamp: new Date().toISOString(),
        reason_code: reasonCode,
        ...errorFields(error),
        message: "polymarket_recorder_failed",
      })}\n`,
    );
    process.exitCode = 1;
  });
}
