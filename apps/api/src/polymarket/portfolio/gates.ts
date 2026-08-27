// RFC-013 task 9: the six gates that would unlock RFC-009, measured — never
// judged.
//
// Every gate returns PASS, FAIL or INSUFFICIENT_DATA with the numbers that
// produced it. There is no path here that a human can talk past: a gate is a
// computation over recorded evidence, and the endpoint publishes the same
// numbers the report does.
//
// INSUFFICIENT_DATA is deliberately distinct from FAIL. "We have not measured
// enough yet" and "we measured and it did not work" are different states, and
// collapsing them would let a young, empty track record look like a rejection —
// or worse, let a rejection look like youth.

import type { GateConfig } from "./config.js";
import {
  blockBootstrapMean,
  brierScore,
  brierSkillScore,
  logLoss,
  type BootstrapResult,
} from "./bootstrap.js";
import type { GateId, GateReasonCode, GateStatus } from "./types.js";

export interface GateResult {
  readonly gate: GateId;
  readonly status: GateStatus;
  readonly reasonCode: GateReasonCode | null;
  readonly metrics: Readonly<Record<string, unknown>>;
}

export interface ClosedPosition {
  /** Realized PnL in USD. */
  readonly pnl: number;
  readonly conditionId: string;
  readonly category: string | null;
  readonly closedAt: Date;
}

export interface ResolvedForecast {
  readonly conditionId: string;
  /** The model probability used at decision time. */
  readonly modelProbability: number;
  /** The executable market probability at the same instant. */
  readonly marketProbability: number;
  readonly outcome: 0 | 1;
  /**
   * Instant the outcome became publicly verifiable. NOT `closedTime`, which
   * postdates it — a label built from closedTime leaks the answer backwards.
   */
  readonly outcomeKnownAt: Date;
  /** Instant the forecast was made. Must precede outcomeKnownAt. */
  readonly forecastAt: Date;
}

export interface G1Input {
  /**
   * The signal actually used for entries, whatever its source. Bar (b) of the
   * RFC — "o sinal usado nas entradas tem Brier < 0,20" — is taken over this.
   */
  readonly forecasts: readonly ResolvedForecast[];
  /**
   * The subset produced by a PROMOTED MODEL. Bar (a) — "o modelo promovido não
   * piora Brier/log-loss vs o próprio preço" — is taken over this, and ONLY
   * over this.
   *
   * The distinction is not bookkeeping, and getting it wrong made this gate
   * report PASS on no evidence in production on 2026-08-26. With no promoted
   * model, the RFC-010 estimator falls back to a market baseline: `q` is then
   * derived from the same recorded book as the market probability it would be
   * compared against. Scoring that set against the price compares the price to
   * ITSELF — the Brier scores tie, "does not worsen" is trivially satisfied,
   * and the absolute ceiling is cleared because the PRICE is well calibrated
   * (~0.074 by the RFC's own figure). Every condition passes and nothing was
   * measured.
   */
  readonly modelForecasts: readonly ResolvedForecast[];
  readonly config: GateConfig;
}

/**
 * G1 — model calibration. Walk-forward over resolved markets, never k-fold:
 * shuffling time would train on the future.
 *
 * Two bars, both required: the PROMOTED MODEL must not be worse than the price
 * itself (a model that cannot beat the market price is not a model), and the
 * signal actually used for entries must score under the RFC's Brier ceiling.
 *
 * With no promoted model the first bar is not merely unmet — it is
 * UNMEASURABLE, and the gate says INSUFFICIENT_DATA. "We have not measured a
 * model yet" and "a model was measured and cleared the bar" are the two states
 * this gate exists to keep apart.
 */
