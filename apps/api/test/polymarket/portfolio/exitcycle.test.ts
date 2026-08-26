// RFC-013 task 5, wired: the exit cycle over a real position context.
//
// exits.test.ts already proves each of the seven criteria as arithmetic. What is
// tested here is the WIRING — that the right recorded number reaches the right
// field — plus the two properties the shadow measurement depends on: the exit
// price is a book-walk over the whole position, and the verdict has a stable
// signature so the log records a change rather than a heartbeat.
//
// No test here asserts a stop-loss, because there is none: every exit is a
// re-evaluation of the thesis or a portfolio state that forces reduction.

import { describe, expect, it } from "vitest";

import { parseScaled } from "../../../src/polymarket/fundamental/fixed.js";
import { DEFAULT_PORTFOLIO_CONFIG } from "../../../src/polymarket/portfolio/config.js";
import {
  exitEvidence,
  exitSignature,
  planExit,
  type PositionExitContext,
} from "../../../src/polymarket/portfolio/exitcycle.js";
import { EXIT_REASONS } from "../../../src/polymarket/portfolio/types.js";

const CONFIG = DEFAULT_PORTFOLIO_CONFIG;

function s(value: string): bigint {
  const parsed = parseScaled(value);
  if (parsed === null) {
    throw new Error(`unparseable fixture value: ${value}`);
  }
  return parsed;
}

/** A held YES position with a healthy thesis and a book deep enough to leave. */
const HELD: PositionExitContext = {
  tokenId: "t1",
  conditionId: "0xa",
  side: "YES",
  sharesScaled: s("100"),
  costScaled: s("50"),
  openedAt: new Date("2026-08-25T12:00:00Z"),
  entryDecisionId: 41,
  entryDecisionTs: new Date("2026-08-25T12:00:00Z"),
  entryProbLowerScaled: s("0.650000"),
  entryRuleVersion: 3,
  entryResolutionSource: "UMA:0xadapter",
  entryRulePrecisionScaled: s("0.900000"),
  invalidationProbLowerBelowScaled: s("0.520000"),
  probLowerScaled: s("0.660000"),
  bids: [
    { price: "0.61", size: "80" },
    { price: "0.60", size: "400" },
  ],
  asks: [{ price: "0.62", size: "300" }],
  bookAgeMs: 2_000,
  ruleVersion: 3,
  resolutionSource: "UMA:0xadapter",
  rulePrecisionScaled: s("0.900000"),
  clarifiedAt: null,
  minsToCatalyst: 600,
  resolutionAction: "NONE",
  disputeActive: false,
  p5050Scaled: s("0.010000"),
  expectedLockupS: 3_600,
  breakerOpen: false,
};

function reasons(
  overrides: Partial<PositionExitContext> = {},
  portfolioState: "NORMAL" | "REDUCE_ONLY" | "HALTED" = "NORMAL",
): string[] {
  return planExit({
    context: { ...HELD, ...overrides },
    config: CONFIG,
    portfolioState,
  }).signals.map((signal) => signal.reason);
}

describe("exit price and unwind cost", () => {
  it("walks the WHOLE position down the bids, never the best bid", () => {
    // 80 shares at 0.61 and 20 at 0.60 -> 0.608 average, not 0.61. Getting out
    // of a real position moves the book.
    const plan = planExit({
      context: HELD,
      config: CONFIG,
      portfolioState: "NORMAL",
    });
    expect(plan.bestBidScaled).toBe(s("0.61"));
    expect(plan.exitPriceScaled).toBe(s("0.608"));
    // The unwind gives up (0.61 - 0.608) x 100 = $0.20 against the best bid.
    expect(plan.unwindCostScaled).toBe(s("0.2"));
    expect(plan.bookTooThinToExit).toBe(false);
  });

  it("residual edge is measured at the executable bid", () => {
    const plan = planExit({
      context: HELD,
      config: CONFIG,
      portfolioState: "NORMAL",
    });
    // 0.660000 - 0.608 = 0.052
    expect(plan.edgeAtBidScaled).toBe(s("0.052"));
    expect(plan.signals).toEqual([]);
  });

  it("a book that cannot absorb the position is a liquidity failure", () => {
    // Even when the recorded depth clears the floor, a book that cannot take
    // the position out is not a book you can leave through.
    const plan = planExit({
      context: {
        ...HELD,
        sharesScaled: s("1000"),
        bids: [{ price: "0.61", size: "60" }],
      },
      config: CONFIG,
      portfolioState: "NORMAL",
    });
    expect(plan.bookTooThinToExit).toBe(true);
    expect(plan.signals.map((signal) => signal.reason)).toContain(
      "LIQUIDITY_OR_RULE_DEGRADED",
    );
  });
});

