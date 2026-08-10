import type { MoneyAmount, MoneyAmountJson } from "./types.js";

const CANONICAL_INTEGER = /^(?:0|-?[1-9][0-9]*)$/u;
const MONEY_AMOUNT_KEYS = new Set(["raw", "decimals", "asset_id"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>): void {
  const keys = Object.keys(value);
  if (
    keys.length !== MONEY_AMOUNT_KEYS.size ||
    keys.some((key) => !MONEY_AMOUNT_KEYS.has(key))
  ) {
    throw new TypeError(
      "MoneyAmount must contain only raw, decimals and asset_id",
    );
  }
}

function assertDecimals(value: unknown): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 255
  ) {
    throw new TypeError(
      "MoneyAmount.decimals must be an integer from 0 through 255",
    );
  }
}

function assertAssetId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("MoneyAmount.asset_id must be a non-empty string");
  }
}

/**
 * Parses the JSON boundary representation without passing `raw` through Number.
 * Invalid, non-canonical or imprecise representations fail closed.
 */
export function parseMoneyAmount(value: unknown): MoneyAmount {
  if (!isRecord(value)) {
    throw new TypeError("MoneyAmount must be an object");
  }

  assertExactKeys(value);

  if (typeof value.raw !== "string" || !CANONICAL_INTEGER.test(value.raw)) {
    throw new TypeError(
      "MoneyAmount.raw must be a canonical base-10 integer string",
    );
  }
  assertDecimals(value.decimals);
  assertAssetId(value.asset_id);

  return {
    raw: BigInt(value.raw),
    decimals: value.decimals,
    asset_id: value.asset_id,
  };
}

/** Serializes an exact internal amount to its canonical JSON representation. */
export function serializeMoneyAmount(value: MoneyAmount): MoneyAmountJson {
  if (typeof value.raw !== "bigint") {
    throw new TypeError("MoneyAmount.raw must be a bigint");
  }
  assertDecimals(value.decimals);
  assertAssetId(value.asset_id);

  return {
    raw: value.raw.toString(10) as MoneyAmountJson["raw"],
    decimals: value.decimals,
    asset_id: value.asset_id,
  };
}