export function evaluateG1(input: G1Input): GateResult {
  // Leakage guard first: a forecast made at or after the outcome was knowable
  // is not a forecast, and one such row poisons the whole score. Both sets are
  // checked, because the model set is what the substantive bar is taken over —
  // de-duplicated by identity, since the model set is normally a subset and
  // counting a row twice would report a number nobody could reconcile.
  const candidates = new Set<ResolvedForecast>([
    ...input.forecasts,
    ...input.modelForecasts,
  ]);
  const leaking = [...candidates].filter(
    (point) => point.forecastAt.getTime() >= point.outcomeKnownAt.getTime(),
  );
  if (leaking.length > 0) {
    return {
      gate: "G1",
      status: "FAIL",
      reasonCode: "G1_CALIBRATION_NOT_MET",
      metrics: {
        leaking_forecasts: leaking.length,
        detail: "forecast timestamps at or after the outcome became knowable",
      },
    };
  }

  const distinctMarkets = new Set(
    input.forecasts.map((point) => point.conditionId),
  ).size;
  if (distinctMarkets < input.config.g1MinResolvedMarkets) {
    return {
      gate: "G1",
      status: "INSUFFICIENT_DATA",
      reasonCode: "G1_CALIBRATION_NOT_MET",
      metrics: {
        resolved_markets: distinctMarkets,
        required: input.config.g1MinResolvedMarkets,
      },
    };
  }

  // Bar (b): the signal actually used for entries, against the absolute ceiling.
  const usedBrier = brierScore(
    input.forecasts.map((point) => ({
      probability: point.modelProbability,
      outcome: point.outcome,
    })),
  );
  const underCeiling = usedBrier < input.config.g1MaxBrier;

  // Bar (a): the promoted model against the price. Unmeasurable without one.
  const modelMarkets = new Set(
    input.modelForecasts.map((point) => point.conditionId),
  ).size;
  if (modelMarkets < input.config.g1MinResolvedMarkets) {
    return {
      gate: "G1",
      status: "INSUFFICIENT_DATA",
      reasonCode: "G1_CALIBRATION_NOT_MET",
      metrics: {
        resolved_markets: distinctMarkets,
        forecasts: input.forecasts.length,
        used_signal_brier: usedBrier,
        under_ceiling: underCeiling,
        ceiling: input.config.g1MaxBrier,
        model_resolved_markets: modelMarkets,
        model_forecasts: input.modelForecasts.length,
        required: input.config.g1MinResolvedMarkets,
        detail:
          input.modelForecasts.length === 0
            ? "no promoted model: the used signal is a market baseline, and " +
              "scoring it against the price would compare the price to itself"
            : "not enough resolved markets forecast by a promoted model",
      },
    };
  }

  const modelPoints = input.modelForecasts.map((point) => ({
    probability: point.modelProbability,
    outcome: point.outcome,
  }));
  const marketPoints = input.modelForecasts.map((point) => ({
    probability: point.marketProbability,
    outcome: point.outcome,
  }));

  const modelBrier = brierScore(modelPoints);
  const marketBrier = brierScore(marketPoints);
  const modelLogLoss = logLoss(modelPoints);
  const marketLogLoss = logLoss(marketPoints);
  const bss = brierSkillScore(modelBrier, marketBrier);

  const beatsPrice = modelBrier <= marketBrier && modelLogLoss <= marketLogLoss;
  const passed = beatsPrice && underCeiling;

  return {
    gate: "G1",
    status: passed ? "PASS" : "FAIL",
    reasonCode: passed ? null : "G1_CALIBRATION_NOT_MET",
    metrics: {
      resolved_markets: distinctMarkets,
      forecasts: input.forecasts.length,
      model_resolved_markets: modelMarkets,
      model_forecasts: input.modelForecasts.length,
      model_brier: modelBrier,
      market_brier: marketBrier,
      model_log_loss: modelLogLoss,
      market_log_loss: marketLogLoss,
      brier_skill_score: bss,
      used_signal_brier: usedBrier,
      beats_price: beatsPrice,
      under_ceiling: underCeiling,
      ceiling: input.config.g1MaxBrier,
    },
  };
}

