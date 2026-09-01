// RFC-017 mode A: counterfactual re-derivation of the decision log under a
// different value of ONE config key.
//
// This is a NEW path deliberately placed next to `replayDecision`, never inside
// it. The audit replay asks "does the recorded config still reproduce the
// recorded decision?" and answers CONFIG_HASH_MISMATCH the moment the parameter
// set in hand is not the one that produced the row — which is exactly right for
// an audit and exactly wrong for a sweep, whose whole purpose is to hold a
// DIFFERENT parameter set. Merging the two would mean weakening the audit's hash
// check to let the sweep through, and that check is the reason the audit means
// anything.
//
// So the sweep calls `replayDecision` first, unchanged, as an ADMISSION TEST:
// only a decision that still reproduces byte for byte under its own recorded
// config is allowed into the sample. Engine drift never becomes signal.
//
// There is no third row builder here either. The re-derivation goes through
// `evaluateMarket` + `entryDecisionRow` (and `planExit` + `exitDecisionRow`),
// the same pair the runner and the audit use.

import {
  parsePortfolioConfig,
  portfolioConfigHash,
  type PortfolioConfig,
} from "./config.js";
import {
  entryDecisionRow,
  exitDecisionRow,
  type EntryDecisionInput,
  type ExitDecisionInput,
} from "./decisionrow.js";
import { evaluateMarket } from "./engine.js";
import { planExit } from "./exitcycle.js";
import {
  deserializeEntryReplay,
  deserializeExitReplay,
  exact,
  replayDecision,
  type PersistedDecision,
} from "./replay.js";
import type { DecisionRow } from "./store.js";

// ---------------------------------------------------------------------------
// Which keys may be swept, and why the others may not.
// ---------------------------------------------------------------------------

/**
 * A key is sweepable if and only if `evaluateMarket` or `planExit` reads it FROM
 * THE CONFIG at decision time.
 *
 * Everything else reaches the replay as a scalar that was already computed
 * upstream — the breaker as `breaker_open`, the loss limits as
 * `portfolio_state`, the caps as `cap_headroom` in dollars, the bankroll as
 * `bankroll`. Swapping such a key in the config recomputes nothing, so the sweep
 * would report "zero decisions changed" and that zero would be an artefact of
 * the tool rather than a fact about the parameter. A vacuous zero that reads
 * like a measured one is worse than a refusal, which is why these are refused
 * by name and with the reason printed.
 */
export const SWEEPABLE_KEYS: readonly string[] = [
  // Entry path (engine.ts).
  "costs.capitalCostAnnual",
  "costs.safetyMarginMin",
  "costs.safetyMarginEdgeFraction",
  "costs.edgeLiqMin",
  "costs.slippageMaxPctEdge",
  "priceBand.minBuy",
  "priceBand.maxBuy",
  "kelly.lambda",
  "kelly.uncertaintyShrinkSlope",
  "depth.takePct",
  "staleness.bookMaxAgeMs",
  "staleness.estimateMaxAgeMs",
  "staleness.resolutionMaxAgeMs",
  // Exit path (exitcycle.ts). capitalCostAnnual appears on both.
  "exits.edgeResidualMin",
  "exits.modelMoveThreshold",
  "exits.depthFloorShares",
  "exits.catalystBlackoutMin",
];

/** Refused keys, each with the reason a sweep of it would be meaningless. */
export const REFUSED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "breakers.jumpThreshold":
    "reaches the replay as the boolean `breaker_open`; the jump was detected " +
    "against book history the replay does not hold",
  "breakers.jumpWindowMs":
    "reaches the replay as the boolean `breaker_open`; the jump was detected " +
    "against book history the replay does not hold",
  "lossLimits.perdaDiariaMax":
    "reaches the replay as `portfolio_state`, decided by the cycle and not by " +
    "the row",
  "lossLimits.perdaSemanalMax":
    "reaches the replay as `portfolio_state`, decided by the cycle and not by " +
    "the row",
  "lossLimits.drawdownMax":
    "reaches the replay as `portfolio_state`, decided by the cycle and not by " +
    "the row",
  "lossLimits.reduceOnlyWeekDays":
    "reaches the replay as `portfolio_state`, decided by the cycle and not by " +
    "the row",
  "caps.entrada": "reaches the replay as `cap_headroom`, already in dollars",
  "caps.mercado": "reaches the replay as `cap_headroom`, already in dollars",
  "caps.grupoCorrelacionado":
    "reaches the replay as `cap_headroom`, already in dollars",
  "caps.categoria": "reaches the replay as `cap_headroom`, already in dollars",
  "caps.fonteResolucao":
    "reaches the replay as `cap_headroom`, already in dollars",
  "caps.catalisadorJanela":
    "reaches the replay as `cap_headroom`, already in dollars",
  "caps.capitalBloqueado":
    "reaches the replay as `cap_headroom`, already in dollars",
  bankrollUsd: "reaches the replay as the `bankroll` scalar",
  "kelly.maxLambda": "read by the gates only, never by the engine",
  "exits.unwindAlarmPctOpenPnl": "an alarm, not a decision input",
  version: "the version name is provenance, not a parameter",
});

