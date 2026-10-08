import {
  JEV_VERSION,
  jevEventKey,
  type JevAccount,
  type JevBinding,
  type JevProfile,
} from "@ganso-market/contracts/trading";
import {
  jevScope,
  type JevLedgerIdentity,
  type JevLedgerCommand,
} from "../../src/storage/jev-ledger.js";
import {
  identity as oldIdentity,
  iso,
  start,
  usd,
  fill,
} from "./ledger-fixture.js";
export { iso, start, usd, fill };
export function jevIdentity(
  mode: "paper" | "stress" | "live" = "paper",
  name = "h1",
): JevLedgerIdentity {
  const profile: JevProfile = {
    schema_version: JEV_VERSION,
    owner_id: "operator",
    profile_id: name,
    profile_version: "v1",
    horizon_minutes: 1,
    manifest_hash: "a".repeat(64),
    created_at: iso(start),
  };
  const account: JevAccount = {
    schema_version: JEV_VERSION,
    owner_id: "operator",
    account_id: `${mode}:${name}`,
    mode,
    started_at: iso(start),
    initial_allocation: usd(mode === "live" ? "0" : "250000000"),
    capital_limit: usd("250000000"),
    capital_origin: mode === "live" ? "unfunded_live" : "fictitious",
    executor_enabled: false,
  };
  const binding: JevBinding = {
    schema_version: JEV_VERSION,
    owner_id: "operator",
    account_id: account.account_id,
    mode,
    profile_id: name,
    profile_version: "v1",
    experiment_id: `experiment:${mode}:${name}`,
    started_at: iso(start),
  };
  return {
    account,
    instrument: oldIdentity().instrument,
    bindings: [{ binding, profile }],
  };
}
export function jevCommand(
  i: JevLedgerIdentity,
  id: string,
  payload = fill(),
  at = start + 1000,
): JevLedgerCommand {
  const scope = jevScope(i.bindings[0]!.binding, i.instrument);
  return {
    ...scope,
    event_id: id,
    idempotency_key: jevEventKey(scope, id),
    cause_id: "fixture",
    occurred_at: iso(at),
    payload,
  };
}
