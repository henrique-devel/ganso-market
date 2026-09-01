// RFC-010 shared contracts for the fundamental model. This module produces
// ESTIMATES ONLY: there is no order, signal, wallet or trading-auth type here,
// and none may be added (see docs/architecture/fundamental-model-scope.md).
//
// Probabilities cross every boundary as canonical fixed-scale decimal strings
// (exactly six fraction digits) so a stored estimate is byte-reproducible.

import type { PriceLevel } from "../types.js";

/** Every model belongs to exactly one category. There is no universal model. */
export type FundamentalCategory = "crypto_updown" | "macro_scheduled";

export const FUNDAMENTAL_CATEGORIES: readonly FundamentalCategory[] = [
  "crypto_updown",
  "macro_scheduled",
];

export type EstimateSource = "MODEL" | "MARKET_BASELINE";
export type EstimateStatus = "shadow" | "active";
export type ModelStatus = "shadow" | "active" | "retired";

/** Canonical decimal string with exactly six fraction digits. */
export type ProbabilityString = string;

/**
 * Hard regime boundary: the CLOB V2 cutover. No training or calibration set
 * may straddle it without an explicit `regime_mix` flag, and a regime-mixed
 * model is never promotable.
 */
export const REGIME_V2_CUTOVER = new Date("2026-04-28T00:00:00.000Z");

/** Executable book view at one instant, straight from the recorded raw book. */
export interface BookView {
  readonly tokenId: string;
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
  /** Venue clock of the book state, when the source provided one. */
  readonly sourceTs: Date | null;
  /** Local clock of the newest input that produced this view. */
  readonly observedAt: Date;
}

export type BookInvalidReason =
  | "NO_BOOK"
  | "BOOK_STALE"
  | "SPREAD_TOO_WIDE"
  | "DEPTH_BELOW_SREF"
  | "BOOK_CROSSED";

/**
 * Executable microprice and the quantities behind it. Every field is exact
 * fixed-point at `SCALE` (nine fraction digits); nothing here is a float.
 */
export interface Microprice {
  /** Depth-weighted executable mid, in [0, 1]. */
  readonly micropriceScaled: bigint;
  /** VWAP of selling `sRefScaled` of notional into the bids. */
  readonly bidExecScaled: bigint;
  /** VWAP of buying `sRefScaled` of notional from the asks. */
  readonly askExecScaled: bigint;
  /** askExec - bidExec, the executable spread at the reference size. */
  readonly execSpreadScaled: bigint;
  /** Total top-of-book bid notional in USD. */
  readonly bidNotionalScaled: bigint;
  /** Total top-of-book ask notional in USD. */
  readonly askNotionalScaled: bigint;
  /** Age of the book view at the decision instant, in milliseconds. */
  readonly bookAgeMs: number;
  /** Reference size in USD notional. */
  readonly sRefScaled: bigint;
  readonly version: string;
}

export type MicropriceResult =
  | { readonly ok: true; readonly value: Microprice }
  | { readonly ok: false; readonly reason: BookInvalidReason };

/** Staleness/quality flags carried by every emitted estimate. */
export interface EstimateFlags {
  readonly bookStale: boolean;
  readonly feedStale: boolean;
  readonly thinBook: boolean;
  readonly ruleChangedRecently: boolean;
}

/** Complete provenance of one estimate; incomplete provenance is a bug. */
export interface EstimateProvenance {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly featureSetVersion: string;
  readonly gitSha: string;
}

/**
 * source_ts of every input window that fed an estimate. Only `source_ts` is
 * ever recorded here: joins are as-of the emitter clock, never as-of the local
 * ingestion clock.
 */
export interface DataRefs {
  readonly bookSourceTs: string | null;
  readonly bookObservedAt: string;
  readonly feedSourceTs?: string | null;
  readonly feedSymbol?: string;
  readonly feedName?: string;
  readonly calendarSourceTs?: string | null;
  readonly releaseSourceTs?: string | null;
  readonly ruleVersion?: number | null;
  readonly paramVersion?: number | null;
  readonly windowFrom?: string | null;
  readonly windowTo?: string | null;
  readonly sampleCount?: number;
  readonly [key: string]: unknown;
}

/** One row of `fundamental_estimates`, before it is written. */
export interface Estimate {
  readonly marketId: string;
  readonly tokenId: string;
  /**
   * The market's category as recorded, not necessarily a modelled one: every
   * token of the universe with a valid book gets a baseline estimate, even when
   * no model owns its category.
   */
  readonly category: string;
  readonly decisionTs: Date;
  readonly q: ProbabilityString;
  readonly qLo: ProbabilityString;
  readonly qHi: ProbabilityString;
  readonly source: EstimateSource;
  readonly status: EstimateStatus;
  readonly provenance: EstimateProvenance | null;
  readonly dataRefs: DataRefs;
  readonly marketProb: ProbabilityString;
  readonly execSpread: string;
  readonly flags: EstimateFlags;
  readonly fallbackReason: string | null;
  readonly intervalVersion: string;
  readonly micropriceVersion: string;
}

/**
 * Reasons the deterministic fallback degraded a model estimate to the market
 * baseline. Every one of them is observable in `fundamental_estimates`.
 */
