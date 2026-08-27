// RFC-013 persistence for the gate measurement pipeline (task 8) and for the
// replay audit (task 7).
//
// Every query here answers one gate's question over recorded evidence. Where the
// evidence does not exist yet the query returns nothing and the gate records
// INSUFFICIENT_DATA — which is the honest state of a portfolio that has not
// traded yet, and deliberately not the same state as FAIL.
//
// Writes are confined to `portfolio_gate_measurements`, `portfolio_gate_reports`,
// `portfolio_g2_clock` and `portfolio_g2_clock_events`.

import { createHash } from "node:crypto";

import { parsePortfolioConfig, type PortfolioConfig } from "./config.js";
import { CALIBRATED_EXPECTATION } from "./gates.js";
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
  GateId,
  GateStatus,
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
 *
 * `source` comes back with each row and matters more than it looks: without a
 * promoted model the estimator falls back to a market baseline, whose `q` is
 * derived from the same book as `market_prob`. G1 splits the two sets on this
 * column, because scoring a baseline against the price compares the price to
 * itself and passes every bar without measuring anything.
 */
export async function loadForecastRows(
  pool: PortfolioPool,
): Promise<ForecastRow[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT DISTINCT ON (e.token_id)
            l.condition_id, e.q, e.market_prob, l.label,
            l.publicly_knowable_ts, e.decision_ts, e.source
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
      source: String(row.source ?? ""),
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

/**
 * One paper ORDER's taker execution, aggregated, with the venue rate recorded
 * closest to it in time and the instant the decision behind it was made.
 *
 * Per order, not per fill event. The ledger writes one `fill` row per book
 * level consumed, so a per-event comparison pits a single level's price against
 * a walk of that level's size from the top of the book — two different
 * quantities, and a number that means nothing whichever way it comes out.
 * Reconciliation is a statement about an execution, so the execution is the
 * unit.
 */
export interface FillReconciliationRow {
  readonly orderId: string;
  readonly tokenId: string;
  readonly side: "BUY" | "SELL";
  /** Total taker size filled for the order. */
  readonly filledSize: string;
  /** Volume-weighted price across the order's taker fills. */
  readonly vwapPrice: string;
  /** Fee the simulator charged, summed across the order's taker fills. */
  readonly simulatedFeeUsd: string;
  /**
   * `sum(price x (1 - price) x size)` over the same fills — the venue's fee
   * curve with the RATE factored out, so the real fee is one multiplication and
   * stays exact instead of being approximated at the VWAP.
   */
  readonly feeShape: string;
  /** Instant the decision behind the order was made, before any latency. */
  readonly decidedAt: Date;
  /** Instant of the last of the order's taker fills. */
  readonly execTs: Date;
  /** `fee_rate_bps` of the nearest recorded trade on the token, or null. */
  readonly venueFeeRateBps: string | null;
}

/**
 * Digits every aggregate is rounded to before it leaves SQL.
 *
 * Not cosmetic. `parseScaled` REFUSES a string with more precision than the
 * working scale rather than truncating it silently, which is the right rule —
 * but numeric division in PostgreSQL is unbounded, so an unrounded VWAP
 * (93.5 / 150 = 0.62333333333333333333) comes back with twenty digits and is
 * refused. Every reconciliation sample would then be dropped on the way in, and
 * G4 would report zero samples forever with nothing in the logs to say why.
 * Rounding here makes the refusal mean what it is for: a malformed row.
 *
 * Nine digits is the module's working scale; a price moves in ticks of 0.01 and
 * carries six decimals of meaning, so nothing measurable is lost.
 */
const WORKING_SCALE_DIGITS = 9;

/**
 * How far from a fill a recorded trade may be and still be taken as evidence of
 * the fee rate in force. A rate from a day away is not the rate that applied.
 *
 * It is also what keeps the query fast: bounded by the effective timestamp, the
 * lookup is a range scan on `polymarket_trades_token_effective_ts_idx` instead
 * of a scan of every trade the token ever had, once per fill.
 */
const FEE_MATCH_WINDOW = "1 hour";

/**
 * Taker executions, newest first, each paired with the venue's own fee rate.
 *
 * Only taker fills: a maker quote pays no fee on V2, so a maker fill has nothing
 * to reconcile and including it would dilute the median with zeros.
 *
 * `decided_at` rides along because it is what makes the slippage comparison
 * capable of failing. The simulator fills against the book at t + latency; a
 * reference re-walked from that SAME snapshot is the simulator against itself.
 * The book the decision was actually made against is a different observation,
 * and the gap between them is exactly the conservatism the simulator claims.
 */
export async function loadFillReconciliationRows(
  pool: PortfolioPool,
  limit: number,
): Promise<FillReconciliationRow[]> {
  const result = await pool.query<Record<string, unknown>>(
    `WITH executions AS (
       SELECT e.order_id,
              o.token_id,
              o.side,
              o.decided_at,
              max(e.event_ts) AS exec_ts,
              sum((e.payload_json ->> 'size')::numeric) AS filled_size,
              sum((e.payload_json ->> 'price')::numeric
                  * (e.payload_json ->> 'size')::numeric) AS notional,
              sum((e.payload_json ->> 'fee')::numeric) AS fee_total,
              sum((e.payload_json ->> 'price')::numeric
                  * (1 - (e.payload_json ->> 'price')::numeric)
                  * (e.payload_json ->> 'size')::numeric) AS fee_shape
         FROM paper_ledger_events e
         JOIN paper_orders o ON o.order_id = e.order_id
        WHERE e.event_type = 'fill'
          AND e.payload_json ->> 'taker' = 'true'
          AND e.order_id IS NOT NULL
        GROUP BY e.order_id, o.token_id, o.side, o.decided_at
       HAVING sum((e.payload_json ->> 'size')::numeric) > 0
        ORDER BY max(e.event_ts) DESC
        LIMIT $1
     )
     SELECT x.order_id, x.token_id, x.side, x.decided_at, x.exec_ts,
            round(x.filled_size, ${WORKING_SCALE_DIGITS}) AS filled_size,
            round(x.fee_total, ${WORKING_SCALE_DIGITS}) AS fee_total,
            round(x.fee_shape, ${WORKING_SCALE_DIGITS}) AS fee_shape,
            round(x.notional / x.filled_size, ${WORKING_SCALE_DIGITS})
              AS vwap_price,
            (SELECT t.fee_rate_bps
               FROM polymarket_trades t
              WHERE t.token_id = x.token_id
                AND t.fee_rate_bps IS NOT NULL
                AND COALESCE(t.trade_ts, t.received_at) BETWEEN
                      x.exec_ts - interval '${FEE_MATCH_WINDOW}'
                  AND x.exec_ts + interval '${FEE_MATCH_WINDOW}'
              ORDER BY abs(extract(epoch FROM (
                        COALESCE(t.trade_ts, t.received_at) - x.exec_ts)))
              LIMIT 1) AS venue_fee_rate_bps
       FROM executions x
      ORDER BY x.exec_ts DESC`,
    [limit],
  );
  const rows: FillReconciliationRow[] = [];
  for (const row of result.rows) {
    const side = String(row.side ?? "");
    const filledSize = text(row.filled_size);
    const vwapPrice = text(row.vwap_price);
    const fee = text(row.fee_total);
    const feeShape = text(row.fee_shape);
    const decidedAt = date(row.decided_at);
    const execTs = date(row.exec_ts);
    if (
      (side !== "BUY" && side !== "SELL") ||
      filledSize === null ||
      vwapPrice === null ||
      fee === null ||
      feeShape === null ||
      decidedAt === null ||
      execTs === null
    ) {
      continue;
    }
    rows.push({
      orderId: String(row.order_id ?? ""),
      tokenId: String(row.token_id ?? ""),
      side,
      filledSize,
      vwapPrice,
      simulatedFeeUsd: fee,
      feeShape,
      decidedAt,
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
 *
 * Ordered by `report_id`, not by `generated_at`: the identity column is
 * monotonic by construction while the timestamp comes from a process clock, and
 * "which report is current" is the hinge the whole gate turns on.
 */
export async function loadOwnerApproval(pool: PortfolioPool): Promise<{
  readonly approval: OwnerApproval | null;
  readonly currentReportId: number | null;
}> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT report_id, approval_json
       FROM portfolio_gate_reports
      ORDER BY report_id DESC
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

/**
 * The verdict fingerprint of a measurement set: gate, status and reason code,
 * in gate order.
 *
 * Deliberately NOT over the metrics. Every cycle moves a number somewhere —
 * a soak day, a sample count — and minting a report for each one would produce
 * a report an hour and invalidate the owner's review continuously. What has to
 * invalidate a review is a VERDICT changing, and that is exactly what this
 * hashes.
 */
export function gateVerdictFingerprint(
  measurements: readonly GateMeasurement[],
  overall: string,
): string {
  const ordered = [...measurements]
    .map((m) => [m.gate, m.status, m.reasonCode ?? ""] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return createHash("sha256")
    .update(JSON.stringify({ overall, gates: ordered }))
    .digest("hex");
}

export interface GateReportRow {
  readonly reportId: number;
  readonly fingerprint: string;
  readonly overallStatus: "BLOCKED" | "READY_FOR_OWNER_REVIEW";
  readonly gates: readonly {
    readonly gate: GateId;
    readonly status: GateStatus;
  }[];
  readonly alreadyApproved: boolean;
}

function parseReportRow(row: Record<string, unknown>): GateReportRow | null {
  const raw: unknown = json(row.gates_json);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const content = raw as Record<string, unknown>;
  const gatesRaw: unknown = content.gates;
  const gates: { gate: GateId; status: GateStatus }[] = [];
  if (Array.isArray(gatesRaw)) {
    for (const entry of gatesRaw) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      gates.push({
        gate: String(record.gate ?? "") as GateId,
        status: String(record.status ?? "") as GateStatus,
      });
    }
  }
  return {
    reportId: Number(row.report_id ?? 0),
    fingerprint: String(content.fingerprint ?? ""),
    overallStatus:
      String(row.overall_status ?? "") === "READY_FOR_OWNER_REVIEW"
        ? "READY_FOR_OWNER_REVIEW"
        : "BLOCKED",
    gates,
    alreadyApproved:
      row.approval_json !== null && row.approval_json !== undefined,
  };
}

/** The newest report, or null when none has been minted yet. */
export async function loadLatestGateReport(
  pool: PortfolioPool,
): Promise<GateReportRow | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT report_id, gates_json, overall_status, approval_json
       FROM portfolio_gate_reports
      ORDER BY report_id DESC
      LIMIT 1`,
  );
  const row = result.rows[0];
  return row === undefined ? null : parseReportRow(row);
}

/** One report by id, for the approval CLI to show before it writes. */
export async function loadGateReport(
  pool: PortfolioPool,
  reportId: number,
): Promise<GateReportRow | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT report_id, gates_json, overall_status, approval_json
       FROM portfolio_gate_reports
      WHERE report_id = $1`,
    [reportId],
  );
  const row = result.rows[0];
  return row === undefined ? null : parseReportRow(row);
}

/**
 * Mint a report: the frozen snapshot a G6 review is written against.
 *
 * The calibrated expectation goes INTO the row, because the RFC requires it on
 * the report and a report is the thing the owner reads. Storing it with the
 * numbers means the record of what was approved carries the warning that was
 * printed alongside it.
 */
export async function insertGateReport(
  pool: PortfolioPool,
  input: {
    readonly measurements: readonly GateMeasurement[];
    readonly overall: "BLOCKED" | "READY_FOR_OWNER_REVIEW";
    readonly fingerprint: string;
    readonly generatedAt: Date;
    readonly windowFrom: Date;
    readonly windowTo: Date;
    readonly configVersion: string;
  },
): Promise<number> {
  const result = await pool.query<Record<string, unknown>>(
    `INSERT INTO portfolio_gate_reports
       (generated_at, window_from, window_to, gates_json, overall_status,
        config_version)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6)
     RETURNING report_id`,
    [
      input.generatedAt,
      input.windowFrom,
      input.windowTo,
      JSON.stringify({
        fingerprint: input.fingerprint,
        calibrated_expectation: CALIBRATED_EXPECTATION,
        gates: input.measurements.map((measurement) => ({
          gate: measurement.gate,
          status: measurement.status,
          reason_code: measurement.reasonCode,
          metrics: measurement.metrics,
          window_from: measurement.windowFrom?.toISOString() ?? null,
          window_to: measurement.windowTo?.toISOString() ?? null,
        })),
      }),
      input.overall,
      input.configVersion,
    ],
  );
  return Number(result.rows[0]?.report_id ?? 0);
}

/**
 * Attach the owner's written review to a report.
 *
 * The guard is repeated IN the statement rather than trusted from the check
 * above it: a report that stopped being current, or acquired an approval,
 * between the read and the write must not be overwritten. Zero rows updated is
 * the refusal, and the caller reports it as one.
 */
export async function recordOwnerApproval(
  pool: PortfolioPool,
  input: {
    readonly reportId: number;
    readonly approval: Record<string, unknown>;
  },
): Promise<boolean> {
  const result = await pool.query<Record<string, unknown>>(
    `UPDATE portfolio_gate_reports
        SET approval_json = $2::jsonb
      WHERE report_id = $1
        AND approval_json IS NULL
        AND report_id = (SELECT max(report_id) FROM portfolio_gate_reports)
      RETURNING report_id`,
    [input.reportId, JSON.stringify(input.approval)],
  );
  return result.rows.length === 1;
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
