/** Pure S3 arithmetic. USD6, BTC8, USD_PER_BTC6; all holds round UP.
 * Full notional collateral remains the isolated 1x envelope. A hold
 * is neither a spot purchase nor a ledger expense. No wall-clock reclamation. */
export const RESERVATION_VERSION = "btc.reservations.v1" as const;
export interface ReservationOrder {
  schema_version: typeof RESERVATION_VERSION;
  order_id: string;
  position_id: string;
  source: "manual" | "strategy";
  intent: "open" | "reduce";
  side: "buy" | "sell";
  quantity_btc_raw: string;
  /** Upper execution price for collateral AND fees, for either side. */
  price_cap_usd_raw: string;
  fee_bps: number;
  margin_policy: "full_notional_v1";
  valid_until: string;
  /** Required by S8 for new exposure; optional only for historical v1 replay. */
  risk_plan?: { stop_price_usd_raw: string; entry_floor_usd_raw: string };
}
export interface Reservation {
  order: ReservationOrder;
  status: "active" | "filled" | "cancelled" | "expired";
  remaining_btc_raw: string;
  margin_usd_raw: string;
  fee_usd_raw: string;
}
export interface ReservationFinance {
  balance_usd_raw: string;
  positions: readonly {
    position_id: string;
    quantity_btc_raw: string;
    cost_usd14_raw: string;
  }[];
  maintenance: {
    usable_for_risk: boolean;
    equity_usd_raw: string | null;
    mark_price: { raw: string } | null;
  };
}
const abs = (n: bigint) => (n < 0n ? -n : n);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
export function requireReservation(ok: boolean, code: string): asserts ok {
  if (!ok) throw new Error(`BTC_RESERVATION_${code}`);
}
export function reservationHold(
  order: ReservationOrder,
  remaining: bigint,
): Reservation {
  const notional = remaining * BigInt(order.price_cap_usd_raw);
  return {
    order,
    status: remaining === 0n ? "filled" : "active",
    remaining_btc_raw: remaining.toString(),
    margin_usd_raw: (order.intent === "open"
      ? ceil(notional, 100_000_000n)
      : 0n
    ).toString(),
    fee_usd_raw: ceil(
      notional * BigInt(order.fee_bps),
      1_000_000_000_000n,
    ).toString(),
  };
}
/** Recompute from ledger positions, including pre-S3 inventory. Never assume
 * that a fill without a reservation means its position uses zero collateral. */
export function positionMargin(finance: ReservationFinance): bigint {
  const mark = BigInt(finance.maintenance.mark_price?.raw ?? "0");
  return finance.positions.reduce(
    (sum, p) =>
      sum +
      ceil(
        max(BigInt(p.cost_usd14_raw), abs(BigInt(p.quantity_btc_raw)) * mark),
        100_000_000n,
      ),
    0n,
  );
}
export function requireOpeningCapacity(
  finance: ReservationFinance,
  reservations: readonly Reservation[],
) {
  requireReservation(
    finance.maintenance.usable_for_risk &&
      finance.maintenance.equity_usd_raw !== null,
    "FINANCE_UNAVAILABLE",
  );
  // Do not pledge unrealized gains. Losses DO reduce collateral capacity.
  const balance = BigInt(finance.balance_usd_raw),
    equity = BigInt(finance.maintenance.equity_usd_raw!);
  const capacity = balance < equity ? balance : equity;
  const held = reservations
    .filter((r) => r.status === "active")
    .reduce(
      (sum, r) => sum + BigInt(r.margin_usd_raw) + BigInt(r.fee_usd_raw),
      0n,
    );
  requireReservation(
    positionMargin(finance) + held <= capacity,
    "MARGIN_UNAVAILABLE",
  );
}
export function reserve(
  order: ReservationOrder,
  finance: ReservationFinance,
  pending: readonly Reservation[],
): Reservation {
  const q = BigInt(order.quantity_btc_raw),
    sign = order.side === "buy" ? 1n : -1n;
  const current = BigInt(
    finance.positions.find((p) => p.position_id === order.position_id)
      ?.quantity_btc_raw ?? "0",
  );
  const peers = pending.filter(
    (r) => r.status === "active" && r.order.position_id === order.position_id,
  );
  const candidate = reservationHold(order, q);
  if (order.intent === "reduce") {
    const used = peers
      .filter((r) => r.order.intent === "reduce")
      .reduce((n, r) => n + BigInt(r.remaining_btc_raw), 0n);
    requireReservation(
      current * sign < 0n && used + q <= abs(current),
      "INVENTORY_UNAVAILABLE",
    );
    // Risk-reducing exits may proceed with unavailable marks; fees still have
    // to fit settled balance and all pending fees. No speculative PnL credit.
    const fees = pending
      .filter((r) => r.status === "active")
      .reduce(
        (n, r) => n + BigInt(r.fee_usd_raw),
        BigInt(candidate.fee_usd_raw),
      );
    requireReservation(
      fees <= BigInt(finance.balance_usd_raw),
      "FEE_UNAVAILABLE",
    );
  } else {
    requireReservation(
      current * sign >= 0n &&
        peers.every(
          (r) => r.order.intent !== "open" || r.order.side === order.side,
        ),
      "SPLIT_REDUCTION_REQUIRED",
    );
    requireReservation(
      finance.maintenance.mark_price === null ||
        BigInt(order.price_cap_usd_raw) >=
          BigInt(finance.maintenance.mark_price.raw),
      "PRICE_CAP_BELOW_MARK",
    );
    requireOpeningCapacity(finance, [...pending, candidate]);
  }
  return candidate;
}
export function consume(
  reservation: Reservation,
  quantity: string,
  price: string,
  fee: string,
  finance: ReservationFinance,
): Reservation {
  requireReservation(reservation.status === "active", "ORDER_CLOSED");
  const q = BigInt(quantity),
    remaining = BigInt(reservation.remaining_btc_raw),
    order = reservation.order;
  requireReservation(q > 0n && q <= remaining, "QUANTITY_UNAVAILABLE");
  requireReservation(
    BigInt(price) > 0n && BigInt(price) <= BigInt(order.price_cap_usd_raw),
    "PRICE_CAP",
  );
  requireReservation(
    BigInt(fee) >= 0n &&
      BigInt(fee) <=
        ceil(q * BigInt(price) * BigInt(order.fee_bps), 1_000_000_000_000n),
    "FEE_CAP",
  );
  const current = BigInt(
    finance.positions.find((p) => p.position_id === order.position_id)
      ?.quantity_btc_raw ?? "0",
  );
  const sign = order.side === "buy" ? 1n : -1n;
  requireReservation(
    order.intent === "reduce"
      ? current * sign < 0n && q <= abs(current)
      : current * sign >= 0n,
    "POSITION_CHANGED",
  );
  return reservationHold(order, remaining - q);
}
export function release(
  reservation: Reservation,
  reason: "cancelled" | "expired",
): Reservation {
  requireReservation(reservation.status === "active", "ORDER_CLOSED");
  return {
    ...reservation,
    status: reason,
    remaining_btc_raw: "0",
    margin_usd_raw: "0",
    fee_usd_raw: "0",
  };
}
