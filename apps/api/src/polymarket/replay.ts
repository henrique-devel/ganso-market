// RFC-007 task 10: deterministic book replay. Reconstructs the order book of
// any token at any covered instant from the latest full snapshot anchor at or
// before `at` plus the append-only deltas up to `at`, in delta_id order.
// Read-only; prices/sizes remain canonical decimal strings.

import type { SqlExecutor } from "../database.js";
import { OrderBook } from "./book.js";
import type { PriceLevel } from "./types.js";

export interface ReplayedBook {
  bids: PriceLevel[];
  asks: PriceLevel[];
  anchorReceivedAt: string;
  deltasApplied: number;
}

export interface DeltaRow {
  readonly deltaId: number;
  readonly tokenId: string;
  readonly side: "BUY" | "SELL";
  readonly price: string;
  readonly size: string;
  readonly sourceTs: string | null;
  readonly receivedAt: string;
  readonly ingestLagMs: number | null;
}

export interface DeltasPage {
  readonly deltas: DeltaRow[];
  /** Cursor for the next page; null when this page was the last. */
  readonly nextAfterId: number | null;
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return "";
}

function toNullableIsoString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return toIsoString(value);
}

// jsonb columns arrive parsed from pg but as strings from some drivers/fakes;
// accept both and validate the level shape defensively.
function parseLevelsJson(value: unknown): PriceLevel[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const levels: PriceLevel[] = [];
  for (const item of parsed) {
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

/**
 * Book state of `tokenId` at instant `at`: latest full snapshot with
 * received_at <= at, plus every delta with received_at in
 * (anchor.received_at, at], applied in delta_id order. Returns null when no
 * anchor covers the instant. Duplicate deltas are naturally idempotent
 * (sizes are absolute) and size 0 removes the level.
 *
 * Border convention: `at` is INCLUSIVE here on purpose ("the book AT instant
 * at" includes a delta received exactly at `at`), while deltasPage uses a
 * half-open [from, to) window — see deltasPage's doc.
 */
export async function bookAt(
  pool: { query: SqlExecutor["query"] },
  tokenId: string,
  at: Date,
  depth = 10,
): Promise<{
  bids: PriceLevel[];
  asks: PriceLevel[];
  anchorReceivedAt: string;
  deltasApplied: number;
} | null> {
  const anchors = await pool.query<{
    snapshot_id: number | string;
    bids_json: unknown;
    asks_json: unknown;
    received_at: Date | string;
  }>(
    `SELECT snapshot_id, bids_json, asks_json, received_at
       FROM polymarket_book_snapshots_full
      WHERE token_id = $1 AND received_at <= $2
      ORDER BY received_at DESC, snapshot_id DESC
      LIMIT 1`,
    [tokenId, at],
  );
  const anchor = anchors.rows[0];
  if (anchor === undefined) {
    return null;
  }

  const book = new OrderBook();
  book.replace(
    parseLevelsJson(anchor.bids_json),
    parseLevelsJson(anchor.asks_json),
  );

  const deltas = await pool.query<{
    delta_id: number | string;
    side: "BUY" | "SELL";
    price: string;
    size: string;
  }>(
    `SELECT delta_id, side, price, size
       FROM polymarket_book_deltas
      WHERE token_id = $1 AND received_at > $2 AND received_at <= $3
      ORDER BY delta_id ASC`,
    [tokenId, anchor.received_at, at],
  );
  for (const delta of deltas.rows) {
    book.applyPriceChange({
      asset_id: tokenId,
      side: delta.side,
      price: delta.price,
      size: delta.size,
    });
  }

  return {
    bids: book.topBids(depth),
    asks: book.topAsks(depth),
    anchorReceivedAt: toIsoString(anchor.received_at),
    deltasApplied: deltas.rows.length,
  };
}

/**
 * One page of raw deltas for `tokenId` in the half-open window [from, to)
 * (`from` inclusive, `to` EXCLUSIVE), ordered by delta_id, keyset-paginated
 * with `afterId` (exclusive). `nextAfterId` is null when the page did not
 * fill, i.e. there is nothing further.
 *
 * Border convention: raw-delta pagination is half-open so consecutive windows
 * [a, b) + [b, c) tile without duplicates; bookAt deliberately keeps its
 * inclusive `received_at <= at` ("state AT instant at") — see bookAt's doc.
 */
export async function deltasPage(
  pool: { query: SqlExecutor["query"] },
  tokenId: string,
  from: Date,
  to: Date,
  afterId?: number,
  limit = 1000,
): Promise<DeltasPage> {
  const result = await pool.query<{
    delta_id: number | string;
    token_id: string;
    side: "BUY" | "SELL";
    price: string;
    size: string;
    source_ts: Date | string | null;
    received_at: Date | string;
    ingest_lag_ms: number | string | null;
  }>(
    `SELECT delta_id, token_id, side, price, size,
            source_ts, received_at, ingest_lag_ms
       FROM polymarket_book_deltas
      WHERE token_id = $1
        AND received_at >= $2 AND received_at < $3
        AND delta_id > $4
      ORDER BY delta_id ASC
      LIMIT $5`,
    [tokenId, from, to, afterId ?? 0, limit],
  );

  const deltas: DeltaRow[] = result.rows.map((row) => ({
    deltaId: Number(row.delta_id),
    tokenId: row.token_id,
    side: row.side,
    price: row.price,
    size: row.size,
    sourceTs: toNullableIsoString(row.source_ts),
    receivedAt: toIsoString(row.received_at),
    ingestLagMs: row.ingest_lag_ms === null ? null : Number(row.ingest_lag_ms),
  }));

  const last = deltas[deltas.length - 1];
  return {
    deltas,
    nextAfterId:
      deltas.length === limit && last !== undefined ? last.deltaId : null,
  };
}
