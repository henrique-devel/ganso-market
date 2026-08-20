import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WalkForwardConfig } from "../../../src/polymarket/fundamental/config.js";
import type { ScoredObservation } from "../../../src/polymarket/fundamental/types.js";
import {
  blockBootstrapDelta,
  brierTerm,
  computeCalibrationMetrics,
  HORIZON_BUCKET_OF,
  intervalCoverage,
  LOG_LOSS_EPSILON,
  logLossTerm,
  reliabilityBins,
  scoreSummary,
  walkForwardSplits,
  type BootstrapOptions,
} from "../../../src/polymarket/fundamental/walkforward.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const BOOTSTRAP: BootstrapOptions = {
  resamples: 400,
  seed: 20_260_819,
  blockDays: 1,
};

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

function observation(
  overrides: Partial<ScoredObservation> & {
    readonly label: number;
    readonly modelQ: number;
    readonly baselineQ: number;
  },
): ScoredObservation {
  return {
    tokenId: overrides.tokenId ?? "token-1",
    conditionId: overrides.conditionId ?? "condition-1",
    decisionTs: overrides.decisionTs ?? new Date("2026-06-01T00:00:00Z"),
    label: overrides.label,
    modelQ: overrides.modelQ,
    baselineQ: overrides.baselineQ,
    modelLo: overrides.modelLo ?? Math.max(overrides.modelQ - 0.05, 0.001),
    modelHi: overrides.modelHi ?? Math.min(overrides.modelQ + 0.05, 0.999),
    horizonMs: overrides.horizonMs ?? 30 * 60_000,
    disputed: overrides.disputed ?? false,
    degenerate: overrides.degenerate ?? false,
  };
}

/**
 * A panel of `markets` markets observed on `days` days, four observations per
 * market-day (the serial dependence the block bootstrap exists to preserve).
 */
function panel(
  markets: number,
  days: number,
  build: (
    index: number,
    market: number,
    day: number,
  ) => Partial<ScoredObservation> & {
    readonly label: number;
    readonly modelQ: number;
    readonly baselineQ: number;
  },
): ScoredObservation[] {
  const observations: ScoredObservation[] = [];
  let index = 0;
  for (let market = 0; market < markets; market += 1) {
    for (let day = 0; day < days; day += 1) {
      for (let slot = 0; slot < 4; slot += 1) {
        observations.push(
          observation({
            tokenId: `token-${market}`,
            conditionId: `condition-${market}`,
            decisionTs: new Date(
              Date.UTC(2026, 5, 1) + day * DAY_MS + slot * HOUR_MS,
            ),
            ...build(index, market, day),
          }),
        );
        index += 1;
      }
    }
  }
  return observations;
}

describe("walkForwardSplits", () => {
  const config: WalkForwardConfig = {
    trainDays: 21,
    validationDays: 7,
    stepDays: 7,
  };

  it("never lets a validation window overlap or precede its training window", () => {
    const splits = walkForwardSplits(
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-04-01T00:00:00Z"),
      config,
    );

    expect(splits.length).toBeGreaterThan(1);
    for (const split of splits) {
      expect(split.trainTo.getTime()).toBeGreaterThan(
        split.trainFrom.getTime(),
      );
      expect(split.validationFrom.getTime()).toBeGreaterThanOrEqual(
        split.trainTo.getTime(),
      );
      expect(split.validationTo.getTime()).toBeGreaterThan(
        split.validationFrom.getTime(),
      );
      expect(split.trainTo.getTime() - split.trainFrom.getTime()).toBe(
        21 * DAY_MS,
      );
      expect(
        split.validationTo.getTime() - split.validationFrom.getTime(),
      ).toBe(7 * DAY_MS);
    }
  });

  it("advances by stepDays and stays inside the requested window", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const to = new Date("2026-04-01T00:00:00Z");
    const splits = walkForwardSplits(from, to, config);

    const first = splits[0];
    expect(first?.trainFrom.toISOString()).toBe(from.toISOString());
    for (let index = 1; index < splits.length; index += 1) {
      const previous = splits[index - 1];
      const current = splits[index];
      expect(
        (current?.trainFrom.getTime() ?? 0) -
          (previous?.trainFrom.getTime() ?? 0),
      ).toBe(7 * DAY_MS);
      expect(
        (current?.validationFrom.getTime() ?? 0) -
          (previous?.validationFrom.getTime() ?? 0),
      ).toBe(7 * DAY_MS);
    }
    const last = splits[splits.length - 1];
    expect(last?.validationTo.getTime()).toBeLessThanOrEqual(to.getTime());
  });

  it("emits no split when the window cannot hold a complete fold", () => {
    expect(
      walkForwardSplits(
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-01-20T00:00:00Z"),
        config,
      ),
    ).toEqual([]);
    expect(
      walkForwardSplits(
        new Date("2026-04-01T00:00:00Z"),
        new Date("2026-01-01T00:00:00Z"),
        config,
      ),
    ).toEqual([]);
  });

  it("refuses a non-positive configuration instead of looping forever", () => {
    expect(
      walkForwardSplits(
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-06-01T00:00:00Z"),
        { trainDays: 21, validationDays: 7, stepDays: 0 },
      ),
    ).toEqual([]);
  });
});

