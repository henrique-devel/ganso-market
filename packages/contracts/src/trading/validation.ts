import AjvModule from "ajv";
import type { ValidateFunction } from "ajv";
import { assertTradingQuantum } from "./amount.js";
import { tradingSchemas } from "./schemas.js";
import {
  TRADING_VERSION,
  type TradingContracts,
  type TradingScope,
  type TradingDataIdentity,
  type TradingOrderTerms,
} from "./types.js";

const ajv = new AjvModule.default({
  strict: true,
  allErrors: false,
  ownProperties: true,
});
ajv.addFormat(
  "utc-milliseconds",
  (value: string) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value,
);
const validators = Object.fromEntries(
  Object.entries(tradingSchemas).map(([kind, schema]) => [
    kind,
    ajv.compile(schema),
  ]),
) as Record<keyof TradingContracts, ValidateFunction>;
function requireContract(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) throw new TypeError(message);
}

/** Stable tuple, not a hash of timestamps or payload: retries must reuse the logical ID. */
export function tradingIdempotencyKey(
  scope: TradingScope,
  kind: "intent" | "order" | "execution" | "ledger",
  logicalId: string,
): string {
  requireContract(
    scope.mode === "paper" &&
      [
        scope.account_id,
        scope.experiment_id,
        scope.instrument_id,
        scope.instrument_version,
        logicalId,
      ].every(
        (id) =>
          typeof id === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/.test(id),
      ) &&
      ["intent", "order", "execution", "ledger"].includes(kind),
    "Invalid idempotency identity",
  );
  return JSON.stringify([
    TRADING_VERSION,
    scope.mode,
    scope.account_id,
    scope.experiment_id,
    scope.instrument_id,
    kind,
    logicalId,
  ]);
}
function sameInstrument(
  a: { instrument_id: string; instrument_version: string },
  b: { instrument_id: string; instrument_version: string },
): void {
  requireContract(
    a.instrument_id === b.instrument_id &&
      a.instrument_version === b.instrument_version,
    "Instrument identity mismatch",
  );
}
function sameScope(a: TradingScope, b: TradingScope): void {
  sameInstrument(a, b);
  requireContract(
    a.mode === b.mode &&
      a.account_id === b.account_id &&
      a.experiment_id === b.experiment_id,
    "Account or experiment mismatch",
  );
}
function knownInputs(
  scope: { instrument_id: string; instrument_version: string },
  inputs: readonly TradingDataIdentity[],
  at: string,
): void {
  for (const input of inputs) {
    sameInstrument(scope, input);
    requireContract(
      input.received_at <= at && input.source_timestamp <= at,
      "Data was unavailable at event time",
    );
  }
}
function unexpired(terms: TradingOrderTerms, at: string): void {
  requireContract(
    terms.time_in_force !== "GTD" || terms.expires_at > at,
    "Order has expired",
  );
}

/** Receipt time and parser revision never create a second copy of a source event. */
export function tradingDataKey(value: unknown): string {
  const data = parseTradingContract("data", value);
  return JSON.stringify([
    TRADING_VERSION,
    data.instrument_id,
    data.source_id,
    data.kind,
    data.source_event_id,
  ]);
}

/** Shape + local invariants only; referenced records are checked by the chain parsers below. */
export function parseTradingContract<K extends keyof TradingContracts>(
  kind: K,
  value: unknown,
): TradingContracts[K] {
  requireContract(Object.hasOwn(validators, kind), "Unknown trading contract");
  const validate = validators[kind];
  if (!validate(value))
    throw new TypeError(
      `Invalid trading ${kind}: ${ajv.errorsText(validate.errors)}`,
    );
  const contract = value as TradingContracts[K];
  if ("idempotency_key" in contract) {
    const logicalId =
      "execution_id" in contract
        ? contract.execution_id
        : "order_id" in contract
          ? contract.order_id
          : "intent_id" in contract
            ? contract.intent_id
            : contract.event_id;
    requireContract(
      contract.idempotency_key ===
        tradingIdempotencyKey(
          contract,
          kind as "intent" | "order" | "execution" | "ledger",
          logicalId,
        ),
      "Idempotency key mismatch",
    );
  }
  if (kind === "instrument") {
    const instrument = contract as TradingContracts["instrument"];
    sameInstrument(instrument, instrument.origin);
    requireContract(
      instrument.origin.kind === "metadata",
      "Instrument requires metadata provenance",
    );
  } else if (kind === "intent") {
    const intent = contract as TradingContracts["intent"];
    knownInputs(intent, intent.decision.inputs, intent.decision.decided_at);
    unexpired(intent.terms, intent.decision.decided_at);
  } else if (kind === "order") {
    const order = contract as TradingContracts["order"];
    unexpired(order.terms, order.accepted_at);
  } else if (kind === "execution") {
    const execution = contract as TradingContracts["execution"];
    knownInputs(execution, execution.evidence, execution.executed_at);
    requireContract(
      execution.evidence.every(
        (input) =>
          input.quality === "fresh" &&
          (input.kind === "book" || input.kind === "trade"),
      ),
      "Execution requires fresh book/trade evidence",
    );
  } else if (kind === "ledger") {
    const event = contract as TradingContracts["ledger"];
    requireContract(
      event.recorded_at >= event.occurred_at,
      "Ledger recorded before occurrence",
    );
    const payload = event.payload;
    if (payload.event_type === "funding" || payload.event_type === "mark") {
      knownInputs(event, [payload.origin], event.recorded_at);
      requireContract(
        payload.origin.source_timestamp <= event.occurred_at,
        "Ledger source postdates economic event",
      );
      requireContract(
        payload.origin.kind === payload.event_type,
        "Ledger source kind mismatch",
      );
    }
    if (payload.event_type === "funding")
      requireContract(
        payload.period_start < payload.period_end &&
          payload.period_end <= event.occurred_at,
        "Invalid funding period",
      );
    if (payload.event_type === "reversal")
      requireContract(
        payload.reverses_event_id !== event.event_id,
        "Ledger cannot reverse itself",
      );
  }
  return contract;
}

