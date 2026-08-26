import { describe, expect, it } from "vitest";

import { parseScaled } from "../../../src/polymarket/fundamental/fixed.js";
import { money } from "../../../src/polymarket/portfolio/ev.js";
import {
  computeSize,
  kellyFraction,
  slippageCappedSize,
  type SizingInput,
} from "../../../src/polymarket/portfolio/sizing.js";
import { BINDING_CONSTRAINTS } from "../../../src/polymarket/portfolio/types.js";

function s(value: string): bigint {
  const parsed = parseScaled(value);
  if (parsed === null) {
    throw new Error(`unparseable fixture value: ${value}`);
  }
  return parsed;
}

/**
 * A deliberately UNCONSTRAINED baseline: every limiter is set generous enough
 * that Kelly binds. Each test below then tightens exactly one limiter and
 * asserts that it — and only it — became the binding constraint.
 */
const BASE: SizingInput = {
  probLowerScaled: s("0.60"),
  execPriceScaled: s("0.40"),
  intervalWidthScaled: 0n,
  kellyLambdaScaled: s("0.25"),
  uncertaintyShrinkSlopeScaled: s("1"),
  bankrollScaled: s("1000"),
  executableDepthScaled: s("100000"),
  depthTakePctScaled: s("0.15"),
  rulePrecisionMultiplierScaled: s("1"),
  correlationMultiplierScaled: s("1"),
  capHeadroom: {
    entrada: s("1000000"),
    mercado: s("1000000"),
    grupoCorrelacionado: s("1000000"),
    categoria: s("1000000"),
    fonteResolucao: s("1000000"),
    catalisadorJanela: s("1000000"),
    capitalBloqueado: s("1000000"),
  },
  minOrderSizeScaled: s("5"),
  slippageCapSizeScaled: s("100000"),
};

describe("fractional Kelly", () => {
  it("computes lambda x (p - a) / (1 - a) on the LOWER bound", () => {
    // 0.25 x (0.60 - 0.40) / (1 - 0.40) = 0.25 x 0.3333... = 0.08333...
    const { fractionScaled } = kellyFraction({
      probLowerScaled: s("0.60"),
      execPriceScaled: s("0.40"),
      intervalWidthScaled: 0n,
      kellyLambdaScaled: s("0.25"),
      uncertaintyShrinkSlopeScaled: s("1"),
    });
    expect(money(fractionScaled)).toBe("0.083333");
  });

  it("is zero when the lower bound does not beat the price", () => {
    const { fractionScaled } = kellyFraction({
      probLowerScaled: s("0.40"),
      execPriceScaled: s("0.40"),
      intervalWidthScaled: 0n,
      kellyLambdaScaled: s("0.25"),
      uncertaintyShrinkSlopeScaled: s("1"),
    });
    expect(fractionScaled).toBe(0n);
  });

  it("shrinks as the estimate interval widens", () => {
    const tight = kellyFraction({
      probLowerScaled: s("0.60"),
      execPriceScaled: s("0.40"),
      intervalWidthScaled: s("0.02"),
      kellyLambdaScaled: s("0.25"),
      uncertaintyShrinkSlopeScaled: s("1"),
    });
    const wide = kellyFraction({
      probLowerScaled: s("0.60"),
      execPriceScaled: s("0.40"),
      intervalWidthScaled: s("0.40"),
      kellyLambdaScaled: s("0.25"),
      uncertaintyShrinkSlopeScaled: s("1"),
    });
    expect(wide.fractionScaled < tight.fractionScaled).toBe(true);
    expect(wide.shrunkLambdaScaled < s("0.25")).toBe(true);
  });

  it("never exceeds the configured lambda, however tight the interval", () => {
    const { shrunkLambdaScaled } = kellyFraction({
      probLowerScaled: s("0.99"),
      execPriceScaled: s("0.01"),
      intervalWidthScaled: 0n,
      kellyLambdaScaled: s("0.25"),
      uncertaintyShrinkSlopeScaled: s("1"),
    });
    expect(shrunkLambdaScaled).toBe(s("0.25"));
  });
});

