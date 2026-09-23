import { assertEvidenceJson } from "../trading/retention.js";
import {
  requireReservation,
  RESERVATION_VERSION,
  type ReservationOrder,
} from "../trading/reservations.js";
export type ReservationCommand =
  | { action: "reserve"; operation_id: string; order: ReservationOrder }
  | {
      action: "consume";
      operation_id: string;
      order_id: string;
      quantity_btc_raw: string;
      price_usd_raw: string;
      fee_usd_raw: string;
    }
  | {
      action: "release";
      operation_id: string;
      order_id: string;
      reason: "cancelled" | "expired";
    };
const id = (s: unknown) =>
  typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(s);
const raw = (s: unknown, zero = false) =>
  typeof s === "string" &&
  (zero ? /^(0|[1-9][0-9]{0,37})$/ : /^[1-9][0-9]{0,37}$/).test(s);
const keys = (v: object, expected: string) =>
  Object.keys(v).sort().join() === expected.split(",").sort().join();
export function validateReservationCommand(input: ReservationCommand): void {
  assertEvidenceJson(input);
  requireReservation(id(input.operation_id), "COMMAND");
  if (input.action === "reserve") {
    const o = input.order;
    requireReservation(
      keys(input, "action,operation_id,order") &&
        !!o &&
        keys(
          o,
          "schema_version,order_id,position_id,source,intent,side,quantity_btc_raw,price_cap_usd_raw,fee_bps,margin_policy,valid_until",
        ),
      "COMMAND",
    );
    requireReservation(
      o.schema_version === RESERVATION_VERSION &&
        id(o.order_id) &&
        id(o.position_id) &&
        ["manual", "strategy"].includes(o.source) &&
        ["open", "reduce"].includes(o.intent) &&
        ["buy", "sell"].includes(o.side) &&
        raw(o.quantity_btc_raw) &&
        raw(o.price_cap_usd_raw) &&
        Number.isInteger(o.fee_bps) &&
        o.fee_bps >= 0 &&
        o.fee_bps <= 10_000 &&
        o.margin_policy === "full_notional_v1",
      "ORDER",
    );
    const at = Date.parse(o.valid_until);
    requireReservation(
      Number.isSafeInteger(at) &&
        at >= 0 &&
        new Date(at).toISOString() === o.valid_until,
      "TIME",
    );
  } else if (input.action === "consume") {
    requireReservation(
      keys(
        input,
        "action,operation_id,order_id,quantity_btc_raw,price_usd_raw,fee_usd_raw",
      ) &&
        id(input.order_id) &&
        raw(input.quantity_btc_raw) &&
        raw(input.price_usd_raw) &&
        raw(input.fee_usd_raw, true),
      "COMMAND",
    );
  } else {
    requireReservation(
      input.action === "release" &&
        keys(input, "action,operation_id,order_id,reason") &&
        id(input.order_id) &&
        ["cancelled", "expired"].includes(input.reason),
      "COMMAND",
    );
  }
}
