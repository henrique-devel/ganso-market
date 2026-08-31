import type { DatabasePool, SqlExecutor } from "../database.js";
import { parseExtendedMarket, type ExtendedMarketRecord } from "./gamma.js";
import {
  applyParamFields,
  applyRuleObservation,
  type RuleObservation,
} from "./versioning.js";

// RFC-007 task 1: Gamma registry poll, universe selection with hard
// exclusions/caps/priority, membership diff logged to
// polymarket_universe_log, and upserts into polymarket_markets /
// polymarket_events / polymarket_event_markets. Task 3 hourly fee re-poll
// lives here too (refreshParams). Public data only; no trading auth.

export const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
export const CLOB_BASE_URL = "https://clob.polymarket.com";

export const MAX_UNIVERSE_MARKETS = 100;
export const MAX_UNIVERSE_TOKENS = 200;

const PAGE_LIMIT = 100;
// Gamma keyset pagination is not documented well enough to rely on offline;
// we page /markets by volume with small offsets only (never deep offsets).
const MAX_PAGES = 5;

const MIN_RULES_LENGTH = 10;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * RFC-016: a market resolving within this window is "short horizon" — the two
 * finest estimator cadence buckets (`lt_1h` at 10 s and `1h_6h` at 60 s).
 */
export const SHORT_HORIZON_MS = 6 * 60 * 60 * 1_000;

/**
 * Slots of the 100-market cap held for short-horizon markets.
 *
 * OPPORTUNISTIC, never wasteful: if fewer than this many short markets are
 * eligible, the unused slots go straight back to the general queue. The
 * reserve exists so that the day the cap starts binding again (it last bound
 * on 2026-08-29) the fast universe is not the first thing evicted — the
 * failure mode the old unconditional priority 3 built in.
 *
 * Sized at a quarter of the cap: enough that a whole day of hourly updown
 * series fits, small enough that scheduled macro and the daily/weekly crypto
 * threshold markets keep three quarters of the universe.
 */
export const SHORT_HORIZON_RESERVED_MARKETS = 25;

const USER_AGENT = "GansoMarketRecorder/1.0 (+public-data-recorder)";

// Hard exclusions applied to question/slug regardless of tag classification.
const ELECTION_PATTERN = /\belection|\beleic|\belectoral/i;
const SPORTS_PATTERN =
  /\bvs\.?\s|\besports\b|\bnba\b|\bnfl\b|\bmlb\b|\bufc\b|premier league|\bgrand slam\b/i;
const MENTIONS_PATTERN = /\bmention/i;
const GEOPOLITICS_PATTERN =
  /\bceasefire\b|\binvasion\b|\binvade\b|\bairstrike\b|military strike|\bnato\b/i;
// Subjective resolution sources are a hard exclusion (43% of disputes come
// from wording; "media consensus" style criteria are unresolvable ex ante).
const SUBJECTIVE_SOURCE_PATTERN =
  /sole discretion|media consensus|consensus of credible|credible reporting|aesthetic|subjective/i;

// Short-series crypto markets (5min/15min/1h "up or down" style) are the
// lowest cap priority.
const SHORT_SERIES_PATTERN =
  /\b\d{1,2}\s?(?:min|m)\b|\b1\s?h(?:our)?\b|hourly|up or down|\d{1,2}\s?(?:am|pm)\b|:\d{2}\s?(?:am|pm)/i;

export type JsonFetcher = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export interface UniverseMember {
  readonly conditionId: string;
  readonly tokenIds: string[];
  readonly category: string;
}

export interface GammaCycleResult {
  readonly universe: UniverseMember[];
  readonly entered: string[];
  readonly exited: string[];
  /** True when the Gamma fetch failed completely: the previous universe must
   * be kept untouched by the caller (no resubscribe, no exits). */
  readonly fetchFailed: boolean;
}

export interface GammaCycleDeps {
  readonly pool: DatabasePool;
  readonly fetcher?: JsonFetcher;
  readonly now?: () => Date;
  readonly baseUrl?: string;
}

