import { describe, expect, it } from "vitest";
import {
  passiveQueue,
  consumePassiveTrade,
} from "../../src/trading/passive.js";
import { validatePassiveCommand } from "../../src/storage/passive-contract.js";
const level = (price: string, quantity: string) => ({
  price: { raw: price },
  quantity: { raw: quantity },
});
const book = {
  bids: [level("64900000000", "600000"), level("64800000000", "2000000")],
  asks: [level("65100000000", "800000"), level("65200000000", "3000000")],
};
const input = {
  queue: { ahead_btc_raw: "600000", fee_numerator: "0", charged_usd_raw: "0" },
  side: "buy" as const,
  limit: "64900000000",
  remaining: "500000",
  step: "1000",
  feeRate: "150000",
  trade: { side: "sell" as const, price: "64900000000", available: "700500" },
};
describe("S5 pessimistic passive queue", () => {
  it("rejects crossing either side including equality", () => {
    for (const [side, limit] of [
      ["buy", "65100000000"],
      ["sell", "64900000000"],
    ] as const)
      expect(() => passiveQueue({ ...book, side, limit })).toThrow(
        "POST_ONLY_CROSS",
      );
  });
  it("uses full observed depth; inside spread has zero observed queue and outside depth is unknown", () => {
    expect(
      passiveQueue({ ...book, side: "sell", limit: "65100000000" })
        .ahead_btc_raw,
    ).toBe("800000");
    expect(
      passiveQueue({ ...book, side: "buy", limit: "65000000000" })
        .ahead_btc_raw,
    ).toBe("0");
    expect(() =>
      passiveQueue({ ...book, side: "buy", limit: "64700000000" }),
    ).toThrow("OUTSIDE_DEPTH");
  });
  it("burns queue first, rounds quantity down and keeps fees exact", () => {
    expect(consumePassiveTrade(input)).toEqual({
      queue: {
        ahead_btc_raw: "0",
        fee_numerator: "973500000000000000000",
        charged_usd_raw: "9735",
      },
      quantity: "100000",
      fee: "9735",
      available: "500",
    });
  });
  it("insufficient negotiation only reduces the queue", () => {
    expect(
      consumePassiveTrade({
        ...input,
        trade: { ...input.trade, available: "400000" },
      }),
    ).toMatchObject({
      queue: { ahead_btc_raw: "200000" },
      quantity: "0",
      fee: "0",
      available: "0",
    });
  });
  it("same-side and trade-through prints are not guaranteed fills", () => {
    for (const trade of [
      { ...input.trade, side: "buy" as const },
      { ...input.trade, price: "64800000000" },
    ])
      expect(consumePassiveTrade({ ...input, trade })).toMatchObject({
        queue: input.queue,
        quantity: "0",
        available: "700500",
      });
  });
  it("rounds fees once across partial fills and polling boundaries", () => {
    const first = consumePassiveTrade({
      ...input,
      queue: { ...input.queue, ahead_btc_raw: "0" },
      feeRate: "1",
      trade: { ...input.trade, available: "1000" },
    });
    const next = consumePassiveTrade({
      ...input,
      queue: first.queue,
      feeRate: "1",
      trade: { ...input.trade, available: "1000" },
    });
    expect(first.fee).toBe("1");
    expect(next.fee).toBe("0");
    expect(next.queue.charged_usd_raw).toBe("1");
  });
  it("rejects malformed or unversioned commands", () => {
    expect(() =>
      validatePassiveCommand({
        action: "advance",
        operation_id: "x",
        extra: true,
      } as never),
    ).toThrow("COMMAND");
    expect(() =>
      validatePassiveCommand({ action: "execute", operation_id: "x" } as never),
    ).toThrow("COMMAND");
  });
});
