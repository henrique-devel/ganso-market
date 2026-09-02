import { ConfigError, loadConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import {
  PortfolioConfigError,
  loadPortfolioConfig,
} from "./polymarket/portfolio/config.js";
import {
  FactorMapError,
  loadFactorMap,
} from "./polymarket/portfolio/factors.js";
import {
  PORTFOLIO_SERVICE,
  PortfolioScopeError,
  createPortfolioRunner,
} from "./polymarket/portfolio/runner.js";
import {
  RESOLUTION_LEXICON_FILE_ENV,
  ResolutionLexiconError,
  lexiconHash,
  loadResolutionLexicon,
} from "./polymarket/resolution/lexicon.js";

async function run(): Promise<void> {
  const config = await loadConfig();
  const portfolio = await loadPortfolioConfig();
  const factorMap = await loadFactorMap();
  // RFC-018 D2: the `fonteResolucao` cap is keyed on the family of resolution
  // clause, classified with the RFC-012 vocabulary. Loaded from the same
  // versioned file the resolution service reads — an unreadable or invalid file
  // fails the boot, which is the right direction: an engine that cannot tell
  // two clauses apart would size every market into one bucket.
  const lexicon = await loadResolutionLexicon();
  // Said out loud, at boot, because the fallback is otherwise INVISIBLE.
  //
  // `loadResolutionLexicon` returns the built-in vocabulary when no file is
  // configured, which is the right default for a service that has none — but
  // here it would mean the cap buckets by one vocabulary while RFC-012 scores
  // by another, and nothing would say so. The CD lands `config/` on a bind
  // mount while the mount itself only appears on a profile recreate, so there
  // is a real window in which this can happen. The hash is printed so the two
  // services can be compared against each other in the log.
  const lexiconFile = process.env[RESOLUTION_LEXICON_FILE_ENV] ?? null;
  process.stderr.write(
    `${JSON.stringify({
      level: lexiconFile === null ? "warn" : "info",
      service: PORTFOLIO_SERVICE,
      timestamp: new Date().toISOString(),
      reason_code: "PORTFOLIO_LEXICON_LOADED",
      from_file: lexiconFile !== null,
      lexicon_hash: lexiconHash(lexicon),
      message:
        lexiconFile === null
          ? "polymarket_portfolio_lexicon_builtin"
          : "polymarket_portfolio_lexicon_from_file",
    })}\n`,
  );
  // The engine reads wide as-of windows (estimates, books, resolution state)
  // and writes small batches, like the resolution service: a forgiving query
  // timeout and a small pool.
  const pool = createDatabasePool(config, {
    max: 4,
    queryTimeoutMs: 60_000,
    applicationName: "ganso-market-polymarket-portfolio",
  });

  // RFC-013: decisions, sizing, exposures and gates only. SIMULAÇÃO — SEM
  // EXECUÇÃO REAL: no order, no wallet, no signer, no stop-loss exists in this
  // process, and portfolio/scope.test.ts fails the build if one appears.
  const runner = createPortfolioRunner({
    pool,
    config: portfolio,
    factorMap,
    lexicon,
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
        service: PORTFOLIO_SERVICE,
        timestamp: new Date().toISOString(),
        reason_code: `${signal}_RECEIVED`,
        message: "polymarket_portfolio_shutdown",
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
  // Every fatal boot failure says WHAT failed. A bare error_name of "Error"
  // says nothing, and diagnosing one in production means re-running the boot by
  // hand — a cost the resolution service already paid on 2026-08-26.
  const reasonCode =
    error instanceof ConfigError ||
    error instanceof PortfolioConfigError ||
    error instanceof FactorMapError ||
    error instanceof ResolutionLexiconError ||
    error instanceof PortfolioScopeError
      ? error.reasonCode
      : "PORTFOLIO_FAILED";
  process.stderr.write(
    `${JSON.stringify({
      level: "fatal",
      service: PORTFOLIO_SERVICE,
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      error_name: error instanceof Error ? error.name : "UnknownError",
      detail: error instanceof Error ? error.message : undefined,
      message: "polymarket_portfolio_failed",
    })}\n`,
  );
  process.exitCode = 1;
});