export interface G2Input {
  readonly closed: readonly ClosedPosition[];
  /** Start of the continuous paper run, after any G5 reset. */
  readonly clockStart: Date | null;
  readonly now: Date;
  readonly config: GateConfig;
}

export interface G2Result extends GateResult {
  readonly bootstrap: BootstrapResult | null;
}

const DAY_MS = 24 * 3_600_000;

/**
 * The volume, breadth and spread of recorded paper evidence.
 *
 * Shared on purpose. G2 asks whether the PnL is distinguishable from zero and
 * G3 asks whether the risk controls survived, but BOTH questions are taken over
 * the same book — and a gate answered over an empty book answers nothing. G3
 * used to pass on zero positions, because zero positions produce zero unblocked
 * breaches and zero drawdown; that is the absence of exposure wearing the name
 * of survival.
 */
export interface EvidenceBase {
  /** Continuous paper days on the clock, after any G5 reset. */
  readonly days: number;
  /**
   * The closed positions that fall INSIDE the clock window.
   *
   * A G5 reset throws the elapsed days away because they were measured under a
   * regime that no longer exists — and the positions closed during those days
   * were measured under it too. Keeping them while discarding the days would
   * make the reset cosmetic: the same sample, relabelled with a shorter clock.
   */
  readonly closedInWindow: readonly ClosedPosition[];
  readonly closedPositions: number;
  readonly distinctMarkets: number;
  readonly distinctCategories: number;
  /** Distinct UTC days on which a position actually closed. */
  readonly distinctCloseDays: number;
  readonly shortfalls: Readonly<Record<string, unknown>>;
  readonly sufficient: boolean;
}

function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Measure the evidence base and name EVERY shortfall, not just the first.
 *
 * `distinctCloseDays` is the one that is not in the RFC's list, and it is there
 * because the RFC's "60 dias corridos" is a property of the CLOCK. A hundred
 * positions that all closed inside one afternoon satisfy every count while
 * describing a single market episode — and a moving-block bootstrap over that
 * afternoon resamples the episode, not the strategy.
 */
export function paperEvidenceBase(input: {
  readonly closed: readonly ClosedPosition[];
  readonly clockStart: Date | null;
  readonly now: Date;
  readonly config: GateConfig;
}): EvidenceBase {
  const days =
    input.clockStart === null
      ? 0
      : (input.now.getTime() - input.clockStart.getTime()) / DAY_MS;
  const clockStartMs = input.clockStart?.getTime() ?? null;
  const closedInWindow =
    clockStartMs === null
      ? []
      : input.closed.filter(
          (position) => position.closedAt.getTime() >= clockStartMs,
        );
  const distinctMarkets = new Set(
    closedInWindow.map((position) => position.conditionId),
  ).size;
  const distinctCategories = new Set(
    closedInWindow.map((position) => position.category ?? "unknown"),
  ).size;
  const distinctCloseDays = new Set(
    closedInWindow.map((position) => utcDayKey(position.closedAt)),
  ).size;

  const shortfalls: Record<string, unknown> = {};
  if (days < input.config.g2MinDays) {
    shortfalls.days = { have: days, need: input.config.g2MinDays };
  }
  if (closedInWindow.length < input.config.g2MinClosedPositions) {
    shortfalls.closed_positions = {
      have: closedInWindow.length,
      need: input.config.g2MinClosedPositions,
      outside_window: input.closed.length - closedInWindow.length,
    };
  }
  if (distinctMarkets < input.config.g2MinDistinctMarkets) {
    shortfalls.distinct_markets = {
      have: distinctMarkets,
      need: input.config.g2MinDistinctMarkets,
    };
  }
  if (distinctCategories < input.config.g2MinCategories) {
    shortfalls.categories = {
      have: distinctCategories,
      need: input.config.g2MinCategories,
    };
  }
  if (distinctCloseDays < input.config.g2MinDistinctCloseDays) {
    shortfalls.distinct_close_days = {
      have: distinctCloseDays,
      need: input.config.g2MinDistinctCloseDays,
    };
  }

  return {
    days,
    closedInWindow,
    closedPositions: closedInWindow.length,
    distinctMarkets,
    distinctCategories,
    distinctCloseDays,
    shortfalls,
    sufficient: Object.keys(shortfalls).length === 0,
  };
}