/** Validate ownership and metadata before accepting an intent at a service boundary. */
export function parseTradingIntent(
  value: unknown,
  accountValue: unknown,
  experimentValue: unknown,
  instrumentValue: unknown,
): TradingContracts["intent"] {
  const intent = parseTradingContract("intent", value);
  const account = parseTradingContract("account", accountValue);
  const experiment = parseTradingContract("experiment", experimentValue);
  const instrument = parseTradingContract("instrument", instrumentValue);
  requireContract(
    intent.account_id === account.account_id &&
      intent.experiment_id === account.experiment_id &&
      account.experiment_id === experiment.experiment_id &&
      intent.mode === account.mode &&
      account.mode === experiment.mode,
    "Intent ownership mismatch",
  );
  requireContract(
    intent.decision.decided_at >= experiment.started_at,
    "Decision predates experiment",
  );
  sameInstrument(intent, instrument);
  knownInputs(intent, [instrument.origin], intent.decision.decided_at);
  assertTradingQuantum(intent.terms.quantity, instrument.quantity_step);
  assertTradingQuantum(intent.terms.limit_price, instrument.tick_size);
  return intent;
}

/** A broker may not silently change an accepted candidate's side, size, price or owner. */
export function parseTradingOrder(
  value: unknown,
  intentValue: unknown,
  instrumentValue: unknown,
): TradingContracts["order"] {
  const order = parseTradingContract("order", value);
  const intent = parseTradingContract("intent", intentValue);
  const instrument = parseTradingContract("instrument", instrumentValue);
  sameScope(order, intent);
  sameInstrument(order, instrument);
  knownInputs(order, [instrument.origin], order.accepted_at);
  requireContract(
    order.intent_id === intent.intent_id &&
      order.decision_id === intent.decision.decision_id &&
      order.accepted_at >= intent.decision.decided_at,
    "Order decision mismatch",
  );
  const a = order.terms,
    b = intent.terms;
  requireContract(
    a.side === b.side &&
      a.quantity.raw === b.quantity.raw &&
      a.limit_price.raw === b.limit_price.raw &&
      a.reduce_only === b.reduce_only &&
      a.time_in_force === b.time_in_force &&
      (a.time_in_force !== "GTD" ||
        (b.time_in_force === "GTD" && a.expires_at === b.expires_at)),
    "Order terms changed after decision",
  );
  assertTradingQuantum(a.quantity, instrument.quantity_step);
  assertTradingQuantum(a.limit_price, instrument.tick_size);
  return order;
}

/** One fill only. Cumulative fills/reservations require an atomic store in later sessions. */
export function parseTradingExecution(
  value: unknown,
  orderValue: unknown,
  instrumentValue: unknown,
): TradingContracts["execution"] {
  const execution = parseTradingContract("execution", value);
  const order = parseTradingContract("order", orderValue);
  const instrument = parseTradingContract("instrument", instrumentValue);
  sameScope(execution, order);
  sameInstrument(execution, instrument);
  knownInputs(execution, [instrument.origin], execution.executed_at);
  assertTradingQuantum(order.terms.quantity, instrument.quantity_step);
  assertTradingQuantum(order.terms.limit_price, instrument.tick_size);
  requireContract(
    execution.order_id === order.order_id &&
      execution.intent_id === order.intent_id &&
      execution.decision_id === order.decision_id &&
      execution.side === order.terms.side &&
      execution.executed_at >= order.accepted_at,
    "Execution order mismatch",
  );
  unexpired(order.terms, execution.executed_at);
  requireContract(
    BigInt(execution.quantity.raw) <= BigInt(order.terms.quantity.raw),
    "Execution exceeds order quantity",
  );
  requireContract(
    execution.side === "buy"
      ? BigInt(execution.price.raw) <= BigInt(order.terms.limit_price.raw)
      : BigInt(execution.price.raw) >= BigInt(order.terms.limit_price.raw),
    "Execution breaches price limit",
  );
  assertTradingQuantum(execution.quantity, instrument.quantity_step);
  assertTradingQuantum(execution.price, instrument.tick_size);
  return execution;
}
