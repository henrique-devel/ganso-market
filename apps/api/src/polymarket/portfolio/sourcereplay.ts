// RFC-017 mode B: "what if the source had been the shadow?"
//
// Structurally different from mode A, and the difference is declared in the
// output rather than left for the reader to infer. Mode A reads only
// `portfolio_decisions` and `portfolio_config_versions`, so it stays valid after
// the raw-data TTL has pruned everything else — it is an audit. Mode B reads
// `fundamental_estimates` and `fundamental_labels`, so it is an OFFLINE ANALYSIS
// whose window is bounded by what those tables still hold.
//
// Three honesty rules, each of which exists because breaking it would manufacture
// a result:
//
//   1. No shadow row at the instant -> the decision is EXCLUDED and counted.
//      Never interpolate, never reach past the estimate staleness TTL for an
//      older row: the engine itself would have refused that row as DATA_STALE.
//   2. Strict as-of. Only `decision_ts <= the decision's instant` is eligible.
//      A later estimate is knowledge the decision did not have.
//   3. A decision whose recorded source was ALREADY a shadow row is EXCLUDED and
//      counted. Measured 2026-09-01: `estimateAsOf` has no status filter and no
//      tiebreak, and two production decisions already carry a shadow model's
//      numbers. Comparing shadow against shadow and calling it a counterfactual
//      would be inventing the answer.
//
// The counterfactual PnL is labelled hypothetical and feeds the promotion
// decision; it does not replace it. The RFC-010 gate stays sovereign.

import type { PersistedDecision } from "./replay.js";

/** One shadow estimate, as-of an instant. */
export interface ShadowEstimate {
  readonly q: string;
  readonly qLo: string;
  readonly qHi: string;
  readonly modelId: string;
  readonly decisionTs: Date;
}

/** Why a decision was left out of the mode B sample. Every one is counted. */
export type SourceExclusion =
  | "BASELINE_MISMATCH"
  | "NO_REPLAY_BLOCK"
  | "SHADOW_MISSING"
  | "SHADOW_STALE"
  | "BASELINE_ALREADY_SHADOW"
  | "UNSUPPORTED_KIND";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Swap ONLY the estimate into a replay block.
 *
 * Five fields move: the three probabilities, the source label, and the age. The
 * age matters and is easy to get wrong — the engine refuses an estimate older
 * than `staleness.estimateMaxAgeMs`, so carrying the baseline's age over would
 * let a stale shadow row through a gate the live engine would have closed. It is
 * recomputed from the shadow row's own instant.
 *
 * Everything else — the book, the resolution state, the caps, the bankroll — is
 * left exactly as recorded. The question is what a different SOURCE would have
 * done to the same decision, not what a different world would have done.
 */
export function substituteEstimate(input: {
  readonly replay: unknown;
  readonly shadow: ShadowEstimate;
  readonly decisionTs: Date;
}): Record<string, unknown> | null {
  if (!isRecord(input.replay)) {
    return null;
  }
  const ageMs = input.decisionTs.getTime() - input.shadow.decisionTs.getTime();
  if (ageMs < 0) {
    // A shadow row stamped after the decision is look-ahead. The caller is
    // supposed to have filtered it out; refusing here as well means a future
    // caller cannot reintroduce the bug quietly.
    return null;
  }
  return {
    ...input.replay,
    q: input.shadow.q,
    q_lo: input.shadow.qLo,
    q_hi: input.shadow.qHi,
    estimate_source: "MODEL",
    estimate_age_ms: ageMs,
  };
}

/**
 * A decision rebuilt so the re-derivation reads the shadow estimate.
 *
 * The `q`/`q_lo`/`q_hi` COLUMNS move too, not just the replay block. They are
 * what `entryDecisionRow` copies into the row, so leaving them at the baseline
 * would produce a row whose columns and whose arithmetic disagree about which
 * estimate produced it.
 */
export function decisionWithShadow(input: {
  readonly decision: PersistedDecision;
  readonly shadow: ShadowEstimate;
}): PersistedDecision | null {
  const { decision, shadow } = input;
  const inputs = decision.inputs;
  if (!isRecord(inputs)) {
    return null;
  }
  const replay = substituteEstimate({
    replay: inputs.replay,
    shadow,
    decisionTs: decision.decisionTs,
  });
  if (replay === null) {
    return null;
  }
  return {
    ...decision,
    q: shadow.q,
    qLo: shadow.qLo,
    qHi: shadow.qHi,
    estimateSource: "MODEL",
    inputs: { ...inputs, replay },
  };
}

/**
 * Was this decision's recorded estimate itself a shadow row?
 *
 * `estimate_source = 'MODEL'` with no promoted model is the fingerprint of the
 * leak measured on 2026-09-01. The caller passes whether any model was active in
 * the window; when none was, a MODEL-sourced decision cannot be a legitimate
 * consumer row.
 */