describe("wiring of the seven criteria", () => {
  it("EDGE_CAPTURED_AT_BID when the bid has taken the advantage", () => {
    expect(
      reasons({
        bids: [
          { price: "0.659", size: "500" },
          { price: "0.658", size: "500" },
        ],
      }),
    ).toContain("EDGE_CAPTURED_AT_BID");
  });

  it("MODEL_MOVED when the estimate left the entry band", () => {
    expect(reasons({ probLowerScaled: s("0.500000") })).toContain(
      "MODEL_MOVED",
    );
  });

  it("THESIS_INVALIDATED when the entry's recorded level is breached", () => {
    // The entry recorded 0.520000; the estimate is now below it.
    const fired = reasons({ probLowerScaled: s("0.510000") });
    expect(fired).toContain("THESIS_INVALIDATED");
  });

  it("THESIS_INVALIDATED when the rule version changed since entry", () => {
    expect(reasons({ ruleVersion: 4 })).toContain("THESIS_INVALIDATED");
  });

  it("does NOT invalidate on favourable movement", () => {
    // A rising ask means the market moved toward the thesis. A condition that
    // fired on that would be reading good news as bad.
    expect(reasons({ asks: [{ price: "0.90", size: "300" }] })).not.toContain(
      "THESIS_INVALIDATED",
    );
  });

  it("LIQUIDITY_OR_RULE_DEGRADED on a downgraded rule-precision score", () => {
    expect(reasons({ rulePrecisionScaled: s("0.400000") })).toContain(
      "LIQUIDITY_OR_RULE_DEGRADED",
    );
  });

  it("LIQUIDITY_OR_RULE_DEGRADED on a clarification landed since entry", () => {
    expect(
      reasons({ clarifiedAt: new Date("2026-08-26T00:00:00Z") }),
    ).toContain("LIQUIDITY_OR_RULE_DEGRADED");
  });

  it("ignores a clarification that predates the entry", () => {
    expect(
      reasons({ clarifiedAt: new Date("2026-08-01T00:00:00Z") }),
    ).not.toContain("LIQUIDITY_OR_RULE_DEGRADED");
  });

  it("CATALYST_BLACKOUT inside the window before a known catalyst", () => {
    expect(reasons({ minsToCatalyst: 10 })).toContain("CATALYST_BLACKOUT");
  });

  it("LOCKUP_NOT_WORTH_EDGE when the remaining lockup costs more than the edge", () => {
    // A six-month projected lockup against a residual edge of half a cent.
    expect(
      reasons({
        expectedLockupS: 180 * 86_400,
        bids: [
          { price: "0.655", size: "500" },
          { price: "0.654", size: "500" },
        ],
      }),
    ).toContain("LOCKUP_NOT_WORTH_EDGE");
  });

  it("PORTFOLIO_LIMIT in REDUCE_ONLY and in HALTED, regardless of the thesis", () => {
    expect(reasons({}, "REDUCE_ONLY")).toContain("PORTFOLIO_LIMIT");
    expect(reasons({}, "HALTED")).toContain("PORTFOLIO_LIMIT");
  });

  it("has a fixture for EVERY exit reason the type declares", () => {
    const fired = new Set<string>([
      ...reasons({
        bids: [
          { price: "0.659", size: "500" },
          { price: "0.658", size: "500" },
        ],
      }),
      ...reasons({ probLowerScaled: s("0.510000") }),
      ...reasons({ ruleVersion: 4 }),
      ...reasons({ rulePrecisionScaled: s("0.400000") }),
      ...reasons({ minsToCatalyst: 10 }),
      ...reasons({
        expectedLockupS: 180 * 86_400,
        bids: [
          { price: "0.655", size: "500" },
          { price: "0.654", size: "500" },
        ],
      }),
      ...reasons({}, "HALTED"),
    ]);
    for (const reason of EXIT_REASONS) {
      expect(fired.has(reason), `no fixture fires ${reason}`).toBe(true);
    }
  });
});

