// RFC-011 task 7: the post-fill markout dataset (A10) and the empirical
// P(fill) calibration (A9), computed exclusively from what the recorder
// persisted. Labels only exist after the sample's life has entirely elapsed,
// so the calibration is walk-forward by construction — k-fold is impossible
// here, not merely avoided.

import type { SqlExecutor } from "../../database.js";
import type { PriceLevel } from "../types.js";
import {
  SCALE,
  div,
  divRound,
  formatScaled,
  mul,
  parseScaled,
} from "../fundamental/fixed.js";

export type QueryPool = { query: SqlExecutor["query"] };

export const MARKOUT_HORIZONS_S = [1, 10, 60, 300] as const;

/** A book older than this at the horizon instant yields a null markout. */
export const MARKOUT_MAX_BOOK_AGE_MS = 30_000;

/** P(fill) sampler: hypothetical order distances (ticks) and life. */
export const SAMPLE_DISTANCES_TICKS = [0, 1, 2, 5] as const;
export const SAMPLE_LIFE_S = 300;
export const MAX_SAMPLED_TOKENS_PER_TICK = 10;

/** Weekly cadence of the walk-forward calibration report. */
export const FILL_REPORT_PERIOD_MS = 7 * 24 * 60 * 60_000;

interface Deps {
  readonly clock?: () => Date;
  readonly logSink?: (line: string) => void;
}

function makeLog(
  sink: ((line: string) => void) | undefined,
): (
  level: "info" | "warn" | "error",
  code: string,
  extra?: Record<string, unknown>,
) => void {
  const write =
    sink ??
    ((line: string): void => {
      process.stderr.write(line);
    });
  return (level, code, extra = {}) => {
    write(
      `${JSON.stringify({
        level,
        service: "polymarket-paper",
        timestamp: new Date().toISOString(),
        reason_code: code,
        ...extra,
      })}\n`,
    );
  };
}

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

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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

interface BookRow {
  readonly bids: PriceLevel[];
  readonly asks: PriceLevel[];
  readonly sourceTs: Date | null;
  readonly receivedAt: Date;
}

async function bookAtOrBefore(
  pool: QueryPool,
  tokenId: string,
  at: Date,
): Promise<BookRow | null> {
  const result = await pool.query(
    "SELECT bids_json, asks_json, source_ts, received_at " +
      "FROM polymarket_book_snapshots " +
      "WHERE token_id = $1 AND received_at <= $2 " +
      "ORDER BY received_at DESC LIMIT 1",
    [tokenId, at],
  );
  const row = result.rows[0];
  const receivedAt = toDate(row?.["received_at"]);
  if (row === undefined || receivedAt === null) {
    return null;
  }
  return {
    bids: parseLevels(row["bids_json"]),
    asks: parseLevels(row["asks_json"]),
    sourceTs: toDate(row["source_ts"]),
    receivedAt,
  };
}

/** VWAP of walking `size` shares into `levels`; null when depth is short. */
export function walkVwap(
  levels: readonly PriceLevel[],
  sizeStr: string,
): string | null {
  const size = parseScaled(sizeStr);
  if (size === null || size <= 0n) {
    return null;
  }
  let remaining = size;
  let notional = 0n;
  for (const level of levels) {
    if (remaining <= 0n) {
      break;
    }
    const price = parseScaled(level.price);
    const levelSize = parseScaled(level.size);
    if (price === null || levelSize === null) {
      return null;
    }
    const take = levelSize < remaining ? levelSize : remaining;
    notional += mul(price, take);
    remaining -= take;
  }
  if (remaining > 0n) {
    return null;
  }
  return formatScaled(div(notional, size), 6);
}

/** Signed markout: (later - fill) for buys, (fill - later) for sells. */
export function signedMarkout(
  side: "BUY" | "SELL",
  fillPrice: string,
  laterPrice: string | null,
): string | null {
  const fill = parseScaled(fillPrice);
  const later = laterPrice === null ? null : parseScaled(laterPrice);
  if (fill === null || later === null) {
    return null;
  }
  return formatScaled(side === "BUY" ? later - fill : fill - later, 6);
}

