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
  computeExecutionEv,
  type EvInput,
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

  it("preserves the legacy maker candidate proxy and walk diagnostic", () => {
    const walk = bookWalk(ASKS, s("250"))!;
    const ev = computeEv({ ...base, side: "YES", walk, maker: true });

    expect(money(ev.execPriceScaled)).toBe("0.412000");
    expect(money(ev.feeScaled)).toBe("0.000000");
    // VWAP 0.412 against a best of 0.40.
    expect(money(ev.slippageScaled)).toBe("0.012000");
    expect(money(ev.capitalCostScaled)).toBe("0.000000");
    expect(money(ev.costsTotalScaled)).toBe("0.000000");
    // Gross edge uses the POINT estimate: 0.60 - 0.412
    expect(money(ev.edgeGrossScaled)).toBe("0.188000");
    // Net edge uses the LOWER BOUND: 0.55 - 0.412; slippage is already paid.
    expect(money(ev.edgeNetScaled)).toBe("0.138000");
    expect(ev.priceBasis).toBe("candidate-vwap");
    expect(ev.modelVersion).toBe("ev-costs-v2");
  });

  it("charges the taker fee when the intent is marketable", () => {
    const walk = bookWalk(ASKS, s("250"))!;
    const maker = computeEv({ ...base, side: "YES", walk, maker: true });
    const taker = computeEv({ ...base, side: "YES", walk, maker: false });

    // .07 x .412 x .588 = .016957920; .55 - .412 - fee = .121042080.
    expect(taker.feeScaled).toBe(16_957_920n);
    expect(taker.costsTotalScaled).toBe(16_957_920n);
    expect(taker.edgeNetScaled).toBe(121_042_080n);
    expect(maker.costsTotalScaled).toBe(0n);
    expect(maker.edgeNetScaled).toBe(138_000_000n);
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
    expect(ev.feeKnown).toBe(false);
    expect(clearsEntryCriterion(ev)).toBe(false);
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
    expect(clean.edgeNetScaled).toBe(138_000_000n);
    expect(risky.edgeNetScaled).toBe(88_000_000n);
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

// EXEC-01: all economic expectations below are hand-calculated constants.
// Rates/costs are synthetic evidence, never a venue fee schedule.
describe("EXEC-01 one cost, one incidence", () => {
  const input: EvInput = {
    side: "YES",
    qScaled: s("0.65"),
    qLoScaled: s("0.65"),
    qHiScaled: s("0.75"),
    // 50 x .50 + 50 x .60 = 55 USD / 100 shares = .55 USD/share.
    walk: bookWalk(
      [
        { price: "0.50", size: "50" },
        { price: "0.60", size: "50" },
      ],
      s("100"),
    )!,
    maker: false,
    takerFeeRateScaled: 0n,
    expectedLockupS: 0,
    capitalAnnualRateScaled: 0n,
    bufferDailyHurdleScaled: 0n,
    resolutionBufferScaled: 0n,
    safetyMarginMinScaled: 0n,
    safetyMarginEdgeFractionScaled: 0n,
  };

  it(".65 payoff minus .55 VWAP is .10, with .05 diagnostic only", () => {
    const ev = computeEv(input);
    expect(ev.execPriceScaled).toBe(550_000_000n);
    expect(ev.slippageScaled).toBe(50_000_000n);
    expect(ev.costsTotalScaled).toBe(0n);
    expect(ev.edgeNetScaled).toBe(100_000_000n);
    expect(computeExecutionEv(input).ok).toBe(true);
  });

  it("known fee is the only extra debit: .04 x .55 x .45 = .0099", () => {
    const ev = computeEv({ ...input, takerFeeRateScaled: s("0.04") });
    expect(ev.feeScaled).toBe(9_900_000n);
    expect(ev.costsTotalScaled).toBe(9_900_000n);
    expect(ev.edgeNetScaled).toBe(90_100_000n);
    expect(ev.slippageScaled).toBe(50_000_000n);
  });

  it("charges capital excess and buffer once; compares margin separately", () => {
    // One year: capital=.20 x .55=.11; buffer already includes
    // .0001 x 365=.0365. Excess=.0735; buffer=.04, fee=.0099.
    // EV=.65-.55-.0735-.04-.0099=-.0234; margin=.25 x .10=.025.
    const ev = computeEv({
      ...input,
      takerFeeRateScaled: s("0.04"),
      expectedLockupS: 365 * DAY_S,
      capitalAnnualRateScaled: s("0.20"),
      bufferDailyHurdleScaled: s("0.0001"),
      resolutionBufferScaled: s("0.04"),
      safetyMarginMinScaled: s("0.01"),
      safetyMarginEdgeFractionScaled: s("0.25"),
    });
    expect(ev.capitalCostScaled).toBe(73_500_000n);
    expect(ev.costsTotalScaled).toBe(123_400_000n);
    expect(ev.edgeNetScaled).toBe(-23_400_000n);
    expect(ev.safetyMarginScaled).toBe(25_000_000n);
    expect(clearsEntryCriterion(ev)).toBe(false);
  });

  it("maker uses its limit and explicit conditional costs, without taker fees", () => {
    // Maker .48, fee .002, selection .003 => .65-.48-.002-.003=.165.
    const result = computeExecutionEv({
      ...input,
      maker: true,
      takerFeeRateScaled: null,
      makerLimitPriceScaled: s("0.48"),
      makerFeeScaled: s("0.002"),
      makerAdverseSelectionScaled: s("0.003"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.priceBasis).toBe("maker-limit");
    expect(result.value.execPriceScaled).toBe(480_000_000n);
    expect(result.value.feeScaled).toBe(2_000_000n);
    expect(result.value.costsTotalScaled).toBe(5_000_000n);
    expect(result.value.edgeNetScaled).toBe(165_000_000n);
    expect(result.value.slippageScaled).toBe(50_000_000n);
  });

  it("known zero maker fee stays explicit; capital is charged on the limit", () => {
    // Conditional fill at .48; one-year capital .10*.48=.048.
    // EV=.65-.48-.048=.122; no taker fee or assumed rebate.
    const result = computeExecutionEv({
      ...input,
      maker: true,
      makerLimitPriceScaled: s("0.48"),
      makerFeeScaled: 0n,
      makerAdverseSelectionScaled: 0n,
      takerFeeRateScaled: s("0.04"),
      expectedLockupS: 365 * DAY_S,
      capitalAnnualRateScaled: s("0.10"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.feeScaled).toBe(0n);
    expect(result.value.capitalCostScaled).toBe(48_000_000n);
    expect(result.value.edgeNetScaled).toBe(122_000_000n);
  });

  it.each([
    { qLoScaled: s("0.90") },
    { qHiScaled: s("1.01") },
    { resolutionBufferScaled: -1n },
    { expectedLockupS: NaN },
  ])("rejects invalid cost/probability evidence %s", (overrides) => {
    expect(computeExecutionEv({ ...input, ...overrides })).toEqual({
      ok: false,
      reason: "INVALID_EV_INPUT",
    });
  });

  it("does not treat a candidate VWAP as maker execution evidence", () => {
    expect(computeExecutionEv({ ...input, maker: true })).toEqual({
      ok: false,
      reason: "INVALID_MAKER_LIMIT",
    });
    expect(
      computeExecutionEv({
        ...input,
        maker: true,
        makerLimitPriceScaled: s("0.48"),
      }),
    ).toEqual({ ok: false, reason: "MAKER_FEE_UNKNOWN" });
    expect(
      computeExecutionEv({
        ...input,
        maker: true,
        makerLimitPriceScaled: s("0.48"),
        makerFeeScaled: 0n,
      }),
    ).toEqual({ ok: false, reason: "MAKER_SELECTION_COST_UNKNOWN" });
    expect(
      computeExecutionEv({
        ...input,
        maker: true,
        makerLimitPriceScaled: s("0.50"),
        makerFeeScaled: 0n,
        makerAdverseSelectionScaled: 0n,
      }),
    ).toEqual({ ok: false, reason: "INVALID_MAKER_LIMIT" });
  });

  it.each([null, -1n])(
    "unknown/invalid taker fee %s never clears aggression",
    (rate) => {
      const candidate = { ...input, takerFeeRateScaled: rate };
      expect(computeExecutionEv(candidate)).toEqual({
        ok: false,
        reason: "TAKER_FEE_UNKNOWN",
      });
      expect(clearsEntryCriterion(computeEv(candidate))).toBe(false);
    },
  );

  it("NO uses 1-qHi=.65, not 1-qLo=.75, and pays the fee once", () => {
    const ev = computeEv({
      ...input,
      side: "NO",
      qScaled: s("0.30"),
      qLoScaled: s("0.25"),
      qHiScaled: s("0.35"),
      takerFeeRateScaled: s("0.04"),
    });
    expect(ev.probLowerScaled).toBe(650_000_000n);
    expect(ev.edgeGrossScaled).toBe(150_000_000n);
    expect(ev.edgeNetScaled).toBe(90_100_000n);
  });

  it("incomplete bookwalk remains diagnostic and cannot approve an entry", () => {
    const candidate = {
      ...input,
      walk: bookWalk(
        [
          { price: "0.50", size: "50" },
          { price: "0.60", size: "50" },
        ],
        s("101"),
      )!,
    };
    expect(computeExecutionEv(candidate)).toEqual({
      ok: false,
      reason: "BOOK_WALK_INCOMPLETE",
    });
    expect(clearsEntryCriterion(computeEv(candidate))).toBe(false);
  });

  it.each(["0", "1", "1.01", "-0.1"])(
    "rejects invalid binary execution price %s",
    (price) => {
      expect(bookWalk([{ price, size: "100" }], s("100"))).toBeNull();
      expect(
        computeExecutionEv({
          ...input,
          walk: { ...input.walk, vwapScaled: s(price) },
        }),
      ).toEqual({ ok: false, reason: "INVALID_BUY_WALK" });
    },
  );
});
