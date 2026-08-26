// RFC-013 task 8: continuous measurement of the gates task 9 defines.
//
// gates.ts holds the six verdicts as arithmetic. This file assembles their
// inputs from recorded evidence and turns them into rows for
// `portfolio_gate_measurements` — one row per gate per measurement, immutable by
// trigger, never pruned. It is the evidence trail behind any future RFC-009
// decision, so it records what was measured even when the answer is "not
// enough yet".
//
// The RFC also asks for a weekly report. By the owner's decision of 2026-08-26
// the report is replaced by a queryable, paginated history in the panel: the
// same numbers, consulted when someone wants them, instead of a document
// generated whether anyone reads it or not. `portfolio_gate_reports` stays in
// the schema unused, because G6 (the owner's written review) is recorded
// against a report id and dropping the table would throw that away.
//
// Nothing here can pass a gate by judgement. Every function is a computation
// over rows, and the only human input in the whole file is G6's written review.

import { createHash } from "node:crypto";

import type { GateConfig } from "./config.js";
import {
  evaluateG1,
  evaluateG2,
  evaluateG3,
  evaluateG4,
  evaluateG5,
  evaluateG6,
  overallStatus,
  type CategoryClock,
  type ClosedPosition,
  type GateResult,
  type ResolvedForecast,
} from "./gates.js";
import { BREAKER_KINDS } from "./types.js";
import type { GateId, GateReasonCode, GateStatus } from "./types.js";

const DAY_MS = 24 * 3_600_000;

/** One row destined for `portfolio_gate_measurements`. */
export interface GateMeasurement {
  readonly gate: GateId;
  readonly status: GateStatus;
  readonly reasonCode: GateReasonCode | null;
  readonly metrics: Readonly<Record<string, unknown>>;
  readonly windowFrom: Date | null;
  readonly windowTo: Date | null;
}

// ---------------------------------------------------------------------------
// G1 inputs: forecasts with a label, and the leakage guard on the way in.
// ---------------------------------------------------------------------------

/** A resolved market's forecast, as the RFC-010 tables record it. */
export interface ForecastRow {
  readonly conditionId: string;
  readonly modelProbability: number;
  /** Executable market probability at the same instant; null when unrecorded. */
  readonly marketProbability: number | null;
  readonly label: string;
  /** The instant the outcome became publicly knowable. Never `closedTime`. */
  readonly outcomeKnownAt: Date | null;
  readonly forecastAt: Date;
}

/** Why a candidate forecast was not scored, and how many were dropped for it. */
export interface ForecastExclusions {
  fifty_fifty_label: number;
  non_binary_label: number;
  no_outcome_instant: number;
  no_market_probability: number;
}

export interface ForecastSelection {
  readonly forecasts: readonly ResolvedForecast[];
  readonly excluded: Readonly<ForecastExclusions>;
}

/**
 * Keep only the forecasts a Brier score can honestly be taken over, and say how
 * many were dropped and why.
 *
 * A 0.50 label is a real outcome on this venue — a 50/50 UMA report pays half
 * to each side — but it is not a binary outcome, so scoring it as 0 or 1 would
 * be inventing an answer. It is excluded and counted; the count is part of the
 * gate's metrics precisely so a book full of 50/50 resolutions cannot look like
 * a clean sample.
 *
 * A row without `outcomeKnownAt` is dropped for a different reason: with no
 * instant to compare against, the leakage check in evaluateG1 cannot run, and a
 * forecast whose honesty cannot be checked is not evidence.
 */
