import { describe, expect, it } from "vitest";

import { parseScaled } from "../../../src/polymarket/fundamental/fixed.js";
import { DEFAULT_PORTFOLIO_CONFIG } from "../../../src/polymarket/portfolio/config.js";
import {
  evaluateMarket,
  type EvaluationInput,
} from "../../../src/polymarket/portfolio/engine.js";

function s(value: string): bigint {
  const parsed = parseScaled(value);
  if (parsed === null) {
    throw new Error(`unparseable fixture value: ${value}`);
  }
  return parsed;
}

/** A market that should be entrable: cheap ask, confident lower bound. */
const GOOD: EvaluationInput = {
  now: new Date("2026-08-26T12:00:00Z"),
  config: DEFAULT_PORTFOLIO_CONFIG,
  conditionId: "0xa",
  tokenId: "t1",
  question: "Will BTC be above $88,000 on August 28?",
  category: "crypto",
  q: "0.700000",
  qLo: "0.650000",
  qHi: "0.750000",
  estimateSource: "MODEL",
  estimateAgeMs: 5_000,
  bids: [
    { price: "0.49", size: "500" },
    { price: "0.48", size: "800" },
  ],
  asks: [
    { price: "0.50", size: "500" },
    { price: "0.52", size: "800" },
  ],
  bookAgeMs: 1_000,
  resolutionAction: "NONE",
  resolutionBuffer: "0.000000",
  p5050: "0.010000",
  expectedLockupS: 3_600,
  resolutionAgeMs: 60_000,
  rulePrecisionMultiplier: 1,
  takerFeeRate: "0.07",
  minOrderSize: "5",
  bufferDailyHurdle: 0.0005,
  portfolioState: "NORMAL",
  bankrollScaled: s("1000"),
  capHeadroom: {
    entrada: s("20"),
    mercado: s("50"),
    grupoCorrelacionado: s("200"),
    categoria: s("350"),
    fonteResolucao: s("250"),
    catalisadorJanela: s("250"),
    capitalBloqueado: s("600"),
  },
  correlationMultiplier: 1,
  breakerOpen: false,
};

describe("entry gates, in order of severity", () => {
  it("enters a market that clears every gate", () => {
    const result = evaluateMarket(GOOD);
    expect(result.entrable).toBe(true);
    expect(result.rejectionCode).toBeNull();
    expect(result.best?.side).toBe("YES");
    expect(result.sizing?.sizeScaled).toBeGreaterThan(0n);
  });

  it("refuses in REDUCE_ONLY and HALTED before doing any arithmetic", () => {
    for (const state of ["REDUCE_ONLY", "HALTED"] as const) {
      const result = evaluateMarket({ ...GOOD, portfolioState: state });
      expect(result.entrable).toBe(false);
      expect(result.best).toBeNull();
      expect(result.sizing).toBeNull();
    }
  });

  it("fails CLOSED when the RFC-012 state is missing", () => {
    // Absence of the risk layer is not permission to skip it.
    const result = evaluateMarket({ ...GOOD, resolutionAction: null });
    expect(result.rejectionCode).toBe("RESOLUTION_STATE_MISSING");
    expect(result.vetoed).toBe(true);
    expect(result.vetoReason).not.toBeNull();
  });

  it("marks a vetoed market as vetoed WITH its reason, never as almost entrable", () => {
    // The panel may not show a vetoed opportunity without saying why — the
    // migration enforces the same thing with a CHECK.
    for (const action of ["VETO", "CIRCUIT_BREAKER"] as const) {
      const result = evaluateMarket({ ...GOOD, resolutionAction: action });
      expect(result.entrable).toBe(false);
      expect(result.vetoed).toBe(true);
      expect(result.vetoReason).toBeTruthy();
      // And no edge is computed at all: nothing tempting to look at.
      expect(result.panel.edge.net).toBeNull();
    }
  });

  it("refuses a stale book, a stale estimate and stale resolution state", () => {
    expect(evaluateMarket({ ...GOOD, bookAgeMs: 60_000 }).rejectionCode).toBe(
      "BOOK_STALE",
    );
    expect(evaluateMarket({ ...GOOD, bookAgeMs: null }).rejectionCode).toBe(
      "BOOK_STALE",
    );
    expect(
      evaluateMarket({ ...GOOD, estimateAgeMs: 999_999 }).rejectionCode,
    ).toBe("DATA_STALE");
    expect(
      evaluateMarket({ ...GOOD, resolutionAgeMs: 99_999_999 }).rejectionCode,
    ).toBe("DATA_STALE");
  });

  it("refuses when the portfolio breaker is open", () => {
    expect(evaluateMarket({ ...GOOD, breakerOpen: true }).rejectionCode).toBe(
      "PORTFOLIO_CIRCUIT_BREAKER",
    );
  });
});

