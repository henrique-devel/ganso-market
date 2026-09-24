/** Authenticated paper desk only. Decimal integers use USD6/BTC8, never floats. */
export type DeskCommand = { account_id: string } & (
  | {
      action: "submit";
      side: "buy" | "sell";
      quantity_btc_raw: string;
      limit_price_usd_raw: string;
      price_cap_usd_raw: string;
      valid_until: string;
      risk_plan: { stop_price_usd_raw: string; entry_floor_usd_raw: string };
    }
  | {
      action: "close";
      position_id: string;
      limit_price_usd_raw: string;
      price_cap_usd_raw: string;
      valid_until: string;
    }
  | { action: "cancel"; order_id: string }
  | { action: "pause" }
);
export interface DeskCommandEnvelope {
  schema_version: "trading.commands.v1";
  simulation: "SIMULAÇÃO";
  mode: "paper";
  account_id: string;
  idempotency_key: string;
  as_of: string;
}
export interface DeskCommandPreview extends DeskCommandEnvelope {
  intent: string;
  expires_at: string;
  guarantees_fill: false;
  revalidation_required: true;
  replay: boolean;
  estimate: null | {
    quantity_btc_raw: string;
    side: "buy" | "sell";
    reserved_margin_usd_raw: string;
    reserved_fees_usd_raw: string;
    maximum_notional_usd_raw: string;
    fee_basis: "public_base_tier_no_discounts";
    broker: "ioc" | "passive";
    risk_state: string | null;
    mark_quality: string;
    book_quality: string;
  };
}
export interface DeskCommandReceipt extends DeskCommandEnvelope {
  action: DeskCommand["action"];
  status: "accepted" | "cancelled" | "already_terminal" | "entries_paused";
  order_id: string | null;
  position_id: string | null;
  /** Admission/cancellation result only. Execution is a separate paper consumer. */
  execution: unknown;
}
