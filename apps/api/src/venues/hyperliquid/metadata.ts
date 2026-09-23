import { createHash } from "node:crypto";
import {
  parseTradingAmount,
  parseTradingContract,
  TRADING_DECIMALS,
  TRADING_VERSION,
  type TradingAmount,
  type TradingUnit,
  type TradingInstrumentMetadata,
} from "@ganso-market/contracts/trading";
import { canonicalFingerprint } from "../../trading/replay.js";
import { parseScaled } from "../../trading/fixed.js";
import { HYPERLIQUID_REFERENCE as reference } from "./reference.js";

export const HYPERLIQUID_SDK = "@nktkas/hyperliquid@0.33.3";
export const HYPERLIQUID_PARSER_VERSION = "hyperliquid.meta.v1";
export const HYPERLIQUID_API_URL = "https://api.hyperliquid.xyz";

export class HyperliquidMetadataError extends Error {
  constructor(
    readonly code: "incompatible_response" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "HyperliquidMetadataError";
  }
}
function reject(message: string): never {
  throw new HyperliquidMetadataError("incompatible_response", message);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    reject("Expected metadata object");
  return value as Record<string, unknown>;
}
function integer(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    reject("Invalid metadata integer");
  return value;
}
function amount<U extends TradingUnit>(
  unit: U,
  value: unknown,
): TradingAmount<U> {
  if (typeof value !== "string" || value.length > 80)
    reject("Invalid decimal metadata");
  const scaled = parseScaled(value);
  const divisor = 10n ** BigInt(9 - TRADING_DECIMALS[unit]);
  if (scaled === null || scaled < 0n || scaled % divisor !== 0n)
    reject("Inexact or negative decimal metadata");
  return parseTradingAmount(unit, {
    raw: (scaled / divisor).toString(),
    unit,
    decimals: TRADING_DECIMALS[unit],
  });
}
function hash(value: unknown): string {
  return createHash("sha256").update(canonicalFingerprint(value)).digest("hex");
}

/** Runtime validation is mandatory: the SDK types its response but does not parse it.
 * Unknown additive fields are tolerated; consumed fields and relationships fail closed.
 */
