// RFC-013 persistence for the exit cycle and the circuit breakers.
//
// Split from store.ts, which owns the entry path, because these are different
// questions over different tables: "what do we hold, and what has changed since
// we opened it?" instead of "what could we enter now?". Keeping them apart keeps
// either file reviewable.
//
// Everything here is read-only over the RFC-007/010/011/012 tables and writes
// only to `portfolio_circuit_breakers`. The paper broker's tables are never
// written by this module — positions belong to the RFC-011 ledger.

import { parseScaled, SCALE } from "../fundamental/fixed.js";
import type {
  BreakerScope,
  BreakerSignal,
  OpenBreakerRow,
} from "./breakers.js";
import { money } from "./ev.js";
import type { BreakerKind, MarketSide, PortfolioPool } from "./types.js";
import { BREAKER_KINDS } from "./types.js";

/** How much of a rule's text the panel carries. Bounded for the disk quota. */
export const RULE_EXCERPT_MAX_CHARS = 240;

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function date(value: unknown): Date | null {
  return value instanceof Date ? value : null;
}

function integer(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** A jsonb object column as a plain record, or null for anything else. */
function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** One open paper position, joined to what the exit cycle needs to judge it. */
export interface OpenPositionRow {
  readonly tokenId: string;
  readonly conditionId: string;
  readonly sharesScaled: bigint;
  readonly costScaled: bigint;
  readonly openedAt: Date | null;
  readonly category: string | null;
  readonly question: string;
  readonly negRisk: boolean;
  readonly eventId: string | null;
  /**
   * The resolution source of the rule version in force — the adapter when
   * Gamma names nothing. This is what the exit's "source changed" criterion
   * compares against the entry; the exposure cap is keyed on the rule CLAUSE
   * instead (RFC-018 D2), and the two must not be collapsed: a source that
   * moves inside one clause family still has to fire that criterion.
   */
  readonly resolutionSource: string | null;
  /** Rule text of the version in force, for the clause-family bucket key. */
  readonly ruleDescription: string | null;
  readonly endDate: Date | null;
  readonly ruleVersion: number | null;
  readonly paramVersion: number | null;
  /** The market's affirmative token, so the leg held can be named. */
  readonly affirmativeTokenId: string | null;
  readonly unresolved: boolean;
}

/**
 * Every open paper position with the metadata the exposure dimensions and the
 * exit criteria both need.
 *
 * Read from `paper_positions`, which the RFC-011 ledger derives. This module
 * never writes there: a position is the broker's fact, and the portfolio engine
 * only ever has an opinion about it.
 */
export async function loadOpenPositions(
  pool: PortfolioPool,
): Promise<OpenPositionRow[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT p.token_id, p.condition_id, p.shares, p.cost_usd, p.opened_at,
            p.resolved_at,
            meta.category, meta.question, meta.affirmative_token_id,
            COALESCE(par.neg_risk, FALSE) AS neg_risk,
            par.version AS param_version,
            ev.event_id,
            COALESCE(r.resolution_source, r.resolved_by) AS resolution_source,
            r.description AS rule_description,
            r.end_date,
            r.version AS rule_version
       FROM paper_positions p
       LEFT JOIN LATERAL (
         SELECT question, category, affirmative_token_id
           FROM polymarket_market_metadata_versions v
          WHERE v.condition_id = p.condition_id AND v.valid_to IS NULL
          ORDER BY v.version DESC LIMIT 1
       ) meta ON TRUE
       LEFT JOIN LATERAL (
         SELECT version, neg_risk FROM polymarket_param_versions pv
          WHERE pv.condition_id = p.condition_id AND pv.valid_to IS NULL
          ORDER BY pv.version DESC LIMIT 1
       ) par ON TRUE
       LEFT JOIN LATERAL (
         SELECT version, resolution_source, resolved_by, end_date, description
           FROM polymarket_rule_versions rv
          WHERE rv.condition_id = p.condition_id AND rv.valid_to IS NULL
          ORDER BY rv.version DESC LIMIT 1
       ) r ON TRUE
       LEFT JOIN LATERAL (
         SELECT event_id FROM polymarket_event_markets em
          WHERE em.condition_id = p.condition_id ORDER BY em.event_id LIMIT 1
       ) ev ON TRUE
      WHERE p.shares <> '0'
      ORDER BY p.token_id`,
  );
  return result.rows.map((row) => ({
    tokenId: String(row.token_id ?? ""),
    conditionId: String(row.condition_id ?? ""),
    sharesScaled: parseScaled(String(row.shares ?? "0")) ?? 0n,
    costScaled: parseScaled(String(row.cost_usd ?? "0")) ?? 0n,
    openedAt: date(row.opened_at),
    category: text(row.category),
    question: String(row.question ?? ""),
    negRisk: row.neg_risk === true,
    eventId: text(row.event_id),
    resolutionSource: text(row.resolution_source),
    ruleDescription: text(row.rule_description),
    endDate: date(row.end_date),
    ruleVersion: integer(row.rule_version),
    paramVersion: integer(row.param_version),
    affirmativeTokenId: text(row.affirmative_token_id),
    unresolved: row.resolved_at === null || row.resolved_at === undefined,
  }));
}

/** Realized and unrealized PnL of the paper book, for the state machine. */
export interface PaperPnl {
  /** Realized PnL over the whole book, exact: the ledger's own total. */
  readonly realizedTotalScaled: bigint;
  /** Realized PnL attributed to the current UTC day. */
  readonly realizedDayScaled: bigint;
  /** Realized PnL attributed to the current UTC week. */
  readonly realizedWeekScaled: bigint;
  /** Cost basis of unresolved positions. */
  readonly openCostScaled: bigint;
  /**
   * Mark of unresolved positions, to the executable bid. A position whose mark
   * is missing or flagged stale contributes its COST instead, so an absent mark
   * can never credit an unrealized gain.
   */
  readonly openMarkScaled: bigint;
  readonly positionsWithStaleMark: number;
}

/**
 * The PnL the state machine measures its limits against.
 *
 * The total is exact — `realized_pnl_usd` is what the RFC-011 ledger derived.
 * The DAY and WEEK figures attribute each position's realized total to its
 * `resolved_at`, which is the only per-position realization instant the broker's
 * table carries.
 *
 * The consequence, stated because it matters: realization from closing a
 * position EARLY (selling before resolution) is not attributed to the day it
 * happened — it lands when the token finally resolves. So the daily and weekly
 * loss limits can trigger LATE for a book that trades out of positions instead
 * of holding them to settlement. Attributing it correctly would mean replaying
 * the RFC-011 ledger event by event, which is that module's job and not this
 * one's; `updated_at` is not a substitute, because a mark refresh moves it and
 * would re-attribute an old loss to today on every cycle.
 */
export async function loadPaperPnl(pool: PortfolioPool): Promise<PaperPnl> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT
       COALESCE(sum(realized_pnl_usd::numeric), 0) AS realized_total,
       COALESCE(sum(CASE
         WHEN resolved_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
           THEN realized_pnl_usd::numeric ELSE 0 END), 0) AS realized_day,
       COALESCE(sum(CASE
         WHEN resolved_at >= date_trunc('week', now() AT TIME ZONE 'UTC')
           THEN realized_pnl_usd::numeric ELSE 0 END), 0) AS realized_week,
       COALESCE(sum(CASE
         WHEN resolved_at IS NULL THEN cost_usd::numeric ELSE 0 END), 0)
         AS open_cost,
       COALESCE(sum(CASE
         WHEN resolved_at IS NULL
              AND mark_value_usd IS NOT NULL
              AND mark_stale IS NOT TRUE
           THEN mark_value_usd::numeric
         WHEN resolved_at IS NULL THEN cost_usd::numeric
         ELSE 0 END), 0) AS open_mark,
       count(*) FILTER (
         WHERE resolved_at IS NULL
           AND (mark_value_usd IS NULL OR mark_stale IS TRUE)
       ) AS stale_marks
       FROM paper_positions
      WHERE shares <> '0' OR resolved_at IS NOT NULL`,
  );
  const row = result.rows[0] ?? {};
  const scaled = (value: unknown): bigint => parseScaled(numeric(value)) ?? 0n;
  return {
    realizedTotalScaled: scaled(row.realized_total),
    realizedDayScaled: scaled(row.realized_day),
    realizedWeekScaled: scaled(row.realized_week),
    openCostScaled: scaled(row.open_cost),
    openMarkScaled: scaled(row.open_mark),
    positionsWithStaleMark: Number(row.stale_marks ?? 0),
  };
}

