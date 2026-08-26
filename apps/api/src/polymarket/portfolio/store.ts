// RFC-013 persistence. Reads the as-of inputs the engine decides on, and writes
// the decision log, the exposures, the state machine and the panel snapshots.
//
// Every read is AS-OF the decision instant. Nothing in this file may consult a
// row that became knowable after the decision it supports — that is what makes
// the replay test meaningful, and the migration's
// `CHECK (newest_input_ts <= decision_ts)` is the backstop.

import type { PortfolioPool } from "./types.js";
import type {
  BindingConstraint,
  DecisionKind,
  DecisionOutcome,
} from "./types.js";

/**
 * The RFC caps exposure "por `resolutionSource`/oráculo". Gamma populates
 * `resolutionSource` for almost nothing — measured in production on
 * 2026-08-26: 2 of 98 eligible markets — while `resolvedBy` (the UMA adapter)
 * is populated for nearly all. Falling back to the oracle is the second half of
 * what the RFC names, and it is far more informative than one "unknown" bucket
 * holding the whole book.
 *
 * Worth knowing about the consequence: 460 of 570 live rule versions resolve
 * through the same adapter, so the 25% source cap effectively caps the whole
 * book at 25% of the bankroll. That is the parameter doing exactly what its
 * rationale says ("cláusulas fallback idênticas em massa = risco
 * correlacionado"), not a bug — but it is a calibration question for the owner,
 * and loosening it silently would be the forbidden direction.
 */
export interface EligibleMarket {
  readonly conditionId: string;
  readonly tokenId: string;
  readonly question: string;
  readonly category: string | null;
  readonly negRisk: boolean;
  readonly eventId: string | null;
  readonly resolutionSource: string | null;
  readonly endDate: Date | null;
  readonly tickSize: string | null;
  readonly minOrderSize: string | null;
  readonly ruleVersion: number | null;
  readonly paramVersion: number | null;
}

/**
 * The universe the engine may consider: markets currently in the universe with
 * a mapped affirmative token. Markets that already left are deliberately
 * excluded from ENTRY consideration — an exit path reads positions directly, by
 * id, and does not need the universe.
 */
export async function loadEligibleMarkets(
  pool: PortfolioPool,
  asOf: Date,
): Promise<EligibleMarket[]> {
  const result = await pool.query<Record<string, unknown>>(
    `WITH membership AS (
       SELECT DISTINCT ON (condition_id) condition_id, action
         FROM polymarket_universe_log
        WHERE at <= $1 AND action IN ('enter', 'exit')
        ORDER BY condition_id, at DESC, universe_log_id DESC
     )
     SELECT m.condition_id,
            meta.affirmative_token_id AS token_id,
            meta.question,
            meta.category,
            COALESCE(p.neg_risk, FALSE) AS neg_risk,
            ev.event_id,
            COALESCE(r.resolution_source, r.resolved_by) AS resolution_source,
            r.end_date,
            p.tick_size,
            p.min_order_size,
            r.version AS rule_version,
            p.version AS param_version
       FROM membership m
       JOIN LATERAL (
         SELECT question, category, affirmative_token_id
           FROM polymarket_market_metadata_versions v
          WHERE v.condition_id = m.condition_id
            AND v.valid_from <= $1
            AND (v.valid_to IS NULL OR v.valid_to > $1)
          ORDER BY v.version DESC
          LIMIT 1
       ) meta ON TRUE
       LEFT JOIN LATERAL (
         SELECT version, resolution_source, resolved_by, end_date
           FROM polymarket_rule_versions rv
          WHERE rv.condition_id = m.condition_id
            AND rv.valid_from <= $1
            AND (rv.valid_to IS NULL OR rv.valid_to > $1)
          ORDER BY rv.version DESC
          LIMIT 1
       ) r ON TRUE
       LEFT JOIN LATERAL (
         SELECT version, neg_risk, tick_size, min_order_size
           FROM polymarket_param_versions pv
          WHERE pv.condition_id = m.condition_id
            AND pv.valid_from <= $1
            AND (pv.valid_to IS NULL OR pv.valid_to > $1)
          ORDER BY pv.version DESC
          LIMIT 1
       ) p ON TRUE
       LEFT JOIN LATERAL (
         SELECT event_id FROM polymarket_event_markets em
          WHERE em.condition_id = m.condition_id
          ORDER BY em.event_id
          LIMIT 1
       ) ev ON TRUE
      WHERE m.action = 'enter'
        AND meta.affirmative_token_id IS NOT NULL
      ORDER BY m.condition_id`,
    [asOf],
  );
  return result.rows.map((row) => ({
    conditionId: String(row.condition_id),
    tokenId: String(row.token_id),
    question: String(row.question ?? ""),
    category: row.category === null ? null : String(row.category),
    negRisk: row.neg_risk === true,
    eventId:
      row.event_id === null || row.event_id === undefined
        ? null
        : String(row.event_id),
    resolutionSource:
      row.resolution_source === null || row.resolution_source === undefined
        ? null
        : String(row.resolution_source),
    endDate: row.end_date instanceof Date ? row.end_date : null,
    tickSize:
      row.tick_size === null || row.tick_size === undefined
        ? null
        : String(row.tick_size),
    minOrderSize:
      row.min_order_size === null || row.min_order_size === undefined
        ? null
        : String(row.min_order_size),
    ruleVersion:
      row.rule_version === null || row.rule_version === undefined
        ? null
        : Number(row.rule_version),
    paramVersion:
      row.param_version === null || row.param_version === undefined
        ? null
        : Number(row.param_version),
  }));
}

