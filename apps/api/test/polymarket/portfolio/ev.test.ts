import { describe, expect, it } from "vitest";

import {
  parseScaled,
  SCALE,
} from "../../../src/polymarket/fundamental/fixed.js";
import {
  bookWalk,
  capitalCostPerShare,
  clearsEntryCriterion,
  computeEv,
  depthUpTo,
  money,
  takerFeePerShare,
} from "../../../src/polymarket/portfolio/ev.js";
import type { BookLevel } from "../../../src/polymarket/portfolio/types.js";

function s(value: string): bigint {
  const parsed = parseScaled(value);
  if (parsed === null) {
    throw new Error(`unparseable fixture value: ${value}`);
  }
  return parsed;
}

const ASKS: readonly BookLevel[] = [
  { price: "0.40", size: "100" },
  { price: "0.42", size: "200" },
  { price: "0.45", size: "500" },
];

const DAY_S = 86_400;

describe("book walk", () => {
  it("returns the VWAP, the worst level consumed and the best level", () => {
    const walk = bookWalk(ASKS, s("250"));
    expect(walk).not.toBeNull();
    // 100 @ 0.40 + 150 @ 0.42 = 40 + 63 = 103 over 250 shares = 0.412
    expect(money(walk!.vwapScaled)).toBe("0.412000");
    expect(money(walk!.worstScaled)).toBe("0.420000");
    expect(money(walk!.bestScaled)).toBe("0.400000");
    expect(walk!.complete).toBe(true);
  });

  it("reports an incomplete walk instead of pretending the book had the size", () => {
    const walk = bookWalk(ASKS, s("5000"));
    expect(walk!.complete).toBe(false);
    expect(money(walk!.filledScaled)).toBe("800.000000");
  });

  it("refuses a malformed book rather than trading against a guess", () => {
    expect(bookWalk([{ price: "abc", size: "10" }], s("5"))).toBeNull();
    expect(bookWalk([{ price: "0.40", size: "-5" }], s("5"))).toBeNull();
    expect(bookWalk([], s("5"))).toBeNull();
    expect(bookWalk(ASKS, 0n)).toBeNull();
  });

  it("measures depth up to a limit price, not volume", () => {
    // Depth is what a size can actually be filled against. Roughly 25% of
    // platform volume is estimated wash, so volume is not a liquidity measure.
    expect(money(depthUpTo(ASKS, s("0.42"), "ask"))).toBe("300.000000");
    expect(money(depthUpTo(ASKS, s("0.45"), "ask"))).toBe("800.000000");
    expect(money(depthUpTo(ASKS, s("0.39"), "ask"))).toBe("0.000000");
  });
});

describe("taker fee curve", () => {
  it("peaks at p = 0.5 and vanishes at the extremes (C x rate x p x (1-p))", () => {
    const rate = s("0.07");
    const mid = takerFeePerShare(rate, s("0.50"));
    const edge = takerFeePerShare(rate, s("0.95"));
    // 0.07 x 0.5 x 0.5 = 0.0175 per share => $1.75 per 100 shares.
    expect(money(mid)).toBe("0.017500");
    expect(money(edge)).toBe("0.003325");
    expect(mid > edge).toBe(true);
    expect(takerFeePerShare(rate, SCALE)).toBe(0n);
  });
});

