import { describe, expect, it } from "vitest";

import { parseScaled } from "../../../src/polymarket/fundamental/fixed.js";
import { money } from "../../../src/polymarket/portfolio/ev.js";
import {
  disputeFreeze,
  evaluateExits,
  trinaryValuePerShare,
  type ExitInput,
} from "../../../src/polymarket/portfolio/exits.js";
import { EXIT_REASONS } from "../../../src/polymarket/portfolio/types.js";

function s(value: string): bigint {
  const parsed = parseScaled(value);
  if (parsed === null) {
    throw new Error(`unparseable fixture value: ${value}`);
  }
  return parsed;
}

/** A healthy position: nothing should fire. */
const HEALTHY: ExitInput = {
  side: "YES",
  edgeAtBidScaled: s("0.05"),
  edgeResidualMinScaled: s("0.01"),
  currentProbScaled: s("0.60"),
  entryProbScaled: s("0.60"),
  modelMoveThresholdScaled: s("0.05"),
  invalidationFired: false,
  sourceChanged: false,
  exitDepthScaled: s("500"),
  depthFloorScaled: s("50"),
  rulePrecisionDowngraded: false,
  clarified: false,
  minsToCatalyst: 600,
  catalystBlackoutMin: 30,
  remainingCapitalCostScaled: s("0.001"),
  portfolioState: "NORMAL",
};

function reasons(input: ExitInput): string[] {
  return evaluateExits(input).map((signal) => signal.reason);
}

describe("exit criteria", () => {
  it("fires nothing on a healthy position", () => {
    expect(evaluateExits(HEALTHY)).toEqual([]);
  });

  it("1. exits when the executable BID already captured the advantage", () => {
    expect(reasons({ ...HEALTHY, edgeAtBidScaled: s("0.005") })).toContain(
      "EDGE_CAPTURED_AT_BID",
    );
  });

  it("2. exits when the model left the entry band, in either direction", () => {
    expect(reasons({ ...HEALTHY, currentProbScaled: s("0.50") })).toContain(
      "MODEL_MOVED",
    );
    expect(reasons({ ...HEALTHY, currentProbScaled: s("0.70") })).toContain(
      "MODEL_MOVED",
    );
    // Exactly at the threshold is still inside the band.
    expect(reasons({ ...HEALTHY, currentProbScaled: s("0.65") })).not.toContain(
      "MODEL_MOVED",
    );
  });

  it("3. exits when the invalidation condition fires or the source changes", () => {
    expect(reasons({ ...HEALTHY, invalidationFired: true })).toContain(
      "THESIS_INVALIDATED",
    );
    expect(reasons({ ...HEALTHY, sourceChanged: true })).toContain(
      "THESIS_INVALIDATED",
    );
  });

  it("4. exits when depth, rule precision or a clarification degrades", () => {
    expect(reasons({ ...HEALTHY, exitDepthScaled: s("10") })).toContain(
      "LIQUIDITY_OR_RULE_DEGRADED",
    );
    expect(reasons({ ...HEALTHY, rulePrecisionDowngraded: true })).toContain(
      "LIQUIDITY_OR_RULE_DEGRADED",
    );
    expect(reasons({ ...HEALTHY, clarified: true })).toContain(
      "LIQUIDITY_OR_RULE_DEGRADED",
    );
  });

  it("5. exits inside the catalyst blackout, and not outside it", () => {
    expect(reasons({ ...HEALTHY, minsToCatalyst: 20 })).toContain(
      "CATALYST_BLACKOUT",
    );
    expect(reasons({ ...HEALTHY, minsToCatalyst: 31 })).not.toContain(
      "CATALYST_BLACKOUT",
    );
    // No known catalyst is not the same as a catalyst at time zero.
    expect(reasons({ ...HEALTHY, minsToCatalyst: null })).not.toContain(
      "CATALYST_BLACKOUT",
    );
  });

  it("6. exits when the residual edge stops paying for the remaining lockup", () => {
    expect(
      reasons({ ...HEALTHY, remainingCapitalCostScaled: s("0.08") }),
    ).toContain("LOCKUP_NOT_WORTH_EDGE");
  });

  it("7. exits on any non-NORMAL portfolio state", () => {
    expect(reasons({ ...HEALTHY, portfolioState: "REDUCE_ONLY" })).toContain(
      "PORTFOLIO_LIMIT",
    );
    expect(reasons({ ...HEALTHY, portfolioState: "HALTED" })).toContain(
      "PORTFOLIO_LIMIT",
    );
  });

  it("has a fixture for every reason the type declares", () => {
    // A criterion added to the union without a fixture would ship untested.
    const covered = new Set<string>();
    const cases: Partial<ExitInput>[] = [
      { edgeAtBidScaled: s("0.005") },
      { currentProbScaled: s("0.50") },
      { invalidationFired: true },
      { exitDepthScaled: s("10") },
      { minsToCatalyst: 20 },
      { remainingCapitalCostScaled: s("0.08") },
      { portfolioState: "HALTED" },
    ];
    for (const override of cases) {
      for (const reason of reasons({ ...HEALTHY, ...override })) {
        covered.add(reason);
      }
    }
    expect([...covered].sort()).toEqual([...EXIT_REASONS].sort());
  });

  it("reports EVERY criterion that fires, not just the first", () => {
    const all = reasons({
      ...HEALTHY,
      edgeAtBidScaled: s("0.005"),
      invalidationFired: true,
      portfolioState: "REDUCE_ONLY",
    });
    expect(all).toContain("EDGE_CAPTURED_AT_BID");
    expect(all).toContain("THESIS_INVALIDATED");
    expect(all).toContain("PORTFOLIO_LIMIT");
  });
});

