import { describe, expect, it } from "vitest";

import { DEFAULT_FUNDAMENTAL_CONFIG } from "../../../src/polymarket/fundamental/config.js";
import {
  DEFAULT_BUDGET_BYTES,
  RETENTION_TABLES,
} from "../../../src/polymarket/retention.js";

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
 * Measured share of the universe's tokens sitting in each horizon bucket. The
 * cadence is per bucket, so the daily row count is the sum over buckets, not
 * one rate times one token count.
 *
 * RE-MEASURED for RFC-016, production 2026-08-31: universe membership sampled
 * hourly over 48 h, each member's horizon taken from the rule version in force
 * at that hour (`polymarket_rule_versions.end_date`), weighted by outcome
 * tokens. The 2026-08-22 numbers this replaces — lt_1h 0.003, 1h_6h 0.028,
 * 6h_24h 0.074, 1d_7d 0.145, gt_7d 0.75 — described a universe that no longer
 * exists: they put three quarters of the tokens beyond a week, where the
 * measurement now finds one fifth, and 0.3% inside the hour, where it now
 * finds twenty times as much.
 */
const MEASURED_ROW_SHARE: Readonly<Record<string, number>> = {
  lt_1h: 0.0632,
  "1h_6h": 0.0955,
  "6h_24h": 0.3195,
  "1d_7d": 0.311,
  gt_7d: 0.2108,
};

/**
 * Consumer rows actually written in 24 h of production, measured 2026-08-31
 * (20 396 rows). Far below the modelled ceiling because an ABSENT estimate
 * writes no row by design, and NO_BOOK / DEPTH_BELOW_SREF / BOOK_STALE
 * dominate the cycles. This is the number the owner's 2026-08-24 quota
 * decision was taken against, so it is the number the safety margin is
 * measured on.
 */
