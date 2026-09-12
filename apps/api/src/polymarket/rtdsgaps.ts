import { randomUUID } from "node:crypto";

import type { DatabasePool } from "../database.js";
import { errorFields } from "../errors.js";

export const RTDS_MAX_PENDING_GAPS = 256;
export const RTDS_MAX_GAP_PERSIST_ATTEMPTS = 8;
export const RTDS_GAP_PROBE_INTERVAL_MS = 5 * 60_000;
export const RTDS_GAP_SHUTDOWN_GRACE_MS = 5_000;

interface Entry {
  readonly id: string;
  readonly start: Date;
  readonly cause: string;
  end: Date | null;
  details: Record<string, unknown>;
  version: number;
  savedVersion: number;
  failures: number;
  due: number;
  exhausted: boolean;
}

export interface RtdsGapJournal {
  record(
    start: Date,
    end: Date | null,
    cause: string,
    details: Record<string, unknown>,
  ): string;
  update(id: string, end: Date | null, details: Record<string, unknown>): void;
  flush(): Promise<void>;
  /** Freeze observation, then drain due writes within the shutdown grace. */
  drainAndStop(): Promise<void>;
  stop(): Promise<void>;
  stats(): {
    pendingGapWrites: number;
    gapPersistFailures: number;
    lastGapPersistErrorMs: number | null;
    gapJournalOverflow: number;
    gapRetryExhausted: number;
  };
}

/**
 * The recorder owns the retry timer. An acknowledged open gap remains in this
 * bounded journal until its close is saved. Failed writes survive socket
 * recovery, with a finite retry burst followed by infrequent recovery probes.
 *
 * episode_id makes a lost acknowledgement safe to retry. Unsaved snapshots are
 * in memory: a process crash can lose them; this is not a disk-backed outbox.
 */