describe("the lower-bound criterion", () => {
  it("REJECTS a favourable mean whose lower bound does not clear the costs", () => {
    // The mean says 0.70 against a 0.50 ask — a 20¢ "edge" — but the lower
    // bound is 0.505. There is no high-conviction exception.
    const result = evaluateMarket({
      ...GOOD,
      qLo: "0.505000",
      qHi: "0.900000",
    });
    expect(result.entrable).toBe(false);
    expect(result.rejectionCode).toBe("LOWER_BOUND_BELOW_COSTS");
    // The panel still shows the (positive) gross edge and says why it refused.
    expect(result.panel.edge.gross).not.toBeNull();
    expect(result.panel.entry_reason).toContain("limite inferior");
  });

  it("rejects an edge that clears the criterion but misses the liquidity floor", () => {
    // Net edge ~0.015: above the $0.01 margin floor, so the lower-bound
    // criterion passes — but below the $0.02/share liquidity floor, where a
    // ~2% round trip would eat it.
    const result = evaluateMarket({
      ...GOOD,
      qLo: "0.515000",
      qHi: "0.545000",
    });
    expect(result.rejectionCode).toBe("EDGE_BELOW_MIN");
  });

  it("refuses outside the price band whatever the edge says", () => {
    const cheap = evaluateMarket({
      ...GOOD,
      asks: [{ price: "0.05", size: "500" }],
      qLo: "0.500000",
      qHi: "0.600000",
      q: "0.550000",
    });
    expect(cheap.rejectionCode).toBe("PRICE_OUT_OF_BAND");

    const dear = evaluateMarket({
      ...GOOD,
      asks: [{ price: "0.97", size: "500" }],
      qLo: "0.995000",
      qHi: "0.999000",
      q: "0.997000",
    });
    expect(dear.rejectionCode).toBe("PRICE_OUT_OF_BAND");
  });
});

describe("side selection", () => {
  it("picks NO when the NO leg carries the edge", () => {
    // Bids at 0.20 means NO is offered at 0.80... which is expensive. Put the
    // bid high so NO is cheap: bid 0.90 => NO at 0.10, and a low q makes NO the
    // right side.
    const result = evaluateMarket({
      ...GOOD,
      q: "0.200000",
      qLo: "0.100000",
      qHi: "0.300000",
      bids: [{ price: "0.80", size: "500" }],
      asks: [{ price: "0.82", size: "500" }],
    });
    expect(result.best?.side).toBe("NO");
    expect(result.best?.orderSide).toBe("SELL");
    // NO pays 1 - q: lower bound is 1 - q_hi = 0.70 against a 0.20 price.
    expect(result.panel.suggested_side).toBe("NO");
  });

  it("uses 1 - q_hi for the NO leg, so a wide interval kills it", () => {
    const wide = evaluateMarket({
      ...GOOD,
      q: "0.200000",
      qLo: "0.010000",
      qHi: "0.850000",
      bids: [{ price: "0.80", size: "500" }],
      asks: [{ price: "0.82", size: "500" }],
    });
    // 1 - 0.85 = 0.15 against a 0.20 price: no edge on the conservative bound.
    expect(wide.entrable).toBe(false);
  });
});

