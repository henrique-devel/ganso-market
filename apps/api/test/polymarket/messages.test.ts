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

  // Regression: parseLastTrade used to rebuild the object with only 6 fields,
  // silently dropping size, fee_rate_bps and transaction_hash — every WS trade
  // persisted with those columns NULL and the WS dedupe index (partial on
  // transaction_hash) never applied.
  it("carries size, fee_rate_bps and transaction_hash from the raw frame", () => {
    const frame = JSON.stringify({
      event_type: "last_trade_price",
      market: "0xcond",
      asset_id: "111",
      price: "0.26",
      size: "12.5",
      side: "SELL",
      timestamp: "3",
      fee_rate_bps: "100",
      transaction_hash: "0xabc",
    });
    const messages = parseMarketFrame(frame);
    expect(messages).toHaveLength(1);
    const trade = messages[0];
    if (trade?.event_type !== "last_trade_price") {
      throw new Error("expected last_trade_price");
    }
    expect(trade.size).toBe("12.5");
    expect(trade.fee_rate_bps).toBe("100");
    expect(trade.transaction_hash).toBe("0xabc");
  });

  it("canonicalizes numeric size/fee_rate_bps and omits missing extras", () => {
    const frame = JSON.stringify({
      event_type: "last_trade_price",
      market: "0xcond",
      asset_id: "111",
      price: "0.26",
      size: 12.5,
      side: "SELL",
      timestamp: "3",
      fee_rate_bps: 100,
    });
    const messages = parseMarketFrame(frame);
    const trade = messages[0];
    if (trade?.event_type !== "last_trade_price") {
      throw new Error("expected last_trade_price");
    }
    expect(trade.size).toBe("12.5");
    expect(trade.fee_rate_bps).toBe("100");
    // Absent on the wire ⇒ absent on the object (never assigned undefined).
    expect("transaction_hash" in trade).toBe(false);
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
