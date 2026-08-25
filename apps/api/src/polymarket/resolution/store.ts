// RFC-012 storage layer: as-of loaders over the RFC-007 tables and writers
// for the module's own tables. Every loader takes an explicit `asOf` instant
// and reads only rows with received_at (or valid_from) at or before it — the
// look-ahead discipline is enforced here, in one place, so the score cannot
// leak future data no matter who calls it. `closedTime` from UMA is never
// read anywhere in this module: it becomes known AFTER the outcome is public.

import type {
  PriorKind,
  ResolutionAction,
  ResolutionPool,
  ScoreTrigger,
} from "./types.js";

export interface ScoreableMarket {
  readonly conditionId: string;
  readonly question: string;
  readonly category: string | null;
  readonly negRisk: boolean | null;
  readonly tokenIds: readonly string[];
  readonly affirmativeTokenId: string | null;
  readonly inUniverse: boolean;
  /** Set only by the historical loader after every required input is proven. */
  readonly historicalInputsAvailable?: boolean;
}

function requiredVersionedMarket(
  row: Record<string, unknown>,
  inUniverse: boolean,
): ScoreableMarket {
  const conditionId = asString(row.condition_id);
  if (conditionId === null || conditionId.length === 0) {
    throw new Error("RESOLUTION_MARKET_CONDITION_ID_MISSING");
  }
  if (
    row.metadata_version_id === null ||
    row.metadata_version_id === undefined
  ) {
    throw new Error(
      `RESOLUTION_MARKET_METADATA_VERSION_MISSING:${conditionId}`,
    );
  }
  const question = asString(row.question);
  if (question === null || question.trim().length === 0) {
    throw new Error(`RESOLUTION_MARKET_QUESTION_MISSING:${conditionId}`);
  }
  const tokenIds = parseTokenIds(row.clob_token_ids);
  if (
    tokenIds.length !== 2 ||
    tokenIds.some((tokenId) => tokenId.trim().length === 0) ||
    new Set(tokenIds).size !== 2
  ) {
    throw new Error(`RESOLUTION_MARKET_TOKEN_IDS_MISSING:${conditionId}`);
  }
  const affirmativeTokenId = asString(row.affirmative_token_id);
  if (
    affirmativeTokenId === null ||
    affirmativeTokenId.trim().length === 0 ||
    !tokenIds.includes(affirmativeTokenId)
  ) {
    throw new Error(
      `RESOLUTION_MARKET_AFFIRMATIVE_TOKEN_MISSING:${conditionId}`,
    );
  }
  if (row.param_version_id === null || row.param_version_id === undefined) {
    throw new Error(`RESOLUTION_MARKET_PARAM_VERSION_MISSING:${conditionId}`);
  }
  if (typeof row.neg_risk !== "boolean") {
    throw new Error(`RESOLUTION_MARKET_NEG_RISK_MISSING:${conditionId}`);
  }
  return {
    conditionId,
    question,
    category: asString(row.category),
    negRisk: row.neg_risk,
    tokenIds,
    affirmativeTokenId,
    inUniverse,
  };
}

/**
 * Markets the score covers: the current universe plus markets that LEFT it
 * without a terminal resolution (production fact: a market exits ~17 min
 * after its UMA proposal, long before liveness ends — exactly the window
 * where dispute risk lives).
 */
export async function loadScoreableMarkets(
  pool: ResolutionPool,
  asOf: Date,
  pendingLookbackMs: number = 7 * 24 * 3_600_000,
): Promise<ScoreableMarket[]> {
  const since = new Date(asOf.getTime() - pendingLookbackMs);
  const result = await pool.query<Record<string, unknown>>(
    `WITH membership AS (
       SELECT DISTINCT ON (condition_id) condition_id, action, at
         FROM polymarket_universe_log
        WHERE at <= $1 AND action IN ('enter', 'exit')
        ORDER BY condition_id, at DESC, universe_log_id DESC
     ),
     terminal AS (
       SELECT DISTINCT condition_id
         FROM polymarket_resolution_events
        WHERE event_type IN ('resolved', 'market_resolved')
          AND received_at <= $1
     ),
     scoreable AS (
       SELECT m.condition_id, (m.action = 'enter') AS in_universe
         FROM membership m
         LEFT JOIN terminal t ON t.condition_id = m.condition_id
        WHERE m.action = 'enter'
           OR (m.action = 'exit' AND t.condition_id IS NULL AND m.at > $2)
     )
     SELECT s.condition_id, h.metadata_version_id, p.param_version_id,
            h.question, h.category, p.neg_risk, h.clob_token_ids,
            h.affirmative_token_id, s.in_universe
       FROM scoreable s
       LEFT JOIN LATERAL (
         SELECT metadata.metadata_version_id, metadata.question,
                metadata.category, metadata.clob_token_ids,
                metadata.affirmative_token_id
           FROM polymarket_market_metadata_versions metadata
          WHERE metadata.condition_id = s.condition_id
            AND metadata.valid_from <= $1
            AND (metadata.valid_to IS NULL OR metadata.valid_to > $1)
          ORDER BY metadata.version DESC
          LIMIT 1
       ) h ON TRUE
       LEFT JOIN LATERAL (
         SELECT params.param_version_id, params.neg_risk
           FROM polymarket_param_versions params
          WHERE params.condition_id = s.condition_id
            AND params.valid_from <= $1
            AND (params.valid_to IS NULL OR params.valid_to > $1)
          ORDER BY params.version DESC
          LIMIT 1
       ) p ON TRUE
      ORDER BY s.condition_id`,
    [asOf, since],
  );
  return result.rows.map((row) =>
    requiredVersionedMarket(row, row.in_universe === true),
  );
}

