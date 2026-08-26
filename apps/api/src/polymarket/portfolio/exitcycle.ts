// RFC-013 task 5, wired: turning one open paper position plus the data another
// RFC already recorded into the seven-criteria evaluation of exits.ts.
//
// exits.ts is the decision; this file is the wiring. Keeping them apart is not
// ceremony — it is what lets the seven criteria be tested as arithmetic while
// the sizeable, boring job of deciding which recorded number goes into which
// field stays reviewable on its own.
//
// Two things this file exists to make honest:
//
//   * The exit price is a BOOK-WALK down the recorded bids for the WHOLE
//     position, never the best bid and never a mid. Getting out of a real
//     position moves the book, and pretending otherwise is the same optimism
//     the RFC forbids in the entry path.
//   * The invalidation condition is EVALUATED, not read. The entry recorded two
//     numbers — the lower bound below which the thesis stops clearing, and the
//     executable price above which it stops clearing — and this file compares
//     today's book against them. Prose in a panel field is not a monitored
//     condition.
//
// There is still no stop-loss here, and adding one would be a lie about what a
// binary book can do; see docs/architecture/portfolio-engine-scope.md.

import { SCALE } from "../fundamental/fixed.js";
import type { PortfolioConfig } from "./config.js";
import { bookWalk, capitalCostPerShare, depthUpTo, money } from "./ev.js";
import {
  disputeFreeze,
  evaluateExits,
  trinaryValuePerShare,
  type DisputeFreeze,
  type ExitInput,
  type ExitSignal,
} from "./exits.js";
import type {
  BookLevel,
  MarketSide,
  PortfolioStateName,
  ExitReason,
} from "./types.js";

/**
 * The per-day capital hurdle the RFC-012 resolution buffer already charges. The
 * entry path passes the same number for the same reason: charging the whole
 * cost of capital on top of a buffer that already contains part of it would
 * charge one lockup twice. Kept here as a named constant so the two paths
 * cannot drift apart silently.
 */
export const BUFFER_DAILY_HURDLE = 0.0005;

function fractionScaled(value: number): bigint {
  return BigInt(Math.round(value * Number(SCALE)));
}

/** Everything known about one open position and its market, at one instant. */
export interface PositionExitContext {
  readonly tokenId: string;
  readonly conditionId: string;
  /** The economic leg held: the affirmative token is YES, its pair is NO. */
  readonly side: MarketSide;
  readonly sharesScaled: bigint;
  readonly costScaled: bigint;
  readonly openedAt: Date | null;

  /** Provenance of the entry, read back from the decision log. */
  readonly entryDecisionId: number | null;
  readonly entryDecisionTs: Date | null;
  /** The conservative probability the entry was justified on, side-adjusted. */
  readonly entryProbLowerScaled: bigint | null;
  readonly entryRuleVersion: number | null;
  readonly entryResolutionSource: string | null;
  readonly entryRulePrecisionScaled: bigint | null;
  /**
   * The structured invalidation the entry recorded: the level the conservative
   * estimate must stay above. Null when the entry did not record one.
   */
  readonly invalidationProbLowerBelowScaled: bigint | null;

  /** Current RFC-010 estimate, already side-adjusted to the leg held. */
  readonly probLowerScaled: bigint | null;
  /** Current recorded book for the position's own token. */
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
  readonly bookAgeMs: number | null;

  /** Current rule/venue state. */
  readonly ruleVersion: number | null;
  readonly resolutionSource: string | null;
  readonly rulePrecisionScaled: bigint | null;
  /** Instant of the newest MATERIAL clarification, or null. */
  readonly clarifiedAt: Date | null;

  /** Minutes to the next known catalyst; null when none is known. */
  readonly minsToCatalyst: number | null;

