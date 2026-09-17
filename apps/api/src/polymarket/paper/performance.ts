// RFC-011 task 8: the performance report, ALWAYS in three columns.
//
//   * optimistic — diagnostic only: the ledger replayed WITH the fills the
//     degradation denied, realized-only. The RFC forbids any gate from ever
//     reading this column.
//   * base — the canonical ledger (degradation already applied at fill time)
//     plus the default stress_slippage of one tick charged on every taker
//     fill, and the executable-bid marks for the unrealized leg.
//   * stress — the base with the taker haircut raised to the community-
//     reported 2–10¢ range (5¢ default).
//
// The "do nothing" baseline is zero by definition and is printed alongside so
// the net columns are always read against it.

import type { SqlExecutor } from "../../database.js";
import {
  SCALE,
  div,
  formatScaled,
  mul,
  parseScaled,
} from "../fundamental/fixed.js";
import {
  loadLedgerEvents,
  replayLedger,
  type LedgerEventRecord,
} from "./ledger.js";

export type QueryPool = { query: SqlExecutor["query"] };

/** Base column: one tick charged per taker share (fallback when no tick). */
export const BASE_SLIPPAGE_FALLBACK = "0.01";
/** Stress column: 5¢ per taker share (middle of the reported 2–10¢ range). */
export const STRESS_SLIPPAGE_USD = "0.05";

export interface PerformanceColumns {
  readonly optimistic_realized_usd: string;
  readonly base_realized_usd: string;
  readonly base_unrealized_usd: string | null;
  readonly base_net_usd: string | null;
  readonly stress_realized_usd: string;
  readonly note: string;
}

