// RFC-012 service runner. Event-driven recomputation (a new rule version or
// UMA status transition triggers the affected markets within one 10 s tick,
// meeting the RFC's <= 60 s acceptance bound) plus an hourly full sweep, the
// graph jobs (phase B) and the layer-divergence comparison. Every job is
// supervised: skip-if-running, catch-all logging, never a crash loop.

import { ensureScoreVersion, loadScoreableMarkets } from "./store.js";
import { buildGraph } from "./graph.js";
import { divergenceCheck } from "./divergence.js";
import { evaluateGraph } from "./evaluate.js";
import { pollOnchainOnce } from "./onchain.js";
import { recomputeMarkets } from "./recompute.js";
import { generateResolutionReport, reportDue } from "./report.js";
import { sanityCheck } from "./sanity.js";
import { lexiconHash, type ResolutionLexicon } from "./lexicon.js";
import { scoreConfigHash, type ResolutionConfig } from "./config.js";
import type { CuratedEdge } from "./curated.js";
import type { ResolutionPool } from "./types.js";

export const RESOLUTION_SERVICE = "polymarket-resolution";

export class ResolutionScopeError extends Error {
  public readonly reasonCode: string;

  public constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "ResolutionScopeError";
    this.reasonCode = reasonCode;
  }
}

function logJson(
  level: "info" | "warn" | "error",
  reasonCode: string,
  extra: Record<string, unknown> = {},
): void {
  process.stderr.write(
    `${JSON.stringify({
      level,
      service: RESOLUTION_SERVICE,
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      ...extra,
    })}\n`,
  );
}

export interface ResolutionRunnerDeps {
  readonly pool: ResolutionPool;
  readonly config: ResolutionConfig;
  readonly lexicon: ResolutionLexicon;
  readonly curatedEdges: readonly CuratedEdge[];
  readonly executionMode: string;
  readonly clock?: () => Date;
  /** Extra supervised jobs (onchain collector, daily report). */
  readonly extraJobs?: ReadonlyArray<{
    readonly name: string;
    readonly everyMs: number;
    readonly run: (asOf: Date) => Promise<void>;
  }>;
}

export interface ResolutionRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Test seam: run one supervised tick of a named job. */
  tickOnce(name: string): Promise<void>;
}