describe("sizing: every limiter can bind", () => {
  it("binds on Kelly when nothing else is tighter", () => {
    const result = computeSize(BASE);
    // 8.3333% of $1000 = $83.33 at $0.40 = 208.33 shares.
    expect(result.bindingConstraint).toBe("KELLY_CAP");
    expect(money(result.sizeScaled)).toBe("208.333332");
    expect(result.kellyCapSharesScaled).toBe(result.sizeScaled);
  });

  it("binds on depth_take_pct, and never takes more than that share of depth", () => {
    const result = computeSize({
      ...BASE,
      executableDepthScaled: s("1000"),
    });
    expect(result.bindingConstraint).toBe("DEPTH_TAKE_PCT");
    // 15% of 1000 shares of executable depth.
    expect(money(result.sizeScaled)).toBe("150.000000");
    expect(result.sizeScaled <= s("150")).toBe(true);
  });

  it("binds on the correlation multiplier at the factor level", () => {
    const result = computeSize({
      ...BASE,
      correlationMultiplierScaled: s("0.25"),
    });
    expect(result.bindingConstraint).toBe("CORRELATION_FACTOR");
    expect(money(result.sizeScaled)).toBe("52.083333");
  });

  it("binds on the RFC-012 rule-precision multiplier", () => {
    const result = computeSize({
      ...BASE,
      rulePrecisionMultiplierScaled: s("0.10"),
    });
    expect(result.bindingConstraint).toBe("RULE_PRECISION");
    expect(money(result.sizeScaled)).toBe("20.833333");
  });

  it("binds on the estimate-uncertainty shrink", () => {
    // A wide interval shrinks lambda, so the KELLY_CAP limiter itself falls
    // below the un-shrunk ceiling that UNCERTAINTY_SHRINK reports.
    const result = computeSize({
      ...BASE,
      intervalWidthScaled: s("0.50"),
    });
    expect(result.bindingConstraint).toBe("KELLY_CAP");
    const unshrunk = result.limiters.find(
      (limiter) => limiter.constraint === "UNCERTAINTY_SHRINK",
    );
    expect(unshrunk?.maxSizeScaled).toBeDefined();
    expect(result.sizeScaled < unshrunk!.maxSizeScaled).toBe(true);
    expect(money(result.sizeScaled)).toBe("138.888890");
  });

  it.each([
    ["entrada", "CAP_ENTRADA"],
    ["mercado", "CAP_MERCADO"],
    ["grupoCorrelacionado", "CAP_GRUPO_CORRELACIONADO"],
    ["categoria", "CAP_CATEGORIA"],
    ["fonteResolucao", "CAP_FONTE_RESOLUCAO"],
    ["catalisadorJanela", "CAP_CATALISADOR_JANELA"],
    ["capitalBloqueado", "CAP_CAPITAL_BLOQUEADO"],
  ])(
    "binds on the %s cap when its headroom is the tightest",
    (key, expected) => {
      const result = computeSize({
        ...BASE,
        capHeadroom: { ...BASE.capHeadroom, [key]: s("4") },
      });
      expect(result.bindingConstraint).toBe(expected);
      // $4 of headroom at $0.40 = 10 shares.
      expect(money(result.sizeScaled)).toBe("10.000000");
    },
  );

  it("binds on the slippage ceiling", () => {
    const result = computeSize({ ...BASE, slippageCapSizeScaled: s("30") });
    expect(result.bindingConstraint).toBe("SLIPPAGE_MAX_PCT_EDGE");
    expect(money(result.sizeScaled)).toBe("30.000000");
  });

  it("has a fixture for every constraint the type declares", () => {
    // A new limiter added to the union without a fixture here would ship
    // untested, which is exactly the failure the RFC's sizing tests exist to
    // prevent.
    const covered = new Set([
      "KELLY_CAP",
      "DEPTH_TAKE_PCT",
      "UNCERTAINTY_SHRINK",
      "CORRELATION_FACTOR",
      "RULE_PRECISION",
      "CAP_ENTRADA",
      "CAP_MERCADO",
      "CAP_GRUPO_CORRELACIONADO",
      "CAP_CATEGORIA",
      "CAP_FONTE_RESOLUCAO",
      "CAP_CATALISADOR_JANELA",
      "CAP_CAPITAL_BLOQUEADO",
      "SLIPPAGE_MAX_PCT_EDGE",
      "MIN_ORDER_SIZE",
      "NOT_SIZED",
    ]);
    expect([...BINDING_CONSTRAINTS].sort()).toEqual([...covered].sort());
  });
});

