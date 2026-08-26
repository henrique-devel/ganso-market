// RFC-013 task 8: continuous gate measurement.
//
// gates.test.ts already proves each verdict as arithmetic. What is tested here
// is the ASSEMBLY: that the right recorded rows become the right gate input,
// including the two the RFC calls out by name —
//
//   * "reset do G2 ao injetar mudança de fee schedule" (a mandatory test), and
//   * labels without leakage, which starts with refusing to score the rows a
//     Brier score cannot honestly be taken over.

import { describe, expect, it } from "vitest";

import { DEFAULT_PORTFOLIO_CONFIG } from "../../../src/polymarket/portfolio/config.js";
import {
  measureGates,
  planClockResets,
  reconcile,
  regimeFingerprint,
  selectForecasts,
  type ForecastRow,
  type MeasureGatesInput,
  type RegimeParams,
} from "../../../src/polymarket/portfolio/measure.js";
import { BREAKER_KINDS } from "../../../src/polymarket/portfolio/types.js";

const NOW = new Date("2026-08-26T12:00:00Z");
const GATES = DEFAULT_PORTFOLIO_CONFIG.gates;

const CRYPTO_PARAMS: RegimeParams[] = [
  {
    feeBaseBps: "700",
    makerFeeBps: "0",
    takerFeeBps: "700",
    tickSize: "0.01",
    minOrderSize: "5",
    negRisk: false,
  },
];

describe("regime fingerprint (G5)", () => {
  it("is stable when a market joins with the same parameters", () => {
    // The universe growing is not a regime change, and resetting a 59-day clock
    // because it grew would throw away evidence for nothing.
    const one = regimeFingerprint(CRYPTO_PARAMS);
    const two = regimeFingerprint([...CRYPTO_PARAMS, ...CRYPTO_PARAMS]);
    expect(two).toBe(one);
  });

  it("changes when the fee schedule changes", () => {
    const changed = regimeFingerprint([
      { ...CRYPTO_PARAMS[0]!, takerFeeBps: "300" },
    ]);
    expect(changed).not.toBe(regimeFingerprint(CRYPTO_PARAMS));
  });

  it("changes when the tick size changes", () => {
    const changed = regimeFingerprint([
      { ...CRYPTO_PARAMS[0]!, tickSize: "0.001" },
    ]);
    expect(changed).not.toBe(regimeFingerprint(CRYPTO_PARAMS));
  });
});

