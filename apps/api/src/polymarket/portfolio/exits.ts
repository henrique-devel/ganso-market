// RFC-013 task 5: the seven exit criteria of the owner's plan.
//
// NONE of them is a stop-loss, and the distinction is not pedantic. A stop-loss
// promises a price: "if it falls to X, I am out at X". A binary book can gap
// from a high price to near zero without trading the levels in between, so that
// promise cannot be kept and the engine must not make it. What follows are
// re-evaluations of the THESIS — the reason the position was opened — plus the
// portfolio-level states that force reduction regardless of any thesis.
//
// The engine sizes for total loss instead of pretending an exit order protects
// the position; see docs/architecture/portfolio-engine-scope.md.

import { SCALE } from "../fundamental/fixed.js";
import type { ExitReason, MarketSide } from "./types.js";

export interface ExitSignal {
  readonly reason: ExitReason;
  /** Human-readable, for the panel and the decision log. */
  readonly detail: string;
}

export interface ExitInput {
  readonly side: MarketSide;
  /** Residual edge available at the EXECUTABLE bid, per share, scaled. */
  readonly edgeAtBidScaled: bigint;
  /** Threshold below which the bid has already captured the advantage. */
  readonly edgeResidualMinScaled: bigint;

  /** Current model estimate for the position's side, scaled. */
  readonly currentProbScaled: bigint;
  /** The estimate that justified the entry, scaled. */
  readonly entryProbScaled: bigint;
  readonly modelMoveThresholdScaled: bigint;

  /** True once the invalidation condition recorded at entry has fired. */
  readonly invalidationFired: boolean;
  /** True when the resolution source or rule changed since entry. */
  readonly sourceChanged: boolean;

  /** Executable depth on the exit side, in shares, scaled. */
  readonly exitDepthScaled: bigint;
  readonly depthFloorScaled: bigint;
  /** True when the RFC-012 rule-precision score was downgraded since entry. */
  readonly rulePrecisionDowngraded: boolean;
  /** True when a clarification landed since entry. */
  readonly clarified: boolean;

  /** Minutes to the next known catalyst; null when none is known. */
  readonly minsToCatalyst: number | null;
  readonly catalystBlackoutMin: number;

  /** Cost of capital for the REMAINING projected lockup, per share, scaled. */
  readonly remainingCapitalCostScaled: bigint;

  /** Portfolio state forces reduction regardless of any thesis. */
  readonly portfolioState: "NORMAL" | "REDUCE_ONLY" | "HALTED";
}

function absDiff(a: bigint, b: bigint): bigint {
  return a >= b ? a - b : b - a;
}

/**
 * Evaluate all seven criteria and return every one that fires.
 *
 * They are returned as a list, not as a single winner: a position can be
 * exiting for more than one reason, and the panel showing only the first would
 * hide the others from whoever reviews the decision.
 */