export type FallbackReason =
  | "NO_ACTIVE_MODEL"
  | "MODEL_IN_SHADOW"
  | "MODEL_ERROR"
  | "MODEL_TIMEOUT"
  | "MODEL_ABSTAINED"
  | "FEED_STALE"
  | "PROVENANCE_UNAVAILABLE"
  | "UMA_DISPUTE_ACTIVE"
  | "GATE_FAILED"
  | "CATEGORY_NOT_MODELLED"
  | "RULE_NOT_PARSEABLE";

/** Output of a category model at one decision instant. */
export interface ModelOutput {
  /** Point probability of YES, in (0, 1). */
  readonly q: number;
  /**
   * Model dispersion (standard deviation of the ensemble / block-bootstrapped
   * residuals) in probability units. Never negative.
   */
  readonly sigma: number;
  readonly featureSetVersion: string;
  readonly dataRefs: DataRefs;
  readonly feedStale: boolean;
  /**
   * Age of the external feed sample the model used, in milliseconds, or null
   * when the model reads no external feed. The interval widens with it, so a
   * model that hides its feed age would be claiming freshness it does not have.
   */
  readonly feedAgeMs?: number | null;
  readonly thinBook: boolean;
}

/** A model abstains explicitly rather than returning a poisoned number. */
export type ModelResult =
  | { readonly ok: true; readonly value: ModelOutput }
  | { readonly ok: false; readonly reason: FallbackReason };

/** A registered, immutable model version. */
export interface ModelRecord {
  readonly modelId: string;
  readonly modelFamily: string;
  readonly category: FundamentalCategory;
  readonly version: string;
  readonly gitSha: string;
  readonly featureSetVersion: string;
  readonly hyperparams: Record<string, unknown>;
  readonly seed: number;
  readonly trainWindowStart: Date | null;
  readonly trainWindowEnd: Date | null;
  readonly regimeMix: boolean;
  readonly status: ModelStatus;
  readonly lastGateReportId: number | null;
  readonly createdAt: Date;
  readonly promotedAt: Date | null;
  readonly demotedAt: Date | null;
  readonly retiredAt: Date | null;
}

/** A resolved market with an honest "publicly knowable" instant. */
export interface LabelRecord {
  readonly tokenId: string;
  readonly conditionId: string;
  readonly category: string;
  /** "0", "0.5" or "1". */
  readonly label: string;
  readonly publiclyKnowableTs: Date | null;
  readonly onchainResolutionTs: Date | null;
  readonly disputed: boolean;
  readonly isFinal: boolean;
}

/** One paired model-vs-baseline observation used by the walk-forward pipeline. */
export interface ScoredObservation {
  readonly tokenId: string;
  readonly conditionId: string;
  readonly decisionTs: Date;
  /** Numeric label in {0, 0.5, 1}. */
  readonly label: number;
  readonly modelQ: number;
  readonly baselineQ: number;
  readonly modelLo: number;
  readonly modelHi: number;
  /** Milliseconds from decision to the publicly knowable instant. */
  readonly horizonMs: number;
  readonly disputed: boolean;
  /** Baseline outside [0.01, 0.99]: excluded from headline metrics. */
  readonly degenerate: boolean;
  /**
   * RFC-019: question form stamped on the estimate's data_refs. Null on rows
   * written before the stamp existed — all of which came from terminal-payoff
   * maps (crypto 1.0.0 and macro), so consumers read null as "terminal".
   */
  readonly form: string | null;
}

export interface ScoreSummary {
  readonly brier: number;
  readonly logLoss: number;
  readonly count: number;
}

export interface ReliabilityBin {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  readonly meanPredicted: number;
  readonly meanObserved: number;
}

export interface ConfidenceInterval {
  readonly point: number;
  readonly lower: number;
  readonly upper: number;
}

export interface HorizonSlice {
  readonly bucket: string;
  readonly count: number;
  readonly model: ScoreSummary;
  readonly baseline: ScoreSummary;
  readonly relativeBrierDegradation: number;
}

export interface CalibrationMetrics {
  readonly observations: number;
  readonly marketsCovered: number;
  readonly model: ScoreSummary;
  readonly baseline: ScoreSummary;
  readonly deltaBrier: ConfidenceInterval;
  readonly deltaLogLoss: ConfidenceInterval;
  readonly horizonSlices: readonly HorizonSlice[];
  /**
   * RFC-019: the same slice mechanics keyed by question form
   * (terminal/barrier/updown). Descriptive only — the gate's criteria are
   * unchanged; a form dragging the whole model down must be VISIBLE, and the
   * gate still judges the model whole.
   */
  readonly formSlices: readonly HorizonSlice[];
  readonly reliabilityModel: readonly ReliabilityBin[];
  readonly reliabilityBaseline: readonly ReliabilityBin[];
  /** Empirical share of outcomes inside the 90% interval; target ~0.90. */
  readonly intervalCoverage: number;
  /** Same metrics computed WITH degenerate observations (annex only). */
  readonly withDegenerate: {
    readonly observations: number;
    readonly model: ScoreSummary;
    readonly baseline: ScoreSummary;
  };
  readonly bootstrapResamples: number;
  readonly bootstrapSeed: number;
  readonly blockLength: number;
}

export type GateVerdict = "PASS" | "NO_EVIDENCE_OF_ALPHA";

export interface GateResult {
  readonly verdict: GateVerdict;
  readonly failures: readonly string[];
  readonly metrics: CalibrationMetrics;
  readonly marketsCovered: number;
  readonly observations: number;
  readonly windowFrom: Date;
  readonly windowTo: Date;
}
