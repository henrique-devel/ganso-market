// RFC-011 Part A: feature loading and persistence. Every feature loader below
// carries an EXPLICIT upper time bound (<= or < windowEnd) — the anti-leakage
// test scans this file's SQL and fails if any loader loses its bound. Rows are
// persisted with ON CONFLICT DO NOTHING: recomputing a window from the same
// recorded data produces the same bytes, so the first write wins and replays
// are idempotent.
//
// Simulation scope only: this module reads the RFC-007 tables and writes to
// paper_feature_windows, nothing else.

import type { SqlExecutor } from "../../database.js";
import type { PriceLevel } from "../types.js";
import { divRound, formatScaled, parseScaled } from "../fundamental/fixed.js";
import {
  computeFeatureRow,
  type FeatureBook,
  type FeatureInputs,
  type FeatureRow,
  type WindowKind,
  type WindowTrade,
} from "./features.js";

export type QueryPool = { query: SqlExecutor["query"] };

/**
 * Feature loaders, named so the anti-leakage test can address each one. The
 * SQL string of every entry must contain a `$2`-bounded (or `$3`-bounded)
 * received/effective-time predicate; the test enforces it.
 */
export const FEATURE_LOADER_SQL = {
  latestBook:
    "SELECT token_id, bids_json, asks_json, source_ts, received_at " +
    "FROM polymarket_book_snapshots " +
    "WHERE token_id = $1 AND received_at <= $2 " +
    "ORDER BY received_at DESC LIMIT 1",
  tickSize:
    "SELECT tick_size FROM polymarket_param_versions " +
    "WHERE condition_id = $1 AND valid_from <= $2 " +
    "ORDER BY version DESC LIMIT 1",
  windowTrades:
    "SELECT price, size FROM polymarket_trades " +
    "WHERE token_id = $1 " +
    "AND COALESCE(trade_ts, received_at) >= $2 " +
    "AND COALESCE(trade_ts, received_at) < $3",
  lastTrade:
    "SELECT COALESCE(trade_ts, received_at) AS effective_ts " +
    "FROM polymarket_trades " +
    "WHERE token_id = $1 AND COALESCE(trade_ts, received_at) <= $2 " +
    "ORDER BY COALESCE(trade_ts, received_at) DESC LIMIT 1",
  deltaStats:
    "SELECT " +
    "COUNT(*) FILTER (WHERE size = '0') AS cancel_events, " +
    "COUNT(*) FILTER (WHERE size <> '0') AS update_events, " +
    "COUNT(DISTINCT (side, price)) AS levels_touched " +
    "FROM polymarket_book_deltas " +
    "WHERE token_id = $1 AND received_at >= $2 AND received_at < $3",
  midCloses:
    "SELECT mid_close FROM polymarket_series_1m " +
    "WHERE token_id = $1 " +
    "AND bucket_start >= $2 " +
    "AND bucket_start + interval '1 minute' <= $3 " +
    "ORDER BY bucket_start",
  snapshotMids:
    "SELECT bids_json, asks_json FROM polymarket_book_snapshots " +
    "WHERE token_id = $1 AND received_at >= $2 AND received_at < $3 " +
    "ORDER BY received_at",
  nextCatalyst:
    "SELECT MIN(scheduled_at) AS next_at FROM (" +
    "SELECT DISTINCT ON (source, event_key) scheduled_at " +
    "FROM polymarket_macro_calendar WHERE received_at <= $2 " +
    "ORDER BY source, event_key, version DESC" +
    ") latest WHERE scheduled_at > $1",
  ruleDates:
    "SELECT end_date, uma_end_date FROM polymarket_rule_versions " +
    "WHERE condition_id = $1 AND valid_from <= $2 " +
    "ORDER BY version DESC LIMIT 1",
} as const;

