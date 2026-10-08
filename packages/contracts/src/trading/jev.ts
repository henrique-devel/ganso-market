import AjvModule from "ajv";
import { parseTradingAmount } from "./amount.js";
import { parseTradingContract, tradingIdempotencyKey } from "./validation.js";
import type { PerpetualLedgerEvent, TradingScope, UsdAmount } from "./types.js";

export const JEV_VERSION = "trading.jev.v2" as const;
export type JevMode = "paper" | "stress" | "live";
export interface JevProfile {
  schema_version: typeof JEV_VERSION;
  owner_id: string;
  profile_id: string;
  profile_version: string;
  manifest_hash: string;
  horizon_minutes: 1 | 3 | 5;
  created_at: string;
}
/** Financial lifetime is independent of profile and evaluation windows. */
export interface JevAccount {
  schema_version: typeof JEV_VERSION;
  owner_id: string;
  account_id: string;
  mode: JevMode;
  started_at: string;
  capital_limit: UsdAmount;
  initial_allocation: UsdAmount;
  capital_origin: "fictitious" | "unfunded_live";
  executor_enabled: false;
}
export interface JevBinding {
  schema_version: typeof JEV_VERSION;
  owner_id: string;
  account_id: string;
  mode: JevMode;
  profile_id: string;
  profile_version: string;
  experiment_id: string;
  started_at: string;
}
export interface JevScope extends Omit<JevBinding, "started_at"> {
  instrument_id: string;
  instrument_version: string;
}
export type JevLedgerEvent = Omit<
  PerpetualLedgerEvent,
  keyof TradingScope | "schema_version"
> &
  JevScope;
