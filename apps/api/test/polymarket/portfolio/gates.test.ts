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
  paperEvidenceBase,
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
      modelForecasts: [],
      config: GATES,
    });
    expect(result.status).toBe("FAIL");
    expect(result.metrics.leaking_forecasts).toBe(1);
  });

  it("reports INSUFFICIENT_DATA below the resolved-market floor", () => {
    const result = evaluateG1({
      forecasts: [forecast()],
      modelForecasts: [forecast()],
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
    const result = evaluateG1({
      forecasts,
      modelForecasts: forecasts,
      config: GATES,
    });
    expect(result.status).toBe("PASS");
    expect(result.metrics.beats_price).toBe(true);
    expect(Number(result.metrics.brier_skill_score)).toBeGreaterThan(0);
  });

  it("NEVER passes on a market baseline alone, however good the price is", () => {
    // The production bug of 2026-08-26. With no promoted model the RFC-010
    // estimator falls back to the book, so `q` IS the market probability. The
    // Brier scores tie, "does not worsen the price" is trivially satisfied, and
    // the absolute ceiling is cleared because the PRICE is well calibrated — so
    // every condition passed and nothing had been measured.
    //
    // 120 markets, a well-calibrated price, and the baseline copying it exactly.
    const baseline = Array.from({ length: 120 }, (_unused, i) => {
      const price = i % 2 === 0 ? 0.9 : 0.1;
      return forecast({
        conditionId: `0x${String(i)}`,
        outcome: i % 2 === 0 ? 1 : 0,
        modelProbability: price,
        marketProbability: price,
      });
    });
    const result = evaluateG1({
      forecasts: baseline,
      // The whole point: no promoted model produced any of them.
      modelForecasts: [],
      config: GATES,
    });
    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect(result.status).not.toBe("PASS");
    expect(result.metrics.model_forecasts).toBe(0);
    expect(String(result.metrics.detail)).toContain("no promoted model");
    // The used signal is still measured and reported — it just is not evidence
    // that a MODEL beat anything.
    expect(result.metrics.under_ceiling).toBe(true);
    expect(Number(result.metrics.used_signal_brier)).toBeLessThan(0.2);
  });

  it("stays INSUFFICIENT_DATA when a model exists but on too few markets", () => {
    const used = Array.from({ length: 120 }, (_unused, i) =>
      forecast({ conditionId: `0x${String(i)}` }),
    );
    const result = evaluateG1({
      forecasts: used,
      modelForecasts: used.slice(0, 40),
      config: GATES,
    });
    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect(result.metrics.model_resolved_markets).toBe(40);
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
    const result = evaluateG1({
      forecasts,
      modelForecasts: forecasts,
      config: GATES,
    });
    expect(result.status).toBe("FAIL");
    expect(result.metrics.beats_price).toBe(false);
    expect(result.reasonCode).toBe("G1_CALIBRATION_NOT_MET");
  });
});

/**
 * Closed positions SPREAD over the window: one every twelve hours, cycling
 * through markets and two categories.
 *
 * Spread on purpose. Counts alone are also satisfied by a hundred positions
 * closed inside one afternoon, and that shape is what `burst` below produces.
 */
function closed(count: number, pnl: (i: number) => number, markets = 40) {
  return Array.from({ length: count }, (_unused, i) => ({
    pnl: pnl(i),
    conditionId: `0x${String(i % markets)}`,
    category: i % 2 === 0 ? "crypto" : "macro",
    closedAt: new Date(NOW.getTime() - (count - i) * (DAY_MS / 2)),
  }));
}

/** The same book, closed inside a single afternoon. */
function burst(count: number, pnl: (i: number) => number, markets = 40) {
  return Array.from({ length: count }, (_unused, i) => ({
    pnl: pnl(i),
    conditionId: `0x${String(i % markets)}`,
    category: i % 2 === 0 ? "crypto" : "macro",
    closedAt: new Date(NOW.getTime() - (count - i) * 60_000),
  }));
}