  /** RFC-012 state for the market. */
  readonly resolutionAction:
    "NONE" | "BUFFER" | "VETO" | "CIRCUIT_BREAKER" | null;
  readonly disputeActive: boolean;
  readonly p5050Scaled: bigint | null;
  /** Projected REMAINING lockup, in seconds. */
  readonly expectedLockupS: number;

  /** True while a portfolio circuit breaker is open for this position. */
  readonly breakerOpen: boolean;
}

export interface ExitPlan {
  readonly tokenId: string;
  readonly conditionId: string;
  readonly side: MarketSide;
  readonly signals: readonly ExitSignal[];
  readonly freeze: DisputeFreeze;
  /** Volume-weighted executable exit price for the WHOLE position, scaled. */
  readonly exitPriceScaled: bigint | null;
  /** Best bid, for the slippage the unwind would pay. */
  readonly bestBidScaled: bigint | null;
  /** Residual edge at the executable bid, per share, scaled. */
  readonly edgeAtBidScaled: bigint | null;
  /** USD the unwind would give up against the best bid. */
  readonly unwindCostScaled: bigint | null;
  /** Share value under the trinary payoff, when a 50/50 report is possible. */
  readonly trinaryValueScaled: bigint | null;
  /** True when the whole position could not be walked out of the recorded book. */
  readonly bookTooThinToExit: boolean;
  /** Stable fingerprint of the verdict, for change detection. */
  readonly signature: string;
  /** The exact input the seven criteria were evaluated on, for replay. */
  readonly exitInput: ExitInput | null;
  /** Why the plan could not be formed, when it could not. */
  readonly incompleteReason: string | null;
}

/**
 * Fingerprint of a verdict: the sorted reason codes, or `hold` when none fired.
 *
 * Sorted so the same set never produces two fingerprints, which is what makes
 * "did anything change since last cycle?" a string comparison instead of a
 * judgement call.
 */
export function exitSignature(signals: readonly ExitSignal[]): string {
  if (signals.length === 0) {
    return "hold";
  }
  return [...signals.map((signal) => signal.reason)].sort().join("+");
}

/** The reason a held position records when nothing fired. */
export const HOLD_REASON_CODE = "HOLD_NO_EXIT_SIGNAL";

function exitContextIncomplete(context: PositionExitContext): string | null {
  if (context.sharesScaled <= 0n) {
    return "POSITION_EMPTY";
  }
  if (context.bids.length === 0) {
    return "NO_EXIT_BOOK";
  }
  if (context.probLowerScaled === null) {
    return "ESTIMATE_MISSING";
  }
  return null;
}

/**
 * Evaluate the seven exit criteria for one position.
 *
 * A position whose context is incomplete produces NO signals and says why.
 * That matters: inventing an exit because the estimate is missing would be
 * acting on the absence of information, and inventing a hold would be worse.
 * The portfolio-state criterion is the one exception — REDUCE_ONLY and HALTED
 * force reduction whatever the data looks like, so it is evaluated first and
 * survives an incomplete context.
 */