export class SweepError extends Error {
  public readonly reasonCode: string;

  public constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "SweepError";
    this.reasonCode = reasonCode;
  }
}

/** Refuse a key that is not sweepable, saying which kind of refusal it is. */
export function assertSweepable(path: string): void {
  if (SWEEPABLE_KEYS.includes(path)) {
    return;
  }
  const refusal = REFUSED_KEYS[path];
  if (refusal !== undefined) {
    throw new SweepError(
      "KEY_NOT_REPLAYABLE",
      `${path} cannot be swept: it ${refusal}. Sweeping it would report zero ` +
        `changes for every candidate, and that zero would say nothing about ` +
        `the parameter.`,
    );
  }
  throw new SweepError(
    "KEY_UNKNOWN",
    `${path} is not a known portfolio config key. Sweepable keys: ` +
      SWEEPABLE_KEYS.join(", "),
  );
}

/**
 * Clone the config with one key replaced, THROUGH the parser.
 *
 * Not a patched object: the config is serialized, the key is swapped in the
 * JSON, and the result goes back through `parsePortfolioConfig`. That buys three
 * refusals a hand-patched object would not have — unknown key, out-of-range
 * value, and the cross-field invariant (`kelly.lambda <= kelly.maxLambda`) that
 * a lambda sweep above 0.5 would otherwise violate in silence.
 */
export function configWithKey(
  config: PortfolioConfig,
  path: string,
  value: number,
): PortfolioConfig {
  assertSweepable(path);
  const raw = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const segments = path.split(".");
  let cursor: Record<string, unknown> = raw;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      throw new SweepError(
        "KEY_UNKNOWN",
        `${path} has no object at ${segment}`,
      );
    }
    cursor = next as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1] as string] = value;
  return parsePortfolioConfig(raw);
}

