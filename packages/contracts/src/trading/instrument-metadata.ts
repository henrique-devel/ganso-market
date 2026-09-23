import type {
  TradingInstrument,
  TradingRate,
  UsdAmount,
  BtcQuantity,
  BtcPrice,
} from "./types.js";
import { parseTradingAmount, assertTradingQuantum } from "./amount.js";

/** Additive metadata envelope: venue currencies are distinct from paper USD units. */
export interface TradingInstrumentMetadata {
  readonly schema_version: "trading.instrument-metadata.v1";
  readonly instrument: TradingInstrument;
  readonly venue_asset_index: number;
  readonly price_rules: {
    readonly max_decimals: number;
    readonly max_significant_digits: number;
    readonly integer_prices_exempt: boolean;
  };
  readonly minimum_order_notional: UsdAmount;
  readonly collateral: {
    readonly token_index: number;
    readonly currency: string;
    readonly oracle_quote_currency: string;
    readonly pnl_conversion: "numerical_parity_no_fx_conversion";
  };
  readonly fees: {
    readonly basis: "public_base_tier_no_discounts";
    readonly maker: TradingRate;
    readonly taker: TradingRate;
    readonly account_effective: null;
    readonly unknown_reason: string;
  };
  readonly margin: {
    readonly table_id: number;
    readonly max_leverage: number;
    readonly mode_constraint:
      "cross_or_isolated" | "strict_isolated" | "isolated_only";
    readonly tiers: readonly {
      readonly lower_bound: UsdAmount;
      readonly max_leverage: number;
      /** Exact fraction 1/(2*max_leverage); never round a repeating rate. */
      readonly maintenance_rate: {
        readonly numerator: string;
        readonly denominator: string;
      };
    }[];
    readonly maintenance_rule: "tier_rate_times_notional_minus_cumulative_deduction";
    readonly selected_leverage: null;
  };
  readonly funding: {
    readonly interval_seconds: number;
    readonly formula_period_seconds: number;
    readonly interest_rate_per_formula_period: TradingRate;
    readonly premium_clamp: TradingRate;
    readonly max_absolute_rate_per_interval: TradingRate;
    readonly impact_notional: UsdAmount;
    readonly payment_price: "oracle";
    readonly positive_rate_payer: "long";
    readonly current_rate: null;
    readonly unknown_reason: string;
  };
  readonly provenance: {
    readonly sdk: string;
    readonly parser_version: string;
    readonly endpoint: string;
    readonly request: { readonly type: "meta"; readonly dex: "" };
    readonly response_hash: string;
    /** meta has no venue timestamp/revision; observation time is not freshness. */
    readonly venue_timestamp: null;
    readonly venue_revision: null;
    readonly reference_version: string;
    readonly reference_checked_on: string;
    readonly sources: Readonly<Record<string, string>>;
  };
}

/** Additional venue constraints required alongside trading.v1 intent validation.
 * tick_size is the finest decimal quantum, not a substitute for significant digits.
 * No rounding, price I/O, account defaults, or reduce-only exceptions are inferred.
 */
export function assertInstrumentOrderConstraints(
  metadata: TradingInstrumentMetadata,
  price: BtcPrice,
  quantity: BtcQuantity,
): void {
  const px = BigInt(parseTradingAmount("USD_PER_BTC", price).raw);
  const qty = BigInt(parseTradingAmount("BTC", quantity).raw);
  if (px <= 0n || qty <= 0n)
    throw new TypeError("Price and quantity must be positive");
  assertTradingQuantum(price, metadata.instrument.tick_size);
  assertTradingQuantum(quantity, metadata.instrument.quantity_step);
  const rules = metadata.price_rules;
  if (
    !Number.isInteger(rules.max_decimals) ||
    rules.max_decimals < 0 ||
    rules.max_decimals > 6 ||
    !Number.isInteger(rules.max_significant_digits) ||
    rules.max_significant_digits < 1
  ) {
    throw new TypeError("Invalid price rules");
  }
  if (px % 10n ** BigInt(6 - rules.max_decimals) !== 0n) {
    throw new TypeError("Price exceeds decimal precision");
  }
  const integer = px % 1_000_000n === 0n;
  const significantDigits = px.toString().replace(/0+$/, "").length;
  if (
    !(integer && rules.integer_prices_exempt) &&
    significantDigits > rules.max_significant_digits
  ) {
    throw new TypeError("Price exceeds significant digits");
  }
  const minimum = BigInt(
    parseTradingAmount("USD", metadata.minimum_order_notional).raw,
  );
  if (minimum <= 0n || px * qty < minimum * 100_000_000n) {
    throw new TypeError("Order below minimum notional");
  }
}
