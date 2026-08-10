import { describe, expect, it } from "vitest";

import { parseMoneyAmount, serializeMoneyAmount } from "../src/index.js";

describe("MoneyAmount exact conversion", () => {
  it("parses values beyond Number.MAX_SAFE_INTEGER as bigint without precision loss", () => {
    const raw = "900719925474099312345678901234567890";

    const amount = parseMoneyAmount({ raw, decimals: 9, asset_id: "SOL" });

    expect(amount.raw).toBe(900719925474099312345678901234567890n);
    expect(serializeMoneyAmount(amount)).toEqual({
      raw,
      decimals: 9,
      asset_id: "SOL",
    });
  });

  it.each(["0", "1", "-1", "42", "-42"])(
    "round-trips canonical raw value %s",
    (raw) => {
      const amount = parseMoneyAmount({
        raw,
        decimals: 0,
        asset_id: "fixture",
      });
      expect(serializeMoneyAmount(amount).raw).toBe(raw);
    },
  );

  it.each([1.5, "1.5", "1e9", "00", "01", "-0", "+1", " 1"])(
    "rejects non-canonical raw value %j",
    (raw) => {
      expect(() =>
        parseMoneyAmount({ raw, decimals: 9, asset_id: "SOL" }),
      ).toThrow(TypeError);
    },
  );

  it.each([-1, 1.5, 256, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid decimals value %j",
    (decimals) => {
      expect(() =>
        parseMoneyAmount({ raw: "1", decimals, asset_id: "SOL" }),
      ).toThrow(TypeError);
    },
  );

  it("rejects empty asset identifiers and extra fields", () => {
    expect(() =>
      parseMoneyAmount({ raw: "1", decimals: 9, asset_id: "" }),
    ).toThrow(TypeError);
    expect(() =>
      parseMoneyAmount({
        raw: "1",
        decimals: 9,
        asset_id: "SOL",
        unsupported: true,
      }),
    ).toThrow(TypeError);
  });

  it("serializes bigint directly to canonical base-10", () => {
    expect(
      serializeMoneyAmount({ raw: 0n, decimals: 0, asset_id: "fixture" }),
    ).toEqual({ raw: "0", decimals: 0, asset_id: "fixture" });
    expect(
      serializeMoneyAmount({ raw: -42n, decimals: 2, asset_id: "fixture" }),
    ).toEqual({ raw: "-42", decimals: 2, asset_id: "fixture" });
  });
});