function log(
  level: "error" | "warn" | "info",
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

export function parseIsoDate(value: string | null): Date | null {
  if (value === null) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/** Reason a market is excluded from the universe, or null when eligible. */
export function exclusionReason(record: ExtendedMarketRecord): string | null {
  if (!record.active || record.closed || !record.enableOrderBook) {
    return "inactive_or_closed";
  }
  if (record.clobTokenIds.length < 2) {
    return "missing_outcome_tokens";
  }
  const haystack = `${record.question} ${record.slug ?? ""}`;
  if (ELECTION_PATTERN.test(haystack)) {
    return "election";
  }
  if (SPORTS_PATTERN.test(haystack)) {
    return "live_sports";
  }
  if (MENTIONS_PATTERN.test(haystack)) {
    return "mentions";
  }
  if (GEOPOLITICS_PATTERN.test(haystack)) {
    return "geopolitics";
  }
  if (record.rules === null || record.rules.length < MIN_RULES_LENGTH) {
    return "description_empty_or_short";
  }
  const sourceText = `${record.resolutionSource ?? ""} ${record.rules}`;
  if (SUBJECTIVE_SOURCE_PATTERN.test(sourceText)) {
    return "subjective_resolution_source";
  }
  if (record.category === null) {
    return "category_not_tracked";
  }
  if (record.category !== "crypto" && record.category !== "macro") {
    return "category_not_tracked";
  }
  return null;
}

/**
 * Milliseconds until the market's real end instant, or null when Gamma did not
 * publish one. Negative for a market already past its end.
 */
export function horizonMs(
  record: ExtendedMarketRecord,
  now: Date,
): number | null {
  const end = parseIsoDate(record.endDate);
  return end === null ? null : end.getTime() - now.getTime();
}

/** A market inside the reserved short-horizon window (RFC-016). */
export function isShortHorizon(
  record: ExtendedMarketRecord,
  now: Date,
): boolean {
  const horizon = horizonMs(record, now);
  return horizon !== null && horizon > 0 && horizon <= SHORT_HORIZON_MS;
}

/**
 * Horizon bucket label stamped on the `enter` row of the membership log. The
 * names match the estimator's cadence buckets so the two can be read together;
 * an unknown or elapsed horizon is named as such rather than folded into a
 * real bucket.
 */
export function horizonBucketLabel(
  record: ExtendedMarketRecord,
  now: Date,
): string {
  const horizon = horizonMs(record, now);
  if (horizon === null) {
    return "unknown";
  }
  if (horizon <= 0) {
    return "past";
  }
  if (horizon <= 60 * 60 * 1_000) {
    return "lt_1h";
  }
  if (horizon <= SHORT_HORIZON_MS) {
    return "1h_6h";
  }
  if (horizon <= 24 * 60 * 60 * 1_000) {
    return "6h_24h";
  }
  if (horizon <= 7 * 24 * 60 * 60 * 1_000) {
    return "1d_7d";
  }
  return "gt_7d";
}

/**
 * Cap priority (lower sorts first): 1 = scheduled macro with endDate within
 * 30 days, 2 = crypto daily/weekly threshold OR any crypto market resolving
 * within 6 h, 3 = crypto short series (5min/15min/1h) still far from its end,
 * 4 = remaining macro (no near catalyst).
 *
 * RFC-016 changed one line of this: a short-series market used to sit at 3
 * unconditionally, which made the 5min/15min/1h markets the FIRST thing the
 * cap dropped — the exact population the owner's 10 s cadence exists to price.
 * The pattern is a name test, not a clock: "Bitcoin Up or Down - August 31,
 * 6PM ET" matches it three weeks before it is worth anything. The horizon is
 * the clock, so a short series inside the reserved window rises to 2 and a
 * distant one stays at 3.
 */
export function capPriority(record: ExtendedMarketRecord, now: Date): number {
  if (record.category === "macro") {
    const end = parseIsoDate(record.endDate);
    if (end !== null && end.getTime() - now.getTime() <= THIRTY_DAYS_MS) {
      return 1;
    }
    return 4;
  }
  if (isShortHorizon(record, now)) {
    return 2;
  }
  const haystack = `${record.question} ${record.slug ?? ""}`;
  return SHORT_SERIES_PATTERN.test(haystack) ? 3 : 2;
}

export interface UniverseSelection {
  readonly selected: ExtendedMarketRecord[];
  readonly rejectedFilter: Array<{ conditionId: string; reason: string }>;
  readonly rejectedCap: Array<{ conditionId: string; reason: string }>;
}

/**
 * Apply hard exclusions, then the 100-market/200-token caps in priority
 * order (stable within a tier, preserving the fetch's volume ordering), with
 * a reserved block of slots for short-horizon markets (RFC-016).
 */
export function selectUniverse(
  records: readonly ExtendedMarketRecord[],
  now: Date,
  caps: {
    maxMarkets: number;
    maxTokens: number;
    reservedShortHorizon?: number;
  } = {
    maxMarkets: MAX_UNIVERSE_MARKETS,
    maxTokens: MAX_UNIVERSE_TOKENS,
  },
): UniverseSelection {
  const rejectedFilter: Array<{ conditionId: string; reason: string }> = [];
  const rejectedCap: Array<{ conditionId: string; reason: string }> = [];
  const seen = new Set<string>();
  const eligible: Array<{ record: ExtendedMarketRecord; index: number }> = [];

  for (const [index, record] of records.entries()) {
    if (seen.has(record.conditionId)) {
      continue;
    }
    seen.add(record.conditionId);
    const reason = exclusionReason(record);
    if (reason !== null) {
      rejectedFilter.push({ conditionId: record.conditionId, reason });
    } else {
      eligible.push({ record, index });
    }
  }

  eligible.sort((a, b) => {
    const priorityDiff =
      capPriority(a.record, now) - capPriority(b.record, now);
    return priorityDiff !== 0 ? priorityDiff : a.index - b.index;
  });

  // RFC-016: the reserved short-horizon block is filled FIRST, soonest-first
  // rather than by the fetch's volume ordering — inside six hours, "resolves
  // next" beats "traded most". Everything it does not take stays in the
  // general queue below, in its original priority order, so an unused reserve
  // costs nothing. A market can only be taken once (`taken`).
  const reserved = Math.max(
    0,
    caps.reservedShortHorizon ?? SHORT_HORIZON_RESERVED_MARKETS,
  );
  const shortQueue = eligible
    .filter((entry) => isShortHorizon(entry.record, now))
    .sort((a, b) => {
      const aEnd = horizonMs(a.record, now) ?? Number.POSITIVE_INFINITY;
      const bEnd = horizonMs(b.record, now) ?? Number.POSITIVE_INFINITY;
      return aEnd !== bEnd ? aEnd - bEnd : a.index - b.index;
    })
    .slice(0, Math.min(reserved, caps.maxMarkets));

  const selected: ExtendedMarketRecord[] = [];
  const taken = new Set<string>();
  let tokenCount = 0;
  // `recordRejection` is false for the reserved pass: a short market the
  // reserve could not fit is retried in the general pass below and rejected
  // there, once. Recording it twice would put the same condition_id in
  // rejectedCap two times over.
  const admit = (
    record: ExtendedMarketRecord,
    recordRejection: boolean,
  ): void => {
    const tokens = record.clobTokenIds.length;
    if (selected.length >= caps.maxMarkets) {
      if (recordRejection) {
        rejectedCap.push({
          conditionId: record.conditionId,
          reason: "cap_markets_exceeded",
        });
      }
      return;
    }
    if (tokenCount + tokens > caps.maxTokens) {
      if (recordRejection) {
        rejectedCap.push({
          conditionId: record.conditionId,
          reason: "cap_tokens_exceeded",
        });
      }
      return;
    }
    selected.push(record);
    taken.add(record.conditionId);
    tokenCount += tokens;
  };

  for (const { record } of shortQueue) {
    admit(record, false);
  }
  for (const { record } of eligible) {
    if (taken.has(record.conditionId)) {
      continue;
    }
    admit(record, true);
  }

  return { selected, rejectedFilter, rejectedCap };
}

interface FetchOutcome {
  readonly records: ExtendedMarketRecord[];
  readonly unparsedCount: number;
  readonly failed: boolean;
}

async function fetchGammaPages(
  fetcher: JsonFetcher,
  baseUrl: string,
): Promise<FetchOutcome> {
  const records: ExtendedMarketRecord[] = [];
  let unparsedCount = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url =
      `${baseUrl}/markets?closed=false&active=true` +
      `&order=volume24hr&ascending=false&limit=${PAGE_LIMIT}` +
      `&offset=${page * PAGE_LIMIT}&include_tag=true`;
    let rows: unknown[];
    try {
      const response = await fetcher(url, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
      });
      if (!response.ok) {
        return { records, unparsedCount, failed: true };
      }
      const body = (await response.json()) as unknown;
      rows = Array.isArray(body) ? body : [];
    } catch {
      return { records, unparsedCount, failed: true };
    }
    for (const row of rows) {
      const record = parseExtendedMarket(row);
      if (record === null) {
        unparsedCount += 1;
      } else {
        records.push(record);
      }
    }
    if (rows.length < PAGE_LIMIT) {
      break;
    }
  }
  return { records, unparsedCount, failed: false };
}