export function evaluateExits(input: ExitInput): ExitSignal[] {
  const signals: ExitSignal[] = [];

  // 1. The executable bid already captures most of the advantage. Note this
  //    reads the BID, not the mid: what someone will actually pay.
  if (input.edgeAtBidScaled < input.edgeResidualMinScaled) {
    signals.push({
      reason: "EDGE_CAPTURED_AT_BID",
      detail: "residual edge at the executable bid is below the minimum",
    });
  }

  // 2. The model moved out of the band the entry was based on.
  const move = absDiff(input.currentProbScaled, input.entryProbScaled);
  if (move > input.modelMoveThresholdScaled) {
    signals.push({
      reason: "MODEL_MOVED",
      detail: "the model estimate left the entry band",
    });
  }

  // 3. The thesis or its source was invalidated.
  if (input.invalidationFired || input.sourceChanged) {
    signals.push({
      reason: "THESIS_INVALIDATED",
      detail: input.invalidationFired
        ? "the invalidation condition recorded at entry fired"
        : "the resolution source or rule changed since entry",
    });
  }

  // 4. Liquidity or the rule deteriorated.
  if (
    input.exitDepthScaled < input.depthFloorScaled ||
    input.rulePrecisionDowngraded ||
    input.clarified
  ) {
    signals.push({
      reason: "LIQUIDITY_OR_RULE_DEGRADED",
      detail:
        input.exitDepthScaled < input.depthFloorScaled
          ? "executable exit depth fell below the floor"
          : input.rulePrecisionDowngraded
            ? "the rule-precision score was downgraded"
            : "a clarification landed on the rule",
    });
  }

  // 5. A catalyst the model does not cover is approaching (Glosten-Milgrom:
  //    the informed side arrives first, so the spread should widen or the
  //    position should leave before the release, not after).
  if (
    input.minsToCatalyst !== null &&
    input.minsToCatalyst <= input.catalystBlackoutMin
  ) {
    signals.push({
      reason: "CATALYST_BLACKOUT",
      detail: "a catalyst not covered by the model is inside the blackout",
    });
  }

  // 6. The locked capital stopped paying for itself.
  if (input.edgeAtBidScaled < input.remainingCapitalCostScaled) {
    signals.push({
      reason: "LOCKUP_NOT_WORTH_EDGE",
      detail: "residual edge no longer covers the cost of the remaining lockup",
    });
  }

  // 7. Portfolio limits. Independent of any thesis, and not overridable.
  if (input.portfolioState !== "NORMAL") {
    signals.push({
      reason: "PORTFOLIO_LIMIT",
      detail: `portfolio state is ${input.portfolioState}`,
    });
  }

  return signals;
}

export interface DisputeFreezeInput {
  /** RFC-012 effective action for the market. */
  readonly resolutionAction: "NONE" | "BUFFER" | "VETO" | "CIRCUIT_BREAKER";
  readonly disputeActive: boolean;
}

export interface DisputeFreeze {
  /** True while the position may not be increased under any circumstance. */
  readonly frozen: boolean;
  /**
   * True when the decision to hold or leave must be taken on the TRINARY
   * payoff — never on an assumption of refund.
   */
  readonly requiresTrinaryPayoff: boolean;
  readonly reason: string | null;
}

/**
 * A market in UMA dispute is frozen: never increase.
 *
 * The RFC is emphatic about why, and the precedents are expensive:
 * Ukraine-minerals (~US$ 7M), Zelensky suit (~US$ 160–237M), Strategy/BTC
 * (~US$ 60M). None of them refunded. So the hold-vs-leave decision is taken on
 * the trinary payoff — YES pays 1, NO pays 0, a 50/50 report pays 0.50 to each
 * side — and never on "it will probably be reverted".
 */
export function disputeFreeze(input: DisputeFreezeInput): DisputeFreeze {
  if (input.disputeActive || input.resolutionAction === "CIRCUIT_BREAKER") {
    return {
      frozen: true,
      requiresTrinaryPayoff: true,
      reason: "uma_dispute_active",
    };
  }
  if (input.resolutionAction === "VETO") {
    return {
      frozen: true,
      requiresTrinaryPayoff: false,
      reason: "resolution_veto",
    };
  }
  return { frozen: false, requiresTrinaryPayoff: false, reason: null };
}

/**
 * Value of one share under the trinary payoff, at a given probability of a
 * 50/50 report.
 *
 *   E[YES] = q x (1 - p50) + 0.50 x p50
 *
 * No credit is taken anywhere for a hypothetical refund: the possible outcomes
 * are 1, 0 and 0.50, and nothing else.
 */
export function trinaryValuePerShare(
  side: MarketSide,
  probYesScaled: bigint,
  p5050Scaled: bigint,
): bigint {
  const half = SCALE / 2n;
  const win = side === "YES" ? probYesScaled : SCALE - probYesScaled;
  const notFifty = SCALE - p5050Scaled;
  return (win * notFifty + half * p5050Scaled) / SCALE;
}
