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
    enableOrderBook: true,
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

describe("keyword classification (Gamma rows have no category)", () => {
  function classifyFrom(question: string): string | null {
    const entry = parseMarket({
      conditionId: "0xc",
      question,
      slug: "",
      clobTokenIds: '["1","2"]',
      description: "Some resolution rules text here.",
      active: true,
      closed: false,
      enableOrderBook: true,
    });
    return entry?.category ?? null;
  }

  it("classifies by keyword when no explicit category is present", () => {
    expect(classifyFrom("Will BTC be above $70k on Friday?")).toBe("crypto");
    expect(
      classifyFrom("Will the Fed cut the interest rate in September?"),
    ).toBe("macro");
  });

  it("returns null for elections, weather and unmatched markets", () => {
    expect(
      classifyFrom("Who will win the 2028 presidential election?"),
    ).toBeNull();
    expect(
      classifyFrom("Will the Lakers beat the Celtics tonight?"),
    ).toBeNull();
    // Weather left the tracked set in RFC-007 (crypto and macro only).
    expect(classifyFrom("Highest temperature in NYC on Aug 20?")).toBeNull();
  });

  it("excludes mentions and geopolitics keywords", () => {
    expect(classifyFrom("Will the CEO mention AI on the call?")).toBeNull();
    expect(classifyFrom("Will there be a ceasefire by March?")).toBeNull();
  });
});