describe("scoreSummary", () => {
  it("scores a perfect predictor at Brier 0 and a finite log loss", () => {
    const summary = scoreSummary([
      { prediction: 1, label: 1 },
      { prediction: 0, label: 0 },
      { prediction: 1, label: 1 },
    ]);

    expect(summary.count).toBe(3);
    expect(summary.brier).toBe(0);
    expect(Number.isFinite(summary.logLoss)).toBe(true);
    // The epsilon clamp costs -ln(1 - 1e-6) per observation and nothing more.
    expect(summary.logLoss).toBeCloseTo(-Math.log(1 - LOG_LOSS_EPSILON), 12);
  });

  it("scores an always-wrong predictor at Brier 1 without producing Infinity", () => {
    const summary = scoreSummary([
      { prediction: 1, label: 0 },
      { prediction: 0, label: 1 },
    ]);

    expect(summary.brier).toBe(1);
    expect(Number.isFinite(summary.logLoss)).toBe(true);
    expect(summary.logLoss).toBeCloseTo(-Math.log(LOG_LOSS_EPSILON), 9);
  });

  it("scores a 0.5 resolution as half of each side", () => {
    const summary = scoreSummary([{ prediction: 0.5, label: 0.5 }]);
    expect(summary.brier).toBe(0);
    expect(summary.logLoss).toBeCloseTo(-Math.log(0.5), 12);
  });

  it("reports NaN rather than a flattering zero for an empty set", () => {
    const summary = scoreSummary([]);
    expect(summary.count).toBe(0);
    expect(Number.isNaN(summary.brier)).toBe(true);
    expect(Number.isNaN(summary.logLoss)).toBe(true);
  });

  it("drops non-finite pairs and logs the drop", () => {
    const summary = scoreSummary([
      { prediction: Number.NaN, label: 1 },
      { prediction: 0.5, label: 1 },
    ]);
    expect(summary.count).toBe(1);
    const lines = vi
      .mocked(process.stderr.write)
      .mock.calls.map((call) => String(call[0]));
    expect(
      lines.some((line) => line.includes("WALKFORWARD_PAIR_DROPPED")),
    ).toBe(true);
  });
});

describe("reliabilityBins", () => {
  it("puts a perfectly calibrated set on the diagonal", () => {
    const pairs: Array<{ prediction: number; label: number }> = [];
    for (let bin = 0; bin < 10; bin += 1) {
      const prediction = bin / 10 + 0.05;
      // Exactly `prediction` of the 100 outcomes in this bin resolve YES.
      const positives = Math.round(prediction * 100);
      for (let index = 0; index < 100; index += 1) {
        pairs.push({ prediction, label: index < positives ? 1 : 0 });
      }
    }

    const bins = reliabilityBins(pairs);

    expect(bins).toHaveLength(10);
    for (const bin of bins) {
      expect(bin.count).toBe(100);
      expect(bin.meanPredicted).toBeGreaterThanOrEqual(bin.lower);
      expect(bin.meanPredicted).toBeLessThanOrEqual(bin.upper);
      expect(bin.meanObserved).toBeCloseTo(bin.meanPredicted, 6);
    }
  });

  it("shows the miscalibration of an overconfident set", () => {
    const pairs = Array.from({ length: 100 }, (_unused, index) => ({
      prediction: 0.95,
      label: index < 50 ? 1 : 0,
    }));

    const bins = reliabilityBins(pairs);
    expect(bins).toHaveLength(1);
    expect(bins[0]?.meanPredicted).toBeCloseTo(0.95, 12);
    expect(bins[0]?.meanObserved).toBeCloseTo(0.5, 12);
  });

  it("omits empty bins instead of inventing a calibration point", () => {
    const bins = reliabilityBins([{ prediction: 0.42, label: 1 }]);
    expect(bins).toHaveLength(1);
    expect(bins[0]?.lower).toBeCloseTo(0.4, 12);
    expect(bins[0]?.upper).toBeCloseTo(0.5, 12);
  });

  it("puts a prediction of exactly 1 in the last bin", () => {
    const bins = reliabilityBins([{ prediction: 1, label: 1 }]);
    expect(bins[0]?.lower).toBeCloseTo(0.9, 12);
    expect(bins[0]?.upper).toBe(1);
  });
});

