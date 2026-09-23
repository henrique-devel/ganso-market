import { describe, expect, it } from "vitest";
import { walkIoc } from "../../src/trading/broker.js";
const level = (price: string, quantity: string) => ({
  price: { raw: price },
  quantity: { raw: quantity },
});
const base = {
  side: "buy" as const,
  quantity: "1000000",
  limit: "66000000000",
  priceCap: "67000000000",
  step: "1000",
  feeRate: "450000",
  levels: [level("65100000000", "600000"), level("65200000000", "600000")],
  consumed: [],
};
describe("pure BTC IOC arithmetic", () => {
  it("keeps exact level prices and charges 45/100000 of notional once", () => {
    expect(walkIoc(base)).toEqual([
      {
        price_usd_raw: "65100000000",
        quantity_btc_raw: "600000",
        fee_usd_raw: "175770",
      },
      {
        price_usd_raw: "65200000000",
        quantity_btc_raw: "400000",
        fee_usd_raw: "117360",
      },
    ]);
  });
  it("limits buy slippage and preserves insufficient depth as partial", () => {
    expect(walkIoc({ ...base, limit: "65100000000" })).toHaveLength(1);
    expect(walkIoc({ ...base, limit: "65000000000" })).toEqual([]);
  });
  it("uses a sell floor independently of the fee collateral ceiling", () => {
    const input = {
      ...base,
      side: "sell" as const,
      limit: "64850000000",
      levels: [level("64900000000", "600000"), level("64800000000", "600000")],
    };
    expect(walkIoc(input)).toEqual([
      {
        price_usd_raw: "64900000000",
        quantity_btc_raw: "600000",
        fee_usd_raw: "175230",
      },
    ]);
  });
  it("deducts prior same-account depth and rounds down to the lot", () => {
    expect(
      walkIoc({
        ...base,
        levels: [level("65100000000", "600999")],
        consumed: [
          { price_usd_raw: "65100000000", quantity_btc_raw: "500000" },
        ],
      }),
    ).toEqual([
      {
        price_usd_raw: "65100000000",
        quantity_btc_raw: "100000",
        fee_usd_raw: "29295",
      },
    ]);
  });
  it("rounds a sub-micro fee once across levels", () => {
    const fills = walkIoc({
      ...base,
      step: "1",
      quantity: "3",
      levels: [level("1", "1"), level("2", "1"), level("3", "1")],
    });
    expect(fills.map((f) => f.fee_usd_raw)).toEqual(["1", "0", "0"]);
  });
  it("never creates negative liquidity or fills above the reservation cap", () => {
    expect(walkIoc({ ...base, priceCap: "65000000000" })).toEqual([]);
    expect(
      walkIoc({
        ...base,
        levels: [base.levels[0]!],
        consumed: [
          { price_usd_raw: "65100000000", quantity_btc_raw: "700000" },
        ],
      }),
    ).toEqual([]);
  });
});