const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$" };
const time = { type: "string", format: "utc-milliseconds" };
const amount = {
  type: "object",
  additionalProperties: false,
  required: ["unit", "decimals", "raw"],
  properties: {
    unit: { const: "USD" },
    decimals: { const: 6 },
    raw: { type: "string", pattern: "^(?:0|[1-9][0-9]*)$" },
  },
};
const shared = { schema_version: { const: JEV_VERSION }, owner_id: id };
const schemas = {
  profile: {
    ...shared,
    profile_id: id,
    profile_version: id,
    manifest_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    horizon_minutes: { enum: [1, 3, 5] },
    created_at: time,
  },
  account: {
    ...shared,
    account_id: id,
    mode: { enum: ["paper", "stress", "live"] },
    started_at: time,
    capital_limit: amount,
    initial_allocation: amount,
    capital_origin: { enum: ["fictitious", "unfunded_live"] },
    executor_enabled: { const: false },
  },
  binding: {
    ...shared,
    account_id: id,
    mode: { enum: ["paper", "stress", "live"] },
    profile_id: id,
    profile_version: id,
    experiment_id: id,
    started_at: time,
  },
};
const ajv = new AjvModule.default({ strict: true, ownProperties: true });
ajv.addFormat(
  "utc-milliseconds",
  (s: string) =>
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) &&
    Number.isFinite(Date.parse(s)) &&
    new Date(s).toISOString() === s,
);
const validators = Object.fromEntries(
  Object.entries(schemas).map(([kind, properties]) => [
    kind,
    ajv.compile({
      type: "object",
      additionalProperties: false,
      required: Object.keys(properties),
      properties,
    }),
  ]),
);
export function requireJev(ok: unknown, code: string): asserts ok {
  if (!ok) throw new TypeError(`JEV_${code}`);
}
interface Contracts {
  profile: JevProfile;
  account: JevAccount;
  binding: JevBinding;
}
export function parseJevContract<K extends keyof Contracts>(
  kind: K,
  value: unknown,
): Contracts[K] {
  requireJev(validators[kind]?.(value), `INVALID_${kind.toUpperCase()}`);
  if (kind === "account") {
    const a = value as unknown as JevAccount;
    parseTradingAmount("USD", a.capital_limit);
    parseTradingAmount("USD", a.initial_allocation);
    requireJev(
      a.capital_limit.raw === "250000000" &&
        (a.mode === "live"
          ? a.initial_allocation.raw === "0" &&
            a.capital_origin === "unfunded_live"
          : a.initial_allocation.raw === "250000000" &&
            a.capital_origin === "fictitious"),
      "CAPITAL",
    );
  }
  return value as unknown as Contracts[K];
}
export function validateJevBinding(
  b: JevBinding,
  a: JevAccount,
  p: JevProfile,
): void {
  parseJevContract("binding", b);
  parseJevContract("account", a);
  parseJevContract("profile", p);
  requireJev(
    b.owner_id === a.owner_id &&
      b.owner_id === p.owner_id &&
      b.account_id === a.account_id &&
      b.mode === a.mode &&
      b.profile_id === p.profile_id &&
      b.profile_version === p.profile_version &&
      b.started_at >= a.started_at &&
      b.started_at >= p.created_at,
    "OWNERSHIP",
  );
}
export function jevEventKey(scope: JevScope, eventId: string): string {
  parseJevContract("binding", {
    schema_version: scope.schema_version,
    owner_id: scope.owner_id,
    account_id: scope.account_id,
    mode: scope.mode,
    profile_id: scope.profile_id,
    profile_version: scope.profile_version,
    experiment_id: scope.experiment_id,
    started_at: "2000-01-01T00:00:00.000Z",
  });
  // The v1 validator remains the source of instrument/logical-ID syntax.
  tradingIdempotencyKey({ ...scope, mode: "paper" }, "ledger", eventId);
  return JSON.stringify([
    JEV_VERSION,
    scope.owner_id,
    scope.mode,
    scope.account_id,
    scope.profile_id,
    scope.profile_version,
    scope.experiment_id,
    scope.instrument_id,
    scope.instrument_version,
    "ledger",
    eventId,
  ]);
}
/** Validate all v1 payload/precision/provenance invariants, then immutable v2 ownership. */
export function parseJevLedgerEvent(value: JevLedgerEvent): JevLedgerEvent {
  const { owner_id, profile_id, profile_version, ...legacy } = value;
  requireJev(
    value.schema_version === JEV_VERSION &&
      value.idempotency_key === jevEventKey(value, value.event_id),
    "EVENT_IDENTITY",
  );
  void owner_id;
  void profile_id;
  void profile_version;
  parseTradingContract("ledger", {
    ...legacy,
    mode: "paper",
    schema_version: "trading.v1",
    idempotency_key: tradingIdempotencyKey(
      { ...value, mode: "paper" },
      "ledger",
      value.event_id,
    ),
  });
  requireJev(
    ["cash", "fill", "fee", "funding", "liquidation"].includes(
      value.payload.event_type,
    ),
    "LEDGER_PAYLOAD",
  );
  return value;
}

/** Shared boundary guard for immutable decision, order, fill and ledger ownership. */
export function assertJevOwnership(
  scope: JevScope,
  binding: JevBinding,
  account: JevAccount,
  profile: JevProfile,
  parent?: JevScope,
): void {
  validateJevBinding(binding, account, profile);
  jevEventKey(scope, "ownership");
  requireJev(
    scope.instrument_id === "hyperliquid:mainnet:BTC" &&
      scope.schema_version === JEV_VERSION,
    "INSTRUMENT_OR_VERSION",
  );
  for (const key of [
    "owner_id",
    "account_id",
    "mode",
    "profile_id",
    "profile_version",
    "experiment_id",
  ] as const)
    requireJev(scope[key] === binding[key], "OWNERSHIP");
  if (parent)
    for (const key of [
      "schema_version",
      "owner_id",
      "account_id",
      "mode",
      "profile_id",
      "profile_version",
      "experiment_id",
      "instrument_id",
      "instrument_version",
    ] as const)
      requireJev(scope[key] === parent[key], "PARENT_OWNERSHIP");
}
