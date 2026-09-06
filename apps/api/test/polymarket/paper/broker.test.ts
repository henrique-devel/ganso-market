import { describe, expect, it } from "vitest";

import {
  executeTaker,
  isFillDegraded,
  markToExecutable,
  passiveFilledFromVolume,
  resolveOutcomeForToken,
  vwapOfFills,
} from "../../../src/polymarket/paper/broker.js";

const ASKS = [
  { price: "0.52", size: "60" },
  { price: "0.53", size: "100" },
  { price: "0.60", size: "500" },
];

describe("C1 taker book-walk", () => {
  it("consumes levels in order and records the exact slice", () => {
    const execution = executeTaker("BUY", "100", "0.53", ASKS, "0.07", false);
    expect(execution).not.toBeNull();
    expect(execution?.filledSize).toBe("100.000000");
    expect(execution?.fills).toEqual([
      { price: "0.520000", size: "60.000000", feeUsd: "1.048320" },
      { price: "0.530000", size: "40.000000", feeUsd: "0.697480" },
    ]);
    expect(execution?.consumedSlice).toEqual([
      { price: "0.520000", size: "60.000000" },
      { price: "0.530000", size: "40.000000" },
    ]);
  });

  it("never walks beyond worst_price: FAK leaves the remainder unfilled", () => {
    const execution = executeTaker("BUY", "100", "0.52", ASKS, "0.07", false);
    expect(execution?.filledSize).toBe("60.000000");
    expect(execution?.fills).toHaveLength(1);
    expect(execution?.killed).toBe(false);
  });

  it("FOK kills the whole order when the size cannot fill within worst", () => {
    const execution = executeTaker("BUY", "100", "0.52", ASKS, "0.07", true);
    expect(execution?.killed).toBe(true);
    expect(execution?.fills).toEqual([]);
    expect(execution?.filledSize).toBe("0.000000");
  });

  it("sells walk the bids downward with the worst as the floor", () => {
    const bids = [
      { price: "0.48", size: "30" },
      { price: "0.45", size: "100" },
    ];
    const execution = executeTaker("SELL", "50", "0.45", bids, "0", false);
    expect(execution?.fills).toEqual([
      { price: "0.480000", size: "30.000000", feeUsd: "0.000000" },
      { price: "0.450000", size: "20.000000", feeUsd: "0.000000" },
    ]);
    expect(vwapOfFills(execution?.fills ?? [])).toBe("0.468000");
  });
});

describe("C2 conservative passive queue", () => {
  it("fills only after traded volume exceeds the queue ahead", () => {
    expect(passiveFilledFromVolume("100", "50", "80")).toBe("0.000000");
    expect(passiveFilledFromVolume("100", "50", "120")).toBe("20.000000");
    expect(passiveFilledFromVolume("100", "50", "500")).toBe("50.000000");
  });

  it("an empty level fills from the first trade", () => {
    expect(passiveFilledFromVolume("0", "50", "10")).toBe("10.000000");
  });
});

describe("C6 deterministic fill degradation", () => {
  it("is stable for the same order and sequence", () => {
    for (const seq of ["1", "2", "42"]) {
      expect(isFillDegraded("order-a", seq)).toBe(
        isFillDegraded("order-a", seq),
      );
    }
  });

  it("denies roughly the configured fraction", () => {
    let denied = 0;
    for (let i = 0; i < 1_000; i += 1) {
      if (isFillDegraded("order-a", String(i))) {
        denied += 1;
      }
    }
    expect(denied).toBeGreaterThan(240);
    expect(denied).toBeLessThan(360);
  });
});

describe("C5 trinary resolution", () => {
  const tokens = ["tok-yes", "tok-no"];

  it("maps the token to its outcome price", () => {
    expect(
      resolveOutcomeForToken("tok-yes", tokens, ["1", "0"], false),
    ).toEqual({ ok: true, value: { outcomePrice: "1.000000" } });
    expect(resolveOutcomeForToken("tok-no", tokens, ["1", "0"], false)).toEqual(
      { ok: true, value: { outcomePrice: "0.000000" } },
    );
  });

  it("pays 0.5 on a 50/50 outcome in a normal market", () => {
    expect(
      resolveOutcomeForToken("tok-yes", tokens, ["0.5", "0.5"], false),
    ).toEqual({ ok: true, value: { outcomePrice: "0.500000" } });
  });

  it("a 50/50 in a negRisk market is a data error, never a liquidation", () => {
    expect(
      resolveOutcomeForToken("tok-yes", tokens, ["0.5", "0.5"], true),
    ).toEqual({ ok: false, reason: "NEGRISK_HALF_OUTCOME" });
  });

  it("refuses unknown tokens and non-trinary prices", () => {
    expect(
      resolveOutcomeForToken("tok-other", tokens, ["1", "0"], false),
    ).toEqual({ ok: false, reason: "TOKEN_NOT_IN_MARKET" });
    expect(
      resolveOutcomeForToken("tok-yes", tokens, ["0.7", "0.3"], false),
    ).toEqual({ ok: false, reason: "OUTCOME_NOT_TRINARY" });
  });

  // Two distinct failures used to answer the same reason code, and the one
  // production emitted 60x/h for a whole book's lifetime was the misleading
  // half: the token was in the market, the price array was empty. A reason
  // code that names the wrong cause costs more than one that says nothing.
  it("separates a missing price from a missing token", () => {
    expect(resolveOutcomeForToken("tok-yes", tokens, [], false)).toEqual({
      ok: false,
      reason: "RESOLUTION_PRICES_MISSING",
    });
    // Short array: the token is known, its index is past the end.
    expect(resolveOutcomeForToken("tok-no", tokens, ["1"], false)).toEqual({
      ok: false,
      reason: "RESOLUTION_PRICES_MISSING",
    });
    // Absent token stays TOKEN_NOT_IN_MARKET even with prices present.
    expect(
      resolveOutcomeForToken("tok-other", tokens, ["1", "0"], false),
    ).toEqual({ ok: false, reason: "TOKEN_NOT_IN_MARKET" });
    // And with no prices at all, the missing token still wins the report.
    expect(resolveOutcomeForToken("tok-other", tokens, [], false)).toEqual({
      ok: false,
      reason: "TOKEN_NOT_IN_MARKET",
    });
  });
});

describe("D2 mark to executable", () => {
  const bids = [
    { price: "0.50", size: "60" },
    { price: "0.45", size: "40" },
  ];

  it("walks the whole position, never the touch alone", () => {
    // 100 shares: 60 x 0.50 + 40 x 0.45 = 48, not 100 x 0.50.
    expect(markToExecutable("100", bids)).toBe("48.000000");
  });

  it("insufficient visible depth yields no mark at all", () => {
    expect(markToExecutable("500", bids)).toBeNull();
  });

  it("a short position marks against the cost to buy back", () => {
    const asks = [{ price: "0.55", size: "100" }];
    expect(markToExecutable("-40", asks)).toBe("22.000000");
  });
});
