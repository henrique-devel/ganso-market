// RFC-010 task 7: the label store — the comparable history of resolved
// markets that every honest metric of this module is scored against. It reads
// the immutable RFC-007 resolution timeline plus the market registry and
// writes `fundamental_labels`. It creates no order, no signal and no position.
//
// Three rules shape this file, and each of them exists to block one specific
// way of lying to ourselves:
//
//   1. A label is written only after the FINAL resolution. While a UMA dispute
//      is open the outcome is not known, so the market is skipped and counted
//      (`skippedNotFinal`) instead of being labelled from the proposal that is
//      being challenged. Once the dispute resolves, the row IS written with
//      `disputed = true`: headline metrics exclude disputed markets, but they
//      are analysed separately, so the flag is stored and the row is kept.
//   2. Metrics index on the instant the outcome became PUBLICLY KNOWABLE — the
//      earliest of the market end date and the UMA proposal. The on-chain
//      resolution instant arrives long after the world already knew the
//      answer; it lives in its own column and indexes nothing.
//   3. {0, 0.5, 1} are all first-class labels. A UMA 50/50 is a real outcome,
//      not a parse failure.
//
// The sync is idempotent by construction: it is a single upsert per token
// whose DO UPDATE only fires when a meaningful column actually changed, so
// re-running it neither duplicates nor churns rows.

import { gammaCategoryToModelCategory, type QueryPool } from "./features.js";
import { div, parseScaled, SCALE } from "./fixed.js";
import type { LabelRecord } from "./types.js";

const DAY_MS = 24 * 3_600_000;

/**
 * Default window of the incremental sync. The resolution timeline is never
 * pruned (RFC-007 retention), so a wide window costs only read time; bounding
 * it keeps the daily job proportional to recent activity instead of to the
 * whole history. Rows already stored outside the window keep their label.
 */
const DEFAULT_LOOKBACK_MS = 365 * DAY_MS;

/** Status events that carry a resolution; 'closed' never carries an outcome. */
const RESOLVING_EVENT_TYPES = new Set(["resolved", "market_resolved"]);

/** Event types that make up the resolution timeline of one market. */
const TIMELINE_EVENT_TYPES = [
  "proposed",
  "disputed",
  "resolved",
  "market_resolved",
];

const LABEL_ZERO = "0";
const LABEL_HALF = "0.5";
const LABEL_ONE = "1";

/** Half of the working scale: the exact fixed-point value of a 50/50 outcome. */
const HALF_SCALED = SCALE / 2n;

const PAYOUT_KEYS = ["payouts", "payoutNumerators", "payout_numerators"];
const OUTCOME_PRICE_KEYS = ["outcomePrices", "outcome_prices"];
const WINNER_INDEX_KEYS = [
  "winningOutcomeIndex",
  "winning_outcome_index",
  "winnerIndex",
  "winner_index",
];
const WINNING_ASSET_KEYS = ["winning_asset_id", "winningAssetId"];

function log(
  level: "info" | "warn" | "error",
  reasonCode: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  process.stderr.write(
    `${JSON.stringify({
      level,
      service: "polymarket-fundamental",
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      message,
      ...extra,
    })}\n`,
  );
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

function toRecord(value: unknown): Record<string, unknown> | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** Arrays reach us either as arrays or as JSON text (Gamma encodes them). */
function toArray(value: unknown): unknown[] | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return Array.isArray(parsed) ? parsed : null;
}

function toStringArray(value: unknown): string[] {
  const array = toArray(value);
  return array === null
    ? []
    : array.filter((item): item is string => typeof item === "string");
}

/**
 * Exact fixed-point value of one outcome quantity. Payout numerators and
 * settled outcome prices are parsed from their canonical decimal form into
 * scaled BigInt — never through a float — so `1/2` is exactly a 50/50 and not
 * 0.49999999999999994. Anything that is not a plain decimal (exponent form,
 * NaN, object) yields null and the caller fails closed.
 */