export interface PerformanceReport {
  readonly execution: ReturnType<typeof executionCoverage>;
  readonly columns: PerformanceColumns;
  readonly baseline_no_trade_usd: string;
  readonly fees_paid_usd: string;
  readonly fill_rates_by_type: Record<
    string,
    { orders: number; filled: number; rate: string }
  >;
  readonly taker_slippage: {
    orders: number;
    avg_predicted_vs_realized_usd: string | null;
  };
  readonly markouts_by_execution: Record<
    string,
    Record<string, { fills: number; avg_mid_markout: string | null }>
  >;
  readonly markouts_by_horizon: Record<
    string,
    { fills: number; avg_mid_markout: string | null }
  >;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Sum of taker penalties: shares x haircut per share. */
function takerPenalty(
  events: readonly LedgerEventRecord[],
  haircutPerShare: (tick: string | null) => bigint,
): bigint {
  let penalty = 0n;
  for (const event of events) {
    if (event.eventType !== "fill" || event.payload["taker"] !== true) {
      continue;
    }
    const size = parseScaled(asString(event.payload["size"]) ?? "");
    if (size === null) {
      continue;
    }
    penalty += mul(size, haircutPerShare(asString(event.payload["tick_size"])));
  }
  return penalty;
}

/** The denied fills, converted back into fills for the optimistic replay. */
export function optimisticEvents(
  events: readonly LedgerEventRecord[],
): LedgerEventRecord[] {
  return events.map((event) =>
    event.eventType === "fill_denied_degradation"
      ? {
          ...event,
          eventType: "fill" as const,
          payload: { ...event.payload, fee: "0" },
        }
      : event,
  );
}

/** Separate observations without pretending mixed maker/taker inventory has
 * independent PnL. Retains the existing report's ledger accounting convention. */
export function executionCoverage(events: readonly LedgerEventRecord[]) {
  const unique = [
    ...new Map(events.map((e) => [e.idempotencyKey, e])).values(),
  ];
  const classes = new Map<string, Set<string>>();
  for (const e of unique) {
    if (e.eventType !== "fill" || e.tokenId === null) continue;
    const kinds = classes.get(e.tokenId) ?? new Set<string>();
    kinds.add(
      e.payload["taker"] === true
        ? "taker"
        : e.payload["taker"] === false
          ? "maker"
          : "unknown",
    );
    classes.set(e.tokenId, kinds);
  }
  const bucket = (kind: "maker" | "taker") => {
    const fills = unique.filter(
      (e) =>
        e.eventType === "fill" && e.payload["taker"] === (kind === "taker"),
    );
    const covered = fills.filter(
      (e) => e.tokenId !== null && classes.get(e.tokenId)?.size === 1,
    );
    const tokens = new Set(covered.map((e) => e.tokenId));
    const pnl = replayLedger(
      unique.filter((e) => e.tokenId !== null && tokens.has(e.tokenId)),
    );
    const fees = fills.reduce(
      (n, e) => n + (parseScaled(asString(e.payload["fee"]) ?? "") ?? 0n),
      0n,
    );
    return {
      fills: fills.length,
      orders_with_fill: new Set(fills.map((e) => e.orderId)).size,
      fees_paid_usd: formatScaled(fees, 6),
      fee_evidence_fills: fills.filter(
        (e) =>
          e.payload["fee_model"] !== undefined &&
          (kind === "maker"
            ? e.payload["fee_source"] !== undefined
            : e.payload["fee_param_version_id"] != null &&
              e.payload["fee_source_ts"] != null),
      ).length,
      realized_pnl_usd: covered.length === 0 ? null : pnl.realizedPnlUsd,
      pnl_covered_fills: covered.length,
      pnl_uncovered_fills: fills.length - covered.length,
      sample: fills.length === 0 ? "no_evidence" : "paper_observations_only",
    };
  };
  return {
    maker: bucket("maker"),
    taker: bucket("taker"),
    unknown_fills: unique.filter(
      (e) => e.eventType === "fill" && typeof e.payload["taker"] !== "boolean",
    ).length,
    note: "Paper only; PnL uses existing legacy report accounting, excludes mixed/unknown execution tokens; no sample or fee evidence never approves G4.",
  };
}

export async function buildPerformanceReport(
  pool: QueryPool,
): Promise<PerformanceReport> {
  const events = await loadLedgerEvents(pool);
  const base = replayLedger(events);
  const optimistic = replayLedger(optimisticEvents(events));

  const baseRealized = parseScaled(base.realizedPnlUsd) ?? 0n;
  const stressHaircut = parseScaled(STRESS_SLIPPAGE_USD) ?? 0n;
  const basePenalty = takerPenalty(events, (tick) => {
    const parsed = tick === null ? null : parseScaled(tick);
    return parsed !== null && parsed > 0n
      ? parsed
      : (parseScaled(BASE_SLIPPAGE_FALLBACK) ?? 0n);
  });
  const stressPenalty = takerPenalty(events, () => stressHaircut);

  // Unrealized: executable-bid marks from the position cache (STALE_MARK
  // positions contribute their frozen value; unmarked ones contribute null).
  const unrealizedRow = await pool.query(
    "SELECT COALESCE(SUM(CASE " +
      "WHEN shares::numeric > 0 THEN COALESCE(mark_value_usd::numeric, cost_usd::numeric) - cost_usd::numeric " +
      "WHEN shares::numeric < 0 THEN cost_usd::numeric - COALESCE(mark_value_usd::numeric, cost_usd::numeric) " +
      "ELSE 0 END), 0)::text AS unrealized, " +
      "BOOL_OR(shares::numeric <> 0 AND mark_value_usd IS NULL) AS unmarked " +
      "FROM paper_positions",
  );
  const unrealizedStr = asString(unrealizedRow.rows[0]?.["unrealized"]);
  const hasUnmarked = unrealizedRow.rows[0]?.["unmarked"] === true;
  const unrealized =
    unrealizedStr === null ? null : (parseScaled(unrealizedStr) ?? null);

  const baseAdjusted = baseRealized - basePenalty;
  const columns: PerformanceColumns = {
    optimistic_realized_usd: optimistic.realizedPnlUsd,
    base_realized_usd: formatScaled(baseAdjusted, 6),
    base_unrealized_usd:
      unrealized === null || hasUnmarked ? null : formatScaled(unrealized, 6),
    base_net_usd:
      unrealized === null || hasUnmarked
        ? null
        : formatScaled(baseAdjusted + unrealized, 6),
    stress_realized_usd: formatScaled(baseRealized - stressPenalty, 6),
    note:
      "optimistic is diagnostic only and never feeds a gate; " +
      "base charges 1 tick per taker share; stress charges " +
      STRESS_SLIPPAGE_USD +
      " per taker share",
  };

  // Fill rate per order type from the orders table.
  const rates = await pool.query(
    "SELECT order_type, COUNT(*)::int AS orders, " +
      "COUNT(*) FILTER (WHERE filled_size::numeric > 0)::int AS filled " +
      "FROM paper_orders GROUP BY order_type",
  );
  const fillRates: Record<
    string,
    { orders: number; filled: number; rate: string }
  > = {};
  for (const row of rates.rows) {
    const orderType = asString(row["order_type"]);
    if (orderType === null) {
      continue;
    }
    const orders = Number(row["orders"] ?? 0);
    const filled = Number(row["filled"] ?? 0);
    fillRates[orderType] = {
      orders,
      filled,
      rate:
        orders === 0
          ? "0.000000"
          : formatScaled(
              BigInt(Math.round((filled / orders) * Number(SCALE))),
              6,
            ),
    };
  }

  // Predicted (worst_price) vs realized (fill VWAP) taker slippage.
  let slippageTotal = 0n;
  let slippageShares = 0n;
  let takerOrders = 0;
  const worstByOrder = new Map<string, bigint>();
  for (const event of events) {
    if (event.eventType === "order_accepted" && event.orderId !== null) {
      const worst = parseScaled(asString(event.payload["worst_price"]) ?? "");
      if (worst !== null) {
        worstByOrder.set(event.orderId, worst);
        takerOrders += 1;
      }
    }
  }
  for (const event of events) {
    if (event.eventType !== "fill" || event.payload["taker"] !== true) {
      continue;
    }
    const worst =
      event.orderId === null ? undefined : worstByOrder.get(event.orderId);
    const price = parseScaled(asString(event.payload["price"]) ?? "");
    const size = parseScaled(asString(event.payload["size"]) ?? "");
    if (worst === undefined || price === null || size === null) {
      continue;
    }
    // Positive = filled better than the declared worst (both sides).
    const sideRaw = event.payload["side"];
    const perShare = sideRaw === "SELL" ? price - worst : worst - price;
    slippageTotal += mul(perShare, size);
    slippageShares += size;
  }

  // Markout means per horizon (mid reference; the RFC's cancel metric).
  const markoutRows = await pool.query(
    "SELECT horizon_s, COUNT(mid_markout)::int AS fills, " +
      "AVG(mid_markout::numeric)::text AS avg_mid " +
      "FROM paper_markouts GROUP BY horizon_s ORDER BY horizon_s",
  );
  const markouts: Record<
    string,
    { fills: number; avg_mid_markout: string | null }
  > = {};
  for (const row of markoutRows.rows) {
    const horizon = row["horizon_s"];
    const key =
      typeof horizon === "number" ? String(horizon) : asString(horizon);
    if (key === null) {
      continue;
    }
    const avg = asString(row["avg_mid"]);
    markouts[`${key}s`] = {
      fills: Number(row["fills"] ?? 0),
      avg_mid_markout:
        avg === null ? null : formatScaled(parseScaled(avg) ?? 0n, 6),
    };
  }

  const splitRows = await pool.query(
    "SELECT CASE WHEN e.payload_json->>'taker'='true' THEN 'taker' WHEN e.payload_json->>'taker'='false' THEN 'maker' ELSE 'unknown' END AS execution_kind, " +
      "m.horizon_s, COUNT(m.mid_markout)::int AS fills, AVG(m.mid_markout::numeric)::text AS avg_mid " +
      "FROM paper_markouts m JOIN paper_ledger_events e ON e.idempotency_key=m.fill_key " +
      "GROUP BY execution_kind,m.horizon_s",
  );
  const split: PerformanceReport["markouts_by_execution"] = {
    maker: {},
    taker: {},
    unknown: {},
  };
  for (const row of splitRows.rows) {
    const kind = asString(row["execution_kind"]);
    if (kind === null || !split[kind]) continue;
    const avg = asString(row["avg_mid"]);
    split[kind][`${String(row["horizon_s"])}s`] = {
      fills: Number(row["fills"] ?? 0),
      avg_mid_markout:
        avg === null ? null : formatScaled(parseScaled(avg) ?? 0n, 6),
    };
  }
  return {
    markouts_by_execution: split,
    execution: executionCoverage(events),
    columns,
    baseline_no_trade_usd: "0.000000",
    fees_paid_usd: base.feesPaidUsd,
    fill_rates_by_type: fillRates,
    taker_slippage: {
      orders: takerOrders,
      avg_predicted_vs_realized_usd:
        slippageShares === 0n
          ? null
          : formatScaled(div(slippageTotal, slippageShares), 6),
    },
    markouts_by_horizon: markouts,
  };
}
