/** USD6/BTC8 integer policy. Independent of JEV responses and legacy btc.risk.v1. */
export const JEV_RISK_POLICY = Object.freeze({
  version: "btc.jev-risk.v1",
  initial_capital_usd_raw: "250000000",
  entry_risk_bps: 100,
  exposure_bps: 5000,
  daily_loss_bps: 200,
  drawdown_usd_raw: "12500000",
});
export interface JevRiskCheckpoint {
  version: typeof JEV_RISK_POLICY.version;
  day: string;
  observed_at: string;
  ledger_sequence: string;
  equity_usd_raw: string | null;
  daily_anchor_usd_raw: string | null;
  high_water_usd_raw: string;
  drawdown_floor_usd_raw: string;
  daily_pause_day: string | null;
  drawdown_blocked: boolean;
  history_complete: boolean;
  entries_paused: boolean;
  cancel_entries: boolean;
  request_close: boolean;
  reasons: string[];
}
export function jevRiskCheck(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(`JEV_RISK_${reason}`);
}
export function riskRaw(raw: string): bigint {
  jevRiskCheck(
    /^-?(0|[1-9][0-9]*)$/.test(raw) && raw.length <= 39 && raw !== "-0",
    "AMOUNT",
  );
  return BigInt(raw);
}
export function riskTime(at: string): number {
  const n = Date.parse(at);
  jevRiskCheck(
    Number.isSafeInteger(n) && n >= 0 && new Date(n).toISOString() === at,
    "TIME",
  );
  return n;
}
/** A new UTC day can clear only yesterday's daily latch, with safe reconciliation.
 * HWM and the fixed dollar DD latch never reset on rollover or profile changes. */
export function jevRiskCheckpoint(input: {
  previous: JevRiskCheckpoint | null;
  now_at: string;
  ledger_sequence: string;
  equity_usd_raw: string | null;
  daily_anchor_usd_raw: string | null;
  initial_equity_usd_raw: string;
  history_complete: boolean;
  fresh: boolean;
  reconciled: boolean;
  flat: boolean;
  global_blocked: boolean;
}): JevRiskCheckpoint {
  const p = input.previous,
    day = input.now_at.slice(0, 10);
  riskTime(input.now_at);
  jevRiskCheck(
    !p ||
      (p.version === JEV_RISK_POLICY.version &&
        riskTime(p.observed_at) <= riskTime(input.now_at) &&
        riskRaw(p.ledger_sequence) <= riskRaw(input.ledger_sequence)),
    "CLOCK_OR_SEQUENCE",
  );
  let high = riskRaw(p?.high_water_usd_raw ?? input.initial_equity_usd_raw);
  const e =
    input.equity_usd_raw === null ? null : riskRaw(input.equity_usd_raw);
  const anchor =
    p?.day === day ? p.daily_anchor_usd_raw : input.daily_anchor_usd_raw;
  if (e !== null && e > high) high = e;
  let dailyPause = p?.daily_pause_day ?? null;
  if (
    dailyPause !== null &&
    dailyPause < day &&
    input.flat &&
    input.reconciled &&
    input.fresh &&
    !input.global_blocked &&
    anchor !== null
  )
    dailyPause = null;
  if (
    e !== null &&
    anchor !== null &&
    (e <= 0n || (riskRaw(anchor) - e) * 10000n >= riskRaw(anchor) * 200n)
  )
    dailyPause = day;
  const dd =
    (p?.drawdown_blocked ?? false) || (e !== null && e <= high - 12500000n);
  const history =
    (p?.history_complete ?? input.history_complete) && input.history_complete;
  const reasons: string[] = [];
  if (!history) reasons.push("HISTORY_UNOBSERVED");
  if (anchor === null) reasons.push("UTC_ANCHOR_UNKNOWN");
  if (dailyPause !== null) reasons.push("DAILY_LOSS");
  if (dd) reasons.push("FIXED_DRAWDOWN");
  if (input.global_blocked) reasons.push("GLOBAL_BLOCK");
  if (!input.reconciled) reasons.push("RECONCILIATION_REQUIRED");
  if (!input.fresh || e === null) reasons.push("DATA_UNAVAILABLE");
  const paused = reasons.length > 0;
  return {
    version: JEV_RISK_POLICY.version,
    day,
    observed_at: input.now_at,
    ledger_sequence: input.ledger_sequence,
    equity_usd_raw: input.equity_usd_raw,
    daily_anchor_usd_raw: anchor,
    high_water_usd_raw: high.toString(),
    drawdown_floor_usd_raw: (high - 12500000n).toString(),
    daily_pause_day: dailyPause,
    drawdown_blocked: dd,
    history_complete: history,
    entries_paused: paused,
    cancel_entries: paused,
    request_close: paused && !input.flat,
    reasons,
  };
}
