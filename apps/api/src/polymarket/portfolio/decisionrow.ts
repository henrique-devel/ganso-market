// RFC-013 task 7, first half: the ONE place a decision row is built.
//
// The replay requirement ("replay determinístico do log contra dados gravados
// reproduz as mesmas decisões") is only meaningful if the replay and the live
// runner agree on how an evaluation becomes a row. If each built its own row,
// the test would be comparing two implementations of the same mapping and would
// pass or fail on the mapping rather than on the engine.
//
// So there is one builder, used by both. The runner calls it with a fresh
// evaluation; the replay calls it with an evaluation recomputed from the
// persisted inputs, and then diffs the two rows field by field.

import { money } from "./ev.js";
import { exitEvidence, type ExitPlan } from "./exitcycle.js";
import type { Evaluation } from "./engine.js";
import type { DecisionRow } from "./store.js";
import type { DecisionKind, MarketSide } from "./types.js";
import { HOLD_REASON_CODE } from "./exitcycle.js";

/** Provenance the row carries but the engine does not compute. */
export interface DecisionProvenance {
  readonly conditionId: string;
  readonly tokenId: string;
  readonly decisionTs: Date;
  readonly configVersion: string;
  readonly configHash: string;
  readonly factorMapVersion: string;
  readonly ruleVersion: number | null;
  readonly paramVersion: number | null;
  readonly resolutionScoreVersion: string | null;
  readonly resolutionAction: string | null;
  readonly oldestInputTs: Date;
  readonly newestInputTs: Date;
  /** The book excerpt the decision was made against, persisted with it. */
  readonly book: unknown;
  readonly portfolioState: "NORMAL" | "REDUCE_ONLY" | "HALTED";
}

export interface EntryDecisionInput extends DecisionProvenance {
  readonly q: string | null;
  readonly qLo: string | null;
  readonly qHi: string | null;
  readonly estimateSource: "MODEL" | "MARKET_BASELINE" | null;
}

/**
 * The decision kind an evaluation produces.
 *
 * A vetoed market is a VETO; everything else on the entry path is an ENTRY,
 * accepted or rejected. There is no third case, and keeping the mapping in a
 * named function stops the runner and the replay from disagreeing about it.
 */
export function entryDecisionKind(evaluation: Evaluation): DecisionKind {
  return evaluation.vetoed ? "VETO" : "ENTRY";
}

/**
 * The signature of an entry-path verdict: what has to change before the log
 * writes the row again.
 *
 * RFC-018 D1. The RFC-013 task 7 requirement is that every INTENTION persists;
 * the exit cycle was already approved reading that as every DISTINCT intention
 * (`runner.ts`, exit cycle), and this extends the same reading to the entry.
 * Two evaluations with the same signature are the same intention observed
 * twice, and the log keeps the first.
 *
 * The owner's decision (2026-08-27) names the triple verdict + reason code +
 * binding constraint. `kind` is carried too — a market that stops being vetoed
 * and starts being merely rejected changed its verdict — which can only make
 * the rule write MORE often than the decision requires, never less.
 *
 * Derived from the persisted columns, not from a field of its own, so a row
 * written by an earlier revision compares correctly against one written now.
 */
export function entrySignature(row: {
  readonly kind: DecisionKind;
  readonly outcome: string;
  readonly reasonCode: string | null;
  readonly bindingConstraint: string;
}): string {
  return [
    row.kind,
    row.outcome,
    row.reasonCode ?? "-",
    row.bindingConstraint,
  ].join("|");
}

