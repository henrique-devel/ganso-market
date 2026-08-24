// RFC-007 task 5: trade persistence. Two provenances feed polymarket_trades:
// the WS `last_trade_price` events ('ws') and the incremental Data API
// `/trades` backfill ('data_api'). Prices/sizes/fees are canonical decimal
// strings, never floats. Dedupe is enforced by the partial unique indexes of
// migration 0005 (ON CONFLICT DO NOTHING) plus an in-memory set per poll for
// the windowed backfill. A persistence failure never crashes the process: it
// is logged and the loop continues (regression of the source_ts crash-loop,
// commit 350d3c9).

import type { SqlExecutor } from "../database.js";
import { sourceTsToDate } from "./recorder.js";
import type { LastTradePriceMessage } from "./types.js";

export const DATA_API_BASE_URL = "https://data-api.polymarket.com";

// Same browser-like UA the recorder sends (Polymarket sits behind Cloudflare).
const USER_AGENT = "GansoMarketRecorder/1.0 (+public-data-recorder)";

// Data API `/trades` clamps limit and offset; the backfill therefore paginates
// by timestamp windows, always overlapping the previous window by one second
// and deduping by the trade's external id.
export const TRADES_PAGE_LIMIT = 1_000;
export const TRADES_MAX_OFFSET = 10_000;
export const WINDOW_OVERLAP_MS = 1_000;
export const DEFAULT_WINDOW_MS = 60 * 60 * 1_000;
export const DEFAULT_INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
export const BEHIND_GAP_THRESHOLD_MS = 15 * 60 * 1_000;
const MAX_FETCH_RETRIES = 3;
const BACKOFF_BASE_MS = 1_000;

type JsonFetcher = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;

