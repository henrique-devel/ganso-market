import { describe, expect, it } from "vitest";

import { money } from "../../../src/polymarket/portfolio/ev.js";
import {
  assignFactor,
  catalystWindow,
  DEFAULT_FACTOR_MAP,
  factorMapHash,
  FactorMapError,
  parseFactorMap,
} from "../../../src/polymarket/portfolio/factors.js";

const BTC = {
  conditionId: "0xbtc",
  question: "Will the price of Bitcoin be above $88,000 on August 28?",
  category: "crypto",
  negRisk: false,
  eventId: null,
};

describe("factor assignment", () => {
  it("puts two BTC price markets on the SAME factor", () => {
    // The whole point: "BTC above $88k" and "BTC above $95k" are one bet on the
    // price of BTC, not two independent positions.
    const a = assignFactor(DEFAULT_FACTOR_MAP, BTC);
    const b = assignFactor(DEFAULT_FACTOR_MAP, {
      ...BTC,
      conditionId: "0xbtc2",
      question: "Will Bitcoin dip to $68,000 August 24-30?",
    });
    expect(a.factor).toBe("btc_price");
    expect(b.factor).toBe(a.factor);
    expect(a.matchedBy).toBe("rule");
  });

  it("keeps different assets on different factors", () => {
    const btc = assignFactor(DEFAULT_FACTOR_MAP, BTC);
    const eth = assignFactor(DEFAULT_FACTOR_MAP, {
      ...BTC,
      conditionId: "0xeth",
      question: "Will Ethereum reach $3,000 by December 31, 2026?",
    });
    expect(btc.factor).toBe("btc_price");
    expect(eth.factor).toBe("eth_price");
  });

  it("groups macro markets by their catalyst, across categories", () => {
    const fed = assignFactor(DEFAULT_FACTOR_MAP, {
      conditionId: "0xfed",
      question: "Will the Fed cut rates in September?",
      category: "macro",
      negRisk: false,
      eventId: null,
    });
    expect(fed.factor).toBe("fed_rate_decision");
  });

  it("treats an unrecognised market as CORRELATED, never as independent", () => {
    // Failing open here is how an unrecognised theme quietly becomes the
    // largest bet in the book.
    const unknown = assignFactor(DEFAULT_FACTOR_MAP, {
      conditionId: "0xmystery",
      question: "Will the Kalshi merger close?",
      category: "other",
      negRisk: false,
      eventId: null,
    });
    expect(unknown.matchedBy).toBe("unknown");
    expect(unknown.factor).toBe("unknown:0xmystery");
    expect(money(unknown.multiplierScaled)).toBe("0.500000");
    expect(unknown.multiplierScaled).toBeLessThan(1_000_000_000n);
  });

  it("uses the negRisk event as a factor when no rule matches", () => {
    const leg = assignFactor(DEFAULT_FACTOR_MAP, {
      conditionId: "0xleg",
      question: "Will candidate Q win the thing?",
      category: "other",
      negRisk: true,
      eventId: "evt-42",
    });
    expect(leg.factor).toBe("negrisk:evt-42");
    expect(leg.matchedBy).toBe("negrisk");
  });

  it("prefers an explicit rule over the negRisk fallback", () => {
    const leg = assignFactor(DEFAULT_FACTOR_MAP, {
      ...BTC,
      negRisk: true,
      eventId: "evt-7",
    });
    expect(leg.factor).toBe("btc_price");
  });

  it("respects the category scope of a rule", () => {
    // The crypto rules must not claim a macro market that merely says "eth".
    const notCrypto = assignFactor(DEFAULT_FACTOR_MAP, {
      conditionId: "0xm",
      question: "Will ETH ETF approval happen?",
      category: "macro",
      negRisk: false,
      eventId: null,
    });
    expect(notCrypto.factor).not.toBe("eth_price");
  });
});

describe("catalyst window", () => {
  it("buckets resolutions into UTC days so one catalyst shares a cap", () => {
    expect(catalystWindow(new Date("2026-09-17T18:00:00Z"))).toBe("2026-09-17");
    expect(catalystWindow(new Date("2026-09-17T23:59:59Z"))).toBe("2026-09-17");
    expect(catalystWindow(null)).toBe("unknown");
    expect(catalystWindow(new Date(Number.NaN))).toBe("unknown");
  });
});

describe("factor map parsing", () => {
  it("round-trips the defaults", () => {
    const parsed = parseFactorMap(
      JSON.parse(JSON.stringify(DEFAULT_FACTOR_MAP)),
    );
    expect(factorMapHash(parsed)).toBe(factorMapHash(DEFAULT_FACTOR_MAP));
  });

  it("rejects an unknown key rather than silently ignoring it", () => {
    expect(() => parseFactorMap({ version: "1.0.0", nope: 1 })).toThrow(
      FactorMapError,
    );
  });

  it("rejects a rule with no patterns, which would match everything", () => {
    expect(() =>
      parseFactorMap({
        version: "1.0.0",
        rules: [{ factor: "x", allOf: [], anyOf: [] }],
      }),
    ).toThrow(FactorMapError);
  });

  it("rejects a multiplier outside [0, 1]", () => {
    expect(() =>
      parseFactorMap({
        version: "1.0.0",
        rules: [{ factor: "x", anyOf: ["y"], correlationMultiplier: 1.5 }],
      }),
    ).toThrow(FactorMapError);
  });

  it("changes the hash when a rule changes, so a decision can be traced", () => {
    const altered = parseFactorMap({
      ...JSON.parse(JSON.stringify(DEFAULT_FACTOR_MAP)),
      unknownFactorMultiplier: 0.25,
    });
    expect(factorMapHash(altered)).not.toBe(factorMapHash(DEFAULT_FACTOR_MAP));
  });
});
