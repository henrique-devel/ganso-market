import { createHash, randomUUID } from "node:crypto";

import type { GapWriter } from "./quality.js";
import type { MarketMessage, PriceLevel } from "./types.js";

export const DEFAULT_STREAM_SILENCE_MS = 120_000;
export const SILENCE_WINDOW_MS = 15 * 60_000;
export const REST_RESYNC_THROTTLE_MS = 30_000;
export const SILENCE_MAX_RECONNECTS = 3;
export const SILENCE_MAX_PENDING_GAPS = 64;
export const SILENCE_MAX_PERSIST_ATTEMPTS = 8;
export const SILENCE_SHUTDOWN_GRACE_MS = 5_000;
const ACTIVITY_DETECTION_GRACE_MS = 60_000;
const MAX_ACTIVITY_BUCKETS = 2_048;

export function streamSilenceMs(value?: string | number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(30_000, parsed)
    : DEFAULT_STREAM_SILENCE_MS;
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value);
}

function validLevel(level: PriceLevel): boolean {
  return (
    decimal(level.price) &&
    decimal(level.size) &&
    /^(?:0+(?:\.\d+)?|0*1(?:\.0+)?)$/.test(level.price)
  );
}

function canonical(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");
  const head = whole.replace(/^0+(?=\d)/, "");
  const tail = fraction.replace(/0+$/, "");
  return tail ? `${head}.${tail}` : head;
}

/** Compare actual full-depth books, ignoring envelope hash/time and level order. */
export function readClobRestBook(
  body: unknown,
  tokenId: string,
): { bids: PriceLevel[]; asks: PriceLevel[]; fingerprint: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (record.asset_id !== tokenId) return null;
  const levels = (raw: unknown): PriceLevel[] | null => {
    if (!Array.isArray(raw)) return null;
    const result: PriceLevel[] = [];
    const prices = new Set<string>();
    for (const item of raw) {
      if (typeof item !== "object" || item === null) return null;
      const level = item as PriceLevel;
      if (!validLevel(level)) return null;
      const price = canonical(level.price);
      if (prices.has(price)) return null;
      prices.add(price);
      const size = canonical(level.size);
      if (size !== "0") result.push({ price, size });
    }
    return result.sort((a, b) => a.price.localeCompare(b.price));
  };
  const bids = levels(record.bids);
  const asks = levels(record.asks);
  if (bids === null || asks === null) return null;
  return {
    bids,
    asks,
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ bids, asks }))
      .digest("hex"),
  };
}

export type ClobControlResult =
  | { status: "ok"; fingerprint: string }
  | { status: "throttled"; retryAtMs: number }
  | { status: "unavailable"; reason: string };

interface TokenActivity {
  firstSeen: number | null;
  lastSeen: number | null;
  buckets: Map<number, number>;
  silentSelection: { token: string; deltas: number }[] | null;
}

interface Episode {
  id: string;
  tokenId?: string;
  start: number;
  detectedAt: number;
  end: number | null;
  reference: string | null;
  details: Record<string, unknown>;
  attempts: { action: string; at: number }[];
  reconnects: number;
  nextRecovery: number;
  controlDue: number;
  controlDeadline: number;
  controlDone: boolean;
  samples: { fingerprint: string; requestedAt: number; receivedAt: number }[];
  version: number;
  savedVersion: number;
  persistAttempts: number;
  persistDue: number;
}

export interface ClobSilenceMonitor {
  restore(): Promise<void>;
  setUniverse(tokenIds: readonly string[]): void;
  /** Arrival, not DB commit or value novelty. Only first copies count activity. */
  observe(message: MarketMessage, firstCopy: boolean): boolean;
  tick(): void;
  stop(): Promise<void>;
  stats(): {
    lastBookFrameMs: number | null;
    openGaps: number;
    pendingWrites: number;
    restorePending: boolean;
    restoreFailures: number;
    restoreOverflow: number;
  };
}

