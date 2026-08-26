// RFC-013 persistence for the gate measurement pipeline (task 8) and for the
// replay audit (task 7).
//
// Every query here answers one gate's question over recorded evidence. Where the
// evidence does not exist yet the query returns nothing and the gate records
// INSUFFICIENT_DATA — which is the honest state of a portfolio that has not
// traded yet, and deliberately not the same state as FAIL.
//
// Writes are confined to `portfolio_gate_measurements`, `portfolio_g2_clock` and
// `portfolio_g2_clock_events`.

import { parsePortfolioConfig, type PortfolioConfig } from "./config.js";
import type { CategoryClock, ClosedPosition } from "./gates.js";
import type {
  ClockResetPlan,
  ForecastRow,
  GateMeasurement,
  RegimeParams,
} from "./measure.js";
import type { PersistedDecision } from "./replay.js";
import type {
  DecisionKind,
  MarketSide,
  PortfolioPool,
  PortfolioStateName,
} from "./types.js";

const SCALE_DIVISOR = 1_000_000_000;

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function date(value: unknown): Date | null {
  return value instanceof Date ? value : null;
}

function float(value: unknown): number | null {
  const raw = text(value);
  if (raw === null) {
    return null;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// G1: one forecast per resolved market, taken strictly before the outcome.
// ---------------------------------------------------------------------------

/**
 * The forecast each resolved market gets scored on.
 *
 * One per market, and the LAST active estimate made strictly before the outcome
 * became publicly knowable. One per market because scoring a market ten times
 * would let a single well-forecast market dominate the Brier; the last one
 * before the outcome because that is the most informed honest forecast, and
 * `publicly_knowable_ts` is the only instant the RFC-010 schema allows a metric
 * to index on — `closedTime` and the onchain resolution instant both postdate
 * the public outcome, and a label built from either leaks the answer backwards.
 *
 * `status = 'active'` on purpose: the gate asks about "o sinal usado nas
 * entradas", and a shadow estimate is by definition not used.
 */
export async function loadForecastRows(
  pool: PortfolioPool,
): Promise<ForecastRow[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT DISTINCT ON (e.token_id)
            l.condition_id, e.q, e.market_prob, l.label,
            l.publicly_knowable_ts, e.decision_ts
       FROM fundamental_labels l
       JOIN fundamental_estimates e ON e.token_id = l.token_id
      WHERE e.status = 'active'
        AND l.publicly_knowable_ts IS NOT NULL
        AND e.decision_ts < l.publicly_knowable_ts
      ORDER BY e.token_id, e.decision_ts DESC`,
  );
  const rows: ForecastRow[] = [];
  for (const row of result.rows) {
    const model = float(row.q);
    const forecastAt = date(row.decision_ts);
    if (model === null || forecastAt === null) {
      continue;
    }
    rows.push({
      conditionId: String(row.condition_id ?? ""),
      modelProbability: model,
      marketProbability: float(row.market_prob),
      label: String(row.label ?? ""),
      outcomeKnownAt: date(row.publicly_knowable_ts),
      forecastAt,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// G2: closed paper positions.
// ---------------------------------------------------------------------------

/**
 * Positions the paper broker has settled, with their realized PnL.
 *
 * A "closed position" is a resolved token position: `paper_positions` is keyed
 * by token and carries the realized total the RFC-011 ledger derived, and
 * `resolved_at` is the instant it settled. The block bootstrap then resamples
 * these in chronological order.
 */
export async function loadClosedPositions(
  pool: PortfolioPool,
): Promise<ClosedPosition[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT p.condition_id, p.realized_pnl_usd, p.resolved_at, meta.category
       FROM paper_positions p
       LEFT JOIN LATERAL (
         SELECT category FROM polymarket_market_metadata_versions v
          WHERE v.condition_id = p.condition_id AND v.valid_to IS NULL
          ORDER BY v.version DESC LIMIT 1
       ) meta ON TRUE
      WHERE p.resolved_at IS NOT NULL
      ORDER BY p.resolved_at`,
  );
  const rows: ClosedPosition[] = [];
  for (const row of result.rows) {
    const closedAt = date(row.resolved_at);
    const pnl = float(row.realized_pnl_usd);
    if (closedAt === null || pnl === null) {
      continue;
    }
    rows.push({
      pnl,
      conditionId: String(row.condition_id ?? ""),
      category: text(row.category),
      closedAt,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// G3: risk survival.
// ---------------------------------------------------------------------------

export interface RiskSurvival {
  readonly unblockedBreaches: number;
  readonly maxDrawdown: number;
  readonly breakersExercised: readonly string[];
  readonly reduceOnlyExercised: boolean;
}

/**
 * The three risk facts G3 asks for.
 *
 * `unblockedBreaches` counts caps currently over 100% utilization while the
 * portfolio is still NORMAL. The reading is deliberately harsh: the sizing
 * min() is supposed to make a breach impossible, so a breach that coexists with
 * a NORMAL state is by definition one nothing stopped. Counting it as blocked
 * because the operator happened to halt afterwards would let the gate pass on a
 * control that did not work.
 *
 * `maxDrawdown` is the worst drawdown the state machine ever recorded, not just
 * today's: the drawdown transition writes the value into its event detail, so
 * the peak survives the recovery.
 */
export async function loadRiskSurvival(
  pool: PortfolioPool,
): Promise<RiskSurvival> {
  const breaches = await pool.query<Record<string, unknown>>(
    `SELECT count(*) AS breaches
       FROM portfolio_exposures e
      WHERE e.dimension <> 'total'
        AND e.utilization::numeric > 1
        AND EXISTS (
          SELECT 1 FROM portfolio_state s
           WHERE s.portfolio_id = 1 AND s.state = 'NORMAL'
        )`,
  );
  const drawdowns = await pool.query<Record<string, unknown>>(
    `SELECT GREATEST(
              COALESCE((SELECT max(drawdown::numeric) FROM portfolio_state), 0),
              COALESCE((
                SELECT max((detail_json ->> 'drawdown')::numeric)
                  FROM portfolio_state_events
                 WHERE trigger_source = 'drawdown'
                   AND detail_json ? 'drawdown'
              ) / ${String(SCALE_DIVISOR)}, 0)
            ) AS max_drawdown`,
  );
  const breakers = await pool.query<Record<string, unknown>>(
    `SELECT DISTINCT kind FROM portfolio_circuit_breakers ORDER BY kind`,
  );
  const reduceOnly = await pool.query<Record<string, unknown>>(
    `SELECT EXISTS (
       SELECT 1 FROM portfolio_state_events WHERE to_state = 'REDUCE_ONLY'
     ) AS exercised`,
  );
  return {
    unblockedBreaches: Number(breaches.rows[0]?.breaches ?? 0),
    maxDrawdown: float(drawdowns.rows[0]?.max_drawdown) ?? 0,
    breakersExercised: breakers.rows.map((row) => String(row.kind ?? "")),
    reduceOnlyExercised: reduceOnly.rows[0]?.exercised === true,
  };
}

// ---------------------------------------------------------------------------
// G4: reconciliation of simulated fills against the venue's own numbers.
// ---------------------------------------------------------------------------

/** One taker fill, with the venue rate recorded closest to it in time. */
export interface FillReconciliationRow {
  readonly tokenId: string;
  readonly side: "BUY" | "SELL";
  readonly price: string;
  readonly size: string;
  readonly simulatedFeeUsd: string;
  readonly execTs: Date;
  /** `fee_rate_bps` of the nearest recorded trade on the token, or null. */
  readonly venueFeeRateBps: string | null;
}

/**
 * Taker fills, newest first, each paired with the venue's own fee rate.
 *
 * Only taker fills: a maker quote pays no fee on V2, so a maker fill has nothing
 * to reconcile and including it would dilute the median with zeros.
 */
export async function loadFillReconciliationRows(
  pool: PortfolioPool,
  limit: number,
): Promise<FillReconciliationRow[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT e.token_id,
            e.payload_json ->> 'side' AS side,
            e.payload_json ->> 'price' AS price,
            e.payload_json ->> 'size' AS size,
            e.payload_json ->> 'fee' AS fee,
            e.event_ts,
            (SELECT t.fee_rate_bps
               FROM polymarket_trades t
              WHERE t.token_id = e.token_id
                AND t.fee_rate_bps IS NOT NULL
              ORDER BY abs(extract(epoch FROM (t.received_at - e.event_ts)))
              LIMIT 1) AS venue_fee_rate_bps
       FROM paper_ledger_events e
      WHERE e.event_type = 'fill'
        AND e.payload_json ->> 'taker' = 'true'
        AND e.token_id IS NOT NULL
      ORDER BY e.event_ts DESC
      LIMIT $1`,
    [limit],
  );
  const rows: FillReconciliationRow[] = [];
  for (const row of result.rows) {
    const side = String(row.side ?? "");
    const price = text(row.price);
    const size = text(row.size);
    const fee = text(row.fee);
    const execTs = date(row.event_ts);
    if (
      (side !== "BUY" && side !== "SELL") ||
      price === null ||
      size === null ||
      fee === null ||
      execTs === null
    ) {
      continue;
    }
    rows.push({
      tokenId: String(row.token_id ?? ""),
      side,
      price,
      size,
      simulatedFeeUsd: fee,
      execTs,
      venueFeeRateBps: text(row.venue_fee_rate_bps),
    });
  }
  return rows;
}

export interface OperationalEvidence {
  /** Days the engine has been writing decisions without interruption. */
  readonly soakDays: number;
  readonly killSwitchExercised: boolean;
}

/**
 * Soak length and whether the kill switch was ever engaged.
 *
 * The soak is measured from the oldest of two records: the first gate
 * measurement, and the oldest decision the log still holds.
 *
 * The gate measurement is the load-bearing one, and the reason is arithmetic.
 * `portfolio_decisions` has a 180-day TTL but a 0.9 GB quota, and a decision row
 * measures around 2 KB; at one row per eligible market per minute — 98 markets
 * when this was written, so ~141k rows a day — the quota binds after roughly
 * three days, not 180. A soak measured only from the decision log would
 * therefore top out around 3 and G4's 30-day requirement could NEVER be met, no
 * matter how long the engine ran. `portfolio_gate_measurements` is `protected`
 * in the retention policy and never pruned, and the gate job writes to it every
 * cycle from the first boot, so it is a record that only grows.
 *
 * Still a floor rather than a ceiling, which is the safe direction for a gate
 * that requires a MINIMUM: a fresh deployment reports zero and the gate stays
 * INSUFFICIENT_DATA until the record is genuinely long enough.
 */
export async function loadOperationalEvidence(
  pool: PortfolioPool,
  now: Date,
): Promise<OperationalEvidence> {
  const oldest = await pool.query<Record<string, unknown>>(
    `SELECT LEAST(
              (SELECT min(measured_at) FROM portfolio_gate_measurements),
              (SELECT min(received_at) FROM portfolio_decisions)
            ) AS oldest`,
  );
  const kill = await pool.query<Record<string, unknown>>(
    `SELECT EXISTS (
       SELECT 1 FROM paper_kill_switch
        WHERE kill_switch_id = 1 AND engaged_at IS NOT NULL
     ) OR EXISTS (
       SELECT 1 FROM paper_ledger_events
        WHERE event_type = 'kill_switch_engaged'
     ) AS exercised`,
  );
  const from = date(oldest.rows[0]?.oldest);
  // Floored at zero. `received_at` is the database's clock and `now` is the
  // process's; a skew between them must not report a negative duration, which
  // would read as evidence of something rather than as the absence of it.
  const elapsed =
    from === null ? 0 : (now.getTime() - from.getTime()) / (24 * 3_600_000);
  return {
    soakDays: Math.max(elapsed, 0),
    killSwitchExercised: kill.rows[0]?.exercised === true,
  };
}

// ---------------------------------------------------------------------------
// G5: the regime fingerprint and the per-category G2 clock.
// ---------------------------------------------------------------------------

/** Venue parameters in force, grouped by the category they belong to. */
export async function loadRegimeParamsByCategory(
  pool: PortfolioPool,
): Promise<Record<string, RegimeParams[]>> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT meta.category, p.fee_base_bps, p.maker_fee_bps, p.taker_fee_bps,
            p.tick_size, p.min_order_size, p.neg_risk
       FROM polymarket_param_versions p
       JOIN LATERAL (
         SELECT category FROM polymarket_market_metadata_versions v
          WHERE v.condition_id = p.condition_id AND v.valid_to IS NULL
          ORDER BY v.version DESC LIMIT 1
       ) meta ON TRUE
      WHERE p.valid_to IS NULL AND meta.category IS NOT NULL
      ORDER BY meta.category`,
  );
  const grouped: Record<string, RegimeParams[]> = {};
  for (const row of result.rows) {
    const category = String(row.category);
    const list = grouped[category] ?? [];
    list.push({
      feeBaseBps: text(row.fee_base_bps),
      makerFeeBps: text(row.maker_fee_bps),
      takerFeeBps: text(row.taker_fee_bps),
      tickSize: text(row.tick_size),
      minOrderSize: text(row.min_order_size),
      negRisk: row.neg_risk === null ? null : row.neg_risk === true,
    });
    grouped[category] = list;
  }
  return grouped;
}

export async function loadG2Clocks(
  pool: PortfolioPool,
): Promise<CategoryClock[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT category, clock_start, regime_fingerprint, last_reset_reason
       FROM portfolio_g2_clock
      ORDER BY category`,
  );
  const clocks: CategoryClock[] = [];
  for (const row of result.rows) {
    const start = date(row.clock_start);
    if (start === null) {
      continue;
    }
    clocks.push({
      category: String(row.category),
      clockStart: start,
      regimeFingerprint: String(row.regime_fingerprint ?? ""),
      lastResetReason: text(row.last_reset_reason),
    });
  }
  return clocks;
}

/**
 * Start or reset one category clock, and record why.
 *
 * The event row is what makes a passing G2 traceable to the regime it was
 * measured under. Without it a 60-day clock would be indistinguishable from a
 * 60-day clock that had been reset three times.
 */
export async function applyClockReset(
  pool: PortfolioPool,
  plan: ClockResetPlan,
): Promise<void> {
  await pool.query(
    `INSERT INTO portfolio_g2_clock
       (category, clock_start, regime_fingerprint, last_reset_reason,
        last_reset_at, updated_at)
     VALUES ($1,$2,$3,$4,$2,CURRENT_TIMESTAMP)
     ON CONFLICT (category) DO UPDATE SET
       clock_start = EXCLUDED.clock_start,
       regime_fingerprint = EXCLUDED.regime_fingerprint,
       last_reset_reason = EXCLUDED.last_reset_reason,
       last_reset_at = EXCLUDED.last_reset_at,
       updated_at = CURRENT_TIMESTAMP`,
    [plan.category, plan.newStart, plan.newFingerprint, plan.reason],
  );
  await pool.query(
    `INSERT INTO portfolio_g2_clock_events
       (category, previous_start, new_start, previous_fingerprint,
        new_fingerprint, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      plan.category,
      plan.previousStart,
      plan.newStart,
      plan.previousFingerprint,
      plan.newFingerprint,
      plan.reason,
    ],
  );
}

// ---------------------------------------------------------------------------
// G6: the owner's written review.
// ---------------------------------------------------------------------------

export interface OwnerApproval {
  readonly reviewedAt: Date;
  readonly reviewer: string;
  readonly note: string;
  readonly reportId: number;
}

/**
 * The newest written owner review, and the newest report id.
 *
 * G6 is the only gate a computation cannot pass. It is recorded against a
 * specific report so a review of older numbers cannot carry forward onto newer
 * ones.
 */
export async function loadOwnerApproval(pool: PortfolioPool): Promise<{
  readonly approval: OwnerApproval | null;
  readonly currentReportId: number | null;
}> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT report_id, approval_json
       FROM portfolio_gate_reports
      ORDER BY generated_at DESC
      LIMIT 50`,
  );
  let currentReportId: number | null = null;
  let approval: OwnerApproval | null = null;
  for (const [index, row] of result.rows.entries()) {
    const reportId = Number(row.report_id ?? 0);
    if (index === 0) {
      currentReportId = reportId;
    }
    const raw: unknown = row.approval_json;
    const record =
      typeof raw === "string" ? (JSON.parse(raw) as unknown) : (raw as unknown);
    if (
      approval === null &&
      typeof record === "object" &&
      record !== null &&
      !Array.isArray(record)
    ) {
      const fields = record as Record<string, unknown>;
      const reviewedAt = text(fields.reviewed_at);
      const reviewer = text(fields.reviewer);
      const note = text(fields.note);
      if (reviewedAt !== null && reviewer !== null && note !== null) {
        const parsed = new Date(reviewedAt);
        if (!Number.isNaN(parsed.getTime())) {
          approval = { reviewedAt: parsed, reviewer, note, reportId };
        }
      }
    }
  }
  return { approval, currentReportId };
}

// ---------------------------------------------------------------------------
// Writing the measurements.
// ---------------------------------------------------------------------------

/** Append one gate measurement. Immutable by trigger once written. */
export async function insertGateMeasurement(
  pool: PortfolioPool,
  input: {
    readonly measurement: GateMeasurement;
    readonly configVersion: string;
    readonly measuredAt: Date;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO portfolio_gate_measurements
       (gate, status, reason_code, metrics_json, config_version,
        window_from, window_to, measured_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
    [
      input.measurement.gate,
      input.measurement.status,
      input.measurement.reasonCode,
      JSON.stringify(input.measurement.metrics),
      input.configVersion,
      input.measurement.windowFrom,
      input.measurement.windowTo,
      input.measuredAt,
    ],
  );
}

// ---------------------------------------------------------------------------
// The replay audit.
// ---------------------------------------------------------------------------

function decisionKind(value: unknown): DecisionKind {
  const candidate = String(value ?? "");
  return candidate === "EXIT" || candidate === "VETO" || candidate === "RESIZE"
    ? candidate
    : "ENTRY";
}

function marketSide(value: unknown): MarketSide {
  return String(value ?? "") === "NO" ? "NO" : "YES";
}

function stateName(value: unknown): PortfolioStateName {
  const candidate = String(value ?? "");
  return candidate === "REDUCE_ONLY" || candidate === "HALTED"
    ? candidate
    : "NORMAL";
}

function json(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

/** The newest decisions, in the shape the replay reads. */
export async function loadRecentDecisions(
  pool: PortfolioPool,
  limit: number,
): Promise<PersistedDecision[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT decision_id, decision_kind, condition_id, token_id, market_side,
            order_side, decision_ts, q, q_lo, q_hi, estimate_source,
            exec_price, worst_price, best_price, fee_expected, slippage,
            capital_cost, resolution_buffer, costs_total, safety_margin,
            edge_gross, edge_net, size_shares, kelly_cap_shares, notional_usd,
            binding_constraint, limiters_json, config_version, config_hash,
            factor_map_version, rule_version, param_version,
            resolution_score_version, resolution_action, oldest_input_ts,
            newest_input_ts, book_json, inputs_json, outcome, reason_code,
            portfolio_state
       FROM portfolio_decisions
      ORDER BY decision_id DESC
      LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    decisionId: Number(row.decision_id ?? 0),
    decisionKind: decisionKind(row.decision_kind),
    conditionId: String(row.condition_id ?? ""),
    tokenId: String(row.token_id ?? ""),
    marketSide: marketSide(row.market_side),
    orderSide: String(row.order_side ?? "") === "SELL" ? "SELL" : "BUY",
    decisionTs: date(row.decision_ts) ?? new Date(0),
    q: text(row.q),
    qLo: text(row.q_lo),
    qHi: text(row.q_hi),
    estimateSource:
      text(row.estimate_source) === "MODEL"
        ? "MODEL"
        : text(row.estimate_source) === "MARKET_BASELINE"
          ? "MARKET_BASELINE"
          : null,
    execPrice: text(row.exec_price),
    worstPrice: text(row.worst_price),
    bestPrice: text(row.best_price),
    feeExpected: text(row.fee_expected),
    slippage: text(row.slippage),
    capitalCost: text(row.capital_cost),
    resolutionBuffer: text(row.resolution_buffer),
    costsTotal: text(row.costs_total),
    safetyMargin: text(row.safety_margin),
    edgeGross: text(row.edge_gross),
    edgeNet: text(row.edge_net),
    sizeShares: text(row.size_shares),
    kellyCapShares: text(row.kelly_cap_shares),
    notionalUsd: text(row.notional_usd),
    bindingConstraint: String(row.binding_constraint ?? "NOT_SIZED"),
    limiters: json(row.limiters_json),
    configVersion: String(row.config_version ?? ""),
    configHash: String(row.config_hash ?? ""),
    factorMapVersion: String(row.factor_map_version ?? ""),
    ruleVersion:
      row.rule_version === null || row.rule_version === undefined
        ? null
        : Number(row.rule_version),
    paramVersion:
      row.param_version === null || row.param_version === undefined
        ? null
        : Number(row.param_version),
    resolutionScoreVersion: text(row.resolution_score_version),
    resolutionAction: text(row.resolution_action),
    oldestInputTs: date(row.oldest_input_ts) ?? new Date(0),
    newestInputTs: date(row.newest_input_ts) ?? new Date(0),
    book: json(row.book_json),
    inputs: json(row.inputs_json),
    outcome: String(row.outcome ?? ""),
    reasonCode: text(row.reason_code),
    portfolioState: stateName(row.portfolio_state),
  }));
}

/**
 * The parameter sets the replay needs, by version name.
 *
 * Read from `portfolio_config_versions` rather than from the process's own
 * config: replaying a decision made under version 1.0.0 against the parameters
 * of 1.1.0 would report a mismatch that is not one. The stored content goes
 * through the same parser the boot uses, so a stored row that no longer parses
 * is a real failure rather than a silent fallback.
 */
export async function loadConfigVersions(
  pool: PortfolioPool,
  versions: readonly string[],
): Promise<Map<string, PortfolioConfig>> {
  const out = new Map<string, PortfolioConfig>();
  if (versions.length === 0) {
    return out;
  }
  const result = await pool.query<Record<string, unknown>>(
    `SELECT version, content_json
       FROM portfolio_config_versions
      WHERE version = ANY($1::text[])`,
    [[...new Set(versions)]],
  );
  for (const row of result.rows) {
    try {
      out.set(
        String(row.version),
        parsePortfolioConfig(json(row.content_json)),
      );
    } catch {
      // A stored version that cannot be parsed is left out; the audit then
      // reports the decision as unreplayable instead of silently comparing it
      // against a different parameter set.
    }
  }
  return out;
}
