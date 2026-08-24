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
  readonly negRisk: boolean;
  readonly tokenIds: readonly string[];
  readonly inUniverse: boolean;
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
  const result = await pool.query<{
    condition_id: string;
    question: string;
    category: string | null;
    neg_risk: boolean;
    clob_token_ids: unknown;
    in_universe: boolean;
  }>(
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
     SELECT p.condition_id, p.question, p.category, p.neg_risk,
            p.clob_token_ids, s.in_universe
       FROM scoreable s
       JOIN polymarket_markets p ON p.condition_id = s.condition_id
      ORDER BY p.condition_id`,
    [asOf, since],
  );
  return result.rows.map((row) => ({
    conditionId: row.condition_id,
    question: row.question,
    category: row.category,
    negRisk: row.neg_risk === true,
    tokenIds: parseTokenIds(row.clob_token_ids),
    inUniverse: row.in_universe === true,
  }));
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

/** Latest UMA status at the instant, from the immutable Gamma timeline. */
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
    status =
      eventType === "market_resolved" ? "resolved" : (eventType as UmaStatus);
    statusAt = at;
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

/** Mid closes of the 1-minute series around the jump window. */
export async function midCloseAt(
  pool: ResolutionPool,
  tokenId: string,
  asOf: Date,
): Promise<number | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT mid_close
       FROM polymarket_series_1m
      WHERE token_id = $1 AND bucket_start <= $2
      ORDER BY bucket_start DESC
      LIMIT 1`,
    [tokenId, asOf],
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
): Promise<Map<string, EventGroup[]>> {
  const groups = new Map<string, EventGroup[]>();
  if (conditionIds.length === 0) {
    return groups;
  }
  const result = await pool.query<Record<string, unknown>>(
    `SELECT em.condition_id, em.event_id, e.neg_risk,
            (SELECT jsonb_agg(m2.condition_id ORDER BY m2.condition_id)
               FROM polymarket_event_markets m2
              WHERE m2.event_id = em.event_id) AS members
       FROM polymarket_event_markets em
       JOIN polymarket_events e ON e.event_id = em.event_id
      WHERE em.condition_id = ANY($1)`,
    [[...conditionIds]],
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
       SELECT DISTINCT ON (e.condition_id) e.condition_id, e.payload_json
         FROM polymarket_resolution_events e
        WHERE e.event_type IN ('resolved', 'market_resolved')
          AND e.received_at <= $1
        ORDER BY e.condition_id, e.received_at DESC, e.resolution_event_id DESC
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
       LEFT JOIN polymarket_markets m ON m.condition_id = t.condition_id
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
