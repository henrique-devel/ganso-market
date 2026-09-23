import { assertEvidenceJson } from "../trading/retention.js";
import {
  BROKER_VERSION,
  type IocIntent,
  type IocFill,
} from "../trading/broker.js";
import type { Reservation, ReservationOrder } from "../trading/reservations.js";
import { validateReservationCommand } from "./reservation-contract.js";
export type IocCommand =
  | {
      action: "submit";
      operation_id: string;
      order: ReservationOrder;
      intent: IocIntent;
    }
  | { action: "execute" | "cancel"; operation_id: string; order_id: string };
export interface IocResult {
  schema_version: typeof BROKER_VERSION;
  /** Separate accounts are explicitly counterfactual markets, never pooled capital. */
  market_id: string;
  status: "accepted" | "waiting" | "filled" | "cancelled" | "expired";
  reason: string;
  reservation: Reservation;
  fills: IocFill[];
  book_key: string | null;
  side: "buy" | "sell";
  fee_basis: "public_base_tier_no_discounts" | null;
  account_effective_fee: null;
  evidence_id: string | null;
}
export function requireIoc(ok: boolean, code: string): asserts ok {
  if (!ok) throw new Error(`BTC_IOC_${code}`);
}
export function validateIocCommand(input: IocCommand) {
  assertEvidenceJson(input);
  const id = (s: unknown) =>
    typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(s);
  const keys = Object.keys(input).sort().join();
  requireIoc(id(input.operation_id), "COMMAND");
  if (input.action === "submit") {
    requireIoc(keys === "action,intent,operation_id,order", "COMMAND");
    validateReservationCommand({
      action: "reserve",
      operation_id: input.operation_id,
      order: input.order,
    });
    const i = input.intent,
      at = Date.parse(i.decision_at);
    requireIoc(
      Object.keys(i).sort().join() ===
        "decision_at,fee_metadata_id,latency_ms,limit_price_usd_raw,schema_version" &&
        i.schema_version === BROKER_VERSION &&
        Number.isSafeInteger(at) &&
        at >= 0 &&
        new Date(at).toISOString() === i.decision_at &&
        Number.isSafeInteger(i.latency_ms) &&
        i.latency_ms >= 0 &&
        i.latency_ms <= 60_000 &&
        /^[1-9][0-9]{0,37}$/.test(i.limit_price_usd_raw) &&
        typeof i.fee_metadata_id === "string" &&
        i.fee_metadata_id.length > 0 &&
        i.fee_metadata_id.length <= 512,
      "INTENT",
    );
  } else
    requireIoc(
      ["execute", "cancel"].includes(input.action) &&
        keys === "action,operation_id,order_id" &&
        typeof input.order_id === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(input.order_id),
      "COMMAND",
    );
}