interface UniverseLogState {
  readonly action: string;
  readonly reason: string;
}

// Latest logged action per condition_id; "enter" as the latest action means
// the market is currently in the universe.
async function latestUniverseActions(
  db: SqlExecutor,
): Promise<Map<string, UniverseLogState>> {
  const result = await db.query<{
    condition_id: string;
    action: string;
    reason: string;
  }>(
    `SELECT DISTINCT ON (condition_id) condition_id, action, reason
       FROM polymarket_universe_log
      ORDER BY condition_id, at DESC, universe_log_id DESC`,
  );
  const map = new Map<string, UniverseLogState>();
  for (const row of result.rows) {
    map.set(row.condition_id, { action: row.action, reason: row.reason });
  }
  return map;
}

async function insertUniverseLog(
  db: SqlExecutor,
  conditionId: string,
  action: "enter" | "exit" | "rejected_cap" | "rejected_filter",
  reason: string,
  at: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO polymarket_universe_log (condition_id, action, reason, at)
     VALUES ($1,$2,$3,$4)`,
    [conditionId, action, reason, at],
  );
}

async function insertDataGap(
  db: SqlExecutor,
  source: string,
  tokenId: string | null,
  cause: string,
  at: Date,
  details: Record<string, unknown> | null,
): Promise<void> {
  await db.query(
    `INSERT INTO polymarket_data_gaps
       (source, token_id, gap_start, gap_end, cause, details_json, received_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [
      source,
      tokenId,
      at,
      at,
      cause,
      details === null ? null : JSON.stringify(details),
      at,
    ],
  );
}

