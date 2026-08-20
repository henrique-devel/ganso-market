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

function rowsPerDay(minGapMs: number): number {
  return Math.floor((MAX_TOKENS * DAY_MS) / minGapMs);
}

describe("estimate volumetry", () => {
  it("respects the RFC's per-token rate limit and daily ceiling", () => {
    const config = DEFAULT_FUNDAMENTAL_CONFIG;
    expect(config.minEstimateGapMs).toBe(60_000);
    // The RFC's stated ceiling for a 50-100 market universe is ~150-300k
    // consumer rows per day; at 200 tokens and one row per token per minute
    // the loop lands at the top of that range and cannot exceed it.
    expect(rowsPerDay(config.minEstimateGapMs)).toBe(288_000);
    expect(rowsPerDay(config.minEstimateGapMs)).toBeLessThanOrEqual(300_000);
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
    const bytesPerDay =
      rowsPerDay(DEFAULT_FUNDAMENTAL_CONFIG.minEstimateGapMs) *
      MEASURED_BYTES_PER_ROW;
    const daysWithinQuota = quotaBytes / bytesPerDay;

    // This is the honest number, and it is deliberately asserted rather than
    // hidden: at the full 200-token universe and the RFC's maximum cadence,
    // the 3 GB quota holds about eleven days, NOT the 90-day TTL. Quota beats
    // TTL in the retention job, so the data stays inside the local budget and
    // the window is what shrinks. Reaching a true 90 days needs either a
    // slower cadence (min_estimate_gap_ms >= ~490 s) or ~26 GB of quota; that
    // is an owner decision, recorded in the handoff.
    expect(daysWithinQuota).toBeGreaterThan(10);
    expect(daysWithinQuota).toBeLessThan(12);

    // The documented knob really does buy the 90-day window.
    const slowerBytesPerDay = rowsPerDay(600_000) * MEASURED_BYTES_PER_ROW;
    expect(quotaBytes / slowerBytesPerDay).toBeGreaterThan(90);
  });

  it("keeps the whole module inside the RFC-007 40 GB budget", () => {
    const total = RETENTION_TABLES.reduce(
      (sum, table) => sum + table.quotaBytes,
      0,
    );
    expect(total).toBeLessThan(40 * GB);
  });
});