/** The gross money the book moved: the denominator of the concentration check. */
function grossAbsolutePnl(closed: readonly ClosedPosition[]): number {
  let total = 0;
  for (const position of closed) {
    total += Math.abs(position.pnl);
  }
  return total;
}

/**
 * G2 — paper with realism. Volume, breadth, DISPERSION, and a bootstrapped
 * interval that clears zero AFTER the 50% haircut.
 *
 * The haircut is not pessimism for its own sake: paper-to-live degradation of
 * 20-50% is the documented expectation, so an edge that only survives at full
 * strength has not shown it would survive at all.
 *
 * The dispersion requirements are the G1 lesson applied here. A block bootstrap
 * answers "how much could this mean have moved, had the sample come out
 * differently" — and there are three sample shapes for which that question has
 * no content, all of which used to clear the gate:
 *
 *   1. a CONSTANT series. Every resample returns the identical mean, the 95%
 *      interval collapses to a point, and `ciLow > 0` becomes plain arithmetic
 *      on that point. A hundred binary-market positions that all realized the
 *      same PnL is an artifact of how the number was produced, not a track
 *      record;
 *   2. a series with too FEW independent blocks, where the interval is the
 *      sample rearranged a handful of ways;
 *   3. a BURST — every close inside a day or two of a 60-day clock. The counts
 *      are all satisfied and the bootstrap resamples one market episode.
 *
 * And one more, which the bootstrap does partly resist but which makes the
 * counts a fiction: a single position accounting for most of the money the book
 * ever moved.
 *
 * None of these is a measured "no alpha here" — they are the absence of a
 * measurement, so they answer INSUFFICIENT_DATA and never FAIL.
 */
