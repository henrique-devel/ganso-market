import {
  parseTradingContract,
  parseTradingAmount,
  assertInstrumentOrderConstraints,
  type JevScope,
  type TradingInstrumentMetadata,
} from "@ganso-market/contracts/trading";
import { venueGridPrice } from "../trading/price-grid.js";
import { jevRiskCheck, riskRaw, JEV_RISK_POLICY } from "../trading/jev-risk.js";
import { initialJevProtection } from "./jev-policy.js";
import { validateJevManifest, type JevManifest } from "./jev-manifest.js";
import { jevHash } from "./jev-hash.js";

export interface JevSizingInput {
  scope: JevScope;
  order_id: string;
  decision_id: string;
  decision_at: string;
  entry_price_raw: string;
  direction: "long" | "short";
  atr14_raw: string;
  atr_captured_at: string;
  maker_fee_rate9_raw: string | null;
  exit_fee_rate9_raw: string | null;
  /** Conservative aggregate debit rate over the full six-hour holding limit.
   * A known credit is budgeted as zero; unknown rates refuse admission. */
  funding_debit_rate9_raw: string | null;
  cost_evidence_id: string;
}
export interface JevEntryPlan {
  version: "btc.jev-sizing.v1";
  policy_version: typeof JEV_RISK_POLICY.version;
  manifest_hash: string;
  input: JevSizingInput;
  equity_usd_raw: string;
  quantity_btc_raw: string;
  entry_notional_usd_raw: string;
  stop_price_raw: string;
  worst_exit_price_raw: string;
  planned_loss_usd_raw: string;
  planned_entry_fee_usd_raw: string;
  planned_exit_fee_usd_raw: string;
  planned_funding_usd_raw: string;
  total_risk_usd_raw: string;
}
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
/** Largest valid maker lot, rounding liabilities up and quantity down. Planned
 * costs are holds, never ledger debits. Maker fills are at the resting price;
 * JE06 must reject fills outside that price/quantity identity. */
export function sizeJevEntry(
  m: JevManifest,
  metadata: TradingInstrumentMetadata,
  input: JevSizingInput,
  equityRaw: string,
): JevEntryPlan {
  const hash = validateJevManifest(m);
  parseTradingContract("instrument", metadata.instrument);
  const e = riskRaw(equityRaw),
    price = riskRaw(input.entry_price_raw),
    step = riskRaw(metadata.instrument.quantity_step.raw);
  jevRiskCheck(
    input.scope.instrument_id === metadata.instrument.instrument_id &&
      input.scope.instrument_version ===
        metadata.instrument.instrument_version &&
      input.cost_evidence_id.length > 0 &&
      input.cost_evidence_id.length <= 512 &&
      input.order_id.length > 0 &&
      input.decision_id.length > 0,
    "SIZING_IDENTITY",
  );
  jevRiskCheck(
    e > 0n &&
      price > 0n &&
      step > 0n &&
      venueGridPrice(price, 1n, "down", metadata) === price,
    "SIZING_GRID",
  );
  jevRiskCheck(
    input.maker_fee_rate9_raw !== null &&
      input.exit_fee_rate9_raw !== null &&
      input.funding_debit_rate9_raw !== null,
    "COST_UNKNOWN",
  );
  const maker = riskRaw(input.maker_fee_rate9_raw),
    exit = riskRaw(input.exit_fee_rate9_raw),
    funding = riskRaw(input.funding_debit_rate9_raw);
  jevRiskCheck(
    maker >= riskRaw(metadata.fees.maker.raw) &&
      exit >= riskRaw(metadata.fees.taker.raw) &&
      maker <= 1000000000n &&
      exit <= 1000000000n &&
      funding >= 0n &&
      funding <= 1000000000n,
    "COST_RATE",
  );
  const p = initialJevProtection(
    m,
    {
      scope: input.scope,
      position_id: input.order_id,
      direction: input.direction,
      first_fill_at: input.decision_at,
      first_fill_price_raw: input.entry_price_raw,
      quantity_btc_raw: step.toString(),
      atr14_raw: input.atr14_raw,
      atr_captured_at: input.atr_captured_at,
      decision_at: input.decision_at,
    },
    metadata,
  );
  const stop = riskRaw(p.stop_price_raw),
    worst = venueGridPrice(
      stop * (input.direction === "long" ? 9n : 11n),
      10n,
      input.direction === "long" ? "down" : "up",
      metadata,
    );
  jevRiskCheck(worst !== null && worst > 0n, "STOP_SLIPPAGE_GRID");
  const distance = input.direction === "long" ? price - worst : worst - price;
  jevRiskCheck(distance > 0n, "STOP_DISTANCE");
  const multiplier = input.scope.mode === "stress" ? 2n : 1n;
  const feeExitPrice = worst > price ? worst : price;
  const costs = (q: bigint) => {
    const loss = ceil(q * distance, 100000000n),
      entryFee = ceil(q * price * maker * multiplier, 100000000000000000n),
      exitFee = ceil(q * feeExitPrice * exit * multiplier, 100000000000000000n),
      plannedFunding = ceil(q * feeExitPrice * funding, 100000000000000000n);
    return {
      loss,
      entryFee,
      exitFee,
      plannedFunding,
      total: loss + entryFee + exitFee + plannedFunding,
    };
  };
  // Integer binary search preserves separate ceilings of every liability.
  let low = 0n,
    high = (((e * 5000n) / 10000n) * 100000000n) / (price * step);
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    if (costs(mid * step).total * 10000n <= e * 100n) low = mid;
    else high = mid - 1n;
  }
  const q = low * step,
    notional = ceil(q * price, 100000000n),
    c = costs(q);
  const minimum = riskRaw(metadata.minimum_order_notional.raw);
  jevRiskCheck(
    q > 0n &&
      q * price >= (minimum > 10000000n ? minimum : 10000000n) * 100000000n,
    "VENUE_MINIMUM_OR_BUDGET",
  );
  assertInstrumentOrderConstraints(
    metadata,
    parseTradingAmount("USD_PER_BTC", {
      unit: "USD_PER_BTC",
      decimals: 6,
      raw: price.toString(),
    }),
    parseTradingAmount("BTC", { unit: "BTC", decimals: 8, raw: q.toString() }),
  );
  return {
    version: "btc.jev-sizing.v1",
    policy_version: JEV_RISK_POLICY.version,
    manifest_hash: hash,
    input: structuredClone(input),
    equity_usd_raw: equityRaw,
    quantity_btc_raw: q.toString(),
    entry_notional_usd_raw: notional.toString(),
    stop_price_raw: stop.toString(),
    worst_exit_price_raw: worst.toString(),
    planned_loss_usd_raw: c.loss.toString(),
    planned_entry_fee_usd_raw: c.entryFee.toString(),
    planned_exit_fee_usd_raw: c.exitFee.toString(),
    planned_funding_usd_raw: c.plannedFunding.toString(),
    total_risk_usd_raw: c.total.toString(),
  };
}
/** One immutable quantity for decision, reservation and eventual order adapter. */
export function jevSizedOrder(plan: JevEntryPlan, expectedPlanHash: string) {
  jevRiskCheck(jevHash(plan) === expectedPlanHash, "PLAN_HASH");
  return {
    scope: plan.input.scope,
    decision_id: plan.input.decision_id,
    order_id: plan.input.order_id,
    quantity_btc_raw: plan.quantity_btc_raw,
    price_raw: plan.input.entry_price_raw,
    side:
      plan.input.direction === "long" ? ("buy" as const) : ("sell" as const),
    time_in_force: "ALO" as const,
    reduce_only: false,
  };
}
