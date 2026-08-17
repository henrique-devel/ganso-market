import { ConfigError, loadConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import {
  createPostgresRecorderStore,
  runRecorder,
} from "./polymarket/recorder.js";

const RECONNECT_DELAY_MS = 2_000;

async function run(): Promise<void> {
  const config = await loadConfig();
  const pool = createDatabasePool(config);
  const store = createPostgresRecorderStore(pool);
  try {
    // runRecorder resolves when the market socket closes; reconnect after a
    // short delay. Public data only — no trading, wallet, or auth.
    for (;;) {
      await runRecorder({ store });
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
    }
  } finally {
    await pool.end();
  }
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
