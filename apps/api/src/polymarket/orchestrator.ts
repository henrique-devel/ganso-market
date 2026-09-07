// RFC-007 data-foundation orchestrator: wires every collector (Gamma registry,
// dual CLOB WebSocket book pipeline, trades, samplers, RTDS, macro calendar),
// the quality/reconciliation jobs, and retention into one supervised process.
// Public data only — no trading auth, wallet, signer, or order path.

import type { DatabasePool } from "../database.js";
import { createBookPipeline, type BookPipeline } from "./bookpipe.js";
import { createDualMarketSocket, type DualMarketSocket } from "./dualws.js";
import { parseMarketFrame } from "./messages.js";
import { createCalendarSync, createReleaseCollector } from "./macro.js";
import {
  createGapWriter,
  createFeedHealth,
  createReconciler,
  type InstantGapInput,
} from "./quality.js";
import {
  runGammaCycle,
  refreshParams,
  type UniverseMember,
} from "./registry.js";
import { createRetentionJob } from "./retention.js";
import { createRtdsRecorder } from "./rtds.js";
import { createOiHoldersSampler, createUmaStatusPoller } from "./samplers.js";
import { handleLastTrade, createTradesBackfill } from "./trades.js";
import {
  nodeMarketSocketFactory,
  type MarketSocketFactory,
} from "./recorder.js";
import { applyTickSizeChange } from "./versioning.js";

const SERVICE = "polymarket-recorder";

// Crypto underlyings referenced by the tracked universe. The RTDS symbol set
// is static for now; live validation may adjust the format (see runbook).
const RTDS_SYMBOLS = ["btc/usd", "eth/usd", "sol/usd", "xrp/usd"] as const;

export interface OrchestratorIntervals {
  readonly gammaMs?: number;
  readonly paramsMs?: number;
  readonly minuteMs?: number;
  readonly tradesMs?: number;
  readonly oiHoldersMs?: number;
  readonly umaMs?: number;
  readonly umaPendingMs?: number;
  readonly reconcileMs?: number;
  readonly retentionMs?: number;
  readonly macroReleaseMs?: number;
  readonly statusMs?: number;
  readonly gapRetryMs?: number;
}

export interface OrchestratorDeps {
  readonly pool: DatabasePool;
  readonly socketFactory?: MarketSocketFactory;
  readonly fetcher?: typeof fetch;
  readonly macroCalendarFile?: string;
  readonly intervals?: OrchestratorIntervals;
}

export interface Orchestrator {
  start(): Promise<void>;
  stop(): Promise<void>;
}

function logJson(
  level: "info" | "warn" | "error",
  reasonCode: string,
  extra: Record<string, unknown> = {},
): void {
  process.stderr.write(
    `${JSON.stringify({
      level,
      service: SERVICE,
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      ...extra,
    })}\n`,
  );
}

/** Wrap a periodic job so a failure is logged and never propagates. */
function safeJob(name: string, job: () => Promise<void>): () => void {
  let running = false;
  return () => {
    if (running) {
      return;
    }
    running = true;
    job()
      .catch((error: unknown) => {
        // The message, not only the class name: a recurring JOB_FAILED with
        // error_name "Error" says a job is broken and nothing about why.
        // These messages are stable codes and RPC/DB failure strings, never
        // user data or secrets.
        logJson("error", "JOB_FAILED", {
          job: name,
          error_name: error instanceof Error ? error.name : "UnknownError",
          detail: error instanceof Error ? error.message : undefined,
        });
      })
      .finally(() => {
        running = false;
      });
  };
}

/**
 * RFC-020 D4.1. The recorder used to call orchestrator.start() the instant the
 * process booted, which on a deploy meant subscribing sockets and scheduling
 * jobs against a database that was still coming back. That is what turned the
 * boot into 100 RETENTION_STEP_FAILED (`EAI_AGAIN postgres`) on 2026-09-02.
 *
 * Waiting is the whole fix: no socket is subscribed before the database
 * answers, so nothing is collected and lost. If it never answers, the recorder
 * exits with its own reason code and Docker restarts it
 * (`restart: unless-stopped`) — a restart loop with Docker's backoff, which is
 * the honest outcome when there is no database.
 */