export function planExit(input: {
  readonly context: PositionExitContext;
  readonly config: PortfolioConfig;
  readonly portfolioState: PortfolioStateName;
}): ExitPlan {
  const { context, config, portfolioState } = input;
  const freeze = disputeFreeze({
    resolutionAction: context.resolutionAction ?? "NONE",
    disputeActive: context.disputeActive,
  });
  const trinaryValueScaled =
    context.probLowerScaled === null || context.p5050Scaled === null
      ? null
      : trinaryValuePerShare(
          context.side,
          // The trinary value is quoted on the leg held, and probLowerScaled is
          // already side-adjusted, so YES is the right argument for both legs.
          context.side === "YES"
            ? context.probLowerScaled
            : SCALE - context.probLowerScaled,
          context.p5050Scaled,
        );

  const incompleteReason = exitContextIncomplete(context);
  if (incompleteReason !== null) {
    // Portfolio limits do not need a book to be true.
    const forced: ExitSignal[] =
      portfolioState === "NORMAL"
        ? []
        : [
            {
              reason: "PORTFOLIO_LIMIT" as ExitReason,
              detail: `portfolio state is ${portfolioState}`,
            },
          ];
    return {
      tokenId: context.tokenId,
      conditionId: context.conditionId,
      side: context.side,
      signals: forced,
      freeze,
      exitPriceScaled: null,
      bestBidScaled: null,
      edgeAtBidScaled: null,
      unwindCostScaled: null,
      trinaryValueScaled,
      bookTooThinToExit: incompleteReason === "NO_EXIT_BOOK",
      signature: exitSignature(forced),
      exitInput: null,
      incompleteReason,
    };
  }

  const probLowerScaled = context.probLowerScaled ?? 0n;

  // The exit price is what the recorded bids would actually pay for the WHOLE
  // position, walked best-first. `complete` false means the book cannot absorb
  // the position at all, which is itself the liquidity criterion firing.
  const walk = bookWalk(context.bids, context.sharesScaled);
  const exitPriceScaled = walk?.vwapScaled ?? null;
  const bestBidScaled = walk?.bestScaled ?? null;
  const bookTooThinToExit = walk === null || !walk.complete;

  // Residual edge at the executable bid: what is still left to earn by holding
  // to resolution instead of selling into the book now.
  const edgeAtBidScaled =
    exitPriceScaled === null ? null : probLowerScaled - exitPriceScaled;

  const unwindCostScaled =
    walk === null
      ? null
      : ((walk.bestScaled - walk.vwapScaled) * walk.filledScaled) / SCALE;

  // The FULL cost of the remaining lockup, not the excess over the RFC-012
  // buffer's own daily hurdle.
  //
  // The entry path charges only the excess, and correctly: its net edge already
  // has the resolution buffer subtracted, and the buffer already contains
  // `capitalDailyHurdle x lockupDays`, so charging the whole cost of capital on
  // top would charge one lockup twice. The exit path compares against
  // `edgeAtBid = probLower - exitPrice`, which has NO buffer subtracted — so
  // here the excess would charge nothing at all. With the default parameters it
  // would charge exactly zero forever: the buffer's hurdle of $0.0005/share/day
  // is ~18.3% a year against a `custo_capital_anual` of 12%, so the excess is
  // negative at every price and every lockup, and criterion 6 could never fire.
  const remainingCapitalCostScaled =
    exitPriceScaled === null
      ? 0n
      : capitalCostPerShare({
          priceScaled: exitPriceScaled,
          expectedLockupS: context.expectedLockupS,
          annualRateScaled: fractionScaled(config.costs.capitalCostAnnual),
          bufferDailyHurdleScaled: 0n,
        });

  // The invalidation condition the entry recorded, actually evaluated. It is a
  // condition on the MODEL: the price side of leaving is the residual-edge and
  // depth criteria, and a price threshold here would be a stop by another name.
  const invalidationFired =
    context.invalidationProbLowerBelowScaled !== null &&
    probLowerScaled < context.invalidationProbLowerBelowScaled;

  const sourceChanged =
    (context.entryRuleVersion !== null &&
      context.ruleVersion !== null &&
      context.entryRuleVersion !== context.ruleVersion) ||
    (context.entryResolutionSource !== null &&
      context.resolutionSource !== null &&
      context.entryResolutionSource !== context.resolutionSource);

  const rulePrecisionDowngraded =
    context.entryRulePrecisionScaled !== null &&
    context.rulePrecisionScaled !== null &&
    context.rulePrecisionScaled < context.entryRulePrecisionScaled;

  const since = context.entryDecisionTs ?? context.openedAt;
  const clarified =
    context.clarifiedAt !== null &&
    (since === null || context.clarifiedAt.getTime() > since.getTime());

  // Executable depth on the exit side: every recorded bid level, since selling
  // walks down the book rather than up to a limit.
  const exitDepthScaled = depthUpTo(context.bids, 0n, "bid");

  const exitInput: ExitInput = {
    side: context.side,
    edgeAtBidScaled: edgeAtBidScaled ?? 0n,
    edgeResidualMinScaled: fractionScaled(config.exits.edgeResidualMin),
    currentProbScaled: probLowerScaled,
    // With no recorded entry the move criterion cannot fire on its own; using
    // the current estimate as the entry band makes the difference zero, which
    // is the honest "we do not know that it moved".
    entryProbScaled: context.entryProbLowerScaled ?? probLowerScaled,
    modelMoveThresholdScaled: fractionScaled(config.exits.modelMoveThreshold),
    invalidationFired,
    sourceChanged,
    exitDepthScaled,
    depthFloorScaled: fractionScaled(config.exits.depthFloorShares),
    rulePrecisionDowngraded,
    clarified,
    minsToCatalyst: context.minsToCatalyst,
    catalystBlackoutMin: config.exits.catalystBlackoutMin,
    remainingCapitalCostScaled,
    portfolioState,
  };

  const signals = evaluateExits(exitInput);

  // A book that cannot absorb the position is a liquidity failure even when the
  // depth floor happens to be below the recorded total, so it is added rather
  // than left to the floor comparison.
  const withThinBook: ExitSignal[] = bookTooThinToExit
    ? [
        ...signals.filter(
          (signal) => signal.reason !== "LIQUIDITY_OR_RULE_DEGRADED",
        ),
        {
          reason: "LIQUIDITY_OR_RULE_DEGRADED",
          detail: "o livro gravado não absorve a posição inteira",
        },
      ]
    : signals;

  return {
    tokenId: context.tokenId,
    conditionId: context.conditionId,
    side: context.side,
    signals: withThinBook,
    freeze,
    exitPriceScaled,
    bestBidScaled,
    edgeAtBidScaled,
    unwindCostScaled,
    trinaryValueScaled,
    bookTooThinToExit,
    signature: exitSignature(withThinBook),
    exitInput,
    incompleteReason: null,
  };
}

