// RFC-007 task 10: data-quality primitives — gap bookkeeping, in-memory feed
// health, hourly book reconciliation against CLOB REST, and exported metrics.
// Public data only; no trading/wallet/order paths. Prices and sizes stay
// canonical decimal strings (no floats for money math).

import type { SqlExecutor } from "../database.js";
import { OrderBook } from "./book.js";
import type { PriceLevel } from "./types.js";

/** Minimal query surface so tests can inject a fake pool. */
export type QueryPool = { query: SqlExecutor["query"] };

export type GapSource =
  | "gamma"
  | "clob_ws"
  | "clob_rest"
  | "data_api"
  | "rtds"
  | "macro"
  | "internal";

/** Global module budget: 40 GB of PostgreSQL (RFC-007 "Orçamento"). */
export const BUDGET_BYTES = 40 * 1024 ** 3;

export const CLOB_REST_BASE_URL = "https://clob.polymarket.com";

// Same browser-like identity the recorder sends (Cloudflare rejects bare
// clients). Kept local: each module is self-contained.
const USER_AGENT = "GansoMarketRecorder/1.0 (+public-data-recorder)";

function log(
  level: "info" | "warn" | "error",
  reasonCode: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  process.stderr.write(
    `${JSON.stringify({
      level,
      service: "polymarket-recorder",
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      message,
      ...extra,
    })}\n`,
  );
}

// ---------------------------------------------------------------------------
// Gap writer
// ---------------------------------------------------------------------------

export interface OpenGapInput {
  readonly source: GapSource;
  readonly tokenId?: string;
  readonly cause: string;
  readonly details?: Record<string, unknown>;
  readonly start: Date;
}

export interface InstantGapInput {
  readonly source: GapSource;
  readonly tokenId?: string;
  readonly cause: string;
  readonly details?: Record<string, unknown>;
  readonly at: Date;
}

export interface GapWriter {
  /** Insert an open gap ([start, null)); returns the new gap_id. */
  openGap(input: OpenGapInput): Promise<number>;
  /** Close a previously opened gap. */
  closeGap(gapId: number, end: Date): Promise<void>;
  /** Record a point-in-time gap event (start = end); returns the gap_id. */
  recordInstantGap(input: InstantGapInput): Promise<number>;
}

export function createGapWriter(pool: QueryPool): GapWriter {
  return {
    async openGap(input: OpenGapInput): Promise<number> {
      const result = await pool.query<{ gap_id: number | string }>(
        `INSERT INTO polymarket_data_gaps
           (source, token_id, gap_start, cause, details_json)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING gap_id`,
        [
          input.source,
          input.tokenId ?? null,
          input.start,
          input.cause,
          input.details === undefined ? null : JSON.stringify(input.details),
        ],
      );
      return Number(result.rows[0]?.gap_id ?? 0);
    },
    async closeGap(gapId: number, end: Date): Promise<void> {
      await pool.query(
        `UPDATE polymarket_data_gaps SET gap_end = $2 WHERE gap_id = $1`,
        [gapId, end],
      );
    },
    async recordInstantGap(input: InstantGapInput): Promise<number> {
      const result = await pool.query<{ gap_id: number | string }>(
        `INSERT INTO polymarket_data_gaps
           (source, token_id, gap_start, gap_end, cause, details_json)
         VALUES ($1, $2, $3, $3, $4, $5::jsonb)
         RETURNING gap_id`,
        [
          input.source,
          input.tokenId ?? null,
          input.at,
          input.cause,
          input.details === undefined ? null : JSON.stringify(input.details),
        ],
      );
      return Number(result.rows[0]?.gap_id ?? 0);
    },
  };
}

// ---------------------------------------------------------------------------
// Feed health (in-memory, 24h window)
// ---------------------------------------------------------------------------

const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_STALE_THRESHOLD_MS = 60_000;

export interface FeedHealthSourceSnapshot {
  readonly lastSeenMs: number | null;
  readonly uptimePct: number;
  readonly heartbeats: number;
}

export interface FeedHealth {
  heartbeat(source: string): void;
  snapshot(): Record<string, FeedHealthSourceSnapshot>;
}

/**
 * Tracks per-source liveness in memory. A heartbeat covers up to
 * `staleThresholdMs` of wall time; uptime is the covered share of the last
 * 24 hours (or since the tracker started, whichever is shorter).
 */