export function evaluateG2(input: G2Input): G2Result {
  const evidence = paperEvidenceBase({
    closed: input.closed,
    clockStart: input.clockStart,
    now: input.now,
    config: input.config,
  });

  const sample = evidence.closedInWindow;
  const shortfalls: Record<string, unknown> = { ...evidence.shortfalls };

  // Dispersion, part 1: enough independent blocks for a BLOCK bootstrap to be
  // one. Taken before the resampling because it is a property of the sample.
  const blockSize = Math.min(
    Math.max(Math.floor(input.config.bootstrapBlockSize), 1),
    Math.max(sample.length, 1),
  );
  const blocks = Math.floor(sample.length / blockSize);
  if (blocks < input.config.g2MinBootstrapBlocks) {
    shortfalls.bootstrap_blocks = {
      have: blocks,
      need: input.config.g2MinBootstrapBlocks,
      block_size: blockSize,
    };
  }

  // Dispersion, part 2: no single close may dominate the money the book moved.
  const gross = grossAbsolutePnl(sample);
  const largest = sample.reduce(
    (worst, position) => Math.max(worst, Math.abs(position.pnl)),
    0,
  );
  const largestShare = gross === 0 ? 0 : largest / gross;
  if (largestShare > input.config.g2MaxSinglePositionPnlShare) {
    shortfalls.single_position_share = {
      have: largestShare,
      max: input.config.g2MaxSinglePositionPnlShare,
    };
  }

  const baseMetrics = {
    days: evidence.days,
    closed_positions: evidence.closedPositions,
    distinct_markets: evidence.distinctMarkets,
    categories: evidence.distinctCategories,
    distinct_close_days: evidence.distinctCloseDays,
    bootstrap_blocks: blocks,
    largest_position_pnl_share: largestShare,
  };

  if (Object.keys(shortfalls).length > 0) {
    return {
      gate: "G2",
      status: "INSUFFICIENT_DATA",
      reasonCode: "G2_INSUFFICIENT_PAPER",
      metrics: { ...baseMetrics, shortfalls },
      bootstrap: null,
    };
  }

  const ordered = [...sample].sort(
    (a, b) => a.closedAt.getTime() - b.closedAt.getTime(),
  );
  const bootstrap = blockBootstrapMean({
    samples: ordered.map((position) => position.pnl),
    resamples: input.config.bootstrapResamples,
    blockSize: input.config.bootstrapBlockSize,
    seed: input.config.bootstrapSeed,
    haircut: input.config.g2EdgeHaircut,
  });

  const intervalWidth = bootstrap.ciHigh - bootstrap.ciLow;
  const metrics = {
    ...baseMetrics,
    mean_pnl: bootstrap.mean,
    mean_pnl_after_haircut: bootstrap.haircutMean,
    ci95_low: bootstrap.ciLow,
    ci95_high: bootstrap.ciHigh,
    ci95_width: intervalWidth,
    haircut: input.config.g2EdgeHaircut,
    resamples: bootstrap.resamples,
    block_size: bootstrap.blockSize,
    seed: bootstrap.seed,
  };

  // Dispersion, part 3: the interval has to BE an interval. A width of zero
  // means every resample came back identical — the sample carries no variation,
  // so `ciLow > 0` is not a confidence statement about anything.
  if (!(intervalWidth > 0)) {
    return {
      gate: "G2",
      status: "INSUFFICIENT_DATA",
      reasonCode: "G2_INSUFFICIENT_PAPER",
      metrics: {
        ...metrics,
        degenerate_interval: true,
        detail:
          "every bootstrap resample returned the same mean: the realized PnL " +
          "carries no dispersion, so the interval is a point and not evidence",
      },
      bootstrap,
    };
  }

  return {
    gate: "G2",
    status: bootstrap.aboveZero ? "PASS" : "FAIL",
    // The RFC names this code specifically: a measured, honest "no alpha here".
    reasonCode: bootstrap.aboveZero ? null : "NO_EVIDENCE_OF_ALPHA",
    metrics: { ...metrics, degenerate_interval: false },
    bootstrap,
  };
}

export interface G3Input {
  /** Cap breaches that were NOT blocked automatically. */
  readonly unblockedBreaches: number;
  readonly maxDrawdown: number;
  readonly drawdownMax: number;
  /** Breaker kinds proven to fire in an injected scenario. */
  readonly breakersExercised: readonly string[];
  readonly breakersRequired: readonly string[];
  /**
   * The SAME evidence base G2 is taken over. Not a convenience: the three
   * survival facts below are all measured over the paper book, and over an
   * empty book every one of them reads clean. Zero positions produce zero
   * unblocked breaches and zero drawdown, and this gate used to call that PASS.
   */
  readonly evidence: EvidenceBase;
}

/**
 * G3 — risk survival: no unblocked breach, drawdown inside the limit, and every
 * circuit breaker demonstrated in an injected scenario — measured over the same
 * book G2 requires.
 *
 * "Nothing broke" is only evidence when something was at risk. Without the
 * evidence base the gate reports INSUFFICIENT_DATA: nothing was survived, and
 * saying so is different from saying the controls held.
 *
 * The breaker demonstrations are NOT gated on the evidence base, and are still
 * reported when it is short — an injected scenario is a deliberate test, not
 * something the book has to produce on its own. But they are not sufficient
 * alone, which is precisely what this gate previously allowed.
 */