function logJson(
  level: "error" | "warn",
  reasonCode: string,
  message: string,
  extra: Record<string, unknown> = {},
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

/**
 * Persist one WS `last_trade_price` event with provenance 'ws'. Duplicates
 * (the feed replays the same transaction across connections) are absorbed by
 * the partial unique index on (token_id, transaction_hash, price, side) via
 * ON CONFLICT DO NOTHING. Never throws.
 */
export async function handleLastTrade(
  pool: SqlExecutor,
  msg: LastTradePriceMessage,
  clock: () => number,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO polymarket_trades
         (token_id, condition_id, price, size, side, fee_rate_bps,
          transaction_hash, provenance, external_id, trade_ts, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ws',NULL,$8,$9)
       ON CONFLICT DO NOTHING`,
      [
        msg.asset_id,
        msg.market,
        msg.price,
        msg.size ?? null,
        msg.side,
        msg.fee_rate_bps ?? null,
        msg.transaction_hash ?? null,
        sourceTsToDate(msg.timestamp),
        new Date(clock()),
      ],
    );
  } catch (error: unknown) {
    logJson(
      "error",
      "WS_TRADE_PERSIST_FAILED",
      "polymarket_ws_trade_persist_failed",
      {
        error_name: error instanceof Error ? error.name : "UnknownError",
        token_id: msg.asset_id,
      },
    );
  }
}

interface DataApiTrade {
  readonly externalId: string;
  readonly tokenId: string;
  readonly conditionId: string | null;
  readonly price: string;
  readonly size: string | null;
  readonly side: "BUY" | "SELL" | null;
  readonly transactionHash: string | null;
  readonly tradeTs: Date | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Numbers become their canonical string form; they are never used in math.
function asDecimalString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

// Data API timestamps are epoch seconds; WS uses epoch milliseconds. Accept
// both by magnitude and reject anything non-numeric (source_ts regression).
function epochToDate(value: unknown): Date | null {
  let ms: number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) {
    ms = value;
  } else if (typeof value === "string" && /^\d{1,15}$/.test(value)) {
    ms = Number(value);
  }
  if (ms === null) {
    return null;
  }
  return new Date(ms < 1_000_000_000_000 ? ms * 1_000 : ms);
}

function normalizeSide(value: unknown): "BUY" | "SELL" | null {
  if (typeof value !== "string") {
    return null;
  }
  const upper = value.toUpperCase();
  return upper === "BUY" || upper === "SELL" ? upper : null;
}

/** Tolerant parse of one Data API `/trades` row; null when unusable. */
export function parseDataApiTrade(raw: unknown): DataApiTrade | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const tokenId = asString(record.asset) ?? asString(record.asset_id);
  const price = asDecimalString(record.price);
  if (tokenId === null || price === null) {
    return null;
  }
  const transactionHash =
    asString(record.transactionHash) ?? asString(record.transaction_hash);
  const tradeTs = epochToDate(record.timestamp);
  const side = normalizeSide(record.side);
  // external_id is the Data API trade id when present; otherwise a
  // deterministic composite so dedupe across overlapping windows still works.
  const rawId = record.id;
  const externalId =
    asString(rawId) ??
    (typeof rawId === "number" && Number.isFinite(rawId)
      ? String(rawId)
      : `${transactionHash ?? "notx"}:${tokenId}:${price}:${side ?? "?"}:${
          tradeTs?.getTime() ?? "?"
        }`);
  return {
    externalId,
    tokenId,
    conditionId:
      asString(record.conditionId) ??
      asString(record.condition_id) ??
      asString(record.market),
    price,
    size: asDecimalString(record.size),
    side,
    transactionHash,
    tradeTs,
  };
}

export interface TradesBackfillDeps {
  readonly pool: SqlExecutor;
  readonly fetcher?: JsonFetcher;
  readonly baseUrl?: string;
  readonly clock: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly windowMs?: number;
  readonly initialLookbackMs?: number;
}

export interface TradesBackfill {
  pollOnce(conditionIds: readonly string[]): Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Incremental `/trades` backfill (provenance 'data_api'). Each market resumes
 * from its last recorded data_api trade_ts, then walks forward in timestamp
 * windows (never offset beyond the API's 10k clamp), each window overlapping
 * the previous by 1s. HTTP failures back off; if a market's window stays more
 * than 15 minutes behind after retries, a data_api gap row is recorded.
 */
export function createTradesBackfill(deps: TradesBackfillDeps): TradesBackfill {
  const fetcher: JsonFetcher =
    deps.fetcher ?? (fetch as unknown as JsonFetcher);
  const baseUrl = deps.baseUrl ?? DATA_API_BASE_URL;
  const sleep = deps.sleep ?? defaultSleep;
  const windowMs = Math.max(
    deps.windowMs ?? DEFAULT_WINDOW_MS,
    WINDOW_OVERLAP_MS * 2,
  );
  const initialLookbackMs =
    deps.initialLookbackMs ?? DEFAULT_INITIAL_LOOKBACK_MS;

  async function fetchPage(
    conditionId: string,
    startMs: number,
    endMs: number,
    offset: number,
  ): Promise<unknown[]> {
    const url =
      `${baseUrl}/trades?market=${encodeURIComponent(conditionId)}` +
      `&takerOnly=false&limit=${TRADES_PAGE_LIMIT}&offset=${offset}` +
      `&startTs=${Math.floor(startMs / 1_000)}&endTs=${Math.ceil(endMs / 1_000)}`;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetcher(url, {
          headers: { accept: "application/json", "user-agent": USER_AGENT },
        });
        if (response.ok) {
          const body = (await response.json()) as unknown;
          return Array.isArray(body) ? body : [];
        }
        logJson(
          "warn",
          "TRADES_FETCH_HTTP_ERROR",
          "polymarket_trades_fetch_http_error",
          {
            condition_id: conditionId,
            status: response.status ?? null,
            attempt,
          },
        );
      } catch (error: unknown) {
        logJson(
          "warn",
          "TRADES_FETCH_NETWORK_ERROR",
          "polymarket_trades_fetch_network_error",
          {
            condition_id: conditionId,
            error_name: error instanceof Error ? error.name : "UnknownError",
            attempt,
          },
        );
      }
      if (attempt >= MAX_FETCH_RETRIES) {
        throw new Error(`trades fetch failed for ${conditionId}`);
      }
      await sleep(BACKOFF_BASE_MS * 2 ** attempt);
    }
  }

  async function insertTrade(trade: DataApiTrade): Promise<void> {
    await deps.pool.query(
      `INSERT INTO polymarket_trades
         (token_id, condition_id, price, size, side, fee_rate_bps,
          transaction_hash, provenance, external_id, trade_ts, received_at)
       VALUES ($1,$2,$3,$4,$5,NULL,$6,'data_api',$7,$8,$9)
       ON CONFLICT DO NOTHING`,
      [
        trade.tokenId,
        trade.conditionId,
        trade.price,
        trade.size,
        trade.side,
        trade.transactionHash,
        trade.externalId,
        trade.tradeTs,
        new Date(deps.clock()),
      ],
    );
  }

  async function recordBehindGap(
    conditionId: string,
    coveredUntilMs: number,
  ): Promise<void> {
    try {
      await deps.pool.query(
        `INSERT INTO polymarket_data_gaps
           (source, token_id, gap_start, gap_end, cause, details_json)
         VALUES ('data_api',NULL,$1,$2,$3,$4::jsonb)`,
        [
          new Date(coveredUntilMs),
          new Date(deps.clock()),
          "trades_backfill_behind",
          JSON.stringify({ condition_id: conditionId }),
        ],
      );
    } catch (error: unknown) {
      logJson("error", "GAP_PERSIST_FAILED", "polymarket_gap_persist_failed", {
        condition_id: conditionId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  async function recordOverflowGap(
    conditionId: string,
    fetchStartMs: number,
    fetchEndMs: number,
    offset: number,
  ): Promise<void> {
    try {
      await deps.pool.query(
        `INSERT INTO polymarket_data_gaps
           (source, token_id, gap_start, gap_end, cause, details_json)
         VALUES ('data_api',NULL,$1,$2,$3,$4::jsonb)`,
        [
          new Date(fetchStartMs),
          new Date(fetchEndMs),
          "trades_window_overflow",
          JSON.stringify({ condition_id: conditionId, offset }),
        ],
      );
    } catch (error: unknown) {
      logJson("error", "GAP_PERSIST_FAILED", "polymarket_gap_persist_failed", {
        condition_id: conditionId,
        cause: "trades_window_overflow",
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  async function lastRecordedTs(conditionId: string): Promise<Date | null> {
    const result = await deps.pool.query<{ max_ts: Date | string | null }>(
      `SELECT max(trade_ts) AS max_ts FROM polymarket_trades
        WHERE provenance = 'data_api' AND condition_id = $1`,
      [conditionId],
    );
    const raw = result.rows[0]?.max_ts ?? null;
    if (raw instanceof Date) {
      return raw;
    }
    if (typeof raw === "string") {
      const parsed = new Date(raw);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
  }

  async function backfillMarket(
    conditionId: string,
    seen: Set<string>,
  ): Promise<void> {
    const nowMs = deps.clock();
    const lastTs = await lastRecordedTs(conditionId);
    let coveredUntil =
      lastTs === null ? nowMs - initialLookbackMs : lastTs.getTime();
    while (coveredUntil < nowMs) {
      const fetchStart = Math.max(0, coveredUntil - WINDOW_OVERLAP_MS);
      const fetchEnd = Math.min(coveredUntil + windowMs, nowMs);
      for (let offset = 0; ; offset += TRADES_PAGE_LIMIT) {
        if (offset > TRADES_MAX_OFFSET) {
          // The window overflowed the API's offset clamp: the remainder is
          // unreachable for this window; log it, record a data_api gap
          // covering [fetchStart, fetchEnd] (once per occurrence) and move on.
          logJson(
            "warn",
            "TRADES_WINDOW_OVERFLOW",
            "polymarket_trades_window_overflow",
            {
              condition_id: conditionId,
              window_start: fetchStart,
              window_end: fetchEnd,
            },
          );
          await recordOverflowGap(conditionId, fetchStart, fetchEnd, offset);
          break;
        }
        let rows: unknown[];
        try {
          rows = await fetchPage(conditionId, fetchStart, fetchEnd, offset);
        } catch (error: unknown) {
          logJson(
            "error",
            "TRADES_BACKFILL_FETCH_FAILED",
            "polymarket_trades_backfill_fetch_failed",
            {
              condition_id: conditionId,
              error_name: error instanceof Error ? error.name : "UnknownError",
            },
          );
          if (nowMs - coveredUntil > BEHIND_GAP_THRESHOLD_MS) {
            await recordBehindGap(conditionId, coveredUntil);
          }
          return;
        }
        for (const raw of rows) {
          const trade = parseDataApiTrade(raw);
          if (trade === null) {
            continue;
          }
          const dedupeKey = `${conditionId}:${trade.externalId}`;
          if (seen.has(dedupeKey)) {
            continue;
          }
          seen.add(dedupeKey);
          try {
            await insertTrade(trade);
          } catch (error: unknown) {
            logJson(
              "error",
              "TRADE_PERSIST_FAILED",
              "polymarket_trade_persist_failed",
              {
                condition_id: conditionId,
                external_id: trade.externalId,
                error_name:
                  error instanceof Error ? error.name : "UnknownError",
              },
            );
          }
        }
        if (rows.length < TRADES_PAGE_LIMIT) {
          break;
        }
      }
      coveredUntil = fetchEnd;
    }
  }

  return {
    async pollOnce(conditionIds: readonly string[]): Promise<void> {
      // Shared per-poll dedupe: overlapping windows re-fetch boundary trades.
      const seen = new Set<string>();
      for (const conditionId of conditionIds) {
        try {
          await backfillMarket(conditionId, seen);
        } catch (error: unknown) {
          logJson(
            "error",
            "TRADES_BACKFILL_MARKET_FAILED",
            "polymarket_trades_backfill_market_failed",
            {
              condition_id: conditionId,
              error_name: error instanceof Error ? error.name : "UnknownError",
            },
          );
        }
      }
    },
  };
}
