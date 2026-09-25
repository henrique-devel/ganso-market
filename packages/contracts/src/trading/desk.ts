import type { TradingAccount, TradingScope } from "./types.js";

/** Raw decimal integers; UTC RFC3339 timestamps; no float money or scenario total. */
export interface DeskEnvelope {
  readonly schema_version: "trading.desk.v1";
  readonly simulation: "SIMULAÇÃO";
  readonly mode: "paper";
  readonly as_of: string;
  readonly units: {
    readonly money: "USD/6";
    readonly quantity: "BTC/8";
    readonly price: "USD_PER_BTC/6";
    readonly cost_basis: "USD/14";
  };
}
export interface DeskReason {
  readonly component: "projection" | "mark" | "book" | "margin" | "orders";
  readonly code: string;
}
export interface DeskPage<T> extends DeskEnvelope {
  readonly scope: TradingScope | null;
  readonly status: "available" | "unavailable";
  readonly reason_codes: readonly DeskReason[];
  readonly items: readonly T[];
  /** Opaque, scoped keyset cursor. Each request is a new committed snapshot. */
  readonly next_cursor: string | null;
}
export interface DeskAccount {
  readonly account: TradingAccount;
  readonly scope: TradingScope;
  readonly status: "disabled";
  readonly strategy_version: string;
  readonly started_at: string;
}
export type DeskQuality =
  | "fresh"
  | "missing"
  | "incompatible"
  | "future"
  | "stale"
  | "feed_unavailable"
  | "source_time_unproven"
  | "invalid";
export interface DeskMarket {
  readonly quality: DeskQuality;
  readonly evidence: string | null;
  readonly source_timestamp: string | null;
  readonly received_at: string | null;
}
export interface DeskMark extends DeskMarket {
  readonly freshness_timestamp?: string | null;
  readonly timestamp_basis?: string;
  readonly mark_price_usd_raw: string | null;
  readonly oracle_price_usd_raw: string | null;
}
export interface DeskMargin {
  readonly mode: "isolated";
  readonly leverage: 1;
  readonly compatible: boolean;
  readonly metadata_valid: boolean;
  readonly free_cash_usd_raw: string;
  readonly open_collateral_usd_raw: string;
  readonly closed_deficit_usd_raw: string;
  readonly reserved_margin_usd_raw: string;
  readonly reserved_fees_usd_raw: string;
  /** Free cash less active holds; not an order acceptance/risk authorization. */
  readonly unreserved_cash_usd_raw: string;
}
export interface DeskBalances {
  readonly cash_usd_raw: string;
  readonly balance_usd_raw: string;
  readonly realized_pnl_usd_raw: string;
  readonly fees_usd_raw: string;
  readonly funding_usd_raw: string;
  readonly unrealized_pnl_usd_raw: string | null;
  readonly equity_usd_raw: string | null;
}
export interface DeskAccountView extends DeskEnvelope {
  readonly account: DeskAccount;
  readonly status: "available" | "unavailable";
  readonly reason_codes: readonly DeskReason[];
  readonly ledger_sequence: string | null;
  readonly ledger_recorded_at: string | null;
  readonly balances: DeskBalances | null;
  readonly margin: DeskMargin | null;
  readonly mark: DeskMark | null;
  readonly book: DeskMarket | null;
}
export interface DeskPosition {
  readonly position_id: string;
  readonly quantity_btc_raw: string;
  readonly cost_usd14_raw: string;
  readonly realized_usd14_raw: string;
  readonly collateral_usd_raw: string;
  readonly equity_usd_raw: string | null;
  readonly maintenance_usd_raw: string | null;
  /** Unknown valuation must not be displayed as safely non-liquidatable. */
  readonly liquidatable: boolean | null;
}
export interface DeskOrder {
  readonly order_id: string;
  readonly position_id: string;
  readonly source: "manual" | "strategy";
  readonly intent: "open" | "reduce";
  readonly side: "buy" | "sell";
  readonly quantity_btc_raw: string;
  readonly filled_btc_raw: string;
  readonly remaining_btc_raw: string;
  readonly price_cap_usd_raw: string;
  readonly valid_until: string;
  readonly status: "active" | "filled" | "cancelled" | "expired";
  readonly reserved_margin_usd_raw: string;
  readonly reserved_fees_usd_raw: string;
  readonly sequence: string;
  readonly recorded_at: string;
}

export interface DeskPositionPage extends DeskPage<DeskPosition> {
  readonly ledger_sequence: string | null;
  readonly ledger_recorded_at: string | null;
  readonly mark: DeskMark | null;
  readonly book: DeskMarket | null;
}