export function evaluateG3(input: G3Input): GateResult {
  const missing = input.breakersRequired.filter(
    (kind) => !input.breakersExercised.includes(kind),
  );
  const metrics = {
    unblocked_breaches: input.unblockedBreaches,
    max_drawdown: input.maxDrawdown,
    drawdown_max: input.drawdownMax,
    breakers_exercised: input.breakersExercised,
    breakers_missing: missing,
    evidence_base: {
      days: input.evidence.days,
      closed_positions: input.evidence.closedPositions,
      distinct_markets: input.evidence.distinctMarkets,
      categories: input.evidence.distinctCategories,
      distinct_close_days: input.evidence.distinctCloseDays,
      shortfalls: input.evidence.shortfalls,
    },
  };

  if (!input.evidence.sufficient) {
    return {
      gate: "G3",
      status: "INSUFFICIENT_DATA",
      reasonCode: "G3_RISK_BREACH",
      metrics: {
        ...metrics,
        detail:
          "no risk was survived: the paper book behind this gate is the same " +
          "one G2 requires, and it is short",
      },
    };
  }

  const passed =
    input.unblockedBreaches === 0 &&
    input.maxDrawdown < input.drawdownMax &&
    missing.length === 0;
  return {
    gate: "G3",
    status: passed ? "PASS" : "FAIL",
    reasonCode: passed ? null : "G3_RISK_BREACH",
    metrics,
  };
}

export interface G4Input {
  /** Median relative error between simulated and real fee, in [0, 1]. */
  readonly feeMedianError: number | null;
  /** Mean of (simulated slippage - realized slippage). Negative = optimistic. */
  readonly slippageBias: number | null;
  /**
   * How many INDEPENDENT samples each number was taken over — independent
   * meaning the reference did not come from the observation the simulator
   * itself consumed.
   */
  readonly feeSamples: number;
  readonly slippageSamples: number;
  /**
   * Samples rejected for being self-referential, reported so the degenerate
   * case is visible rather than merely absent. A run where these are large and
   * the counts above are zero is the G1 failure mode in another dress: a
   * comparison of the simulator against itself, which cannot fail.
   */
  readonly selfReferentialFeeSamples: number;
  readonly selfReferentialSlippageSamples: number;
  readonly soakDays: number;
  readonly killSwitchExercised: boolean;
  readonly reduceOnlyExercised: boolean;
  readonly config: GateConfig;
}

/**
 * G4 — reconciliation and operation.
 *
 * Three things this gate has to refuse to answer, rather than answer well:
 *
 *   - NO fills reconciled. `reconcile([])` returns nulls, and a gate reading
 *     nulls as "nothing wrong" would be the G1 mistake exactly;
 *   - TOO FEW fills. A median over one sample is that sample, and a mean bias
 *     over one sample is that sample's sign. The RFC does not name a number, so
 *     `g4MinReconciledFills` does, and it is required on EACH leg separately —
 *     a hundred fee samples say nothing about slippage;
 *   - a SELF-REFERENTIAL reference. If the "real" number is re-derived from the
 *     same recorded observation the simulator consumed, the comparison is the
 *     simulator against itself: the error is zero and the bias is zero, both of
 *     which clear the bars. Those samples never reach the arithmetic — they are
 *     excluded upstream in `reconcile` and only counted here.
 *
 * The slippage check is one-sided on purpose: simulating MORE slippage than
 * reality is conservative and fine; simulating less is the optimistic bias the
 * RFC forbids.
 */