export function parseHyperliquidBtcMetadata(
  response: unknown,
  receivedAt: string,
): TradingInstrumentMetadata {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(receivedAt) ||
    !Number.isFinite(Date.parse(receivedAt)) ||
    new Date(receivedAt).toISOString() !== receivedAt
  )
    reject("Invalid observation timestamp");
  const meta = record(response);
  if (!Array.isArray(meta.universe) || !Array.isArray(meta.marginTables))
    reject("Missing universe or margin tables");
  const universe = meta.universe.map(record);
  const matches = universe.filter((asset) => asset.name === "BTC");
  if (matches.length !== 1)
    reject("Expected exactly one standard BTC perpetual");
  const btc = matches[0]!;
  const assetIndex = universe.indexOf(btc);
  const szDecimals = integer(btc.szDecimals, 0, 6);
  const maxLeverage = integer(btc.maxLeverage, 1);
  const tableId = integer(btc.marginTableId, 1);
  if (meta.collateralToken !== reference.collateral_token_index)
    reject("Unsupported collateral token");
  if (btc.isDelisted !== undefined && btc.isDelisted !== false)
    reject("BTC is delisted or has incompatible status");
  if (btc.growthMode !== undefined)
    reject("Unexpected growth mode for standard BTC");
  if (btc.onlyIsolated !== undefined && typeof btc.onlyIsolated !== "boolean")
    reject("Invalid isolated flag");
  let mode: TradingInstrumentMetadata["margin"]["mode_constraint"];
  if (btc.marginMode === "strictIsolated") mode = "strict_isolated";
  else if (btc.marginMode === "noCross") mode = "isolated_only";
  else if (btc.marginMode === undefined && btc.onlyIsolated !== true)
    mode = "cross_or_isolated";
  else reject("Unknown margin mode; deprecated flag is insufficient");
  if (btc.onlyIsolated === false && mode !== "cross_or_isolated")
    reject("Contradictory margin flags");
  const tables = meta.marginTables
    .map((value) => {
      if (!Array.isArray(value) || value.length !== 2)
        reject("Invalid margin table entry");
      return { id: integer(value[0], 1), table: record(value[1]) };
    })
    .filter((entry) => entry.id === tableId);
  if (tables.length > 1) reject("Duplicate BTC margin table");
  // Official convention: table IDs below 50 are single-tier max leverage IDs.
  const rawTiers =
    tables.length === 1
      ? tables[0]!.table.marginTiers
      : tableId < 50
        ? [{ lowerBound: "0", maxLeverage: tableId }]
        : null;
  if (!Array.isArray(rawTiers) || rawTiers.length === 0)
    reject("BTC margin table unavailable");
  const tiers = rawTiers.map((value) => {
    const tier = record(value);
    const leverage = integer(tier.maxLeverage, 1, maxLeverage);
    return {
      lower_bound: amount("USD", tier.lowerBound),
      max_leverage: leverage,
      maintenance_rate: {
        numerator: "1",
        denominator: (2n * BigInt(leverage)).toString(),
      },
    };
  });
  if (
    tiers[0]!.lower_bound.raw !== "0" ||
    tiers[0]!.max_leverage !== maxLeverage
  )
    reject("Inconsistent base margin tier");
  for (let i = 1; i < tiers.length; i++) {
    if (
      BigInt(tiers[i]!.lower_bound.raw) <=
        BigInt(tiers[i - 1]!.lower_bound.raw) ||
      tiers[i]!.max_leverage >= tiers[i - 1]!.max_leverage
    )
      reject("Invalid margin tier order");
  }
  const rules = {
    venue_asset_index: assetIndex,
    price_rules: {
      max_decimals: reference.price_max_decimals - szDecimals,
      max_significant_digits: reference.price_significant_digits,
      integer_prices_exempt: reference.integer_prices_exempt,
    },
    minimum_order_notional: amount("USD", reference.minimum_order_notional),
    collateral: {
      token_index: reference.collateral_token_index,
      currency: reference.collateral_currency,
      oracle_quote_currency: reference.oracle_quote_currency,
      pnl_conversion: "numerical_parity_no_fx_conversion" as const,
    },
    fees: {
      basis: "public_base_tier_no_discounts" as const,
      maker: amount("RATE", reference.maker_rate),
      taker: amount("RATE", reference.taker_rate),
      account_effective: null,
      unknown_reason:
        "No account queried; discounts, rebates and effective account fees are unknown",
    },
    margin: {
      table_id: tableId,
      max_leverage: maxLeverage,
      mode_constraint: mode,
      tiers,
      maintenance_rule:
        "tier_rate_times_notional_minus_cumulative_deduction" as const,
      selected_leverage: null,
    },
    funding: {
      interval_seconds: reference.funding_interval_seconds,
      formula_period_seconds: reference.funding_formula_period_seconds,
      interest_rate_per_formula_period: amount(
        "RATE",
        reference.funding_interest_per_formula_period,
      ),
      premium_clamp: amount("RATE", reference.funding_premium_clamp),
      max_absolute_rate_per_interval: amount(
        "RATE",
        reference.funding_max_absolute_rate_per_interval,
      ),
      impact_notional: amount("USD", reference.funding_impact_notional),
      payment_price: "oracle" as const,
      positive_rate_payer: "long" as const,
      current_rate: null,
      unknown_reason:
        "meta contains no interval funding rate; the feed is delivered in G2-04.2",
    },
  };
  const instrumentId = "hyperliquid:mainnet:BTC";
  // Unrelated assets, receipt time and mutable market context do not churn the version.
  const payloadHash = hash({
    instrumentId,
    szDecimals,
    rules,
    reference,
    parser: HYPERLIQUID_PARSER_VERSION,
    sdk: HYPERLIQUID_SDK,
  });
  const instrumentVersion = `hl-btc-${payloadHash}`;
  const instrument = parseTradingContract("instrument", {
    schema_version: TRADING_VERSION,
    instrument_id: instrumentId,
    instrument_version: instrumentVersion,
    venue_id: "hyperliquid",
    venue_symbol: "BTC",
    kind: "linear_perpetual",
    base_currency: "BTC",
    // These are paper accounting units. Actual venue quote/collateral are above.
    quote_currency: "USD",
    settlement_currency: "USD",
    tick_size: parseTradingAmount("USD_PER_BTC", {
      unit: "USD_PER_BTC",
      decimals: 6,
      raw: (10n ** BigInt(szDecimals)).toString(),
    }),
    quantity_step: parseTradingAmount("BTC", {
      unit: "BTC",
      decimals: 8,
      raw: (10n ** BigInt(8 - szDecimals)).toString(),
    }),
    origin: {
      schema_version: TRADING_VERSION,
      instrument_id: instrumentId,
      instrument_version: instrumentVersion,
      source_id: "hyperliquid:mainnet:meta-observation",
      source_event_id: payloadHash,
      kind: "metadata",
      // Timestamp of the LOCAL observation, not a venue event. Never mark it fresh.
      source_timestamp: receivedAt,
      received_at: receivedAt,
      parser_version: HYPERLIQUID_PARSER_VERSION,
      payload_hash: payloadHash,
      quality: "unknown",
    },
  });
  return {
    schema_version: "trading.instrument-metadata.v1",
    instrument,
    ...rules,
    provenance: {
      sdk: HYPERLIQUID_SDK,
      parser_version: HYPERLIQUID_PARSER_VERSION,
      endpoint: `${HYPERLIQUID_API_URL}/info`,
      request: { type: "meta", dex: "" },
      response_hash: hash(response),
      venue_timestamp: null,
      venue_revision: null,
      reference_version: reference.version,
      reference_checked_on: reference.checked_on,
      sources: { ...reference.sources },
    },
  };
}