/** A timer owned by the orchestrator drives this bounded, non-blocking journal. */
export function createClobSilenceMonitor(deps: {
  gaps: Pick<GapWriter, "saveSilenceGap" | "loadOpenSilenceGaps">;
  openConnections: () => number;
  resubscribe: () => void;
  reconnect: () => void;
  control: (tokenId: string) => Promise<ClobControlResult>;
  silenceMs?: number;
  clock?: () => number;
  log: (
    level: "info" | "warn" | "error",
    code: string,
    details: Record<string, unknown>,
  ) => void;
}): ClobSilenceMonitor {
  const clock = deps.clock ?? Date.now;
  const threshold = streamSilenceMs(deps.silenceMs);
  // Preserve a full pre-onset window plus scheduling grace even for larger N,
  // while keeping a hard cap on the number of counters per subscribed token.
  const activityBucketMs = Math.max(
    1_000,
    Math.ceil(
      (SILENCE_WINDOW_MS + threshold + ACTIVITY_DETECTION_GRACE_MS) /
        (MAX_ACTIVITY_BUCKETS - 1) /
        1_000,
    ) * 1_000,
  );
  const tokens = new Map<string, TokenActivity>();
  const episodes = new Map<string, Episode>();
  const active = new Map<string, Episode>();
  const restored = new Map<string, Episode>();
  const bootMs = clock();
  let universeObservedAt: number | null = null;
  let firstFrame: number | null = null;
  let restorePending = true;
  let restoreFailures = 0;
  let restoreOverflow = 0;
  let restoreDue = bootMs;
  let restoring: Promise<void> | null = null;
  let startedAt: number | null = null;
  let lastFrame: number | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let draining = false;
  let stopPromise: Promise<void> | null = null;
  let controlling = false;
  let nextCapacityLog = 0;
  let nextRecovery = 0;

  function rank(at: number): { token: string; deltas: number }[] {
    return [...tokens.entries()]
      .map(([token, activity]) => ({
        token,
        deltas: [...activity.buckets.entries()].reduce(
          (sum, [bucket, count]) =>
            bucket > at - SILENCE_WINDOW_MS && bucket <= at ? sum + count : sum,
          0,
        ),
      }))
      .filter((entry) => entry.deltas > 0)
      .sort((a, b) => b.deltas - a.deltas || a.token.localeCompare(b.token))
      .slice(0, 5);
  }

  function finish(episode: Episode, at: number, reason: string): void {
    if (episode.end !== null) return;
    episode.end = at;
    episode.details.closed_by = reason;
    // Once WS recovers/its subscription exits, two later REST books cannot
    // classify the former outage. Preserve completed controls; cancel pending.
    if (!episode.controlDone) {
      episode.controlDone = true;
      episode.details.control = "unavailable";
      episode.details.control_reason = reason;
    }
    episode.version += 1;
    episode.persistDue = at;
    episode.persistAttempts = 0;
    if (active.get(episode.tokenId ?? "") === episode)
      active.delete(episode.tokenId ?? "");
    restored.delete(episode.id);
  }

  function finishRestored(scope: string, at: number, reason: string): void {
    for (const episode of restored.values())
      if ((episode.tokenId ?? "") === scope) finish(episode, at, reason);
  }

  function restore(): Promise<void> {
    if (stopped || !restorePending || clock() < restoreDue)
      return Promise.resolve();
    if (restoring !== null) return restoring;
    restoring = (async () => {
      try {
        const rows = await deps.gaps.loadOpenSilenceGaps(
          new Date(bootMs),
          SILENCE_MAX_PENDING_GAPS + 1,
        );
        if (stopped) return;
        let omitted = 0;
        for (const row of rows) {
          if (episodes.has(row.episodeId)) continue;
          if (episodes.size >= SILENCE_MAX_PENDING_GAPS) {
            omitted += 1;
            continue;
          }
          const attempts = (
            Array.isArray(row.details.attempts) ? row.details.attempts : []
          )
            .filter(
              (item): item is { action: string; at: number } =>
                typeof item === "object" &&
                item !== null &&
                typeof item.action === "string" &&
                typeof item.at === "number" &&
                Number.isFinite(item.at),
            )
            .map((item) => ({ action: item.action, at: item.at }));
          const priorBudget = row.details.recovery_reconnects;
          const reconnects = Math.max(
            attempts.filter((item) => item.action === "reconnect").length,
            typeof priorBudget === "number" &&
              Number.isInteger(priorBudget) &&
              priorBudget >= 0
              ? priorBudget
              : 0,
          );
          const lastAttempt = attempts.at(-1)?.at ?? bootMs;
          const episode: Episode = {
            id: row.episodeId,
            ...(row.tokenId === undefined ? {} : { tokenId: row.tokenId }),
            start: row.start.getTime(),
            detectedAt: bootMs,
            end: null,
            reference: row.tokenId ?? null,
            details: {
              ...row.details,
              restored_at: new Date(bootMs).toISOString(),
            },
            attempts,
            reconnects,
            nextRecovery: Math.max(
              bootMs + threshold,
              lastAttempt + threshold * 2 ** reconnects,
            ),
            controlDue: 0,
            controlDeadline: 0,
            controlDone: true,
            samples: Array.isArray(row.details.control_samples)
              ? row.details.control_samples
              : [],
            version: 1,
            savedVersion: 0,
            persistAttempts: 0,
            persistDue: clock(),
          };
          if (episode.details.control === "pending") {
            episode.details.control = "unavailable";
            episode.details.control_reason = "recorder_restart";
          }
          episodes.set(episode.id, episode);
          restored.set(episode.id, episode);
          const local = active.get(row.tokenId ?? "");
          if (local !== undefined) {
            // The DB may have been unavailable long enough to detect this same
            // outage locally. Its new UUID cannot reset the prior socket budget.
            local.reconnects = Math.max(local.reconnects, reconnects);
            local.nextRecovery = Math.max(
              local.nextRecovery,
              episode.nextRecovery,
            );
            local.details.restored_recovery_episode = episode.id;
            local.details.recovery_reconnects = local.reconnects;
            local.details.recovery_exhausted =
              local.reconnects >= SILENCE_MAX_RECONNECTS;
            local.version += 1;
          }
          // A read may complete after the first valid frame. Preserve that
          // observation, never substitute DB-read time or a REST response.
          const received =
            row.tokenId === undefined
              ? firstFrame
              : tokens.get(row.tokenId)?.firstSeen;
          if (received !== null && received !== undefined)
            finish(episode, received, "ws_book_frame");
          else if (
            universeObservedAt !== null &&
            (row.tokenId === undefined
              ? tokens.size === 0
              : !tokens.has(row.tokenId))
          )
            finish(
              episode,
              universeObservedAt,
              row.tokenId === undefined ? "universe_empty" : "universe_exit",
            );
        }
        restoreOverflow += omitted;
        if (omitted)
          deps.log("error", "WS_SILENCE_RESTORE_OVERFLOW", {
            omitted_at_least: omitted,
          });
        restorePending = false;
      } catch (error) {
        if (stopped) return;
        restoreFailures += 1;
        restoreDue =
          clock() +
          Math.min(300_000, 1_000 * 2 ** Math.min(restoreFailures - 1, 20));
        deps.log("error", "WS_SILENCE_RESTORE_FAILED", {
          attempt: restoreFailures,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })().finally(() => {
      restoring = null;
    });
    return restoring;
  }

  function open(tokenId: string | undefined, onset: number): void {
    const key = tokenId ?? "";
    if (
      active.has(key) ||
      [...restored.values()].some((episode) => (episode.tokenId ?? "") === key)
    )
      return;
    const now = clock();
    if (episodes.size >= SILENCE_MAX_PENDING_GAPS) {
      if (now >= nextCapacityLog) {
        deps.log("error", "WS_SILENCE_JOURNAL_FULL", {
          pending: episodes.size,
        });
        nextCapacityLog = now + REST_RESYNC_THROTTLE_MS;
      }
      return;
    }
    const selection =
      (tokenId === undefined ? null : tokens.get(tokenId)?.silentSelection) ??
      rank(onset);
    // Zero deltas is a tie for the global control, not evidence of failure.
    // It never makes a book-only/illiquid token eligible for a per-token gap.
    const reference =
      tokenId ?? selection[0]?.token ?? [...tokens.keys()].sort()[0] ?? null;
    if (tokenId === undefined) {
      for (const entry of selection) {
        const activity = tokens.get(entry.token);
        if (activity) activity.silentSelection = selection;
      }
    }
    const episode: Episode = {
      id: randomUUID(),
      ...(tokenId === undefined ? {} : { tokenId }),
      start: onset,
      detectedAt: now,
      end: null,
      reference,
      details: {
        detected_at: new Date(now).toISOString(),
        threshold_ms: threshold,
        observation: "valid_ws_book_or_price_change_arrival",
        selection_at: new Date(onset).toISOString(),
        activity_window_ms: SILENCE_WINDOW_MS,
        activity_bucket_ms: activityBucketMs,
        active_tokens: selection,
        reference_token: reference,
        control: reference === null ? "unavailable" : "pending",
        ...(reference === null ? { control_reason: "no_recent_deltas" } : {}),
      },
      attempts: [],
      reconnects: 0,
      nextRecovery: now + threshold,
      controlDue: now,
      controlDeadline: now + Math.max(threshold, 90_000),
      controlDone: reference === null,
      samples: [],
      version: 1,
      savedVersion: 0,
      persistAttempts: 0,
      persistDue: now,
    };
    episodes.set(episode.id, episode);
    active.set(key, episode);
    deps.log("error", "WS_STREAM_SILENT", {
      episode_id: episode.id,
      token_id: tokenId ?? null,
      last_book_frame_ms: onset,
      threshold_ms: threshold,
    });
    // All openings in the same tick share one resubscribe, with evidence per gap.
    if (!restorePending && now >= nextRecovery) {
      deps.resubscribe();
      nextRecovery = now + threshold;
      episode.attempts.push({ action: "resubscribe", at: now });
    } else {
      episode.attempts.push({
        action: restorePending
          ? "resubscribe_deferred_restore"
          : "resubscribe_coalesced",
        at: now,
      });
    }
  }

  function persistOne(drainSeen?: Set<string>): Promise<void> | null {
    if (stopped && !draining) return null;
    if (inFlight !== null) return inFlight;
    const episode = [...episodes.values()].find(
      (item) =>
        item.version !== item.savedVersion &&
        (drainSeen === undefined
          ? item.persistDue <= clock()
          : !drainSeen.has(item.id)),
    );
    if (!episode) return null;
    drainSeen?.add(episode.id);
    const version = episode.version;
    episode.persistAttempts = Math.min(
      episode.persistAttempts + 1,
      SILENCE_MAX_PERSIST_ATTEMPTS,
    );
    const details = {
      ...episode.details,
      attempts: episode.attempts.map((attempt) => ({ ...attempt })),
      control_samples: episode.samples.map((sample) => ({ ...sample })),
    };
    inFlight = deps.gaps
      .saveSilenceGap({
        episodeId: episode.id,
        ...(episode.tokenId === undefined ? {} : { tokenId: episode.tokenId }),
        start: new Date(episode.start),
        end: episode.end === null ? null : new Date(episode.end),
        details,
      })
      .then(() => {
        episode.savedVersion = version;
        episode.persistAttempts = 0;
        if (episode.end !== null && episode.version === version)
          episodes.delete(episode.id);
      })
      .catch(() => {
        const exhausted =
          episode.persistAttempts >= SILENCE_MAX_PERSIST_ATTEMPTS;
        // Eight quick attempts, then one recovery probe per five minutes for an
        // gap. DB recovery must not depend on WS recovery. Never a new row/id.
        episode.persistDue =
          clock() +
          (exhausted
            ? 300_000
            : Math.min(1_000 * 2 ** (episode.persistAttempts - 1), 60_000));
        deps.log(
          "error",
          exhausted ? "WS_SILENCE_PERSIST_EXHAUSTED" : "GAP_PERSIST_FAILED",
          {
            cause: "stream_silent",
            episode_id: episode.id,
            attempt: episode.persistAttempts,
          },
        );
        // Retain even an unsaved close: dropping it could leave a persisted gap
        // open forever. The journal's admission cap bounds this backlog.
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function controlOne(): void {
    if (stopped || controlling) return;
    const now = clock();
    const episode = [...active.values()].find(
      (item) => !item.controlDone && item.controlDue <= now,
    );
    if (!episode || episode.reference === null) return;
    if (now >= episode.controlDeadline) {
      episode.controlDone = true;
      episode.details.control = "unavailable";
      episode.details.control_reason = "control_deadline";
      episode.version += 1;
      return;
    }
    controlling = true;
    void deps
      .control(episode.reference)
      .catch((): ClobControlResult => ({
        status: "unavailable",
        reason: "request_failed",
      }))
      .then((result) => {
        if (stopped || episode.controlDone || episode.end !== null) return;
        if (result.status === "throttled") {
          episode.controlDue = Math.max(now + 1_000, result.retryAtMs);
          return;
        }
        if (result.status === "unavailable") {
          episode.details.control = "unavailable";
          episode.details.control_reason = result.reason;
          episode.controlDone = true;
        } else {
          episode.samples.push({
            fingerprint: result.fingerprint,
            requestedAt: now,
            receivedAt: clock(),
          });
          if (episode.samples.length === 2) {
            episode.details.control =
              episode.samples[0]?.fingerprint === result.fingerprint
                ? "venue_quiet"
                : "blind";
            episode.controlDone = true;
          } else {
            episode.controlDue = clock() + REST_RESYNC_THROTTLE_MS;
          }
        }
        episode.version += 1;
        if (episode.controlDone)
          deps.log("info", "WS_SILENCE_CONTROL", {
            episode_id: episode.id,
            control: episode.details.control,
          });
      })
      .finally(() => {
        controlling = false;
      });
  }

  return {
    restore,
    setUniverse(ids): void {
      if (stopped) return;
      const next = new Set(ids);
      const now = clock();
      universeObservedAt = now;
      for (const id of tokens.keys())
        if (!next.has(id)) {
          const episode = active.get(id);
          if (episode) finish(episode, now, "universe_exit");
          finishRestored(id, now, "universe_exit");
          tokens.delete(id);
        }
      for (const id of next)
        if (id && !tokens.has(id))
          tokens.set(id, {
            firstSeen: null,
            lastSeen: null,
            buckets: new Map(),
            silentSelection: null,
          });
      // A failed Gamma boot can restore tokens before any local universe
      // exists. Their departure must be checked against this authoritative
      // result even when they never appeared in the local token map.
      for (const episode of restored.values())
        if (episode.tokenId !== undefined && !tokens.has(episode.tokenId))
          finish(episode, now, "universe_exit");
      if (tokens.size === 0) {
        const global = active.get("");
        if (global) finish(global, now, "universe_empty");
        finishRestored("", now, "universe_empty");
        startedAt = lastFrame = null;
      } else if (startedAt === null) startedAt = now;
    },
    observe(message, firstCopy): boolean {
      if (
        stopped ||
        !message.market.trim() ||
        !/^\d+$/.test(message.timestamp) ||
        !Number.isFinite(new Date(Number(message.timestamp)).getTime())
      )
        return false;
      let observations: { id: string; deltas: number }[] = [];
      if (
        message.event_type === "book" &&
        message.bids.every(validLevel) &&
        message.asks.every(validLevel)
      ) {
        observations = [{ id: message.asset_id, deltas: 0 }];
      } else if (
        message.event_type === "price_change" &&
        message.price_changes.every(validLevel)
      ) {
        observations = message.price_changes.map((change) => ({
          id: change.asset_id,
          deltas: firstCopy ? 1 : 0,
        }));
      }
      const now = clock();
      let valid = false;
      for (const observation of observations) {
        const activity = tokens.get(observation.id);
        if (!activity) continue;
        valid = true;
        activity.firstSeen ??= now;
        activity.lastSeen = now;
        activity.silentSelection = null;
        if (observation.deltas) {
          const bucket = Math.floor(now / activityBucketMs) * activityBucketMs;
          activity.buckets.set(
            bucket,
            (activity.buckets.get(bucket) ?? 0) + observation.deltas,
          );
          for (const key of activity.buckets.keys()) {
            if (
              key <
                now -
                  SILENCE_WINDOW_MS -
                  threshold -
                  ACTIVITY_DETECTION_GRACE_MS ||
              activity.buckets.size > MAX_ACTIVITY_BUCKETS
            )
              activity.buckets.delete(key);
            else break;
          }
        }
        const episode = active.get(observation.id);
        if (episode) finish(episode, now, "ws_book_frame");
        finishRestored(observation.id, now, "ws_book_frame");
      }
      if (valid) {
        firstFrame ??= now;
        lastFrame = now;
        const global = active.get("");
        if (global) finish(global, now, "ws_book_frame");
        finishRestored("", now, "ws_book_frame");
      }
      return valid;
    },
    tick(): void {
      if (stopped) return;
      void restore();
      const now = clock();
      const onset = lastFrame ?? startedAt;
      if (tokens.size && deps.openConnections() > 0 && onset !== null) {
        if (now - onset >= threshold) open(undefined, onset);
        else {
          // Rank at the beginning of the candidate's silence, not after its
          // activity has aged out. Bounded buckets, frozen in the episode.
          for (const [id, activity] of tokens) {
            if (active.size - Number(active.has("")) >= 5) break;
            if (
              activity.lastSeen !== null &&
              now - activity.lastSeen >= threshold
            ) {
              // Freeze eligibility on first detection, while the preceding
              // window is retained. A global outage also freezes its top five.
              // Never rank an old silent token against peers whose history has
              // already been evicted (including very large N overrides).
              if (
                activity.silentSelection === null &&
                now - activity.lastSeen <=
                  threshold + ACTIVITY_DETECTION_GRACE_MS
              ) {
                activity.silentSelection = rank(activity.lastSeen);
              }
              if (activity.silentSelection?.some((entry) => entry.token === id))
                open(id, activity.lastSeen);
            }
          }
        }
      }
      const deferred = [...active.values()].filter(
        (episode) =>
          episode.details.restored_recovery_episode === undefined &&
          episode.attempts.some(
            (attempt) => attempt.action === "resubscribe_deferred_restore",
          ) &&
          !episode.attempts.some((attempt) => attempt.action === "resubscribe"),
      );
      if (
        !restorePending &&
        deferred.length &&
        now >= nextRecovery &&
        deps.openConnections() > 0
      ) {
        deps.resubscribe();
        nextRecovery = now + threshold;
        for (const episode of deferred) {
          episode.attempts.push({ action: "resubscribe", at: now });
          episode.nextRecovery = now + threshold;
          episode.version += 1;
        }
      }
      const recoverable = [...active.values(), ...restored.values()].filter(
        (item) =>
          tokens.size > 0 &&
          item.nextRecovery <= now &&
          item.reconnects < SILENCE_MAX_RECONNECTS,
      );
      if (
        recoverable.length &&
        !restorePending &&
        now >= nextRecovery &&
        deps.openConnections() > 0
      ) {
        deps.reconnect();
        for (const episode of recoverable) {
          episode.reconnects += 1;
          episode.details.recovery_reconnects = episode.reconnects;
          episode.attempts.push({ action: "reconnect", at: now });
          episode.nextRecovery = now + threshold * 2 ** episode.reconnects;
          episode.details.recovery_exhausted =
            episode.reconnects === SILENCE_MAX_RECONNECTS;
          deps.log(
            episode.reconnects === SILENCE_MAX_RECONNECTS ? "error" : "warn",
            episode.reconnects === SILENCE_MAX_RECONNECTS
              ? "WS_SILENCE_RECOVERY_EXHAUSTED"
              : "WS_SILENCE_RECONNECT",
            { episode_id: episode.id, attempt: episode.reconnects },
          );
          episode.version += 1;
        }
        nextRecovery = now + threshold;
      }
      persistOne();
      controlOne();
    },
    stop(): Promise<void> {
      if (stopPromise !== null) return stopPromise;
      stopped = true;
      draining = true;
      // Stop observation/recovery immediately, but retain a close received just
      // before shutdown. One final write per dirty episode, bounded by grace.
      for (const episode of active.values()) {
        if (!episode.controlDone) {
          episode.controlDone = true;
          episode.details.control = "unavailable";
          episode.details.control_reason = "shutdown";
          episode.version += 1;
        }
      }
      const drainSeen = new Set<string>();
      const drain = async (): Promise<void> => {
        if (inFlight !== null) await inFlight;
        while (draining) {
          const pending = persistOne(drainSeen);
          if (pending === null) break;
          await pending;
        }
      };
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SILENCE_SHUTDOWN_GRACE_MS);
      });
      stopPromise = Promise.race([drain(), deadline]).finally(() => {
        clearTimeout(timer);
        draining = false;
        const pending = [...episodes.values()].filter(
          (item) => item.version !== item.savedVersion,
        ).length;
        if (pending)
          deps.log("error", "WS_SILENCE_SHUTDOWN_UNFLUSHED", { pending });
      });
      return stopPromise;
    },
    stats: () => ({
      lastBookFrameMs: lastFrame,
      openGaps: active.size + restored.size,
      pendingWrites: [...episodes.values()].filter(
        (item) => item.version !== item.savedVersion,
      ).length,
      restorePending,
      restoreFailures,
      restoreOverflow,
    }),
  };
}