/** Read the current value of a sweepable key. */
export function configValueAt(config: PortfolioConfig, path: string): number {
  assertSweepable(path);
  const raw = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  let cursor: unknown = raw;
  for (const segment of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) {
      throw new SweepError("KEY_UNKNOWN", `${path} does not resolve`);
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (typeof cursor !== "number") {
    throw new SweepError("KEY_UNKNOWN", `${path} is not a number`);
  }
  return cursor;
}

// ---------------------------------------------------------------------------
// Re-derivation of one decision under one candidate config.
// ---------------------------------------------------------------------------

/** Why a decision was left out of the sample. Every exclusion is counted. */
export type SweepExclusion =
  | "BASELINE_MISMATCH"
  | "NO_REPLAY_BLOCK"
  | "UNSUPPORTED_KIND"
  | "CONFIG_UNAVAILABLE";

/**
 * Signed distance from the entry decision boundary, in price units per share.
 *
 * `clearsEntryCriterion` is `edge_net > safety_margin` and the next rung is
 * `edge_net >= edgeLiqMin`, so the boundary that actually decides is the max of
 * the two. Positive means the row cleared it. This is the ONE continuous
 * quantity a cost-key sweep moves, which is what makes "how much of the slack
 * did the candidate consume" a measurable number rather than a figure of speech.
 *
 * Null for a row that never reached the arithmetic: its verdict was decided
 * before any of this existed, and inventing a distance for it would be inventing
 * a denominator.
 */
export function acceptSlack(
  exact: Pick<ExactValues, "edgeNet" | "safetyMargin">,
  config: PortfolioConfig,
): number | null {
  const { edgeNet, safetyMargin } = exact;
  if (edgeNet === null || safetyMargin === null) {
    return null;
  }
  return edgeNet - Math.max(safetyMargin, config.costs.edgeLiqMin);
}

/** True when the row got past the categorical refusals into the EV math. */
export function reachedArithmetic(row: {
  readonly edgeNet: string | null;
}): boolean {
  return row.edgeNet !== null;
}

/**
 * The engine's own numbers, at WORKING scale.
 *
 * The row carries six decimals, because that is what the columns store. The
 * engine decides at nine. The difference is not academic here: measured on
 * production rows on 2026-09-01, `capitalCostAnnual = 0.183` already flips the
 * chosen leg on 12 of 300 decisions while the recorded `capital_cost` column
 * still reads `0.000000` — the charge that moved them is ~2.5e-7 per share.
 * Deltas computed from the six-decimal strings would report that as no change at
 * all, which is exactly the false zero this tool exists not to produce.
 */
export interface ExactValues {
  readonly edgeNet: number | null;
  readonly costsTotal: number | null;
  readonly capitalCost: number | null;
  readonly safetyMargin: number | null;
  readonly sizeShares: number | null;
}

export interface Rederived {
  readonly row: DecisionRow;
  readonly exact: ExactValues;
}

const NO_EXACT: ExactValues = {
  edgeNet: null,
  costsTotal: null,
  capitalCost: null,
  safetyMargin: null,
  sizeShares: null,
};

/** Nine-digit value of a scaled bigint, as a number. */
function exactNumber(scaled: bigint): number {
  return Number(exact(scaled));
}

/** Re-derive one decision under one config. Returns the row, never persisted. */
export function rederive(input: {
  readonly decision: PersistedDecision;
  readonly config: PortfolioConfig;
}): Rederived | null {
  const { decision, config } = input;
  const inputs = decision.inputs;
  const raw =
    typeof inputs === "object" && inputs !== null && !Array.isArray(inputs)
      ? (inputs as Record<string, unknown>).replay
      : undefined;
  if (raw === undefined) {
    return null;
  }
  const panel =
    typeof inputs === "object" && inputs !== null && !Array.isArray(inputs)
      ? (inputs as Record<string, unknown>).panel
      : undefined;
  const replayBlock =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const provenance = {
    conditionId: decision.conditionId,
    tokenId: decision.tokenId,
    decisionTs: decision.decisionTs,
    configVersion: decision.configVersion,
    configHash: decision.configHash,
    factorMapVersion: decision.factorMapVersion,
    ruleVersion: decision.ruleVersion,
    paramVersion: decision.paramVersion,
    resolutionScoreVersion: decision.resolutionScoreVersion,
    resolutionAction: decision.resolutionAction,
    oldestInputTs: decision.oldestInputTs,
    newestInputTs: decision.newestInputTs,
    book: decision.book,
    portfolioState: decision.portfolioState,
  };

  if (
    decision.decisionKind === "ENTRY" ||
    decision.decisionKind === "VETO" ||
    decision.decisionKind === "RESIZE"
  ) {
    const engineInput = deserializeEntryReplay({
      raw,
      book: decision.book,
      panel,
      config,
      conditionId: decision.conditionId,
      tokenId: decision.tokenId,
      decisionTs: decision.decisionTs,
    });
    if (engineInput === null) {
      return null;
    }
    const context: EntryDecisionInput = {
      ...provenance,
      q: decision.q,
      qLo: decision.qLo,
      qHi: decision.qHi,
      estimateSource: decision.estimateSource,
    };
    const evaluation = evaluateMarket(engineInput);
    const best = evaluation.best;
    const sizing = evaluation.sizing;
    return {
      row: entryDecisionRow({ evaluation, context, replay: replayBlock }),
      exact: {
        edgeNet: best === null ? null : exactNumber(best.ev.edgeNetScaled),
        costsTotal:
          best === null ? null : exactNumber(best.ev.costsTotalScaled),
        capitalCost:
          best === null ? null : exactNumber(best.ev.capitalCostScaled),
        safetyMargin:
          best === null ? null : exactNumber(best.ev.safetyMarginScaled),
        sizeShares: sizing === null ? null : exactNumber(sizing.sizeScaled),
      },
    };
  }

  if (decision.decisionKind === "EXIT") {
    const restored = deserializeExitReplay({
      raw,
      book: decision.book,
      conditionId: decision.conditionId,
      tokenId: decision.tokenId,
    });
    if (restored === null) {
      return null;
    }
    const context: ExitDecisionInput = {
      ...provenance,
      side: restored.context.side,
      q: decision.q,
      qLo: decision.qLo,
      qHi: decision.qHi,
      estimateSource: decision.estimateSource,
    };
    const plan = planExit({
      context: restored.context,
      config,
      portfolioState: restored.portfolioState,
    });
    return {
      row: exitDecisionRow({ plan, context, replay: replayBlock }),
      exact: {
        ...NO_EXACT,
        edgeNet:
          plan.edgeAtBidScaled === null
            ? null
            : exactNumber(plan.edgeAtBidScaled),
      },
    };
  }

  return null;
}

/** What one candidate value did to one decision. */
export interface CandidateOutcome {
  readonly value: number;
  readonly outcome: string;
  readonly reasonCode: string | null;
  readonly bindingConstraint: string;
  readonly marketSide: string;
  /**
   * ACCEPTED <-> REJECTED. The headline: would the engine have ACTED differently.
   */
  readonly outcomeChanged: boolean;
  /**
   * The recorded reason moved while the action did not.
   *
   * Measured on production rows, this is not a hypothetical: at r >= 0.20 the
   * capital charge, being proportional to price, breaks the exact tie between
   * the two legs (`q_lo - ask_yes` and `(1 - q_hi) - ask_no` coincide on a
   * complementary book) in favour of the cheap one, and a rejection recorded as
   * LOWER_BOUND_BELOW_COSTS on YES at 0.93 becomes PRICE_OUT_OF_BAND on NO at
   * 0.08. Nothing became entrable. Reporting that as "the verdict changed" would
   * inflate the parameter's apparent bite by an order of magnitude.
   */
  readonly reasonChanged: boolean;
  /** The chosen leg flipped — the mechanism behind most `reasonChanged`. */
  readonly sideChanged: boolean;
  readonly bindingChanged: boolean;
  /** Deltas against the baseline re-derivation, in price units per share. */
  readonly deltaEdgeNet: number | null;
  readonly deltaCostsTotal: number | null;
  readonly deltaCapitalCost: number | null;
  /** Size delta in shares; null when either side was not sized. */
  readonly deltaSizeShares: number | null;
  readonly acceptSlack: number | null;
  readonly deltaAcceptSlack: number | null;
  /** |delta slack| / |baseline slack|; null when the baseline slack is zero. */
  readonly slackConsumed: number | null;
  /**
   * True when the capital charge went from zero to positive at WORKING scale.
   *
   * Working scale, not the six-decimal column: at r = 0.183 the charge that
   * flips a leg is ~2.5e-7 per share, which the recorded `capital_cost` column
   * still prints as `0.000000`.
   */
  readonly capitalCostBecamePositive: boolean;
}

export interface DecisionSweep {
  readonly decisionId: number;
  readonly conditionId: string;
  readonly kind: string;
  readonly reachedArithmetic: boolean;
  readonly baselineOutcome: string;
  readonly baselineReason: string | null;
  readonly baselineBinding: string;
  readonly baselineSide: string;
  readonly baselineAcceptSlack: number | null;
  readonly candidates: readonly CandidateOutcome[];
}

/**
 * Sweep one decision across candidate values.
 *
 * Step 1 is the admission test: `replayDecision` with the RECORDED config must
 * return MATCHED. A mismatch is excluded and counted rather than swept, because
 * a row the engine no longer reproduces cannot tell us anything about a
 * parameter — the difference we would measure could be the drift rather than the
 * candidate.
 */
export function sweepDecision(input: {
  readonly decision: PersistedDecision;
  readonly config: PortfolioConfig;
  readonly path: string;
  readonly values: readonly number[];
}): DecisionSweep | SweepExclusion {
  const { decision, config, path, values } = input;

  const admission = replayDecision({ decision, config });
  if (!admission.matched) {
    return admission.failure === "NO_REPLAY_BLOCK"
      ? "NO_REPLAY_BLOCK"
      : admission.failure === "UNSUPPORTED_KIND"
        ? "UNSUPPORTED_KIND"
        : "BASELINE_MISMATCH";
  }

  const rebuilt = rederive({ decision, config });
  if (rebuilt === null) {
    return "NO_REPLAY_BLOCK";
  }
  const baseline = rebuilt.row;
  const baselineSlack = acceptSlack(rebuilt.exact, config);
  const baselineEdge = rebuilt.exact.edgeNet;
  const baselineCosts = rebuilt.exact.costsTotal;
  const baselineCapital = rebuilt.exact.capitalCost;
  const baselineSize = rebuilt.exact.sizeShares;

  const candidates: CandidateOutcome[] = [];
  for (const value of values) {
    const candidateConfig = configWithKey(config, path, value);
    const rederived = rederive({ decision, config: candidateConfig });
    if (rederived === null) {
      return "NO_REPLAY_BLOCK";
    }
    const row = rederived.row;
    const slack = acceptSlack(rederived.exact, candidateConfig);
    const edge = rederived.exact.edgeNet;
    const costs = rederived.exact.costsTotal;
    const capital = rederived.exact.capitalCost;
    const size = rederived.exact.sizeShares;
    const deltaSlack =
      slack === null || baselineSlack === null ? null : slack - baselineSlack;
    candidates.push({
      value,
      outcome: row.outcome,
      reasonCode: row.reasonCode,
      bindingConstraint: row.bindingConstraint,
      marketSide: row.marketSide,
      outcomeChanged: row.outcome !== baseline.outcome,
      reasonChanged: row.reasonCode !== baseline.reasonCode,
      sideChanged: row.marketSide !== baseline.marketSide,
      bindingChanged: row.bindingConstraint !== baseline.bindingConstraint,
      deltaEdgeNet:
        edge === null || baselineEdge === null ? null : edge - baselineEdge,
      deltaCostsTotal:
        costs === null || baselineCosts === null ? null : costs - baselineCosts,
      deltaCapitalCost:
        capital === null || baselineCapital === null
          ? null
          : capital - baselineCapital,
      deltaSizeShares:
        size === null || baselineSize === null ? null : size - baselineSize,
      acceptSlack: slack,
      deltaAcceptSlack: deltaSlack,
      slackConsumed:
        deltaSlack === null || baselineSlack === null || baselineSlack === 0
          ? null
          : Math.abs(deltaSlack) / Math.abs(baselineSlack),
      capitalCostBecamePositive:
        baselineCapital === 0 && capital !== null && capital > 0,
    });
  }

  return {
    decisionId: decision.decisionId,
    conditionId: decision.conditionId,
    kind: decision.decisionKind,
    reachedArithmetic: reachedArithmetic(baseline),
    baselineOutcome: baseline.outcome,
    baselineReason: baseline.reasonCode,
    baselineBinding: baseline.bindingConstraint,
    baselineSide: baseline.marketSide,
    baselineAcceptSlack: baselineSlack,
    candidates,
  };
}

// ---------------------------------------------------------------------------
// Aggregation, weighted BOTH ways.
// ---------------------------------------------------------------------------

/**
 * Per-candidate totals, counted by line AND by distinct market.
 *
 * The log writes one row per market per cycle, so a market that lived through
 * the whole window contributes ~1300 rows and one that appeared for three
 * minutes contributes 3. Measured on this window: 65 markets in the reachable
 * population, the largest holding 6.8% of the rows and the smallest 0.001%. A
 * single per-line percentage would be a statement about market longevity wearing
 * the name of a statement about the parameter.
 */
export interface CandidateTotals {
  readonly value: number;
  /** ACCEPTED <-> REJECTED: the number that answers "would it have acted". */
  readonly linesOutcomeChanged: number;
  readonly marketsOutcomeChanged: number;
  /** The recorded reason moved while the action did not. */
  readonly linesReasonChanged: number;
  readonly marketsReasonChanged: number;
  readonly linesSideChanged: number;
  readonly linesBindingChanged: number;
  readonly marketsBindingChanged: number;
  readonly capitalCostBecamePositive: number;
  /** Transitions `from -> to`, by count, for the reasons that moved. */
  readonly verdictTransitions: Readonly<Record<string, number>>;
  readonly bindingTransitions: Readonly<Record<string, number>>;
  readonly medianDeltaEdgeNet: number | null;
  readonly p90AbsDeltaEdgeNet: number | null;
  readonly medianDeltaSizeShares: number | null;
  readonly p90AbsDeltaSizeShares: number | null;
  /** Margin metrics: the honest headline when nothing flips. */
  readonly maxSlackConsumed: number | null;
  readonly medianSlackConsumed: number | null;
  readonly minAbsAcceptSlack: number | null;
}

export interface SweepTotals {
  readonly path: string;
  readonly recordedValue: number | null;
  readonly decisionsSeen: number;
  readonly decisionsAdmitted: number;
  readonly decisionsReachingArithmetic: number;
  readonly marketsSeen: number;
  readonly marketsAdmitted: number;
  readonly marketsReachingArithmetic: number;
  readonly exclusions: Readonly<Record<SweepExclusion, number>>;
  readonly baselineOutcomes: Readonly<Record<string, number>>;
  readonly candidates: readonly CandidateTotals[];
}

function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}

