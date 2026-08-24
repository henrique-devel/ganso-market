// RFC-012 measurement report: dispute rate per category, P1..P4 distribution,
// 50/50 frequency and observed lockup — statistics that exist nowhere else —
// plus the task-10 veto backtest (coverage of disputed markets, false-positive
// rate on clean ones). Every number declares its real n with a Wilson
// interval; while the own history is thin, prior_external stays in charge and
// the report says so. No profit target anywhere: the metric is veto quality.

import { composeForMarket, type RecomputeDeps } from "./recompute.js";
import { loadScoreableMarkets, measuredCategoryStats } from "./store.js";
import type { ResolutionPool } from "./types.js";

const Z_95 = 1.959964;

/** Wilson score interval for a proportion; honest at tiny n. */
export function wilsonInterval(
  successes: number,
  n: number,
): { readonly low: number; readonly high: number } {
  if (n <= 0) {
    return { low: 0, high: 1 };
  }
  const p = successes / n;
  const z2 = Z_95 * Z_95;
  const denominator = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = Z_95 * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return {
    low: Math.max((center - margin) / denominator, 0),
    high: Math.min((center + margin) / denominator, 1),
  };
}

interface CategoryReport {
  readonly category: string;
  readonly resolved: number;
  readonly disputed: number;
  readonly dispute_rate: number | null;
  readonly dispute_rate_ci: { low: number; high: number };
  readonly p5050: number;
  readonly prior_in_use: "external" | "measured";
  readonly results: Record<string, number>;
  readonly lockup_median_s: number | null;
  readonly lockup_p95_s: number | null;
}

async function categoryReports(
  pool: ResolutionPool,
  measuredMinN: number,
  asOf: Date,
): Promise<CategoryReport[]> {
  const stats = await measuredCategoryStats(pool, asOf);

  // Observed lockup and P1..P4 from the own timeline: settled entries paired
  // with the first proposed instant of the same market.
  const timeline = await pool.query<Record<string, unknown>>(
    `WITH settled AS (
       SELECT DISTINCT ON (t.condition_id)
              t.condition_id, t.result, t.occurred_at
         FROM resolution_uma_timeline t
        WHERE t.state = 'settled' AND t.occurred_at <= $1
        ORDER BY t.condition_id, t.occurred_at ASC
     ),
     proposed AS (
       SELECT condition_id, MIN(occurred_at) AS proposed_at
         FROM resolution_uma_timeline
        WHERE state = 'proposed' AND occurred_at <= $1
        GROUP BY condition_id
     )
     SELECT COALESCE(m.category, 'unknown') AS category,
            s.result,
            EXTRACT(EPOCH FROM (s.occurred_at - p.proposed_at)) AS lockup_s
       FROM settled s
       LEFT JOIN proposed p ON p.condition_id = s.condition_id
       LEFT JOIN polymarket_markets m ON m.condition_id = s.condition_id`,
    [asOf],
  );
  const byCategory = new Map<
    string,
    { results: Record<string, number>; lockups: number[] }
  >();
  for (const row of timeline.rows) {
    const category = String(row.category ?? "unknown");
    const entry = byCategory.get(category) ?? { results: {}, lockups: [] };
    const result = typeof row.result === "string" ? row.result : "unknown";
    entry.results[result] = (entry.results[result] ?? 0) + 1;
    const lockup = Number(row.lockup_s);
    if (Number.isFinite(lockup) && lockup >= 0) {
      entry.lockups.push(lockup);
    }
    byCategory.set(category, entry);
  }

  const quantile = (sorted: number[], q: number): number | null => {
    if (sorted.length === 0) {
      return null;
    }
    const index = Math.min(
      sorted.length - 1,
      Math.floor(q * (sorted.length - 1)),
    );
    return sorted[index] ?? null;
  };

  return stats.map((stat) => {
    const observed = byCategory.get(stat.category) ?? {
      results: {},
      lockups: [],
    };
    const lockups = [...observed.lockups].sort((a, b) => a - b);
    return {
      category: stat.category,
      resolved: stat.resolved,
      disputed: stat.disputed,
      dispute_rate: stat.resolved > 0 ? stat.disputed / stat.resolved : null,
      dispute_rate_ci: wilsonInterval(stat.disputed, stat.resolved),
      p5050: stat.p5050,
      prior_in_use: stat.resolved >= measuredMinN ? "measured" : "external",
      results: observed.results,
      lockup_median_s: quantile(lockups, 0.5),
      lockup_p95_s: quantile(lockups, 0.95),
    };
  });
}

export interface BacktestReport {
  readonly n_resolved: number;
  readonly n_scored: number;
  readonly n_skipped_no_proposal: number;
  readonly disputed: number;
  readonly vetoed_disputed: number;
  readonly coverage: number | null;
  readonly coverage_ci: { low: number; high: number };
  readonly clean: number;
  readonly vetoed_clean: number;
  readonly false_positive_rate: number | null;
  readonly false_positive_ci: { low: number; high: number };
}

/**
 * Task 10: would the veto have blocked, with measurable lead time, the
 * markets that went on to dispute? Each resolved market is re-scored as-of
 * one minute BEFORE its first observed proposal (look-ahead safe: the score
 * pipeline only reads received_at <= asOf), and the verdict is compared with
 * what actually happened. No profit metric — coverage and precision only,
 * reported with the sample that exists.
 */