export function baselineIsShadow(input: {
  readonly decision: PersistedDecision;
  readonly anyModelPromoted: boolean;
}): boolean {
  return input.decision.estimateSource === "MODEL" && !input.anyModelPromoted;
}

// ---------------------------------------------------------------------------
// Counterfactual PnL.
// ---------------------------------------------------------------------------

/** A final outcome, as `fundamental_labels` records it. */
export interface Label {
  readonly tokenId: string;
  /** "0", "0.5" or "1" — the payout per share of the YES token. */
  readonly label: string;
  readonly isFinal: boolean;
}

/** One entry the shadow would have taken, priced for settlement. */
export interface CounterfactualEntry {
  readonly decisionId: number;
  readonly conditionId: string;
  readonly tokenId: string;
  readonly marketSide: "YES" | "NO";
  /** Executable entry price per share, from the re-derived evaluation. */
  readonly execPrice: number;
  /** The engine's own total cost per share for this entry. */
  readonly costsTotal: number;
  readonly sizeShares: number;
}

export interface CounterfactualPnl {
  readonly entriesConsidered: number;
  readonly entriesSettled: number;
  readonly entriesWithoutFinalLabel: number;
  /** Sum over settled entries, in USD. Hypothetical by construction. */
  readonly grossUsd: number;
  readonly costsUsd: number;
  readonly degradationUsd: number;
  readonly netUsd: number;
  readonly wins: number;
  readonly losses: number;
  readonly halves: number;
}

/**
 * Settle the shadow's entries against the final labels.
 *
 * The payout of the leg held: a YES share pays the label, a NO share pays its
 * complement. A "0.5" label pays half to both, which is what a 50/50 UMA
 * resolution actually does.
 *
 * Costs are the engine's OWN decomposition for that entry (fee, slippage,
 * capital, resolution buffer — whatever `computeEv` charged under the shadow
 * estimate), plus the ledger's conservative degradation: one tick per share, the
 * `BASE_SLIPPAGE_FALLBACK` of the paper report's base column. Using the engine's
 * costs and then a second, more optimistic degradation would be quoting the
 * conservative ledger's name over an optimistic number.
 */
export function counterfactualPnl(input: {
  readonly entries: readonly CounterfactualEntry[];
  readonly labels: ReadonlyMap<string, Label>;
  readonly degradationPerShare: number;
}): CounterfactualPnl {
  let grossUsd = 0;
  let costsUsd = 0;
  let degradationUsd = 0;
  let settled = 0;
  let missing = 0;
  let wins = 0;
  let losses = 0;
  let halves = 0;

  for (const entry of input.entries) {
    const label = input.labels.get(entry.tokenId);
    if (label === undefined || !label.isFinal) {
      missing += 1;
      continue;
    }
    const yesPayout = Number.parseFloat(label.label);
    if (!Number.isFinite(yesPayout)) {
      missing += 1;
      continue;
    }
    const payout = entry.marketSide === "YES" ? yesPayout : 1 - yesPayout;
    settled += 1;
    if (payout > 0.5) {
      wins += 1;
    } else if (payout < 0.5) {
      losses += 1;
    } else {
      halves += 1;
    }
    grossUsd += (payout - entry.execPrice) * entry.sizeShares;
    costsUsd += entry.costsTotal * entry.sizeShares;
    degradationUsd += input.degradationPerShare * entry.sizeShares;
  }

  return {
    entriesConsidered: input.entries.length,
    entriesSettled: settled,
    entriesWithoutFinalLabel: missing,
    grossUsd,
    costsUsd,
    degradationUsd,
    netUsd: grossUsd - costsUsd - degradationUsd,
    wins,
    losses,
    halves,
  };
}

// ---------------------------------------------------------------------------
// Aggregation.
// ---------------------------------------------------------------------------

export interface SourceReplayTotals {
  readonly decisionsSeen: number;
  readonly decisionsAdmitted: number;
  /**
   * Admitted rows that actually reached the estimate.
   *
   * A VETO refused at the resolution layer replays fine and finds its shadow
   * row, but no estimate on earth could have changed it. Counting it as "the
   * shadow changed nothing" would pad the denominator with rows the question
   * never applied to — the same vacuous zero mode A refuses.
   */
  readonly decisionsReachingEstimate: number;
  readonly marketsSeen: number;
  readonly marketsAdmitted: number;
  readonly marketsReachingEstimate: number;
  readonly exclusions: Readonly<Record<SourceExclusion, number>>;
  /** ACCEPTED <-> REJECTED: would the engine have ACTED differently. */
  readonly linesOutcomeChanged: number;
  readonly marketsOutcomeChanged: number;
  /**
   * The recorded reason moved while the action did not.
   *
   * Kept apart from the outcome for the reason mode A's sweep made concrete: a
   * change of chosen leg rewrites the reason and the side of a rejection that
   * stays a rejection, and folding the two together inflates the apparent bite.
   */
  readonly linesReasonChanged: number;
  readonly marketsReasonChanged: number;
  readonly verdictTransitions: Readonly<Record<string, number>>;
  readonly baselineAccepted: number;
  readonly shadowAccepted: number;
  readonly shadowOnlyAccepted: number;
  readonly baselineOnlyAccepted: number;
  /** The window the sample actually covered, not the window requested. */
  readonly coveredFrom: string | null;
  readonly coveredTo: string | null;
  readonly modelIds: readonly string[];
}