/**
 * Compute the pending markouts of every fill whose 300 s horizon is already
 * in the past. Each (fill, horizon) row is inserted once (unique constraint);
 * a missing/stale book records an explicit null, never a retry loop.
 */
export async function markoutTick(
  pool: QueryPool,
  deps: Deps = {},
): Promise<void> {
  const log = makeLog(deps.logSink);
  const clock = deps.clock ?? ((): Date => new Date());
  const now = clock();
  const cutoff = new Date(now.getTime() - 300_000);
  const fills = await pool.query(
    "SELECT e.idempotency_key, e.order_id, e.token_id, e.payload_json, e.event_ts " +
      "FROM paper_ledger_events e " +
      "WHERE e.event_type = 'fill' AND e.event_ts <= $1 " +
      "AND NOT EXISTS (" +
      "SELECT 1 FROM paper_markouts m WHERE m.fill_key = e.idempotency_key AND m.horizon_s = 300" +
      ") ORDER BY e.event_ts LIMIT 50",
    [cutoff],
  );
  for (const row of fills.rows) {
    const fillKey = asString(row["idempotency_key"]);
    const tokenId = asString(row["token_id"]);
    const fillTs = toDate(row["event_ts"]);
    const payload =
      typeof row["payload_json"] === "object" && row["payload_json"] !== null
        ? (row["payload_json"] as Record<string, unknown>)
        : {};
    const side = payload["side"];
    const price = asString(payload["price"]);
    const size = asString(payload["size"]);
    if (
      fillKey === null ||
      tokenId === null ||
      fillTs === null ||
      (side !== "BUY" && side !== "SELL") ||
      price === null ||
      size === null
    ) {
      continue;
    }
    try {
      for (const horizon of MARKOUT_HORIZONS_S) {
        const at = new Date(fillTs.getTime() + horizon * 1_000);
        const book = await bookAtOrBefore(pool, tokenId, at);
        const reference = book?.sourceTs ?? book?.receivedAt ?? null;
        const fresh =
          book !== null &&
          reference !== null &&
          at.getTime() - reference.getTime() <= MARKOUT_MAX_BOOK_AGE_MS;
        let mid: string | null = null;
        let execBid: string | null = null;
        if (fresh && book !== null) {
          const bestBid = parseScaled(book.bids[0]?.price ?? "");
          const bestAsk = parseScaled(book.asks[0]?.price ?? "");
          if (bestBid !== null && bestAsk !== null) {
            mid = formatScaled(divRound(bestBid + bestAsk, 2n), 6);
          }
          // Executable exit reference: walk the fill size into the exit side.
          execBid = walkVwap(side === "BUY" ? book.bids : book.asks, size);
        }
        await pool.query(
          "INSERT INTO paper_markouts (fill_key, order_id, token_id, side, taker, " +
            "fill_price, fill_size, fill_ts, horizon_s, mid_markout, exec_bid_markout) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) " +
            "ON CONFLICT (fill_key, horizon_s) DO NOTHING",
          [
            fillKey,
            asString(row["order_id"]),
            tokenId,
            side,
            payload["taker"] === true,
            price,
            size,
            fillTs,
            horizon,
            signedMarkout(side, price, mid),
            signedMarkout(side, price, execBid),
          ],
        );
      }
    } catch (error: unknown) {
      log("error", "PAPER_MARKOUT_FAILED", {
        fill_key: fillKey,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}

/**
 * A9 sampler: for a few active tokens, place hypothetical passive orders at
 * 0/1/2/5 ticks from the touch, joining behind all visible depth, and record
 * the queue. The labeler decides later whether traded volume beat the queue.
 */
export async function fillSamplerTick(
  pool: QueryPool,
  deps: Deps = {},
): Promise<void> {
  const log = makeLog(deps.logSink);
  const clock = deps.clock ?? ((): Date => new Date());
  const now = clock();
  const tokens = await pool.query(
    "SELECT DISTINCT token_id FROM polymarket_book_snapshots " +
      "WHERE received_at > $1 ORDER BY token_id LIMIT $2",
    [new Date(now.getTime() - 60_000), MAX_SAMPLED_TOKENS_PER_TICK],
  );
  for (const row of tokens.rows) {
    const tokenId = asString(row["token_id"]);
    if (tokenId === null) {
      continue;
    }
    try {
      const book = await bookAtOrBefore(pool, tokenId, now);
      if (book === null || book.bids.length === 0 || book.asks.length === 0) {
        continue;
      }
      // Tick from the market registry's params would need the condition; the
      // touch spacing of the book itself is the sampler's grid unit instead:
      // conservative and self-consistent (samples carry the level price).
      const tickRow = await pool.query(
        "SELECT p.tick_size FROM polymarket_param_versions p " +
          "JOIN polymarket_markets m ON m.condition_id = p.condition_id " +
          "WHERE m.clob_token_ids @> to_jsonb($1::text) AND p.valid_from <= $2 " +
          "ORDER BY p.version DESC LIMIT 1",
        [tokenId, now],
      );
      const tick = parseScaled(asString(tickRow.rows[0]?.["tick_size"]) ?? "");
      if (tick === null || tick <= 0n) {
        continue;
      }
      for (const side of ["BUY", "SELL"] as const) {
        const touch = parseScaled(
          (side === "BUY" ? book.bids[0]?.price : book.asks[0]?.price) ?? "",
        );
        if (touch === null) {
          continue;
        }
        for (const distance of SAMPLE_DISTANCES_TICKS) {
          const level =
            side === "BUY"
              ? touch - tick * BigInt(distance)
              : touch + tick * BigInt(distance);
          if (level <= 0n || level >= SCALE) {
            continue;
          }
          const levelPrice = formatScaled(level, 6);
          let queue = 0n;
          const levels = side === "BUY" ? book.bids : book.asks;
          for (const bookLevel of levels) {
            const price = parseScaled(bookLevel.price);
            const size = parseScaled(bookLevel.size);
            if (price !== null && size !== null && price === level) {
              queue += size;
            }
          }
          await pool.query(
            "INSERT INTO paper_fill_samples (token_id, side, sampled_at, " +
              "distance_ticks, level_price, queue_ahead, life_s) " +
              "VALUES ($1,$2,$3,$4,$5,$6,$7) " +
              "ON CONFLICT (token_id, side, sampled_at, distance_ticks, life_s) DO NOTHING",
            [
              tokenId,
              side,
              now,
              distance,
              levelPrice,
              formatScaled(queue, 6),
              SAMPLE_LIFE_S,
            ],
          );
        }
      }
    } catch (error: unknown) {
      log("error", "PAPER_FILL_SAMPLER_FAILED", {
        token_id: tokenId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}

/** Label samples whose life has entirely elapsed: volume at level vs queue. */
export async function fillLabelerTick(
  pool: QueryPool,
  deps: Deps = {},
): Promise<void> {
  const log = makeLog(deps.logSink);
  const clock = deps.clock ?? ((): Date => new Date());
  const now = clock();
  const due = await pool.query(
    "SELECT sample_id, token_id, sampled_at, level_price, queue_ahead, life_s " +
      "FROM paper_fill_samples " +
      "WHERE filled IS NULL AND sampled_at + make_interval(secs => life_s) <= $1 " +
      "ORDER BY sampled_at LIMIT 200",
    [now],
  );
  for (const row of due.rows) {
    const tokenId = asString(row["token_id"]);
    const sampledAt = toDate(row["sampled_at"]);
    const levelPrice = asString(row["level_price"]);
    const queue = parseScaled(asString(row["queue_ahead"]) ?? "0") ?? 0n;
    const lifeRaw = row["life_s"];
    const lifeS =
      typeof lifeRaw === "number"
        ? lifeRaw
        : typeof lifeRaw === "string"
          ? Number(lifeRaw)
          : null;
    if (
      tokenId === null ||
      sampledAt === null ||
      levelPrice === null ||
      lifeS === null
    ) {
      continue;
    }
    try {
      const until = new Date(sampledAt.getTime() + lifeS * 1_000);
      const volumeRow = await pool.query(
        "SELECT COALESCE(SUM(size::numeric), 0)::text AS volume " +
          "FROM polymarket_trades " +
          "WHERE token_id = $1 AND size IS NOT NULL " +
          "AND price::numeric = $2::numeric " +
          "AND COALESCE(trade_ts, received_at) > $3 " +
          "AND COALESCE(trade_ts, received_at) <= $4",
        [tokenId, levelPrice, sampledAt, until],
      );
      const volume =
        parseScaled(asString(volumeRow.rows[0]?.["volume"]) ?? "0") ?? 0n;
      await pool.query(
        "UPDATE paper_fill_samples SET filled = $2, labeled_at = $3 WHERE sample_id = $1",
        [row["sample_id"], volume > queue, now],
      );
    } catch (error: unknown) {
      log("error", "PAPER_FILL_LABELER_FAILED", {
        token_id: tokenId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}

interface FillBucket {
  readonly distance_ticks: number;
  readonly life_s: number;
  readonly samples: number;
  readonly fills: number;
  readonly rate: string;
  readonly ci_low: string;
  readonly ci_high: string;
}

/** Wilson 95% interval; doubles internally, quantized on the way out. */
export function wilsonInterval(
  fills: number,
  samples: number,
): { rate: string; low: string; high: string } {
  if (samples <= 0) {
    return { rate: "0.000000", low: "0.000000", high: "0.000000" };
  }
  const z = 1.959964;
  const p = fills / samples;
  const denominator = 1 + (z * z) / samples;
  const center = (p + (z * z) / (2 * samples)) / denominator;
  const spread =
    (z *
      Math.sqrt((p * (1 - p)) / samples + (z * z) / (4 * samples * samples))) /
    denominator;
  const fmt = (value: number): string =>
    formatScaled(
      BigInt(Math.round(Math.max(0, Math.min(1, value)) * Number(SCALE))),
      6,
    );
  return {
    rate: fmt(p),
    low: fmt(center - spread),
    high: fmt(center + spread),
  };
}

/**
 * The weekly walk-forward calibration report: bucket frequencies with a
 * Wilson interval over every labeled sample, stamped with the exact window
 * the data covers. Due when the last report is older than the period.
 */
export async function fillReportIfDue(
  pool: QueryPool,
  deps: Deps = {},
): Promise<boolean> {
  const log = makeLog(deps.logSink);
  const clock = deps.clock ?? ((): Date => new Date());
  const now = clock();
  const last = await pool.query(
    "SELECT MAX(generated_at) AS last FROM paper_fill_reports",
  );
  const lastAt = toDate(last.rows[0]?.["last"]);
  if (
    lastAt !== null &&
    now.getTime() - lastAt.getTime() < FILL_REPORT_PERIOD_MS
  ) {
    return false;
  }
  const rows = await pool.query(
    "SELECT distance_ticks, life_s, " +
      "COUNT(*)::int AS samples, COUNT(*) FILTER (WHERE filled)::int AS fills, " +
      "MIN(sampled_at) AS data_from, MAX(sampled_at) AS data_to " +
      "FROM paper_fill_samples WHERE filled IS NOT NULL " +
      "GROUP BY distance_ticks, life_s ORDER BY distance_ticks, life_s",
  );
  const buckets: FillBucket[] = [];
  let total = 0;
  let dataFrom: Date | null = null;
  let dataTo: Date | null = null;
  for (const row of rows.rows) {
    const samples = Number(row["samples"] ?? 0);
    const fills = Number(row["fills"] ?? 0);
    total += samples;
    const from = toDate(row["data_from"]);
    const to = toDate(row["data_to"]);
    if (from !== null && (dataFrom === null || from < dataFrom)) {
      dataFrom = from;
    }
    if (to !== null && (dataTo === null || to > dataTo)) {
      dataTo = to;
    }
    const interval = wilsonInterval(fills, samples);
    buckets.push({
      distance_ticks: Number(row["distance_ticks"] ?? 0),
      life_s: Number(row["life_s"] ?? 0),
      samples,
      fills,
      rate: interval.rate,
      ci_low: interval.low,
      ci_high: interval.high,
    });
  }
  await pool.query(
    "INSERT INTO paper_fill_reports (generated_at, data_from, data_to, samples_total, buckets_json) " +
      "VALUES ($1,$2,$3,$4,$5)",
    [now, dataFrom, dataTo, total, JSON.stringify(buckets)],
  );
  log("info", "PAPER_FILL_REPORT_GENERATED", {
    samples_total: total,
    buckets: buckets.length,
  });
  return true;
}
