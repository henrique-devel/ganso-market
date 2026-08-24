// Polymarket recorder domain types (RFC-007 anticipation). Prices and sizes are
// always canonical decimal strings; they are never parsed into floats for
// storage or money math.

export interface PriceLevel {
  readonly price: string;
  readonly size: string;
}

export interface MarketRegistryEntry {
  readonly conditionId: string;
  readonly question: string;
  readonly slug: string | null;
  readonly category: string | null;
  readonly negRisk: boolean;
  readonly clobTokenIds: readonly string[];
  readonly rules: string | null;
  readonly tickSize: string | null;
  readonly minOrderSize: string | null;
  readonly rewardsMinSize: string | null;
  readonly rewardsMaxSpread: string | null;
  readonly feeType: string | null;
  readonly endDateIso: string | null;
  readonly active: boolean;
  readonly closed: boolean;
  readonly enableOrderBook: boolean;
}

// WebSocket market-channel message shapes (verified against the live feed).
export interface BookMessage {
  readonly event_type: "book";
  readonly market: string;
  readonly asset_id: string;
  readonly timestamp: string;
  readonly hash: string;
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
}

export interface PriceChangeEntry {
  readonly asset_id: string;
  readonly price: string;
  readonly size: string;
  readonly side: "BUY" | "SELL";
}

export interface PriceChangeMessage {
  readonly event_type: "price_change";
  readonly market: string;
  readonly price_changes: readonly PriceChangeEntry[];
  readonly timestamp: string;
}

export interface LastTradePriceMessage {
  readonly event_type: "last_trade_price";
  readonly market: string;
  readonly asset_id: string;
  readonly price: string;
  readonly side: "BUY" | "SELL";
  readonly timestamp: string;
  // The live feed also sends these on last_trade_price. Optional because the
  // venue schema is tolerant: a missing field never drops the trade, it just
  // persists as NULL. transaction_hash is the WS dedupe key and the future
  // onchain reconciliation join key (RFC-011).
  readonly size?: string;
  readonly fee_rate_bps?: string;
  readonly transaction_hash?: string;
}

export interface TickSizeChangeMessage {
  readonly event_type: "tick_size_change";
  readonly market: string;
  readonly asset_id: string;
  readonly old_tick_size: string;
  readonly new_tick_size: string;
  readonly timestamp: string;
}

export type MarketMessage =
  | BookMessage
  | PriceChangeMessage
  | LastTradePriceMessage
  | TickSizeChangeMessage;