export function createFeedHealth(
  clock: () => number,
  staleThresholdMs: number = DEFAULT_STALE_THRESHOLD_MS,
): FeedHealth {
  const startedAtMs = clock();
  const beats = new Map<string, number[]>();

  function prune(times: number[], nowMs: number): void {
    const cutoff = nowMs - HEALTH_WINDOW_MS;
    while (times.length > 0 && (times[0] ?? Infinity) < cutoff) {
      times.shift();
    }
  }

  return {
    heartbeat(source: string): void {
      const nowMs = clock();
      const times = beats.get(source) ?? [];
      times.push(nowMs);
      prune(times, nowMs);
      beats.set(source, times);
    },
    snapshot(): Record<string, FeedHealthSourceSnapshot> {
      const nowMs = clock();
      const windowStart = Math.max(nowMs - HEALTH_WINDOW_MS, startedAtMs);
      const span = Math.max(nowMs - windowStart, 1);
      const result: Record<string, FeedHealthSourceSnapshot> = {};
      for (const [source, times] of beats) {
        prune(times, nowMs);
        let covered = 0;
        for (let i = 0; i < times.length; i += 1) {
          const current = Math.max(times[i] ?? nowMs, windowStart);
          const nextBeat =
            i + 1 < times.length ? (times[i + 1] ?? nowMs) : nowMs;
          const coverageEnd = Math.min(nextBeat, current + staleThresholdMs);
          if (coverageEnd > current) {
            covered += coverageEnd - current;
          }
        }
        const lastSeenMs =
          times.length > 0 ? (times[times.length - 1] ?? null) : null;
        result[source] = {
          lastSeenMs,
          uptimePct: Math.min(100, (covered / span) * 100),
          heartbeats: times.length,
        };
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Hourly reconciliation against CLOB REST /book
// ---------------------------------------------------------------------------

type JsonFetcher = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface CachedBook {
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
  /** Book hash of the last applied WS `book` event, when tracked. */
  readonly hashOf?: string;
}

export interface ReconcilerDeps {
  readonly pool: QueryPool;
  readonly fetcher?: JsonFetcher;
  readonly getCachedBook: (tokenId: string) => CachedBook | null;
  readonly requestResync: (tokenId: string) => void;
  readonly clock: () => number;
  readonly restBaseUrl?: string;
  /** Max tokens compared per round (round-robin over the universe). */
  readonly sampleSize?: number;
}

export interface ReconcileStats {
  checked: number;
  divergent: number;
  skipped: number;
}

export interface Reconciler {
  reconcileOnce(tokenIds: readonly string[]): Promise<ReconcileStats>;
}

const DEFAULT_SAMPLE_SIZE = 20;
const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

interface RestBook {
  readonly hash: string | null;
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
}

function parseRestLevels(value: unknown): PriceLevel[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const levels: PriceLevel[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      return null;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.price !== "string" || typeof record.size !== "string") {
      return null;
    }
    levels.push({ price: record.price, size: record.size });
  }
  return levels;
}

function parseRestBook(body: unknown): RestBook | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const bids = parseRestLevels(record.bids);
  const asks = parseRestLevels(record.asks);
  if (bids === null || asks === null) {
    return null;
  }
  return {
    hash: typeof record.hash === "string" ? record.hash : null,
    bids,
    asks,
  };
}

function topLevelsKey(
  bids: readonly PriceLevel[],
  asks: readonly PriceLevel[],
): string {
  const book = new OrderBook();
  book.replace(bids, asks);
  return JSON.stringify({ bids: book.topBids(10), asks: book.topAsks(10) });
}

/**
 * Compares a sample of cached books against REST `/book`. A divergence
 * requests a resync and records an instantaneous `clob_ws` gap with cause
 * `reconcile_divergence`. 429/5xx trigger exponential backoff — never a crash.
 */
export function createReconciler(deps: ReconcilerDeps): Reconciler {
  const fetcher: JsonFetcher =
    deps.fetcher ?? (fetch as unknown as JsonFetcher);
  const baseUrl = deps.restBaseUrl ?? CLOB_REST_BASE_URL;
  const sampleSize = deps.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const gapWriter = createGapWriter(deps.pool);
  let cursor = 0;
  let backoffUntilMs = 0;
  let backoffMs = INITIAL_BACKOFF_MS;

  function enterBackoff(status: number | null): void {
    backoffUntilMs = deps.clock() + backoffMs;
    log("warn", "RECONCILE_BACKOFF", "polymarket_reconcile_backoff", {
      status,
      backoff_ms: backoffMs,
    });
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }

  return {
    async reconcileOnce(tokenIds: readonly string[]): Promise<ReconcileStats> {
      const stats: ReconcileStats = { checked: 0, divergent: 0, skipped: 0 };
      if (tokenIds.length === 0) {
        return stats;
      }
      if (deps.clock() < backoffUntilMs) {
        stats.skipped = Math.min(sampleSize, tokenIds.length);
        return stats;
      }
      const count = Math.min(sampleSize, tokenIds.length);
      const sample: string[] = [];
      for (let i = 0; i < count; i += 1) {
        sample.push(tokenIds[(cursor + i) % tokenIds.length] ?? "");
      }
      cursor = (cursor + count) % tokenIds.length;

      for (const tokenId of sample) {
        const cached = deps.getCachedBook(tokenId);
        if (cached === null) {
          stats.skipped += 1;
          continue;
        }
        let response: Awaited<ReturnType<JsonFetcher>>;
        try {
          response = await fetcher(
            `${baseUrl}/book?token_id=${encodeURIComponent(tokenId)}`,
            {
              headers: {
                accept: "application/json",
                "user-agent": USER_AGENT,
              },
            },
          );
        } catch (error: unknown) {
          log(
            "error",
            "RECONCILE_FETCH_FAILED",
            "polymarket_reconcile_fetch_failed",
            {
              error_name: error instanceof Error ? error.name : "UnknownError",
            },
          );
          enterBackoff(null);
          break;
        }
        if (!response.ok) {
          if (response.status === 429 || response.status >= 500) {
            enterBackoff(response.status);
            break;
          }
          stats.skipped += 1;
          continue;
        }
        let restBook: RestBook | null = null;
        try {
          restBook = parseRestBook(await response.json());
        } catch {
          restBook = null;
        }
        if (restBook === null) {
          stats.skipped += 1;
          continue;
        }
        backoffMs = INITIAL_BACKOFF_MS;

        const equal =
          cached.hashOf !== undefined && restBook.hash !== null
            ? cached.hashOf === restBook.hash
            : topLevelsKey(cached.bids, cached.asks) ===
              topLevelsKey(restBook.bids, restBook.asks);
        stats.checked += 1;
        if (equal) {
          continue;
        }
        stats.divergent += 1;
        deps.requestResync(tokenId);
        try {
          await gapWriter.recordInstantGap({
            source: "clob_ws",
            tokenId,
            cause: "reconcile_divergence",
            details: {
              rest_hash: restBook.hash,
              cached_hash: cached.hashOf ?? null,
            },
            at: new Date(deps.clock()),
          });
        } catch (error: unknown) {
          // A persistence failure must never take the reconciler down.
          log("error", "GAP_PERSIST_FAILED", "polymarket_gap_persist_failed", {
            error_name: error instanceof Error ? error.name : "UnknownError",
            token_id: tokenId,
          });
        }
        log("warn", "RECONCILE_DIVERGENCE", "polymarket_reconcile_divergence", {
          token_id: tokenId,
        });
      }
      return stats;
    },
  };
}

// ---------------------------------------------------------------------------
// Metrics snapshot
// ---------------------------------------------------------------------------

export interface GapSourceMetrics {
  readonly count: number;
  readonly totalSeconds: number;
}

export interface QualityMetrics {
  readonly gapsLast24h: Record<string, GapSourceMetrics>;
  readonly ingestLagLastHour: {
    readonly p50Ms: number | null;
    readonly p99Ms: number | null;
  };
  readonly updatesLastHour: number;
  readonly bytesByTable: Record<string, number>;
  readonly totalBytes: number;
  readonly budgetBytes: number;
  readonly budgetUsedPct: number;
}

/** Aggregated quality metrics for the /polymarket/data-quality endpoint. */
export async function metricsSnapshot(
  pool: QueryPool,
  clock: () => Date,
): Promise<QualityMetrics> {
  const now = clock();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
  const since1h = new Date(now.getTime() - 60 * 60 * 1_000);

  const gapRows = await pool.query<{
    source: string;
    gap_count: string | number;
    total_seconds: string | number | null;
  }>(
    `SELECT source,
            COUNT(*)::bigint AS gap_count,
            COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(gap_end, $2::timestamptz) - gap_start))), 0)
              AS total_seconds
       FROM polymarket_data_gaps
      WHERE gap_start >= $1
      GROUP BY source`,
    [since24h, now],
  );

  const lagRows = await pool.query<{
    p50: string | number | null;
    p99: string | number | null;
    updates: string | number;
  }>(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ingest_lag_ms) AS p50,
            percentile_cont(0.99) WITHIN GROUP (ORDER BY ingest_lag_ms) AS p99,
            COUNT(*)::bigint AS updates
       FROM (
         SELECT ingest_lag_ms FROM polymarket_book_deltas WHERE received_at >= $1
         UNION ALL
         SELECT ingest_lag_ms FROM polymarket_rtds_prices WHERE received_at >= $1
       ) samples`,
    [since1h],
  );

  const sizeRows = await pool.query<{
    table_name: string;
    bytes: string | number;
  }>(
    `SELECT c.relname AS table_name,
            pg_total_relation_size(c.oid)::bigint AS bytes
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname LIKE 'polymarket\\_%'`,
    [],
  );

  const gapsLast24h: Record<string, GapSourceMetrics> = {};
  for (const row of gapRows.rows) {
    gapsLast24h[row.source] = {
      count: Number(row.gap_count),
      totalSeconds: Number(row.total_seconds ?? 0),
    };
  }

  const lag = lagRows.rows[0];
  const bytesByTable: Record<string, number> = {};
  let totalBytes = 0;
  for (const row of sizeRows.rows) {
    const bytes = Number(row.bytes);
    bytesByTable[row.table_name] = bytes;
    totalBytes += bytes;
  }

  return {
    gapsLast24h,
    ingestLagLastHour: {
      p50Ms:
        lag?.p50 === null || lag?.p50 === undefined ? null : Number(lag.p50),
      p99Ms:
        lag?.p99 === null || lag?.p99 === undefined ? null : Number(lag.p99),
    },
    updatesLastHour: Number(lag?.updates ?? 0),
    bytesByTable,
    totalBytes,
    budgetBytes: BUDGET_BYTES,
    budgetUsedPct: (totalBytes / BUDGET_BYTES) * 100,
  };
}