export function selectForecasts(
  rows: readonly ForecastRow[],
): ForecastSelection {
  const forecasts: ResolvedForecast[] = [];
  const excluded: ForecastExclusions = {
    fifty_fifty_label: 0,
    non_binary_label: 0,
    no_outcome_instant: 0,
    no_market_probability: 0,
  };
  for (const row of rows) {
    if (row.label === "0.5") {
      excluded.fifty_fifty_label += 1;
      continue;
    }
    if (row.label !== "0" && row.label !== "1") {
      excluded.non_binary_label += 1;
      continue;
    }
    if (row.outcomeKnownAt === null) {
      excluded.no_outcome_instant += 1;
      continue;
    }
    if (row.marketProbability === null) {
      excluded.no_market_probability += 1;
      continue;
    }
    forecasts.push({
      conditionId: row.conditionId,
      modelProbability: row.modelProbability,
      marketProbability: row.marketProbability,
      outcome: row.label === "1" ? 1 : 0,
      outcomeKnownAt: row.outcomeKnownAt,
      forecastAt: row.forecastAt,
    });
  }
  return { forecasts, excluded };
}

// ---------------------------------------------------------------------------
// G4 inputs: fee and slippage reconciliation over recorded paper fills.
// ---------------------------------------------------------------------------

export interface ReconciliationSample {
  readonly side: "BUY" | "SELL";
  /** Fee the simulator charged for this fill, in USD. */
  readonly simulatedFeeUsd: number;
  /**
   * Fee implied by the venue's own `fee_rate_bps` at the same price and size.
   * Null when no recorded trade near the fill carried a rate.
   */
  readonly realFeeUsd: number | null;
  /** Price the simulator filled at. */
  readonly simulatedPrice: number;
  /** Price a book-walk of the same size over the recorded book would give. */
  readonly bookWalkPrice: number | null;
}

export interface ReconciliationResult {
  /** Median relative fee error, or null when nothing could be compared. */
  readonly feeMedianError: number | null;
  /**
   * Mean conservatism of the simulated price: positive means the simulator was
   * WORSE than the recorded book (paid more buying, received less selling),
   * which is the safe direction. Negative is the optimistic bias the RFC
   * forbids, and evaluateG4 fails on it.
   */
  readonly slippageBias: number | null;
  readonly feeSamples: number;
  readonly slippageSamples: number;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }
  const low = sorted[middle - 1] ?? 0;
  const high = sorted[middle] ?? 0;
  return (low + high) / 2;
}

/**
 * Reconcile simulated fills against the venue's recorded numbers.
 *
 * The slippage comparison is deliberately signed rather than absolute. The RFC
 * asks for "slippage simulado vs book real sem viés otimista", and those are
 * different requirements: simulating more cost than the book would have charged
 * is conservative and acceptable, while simulating less is the bias that makes
 * a paper track record mean nothing.
 */
export function reconcile(
  samples: readonly ReconciliationSample[],
): ReconciliationResult {
  const feeErrors: number[] = [];
  const biases: number[] = [];
  for (const sample of samples) {
    if (sample.realFeeUsd !== null && sample.realFeeUsd > 0) {
      feeErrors.push(
        Math.abs(sample.simulatedFeeUsd - sample.realFeeUsd) /
          sample.realFeeUsd,
      );
    }
    if (sample.bookWalkPrice !== null) {
      biases.push(
        sample.side === "BUY"
          ? sample.simulatedPrice - sample.bookWalkPrice
          : sample.bookWalkPrice - sample.simulatedPrice,
      );
    }
  }
  return {
    feeMedianError: median(feeErrors),
    slippageBias:
      biases.length === 0
        ? null
        : biases.reduce((sum, value) => sum + value, 0) / biases.length,
    feeSamples: feeErrors.length,
    slippageSamples: biases.length,
  };
}

// ---------------------------------------------------------------------------
// G5 inputs: the regime fingerprint, and when the G2 clock has to reset.
// ---------------------------------------------------------------------------

/** The venue parameters that define a regime for one market. */
export interface RegimeParams {
  readonly feeBaseBps: string | null;
  readonly makerFeeBps: string | null;
  readonly takerFeeBps: string | null;
  readonly tickSize: string | null;
  readonly minOrderSize: string | null;
  readonly negRisk: boolean | null;
}