/**
 * Load specific markets by id regardless of universe membership or terminal
 * state — the task-10 backtest re-scores RESOLVED markets, and a targeted
 * recompute must be able to RELEASE a market that resolved after exiting the
 * universe (its stale VETO/CIRCUIT_BREAKER would otherwise freeze its event
 * group forever).
 */
export async function marketsByIds(
  pool: ResolutionPool,
  conditionIds: readonly string[],
  asOf: Date,
): Promise<ScoreableMarket[]> {
  if (conditionIds.length === 0) {
    return [];
  }
  const result = await pool.query<Record<string, unknown>>(
    `WITH requested AS (
       SELECT unnest($1::text[]) AS condition_id
     )
     SELECT r.condition_id, h.metadata_version_id, p.param_version_id,
            h.question, h.category, p.neg_risk, h.clob_token_ids,
            h.affirmative_token_id
       FROM requested r
       LEFT JOIN LATERAL (
         SELECT metadata.metadata_version_id, metadata.question,
                metadata.category, metadata.clob_token_ids,
                metadata.affirmative_token_id
           FROM polymarket_market_metadata_versions metadata
          WHERE metadata.condition_id = r.condition_id
            AND metadata.valid_from <= $2
            AND (metadata.valid_to IS NULL OR metadata.valid_to > $2)
          ORDER BY metadata.version DESC
          LIMIT 1
       ) h ON TRUE
       LEFT JOIN LATERAL (
         SELECT params.param_version_id, params.neg_risk
           FROM polymarket_param_versions params
          WHERE params.condition_id = r.condition_id
            AND params.valid_from <= $2
            AND (params.valid_to IS NULL OR params.valid_to > $2)
          ORDER BY params.version DESC
          LIMIT 1
       ) p ON TRUE
      ORDER BY r.condition_id`,
    [[...conditionIds], asOf],
  );
  return result.rows.map((row) => requiredVersionedMarket(row, false));
}

export interface HistoricalMarketRequest {
  readonly conditionId: string;
  readonly asOf: Date;
}

/**
 * Reconstruct the metadata that was actually observable at each historical
 * decision instant. Question/category/token mappings come exclusively from
 * the prospective metadata history; the mutable registry is never projected
 * backward. Membership and negRisk retain their own versioned sources.
 */