export interface EstimateAsOf {
  readonly q: string;
  readonly qLo: string;
  readonly qHi: string;
  readonly source: string;
  readonly decisionTs: Date;
}

/** Newest RFC-010 estimate at or before the instant. Never a later one. */
export async function estimateAsOf(
  pool: PortfolioPool,
  tokenId: string,
  asOf: Date,
): Promise<EstimateAsOf | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT q, q_lo, q_hi, source, decision_ts
       FROM fundamental_estimates
      WHERE token_id = $1 AND decision_ts <= $2
      ORDER BY decision_ts DESC
      LIMIT 1`,
    [tokenId, asOf],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    q: String(row.q),
    qLo: String(row.q_lo),
    qHi: String(row.q_hi),
    source: String(row.source),
    decisionTs: row.decision_ts instanceof Date ? row.decision_ts : new Date(0),
  };
}

export interface ResolutionStateAsOf {
  readonly action: "NONE" | "BUFFER" | "VETO" | "CIRCUIT_BREAKER";
  readonly score: string | null;
  readonly scoreVersion: string | null;
  readonly resolutionBuffer: string | null;
  readonly p5050: string | null;
  readonly expectedLockupS: number;
  readonly disputeActive: boolean;
  readonly justification: string | null;
  readonly computedAt: Date | null;
}

/** RFC-012 current state for a market. Absent state fails the entry closed. */
export async function resolutionStateFor(
  pool: PortfolioPool,
  conditionId: string,
): Promise<ResolutionStateAsOf | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT effective_action, score, score_version, resolution_buffer, p_5050,
            expected_lockup_s, dispute_active, justification, computed_at
       FROM resolution_market_state
      WHERE condition_id = $1`,
    [conditionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  const action = String(row.effective_action);
  return {
    action:
      action === "BUFFER" || action === "VETO" || action === "CIRCUIT_BREAKER"
        ? action
        : "NONE",
    score:
      row.score === null || row.score === undefined ? null : String(row.score),
    scoreVersion:
      row.score_version === null || row.score_version === undefined
        ? null
        : String(row.score_version),
    resolutionBuffer:
      row.resolution_buffer === null || row.resolution_buffer === undefined
        ? null
        : String(row.resolution_buffer),
    p5050:
      row.p_5050 === null || row.p_5050 === undefined
        ? null
        : String(row.p_5050),
    expectedLockupS: Number(row.expected_lockup_s ?? 0),
    disputeActive: row.dispute_active === true,
    justification:
      row.justification === null || row.justification === undefined
        ? null
        : String(row.justification),
    computedAt: row.computed_at instanceof Date ? row.computed_at : null,
  };
}