/** Build the decision row for one entry-path evaluation. */
export function entryDecisionRow(input: {
  readonly evaluation: Evaluation;
  readonly context: EntryDecisionInput;
  /** Serialized engine inputs, so the replay does not depend on raw-data TTL. */
  readonly replay: Readonly<Record<string, unknown>>;
}): DecisionRow {
  const { evaluation, context } = input;
  const best = evaluation.best;
  const sizing = evaluation.sizing;
  return {
    kind: entryDecisionKind(evaluation),
    conditionId: context.conditionId,
    tokenId: context.tokenId,
    marketSide: best?.side ?? "YES",
    orderSide: best?.orderSide ?? "BUY",
    decisionTs: context.decisionTs,
    q: context.q,
    qLo: context.qLo,
    qHi: context.qHi,
    estimateSource: context.estimateSource,
    execPrice: best === null ? null : money(best.ev.execPriceScaled),
    worstPrice: best === null ? null : money(best.ev.worstPriceScaled),
    bestPrice: best === null ? null : money(best.ev.bestPriceScaled),
    feeExpected: best === null ? null : money(best.ev.feeScaled),
    slippage: best === null ? null : money(best.ev.slippageScaled),
    capitalCost: best === null ? null : money(best.ev.capitalCostScaled),
    resolutionBuffer:
      best === null ? null : money(best.ev.resolutionBufferScaled),
    costsTotal: best === null ? null : money(best.ev.costsTotalScaled),
    safetyMargin: best === null ? null : money(best.ev.safetyMarginScaled),
    edgeGross: best === null ? null : money(best.ev.edgeGrossScaled),
    edgeNet: best === null ? null : money(best.ev.edgeNetScaled),
    sizeShares: sizing === null ? null : money(sizing.sizeScaled),
    kellyCapShares: sizing === null ? null : money(sizing.kellyCapSharesScaled),
    notionalUsd: sizing === null ? null : money(sizing.notionalScaled),
    bindingConstraint: sizing?.bindingConstraint ?? "NOT_SIZED",
    limiters:
      sizing?.limiters.map((limiter) => ({
        constraint: limiter.constraint,
        max_shares: money(limiter.maxSizeScaled),
        note: limiter.note,
      })) ?? [],
    configVersion: context.configVersion,
    configHash: context.configHash,
    factorMapVersion: context.factorMapVersion,
    ruleVersion: context.ruleVersion,
    paramVersion: context.paramVersion,
    resolutionScoreVersion: context.resolutionScoreVersion,
    resolutionAction: context.resolutionAction,
    oldestInputTs: context.oldestInputTs,
    newestInputTs: context.newestInputTs,
    book: context.book,
    inputs: { panel: evaluation.panel, replay: input.replay },
    outcome: evaluation.entrable ? "ACCEPTED" : "REJECTED",
    reasonCode: evaluation.entrable
      ? null
      : (evaluation.rejectionCode ?? "ESTIMATE_MISSING"),
    portfolioState: context.portfolioState,
  };
}

export interface ExitDecisionInput extends DecisionProvenance {
  /** The leg held; an exit of a YES long is a SELL of that token. */
  readonly side: MarketSide;
  readonly q: string | null;
  readonly qLo: string | null;
  readonly qHi: string | null;
  readonly estimateSource: "MODEL" | "MARKET_BASELINE" | null;
}

/**
 * Build the decision row for one exit evaluation.
 *
 * `ACCEPTED` means an exit intent was emitted; `REJECTED` with
 * HOLD_NO_EXIT_SIGNAL means the position was evaluated and held. Both are
 * recorded, because "we looked and decided to stay" is evidence and its absence
 * would be indistinguishable from never having looked.
 *
 * `limiters_json` is empty for an exit: an exit is not sized by the entry
 * limiters, and reusing the column for something else would make the same field
 * mean two things. The criteria that fired live in `inputs_json.exit.signals`,
 * next to the inputs that produced them.
 */
export function exitDecisionRow(input: {
  readonly plan: ExitPlan;
  readonly context: ExitDecisionInput;
  readonly replay: Readonly<Record<string, unknown>>;
}): DecisionRow {
  const { plan, context } = input;
  const exiting = plan.signals.length > 0;
  return {
    kind: "EXIT",
    conditionId: context.conditionId,
    tokenId: context.tokenId,
    marketSide: context.side,
    // Leaving a long is a sale of the token held, on either leg.
    orderSide: "SELL",
    decisionTs: context.decisionTs,
    q: context.q,
    qLo: context.qLo,
    qHi: context.qHi,
    estimateSource: context.estimateSource,
    execPrice:
      plan.exitPriceScaled === null ? null : money(plan.exitPriceScaled),
    worstPrice: null,
    bestPrice: plan.bestBidScaled === null ? null : money(plan.bestBidScaled),
    feeExpected: null,
    slippage: null,
    capitalCost: null,
    resolutionBuffer: null,
    costsTotal: null,
    safetyMargin: null,
    edgeGross: null,
    edgeNet: plan.edgeAtBidScaled === null ? null : money(plan.edgeAtBidScaled),
    sizeShares: null,
    kellyCapShares: null,
    notionalUsd: null,
    bindingConstraint: "NOT_SIZED",
    limiters: [],
    configVersion: context.configVersion,
    configHash: context.configHash,
    factorMapVersion: context.factorMapVersion,
    ruleVersion: context.ruleVersion,
    paramVersion: context.paramVersion,
    resolutionScoreVersion: context.resolutionScoreVersion,
    resolutionAction: context.resolutionAction,
    oldestInputTs: context.oldestInputTs,
    newestInputTs: context.newestInputTs,
    book: context.book,
    inputs: { exit: exitEvidence(plan), replay: input.replay },
    outcome: exiting ? "ACCEPTED" : "REJECTED",
    reasonCode: exiting ? null : HOLD_REASON_CODE,
    portfolioState: context.portfolioState,
  };
}
