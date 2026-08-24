// RFC-011 foundation: the paper-broker process skeleton. This revision only
// boots, proves its guards and heartbeats; the microstructure features, the
// order validator/policy, the simulator and the ledger arrive with the next
// PRs of the RFC.
//
// SIMULAÇÃO — SEM EXECUÇÃO REAL: this process must never gain trading auth, a
// wallet, a signer or a real order path (scope.test.ts enforces it, the same
// guard the fundamental module carries).

import type { SqlExecutor } from "../../database.js";

const SERVICE = "polymarket-paper";

/** Mandatory RFC-011 banner: every surface of this module repeats it. */
export const SIMULATION_BANNER = "SIMULAÇÃO — SEM EXECUÇÃO REAL";

export const DEFAULT_HEARTBEAT_MS = 60_000;

export class PaperScopeError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "PaperScopeError";
    this.reasonCode = reasonCode;
  }
}

export interface PaperRunnerDeps {
  readonly pool: SqlExecutor;
  /** From the runtime config; anything but "paper" refuses to boot. */
  readonly executionMode: string;
  readonly gitSha: string | null;
  readonly heartbeatMs?: number;
  /** Test seam: replaces process.stderr. */
  readonly logSink?: (line: string) => void;
}

export interface PaperRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** One heartbeat probe; exposed for tests and the smoke path. */
  heartbeatOnce(): Promise<void>;
}

export function createPaperRunner(deps: PaperRunnerDeps): PaperRunner {
  const sink =
    deps.logSink ??
    ((line: string): void => {
      process.stderr.write(line);
    });
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let probing = false;

  function logJson(
    level: "info" | "warn" | "error",
    reasonCode: string,
    extra: Record<string, unknown> = {},
  ): void {
    sink(
      `${JSON.stringify({
        level,
        service: SERVICE,
        timestamp: new Date().toISOString(),
        reason_code: reasonCode,
        ...extra,
      })}\n`,
    );
  }

  async function heartbeatOnce(): Promise<void> {
    if (probing) {
      // A slow probe must not stack; skipping is safer than queueing.
      logJson("warn", "JOB_STILL_RUNNING", { job: "paper_heartbeat" });
      return;
    }
    probing = true;
    try {
      await deps.pool.query("SELECT 1");
      logJson("info", "PAPER_HEARTBEAT", {});
    } catch (error: unknown) {
      // The heartbeat reports health; it never kills the process.
      logJson("error", "PAPER_HEARTBEAT_FAILED", {
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    } finally {
      probing = false;
    }
  }

  return {
    start(): Promise<void> {
      if (deps.executionMode !== "paper") {
        // RFC-011 mandatory test: boot fails unless execution_mode is paper.
        // The runtime config already fails closed for unknown modes; this is
        // the module's own last line of defense, so a future config change
        // can never boot this process into anything but simulation.
        return Promise.reject(
          new PaperScopeError(
            "EXECUTION_MODE_NOT_PAPER",
            `refusing to boot with execution_mode "${deps.executionMode}"`,
          ),
        );
      }
      logJson("info", "PAPER_BOOT", {
        execution_mode: deps.executionMode,
        git_sha_known: deps.gitSha !== null,
        simulation: SIMULATION_BANNER,
      });
      timer = setInterval(() => {
        void heartbeatOnce();
      }, heartbeatMs);
      return Promise.resolve();
    },
    stop(): Promise<void> {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      logJson("info", "PAPER_STOPPED", {});
      return Promise.resolve();
    },
    heartbeatOnce,
  };
}
