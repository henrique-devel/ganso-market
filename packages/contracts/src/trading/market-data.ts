import type { BtcPrice, BtcQuantity } from "./types.js";

/** Public observations, not execution evidence or a promise of historical coverage.
 * Separate from trading.v1 identities, whose source timestamp is mandatory.
 */
export interface TradingMarketObservation {
  readonly schema_version: "trading.market-data.v1";
  readonly instrument_id: string;
  readonly instrument_version: string;
  readonly source_id: "hyperliquid:mainnet:ws" | "hyperliquid:mainnet:info";
  readonly parser_version:
    | "hyperliquid.feed.v1"
    | "hyperliquid.context-snapshot.v1"
    | "hyperliquid.book-snapshot.v1";
  readonly channel: "book" | "trades" | "context";
  readonly key: string;
  readonly source_timestamp: string | null;
  readonly received_at: string;
  readonly payload_hash: string;
  readonly payload:
    | {
        readonly kind: "book";
        readonly semantics: "full_snapshot_top_20";
        readonly bids: readonly TradingBookLevel[];
        readonly asks: readonly TradingBookLevel[];
      }
    | {
        readonly kind: "trade";
        readonly side: "buy" | "sell";
        readonly price: BtcPrice;
        readonly quantity: BtcQuantity;
        /** (block_time, coin, tid); tid is a hash, NEVER a sequence. */
        readonly venue_trade_id: string;
      }
    | {
        readonly kind: "mark_funding";
        readonly mark_price: BtcPrice;
        readonly oracle_price: BtcPrice;
        /** Exact signed decimal, potentially more precise than ledger RATE. */
        readonly funding_rate: {
          readonly raw: string;
          readonly decimals: number;
        };
        readonly funding_semantics: "current_context_not_settled_payment";
        readonly funding_interval_seconds: 3600;
        readonly settlement_timestamp: null;
        /** Current-state HTTP response time; never a price-update timestamp. */
        readonly snapshot?: {
          readonly basis: "http_response_date";
          readonly requested_at: string;
          readonly received_at: string;
          readonly server_date: string;
          readonly cache_status: "Miss from cloudfront";
          readonly age: string | null;
          readonly raw_context: unknown;
        };
      };
}
export interface TradingBookLevel {
  readonly price: BtcPrice;
  readonly quantity: BtcQuantity;
  readonly orders: number;
}
export type TradingMarketData = TradingMarketObservation & {
  readonly quality: "fresh" | "stale" | "unknown";
  readonly gap_epoch: number;
  readonly revalidation:
    "none" | "current_state_only" | "delivery_resumed_only";
  /** No public sequence/coverage guarantee, including before an observed gap. */
  readonly continuity: "unproven";
};
