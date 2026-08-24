// RFC-011: the paper-broker process. This revision boots under the paper-only
// guard, heartbeats, and runs the Part A feature pipeline: event-driven,
// incremental windows (1s/10s/1m per token, gated by horizon), computed only
// from data the recorder already persisted and never from anything after the
// window end. The order validator/policy, the simulator and the ledger arrive
// with the next PRs of the RFC.
//
// SIMULAÇÃO — SEM EXECUÇÃO REAL: this process must never gain trading auth, a
// wallet, a signer or a real order path (scope.test.ts enforces it, the same
// guard the fundamental module carries).

import type { SqlExecutor } from "../../database.js";
import {
  brokerTick,
  killSwitchTriggersTick,
  markTick,
  settlementTick,
} from "./brokerstore.js";
import {
  fillLabelerTick,
  fillReportIfDue,
  fillSamplerTick,
  markoutTick,
} from "./calibration.js";
import {
  WINDOW_MS,
  windowKindsForHorizon,
  type WindowKind,
} from "./features.js";
import { computeAndStoreWindow, type QueryPool } from "./featurestore.js";

const SERVICE = "polymarket-paper";

/** Mandatory RFC-011 banner: every surface of this module repeats it. */
export const SIMULATION_BANNER = "SIMULAÇÃO — SEM EXECUÇÃO REAL";

export const DEFAULT_HEARTBEAT_MS = 60_000;
export const DEFAULT_FEATURES_TICK_MS = 10_000;
export const DEFAULT_BROKER_TICK_MS = 2_000;
export const DEFAULT_SETTLEMENT_TICK_MS = 60_000;
export const DEFAULT_MARK_TICK_MS = 60_000;
export const DEFAULT_CALIBRATION_TICK_MS = 60_000;
export const DEFAULT_SAMPLER_TICK_MS = 300_000;

/** A token with a book snapshot this recent is "being recorded" (in universe). */
export const ACTIVE_TOKEN_WINDOW_MS = 10 * 60_000;

/**
 * Catch-up cap per token/kind/tick. A longer backlog (boot after downtime) is
 * SKIPPED, not replayed: features are a hot-path product, and re-scanning
 * history on boot is explicitly out of budget (RFC-011). The skip is logged.
 */
export const MAX_WINDOW_BACKLOG = 5;

/** Operational query (current state, not a feature input). */
const ACTIVE_TOKENS_SQL =
  "SELECT s.token_id, MAX(s.condition_id) AS condition_id, " +
  "MAX(m.end_date_iso) AS end_date_iso " +
  "FROM polymarket_book_snapshots s " +
  "LEFT JOIN polymarket_markets m ON m.condition_id = s.condition_id " +
  "WHERE s.received_at > $1 " +
  "GROUP BY s.token_id";

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
  readonly featuresTickMs?: number;
  readonly brokerTickMs?: number;
  readonly settlementTickMs?: number;
  readonly markTickMs?: number;
  readonly calibrationTickMs?: number;
  readonly samplerTickMs?: number;
  readonly latencyMs?: number;
  readonly clock?: () => Date;
  /** Test seam: replaces process.stderr. */
  readonly logSink?: (line: string) => void;
}

export interface PaperRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** One heartbeat probe; exposed for tests and the smoke path. */
  heartbeatOnce(): Promise<void>;
  /** One feature-pipeline tick; exposed for tests and the smoke path. */
  featuresTickOnce(): Promise<void>;
}

interface ActiveToken {
  readonly tokenId: string;
  readonly conditionId: string | null;
  readonly endDate: Date | null;
}