/** Streaming accumulator: only aggregates survive a batch, never the rows. */
export class SweepAccumulator {
  private readonly path: string;
  private readonly recordedValue: number | null;
  private readonly values: readonly number[];

  private seen = 0;
  private admitted = 0;
  private reaching = 0;
  private readonly marketsSeen = new Set<string>();
  private readonly marketsAdmitted = new Set<string>();
  private readonly marketsReaching = new Set<string>();
  private readonly exclusions: Record<SweepExclusion, number> = {
    BASELINE_MISMATCH: 0,
    NO_REPLAY_BLOCK: 0,
    UNSUPPORTED_KIND: 0,
    CONFIG_UNAVAILABLE: 0,
  };
  private readonly baselineOutcomes: Record<string, number> = {};

  private readonly linesOutcome: number[];
  private readonly linesReason: number[];
  private readonly linesSide: number[];
  private readonly linesBinding: number[];
  private readonly capitalPositive: number[];
  private readonly marketsOutcome: Set<string>[];
  private readonly marketsReason: Set<string>[];
  private readonly marketsBinding: Set<string>[];
  private readonly verdictTransitions: Record<string, number>[];
  private readonly bindingTransitions: Record<string, number>[];
  private readonly deltaEdge: number[][];
  private readonly deltaSize: number[][];
  private readonly slackConsumed: number[][];
  private readonly absSlack: number[][];