export async function backtestVeto(
  deps: RecomputeDeps,
  asOf: Date,
  limit = 500,
): Promise<BacktestReport> {
  const { pool } = deps;
  const resolved = await pool.query<Record<string, unknown>>(
    `WITH terminal AS (
       SELECT DISTINCT ON (condition_id) condition_id, received_at
         FROM polymarket_resolution_events
        WHERE event_type IN ('resolved', 'market_resolved')
          AND received_at <= $1
        ORDER BY condition_id, received_at ASC
     ),
     first_proposed AS (
       SELECT condition_id, MIN(received_at) AS proposed_at
         FROM polymarket_resolution_events
        WHERE event_type = 'proposed' AND received_at <= $1
        GROUP BY condition_id
     ),
     disputed AS (
       SELECT DISTINCT condition_id
         FROM polymarket_resolution_events
        WHERE event_type = 'disputed' AND received_at <= $1
     )
     SELECT t.condition_id, p.proposed_at,
            (d.condition_id IS NOT NULL) AS was_disputed
       FROM terminal t
       LEFT JOIN first_proposed p ON p.condition_id = t.condition_id
       LEFT JOIN disputed d ON d.condition_id = t.condition_id
      ORDER BY t.received_at DESC
      LIMIT $2`,
    [asOf, limit],
  );

  const stats = await measuredCategoryStats(pool, asOf);
  const statsByCategory = new Map(
    stats.map((row) => [
      row.category,
      { resolved: row.resolved, disputed: row.disputed, p5050: row.p5050 },
    ]),
  );

  // Markets that already left the recorder's scoreable window still count in
  // n_resolved; only those we can identify get re-scored.
  const markets = await loadScoreableMarkets(pool, asOf, 365 * 24 * 3_600_000);
  const marketById = new Map(markets.map((m) => [m.conditionId, m]));

  let scored = 0;
  let skippedNoProposal = 0;
  let disputed = 0;
  let vetoedDisputed = 0;
  let clean = 0;
  let vetoedClean = 0;

  for (const row of resolved.rows) {
    const conditionId = String(row.condition_id);
    const proposedAt =
      row.proposed_at instanceof Date
        ? row.proposed_at
        : typeof row.proposed_at === "string"
          ? new Date(row.proposed_at)
          : null;
    if (proposedAt === null || Number.isNaN(proposedAt.getTime())) {
      skippedNoProposal += 1;
      continue;
    }
    const market = marketById.get(conditionId);
    if (market === undefined) {
      skippedNoProposal += 1;
      continue;
    }
    const decisionInstant = new Date(proposedAt.getTime() - 60_000);
    const { composed } = await composeForMarket(
      deps,
      market,
      statsByCategory,
      decisionInstant,
      false,
    );
    scored += 1;
    // The backtest verdict is the VETO band (score/hard flags) — an active
    // CIRCUIT_BREAKER at the instant would mean the dispute already started,
    // which is exactly what "antecedência mensurável" excludes.
    const vetoed = composed.action === "VETO";
    if (row.was_disputed === true) {
      disputed += 1;
      if (vetoed) {
        vetoedDisputed += 1;
      }
    } else {
      clean += 1;
      if (vetoed) {
        vetoedClean += 1;
      }
    }
  }

  return {
    n_resolved: resolved.rows.length,
    n_scored: scored,
    n_skipped_no_proposal: skippedNoProposal,
    disputed,
    vetoed_disputed: vetoedDisputed,
    coverage: disputed > 0 ? vetoedDisputed / disputed : null,
    coverage_ci: wilsonInterval(vetoedDisputed, disputed),
    clean,
    vetoed_clean: vetoedClean,
    false_positive_rate: clean > 0 ? vetoedClean / clean : null,
    false_positive_ci: wilsonInterval(vetoedClean, clean),
  };
}

/** Generate and persist the daily measurement report. */
export async function generateResolutionReport(
  deps: RecomputeDeps,
  asOf: Date,
): Promise<{ reportId: number }> {
  const categories = await categoryReports(
    deps.pool,
    deps.config.priors.measuredMinN,
    asOf,
  );
  const backtest = await backtestVeto(deps, asOf);
  const inserted = await deps.pool.query<{ report_id: string | number }>(
    `INSERT INTO resolution_reports
       (generated_at, data_from, data_to, categories_json, backtest_json, score_version)
     VALUES ($1, NULL, $1, $2::jsonb, $3::jsonb, $4)
     RETURNING report_id`,
    [
      asOf,
      JSON.stringify(categories),
      JSON.stringify(backtest),
      deps.scoreVersion,
    ],
  );
  return { reportId: Number(inserted.rows[0]?.report_id ?? 0) };
}

/** Due-check against the last STORED report (deploys must not starve it). */
export async function reportDue(
  pool: ResolutionPool,
  everyMs: number,
  asOf: Date,
): Promise<boolean> {
  const last = await pool.query<Record<string, unknown>>(
    `SELECT generated_at FROM resolution_reports
      ORDER BY generated_at DESC LIMIT 1`,
  );
  const raw = last.rows[0]?.generated_at;
  const generatedAt =
    raw instanceof Date ? raw : typeof raw === "string" ? new Date(raw) : null;
  if (generatedAt === null || Number.isNaN(generatedAt.getTime())) {
    return true;
  }
  return asOf.getTime() - generatedAt.getTime() >= everyMs;
}
