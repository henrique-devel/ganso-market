import { describe, expect, it } from "vitest";

import { isInUniverse, parseMarket } from "../../src/polymarket/gamma.js";
import type { MarketRegistryEntry } from "../../src/polymarket/types.js";

function cryptoMarket(): MarketRegistryEntry {
  const entry = parseMarket({
    conditionId: "0xabc",
    question: "Will BTC be up at 3pm?",
    slug: "btc-up-3pm",
    category: "crypto",
    negRisk: false,
    clobTokenIds: '["111", "222"]',
    description: "Resolves YES if the price is higher at the close.",
    orderPriceMinTickSize: 0.001,
    orderMinSize: 5,
    rewardsMinSize: 50,
    rewardsMaxSpread: 3.5,
    feeType: "crypto_fees",
    endDateIso: "2026-08-16",
    active: true,
    closed: false,
  });
  if (entry === null) {
    throw new Error("expected a parsed market");
  }
  return entry;
}

describe("gamma market parsing", () => {
  it("parses a market and its stringified token id array", () => {
    const entry = cryptoMarket();
    expect(entry.conditionId).toBe("0xabc");
    expect(entry.clobTokenIds).toEqual(["111", "222"]);
    expect(entry.tickSize).toBe("0.001");
    expect(entry.minOrderSize).toBe("5");
    expect(entry.negRisk).toBe(false);
  });

  it("rejects a market missing essential fields", () => {
    expect(parseMarket({ question: "no condition id" })).toBeNull();
    expect(parseMarket(null)).toBeNull();
  });

  it("keeps decimal parameters as strings, never floats", () => {
    const entry = cryptoMarket();
    expect(typeof entry.rewardsMaxSpread).toBe("string");
    expect(entry.rewardsMaxSpread).toBe("3.5");
  });
});

describe("universe selection", () => {
  it("admits an active crypto market with rules and two tokens", () => {
    expect(isInUniverse(cryptoMarket())).toBe(true);
  });

  it("excludes election markets regardless of category", () => {
    const entry: MarketRegistryEntry = {
      ...cryptoMarket(),
      category: "politics",
      question: "Who will win the 2028 election?",
    };
    expect(isInUniverse(entry)).toBe(false);
  });

  it("excludes closed or thin markets", () => {
    expect(isInUniverse({ ...cryptoMarket(), closed: true })).toBe(false);
    expect(
      isInUniverse({ ...cryptoMarket(), clobTokenIds: ["only-one"] }),
    ).toBe(false);
  });

  it("excludes categories outside the tracked set", () => {
    expect(isInUniverse({ ...cryptoMarket(), category: "sports" })).toBe(false);
  });
});
