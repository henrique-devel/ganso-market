// RFC-012 service runner. Event-driven recomputation (a new rule version or
// UMA status transition triggers the affected markets within one 10 s tick,
// meeting the RFC's <= 60 s acceptance bound) plus an hourly full sweep, the
// graph jobs (phase B) and the layer-divergence comparison. Every job is
// supervised: skip-if-running, catch-all logging, never a crash loop. A
// durable generation/lease/watermark handshake keeps the paper broker closed
// whenever this process is booting, stale or behind its source tables.

import { randomUUID } from "node:crypto";

import type { DatabasePool, SqlExecutor } from "../../database.js";
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

/** The state tick refreshes this lease every 10 s under the default config. */
export const RESOLUTION_RUNTIME_LEASE_MS = 60_000;

export class ResolutionScopeError extends Error {
  public readonly reasonCode: string;

  public constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "ResolutionScopeError";
    this.reasonCode = reasonCode;
  }
}

class ResolutionLeaseExpiredError extends Error {
  public constructor() {
    super("resolution runtime lease expired before renewal");
    this.name = "ResolutionLeaseExpiredError";
  }
}

class ResolutionGraphExpiredError extends Error {
  public constructor() {
    super("resolution graph freshness expired before renewal");
    this.name = "ResolutionGraphExpiredError";
  }
}

function assertRecomputeComplete(
  summary: { readonly failed: number },
  trigger: string,
): void {
  if (summary.failed > 0) {
    throw new ResolutionScopeError(
      "RESOLUTION_RECOMPUTE_INCOMPLETE",
      `${trigger} recompute reported ${summary.failed} failed market(s)`,
    );
  }
}

function runtimeDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
  readonly pool: DatabasePool;
  readonly config: ResolutionConfig;
  readonly lexicon: ResolutionLexicon;
  readonly curatedEdges: readonly CuratedEdge[];
  readonly executionMode: string;
  readonly clock?: () => Date;
  /** Stable test seam; production generations are cryptographically random. */
  readonly generationFactory?: () => string;
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
  // Consecutive beyond-band counter per edge_key. Each database transaction
  // evaluates a private clone and publishes it only after COMMIT.
  const streaks = new Map<string, number>();
  const jobs = new Map<
    string,
    { everyMs: number; run: (asOf: Date) => Promise<void> }
  >();

  let generation: string | null = null;
  let recoveryRequired = false;
  let stopping = false;
  let graphPipelineTail: Promise<void> = Promise.resolve();

  async function withGraphPipelineMutex<T>(run: () => Promise<T>): Promise<T> {
    const previous = graphPipelineTail;
    let release = (): void => undefined;
    graphPipelineTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      assertRunning();
      return await run();
    } finally {
      release();
    }
  }

  function publishStreaks(next: ReadonlyMap<string, number>): void {
    streaks.clear();
    for (const [key, value] of next) {
      streaks.set(key, value);
    }
  }

  function leaseExpiresAt(asOf: Date): Date {
    return new Date(asOf.getTime() + RESOLUTION_RUNTIME_LEASE_MS);
  }

  function graphValidUntil(evaluatedAt: Date): Date {
    const validityMs = Math.max(
      RESOLUTION_RUNTIME_LEASE_MS,
      deps.config.cadence.graphEvalMs * 2,
    );
    return new Date(evaluatedAt.getTime() + validityMs);
  }

  function scoreDeps(pool: ResolutionPool) {
    return {
      pool,
      config: deps.config,
      lexicon: deps.lexicon,
      scoreVersion: deps.config.scoreVersion,
    };
  }

  function ownedGeneration(): string {
    if (generation === null) {
      throw new ResolutionScopeError(
        "RESOLUTION_RUNTIME_NOT_STARTED",
        "resolution runtime generation is not initialized",
      );
    }
    return generation;
  }

  function assertRunning(): void {
    if (stopping) {
      throw new ResolutionScopeError(
        "RESOLUTION_RUNTIME_STOPPING",
        "resolution runtime is stopping",
      );
    }
  }

  function assertLeaseCurrent(
    currentLease: Date | null,
    checkedAt: Date,
  ): void {
    if (
      currentLease === null ||
      currentLease.getTime() <= checkedAt.getTime()
    ) {
      throw new ResolutionLeaseExpiredError();
    }
  }

  function assertGraphCurrent(
    evaluatedAt: Date | null,
    validUntil: Date | null,
    checkedAt: Date,
  ): void {
    if (
      evaluatedAt === null ||
      validUntil === null ||
      validUntil.getTime() <= evaluatedAt.getTime() ||
      validUntil.getTime() <= checkedAt.getTime()
    ) {
      throw new ResolutionGraphExpiredError();
    }
  }

  async function evaluateGraphSafety(
    pool: ResolutionPool,
    asOf: Date,
    nextStreaks: Map<string, number>,
  ): Promise<{
    readonly violations: Awaited<ReturnType<typeof evaluateGraph>>;
    readonly vetoes: Awaited<ReturnType<typeof sanityCheck>>;
  }> {
    const violations = await evaluateGraph(
      pool,
      deps.config,
      nextStreaks,
      asOf,
    );
    assertRunning();
    const vetoes = await sanityCheck(pool, deps.config, asOf);
    return { violations, vetoes };
  }

  async function lockResolutionInputJournal(tx: SqlExecutor): Promise<void> {
    // Identity values may commit out of allocation order. Waiting for every
    // current writer before reading a head/cursor makes the visible prefix
    // contiguous, then blocks new writers until the watermark commits. Writers
    // never lock runtime state, and the broker uses this same journal-first
    // order, so this cannot form a lock cycle.
    await tx.query(
      "LOCK TABLE polymarket_resolution_input_changes IN SHARE MODE",
    );
  }

  async function markBooting(
    asOf: Date,
    nextGeneration: string,
  ): Promise<void> {
    await deps.pool.query(
      `INSERT INTO resolution_runtime_state
       (runtime_id, generation, score_version, ready, started_at,
          heartbeat_at, lease_expires_at, processed_resolution_event_id,
          processed_rule_version_id, processed_input_change_id,
          graph_evaluated_at, graph_valid_until, failure_reason, stopped_at,
          updated_at)
       VALUES (1, $1, $2, FALSE, $3, $3, $3, 0, 0, 0, NULL, NULL,
               NULL, NULL, $3)
       ON CONFLICT (runtime_id) DO UPDATE SET
         generation = EXCLUDED.generation,
         score_version = EXCLUDED.score_version,
         ready = FALSE,
         started_at = EXCLUDED.started_at,
         ready_at = NULL,
         heartbeat_at = EXCLUDED.heartbeat_at,
         lease_expires_at = EXCLUDED.lease_expires_at,
         last_success_at = NULL,
         processed_resolution_event_id = 0,
         processed_rule_version_id = 0,
         processed_input_change_id = 0,
         graph_evaluated_at = NULL,
         graph_valid_until = NULL,
         failure_reason = NULL,
         stopped_at = NULL,
         updated_at = EXCLUDED.updated_at`,
      [nextGeneration, deps.config.scoreVersion, asOf],
    );
  }

  async function markFailed(reason: string): Promise<void> {
    if (stopping) {
      return;
    }
    recoveryRequired = true;
    if (generation === null) {
      return;
    }
    try {
      const failedAt = clock();
      await deps.pool.query(
        `UPDATE resolution_runtime_state
            SET ready = FALSE, failure_reason = $2,
                lease_expires_at = $3, updated_at = $3
          WHERE runtime_id = 1 AND generation = $1::uuid
            AND stopped_at IS NULL`,
        [generation, reason, failedAt],
      );
    } catch {
      // The in-memory recovery latch survives a database outage. The next
      // successful state tick rotates generation before becoming ready.
    }
  }

  async function bootGenerationUnlocked(): Promise<void> {
    assertRunning();
    const nextGeneration = deps.generationFactory?.() ?? randomUUID();
    generation = nextGeneration;
    await markBooting(clock(), nextGeneration);
    assertRunning();

    await ensureScoreVersion(deps.pool, {
      scoreVersion: deps.config.scoreVersion,
      configHash: scoreConfigHash(deps.config),
      lexiconHash: lexiconHash(deps.lexicon),
      weights: deps.config.weights as unknown as Record<string, number>,
      thresholds: deps.config.thresholds as unknown as Record<string, number>,
      priors: deps.config.priors as unknown as Record<string, unknown>,
    });
    assertRunning();

    const result = await deps.pool.transaction(async (tx: SqlExecutor) => {
      await lockResolutionInputJournal(tx);
      assertRunning();
      const owned = await tx.query<Record<string, unknown>>(
        `SELECT generation FROM resolution_runtime_state
          WHERE runtime_id = 1 AND generation = $1::uuid
            AND stopped_at IS NULL
          FOR UPDATE`,
        [nextGeneration],
      );
      if (owned.rows.length !== 1) {
        throw new ResolutionScopeError(
          "RESOLUTION_GENERATION_LOST",
          "resolution runtime generation changed during boot",
        );
      }
      assertRunning();
      const heads = await tx.query<Record<string, unknown>>(
        `SELECT
           (SELECT COALESCE(MAX(input_change_id), 0) FROM polymarket_resolution_input_changes) AS input_head,
           (SELECT COALESCE(MAX(resolution_event_id), 0) FROM polymarket_resolution_events) AS event_head,
           (SELECT COALESCE(MAX(rule_version_id), 0) FROM polymarket_rule_versions) AS rule_head`,
      );
      assertRunning();
      const inputHead = BigInt(String(heads.rows[0]?.input_head ?? 0));
      const eventHead = BigInt(String(heads.rows[0]?.event_head ?? 0));
      const ruleHead = BigInt(String(heads.rows[0]?.rule_head ?? 0));
      const recomputeAt = clock();
      const summary = await recomputeMarkets(
        scoreDeps(tx),
        "boot",
        recomputeAt,
        null,
      );
      assertRecomputeComplete(summary, "boot");
      assertRunning();
      const graph = await buildGraph(tx, deps.curatedEdges, recomputeAt);
      assertRunning();
      const graphEvaluatedAt = clock();
      const nextStreaks = new Map<string, number>();
      const graphSafety = await evaluateGraphSafety(
        tx,
        graphEvaluatedAt,
        nextStreaks,
      );
      assertRunning();
      const publishedAt = clock();
      const graphExpiresAt = graphValidUntil(graphEvaluatedAt);
      assertGraphCurrent(graphEvaluatedAt, graphExpiresAt, publishedAt);
      const updated = await tx.query(
        `UPDATE resolution_runtime_state
            SET ready = TRUE, ready_at = $2, heartbeat_at = $2,
                lease_expires_at = $3, last_success_at = $2,
                processed_resolution_event_id = $4,
                processed_rule_version_id = $5,
                processed_input_change_id = $6,
                graph_evaluated_at = $7, graph_valid_until = $8,
                failure_reason = NULL, updated_at = $2
          WHERE runtime_id = 1 AND generation = $1::uuid
            AND stopped_at IS NULL`,
        [
          nextGeneration,
          publishedAt,
          leaseExpiresAt(publishedAt),
          eventHead.toString(),
          ruleHead.toString(),
          inputHead.toString(),
          graphEvaluatedAt,
          graphExpiresAt,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new ResolutionScopeError(
          "RESOLUTION_GENERATION_LOST",
          "resolution runtime generation changed before readiness",
        );
      }
      return { summary, graph, graphSafety, nextStreaks };
    });
    publishStreaks(result.nextStreaks);
    recoveryRequired = false;
    logJson("info", "SCORES_RECOMPUTED", {
      trigger: "boot",
      ...result.summary,
    });
    logJson("info", "GRAPH_BUILT", { ...result.graph });
    logJson("info", "GRAPH_EVALUATED", {
      ...result.graphSafety.violations,
      sanity_active: result.graphSafety.vetoes.active,
      sanity_opened: result.graphSafety.vetoes.opened,
      sanity_closed: result.graphSafety.vetoes.closed,
    });
  }

  async function bootGeneration(): Promise<void> {
    await withGraphPipelineMutex(bootGenerationUnlocked);
  }

  async function stateTickUnlocked(_scheduledAt: Date): Promise<void> {
    assertRunning();
    if (recoveryRequired) {
      await bootGenerationUnlocked();
      return;
    }
    const currentGeneration = ownedGeneration();
    try {
      const summaries = await deps.pool.transaction(async (tx: SqlExecutor) => {
        await lockResolutionInputJournal(tx);
        assertRunning();
        const state = await tx.query<Record<string, unknown>>(
          `SELECT processed_resolution_event_id, processed_rule_version_id,
                  processed_input_change_id, lease_expires_at,
                  graph_evaluated_at, graph_valid_until
             FROM resolution_runtime_state
            WHERE runtime_id = 1 AND generation = $1::uuid
              AND stopped_at IS NULL
            FOR UPDATE`,
          [currentGeneration],
        );
        const row = state.rows[0];
        if (row === undefined) {
          throw new ResolutionScopeError(
            "RESOLUTION_GENERATION_LOST",
            "resolution runtime generation changed during state tick",
          );
        }
        assertRunning();
        const currentLease = runtimeDate(row.lease_expires_at);
        const currentGraphEvaluatedAt = runtimeDate(row.graph_evaluated_at);
        const currentGraphValidUntil = runtimeDate(row.graph_valid_until);
        const checkedAt = clock();
        assertLeaseCurrent(currentLease, checkedAt);
        assertGraphCurrent(
          currentGraphEvaluatedAt,
          currentGraphValidUntil,
          checkedAt,
        );
        const lastEventId = BigInt(
          String(row.processed_resolution_event_id ?? 0),
        );
        const lastRuleVersionId = BigInt(
          String(row.processed_rule_version_id ?? 0),
        );
        const lastInputChangeId = BigInt(
          String(row.processed_input_change_id ?? 0),
        );
        const changes = await tx.query<Record<string, unknown>>(
          `SELECT c.input_change_id, c.source, c.source_key, c.condition_id,
                  e.resolution_event_id, e.event_type, r.rule_version_id
             FROM polymarket_resolution_input_changes c
             LEFT JOIN polymarket_resolution_events e
               ON c.source = 'resolution_event'
              AND e.resolution_event_id::text = c.source_key
             LEFT JOIN polymarket_rule_versions r
               ON c.source = 'rule_version'
              AND r.rule_version_id::text = c.source_key
            WHERE c.input_change_id > $1
            ORDER BY c.input_change_id ASC
        LIMIT 500`,
          [lastInputChangeId.toString()],
        );
        assertRunning();
        const recomputeAt = clock();
        assertLeaseCurrent(currentLease, recomputeAt);
        assertGraphCurrent(
          currentGraphEvaluatedAt,
          currentGraphValidUntil,
          recomputeAt,
        );
        const statusTouched = new Set<string>();
        const ruleTouched = new Set<string>();
        let fullTrigger: "rule_change" | "status_change" | null = null;
        let nextEventId = lastEventId;
        let nextRuleVersionId = lastRuleVersionId;
        let nextInputChangeId = lastInputChangeId;
        for (const change of changes.rows) {
          const inputChangeId = BigInt(String(change.input_change_id));
          if (inputChangeId > nextInputChangeId) {
            nextInputChangeId = inputChangeId;
          }
          if (change.resolution_event_id !== null) {
            const eventId = BigInt(String(change.resolution_event_id));
            if (eventId > nextEventId) {
              nextEventId = eventId;
            }
          }
          if (change.rule_version_id !== null) {
            const ruleVersionId = BigInt(String(change.rule_version_id));
            if (ruleVersionId > nextRuleVersionId) {
              nextRuleVersionId = ruleVersionId;
            }
          }
          const conditionId = String(change.condition_id);
          if (change.source === "market_metadata") {
            // Category changes alter measured priors for every market. A full
            // rule-style recompute supersedes every incremental set below.
            fullTrigger ??= "rule_change";
          }
          if (
            change.source === "resolution_event" &&
            (change.event_type === "disputed" ||
              change.event_type === "resolved" ||
              change.event_type === "market_resolved")
          ) {
            // Dispute/terminal facts change the global measured prior; terminal
            // facts may also release an entire coupled group. Status semantics
            // take precedence when a batch also contains metadata.
            fullTrigger = "status_change";
          }
          if (
            change.source !== "resolution_event" ||
            change.event_type === "rule_change"
          ) {
            ruleTouched.add(conditionId);
          } else {
            statusTouched.add(conditionId);
          }
        }
        const logged: Array<Record<string, unknown>> = [];
        if (fullTrigger !== null) {
          const summary = await recomputeMarkets(
            scoreDeps(tx),
            fullTrigger,
            recomputeAt,
            null,
          );
          assertRecomputeComplete(summary, fullTrigger);
          logged.push({ trigger: fullTrigger, ...summary });
        } else if (ruleTouched.size > 0) {
          const summary = await recomputeMarkets(
            scoreDeps(tx),
            "rule_change",
            recomputeAt,
            [...ruleTouched],
          );
          assertRecomputeComplete(summary, "rule_change");
          logged.push({ trigger: "rule_change", ...summary });
        }
        const statusOnly =
          fullTrigger === null
            ? [...statusTouched].filter((id) => !ruleTouched.has(id))
            : [];
        if (statusOnly.length > 0) {
          const summary = await recomputeMarkets(
            scoreDeps(tx),
            "status_change",
            recomputeAt,
            statusOnly,
          );
          assertRecomputeComplete(summary, "status_change");
          logged.push({ trigger: "status_change", ...summary });
        }
        assertRunning();
        let graph: Awaited<ReturnType<typeof buildGraph>> | null = null;
        let graphSafety: Awaited<
          ReturnType<typeof evaluateGraphSafety>
        > | null = null;
        let nextStreaks: Map<string, number> | null = null;
        let nextGraphEvaluatedAt = currentGraphEvaluatedAt;
        let nextGraphValidUntil = currentGraphValidUntil;
        if (changes.rows.length > 0) {
          // Every source can change topology, cost bands, suppression or
          // grouping. One non-empty batch is one causal graph revision, so its
          // cursor waits for the complete build -> evaluate -> sanity chain.
          // Resetting the private streak copy avoids counting the same book on
          // both sides of this logical revision; later periodic observations
          // rebuild the consecutive-snapshot count.
          graph = await buildGraph(tx, deps.curatedEdges, clock());
          assertRunning();
          nextGraphEvaluatedAt = clock();
          nextStreaks = new Map<string, number>();
          graphSafety = await evaluateGraphSafety(
            tx,
            nextGraphEvaluatedAt,
            nextStreaks,
          );
          nextGraphValidUntil = graphValidUntil(nextGraphEvaluatedAt);
          assertRunning();
        }
        const completedAt = clock();
        assertLeaseCurrent(currentLease, completedAt);
        assertGraphCurrent(
          currentGraphEvaluatedAt,
          currentGraphValidUntil,
          completedAt,
        );
        assertGraphCurrent(
          nextGraphEvaluatedAt,
          nextGraphValidUntil,
          completedAt,
        );
        const updated = await tx.query(
          `UPDATE resolution_runtime_state
              SET ready = TRUE, heartbeat_at = $2, lease_expires_at = $3,
                  last_success_at = $2,
                  processed_resolution_event_id = $4,
                  processed_rule_version_id = $5,
                  processed_input_change_id = $6,
                  graph_evaluated_at = $7, graph_valid_until = $8,
                  failure_reason = NULL, updated_at = $2
            WHERE runtime_id = 1 AND generation = $1::uuid
              AND stopped_at IS NULL AND lease_expires_at > $2
              AND graph_valid_until > $2`,
          [
            currentGeneration,
            completedAt,
            leaseExpiresAt(completedAt),
            nextEventId.toString(),
            nextRuleVersionId.toString(),
            nextInputChangeId.toString(),
            nextGraphEvaluatedAt,
            nextGraphValidUntil,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new ResolutionScopeError(
            "RESOLUTION_GENERATION_LOST",
            "resolution runtime generation changed before cursor commit",
          );
        }
        return { logged, graph, graphSafety, nextStreaks };
      });
      if (summaries.nextStreaks !== null) {
        publishStreaks(summaries.nextStreaks);
      }
      for (const summary of summaries.logged) {
        logJson("info", "SCORES_RECOMPUTED", summary);
      }
      if (summaries.graph !== null) {
        logJson("info", "GRAPH_BUILT", { ...summaries.graph });
      }
      if (summaries.graphSafety !== null) {
        logJson("info", "GRAPH_EVALUATED", {
          ...summaries.graphSafety.violations,
          sanity_active: summaries.graphSafety.vetoes.active,
          sanity_opened: summaries.graphSafety.vetoes.opened,
          sanity_closed: summaries.graphSafety.vetoes.closed,
        });
      }
    } catch (error: unknown) {
      if (stopping) {
        throw error;
      }
      await markFailed("STATE_TICK_FAILED");
      if (
        error instanceof ResolutionLeaseExpiredError ||
        error instanceof ResolutionGraphExpiredError
      ) {
        await bootGenerationUnlocked();
        return;
      }
      throw error;
    }
  }

  async function stateTick(scheduledAt: Date): Promise<void> {
    await withGraphPipelineMutex(() => stateTickUnlocked(scheduledAt));
  }

  async function sweepUnlocked(_scheduledAt: Date): Promise<void> {
    assertRunning();
    const currentGeneration = ownedGeneration();
    try {
      const summary = await deps.pool.transaction(async (tx: SqlExecutor) => {
        await lockResolutionInputJournal(tx);
        assertRunning();
        const owned = await tx.query<Record<string, unknown>>(
          `SELECT generation, lease_expires_at, graph_evaluated_at,
                  graph_valid_until
             FROM resolution_runtime_state
            WHERE runtime_id = 1 AND generation = $1::uuid AND ready = TRUE
              AND stopped_at IS NULL
            FOR UPDATE`,
          [currentGeneration],
        );
        if (owned.rows.length !== 1) {
          throw new ResolutionScopeError(
            "RESOLUTION_RUNTIME_NOT_READY",
            "sweep cannot run without the owned ready generation",
          );
        }
        assertRunning();
        const currentLease = runtimeDate(owned.rows[0]?.lease_expires_at);
        const currentGraphEvaluatedAt = runtimeDate(
          owned.rows[0]?.graph_evaluated_at,
        );
        const currentGraphValidUntil = runtimeDate(
          owned.rows[0]?.graph_valid_until,
        );
        const recomputeAt = clock();
        assertLeaseCurrent(currentLease, recomputeAt);
        assertGraphCurrent(
          currentGraphEvaluatedAt,
          currentGraphValidUntil,
          recomputeAt,
        );
        const result = await recomputeMarkets(
          scoreDeps(tx),
          "sweep",
          recomputeAt,
          null,
        );
        assertRecomputeComplete(result, "sweep");
        assertRunning();
        const graphEvaluatedAt = clock();
        const nextStreaks = new Map(streaks);
        const graphSafety = await evaluateGraphSafety(
          tx,
          graphEvaluatedAt,
          nextStreaks,
        );
        const graphExpiresAt = graphValidUntil(graphEvaluatedAt);
        assertRunning();
        const completedAt = clock();
        assertLeaseCurrent(currentLease, completedAt);
        assertGraphCurrent(
          currentGraphEvaluatedAt,
          currentGraphValidUntil,
          completedAt,
        );
        assertGraphCurrent(graphEvaluatedAt, graphExpiresAt, completedAt);
        const updated = await tx.query(
          `UPDATE resolution_runtime_state
              SET heartbeat_at = $2, lease_expires_at = $3,
                  last_success_at = $2, graph_evaluated_at = $4,
                  graph_valid_until = $5, updated_at = $2
            WHERE runtime_id = 1 AND generation = $1::uuid
              AND stopped_at IS NULL AND lease_expires_at > $2
              AND graph_valid_until > $2`,
          [
            currentGeneration,
            completedAt,
            leaseExpiresAt(completedAt),
            graphEvaluatedAt,
            graphExpiresAt,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new ResolutionScopeError(
            "RESOLUTION_GENERATION_LOST",
            "resolution runtime stopped or changed during sweep",
          );
        }
        return { result, graphSafety, nextStreaks };
      });
      publishStreaks(summary.nextStreaks);
      logJson("info", "SCORES_RECOMPUTED", {
        trigger: "sweep",
        ...summary.result,
      });
      logJson("info", "GRAPH_EVALUATED", {
        ...summary.graphSafety.violations,
        sanity_active: summary.graphSafety.vetoes.active,
        sanity_opened: summary.graphSafety.vetoes.opened,
        sanity_closed: summary.graphSafety.vetoes.closed,
      });
    } catch (error: unknown) {
      if (stopping) {
        throw error;
      }
      await markFailed("SWEEP_FAILED");
      if (
        error instanceof ResolutionLeaseExpiredError ||
        error instanceof ResolutionGraphExpiredError
      ) {
        await bootGenerationUnlocked();
        return;
      }
      throw error;
    }
  }

  async function sweep(scheduledAt: Date): Promise<void> {
    await withGraphPipelineMutex(() => sweepUnlocked(scheduledAt));
  }

  async function graphPipelineJobUnlocked(rebuild: boolean): Promise<void> {
    assertRunning();
    const currentGeneration = ownedGeneration();
    const failureReason = rebuild ? "GRAPH_BUILD_FAILED" : "GRAPH_EVAL_FAILED";
    try {
      const result = await deps.pool.transaction(async (tx: SqlExecutor) => {
        await lockResolutionInputJournal(tx);
        assertRunning();
        const owned = await tx.query<Record<string, unknown>>(
          `SELECT lease_expires_at, graph_evaluated_at, graph_valid_until
             FROM resolution_runtime_state
            WHERE runtime_id = 1 AND generation = $1::uuid AND ready = TRUE
              AND stopped_at IS NULL
            FOR UPDATE`,
          [currentGeneration],
        );
        if (owned.rows.length !== 1) {
          throw new ResolutionScopeError(
            "RESOLUTION_RUNTIME_NOT_READY",
            "graph pipeline cannot refresh an unowned or unready runtime",
          );
        }
        assertRunning();
        const currentLease = runtimeDate(owned.rows[0]?.lease_expires_at);
        const currentGraphEvaluatedAt = runtimeDate(
          owned.rows[0]?.graph_evaluated_at,
        );
        const currentGraphValidUntil = runtimeDate(
          owned.rows[0]?.graph_valid_until,
        );
        const startedAt = clock();
        assertLeaseCurrent(currentLease, startedAt);
        assertGraphCurrent(
          currentGraphEvaluatedAt,
          currentGraphValidUntil,
          startedAt,
        );
        const graph = rebuild
          ? await buildGraph(tx, deps.curatedEdges, clock())
          : null;
        assertRunning();
        const graphEvaluatedAt = clock();
        const nextStreaks = rebuild
          ? new Map<string, number>()
          : new Map(streaks);
        const graphSafety = await evaluateGraphSafety(
          tx,
          graphEvaluatedAt,
          nextStreaks,
        );
        const graphExpiresAt = graphValidUntil(graphEvaluatedAt);
        assertRunning();
        const completedAt = clock();
        assertLeaseCurrent(currentLease, completedAt);
        assertGraphCurrent(
          currentGraphEvaluatedAt,
          currentGraphValidUntil,
          completedAt,
        );
        assertGraphCurrent(graphEvaluatedAt, graphExpiresAt, completedAt);
        const updated = await tx.query(
          `UPDATE resolution_runtime_state
              SET heartbeat_at = $2, lease_expires_at = $3,
                  last_success_at = $2, graph_evaluated_at = $4,
                  graph_valid_until = $5, updated_at = $2
            WHERE runtime_id = 1 AND generation = $1::uuid AND ready = TRUE
              AND stopped_at IS NULL AND lease_expires_at > $2
              AND graph_valid_until > $2`,
          [
            currentGeneration,
            completedAt,
            leaseExpiresAt(completedAt),
            graphEvaluatedAt,
            graphExpiresAt,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new ResolutionScopeError(
            "RESOLUTION_GENERATION_LOST",
            "resolution runtime changed before graph freshness commit",
          );
        }
        return { graph, graphSafety, nextStreaks };
      });
      publishStreaks(result.nextStreaks);
      if (result.graph !== null) {
        logJson("info", "GRAPH_BUILT", { ...result.graph });
      }
      logJson("info", "GRAPH_EVALUATED", {
        ...result.graphSafety.violations,
        sanity_active: result.graphSafety.vetoes.active,
        sanity_opened: result.graphSafety.vetoes.opened,
        sanity_closed: result.graphSafety.vetoes.closed,
      });
    } catch (error: unknown) {
      if (stopping) {
        throw error;
      }
      await markFailed(failureReason);
      throw error;
    }
  }

  async function graphPipelineJob(rebuild: boolean): Promise<void> {
    await withGraphPipelineMutex(() => graphPipelineJobUnlocked(rebuild));
  }

  async function graphBuild(_scheduledAt: Date): Promise<void> {
    await graphPipelineJob(true);
  }

  async function graphEval(_scheduledAt: Date): Promise<void> {
    await graphPipelineJob(false);
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
    const { reportId } = await generateResolutionReport(
      scoreDeps(deps.pool),
      asOf,
    );
    logJson("info", "RESOLUTION_REPORT_GENERATED", { report_id: reportId });
  }

  async function heartbeat(_scheduledAt: Date): Promise<void> {
    assertRunning();
    const currentGeneration = ownedGeneration();
    try {
      const marketCount = await deps.pool.transaction(
        async (tx: SqlExecutor): Promise<number> => {
          await lockResolutionInputJournal(tx);
          assertRunning();
          const owned = await tx.query<Record<string, unknown>>(
            `SELECT lease_expires_at, graph_evaluated_at, graph_valid_until
               FROM resolution_runtime_state
              WHERE runtime_id = 1 AND generation = $1::uuid AND ready = TRUE
                AND stopped_at IS NULL
              FOR UPDATE`,
            [currentGeneration],
          );
          if (owned.rows.length !== 1) {
            throw new ResolutionScopeError(
              "RESOLUTION_RUNTIME_NOT_READY",
              "heartbeat cannot renew an unowned or unready runtime",
            );
          }
          assertRunning();
          const currentLease = runtimeDate(owned.rows[0]?.lease_expires_at);
          const graphEvaluatedAt = runtimeDate(
            owned.rows[0]?.graph_evaluated_at,
          );
          const graphExpiresAt = runtimeDate(owned.rows[0]?.graph_valid_until);
          const checkedAt = clock();
          assertLeaseCurrent(currentLease, checkedAt);
          assertGraphCurrent(graphEvaluatedAt, graphExpiresAt, checkedAt);
          const markets = await loadScoreableMarkets(tx, clock());
          assertRunning();
          const renewedAt = clock();
          assertLeaseCurrent(currentLease, renewedAt);
          assertGraphCurrent(graphEvaluatedAt, graphExpiresAt, renewedAt);
          const updated = await tx.query(
            `UPDATE resolution_runtime_state
                SET heartbeat_at = $2, lease_expires_at = $3, updated_at = $2
              WHERE runtime_id = 1 AND generation = $1::uuid AND ready = TRUE
                AND stopped_at IS NULL AND lease_expires_at > $2
                AND graph_valid_until > $2`,
            [currentGeneration, renewedAt, leaseExpiresAt(renewedAt)],
          );
          if (updated.rowCount !== 1) {
            throw new ResolutionScopeError(
              "RESOLUTION_RUNTIME_NOT_READY",
              "heartbeat cannot renew an unowned or unready runtime",
            );
          }
          return markets.length;
        },
      );
      logJson("info", "RESOLUTION_HEARTBEAT", {
        scoreable_markets: marketCount,
        score_version: deps.config.scoreVersion,
      });
    } catch (error: unknown) {
      if (stopping) {
        throw error;
      }
      await markFailed("HEARTBEAT_FAILED");
      if (
        error instanceof ResolutionLeaseExpiredError ||
        error instanceof ResolutionGraphExpiredError
      ) {
        await bootGeneration();
        return;
      }
      throw error;
    }
  }

  function supervised(
    name: string,
    run: (asOf: Date) => Promise<void>,
  ): () => void {
    return () => {
      if (stopping) {
        return;
      }
      if (running.get(name) === true) {
        logJson("warn", "JOB_STILL_RUNNING", { job: name });
        return;
      }
      running.set(name, true);
      run(clock())
        .catch((error: unknown) => {
          // The message, not only the class name. A recurring JOB_FAILED with
          // error_name "Error" says a job is broken and nothing about why —
          // diagnosing the onchain collector in production on 2026-08-26 meant
          // reproducing its RPC calls by hand. These messages are stable codes
          // and RPC/DB failure strings, never user data or secrets.
          logJson("error", "JOB_FAILED", {
            job: name,
            error_name: error instanceof Error ? error.name : "UnknownError",
            detail: error instanceof Error ? error.message : undefined,
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
      assertRunning();
      await bootGeneration();
      assertRunning();

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

      await report(clock()).catch((error: unknown) => {
        logJson("error", "JOB_FAILED", {
          job: "report_boot",
          error_name: error instanceof Error ? error.name : "UnknownError",
          detail: error instanceof Error ? error.message : undefined,
        });
      });
      assertRunning();

      for (const [name, job] of jobs) {
        const timer = setInterval(supervised(name, job.run), job.everyMs);
        timers.push(timer);
      }
    },

    async stop(): Promise<void> {
      stopping = true;
      for (const timer of timers) {
        clearInterval(timer);
      }
      timers.length = 0;
      if (generation !== null) {
        const stoppedAt = clock();
        try {
          await deps.pool.query(
            `UPDATE resolution_runtime_state
                SET ready = FALSE, stopped_at = $2, lease_expires_at = $2,
                    updated_at = $2
              WHERE runtime_id = 1 AND generation = $1::uuid`,
            [generation, stoppedAt],
          );
        } catch {
          // Shutdown must continue; the finite lease is the crash fallback.
        }
      }
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