describe("the G2 clock resets on a regime change", () => {
  const fingerprint = regimeFingerprint(CRYPTO_PARAMS);

  it("starts a clock for a category that has none", () => {
    const plans = planClockResets({
      clocks: [],
      currentFingerprints: { crypto: fingerprint },
      now: NOW,
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.reason).toBe("clock_started");
    expect(plans[0]?.previousStart).toBeNull();
  });

  it("leaves a clock alone while the regime holds", () => {
    const plans = planClockResets({
      clocks: [
        {
          category: "crypto",
          clockStart: new Date("2026-06-01T00:00:00Z"),
          regimeFingerprint: fingerprint,
          lastResetReason: null,
        },
      ],
      currentFingerprints: { crypto: fingerprint },
      now: NOW,
    });
    expect(plans).toEqual([]);
  });

  it("RESETS the clock when an injected fee schedule change lands", () => {
    // The RFC's mandatory test. A reset is not a smaller number averaged in: it
    // throws the elapsed days away, because they were measured under a regime
    // that no longer exists.
    const changed = regimeFingerprint([
      { ...CRYPTO_PARAMS[0]!, takerFeeBps: "300" },
    ]);
    const clockStart = new Date("2026-06-01T00:00:00Z");
    const plans = planClockResets({
      clocks: [
        {
          category: "crypto",
          clockStart,
          regimeFingerprint: fingerprint,
          lastResetReason: null,
        },
      ],
      currentFingerprints: { crypto: changed },
      now: NOW,
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.reason).toBe("regime_fingerprint_changed");
    expect(plans[0]?.previousStart).toEqual(clockStart);
    expect(plans[0]?.newStart).toEqual(NOW);
    expect(plans[0]?.previousFingerprint).toBe(fingerprint);
    expect(plans[0]?.newFingerprint).toBe(changed);
  });

  it("resets only the affected category", () => {
    // "reseta o relógio do G2 para as categorias afetadas" — the RFC is precise
    // about the scope, and fees differ by category.
    const changed = regimeFingerprint([
      { ...CRYPTO_PARAMS[0]!, takerFeeBps: "300" },
    ]);
    const plans = planClockResets({
      clocks: [
        {
          category: "crypto",
          clockStart: new Date("2026-06-01T00:00:00Z"),
          regimeFingerprint: fingerprint,
          lastResetReason: null,
        },
        {
          category: "macro",
          clockStart: new Date("2026-06-01T00:00:00Z"),
          regimeFingerprint: fingerprint,
          lastResetReason: null,
        },
      ],
      currentFingerprints: { crypto: changed, macro: fingerprint },
      now: NOW,
    });
    expect(plans.map((plan) => plan.category)).toEqual(["crypto"]);
  });
});

describe("forecast selection (G1)", () => {
  const base: ForecastRow = {
    conditionId: "0xa",
    modelProbability: 0.7,
    marketProbability: 0.6,
    label: "1",
    outcomeKnownAt: new Date("2026-08-20T00:00:00Z"),
    forecastAt: new Date("2026-08-19T00:00:00Z"),
    source: "MODEL",
  };

  it("keeps a clean binary forecast", () => {
    const selection = selectForecasts([base]);
    expect(selection.forecasts).toHaveLength(1);
    expect(selection.forecasts[0]?.outcome).toBe(1);
  });

  it("EXCLUDES a 0.50 label and counts it", () => {
    // A 50/50 UMA report is a real outcome on this venue, but it is not binary:
    // scoring it as 0 or 1 would be inventing an answer. The count matters
    // because a book full of 50/50s must not look like a clean sample.
    const selection = selectForecasts([{ ...base, label: "0.5" }]);
    expect(selection.forecasts).toHaveLength(0);
    expect(selection.excluded.fifty_fifty_label).toBe(1);
  });

  it("EXCLUDES a row with no publicly-knowable instant", () => {
    // With no instant to compare against, the leakage check cannot run, and a
    // forecast whose honesty cannot be checked is not evidence.
    const selection = selectForecasts([{ ...base, outcomeKnownAt: null }]);
    expect(selection.forecasts).toHaveLength(0);
    expect(selection.excluded.no_outcome_instant).toBe(1);
  });

  it("EXCLUDES a row with no recorded market probability", () => {
    // G1 requires beating the price, which needs the price.
    const selection = selectForecasts([{ ...base, marketProbability: null }]);
    expect(selection.forecasts).toHaveLength(0);
    expect(selection.excluded.no_market_probability).toBe(1);
  });
});

describe("reconciliation (G4)", () => {
  it("reports positive bias when the simulator was more expensive than the book", () => {
    // Conservative, and acceptable: paying more than the book would have is not
    // the direction that makes a paper record meaningless.
    const result = reconcile([
      {
        side: "BUY",
        simulatedFeeUsd: 0.5,
        realFeeUsd: 0.5,
        simulatedPrice: 0.52,
        bookWalkPrice: 0.5,
      },
    ]);
    expect(result.slippageBias).toBeCloseTo(0.02, 6);
    expect(result.feeMedianError).toBe(0);
  });

  it("reports NEGATIVE bias when the simulator filled better than the book", () => {
    // This is the optimistic bias the RFC forbids, and evaluateG4 fails on it.
    const result = reconcile([
      {
        side: "BUY",
        simulatedFeeUsd: 0.5,
        realFeeUsd: 0.5,
        simulatedPrice: 0.48,
        bookWalkPrice: 0.5,
      },
    ]);
    expect(result.slippageBias).toBeLessThan(0);
  });

  it("flips the sign for a SELL: receiving less is the conservative side", () => {
    const result = reconcile([
      {
        side: "SELL",
        simulatedFeeUsd: 0,
        realFeeUsd: null,
        simulatedPrice: 0.48,
        bookWalkPrice: 0.5,
      },
    ]);
    expect(result.slippageBias).toBeCloseTo(0.02, 6);
    expect(result.feeMedianError).toBeNull();
    expect(result.feeSamples).toBe(0);
  });

  it("returns nulls with nothing to compare, so G4 stays INSUFFICIENT_DATA", () => {
    const result = reconcile([]);
    expect(result.feeMedianError).toBeNull();
    expect(result.slippageBias).toBeNull();
  });
});

describe("the full measurement", () => {
  const EMPTY: MeasureGatesInput = {
    now: NOW,
    config: GATES,
    forecastRows: [],
    closed: [],
    clockStart: null,
    unblockedBreaches: 0,
    maxDrawdown: 0,
    drawdownMax: 0.1,
    breakersExercised: [],
    reconciliation: {
      feeMedianError: null,
      slippageBias: null,
      feeSamples: 0,
      slippageSamples: 0,
    },
    soakDays: 0,
    killSwitchExercised: false,
    reduceOnlyExercised: false,
    clocks: [],
    currentFingerprints: {},
    approval: null,
    currentReportId: null,
  };

  it("produces exactly one row per gate", () => {
    const result = measureGates(EMPTY);
    expect(result.measurements.map((m) => m.gate)).toEqual([
      "G1",
      "G2",
      "G3",
      "G4",
      "G5",
      "G6",
    ]);
  });

  it("keeps RFC-009 BLOCKED on a fresh engine, and says INSUFFICIENT_DATA", () => {
    // The honest state of a portfolio that has not traded: not enough evidence,
    // deliberately distinct from "we measured and it did not work".
    const result = measureGates(EMPTY);
    expect(result.overall).toBe("BLOCKED");
    const g2 = result.measurements.find((m) => m.gate === "G2");
    expect(g2?.status).toBe("INSUFFICIENT_DATA");
    expect(g2?.reasonCode).toBe("G2_INSUFFICIENT_PAPER");
  });

  it("every non-PASS row carries a reason code", () => {
    // The migration's CHECK enforces this at the database; the measurement must
    // not be the thing that trips it.
    for (const measurement of measureGates(EMPTY).measurements) {
      if (measurement.status !== "PASS") {
        expect(measurement.reasonCode, measurement.gate).not.toBeNull();
      }
    }
  });

  it("G3 fails until EVERY breaker kind has been exercised", () => {
    const partial = measureGates({
      ...EMPTY,
      breakersExercised: [...BREAKER_KINDS].slice(0, 2),
    });
    const g3 = partial.measurements.find((m) => m.gate === "G3");
    expect(g3?.status).toBe("FAIL");
    expect(g3?.reasonCode).toBe("G3_RISK_BREACH");

    const complete = measureGates({
      ...EMPTY,
      breakersExercised: [...BREAKER_KINDS],
    });
    expect(complete.measurements.find((m) => m.gate === "G3")?.status).toBe(
      "PASS",
    );
  });

  it("G1 records what it excluded, so the sample cannot be read as clean", () => {
    const result = measureGates({
      ...EMPTY,
      forecastRows: [
        {
          conditionId: "0xa",
          modelProbability: 0.7,
          marketProbability: 0.6,
          label: "0.5",
          outcomeKnownAt: new Date("2026-08-20T00:00:00Z"),
          forecastAt: new Date("2026-08-19T00:00:00Z"),
          source: "MODEL",
        },
      ],
    });
    const g1 = result.measurements.find((m) => m.gate === "G1");
    expect(g1?.metrics.candidate_rows).toBe(1);
    expect(g1?.metrics.scored_forecasts).toBe(0);
    expect(g1?.status).toBe("INSUFFICIENT_DATA");
  });

  it("G1 FAILS on a leaking label rather than scoring it", () => {
    // A forecast made at or after the outcome was knowable is not a forecast,
    // and one such row poisons the whole score.
    const leaking = Array.from({ length: 120 }, (_, index) => ({
      conditionId: `0x${String(index)}`,
      modelProbability: 0.9,
      marketProbability: 0.5,
      label: index % 2 === 0 ? "1" : "0",
      outcomeKnownAt: new Date("2026-08-20T00:00:00Z"),
      // AFTER the outcome was knowable.
      forecastAt: new Date("2026-08-21T00:00:00Z"),
      source: "MODEL",
    }));
    const g1 = measureGates({
      ...EMPTY,
      forecastRows: leaking,
    }).measurements.find((m) => m.gate === "G1");
    expect(g1?.status).toBe("FAIL");
    expect(g1?.reasonCode).toBe("G1_CALIBRATION_NOT_MET");
    expect(g1?.metrics.leaking_forecasts).toBe(120);
  });

  it("one non-PASS gate is enough to keep the verdict BLOCKED", () => {
    // No weighting, no "mostly passing", no override.
    const result = measureGates({
      ...EMPTY,
      breakersExercised: [...BREAKER_KINDS],
    });
    expect(
      result.measurements.filter((m) => m.status === "PASS").length,
    ).toBeGreaterThan(0);
    expect(result.overall).toBe("BLOCKED");
  });
});