function toScaledValue(value: unknown): bigint | null {
  if (typeof value === "string") {
    return parseScaled(value.trim());
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? parseScaled(value.toString()) : null;
  }
  return null;
}

function labelFromShare(shareScaled: bigint): string | null {
  if (shareScaled === 0n) {
    return LABEL_ZERO;
  }
  if (shareScaled === SCALE) {
    return LABEL_ONE;
  }
  if (shareScaled === HALF_SCALED) {
    return LABEL_HALF;
  }
  // A share the RFC does not define as a label (e.g. a 2/3 payout split) is
  // undecidable here, not silently rounded to the nearest allowed value.
  return null;
}

/**
 * CTF payout numerators, the canonical settlement encoding: [1, 0] pays the
 * first token, [1, 1] is the UMA 50/50 (the NegRiskAdapter reverts [1, 1], so
 * this outcome only exists outside negRisk markets). The share is normalized
 * by the sum, which makes any denominator convention work.
 */
function labelFromPayouts(
  record: Record<string, unknown>,
  tokenIndex: number,
): string | null {
  for (const key of PAYOUT_KEYS) {
    const array = toArray(record[key]);
    if (array === null || array.length === 0) {
      continue;
    }
    const values: bigint[] = [];
    let total = 0n;
    let malformed = false;
    for (const item of array) {
      const value = toScaledValue(item);
      if (value === null || value < 0n) {
        malformed = true;
        break;
      }
      values.push(value);
      total += value;
    }
    const own = values[tokenIndex];
    if (malformed || total <= 0n || own === undefined) {
      continue;
    }
    const label = labelFromShare(div(own, total));
    if (label !== null) {
      return label;
    }
  }
  return null;
}

/**
 * Settled outcome prices. A resolved vector is exactly {0, 1} (or {0.5, 0.5})
 * and sums to exactly 1; anything else is a LIVE price vector, which is a
 * market opinion and never an outcome, so it is rejected.
 */
function labelFromOutcomePrices(
  record: Record<string, unknown>,
  tokenIndex: number,
): string | null {
  for (const key of OUTCOME_PRICE_KEYS) {
    const array = toArray(record[key]);
    if (array === null || array.length === 0) {
      continue;
    }
    const values: bigint[] = [];
    let total = 0n;
    let malformed = false;
    for (const item of array) {
      const value = toScaledValue(item);
      if (value === null || labelFromShare(value) === null) {
        malformed = true;
        break;
      }
      values.push(value);
      total += value;
    }
    const own = values[tokenIndex];
    if (malformed || total !== SCALE || own === undefined) {
      continue;
    }
    return labelFromShare(own);
  }
  return null;
}

/** A single winning outcome index: the indexed token wins, every other loses. */
function labelFromWinningIndex(
  record: Record<string, unknown>,
  tokenIndex: number,
): string | null {
  for (const key of WINNER_INDEX_KEYS) {
    const raw = record[key];
    const value =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && /^\d+$/.test(raw.trim())
          ? Number(raw.trim())
          : Number.NaN;
    if (!Number.isSafeInteger(value) || value < 0) {
      continue;
    }
    return value === tokenIndex ? LABEL_ONE : LABEL_ZERO;
  }
  return null;
}

/**
 * The venue nests the raw payload under `raw` when the UMA status poller
 * records a transition, and delivers it flat on the WS `market_resolved`
 * event. Both shapes are inspected, in that order; nothing deeper is, so a
 * stray key buried in an unrelated sub-object can never decide a label.
 */
function candidateRecords(payload: unknown): Record<string, unknown>[] {
  const root = toRecord(payload);
  if (root === null) {
    return [];
  }
  const records = [root];
  const raw = toRecord(root.raw);
  if (raw !== null) {
    records.push(raw);
  }
  return records;
}

