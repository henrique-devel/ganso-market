import { ConfigError, loadConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import { createOrchestrator } from "./polymarket/orchestrator.js";

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

  await orchestrator.start();
  // The orchestrator owns timers and sockets; keep the process alive.
  await new Promise<void>(() => undefined);
}

void run().catch((error: unknown) => {
  const reasonCode =
    error instanceof ConfigError ? error.reasonCode : "RECORDER_FAILED";
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