/**
 * Fingerprint of a category's regime: the sorted set of DISTINCT parameter
 * tuples in force across that category's markets.
 *
 * Sorted and de-duplicated on purpose. A new market appearing with the same fee
 * schedule is not a regime change, and the gate must not reset a 59-day clock
 * because the universe grew. A fee schedule, tick or negRisk flag changing IS a
 * regime change, and resets it — the RFC is explicit that V2 killed strategies
 * that were live under V1.
 */
export function regimeFingerprint(params: readonly RegimeParams[]): string {
  const tuples = params.map((p) =>
    [
      p.feeBaseBps ?? "",
      p.makerFeeBps ?? "",
      p.takerFeeBps ?? "",
      p.tickSize ?? "",
      p.minOrderSize ?? "",
      p.negRisk === null ? "" : String(p.negRisk),
    ].join(":"),
  );
  const distinct = [...new Set(tuples)].sort();
  return createHash("sha256").update(JSON.stringify(distinct)).digest("hex");
}

export interface ClockResetPlan {
  readonly category: string;
  readonly previousStart: Date | null;
  readonly newStart: Date;
  readonly previousFingerprint: string | null;
  readonly newFingerprint: string;
  readonly reason: string;
}

/**
 * Which category clocks have to start or reset.
 *
 * The RFC's rule, applied literally: "qualquer mudança de fee
 * schedule/regras/protocolo durante o gate reseta o relógio do G2 para as
 * categorias afetadas". A reset is not a smaller number to be averaged in — it
 * throws the elapsed days away, because the days were measured under a regime
 * that no longer exists.
 */
export function planClockResets(input: {
  readonly clocks: readonly CategoryClock[];
  readonly currentFingerprints: Readonly<Record<string, string>>;
  readonly now: Date;
}): ClockResetPlan[] {
  const byCategory = new Map(
    input.clocks.map((clock) => [clock.category, clock]),
  );
  const plans: ClockResetPlan[] = [];
  for (const [category, fingerprint] of Object.entries(
    input.currentFingerprints,
  )) {
    const existing = byCategory.get(category);
    if (existing === undefined) {
      plans.push({
        category,
        previousStart: null,
        newStart: input.now,
        previousFingerprint: null,
        newFingerprint: fingerprint,
        reason: "clock_started",
      });
      continue;
    }
    if (existing.regimeFingerprint !== fingerprint) {
      plans.push({
        category,
        previousStart: existing.clockStart,
        newStart: input.now,
        previousFingerprint: existing.regimeFingerprint,
        newFingerprint: fingerprint,
        reason: "regime_fingerprint_changed",
      });
    }
  }
  return plans;
}

// ---------------------------------------------------------------------------
// The measurement itself.
// ---------------------------------------------------------------------------

export interface MeasureGatesInput {
  readonly now: Date;
  readonly config: GateConfig;

  /** G1. */
  readonly forecastRows: readonly ForecastRow[];

  /** G2. */
  readonly closed: readonly ClosedPosition[];
  readonly clockStart: Date | null;

  /** G3. */
  readonly unblockedBreaches: number;
  readonly maxDrawdown: number;
  readonly drawdownMax: number;
  readonly breakersExercised: readonly string[];

  /** G4. */
  readonly reconciliation: ReconciliationResult;
  readonly soakDays: number;
  readonly killSwitchExercised: boolean;
  readonly reduceOnlyExercised: boolean;

  /** G5 — clocks AFTER any reset this cycle applied. */
  readonly clocks: readonly CategoryClock[];
  readonly currentFingerprints: Readonly<Record<string, string>>;

  /** G6. */
  readonly approval: {
    readonly reviewedAt: Date;
    readonly reviewer: string;
    readonly note: string;
    readonly reportId: number;
  } | null;
  readonly currentReportId: number | null;
}

export interface MeasureGatesResult {
  readonly measurements: readonly GateMeasurement[];
  readonly overall: "BLOCKED" | "READY_FOR_OWNER_REVIEW";
}