export function evaluateG4(input: G4Input): GateResult {
  const sampleMetrics = {
    fee_samples: input.feeSamples,
    slippage_samples: input.slippageSamples,
    samples_required: input.config.g4MinReconciledFills,
    self_referential_fee_samples: input.selfReferentialFeeSamples,
    self_referential_slippage_samples: input.selfReferentialSlippageSamples,
  };

  const feeShort = input.feeSamples < input.config.g4MinReconciledFills;
  const slippageShort =
    input.slippageSamples < input.config.g4MinReconciledFills;

  if (
    input.feeMedianError === null ||
    input.slippageBias === null ||
    feeShort ||
    slippageShort
  ) {
    const selfReferentialOnly =
      (input.feeSamples === 0 && input.selfReferentialFeeSamples > 0) ||
      (input.slippageSamples === 0 && input.selfReferentialSlippageSamples > 0);
    return {
      gate: "G4",
      status: "INSUFFICIENT_DATA",
      reasonCode: "G4_RECONCILIATION_OFF",
      metrics: {
        ...sampleMetrics,
        fee_median_error: input.feeMedianError,
        slippage_bias: input.slippageBias,
        detail: selfReferentialOnly
          ? "every reference came from the same recorded observation the " +
            "simulator consumed: comparing the simulator to itself measures " +
            "nothing"
          : "not enough independently reconciled fills yet",
      },
    };
  }

  const feeOk = input.feeMedianError < input.config.g4MaxFeeMedianError;
  const slippageOk = input.slippageBias >= 0;
  const soakOk = input.soakDays >= input.config.g4MinSoakDays;
  const passed =
    feeOk &&
    slippageOk &&
    soakOk &&
    input.killSwitchExercised &&
    input.reduceOnlyExercised;
  return {
    gate: "G4",
    status: passed ? "PASS" : "FAIL",
    reasonCode: passed ? null : "G4_RECONCILIATION_OFF",
    metrics: {
      ...sampleMetrics,
      fee_median_error: input.feeMedianError,
      fee_ceiling: input.config.g4MaxFeeMedianError,
      slippage_bias: input.slippageBias,
      slippage_optimistic: !slippageOk,
      soak_days: input.soakDays,
      soak_required: input.config.g4MinSoakDays,
      kill_switch_exercised: input.killSwitchExercised,
      reduce_only_exercised: input.reduceOnlyExercised,
    },
  };
}

export interface CategoryClock {
  readonly category: string;
  readonly clockStart: Date;
  readonly regimeFingerprint: string;
  readonly lastResetReason: string | null;
}

export interface G5Input {
  readonly clocks: readonly CategoryClock[];
  /** Current regime fingerprint per category, recomputed from live params. */
  readonly currentFingerprints: Readonly<Record<string, string>>;
  readonly now: Date;
  readonly config: GateConfig;
}

/**
 * G5 — regime freshness. The G2 window must lie entirely after the venue's
 * last relevant change, PER CATEGORY: fees differ by category, and V2 killed
 * strategies that were live under V1.
 *
 * A fingerprint mismatch means the clock has not been reset for a change that
 * already happened, which is itself a failure — the evidence being counted was
 * gathered under a regime that no longer exists.
 */
export function evaluateG5(input: G5Input): GateResult {
  const stale: string[] = [];
  const tooYoung: string[] = [];
  for (const clock of input.clocks) {
    const current = input.currentFingerprints[clock.category];
    if (current !== undefined && current !== clock.regimeFingerprint) {
      stale.push(clock.category);
    }
    const days = (input.now.getTime() - clock.clockStart.getTime()) / DAY_MS;
    if (days < input.config.g2MinDays) {
      tooYoung.push(clock.category);
    }
  }
  if (input.clocks.length === 0) {
    return {
      gate: "G5",
      status: "INSUFFICIENT_DATA",
      reasonCode: "G5_REGIME_STALE",
      metrics: { detail: "no category clock started yet" },
    };
  }
  const passed = stale.length === 0 && tooYoung.length === 0;
  return {
    gate: "G5",
    status: passed ? "PASS" : stale.length > 0 ? "FAIL" : "INSUFFICIENT_DATA",
    reasonCode: passed ? null : "G5_REGIME_STALE",
    metrics: {
      categories: input.clocks.length,
      fingerprint_mismatch: stale,
      below_minimum_days: tooYoung,
      required_days: input.config.g2MinDays,
    },
  };
}

/**
 * Minimum length of the owner's written review.
 *
 * A number rather than "non-empty" because "ok" is non-empty. G6 is the written
 * record; the act of approving is the easy part.
 */
export const MIN_REVIEW_NOTE_LENGTH = 40;

export interface G6Input {
  /** The owner's written review, or null when none exists. */
  readonly approval: {
    readonly reviewedAt: Date;
    readonly reviewer: string;
    readonly note: string;
    /** Which gate report the review was written against. */
    readonly reportId: number;
  } | null;
  /** The report currently being assembled. */
  readonly currentReportId: number | null;
}

