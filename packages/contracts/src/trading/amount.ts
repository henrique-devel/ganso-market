import { parseMoneyAmount } from "../money-amount.js";
import {
  TRADING_DECIMALS,
  type TradingAmount,
  type TradingUnit,
} from "./types.js";

/** Validates a JSON amount without converting its raw integer through Number. */
export function parseTradingAmount<U extends TradingUnit>(
  unit: U,
  value: unknown,
): TradingAmount<U> {
  if (
    !Object.hasOwn(TRADING_DECIMALS, unit) ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TypeError("Invalid trading amount");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    !["raw", "unit", "decimals"].every((key) => Object.hasOwn(record, key)) ||
    record.unit !== unit ||
    record.decimals !== TRADING_DECIMALS[unit]
  ) {
    throw new TypeError("Trading amount unit or scale mismatch");
  }
  const parsed = parseMoneyAmount({
    raw: record.raw,
    decimals: record.decimals,
    asset_id: unit,
  });
  if (unit === "PROBABILITY" && (parsed.raw < 0n || parsed.raw > 1_000_000n)) {
    throw new TypeError("Probability must be in [0, 1]");
  }
  return {
    unit,
    decimals: TRADING_DECIMALS[unit],
    raw: record.raw as TradingAmount<U>["raw"],
  };
}

/** No truncation: venue tick/lot checks use exact integer divisibility. */
export function assertTradingQuantum<U extends TradingUnit>(
  value: TradingAmount<U>,
  step: TradingAmount<NoInfer<U>>,
): void {
  const amount = parseTradingAmount(value.unit, value);
  const quantum = parseTradingAmount(value.unit, step);
  if (
    BigInt(quantum.raw) <= 0n ||
    BigInt(amount.raw) % BigInt(quantum.raw) !== 0n
  ) {
    throw new TypeError(
      "Trading amount is not an exact multiple of a positive quantum",
    );
  }
}