export async function historicalMarketsAsOf(
  pool: ResolutionPool,
  requests: readonly HistoricalMarketRequest[],
): Promise<Map<string, ScoreableMarket>> {
  const markets = new Map<string, ScoreableMarket>();
  if (requests.length === 0) {
    return markets;
  }
  if (
    new Set(requests.map((request) => request.conditionId)).size !==
    requests.length
  ) {
    throw new Error("HISTORICAL_MARKET_REQUEST_DUPLICATE_CONDITION");
  }
  const result = await pool.query<Record<string, unknown>>(
    `WITH requested AS (
       SELECT condition_id, decision_at
         FROM unnest($1::text[], $2::timestamptz[])
              AS request(condition_id, decision_at)
     ),
     membership AS (
       SELECT DISTINCT ON (r.condition_id)
              r.condition_id, u.action
         FROM requested r
         LEFT JOIN polymarket_universe_log u
           ON u.condition_id = r.condition_id
          AND u.at <= r.decision_at
          AND u.action IN ('enter', 'exit')
        ORDER BY r.condition_id, u.at DESC NULLS LAST,
                 u.universe_log_id DESC NULLS LAST
     ),
     params AS (
       SELECT DISTINCT ON (r.condition_id)
              r.condition_id, p.neg_risk
         FROM requested r
         LEFT JOIN polymarket_param_versions p
           ON p.condition_id = r.condition_id
          AND p.valid_from <= r.decision_at
          AND (p.valid_to IS NULL OR p.valid_to > r.decision_at)
        ORDER BY r.condition_id, p.version DESC NULLS LAST
     ),
     metadata AS (
       SELECT DISTINCT ON (r.condition_id)
              r.condition_id, h.question, h.category, h.clob_token_ids,
              h.affirmative_token_id
         FROM requested r
         LEFT JOIN polymarket_market_metadata_versions h
           ON h.condition_id = r.condition_id
          AND h.valid_from <= r.decision_at
          AND (h.valid_to IS NULL OR h.valid_to > r.decision_at)
        ORDER BY r.condition_id, h.version DESC NULLS LAST
     )
     SELECT r.condition_id, m.action, p.neg_risk,
            h.question, h.category, h.affirmative_token_id,
            COALESCE(h.clob_token_ids, '[]'::jsonb) AS token_ids
       FROM requested r
       LEFT JOIN membership m ON m.condition_id = r.condition_id
       LEFT JOIN params p ON p.condition_id = r.condition_id
       LEFT JOIN metadata h ON h.condition_id = r.condition_id
      ORDER BY r.condition_id`,
    [
      requests.map((request) => request.conditionId),
      requests.map((request) => request.asOf),
    ],
  );
  for (const row of result.rows) {
    const conditionId = asString(row.condition_id);
    if (conditionId === null) {
      continue;
    }
    const question = asString(row.question) ?? "";
    const category = asString(row.category);
    const negRisk = typeof row.neg_risk === "boolean" ? row.neg_risk : null;
    const tokenIds = parseTokenIds(row.token_ids);
    const affirmativeTokenId = asString(row.affirmative_token_id);
    const affirmativeMappingAvailable =
      tokenIds.length === 2 &&
      tokenIds.every((tokenId) => tokenId.trim().length > 0) &&
      new Set(tokenIds).size === 2 &&
      affirmativeTokenId !== null &&
      affirmativeTokenId.trim().length > 0 &&
      tokenIds.includes(affirmativeTokenId);
    markets.set(conditionId, {
      conditionId,
      question,
      category,
      negRisk,
      tokenIds,
      affirmativeTokenId: affirmativeMappingAvailable
        ? affirmativeTokenId
        : null,
      inUniverse: row.action === "enter",
      historicalInputsAvailable:
        question.length > 0 &&
        category !== null &&
        negRisk !== null &&
        affirmativeMappingAvailable,
    });
  }
  return markets;
}

function parseTokenIds(value: unknown): string[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is string => typeof item === "string");
}

export interface RuleAsOf {
  readonly ruleVersion: number;
  readonly description: string;
  readonly resolutionSource: string | null;
  readonly endDate: Date | null;
  readonly umaEndDate: Date | null;
  readonly umaBond: string | null;
  readonly umaReward: string | null;
  readonly customLiveness: string | null;
  readonly automaticallyResolved: boolean | null;
  readonly validFrom: Date;
}

/** Versioned rule at the instant, strict [valid_from, valid_to) semantics. */
export async function ruleAsOf(
  pool: ResolutionPool,
  conditionId: string,
  asOf: Date,
): Promise<RuleAsOf | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT version, description, resolution_source, end_date, uma_end_date,
            uma_bond, uma_reward, custom_liveness, automatically_resolved,
            valid_from
       FROM polymarket_rule_versions
      WHERE condition_id = $1
        AND valid_from <= $2
        AND (valid_to IS NULL OR valid_to > $2)
      ORDER BY version DESC
      LIMIT 1`,
    [conditionId, asOf],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  const validFrom = toDate(row.valid_from);
  if (validFrom === null) {
    return null;
  }
  return {
    ruleVersion: Number(row.version),
    description: typeof row.description === "string" ? row.description : "",
    resolutionSource: asString(row.resolution_source),
    endDate: toDate(row.end_date),
    umaEndDate: toDate(row.uma_end_date),
    umaBond: asString(row.uma_bond),
    umaReward: asString(row.uma_reward),
    customLiveness: asString(row.custom_liveness),
    automaticallyResolved:
      typeof row.automatically_resolved === "boolean"
        ? row.automatically_resolved
        : null,
    validFrom,
  };
}

/** Previous rule version's text, for the clarification diff. */
export async function ruleVersionText(
  pool: ResolutionPool,
  conditionId: string,
  version: number,
): Promise<{
  description: string;
  resolutionSource: string | null;
  endDate: Date | null;
  umaEndDate: Date | null;
  umaBond: string | null;
  customLiveness: string | null;
} | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT description, resolution_source, end_date, uma_end_date, uma_bond,
            custom_liveness
       FROM polymarket_rule_versions
      WHERE condition_id = $1 AND version = $2
      LIMIT 1`,
    [conditionId, version],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    description: typeof row.description === "string" ? row.description : "",
    resolutionSource: asString(row.resolution_source),
    endDate: toDate(row.end_date),
    umaEndDate: toDate(row.uma_end_date),
    umaBond: asString(row.uma_bond),
    customLiveness: asString(row.custom_liveness),
  };
}