export interface BookAsOf {
  readonly bids: { price: string; size: string }[];
  readonly asks: { price: string; size: string }[];
  readonly receivedAt: Date;
}

/** Newest recorded top-of-book snapshot at or before the instant. */
export async function bookAsOf(
  pool: PortfolioPool,
  tokenId: string,
  asOf: Date,
): Promise<BookAsOf | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT bids_json, asks_json, received_at
       FROM polymarket_book_snapshots
      WHERE token_id = $1 AND received_at <= $2
      ORDER BY received_at DESC
      LIMIT 1`,
    [tokenId, asOf],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  const parseLevels = (value: unknown): { price: string; size: string }[] => {
    const raw: unknown = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(raw)) {
      return [];
    }
    const levels: { price: string; size: string }[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const record = item as Record<string, unknown>;
      const price = record.price;
      const size = record.size;
      if (typeof price === "string" && typeof size === "string") {
        levels.push({ price, size });
      }
    }
    return levels;
  };
  return {
    bids: parseLevels(row.bids_json),
    asks: parseLevels(row.asks_json),
    receivedAt: row.received_at instanceof Date ? row.received_at : new Date(0),
  };
}

export interface DecisionRow {
  readonly kind: DecisionKind;
  readonly conditionId: string;
  readonly tokenId: string;
  readonly marketSide: "YES" | "NO";
  readonly orderSide: "BUY" | "SELL";
  readonly decisionTs: Date;
  readonly q: string | null;
  readonly qLo: string | null;
  readonly qHi: string | null;
  readonly estimateSource: "MODEL" | "MARKET_BASELINE" | null;
  readonly execPrice: string | null;
  readonly worstPrice: string | null;
  readonly bestPrice: string | null;
  readonly feeExpected: string | null;
  readonly slippage: string | null;
  readonly capitalCost: string | null;
  readonly resolutionBuffer: string | null;
  readonly costsTotal: string | null;
  readonly safetyMargin: string | null;
  readonly edgeGross: string | null;
  readonly edgeNet: string | null;
  readonly sizeShares: string | null;
  readonly kellyCapShares: string | null;
  readonly notionalUsd: string | null;
  readonly bindingConstraint: BindingConstraint;
  readonly limiters: unknown;
  readonly configVersion: string;
  readonly configHash: string;
  readonly factorMapVersion: string;
  readonly ruleVersion: number | null;
  readonly paramVersion: number | null;
  readonly resolutionScoreVersion: string | null;
  readonly resolutionAction: string | null;
  readonly oldestInputTs: Date;
  readonly newestInputTs: Date;
  readonly book: unknown;
  readonly inputs: unknown;
  readonly outcome: DecisionOutcome;
  readonly reasonCode: string | null;
  readonly portfolioState: "NORMAL" | "REDUCE_ONLY" | "HALTED";
}

/** Append one decision. Returns its id so the panel can point at it. */
export async function insertDecision(
  pool: PortfolioPool,
  row: DecisionRow,
): Promise<number> {
  const result = await pool.query<{ decision_id: string | number }>(
    `INSERT INTO portfolio_decisions
       (decision_kind, condition_id, token_id, market_side, order_side,
        decision_ts, q, q_lo, q_hi, estimate_source, exec_price, worst_price,
        best_price, fee_expected, slippage, capital_cost, resolution_buffer,
        costs_total, safety_margin, edge_gross, edge_net, size_shares,
        kelly_cap_shares, notional_usd, binding_constraint, limiters_json,
        config_version, config_hash, factor_map_version, rule_version,
        param_version, resolution_score_version, resolution_action,
        oldest_input_ts, newest_input_ts, book_json, inputs_json, outcome,
        reason_code, portfolio_state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
             $19,$20,$21,$22,$23,$24,$25,$26::jsonb,$27,$28,$29,$30,$31,$32,
             $33,$34,$35,$36::jsonb,$37::jsonb,$38,$39,$40)
     RETURNING decision_id`,
    [
      row.kind,
      row.conditionId,
      row.tokenId,
      row.marketSide,
      row.orderSide,
      row.decisionTs,
      row.q,
      row.qLo,
      row.qHi,
      row.estimateSource,
      row.execPrice,
      row.worstPrice,
      row.bestPrice,
      row.feeExpected,
      row.slippage,
      row.capitalCost,
      row.resolutionBuffer,
      row.costsTotal,
      row.safetyMargin,
      row.edgeGross,
      row.edgeNet,
      row.sizeShares,
      row.kellyCapShares,
      row.notionalUsd,
      row.bindingConstraint,
      JSON.stringify(row.limiters),
      row.configVersion,
      row.configHash,
      row.factorMapVersion,
      row.ruleVersion,
      row.paramVersion,
      row.resolutionScoreVersion,
      row.resolutionAction,
      row.oldestInputTs,
      row.newestInputTs,
      JSON.stringify(row.book),
      JSON.stringify(row.inputs),
      row.outcome,
      row.reasonCode,
      row.portfolioState,
    ],
  );
  return Number(result.rows[0]?.decision_id ?? 0);
}

/** Register the versioned config in force, failing closed on a content clash. */
export async function ensureConfigVersion(
  pool: PortfolioPool,
  input: {
    readonly version: string;
    readonly configHash: string;
    readonly content: unknown;
    readonly validFrom: Date;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO portfolio_config_versions
       (version, config_hash, content_json, valid_from)
     VALUES ($1,$2,$3::jsonb,$4)
     ON CONFLICT (version) DO NOTHING`,
    [
      input.version,
      input.configHash,
      JSON.stringify(input.content),
      input.validFrom,
    ],
  );
  const stored = await pool.query<{ config_hash: string }>(
    `SELECT config_hash FROM portfolio_config_versions WHERE version = $1`,
    [input.version],
  );
  const row = stored.rows[0];
  if (row === undefined) {
    throw new Error("PORTFOLIO_CONFIG_VERSION_MISSING_AFTER_INSERT");
  }
  // Same reproducibility gate the RFC-012 score version uses: a version name
  // may never come to mean two different parameter sets, because decisions
  // already point at it by name.
  if (row.config_hash !== input.configHash) {
    throw new Error("PORTFOLIO_CONFIG_VERSION_CONTENT_MISMATCH");
  }
}

/** Same gate for the factor map, which decides what "one bet" means. */
export async function ensureFactorMapVersion(
  pool: PortfolioPool,
  input: {
    readonly version: string;
    readonly contentHash: string;
    readonly content: unknown;
    readonly validFrom: Date;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO portfolio_factor_map_versions
       (version, content_hash, content_json, valid_from)
     VALUES ($1,$2,$3::jsonb,$4)
     ON CONFLICT (version) DO NOTHING`,
    [
      input.version,
      input.contentHash,
      JSON.stringify(input.content),
      input.validFrom,
    ],
  );
  const stored = await pool.query<{ content_hash: string }>(
    `SELECT content_hash FROM portfolio_factor_map_versions WHERE version = $1`,
    [input.version],
  );
  const row = stored.rows[0];
  if (row === undefined) {
    throw new Error("PORTFOLIO_FACTOR_MAP_MISSING_AFTER_INSERT");
  }
  if (row.content_hash !== input.contentHash) {
    throw new Error("PORTFOLIO_FACTOR_MAP_CONTENT_MISMATCH");
  }
}
