import { describe, expect, it } from "vitest";
import { parseTradingAmount } from "../src/trading/amount.js";
import {
  JEV_VERSION,
  assertJevOwnership,
  parseJevContract,
  validateJevBinding,
  type JevAccount,
  type JevBinding,
  type JevProfile,
} from "../src/trading/jev.js";
const created_at = "2026-10-07T00:00:00.000Z";
const usd = (raw: string) =>
  parseTradingAmount("USD", { unit: "USD", decimals: 6, raw });
const profile: JevProfile = {
  schema_version: JEV_VERSION,
  owner_id: "operator",
  profile_id: "h1",
  profile_version: "v1",
  manifest_hash: "a".repeat(64),
  horizon_minutes: 1,
  created_at,
};
const account: JevAccount = {
  schema_version: JEV_VERSION,
  owner_id: "operator",
  account_id: "paper:h1",
  mode: "paper",
  started_at: created_at,
  capital_limit: usd("250000000"),
  initial_allocation: usd("250000000"),
  capital_origin: "fictitious",
  executor_enabled: false,
};
const binding: JevBinding = {
  schema_version: JEV_VERSION,
  owner_id: "operator",
  account_id: account.account_id,
  mode: "paper",
  profile_id: "h1",
  profile_version: "v1",
  experiment_id: "experiment:h1",
  started_at: created_at,
};
describe("JEV financial identities v2", () => {
  it("represents independent paper/stress and unfunded live without an executor", () => {
    for (const mode of ["paper", "stress", "live"] as const) {
      const a = {
        ...account,
        mode,
        initial_allocation: usd(mode === "live" ? "0" : "250000000"),
        capital_origin:
          mode === "live"
            ? ("unfunded_live" as const)
            : ("fictitious" as const),
      };
      expect(parseJevContract("account", a)).toEqual(a);
      validateJevBinding({ ...binding, mode }, a, profile);
    }
  });
  it.each([
    "owner_id",
    "account_id",
    "mode",
    "profile_id",
    "profile_version",
  ] as const)("rejects incompatible %s", (field) => {
    expect(() =>
      validateJevBinding(
        { ...binding, [field]: "different" },
        account,
        profile,
      ),
    ).toThrow();
  });
  it.each([
    { initial_allocation: usd("1000000000") },
    { executor_enabled: true },
    { capital_limit: usd("250000001") },
    { initial_allocation: { unit: "USD", decimals: 2, raw: "25000" } },
    { schema_version: "trading.v1" },
    { mode: "live", capital_origin: "fictitious" },
    { extra: "ignored" },
  ])("rejects money/version/capability mismatch %#", (delta) => {
    expect(() =>
      parseJevContract("account", { ...account, ...delta }),
    ).toThrow();
  });
  it("binds each decision/operation to all identity dimensions", () => {
    const scope = {
      schema_version: JEV_VERSION,
      owner_id: "operator",
      account_id: account.account_id,
      mode: "paper" as const,
      profile_id: "h1",
      profile_version: "v1",
      experiment_id: binding.experiment_id,
      instrument_id: "hyperliquid:mainnet:BTC",
      instrument_version: "metadata:v1",
    };
    assertJevOwnership(scope, binding, account, profile, scope);
    for (const field of Object.keys(scope))
      expect(() =>
        assertJevOwnership(
          { ...scope, [field]: "other" },
          binding,
          account,
          profile,
          scope,
        ),
      ).toThrow();
  });
});
