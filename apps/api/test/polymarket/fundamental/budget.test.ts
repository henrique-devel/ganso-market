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
    // The RFC-007 budget reserves 6 GB in total for the RFC-010..013 tables.
    // Owner decision of 2026-08-24 (RFC-012): the estimates quota is 2 GB —
    // the 1 GB it gave up funds the resolution-risk and graph tables.
    expect(estimates?.quotaBytes).toBe(2 * GB);
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
    // what makes accumulating 100 resolved markets realistic at all. This is
    // the MODELED CEILING (200 tokens, every bucket at full rate): the 2 GB
    // quota buys ~24 days there, while at the rate actually measured in
    // production (~23 MB/day, 2026-08-23) it buys ~87 days — the number the
    // owner's 2026-08-24 rebalancing decision was based on.
    expect(daysWithinQuota).toBeGreaterThan(20);

    // And an estimate must outlive the evidence chain that scores it:
    // resolution, then UMA liveness (~2 h), the hourly label sync, and up to a
    // full day until the daily calibration runs. Anything under ~2 days would
    // prune the row before it could ever become evidence.
    const EVIDENCE_CHAIN_DAYS = 27 / 24;
    expect(daysWithinQuota).toBeGreaterThan(EVIDENCE_CHAIN_DAYS * 7);
  });

  it("keeps the whole module inside the RFC-007 40 GB budget", () => {
    // The protected polymarket_* metadata tables SHARE one 0.5 GB monitored
    // quota (RFC-007's retention table has a single line for the whole group);
    // retention.ts stamps that same 0.5 GB on each member, so a naive sum
    // counts it eleven times. Count the group once, everything else per table.
    const metadataGroup = RETENTION_TABLES.filter(
      (table) => table.protected && table.table.startsWith("polymarket_"),
    );
    const metadataShared = Math.max(
      ...metadataGroup.map((table) => table.quotaBytes),
    );
    const individual = RETENTION_TABLES.filter(
      (table) => !(table.protected && table.table.startsWith("polymarket_")),
    ).reduce((sum, table) => sum + table.quotaBytes, 0);
    expect(individual + metadataShared).toBeLessThan(40 * GB);
  });

  it("keeps the RFC-010..013 tables inside their 6 GB reserve", () => {
    // The RFC-007 budget reserves 6 GB for the RFC-010..013 tables: RFC-010
    // holds 3.7 GB (after ceding 1.0 GB of the estimates quota on 2026-08-24),
    // RFC-011 holds the 1.3 GB allotted on 2026-08-23, and RFC-012 holds the
    // 1.0 GB approved on 2026-08-24 (scores 0.4 / graph+violations 0.3 /
    // dispute timeline 0.2 / reports 0.1). Any new table must fit here.
    const reserve = RETENTION_TABLES.filter(
      (table) =>
        table.table.startsWith("fundamental_") ||
        table.table.startsWith("paper_") ||
        table.table.startsWith("resolution_") ||
        table.table.startsWith("graph_"),
    ).reduce((sum, table) => sum + table.quotaBytes, 0);
    expect(reserve).toBeLessThanOrEqual(6 * GB);
  });

  it("splits the RFC-012 gigabyte exactly as the owner approved", () => {
    const quota = (name: string): number =>
      RETENTION_TABLES.find((table) => table.table === name)?.quotaBytes ?? 0;
    const scores =
      quota("resolution_scores") +
      quota("resolution_score_versions") +
      quota("resolution_market_state") +
      quota("resolution_clarifications");
    const timeline =
      quota("resolution_uma_timeline") +
      quota("resolution_onchain_events") +
      quota("resolution_onchain_cursor") +
      quota("resolution_adjudication_samples");
    const graph =
      quota("graph_edges") +
      quota("graph_violations") +
      quota("graph_sanity_vetoes") +
      quota("resolution_layer_divergences");
    const reports = quota("resolution_reports");
    expect(scores).toBeCloseTo(0.4 * GB, 0);
    expect(timeline).toBeCloseTo(0.2 * GB, 0);
    expect(graph).toBeCloseTo(0.3 * GB, 0);
    expect(reports).toBeCloseTo(0.1 * GB, 0);
    // Within half a byte of the approved 1.0 GB (float dust from the GB
    // multiples; the 6 GB reserve assertion above is the binding budget).
    expect(scores + timeline + graph + reports).toBeCloseTo(1 * GB, 0);
  });
});
