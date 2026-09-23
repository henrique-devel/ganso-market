import { ledgerScope } from "../../src/trading/ledger.js";
import type { Sha256Hex, UtcRfc3339Timestamp } from "@ganso-market/contracts";
import {
  tradingIdempotencyKey,
  parseTradingAmount,
  type TradingScope,
} from "@ganso-market/contracts/trading";
import {
  type LedgerIdentity,
  type LedgerPayload,
  type LedgerCommand,
} from "../../src/storage/ledger-contract.js";
import { metadata, iso as formatIso, start } from "./bars-fixture.js";
export { start };
export const iso = (at: number) => formatIso(at) as UtcRfc3339Timestamp;
export const usd = (raw: string) =>
  parseTradingAmount("USD", { unit: "USD", decimals: 6, raw });
export function identity(id = "manual"): LedgerIdentity {
  return {
    account: {
      schema_version: "trading.v1",
      mode: "paper",
      account_id: id,
      experiment_id: `experiment:${id}`,
      purpose: "manual",
      settlement_currency: "USD",
    },
    experiment: {
      schema_version: "trading.v1",
      mode: "paper",
      experiment_id: `experiment:${id}`,
      manifest_hash: "a".repeat(64) as Sha256Hex,
      strategy_version: "manual.v1",
      started_at: iso(start),
    },
    instrument: metadata.instrument,
  };
}
export function command(
  id: string,
  payload: LedgerPayload,
  scope: TradingScope = ledgerScope(identity()),
  at = start + 1000,
): LedgerCommand {
  return {
    schema_version: "trading.v1",
    ...scope,
    event_id: id,
    idempotency_key: tradingIdempotencyKey(scope, "ledger", id),
    cause_id: "fixture",
    occurred_at: iso(at),
    payload,
  };
}
export function fill(
  execution = "exec:1",
  side: "buy" | "sell" = "buy",
  quantity = "1000000",
): LedgerPayload {
  return {
    event_type: "fill",
    execution_id: execution,
    order_id: "order:1",
    position_id: "position:1",
    side,
    quantity: parseTradingAmount("BTC", {
      unit: "BTC",
      decimals: 8,
      raw: quantity,
    }),
    price: parseTradingAmount("USD_PER_BTC", {
      unit: "USD_PER_BTC",
      decimals: 6,
      raw: "64000000000",
    }),
  };
}
export function funding(delta = "-250000"): LedgerPayload {
  return {
    event_type: "funding",
    position_id: "position:1",
    period_start: iso(start),
    period_end: iso(start + 1000),
    rate: parseTradingAmount("RATE", {
      unit: "RATE",
      decimals: 9,
      raw: "100000",
    }),
    delta: usd(delta),
    origin: {
      ...metadata.instrument.origin,
      kind: "funding",
      source_timestamp: iso(start + 1000),
      received_at: iso(start + 1000),
    },
  };
}
