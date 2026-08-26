import { describe, expect, it } from "vitest";

import {
  blockBootstrapMean,
  brierScore,
  brierSkillScore,
  createSeededRandom,
  logLoss,
} from "../../../src/polymarket/portfolio/bootstrap.js";
import { DEFAULT_PORTFOLIO_CONFIG } from "../../../src/polymarket/portfolio/config.js";
import {
  CALIBRATED_EXPECTATION,
  evaluateG1,
  evaluateG2,
  evaluateG3,
  evaluateG4,
  evaluateG5,
  evaluateG6,
  overallStatus,
  type GateResult,
  type ResolvedForecast,
} from "../../../src/polymarket/portfolio/gates.js";
import { GATE_IDS } from "../../../src/polymarket/portfolio/types.js";

const GATES = DEFAULT_PORTFOLIO_CONFIG.gates;
const NOW = new Date("2026-12-01T00:00:00Z");
const DAY_MS = 24 * 3_600_000;

describe("seeded randomness", () => {
  it("is reproducible: an irreproducible gate is not a gate", () => {
    const a = createSeededRandom(12345);
    const b = createSeededRandom(12345);
    const first = Array.from({ length: 20 }, () => a());
    const second = Array.from({ length: 20 }, () => b());
    expect(first).toEqual(second);
  });

  it("produces different sequences for different seeds", () => {
    const a = createSeededRandom(1);
    const b = createSeededRandom(2);
    expect(a()).not.toBe(b());
  });

  it("stays inside [0, 1)", () => {
    const random = createSeededRandom(7);
    for (let i = 0; i < 1_000; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("block bootstrap", () => {
  const positive = Array.from(
    { length: 200 },
    (_unused, i) => 1 + (i % 3) * 0.1,
  );

  it("is reproducible with the same seed and inputs", () => {
    const a = blockBootstrapMean({
      samples: positive,
      resamples: 500,
      blockSize: 10,
      seed: 42,
      haircut: 0.5,
    });
    const b = blockBootstrapMean({
      samples: positive,
      resamples: 500,
      blockSize: 10,
      seed: 42,
      haircut: 0.5,
    });
    expect(a.ciLow).toBe(b.ciLow);
    expect(a.ciHigh).toBe(b.ciHigh);
  });

  it("applies the haircut to the DATA, before the interval is taken", () => {
    const result = blockBootstrapMean({
      samples: positive,
      resamples: 500,
      blockSize: 10,
      seed: 42,
      haircut: 0.5,
    });
    // Haircutting the bound instead of the data would answer a different
    // question; here the mean halves and the interval follows it down.
    expect(result.haircutMean).toBeCloseTo(result.mean * 0.5, 10);
    expect(result.ciHigh).toBeLessThan(result.mean);
  });

  it("clears zero for a consistently profitable series", () => {
    const result = blockBootstrapMean({
      samples: positive,
      resamples: 1_000,
      blockSize: 10,
      seed: GATES.bootstrapSeed,
      haircut: 0.5,
    });
    expect(result.aboveZero).toBe(true);
    expect(result.ciLow).toBeGreaterThan(0);
  });

  it("does NOT clear zero for a noisy series that merely averages positive", () => {
    // Many small wins and a few large losses — the shape of a book that looks
    // profitable right up until the tail arrives. The point estimate is up, but
    // the interval straddles zero and the gate has to say so.
    //
    // (Strict alternation would NOT work as a fixture: every block then holds
    // the same mix, which makes the resample mean unusually stable.)
    const noisy = Array.from({ length: 200 }, (_unused, i) =>
      i % 37 === 0 ? -26 : 1,
    );
    const result = blockBootstrapMean({
      samples: noisy,
      resamples: 1_000,
      blockSize: 10,
      seed: GATES.bootstrapSeed,
      haircut: 0.5,
    });
    expect(result.mean).toBeGreaterThan(0);
    expect(result.aboveZero).toBe(false);
  });

  it("never clears zero on an empty series", () => {
    const result = blockBootstrapMean({
      samples: [],
      resamples: 100,
      blockSize: 10,
      seed: 1,
      haircut: 0.5,
    });
    expect(result.aboveZero).toBe(false);
    expect(result.n).toBe(0);
  });

  it("uses BLOCKS: a longer block widens the interval on serial data", () => {
    // Runs of the same sign are the dependence an i.i.d. bootstrap would
    // pretend away, producing a falsely tight interval.
    const serial = Array.from({ length: 200 }, (_unused, i) =>
      Math.floor(i / 20) % 2 === 0 ? 5 : -3,
    );
    const short = blockBootstrapMean({
      samples: serial,
      resamples: 1_000,
      blockSize: 1,
      seed: 99,
      haircut: 0,
    });
    const long = blockBootstrapMean({
      samples: serial,
      resamples: 1_000,
      blockSize: 25,
      seed: 99,
      haircut: 0,
    });
    expect(long.ciHigh - long.ciLow).toBeGreaterThan(
      short.ciHigh - short.ciLow,
    );
  });
});

describe("scoring", () => {
  it("computes Brier and log loss, and a skill score against the price", () => {
    const perfect = [{ probability: 1, outcome: 1 as const }];
    expect(brierScore(perfect)).toBe(0);
    expect(logLoss(perfect)).toBeCloseTo(0, 5);

    const coinflip = [
      { probability: 0.5, outcome: 1 as const },
      { probability: 0.5, outcome: 0 as const },
    ];
    expect(brierScore(coinflip)).toBeCloseTo(0.25, 10);
    expect(brierSkillScore(0.05, 0.074)).toBeGreaterThan(0);
    expect(brierSkillScore(0.1, 0.074)).toBeLessThan(0);
  });
});

function forecast(overrides: Partial<ResolvedForecast> = {}): ResolvedForecast {
  return {
    conditionId: "0xa",
    modelProbability: 0.9,
    marketProbability: 0.7,
    outcome: 1,
    forecastAt: new Date("2026-08-01T00:00:00Z"),
    outcomeKnownAt: new Date("2026-08-02T00:00:00Z"),
    ...overrides,
  };
}

describe("G1 — calibration", () => {
  it("FAILS closed on a leaking label, before scoring anything", () => {
    // A forecast made at or after the outcome was knowable is not a forecast.
    const result = evaluateG1({
      forecasts: [
        forecast(),
        forecast({
          conditionId: "0xleak",
          forecastAt: new Date("2026-08-03T00:00:00Z"),
        }),
      ],
      config: GATES,
    });
    expect(result.status).toBe("FAIL");
    expect(result.metrics.leaking_forecasts).toBe(1);
  });

  it("reports INSUFFICIENT_DATA below the resolved-market floor", () => {
    const result = evaluateG1({
      forecasts: [forecast()],
      config: GATES,
    });
    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect(result.metrics.required).toBe(100);
  });

  it("PASSES when the model beats the price and clears the ceiling", () => {
    const forecasts = Array.from({ length: 120 }, (_unused, i) =>
      forecast({
        conditionId: `0x${String(i)}`,
        outcome: i % 2 === 0 ? 1 : 0,
        modelProbability: i % 2 === 0 ? 0.85 : 0.15,
        marketProbability: i % 2 === 0 ? 0.7 : 0.3,
      }),
    );
    const result = evaluateG1({ forecasts, config: GATES });
    expect(result.status).toBe("PASS");
    expect(result.metrics.beats_price).toBe(true);
    expect(Number(result.metrics.brier_skill_score)).toBeGreaterThan(0);
  });

  it("FAILS a model that cannot beat the market price, however low its Brier", () => {
    // "Did not beat the price" is not evidence of anything, even at a good
    // absolute score.
    const forecasts = Array.from({ length: 120 }, (_unused, i) =>
      forecast({
        conditionId: `0x${String(i)}`,
        outcome: i % 2 === 0 ? 1 : 0,
        modelProbability: i % 2 === 0 ? 0.8 : 0.2,
        marketProbability: i % 2 === 0 ? 0.95 : 0.05,
      }),
    );
    const result = evaluateG1({ forecasts, config: GATES });
    expect(result.status).toBe("FAIL");
    expect(result.metrics.beats_price).toBe(false);
    expect(result.reasonCode).toBe("G1_CALIBRATION_NOT_MET");
  });
});

function closed(count: number, pnl: (i: number) => number, markets = 40) {
  return Array.from({ length: count }, (_unused, i) => ({
    pnl: pnl(i),
    conditionId: `0x${String(i % markets)}`,
    category: i % 2 === 0 ? "crypto" : "macro",
    closedAt: new Date(NOW.getTime() - (count - i) * 3_600_000),
  }));
}

describe("G2 — paper with realism", () => {
  const clockStart = new Date(NOW.getTime() - 90 * DAY_MS);

  it("separates INSUFFICIENT_DATA from FAIL", () => {
    // A young track record is not a rejection, and a rejection is not youth.
    const young = evaluateG2({
      closed: closed(10, () => 1),
      clockStart: new Date(NOW.getTime() - 10 * DAY_MS),
      now: NOW,
      config: GATES,
    });
    expect(young.status).toBe("INSUFFICIENT_DATA");
    expect(young.bootstrap).toBeNull();
  });

  it("names every shortfall, not just the first", () => {
    const result = evaluateG2({
      closed: closed(5, () => 1, 2),
      clockStart: new Date(NOW.getTime() - 5 * DAY_MS),
      now: NOW,
      config: GATES,
    });
    const shortfalls = result.metrics.shortfalls as Record<string, unknown>;
    expect(Object.keys(shortfalls).sort()).toEqual([
      "closed_positions",
      "days",
      "distinct_markets",
    ]);
  });

  it("PASSES a profitable run whose interval clears zero after the haircut", () => {
    const result = evaluateG2({
      closed: closed(150, (i) => 2 + (i % 5) * 0.2),
      clockStart,
      now: NOW,
      config: GATES,
    });
    expect(result.status).toBe("PASS");
    expect(Number(result.metrics.ci95_low)).toBeGreaterThan(0);
    expect(Number(result.metrics.mean_pnl_after_haircut)).toBeCloseTo(
      Number(result.metrics.mean_pnl) * 0.5,
      6,
    );
  });

  it("records NO_EVIDENCE_OF_ALPHA when the interval straddles zero", () => {
    const result = evaluateG2({
      closed: closed(150, (i) => (i % 37 === 0 ? -26 : 1)),
      clockStart,
      now: NOW,
      config: GATES,
    });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("NO_EVIDENCE_OF_ALPHA");
  });

  it("requires at least two categories, not just many markets", () => {
    const singleCategory = closed(150, () => 2).map((position) => ({
      ...position,
      category: "crypto",
    }));
    const result = evaluateG2({
      closed: singleCategory,
      clockStart,
      now: NOW,
      config: GATES,
    });
    expect(result.status).toBe("INSUFFICIENT_DATA");
  });
});

describe("G3 — risk survival", () => {
  const required = ["UMA_PROPOSED_OR_DISPUTED", "PRICE_JUMP_NO_CATALYST"];

  it("passes only with zero unblocked breaches and every breaker exercised", () => {
    expect(
      evaluateG3({
        unblockedBreaches: 0,
        maxDrawdown: 0.05,
        drawdownMax: 0.1,
        breakersExercised: required,
        breakersRequired: required,
      }).status,
    ).toBe("PASS");
  });

  it("fails on a single unblocked breach", () => {
    expect(
      evaluateG3({
        unblockedBreaches: 1,
        maxDrawdown: 0.01,
        drawdownMax: 0.1,
        breakersExercised: required,
        breakersRequired: required,
      }).status,
    ).toBe("FAIL");
  });

  it("fails and names the breakers never demonstrated", () => {
    const result = evaluateG3({
      unblockedBreaches: 0,
      maxDrawdown: 0.01,
      drawdownMax: 0.1,
      breakersExercised: ["UMA_PROPOSED_OR_DISPUTED"],
      breakersRequired: required,
    });
    expect(result.status).toBe("FAIL");
    expect(result.metrics.breakers_missing).toEqual(["PRICE_JUMP_NO_CATALYST"]);
  });
});

describe("G4 — reconciliation", () => {
  const base = {
    feeMedianError: 0.02,
    slippageBias: 0.001,
    soakDays: 40,
    killSwitchExercised: true,
    reduceOnlyExercised: true,
    config: GATES,
  };

  it("passes a reconciled, soaked, exercised system", () => {
    expect(evaluateG4(base).status).toBe("PASS");
  });

  it("is one-sided on slippage: simulating LESS than reality fails", () => {
    // Over-simulating slippage is conservative and fine; under-simulating is
    // the optimistic bias the RFC forbids.
    const optimistic = evaluateG4({ ...base, slippageBias: -0.001 });
    expect(optimistic.status).toBe("FAIL");
    expect(optimistic.metrics.slippage_optimistic).toBe(true);

    expect(evaluateG4({ ...base, slippageBias: 0.05 }).status).toBe("PASS");
  });

  it("fails a fee model off by more than the ceiling", () => {
    expect(evaluateG4({ ...base, feeMedianError: 0.2 }).status).toBe("FAIL");
  });

  it("reports INSUFFICIENT_DATA before any fill has been reconciled", () => {
    const result = evaluateG4({
      ...base,
      feeMedianError: null,
      slippageBias: null,
    });
    expect(result.status).toBe("INSUFFICIENT_DATA");
  });
});

describe("G5 — regime freshness", () => {
  it("fails when a category's fingerprint changed without a clock reset", () => {
    // The evidence being counted was gathered under a regime that is gone.
    const result = evaluateG5({
      clocks: [
        {
          category: "crypto",
          clockStart: new Date(NOW.getTime() - 120 * DAY_MS),
          regimeFingerprint: "a".repeat(64),
          lastResetReason: null,
        },
      ],
      currentFingerprints: { crypto: "b".repeat(64) },
      now: NOW,
      config: GATES,
    });
    expect(result.status).toBe("FAIL");
    expect(result.metrics.fingerprint_mismatch).toEqual(["crypto"]);
  });

  it("reports INSUFFICIENT_DATA for a clock younger than the G2 window", () => {
    const result = evaluateG5({
      clocks: [
        {
          category: "crypto",
          clockStart: new Date(NOW.getTime() - 10 * DAY_MS),
          regimeFingerprint: "a".repeat(64),
          lastResetReason: "fee_schedule_changed",
        },
      ],
      currentFingerprints: { crypto: "a".repeat(64) },
      now: NOW,
      config: GATES,
    });
    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect(result.metrics.below_minimum_days).toEqual(["crypto"]);
  });

  it("passes when every category is fresh and old enough", () => {
    const result = evaluateG5({
      clocks: [
        {
          category: "crypto",
          clockStart: new Date(NOW.getTime() - 120 * DAY_MS),
          regimeFingerprint: "a".repeat(64),
          lastResetReason: null,
        },
      ],
      currentFingerprints: { crypto: "a".repeat(64) },
      now: NOW,
      config: GATES,
    });
    expect(result.status).toBe("PASS");
  });
});

describe("G6 — approval", () => {
  it("is INSUFFICIENT_DATA with no written review", () => {
    expect(evaluateG6({ approval: null, currentReportId: 5 }).status).toBe(
      "INSUFFICIENT_DATA",
    );
  });

  it("does NOT carry a review of an older report forward", () => {
    // The numbers that review approved are not the numbers on the table.
    const result = evaluateG6({
      approval: {
        reviewedAt: NOW,
        reviewer: "owner",
        note: "ok",
        reportId: 4,
      },
      currentReportId: 5,
    });
    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect(result.metrics.matches_current_report).toBe(false);
  });

  it("passes on a review of the report under consideration", () => {
    expect(
      evaluateG6({
        approval: {
          reviewedAt: NOW,
          reviewer: "owner",
          note: "ok",
          reportId: 5,
        },
        currentReportId: 5,
      }).status,
    ).toBe("PASS");
  });
});

describe("overall verdict", () => {
  const pass = (gate: (typeof GATE_IDS)[number]): GateResult => ({
    gate,
    status: "PASS",
    reasonCode: null,
    metrics: {},
  });

  it("is READY only when EVERY gate passes", () => {
    expect(overallStatus(GATE_IDS.map(pass))).toBe("READY_FOR_OWNER_REVIEW");
  });

  it("is BLOCKED when a single gate is anything else", () => {
    for (const status of ["FAIL", "INSUFFICIENT_DATA"] as const) {
      const results = GATE_IDS.map(pass);
      results[3] = { ...results[3]!, status };
      expect(overallStatus(results)).toBe("BLOCKED");
    }
  });

  it("carries the calibrated expectation, so a pass is never read as a promise", () => {
    expect(CALIBRATED_EXPECTATION).toContain("84%");
    expect(CALIBRATED_EXPECTATION).toContain("não promete lucro");
  });
});
