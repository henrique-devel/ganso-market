import type { DeskEnvelope, DeskOrder } from "./desk.js";
import type { PerpetualLedgerEvent, TradingScope } from "./types.js";

/** Persisted facts only. Null is missing evidence, never a reconstructed cause. */
export interface DeskOperation extends DeskEnvelope {
  readonly scope: TradingScope;
  readonly view: "events" | "receipts";
  readonly order: Pick<
    DeskOrder,
    | "order_id"
    | "position_id"
    | "source"
    | "intent"
    | "side"
    | "quantity_btc_raw"
    | "price_cap_usd_raw"
    | "valid_until"
  > & {
    readonly fee_bps: number;
    readonly risk_plan?: {
      stop_price_usd_raw: string;
      entry_floor_usd_raw: string;
    };
  };
  readonly accepted_at: string;
  readonly broker: "ioc" | "passive" | null;
  readonly execution_input: {
    readonly limit_price_usd_raw: string;
    readonly fee_metadata_id: string;
    readonly decision_at?: string;
    readonly latency_ms?: number;
  } | null;
  readonly decision_evidence_id: string | null;
  readonly protective_exit: { reason: string; triggered_at: string } | null;
  readonly events: readonly {
    sequence: string;
    operation_id: string;
    action: "reserve" | "consume" | "release";
    reason: "cancelled" | "expired" | null;
    recorded_at: string;
    status: DeskOrder["status"];
    remaining_btc_raw: string;
    ledger: readonly PerpetualLedgerEvent[];
  }[];
  readonly receipts: readonly {
    cursor: string;
    operation_id: string;
    reason: string;
    evidence_id: string;
    recorded_at: string;
    book_key: string | null;
  }[];
  readonly next_cursor: string | null;
}
