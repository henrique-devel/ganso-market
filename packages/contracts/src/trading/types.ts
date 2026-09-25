import type {
  CanonicalIntegerString,
  Sha256Hex,
  UtcRfc3339Timestamp,
} from "../types.js";

export const TRADING_VERSION = "trading.v1" as const;
/** Domain precision, independent of venue tick/lot metadata. No implicit rounding. */
export const TRADING_DECIMALS = {
  BTC: 8,
  USD: 6,
  USD_PER_BTC: 6,
  RATE: 9,
  PROBABILITY: 6,
} as const;
export const TRADING_ROUNDING = "reject_inexact" as const;
export type TradingUnit = keyof typeof TRADING_DECIMALS;
export interface TradingAmount<U extends TradingUnit> {
  readonly unit: U;
  readonly decimals: (typeof TRADING_DECIMALS)[U];
  readonly raw: CanonicalIntegerString;
}
export type BtcQuantity = TradingAmount<"BTC">;
export type UsdAmount = TradingAmount<"USD">;
export type BtcPrice = TradingAmount<"USD_PER_BTC">;
/** Signed dimensionless ratio (not percent or basis points); funding may be negative. */
export type TradingRate = TradingAmount<"RATE">;
export type TradingProbability = TradingAmount<"PROBABILITY">;
export type TradingMode = "paper";
export type TradingSide = "buy" | "sell";

export interface TradingScope {
  readonly mode: TradingMode;
  readonly account_id: string;
  readonly experiment_id: string;
  readonly instrument_id: string;
  readonly instrument_version: string;
}
interface Versioned {
  readonly schema_version: typeof TRADING_VERSION;
}

/** Public data belongs to an instrument; account/experiment ownership starts at decisions. */
export interface TradingDataIdentity extends Versioned {
  readonly instrument_id: string;
  readonly instrument_version: string;
  readonly source_id: string;
  readonly source_event_id: string;
  readonly kind: "metadata" | "book" | "trade" | "mark" | "funding" | "bar";
  readonly source_timestamp: UtcRfc3339Timestamp;
  readonly received_at: UtcRfc3339Timestamp;
  readonly parser_version: string;
  readonly payload_hash: Sha256Hex;
  readonly quality: "fresh" | "stale" | "unknown";
}

export interface TradingInstrument extends Versioned {
  readonly instrument_id: string;
  readonly instrument_version: string;
  readonly venue_id: string;
  readonly venue_symbol: string;
  readonly kind: "linear_perpetual";
  readonly base_currency: "BTC";
  readonly quote_currency: "USD";
  readonly settlement_currency: "USD";
  readonly tick_size: BtcPrice;
  readonly quantity_step: BtcQuantity;
  readonly origin: TradingDataIdentity;
}
export interface TradingAccount extends Versioned {
  readonly account_id: string;
  readonly experiment_id: string;
  readonly mode: TradingMode;
  readonly purpose: "manual" | "baseline" | "challenger";
  readonly settlement_currency: "USD";
}
export interface TradingExperiment extends Versioned {
  readonly experiment_id: string;
  readonly mode: TradingMode;
  readonly manifest_hash: Sha256Hex;
  readonly strategy_version: string;
  readonly started_at: UtcRfc3339Timestamp;
}

export type TradingDecisionOrigin =
  | { readonly kind: "manual"; readonly actor_id: string }
  | {
      readonly kind: "strategy";
      readonly strategy_id: string;
      readonly strategy_version: string;
    }
  | {
      readonly kind: "model_filter";
      readonly strategy_id: string;
      readonly strategy_version: string;
      readonly model_id: string;
      readonly model_version: string;
      readonly response_id: string;
    };

export interface TradingDecision {
  readonly decision_id: string;
  readonly decided_at: UtcRfc3339Timestamp;
  readonly origin: TradingDecisionOrigin;
  readonly inputs: readonly TradingDataIdentity[];
}

/** IOC still has a price limit; GTD has a mandatory UTC expiry. */
export type TradingOrderTerms = {
  readonly side: TradingSide;
  readonly quantity: BtcQuantity;
  readonly limit_price: BtcPrice;
  readonly reduce_only: boolean;
} & (
  | { readonly time_in_force: "IOC" }
  | { readonly time_in_force: "GTD"; readonly expires_at: UtcRfc3339Timestamp }
);