/** Outcome as {0, 0.5, 1} from a resolution payload, or null when undecidable. */
export function parseOutcomeLabel(
  payload: unknown,
  tokenIndex: number,
): string | null {
  if (!Number.isSafeInteger(tokenIndex) || tokenIndex < 0) {
    return null;
  }
  for (const record of candidateRecords(payload)) {
    const fromPayouts = labelFromPayouts(record, tokenIndex);
    if (fromPayouts !== null) {
      return fromPayouts;
    }
    const fromPrices = labelFromOutcomePrices(record, tokenIndex);
    if (fromPrices !== null) {
      return fromPrices;
    }
    const fromWinner = labelFromWinningIndex(record, tokenIndex);
    if (fromWinner !== null) {
      return fromWinner;
    }
  }
  return null;
}

function validDate(value: Date | null): Date | null {
  return value !== null && !Number.isNaN(value.getTime()) ? value : null;
}

/** Instant at which the outcome became PUBLICLY KNOWABLE — the only timestamp
 *  honest metrics may index on. Never the on-chain resolution instant. */
export function publiclyKnowableInstant(input: {
  readonly endDate: Date | null;
  readonly proposedAt: Date | null;
  readonly resolvedAt: Date | null;
}): Date | null {
  // The proposer only acts once the outcome is public, and the market's end
  // date is published in the rules, so both are upper bounds on the moment the
  // world learned the answer: the EARLIEST of them is the honest instant.
  //
  // `input.resolvedAt` is accepted and deliberately ignored. The on-chain
  // resolution lands one UMA liveness window (hours to days) after the outcome
  // was public; indexing metrics on it would credit a model for "predicting"
  // something everybody already knew. It is stored in its own column instead.
  const candidates: Date[] = [];
  const endDate = validDate(input.endDate);
  if (endDate !== null) {
    candidates.push(endDate);
  }
  const proposedAt = validDate(input.proposedAt);
  if (proposedAt !== null) {
    candidates.push(proposedAt);
  }
  const earliest = candidates.reduce<Date | null>(
    (best, candidate) =>
      best === null || candidate.getTime() < best.getTime() ? candidate : best,
    null,
  );
  return earliest;
}

/** A per-observation degeneracy test: the market price at the decision instant
 *  was already >0.99 or <0.01. Headline metrics exclude these. */
export function isDegenerate(baselineQ: number): boolean {
  // Including degenerate markets inflates the skill score (BSS 0.231 -> 0.428
  // in the published 24h study), so they are excluded from the headline and
  // reported only as an annex. A non-finite baseline is not a price at all and
  // is excluded on the same conservative grounds.
  if (!Number.isFinite(baselineQ)) {
    return true;
  }
  return baselineQ > 0.99 || baselineQ < 0.01;
}

export interface LabelSyncDeps {
  readonly pool: QueryPool;
  readonly clock?: () => Date;
  readonly lookbackMs?: number;
}

/**
 * Counters of one sync run. Every counter is per PROSPECTIVE LABEL ROW — one
 * per token of the market — so `inserted + updated + skipped* + unchanged`
 * describes the same population.
 */
export interface LabelSyncReport {
  readonly inserted: number;
  readonly updated: number;
  /** Resolution not final yet (open UMA dispute, or proposal in liveness). */
  readonly skippedNotFinal: number;
  /** Final resolution whose payload does not decide this token's outcome. */
  readonly skippedUnparsable: number;
}

interface TimelineEvent {
  readonly eventId: number;
  readonly eventType: string;
  readonly payload: unknown;
  readonly sourceTs: Date | null;
  /** COALESCE(source_ts, received_at): the instant the event is ordered by. */
  readonly effectiveTs: Date | null;
}

interface MarketRow {
  readonly category: string;
  readonly tokenIds: readonly string[];
  readonly endDate: Date | null;
}

function effectiveTime(event: TimelineEvent): number {
  return event.effectiveTs === null ? 0 : event.effectiveTs.getTime();
}