export class DatabaseUnavailableError extends Error {
  public readonly reasonCode = "RECORDER_DATABASE_UNAVAILABLE";
  public readonly attempts: number;
  public readonly waitedMs: number;

  public constructor(attempts: number, waitedMs: number) {
    super(
      `database did not answer SELECT 1 after ${attempts} attempts in ${waitedMs} ms`,
    );
    this.name = "DatabaseUnavailableError";
    this.attempts = attempts;
    this.waitedMs = waitedMs;
  }
}

export interface WaitForDatabaseOptions {
  /** Hard ceiling on the whole wait. RFC-020 D4 fixes it at 60s. */
  readonly totalTimeoutMs?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: () => number;
  readonly log?: (
    level: "info" | "warn" | "error",
    reasonCode: string,
    extra?: Record<string, unknown>,
  ) => void;
}

export async function waitForDatabase(
  pool: Pick<DatabasePool, "query">,
  options: WaitForDatabaseOptions = {},
): Promise<void> {
  const totalTimeoutMs = options.totalTimeoutMs ?? 60_000;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const clock = options.clock ?? Date.now;
  const log = options.log ?? logJson;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));

  const startedAt = clock();
  let delayMs = options.initialDelayMs ?? 250;
  let attempts = 0;

  for (;;) {
    attempts += 1;
    try {
      await pool.query("SELECT 1");
      if (attempts > 1) {
        log("info", "RECORDER_DATABASE_READY", {
          attempts,
          waited_ms: clock() - startedAt,
        });
      }
      return;
    } catch (error: unknown) {
      const elapsedMs = clock() - startedAt;
      if (elapsedMs + delayMs >= totalTimeoutMs) {
        throw new DatabaseUnavailableError(attempts, elapsedMs);
      }
      log("warn", "RECORDER_DATABASE_WAITING", {
        attempt: attempts,
        delay_ms: delayMs,
        elapsed_ms: elapsedMs,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }
}

/**
 * RFC-020 D4.3. A gap is written to the same database that just failed, so the
 * write that records the loss fails for the same reason the loss happened. On
 * 2026-09-02 that produced 63 GAP_PERSIST_FAILED against ONE surviving
 * `internal/delta_persist_failed` row — and the log line carried no `dropped`,
 * so the number was gone for good.
 *
 * The queue holds the gap in memory and retries it until the pool comes back.
 * Windows for the same (source, cause, token) coalesce, so a 12-second outage
 * that loses 32 batches becomes one row with the summed `dropped` and the union
 * of the windows rather than 32 rows or one row that lies about its size. When
 * the retries are exhausted the number still reaches the log: `dropped`,
 * `window_start` and `window_end` go into GAP_PERSIST_FAILED.
 */
export interface GapRetryQueueDeps {
  readonly record: (input: InstantGapInput) => Promise<unknown>;
  readonly log?: (
    level: "info" | "warn" | "error",
    reasonCode: string,
    extra?: Record<string, unknown>,
  ) => void;
  /** ~1s ticks for 120 attempts covers a two-minute outage. */
  readonly maxAttempts?: number;
  readonly maxEntries?: number;
}

export interface GapRetryEntry {
  readonly source: InstantGapInput["source"];
  readonly cause: string;
  readonly tokenId?: string;
  readonly dropped: number;
  readonly windowStart: Date;
  readonly windowEnd: Date;
}

export interface GapRetryQueue {
  enqueue(entry: GapRetryEntry): void;
  flushOnce(): Promise<void>;
  size(): number;
}

interface PendingGap {
  source: InstantGapInput["source"];
  cause: string;
  tokenId: string | undefined;
  dropped: number;
  windowStart: Date;
  windowEnd: Date;
  attempts: number;
}

export function createGapRetryQueue(deps: GapRetryQueueDeps): GapRetryQueue {
  const log = deps.log ?? logJson;
  const maxAttempts = deps.maxAttempts ?? 120;
  const maxEntries = deps.maxEntries ?? 500;
  const pending = new Map<string, PendingGap>();

  function abandon(entry: PendingGap, reason: string): void {
    log("error", "GAP_PERSIST_FAILED", {
      cause: entry.cause,
      source: entry.source,
      ...(entry.tokenId === undefined ? {} : { token_id: entry.tokenId }),
      dropped: entry.dropped,
      window_start: entry.windowStart.toISOString(),
      window_end: entry.windowEnd.toISOString(),
      attempts: entry.attempts,
      reason,
    });
  }

  return {
    enqueue(entry: GapRetryEntry): void {
      const key = `${entry.source}|${entry.cause}|${entry.tokenId ?? ""}`;
      const existing = pending.get(key);
      if (existing === undefined) {
        if (pending.size >= maxEntries) {
          // Shed the oldest so a long outage cannot grow the queue without
          // bound; the number it carries still reaches the log.
          const [oldestKey, oldest] = pending.entries().next().value as [
            string,
            PendingGap,
          ];
          pending.delete(oldestKey);
          abandon(oldest, "queue_full");
        }
        pending.set(key, {
          source: entry.source,
          cause: entry.cause,
          tokenId: entry.tokenId,
          dropped: entry.dropped,
          windowStart: entry.windowStart,
          windowEnd: entry.windowEnd,
          attempts: 0,
        });
        return;
      }
      existing.dropped += entry.dropped;
      if (entry.windowStart < existing.windowStart) {
        existing.windowStart = entry.windowStart;
      }
      if (entry.windowEnd > existing.windowEnd) {
        existing.windowEnd = entry.windowEnd;
      }
    },

    async flushOnce(): Promise<void> {
      while (pending.size > 0) {
        const next = pending.entries().next().value as
          [string, PendingGap] | undefined;
        if (next === undefined) {
          return;
        }
        const [key, entry] = next;
        try {
          await deps.record({
            source: entry.source,
            cause: entry.cause,
            ...(entry.tokenId === undefined ? {} : { tokenId: entry.tokenId }),
            at: entry.windowEnd,
            details: {
              dropped: entry.dropped,
              window_start: entry.windowStart.toISOString(),
              window_end: entry.windowEnd.toISOString(),
            },
          });
          pending.delete(key);
        } catch {
          // One probe answers for the whole queue: they all target the same
          // pool and fail for the same reason. Charging every entry an attempt
          // here is what keeps the 120-attempt ceiling honest without firing
          // hundreds of doomed queries per tick.
          const exhausted: string[] = [];
          for (const [pendingKey, pendingEntry] of pending) {
            pendingEntry.attempts += 1;
            if (pendingEntry.attempts >= maxAttempts) {
              exhausted.push(pendingKey);
            }
          }
          for (const exhaustedKey of exhausted) {
            const dead = pending.get(exhaustedKey);
            pending.delete(exhaustedKey);
            if (dead !== undefined) {
              abandon(dead, "retries_exhausted");
            }
          }
          return;
        }
      }
    },

    size(): number {
      return pending.size;
    },
  };
}

export interface ScheduleOptions {
  /**
   * Fire the job once immediately, in addition to the interval.
   *
   * This exists because setInterval alone made the daily retention job
   * unreachable in practice: the recorder process restarts on every
   * deploy/rebuild, which is more often than once a day, so a 24h timer never
   * elapsed. Measured in production on 2026-08-25: a single row in
   * polymarket_retention_log for the whole life of the service, while
   * polymarket_book_deltas sat at 6.3x its quota. Only safe for idempotent
   * jobs that are cheap when there is nothing to do.
   */
  readonly runAtBoot?: boolean;
}

/**
 * Job scheduler used by the orchestrator. The boot tick is fired without
 * awaiting so a long first run never delays ORCHESTRATOR_STARTED, and safeJob
 * guarantees the interval cannot start a second copy while it is still
 * running.
 */
export function createJobScheduler(
  timers: NodeJS.Timeout[],
): (
  name: string,
  everyMs: number,
  job: () => Promise<void>,
  options?: ScheduleOptions,
) => void {
  return (name, everyMs, job, options) => {
    const tick = safeJob(name, job);
    timers.push(setInterval(tick, everyMs));
    if (options?.runAtBoot === true) {
      tick();
    }
  };
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const pool = deps.pool;
  const socketFactory = deps.socketFactory ?? nodeMarketSocketFactory;
  const intervals = deps.intervals ?? {};
  const timers: ReturnType<typeof setInterval>[] = [];

  const gaps = createGapWriter(pool);
  // RFC-020 D4.3: gaps are written to the database that just failed, so the
  // record of the loss needs to outlive the outage that caused it.
  const gapRetries = createGapRetryQueue({
    record: (input) => gaps.recordInstantGap(input),
    log: logJson,
  });
  const feedHealth = createFeedHealth(Date.now);

  let universe: readonly UniverseMember[] = [];
  let tokenIds: string[] = [];
  let dual: DualMarketSocket | null = null;
  // Both-down gap tracking via promise: a second outage before the first gap
  // id resolves must close the prior gap instead of leaking it open.
  let wsGapPromise: Promise<number | null> | null = null;
  let stopped = false;
  const lastRestResyncMs = new Map<string, number>();

  async function resyncFromRest(tokenId: string): Promise<void> {
    const now = Date.now();
    const last = lastRestResyncMs.get(tokenId);
    if (last !== undefined && now - last < 30_000) {
      return;
    }
    lastRestResyncMs.set(tokenId, now);
    const fetcher = deps.fetcher ?? fetch;
    const response = await fetcher(
      `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`,
      {
        headers: {
          accept: "application/json",
          "user-agent": "GansoMarketRecorder/1.0 (+public-data-recorder)",
        },
      },
    );
    if (!response.ok) {
      logJson("warn", "BOOK_REST_RESYNC_FAILED", {
        token_id: tokenId,
        status: response.status,
      });
      return;
    }
    const body = (await response.json()) as {
      bids?: unknown;
      asks?: unknown;
    } | null;
    const levels = (raw: unknown): { price: string; size: string }[] =>
      Array.isArray(raw)
        ? raw.flatMap((item) => {
            const record = item as { price?: unknown; size?: unknown } | null;
            return record !== null &&
              typeof record.price === "string" &&
              typeof record.size === "string"
              ? [{ price: record.price, size: record.size }]
              : [];
          })
        : [];
    await pipeline.seedBook(
      tokenId,
      levels(body?.bids),
      levels(body?.asks),
      null,
    );
    logJson("info", "BOOK_REST_RESYNC_DONE", { token_id: tokenId });
  }

  const pipeline: BookPipeline = createBookPipeline({
    pool,
    onResyncNeeded: (tokenId: string) => {
      logJson("warn", "BOOK_RESYNC_NEEDED", { token_id: tokenId });
      resyncFromRest(tokenId).catch((error: unknown) => {
        logJson("error", "BOOK_REST_RESYNC_FAILED", {
          token_id: tokenId,
          error_name: error instanceof Error ? error.name : "UnknownError",
        });
      });
    },
    onPersistFailure: (info) => {
      gapRetries.enqueue({
        source: "internal",
        cause: "delta_persist_failed",
        dropped: info.count,
        windowStart: info.firstReceivedAt,
        windowEnd: info.lastReceivedAt,
      });
    },
    onOverflow: (count: number) => {
      // Same treatment as a failed persist: the overflow gap was written with
      // the same `.catch` that logged GAP_PERSIST_FAILED without `dropped`.
      const now = new Date();
      gapRetries.enqueue({
        source: "internal",
        cause: "delta_queue_overflow",
        dropped: count,
        windowStart: now,
        windowEnd: now,
      });
    },
  });

  const tradesBackfill = createTradesBackfill({ pool, clock: Date.now });
  const oiSampler = createOiHoldersSampler({ pool, clock: Date.now });
  const umaPoller = createUmaStatusPoller({ pool, clock: Date.now });
  const reconciler = createReconciler({
    pool,
    getCachedBook: (tokenId) => {
      const book = pipeline.getCachedBook(tokenId);
      return book === null
        ? null
        : { bids: book.topBids(10), asks: book.topAsks(10) };
    },
    requestResync: (tokenId) => {
      pipeline.requestResync(tokenId);
      resyncFromRest(tokenId).catch(() => {
        logJson("warn", "BOOK_REST_RESYNC_FAILED", { token_id: tokenId });
      });
    },
    clock: Date.now,
  });
  const retention = createRetentionJob({ pool, clock: () => new Date() });
  const rtds = createRtdsRecorder({
    pool,
    socketFactory,
    symbols: [...RTDS_SYMBOLS],
    clock: Date.now,
  });
  const macroReleases = createReleaseCollector({
    pool,
    clock: () => new Date(),
  });

  function conditionIds(): string[] {
    return universe.map((member) => member.conditionId);
  }

  function handleWsFrame(raw: string): void {
    feedHealth.heartbeat("clob_ws");
    if (wsGapPromise !== null) {
      const pending = wsGapPromise;
      wsGapPromise = null;
      void pending
        .then((gapId) =>
          gapId === null ? undefined : gaps.closeGap(gapId, new Date()),
        )
        .catch(() => {
          logJson("error", "GAP_PERSIST_FAILED", { cause: "close_ws_gap" });
        });
    }
    for (const message of parseMarketFrame(raw)) {
      if (
        message.event_type === "book" ||
        message.event_type === "price_change"
      ) {
        void pipeline.handleMessage(message);
      } else if (message.event_type === "last_trade_price") {
        void handleLastTrade(pool, message, Date.now);
      } else if (message.event_type === "tick_size_change") {
        void pipeline.handleMessage(message);
        applyTickSizeChange(
          pool,
          {
            market: message.market,
            asset_id: message.asset_id,
            new_tick_size: message.new_tick_size,
            timestamp: message.timestamp,
          },
          new Date(),
        ).catch((error: unknown) => {
          logJson("error", "TICK_SIZE_VERSION_FAILED", {
            error_name: error instanceof Error ? error.name : "UnknownError",
          });
        });
      }
    }
  }

  async function gammaCycle(): Promise<void> {
    const result = await runGammaCycle({
      pool,
      ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
    });
    if (result.fetchFailed) {
      // Transient Gamma failure: keep the previous universe and
      // subscriptions untouched (a mass-exit here would stop collection).
      logJson("warn", "GAMMA_FETCH_FAILED_UNIVERSE_KEPT", {
        markets: universe.length,
      });
      return;
    }
    feedHealth.heartbeat("gamma");
    if (result.universe.length === 0 && tokenIds.length > 0) {
      logJson("warn", "GAMMA_EMPTY_UNIVERSE_KEPT", {});
      return;
    }
    universe = result.universe;
    const nextTokenIds = universe.flatMap((member) => [...member.tokenIds]);
    const changed =
      nextTokenIds.length !== tokenIds.length ||
      nextTokenIds.some((id, index) => id !== tokenIds[index]);
    tokenIds = nextTokenIds;
    if (result.entered.length > 0 || result.exited.length > 0) {
      logJson("info", "UNIVERSE_CHANGED", {
        entered: result.entered.length,
        exited: result.exited.length,
        markets: universe.length,
        tokens: tokenIds.length,
      });
    }
    if (dual === null) {
      dual = createDualMarketSocket({
        socketFactory,
        tokenIds,
        onMessage: handleWsFrame,
        onBothDown: (info) => {
          const prior = wsGapPromise;
          wsGapPromise = (async (): Promise<number | null> => {
            if (prior !== null) {
              const priorId = await prior.catch(() => null);
              if (priorId !== null) {
                await gaps
                  .closeGap(priorId, new Date(info.downSince))
                  .catch(() => undefined);
              }
            }
            try {
              return await gaps.openGap({
                source: "clob_ws",
                cause: "both_connections_down",
                start: new Date(info.downSince),
              });
            } catch {
              logJson("error", "GAP_PERSIST_FAILED", {
                cause: "both_connections_down",
              });
              return null;
            }
          })();
        },
      });
    } else if (changed) {
      dual.resubscribe(tokenIds);
    }
  }

  const macroCalendar = createCalendarSync({
    pool,
    file: () => deps.macroCalendarFile ?? process.env.GANSO_MACRO_CALENDAR_FILE,
    log: logJson,
  });

  function statusReport(): void {
    const pipe = pipeline.stats();
    logJson("info", "STATUS", {
      universe_markets: universe.length,
      universe_tokens: tokenIds.length,
      ws: dual?.stats() ?? null,
      pipeline: pipe,
      rtds_unknown_frames: rtds.unknownFrames(),
      feeds: feedHealth.snapshot(),
    });
  }

  return {
    async start(): Promise<void> {
      logJson("info", "ORCHESTRATOR_STARTING", {});
      await macroCalendar.runOnce("boot");
      await gammaCycle().catch((error: unknown) => {
        logJson("error", "JOB_FAILED", {
          job: "gamma_boot",
          error_name: error instanceof Error ? error.name : "UnknownError",
        });
      });
      rtds.start();

      const schedule = createJobScheduler(timers);

      schedule("gamma", intervals.gammaMs ?? 600_000, gammaCycle);
      schedule("params", intervals.paramsMs ?? 3_600_000, async () => {
        await refreshParams(
          { pool, ...(deps.fetcher ? { fetcher: deps.fetcher } : {}) },
          universe,
        );
      });
      schedule("minute", intervals.minuteMs ?? 60_000, async () => {
        await pipeline.flushMinute();
        await pipeline.runAnchorPass();
      });
      schedule("trades", intervals.tradesMs ?? 300_000, async () => {
        await tradesBackfill.pollOnce(conditionIds());
        feedHealth.heartbeat("data_api");
      });
      schedule("oi_holders", intervals.oiHoldersMs ?? 900_000, async () => {
        await oiSampler.sampleOnce(
          universe.map((member) => ({
            conditionId: member.conditionId,
            tokenIds: member.tokenIds,
          })),
        );
      });
      schedule("uma", intervals.umaMs ?? 120_000, async () => {
        await umaPoller.pollOnce(conditionIds());
      });
      // Markets leave the universe within minutes of their UMA proposal, well
      // before liveness completes, so the universe poll above can never see
      // them resolve. This slower sweep follows them until they reach a
      // terminal state — it is what makes any label, and therefore any gate
      // evidence, possible at all.
      schedule("uma_pending", intervals.umaPendingMs ?? 600_000, async () => {
        await umaPoller.pollPendingOnce();
      });
      schedule("reconcile", intervals.reconcileMs ?? 3_600_000, async () => {
        await reconciler.reconcileOnce(tokenIds);
      });
      schedule(
        "retention",
        intervals.retentionMs ?? 86_400_000,
        async () => {
          await retention.runOnce();
        },
        { runAtBoot: true },
      );
      schedule(
        "macro_releases",
        intervals.macroReleaseMs ?? 600_000,
        async () => {
          // Sync first: a boot that lost the race with postgres leaves the
          // table behind the file, and an entry that is not in the table
          // cannot be polled for its release.
          await macroCalendar.runOnce("scheduled");
          await macroReleases.pollOnce();
        },
      );
      schedule("gap_retry", intervals.gapRetryMs ?? 1_000, async () => {
        await gapRetries.flushOnce();
      });
      schedule("status", intervals.statusMs ?? 300_000, async () => {
        statusReport();
      });
      logJson("info", "ORCHESTRATOR_STARTED", {});
    },

    async stop(): Promise<void> {
      if (stopped) {
        return;
      }
      stopped = true;
      for (const timer of timers) {
        clearInterval(timer);
      }
      dual?.close();
      await rtds.stop().catch(() => undefined);
      await pipeline.flushDeltas().catch(() => undefined);
      await pipeline.flushMinute().catch(() => undefined);
      logJson("info", "ORCHESTRATOR_STOPPED", {});
    },
  };
}