export function createRtdsGapJournal(deps: {
  pool: Pick<DatabasePool, "query">;
  clock?: () => number;
  log: (
    level: "info" | "warn" | "error",
    code: string,
    details: Record<string, unknown>,
  ) => void;
}): RtdsGapJournal {
  const clock = deps.clock ?? Date.now;
  const entries = new Map<string, Entry>();
  let stopped = false;
  let draining = false;
  let inFlight: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let gapPersistFailures = 0;
  let lastGapPersistErrorMs: number | null = null;
  let gapJournalOverflow = 0;
  let gapRetryExhausted = 0;

  const pending = (): number =>
    [...entries.values()].filter(
      (entry) => entry.version !== entry.savedVersion,
    ).length;

  function update(
    id: string,
    end: Date | null,
    details: Record<string, unknown>,
  ): void {
    if (stopped) return;
    const entry = entries.get(id);
    if (entry === undefined) return;
    // A stale replay must never reopen a closed episode or move its first end.
    if (entry.end === null && end !== null) entry.end = new Date(end);
    entry.details = { ...entry.details, ...details, episode_id: id };
    entry.version += 1;
    // Observing more recovery actions cannot circumvent a failed DB's budget.
    if (entry.failures === 0) entry.due = clock();
  }

  function persistDue(): Promise<void> {
    if (stopped && !draining) return Promise.resolve();
    if (inFlight !== null) return inFlight;
    const now = clock();
    const due = [...entries.values()].filter(
      (entry) => entry.version !== entry.savedVersion && entry.due <= now,
    );
    if (due.length === 0) return Promise.resolve();
    const run = async (): Promise<void> => {
      for (const entry of due) {
        if (stopped && !draining) break;
        const version = entry.version;
        const end = entry.end;
        try {
          await deps.pool.query(
            `INSERT INTO polymarket_data_gaps
               (source, gap_start, gap_end, cause, details_json)
             VALUES ('rtds', $1, $2, $3, $4::jsonb)
             ON CONFLICT ((details_json->>'episode_id'))
               WHERE source = 'rtds' AND details_json ? 'episode_id'
             DO UPDATE SET
               gap_start = LEAST(polymarket_data_gaps.gap_start, EXCLUDED.gap_start),
               gap_end = COALESCE(polymarket_data_gaps.gap_end, EXCLUDED.gap_end),
               details_json = polymarket_data_gaps.details_json || EXCLUDED.details_json`,
            [entry.start, end, entry.cause, JSON.stringify(entry.details)],
          );
          entry.savedVersion = version;
          entry.failures = 0;
          entry.exhausted = false;
          entry.due = clock();
          deps.log("info", "RTDS_GAP_PERSISTED", {
            episode_id: entry.id,
            cause: entry.cause,
            gap_start: entry.start.toISOString(),
            gap_end: end?.toISOString() ?? null,
          });
          if (entry.end !== null && entry.savedVersion === entry.version)
            entries.delete(entry.id);
        } catch (error) {
          const failedAt = clock();
          entry.failures += 1;
          gapPersistFailures += 1;
          lastGapPersistErrorMs = failedAt;
          const exhausted = entry.failures >= RTDS_MAX_GAP_PERSIST_ATTEMPTS;
          if (exhausted && !entry.exhausted) {
            entry.exhausted = true;
            gapRetryExhausted += 1;
          }
          entry.due =
            failedAt +
            (exhausted
              ? RTDS_GAP_PROBE_INTERVAL_MS
              : Math.min(60_000, 1_000 * 2 ** (entry.failures - 1)));
          deps.log("error", "RTDS_GAP_PERSIST_FAILED", {
            episode_id: entry.id,
            cause: entry.cause,
            attempt: entry.failures,
            retry_exhausted: exhausted,
            next_probe_at: new Date(entry.due).toISOString(),
            ...errorFields(error),
          });
        }
      }
    };
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function shutdown(drain: boolean): Promise<void> {
    if (stopPromise !== null) return stopPromise;
    // External observation/flush stops immediately. Only this bounded drain
    // may dispatch further writes; after the deadline even its continuation
    // cannot send a query. A query already dispatched belongs to the DB pool.
    stopped = true;
    draining = drain;
    const finish = async (): Promise<void> => {
      if (inFlight !== null) await inFlight;
      // A close may have arrived while an open snapshot was in flight. Freeze
      // versions at shutdown, then persist that remaining dirty snapshot too.
      if (draining) await persistDue();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, RTDS_GAP_SHUTDOWN_GRACE_MS);
    });
    stopPromise = Promise.race([finish(), deadline]).finally(() => {
      clearTimeout(timer);
      draining = false;
      const count = pending();
      if (count > 0)
        deps.log("error", "RTDS_GAP_SHUTDOWN_UNFLUSHED", { pending: count });
    });
    return stopPromise;
  }

  return {
    record(start, end, cause, details): string {
      const id =
        typeof details.episode_id === "string" && details.episode_id.length > 0
          ? details.episode_id
          : randomUUID();
      if (stopped) return id;
      if (entries.has(id)) {
        update(id, end, details);
        return id;
      }
      if (entries.size >= RTDS_MAX_PENDING_GAPS) {
        gapJournalOverflow += 1;
        deps.log("error", "RTDS_GAP_JOURNAL_FULL", {
          episode_id: id,
          cause,
          retained: entries.size,
          dropped: gapJournalOverflow,
        });
        return id;
      }
      entries.set(id, {
        id,
        start: new Date(start),
        end: end === null ? null : new Date(end),
        cause,
        details: { ...details, episode_id: id },
        version: 1,
        savedVersion: 0,
        failures: 0,
        due: clock(),
        exhausted: false,
      });
      return id;
    },
    update,
    flush: () => (stopped ? Promise.resolve() : persistDue()),
    drainAndStop: () => shutdown(true),
    stop: () => shutdown(false),
    stats: () => ({
      pendingGapWrites: pending(),
      gapPersistFailures,
      lastGapPersistErrorMs,
      gapJournalOverflow,
      gapRetryExhausted,
    }),
  };
}
