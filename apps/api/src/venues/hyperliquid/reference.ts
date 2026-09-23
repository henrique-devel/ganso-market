/** Reviewed official documentation, not live account fees or chosen leverage.
 * Bump the revision whenever any assumption changes; it participates in the hash.
 */
export const HYPERLIQUID_REFERENCE = {
  version: "hyperliquid-mainnet-btc.2026-09-23.1",
  checked_on: "2026-09-23",
  sources: {
    api: "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals",
    precision:
      "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size",
    minimum:
      "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses",
    specifications:
      "https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications",
    fees: "https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees",
    margin: "https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margining",
    tiers:
      "https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margin-tiers",
    funding: "https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding",
  },
  price_max_decimals: 6,
  price_significant_digits: 5,
  integer_prices_exempt: true,
  minimum_order_notional: "10",
  collateral_token_index: 0,
  collateral_currency: "USDC",
  oracle_quote_currency: "USDT",
  maker_rate: "0.00015",
  taker_rate: "0.00045",
  funding_interval_seconds: 3600,
  funding_formula_period_seconds: 28800,
  funding_interest_per_formula_period: "0.0001",
  funding_premium_clamp: "0.0005",
  funding_max_absolute_rate_per_interval: "0.04",
  funding_impact_notional: "20000",
} as const;
