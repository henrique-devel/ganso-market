import { ConfigError, loadConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import { loadFundamentalConfig } from "./polymarket/fundamental/config.js";
import { resolveGitSha } from "./polymarket/fundamental/provenance.js";
import { createRunner } from "./polymarket/fundamental/runner.js";

async function run(): Promise<void> {
  const config = await loadConfig();
  const fundamental = await loadFundamentalConfig();
  // The estimator reads wide windows (book replay, one-minute series, label
  // joins) and writes in small batches: it needs a larger query timeout than
  // the request-path API, but a much smaller pool than the recorder.
  const pool = createDatabasePool(config, {
    max: 4,
    queryTimeoutMs: 60_000,
    applicationName: "ganso-market-polymarket-estimator",
  });
  const gitSha = await resolveGitSha();

  // RFC-010: estimates only. No order, paper order, signal, wallet or signer
  // exists in this process.
  const runner = createRunner({ pool, config: fundamental, gitSha });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stderr.write(
      `${JSON.stringify({
        level: "info",
        service: "polymarket-estimator",
        timestamp: new Date().toISOString(),
        reason_code: `${signal}_RECEIVED`,
        message: "polymarket_estimator_shutdown",
      })}\n`,
    );
    runner
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

  await runner.start();
  // The runner owns the timers; keep the process alive.
  await new Promise<void>(() => undefined);
}

void run().catch((error: unknown) => {
  const reasonCode =
    error instanceof ConfigError ? error.reasonCode : "ESTIMATOR_FAILED";
  process.stderr.write(
    `${JSON.stringify({
      level: "fatal",
      service: "polymarket-estimator",
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      error_name: error instanceof Error ? error.name : "UnknownError",
      message: "polymarket_estimator_failed",
    })}\n`,
  );
  process.exitCode = 1;
});