export function createResolutionRunner(
  deps: ResolutionRunnerDeps,
): ResolutionRunner {
  const clock = deps.clock ?? ((): Date => new Date());
  const timers: NodeJS.Timeout[] = [];
  const running = new Map<string, boolean>();
  const jobs = new Map<
    string,
    { everyMs: number; run: (asOf: Date) => Promise<void> }
  >();

  // Event cursor of the state tick: only rows newer than this trigger work.
  let lastEventId = 0n;
  let lastRuleVersionId = 0n;

  const recomputeDeps = {
    pool: deps.pool,
    config: deps.config,
    lexicon: deps.lexicon,
    scoreVersion: deps.config.scoreVersion,
  };

  async function stateTick(asOf: Date): Promise<void> {
    const events = await deps.pool.query<Record<string, unknown>>(
      `SELECT resolution_event_id, condition_id, event_type
         FROM polymarket_resolution_events
        WHERE resolution_event_id > $1
        ORDER BY resolution_event_id ASC
        LIMIT 500`,
      [lastEventId.toString()],
    );
    const rules = await deps.pool.query<Record<string, unknown>>(
      `SELECT rule_version_id, condition_id
         FROM polymarket_rule_versions
        WHERE rule_version_id > $1
        ORDER BY rule_version_id ASC
        LIMIT 500`,
      [lastRuleVersionId.toString()],
    );
    const statusTouched = new Set<string>();
    const ruleTouched = new Set<string>();
    for (const row of events.rows) {
      const id = BigInt(String(row.resolution_event_id));
      if (id > lastEventId) {
        lastEventId = id;
      }
      const conditionId = String(row.condition_id);
      if (row.event_type === "rule_change") {
        ruleTouched.add(conditionId);
      } else {
        statusTouched.add(conditionId);
      }
    }
    for (const row of rules.rows) {
      const id = BigInt(String(row.rule_version_id));
      if (id > lastRuleVersionId) {
        lastRuleVersionId = id;
      }
      ruleTouched.add(String(row.condition_id));
    }
    if (ruleTouched.size > 0) {
      const summary = await recomputeMarkets(
        recomputeDeps,
        "rule_change",
        asOf,
        [...ruleTouched],
      );
      logJson("info", "SCORES_RECOMPUTED", {
        trigger: "rule_change",
        ...summary,
      });
    }
    const statusOnly = [...statusTouched].filter((id) => !ruleTouched.has(id));
    if (statusOnly.length > 0) {
      const summary = await recomputeMarkets(
        recomputeDeps,
        "status_change",
        asOf,
        statusOnly,
      );
      logJson("info", "SCORES_RECOMPUTED", {
        trigger: "status_change",
        ...summary,
      });
    }
  }

  async function sweep(asOf: Date): Promise<void> {
    const summary = await recomputeMarkets(recomputeDeps, "sweep", asOf, null);
    logJson("info", "SCORES_RECOMPUTED", { trigger: "sweep", ...summary });
  }

  // Consecutive beyond-band counter per edge_key (violations need k in a row;
  // an in-memory reset on restart only makes the detector MORE conservative).
  const streaks = new Map<string, number>();

  async function graphBuild(asOf: Date): Promise<void> {
    const summary = await buildGraph(deps.pool, deps.curatedEdges, asOf);
    logJson("info", "GRAPH_BUILT", { ...summary });
  }

  async function graphEval(asOf: Date): Promise<void> {
    const violations = await evaluateGraph(
      deps.pool,
      deps.config,
      streaks,
      asOf,
    );
    const vetoes = await sanityCheck(deps.pool, deps.config, asOf);
    logJson("info", "GRAPH_EVALUATED", {
      ...violations,
      sanity_active: vetoes.active,
      sanity_opened: vetoes.opened,
      sanity_closed: vetoes.closed,
    });
  }

  async function divergence(asOf: Date): Promise<void> {
    const summary = await divergenceCheck(deps.pool, asOf);
    if (summary.rfc012Only > 0 || summary.rfc011Only > 0) {
      // The comparison the owner asked for: which layer fired alone.
      logJson("warn", "LAYER_DIVERGENCE_ACTIVE", { ...summary });
    }
  }

  async function onchain(_asOf: Date): Promise<void> {
    const summary = await pollOnchainOnce({
      pool: deps.pool,
      config: deps.config.onchain,
      clock,
    });
    if (
      summary !== null &&
      (summary.inserted > 0 || summary.decodedUnknown > 0)
    ) {
      logJson("info", "ONCHAIN_POLLED", {
        inserted: summary.inserted,
        decoded_unknown: summary.decodedUnknown,
        skipped_unmapped: summary.skippedUnmapped,
        to_block: summary.toBlock?.toString() ?? null,
      });
    }
  }

  async function report(asOf: Date): Promise<void> {
    // Due-check against the last STORED report: a deploy restarts the timer
    // but must never starve the daily measurement.
    if (!(await reportDue(deps.pool, deps.config.cadence.reportMs, asOf))) {
      return;
    }
    const { reportId } = await generateResolutionReport(recomputeDeps, asOf);
    logJson("info", "RESOLUTION_REPORT_GENERATED", { report_id: reportId });
  }

  async function heartbeat(asOf: Date): Promise<void> {
    await deps.pool.query("SELECT 1");
    const markets = await loadScoreableMarkets(deps.pool, asOf);
    logJson("info", "RESOLUTION_HEARTBEAT", {
      scoreable_markets: markets.length,
      score_version: deps.config.scoreVersion,
    });
  }

  function supervised(
    name: string,
    run: (asOf: Date) => Promise<void>,
  ): () => void {
    return () => {
      if (running.get(name) === true) {
        logJson("warn", "JOB_STILL_RUNNING", { job: name });
        return;
      }
      running.set(name, true);
      run(clock())
        .catch((error: unknown) => {
          logJson("error", "JOB_FAILED", {
            job: name,
            error_name: error instanceof Error ? error.name : "UnknownError",
          });
        })
        .finally(() => {
          running.set(name, false);
        });
    };
  }

  return {
    async start(): Promise<void> {
      // Analytics only. The runtime's only execution mode is paper; anything
      // else means this binary is running somewhere it must not.
      if (deps.executionMode !== "paper") {
        throw new ResolutionScopeError(
          "EXECUTION_MODE_NOT_PAPER",
          "resolution service only runs in paper mode",
        );
      }
      // Reproducibility gate: refuse to run when the configured score_version
      // names different weight/lexicon content than what is stored.
      await ensureScoreVersion(deps.pool, {
        scoreVersion: deps.config.scoreVersion,
        configHash: scoreConfigHash(deps.config),
        lexiconHash: lexiconHash(deps.lexicon),
        weights: deps.config.weights as unknown as Record<string, number>,
        thresholds: deps.config.thresholds as unknown as Record<string, number>,
        priors: deps.config.priors as unknown as Record<string, unknown>,
      });

      // Start the event cursor at the current head: the boot sweep below
      // covers everything older.
      const heads = await deps.pool.query<Record<string, unknown>>(
        `SELECT
           (SELECT COALESCE(MAX(resolution_event_id), 0) FROM polymarket_resolution_events) AS event_head,
           (SELECT COALESCE(MAX(rule_version_id), 0) FROM polymarket_rule_versions) AS rule_head`,
      );
      lastEventId = BigInt(String(heads.rows[0]?.event_head ?? 0));
      lastRuleVersionId = BigInt(String(heads.rows[0]?.rule_head ?? 0));

      logJson("info", "RESOLUTION_BOOT", {
        score_version: deps.config.scoreVersion,
        config_hash: scoreConfigHash(deps.config),
        lexicon_hash: lexiconHash(deps.lexicon),
        onchain_enabled: deps.config.onchain.enabled,
      });

      jobs.set("state_tick", {
        everyMs: deps.config.cadence.stateTickMs,
        run: stateTick,
      });
      jobs.set("sweep", { everyMs: deps.config.cadence.sweepMs, run: sweep });
      jobs.set("graph_build", {
        everyMs: deps.config.cadence.graphBuildMs,
        run: graphBuild,
      });
      jobs.set("graph_eval", {
        everyMs: deps.config.cadence.graphEvalMs,
        run: graphEval,
      });
      jobs.set("divergence", {
        everyMs: deps.config.cadence.divergenceMs,
        run: divergence,
      });
      if (deps.config.onchain.enabled) {
        jobs.set("onchain", {
          everyMs: deps.config.cadence.onchainPollMs,
          run: onchain,
        });
      }
      jobs.set("report", { everyMs: 600_000, run: report });
      jobs.set("heartbeat", {
        everyMs: deps.config.cadence.heartbeatMs,
        run: heartbeat,
      });
      for (const job of deps.extraJobs ?? []) {
        jobs.set(job.name, { everyMs: job.everyMs, run: job.run });
      }

      // One boot pass before the timers: every market gets a score row, a
      // current state and a graph as soon as the service is up.
      await recomputeMarkets(recomputeDeps, "boot", clock(), null)
        .then((summary) => {
          logJson("info", "SCORES_RECOMPUTED", { trigger: "boot", ...summary });
        })
        .catch((error: unknown) => {
          logJson("error", "JOB_FAILED", {
            job: "boot_sweep",
            error_name: error instanceof Error ? error.name : "UnknownError",
          });
        });
      await graphBuild(clock()).catch((error: unknown) => {
        logJson("error", "JOB_FAILED", {
          job: "graph_build_boot",
          error_name: error instanceof Error ? error.name : "UnknownError",
        });
      });
      await report(clock()).catch((error: unknown) => {
        logJson("error", "JOB_FAILED", {
          job: "report_boot",
          error_name: error instanceof Error ? error.name : "UnknownError",
        });
      });

      for (const [name, job] of jobs) {
        const timer = setInterval(supervised(name, job.run), job.everyMs);
        timers.push(timer);
      }
    },

    async stop(): Promise<void> {
      for (const timer of timers) {
        clearInterval(timer);
      }
      timers.length = 0;
    },

    async tickOnce(name: string): Promise<void> {
      const job = jobs.get(name);
      if (job === undefined) {
        throw new Error(`unknown job: ${name}`);
      }
      await job.run(clock());
    },
  };
}