  public constructor(input: {
    readonly path: string;
    readonly recordedValue: number | null;
    readonly values: readonly number[];
  }) {
    this.path = input.path;
    this.recordedValue = input.recordedValue;
    this.values = input.values;
    const n = input.values.length;
    this.linesOutcome = Array.from({ length: n }, () => 0);
    this.linesReason = Array.from({ length: n }, () => 0);
    this.linesSide = Array.from({ length: n }, () => 0);
    this.linesBinding = Array.from({ length: n }, () => 0);
    this.capitalPositive = Array.from({ length: n }, () => 0);
    this.marketsOutcome = Array.from({ length: n }, () => new Set<string>());
    this.marketsReason = Array.from({ length: n }, () => new Set<string>());
    this.marketsBinding = Array.from({ length: n }, () => new Set<string>());
    this.verdictTransitions = Array.from(
      { length: n },
      () => ({}) as Record<string, number>,
    );
    this.bindingTransitions = Array.from(
      { length: n },
      () => ({}) as Record<string, number>,
    );
    this.deltaEdge = Array.from({ length: n }, () => []);
    this.deltaSize = Array.from({ length: n }, () => []);
    this.slackConsumed = Array.from({ length: n }, () => []);
    this.absSlack = Array.from({ length: n }, () => []);
  }

