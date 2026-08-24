import { describe, expect, it } from "vitest";

import {
  decideOrderType,
  TAKER_DELAY_MS,
  type PolicyContext,
} from "../../../src/polymarket/paper/policy.js";

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    side: "BUY",
    qLo: "0.50",
    size: "50",
    bids: [
      { price: "0.48", size: "100" },
      { price: "0.47", size: "100" },
    ],
    asks: [
      { price: "0.52", size: "60" },
      { price: "0.53", size: "100" },
    ],
    tickSize: "0.01",
    takerFeeRate: "0.07",
    minsToCatalyst: null,
    externalFairAgainst: false,
    ...overrides,
  };
}

describe("B1 default passive", () => {
  it("rests post-only at the touch when the edge does not pay the taker fee", () => {
    const result = decideOrderType(context());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orderType).toBe("GTC");
      expect(result.value.limitPrice).toBe("0.480000");
      expect(result.value.postOnly).toBe(true);
      expect(result.value.worstPrice).toBeNull();
      expect(result.value.expectedTakerDelayMs).toBe(0);
      expect(result.value.policyReason).toBe("DEFAULT_PASSIVE_MAKER_FEE_ZERO");
    }
  });

  it("an unknown taker fee disables aggression no matter the edge", () => {
    const result = decideOrderType(
      context({ qLo: "0.99", takerFeeRate: null }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orderType).toBe("GTC");
      expect(result.value.policyReason).toBe(
        "DEFAULT_PASSIVE_TAKER_FEE_UNKNOWN",
      );
    }
  });

  it("a ttl turns the resting order into GTD carrying the ttl", () => {
    const result = decideOrderType(context({ ttlS: 300 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orderType).toBe("GTD");
      expect(result.value.ttlS).toBe(300);
    }
  });
});

describe("B3 taker eligibility", () => {
  it("goes FAK only when q_lo beats the walk worst price by fee + margin", () => {
    // Walk of 50 shares consumes only the 0.52 level: worst = 0.52.
    // fee = 0.07 x 0.52 x 0.48 = 0.0174720; margin 0.01; edge = 0.06.
    const result = decideOrderType(context({ qLo: "0.58" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orderType).toBe("FAK");
      expect(result.value.limitPrice).toBe("0.520000");
      expect(result.value.worstPrice).toBe("0.520000");
      expect(result.value.postOnly).toBe(false);
      expect(result.value.expectedTakerDelayMs).toBe(TAKER_DELAY_MS);
      expect(result.value.policyReason).toBe("TAKER_EDGE_EXCEEDS_FEE");
    }
  });

  it("the worst price comes from walking ALL the size, not the touch", () => {
    // 100 shares cross into the second level: worst = 0.53, never 0.52.
    const result = decideOrderType(context({ qLo: "0.58", size: "100" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orderType).toBe("FAK");
      expect(result.value.worstPrice).toBe("0.530000");
    }
  });

  it("sells aggress only when the walk worst bid clears q_lo by fee + margin", () => {
    const result = decideOrderType(context({ side: "SELL", qLo: "0.40" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orderType).toBe("FAK");
      expect(result.value.worstPrice).toBe("0.480000");
    }
  });

  it("insufficient visible depth keeps the order passive", () => {
    const result = decideOrderType(context({ qLo: "0.99", size: "500" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orderType).toBe("GTC");
      expect(result.value.postOnly).toBe(true);
    }
  });

  it("an edge inside fee + margin stays passive", () => {
    // edge = 0.55 - 0.52 = 0.03; fee + margin = 0.027472 + tiny slack over.
    const result = decideOrderType(context({ qLo: "0.547" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orderType).toBe("GTC");
    }
  });
});

describe("B4 retreat rules are defensive and take precedence", () => {
  it("near a catalyst the quote widens even with a huge edge", () => {
    const result = decideOrderType(
      context({ qLo: "0.99", minsToCatalyst: 10 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orderType).toBe("GTC");
      expect(result.value.limitPrice).toBe("0.460000");
      expect(result.value.postOnly).toBe(true);
      expect(result.value.policyReason).toBe("CATALYST_NEAR_WIDEN");
    }
  });

  it("an external fair moving against the quote widens it, never attacks", () => {
    const result = decideOrderType(
      context({ side: "SELL", qLo: "0.10", externalFairAgainst: true }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orderType).toBe("GTC");
      expect(result.value.limitPrice).toBe("0.540000");
      expect(result.value.policyReason).toBe("EXTERNAL_FAIR_AGAINST_WIDEN");
    }
  });

  it("beyond the threshold the catalyst clock does not widen", () => {
    const result = decideOrderType(context({ minsToCatalyst: 120 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.limitPrice).toBe("0.480000");
      expect(result.value.policyReason).toBe("DEFAULT_PASSIVE_MAKER_FEE_ZERO");
    }
  });
});

describe("hard failures", () => {
  it("a crossed or missing book yields no order at all", () => {
    expect(
      decideOrderType(context({ bids: [{ price: "0.55", size: "10" }] })),
    ).toEqual({ ok: false, reason: "NO_TRADABLE_BOOK" });
    expect(decideOrderType(context({ asks: [] }))).toEqual({
      ok: false,
      reason: "NO_TRADABLE_BOOK",
    });
  });

  it("degenerate q_lo or size yields no order", () => {
    expect(decideOrderType(context({ qLo: "0" }))).toEqual({
      ok: false,
      reason: "INVALID_Q_LO",
    });
    expect(decideOrderType(context({ size: "0" }))).toEqual({
      ok: false,
      reason: "INVALID_SIZE",
    });
  });
});

describe("property: no order without a price limit (RFC-011)", () => {
  it("every decision across the context grid carries a limit price", () => {
    const sides = ["BUY", "SELL"] as const;
    const qLos = ["0.10", "0.30", "0.50", "0.70", "0.90"];
    const sizes = ["1", "50", "100", "500"];
    const catalysts = [null, 5, 60];
    const fees = [null, "0", "0.07"];
    const externals = [false, true];
    let decisions = 0;
    for (const side of sides) {
      for (const qLo of qLos) {
        for (const size of sizes) {
          for (const minsToCatalyst of catalysts) {
            for (const takerFeeRate of fees) {
              for (const externalFairAgainst of externals) {
                const result = decideOrderType(
                  context({
                    side,
                    qLo,
                    size,
                    minsToCatalyst,
                    takerFeeRate,
                    externalFairAgainst,
                  }),
                );
                if (!result.ok) {
                  continue;
                }
                decisions += 1;
                const decision = result.value;
                expect(decision.limitPrice.length).toBeGreaterThan(0);
                expect(Number(decision.limitPrice)).toBeGreaterThan(0);
                if (
                  decision.orderType === "FAK" ||
                  decision.orderType === "FOK"
                ) {
                  expect(decision.worstPrice).not.toBeNull();
                } else {
                  expect(decision.postOnly).toBe(true);
                }
                expect(decision.policyReason.length).toBeGreaterThan(0);
              }
            }
          }
        }
      }
    }
    expect(decisions).toBeGreaterThan(300);
  });
});