/** The evidence base G3 is taken over, from the same closed positions. */
function evidenceOf(
  positions: ReturnType<typeof closed>,
  clockStart: Date | null,
) {
  return paperEvidenceBase({
    closed: positions,
    clockStart,
    now: NOW,
    config: GATES,
  });
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
      "bootstrap_blocks",
      "closed_positions",
      "days",
      "distinct_close_days",
      "distinct_markets",
    ]);
  });

  it("NEVER counts an uncategorized position as a category", () => {
    // The degeneration this replaced: `position.category ?? "unknown"` made the
    // ABSENCE of a category behave as the presence of one. With
    // `g2MinCategories` at 2 and exactly two tracked categories in the
    // universe, a book of nothing but crypto plus a single market whose
    // category had been lost satisfied the breadth requirement — the gate
    // reporting diversity it never saw.
    //
    // Both books below have the same 150 positions and the same shape; only
    // the category of the odd-indexed ones differs.
    const oneRealCategory = Array.from({ length: 150 }, (_unused, i) => ({
      pnl: 2 + (i % 5) * 0.2,
      conditionId: `0x${String(i % 40)}`,
      category: i % 2 === 0 ? "crypto" : null,
      closedAt: new Date(NOW.getTime() - (150 - i) * (DAY_MS / 2)),
    }));

    const result = evaluateG2({
      closed: oneRealCategory,
      clockStart,
      now: NOW,
      config: GATES,
    });

    // One NAMED category, and the uncategorized half counted rather than
    // bucketed. The same book with `crypto`/`macro` PASSES (test above), so the
    // only thing standing between this book and a pass is the missing category.
    expect(result.metrics.categories).toBe(1);
    expect(result.metrics.uncategorized_positions).toBe(75);
    expect(result.status).toBe("INSUFFICIENT_DATA");
    const shortfalls = result.metrics.shortfalls as Record<string, unknown>;
    expect(shortfalls.categories).toEqual({
      have: 1,
      need: GATES.g2MinCategories,
      uncategorized_positions: 75,
    });
  });

  it("counts uncategorized positions even when the gate passes", () => {
    // The number has to be visible on a PASS too: it is how a reader learns
    // that breadth evidence went unattributed, and a metric that only appears
    // on failure cannot be trended.
    const result = evaluateG2({
      closed: closed(150, (i) => 2 + (i % 5) * 0.2),
      clockStart,
      now: NOW,
      config: GATES,
    });
    expect(result.status).toBe("PASS");
    expect(result.metrics.categories).toBe(2);
    expect(result.metrics.uncategorized_positions).toBe(0);
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

  it("NEVER passes on a constant PnL series, however positive", () => {
    // The G1 failure mode in G2's clothing. Every resample of a constant series
    // returns the identical mean, so the 95% interval collapses to a point and
    // `ciLow > 0` is arithmetic on that point rather than a statement about
    // uncertainty. A hundred binary-market positions that all realized exactly
    // the same PnL is an artifact of how the number was produced.
    const constant = evaluateG2({
      closed: closed(150, () => 1),
      clockStart,
      now: NOW,
      config: GATES,
    });
    expect(constant.status).toBe("INSUFFICIENT_DATA");
    expect(constant.status).not.toBe("PASS");
    expect(constant.metrics.degenerate_interval).toBe(true);
    expect(constant.metrics.ci95_width).toBe(0);
    // The point estimate is up — which is exactly why the old gate passed.
    expect(constant.bootstrap?.aboveZero).toBe(true);
  });

  it("NEVER passes on a burst: every close inside one afternoon", () => {
    // Sixty days on the clock, and every position closed within a couple of
    // hours of the others. Every count in the RFC is satisfied and the block
    // bootstrap resamples a single market episode.
    const result = evaluateG2({
      closed: burst(150, (i) => 2 + (i % 5) * 0.2),
      clockStart,
      now: NOW,
      config: GATES,
    });
    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect(result.status).not.toBe("PASS");
    const shortfalls = result.metrics.shortfalls as Record<string, unknown>;
    expect(Object.keys(shortfalls)).toEqual(["distinct_close_days"]);
  });

  it("NEVER passes when one position is most of the money the book moved", () => {
    const result = evaluateG2({
      closed: closed(150, (i) => (i === 100 ? 10 : 0.01)),
      clockStart,
      now: NOW,
      config: GATES,
    });
    expect(result.status).toBe("INSUFFICIENT_DATA");
    const shortfalls = result.metrics.shortfalls as Record<string, unknown>;
    expect(Object.keys(shortfalls)).toEqual(["single_position_share"]);
    expect(Number(result.metrics.largest_position_pnl_share)).toBeGreaterThan(
      0.8,
    );
  });

  it("NEVER passes when the sample supports too few independent blocks", () => {
    // A block bootstrap over three blocks is the sample rearranged three ways.
    const result = evaluateG2({
      closed: closed(150, (i) => 2 + (i % 5) * 0.2),
      clockStart,
      now: NOW,
      config: { ...GATES, bootstrapBlockSize: 40 },
    });
    expect(result.status).toBe("INSUFFICIENT_DATA");
    const shortfalls = result.metrics.shortfalls as Record<string, unknown>;
    expect(Object.keys(shortfalls)).toEqual(["bootstrap_blocks"]);
    expect(result.metrics.bootstrap_blocks).toBe(3);
  });

  it("drops closed positions from BEFORE the clock start", () => {
    // A G5 reset throws the elapsed days away because the regime that produced
    // them is gone. Keeping the positions closed during those days while
    // discarding the days would make the reset cosmetic: the same sample, worn
    // with a shorter clock.
    const beforeReset = Array.from({ length: 120 }, (_unused, i) => ({
      pnl: 2,
      conditionId: `0x${String(i % 40)}`,
      category: i % 2 === 0 ? "crypto" : "macro",
      closedAt: new Date(NOW.getTime() - (120 - i) * DAY_MS - 70 * DAY_MS),
    }));
    const afterReset = Array.from({ length: 50 }, (_unused, i) => ({
      pnl: 1 + (i % 4) * 0.3,
      conditionId: `0x${String(i % 40)}`,
      category: i % 2 === 0 ? "crypto" : "macro",
      closedAt: new Date(NOW.getTime() - (50 - i) * DAY_MS),
    }));
    const result = evaluateG2({
      closed: [...beforeReset, ...afterReset],
      clockStart: new Date(NOW.getTime() - 61 * DAY_MS),
      now: NOW,
      config: GATES,
    });
    // 170 closed positions on the books, 50 inside the window.
    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect(result.metrics.closed_positions).toBe(50);
    const shortfall = (result.metrics.shortfalls as Record<string, unknown>)
      .closed_positions as Record<string, unknown>;
    expect(shortfall.have).toBe(50);
    expect(shortfall.outside_window).toBe(120);
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
  const clockStart = new Date(NOW.getTime() - 90 * DAY_MS);
  const sufficient = evidenceOf(
    closed(150, (i) => 2 + (i % 5) * 0.2),
    clockStart,
  );

  it("passes only with zero unblocked breaches and every breaker exercised", () => {
    expect(
      evaluateG3({
        unblockedBreaches: 0,
        maxDrawdown: 0.05,
        drawdownMax: 0.1,
        breakersExercised: required,
        breakersRequired: required,
        evidence: sufficient,
      }).status,
    ).toBe("PASS");
  });

  it("NEVER passes over an empty book, however clean it reads", () => {
    // The G1 failure mode a third time. Zero positions produce zero unblocked
    // breaches and zero drawdown, so every survival fact reads perfect — and
    // the gate used to call that PASS. Nothing was survived, because nothing
    // was ever at risk.
    const result = evaluateG3({
      unblockedBreaches: 0,
      maxDrawdown: 0,
      drawdownMax: 0.1,
      breakersExercised: required,
      breakersRequired: required,
      evidence: evidenceOf([], clockStart),
    });
    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect(result.status).not.toBe("PASS");
    expect(String(result.metrics.detail)).toContain("no risk was survived");
    const evidence = result.metrics.evidence_base as Record<string, unknown>;
    expect(evidence.closed_positions).toBe(0);
  });

  it("is taken over the SAME base G2 requires, shortfall for shortfall", () => {
    // Not "a base of its own that happens to look similar": both gates read one
    // object, so a book too short for G2 is too short for G3 by construction.
    const short = closed(20, () => 1);
    const g2 = evaluateG2({
      closed: short,
      clockStart,
      now: NOW,
      config: GATES,
    });
    const g3 = evaluateG3({
      unblockedBreaches: 0,
      maxDrawdown: 0,
      drawdownMax: 0.1,
      breakersExercised: required,
      breakersRequired: required,
      evidence: evidenceOf(short, clockStart),
    });
    expect(g2.status).toBe("INSUFFICIENT_DATA");
    expect(g3.status).toBe("INSUFFICIENT_DATA");
    const base = g3.metrics.evidence_base as Record<string, unknown>;
    const g2Shortfalls = g2.metrics.shortfalls as Record<string, unknown>;
    const g3Shortfalls = base.shortfalls as Record<string, unknown>;
    expect(Object.keys(g3Shortfalls).length).toBeGreaterThan(0);
    for (const key of Object.keys(g3Shortfalls)) {
      expect(Object.keys(g2Shortfalls)).toContain(key);
    }
  });

  it("fails on a single unblocked breach", () => {
    expect(
      evaluateG3({
        unblockedBreaches: 1,
        maxDrawdown: 0.01,
        drawdownMax: 0.1,
        breakersExercised: required,
        breakersRequired: required,
        evidence: sufficient,
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
      evidence: sufficient,
    });
    expect(result.status).toBe("FAIL");
    expect(result.metrics.breakers_missing).toEqual(["PRICE_JUMP_NO_CATALYST"]);
  });

  it("still reports the breaker demonstrations when the book is short", () => {
    // An injected scenario is a deliberate test, not something the book has to
    // produce on its own — so the information survives; it just stops being
    // sufficient by itself.
    const result = evaluateG3({
      unblockedBreaches: 0,
      maxDrawdown: 0,
      drawdownMax: 0.1,
      breakersExercised: ["UMA_PROPOSED_OR_DISPUTED"],
      breakersRequired: required,
      evidence: evidenceOf([], clockStart),
    });
    expect(result.metrics.breakers_missing).toEqual(["PRICE_JUMP_NO_CATALYST"]);
  });
});

describe("G4 — reconciliation", () => {
  const base = {
    feeMedianError: 0.02,
    slippageBias: 0.001,
    feeSamples: 120,
    slippageSamples: 120,
    selfReferentialFeeSamples: 0,
    selfReferentialSlippageSamples: 0,
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
      feeSamples: 0,
      slippageSamples: 0,
    });
    expect(result.status).toBe("INSUFFICIENT_DATA");
  });

  it("NEVER passes on a handful of samples, however good they look", () => {
    // A median over one sample is that sample; a mean bias over one sample is
    // that sample's sign. Both cleared every bar before this.
    const result = evaluateG4({ ...base, feeSamples: 1, slippageSamples: 1 });
    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect(result.status).not.toBe("PASS");
    expect(result.metrics.samples_required).toBe(GATES.g4MinReconciledFills);
    expect(String(result.metrics.detail)).toContain(
      "not enough independently reconciled fills",
    );
  });

  it("requires the minimum on EACH leg: fees say nothing about slippage", () => {
    expect(evaluateG4({ ...base, slippageSamples: 3 }).status).toBe(
      "INSUFFICIENT_DATA",
    );
    expect(evaluateG4({ ...base, feeSamples: 3 }).status).toBe(
      "INSUFFICIENT_DATA",
    );
  });

  it("NEVER passes when every reference was the simulator's own input", () => {
    // The G1 incident in G4's shape: when the "real" number is re-derived from
    // the same recorded observation the simulator consumed, the fee error is
    // zero and the slippage bias is zero — both clear their bars, and neither
    // measured anything. Those samples never reach the arithmetic, so the
    // counts are zero and the rejected ones are named.
    const result = evaluateG4({
      ...base,
      feeMedianError: null,
      slippageBias: null,
      feeSamples: 0,
      slippageSamples: 0,
      selfReferentialFeeSamples: 400,
      selfReferentialSlippageSamples: 400,
    });
    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect(result.status).not.toBe("PASS");
    expect(result.metrics.self_referential_slippage_samples).toBe(400);
    expect(String(result.metrics.detail)).toContain(
      "comparing the simulator to itself",
    );
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
  const REVIEW =
    "Li o relatório inteiro, incluindo a expectativa calibrada, e aceito a " +
    "evidência como suficiente para a decisão registrada.";

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
        note: REVIEW,
        reportId: 4,
      },
      currentReportId: 5,
    });
    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect(result.metrics.matches_current_report).toBe(false);
  });

  it("NEVER passes an approval with no report to have been written against", () => {
    // `currentReportId === null` used to mean "matches" — an approval of
    // nothing matching everything, which is the G1 shape exactly: a condition
    // satisfied because there was nothing to compare it against. And it was the
    // LIVE state of this gate, because nothing minted gate reports at all.
    const result = evaluateG6({
      approval: {
        reviewedAt: NOW,
        reviewer: "owner",
        note: REVIEW,
        reportId: 1,
      },
      currentReportId: null,
    });
    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect(result.status).not.toBe("PASS");
    expect(String(result.metrics.detail)).toContain("no gate report");
  });

  it("NEVER passes a signature with no written record behind it", () => {
    const result = evaluateG6({
      approval: { reviewedAt: NOW, reviewer: "owner", note: "ok", reportId: 5 },
      currentReportId: 5,
    });
    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect(String(result.metrics.detail)).toContain("written record");
  });

  it("passes on a review of the report under consideration", () => {
    expect(
      evaluateG6({
        approval: {
          reviewedAt: NOW,
          reviewer: "owner",
          note: REVIEW,
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