  public excluded(conditionId: string, reason: SweepExclusion): void {
    this.seen += 1;
    this.marketsSeen.add(conditionId);
    this.exclusions[reason] += 1;
  }

  public add(sweep: DecisionSweep): void {
    this.seen += 1;
    this.admitted += 1;
    this.marketsSeen.add(sweep.conditionId);
    this.marketsAdmitted.add(sweep.conditionId);
    const baselineKey = `${sweep.baselineOutcome}:${sweep.baselineReason ?? "-"}`;
    this.baselineOutcomes[baselineKey] =
      (this.baselineOutcomes[baselineKey] ?? 0) + 1;
    if (sweep.reachedArithmetic) {
      this.reaching += 1;
      this.marketsReaching.add(sweep.conditionId);
    }
    sweep.candidates.forEach((candidate, index) => {
      if (candidate.outcomeChanged) {
        this.linesOutcome[index] = (this.linesOutcome[index] ?? 0) + 1;
        this.marketsOutcome[index]?.add(sweep.conditionId);
      }
      if (candidate.sideChanged) {
        this.linesSide[index] = (this.linesSide[index] ?? 0) + 1;
      }
      if (candidate.outcomeChanged || candidate.reasonChanged) {
        this.linesReason[index] = (this.linesReason[index] ?? 0) + 1;
        this.marketsReason[index]?.add(sweep.conditionId);
        const key =
          `${sweep.baselineSide}/${baselineKey} -> ` +
          `${candidate.marketSide}/${candidate.outcome}:${candidate.reasonCode ?? "-"}`;
        const bucket = this.verdictTransitions[index];
        if (bucket !== undefined) {
          bucket[key] = (bucket[key] ?? 0) + 1;
        }
      }
      if (candidate.bindingChanged) {
        this.linesBinding[index] = (this.linesBinding[index] ?? 0) + 1;
        this.marketsBinding[index]?.add(sweep.conditionId);
        const key = `${sweep.baselineBinding} -> ${candidate.bindingConstraint}`;
        const bucket = this.bindingTransitions[index];
        if (bucket !== undefined) {
          bucket[key] = (bucket[key] ?? 0) + 1;
        }
      }
      if (candidate.capitalCostBecamePositive) {
        this.capitalPositive[index] = (this.capitalPositive[index] ?? 0) + 1;
      }
      if (candidate.deltaEdgeNet !== null) {
        this.deltaEdge[index]?.push(candidate.deltaEdgeNet);
      }
      if (candidate.deltaSizeShares !== null) {
        this.deltaSize[index]?.push(candidate.deltaSizeShares);
      }
      if (candidate.slackConsumed !== null) {
        this.slackConsumed[index]?.push(candidate.slackConsumed);
      }
      if (candidate.acceptSlack !== null) {
        this.absSlack[index]?.push(Math.abs(candidate.acceptSlack));
      }
    });
  }

