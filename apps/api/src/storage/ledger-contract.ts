import {
  parseTradingContract,
  parseTradingAmount,
  tradingIdempotencyKey,
  type PerpetualLedgerEvent,
  type PerpetualLedgerPayload,
  type TradingAccount,
  type TradingExperiment,
  type TradingInstrument,
} from "@ganso-market/contracts/trading";
import { canonicalFingerprint } from "../trading/replay.js";
import { assertEvidenceJson } from "../trading/retention.js";

import { ledgerScope } from "../trading/ledger.js";
export const GENESIS_USD_RAW = "1000000000"; // USD, six decimals; fictitious.
export interface LedgerIdentity {
  readonly account: TradingAccount;
  readonly experiment: TradingExperiment;
  readonly instrument: TradingInstrument;
}
/** S1 deliberately accepts only these events. PnL, reserves and risk come later. */
export type LedgerPayload = Extract<
  PerpetualLedgerPayload,
  { event_type: "cash" | "fill" | "fee" | "funding" | "liquidation" }
>;
export type LedgerEvent = Omit<PerpetualLedgerEvent, "payload"> & {
  readonly payload: LedgerPayload;
};
export type LedgerCommand = Omit<
  PerpetualLedgerEvent,
  "sequence" | "recorded_at" | "transaction_id" | "payload"
> & { readonly payload: LedgerPayload };
export interface LedgerBatch {
  readonly transaction_id: string;
  /** Caller order is causal order inside the atomic transaction. */
  readonly events: readonly LedgerCommand[];
}
function requireLedger(ok: boolean, code: string): asserts ok {
  if (!ok) throw new Error(`BTC_LEDGER_${code}`);
}
export function validateLedgerIdentity(identity: LedgerIdentity): void {
  assertEvidenceJson(identity);
  requireLedger(
    Object.keys(identity).sort().join() === "account,experiment,instrument",
    "IDENTITY",
  );
  const account = parseTradingContract("account", identity.account);
  const experiment = parseTradingContract("experiment", identity.experiment);
  const instrument = parseTradingContract("instrument", identity.instrument);
  requireLedger(
    account.experiment_id === experiment.experiment_id &&
      instrument.instrument_id === "hyperliquid:mainnet:BTC" &&
      instrument.origin.received_at <= experiment.started_at,
    "IDENTITY",
  );
}
export function genesisBatch(identity: LedgerIdentity): LedgerBatch {
  validateLedgerIdentity(identity);
  const scope = ledgerScope(identity);
  return {
    transaction_id: "genesis",
    events: [
      {
        schema_version: "trading.v1",
        ...scope,
        event_id: "genesis",
        idempotency_key: tradingIdempotencyKey(scope, "ledger", "genesis"),
        cause_id: identity.experiment.experiment_id,
        occurred_at: identity.experiment.started_at,
        payload: {
          event_type: "cash",
          reason: "initial_allocation",
          delta: parseTradingAmount("USD", {
            unit: "USD",
            decimals: 6,
            raw: GENESIS_USD_RAW,
          }),
        },
      },
    ],
  };
}
export function materializeLedgerBatch(
  batch: LedgerBatch,
  previous: string,
  recordedAt: string,
): LedgerEvent[] {
  assertEvidenceJson(batch);
  requireLedger(
    Object.keys(batch).sort().join() === "events,transaction_id" &&
      batch.events.length > 0 &&
      batch.events.length <= 128 &&
      canonicalFingerprint(batch).length <= 1_048_576,
    "BATCH",
  );
  return batch.events.map((command, index) => {
    requireLedger(
      !["sequence", "recorded_at", "transaction_id"].some((key) =>
        Object.hasOwn(command, key),
      ),
      "STORE_FIELDS",
    );
    const event = parseTradingContract("ledger", {
      ...command,
      transaction_id: batch.transaction_id,
      sequence: (BigInt(previous) + BigInt(index) + 1n).toString(),
      recorded_at: recordedAt,
    });
    return parseLedgerEvent(event);
  });
}

/** Validate stored JSON as well as caller commands before pure reduction. */
export function parseLedgerEvent(value: unknown): LedgerEvent {
  const event = parseTradingContract("ledger", value);
  requireLedger(
    ["cash", "fill", "fee", "funding", "liquidation"].includes(
      event.payload.event_type,
    ),
    "UNSUPPORTED_EVENT",
  );
  return event as LedgerEvent;
}