export type UmaStatus = "proposed" | "disputed" | "resolved" | "closed" | null;

export interface StatusAsOf {
  readonly status: UmaStatus;
  readonly statusAt: Date | null;
  /** First 'proposed' instant of the current lifecycle, when known. */
  readonly proposedAt: Date | null;
  readonly disputeCount: number;
}

/**
 * UMA status at the instant. Settlement is monotonic: once any resolved or
 * market_resolved event has been observed, a delayed non-terminal event can
 * no longer reopen the market.
 */
export async function statusAsOf(
  pool: ResolutionPool,
  conditionId: string,
  asOf: Date,
): Promise<StatusAsOf> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT event_type, received_at
       FROM polymarket_resolution_events
      WHERE condition_id = $1
        AND received_at <= $2
        AND event_type IN ('proposed', 'disputed', 'resolved', 'closed', 'market_resolved')
      ORDER BY received_at ASC, resolution_event_id ASC`,
    [conditionId, asOf],
  );
  let status: UmaStatus = null;
  let statusAt: Date | null = null;
  let proposedAt: Date | null = null;
  let terminalAt: Date | null = null;
  let disputeCount = 0;
  for (const row of result.rows) {
    const eventType = asString(row.event_type);
    const at = toDate(row.received_at);
    if (eventType === null || at === null) {
      continue;
    }
    if (eventType === "proposed" && proposedAt === null) {
      proposedAt = at;
    }
    if (eventType === "disputed") {
      disputeCount += 1;
    }
    if (
      terminalAt === null &&
      (eventType === "resolved" || eventType === "market_resolved")
    ) {
      terminalAt = at;
    }
    status =
      eventType === "market_resolved" ? "resolved" : (eventType as UmaStatus);
    statusAt = at;
  }
  if (terminalAt !== null) {
    status = "resolved";
    statusAt = terminalAt;
  }
  return { status, statusAt, proposedAt, disputeCount };
}

export interface HoldersAsOf {
  readonly top1Share: number | null;
  readonly top5Share: number | null;
  readonly sampledAt: Date | null;
}

/** Latest holders-concentration sample at the instant (market level). */
export async function holdersAsOf(
  pool: ResolutionPool,
  conditionId: string,
  asOf: Date,
): Promise<HoldersAsOf> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT top1_share, top5_share, received_at
       FROM polymarket_oi_holders
      WHERE condition_id = $1
        AND received_at <= $2
        AND top1_share IS NOT NULL
      ORDER BY received_at DESC, sample_id DESC
      LIMIT 1`,
    [conditionId, asOf],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return { top1Share: null, top5Share: null, sampledAt: null };
  }
  return {
    top1Share: toShare(row.top1_share),
    top5Share: toShare(row.top5_share),
    sampledAt: toDate(row.received_at),
  };
}