/** Streaming accumulator; only aggregates survive a batch. */
export class SourceReplayAccumulator {
  private seen = 0;
  private admitted = 0;
  private reaching = 0;
  private linesOutcomeChanged = 0;
  private linesReasonChanged = 0;
  private baselineAccepted = 0;
  private shadowAccepted = 0;
  private shadowOnly = 0;
  private baselineOnly = 0;
  private coveredFrom: Date | null = null;
  private coveredTo: Date | null = null;
  private readonly marketsSeen = new Set<string>();
  private readonly marketsAdmitted = new Set<string>();
  private readonly marketsReaching = new Set<string>();
  private readonly marketsOutcomeChanged = new Set<string>();
  private readonly marketsReasonChanged = new Set<string>();
  private readonly modelIds = new Set<string>();
  private readonly transitions: Record<string, number> = {};
  private readonly exclusions: Record<SourceExclusion, number> = {
    BASELINE_MISMATCH: 0,
    NO_REPLAY_BLOCK: 0,
    SHADOW_MISSING: 0,
    SHADOW_STALE: 0,
    BASELINE_ALREADY_SHADOW: 0,
    UNSUPPORTED_KIND: 0,
  };

  public excluded(conditionId: string, reason: SourceExclusion): void {
    this.seen += 1;
    this.marketsSeen.add(conditionId);
    this.exclusions[reason] += 1;
  }

  public add(input: {
    readonly conditionId: string;
    readonly decisionTs: Date;
    readonly modelId: string;
    readonly baselineOutcome: string;
    readonly baselineReason: string | null;
    readonly shadowOutcome: string;
    readonly shadowReason: string | null;
    /** True when the baseline row got as far as reading the estimate. */
    readonly reachedEstimate: boolean;
  }): void {
    this.seen += 1;
    this.admitted += 1;
    this.marketsSeen.add(input.conditionId);
    this.marketsAdmitted.add(input.conditionId);
    if (input.reachedEstimate) {
      this.reaching += 1;
      this.marketsReaching.add(input.conditionId);
    }
    this.modelIds.add(input.modelId);
    if (this.coveredFrom === null || input.decisionTs < this.coveredFrom) {
      this.coveredFrom = input.decisionTs;
    }
    if (this.coveredTo === null || input.decisionTs > this.coveredTo) {
      this.coveredTo = input.decisionTs;
    }
    const baseKey = `${input.baselineOutcome}:${input.baselineReason ?? "-"}`;
    const shadowKey = `${input.shadowOutcome}:${input.shadowReason ?? "-"}`;
    const baseAccepted = input.baselineOutcome === "ACCEPTED";
    const shadowAccepted = input.shadowOutcome === "ACCEPTED";
    if (baseAccepted) {
      this.baselineAccepted += 1;
    }
    if (shadowAccepted) {
      this.shadowAccepted += 1;
    }
    if (shadowAccepted && !baseAccepted) {
      this.shadowOnly += 1;
    }
    if (baseAccepted && !shadowAccepted) {
      this.baselineOnly += 1;
    }
    if (baseAccepted !== shadowAccepted) {
      this.linesOutcomeChanged += 1;
      this.marketsOutcomeChanged.add(input.conditionId);
    }
    if (baseKey !== shadowKey) {
      this.linesReasonChanged += 1;
      this.marketsReasonChanged.add(input.conditionId);
      const key = `${baseKey} -> ${shadowKey}`;
      this.transitions[key] = (this.transitions[key] ?? 0) + 1;
    }
  }

  public totals(): SourceReplayTotals {
    return {
      decisionsSeen: this.seen,
      decisionsAdmitted: this.admitted,
      decisionsReachingEstimate: this.reaching,
      marketsSeen: this.marketsSeen.size,
      marketsAdmitted: this.marketsAdmitted.size,
      marketsReachingEstimate: this.marketsReaching.size,
      exclusions: { ...this.exclusions },
      linesOutcomeChanged: this.linesOutcomeChanged,
      marketsOutcomeChanged: this.marketsOutcomeChanged.size,
      linesReasonChanged: this.linesReasonChanged,
      marketsReasonChanged: this.marketsReasonChanged.size,
      verdictTransitions: { ...this.transitions },
      baselineAccepted: this.baselineAccepted,
      shadowAccepted: this.shadowAccepted,
      shadowOnlyAccepted: this.shadowOnly,
      baselineOnlyAccepted: this.baselineOnly,
      coveredFrom: this.coveredFrom?.toISOString() ?? null,
      coveredTo: this.coveredTo?.toISOString() ?? null,
      modelIds: [...this.modelIds].sort(),
    };
  }
}