/**
 * PostgreSQL `numeric` arrives as a string that may carry more than the nine
 * fraction digits the working scale accepts, which `parseScaled` refuses. Money
 * is truncated to the working scale rather than rounded: the direction that
 * cannot invent a cent.
 */
function numeric(value: unknown): string {
  const raw = value === null || value === undefined ? "0" : String(value);
  const match = /^(-?\d+)(?:\.(\d*))?$/.exec(raw.trim());
  if (match === null) {
    return "0";
  }
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").slice(0, 9);
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

/** Which leg of the market a position token is. */
export function positionSide(row: OpenPositionRow): MarketSide {
  return row.affirmativeTokenId === null ||
    row.affirmativeTokenId === row.tokenId
    ? "YES"
    : "NO";
}

/** The entry that opened a position, read back from the decision log. */
export interface EntryProvenance {
  readonly decisionId: number;
  readonly decisionTs: Date;
  readonly marketSide: MarketSide;
  readonly qLo: string | null;
  readonly qHi: string | null;
  readonly ruleVersion: number | null;
  readonly resolutionSource: string | null;
  readonly rulePrecisionScaled: bigint | null;
  readonly invalidationProbLowerBelowScaled: bigint | null;
}

/**
 * The newest entry provenance for a token: what the ENTRY committed to.
 *
 * The invalidation condition and the rule-precision multiplier are read out of
 * what was RECORDED rather than recomputed: the point of monitoring an
 * invalidation is to compare today against what the entry committed to, and
 * recomputing it from today's data would compare today against itself.
 *
 * Two sources, in this order:
 *
 * 1. `portfolio_position_entries`, written by the bridge stamp when the order
 *    was accepted. Never pruned.
 * 2. the decision log, for entries that predate the bridge.
 *
 * The order is not a preference, it is a correctness requirement. The decision
 * log has a TTL of months but a quota that binds in about three days, so reading
 * it alone meant that a position held longer than that came back with every
 * field null — and four of the seven exit criteria default to "we do not know
 * that it moved" on null, so they stopped being able to fire. Honest for a row
 * that never existed; silent degeneration for one that retention removed.
 */
export async function entryProvenanceFor(
  pool: PortfolioPool,
  tokenId: string,
): Promise<EntryProvenance | null> {
  const stamped = await pool.query<Record<string, unknown>>(
    `SELECT decision_id, entry_decision_ts AS decision_ts, market_side, q_lo,
            q_hi, rule_version, resolution_source,
            rule_precision AS rule_precision_multiplier,
            invalidation_prob_lower_below
       FROM portfolio_position_entries
      WHERE token_id = $1
      ORDER BY entry_decision_ts DESC, decision_id DESC
      LIMIT 1`,
    [tokenId],
  );
  const stampedRow = stamped.rows[0];
  if (stampedRow !== undefined) {
    return parseEntryProvenance(stampedRow);
  }
  const result = await pool.query<Record<string, unknown>>(
    `SELECT decision_id, decision_ts, market_side, q_lo, q_hi, rule_version,
            inputs_json #>> '{panel,resolution_source}' AS resolution_source,
            inputs_json #>> '{panel,invalidation,prob_lower_below}'
              AS invalidation_prob_lower_below,
            inputs_json #>> '{replay,rule_precision_multiplier}'
              AS rule_precision_multiplier
       FROM portfolio_decisions
      WHERE token_id = $1
        AND decision_kind = 'ENTRY'
        AND outcome = 'ACCEPTED'
      ORDER BY decision_ts DESC
      LIMIT 1`,
    [tokenId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  return parseEntryProvenance(row);
}

/** Same shape from either source; the column names are aliased to match. */
function parseEntryProvenance(row: Record<string, unknown>): EntryProvenance {
  const precisionText = text(row.rule_precision_multiplier);
  const precision =
    precisionText === null ? null : Number.parseFloat(precisionText);
  return {
    decisionId: Number(row.decision_id ?? 0),
    decisionTs: date(row.decision_ts) ?? new Date(0),
    marketSide: String(row.market_side) === "NO" ? "NO" : "YES",
    qLo: text(row.q_lo),
    qHi: text(row.q_hi),
    ruleVersion: integer(row.rule_version),
    resolutionSource: text(row.resolution_source),
    rulePrecisionScaled:
      precision === null || !Number.isFinite(precision)
        ? null
        : BigInt(Math.round(precision * Number(SCALE))),
    invalidationProbLowerBelowScaled: parseOrNull(
      text(row.invalidation_prob_lower_below),
    ),
  };
}

function parseOrNull(value: string | null): bigint | null {
  return value === null ? null : parseScaled(value);
}

/**
 * Signature of the newest exit evaluation for a token, or null when none.
 *
 * The exit cycle writes a decision only when the verdict CHANGES. Without that,
 * a position held for a week at a 30-second cadence would write twenty thousand
 * identical rows and bury the moment the verdict actually moved.
 */
export async function lastExitSignature(
  pool: PortfolioPool,
  tokenId: string,
): Promise<string | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT inputs_json #>> '{exit,signature}' AS signature
       FROM portfolio_decisions
      WHERE token_id = $1 AND decision_kind = 'EXIT'
      ORDER BY decision_ts DESC
      LIMIT 1`,
    [tokenId],
  );
  return text(result.rows[0]?.signature);
}

/** Market state the breakers and the exit criteria both read. */
export interface MarketChangeState {
  /** Newest MATERIAL clarification instant, or null. */
  readonly clarifiedAt: Date | null;
  /**
   * RFC-025 D1: `valid_from` of the newest parameter version that changed a
   * cost the EV actually reads, from a NON-NULL value to a DIFFERENT non-null
   * value. Null when no such version exists.
   *
   * This used to be `max(valid_from)` — the newest version, whatever it was —
   * and that made a market's BIRTH look like a venue parameter change. Version 1
   * has nothing to be compared against, and the collector's late fill of
   * `fee_base_bps` (`NULL -> 1000`, ~40 min after version 1) is a gap in our own
   * recording, not a change at the venue. Together those two were 92.4% of the
   * 1 661 `PARAM_CHANGE` ever opened, and they froze every hourly market for its
   * entire life: 50 of 50 "Up or Down" markets discovered in 24 h had their FIRST
   * entry decision refused by this breaker.
   */
  readonly paramChangedAt: Date | null;
  /**
   * Which fields changed at that version, so the breaker can say WHY it opened
   * and the count is auditable by field rather than by guess.
   */
  readonly paramChangedFields: readonly string[];
  /** `version` of that parameter version, or null. */
  readonly paramChangedVersion: number | null;
  /** Previous and new values, keyed by field — only the fields that changed. */
  readonly paramChangedFrom: Readonly<Record<string, unknown>> | null;
  readonly paramChangedTo: Readonly<Record<string, unknown>> | null;
  /** Rule-precision multiplier in [0, 1] from the RFC-012 score, scaled. */
  readonly rulePrecisionScaled: bigint | null;
}

export const NO_MARKET_CHANGE: MarketChangeState = Object.freeze({
  clarifiedAt: null,
  paramChangedAt: null,
  paramChangedFields: Object.freeze([]),
  paramChangedVersion: null,
  paramChangedFrom: null,
  paramChangedTo: null,
  rulePrecisionScaled: null,
});

/**
 * The parameters whose change is a reason to re-price, and nothing else.
 *
 * `fee_base_bps` is in the list because `store.ts:85` reads it AS the taker fee
 * whenever `taker_fee_bps` is NULL (`COALESCE(p.taker_fee_bps, p.fee_base_bps)`)
 * — leaving it out would ignore a real change in the very field the engine used.
 * `maker_fee_bps`, `min_order_size` and `neg_risk` are NOT in it: they never
 * enter the EV (`store.ts:83-85`) and have never once changed.
 */
export const PARAM_CHANGE_FIELDS = Object.freeze([
  "taker_fee_bps",
  "fee_curve_json",
  "tick_size",
  "fee_base_bps",
] as const);

/**
 * Clarifications, parameter changes and the rule-precision multiplier, for a
 * whole batch of markets in one query.
 *
 * Batched deliberately. The panel cycle evaluates the entire eligible universe
 * — 98 markets when this was written — and asking these three questions one
 * market at a time would be three hundred round trips a minute for data that
 * one grouped scan answers.
 *
 * The multiplier is `1 - rule_precision.value`: the RFC-012 score records the
 * RISK contribution of imprecise rules, and what the sizing needs is the
 * complementary confidence. Reading the score's own feature rather than
 * re-deriving it keeps one definition of rule precision in the repository.
 */
export async function loadMarketChangeStates(
  pool: PortfolioPool,
  conditionIds: readonly string[],
): Promise<Map<string, MarketChangeState>> {
  const out = new Map<string, MarketChangeState>();
  if (conditionIds.length === 0) {
    return out;
  }
  const ids = [...new Set(conditionIds)];
  const result = await pool.query<Record<string, unknown>>(
    // The parameter half is RFC-025 D1: `lag()` over the version series, then
    // the NEWEST version whose diff against its predecessor moved at least one
    // EV-bearing field from a non-null value to a different non-null value.
    //
    //   * `version = 1` is excluded because `lag()` gives it no predecessor: a
    //     market entering the recorder is not the venue changing anything.
    //   * `NULL -> value` is excluded by requiring the previous value to be NOT
    //     NULL: that is the collector filling a gap in our own recording.
    //   * `value -> NULL` is excluded by requiring the new value to be NOT NULL:
    //     losing a datum is a finding for the data-quality surface, not a reason
    //     to freeze a market.
    //
    // `DISTINCT ON ... ORDER BY version DESC` is what makes it the newest such
    // version; `valid_from` would order the same way but `version` is the column
    // with the UNIQUE constraint, so it cannot tie.
    `WITH v AS (
       SELECT pv.condition_id, pv.version, pv.valid_from,
              pv.taker_fee_bps, pv.fee_curve_json, pv.tick_size, pv.fee_base_bps,
              lag(pv.taker_fee_bps)  OVER w AS p_taker,
              lag(pv.fee_curve_json) OVER w AS p_curve,
              lag(pv.tick_size)      OVER w AS p_tick,
              lag(pv.fee_base_bps)   OVER w AS p_base
         FROM polymarket_param_versions pv
        WHERE pv.condition_id = ANY($1::text[])
       WINDOW w AS (PARTITION BY pv.condition_id ORDER BY pv.version)
     ),
     diffed AS (
       SELECT v.condition_id, v.version, v.valid_from,
              (v.p_taker IS NOT NULL AND v.taker_fee_bps IS NOT NULL
                 AND v.taker_fee_bps <> v.p_taker)      AS d_taker,
              (v.p_curve IS NOT NULL AND v.fee_curve_json IS NOT NULL
                 AND v.fee_curve_json <> v.p_curve)     AS d_curve,
              (v.p_tick IS NOT NULL AND v.tick_size IS NOT NULL
                 AND v.tick_size <> v.p_tick)           AS d_tick,
              (v.p_base IS NOT NULL AND v.fee_base_bps IS NOT NULL
                 AND v.fee_base_bps <> v.p_base)        AS d_base,
              v.taker_fee_bps, v.fee_curve_json, v.tick_size, v.fee_base_bps,
              v.p_taker, v.p_curve, v.p_tick, v.p_base
         FROM v
        WHERE v.version > 1
     ),
     changed AS (
       SELECT d.condition_id, d.version, d.valid_from,
              ARRAY(SELECT f FROM unnest(ARRAY[
                CASE WHEN d.d_taker THEN 'taker_fee_bps'  END,
                CASE WHEN d.d_curve THEN 'fee_curve_json' END,
                CASE WHEN d.d_tick  THEN 'tick_size'      END,
                CASE WHEN d.d_base  THEN 'fee_base_bps'   END
              ]) AS f WHERE f IS NOT NULL) AS fields,
              jsonb_strip_nulls(jsonb_build_object(
                'taker_fee_bps',  CASE WHEN d.d_taker THEN to_jsonb(d.p_taker) END,
                'fee_curve_json', CASE WHEN d.d_curve THEN d.p_curve END,
                'tick_size',      CASE WHEN d.d_tick  THEN to_jsonb(d.p_tick)  END,
                'fee_base_bps',   CASE WHEN d.d_base  THEN to_jsonb(d.p_base)  END
              )) AS from_json,
              jsonb_strip_nulls(jsonb_build_object(
                'taker_fee_bps',  CASE WHEN d.d_taker THEN to_jsonb(d.taker_fee_bps) END,
                'fee_curve_json', CASE WHEN d.d_curve THEN d.fee_curve_json END,
                'tick_size',      CASE WHEN d.d_tick  THEN to_jsonb(d.tick_size)     END,
                'fee_base_bps',   CASE WHEN d.d_base  THEN to_jsonb(d.fee_base_bps)  END
              )) AS to_json
         FROM diffed d
        WHERE d.d_taker OR d.d_curve OR d.d_tick OR d.d_base
     ),
     newest AS (
       SELECT DISTINCT ON (c.condition_id)
              c.condition_id, c.version, c.valid_from, c.fields, c.from_json, c.to_json
         FROM changed c
        ORDER BY c.condition_id, c.version DESC
     )
     SELECT m.condition_id,
            (SELECT max(c.valid_from) FROM resolution_clarifications c
              WHERE c.condition_id = m.condition_id
                AND c.classification = 'material') AS clarified_at,
            n.valid_from  AS param_changed_at,
            n.fields      AS param_changed_fields,
            n.version     AS param_changed_version,
            n.from_json   AS param_changed_from,
            n.to_json     AS param_changed_to,
            (SELECT s.features_json #>> '{rule_precision,value}'
               FROM resolution_scores s
              WHERE s.condition_id = m.condition_id
              ORDER BY s.computed_at DESC LIMIT 1) AS rule_precision_risk
       FROM unnest($1::text[]) AS m(condition_id)
       LEFT JOIN newest n ON n.condition_id = m.condition_id`,
    [ids],
  );
  for (const row of result.rows) {
    const riskText = text(row.rule_precision_risk);
    const risk = riskText === null ? null : Number.parseFloat(riskText);
    const multiplier =
      risk === null || !Number.isFinite(risk)
        ? null
        : Math.min(Math.max(1 - risk, 0), 1);
    const changedAt = date(row.param_changed_at);
    const fields = Array.isArray(row.param_changed_fields)
      ? row.param_changed_fields.map((field) => String(field))
      : [];
    out.set(String(row.condition_id), {
      clarifiedAt: date(row.clarified_at),
      // Fail closed on the pair: an instant without a field would open a
      // breaker that cannot say why, which is the state RFC-025 exists to end.
      paramChangedAt:
        changedAt !== null && fields.length > 0 ? changedAt : null,
      paramChangedFields: fields,
      paramChangedVersion: integer(row.param_changed_version),
      paramChangedFrom: record(row.param_changed_from),
      paramChangedTo: record(row.param_changed_to),
      rulePrecisionScaled:
        multiplier === null
          ? null
          : BigInt(Math.round(multiplier * Number(SCALE))),
    });
  }
  return out;
}

/** Taker fee RATE from bps, mirroring the RFC-011 conversion (700 -> 0.07). */
export function feeRateFromBps(bps: string | null): string | null {
  const parsed = bps === null ? null : parseScaled(bps);
  if (parsed === null || parsed < 0n) {
    return null;
  }
  return money(parsed / 10_000n);
}

/** Field 9 of the panel: the rule text, collapsed and bounded in length. */
export function ruleExcerpt(description: string | null): string | null {
  if (description === null) {
    return null;
  }
  const collapsed = description.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return null;
  }
  return collapsed.length <= RULE_EXCERPT_MAX_CHARS
    ? collapsed
    : `${collapsed.slice(0, RULE_EXCERPT_MAX_CHARS)}\u2026`;
}

/**
 * Field 10 of the panel: markets the RFC-012 logical graph says are related,
 * for a whole batch at once.
 *
 * Every live edge naming a market in either direction, plus the members of any
 * group edge it belongs to. The edge KIND is kept in the label because "these
 * two sum to one" and "this one implies that one" are different warnings.
 */
export async function loadCorrelatedMarkets(
  pool: PortfolioPool,
  conditionIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (conditionIds.length === 0) {
    return out;
  }
  const ids = [...new Set(conditionIds)];
  const result = await pool.query<Record<string, unknown>>(
    `SELECT kind, from_condition_id, to_condition_id, members_json
       FROM graph_edges
      WHERE revoked_at IS NULL
        AND (from_condition_id = ANY($1::text[])
             OR to_condition_id = ANY($1::text[])
             OR members_json ?| $1::text[])
      ORDER BY edge_id
      LIMIT 5000`,
    [ids],
  );
  const wanted = new Set(ids);
  const add = (owner: string, label: string): void => {
    if (!wanted.has(owner)) {
      return;
    }
    const list = out.get(owner) ?? [];
    if (!list.includes(label)) {
      list.push(label);
    }
    out.set(owner, list);
  };
  for (const row of result.rows) {
    const kind = String(row.kind ?? "");
    const members: string[] = [];
    const from = text(row.from_condition_id);
    const to = text(row.to_condition_id);
    if (from !== null) {
      members.push(from);
    }
    if (to !== null) {
      members.push(to);
    }
    const raw: unknown = row.members_json;
    if (Array.isArray(raw)) {
      for (const member of raw) {
        if (typeof member === "string") {
          members.push(member);
        }
      }
    }
    for (const owner of members) {
      for (const other of members) {
        if (other !== owner) {
          add(owner, `${kind}:${other}`);
        }
      }
    }
  }
  for (const [owner, list] of out) {
    out.set(owner, [...list].sort());
  }
  return out;
}

/**
 * Executable mid of the newest recorded book at or before an instant, for a
 * batch of tokens. Used by the jump breaker as the "before" leg.
 */
export async function loadMidsAsOf(
  pool: PortfolioPool,
  tokenIds: readonly string[],
  asOf: Date,
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (tokenIds.length === 0) {
    return out;
  }
  const result = await pool.query<Record<string, unknown>>(
    `SELECT DISTINCT ON (token_id) token_id, bids_json, asks_json
       FROM polymarket_book_snapshots
      WHERE token_id = ANY($1::text[]) AND received_at <= $2
      ORDER BY token_id, received_at DESC`,
    [[...new Set(tokenIds)], asOf],
  );
  for (const row of result.rows) {
    const bid = topPrice(row.bids_json);
    const ask = topPrice(row.asks_json);
    if (bid !== null && ask !== null) {
      out.set(String(row.token_id), (bid + ask) / 2n);
    }
  }
  return out;
}

function topPrice(value: unknown): bigint | null {
  const raw: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(raw) || raw.length === 0) {
    return null;
  }
  const first: unknown = raw[0];
  if (typeof first !== "object" || first === null) {
    return null;
  }
  const price = (first as Record<string, unknown>).price;
  return typeof price === "string" ? parseScaled(price) : null;
}

/**
 * True when the macro calendar knew about something inside the window.
 *
 * A jump WITH a catalyst is information arriving, which is not what the
 * no-catalyst breaker is for. The market's OWN resolution instant is the other
 * half of "known catalyst" and comes from its rule version's `end_date`, which
 * the caller already has.
 */
export async function macroCatalystInWindow(
  pool: PortfolioPool,
  from: Date,
  to: Date,
): Promise<boolean> {
  const result = await pool.query<{ present: boolean }>(
    `SELECT (
       EXISTS (SELECT 1 FROM polymarket_macro_calendar
                WHERE scheduled_at BETWEEN $1 AND $2)
       OR EXISTS (SELECT 1 FROM polymarket_macro_releases
                   WHERE published_at BETWEEN $1 AND $2)
     ) AS present`,
    [from, to],
  );
  return result.rows[0]?.present === true;
}

// ---------------------------------------------------------------------------
// Circuit breakers.
// ---------------------------------------------------------------------------

function breakerKind(value: unknown): BreakerKind | null {
  const candidate = String(value ?? "");
  return (BREAKER_KINDS as readonly string[]).includes(candidate)
    ? (candidate as BreakerKind)
    : null;
}

function breakerScope(value: unknown): BreakerScope {
  const candidate = String(value ?? "");
  return candidate === "market" || candidate === "token"
    ? candidate
    : "portfolio";
}

/** Every breaker whose window has not closed. */
export async function loadOpenBreakers(
  pool: PortfolioPool,
): Promise<OpenBreakerRow[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT breaker_id, kind, scope, condition_id, token_id
       FROM portfolio_circuit_breakers
      WHERE ended_at IS NULL
      ORDER BY breaker_id`,
  );
  const rows: OpenBreakerRow[] = [];
  for (const row of result.rows) {
    const kind = breakerKind(row.kind);
    if (kind === null) {
      continue;
    }
    rows.push({
      breakerId: Number(row.breaker_id ?? 0),
      kind,
      scope: breakerScope(row.scope),
      conditionId: text(row.condition_id),
      tokenId: text(row.token_id),
    });
  }
  return rows;
}

/** Open one breaker. */
export async function openBreaker(
  pool: PortfolioPool,
  signal: BreakerSignal,
  startedAt: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO portfolio_circuit_breakers
       (kind, scope, condition_id, token_id, detail_json, started_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
    [
      signal.kind,
      signal.scope,
      // The migration's scope CHECK requires condition_id for `market` and
      // token_id for `token`, and NEITHER for `portfolio`. A token-scoped
      // breaker keeps its condition_id too: the market is what an operator
      // looks the breaker up by.
      signal.scope === "portfolio" ? null : signal.conditionId,
      signal.scope === "token" ? signal.tokenId : null,
      JSON.stringify(signal.detail),
      startedAt,
    ],
  );
}

/** Close one breaker, which is what makes `ended_at` mean "condition cleared". */
export async function closeBreaker(
  pool: PortfolioPool,
  breakerId: number,
  endedAt: Date,
): Promise<void> {
  await pool.query(
    `UPDATE portfolio_circuit_breakers
        SET ended_at = $2
      WHERE breaker_id = $1 AND ended_at IS NULL`,
    [breakerId, endedAt],
  );
}