const INSERT_SQL =
  "INSERT INTO paper_feature_windows (" +
  "token_id, window_kind, window_start, window_end, source_ts, " +
  "book_valid, book_invalid_reason, best_bid, best_ask, mid, " +
  "spread_quoted, half_spread_bps, exec_spread_sref, microprice, thin_book, " +
  "bid_depth_top1, ask_depth_top1, bid_depth_top10, ask_depth_top10, " +
  "top_frac_bid, top_frac_ask, depth_ticks_json, " +
  "imbalance_top1, imbalance_top10, " +
  "trades_count, volume_unsigned, volume_signed, flow_direction_status, " +
  "cancel_events, update_events, levels_touched, " +
  "vol_1m, vol_5m, vol_30m, jump_count, " +
  "last_trade_age_ms, book_staleness_ms, " +
  "mins_to_catalyst, mins_to_end_date, mins_to_uma_end" +
  ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17," +
  "$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34," +
  "$35,$36,$37,$38,$39,$40) " +
  "ON CONFLICT (token_id, window_kind, window_start) DO NOTHING";

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function toCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return 0;
}

function parseLevels(value: unknown): PriceLevel[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const levels: PriceLevel[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.price === "string" && typeof record.size === "string") {
      levels.push({ price: record.price, size: record.size });
    }
  }
  return levels;
}

function midOf(
  bids: readonly PriceLevel[],
  asks: readonly PriceLevel[],
): string | null {
  const bid = parseScaled(bids[0]?.price ?? "");
  const ask = parseScaled(asks[0]?.price ?? "");
  if (bid === null || ask === null) {
    return null;
  }
  return formatScaled(divRound(bid + ask, 2n), 6);
}

/** Load every bounded input of one window; nothing after windowEnd. */
export async function loadFeatureInputs(
  pool: QueryPool,
  tokenId: string,
  conditionId: string | null,
  windowStart: Date,
  windowEnd: Date,
): Promise<FeatureInputs> {
  const bookRows = await pool.query(FEATURE_LOADER_SQL.latestBook, [
    tokenId,
    windowEnd,
  ]);
  const bookRow = bookRows.rows[0];
  const book: FeatureBook | null =
    bookRow === undefined
      ? null
      : {
          tokenId,
          bids: parseLevels(bookRow["bids_json"]),
          asks: parseLevels(bookRow["asks_json"]),
          sourceTs: toDate(bookRow["source_ts"]),
          observedAt: toDate(bookRow["received_at"]) ?? windowEnd,
        };

  let tickSize: string | null = null;
  let endDateAt: Date | null = null;
  let umaEndDateAt: Date | null = null;
  if (conditionId !== null) {
    const tickRows = await pool.query(FEATURE_LOADER_SQL.tickSize, [
      conditionId,
      windowEnd,
    ]);
    const tick = tickRows.rows[0]?.["tick_size"];
    tickSize = typeof tick === "string" ? tick : null;

    const ruleRows = await pool.query(FEATURE_LOADER_SQL.ruleDates, [
      conditionId,
      windowEnd,
    ]);
    endDateAt = toDate(ruleRows.rows[0]?.["end_date"]);
    umaEndDateAt = toDate(ruleRows.rows[0]?.["uma_end_date"]);
  }

  const tradeRows = await pool.query(FEATURE_LOADER_SQL.windowTrades, [
    tokenId,
    windowStart,
    windowEnd,
  ]);
  const trades: WindowTrade[] = tradeRows.rows.map((row) => ({
    price: typeof row["price"] === "string" ? row["price"] : "",
    size: typeof row["size"] === "string" ? row["size"] : null,
  }));

  const lastTradeRows = await pool.query(FEATURE_LOADER_SQL.lastTrade, [
    tokenId,
    windowEnd,
  ]);
  const lastTradeTs = toDate(lastTradeRows.rows[0]?.["effective_ts"]);

  const deltaRows = await pool.query(FEATURE_LOADER_SQL.deltaStats, [
    tokenId,
    windowStart,
    windowEnd,
  ]);
  const deltaRow = deltaRows.rows[0] ?? {};

  const lookbackStart = new Date(windowEnd.getTime() - 31 * 60_000);
  const closeRows = await pool.query(FEATURE_LOADER_SQL.midCloses, [
    tokenId,
    lookbackStart,
    windowEnd,
  ]);
  const midCloses1m = closeRows.rows
    .map((row) => row["mid_close"])
    .filter((value): value is string => typeof value === "string");

  const snapRows = await pool.query(FEATURE_LOADER_SQL.snapshotMids, [
    tokenId,
    windowStart,
    windowEnd,
  ]);
  const snapshotMids = snapRows.rows
    .map((row) =>
      midOf(parseLevels(row["bids_json"]), parseLevels(row["asks_json"])),
    )
    .filter((value): value is string => value !== null);

  const catalystRows = await pool.query(FEATURE_LOADER_SQL.nextCatalyst, [
    windowEnd,
    windowEnd,
  ]);
  const nextCatalystAt = toDate(catalystRows.rows[0]?.["next_at"]);

  return {
    windowStart,
    windowEnd,
    book,
    tickSize,
    trades,
    lastTradeTs,
    deltaStats: {
      cancelEvents: toCount(deltaRow["cancel_events"]),
      updateEvents: toCount(deltaRow["update_events"]),
      levelsTouched: toCount(deltaRow["levels_touched"]),
    },
    midCloses1m,
    snapshotMids,
    nextCatalystAt,
    endDateAt,
    umaEndDateAt,
  };
}

