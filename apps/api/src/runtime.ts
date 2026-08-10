import type { FastifyInstance } from "fastify";

import type { DatabasePool } from "./database.js";

type ShutdownReason = NodeJS.Signals | "STARTUP_FAILURE";

interface SignalSource {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

const processSignalSource: SignalSource = {
  once(signal, listener): void {
    process.once(signal, listener);
  },
  off(signal, listener): void {
    process.off(signal, listener);
  },
};

export interface GracefulShutdown {
  shutdown(reason: ShutdownReason): Promise<void>;
  install(): void;
  uninstall(): void;
}

export function createGracefulShutdown(
  app: Pick<FastifyInstance, "close" | "log">,
  pool: Pick<DatabasePool, "end">,
  signalSource: SignalSource = processSignalSource,
): GracefulShutdown {
  let shutdownPromise: Promise<void> | undefined;
  let installed = false;

  const handlers: Readonly<Record<NodeJS.Signals, () => void>> = {
    SIGINT: (): void => {
      void shutdown("SIGINT").catch(() => {
        process.exitCode = 1;
      });
    },
    SIGTERM: (): void => {
      void shutdown("SIGTERM").catch(() => {
        process.exitCode = 1;
      });
    },
  } as Readonly<Record<NodeJS.Signals, () => void>>;

  function install(): void {
    if (installed) {
      return;
    }
    installed = true;
    signalSource.once("SIGINT", handlers.SIGINT);
    signalSource.once("SIGTERM", handlers.SIGTERM);
  }

  function uninstall(): void {
    if (!installed) {
      return;
    }
    installed = false;
    signalSource.off("SIGINT", handlers.SIGINT);
    signalSource.off("SIGTERM", handlers.SIGTERM);
  }

  async function shutdown(reason: ShutdownReason): Promise<void> {
    shutdownPromise ??= (async () => {
      uninstall();
      app.log.info({ reason }, "shutdown_started");
      let closeError: unknown;
      try {
        await app.close();
      } catch (error) {
        closeError = error;
      }
      try {
        await pool.end();
      } catch (error) {
        closeError ??= error;
      }
      if (closeError !== undefined) {
        app.log.error(
          {
            reason_code: "SHUTDOWN_FAILED",
            error_name:
              closeError instanceof Error ? closeError.name : "UnknownError",
          },
          "shutdown_failed",
        );
        throw closeError;
      }
      app.log.info({ reason }, "shutdown_completed");
    })();
    return shutdownPromise;
  }

  return { shutdown, install, uninstall };
}
