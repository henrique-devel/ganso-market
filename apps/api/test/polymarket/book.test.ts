import { describe, expect, it } from "vitest";

import { comparePriceStrings, OrderBook } from "../../src/polymarket/book.js";
import type { BookMessage } from "../../src/polymarket/types.js";

function snapshot(): BookMessage {
  return {
    event_type: "book",
    market: "0xcond",
    asset_id: "111",
    timestamp: "1786846500810",
    hash: "abc",
    bids: [
      { price: "0.010", size: "5" },
      { price: "0.361", size: "992.4" },
    ],
    asks: [
      { price: "0.995", size: "10" },
      { price: "0.991", size: "3" },
    ],
  };
}

describe("decimal price comparison", () => {
  it("compares without floating point error", () => {
    expect(comparePriceStrings("0.1", "0.2")).toBe(-1);
    expect(comparePriceStrings("0.30", "0.3")).toBe(0);
    expect(comparePriceStrings("0.991", "0.99")).toBe(1);
  });
});

describe("order book reconstruction", () => {
  it("orders best bid highest and best ask lowest", () => {
    const book = OrderBook.fromMessage(snapshot());
    expect(book.bestBid()?.price).toBe("0.361");
    expect(book.bestAsk()?.price).toBe("0.991");
  });

  it("applies a delta as an absolute size and removes on zero", () => {
    const book = OrderBook.fromMessage(snapshot());
    book.applyPriceChange({
      asset_id: "111",
      price: "0.500",
      size: "100",
      side: "BUY",
    });
    expect(book.bestBid()?.price).toBe("0.500");
    expect(book.bestBid()?.size).toBe("100");

    book.applyPriceChange({
      asset_id: "111",
      price: "0.500",
      size: "0",
      side: "BUY",
    });
    expect(book.bestBid()?.price).toBe("0.361");
  });

  it("returns at most the requested depth per side", () => {
    const book = new OrderBook();
    const bids = Array.from({ length: 15 }, (_, index) => ({
      price: `0.${String(100 + index)}`,
      size: "1",
    }));
    book.replace(bids, []);
    expect(book.topBids(10)).toHaveLength(10);
    // Highest price first.
    expect(book.topBids(10)[0]?.price).toBe("0.114");
  });
});
