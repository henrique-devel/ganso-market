import type { ReservationOrder } from "../../src/trading/reservations.js";
export function order(
  order_id = "order:1",
  changes: Partial<ReservationOrder> = {},
): ReservationOrder {
  return {
    schema_version: "btc.reservations.v1",
    order_id,
    position_id: "position:1",
    source: "manual",
    intent: "open",
    side: "buy",
    quantity_btc_raw: "1000000",
    price_cap_usd_raw: "65000000000",
    fee_bps: 10,
    margin_policy: "full_notional_v1",
    valid_until: new Date(Date.now() + 60_000).toISOString(),
    ...changes,
  };
}