/**
 * G6 — approval. A human act, and the only gate a computation cannot pass.
 *
 * A review of an OLDER report does not carry: the numbers it approved are not
 * the numbers on the table. That is why the approval records which report it
 * was written against, and why the engine mints a new report whenever any gate
 * verdict changes — a review survives exactly as long as the numbers it read.
 *
 * `currentReportId === null` used to mean "matches" — an approval of nothing
 * matching everything. It is the same shape as the G1 incident: a condition
 * satisfied because there was nothing to compare against. With no report on
 * record there is nothing the owner can have reviewed, so the gate says so.
 */
export function evaluateG6(input: G6Input): GateResult {
  if (input.approval === null) {
    return {
      gate: "G6",
      status: "INSUFFICIENT_DATA",
      reasonCode: "G6_NOT_REVIEWED",
      metrics: {
        current_report_id: input.currentReportId,
        detail: "no written owner review on record",
      },
    };
  }
  if (input.currentReportId === null) {
    return {
      gate: "G6",
      status: "INSUFFICIENT_DATA",
      reasonCode: "G6_NOT_REVIEWED",
      metrics: {
        reviewed_at: input.approval.reviewedAt.toISOString(),
        reviewer: input.approval.reviewer,
        report_id: input.approval.reportId,
        current_report_id: null,
        matches_current_report: false,
        detail:
          "an approval exists but no gate report does: there is nothing it " +
          "can have been written against",
      },
    };
  }
  // The written record IS the gate. A signature on a blank page is not a
  // review, and the RFC asks for "revisão manual do proprietário [...] com
  // registro escrito".
  //
  // The same bar the CLI enforces on the way in, enforced again on the way out:
  // a row written by hand into the table has to clear it too, or the CLI's
  // check would be a suggestion.
  const note = input.approval.note.trim();
  if (note.length < MIN_REVIEW_NOTE_LENGTH) {
    return {
      gate: "G6",
      status: "INSUFFICIENT_DATA",
      reasonCode: "G6_NOT_REVIEWED",
      metrics: {
        reviewed_at: input.approval.reviewedAt.toISOString(),
        reviewer: input.approval.reviewer,
        report_id: input.approval.reportId,
        current_report_id: input.currentReportId,
        matches_current_report:
          input.approval.reportId === input.currentReportId,
        detail:
          "the review carries no written record of at least " +
          `${String(MIN_REVIEW_NOTE_LENGTH)} characters`,
      },
    };
  }
  const matchesCurrent = input.approval.reportId === input.currentReportId;
  return {
    gate: "G6",
    status: matchesCurrent ? "PASS" : "INSUFFICIENT_DATA",
    reasonCode: matchesCurrent ? null : "G6_NOT_REVIEWED",
    metrics: {
      reviewed_at: input.approval.reviewedAt.toISOString(),
      reviewer: input.approval.reviewer,
      report_id: input.approval.reportId,
      current_report_id: input.currentReportId,
      matches_current_report: matchesCurrent,
    },
  };
}

/**
 * The overall verdict. BLOCKED unless EVERY gate is PASS.
 *
 * There is no weighting, no "mostly passing", and no override. RFC-009 stays
 * blocked while any gate is anything other than PASS.
 */
export function overallStatus(
  results: readonly GateResult[],
): "BLOCKED" | "READY_FOR_OWNER_REVIEW" {
  const allPass = results.every((result) => result.status === "PASS");
  return allPass ? "READY_FOR_OWNER_REVIEW" : "BLOCKED";
}

/**
 * The expectation the RFC requires printed on every report, so nobody reads a
 * passing gate as a promise.
 */
export const CALIBRATED_EXPECTATION =
  "~84% das carteiras rastreáveis perdem dinheiro. O gate exige evidência de " +
  "decil superior, não 'parece bom'. Passar os gates não promete lucro.";