export function createPaperRunner(deps: PaperRunnerDeps): PaperRunner {
  const sink =
    deps.logSink ??
    ((line: string): void => {
      process.stderr.write(line);
    });
  const clock = deps.clock ?? ((): Date => new Date());
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const featuresTickMs = deps.featuresTickMs ?? DEFAULT_FEATURES_TICK_MS;
  const pool: QueryPool = deps.pool;

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let featuresTimer: ReturnType<typeof setInterval> | null = null;
  let brokerTimer: ReturnType<typeof setInterval> | null = null;
  let settlementTimer: ReturnType<typeof setInterval> | null = null;
  let markTimer: ReturnType<typeof setInterval> | null = null;
  let calibrationTimer: ReturnType<typeof setInterval> | null = null;
  let samplerTimer: ReturnType<typeof setInterval> | null = null;
  let probing = false;
  let computing = false;
  let brokering = false;
  let settling = false;
  let marking = false;
  let calibrating = false;
  let sampling = false;

  // Cursor of the last computed window start per token per kind. In-memory by
  // design: a restart resumes from "now" (bounded skip, logged), never from a
  // history re-scan.
  const cursors = new Map<string, number>();

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

  async function listActiveTokens(now: Date): Promise<ActiveToken[]> {
    const since = new Date(now.getTime() - ACTIVE_TOKEN_WINDOW_MS);
    const result = await deps.pool.query(ACTIVE_TOKENS_SQL, [since]);
    const tokens: ActiveToken[] = [];
    for (const row of result.rows) {
      const tokenId = row["token_id"];
      if (typeof tokenId !== "string" || tokenId.length === 0) {
        continue;
      }
      const conditionId = row["condition_id"];
      const endDateIso = row["end_date_iso"];
      let endDate: Date | null = null;
      if (typeof endDateIso === "string" && endDateIso.length > 0) {
        const parsed = new Date(endDateIso);
        endDate = Number.isNaN(parsed.getTime()) ? null : parsed;
      }
      tokens.push({
        tokenId,
        conditionId: typeof conditionId === "string" ? conditionId : null,
        endDate,
      });
    }
    return tokens;
  }

  async function computeDueWindows(
    token: ActiveToken,
    kind: WindowKind,
    nowMs: number,
  ): Promise<{ computed: number; persisted: number }> {
    const kindMs = WINDOW_MS[kind];
    // Latest window whose end is at or before now.
    const latestStart = Math.floor((nowMs - kindMs) / kindMs) * kindMs;
    if (latestStart < 0) {
      return { computed: 0, persisted: 0 };
    }
    const cursorKey = `${token.tokenId}:${kind}`;
    const cursor = cursors.get(cursorKey);
    // First sight of the token/kind: start at the latest complete window.
    let nextStart = cursor === undefined ? latestStart : cursor + kindMs;
    if (nextStart > latestStart) {
      return { computed: 0, persisted: 0 };
    }
    const backlog = (latestStart - nextStart) / kindMs + 1;
    if (backlog > MAX_WINDOW_BACKLOG) {
      const skipped = backlog - MAX_WINDOW_BACKLOG;
      logJson("warn", "FEATURES_BACKLOG_SKIPPED", {
        token_id: token.tokenId,
        window_kind: kind,
        windows_skipped: skipped,
      });
      nextStart = latestStart - (MAX_WINDOW_BACKLOG - 1) * kindMs;
    }
    let computed = 0;
    let persisted = 0;
    for (let start = nextStart; start <= latestStart; start += kindMs) {
      const stored = await computeAndStoreWindow(
        pool,
        token.tokenId,
        token.conditionId,
        kind,
        new Date(start),
        new Date(start + kindMs),
      );
      computed += 1;
      if (stored) {
        persisted += 1;
      }
      cursors.set(cursorKey, start);
    }
    return { computed, persisted };
  }

  async function featuresTickOnce(): Promise<void> {
    if (computing) {
      logJson("warn", "JOB_STILL_RUNNING", { job: "paper_features" });
      return;
    }
    computing = true;
    try {
      const now = clock();
      const tokens = await listActiveTokens(now);
      let computed = 0;
      let persisted = 0;
      let failures = 0;
      for (const token of tokens) {
        const horizon =
          token.endDate === null
            ? null
            : token.endDate.getTime() - now.getTime();
        for (const kind of windowKindsForHorizon(horizon)) {
          try {
            const result = await computeDueWindows(token, kind, now.getTime());
            computed += result.computed;
            persisted += result.persisted;
          } catch (error: unknown) {
            // One token/kind failing must not starve the rest of the universe.
            failures += 1;
            logJson("error", "FEATURES_WINDOW_FAILED", {
              token_id: token.tokenId,
              window_kind: kind,
              error_name: error instanceof Error ? error.name : "UnknownError",
            });
          }
        }
      }
      if (computed > 0 || failures > 0) {
        logJson("info", "FEATURES_TICK", {
          tokens: tokens.length,
          windows_computed: computed,
          windows_persisted: persisted,
          failures,
        });
      }
    } catch (error: unknown) {
      logJson("error", "FEATURES_TICK_FAILED", {
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    } finally {
      computing = false;
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
      heartbeatTimer = setInterval(() => {
        void heartbeatOnce();
      }, heartbeatMs);
      featuresTimer = setInterval(() => {
        void featuresTickOnce();
      }, featuresTickMs);
      const brokerDeps = {
        clock,
        logSink: sink,
        ...(deps.latencyMs === undefined ? {} : { latencyMs: deps.latencyMs }),
      };
      brokerTimer = setInterval(() => {
        if (brokering) {
          return;
        }
        brokering = true;
        void brokerTick(pool, brokerDeps).finally(() => {
          brokering = false;
        });
      }, deps.brokerTickMs ?? DEFAULT_BROKER_TICK_MS);
      settlementTimer = setInterval(() => {
        if (settling) {
          return;
        }
        settling = true;
        void settlementTick(pool, brokerDeps)
          .then(() => killSwitchTriggersTick(pool, brokerDeps))
          .finally(() => {
            settling = false;
          });
      }, deps.settlementTickMs ?? DEFAULT_SETTLEMENT_TICK_MS);
      markTimer = setInterval(() => {
        if (marking) {
          return;
        }
        marking = true;
        void markTick(pool, brokerDeps).finally(() => {
          marking = false;
        });
      }, deps.markTickMs ?? DEFAULT_MARK_TICK_MS);
      calibrationTimer = setInterval(() => {
        if (calibrating) {
          return;
        }
        calibrating = true;
        void markoutTick(pool, brokerDeps)
          .then(() => fillLabelerTick(pool, brokerDeps))
          .then(() => fillReportIfDue(pool, brokerDeps))
          .finally(() => {
            calibrating = false;
          });
      }, deps.calibrationTickMs ?? DEFAULT_CALIBRATION_TICK_MS);
      samplerTimer = setInterval(() => {
        if (sampling) {
          return;
        }
        sampling = true;
        void fillSamplerTick(pool, brokerDeps).finally(() => {
          sampling = false;
        });
      }, deps.samplerTickMs ?? DEFAULT_SAMPLER_TICK_MS);
      return Promise.resolve();
    },
    stop(): Promise<void> {
      for (const timer of [
        heartbeatTimer,
        featuresTimer,
        brokerTimer,
        settlementTimer,
        markTimer,
        calibrationTimer,
        samplerTimer,
      ]) {
        if (timer !== null) {
          clearInterval(timer);
        }
      }
      heartbeatTimer = null;
      featuresTimer = null;
      brokerTimer = null;
      settlementTimer = null;
      markTimer = null;
      calibrationTimer = null;
      samplerTimer = null;
      logJson("info", "PAPER_STOPPED", {});
      return Promise.resolve();
    },
    heartbeatOnce,
    featuresTickOnce,
  };
}
