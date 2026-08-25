import { ConfigError, loadConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import {
  ResolutionConfigError,
  loadResolutionConfig,
} from "./polymarket/resolution/config.js";
import {
  GraphEdgesConfigError,
  loadCuratedEdges,
} from "./polymarket/resolution/curated.js";
import {
  ResolutionLexiconError,
  loadResolutionLexicon,
} from "./polymarket/resolution/lexicon.js";
import {
  RESOLUTION_SERVICE,
  createResolutionRunner,
} from "./polymarket/resolution/runner.js";

async function run(): Promise<void> {
  const config = await loadConfig();
  const resolution = await loadResolutionConfig();
  const lexicon = await loadResolutionLexicon();
  const curatedEdges = await loadCuratedEdges();
  // Scores and graph checks read wide as-of windows (rule versions, status
  // timelines, books) and write small batches: a slightly larger query
  // timeout than the request-path API, a small pool.
  const pool = createDatabasePool(config, {
    max: 4,
    queryTimeoutMs: 60_000,
    applicationName: "ganso-market-polymarket-resolution",
  });

  // RFC-012: scores, vetoes, buffers and consistency checks only. No order,
  // no paper order, no execution path exists in this process.
  const runner = createResolutionRunner({
    pool,
    config: resolution,
    lexicon,
    curatedEdges,
    executionMode: config.executionMode,
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
        service: RESOLUTION_SERVICE,
        timestamp: new Date().toISOString(),
        reason_code: `${signal}_RECEIVED`,
        message: "polymarket_resolution_shutdown",
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
  // A config failure has to say WHICH field it refused, or the operator is
  // left guessing; the reason codes name the field and carry no secrets.
  const reasonCode =
    error instanceof ConfigError ||
    error instanceof ResolutionConfigError ||
    error instanceof ResolutionLexiconError ||
    error instanceof GraphEdgesConfigError
      ? error.reasonCode
      : "RESOLUTION_FAILED";
  const detail =
    error instanceof ResolutionConfigError ||
    error instanceof ResolutionLexiconError ||
    error instanceof GraphEdgesConfigError
      ? { detail: error.message }
      : {};
  process.stderr.write(
    `${JSON.stringify({
      level: "fatal",
      service: RESOLUTION_SERVICE,
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      error_name: error instanceof Error ? error.name : "UnknownError",
      ...detail,
      message: "polymarket_resolution_failed",
    })}\n`,
  );
  process.exitCode = 1;
});