/** The earliest of a list of instants, or null when the list is empty. */
function oldestOf(dates: readonly Date[]): Date | null {
  let oldest: Date | null = null;
  for (const date of dates) {
    if (oldest === null || date.getTime() < oldest.getTime()) {
      oldest = date;
    }
  }
  return oldest;
}

function windowOf(
  from: Date | null,
  to: Date,
): { windowFrom: Date | null; windowTo: Date | null } {
  return { windowFrom: from, windowTo: to };
}

function toMeasurement(
  result: GateResult,
  window: { windowFrom: Date | null; windowTo: Date | null },
  extraMetrics: Readonly<Record<string, unknown>> = {},
): GateMeasurement {
  return {
    gate: result.gate,
    status: result.status,
    reasonCode: result.reasonCode,
    metrics: { ...result.metrics, ...extraMetrics },
    windowFrom: window.windowFrom,
    windowTo: window.windowTo,
  };
}

/**
 * Measure all six gates and say whether RFC-009 would be unblocked.
 *
 * The answer is BLOCKED unless every gate is PASS, with no weighting and no
 * override. A failing gate carries its own reason code, and the G2 failure
 * carries the RFC's own name for it: NO_EVIDENCE_OF_ALPHA.
 */
export function measureGates(input: MeasureGatesInput): MeasureGatesResult {
  const selection = selectForecasts(input.forecastRows);
  const g1 = evaluateG1({
    forecasts: selection.forecasts,
    config: input.config,
  });
  const g1From = oldestOf(selection.forecasts.map((point) => point.forecastAt));

  const g2 = evaluateG2({
    closed: input.closed,
    clockStart: input.clockStart,
    now: input.now,
    config: input.config,
  });

  const g3 = evaluateG3({
    unblockedBreaches: input.unblockedBreaches,
    maxDrawdown: input.maxDrawdown,
    drawdownMax: input.drawdownMax,
    breakersExercised: input.breakersExercised,
    // Every breaker kind the module can open has to have been demonstrated;
    // deriving the list from the type means a new breaker cannot be added
    // without also having to be exercised.
    breakersRequired: BREAKER_KINDS,
  });

  const g4 = evaluateG4({
    feeMedianError: input.reconciliation.feeMedianError,
    slippageBias: input.reconciliation.slippageBias,
    soakDays: input.soakDays,
    killSwitchExercised: input.killSwitchExercised,
    reduceOnlyExercised: input.reduceOnlyExercised,
    config: input.config,
  });

  const g5 = evaluateG5({
    clocks: input.clocks,
    currentFingerprints: input.currentFingerprints,
    now: input.now,
    config: input.config,
  });

  const g6 = evaluateG6({
    approval: input.approval,
    currentReportId: input.currentReportId,
  });

  const oldestClock = oldestOf(input.clocks.map((clock) => clock.clockStart));

  const measurements: GateMeasurement[] = [
    toMeasurement(g1, windowOf(g1From, input.now), {
      excluded_forecasts: selection.excluded,
      scored_forecasts: selection.forecasts.length,
      candidate_rows: input.forecastRows.length,
    }),
    toMeasurement(g2, windowOf(input.clockStart, input.now)),
    toMeasurement(g3, windowOf(null, input.now)),
    toMeasurement(g4, windowOf(null, input.now), {
      fee_samples: input.reconciliation.feeSamples,
      slippage_samples: input.reconciliation.slippageSamples,
    }),
    toMeasurement(g5, windowOf(oldestClock, input.now)),
    toMeasurement(g6, windowOf(null, input.now)),
  ];

  return {
    measurements,
    overall: overallStatus([g1, g2, g3, g4, g5, g6]),
  };
}

/** Days a clock has been running, for the soak and G2 windows. */
export function daysBetween(from: Date | null, to: Date): number {
  if (from === null) {
    return 0;
  }
  return (to.getTime() - from.getTime()) / DAY_MS;
}