function toShare(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

export interface BookTop {
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly bids: ReadonlyArray<{ price: string; size: string }>;
  readonly asks: ReadonlyArray<{ price: string; size: string }>;
  readonly sourceTs: Date | null;
  readonly receivedAt: Date;
}

/** Latest recorded top-10 book at the instant (never the UI midpoint). */
export async function bookAsOf(
  pool: ResolutionPool,
  tokenId: string,
  asOf: Date,
): Promise<BookTop | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT bids_json, asks_json, source_ts, received_at
       FROM polymarket_book_snapshots
      WHERE token_id = $1 AND received_at <= $2
      ORDER BY received_at DESC, snapshot_id DESC
      LIMIT 1`,
    [tokenId, asOf],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  const receivedAt = toDate(row.received_at);
  if (receivedAt === null) {
    return null;
  }
  const bids = parseLevels(row.bids_json);
  const asks = parseLevels(row.asks_json);
  return {
    bestBid: levelPrice(bids[0]),
    bestAsk: levelPrice(asks[0]),
    bids,
    asks,
    sourceTs: toDate(row.source_ts),
    receivedAt,
  };
}

function parseLevels(value: unknown): Array<{ price: string; size: string }> {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const levels: Array<{ price: string; size: string }> = [];
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

function levelPrice(
  level: { price: string; size: string } | undefined,
): number | null {
  if (level === undefined) {
    return null;
  }
  const parsed = Number(level.price);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Mid close of the newest FULLY CLOSED 1-minute bucket at the instant. The
 * bucket containing asOf aggregates data up to bucket_start+60s — reading it
 * would leak up to 59s of post-asOf data, so only buckets whose window ended
 * at or before asOf qualify.
 */
export async function midCloseAt(
  pool: ResolutionPool,
  tokenId: string,
  asOf: Date,
): Promise<number | null> {
  const closedBefore = new Date(asOf.getTime() - 60_000);
  const result = await pool.query<Record<string, unknown>>(
    `SELECT mid_close
       FROM polymarket_series_1m
      WHERE token_id = $1 AND bucket_start <= $2
      ORDER BY bucket_start DESC
      LIMIT 1`,
    [tokenId, closedBefore],
  );
  const value = result.rows[0]?.mid_close;
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface EventGroup {
  readonly eventId: string;
  readonly negRisk: boolean;
  readonly members: readonly string[];
}

/** Event groups (negRisk parents) for a set of markets. */
export async function eventGroupsFor(
  pool: ResolutionPool,
  conditionIds: readonly string[],
  asOf: Date,
): Promise<Map<string, EventGroup[]>> {
  const groups = new Map<string, EventGroup[]>();
  if (conditionIds.length === 0) {
    return groups;
  }
  const result = await pool.query<Record<string, unknown>>(
    `WITH touched AS (
       SELECT em.condition_id, em.event_id
         FROM polymarket_event_markets em
        WHERE em.condition_id = ANY($1)
          AND em.received_at <= $2
     ),
     membership AS (
       SELECT t.condition_id, t.event_id, m.condition_id AS member_condition_id,
              (SELECT pv.neg_risk
                 FROM polymarket_param_versions pv
                WHERE pv.condition_id = m.condition_id
                  AND pv.valid_from <= $2
                  AND (pv.valid_to IS NULL OR pv.valid_to > $2)
                ORDER BY pv.version DESC
                LIMIT 1) AS neg_risk_as_of
         FROM touched t
         JOIN polymarket_event_markets m ON m.event_id = t.event_id
                                      AND m.received_at <= $2
     )
     SELECT condition_id, event_id,
            bool_and(neg_risk_as_of IS TRUE) AS neg_risk,
            jsonb_agg(member_condition_id ORDER BY member_condition_id) AS members
       FROM membership
      GROUP BY condition_id, event_id`,
    [[...conditionIds], asOf],
  );
  for (const row of result.rows) {
    const conditionId = asString(row.condition_id);
    const eventId = asString(row.event_id);
    if (conditionId === null || eventId === null) {
      continue;
    }
    const members = Array.isArray(row.members)
      ? (row.members as unknown[]).filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    const entry: EventGroup = {
      eventId,
      negRisk: row.neg_risk === true,
      members,
    };
    const existing = groups.get(conditionId);
    if (existing === undefined) {
      groups.set(conditionId, [entry]);
    } else {
      existing.push(entry);
    }
  }
  return groups;
}

export interface MeasuredCategoryStats {
  readonly category: string;
  readonly resolved: number;
  readonly disputed: number;
  readonly p5050: number;
}

/**
 * Own-pipeline dispute statistics per Gamma category (task 4): resolutions
 * observed, how many saw a dispute, and how many settled 50/50. The measured
 * prior replaces the external one at measuredMinN resolutions.
 */
export async function measuredCategoryStats(
  pool: ResolutionPool,
  asOf: Date,
): Promise<MeasuredCategoryStats[]> {
  const result = await pool.query<Record<string, unknown>>(
    `WITH terminal AS (
       SELECT DISTINCT ON (e.condition_id)
              e.condition_id, e.received_at AS terminal_at, e.payload_json
         FROM polymarket_resolution_events e
        WHERE e.event_type IN ('resolved', 'market_resolved')
          AND e.received_at <= $1
        ORDER BY e.condition_id, e.received_at ASC, e.resolution_event_id ASC
     ),
     disputes AS (
       SELECT DISTINCT condition_id
         FROM polymarket_resolution_events
        WHERE event_type = 'disputed' AND received_at <= $1
     )
     SELECT COALESCE(m.category, 'unknown') AS category,
            COUNT(*)::bigint AS resolved,
            COUNT(d.condition_id)::bigint AS disputed,
            COUNT(*) FILTER (
              WHERE t.payload_json->'raw'->'outcomePrices' @> '["0.5"]'::jsonb
                 OR t.payload_json->'outcomePrices' @> '["0.5"]'::jsonb
            )::bigint AS p5050
       FROM terminal t
       LEFT JOIN disputes d ON d.condition_id = t.condition_id
       LEFT JOIN LATERAL (
         SELECT metadata.category
           FROM polymarket_market_metadata_versions metadata
          WHERE metadata.condition_id = t.condition_id
            AND metadata.valid_from <= t.terminal_at
            AND (metadata.valid_to IS NULL OR metadata.valid_to > t.terminal_at)
          ORDER BY metadata.version DESC
          LIMIT 1
       ) m ON TRUE
      GROUP BY COALESCE(m.category, 'unknown')`,
    [asOf],
  );
  return result.rows.map((row) => ({
    category: asString(row.category) ?? "unknown",
    resolved: Number(row.resolved ?? 0),
    disputed: Number(row.disputed ?? 0),
    p5050: Number(row.p5050 ?? 0),
  }));
}

/**
 * Historical priors for many decision instants in one database read. Terminal
 * facts are loaded once up to the newest instant, then accumulated in memory
 * in chronological order. Category comes from the immutable universe-entry
 * observation rather than today's mutable market registry.
 */
export async function measuredCategoryStatsBatch(
  pool: ResolutionPool,
  asOfInstants: readonly Date[],
): Promise<Map<number, MeasuredCategoryStats[]>> {
  const snapshots = new Map<number, MeasuredCategoryStats[]>();
  const instants = [...new Set(asOfInstants.map((asOf) => asOf.getTime()))]
    .filter((instant) => Number.isFinite(instant))
    .sort((a, b) => a - b);
  const newest = instants.at(-1);
  if (newest === undefined) {
    return snapshots;
  }

  const result = await pool.query<Record<string, unknown>>(
    `WITH terminal AS (
       SELECT DISTINCT ON (e.condition_id)
              e.condition_id, e.received_at AS terminal_at, e.payload_json
         FROM polymarket_resolution_events e
        WHERE e.event_type IN ('resolved', 'market_resolved')
          AND e.received_at <= $1
        ORDER BY e.condition_id, e.received_at ASC,
                 e.resolution_event_id ASC
     ),
     disputes AS (
       SELECT condition_id, MIN(received_at) AS disputed_at
         FROM polymarket_resolution_events
        WHERE event_type = 'disputed' AND received_at <= $1
        GROUP BY condition_id
     )
     SELECT t.condition_id, t.terminal_at, d.disputed_at,
            COALESCE(c.category, 'unknown') AS category,
            COALESCE(
              t.payload_json->'raw'->'outcomePrices' @> '["0.5"]'::jsonb
              OR t.payload_json->'outcomePrices' @> '["0.5"]'::jsonb,
              FALSE
            ) AS is_p5050
       FROM terminal t
       LEFT JOIN disputes d ON d.condition_id = t.condition_id
       LEFT JOIN LATERAL (
         SELECT h.category
           FROM polymarket_market_metadata_versions h
          WHERE h.condition_id = t.condition_id
            AND h.valid_from <= t.terminal_at
            AND (h.valid_to IS NULL OR h.valid_to > t.terminal_at)
          ORDER BY h.version DESC
          LIMIT 1
       ) c ON TRUE
      ORDER BY t.terminal_at ASC, t.condition_id`,
    [new Date(newest)],
  );

  interface HistoricalFact {
    readonly category: string;
    readonly terminalAt: number;
    readonly disputedAt: number | null;
    readonly p5050: boolean;
  }
  const facts: HistoricalFact[] = [];
  for (const row of result.rows) {
    const terminalAt = toDate(row.terminal_at)?.getTime();
    if (terminalAt === undefined || !Number.isFinite(terminalAt)) {
      continue;
    }
    const disputedAt = toDate(row.disputed_at)?.getTime() ?? null;
    facts.push({
      category: asString(row.category) ?? "unknown",
      terminalAt,
      disputedAt,
      p5050: row.is_p5050 === true,
    });
  }
  facts.sort((left, right) => left.terminalAt - right.terminalAt);
  const disputeActivations = facts
    .filter(
      (fact): fact is HistoricalFact & { readonly disputedAt: number } =>
        fact.disputedAt !== null,
    )
    .map((fact) => ({
      category: fact.category,
      at: Math.max(fact.terminalAt, fact.disputedAt),
    }))
    .sort((left, right) => left.at - right.at);

  const totals = new Map<
    string,
    { resolved: number; disputed: number; p5050: number }
  >();
  const totalFor = (
    category: string,
  ): { resolved: number; disputed: number; p5050: number } => {
    const current = totals.get(category);
    if (current !== undefined) {
      return current;
    }
    const created = { resolved: 0, disputed: 0, p5050: 0 };
    totals.set(category, created);
    return created;
  };

  let terminalIndex = 0;
  let disputeIndex = 0;
  for (const instant of instants) {
    while (
      terminalIndex < facts.length &&
      (facts[terminalIndex]?.terminalAt ?? Number.POSITIVE_INFINITY) <= instant
    ) {
      const fact = facts[terminalIndex];
      if (fact !== undefined) {
        const total = totalFor(fact.category);
        total.resolved += 1;
        total.p5050 += fact.p5050 ? 1 : 0;
      }
      terminalIndex += 1;
    }
    while (
      disputeIndex < disputeActivations.length &&
      (disputeActivations[disputeIndex]?.at ?? Number.POSITIVE_INFINITY) <=
        instant
    ) {
      const activation = disputeActivations[disputeIndex];
      if (activation !== undefined) {
        totalFor(activation.category).disputed += 1;
      }
      disputeIndex += 1;
    }
    snapshots.set(
      instant,
      [...totals.entries()]
        .map(([category, total]) => ({ category, ...total }))
        .sort((left, right) => left.category.localeCompare(right.category)),
    );
  }
  return snapshots;
}

export interface ScoreRowInput {
  readonly conditionId: string;
  readonly scoreVersion: string;
  readonly ruleVersion: number | null;
  readonly score: string;
  readonly action: ResolutionAction;
  readonly resolutionBuffer: string | null;
  readonly p5050: string | null;
  readonly expectedLockupS: number | null;
  readonly p95LockupS: number | null;
  readonly priorKind: PriorKind;
  readonly features: Record<string, unknown>;
  readonly hardFlags: readonly string[];
  readonly justification: string | null;
  readonly trigger: ScoreTrigger;
  readonly computedAt: Date;
}

export async function insertScore(
  pool: ResolutionPool,
  input: ScoreRowInput,
): Promise<number> {
  const result = await pool.query<{ score_id: string | number }>(
    `INSERT INTO resolution_scores
       (condition_id, score_version, rule_version, score, action,
        resolution_buffer, p_5050, expected_lockup_s, p95_lockup_s, prior_kind,
        features_json, hard_flags_json, justification, trigger, computed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15)
     RETURNING score_id`,
    [
      input.conditionId,
      input.scoreVersion,
      input.ruleVersion,
      input.score,
      input.action,
      input.resolutionBuffer,
      input.p5050,
      input.expectedLockupS,
      input.p95LockupS,
      input.priorKind,
      JSON.stringify(input.features),
      JSON.stringify(input.hardFlags),
      input.justification,
      input.trigger,
      input.computedAt,
    ],
  );
  return Number(result.rows[0]?.score_id ?? 0);
}

export interface MarketStateInput {
  readonly conditionId: string;
  readonly scoreId: number | null;
  readonly score: string | null;
  readonly scoreVersion: string | null;
  readonly action: ResolutionAction;
  readonly effectiveAction: ResolutionAction;
  readonly resolutionBuffer: string | null;
  readonly p5050: string | null;
  readonly expectedLockupS: number | null;
  readonly p95LockupS: number | null;
  readonly disputeActive: boolean;
  readonly suspectJump: boolean;
  readonly hardFlags: readonly string[];
  readonly eventIds: readonly string[];
  readonly groupWorstScore: string | null;
  readonly justification: string | null;
  readonly priorKind: PriorKind | null;
  readonly computedAt: Date;
}

export async function upsertMarketState(
  pool: ResolutionPool,
  input: MarketStateInput,
): Promise<void> {
  await pool.query(
    `INSERT INTO resolution_market_state
       (condition_id, score_id, score, score_version, action, effective_action,
        resolution_buffer, p_5050, expected_lockup_s, p95_lockup_s,
        dispute_active, suspect_jump, hard_flags_json, event_ids_json,
        group_worst_score, justification, prior_kind, computed_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$18)
     ON CONFLICT (condition_id) DO UPDATE SET
       score_id = EXCLUDED.score_id,
       score = EXCLUDED.score,
       score_version = EXCLUDED.score_version,
       action = EXCLUDED.action,
       effective_action = EXCLUDED.effective_action,
       resolution_buffer = EXCLUDED.resolution_buffer,
       p_5050 = EXCLUDED.p_5050,
       expected_lockup_s = EXCLUDED.expected_lockup_s,
       p95_lockup_s = EXCLUDED.p95_lockup_s,
       dispute_active = EXCLUDED.dispute_active,
       suspect_jump = EXCLUDED.suspect_jump,
       hard_flags_json = EXCLUDED.hard_flags_json,
       event_ids_json = EXCLUDED.event_ids_json,
       group_worst_score = EXCLUDED.group_worst_score,
       justification = EXCLUDED.justification,
       prior_kind = EXCLUDED.prior_kind,
       computed_at = EXCLUDED.computed_at,
       updated_at = EXCLUDED.updated_at`,
    [
      input.conditionId,
      input.scoreId,
      input.score,
      input.scoreVersion,
      input.action,
      input.effectiveAction,
      input.resolutionBuffer,
      input.p5050,
      input.expectedLockupS,
      input.p95LockupS,
      input.disputeActive,
      input.suspectJump,
      JSON.stringify(input.hardFlags),
      JSON.stringify(input.eventIds),
      input.groupWorstScore,
      input.justification,
      input.priorKind,
      input.computedAt,
    ],
  );
}

/**
 * Register the running score version, failing closed when the same version
 * name already exists with DIFFERENT content hashes: a weight or lexicon
 * change without a version bump would silently break reproducibility.
 */
export async function ensureScoreVersion(
  pool: ResolutionPool,
  input: {
    scoreVersion: string;
    configHash: string;
    lexiconHash: string;
    weights: Record<string, number>;
    thresholds: Record<string, number>;
    priors: Record<string, unknown>;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO resolution_score_versions
       (score_version, config_hash, lexicon_hash, weights_json, thresholds_json, priors_json)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)
     ON CONFLICT (score_version) DO NOTHING`,
    [
      input.scoreVersion,
      input.configHash,
      input.lexiconHash,
      JSON.stringify(input.weights),
      JSON.stringify(input.thresholds),
      JSON.stringify(input.priors),
    ],
  );
  const stored = await pool.query<{
    config_hash: string;
    lexicon_hash: string;
  }>(
    `SELECT config_hash, lexicon_hash
       FROM resolution_score_versions
      WHERE score_version = $1`,
    [input.scoreVersion],
  );
  const row = stored.rows[0];
  if (row === undefined) {
    throw new Error("SCORE_VERSION_MISSING_AFTER_INSERT");
  }
  if (
    row.config_hash !== input.configHash ||
    row.lexicon_hash !== input.lexiconHash
  ) {
    throw new Error("SCORE_VERSION_CONTENT_MISMATCH");
  }
}

