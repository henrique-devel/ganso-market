import type { AnySchemaObject } from "ajv";
import {
  TRADING_DECIMALS,
  TRADING_VERSION,
  type TradingContracts,
  type TradingUnit,
} from "./types.js";

const exact = (
  properties: Record<string, AnySchemaObject>,
): AnySchemaObject => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const choice = (...values: string[]): AnySchemaObject => ({
  type: "string",
  enum: values,
});
const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$" };
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const timestamp = { type: "string", format: "utc-milliseconds" };
const key = { type: "string", minLength: 1 };
const version = { schema_version: { const: TRADING_VERSION } };
const instrumentRef = { instrument_id: id, instrument_version: id };
const scope = {
  ...instrumentRef,
  account_id: id,
  experiment_id: id,
  mode: choice("paper"),
};
const amount = (
  unit: TradingUnit,
  sign: "signed" | "positive" | "nonnegative" = "signed",
) =>
  exact({
    unit: { const: unit },
    decimals: { const: TRADING_DECIMALS[unit] },
    raw: {
      type: "string",
      pattern:
        sign === "positive"
          ? "^[1-9][0-9]*$"
          : sign === "nonnegative"
            ? "^(?:0|[1-9][0-9]*)$"
            : "^(?:0|-?[1-9][0-9]*)$",
    },
  });
const data = exact({
  ...version,
  ...instrumentRef,
  source_id: id,
  source_event_id: id,
  kind: choice("metadata", "book", "trade", "mark", "funding", "bar"),
  source_timestamp: timestamp,
  received_at: timestamp,
  parser_version: id,
  payload_hash: hash,
  quality: choice("fresh", "stale", "unknown"),
});
const inputs = { type: "array", minItems: 1, uniqueItems: true, items: data };
const origin = {
  oneOf: [
    exact({ kind: choice("manual"), actor_id: id }),
    exact({ kind: choice("strategy"), strategy_id: id, strategy_version: id }),
    exact({
      kind: choice("model_filter"),
      strategy_id: id,
      strategy_version: id,
      model_id: id,
      model_version: id,
      response_id: id,
    }),
  ],
};
const commonTerms = {
  side: choice("buy", "sell"),
  quantity: amount("BTC", "positive"),
  limit_price: amount("USD_PER_BTC", "positive"),
  reduce_only: { type: "boolean" },
};
const terms = {
  oneOf: [
    exact({ ...commonTerms, time_in_force: choice("IOC") }),
    exact({
      ...commonTerms,
      time_in_force: choice("GTD"),
      expires_at: timestamp,
    }),
  ],
};
const payload = {
  oneOf: [
    exact({
      event_type: choice("cash"),
      delta: amount("USD"),
      reason: choice("initial_allocation", "transfer"),
    }),
    exact({
      event_type: choice("margin_reserved", "margin_released"),
      reservation_id: id,
      order_id: id,
      amount: amount("USD", "positive"),
    }),
    exact({
      event_type: choice("fill"),
      execution_id: id,
      order_id: id,
      position_id: id,
      side: choice("buy", "sell"),
      quantity: amount("BTC", "positive"),
      price: amount("USD_PER_BTC", "positive"),
    }),
    exact({
      event_type: choice("fee"),
      execution_id: id,
      delta: amount("USD"),
    }),
    exact({
      event_type: choice("funding"),
      position_id: id,
      period_start: timestamp,
      period_end: timestamp,
      rate: {
        oneOf: [
          amount("RATE"),
          exact({
            unit: { const: "RATE" },
            decimals: { const: 18 },
            raw: { type: "string", pattern: "^(?:0|-?[1-9][0-9]*)$" },
          }),
        ],
      },
      delta: amount("USD"),
      origin: data,
    }),
    exact({
      event_type: choice("realized_pnl"),
      position_id: id,
      execution_id: id,
      delta: amount("USD"),
    }),
    exact({
      event_type: choice("mark"),
      position_id: id,
      price: amount("USD_PER_BTC", "positive"),
      unrealized_pnl: amount("USD"),
      maintenance_margin: amount("USD", "nonnegative"),
      origin: data,
    }),
    exact({
      event_type: choice("liquidation"),
      position_id: id,
      execution_id: id,
    }),
    exact({
      event_type: choice("reversal"),
      reverses_event_id: id,
      reason: id,
    }),
  ],
};

/** JSON shapes; parseTradingContract also checks temporal, ownership and ID invariants. */
export const tradingSchemas: Readonly<
  Record<keyof TradingContracts, AnySchemaObject>
> = {
  instrument: exact({
    ...version,
    ...instrumentRef,
    venue_id: id,
    venue_symbol: id,
    kind: choice("linear_perpetual"),
    base_currency: choice("BTC"),
    quote_currency: choice("USD"),
    settlement_currency: choice("USD"),
    tick_size: amount("USD_PER_BTC", "positive"),
    quantity_step: amount("BTC", "positive"),
    origin: data,
  }),
  account: exact({
    ...version,
    account_id: id,
    experiment_id: id,
    mode: choice("paper"),
    purpose: choice("manual", "baseline", "challenger"),
    settlement_currency: choice("USD"),
  }),
  experiment: exact({
    ...version,
    experiment_id: id,
    mode: choice("paper"),
    manifest_hash: hash,
    strategy_version: id,
    started_at: timestamp,
  }),
  data,
  intent: exact({
    ...version,
    ...scope,
    intent_id: id,
    idempotency_key: key,
    decision: exact({ decision_id: id, decided_at: timestamp, origin, inputs }),
    terms,
  }),
  order: exact({
    ...version,
    ...scope,
    order_id: id,
    intent_id: id,
    decision_id: id,
    idempotency_key: key,
    accepted_at: timestamp,
    terms,
  }),
  execution: exact({
    ...version,
    ...scope,
    execution_id: id,
    order_id: id,
    intent_id: id,
    decision_id: id,
    idempotency_key: key,
    executed_at: timestamp,
    side: choice("buy", "sell"),
    quantity: amount("BTC", "positive"),
    price: amount("USD_PER_BTC", "positive"),
    fee: amount("USD"),
    liquidity: choice("maker", "taker"),
    evidence: inputs,
  }),
  ledger: exact({
    ...version,
    ...scope,
    event_id: id,
    idempotency_key: key,
    transaction_id: id,
    sequence: { type: "string", pattern: "^[1-9][0-9]*$" },
    cause_id: id,
    occurred_at: timestamp,
    recorded_at: timestamp,
    payload,
  }),
};