export interface TradingIntent extends Versioned, TradingScope {
  readonly intent_id: string;
  readonly idempotency_key: string;
  readonly decision: TradingDecision;
  readonly terms: TradingOrderTerms;
}
/** Immutable accepted command. Lifecycle updates belong to append-only events. */
export interface TradingOrder extends Versioned, TradingScope {
  readonly order_id: string;
  readonly intent_id: string;
  readonly decision_id: string;
  readonly idempotency_key: string;
  readonly accepted_at: UtcRfc3339Timestamp;
  readonly terms: TradingOrderTerms;
}
export interface TradingExecution extends Versioned, TradingScope {
  readonly execution_id: string;
  readonly order_id: string;
  readonly intent_id: string;
  readonly decision_id: string;
  readonly idempotency_key: string;
  readonly executed_at: UtcRfc3339Timestamp;
  readonly side: TradingSide;
  readonly quantity: BtcQuantity;
  readonly price: BtcPrice;
  /** Positive charge, negative rebate. Ledger cash delta has the opposite sign. */
  readonly fee: UsdAmount;
  readonly liquidity: "maker" | "taker";
  readonly evidence: readonly TradingDataIdentity[];
}

export type PerpetualLedgerPayload =
  | {
      readonly event_type: "cash";
      readonly delta: UsdAmount;
      readonly reason: "initial_allocation" | "transfer";
    }
  | {
      readonly event_type: "margin_reserved" | "margin_released";
      readonly reservation_id: string;
      readonly order_id: string;
      readonly amount: UsdAmount;
    }
  | {
      readonly event_type: "fill";
      readonly execution_id: string;
      readonly order_id: string;
      readonly position_id: string;
      readonly side: TradingSide;
      readonly quantity: BtcQuantity;
      readonly price: BtcPrice;
    }
  | {
      readonly event_type: "fee";
      readonly execution_id: string;
      readonly delta: UsdAmount;
    }
  | {
      readonly event_type: "funding";
      readonly position_id: string;
      readonly period_start: UtcRfc3339Timestamp;
      readonly period_end: UtcRfc3339Timestamp;
      /** Legacy RATE9 or exact final funding RATE18; other rates stay RATE9. */
      readonly rate:
        | TradingRate
        | {
            readonly unit: "RATE";
            readonly decimals: 18;
            readonly raw: CanonicalIntegerString;
          };
      readonly delta: UsdAmount;
      readonly origin: TradingDataIdentity;
    }
  | {
      readonly event_type: "realized_pnl";
      readonly position_id: string;
      readonly execution_id: string;
      readonly delta: UsdAmount;
    }
  | {
      readonly event_type: "mark";
      readonly position_id: string;
      readonly price: BtcPrice;
      readonly unrealized_pnl: UsdAmount;
      readonly maintenance_margin: UsdAmount;
      readonly origin: TradingDataIdentity;
    }
  | {
      readonly event_type: "liquidation";
      readonly position_id: string;
      readonly execution_id: string;
    }
  | {
      readonly event_type: "reversal";
      readonly reverses_event_id: string;
      readonly reason: string;
    };

export interface PerpetualLedgerEvent extends Versioned, TradingScope {
  readonly event_id: string;
  readonly idempotency_key: string;
  /** Atomic group (e.g. fill + fee + realized PnL), assigned by the future store. */
  readonly transaction_id: string;
  /** Strictly positive, monotonic per account, assigned once by the store. */
  readonly sequence: CanonicalIntegerString;
  readonly cause_id: string;
  readonly occurred_at: UtcRfc3339Timestamp;
  readonly recorded_at: UtcRfc3339Timestamp;
  readonly payload: PerpetualLedgerPayload;
}

export interface TradingContracts {
  readonly instrument: TradingInstrument;
  readonly account: TradingAccount;
  readonly experiment: TradingExperiment;
  readonly data: TradingDataIdentity;
  readonly intent: TradingIntent;
  readonly order: TradingOrder;
  readonly execution: TradingExecution;
  readonly ledger: PerpetualLedgerEvent;
}