describe("incomplete context", () => {
  it("produces no thesis signal when the estimate is missing", () => {
    // Acting on the absence of information would be inventing a decision.
    const plan = planExit({
      context: { ...HELD, probLowerScaled: null },
      config: CONFIG,
      portfolioState: "NORMAL",
    });
    expect(plan.signals).toEqual([]);
    expect(plan.incompleteReason).toBe("ESTIMATE_MISSING");
    expect(plan.exitInput).toBeNull();
  });

  it("still forces reduction in REDUCE_ONLY with no book at all", () => {
    // The portfolio limit does not need a book to be true.
    const plan = planExit({
      context: { ...HELD, bids: [], asks: [] },
      config: CONFIG,
      portfolioState: "REDUCE_ONLY",
    });
    expect(plan.incompleteReason).toBe("NO_EXIT_BOOK");
    expect(plan.signals.map((signal) => signal.reason)).toEqual([
      "PORTFOLIO_LIMIT",
    ]);
  });
});

describe("dispute freeze and the trinary payoff", () => {
  it("freezes a disputed market and requires the trinary payoff", () => {
    const plan = planExit({
      context: { ...HELD, disputeActive: true },
      config: CONFIG,
      portfolioState: "NORMAL",
    });
    expect(plan.freeze.frozen).toBe(true);
    expect(plan.freeze.requiresTrinaryPayoff).toBe(true);
    expect(plan.trinaryValueScaled).not.toBeNull();
  });

  it("never credits a refund: at p50 = 1 a share is worth exactly 0.50", () => {
    const plan = planExit({
      context: { ...HELD, disputeActive: true, p5050Scaled: s("1") },
      config: CONFIG,
      portfolioState: "NORMAL",
    });
    expect(plan.trinaryValueScaled).toBe(s("0.5"));
  });

  it("records the absence of any price guarantee on every evaluation", () => {
    const plan = planExit({
      context: HELD,
      config: CONFIG,
      portfolioState: "NORMAL",
    });
    const evidence = exitEvidence(plan);
    expect(String(evidence.no_stop_promise)).toContain("saltar de");
  });
});

describe("verdict signature", () => {
  it("is `hold` when nothing fired", () => {
    expect(exitSignature([])).toBe("hold");
  });

  it("does not depend on the order the criteria were evaluated in", () => {
    // The signature is what "did the verdict change since last cycle?" compares,
    // so the same set must never produce two fingerprints.
    const a = exitSignature([
      { reason: "MODEL_MOVED", detail: "" },
      { reason: "CATALYST_BLACKOUT", detail: "" },
    ]);
    const b = exitSignature([
      { reason: "CATALYST_BLACKOUT", detail: "" },
      { reason: "MODEL_MOVED", detail: "" },
    ]);
    expect(a).toBe(b);
  });

  it("changes when the set changes", () => {
    const held = planExit({
      context: HELD,
      config: CONFIG,
      portfolioState: "NORMAL",
    });
    const moved = planExit({
      context: { ...HELD, probLowerScaled: s("0.500000") },
      config: CONFIG,
      portfolioState: "NORMAL",
    });
    expect(held.signature).toBe("hold");
    expect(moved.signature).not.toBe(held.signature);
  });
});
