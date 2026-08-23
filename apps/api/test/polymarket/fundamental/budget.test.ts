import { describe, expect, it } from "vitest";

import { DEFAULT_FUNDAMENTAL_CONFIG } from "../../../src/polymarket/fundamental/config.js";
import { RETENTION_TABLES } from "../../../src/polymarket/retention.js";

// Measured, not guessed: 200 000 representative rows inserted into a real
// PostgreSQL 18 instance with this migration's columns and indexes, then
// VACUUM ANALYZE'd, gave pg_total_relation_size / rows = 1020.1 bytes
// (546 B heap + 474 B index). Re-measure and update this constant whenever the
// row shape or the index set changes; the evidence is recorded in
// docs/test-results/RFC-010-fundamental-model.md.
const MEASURED_BYTES_PER_ROW = 1020;

const GB = 1024 ** 3;
const DAY_MS = 24 * 3_600_000;

/** RFC-007 caps: 100 markets, 200 outcome tokens. */
const MAX_TOKENS = 200;

/**
 * Measured share of the universe's tokens sitting in each horizon bucket,
 * from production on 2026-08-22 (586 878 rows over ~1.9 days). The cadence is
 * per bucket, so the daily row count is the sum over buckets, not one rate
 * times one token count.
 */
const MEASURED_ROW_SHARE: Readonly<Record<string, number>> = {
  lt_1h: 0.003,
  "1h_6h": 0.028,
  "6h_24h": 0.074,
  "1d_7d": 0.145,
  gt_7d: 0.75,
};

/** Rows a day under a flat 60 s cadence, the shape production ran at first. */
const FLAT_60S_ROWS_PER_DAY = Math.floor((MAX_TOKENS * DAY_MS) / 60_000);

/**
 * Rows a day under the per-horizon cadence: each bucket's share of the tokens
 * sampled at that bucket's own rate.
 */
function rowsPerDay(cadence: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const [bucket, share] of Object.entries(MEASURED_ROW_SHARE)) {
    const gap = cadence[bucket] ?? 60_000;
    total += (MAX_TOKENS * share * DAY_MS) / gap;
  }
  return Math.floor(total);
}

describe("estimate volumetry", () => {
  it("spends resolution near the resolution instant, not far from it", () => {
    const cadence = DEFAULT_FUNDAMENTAL_CONFIG.estimateCadenceMs;
    // A market resolving within the hour is sampled every 10 s; one resolving
    // in months every 10 min. Sampling the far market more often would spend
    // the whole budget exactly where it can never become gate evidence.
    expect(cadence.lt_1h).toBe(10_000);
    expect(cadence["1h_6h"]).toBe(60_000);
    expect(cadence["6h_24h"]).toBe(300_000);
    expect(cadence["1d_7d"]).toBe(600_000);
    expect(cadence.gt_7d).toBe(600_000);

    // The loop has to tick at least as fine as the finest cadence, or the
    // 10 s bucket could never actually be served every 10 s.
    expect(DEFAULT_FUNDAMENTAL_CONFIG.estimateIntervalMs).toBeLessThanOrEqual(
      cadence.lt_1h,
    );

    // Never finer as the horizon grows.
    const ordered = [
      cadence.lt_1h,
      cadence["1h_6h"],
      cadence["6h_24h"],
      cadence["1d_7d"],
      cadence.gt_7d,
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(ordered[index]).toBeGreaterThanOrEqual(ordered[index - 1] ?? 0);
    }
  });

  it("cuts the daily volume several times over versus a flat cadence", () => {
    const perHorizon = rowsPerDay(DEFAULT_FUNDAMENTAL_CONFIG.estimateCadenceMs);
    expect(FLAT_60S_ROWS_PER_DAY).toBe(288_000);
    expect(perHorizon).toBeLessThan(FLAT_60S_ROWS_PER_DAY / 4);
  });

  it("keeps the estimates quota inside the module's shared reserve", () => {
    const estimates = RETENTION_TABLES.find(
      (table) => table.table === "fundamental_estimates",
    );
    expect(estimates).toBeDefined();
    expect(estimates?.ttlDays).toBe(90);
    expect(estimates?.protected).toBe(false);
    // The RFC-007 budget reserves 6 GB in total for the RFC-010..013 tables;
    // this module takes at most half of it and leaves the rest for 011-013.
    expect(estimates?.quotaBytes).toBeLessThanOrEqual(3 * GB);
  });

  it("states the real retention window the quota buys", () => {
    const estimates = RETENTION_TABLES.find(
      (table) => table.table === "fundamental_estimates",
    );
    const quotaBytes = estimates?.quotaBytes ?? 0;
    // Consumer rows plus one shadow row per token per cycle.
    const rows = rowsPerDay(DEFAULT_FUNDAMENTAL_CONFIG.estimateCadenceMs) * 2;
    const daysWithinQuota = quotaBytes / (rows * MEASURED_BYTES_PER_ROW);

    // The honest number, asserted rather than hidden. The per-horizon cadence
    // buys weeks instead of the ~5.5 days a flat 60 s cadence bought, which is
    // what makes accumulating 100 resolved markets realistic at all.
    expect(daysWithinQuota).toBeGreaterThan(30);

    // And an estimate must outlive the evidence chain that scores it:
    // resolution, then UMA liveness (~2 h), the hourly label sync, and up to a
    // full day until the daily calibration runs. Anything under ~2 days would
    // prune the row before it could ever become evidence.
    const EVIDENCE_CHAIN_DAYS = 27 / 24;
    expect(daysWithinQuota).toBeGreaterThan(EVIDENCE_CHAIN_DAYS * 7);
  });

  it("keeps the whole module inside the RFC-007 40 GB budget", () => {
    const total = RETENTION_TABLES.reduce(
      (sum, table) => sum + table.quotaBytes,
      0,
    );
    expect(total).toBeLessThan(40 * GB);
  });
});