describe("the opportunity panel", () => {
  it("carries all fourteen fields of the RFC's task 6", () => {
    const panel = evaluateMarket(GOOD).panel;
    expect(panel.market_probability.bid).toBe("0.49");
    expect(panel.market_probability.ask).toBe("0.50");
    expect(panel.market_probability.microprice).not.toBeNull();
    expect(panel.estimate.q_lo).toBe("0.650000");
    expect(panel.suggested_side).toBe("YES");
    expect(panel.book.spread).toBe("0.010000");
    expect(panel.book.asks.length).toBeGreaterThan(0);
    expect(panel.edge.net).not.toBeNull();
    expect(panel.costs.fee).not.toBeNull();
    expect(panel.costs.slippage).not.toBeNull();
    expect(panel.max_size.shares).not.toBeNull();
    expect(panel.max_size.binding_constraint).not.toBeNull();
    expect(panel.max_size.limiters.length).toBeGreaterThan(5);
    expect(panel.resolution_risk.action).toBe("NONE");
    expect(panel.entry_reason).not.toBeNull();
    expect(panel.invalidation_condition).not.toBeNull();
    expect(panel.data_freshness.book_age_ms).toBe(1_000);
    expect(panel.scenarios.worst).toBe("perda total da posição");
  });

  it("always states the worst case as TOTAL LOSS, with no stop softening it", () => {
    for (const override of [
      {},
      { qLo: "0.505000" },
      { resolutionAction: "VETO" as const },
      { portfolioState: "HALTED" as const },
    ]) {
      const panel = evaluateMarket({ ...GOOD, ...override }).panel;
      expect(panel.scenarios.worst).toBe("perda total da posição");
    }
  });

  it("reflects injected staleness in the freshness field", () => {
    const panel = evaluateMarket({
      ...GOOD,
      bookAgeMs: 45_000,
      estimateAgeMs: 120_000,
    }).panel;
    expect(panel.data_freshness.book_age_ms).toBe(45_000);
    expect(panel.data_freshness.estimate_age_ms).toBe(120_000);
  });

  it("names the binding constraint whenever a size was computed", () => {
    const tight = evaluateMarket({
      ...GOOD,
      capHeadroom: { ...GOOD.capHeadroom, mercado: s("4") },
    });
    expect(tight.sizing?.bindingConstraint).toBe("CAP_MERCADO");
    expect(tight.panel.max_size.binding_constraint).toBe("CAP_MERCADO");
  });
});

describe("sizing refusals", () => {
  it("reports CAP_EXHAUSTED when a cap leaves nothing", () => {
    const result = evaluateMarket({
      ...GOOD,
      capHeadroom: { ...GOOD.capHeadroom, categoria: 0n },
    });
    expect(result.entrable).toBe(false);
    expect(result.rejectionCode).toBe("CAP_EXHAUSTED");
  });

  it("reports SIZE_BELOW_MIN_ORDER when the venue floor is not reached", () => {
    const result = evaluateMarket({
      ...GOOD,
      capHeadroom: { ...GOOD.capHeadroom, mercado: s("1") },
      minOrderSize: "100",
    });
    expect(result.rejectionCode).toBe("SIZE_BELOW_MIN_ORDER");
  });

  it("never sizes above the depth share, whatever the caps allow", () => {
    const result = evaluateMarket({
      ...GOOD,
      asks: [{ price: "0.50", size: "40" }],
      capHeadroom: {
        entrada: s("1000"),
        mercado: s("1000"),
        grupoCorrelacionado: s("1000"),
        categoria: s("1000"),
        fonteResolucao: s("1000"),
        catalisadorJanela: s("1000"),
        capitalBloqueado: s("1000"),
      },
    });
    // 15% of 40 shares of executable depth = 6 shares.
    expect(result.sizing?.sizeScaled).toBeLessThanOrEqual(s("6"));
  });
});