  public totals(): SweepTotals {
    const candidates: CandidateTotals[] = this.values.map((value, index) => {
      const edges = [...(this.deltaEdge[index] ?? [])].sort((a, b) => a - b);
      const edgesAbs = edges.map(Math.abs).sort((a, b) => a - b);
      const sizes = [...(this.deltaSize[index] ?? [])].sort((a, b) => a - b);
      const sizesAbs = sizes.map(Math.abs).sort((a, b) => a - b);
      const consumed = [...(this.slackConsumed[index] ?? [])].sort(
        (a, b) => a - b,
      );
      const slack = [...(this.absSlack[index] ?? [])].sort((a, b) => a - b);
      return {
        value,
        linesOutcomeChanged: this.linesOutcome[index] ?? 0,
        marketsOutcomeChanged: this.marketsOutcome[index]?.size ?? 0,
        linesReasonChanged: this.linesReason[index] ?? 0,
        marketsReasonChanged: this.marketsReason[index]?.size ?? 0,
        linesSideChanged: this.linesSide[index] ?? 0,
        linesBindingChanged: this.linesBinding[index] ?? 0,
        marketsBindingChanged: this.marketsBinding[index]?.size ?? 0,
        capitalCostBecamePositive: this.capitalPositive[index] ?? 0,
        verdictTransitions: this.verdictTransitions[index] ?? {},
        bindingTransitions: this.bindingTransitions[index] ?? {},
        medianDeltaEdgeNet: quantile(edges, 0.5),
        p90AbsDeltaEdgeNet: quantile(edgesAbs, 0.9),
        medianDeltaSizeShares: quantile(sizes, 0.5),
        p90AbsDeltaSizeShares: quantile(sizesAbs, 0.9),
        maxSlackConsumed:
          consumed.length === 0
            ? null
            : (consumed[consumed.length - 1] ?? null),
        medianSlackConsumed: quantile(consumed, 0.5),
        minAbsAcceptSlack: slack.length === 0 ? null : (slack[0] ?? null),
      };
    });
    return {
      path: this.path,
      recordedValue: this.recordedValue,
      decisionsSeen: this.seen,
      decisionsAdmitted: this.admitted,
      decisionsReachingArithmetic: this.reaching,
      marketsSeen: this.marketsSeen.size,
      marketsAdmitted: this.marketsAdmitted.size,
      marketsReachingArithmetic: this.marketsReaching.size,
      exclusions: { ...this.exclusions },
      baselineOutcomes: { ...this.baselineOutcomes },
      candidates,
    };
  }
}

