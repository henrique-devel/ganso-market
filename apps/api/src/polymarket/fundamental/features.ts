// RFC-010 feature layer. Every join here is AS-OF the decision instant:
//
//   - the normative as-of key is the datum's `source_ts` (the emitter clock);
//   - where the table also has `received_at` we additionally require
//     `received_at <= decision_ts`. That is strictly more conservative: a row
//     the venue stamped before the decision but that reached us afterwards was
//     not knowable at the decision, so it is excluded too;
//   - a one-minute aggregate bucket is only usable once the whole bucket lies
//     in the past (`bucket_start + 60s <= decision_ts`), otherwise the bucket
//     would carry post-decision ticks.
//
// Resolution data (`closedTime`, UMA status, `polymarket_resolution_events`)
// is NEVER a feature. An active UMA dispute is read here only as a VETO that
// forces the market baseline; it never enters q, and the anti-leakage test
// asserts that no resolution field reaches the feature vector.

import type { SqlExecutor } from "../../database.js";
import { OrderBook } from "../book.js";
import type { PriceLevel } from "../types.js";
import type { BookView, FundamentalCategory } from "./types.js";

export type QueryPool = { query: SqlExecutor["query"] };

/** Feature-set version; bump whenever a feature definition changes. */
export const FEATURE_SET_VERSION = "1.0.0";

const MINUTE_MS = 60_000;

export class LeakageError extends Error {
  public readonly feature: string;
  public readonly sourceTs: Date;
  public readonly decisionTs: Date;

  public constructor(feature: string, sourceTs: Date, decisionTs: Date) {
    super(`feature ${feature} carries source_ts after the decision instant`);
    this.name = "LeakageError";
    this.feature = feature;
    this.sourceTs = sourceTs;
    this.decisionTs = decisionTs;
  }
}

/**
 * Collects the source_ts of every datum that fed an estimate and refuses any
 * value stamped after the decision. Models must route every input through
 * `record`, which makes the anti-leakage test a property of the collector
 * rather than of each individual model.
 */
export class AsOfGuard {
  readonly #decisionTs: Date;
  readonly #entries: Array<{ name: string; sourceTs: Date | null }> = [];

  public constructor(decisionTs: Date) {
    this.#decisionTs = decisionTs;
  }

  /** Register one input; throws LeakageError when it postdates the decision. */
  public record<T>(name: string, sourceTs: Date | null, value: T): T {
    if (sourceTs !== null && sourceTs.getTime() > this.#decisionTs.getTime()) {
      throw new LeakageError(name, sourceTs, this.#decisionTs);
    }
    this.#entries.push({ name, sourceTs });
    return value;
  }

  public get decisionTs(): Date {
    return this.#decisionTs;
  }

  public entries(): ReadonlyArray<{ name: string; sourceTs: Date | null }> {
    return this.#entries;
  }

