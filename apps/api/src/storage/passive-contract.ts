import { assertEvidenceJson } from "../trading/retention.js";
import {
  PASSIVE_VERSION,
  PASSIVE_POLICY,
  type PassiveIntent,
  type PassiveQueue,
} from "../trading/passive.js";
import type { Reservation, ReservationOrder } from "../trading/reservations.js";
import { validateReservationCommand } from "./reservation-contract.js";
export type PassiveCommand =
  | {
      action: "submit";
      operation_id: string;
      order: ReservationOrder;
      intent: PassiveIntent;
    }
  | {
      action: "replace";
      operation_id: string;
      order_id: string;
      order: ReservationOrder;
      intent: PassiveIntent;
    }
  | { action: "cancel"; operation_id: string; order_id: string }
  | { action: "advance"; operation_id: string };
export interface PassiveState {
  reservation: Reservation;
  intent: PassiveIntent;
  queue: PassiveQueue;
  accepted_at: string;
  priority: string;
  fee_rate: string;
  session: string;
  gaps: number;
  book_epoch: number;
  trade_epoch: number;
  capture_at: number;
}
export interface PassiveResult {
  schema_version: typeof PASSIVE_VERSION;
  policy: typeof PASSIVE_POLICY;
  fidelity: "low_observed_queue_not_venue_priority";
  market_id: string;
  reason: string;
  orders: PassiveState[];
  fills: {
    order_id: string;
    trade_id: string;
    price_usd_raw: string;
    quantity_btc_raw: string;
    fee_usd_raw: string;
  }[];
  fee_basis: "public_base_tier_no_discounts";
  account_effective_fee: null;
  evidence_id: string;
}
export function requirePassive(ok: boolean, code: string): asserts ok {
  if (!ok) throw new Error(`BTC_PASSIVE_${code}`);
}
export function validatePassiveCommand(input: PassiveCommand) {
  assertEvidenceJson(input);
  const id = (v: unknown, max = 79) =>
    typeof v === "string" &&
    new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,${max}}$`).test(v);
  requirePassive(!!input && id(input.operation_id), "COMMAND");
  const keys = Object.keys(input).sort().join();
  if (input.action === "submit" || input.action === "replace") {
    requirePassive(
      keys ===
        (input.action === "submit"
          ? "action,intent,operation_id,order"
          : "action,intent,operation_id,order,order_id"),
      "COMMAND",
    );
    if (input.action === "replace")
      requirePassive(
        id(input.order_id, 159) && input.order_id !== input.order.order_id,
        "REPLACE_ID",
      );
    validateReservationCommand({
      action: "reserve",
      operation_id: input.operation_id,
      order: input.order,
    });
    const i = input.intent;
    requirePassive(
      !!i &&
        Object.keys(i).sort().join() ===
          "fee_metadata_id,limit_price_usd_raw,schema_version" &&
        i.schema_version === PASSIVE_VERSION &&
        typeof i.limit_price_usd_raw === "string" &&
        /^[1-9][0-9]{0,37}$/.test(i.limit_price_usd_raw) &&
        typeof i.fee_metadata_id === "string" &&
        i.fee_metadata_id.length > 0 &&
        i.fee_metadata_id.length <= 512,
      "INTENT",
    );
  } else
    requirePassive(
      input.action === "advance"
        ? keys === "action,operation_id"
        : input.action === "cancel" &&
            keys === "action,operation_id,order_id" &&
            id(input.order_id, 159),
      "COMMAND",
    );
}