// ---------------------------------------------------------------------------
// The breakeven value: what turns a zero into a number.
// ---------------------------------------------------------------------------

export interface Breakeven {
  readonly decisionId: number;
  /** The value at which the verdict changes, confirmed by re-derivation. */
  readonly value: number;
  readonly fromOutcome: string;
  readonly toOutcome: string;
  readonly bracketLow: number;
  readonly bracketHigh: number;
}

/**
 * The value of `path` at which this decision's verdict changes.
 *
 * Found by scanning a geometric ladder across the bracket for the first pair
 * whose verdicts differ, then bisecting inside that pair. The limitation is
 * stated rather than hidden: this finds A crossing on a fixed grid, and cannot
 * prove it is the only one — a crossing narrower than the grid step is missed.
 * The value returned is always confirmed by re-deriving at it.
 *
 * This is what converts "zero decisions changed at every candidate" from a fact
 * about the tool into a fact about the parameter: it answers "how far away was
 * the nearest change" in the units of the key itself.
 */
export function breakevenValue(input: {
  readonly decision: PersistedDecision;
  readonly config: PortfolioConfig;
  readonly path: string;
  readonly bracketLow: number;
  readonly bracketHigh: number;
  readonly steps?: number;
  readonly tolerance?: number;
}): Breakeven | null {
  const { decision, config, path, bracketLow, bracketHigh } = input;
  const steps = input.steps ?? 64;
  const tolerance = input.tolerance ?? 1e-6;

  const verdictAt = (value: number): string | null => {
    let candidateConfig: PortfolioConfig;
    try {
      candidateConfig = configWithKey(config, path, value);
    } catch {
      // Out of the parser's range: not a usable point on the ladder.
      return null;
    }
    const rederived = rederive({ decision, config: candidateConfig });
    return rederived === null
      ? null
      : `${rederived.row.marketSide}/${rederived.row.outcome}:${rederived.row.reasonCode ?? "-"}`;
  };

  if (!(bracketHigh > bracketLow)) {
    // A ladder that does not climb would walk downwards and report a crossing
    // on the wrong side of the recorded value.
    return null;
  }
  const base = verdictAt(bracketLow);
  if (base === null) {
    return null;
  }
  // Geometric ladder so a bracket spanning several orders of magnitude is
  // scanned with even resolution in ratio rather than in absolute value.
  const low = Math.max(bracketLow, tolerance);
  const ratio = Math.pow(bracketHigh / low, 1 / steps);
  let previousValue = bracketLow;
  let previousVerdict = base;
  for (let step = 1; step <= steps; step += 1) {
    const value = low * Math.pow(ratio, step);
    const verdict = verdictAt(value);
    if (verdict === null) {
      continue;
    }
    if (verdict !== previousVerdict) {
      let lo = previousValue;
      let hi = value;
      for (let iteration = 0; iteration < 60; iteration += 1) {
        if (hi - lo <= tolerance) {
          break;
        }
        const mid = (lo + hi) / 2;
        const midVerdict = verdictAt(mid);
        if (midVerdict === null || midVerdict === previousVerdict) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      const confirmed = verdictAt(hi);
      if (confirmed === null || confirmed === previousVerdict) {
        return null;
      }
      return {
        decisionId: decision.decisionId,
        value: hi,
        fromOutcome: previousVerdict,
        toOutcome: confirmed,
        bracketLow,
        bracketHigh,
      };
    }
    previousValue = value;
    previousVerdict = verdict;
  }
  return null;
}

/** The recorded config hash, re-exported so the CLI can print provenance. */
export function configHashOf(config: PortfolioConfig): string {
  return portfolioConfigHash(config);
}

/** Parse a `--values` list, rejecting anything that is not a finite number. */
export function parseValues(raw: string): number[] {
  const values = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const parsed = Number.parseFloat(part);
      if (!Number.isFinite(parsed)) {
        throw new SweepError("INVALID_VALUE", `${part} is not a finite number`);
      }
      return parsed;
    });
  if (values.length === 0) {
    throw new SweepError("INVALID_VALUE", "--values must list at least one");
  }
  return values;
}
