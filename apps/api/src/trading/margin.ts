/** Structural inputs keep the pure core independent of adapters and runtime. */
interface MarginMetadata {
  schema_version: string;
  instrument: {
    instrument_id: string;
    instrument_version: string;
    origin: { received_at: string };
  };
  provenance: { parser_version: string };
  margin: {
    maintenance_rule: string;
    mode_constraint: string;
    selected_leverage: number | null;
    max_leverage: number;
    tiers: readonly {
      lower_bound: { unit: string; decimals: number; raw: string };
      max_leverage: number;
      maintenance_rate: { numerator: string; denominator: string };
    }[];
  };
  fees: {
    basis: string;
    taker: { unit: string; decimals: number; raw: string };
  };
}
interface MarginFinance {
  ledger: { scope: { instrument_id: string; instrument_version: string } };
  balance_usd_raw: string;
  positions: readonly {
    position_id: string;
    quantity_btc_raw: string;
    cost_usd14_raw: string;
    realized_usd14_raw: string;
  }[];
}
interface MarginEvent {
  sequence: string;
  payload:
    | { event_type: "cash"; delta: { raw: string } }
    | {
        event_type: "fill";
        execution_id: string;
        position_id: string;
        side: "buy" | "sell";
        quantity: { raw: string };
        price: { raw: string };
      }
    | { event_type: "fee"; execution_id: string; delta: { raw: string } }
    | { event_type: "funding"; position_id: string; delta: { raw: string } }
    | { event_type: "liquidation" };
}
export const MARGIN_VERSION = "btc.margin.v1" as const;
export const MARGIN_POLICY = Object.freeze({
  leverage: 1,
  metadataObservationMaxAgeMs: 86_400_000,
  units: "BTC8, price USD6, budget/cost USD14, reports USD6",
  rounding:
    "PnL/budget floor, maintenance ceiling; exact rational tiers; fee ceiling per attempt",
  collateral:
    "entry notional at 1x; retain all collateral on partial closes until flat; no top-up or position-id reuse",
  execution:
    "observed top-20 at/after trigger mark only, shared with IOC per account/book; public taker fee; no extra clearance fee",
  gap: "unfilled remains exposed; deficit is a position liability, never a transfer from another bucket/account",
  limitations:
    "no HLP/backstop/ADL, market impact, hidden depth, venue block ordering or stop guarantee; no 20%/30s venue liquidation algorithm",
  reference_checked_on: "2026-09-23",
  sources: [
    "https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margining",
    "https://hyperliquid.gitbook.io/hyperliquid-docs/trading/liquidations",
    "https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margin-tiers",
  ],
});
const SCALE = 100_000_000n;
const abs = (n: bigint) => (n < 0n ? -n : n);
const positive = (n: bigint) => (n > 0n ? n : 0n);
const floor = (n: bigint, d = SCALE) =>
  n / d - (n < 0n && n % d !== 0n ? 1n : 0n);
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
export function requireMargin(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(`BTC_MARGIN_${code}`);
}
/** The observation TTL is a simulator validity bound, never venue freshness.
 * A newer incompatible observation must not fall back to older metadata. */
export function validMarginMetadata(
  meta: MarginMetadata | null,
  scope: MarginFinance["ledger"]["scope"],
  asOf: string,
): meta is MarginMetadata {
  try {
    requireMargin(
      meta?.schema_version === "trading.instrument-metadata.v1",
      "METADATA",
    );
    requireMargin(
      meta.instrument.instrument_id === scope.instrument_id &&
        meta.instrument.instrument_version === scope.instrument_version &&
        meta.provenance.parser_version === "hyperliquid.meta.v1",
      "METADATA",
    );
    const age =
      Date.parse(asOf) - Date.parse(meta.instrument.origin.received_at);
    requireMargin(
      Number.isFinite(age) &&
        age >= 0 &&
        age <= MARGIN_POLICY.metadataObservationMaxAgeMs,
      "METADATA",
    );
    requireMargin(
      meta.margin.maintenance_rule ===
        "tier_rate_times_notional_minus_cumulative_deduction" &&
        ["cross_or_isolated", "strict_isolated", "isolated_only"].includes(
          meta.margin.mode_constraint,
        ) &&
        meta.margin.selected_leverage === null &&
        meta.margin.tiers.length > 0 &&
        meta.margin.tiers.length <= 64,
      "METADATA",
    );
    let bound = -1n,
      leverage = Number.MAX_SAFE_INTEGER;
    for (const [i, tier] of meta.margin.tiers.entries()) {
      requireMargin(
        tier.lower_bound.unit === "USD" &&
          tier.lower_bound.decimals === 6 &&
          /^(0|[1-9][0-9]{0,37})$/.test(tier.lower_bound.raw),
        "METADATA",
      );
      const lower = BigInt(tier.lower_bound.raw);
      requireMargin(
        lower > bound &&
          (i !== 0 ||
            (lower === 0n && tier.max_leverage === meta.margin.max_leverage)) &&
          Number.isSafeInteger(tier.max_leverage) &&
          tier.max_leverage >= 1 &&
          tier.max_leverage < leverage &&
          tier.maintenance_rate.numerator === "1" &&
          tier.maintenance_rate.denominator ===
            String(2n * BigInt(tier.max_leverage)),
        "METADATA",
      );
      bound = lower;
      leverage = tier.max_leverage;
    }
    requireMargin(
      meta.fees.basis === "public_base_tier_no_discounts" &&
        meta.fees.taker.unit === "RATE" &&
        meta.fees.taker.decimals === 9 &&
        /^(0|[1-9][0-9]{0,8})$/.test(meta.fees.taker.raw),
      "METADATA",
    );
    return true;
  } catch {
    return false;
  }
}
/** Integrating the piecewise rate equals rate * notional - cumulative deduction.
 * Sum rational USD14 exactly and ceil ONCE to USD6, including repeating rates. */