describe("capital cost", () => {
  it("charges the annual rate over the expected lockup, on the price paid", () => {
    // 12% a year over 30 days on a $0.50 share, with no buffer overlap:
    // 0.12 x 30/365 x 0.50 = 0.004931...
    const cost = capitalCostPerShare({
      priceScaled: s("0.50"),
      expectedLockupS: 30 * DAY_S,
      annualRateScaled: s("0.12"),
      bufferDailyHurdleScaled: 0n,
    });
    expect(money(cost)).toBe("0.004931");
  });

  it("never double-charges the lockup the RFC-012 buffer already covers", () => {
    // The RFC-012 buffer already adds capitalDailyHurdle x lockupDays. Charging
    // the full RFC-013 capital cost on top would bill the same lockup twice.
    const overlap = capitalCostPerShare({
      priceScaled: s("0.50"),
      expectedLockupS: 30 * DAY_S,
      annualRateScaled: s("0.12"),
      bufferDailyHurdleScaled: s("0.0005"),
    });
    // 0.0049315 own - 0.015 already charged => clamped at zero, never negative.
    expect(overlap).toBe(0n);
  });

  it("still charges the excess when its own rate exceeds the buffer hurdle", () => {
    const excess = capitalCostPerShare({
      priceScaled: s("0.90"),
      expectedLockupS: 30 * DAY_S,
      annualRateScaled: s("2.00"),
      bufferDailyHurdleScaled: s("0.0005"),
    });
    // 2.00 x 30/365 x 0.90 = 0.147945; minus 0.015 = 0.132945
    expect(money(excess)).toBe("0.132945");
  });

  it("is zero for an instant lockup", () => {
    expect(
      capitalCostPerShare({
        priceScaled: s("0.50"),
        expectedLockupS: 0,
        annualRateScaled: s("0.12"),
        bufferDailyHurdleScaled: 0n,
      }),
    ).toBe(0n);
  });
});

describe("EV per share", () => {
  const base = {
    qScaled: s("0.60"),
    qLoScaled: s("0.55"),
    qHiScaled: s("0.65"),
    takerFeeRateScaled: s("0.07"),
    expectedLockupS: 0,
    capitalAnnualRateScaled: s("0.12"),
    bufferDailyHurdleScaled: 0n,
    resolutionBufferScaled: 0n,
    safetyMarginMinScaled: s("0.01"),
    safetyMarginEdgeFractionScaled: s("0.25"),
  };

  it("decomposes a maker YES entry: no fee, slippage from the walk", () => {
    const walk = bookWalk(ASKS, s("250"))!;
    const ev = computeEv({ ...base, side: "YES", walk, maker: true });

    expect(money(ev.execPriceScaled)).toBe("0.412000");
    expect(money(ev.feeScaled)).toBe("0.000000");
    // VWAP 0.412 against a best of 0.40.
    expect(money(ev.slippageScaled)).toBe("0.012000");
    expect(money(ev.capitalCostScaled)).toBe("0.000000");
    expect(money(ev.costsTotalScaled)).toBe("0.012000");
    // Gross edge uses the POINT estimate: 0.60 - 0.412
    expect(money(ev.edgeGrossScaled)).toBe("0.188000");
    // Net edge uses the LOWER BOUND: 0.55 - 0.412 - 0.012
    expect(money(ev.edgeNetScaled)).toBe("0.126000");
  });

  it("charges the taker fee when the intent is marketable", () => {
    const walk = bookWalk(ASKS, s("250"))!;
    const maker = computeEv({ ...base, side: "YES", walk, maker: true });
    const taker = computeEv({ ...base, side: "YES", walk, maker: false });

    expect(money(taker.feeScaled)).toBe("0.016957");
    expect(taker.costsTotalScaled > maker.costsTotalScaled).toBe(true);
    expect(taker.edgeNetScaled < maker.edgeNetScaled).toBe(true);
  });

  it("treats an unknown fee rate as maker-only rather than assuming zero cost", () => {
    // A null rate disables the taker path upstream; here it must not silently
    // become a free taker order.
    const walk = bookWalk(ASKS, s("250"))!;
    const ev = computeEv({
      ...base,
      side: "YES",
      walk,
      maker: false,
      takerFeeRateScaled: null,
    });
    expect(ev.feeScaled).toBe(0n);
  });

  it("uses 1 - q_hi for a NO entry, never 1 - q_lo", () => {
    // Flipping the side flips which end of the interval is the pessimistic one.
    // Using 1 - q_lo here would be the OPTIMISTIC bound wearing the lower
    // bound's name.
    const noAsks: readonly BookLevel[] = [{ price: "0.30", size: "1000" }];
    const walk = bookWalk(noAsks, s("100"))!;
    const ev = computeEv({ ...base, side: "NO", walk, maker: true });

    // prob = 1 - 0.60 = 0.40; lower = 1 - 0.65 = 0.35
    expect(money(ev.probScaled)).toBe("0.400000");
    expect(money(ev.probLowerScaled)).toBe("0.350000");
    expect(money(ev.edgeNetScaled)).toBe("0.050000");
  });

  it("subtracts the RFC-012 resolution buffer as a cost, monotonically", () => {
    const walk = bookWalk(ASKS, s("250"))!;
    const clean = computeEv({ ...base, side: "YES", walk, maker: true });
    const risky = computeEv({
      ...base,
      side: "YES",
      walk,
      maker: true,
      resolutionBufferScaled: s("0.05"),
    });
    expect(risky.edgeNetScaled).toBe(clean.edgeNetScaled - s("0.05"));
  });

  it("charges more capital cost for the disputed tail than the base case", () => {
    // Bimodal lockup: crypto-price settles in ~38 min, but a dispute adds ~49 h
    // at the median. The same market must cost more when the tail is expected.
    const walk = bookWalk(ASKS, s("250"))!;
    const fast = computeEv({
      ...base,
      side: "YES",
      walk,
      maker: true,
      expectedLockupS: 38 * 60,
    });
    const disputed = computeEv({
      ...base,
      side: "YES",
      walk,
      maker: true,
      expectedLockupS: 49 * 3_600,
    });
    expect(disputed.capitalCostScaled > fast.capitalCostScaled).toBe(true);
    expect(disputed.edgeNetScaled < fast.edgeNetScaled).toBe(true);
  });
});