/** Persist one computed row; idempotent by (token, kind, window_start). */
export async function insertFeatureRow(
  pool: QueryPool,
  tokenId: string,
  kind: WindowKind,
  row: FeatureRow,
): Promise<void> {
  await pool.query(INSERT_SQL, [
    tokenId,
    kind,
    row.windowStart,
    row.windowEnd,
    row.sourceTs,
    row.bookValid,
    row.bookInvalidReason,
    row.bestBid,
    row.bestAsk,
    row.mid,
    row.spreadQuoted,
    row.halfSpreadBps,
    row.execSpreadSref,
    row.microprice,
    row.thinBook,
    row.bidDepthTop1,
    row.askDepthTop1,
    row.bidDepthTop10,
    row.askDepthTop10,
    row.topFracBid,
    row.topFracAsk,
    row.depthTicks === null ? null : JSON.stringify(row.depthTicks),
    row.imbalanceTop1,
    row.imbalanceTop10,
    row.tradesCount,
    row.volumeUnsigned,
    row.volumeSigned,
    row.flowDirectionStatus,
    row.cancelEvents,
    row.updateEvents,
    row.levelsTouched,
    row.vol1m,
    row.vol5m,
    row.vol30m,
    row.jumpCount,
    row.lastTradeAgeMs,
    row.bookStalenessMs,
    row.minsToCatalyst,
    row.minsToEndDate,
    row.minsToUmaEnd,
  ]);
}

/**
 * A 1s/10s window with no event inside it would duplicate the previous row;
 * only the 1m cadence persists quiet windows (the staleness record itself).
 */
export function shouldPersist(kind: WindowKind, row: FeatureRow): boolean {
  if (kind === "1m") {
    return true;
  }
  return (
    row.tradesCount > 0 ||
    row.cancelEvents > 0 ||
    row.updateEvents > 0 ||
    row.jumpCount > 0
  );
}

/** Compute and persist one window; returns whether a row was written. */
export async function computeAndStoreWindow(
  pool: QueryPool,
  tokenId: string,
  conditionId: string | null,
  kind: WindowKind,
  windowStart: Date,
  windowEnd: Date,
): Promise<boolean> {
  const inputs = await loadFeatureInputs(
    pool,
    tokenId,
    conditionId,
    windowStart,
    windowEnd,
  );
  const row = computeFeatureRow(inputs);
  if (!shouldPersist(kind, row)) {
    return false;
  }
  await insertFeatureRow(pool, tokenId, kind, row);
  return true;
}