const MEASURED_ROWS_PER_DAY = 20_396;

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

  it("still cuts the daily volume versus a flat cadence, by less than it used to", () => {
    const perHorizon = rowsPerDay(DEFAULT_FUNDAMENTAL_CONFIG.estimateCadenceMs);
    expect(FLAT_60S_ROWS_PER_DAY).toBe(288_000);
    expect(perHorizon).toBeLessThan(FLAT_60S_ROWS_PER_DAY);

    // The honest ratio, asserted instead of a claim that no longer holds.
    // Against the 2026-08-22 distribution this test demanded a 4x cut and got
    // 6.6x, because that model put three quarters of the tokens beyond a week
    // where the cadence is 10 min. Re-measured on 2026-08-31 the far tail is
    // 21% and the cut is ~1.7x. The saving shrank because the UNIVERSE moved
    // toward short horizons, not because the cadence got worse — and moving
    // toward short horizons is the outcome RFC-016 is built to encourage.
    const ratio = FLAT_60S_ROWS_PER_DAY / perHorizon;
    expect(ratio).toBeGreaterThan(1.5);
    expect(ratio).toBeLessThan(2);

    // Volume was never the point on its own; WHERE the volume lands is. The
    // next test asserts that, and it is the assertion that matters.
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
    const ceilingDays = quotaBytes / (rows * MEASURED_BYTES_PER_ROW);
    // NOT doubled for shadow: unlike the modelled ceiling, the measured count
    // is what the table actually received, shadow rows included (2 900 of the
    // 20 396 on 2026-08-31 were shadow).
    const measuredDays =
      quotaBytes / (MEASURED_ROWS_PER_DAY * MEASURED_BYTES_PER_ROW);

    // THE INVARIANT, and it is the one thing here that may never be relaxed:
    // an estimate must outlive the evidence chain that scores it — resolution,
    // then UMA liveness (~2 h), the hourly label sync, and up to a full day
    // until the daily calibration runs. Anything under that prunes the row
    // before it can ever become evidence. Asserted on the MODELLED CEILING
    // (200 tokens, every bucket writing at full rate), the most pessimistic
    // number available, which clears it by more than five times.
    const EVIDENCE_CHAIN_DAYS = 27 / 24;
    expect(ceilingDays).toBeGreaterThan(EVIDENCE_CHAIN_DAYS);
    expect(ceilingDays).toBeGreaterThan(5);

    // The 7x safety margin the owner's quota decision was taken with, measured
    // where that decision measured it: the rate production actually writes.
    //
    // RFC-016 moved this assertion off the ceiling, and the reason is recorded
    // rather than buried. The margin used to be checked against a ceiling
    // computed from the 2026-08-22 horizon distribution, which put 75% of the
    // tokens beyond a week; re-measured on 2026-08-31 that share is 21%, the
    // ceiling rises from ~47 k to ~170 k rows/day, and the same 2 GB buys 6.2
    // days there instead of 24. Nothing about the data changed for the worse —
    // the old model was wrong about a universe that had already shifted toward
    // short horizons. The owner was consulted with both numbers on 2026-08-31
    // and kept the quota at 2 GB: the invariant stays on the ceiling, the
    // margin moves to the measured rate. Neither the TTL (90 days) nor the
    // quota (2 GB) in RETENTION_TABLES is touched.
    expect(measuredDays).toBeGreaterThan(EVIDENCE_CHAIN_DAYS * 7);
    expect(measuredDays).toBeGreaterThan(90);
  });

  it("spends most of the modelled ceiling on the markets near resolution", () => {
    // RFC-016 declares that the fast universe costs more BY DESIGN: the
    // reserved short-horizon slots in the universe cap push tokens into the
    // 10 s and 60 s buckets on purpose. This asserts the intent is real —
    // that the budget is spent where an estimate can still become evidence —
    // and pins the shape so a future distribution shift is visible as a
    // failing test rather than a silent drift.
    const cadence: Readonly<Record<string, number>> =
      DEFAULT_FUNDAMENTAL_CONFIG.estimateCadenceMs;
    const rowsFor = (bucket: string): number =>
      (MAX_TOKENS * (MEASURED_ROW_SHARE[bucket] ?? 0) * DAY_MS) /
      (cadence[bucket] ?? 60_000);
    const total = Object.keys(MEASURED_ROW_SHARE).reduce(
      (sum, bucket) => sum + rowsFor(bucket),
      0,
    );
    const nearResolution = rowsFor("lt_1h") + rowsFor("1h_6h");

    // Six percent of the tokens, but the overwhelming majority of the rows —
    // which is exactly what the owner's 2026-08-22 cadence decision bought.
    expect(nearResolution / total).toBeGreaterThan(0.75);
    // And the far tail, which pays for storage it can never turn into
    // evidence, stays a rounding error.
    expect(rowsFor("gt_7d") / total).toBeLessThan(0.05);
  });

  it("keeps the whole module inside the RFC-007 budget (110 GB after the 2026-08-25 amendment)", () => {
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
    // The owner raised the global budget from 40 to 110 GB on 2026-08-25 after
    // production showed the recorded L2 stream is ~15.3 GB/day, not the ~1
    // GB/day the original quotas assumed. Assert against the constant the
    // pruning actually uses so the two can never drift.
    expect(individual + metadataShared).toBeLessThan(DEFAULT_BUDGET_BYTES);
    expect(DEFAULT_BUDGET_BYTES).toBe(110 * GB);
    // And the sum must still leave real headroom, not merely fit: the alarm
    // fires at 90% of the budget, so the declared quotas have to stay under it.
    expect(individual + metadataShared).toBeLessThan(
      DEFAULT_BUDGET_BYTES * 0.9,
    );
  });

  it("keeps the RFC-010..013 tables inside their 8 GB reserve", () => {
    // The RFC-007 budget reserved 6 GB for the RFC-010..013 tables: RFC-010
    // holds 3.7 GB (after ceding 1.0 GB of the estimates quota on 2026-08-24),
    // RFC-011 holds the 1.3 GB allotted on 2026-08-23, and RFC-012 holds the
    // 1.0 GB approved on 2026-08-24 (scores 0.4 / graph+violations 0.3 /
    // dispute timeline 0.2 / reports 0.1). That accounted for the ENTIRE 6 GB,
    // leaving RFC-013 with literally zero room, so the reserve was expanded to
    // 8 GB — funded by trimming polymarket_book_deltas from 60 to 52 GB, which
    // keeps the module's declared total at 89 GB against the 110 GB budget.
    const reserve = RETENTION_TABLES.filter(
      (table) =>
        table.table.startsWith("fundamental_") ||
        table.table.startsWith("paper_") ||
        table.table.startsWith("resolution_") ||
        table.table.startsWith("graph_") ||
        table.table.startsWith("portfolio_"),
    ).reduce((sum, table) => sum + table.quotaBytes, 0);
    expect(reserve).toBeLessThanOrEqual(8 * GB);
  });

  it("splits the RFC-013 two gigabytes as the engine's own slices", () => {
    const quota = (name: string): number =>
      RETENTION_TABLES.find((table) => table.table === name)?.quotaBytes ?? 0;
    const decisions = quota("portfolio_decisions");
    const panel = quota("portfolio_panel_snapshots");
    const gates =
      quota("portfolio_gate_measurements") + quota("portfolio_gate_reports");
    const stateAndConfig =
      quota("portfolio_exposures") +
      quota("portfolio_state") +
      quota("portfolio_state_events") +
      quota("portfolio_config_versions") +
      quota("portfolio_factor_map_versions") +
      quota("portfolio_g2_clock") +
      quota("portfolio_g2_clock_events") +
      quota("portfolio_circuit_breakers") +
      // The bridge's entry-provenance table joined the audit group and was
      // funded from the panel snapshots (0.56 -> 0.54), not from new budget:
      // the slice below is still exactly 2 GB.
      quota("portfolio_position_entries");
    expect(decisions).toBeCloseTo(0.9 * GB, 0);
    expect(panel).toBeCloseTo(0.54 * GB, 0);
    expect(gates).toBeCloseTo(0.35 * GB, 0);
    expect(stateAndConfig).toBeCloseTo(0.21 * GB, 0);
    expect(decisions + panel + gates + stateAndConfig).toBeCloseTo(2 * GB, 0);
  });

  it("never prunes the RFC-013 evidence the RFC-009 gates would rest on", () => {
    // Gate measurements and reports are the audit trail behind any future
    // decision to allow real execution. A TTL on them would quietly erase the
    // reason a gate ever passed.
    const byName = new Map(RETENTION_TABLES.map((t) => [t.table, t]));
    for (const name of [
      "portfolio_gate_measurements",
      "portfolio_gate_reports",
      "portfolio_state",
      "portfolio_state_events",
      "portfolio_config_versions",
      "portfolio_factor_map_versions",
    ]) {
      expect(byName.get(name)?.protected, name).toBe(true);
      expect(byName.get(name)?.ttlDays, name).toBeNull();
    }
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