export interface ParamsAsOf {
  readonly takerFeeBps: string | null;
  readonly tickSize: string | null;
  readonly negRisk: boolean | null;
}

/** Versioned fee/tick parameters at the instant ([valid_from, valid_to)). */
export async function paramsAsOf(
  pool: ResolutionPool,
  conditionId: string,
  asOf: Date,
): Promise<ParamsAsOf | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT taker_fee_bps, tick_size, neg_risk
       FROM polymarket_param_versions
      WHERE condition_id = $1
        AND valid_from <= $2
        AND (valid_to IS NULL OR valid_to > $2)
      ORDER BY version DESC
      LIMIT 1`,
    [conditionId, asOf],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    takerFeeBps: asString(row.taker_fee_bps),
    tickSize: asString(row.tick_size),
    negRisk: typeof row.neg_risk === "boolean" ? row.neg_risk : null,
  };
}

export interface FreshModelEstimate {
  readonly tokenId: string;
  readonly conditionId: string | null;
  readonly q: string;
  readonly modelId: string | null;
  readonly status: "shadow" | "active";
  readonly decisionTs: Date;
}

/**
 * Latest MODEL estimate per token within the freshness window (the module's
 * contract everywhere: an estimate older than the window is an ABSENCE, never
 * a stale value). Shadow rows are included on purpose — the sanity veto must
 * exercise the machinery before any model is promoted — and the status rides
 * along so consumers can tell them apart.
 */
export async function freshModelEstimates(
  pool: ResolutionPool,
  tokenIds: readonly string[],
  asOf: Date,
  maxAgeMs: number = 5 * 60_000,
): Promise<FreshModelEstimate[]> {
  if (tokenIds.length === 0) {
    return [];
  }
  const since = new Date(asOf.getTime() - maxAgeMs);
  const result = await pool.query<Record<string, unknown>>(
    `SELECT DISTINCT ON (token_id)
            token_id, market_id, q, model_id, status, decision_ts
       FROM fundamental_estimates
      WHERE token_id = ANY($1)
        AND source = 'MODEL'
        AND decision_ts >= $2
        AND decision_ts <= $3
      ORDER BY token_id, decision_ts DESC, estimate_id DESC`,
    [[...tokenIds], since, asOf],
  );
  const estimates: FreshModelEstimate[] = [];
  for (const row of result.rows) {
    const tokenId = asString(row.token_id);
    const q = asString(row.q);
    const decisionTs = toDate(row.decision_ts);
    const status = row.status === "active" ? "active" : "shadow";
    if (tokenId === null || q === null || decisionTs === null) {
      continue;
    }
    estimates.push({
      tokenId,
      conditionId: asString(row.market_id),
      q,
      modelId: asString(row.model_id),
      status,
      decisionTs,
    });
  }
  return estimates;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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
