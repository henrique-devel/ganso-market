import { createAuthService } from "./auth/service.js";
import { createPostgresAuthStore } from "./auth/store.js";
import { loadConfig, ConfigError } from "./config.js";
import {
  createDatabasePool,
  createPostgresReadinessProbe,
} from "./database.js";
import { createGracefulShutdown } from "./runtime.js";
import { buildApi } from "./server.js";

async function run(): Promise<void> {
  const config = await loadConfig();
  const pool = createDatabasePool(config);
  const authService = createAuthService({
    store: createPostgresAuthStore(pool),
  });
  const app = buildApi({
    config,
    readinessProbe: createPostgresReadinessProbe(pool),
    authService,
  });
  const gracefulShutdown = createGracefulShutdown(app, pool);
  gracefulShutdown.install();

  try {
    await app.listen({ host: config.server.host, port: config.server.port });
    app.log.info(
      {
        config,
        execution_mode: config.executionMode,
        host: config.server.host,
        port: config.server.port,
      },
      "api_started",
    );
  } catch (error) {
    await gracefulShutdown.shutdown("STARTUP_FAILURE");
    throw error;
  }
}

void run().catch((error: unknown) => {
  const reasonCode =
    error instanceof ConfigError ? error.reasonCode : "BOOT_FAILED";
  const errorName = error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(
    `${JSON.stringify({
      level: "fatal",
      service: "api",
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      error_name: errorName,
      message: "api_boot_failed",
    })}\n`,
  );
  process.exitCode = 1;
});