describe("intervalCoverage", () => {
  it("measures a synthetic 90% set at ~0.9", () => {
    const observations: ScoredObservation[] = [];
    for (let index = 0; index < 100; index += 1) {
      const covered = index < 90;
      observations.push(
        observation({
          conditionId: `condition-${index}`,
          label: 1,
          modelQ: 0.8,
          baselineQ: 0.8,
          // A covered observation is one whose upper bound reached the
          // truncation ceiling; an uncovered one stayed short of the outcome.
          modelLo: covered ? 0.6 : 0.3,
          modelHi: covered ? 0.999 : 0.5,
        }),
      );
    }

    expect(intervalCoverage(observations)).toBeCloseTo(0.9, 12);
  });

  it("counts a 0.5 resolution as covered only when 0.5 is inside", () => {
    const inside = observation({
      label: 0.5,
      modelQ: 0.5,
      baselineQ: 0.5,
      modelLo: 0.4,
      modelHi: 0.6,
    });
    const outside = observation({
      label: 0.5,
      modelQ: 0.8,
      baselineQ: 0.8,
      modelLo: 0.7,
      modelHi: 0.9,
    });

    expect(intervalCoverage([inside])).toBe(1);
    expect(intervalCoverage([outside])).toBe(0);
    expect(intervalCoverage([inside, outside])).toBe(0.5);
  });

  it("treats a bound sitting on the truncation limit as reaching certainty", () => {
    const reachesZero = observation({
      label: 0,
      modelQ: 0.2,
      baselineQ: 0.2,
      modelLo: 0.001,
      modelHi: 0.4,
    });
    const reachesOne = observation({
      label: 1,
      modelQ: 0.8,
      baselineQ: 0.8,
      modelLo: 0.6,
      modelHi: 0.999,
    });

    expect(intervalCoverage([reachesZero, reachesOne])).toBe(1);
  });

  it("reports NaN for an empty set", () => {
    expect(Number.isNaN(intervalCoverage([]))).toBe(true);
  });
});

describe("brierTerm / logLossTerm", () => {
  it("scores the paired predictions of one observation independently", () => {
    const scored = observation({ label: 1, modelQ: 0.9, baselineQ: 0.6 });
    expect(brierTerm(scored, scored.modelQ)).toBeCloseTo(0.01, 12);
    expect(brierTerm(scored, scored.baselineQ)).toBeCloseTo(0.16, 12);
    expect(logLossTerm(scored, scored.modelQ)).toBeCloseTo(-Math.log(0.9), 12);
  });

  it("clamps log loss away from 0 and 1", () => {
    const scored = observation({ label: 1, modelQ: 0, baselineQ: 0.5 });
    expect(Number.isFinite(logLossTerm(scored, 0))).toBe(true);
    expect(logLossTerm(scored, 0)).toBeCloseTo(-Math.log(LOG_LOSS_EPSILON), 9);
  });
});

describe("HORIZON_BUCKET_OF", () => {
  it("reuses the interval layer's buckets", () => {
    expect(
      HORIZON_BUCKET_OF(
        observation({
          label: 1,
          modelQ: 0.5,
          baselineQ: 0.5,
          horizonMs: 60_000,
        }),
      ),
    ).toBe("lt_1h");
    expect(
      HORIZON_BUCKET_OF(
        observation({
          label: 1,
          modelQ: 0.5,
          baselineQ: 0.5,
          horizonMs: 3 * HOUR_MS,
        }),
      ),
    ).toBe("1h_6h");
    expect(
      HORIZON_BUCKET_OF(
        observation({
          label: 1,
          modelQ: 0.5,
          baselineQ: 0.5,
          horizonMs: 10 * DAY_MS,
        }),
      ),
    ).toBe("gt_7d");
  });
});