  /** Newest input timestamp seen, or null when nothing carried a source_ts. */
  public newestSourceTs(): Date | null {
    let newest: Date | null = null;
    for (const entry of this.#entries) {
      if (entry.sourceTs === null) {
        continue;
      }
      if (newest === null || entry.sourceTs.getTime() > newest.getTime()) {
        newest = entry.sourceTs;
      }
    }
    return newest;
  }
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function parseLevels(value: unknown): PriceLevel[] {
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

function parseStringArray(value: unknown): string[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * Raw recorded book of `tokenId` as it was knowable at `decisionTs`: the
 * newest full-depth anchor at or before the instant, plus every delta received
 * up to it, applied in delta_id order. `sourceTs` is the newest venue
 * timestamp among the applied inputs — the value staleness is measured on.
 */
export async function loadBookView(
  pool: QueryPool,
  tokenId: string,
  decisionTs: Date,
): Promise<BookView | null> {
  const anchors = await pool.query<{
    bids_json: unknown;
    asks_json: unknown;
    source_ts: unknown;
    received_at: unknown;
  }>(
    `SELECT bids_json, asks_json, source_ts, received_at
       FROM polymarket_book_snapshots_full
      WHERE token_id = $1 AND received_at <= $2
      ORDER BY received_at DESC, snapshot_id DESC
      LIMIT 1`,
    [tokenId, decisionTs],
  );
  const anchor = anchors.rows[0];
  if (anchor === undefined) {
    return null;
  }
  const anchorReceivedAt = toDate(anchor.received_at);
  if (anchorReceivedAt === null) {
    return null;
  }

  const book = new OrderBook();
  book.replace(parseLevels(anchor.bids_json), parseLevels(anchor.asks_json));

  const deltas = await pool.query<{
    side: "BUY" | "SELL";
    price: string;
    size: string;
    source_ts: unknown;
    received_at: unknown;
  }>(
    `SELECT side, price, size, source_ts, received_at
       FROM polymarket_book_deltas
      WHERE token_id = $1 AND received_at > $2 AND received_at <= $3
      ORDER BY delta_id ASC`,
    [tokenId, anchorReceivedAt, decisionTs],
  );

  let newestSourceTs = toDate(anchor.source_ts);
  let newestReceivedAt = anchorReceivedAt;
  for (const delta of deltas.rows) {
    book.applyPriceChange({
      asset_id: tokenId,
      side: delta.side,
      price: delta.price,
      size: delta.size,
    });
    const deltaSourceTs = toDate(delta.source_ts);
    if (
      deltaSourceTs !== null &&
      (newestSourceTs === null ||
        deltaSourceTs.getTime() > newestSourceTs.getTime())
    ) {
      newestSourceTs = deltaSourceTs;
    }
    const deltaReceivedAt = toDate(delta.received_at);
    if (
      deltaReceivedAt !== null &&
      deltaReceivedAt.getTime() > newestReceivedAt.getTime()
    ) {
      newestReceivedAt = deltaReceivedAt;
    }
  }

  return {
    tokenId,
    bids: book.topBids(10),
    asks: book.topAsks(10),
    sourceTs: newestSourceTs,
    observedAt: newestReceivedAt,
  };
}

export interface MarketContext {
  readonly conditionId: string;
  readonly question: string;
  readonly slug: string | null;
  readonly gammaCategory: string | null;
  readonly tokenIds: readonly string[];
  readonly endDate: Date | null;
  readonly rulesText: string | null;
  readonly resolutionSource: string | null;
  readonly ruleVersion: number | null;
  readonly ruleValidFrom: Date | null;
  readonly paramVersion: number | null;
  readonly tickSize: string | null;
  /** VETO input, never a feature: an open UMA dispute at the decision instant. */
  readonly umaDisputeActive: boolean;
  readonly ruleChangedRecently: boolean;
}

/**
 * Static and versioned market metadata as-of `decisionTs`, for a batch of
 * markets (one round trip per table instead of one per market).
 */
export async function loadMarketContexts(
  pool: QueryPool,
  conditionIds: readonly string[],
  decisionTs: Date,
  ruleChangeWindowMs: number,
): Promise<Map<string, MarketContext>> {
  const contexts = new Map<string, MarketContext>();
  if (conditionIds.length === 0) {
    return contexts;
  }
  const ids = [...conditionIds];

  // polymarket_markets is upserted in place, so it is read for IDENTITY only
  // (question, slug, category, outcome tokens) plus last-resort fallbacks. Every
  // field that can change over the life of a market — the rule text, the end
  // date, the tick — is taken from the versioned tables below, as-of the
  // decision. The `received_at` bound keeps a market that did not exist yet at
  // the decision instant out of the batch.
  const markets = await pool.query<Record<string, unknown>>(
    `SELECT condition_id, question, slug, category, clob_token_ids,
            end_date_iso, rules, tick_size
       FROM polymarket_markets
      WHERE condition_id = ANY($1::text[])
        AND received_at <= $2`,
    [ids, decisionTs],
  );

  const rules = await pool.query<Record<string, unknown>>(
    `SELECT DISTINCT ON (condition_id)
            condition_id, version, resolution_source, description, valid_from,
            end_date
       FROM polymarket_rule_versions
      WHERE condition_id = ANY($1::text[])
        AND valid_from <= $2
        AND (valid_to IS NULL OR valid_to > $2)
      ORDER BY condition_id, version DESC`,
    [ids, decisionTs],
  );
  const rulesById = new Map<string, Record<string, unknown>>();
  for (const row of rules.rows) {
    rulesById.set(String(row.condition_id), row);
  }

  const params = await pool.query<Record<string, unknown>>(
    `SELECT DISTINCT ON (condition_id) condition_id, version, tick_size
       FROM polymarket_param_versions
      WHERE condition_id = ANY($1::text[])
        AND valid_from <= $2
        AND (valid_to IS NULL OR valid_to > $2)
      ORDER BY condition_id, version DESC`,
    [ids, decisionTs],
  );
  const paramsById = new Map<string, Record<string, unknown>>();
  for (const row of params.rows) {
    paramsById.set(String(row.condition_id), row);
  }

  // Dispute veto: the latest UMA-relevant event at or before the decision is a
  // dispute that has not been superseded by a resolution.
  const disputes = await pool.query<Record<string, unknown>>(
    `SELECT DISTINCT ON (condition_id) condition_id, event_type
       FROM polymarket_resolution_events
      WHERE condition_id = ANY($1::text[])
        AND event_type IN ('disputed', 'resolved', 'market_resolved')
        AND COALESCE(source_ts, received_at) <= $2
        AND received_at <= $2
      ORDER BY condition_id, COALESCE(source_ts, received_at) DESC,
               resolution_event_id DESC`,
    [ids, decisionTs],
  );
  const disputedIds = new Set<string>();
  for (const row of disputes.rows) {
    if (row.event_type === "disputed") {
      disputedIds.add(String(row.condition_id));
    }
  }

  const recentRuleChanges = await pool.query<Record<string, unknown>>(
    `SELECT DISTINCT condition_id
       FROM polymarket_rule_versions
      WHERE condition_id = ANY($1::text[])
        AND version > 1
        AND valid_from <= $2
        AND valid_from > $3`,
    [ids, decisionTs, new Date(decisionTs.getTime() - ruleChangeWindowMs)],
  );
  const changedIds = new Set(
    recentRuleChanges.rows.map((row) => String(row.condition_id)),
  );

  for (const row of markets.rows) {
    const conditionId = String(row.condition_id);
    const rule = rulesById.get(conditionId);
    const param = paramsById.get(conditionId);
    contexts.set(conditionId, {
      conditionId,
      question: typeof row.question === "string" ? row.question : "",
      slug: typeof row.slug === "string" ? row.slug : null,
      gammaCategory: typeof row.category === "string" ? row.category : null,
      tokenIds: parseStringArray(row.clob_token_ids),
      // The versioned rule's end date wins: it is the value that was in force
      // at the decision instant.
      endDate: toDate(rule?.end_date) ?? toDate(row.end_date_iso),
      rulesText:
        typeof rule?.description === "string"
          ? rule.description
          : typeof row.rules === "string"
            ? row.rules
            : null,
      resolutionSource:
        typeof rule?.resolution_source === "string"
          ? rule.resolution_source
          : null,
      ruleVersion: rule?.version === undefined ? null : Number(rule.version),
      ruleValidFrom: toDate(rule?.valid_from),
      paramVersion: param?.version === undefined ? null : Number(param.version),
      tickSize:
        typeof param?.tick_size === "string"
          ? param.tick_size
          : typeof row.tick_size === "string"
            ? row.tick_size
            : null,
      umaDisputeActive: disputedIds.has(conditionId),
      ruleChangedRecently: changedIds.has(conditionId),
    });
  }
  return contexts;
}

export interface FeedSample {
  readonly feed: string;
  readonly symbol: string;
  readonly price: number;
  readonly sourceTs: Date | null;
  readonly ageMs: number;
  readonly stale: boolean;
}

/**
 * Newest resolving-feed sample per symbol as-of `decisionTs`. The Chainlink
 * TWAP is the feed that RESOLVES the crypto markets, so it is the primary
 * input: using it removes the basis risk of a spot feed (a documented ~0.12%
 * structural offset in ETH between Binance and Chainlink already produced one
 * false positive elsewhere).
 */
export async function loadFeedSamples(
  pool: QueryPool,
  symbols: readonly string[],
  decisionTs: Date,
  maxFeedAgeMs: number,
  feeds: readonly string[] = ["twap30", "twap60"],
): Promise<Map<string, FeedSample>> {
  const samples = new Map<string, FeedSample>();
  if (symbols.length === 0) {
    return samples;
  }
  const result = await pool.query<Record<string, unknown>>(
    `SELECT DISTINCT ON (symbol, feed) symbol, feed, price, source_ts, received_at
       FROM polymarket_rtds_prices
      WHERE symbol = ANY($1::text[])
        AND feed = ANY($2::text[])
        AND COALESCE(source_ts, received_at) <= $3
        AND received_at <= $3
      ORDER BY symbol, feed, COALESCE(source_ts, received_at) DESC,
               rtds_price_id DESC`,
    [[...symbols], [...feeds], decisionTs],
  );
  const bySymbol = new Map<string, Map<string, Record<string, unknown>>>();
  for (const row of result.rows) {
    const symbol = String(row.symbol);
    const perFeed = bySymbol.get(symbol) ?? new Map();
    perFeed.set(String(row.feed), row);
    bySymbol.set(symbol, perFeed);
  }

  for (const symbol of symbols) {
    const perFeed = bySymbol.get(symbol);
    if (perFeed === undefined) {
      continue;
    }
    // Feed preference is the caller's order: twap30 first, twap60 as backup.
    for (const feed of feeds) {
      const row = perFeed.get(feed);
      if (row === undefined) {
        continue;
      }
      const price = Number(row.price);
      if (!Number.isFinite(price) || price <= 0) {
        continue;
      }
      const sourceTs = toDate(row.source_ts) ?? toDate(row.received_at);
      const ageMs =
        sourceTs === null
          ? Number.POSITIVE_INFINITY
          : decisionTs.getTime() - sourceTs.getTime();
      samples.set(symbol, {
        feed,
        symbol,
        price,
        sourceTs,
        ageMs,
        stale: !(ageMs <= maxFeedAgeMs),
      });
      break;
    }
  }
  return samples;
}

export interface FeedSeries {
  readonly symbol: string;
  readonly feed: string;
  readonly closes: readonly number[];
  readonly firstBucket: Date | null;
  readonly lastBucket: Date | null;
}

/**
 * One-minute closes of the resolving feed, strictly before `decisionTs`. A
 * bucket is only included once it is entirely in the past: the bucket labelled
 * 10:00 covers [10:00, 10:01), so at 10:00:30 it would carry ticks the
 * decision could not have seen.
 */
export async function loadFeedSeries(
  pool: QueryPool,
  symbol: string,
  feed: string,
  decisionTs: Date,
  minutes: number,
): Promise<FeedSeries> {
  const lastComplete = new Date(
    Math.floor(decisionTs.getTime() / MINUTE_MS) * MINUTE_MS - MINUTE_MS,
  );
  const from = new Date(lastComplete.getTime() - minutes * MINUTE_MS);
  const result = await pool.query<Record<string, unknown>>(
    `SELECT bucket_start, close
       FROM polymarket_rtds_1m
      WHERE symbol = $1 AND feed = $2
        AND bucket_start >= $3 AND bucket_start <= $4
      ORDER BY bucket_start ASC`,
    [symbol, feed, from, lastComplete],
  );
  const closes: number[] = [];
  let firstBucket: Date | null = null;
  let lastBucket: Date | null = null;
  for (const row of result.rows) {
    const close = Number(row.close);
    if (!Number.isFinite(close) || close <= 0) {
      continue;
    }
    closes.push(close);
    const bucket = toDate(row.bucket_start);
    if (bucket !== null) {
      firstBucket ??= bucket;
      lastBucket = bucket;
    }
  }
  return { symbol, feed, closes, firstBucket, lastBucket };
}

export interface MacroCalendarContext {
  readonly source: string;
  readonly eventKey: string;
  readonly eventName: string;
  readonly scheduledAt: Date | null;
  readonly version: number;
  readonly payload: Record<string, unknown>;
  readonly sourceTs: Date | null;
}

export interface MacroReleaseContext {
  readonly source: string;
  readonly eventKey: string;
  readonly value: string | null;
  readonly publishedAt: Date | null;
  readonly sourceTs: Date | null;
  readonly payload: Record<string, unknown>;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/** Every calendar entry knowable at `decisionTs`, newest version per event. */
export async function loadMacroCalendar(
  pool: QueryPool,
  decisionTs: Date,
  maxCalendarAgeMs: number,
): Promise<MacroCalendarContext[]> {
  const from = new Date(decisionTs.getTime() - maxCalendarAgeMs);
  const result = await pool.query<Record<string, unknown>>(
    `SELECT DISTINCT ON (source, event_key)
            source, event_key, event_name, scheduled_at, version,
            payload_json, source_ts
       FROM polymarket_macro_calendar
      WHERE COALESCE(source_ts, received_at) <= $1
        AND received_at <= $1
        AND scheduled_at >= $2
      ORDER BY source, event_key, version DESC`,
    [decisionTs, from],
  );
  return result.rows.map((row) => ({
    source: String(row.source),
    eventKey: String(row.event_key),
    eventName: typeof row.event_name === "string" ? row.event_name : "",
    scheduledAt: toDate(row.scheduled_at),
    version: Number(row.version),
    payload: parseJsonObject(row.payload_json),
    sourceTs: toDate(row.source_ts),
  }));
}

/** Official release values already published at `decisionTs`. */
export async function loadMacroReleases(
  pool: QueryPool,
  decisionTs: Date,
): Promise<Map<string, MacroReleaseContext>> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT source, event_key, value, published_at, payload_json, source_ts
       FROM polymarket_macro_releases
      WHERE COALESCE(published_at, source_ts, received_at) <= $1
        AND received_at <= $1`,
    [decisionTs],
  );
  const releases = new Map<string, MacroReleaseContext>();
  for (const row of result.rows) {
    const key = `${String(row.source)}:${String(row.event_key)}`;
    releases.set(key, {
      source: String(row.source),
      eventKey: String(row.event_key),
      value: typeof row.value === "string" ? row.value : null,
      publishedAt: toDate(row.published_at),
      sourceTs: toDate(row.source_ts),
      payload: parseJsonObject(row.payload_json),
    });
  }
  return releases;
}

/**
 * Model category of a market, or null when no model owns it (the market then
 * lives permanently on the baseline). Gamma's own category is the outer
 * filter; the inner test is whether the category's model can parse the market.
 */
export function gammaCategoryToModelCategory(
  gammaCategory: string | null,
): FundamentalCategory | null {
  if (gammaCategory === "crypto") {
    return "crypto_updown";
  }
  if (gammaCategory === "macro") {
    return "macro_scheduled";
  }
  return null;
}