export function maintenanceMargin(
  notional14: bigint,
  tiers: MarginMetadata["margin"]["tiers"],
): bigint {
  let numerator = 0n,
    denominator = 1n;
  for (const [i, tier] of tiers.entries()) {
    const lower = BigInt(tier.lower_bound.raw) * SCALE;
    if (notional14 <= lower) break;
    const next = tiers[i + 1];
    const upper = next ? BigInt(next.lower_bound.raw) * SCALE : notional14;
    const width = (notional14 < upper ? notional14 : upper) - lower;
    const d = BigInt(tier.maintenance_rate.denominator);
    numerator = numerator * d + width * denominator;
    denominator *= d;
  }
  return ceil(numerator, denominator * SCALE);
}
/** Replay-owned isolated budgets, not a second cash ledger. Each position ID
 * denotes one lifetime, making delayed funding attributable after a close.
 * No partial withdrawal: retain budget and realized PnL until entirely flat.
 * Raw ledger balance includes insolvency; free buckets do NOT absorb that debt.
 * Rounding residual explicitly reconciles per-position floors to account floor. */
export function projectIsolatedMargin(
  finance: MarginFinance,
  events: readonly MarginEvent[],
  mark: string | null,
  meta: MarginMetadata | null,
  asOf: string,
) {
  const budgets = new Map<
    string,
    { allocated: bigint; charges: bigint; q: bigint; closed: boolean }
  >();
  const executions = new Map<string, string>();
  let capital = 0n,
    compatible = true;
  for (const event of [...events].sort((a, b) =>
    BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1,
  )) {
    const p = event.payload;
    if (p.event_type === "cash") capital += BigInt(p.delta.raw) * SCALE;
    if (p.event_type === "fill") {
      const b = budgets.get(p.position_id) ?? {
        allocated: 0n,
        charges: 0n,
        q: 0n,
        closed: false,
      };
      const delta = (p.side === "buy" ? 1n : -1n) * BigInt(p.quantity.raw);
      if (b.q === 0n || b.q * delta > 0n) {
        if (b.closed) compatible = false;
        b.allocated += abs(delta) * BigInt(p.price.raw);
      } else if (abs(delta) > abs(b.q)) compatible = false;
      b.q += delta;
      if (b.q === 0n) b.closed = true;
      budgets.set(p.position_id, b);
      executions.set(p.execution_id, p.position_id);
    }
    if (p.event_type === "fee" || p.event_type === "funding") {
      const id =
        p.event_type === "funding"
          ? p.position_id
          : executions.get(p.execution_id);
      const b = id ? budgets.get(id) : null;
      if (!b) compatible = false;
      else b.charges += BigInt(p.delta.raw) * SCALE;
    }
  }
  const metadataValid = validMarginMetadata(meta, finance.ledger.scope, asOf);
  let allocated = 0n,
    released = 0n,
    openCash = 0n,
    closedDebt = 0n;
  const positions = finance.positions.map((p) => {
    const b = budgets.get(p.position_id)!;
    const q = BigInt(p.quantity_btc_raw),
      cash = b.allocated + b.charges + BigInt(p.realized_usd14_raw);
    allocated += b.allocated;
    if (q === 0n) {
      released += positive(cash);
      closedDebt += positive(-cash);
    } else openCash += cash;
    const unrealized =
      mark === null
        ? null
        : (q < 0n ? -1n : 1n) *
          (abs(q) * BigInt(mark) - BigInt(p.cost_usd14_raw));
    const equity = unrealized === null ? null : floor(cash + unrealized);
    const maintenance =
      mark !== null && metadataValid
        ? maintenanceMargin(abs(q) * BigInt(mark), meta.margin.tiers)
        : null;
    return {
      position_id: p.position_id,
      quantity_btc_raw: p.quantity_btc_raw,
      allocated_usd_raw: floor(b.allocated).toString(),
      collateral_usd_raw: q === 0n ? "0" : floor(cash).toString(),
      equity_usd_raw: q === 0n ? "0" : (equity?.toString() ?? null),
      maintenance_usd_raw: maintenance?.toString() ?? null,
      liquidatable:
        q !== 0n &&
        equity !== null &&
        maintenance !== null &&
        equity <= maintenance,
      residual_usd_raw: q === 0n ? floor(positive(cash)).toString() : "0",
      deficit_usd_raw:
        q !== 0n && unrealized === null
          ? null
          : ceil(
              positive(q === 0n ? -cash : -(cash + (unrealized ?? 0n))),
              SCALE,
            ).toString(),
    };
  });
  const free = floor(capital - allocated + released),
    open = floor(openCash),
    debt = ceil(closedDebt, SCALE);
  return {
    schema_version: MARGIN_VERSION,
    leverage: 1 as const,
    mode: "isolated" as const,
    compatible,
    metadata_valid: metadataValid,
    positions,
    free_cash_usd_raw: free.toString(),
    open_collateral_usd_raw: open.toString(),
    closed_deficit_usd_raw: debt.toString(),
    balance_usd_raw: finance.balance_usd_raw,
    rounding_residual_usd_raw: (
      BigInt(finance.balance_usd_raw) -
      (free + open - debt)
    ).toString(),
  };
}
export type IsolatedMargin = ReturnType<typeof projectIsolatedMargin>;
