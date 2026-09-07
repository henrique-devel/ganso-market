import { ConfigError, loadConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import {
  createOrchestrator,
  waitForDatabase,
} from "./polymarket/orchestrator.js";

async function run(): Promise<void> {
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
  // The orchestrator owns timers and sockets; keep the process alive.
  await new Promise<void>(() => undefined);
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

void run().catch((error: unknown) => {
  const reasonCode = reasonCodeOf(error);
  const errorName = error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(
    `${JSON.stringify({
      level: "fatal",
      service: "polymarket-recorder",
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      error_name: errorName,
      message: "polymarket_recorder_failed",
    })}\n`,
  );
  process.exitCode = 1;
});