describe("blockBootstrapDelta", () => {
  // A model with no edge: half the market-days it beats the baseline by the
  // same Brier it loses on the other half, so the true delta is 0. Brier is
  // quadratic, so the losing side is priced from the cost itself (0.16 + 0.07)
  // rather than from an equal distance on the other side of the baseline,
  // which would NOT be an equal cost.
  const BETTER_YES_Q = 0.7; // (1 - 0.7)^2 = 0.09 against a baseline 0.16
  const WORSE_YES_Q = 1 - Math.sqrt(0.23); // (1 - q)^2 = 0.23, i.e. +0.07
  const noEdge = panel(40, 4, (_index, market, day) => {
    const yes = market % 2 === 0;
    const better = day % 2 === 0;
    return {
      label: yes ? 1 : 0,
      baselineQ: yes ? 0.6 : 0.4,
      modelQ: yes
        ? better
          ? BETTER_YES_Q
          : WORSE_YES_Q
        : better
          ? 1 - BETTER_YES_Q
          : 1 - WORSE_YES_Q,
    };
  });

  // A model that is strictly closer to the outcome on every observation.
  const strictlyBetter = panel(40, 4, (index) => {
    const label = index % 2 === 0 ? 1 : 0;
    return {
      label,
      modelQ: label === 1 ? 0.9 : 0.1,
      baselineQ: label === 1 ? 0.6 : 0.4,
    };
  });

  it("is reproducible for the same observations and seed", () => {
    const first = blockBootstrapDelta(noEdge, brierTerm, BOOTSTRAP);
    const second = blockBootstrapDelta(noEdge, brierTerm, BOOTSTRAP);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    // Input order must not move the CI either: blocks are built from sorted
    // observations, not from the order the rows were read in.
    const reversed = blockBootstrapDelta(
      [...noEdge].reverse(),
      brierTerm,
      BOOTSTRAP,
    );
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(first));
  });

  it("produces a different interval for a different seed", () => {
    const first = blockBootstrapDelta(noEdge, brierTerm, BOOTSTRAP);
    const other = blockBootstrapDelta(noEdge, brierTerm, {
      ...BOOTSTRAP,
      seed: BOOTSTRAP.seed + 1,
    });

    expect(other.point).toBe(first.point);
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(first));
  });

  it("returns a CI containing 0 for a model identical to the baseline", () => {
    const identical = noEdge.map((scored) => ({
      ...scored,
      modelQ: scored.baselineQ,
    }));
    const delta = blockBootstrapDelta(identical, brierTerm, BOOTSTRAP);

    expect(delta.point).toBe(0);
    expect(delta.lower).toBeLessThanOrEqual(0);
    expect(delta.upper).toBeGreaterThanOrEqual(0);
  });

  it("returns a CI containing 0 for a model with no systematic edge", () => {
    const delta = blockBootstrapDelta(noEdge, brierTerm, BOOTSTRAP);

    expect(delta.point).toBeCloseTo(0, 12);
    expect(delta.lower).toBeLessThan(0);
    expect(delta.upper).toBeGreaterThan(0);
  });

  it("returns a CI strictly below 0 for a strictly better model", () => {
    const brier = blockBootstrapDelta(strictlyBetter, brierTerm, BOOTSTRAP);
    const logLoss = blockBootstrapDelta(strictlyBetter, logLossTerm, BOOTSTRAP);

    expect(brier.point).toBeLessThan(0);
    expect(brier.upper).toBeLessThan(0);
    expect(logLoss.upper).toBeLessThan(0);
  });

  it("fails closed on an empty sample or an unusable configuration", () => {
    for (const result of [
      blockBootstrapDelta([], brierTerm, BOOTSTRAP),
      blockBootstrapDelta(noEdge, brierTerm, { ...BOOTSTRAP, resamples: 0 }),
      blockBootstrapDelta(noEdge, brierTerm, { ...BOOTSTRAP, blockDays: 0 }),
    ]) {
      expect(Number.isNaN(result.point)).toBe(true);
      expect(Number.isNaN(result.lower)).toBe(true);
      expect(Number.isNaN(result.upper)).toBe(true);
    }
  });
});

