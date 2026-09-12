import type { RtdsFeed, RtdsPriceSample } from "./rtds.js";
import {
  RTDS_MAX_PENDING_GAPS,
  type createRtdsGapJournal,
} from "./rtdsgaps.js";
import type { DatabasePool } from "../database.js";
import { errorFields } from "../errors.js";

// OPS-01 found no measured production cadence. This conservative D1-aligned
// default is an arrival watchdog, not a claim about upstream/source freshness.
export const DEFAULT_RTDS_SILENCE_MS = 120_000;
export const DEFAULT_RTDS_MAX_RECONNECTS = 3;
export const RTDS_WATCHDOG_INTERVAL_MS = 1_000;
const FEEDS: readonly RtdsFeed[] = ["spot", "twap30", "twap60"];

function integer(
  value: number,
  min: number,
  max: number,
  name: string,
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function rtdsSilenceMs(value = DEFAULT_RTDS_SILENCE_MS): number {
  return integer(value, 30_000, 3_600_000, "GANSO_RTDS_SILENCE_MS");
}

export function rtdsMaxReconnects(value = DEFAULT_RTDS_MAX_RECONNECTS): number {
  return integer(value, 0, 10, "GANSO_RTDS_MAX_RECONNECTS");
}

interface Series {
  feed: RtdsFeed;
  symbol: string;
  subscribedAtMs: number | null;
  lastPriceFrameMs: number | null;
  lastSourceTsMs: number | null;
  lastSourceAdvanceMs: number | null;
  lastValueChangeMs: number | null;
  lastPersistedReceivedMs: number | null;
  price: string | null;
}

interface Episode {
  id: string;
  details: Record<string, unknown>;
}

export function createRtdsSilenceMonitor(deps: {
  pool: Pick<DatabasePool, "query">;
  journal: ReturnType<typeof createRtdsGapJournal>;
  clock: () => number;
  silenceMs: number;
  maxReconnects: number;
  socketOpen: () => boolean;
  resubscribe: () => void;
  reconnect: () => void;
  log: (
    level: "info" | "warn" | "error",
    code: string,
    details: Record<string, unknown>,
  ) => void;
}) {
  const series = new Map<string, Series>();
  const active = new Map<string, Episode>();
  const restored = new Map<string, Episode>();
  const firstPriceFrameMs = new Map<string, number>();
  const bootMs = deps.clock();
  let stopped = false;
  let restorePending = true;
  let restoreFailures = 0;
  let restoreOverflow = 0;
  let restoreDue = bootMs;
  let restoring: Promise<void> | null = null;
  let subscribedAtMs: number | null = null;
  let lastFrameMs: number | null = null;
  let lastPriceFrameMs: number | null = null;
  let resubscribes = 0;
  let reconnects = 0;
  let recoveryDue = 0;
  let recoveryStarted = false;

  function key(feed: RtdsFeed, symbol: string): string {
    return `${feed}|${symbol}`;
  }

  function find(sample: RtdsPriceSample): Series | undefined {
    return (
      series.get(key(sample.feed, sample.symbol)) ??
      (sample.feed === "spot"
        ? [...series.values()].find(
            (item) =>
              item.feed === "spot" &&
              item.symbol.replace("/usd", "usdt").replace("/", "") ===
                sample.symbol,
          )
        : undefined)
    );
  }

  function restoredScope(episode: Episode): string | null {
    const { scope, feed, symbol } = episode.details;
    if (scope === "global") return "global";
    if (
      scope !== "series" ||
      !FEEDS.includes(feed as RtdsFeed) ||
      typeof symbol !== "string"
    )
      return null;
    const normalized = symbol.toLowerCase();
    const item = find({
      feed: feed as RtdsFeed,
      symbol: normalized,
      price: "0",
      sourceTs: null,
      receivedAtMs: bootMs,
    });
    return key(feed as RtdsFeed, item?.symbol ?? normalized);
  }

  function restoredFor(scope: string): Episode[] {
    return [...restored.values()].filter(
      (episode) => restoredScope(episode) === scope,
    );
  }

  function recoveryEpisodes(): Episode[] {
    return [
      ...active.values(),
      ...[...restored.values()].filter((episode) => {
        const scope = restoredScope(episode);
        return scope === "global"
          ? series.size > 0
          : scope !== null && series.has(scope);
      }),
    ];
  }

  function closeRestored(scope: string, at: number): void {
    for (const episode of restoredFor(scope)) {
      episode.details.closure_reason = "valid_price";
      deps.journal.update(episode.id, new Date(at), episode.details);
      restored.delete(episode.id);
    }
  }

  function restore(): Promise<void> {
    if (stopped || !restorePending || deps.clock() < restoreDue)
      return Promise.resolve();
    if (restoring !== null) return restoring;
    restoring = (async () => {
      try {
        // The extra row is only an overflow sentinel; at most 256 episodes are
        // retained. Never scan the collector's entire historical gap table.
        const result = await deps.pool.query<{
          gap_start: Date | string;
          details_json: Record<string, unknown>;
        }>(
          `SELECT gap_start, details_json FROM polymarket_data_gaps
           WHERE source = 'rtds' AND cause = 'stream_silent' AND gap_end IS NULL
             AND gap_start <= $1 AND details_json ? 'episode_id'
           ORDER BY gap_start, gap_id LIMIT $2`,
          [new Date(bootMs), RTDS_MAX_PENDING_GAPS + 1],
        );
        if (stopped) return;
        const localIds = new Set(
          [...active.values()].map((episode) => episode.id),
        );
        let priorResubscribes = 0;
        let priorReconnects = 0;
        let priorDue = 0;
        for (const row of result.rows.slice(0, RTDS_MAX_PENDING_GAPS)) {
          const details = row.details_json;
          const id = details?.episode_id;
          const start = new Date(row.gap_start);
          if (
            typeof id !== "string" ||
            localIds.has(id) ||
            !Number.isFinite(start.getTime())
          )
            continue;
          const episode = { id, details: { ...details } };
          const scope = restoredScope(episode);
          if (scope === null) continue;
          deps.journal.record(start, null, "stream_silent", episode.details);
          restored.set(id, episode);
          const first = firstPriceFrameMs.get(scope);
          const subscribed =
            scope === "global" ? series.size > 0 : series.has(scope);
          if (first !== undefined && subscribed) {
            closeRestored(scope, first);
            continue;
          }
          if (!subscribed) continue;
          const attempts = Array.isArray(details.attempts)
            ? details.attempts
            : [];
          const actions = attempts.filter(
            (entry): entry is Record<string, unknown> =>
              typeof entry === "object" && entry !== null,
          );
          priorResubscribes = Math.max(
            priorResubscribes,
            actions.filter((entry) => entry.action === "resubscribe").length,
          );
          priorReconnects = Math.max(
            priorReconnects,
            actions.filter((entry) => entry.action === "reconnect").length,
          );
          for (const entry of actions) {
            const due =
              typeof entry.next_attempt_at === "string"
                ? Date.parse(entry.next_attempt_at)
                : NaN;
            if (Number.isFinite(due)) priorDue = Math.max(priorDue, due);
          }
        }
        if (priorResubscribes > 0 || priorReconnects > 0) {
          // The local attempts happened while the restore read was unavailable;
          // add them to the largest old per-episode count, never reset a budget.
          resubscribes += priorResubscribes;
          reconnects += priorReconnects;
          recoveryStarted = true;
          recoveryDue = Math.max(
            recoveryDue,
            deps.clock() + deps.silenceMs,
            priorDue,
          );
        }
        if (result.rows.length > RTDS_MAX_PENDING_GAPS) {
          restoreOverflow += result.rows.length - RTDS_MAX_PENDING_GAPS;
          deps.log("error", "RTDS_GAP_RESTORE_OVERFLOW", {
            retained_limit: RTDS_MAX_PENDING_GAPS,
            omitted_at_least: restoreOverflow,
          });
        }
        restorePending = false;
        void deps.journal.flush();
      } catch (error) {
        if (stopped) return;
        restoreFailures += 1;
        restoreDue =
          deps.clock() +
          Math.min(300_000, 1_000 * 2 ** Math.min(restoreFailures - 1, 20));
        deps.log("error", "RTDS_GAP_RESTORE_FAILED", {
          attempt: restoreFailures,
          next_attempt_at: new Date(restoreDue).toISOString(),
          ...errorFields(error),
        });
      }
    })().finally(() => {
      restoring = null;
    });
    return restoring;
  }

  function close(scope: string, at: number, reason: string): void {
    const episode = active.get(scope);
    if (episode === undefined) return;
    episode.details.closure_reason = reason;
    deps.journal.update(episode.id, new Date(at), episode.details);
    active.delete(scope);
  }

  function open(
    scope: string,
    start: number,
    now: number,
    item?: Series,
  ): void {
    if (active.has(scope) || restoredFor(scope).length > 0) return;
    const details: Record<string, unknown> = {
      scope: item === undefined ? "global" : "series",
      ...(item === undefined ? {} : { feed: item.feed, symbol: item.symbol }),
      threshold_ms: deps.silenceMs,
      recovery_max_reconnects: deps.maxReconnects,
      detected_at: new Date(now).toISOString(),
      last_price_frame_ms:
        item === undefined ? lastPriceFrameMs : item.lastPriceFrameMs,
      clock: "received_price_frame",
      attempts: [],
    };
    const id = deps.journal.record(
      new Date(start),
      null,
      "stream_silent",
      details,
    );
    active.set(scope, { id, details });
    deps.log("error", "RTDS_STREAM_SILENT", { episode_id: id, ...details });
  }

  function attempt(
    action: "resubscribe" | "reconnect",
    now: number,
    run: () => void,
  ): void {
    const entry: Record<string, unknown> = {
      action,
      at: new Date(now).toISOString(),
      ordinal: action === "resubscribe" ? resubscribes : reconnects,
      next_attempt_at:
        reconnects >= deps.maxReconnects
          ? null
          : new Date(recoveryDue).toISOString(),
    };
    try {
      run();
      entry.result = "requested";
    } catch (error) {
      entry.result = "failed";
      entry.error = error instanceof Error ? error.message : String(error);
    }
    // One socket action serves every silent series; never one reconnect per feed.
    for (const episode of recoveryEpisodes()) {
      const attempts = Array.isArray(episode.details.attempts)
        ? episode.details.attempts
        : [];
      attempts.push(entry);
      episode.details.attempts = attempts;
      deps.journal.update(episode.id, null, episode.details);
    }
    deps.log("warn", "RTDS_SILENCE_RECOVERY", entry);
  }

  return {
    restore,
    stop(): void {
      stopped = true;
    },
    setSymbols(symbols: readonly string[]): void {
      if (stopped) return;
      const wanted = new Set(
        symbols.flatMap((symbol) => FEEDS.map((feed) => key(feed, symbol))),
      );
      for (const existing of series.keys()) {
        if (!wanted.has(existing)) {
          close(existing, deps.clock(), "subscription_removed");
          series.delete(existing);
        }
      }
      for (const symbol of symbols) {
        for (const feed of FEEDS) {
          if (series.has(key(feed, symbol))) continue;
          series.set(key(feed, symbol), {
            feed,
            symbol,
            subscribedAtMs: subscribedAtMs === null ? null : deps.clock(),
            lastPriceFrameMs: null,
            lastSourceTsMs: null,
            lastSourceAdvanceMs: null,
            lastValueChangeMs: null,
            lastPersistedReceivedMs: null,
            price: null,
          });
        }
      }
      if (series.size === 0) {
        close("global", deps.clock(), "subscription_removed");
        subscribedAtMs = null;
        lastPriceFrameMs = null;
      }
    },
    subscribed(): void {
      if (stopped || series.size === 0) return;
      subscribedAtMs ??= deps.clock();
      for (const item of series.values()) item.subscribedAtMs ??= deps.clock();
    },
    frame(): void {
      if (stopped) return;
      lastFrameMs = deps.clock();
    },
    observe(sample: RtdsPriceSample): boolean {
      if (stopped) return false;
      const item = find(sample);
      if (item === undefined) return false;
      const now = sample.receivedAtMs;
      const scope = key(item.feed, item.symbol);
      if (!firstPriceFrameMs.has(scope)) firstPriceFrameMs.set(scope, now);
      if (!firstPriceFrameMs.has("global"))
        firstPriceFrameMs.set("global", now);
      item.lastPriceFrameMs = now;
      lastPriceFrameMs = now;
      const source = sample.sourceTs?.getTime() ?? null;
      if (
        source !== null &&
        (item.lastSourceTsMs === null || source > item.lastSourceTsMs)
      ) {
        item.lastSourceTsMs = source;
        item.lastSourceAdvanceMs = now;
      }
      if (item.price !== sample.price) item.lastValueChangeMs = now;
      item.price = sample.price;
      close(scope, now, "valid_price");
      close("global", now, "valid_price");
      closeRestored(scope, now);
      closeRestored("global", now);
      return true;
    },
    persisted(samples: readonly RtdsPriceSample[]): void {
      for (const sample of samples) {
        const item = find(sample);
        if (item !== undefined)
          item.lastPersistedReceivedMs = Math.max(
            item.lastPersistedReceivedMs ?? -Infinity,
            sample.receivedAtMs,
          );
      }
    },
    tick(): void {
      if (stopped || subscribedAtMs === null || series.size === 0) return;
      const now = deps.clock();
      const globalStart = lastPriceFrameMs ?? subscribedAtMs;
      if (now - globalStart >= deps.silenceMs) open("global", globalStart, now);
      for (const [scope, item] of series) {
        const start = item.lastPriceFrameMs ?? item.subscribedAtMs;
        if (start !== null && now - start >= deps.silenceMs)
          open(scope, start, now, item);
      }
      if (recoveryEpisodes().length === 0) {
        recoveryStarted = false;
        resubscribes = 0;
        reconnects = 0;
        return;
      }
      if (!recoveryStarted) {
        recoveryStarted = true;
        recoveryDue = now;
        if (deps.socketOpen()) {
          resubscribes = 1;
          recoveryDue = now + deps.silenceMs;
          attempt("resubscribe", now, deps.resubscribe);
        }
      }
      if (now >= recoveryDue && reconnects < deps.maxReconnects) {
        reconnects += 1;
        recoveryDue =
          now +
          Math.min(
            deps.silenceMs * 2 ** reconnects,
            Math.max(deps.silenceMs, 300_000),
          );
        attempt("reconnect", now, deps.reconnect);
      }
    },
    hasOpenGaps(): boolean {
      return recoveryEpisodes().length > 0;
    },
    stats() {
      return {
        thresholdMs: deps.silenceMs,
        lastFrameMs,
        lastPriceFrameMs,
        openGaps: active.size + restored.size,
        restorePending,
        restoreFailures,
        restoreOverflow,
        recovery: {
          resubscribes,
          reconnects,
          exhausted: recoveryStarted && reconnects >= deps.maxReconnects,
        },
        series: [...series.entries()].map(([scope, item]) => {
          const { price: _price, ...health } = item;
          return {
            ...health,
            silent: active.has(scope) || restoredFor(scope).length > 0,
          };
        }),
      };
    },
  };
}
