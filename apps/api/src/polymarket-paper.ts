import { ConfigError, loadConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import { resolveGitSha } from "./polymarket/fundamental/provenance.js";
import {
  createPaperRunner,
  PaperScopeError,
} from "./polymarket/paper/runner.js";

async function run(): Promise<void> {
  const config = await loadConfig();
  // The paper broker's hot path is event-driven and small; it needs neither
  // the recorder's pool nor the estimator's long replay windows yet.
  const pool = createDatabasePool(config, {
    max: 2,
    queryTimeoutMs: 30_000,
    applicationName: "ganso-market-polymarket-paper",
  });
  const gitSha = await resolveGitSha();

  // RFC-011: simulation only — SIMULAÇÃO, SEM EXECUÇÃO REAL. No order signing,
  // trading auth, wallet or real order path exists in this process.
  const runner = createPaperRunner({
    pool,
    executionMode: config.executionMode,
    gitSha,
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stderr.write(
      `${JSON.stringify({
        level: "info",
        service: "polymarket-paper",
        timestamp: new Date().toISOString(),
        reason_code: `${signal}_RECEIVED`,
        message: "polymarket_paper_shutdown",
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
  // A refused boot has to say WHY (which config field, which guard), or the
  // operator is left guessing; the reason codes carry no secret material.
  const reasonCode =
    error instanceof ConfigError || error instanceof PaperScopeError
      ? error.reasonCode
      : "PAPER_BOOT_FAILED";
  const detail =
    error instanceof PaperScopeError ? { detail: error.message } : {};
  process.stderr.write(
    `${JSON.stringify({
      level: "fatal",
      service: "polymarket-paper",
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      error_name: error instanceof Error ? error.name : "UnknownError",
      ...detail,
      message: "polymarket_paper_failed",
    })}\n`,
  );
  process.exitCode = 1;
});
