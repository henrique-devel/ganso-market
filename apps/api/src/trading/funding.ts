interface FundingEvent {
  occurred_at: string;
  payload:
    | {
        event_type: "fill";
        position_id: string;
        side: "buy" | "sell";
        quantity: { raw: string };
      }
    | { event_type: "cash" | "fee" | "funding" | "liquidation" };
}

export const FUNDING_VERSION = "btc.funding.v1" as const;
export const FUNDING_HOUR_MS = 3_600_000;
export const FUNDING_POLICY = Object.freeze({
  units: "quantity BTC8 * oracle USD_PER_BTC6 * signed hourly RATE9 -> USD6",
  rounding: "floor signed cash delta once per account/hour/position",
  cutoff:
    "fundingHistory.time verbatim; equal-time fills require ordering evidence",
  correction:
    "append conflict; preserve settled cash; manual reconciliation required",
});
/** No interpolation, mark substitution, daily-rate division or pro-rating. The
 * history endpoint already returns the hourly rate. Floor is a conservative
 * paper policy, not a claim about venue rounding. */
export function fundingDelta(quantity: string, oracle: string, rate: string) {
  const numerator = -BigInt(quantity) * BigInt(oracle) * BigInt(rate);
  const denominator = 100_000_000n * 1_000_000_000n;
  return (
    numerator / denominator -
    (numerator < 0n && numerator % denominator !== 0n ? 1n : 0n)
  ).toString();
}
/** Economic time, not the current position or the append sequence. At equal
 * milliseconds the public data cannot prove fill/settlement order: stay pending. */
export function fundingPositions(
  events: readonly FundingEvent[],
  cutoff: string,
) {
  const quantities = new Map<string, bigint>();
  const ambiguous = new Set<string>();
  for (const e of events) {
    const p = e.payload;
    if (p.event_type !== "fill" || e.occurred_at > cutoff) continue;
    if (e.occurred_at === cutoff) ambiguous.add(p.position_id);
    else
      quantities.set(
        p.position_id,
        (quantities.get(p.position_id) ?? 0n) +
          (p.side === "buy" ? 1n : -1n) * BigInt(p.quantity.raw),
      );
  }
  return {
    ambiguous: [...ambiguous].sort(),
    positions: [...quantities]
      .filter(([, q]) => q !== 0n)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([position_id, q]) => ({
        position_id,
        quantity_btc_raw: q.toString(),
      })),
  };
}
export interface FundingReceipt {
  schema_version: typeof FUNDING_VERSION;
  period_hour: string;
  cutoff: string | null;
  status: "pending" | "settled" | "conflict" | "duplicate";
  reason: string;
  basis: string | null;
  oracle_usd_raw: string | null;
  positions: readonly {
    position_id: string;
    quantity_btc_raw: string;
    delta_usd_raw: string;
  }[];
  evidence_id: string;
}
/** Missing periods are visible even if no reconciliation command was run.
 * Conservatively require all due hours since the first fill; without a final
 * timestamp even a flat account cannot prove its position at that hour's cut.
 * Bounded output, and overflow is unavailable, never implicitly complete. */
export function fundingCoverage(
  events: readonly FundingEvent[],
  receipts: readonly FundingReceipt[],
  asOf: string,
) {
  const fills = events.filter((e) => e.payload.event_type === "fill");
  const first = fills
    .map((e) => Date.parse(e.occurred_at))
    .sort((a, b) => a - b)[0];
  const due =
    first === undefined
      ? 0
      : Math.max(
          0,
          Math.floor(Date.parse(asOf) / FUNDING_HOUR_MS) -
            Math.floor(first / FUNDING_HOUR_MS) +
            1,
        );
  const start =
    first === undefined
      ? 0
      : Math.floor(first / FUNDING_HOUR_MS) * FUNDING_HOUR_MS;
  const byHour = new Map<string, FundingReceipt[]>();
  for (const r of receipts)
    byHour.set(r.period_hour, [...(byHour.get(r.period_hour) ?? []), r]);
  const pending: { period_hour: string; reason: string }[] = [];
  let pendingCount = 0;
  for (let i = 0; i < due; i++) {
    const hour = new Date(start + i * FUNDING_HOUR_MS).toISOString();
    const rows = byHour.get(hour) ?? [];
    const reason = rows.some((r) => r.status === "conflict")
      ? "conflict"
      : rows.some((r) => r.status === "settled")
        ? null
        : (rows.at(-1)?.reason ?? "missing_final_rate");
    if (reason) {
      pendingCount++;
      if (pending.length < 744) pending.push({ period_hour: hour, reason });
    }
  }
  const conflicts = receipts.filter((r) => r.status === "conflict").length;
  return {
    status:
      pendingCount || conflicts ? ("pending" as const) : ("complete" as const),
    pending,
    pending_count: pendingCount,
    overflow: pendingCount > pending.length,
    usable_for_risk: !pendingCount && !conflicts,
  };
}