describe("computeCalibrationMetrics", () => {
  const clean = panel(30, 3, (index) => {
    const label = index % 2 === 0 ? 1 : 0;
    return {
      label,
      modelQ: label === 1 ? 0.75 : 0.25,
      baselineQ: label === 1 ? 0.7 : 0.3,
      horizonMs: index % 3 === 0 ? 30 * 60_000 : 3 * HOUR_MS,
    };
  });

  const degenerate = observation({
    tokenId: "token-degenerate",
    conditionId: "condition-degenerate",
    decisionTs: new Date("2026-06-02T00:00:00Z"),
    label: 1,
    modelQ: 0.995,
    baselineQ: 0.995,
    degenerate: true,
  });

  const disputed = observation({
    tokenId: "token-disputed",
    conditionId: "condition-disputed",
    decisionTs: new Date("2026-06-02T01:00:00Z"),
    label: 0.5,
    modelQ: 0.5,
    baselineQ: 0.5,
    disputed: true,
  });

  it("excludes degenerate and disputed observations from the headline but keeps them in the annex", () => {
    const metrics = computeCalibrationMetrics(
      [...clean, degenerate, disputed],
      BOOTSTRAP,
    );

    expect(metrics.observations).toBe(clean.length);
    expect(metrics.marketsCovered).toBe(30);
    expect(metrics.withDegenerate.observations).toBe(clean.length + 2);
    expect(metrics.withDegenerate.model.count).toBe(clean.length + 2);

    // The annex is the inflated version: a near-certain baseline that resolved
    // the way it was priced pulls both Brier scores down.
    expect(metrics.withDegenerate.baseline.brier).toBeLessThan(
      metrics.baseline.brier,
    );
    expect(metrics.model.count).toBe(clean.length);
  });

  it("excludes a degenerate baseline even when the stored flag says otherwise", () => {
    const unflagged = observation({
      tokenId: "token-unflagged",
      conditionId: "condition-unflagged",
      label: 1,
      modelQ: 0.995,
      baselineQ: 0.995,
      degenerate: false,
    });

    const metrics = computeCalibrationMetrics([...clean, unflagged], BOOTSTRAP);
    expect(metrics.observations).toBe(clean.length);
    expect(metrics.withDegenerate.observations).toBe(clean.length + 1);
  });

  it("stratifies by horizon bucket with a relative Brier degradation per slice", () => {
    const metrics = computeCalibrationMetrics(clean, BOOTSTRAP);

    expect(metrics.horizonSlices.map((slice) => slice.bucket)).toEqual([
      "lt_1h",
      "1h_6h",
    ]);
    let counted = 0;
    for (const slice of metrics.horizonSlices) {
      counted += slice.count;
      expect(slice.model.count).toBe(slice.count);
      expect(slice.baseline.count).toBe(slice.count);
      // This model is closer to every outcome than the baseline is.
      expect(slice.relativeBrierDegradation).toBeLessThan(0);
    }
    expect(counted).toBe(clean.length);
  });

  it("reports reliability curves, interval coverage and the bootstrap settings", () => {
    const metrics = computeCalibrationMetrics(clean, BOOTSTRAP);

    expect(metrics.reliabilityModel.length).toBeGreaterThan(0);
    expect(metrics.reliabilityBaseline.length).toBeGreaterThan(0);
    expect(
      metrics.reliabilityModel.reduce((total, bin) => total + bin.count, 0),
    ).toBe(clean.length);
    expect(metrics.intervalCoverage).toBeGreaterThanOrEqual(0);
    expect(metrics.intervalCoverage).toBeLessThanOrEqual(1);
    expect(metrics.bootstrapResamples).toBe(BOOTSTRAP.resamples);
    expect(metrics.bootstrapSeed).toBe(BOOTSTRAP.seed);
    expect(metrics.blockLength).toBe(BOOTSTRAP.blockDays);
  });

  it("is reproducible byte for byte across two runs", () => {
    const first = computeCalibrationMetrics(
      [...clean, degenerate, disputed],
      BOOTSTRAP,
    );
    const second = computeCalibrationMetrics(
      [...clean, degenerate, disputed],
      BOOTSTRAP,
    );
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("fails closed when every observation is excluded", () => {
    const metrics = computeCalibrationMetrics(
      [degenerate, disputed],
      BOOTSTRAP,
    );

    expect(metrics.observations).toBe(0);
    expect(metrics.marketsCovered).toBe(0);
    expect(Number.isNaN(metrics.model.brier)).toBe(true);
    expect(Number.isNaN(metrics.deltaBrier.upper)).toBe(true);
    expect(Number.isNaN(metrics.intervalCoverage)).toBe(true);
    expect(metrics.horizonSlices).toEqual([]);
  });
});
