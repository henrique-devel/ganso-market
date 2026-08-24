// RFC-012 tasks 4-9: the composed resolution-risk score R, the deterministic
// score -> action mapping and the resolution_buffer. Pure functions: every
// input is loaded elsewhere (as-of guarded), so the same inputs and the same
// score_version reproduce the same score forever. All features are normalized
// into [0, 1] and the weights sum to 1, which makes R ∈ [0, 1] and monotonic
// in every feature by construction — a riskier input can never lower R.

import type { RulePrecisionResult } from "./lexicon.js";
import type {
  PriorKind,
  ResolutionAction,
  ResolutionHardFlag,
} from "./types.js";
import type { ResolutionConfig } from "./config.js";

export interface MeasuredPriorInput {
  readonly resolved: number;
  readonly disputed: number;
  readonly p5050: number;
}

export interface ScoreInputs {
  readonly conditionId: string;
  readonly category: string | null;
  readonly negRisk: boolean;
  /** Lexicon verdict over the rule as-of the decision instant. */
  readonly precision: RulePrecisionResult | null;
  /** Age of the newest MATERIAL clarification, ms; null when none exists. */
  readonly materialClarificationAgeMs: number | null;
  readonly umaBond: string | null;
  readonly customLivenessS: number | null;
  readonly endDate: Date | null;
  readonly umaEndDate: Date | null;
  /** Latest holders concentration (0..1); null when never sampled. */
  readonly top1Share: number | null;
  /** Latest UMA status at the instant. */
  readonly disputeActive: boolean;
  readonly proposalActive: boolean;
  /** min(p, 1-p) of the recorded executable book while proposed; null = no book. */
  readonly adjudicationPremium: number | null;
  /** Own-pipeline stats of the market's category (task 4). */
  readonly measuredPrior: MeasuredPriorInput | null;
  /** Price jump without catalyst detected by the caller. */
  readonly suspectJump: boolean;
}

export interface FeatureBreakdown {
  readonly value: number;
  readonly weight: number;
  readonly contribution: number;
  readonly note?: string;
}

