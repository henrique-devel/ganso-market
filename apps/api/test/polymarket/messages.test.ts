import { describe, expect, it } from "vitest";

import { parseMarketFrame } from "../../src/polymarket/messages.js";

describe("market frame parsing", () => {
  it("parses an array frame with mixed event types", () => {
    const frame = JSON.stringify([
      {
        event_type: "book",
        market: "0xcond",
        asset_id: "111",
        timestamp: "1",
        hash: "h",
        bids: [{ price: "0.01", size: "5" }],
        asks: [{ price: "0.99", size: "2" }],
      },
      {
        event_type: "price_change",
        market: "0xcond",
        timestamp: "2",
        price_changes: [
          { asset_id: "111", price: "0.36", size: "10", side: "BUY" },
        ],
      },
    ]);
    const messages = parseMarketFrame(frame);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.event_type).toBe("book");
    expect(messages[1]?.event_type).toBe("price_change");
  });

  it("accepts a single-object frame", () => {
    const frame = JSON.stringify({
      event_type: "last_trade_price",
      market: "0xcond",
      asset_id: "111",
      price: "0.26",
      side: "SELL",
      timestamp: "3",
    });
    const messages = parseMarketFrame(frame);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.event_type).toBe("last_trade_price");
  });

  it("skips malformed or unknown events", () => {
    expect(parseMarketFrame("not json")).toEqual([]);
    expect(
      parseMarketFrame(
        JSON.stringify([
          { event_type: "book", market: "0xcond" },
          { event_type: "unknown_event" },
        ]),
      ),
    ).toEqual([]);
  });
});