describe("entry criterion", () => {
  const walk = bookWalk([{ price: "0.50", size: "1000" }], s("100"))!;
  const base = {
    side: "YES" as const,
    walk,
    maker: true,
    qScaled: s("0.70"),
    takerFeeRateScaled: null,
    expectedLockupS: 0,
    capitalAnnualRateScaled: s("0.12"),
    bufferDailyHurdleScaled: 0n,
    resolutionBufferScaled: 0n,
    safetyMarginMinScaled: s("0.01"),
    safetyMarginEdgeFractionScaled: s("0.25"),
  };

  it("passes when the LOWER bound clears price plus costs plus margin", () => {
    const ev = computeEv({
      ...base,
      qLoScaled: s("0.60"),
      qHiScaled: s("0.80"),
    });
    // lower gross 0.10, costs 0, margin = max(0.01, 25% of 0.10) = 0.025
    expect(money(ev.safetyMarginScaled)).toBe("0.025000");
    expect(clearsEntryCriterion(ev)).toBe(true);
  });

  it("REJECTS a favourable mean whose lower bound does not clear the costs", () => {
    // This is the RFC's central invariant: the mean says 0.70 against a 0.50
    // price — a 20¢ "edge" — but the lower bound is 0.505, so the trade is not
    // there. There is no high-conviction exception.
    const ev = computeEv({
      ...base,
      qLoScaled: s("0.505"),
      qHiScaled: s("0.90"),
    });
    expect(ev.edgeGrossScaled > 0n).toBe(true);
    expect(clearsEntryCriterion(ev)).toBe(false);
  });

  it("rejects when the margin alone eats the edge", () => {
    const ev = computeEv({
      ...base,
      qLoScaled: s("0.5099"),
      qHiScaled: s("0.80"),
    });
    // lower gross 0.0099 < the 0.01 margin floor.
    expect(money(ev.safetyMarginScaled)).toBe("0.010000");
    expect(clearsEntryCriterion(ev)).toBe(false);
  });

  it("floors the margin at the absolute minimum for tiny edges", () => {
    // 25% of a 0.02 edge is 0.005, below the $0.01/share floor: the floor wins,
    // and the trade still clears because 0.02 > 0.01.
    const clears = computeEv({
      ...base,
      qLoScaled: s("0.52"),
      qHiScaled: s("0.55"),
    });
    expect(money(clears.safetyMarginScaled)).toBe("0.010000");
    expect(clearsEntryCriterion(clears)).toBe(true);

    // Just under the floor, the same fraction would have waved it through.
    const rejected = computeEv({
      ...base,
      qLoScaled: s("0.509"),
      qHiScaled: s("0.55"),
    });
    expect(money(rejected.safetyMarginScaled)).toBe("0.010000");
    expect(clearsEntryCriterion(rejected)).toBe(false);
  });
});