interface OpenMetadataVersion {
  readonly version: number;
  readonly question: string;
  readonly category: string | null;
  readonly clob_token_ids: unknown;
  readonly affirmative_token_id: string | null;
  readonly valid_from: Date;
}

function metadataTokenIds(value: unknown): string[] | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((token): token is string => typeof token === "string")
  ) {
    return null;
  }
  return parsed;
}

function metadataMatches(
  open: OpenMetadataVersion,
  record: MarketMetadataObservation,
  category: string | null,
): boolean {
  const previousTokens = metadataTokenIds(open.clob_token_ids);
  return (
    open.question === record.question &&
    open.category === category &&
    previousTokens !== null &&
    previousTokens.length === record.clobTokenIds.length &&
    previousTokens.every(
      (token, index) => token === record.clobTokenIds[index],
    ) &&
    open.affirmative_token_id === record.affirmativeTokenId
  );
}

/**
 * The category to record: a null observation NEVER erases a known one.
 *
 * `classifyCategory` returns null for two situations a caller cannot tell
 * apart — "this market belongs to no tracked category" and "this payload did
 * not carry what the classifier needs". The second is a property of the
 * REQUEST, not of the market: a Gamma response without the tag array demotes
 * every market to the keyword fallback, and the fallback names only a handful
 * of tickers. Writing that null closes a `crypto`/`macro` window and opens an
 * uncategorized one, which the RFC-012 report then buckets as `unknown` and
 * the G5 regime query drops entirely.
 *
 * So null means "not observed" and the open window's category carries forward.
 * A market that genuinely leaves a category leaves the universe instead, and
 * that is recorded in `polymarket_universe_log` — not by erasing history.
 */
function categoryToRecord(
  open: OpenMetadataVersion | undefined,
  observed: string | null,
): string | null {
  return observed ?? open?.category ?? null;
}

export interface MarketMetadataObservation {
  readonly conditionId: string;
  readonly question: string;
  readonly category: string | null;
  readonly clobTokenIds: readonly string[];
  readonly affirmativeTokenId: string | null;
  readonly sourceTs: Date | null;
}

/**
 * Record one prospective metadata observation after the mutable registry row
 * has been upserted in the same transaction. Locking the source row before the
 * transaction-scoped advisory lock matches the database compatibility trigger;
 * direct comparison makes identical polls idempotent.
 */
export async function applyMarketMetadataObservation(
  db: SqlExecutor,
  record: MarketMetadataObservation,
  observedAt: Date,
): Promise<void> {
  await db.query(
    `SELECT condition_id
       FROM polymarket_markets
      WHERE condition_id = $1
      FOR UPDATE`,
    [record.conditionId],
  );
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    record.conditionId,
  ]);
  const current = await db.query<OpenMetadataVersion>(
    `SELECT version, question, category, clob_token_ids,
            affirmative_token_id, valid_from
       FROM polymarket_market_metadata_versions
      WHERE condition_id = $1 AND valid_to IS NULL
      ORDER BY version DESC
      LIMIT 1
      FOR UPDATE`,
    [record.conditionId],
  );
  const open = current.rows[0];
  const category = categoryToRecord(open, record.category);
  if (open !== undefined && metadataMatches(open, record, category)) {
    return;
  }

  let version = 1;
  if (open !== undefined) {
    if (observedAt.getTime() <= open.valid_from.getTime()) {
      throw new Error("MARKET_METADATA_OBSERVATION_TIME_NOT_MONOTONIC");
    }
    version = open.version + 1;
    await db.query(
      `UPDATE polymarket_market_metadata_versions
          SET valid_to = $2
        WHERE condition_id = $1 AND valid_to IS NULL`,
      [record.conditionId, observedAt],
    );
  } else {
    const maximum = await db.query<{ max_version: number | string | null }>(
      `SELECT COALESCE(MAX(version), 0) AS max_version
         FROM polymarket_market_metadata_versions
        WHERE condition_id = $1`,
      [record.conditionId],
    );
    const maxVersion = Number(maximum.rows[0]?.max_version ?? 0);
    version = (Number.isFinite(maxVersion) ? maxVersion : 0) + 1;
  }

  await db.query(
    `INSERT INTO polymarket_market_metadata_versions
       (condition_id, version, question, category, clob_token_ids,
        affirmative_token_id, valid_from, source_ts, received_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$7)`,
    [
      record.conditionId,
      version,
      record.question,
      category,
      JSON.stringify(record.clobTokenIds),
      record.affirmativeTokenId,
      observedAt,
      record.sourceTs,
    ],
  );
}

