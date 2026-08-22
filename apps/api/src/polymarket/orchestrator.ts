// RFC-007 data-foundation orchestrator: wires every collector (Gamma registry,
// dual CLOB WebSocket book pipeline, trades, samplers, RTDS, macro calendar),
// the quality/reconciliation jobs, and retention into one supervised process.
// Public data only — no trading auth, wallet, signer, or order path.

import { readFile } from "node:fs/promises";

import type { DatabasePool } from "../database.js";
import { createBookPipeline, type BookPipeline } from "./bookpipe.js";
import { createDualMarketSocket, type DualMarketSocket } from "./dualws.js";
import { parseMarketFrame } from "./messages.js";
import { createReleaseCollector, syncCalendar } from "./macro.js";
import {
  createGapWriter,
  createFeedHealth,
  createReconciler,
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
        logJson("error", "JOB_FAILED", {
          job: name,
          error_name: error instanceof Error ? error.name : "UnknownError",
        });
      })
      .finally(() => {
        running = false;
      });
  };
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const pool = deps.pool;
  const socketFactory = deps.socketFactory ?? nodeMarketSocketFactory;
  const intervals = deps.intervals ?? {};
  const timers: ReturnType<typeof setInterval>[] = [];

  const gaps = createGapWriter(pool);
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
      gaps
        .recordInstantGap({
          source: "internal",
          cause: "delta_persist_failed",
          at: info.lastReceivedAt,
          details: {
            dropped: info.count,
            window_start: info.firstReceivedAt.toISOString(),
            window_end: info.lastReceivedAt.toISOString(),
          },
        })
        .catch(() => {
          logJson("error", "GAP_PERSIST_FAILED", {
            cause: "delta_persist_failed",
          });
        });
    },
    onOverflow: (count: number) => {
      gaps
        .recordInstantGap({
          source: "internal",
          cause: "delta_queue_overflow",
          at: new Date(),
          details: { dropped: count },
        })
        .catch(() => {
          logJson("error", "GAP_PERSIST_FAILED", {
            cause: "delta_queue_overflow",
          });
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

  async function loadMacroCalendar(): Promise<void> {
    const file =
      deps.macroCalendarFile ?? process.env.GANSO_MACRO_CALENDAR_FILE;
    if (file === undefined || file === "") {
      logJson("warn", "MACRO_CALENDAR_FILE_MISSING", {});
      return;
    }
    try {
      const raw: unknown = JSON.parse(await readFile(file, "utf8"));
      // syncCalendar parses/validates the raw JSON itself.
      const inserted = await syncCalendar(pool, raw, new Date());
      logJson("info", "MACRO_CALENDAR_SYNCED", { inserted });
    } catch (error: unknown) {
      logJson("error", "MACRO_CALENDAR_SYNC_FAILED", {
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

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
      await loadMacroCalendar();
      await gammaCycle().catch((error: unknown) => {
        logJson("error", "JOB_FAILED", {
          job: "gamma_boot",
          error_name: error instanceof Error ? error.name : "UnknownError",
        });
      });
      rtds.start();

      const schedule = (
        name: string,
        everyMs: number,
        job: () => Promise<void>,
      ): void => {
        const tick = safeJob(name, job);
        timers.push(setInterval(tick, everyMs));
      };

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
      schedule("retention", intervals.retentionMs ?? 86_400_000, async () => {
        await retention.runOnce();
      });
      schedule(
        "macro_releases",
        intervals.macroReleaseMs ?? 600_000,
        async () => {
          await macroReleases.pollOnce();
        },
      );
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