export interface ComposedScore {
  readonly score: number;
  readonly scoreText: string;
  readonly action: ResolutionAction;
  readonly features: Readonly<Record<string, FeatureBreakdown>>;
  readonly hardFlags: readonly ResolutionHardFlag[];
  readonly priorKind: PriorKind;
  readonly disputeRateUsed: number;
  readonly p5050: number;
  readonly p5050Text: string;
  readonly expectedLockupS: number;
  readonly p95LockupS: number;
  /** Price-independent buffer per share (6-digit decimal string). */
  readonly bufferBase: string;
  readonly justification: string;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function fixed6(value: number): string {
  return (Math.round(clamp01(value) * 1e6) / 1e6).toFixed(6);
}

function categoryKey(category: string | null): "crypto" | "macro" | "default" {
  return category === "crypto" || category === "macro" ? category : "default";
}

/** Dispute prior in use: measured once the category has enough resolutions. */
export function disputePrior(
  category: string | null,
  measured: MeasuredPriorInput | null,
  config: ResolutionConfig,
): { rate: number; kind: PriorKind } {
  if (measured !== null && measured.resolved >= config.priors.measuredMinN) {
    return {
      rate: clamp01(measured.disputed / measured.resolved),
      kind: "measured",
    };
  }
  return {
    rate: config.priors[categoryKey(category)].disputeRate,
    kind: "external",
  };
}

/**
 * Task 6: P(50/50). Structurally zero in negRisk groups (the NegRiskAdapter
 * reverts on a [1, 1] report); otherwise the rule-precision-driven formula
 * until the own-pipeline history is large enough to measure it.
 */
export function estimateP5050(
  inputs: Pick<ScoreInputs, "negRisk" | "precision" | "measuredPrior">,
  config: ResolutionConfig,
): { value: number; kind: PriorKind } {
  if (inputs.negRisk) {
    return { value: 0, kind: "external" };
  }
  const measured = inputs.measuredPrior;
  if (measured !== null && measured.resolved >= config.p5050.measuredMinN) {
    return {
      value: Math.min(measured.p5050 / measured.resolved, config.p5050.cap),
      kind: "measured",
    };
  }
  const precision =
    inputs.precision === null ? 0.5 : Number(inputs.precision.precision);
  const value = Math.min(
    config.p5050.base + config.p5050.precisionMultiplier * (1 - precision),
    config.p5050.cap,
  );
  return { value, kind: "external" };
}

/**
 * Task 5: the bimodal lockup model. Expected lockup = category base median
 * plus the dispute tail weighted by the dispute probability; the P95 is the
 * dispute-conditional tail once a dispute is live, the category tail before.
 */
export function lockupModel(
  category: string | null,
  disputeRate: number,
  disputeActive: boolean,
  config: ResolutionConfig,
): { expectedS: number; p95S: number } {
  const key = categoryKey(category);
  const baseMin = config.lockup.baseMedianMinutes[key];
  const addedMin = disputeActive
    ? config.lockup.disputeAddedMedianMinutes
    : disputeRate * config.lockup.disputeAddedMedianMinutes;
  const p95Min = disputeActive
    ? config.lockup.disputeP95Minutes
    : config.lockup.p95BaseMinutes[key];
  return {
    expectedS: Math.round((baseMin + addedMin) * 60),
    p95S: Math.round(p95Min * 60),
  };
}

/**
 * The price-independent buffer component per share: a linear ramp of R above
 * rBuffer, plus a capital hurdle for the expected lockup. The price-dependent
 * 50/50 tail (p5050 x max(price - 0.5, 0)) is applied at decision time by
 * evaluateBufferAtPrice, because the entry price is only known then.
 */
export function bufferBase(
  score: number,
  expectedLockupS: number,
  config: ResolutionConfig,
): number {
  const { rBuffer } = config.thresholds;
  const ramp =
    score <= rBuffer ? 0 : (score - rBuffer) / Math.max(1 - rBuffer, 1e-9);
  const capital = config.buffer.capitalDailyHurdle * (expectedLockupS / 86_400);
  return clamp01(config.buffer.maxBase * ramp + capital);
}

/**
 * Full buffer at a concrete entry price: base + the 50/50 tail loss. A YES
 * bought at 80¢ pays 50¢ in a P3 — the tail costs p5050 x 30¢ per share; at
 * prices below 50¢ a P3 is not a loss and no credit is taken for the gain
 * (conservative by decision: no "probable refund" style credits).
 */
export function evaluateBufferAtPrice(
  base: number,
  p5050: number,
  price: number,
): number {
  const tail = p5050 * Math.max(price - 0.5, 0);
  return clamp01(base + tail);
}

export function composeScore(
  inputs: ScoreInputs,
  config: ResolutionConfig,
): ComposedScore {
  const notes: string[] = [];
  const hardFlags: ResolutionHardFlag[] = [];

  // 1. Rule precision (task 3). No versioned rule at the instant is itself a
  // risk: nothing verifiable to hold the proposer to.
  let precisionRisk: number;
  if (inputs.precision === null) {
    precisionRisk = 0.7;
    notes.push("rule_missing");
  } else {
    precisionRisk = clamp01(1 - Number(inputs.precision.precision));
    for (const flag of inputs.precision.hardFlags) {
      if (flag === "SUBJECTIVE_SOURCE" || flag === "TITLE_RULE_MISMATCH") {
        hardFlags.push(flag);
      }
    }
  }

  // 2. Dispute prior (task 4) — external until measured n is large enough.
  const prior = disputePrior(inputs.category, inputs.measuredPrior, config);
  const priorValue = clamp01(prior.rate / config.priors.rateCap);

  // 3. Clarification recency (task 2): hard flag inside the window, linear
  // decay to zero afterwards.
  let clarificationValue = 0;
  const age = inputs.materialClarificationAgeMs;
  if (age !== null) {
    const window = config.hardFlags.clarificationWindowMs;
    const decay = config.hardFlags.clarificationDecayMs;
    if (age <= window) {
      clarificationValue = 1;
      hardFlags.push("MATERIAL_CLARIFICATION_24H");
    } else if (age < decay) {
      clarificationValue = clamp01(1 - (age - window) / (decay - window));
    }
  }

  // 4. UMA sensitivity: a bond above the ~US$ 750 baseline is the proposer's
  // own signal of a contentious question; a non-default liveness likewise.
  let bondRisk = 0;
  const baselineBond = Number(config.uma.baselineBond);
  const bond = inputs.umaBond === null ? null : Number(inputs.umaBond);
  if (bond !== null && Number.isFinite(bond) && baselineBond > 0) {
    bondRisk = clamp01(bond / baselineBond - 1);
  }
  let livenessRisk = 0;
  if (
    inputs.customLivenessS !== null &&
    inputs.customLivenessS !== config.uma.baselineLivenessS
  ) {
    livenessRisk = 0.5;
  }
  const umaSensitivity = clamp01(bondRisk + livenessRisk);

  // 5. endDate vs umaEndDate mismatch (task 8): saturates at one day apart.
  let endDateMismatch = 0;
  if (inputs.endDate !== null && inputs.umaEndDate !== null) {
    const deltaMs = Math.abs(
      inputs.endDate.getTime() - inputs.umaEndDate.getTime(),
    );
    endDateMismatch = clamp01(deltaMs / 86_400_000);
  }

  // 6. Holders concentration: >50% of dispute votes sit in 10 wallets; a
  // concentrated market is where that power gets used. Unknown = moderate.
  let holdersValue: number;
  if (inputs.top1Share === null) {
    holdersValue = 0.5;
    notes.push("holders_unknown");
  } else {
    holdersValue = clamp01(inputs.top1Share);
  }

  // 7. P(50/50) (task 6).
  const p5050 = estimateP5050(inputs, config);
  const p5050Value = clamp01(p5050.value / config.p5050.cap);

  // 8. Adjudication premium (task 7): only meaningful in the settlement
  // window; the caller samples it from the recorded executable book.
  let adjudicationValue = 0;
  if (inputs.proposalActive && inputs.adjudicationPremium !== null) {
    adjudicationValue = clamp01(inputs.adjudicationPremium / 0.05);
  }

  const weights = config.weights;
  const features: Record<string, FeatureBreakdown> = {
    rule_precision: {
      value: precisionRisk,
      weight: weights.rulePrecision,
      contribution: precisionRisk * weights.rulePrecision,
    },
    dispute_prior: {
      value: priorValue,
      weight: weights.disputePrior,
      contribution: priorValue * weights.disputePrior,
      note: `${prior.kind}:${prior.rate.toFixed(4)}`,
    },
    clarification: {
      value: clarificationValue,
      weight: weights.clarification,
      contribution: clarificationValue * weights.clarification,
    },
    uma_sensitivity: {
      value: umaSensitivity,
      weight: weights.umaSensitivity,
      contribution: umaSensitivity * weights.umaSensitivity,
    },
    end_date_mismatch: {
      value: endDateMismatch,
      weight: weights.endDateMismatch,
      contribution: endDateMismatch * weights.endDateMismatch,
    },
    holders_concentration: {
      value: holdersValue,
      weight: weights.holdersConcentration,
      contribution: holdersValue * weights.holdersConcentration,
    },
    p_5050: {
      value: p5050Value,
      weight: weights.p5050,
      contribution: p5050Value * weights.p5050,
      note: `${p5050.kind}:${p5050.value.toFixed(4)}`,
    },
    adjudication_premium: {
      value: adjudicationValue,
      weight: weights.adjudicationPremium,
      contribution: adjudicationValue * weights.adjudicationPremium,
    },
  };

  const score = clamp01(
    Object.values(features).reduce((sum, f) => sum + f.contribution, 0),
  );

  const lockup = lockupModel(
    inputs.category,
    prior.rate,
    inputs.disputeActive,
    config,
  );

  // Task 9: deterministic mapping. Dispute (or an unexplained jump) freezes;
  // a hard flag or R >= rVeto vetoes; the middle band pays a buffer.
  let action: ResolutionAction;
  let why: string;
  if (inputs.disputeActive) {
    action = "CIRCUIT_BREAKER";
    why = "disputa UMA ativa";
  } else if (inputs.suspectJump) {
    action = "CIRCUIT_BREAKER";
    why = "salto de preço sem catalisador (modo suspeita)";
  } else if (hardFlags.length > 0) {
    action = "VETO";
    why = `flag dura: ${hardFlags.join(", ")}`;
  } else if (score >= config.thresholds.rVeto) {
    action = "VETO";
    why = `R=${score.toFixed(3)} >= r_veto=${config.thresholds.rVeto}`;
  } else if (score >= config.thresholds.rBuffer) {
    action = "BUFFER";
    why = `R=${score.toFixed(3)} em banda de buffer`;
  } else {
    action = "NONE";
    why = `R=${score.toFixed(3)} abaixo de r_buffer`;
  }

  const dominant = Object.entries(features)
    .sort((a, b) => b[1].contribution - a[1].contribution)
    .slice(0, 2)
    .map(([name, f]) => `${name}=${f.value.toFixed(2)}`)
    .join(", ");
  const justification =
    `${why}; dominantes: ${dominant}` +
    (notes.length > 0 ? `; notas: ${notes.join(", ")}` : "");

  return {
    score,
    scoreText: fixed6(score),
    action,
    features,
    hardFlags,
    priorKind: prior.kind,
    disputeRateUsed: prior.rate,
    p5050: p5050.value,
    p5050Text: fixed6(p5050.value),
    expectedLockupS: lockup.expectedS,
    p95LockupS: lockup.p95S,
    bufferBase: fixed6(bufferBase(score, lockup.expectedS, config)),
    justification,
  };
}