describe("UMA dispute freeze", () => {
  it("freezes on an active dispute and demands the trinary payoff", () => {
    const freeze = disputeFreeze({
      resolutionAction: "NONE",
      disputeActive: true,
    });
    expect(freeze.frozen).toBe(true);
    expect(freeze.requiresTrinaryPayoff).toBe(true);
  });

  it("freezes on the RFC-012 circuit breaker as well", () => {
    expect(
      disputeFreeze({
        resolutionAction: "CIRCUIT_BREAKER",
        disputeActive: false,
      }).frozen,
    ).toBe(true);
  });

  it("freezes on a VETO without demanding the trinary payoff", () => {
    const freeze = disputeFreeze({
      resolutionAction: "VETO",
      disputeActive: false,
    });
    expect(freeze.frozen).toBe(true);
    expect(freeze.requiresTrinaryPayoff).toBe(false);
  });

  it("does not freeze a clean market", () => {
    expect(
      disputeFreeze({ resolutionAction: "BUFFER", disputeActive: false })
        .frozen,
    ).toBe(false);
  });
});

describe("trinary payoff", () => {
  it("collapses to the plain probability when a 50/50 report is impossible", () => {
    // negRisk groups are structurally p50 = 0.
    expect(money(trinaryValuePerShare("YES", s("0.70"), 0n))).toBe("0.700000");
    expect(money(trinaryValuePerShare("NO", s("0.70"), 0n))).toBe("0.300000");
  });

  it("pulls both sides toward 0.50 as the 50/50 probability rises", () => {
    // 0.70 x 0.8 + 0.50 x 0.2 = 0.66
    expect(money(trinaryValuePerShare("YES", s("0.70"), s("0.20")))).toBe(
      "0.660000",
    );
    // A confident NO is hurt by the same tail.
    expect(money(trinaryValuePerShare("NO", s("0.10"), s("0.20")))).toBe(
      "0.820000",
    );
  });

  it("never credits a refund: the only outcomes are 1, 0 and 0.50", () => {
    // At p50 = 1 every share is worth exactly 0.50, whatever the model says.
    expect(money(trinaryValuePerShare("YES", s("0.99"), s("1")))).toBe(
      "0.500000",
    );
    expect(money(trinaryValuePerShare("NO", s("0.01"), s("1")))).toBe(
      "0.500000",
    );
  });
});