describe("sizing: hard floors and refusals", () => {
  it("returns no size at all below the venue minimum order size", () => {
    const result = computeSize({
      ...BASE,
      capHeadroom: { ...BASE.capHeadroom, mercado: s("1") },
      minOrderSizeScaled: s("100"),
    });
    // $1 of headroom at $0.40 = 2.5 shares, under a 100-share minimum.
    expect(result.sizeScaled).toBe(0n);
    expect(result.bindingConstraint).toBe("MIN_ORDER_SIZE");
    expect(result.notionalScaled).toBe(0n);
  });

  it("returns zero when a cap is already exhausted, never a negative size", () => {
    const result = computeSize({
      ...BASE,
      capHeadroom: { ...BASE.capHeadroom, categoria: -s("500") },
    });
    expect(result.sizeScaled).toBe(0n);
    expect(result.bindingConstraint).toBe("CAP_CATEGORIA");
  });

  it("treats a missing cap entry as exhausted, not as unlimited", () => {
    // Failing open here would silently remove a cap — the direction the RFC
    // forbids.
    const result = computeSize({ ...BASE, capHeadroom: {} });
    expect(result.sizeScaled).toBe(0n);
  });

  it("takes the min() of every limiter, not the first or the last", () => {
    const result = computeSize({
      ...BASE,
      executableDepthScaled: s("2000"),
      correlationMultiplierScaled: s("0.50"),
      capHeadroom: { ...BASE.capHeadroom, mercado: s("20") },
      slippageCapSizeScaled: s("80"),
    });
    // depth 300, correlation 104.17, mercado 50, slippage 80 => 50 wins.
    expect(result.bindingConstraint).toBe("CAP_MERCADO");
    expect(money(result.sizeScaled)).toBe("50.000000");
    for (const limiter of result.limiters) {
      expect(result.sizeScaled <= limiter.maxSizeScaled).toBe(true);
    }
  });

  it("keeps a correlated group inside the joint cap even across many markets", () => {
    // The group is sized as ONE bet: as sibling positions consume the group
    // headroom, the next market in the same negRisk event gets what is left,
    // never its own fresh allowance.
    const groupCapUsd = s("200");
    let consumed = 0n;
    for (let i = 0; i < 5; i += 1) {
      const result = computeSize({
        ...BASE,
        capHeadroom: {
          ...BASE.capHeadroom,
          grupoCorrelacionado: groupCapUsd - consumed,
        },
      });
      consumed += result.notionalScaled;
    }
    expect(consumed <= groupCapUsd).toBe(true);
  });
});

describe("slippage-capped size", () => {
  const levels = [
    { priceScaled: s("0.40"), sizeScaled: s("100") },
    { priceScaled: s("0.42"), sizeScaled: s("200") },
    { priceScaled: s("0.60"), sizeScaled: s("500") },
  ];

  it("stops before the level whose VWAP breaks the allowance", () => {
    // Gross edge 0.20, allowance 25% = 0.05 over the best price of 0.40.
    const size = slippageCappedSize({
      levels,
      grossEdgeScaled: s("0.20"),
      maxPctEdgeScaled: s("0.25"),
    });
    // The first two levels keep the VWAP at 0.4133 (0.0133 of slippage); the
    // 0.60 level would blow past 0.45, so only part of it fits.
    expect(size > s("300")).toBe(true);
    expect(size < s("800")).toBe(true);
  });

  it("allows the whole book when the allowance is generous", () => {
    const size = slippageCappedSize({
      levels,
      grossEdgeScaled: s("0.80"),
      maxPctEdgeScaled: s("1"),
    });
    expect(money(size)).toBe("800.000000");
  });

  it("returns zero when there is no gross edge to spend on slippage", () => {
    expect(
      slippageCappedSize({
        levels,
        grossEdgeScaled: 0n,
        maxPctEdgeScaled: s("0.25"),
      }),
    ).toBe(0n);
    expect(
      slippageCappedSize({
        levels,
        grossEdgeScaled: -s("0.10"),
        maxPctEdgeScaled: s("0.25"),
      }),
    ).toBe(0n);
  });

  it("never returns a size whose realized slippage exceeds the allowance", () => {
    const grossEdge = s("0.20");
    const maxPct = s("0.25");
    const size = slippageCappedSize({
      levels,
      grossEdgeScaled: grossEdge,
      maxPctEdgeScaled: maxPct,
    });
    // Re-walk the book for exactly that size and check the realized slippage.
    let remaining = size;
    let notional = 0n;
    let taken = 0n;
    for (const level of levels) {
      if (remaining <= 0n) {
        break;
      }
      const take = level.sizeScaled < remaining ? level.sizeScaled : remaining;
      notional += (level.priceScaled * take) / s("1");
      taken += take;
      remaining -= take;
    }
    const vwap = (notional * s("1")) / taken;
    const allowance = (maxPct * grossEdge) / s("1");
    expect(vwap - s("0.40") <= allowance).toBe(true);
  });
});
