/** Structural inputs preserve the neutral core's zero-import boundary. */
interface RiskOrder {
  side: "buy" | "sell";
  quantity_btc_raw: string;
  price_cap_usd_raw: string;
  fee_bps: number;
  risk_plan?: { stop_price_usd_raw: string; entry_floor_usd_raw: string };
}
interface RiskReservation {
  status: string;
  remaining_btc_raw: string;
  order: RiskOrder & { intent: string };
}

/** Fixed, account-scoped paper policy. No caller overrides or Jev input. USD6,
 * BTC8, price6. Caps compare integer products; liabilities/anchors round up.
 * Stops describe planned risk, never a guaranteed execution or maximum loss. */
export const RISK_POLICY = Object.freeze({
  version: "btc.risk.v1",
  exposure_bps: 2500,
  entry_risk_bps: 25,
  daily_loss_bps: 150,
  drawdown_bps: 500,
  mark_age_ms: 5000,
  book_age_ms: 2000,
});
export type RiskState = "NORMAL" | "REDUCE_ONLY" | "HALTED";
export interface RiskCheckpoint {
  version: typeof RISK_POLICY.version;
  state: RiskState;
  history_complete: boolean;
  reasons: string[];
  day: string;
  daily_anchor_usd_raw: string | null;
  high_water_usd_raw: string;
  external_cash_usd_raw: string;
  equity_usd_raw: string | null;
  ledger_sequence: string;
  observed_at: string;
}
export class RiskRefusal extends Error {
  constructor(code: string) {
    super(`BTC_RISK_${code}`);
  }
}
export function requireRisk(ok: boolean, code: string): asserts ok {
  if (!ok) throw new RiskRefusal(code);
}
const abs = (n: bigint) => (n < 0n ? -n : n);
export const riskCeil = (n: bigint, d: bigint) => (n + d - 1n) / d;
export function breached(equity: bigint, anchor: bigint, bps: number) {
  return (
    equity <= 0n ||
    anchor <= 0n ||
    (anchor - equity) * 10000n >= anchor * BigInt(bps)
  );
}
/** Economic flow adjustment scales anchors at pre-flow equity, preserving loss
 * percentages instead of diluting them with a deposit. Ceiling cannot hide loss.
 * Callers must sample before external flows; missing/nonpositive equity halts. */
export function flowAnchor(anchor: bigint, before: bigint, delta: bigint) {
  requireRisk(before > 0n && before + delta > 0n, "EXTERNAL_FLOW_EQUITY");
  return riskCeil(anchor * (before + delta), before);
}
export function riskCheckpoint(input: {
  previous: RiskCheckpoint | null;
  now: string;
  equity: string | null;
  external: string;
  initial_anchor: string;
  daily_anchor: string | null;
  sequence: string;
  usable: boolean;
  accounting: boolean;
  history_complete?: boolean;
}): RiskCheckpoint {
  const p = input.previous,
    day = input.now.slice(0, 10);
  let high = BigInt(p?.high_water_usd_raw ?? input.initial_anchor);
  let daily = p?.day === day ? p.daily_anchor_usd_raw : input.daily_anchor;
  const reasons: string[] = [];
  let state: RiskState = p?.state ?? "NORMAL";
  const delta =
    BigInt(input.external) - BigInt(p?.external_cash_usd_raw ?? input.external);
  if (delta !== 0n) {
    const before = input.equity === null ? 0n : BigInt(input.equity) - delta;
    if (before <= 0n || before + delta <= 0n)
      reasons.push("external_flow_unvalued");
    else {
      high = flowAnchor(high, before, delta);
      // A new UTC anchor already contains flows before midnight.
      if (daily !== null && p?.day === day)
        daily = flowAnchor(BigInt(daily), before, delta).toString();
    }
  }
  if (!(p?.history_complete ?? input.history_complete ?? true))
    reasons.push("history_unobserved");
  if (!input.accounting) reasons.push("accounting_inconsistent");
  if (daily === null) reasons.push("utc_anchor_unavailable");
  if (!input.usable || input.equity === null) reasons.push("data_unavailable");
  if (input.equity !== null) {
    const equity = BigInt(input.equity);
    if (equity > high) high = equity;
    if (
      daily !== null &&
      breached(equity, BigInt(daily), RISK_POLICY.daily_loss_bps)
    )
      reasons.push("daily_loss");
    if (breached(equity, high, RISK_POLICY.drawdown_bps))
      reasons.push("drawdown");
  }
  if (
    reasons.some((r) =>
      ["accounting_inconsistent", "external_flow_unvalued"].includes(r),
    )
  )
    state = "HALTED";
  else if (reasons.length && state === "NORMAL") state = "REDUCE_ONLY";
  return {
    version: RISK_POLICY.version,
    history_complete: p?.history_complete ?? input.history_complete ?? true,
    state,
    reasons,
    day,
    daily_anchor_usd_raw: daily,
    high_water_usd_raw: high.toString(),
    external_cash_usd_raw: input.external,
    equity_usd_raw: input.equity,
    ledger_sequence: input.sequence,
    observed_at: input.now,
  };
}
export function grossExposure(
  positions: readonly { quantity_btc_raw: string }[],
  mark: string,
  reservations: readonly RiskReservation[],
) {
  return (
    positions.reduce(
      (n, p) =>
        n +
        riskCeil(abs(BigInt(p.quantity_btc_raw)) * BigInt(mark), 100000000n),
      0n,
    ) +
    reservations
      .filter((r) => r.status === "active" && r.order.intent === "open")
      .reduce(
        (n, r) =>
          n +
          riskCeil(
            BigInt(r.remaining_btc_raw) * BigInt(r.order.price_cap_usd_raw),
            100000000n,
          ),
        0n,
      )
  );
}
export function plannedRisk(order: RiskOrder, minimumFeeBps: number): bigint {
  requireRisk(!!order.risk_plan, "PLAN_REQUIRED");
  const { stop_price_usd_raw, entry_floor_usd_raw } = order.risk_plan;
  const stop = BigInt(stop_price_usd_raw),
    floor = BigInt(entry_floor_usd_raw),
    cap = BigInt(order.price_cap_usd_raw),
    q = BigInt(order.quantity_btc_raw);
  requireRisk(
    floor > 0n &&
      floor <= cap &&
      (order.side === "buy" ? stop < floor : stop > cap),
    "PLAN_DIRECTION",
  );
  requireRisk(order.fee_bps >= minimumFeeBps, "FEE_UNDERESTIMATED");
  const loss = order.side === "buy" ? cap - stop : stop - floor;
  // Separate ceiling for both legs. Use the higher of stop/cap for exit fee.
  const fee = BigInt(order.fee_bps),
    exit = stop > cap ? stop : cap;
  return (
    riskCeil(q * loss, 100000000n) +
    riskCeil(q * cap * fee, 1000000000000n) +
    riskCeil(q * exit * fee, 1000000000000n)
  );
}
export function requireRiskCaps(
  equity: string,
  exposure: bigint,
  planned?: bigint,
) {
  const e = BigInt(equity);
  requireRisk(
    e > 0n && exposure * 10000n <= e * BigInt(RISK_POLICY.exposure_bps),
    "EXPOSURE_LIMIT",
  );
  if (planned !== undefined)
    requireRisk(
      planned * 10000n <= e * BigInt(RISK_POLICY.entry_risk_bps),
      "PLANNED_LIMIT",
    );
}