/**
 * Label category: the model category when Gamma's category maps to one (the
 * gate counts "100 resolved markets in THIS category"), and Gamma's own
 * category otherwise, so the store stays a complete resolved-market history
 * instead of silently dropping everything no model owns.
 */
function labelCategory(gammaCategory: string | null): string {
  const modelCategory = gammaCategoryToModelCategory(gammaCategory);
  if (modelCategory !== null) {
    return modelCategory;
  }
  return gammaCategory === null || gammaCategory === ""
    ? "uncategorized"
    : gammaCategory;
}

async function loadTimelines(
  pool: QueryPool,
  since: Date,
): Promise<Map<string, TimelineEvent[]>> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT resolution_event_id, condition_id, event_type, payload_json,
            source_ts, received_at
       FROM polymarket_resolution_events
      WHERE event_type = ANY($1::text[])
        AND COALESCE(source_ts, received_at) >= $2
      ORDER BY condition_id ASC, COALESCE(source_ts, received_at) ASC,
               resolution_event_id ASC`,
    [[...TIMELINE_EVENT_TYPES], since],
  );
  const timelines = new Map<string, TimelineEvent[]>();
  for (const row of result.rows) {
    const conditionId = String(row.condition_id);
    const sourceTs = toDate(row.source_ts);
    const events = timelines.get(conditionId) ?? [];
    events.push({
      eventId: Number(row.resolution_event_id),
      eventType: String(row.event_type),
      payload: row.payload_json,
      sourceTs,
      effectiveTs: sourceTs ?? toDate(row.received_at),
    });
    timelines.set(conditionId, events);
  }
  // Re-establish the ordering in memory: the timeline logic reads position
  // (last dispute, newest resolution), so it must not depend on the driver
  // preserving the server's ORDER BY.
  for (const events of timelines.values()) {
    events.sort(
      (left, right) =>
        effectiveTime(left) - effectiveTime(right) ||
        left.eventId - right.eventId,
    );
  }
  return timelines;
}

/**
 * Static registry metadata of the resolved markets. Deliberately NOT the
 * as-of feature loader: labels describe what happened after the decision, so
 * there is no decision instant to join as-of, and only three columns matter.
 */
async function loadMarketRows(
  pool: QueryPool,
  conditionIds: readonly string[],
): Promise<Map<string, MarketRow>> {
  const markets = new Map<string, MarketRow>();
  if (conditionIds.length === 0) {
    return markets;
  }
  const result = await pool.query<Record<string, unknown>>(
    `SELECT condition_id, category, clob_token_ids, end_date_iso
       FROM polymarket_markets
      WHERE condition_id = ANY($1::text[])`,
    [[...conditionIds]],
  );
  for (const row of result.rows) {
    markets.set(String(row.condition_id), {
      category: labelCategory(
        typeof row.category === "string" ? row.category : null,
      ),
      tokenIds: toStringArray(row.clob_token_ids),
      endDate: toDate(row.end_date_iso),
    });
  }
  return markets;
}

/**
 * Resolve a `winning_asset_id` (the WS `market_resolved` encoding) into the
 * token index `parseOutcomeLabel` speaks. The mapping needs the market's token
 * list, which only the sync has, so it happens here and the parser stays a
 * pure index-addressed function.
 */
function normalizePayload(
  payload: unknown,
  conditionId: string,
  tokenIds: readonly string[],
): unknown {
  const record = toRecord(payload);
  if (record === null) {
    return payload;
  }
  for (const source of candidateRecords(record)) {
    for (const key of WINNING_ASSET_KEYS) {
      const value = source[key];
      if (typeof value !== "string" || value === "") {
        continue;
      }
      const index = tokenIds.indexOf(value);
      if (index < 0) {
        log(
          "warn",
          "LABEL_WINNING_TOKEN_UNKNOWN",
          "polymarket_label_winning_token_unknown",
          { condition_id: conditionId },
        );
        return payload;
      }
      return { ...record, winningOutcomeIndex: index };
    }
  }
  return payload;
}

interface UpsertInput {
  readonly tokenId: string;
  readonly conditionId: string;
  readonly category: string;
  readonly label: string;
  readonly publiclyKnowableTs: Date | null;
  readonly onchainResolutionTs: Date | null;
  readonly disputed: boolean;
  readonly payload: unknown;
  readonly sourceTs: Date | null;
  readonly now: Date;
}

/**
 * Idempotent upsert. DO UPDATE only fires when a meaningful column actually
 * changed (`updated_at` is excluded from the comparison on purpose, otherwise
 * every run would rewrite every row), and `received_at` keeps the first-seen
 * local clock. `xmax = 0` distinguishes the insert from the update; an
 * unchanged row returns no row at all.
 */
async function upsertLabel(
  pool: QueryPool,
  input: UpsertInput,
): Promise<"inserted" | "updated" | "unchanged"> {
  const result = await pool.query<{ inserted: boolean }>(
    `INSERT INTO fundamental_labels
       (token_id, condition_id, category, label, publicly_knowable_ts,
        onchain_resolution_ts, disputed, is_final, provenance, payload_json,
        source_ts, received_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, 'resolution_events', $8::jsonb,
             $9, $10, $10)
     ON CONFLICT (token_id) DO UPDATE
        SET condition_id = EXCLUDED.condition_id,
            category = EXCLUDED.category,
            label = EXCLUDED.label,
            publicly_knowable_ts = EXCLUDED.publicly_knowable_ts,
            onchain_resolution_ts = EXCLUDED.onchain_resolution_ts,
            disputed = EXCLUDED.disputed,
            is_final = EXCLUDED.is_final,
            provenance = EXCLUDED.provenance,
            payload_json = EXCLUDED.payload_json,
            source_ts = EXCLUDED.source_ts,
            updated_at = EXCLUDED.updated_at
      WHERE fundamental_labels.condition_id IS DISTINCT FROM EXCLUDED.condition_id
         OR fundamental_labels.category IS DISTINCT FROM EXCLUDED.category
         OR fundamental_labels.label IS DISTINCT FROM EXCLUDED.label
         OR fundamental_labels.publicly_knowable_ts IS DISTINCT FROM EXCLUDED.publicly_knowable_ts
         OR fundamental_labels.onchain_resolution_ts IS DISTINCT FROM EXCLUDED.onchain_resolution_ts
         OR fundamental_labels.disputed IS DISTINCT FROM EXCLUDED.disputed
         OR fundamental_labels.is_final IS DISTINCT FROM EXCLUDED.is_final
         OR fundamental_labels.provenance IS DISTINCT FROM EXCLUDED.provenance
         OR fundamental_labels.payload_json IS DISTINCT FROM EXCLUDED.payload_json
         OR fundamental_labels.source_ts IS DISTINCT FROM EXCLUDED.source_ts
     RETURNING (xmax = 0) AS inserted`,
    [
      input.tokenId,
      input.conditionId,
      input.category,
      input.label,
      input.publiclyKnowableTs,
      input.onchainResolutionTs,
      input.disputed,
      JSON.stringify(input.payload ?? {}),
      input.sourceTs,
      input.now,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return "unchanged";
  }
  return row.inserted === true ? "inserted" : "updated";
}

/**
 * Backfill/refresh `fundamental_labels` from the recorded resolution timeline.
 * Never throws: a supervised job keeps running, and every anomaly is one line
 * of JSON on stderr with a stable reason code.
 */
export async function syncLabels(
  deps: LabelSyncDeps,
): Promise<LabelSyncReport> {
  const clock = deps.clock ?? ((): Date => new Date());
  const lookbackMs = deps.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const now = clock();
  const since = new Date(now.getTime() - lookbackMs);

  let inserted = 0;
  let updated = 0;
  let skippedNotFinal = 0;
  let skippedUnparsable = 0;

  let timelines: Map<string, TimelineEvent[]>;
  let markets: Map<string, MarketRow>;
  try {
    timelines = await loadTimelines(deps.pool, since);
    markets = await loadMarketRows(deps.pool, [...timelines.keys()]);
  } catch (error: unknown) {
    log(
      "error",
      "LABEL_SYNC_READ_FAILED",
      "polymarket_label_sync_read_failed",
      {
        error_name: error instanceof Error ? error.name : "UnknownError",
      },
    );
    return { inserted, updated, skippedNotFinal, skippedUnparsable };
  }

  for (const [conditionId, timeline] of timelines) {
    const market = markets.get(conditionId);
    if (market === undefined) {
      // The registry has not caught up with the resolution feed; the next run
      // picks the market up, so this is reported and not counted as a skip.
      log(
        "warn",
        "LABEL_MARKET_NOT_FOUND",
        "polymarket_label_market_not_found",
        {
          condition_id: conditionId,
        },
      );
      continue;
    }
    if (market.tokenIds.length === 0) {
      log("warn", "LABEL_TOKENS_MISSING", "polymarket_label_tokens_missing", {
        condition_id: conditionId,
      });
      continue;
    }

    let lastDisputeIndex = -1;
    for (let index = 0; index < timeline.length; index += 1) {
      if (timeline[index]?.eventType === "disputed") {
        lastDisputeIndex = index;
      }
    }
    const disputed = lastDisputeIndex >= 0;
    // Only resolutions AFTER the last dispute are final: a resolution that a
    // dispute later challenged is exactly the value this store must not use.
    const resolving = timeline.filter(
      (event, index) =>
        index > lastDisputeIndex && RESOLVING_EVENT_TYPES.has(event.eventType),
    );
    const finalEvent = resolving[resolving.length - 1];
    if (finalEvent === undefined) {
      skippedNotFinal += market.tokenIds.length;
      if (disputed) {
        log(
          "warn",
          "LABEL_RESOLUTION_NOT_FINAL",
          "polymarket_label_resolution_not_final",
          { condition_id: conditionId, tokens: market.tokenIds.length },
        );
      }
      continue;
    }

    // Earliest UMA proposal, by SOURCE_TS only: `received_at` is our ingest
    // clock and can only be later than the real proposal, so accepting it
    // would push the "knowable" instant forward and let a decision taken after
    // the outcome was public count as a legitimate prediction. When the venue
    // gave us no source_ts the end date carries the instant, or it stays null.
    //
    // For a disputed market the first proposal may have asserted the WRONG
    // outcome, so its instant is a lower bound only — another reason disputed
    // markets are excluded from the headline and analysed on their own.
    let proposedAt: Date | null = null;
    for (const event of timeline) {
      if (event.eventType !== "proposed") {
        continue;
      }
      // RFC-007's UMA poller has no emitter clock to copy, so it stores the
      // transition with a NULL source_ts. Falling back to `received_at` keeps
      // the proposal instant usable: it is later than the true one, so it
      // remains a valid UPPER bound on when the outcome became knowable, and
      // it is usually far earlier than the market's end date.
      const proposalTs = event.effectiveTs;
      if (proposalTs === null) {
        continue;
      }
      if (proposedAt === null || proposalTs.getTime() < proposedAt.getTime()) {
        proposedAt = proposalTs;
      }
    }
    const onchainResolutionTs = finalEvent.effectiveTs;
    const publiclyKnowableTs = publiclyKnowableInstant({
      endDate: market.endDate,
      proposedAt,
      resolvedAt: onchainResolutionTs,
    });
    if (publiclyKnowableTs === null) {
      log(
        "warn",
        "LABEL_KNOWABLE_TS_UNKNOWN",
        "polymarket_label_knowable_ts_unknown",
        { condition_id: conditionId },
      );
    }

    // Normalize once per event, not once per token: the UMA poller's own
    // 'resolved' payload carries a status transition and no outcome, so the
    // outcome usually comes from the WS `market_resolved` row in the same
    // timeline. Newest resolution first.
    const evidence = resolving
      .map((event) => ({
        event,
        payload: normalizePayload(event.payload, conditionId, market.tokenIds),
      }))
      .reverse();

    for (let index = 0; index < market.tokenIds.length; index += 1) {
      const tokenId = market.tokenIds[index];
      if (tokenId === undefined || tokenId === "") {
        continue;
      }
      const decided = evidence
        .map((candidate) => ({
          candidate,
          label: parseOutcomeLabel(candidate.payload, index),
        }))
        .find((entry) => entry.label !== null);
      if (decided === undefined || decided.label === null) {
        skippedUnparsable += 1;
        log(
          "warn",
          "LABEL_OUTCOME_UNPARSABLE",
          "polymarket_label_outcome_unparsable",
          {
            condition_id: conditionId,
            token_index: index,
            event_type: finalEvent.eventType,
          },
        );
        continue;
      }
      try {
        const outcome = await upsertLabel(deps.pool, {
          tokenId,
          conditionId,
          category: market.category,
          label: decided.label,
          publiclyKnowableTs,
          onchainResolutionTs,
          disputed,
          payload: {
            event_type: decided.candidate.event.eventType,
            token_index: index,
            event_source_ts:
              decided.candidate.event.sourceTs === null
                ? null
                : decided.candidate.event.sourceTs.toISOString(),
            payload: decided.candidate.event.payload,
          },
          sourceTs: decided.candidate.event.sourceTs,
          now,
        });
        if (outcome === "inserted") {
          inserted += 1;
        } else if (outcome === "updated") {
          updated += 1;
        }
      } catch (error: unknown) {
        log("error", "LABEL_UPSERT_FAILED", "polymarket_label_upsert_failed", {
          condition_id: conditionId,
          token_index: index,
          error_name: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
  }

  return { inserted, updated, skippedNotFinal, skippedUnparsable };
}

/**
 * Read final labels back. `from` is inclusive and `to` is EXCLUSIVE, so
 * adjacent walk-forward windows can never count the same resolution twice.
 * Disputed markets are excluded unless asked for (headline vs separate
 * analysis). Rows with a null knowable instant are returned only when no time
 * bound is given — a bounded query cannot place them, and callers computing
 * metrics must exclude them explicitly.
 *
 * Unlike `syncLabels` this DOES propagate a database failure: a metric
 * computed over a silently truncated label set is worse than no metric.
 */
export async function loadLabels(
  pool: QueryPool,
  options: {
    readonly category?: string;
    readonly from?: Date;
    readonly to?: Date;
    readonly includeDisputed?: boolean;
  },
): Promise<LabelRecord[]> {
  const conditions: string[] = ["is_final = TRUE"];
  const params: unknown[] = [];
  if (options.category !== undefined) {
    params.push(options.category);
    conditions.push(`category = $${params.length}`);
  }
  if (options.from !== undefined) {
    params.push(options.from);
    conditions.push(`publicly_knowable_ts >= $${params.length}`);
  }
  if (options.to !== undefined) {
    params.push(options.to);
    conditions.push(`publicly_knowable_ts < $${params.length}`);
  }
  if (options.includeDisputed !== true) {
    conditions.push("disputed = FALSE");
  }
  const result = await pool.query<Record<string, unknown>>(
    `SELECT token_id, condition_id, category, label, publicly_knowable_ts,
            onchain_resolution_ts, disputed, is_final
       FROM fundamental_labels
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY publicly_knowable_ts ASC NULLS LAST, token_id ASC`,
    params,
  );
  return result.rows.map((row) => ({
    tokenId: String(row.token_id),
    conditionId: String(row.condition_id),
    category: String(row.category),
    label: String(row.label),
    publiclyKnowableTs: toDate(row.publicly_knowable_ts),
    onchainResolutionTs: toDate(row.onchain_resolution_ts),
    disputed: row.disputed === true,
    isFinal: row.is_final === true,
  }));
}