/**
 * RFC-016: record the market's real end INSTANT on the flat registry row, from
 * a call site that does not own the rest of the row.
 *
 * The registry cycle writes `end_ts` inside its full upsert, but it only ever
 * observes markets that are currently IN the universe. The pending sweep in
 * `samplers.ts` is the only path that re-observes the ones that left — and it
 * fetches with `closed=true`, a query the registry never makes. That asymmetry
 * between the two Gamma call sites is exactly what caused the category bug of
 * PR #49, so both of them capture the instant.
 *
 * Deliberately narrow: this touches `end_ts` and nothing else. Writing the
 * whole registry row from the sweep would import the rest of the upsert's
 * semantics (rules_version bumping, category, token ids) into a path that was
 * never designed to own them.
 *
 * A payload without `endDate` leaves the known value standing. Null means "not
 * observed", never "this market has no end" — the same rule
 * `categoryToRecord` applies to categories, and the reason the UPDATE is
 * guarded rather than unconditional. A market absent from the registry is a
 * no-op, not an insert: this function records a fact about a row, it does not
 * create one.
 */
export async function applyMarketEndTsObservation(
  db: SqlExecutor,
  conditionId: string,
  endTs: Date | null,
  now: Date,
): Promise<void> {
  if (endTs === null) {
    return;
  }
  await db.query(
    `UPDATE polymarket_markets
        SET end_ts = $2, updated_at = $3
      WHERE condition_id = $1
        AND (end_ts IS NULL OR end_ts IS DISTINCT FROM $2)`,
    [conditionId, endTs, now],
  );
}

