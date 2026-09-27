/** Read-only economic primitives. USD6, BTC8, ratios in signed parts per million. */
export const METRICS_VERSION = "btc.metrics.v1";
export function requireMetric(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(`BTC_METRICS_${code}`);
}
export function money(value: string): bigint {
  requireMetric(
    typeof value === "string" && /^(0|-?[1-9][0-9]{0,77})$/.test(value),
    "AMOUNT",
  );
  return BigInt(value);
}
export function utc(value: string): number {
  const n = Date.parse(value);
  requireMetric(
    Number.isSafeInteger(n) && n >= 0 && new Date(n).toISOString() === value,
    "UTC",
  );
  return n;
}
export function floor(n: bigint, d: bigint): bigint {
  requireMetric(d > 0n, "DENOMINATOR");
  return n / d - (n < 0n && n % d !== 0n ? 1n : 0n);
}
export const ratio = (n: bigint, d: bigint): string | null =>
  d > 0n ? floor(n * 1000000n, d).toString() : null;

/** Missing samples invalidate drawdown. Nonpositive peaks have no percentage
 * denominator; insolvency may exceed 100%, never clamp losses. */
export function drawdown(equities: readonly (string | null)[]) {
  if (!equities.length || equities.some((x) => x === null))
    return {
      max_usd_raw: null,
      max_ppm: null,
      status: "missing_equity_history",
    };
  let peak = money(equities[0]!),
    max = 0n,
    ppm = 0n;
  let positivePeak = peak > 0n;
  for (const value of equities) {
    const equity = money(value!);
    if (equity > peak) peak = equity;
    const loss = peak - equity;
    if (loss > max) max = loss;
    if (peak > 0n) {
      positivePeak = true;
      const p = floor(loss * 1000000n, peak);
      if (p > ppm) ppm = p;
    }
  }
  return {
    max_usd_raw: max.toString(),
    max_ppm: positivePeak ? ppm.toString() : null,
    status: positivePeak ? "available" : "nonpositive_peak",
  };
}

export interface CostAllocation {
  schema_version: "btc.cost-allocation.v1";
  window: { start: string; end: string };
  /** Explicit completeness attestation; [] is known zero, omission is unknown. */
  complete: true;
  basis: string;
  bills: {
    id: string;
    kind: "ai" | "infrastructure";
    total_usd_raw: string;
    shares: { account_id: string; usd_raw: string }[];
  }[];
}
export function allocatedCosts(
  input: CostAllocation | undefined,
  account: string,
  start: string,
  end: string,
) {
  if (!input)
    return {
      ai_usd_raw: null,
      infrastructure_usd_raw: null,
      total_usd_raw: null,
      basis: null,
    };
  requireMetric(
    input.schema_version === "btc.cost-allocation.v1" &&
      input.complete === true &&
      typeof input.basis === "string" &&
      input.basis.length > 0 &&
      input.basis.length <= 512 &&
      input.window.start === start &&
      input.window.end === end,
    "COST_SCOPE",
  );
  requireMetric(input.bills.length <= 4096, "COST_LIMIT");
  const ids = new Set<string>();
  let ai = 0n,
    infra = 0n;
  for (const b of input.bills) {
    requireMetric(
      typeof b.id === "string" &&
        b.id.length > 0 &&
        !ids.has(b.id) &&
        ["ai", "infrastructure"].includes(b.kind) &&
        b.shares.length > 0 &&
        b.shares.length <= 256,
      "BILL_ID_OR_KIND",
    );
    ids.add(b.id);
    const total = money(b.total_usd_raw),
      owners = new Set<string>();
    let sum = 0n;
    for (const share of b.shares) {
      const amount = money(share.usd_raw);
      requireMetric(
        typeof share.account_id === "string" &&
          share.account_id.length > 0 &&
          !owners.has(share.account_id) &&
          amount >= 0n,
        "COST_SHARE",
      );
      owners.add(share.account_id);
      sum += amount;
      if (share.account_id === account) {
        if (b.kind === "ai") ai += amount;
        else infra += amount;
      }
    }
    requireMetric(total >= 0n && sum === total, "COST_CONSERVATION");
  }
  return {
    ai_usd_raw: ai.toString(),
    infrastructure_usd_raw: infra.toString(),
    total_usd_raw: (ai + infra).toString(),
    basis: input.basis,
  };
}

export interface ReferenceInput {
  kind: "cash" | "spot" | "perpetual";
  exposure_bps: 0 | 2500 | 10000;
  capital_usd_raw: string;
  window: { start: string; end: string };
  /** Exact endpoint observations, never extrapolated using a current price. */
  prices: null | {
    start: { at: string; usd_raw: string; evidence_id: string };
    end: { at: string; usd_raw: string; evidence_id: string };
  };
  fees_usd_raw: string | null;
  funding_usd_raw: string | null;
}
/** Constant quantity, no rebalancing. Explicit financing assumptions. Supplied
 * observations are provenance declarations, not an audit of external data. */
export function normalizedReference(input: ReferenceInput) {
  const start = utc(input.window.start),
    end = utc(input.window.end),
    capital = money(input.capital_usd_raw);
  requireMetric(
    end > start &&
      capital > 0n &&
      ["cash", "spot", "perpetual"].includes(input.kind) &&
      (input.kind === "cash"
        ? input.exposure_bps === 0
        : [2500, 10000].includes(input.exposure_bps)),
    "REFERENCE_SCOPE",
  );
  const fees = input.fees_usd_raw === null ? null : money(input.fees_usd_raw);
  const funding =
    input.funding_usd_raw === null ? null : money(input.funding_usd_raw);
  requireMetric(fees === null || fees <= 0n, "REFERENCE_FEES");
  requireMetric(
    input.kind === "perpetual" || funding === 0n,
    "SPOT_CASH_NO_FUNDING",
  );
  let gross: bigint | null = input.kind === "cash" ? 0n : null,
    quantity: bigint | null = input.kind === "cash" ? 0n : null;
  if (input.kind !== "cash" && input.prices) {
    const p = input.prices,
      open = money(p.start.usd_raw),
      close = money(p.end.usd_raw);
    requireMetric(
      p.start.at === input.window.start &&
        p.end.at === input.window.end &&
        open > 0n &&
        close > 0n &&
        !!p.start.evidence_id &&
        !!p.end.evidence_id,
      "REFERENCE_PRICE_TIME",
    );
    quantity = floor(
      capital * BigInt(input.exposure_bps) * 100000000n,
      10000n * open,
    );
    gross = floor(quantity * (close - open), 100000000n);
  }
  const net =
    gross === null || fees === null || funding === null
      ? null
      : gross + fees + funding;
  return {
    ...input,
    schema_version: METRICS_VERSION,
    quantity_btc_raw: quantity?.toString() ?? null,
    gross_pnl_usd_raw: gross?.toString() ?? null,
    net_pnl_usd_raw: net?.toString() ?? null,
    net_return_ppm: net === null ? null : ratio(net, capital),
    data_audit: "supplied_observations_not_independently_audited",
    assumptions:
      "constant_quantity_no_rebalancing_no_interest_no_slippage_beyond_supplied_costs",
  };
}