/**
 * The panel-shaped record of an exit evaluation, for `inputs_json`.
 *
 * The verdict (`ACCEPTED` = exit intent, `REJECTED` = hold) lives in the
 * decision row's own `outcome` column, which the append-only trigger protects.
 * The signal list lives here, next to the inputs that produced it: a replay
 * recomputes the list from those inputs and compares, and the verdict column is
 * the independent check that the list and the decision agree.
 */
export function exitEvidence(plan: ExitPlan): Record<string, unknown> {
  return {
    token_id: plan.tokenId,
    condition_id: plan.conditionId,
    side: plan.side,
    signals: plan.signals.map((signal) => ({
      reason: signal.reason,
      detail: signal.detail,
    })),
    signature: plan.signature,
    frozen: plan.freeze.frozen,
    freeze_reason: plan.freeze.reason,
    requires_trinary_payoff: plan.freeze.requiresTrinaryPayoff,
    exit_price:
      plan.exitPriceScaled === null ? null : money(plan.exitPriceScaled),
    best_bid: plan.bestBidScaled === null ? null : money(plan.bestBidScaled),
    edge_at_bid:
      plan.edgeAtBidScaled === null ? null : money(plan.edgeAtBidScaled),
    unwind_cost:
      plan.unwindCostScaled === null ? null : money(plan.unwindCostScaled),
    trinary_value_per_share:
      plan.trinaryValueScaled === null ? null : money(plan.trinaryValueScaled),
    book_too_thin_to_exit: plan.bookTooThinToExit,
    incomplete_reason: plan.incompleteReason,
    // Stated on every exit record, because an exit is exactly where somebody
    // would want to read a protection that does not exist.
    no_stop_promise:
      "nenhuma saída é garantida por preço: um livro binário pode saltar de " +
      "preço alto para perto de zero sem negociar os níveis intermediários",
  };
}