// Same registry upsert the recorder used, adapted to the extended record and
// carrying source_ts (Gamma updatedAt). The orchestrator migrates to this one.
async function upsertMarket(
  db: SqlExecutor,
  record: ExtendedMarketRecord,
  now: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO polymarket_markets
       (condition_id, question, slug, category, neg_risk, clob_token_ids,
        affirmative_token_id, rules, tick_size, min_order_size,
        rewards_min_size, rewards_max_spread, fee_type, end_date_iso, end_ts,
        active, closed, question_id, source_ts, received_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20)
     ON CONFLICT (condition_id) DO UPDATE SET
       question = EXCLUDED.question,
       slug = EXCLUDED.slug,
       category = EXCLUDED.category,
       neg_risk = EXCLUDED.neg_risk,
       clob_token_ids = EXCLUDED.clob_token_ids,
       affirmative_token_id = EXCLUDED.affirmative_token_id,
       rules = EXCLUDED.rules,
       rules_version = polymarket_markets.rules_version
         + CASE WHEN polymarket_markets.rules IS DISTINCT FROM EXCLUDED.rules THEN 1 ELSE 0 END,
       tick_size = EXCLUDED.tick_size,
       min_order_size = EXCLUDED.min_order_size,
       rewards_min_size = EXCLUDED.rewards_min_size,
       rewards_max_spread = EXCLUDED.rewards_max_spread,
       fee_type = EXCLUDED.fee_type,
       end_date_iso = EXCLUDED.end_date_iso,
       -- RFC-016: a payload without endDate means "not observed", never "this
       -- market has no end". COALESCE keeps the known instant standing, the
       -- same reason categoryToRecord never erases a known category.
       end_ts = COALESCE(EXCLUDED.end_ts, polymarket_markets.end_ts),
       active = EXCLUDED.active,
       closed = EXCLUDED.closed,
       question_id = COALESCE(EXCLUDED.question_id, polymarket_markets.question_id),
       source_ts = EXCLUDED.source_ts,
       updated_at = EXCLUDED.updated_at`,
    [
      record.conditionId,
      record.question,
      record.slug,
      record.category,
      record.negRisk,
      JSON.stringify(record.clobTokenIds),
      record.affirmativeTokenId,
      record.rules,
      record.tickSize,
      record.minOrderSize,
      record.rewardsMinSize,
      record.rewardsMaxSpread,
      record.feeType,
      record.endDateIso ?? record.endDate,
      // The SAME value that feeds the versioned rule below
      // (ruleObservationFrom), so the flat column and the as-of chain cannot
      // disagree at the source.
      parseIsoDate(record.endDate),
      record.active,
      record.closed,
      record.questionId,
      parseIsoDate(record.updatedAt),
      now,
    ],
  );
}

async function upsertEvents(
  db: SqlExecutor,
  record: ExtendedMarketRecord,
  now: Date,
): Promise<void> {
  for (const event of record.events) {
    if (event.title === null && event.slug === null) {
      continue;
    }
    await db.query(
      `INSERT INTO polymarket_events
         (event_id, slug, title, neg_risk, tags_json, source_ts, received_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
       ON CONFLICT (event_id) DO UPDATE SET
         slug = EXCLUDED.slug,
         title = EXCLUDED.title,
         neg_risk = EXCLUDED.neg_risk,
         tags_json = EXCLUDED.tags_json,
         source_ts = EXCLUDED.source_ts,
         received_at = EXCLUDED.received_at`,
      [
        event.eventId,
        event.slug,
        event.title ?? event.slug ?? event.eventId,
        event.negRisk,
        JSON.stringify(record.tagSlugs),
        parseIsoDate(record.updatedAt),
        now,
      ],
    );
    await db.query(
      `INSERT INTO polymarket_event_markets (event_id, condition_id, received_at)
       VALUES ($1,$2,$3)
       ON CONFLICT (event_id, condition_id) DO NOTHING`,
      [event.eventId, record.conditionId, now],
    );
  }
}

function ruleObservationFrom(record: ExtendedMarketRecord): RuleObservation {
  return {
    conditionId: record.conditionId,
    // exclusionReason guarantees rules is a non-empty string for members.
    description: record.rules ?? "",
    resolutionSource: record.resolutionSource,
    resolvedBy: record.resolvedBy,
    endDate: parseIsoDate(record.endDate),
    umaEndDate: parseIsoDate(record.umaEndDate),
    umaBond: record.umaBond,
    umaReward: record.umaReward,
    customLiveness: record.customLiveness,
    automaticallyResolved: record.automaticallyResolved,
    sourceTs: parseIsoDate(record.updatedAt),
  };
}

/**
 * One Gamma registry cycle (RFC-007 tasks 1–3, every 10 min): fetch and parse
 * the catalog, select the universe (hard exclusions + caps + priority), log
 * membership transitions, upsert markets/events, and version rules and
 * parameters for every member. Persistence failures are logged and skipped —
 * they never propagate (crash-loop regression, commit 350d3c9).
 */
export async function runGammaCycle(
  deps: GammaCycleDeps,
): Promise<GammaCycleResult> {
  const now = deps.now ?? ((): Date => new Date());
  const fetcher = deps.fetcher ?? (fetch as JsonFetcher);
  const baseUrl = deps.baseUrl ?? GAMMA_BASE_URL;
  const pool = deps.pool;

  const outcome = await fetchGammaPages(fetcher, baseUrl);
  if (outcome.failed && outcome.records.length === 0) {
    // Nothing fetched: log a gap and keep the previous universe untouched
    // (an empty fetch must not mass-exit every market).
    log("error", "GAMMA_FETCH_FAILED", "polymarket_gamma_fetch_failed");
    try {
      await insertDataGap(pool, "gamma", null, "gamma_fetch_failed", now(), {
        base_url: baseUrl,
      });
    } catch {
      log("error", "GAP_PERSIST_FAILED", "polymarket_gap_persist_failed");
    }
    return { universe: [], entered: [], exited: [], fetchFailed: true };
  }
  if (outcome.failed) {
    log("warn", "GAMMA_FETCH_PARTIAL", "polymarket_gamma_fetch_partial", {
      records: outcome.records.length,
    });
  }
  if (outcome.unparsedCount > 0) {
    log("warn", "GAMMA_PARSE_SKIPPED", "polymarket_gamma_rows_unparsed", {
      count: outcome.unparsedCount,
    });
  }

  const selection = selectUniverse(outcome.records, now());
  const selectedIds = new Set(
    selection.selected.map((record) => record.conditionId),
  );

  let previous = new Map<string, UniverseLogState>();
  try {
    previous = await latestUniverseActions(pool);
  } catch {
    log("error", "UNIVERSE_QUERY_FAILED", "polymarket_universe_query_failed");
  }
  const previousMembers = new Set<string>();
  for (const [conditionId, state] of previous) {
    if (state.action === "enter") {
      previousMembers.add(conditionId);
    }
  }

  const entered: string[] = [];
  const exited: string[] = [];
  const rejectionByCondition = new Map<
    string,
    { action: "rejected_filter" | "rejected_cap"; reason: string }
  >();
  for (const rejection of selection.rejectedFilter) {
    rejectionByCondition.set(rejection.conditionId, {
      action: "rejected_filter",
      reason: rejection.reason,
    });
  }
  for (const rejection of selection.rejectedCap) {
    rejectionByCondition.set(rejection.conditionId, {
      action: "rejected_cap",
      reason: rejection.reason,
    });
  }

  const logSafely = async (
    conditionId: string,
    action: "enter" | "exit" | "rejected_cap" | "rejected_filter",
    reason: string,
  ): Promise<void> => {
    try {
      await insertUniverseLog(pool, conditionId, action, reason, now());
    } catch {
      log("error", "UNIVERSE_LOG_FAILED", "polymarket_universe_log_failed", {
        condition_id: conditionId,
        action,
      });
    }
  };

  // Entries are NOT logged here. The `enter` row is what puts a market inside
  // the RFC-012 scoring scope, and migration 0011 publishes it to the
  // resolution input journal the instant it commits — so logging it before the
  // market's first metadata version exists opens a window in which the score
  // sees a member it cannot map (RESOLUTION_MARKET_METADATA_VERSION_MISSING,
  // measured in production on 2026-08-31: the error fired 0,41 s after the
  // `enter` row and 0,43 s BEFORE the first metadata version). The insert
  // moved into the per-market persist transaction below, next to
  // applyMarketMetadataObservation, so membership and mapping become visible
  // in the same commit.
  // Exits and rejection transitions are skipped on a PARTIAL fetch failure:
  // an unseen market may simply live in a page that failed, and a mass exit
  // would silently stop collection for it.
  if (!outcome.failed) {
    // Exits: previous members no longer selected; carry the rejection reason.
    for (const conditionId of previousMembers) {
      if (!selectedIds.has(conditionId)) {
        exited.push(conditionId);
        const rejection = rejectionByCondition.get(conditionId);
        await logSafely(
          conditionId,
          "exit",
          rejection === undefined
            ? "not_selected"
            : `${rejection.action}:${rejection.reason}`,
        );
      }
    }
    // Rejection transitions for non-members (a repeated identical rejection is
    // not re-logged; the log records state changes, not every cycle).
    for (const [conditionId, rejection] of rejectionByCondition) {
      if (previousMembers.has(conditionId)) {
        continue; // Already logged as exit above.
      }
      const last = previous.get(conditionId);
      if (
        last !== undefined &&
        last.action === rejection.action &&
        last.reason === rejection.reason
      ) {
        continue;
      }
      await logSafely(conditionId, rejection.action, rejection.reason);
    }
  }

  // Persist registry rows and versioned rules/params per member, and log the
  // membership entry of a new member in the SAME transaction as its metadata
  // observation. A failure on one market is logged and never aborts the cycle:
  // an entrant whose metadata could not be written is simply not logged as a
  // member this cycle and is retried in the next one — never a member without
  // an as-of mapping.
  const universe: UniverseMember[] = [];
  for (const record of selection.selected) {
    universe.push({
      conditionId: record.conditionId,
      tokenIds: [...record.clobTokenIds],
      category: record.category ?? "unknown",
    });
    const entering = !previousMembers.has(record.conditionId);
    try {
      const observedAt = now();
      await pool.transaction(async (tx) => {
        await upsertMarket(tx, record, observedAt);
        await applyMarketMetadataObservation(
          tx,
          {
            conditionId: record.conditionId,
            question: record.question,
            category: record.category,
            clobTokenIds: record.clobTokenIds,
            affirmativeTokenId: record.affirmativeTokenId,
            sourceTs: parseIsoDate(record.updatedAt),
          },
          observedAt,
        );
        if (entering) {
          // Same instant as the metadata version's valid_from: an as-of read
          // that sees the membership always sees the mapping too.
          await insertUniverseLog(
            tx,
            record.conditionId,
            "enter",
            // RFC-016 appends the horizon bucket, so "how much of the turnover
            // is the fast universe" is answerable from the membership log
            // alone — no join against a rule chain that has moved on by the
            // time anyone asks.
            `priority_${String(capPriority(record, observedAt))}_${record.category ?? "unknown"}_${horizonBucketLabel(record, observedAt)}`,
            observedAt,
          );
        }
      });
      if (entering) {
        entered.push(record.conditionId);
      }
      await upsertEvents(pool, record, observedAt);
      await applyRuleObservation(pool, ruleObservationFrom(record), observedAt);
      await applyParamFields(
        pool,
        record.conditionId,
        {
          tickSize: record.tickSize,
          minOrderSize: record.minOrderSize,
          negRisk: record.negRisk,
        },
        observedAt,
        parseIsoDate(record.updatedAt),
      );
    } catch (error: unknown) {
      log(
        "error",
        "REGISTRY_PERSIST_FAILED",
        "polymarket_registry_persist_failed",
        {
          condition_id: record.conditionId,
          error_name: error instanceof Error ? error.name : "UnknownError",
        },
      );
    }
  }

  // On a partial fetch, previous members missing from this cycle keep their
  // membership: recover their token ids from the registry so subscriptions
  // are not dropped.
  if (outcome.failed) {
    const present = new Set(universe.map((member) => member.conditionId));
    for (const conditionId of previousMembers) {
      if (present.has(conditionId)) {
        continue;
      }
      try {
        const row = await pool.query<{
          clob_token_ids: unknown;
          category: string | null;
        }>(
          `SELECT clob_token_ids, category FROM polymarket_markets
            WHERE condition_id = $1`,
          [conditionId],
        );
        const first = row.rows[0];
        const tokenIds = Array.isArray(first?.clob_token_ids)
          ? (first.clob_token_ids as unknown[]).filter(
              (value): value is string => typeof value === "string",
            )
          : [];
        if (tokenIds.length > 0) {
          universe.push({
            conditionId,
            tokenIds,
            category: first?.category ?? "unknown",
          });
        }
      } catch {
        log(
          "error",
          "UNIVERSE_QUERY_FAILED",
          "polymarket_universe_member_recover_failed",
          { condition_id: conditionId },
        );
      }
    }
  }

  return { universe, entered, exited, fetchFailed: false };
}

export interface RefreshParamsDeps {
  readonly pool: DatabasePool;
  readonly fetcher?: JsonFetcher;
  readonly now?: () => Date;
  readonly clobBaseUrl?: string;
}

function asBpsString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

// The /fee-rate response shape is tolerated loosely: any of the known field
// spellings is accepted; an unknown shape yields no update (logged).
function parseFeeRateBody(body: unknown): {
  feeBaseBps: string | null;
  makerFeeBps: string | null;
  takerFeeBps: string | null;
} | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const feeBaseBps =
    asBpsString(record.fee_rate_bps) ??
    asBpsString(record.feeRateBps) ??
    asBpsString(record.base_fee_rate_bps) ??
    asBpsString(record.base_fee);
  const makerFeeBps =
    asBpsString(record.maker_fee_bps) ?? asBpsString(record.makerFeeBps);
  const takerFeeBps =
    asBpsString(record.taker_fee_bps) ?? asBpsString(record.takerFeeBps);
  if (feeBaseBps === null && makerFeeBps === null && takerFeeBps === null) {
    return null;
  }
  return { feeBaseBps, makerFeeBps, takerFeeBps };
}

/**
 * Hourly fee re-poll (RFC-007 task 3): query CLOB REST /fee-rate for each
 * universe member and version any change via applyParamFields (fields not
 * reported by this endpoint carry over from the open version). An HTTP
 * failure records a clob_rest gap and continues.
 */
export async function refreshParams(
  deps: RefreshParamsDeps,
  universe: readonly UniverseMember[],
): Promise<void> {
  const now = deps.now ?? ((): Date => new Date());
  const fetcher = deps.fetcher ?? (fetch as JsonFetcher);
  const clobBaseUrl = deps.clobBaseUrl ?? CLOB_BASE_URL;
  const pool = deps.pool;

  for (const member of universe) {
    // Fee rates are market-wide; either token is a valid lookup key.
    const tokenId = member.tokenIds[0];
    if (tokenId === undefined) {
      continue;
    }
    let parsed: ReturnType<typeof parseFeeRateBody>;
    try {
      const response = await fetcher(
        `${clobBaseUrl}/fee-rate?token_id=${encodeURIComponent(tokenId)}`,
        { headers: { accept: "application/json", "user-agent": USER_AGENT } },
      );
      if (!response.ok) {
        throw new Error("fee_rate_http_error");
      }
      parsed = parseFeeRateBody((await response.json()) as unknown);
    } catch {
      log("error", "FEE_POLL_FAILED", "polymarket_fee_poll_failed", {
        condition_id: member.conditionId,
      });
      try {
        await insertDataGap(
          pool,
          "clob_rest",
          tokenId,
          "fee_poll_failed",
          now(),
          { condition_id: member.conditionId },
        );
      } catch {
        log("error", "GAP_PERSIST_FAILED", "polymarket_gap_persist_failed");
      }
      continue;
    }
    if (parsed === null) {
      log("warn", "FEE_SHAPE_UNKNOWN", "polymarket_fee_shape_unknown", {
        condition_id: member.conditionId,
      });
      continue;
    }
    try {
      await applyParamFields(pool, member.conditionId, parsed, now());
    } catch (error: unknown) {
      log("error", "PARAM_PERSIST_FAILED", "polymarket_param_persist_failed", {
        condition_id: member.conditionId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}
