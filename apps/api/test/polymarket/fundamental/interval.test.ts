import { describe, expect, it } from "vitest";

import {
  formatScaled,
  parseScaled,
} from "../../../src/polymarket/fundamental/fixed.js";
import {
  buildInterval,
  FALLBACK_WIDEN_FACTOR,
  horizonBucket,
  HORIZON_MULTIPLIERS,
  INTERVAL_VERSION,
  stalenessMultiplier,
  Z_90,
  type IntervalInputs,
} from "../../../src/polymarket/fundamental/interval.js";

const HOUR_MS = 3_600_000;

function inputs(overrides: Partial<IntervalInputs> = {}): IntervalInputs {
  return {
    qScaled: parseScaled("0.5") ?? 0n,
    execSpreadScaled: parseScaled("0.02") ?? 0n,
    sigma: 0,
    bookAgeMs: 0,
    maxBookAgeMs: 30_000,
    feedAgeMs: null,
    maxFeedAgeMs: 120_000,
    timeToResolutionMs: 30 * 60_000,
    widenFactor: 1,
    ...overrides,
  };
}

describe("horizonBucket", () => {
  it("buckets by time to resolution and widens monotonically", () => {
    expect(horizonBucket(30 * 60_000)).toBe("lt_1h");
    expect(horizonBucket(3 * HOUR_MS)).toBe("1h_6h");
    expect(horizonBucket(12 * HOUR_MS)).toBe("6h_24h");
    expect(horizonBucket(3 * 24 * HOUR_MS)).toBe("1d_7d");
    expect(horizonBucket(30 * 24 * HOUR_MS)).toBe("gt_7d");

    const multipliers = [
      HORIZON_MULTIPLIERS.lt_1h,
      HORIZON_MULTIPLIERS["1h_6h"],
      HORIZON_MULTIPLIERS["6h_24h"],
      HORIZON_MULTIPLIERS["1d_7d"],
      HORIZON_MULTIPLIERS.gt_7d,
    ];
    for (let index = 1; index < multipliers.length; index += 1) {
      expect(multipliers[index]).toBeGreaterThanOrEqual(
        multipliers[index - 1] ?? 0,
      );
    }
  });

  it("treats an unknown or past horizon as the widest bucket", () => {
    // An unknown horizon is never rewarded with a narrow interval.
    expect(horizonBucket(null)).toBe("gt_7d");
    expect(horizonBucket(-1)).toBe("gt_7d");
    expect(horizonBucket(Number.NaN)).toBe("gt_7d");
  });
});

describe("buildInterval", () => {
  it("is never narrower than half the executable spread", () => {
    const result = buildInterval(inputs({ sigma: 0 }));
    expect(result.halfWidthScaled).toBeGreaterThanOrEqual(
      result.structuralHalfScaled,
    );
    expect(formatScaled(result.structuralHalfScaled, 9)).toBe("0.010000000");
    expect(result.version).toBe(INTERVAL_VERSION);
  });

  it("keeps q_lo <= q <= q_hi under every input", () => {
    const cases: IntervalInputs[] = [
      inputs(),
      inputs({ qScaled: parseScaled("0.999") ?? 0n, sigma: 0.4 }),
      inputs({ qScaled: parseScaled("0.0005") ?? 0n, sigma: 0.4 }),
      inputs({ qScaled: 0n }),
      inputs({ execSpreadScaled: -5n }),
      inputs({ sigma: Number.NaN }),
      inputs({ sigma: 10 }),
      inputs({ timeToResolutionMs: null }),
      inputs({ widenFactor: Number.NaN }),
    ];
    for (const candidate of cases) {
      const result = buildInterval(candidate);
      expect(result.qLoScaled <= result.qScaled).toBe(true);
      expect(result.qScaled <= result.qHiScaled).toBe(true);
    }
  });

  it("truncates every bound into [0.001, 0.999]", () => {
    const high = buildInterval(
      inputs({ qScaled: parseScaled("0.9999") ?? 0n, sigma: 0.5 }),
    );
    expect(high.qHiScaled).toBe(parseScaled("0.999"));
    const low = buildInterval(
      inputs({ qScaled: parseScaled("0.0001") ?? 0n, sigma: 0.5 }),
    );
    expect(low.qLoScaled).toBe(parseScaled("0.001"));
  });

  it("widens with model dispersion at the 90% multiplier", () => {
    const sigma = 0.05;
    const result = buildInterval(
      inputs({ sigma, timeToResolutionMs: 30 * 60_000 }),
    );
    // Horizon lt_1h and fresh data leave the dispersion term untouched.
    const expected = BigInt(Math.round(Z_90 * sigma * 1_000_000_000));
    expect(result.halfWidthScaled).toBe(expected);
  });

  it("widens with staleness and with the horizon bucket", () => {
    const fresh = buildInterval(inputs({ sigma: 0.05 }));
    const staleBook = buildInterval(inputs({ sigma: 0.05, bookAgeMs: 30_000 }));
    const staleFeed = buildInterval(
      inputs({ sigma: 0.05, feedAgeMs: 120_000 }),
    );
    const farHorizon = buildInterval(
      inputs({ sigma: 0.05, timeToResolutionMs: 30 * 24 * HOUR_MS }),
    );
    expect(staleBook.halfWidthScaled).toBeGreaterThan(fresh.halfWidthScaled);
    expect(staleFeed.halfWidthScaled).toBeGreaterThan(fresh.halfWidthScaled);
    expect(farHorizon.halfWidthScaled).toBeGreaterThan(fresh.halfWidthScaled);
    expect(stalenessMultiplier(inputs({ bookAgeMs: 0 }))).toBe(1);
  });

  it("makes the fallback strictly wider than the raw baseline", () => {
    const baseline = buildInterval(inputs({ sigma: 0, widenFactor: 1 }));
    const fallback = buildInterval(
      inputs({ sigma: 0, widenFactor: FALLBACK_WIDEN_FACTOR }),
    );
    const baselineWidth = baseline.qHiScaled - baseline.qLoScaled;
    const fallbackWidth = fallback.qHiScaled - fallback.qLoScaled;
    expect(fallbackWidth).toBeGreaterThan(baselineWidth);
  });

  it("is deterministic", () => {
    const first = buildInterval(inputs({ sigma: 0.037 }));
    const second = buildInterval(inputs({ sigma: 0.037 }));
    expect(first.qLoScaled).toBe(second.qLoScaled);
    expect(first.qScaled).toBe(second.qScaled);
    expect(first.qHiScaled).toBe(second.qHiScaled);
  });
});
