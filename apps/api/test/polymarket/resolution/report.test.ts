// RFC-012 phase C: the measurement report's statistical honesty. Wilson
// intervals at tiny and growing n, and the due-check against the last STORED
// report (deploys must not starve the cadence).

import { describe, expect, it } from "vitest";

import type { QueryResult } from "../../../src/database.js";
import { DEFAULT_RESOLUTION_CONFIG } from "../../../src/polymarket/resolution/config.js";
import { DEFAULT_RESOLUTION_LEXICON } from "../../../src/polymarket/resolution/lexicon.js";
import {
  backtestVeto,
  generateResolutionReport,
  reportDue,
  wilsonInterval,
} from "../../../src/polymarket/resolution/report.js";
import type { RecomputeDeps } from "../../../src/polymarket/resolution/recompute.js";
import type { ResolutionPool } from "../../../src/polymarket/resolution/types.js";

type Row = Record<string, unknown>;

const NOW = new Date("2026-08-24T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function reportsPool(rows: Row[]): ResolutionPool {
  return {
    query<R extends Row>(text: string): Promise<QueryResult<R>> {
      if (text.includes("FROM resolution_reports")) {
        return Promise.resolve({ rows: rows as R[], rowCount: rows.length });
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

function categoryReportWorld(
  timelineRows: (sql: string) => readonly Row[],
  statsRows: readonly Row[] = [
    { category: "crypto", resolved: "1", disputed: "0", p5050: "0" },
  ],
): {
  readonly pool: ResolutionPool;
  readonly observed: {
    timelineSql: string;
    categories: unknown;
  };
} {
  const observed = { timelineSql: "", categories: null as unknown };
  const pool: ResolutionPool = {
    query<R extends Row>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      if (text.includes("COUNT(*)::bigint AS resolved")) {
        return Promise.resolve({
          rows: [...statsRows] as unknown as R[],
          rowCount: statsRows.length,
        });
      }
      if (text.includes("FROM resolution_uma_timeline")) {
        observed.timelineSql = text;
        const rows = timelineRows(text);
        return Promise.resolve({
          rows: [...rows] as unknown as R[],
          rowCount: rows.length,
        });
      }
      if (text.includes("ORDER BY t.received_at DESC")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes("INSERT INTO resolution_reports")) {
        observed.categories = JSON.parse(String(params[1])) as unknown;
        return Promise.resolve({
          rows: [{ report_id: "7" }] as unknown as R[],
          rowCount: 1,
        });
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  return { pool, observed };
}

function backtestPool(
  proposedAts: readonly Date[],
  observed: {
    priorBatchCalls: number;
    midCloseCalls: number;
    newestPrior: Date | null;
    historicalQuestionAvailable?: boolean;
  },
): ResolutionPool {
  return {
    query<R extends Row>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      if (text.includes("ORDER BY t.received_at DESC")) {
        return Promise.resolve({
          rows: proposedAts.map((proposedAt, index) => ({
            condition_id: `0xhistoric-${String(index)}`,
            proposed_at: proposedAt,
            was_disputed: index === 0,
          })) as unknown as R[],
          rowCount: proposedAts.length,
        });
      }
      if (text.includes("FROM unnest($1::text[], $2::timestamptz[])")) {
        return Promise.resolve({
          rows: proposedAts.map((_, index) => ({
            condition_id: `0xhistoric-${String(index)}`,
            action: "enter",
            question:
              observed.historicalQuestionAvailable === false
                ? null
                : `Will historical event ${String(index)} happen?`,
            category: "crypto",
            neg_risk: false,
            token_ids: [
              `token-${String(index)}-yes`,
              `token-${String(index)}-no`,
            ],
            affirmative_token_id: `token-${String(index)}-yes`,
          })) as unknown as R[],
          rowCount: proposedAts.length,
        });
      }
      if (text.includes("AS is_p5050")) {
        observed.priorBatchCalls += 1;
        const newest = params?.[0];
        if (newest instanceof Date) {
          observed.newestPrior = newest;
        }
        return Promise.resolve({
          rows: [
            {
              condition_id: "0xprior",
              category: "crypto",
              terminal_at: new Date("2026-08-01T00:00:00.000Z"),
              disputed_at: null,
              is_p5050: false,
            },
          ] as unknown as R[],
          rowCount: 1,
        });
      }
      if (text.includes("FROM polymarket_series_1m")) {
        observed.midCloseCalls += 1;
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (
        text.includes("FROM polymarket_rule_versions") ||
        text.includes("FROM polymarket_resolution_events") ||
        text.includes("FROM polymarket_oi_holders") ||
        text.includes("FROM resolution_clarifications")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

describe("wilsonInterval", () => {
  it("returns the vacuous [0, 1] interval at n = 0", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });

  it("matches the known Wilson 95% interval for 5/10", () => {
    const interval = wilsonInterval(5, 10);
    expect(interval.low).toBeCloseTo(0.2366, 3);
    // At p = 0.5 the Wilson interval is exactly symmetric about 0.5, so the
    // high bound is 1 - low.
    expect(interval.high).toBeCloseTo(0.7634, 3);
    expect(interval.low + interval.high).toBeCloseTo(1, 9);
  });

  it("keeps the upper bound honest at 0/50", () => {
    const interval = wilsonInterval(0, 50);
    expect(interval.low).toBe(0);
    expect(interval.high).toBeLessThan(0.09);
    expect(interval.high).toBeGreaterThan(0);
  });

  it("shrinks as n grows for a fixed proportion", () => {
    const width = (successes: number, n: number): number => {
      const interval = wilsonInterval(successes, n);
      return interval.high - interval.low;
    };
    expect(width(5, 10)).toBeGreaterThan(width(50, 100));
    expect(width(50, 100)).toBeGreaterThan(width(500, 1000));
  });
});

describe("reportDue", () => {
  it("is due when no report was ever stored", async () => {
    await expect(reportDue(reportsPool([]), DAY_MS, NOW)).resolves.toBe(true);
  });

  it("is due when the last report is older than the cadence", async () => {
    const pool = reportsPool([
      { generated_at: new Date(NOW.getTime() - 25 * HOUR_MS) },
    ]);
    await expect(reportDue(pool, DAY_MS, NOW)).resolves.toBe(true);
  });

  it("is not due when the last report is recent", async () => {
    const pool = reportsPool([
      { generated_at: new Date(NOW.getTime() - 1 * HOUR_MS) },
    ]);
    await expect(reportDue(pool, DAY_MS, NOW)).resolves.toBe(false);
  });
});

describe("category report as-of timeline", () => {
  it("excludes an event that occurred before asOf but was ingested later", async () => {
    const world = categoryReportWorld((sql) => {
      const receivedFilters = sql.match(/t\.received_at <= \$1/g) ?? [];
      return receivedFilters.length >= 2
        ? []
        : [
            {
              condition_id: "0xlate",
              metadata_version_id: "1",
              category: "crypto",
              result: "P1",
              lockup_s: "3600",
            },
          ];
    });
    const deps: RecomputeDeps = {
      pool: world.pool,
      config: DEFAULT_RESOLUTION_CONFIG,
      lexicon: DEFAULT_RESOLUTION_LEXICON,
      scoreVersion: DEFAULT_RESOLUTION_CONFIG.scoreVersion,
    };

    await generateResolutionReport(deps, NOW);

    const categories = world.observed.categories as Array<{
      results: Record<string, number>;
    }>;
    expect(categories[0]?.results).toEqual({});
    expect(
      world.observed.timelineSql.match(/t\.received_at <= \$1/g),
    ).toHaveLength(2);
    expect(
      world.observed.timelineSql.match(/t\.occurred_at <= \$1/g),
    ).toHaveLength(2);
  });

  it("uses terminal occurrence, rather than timeline materialization, for metadata", async () => {
    const world = categoryReportWorld((sql) => {
      const historicalCategory =
        sql.includes("polymarket_market_metadata_versions h") &&
        sql.includes("h.valid_from <= s.terminal_at") &&
        !sql.includes("polymarket_markets");
      return [
        {
          condition_id: "0xrecategorized",
          metadata_version_id: "1",
          category: historicalCategory ? "crypto" : "politics",
          result: "P2",
          lockup_s: "7200",
        },
      ];
    });
    const deps: RecomputeDeps = {
      pool: world.pool,
      config: DEFAULT_RESOLUTION_CONFIG,
      lexicon: DEFAULT_RESOLUTION_LEXICON,
      scoreVersion: DEFAULT_RESOLUTION_CONFIG.scoreVersion,
    };

    await generateResolutionReport(deps, NOW);

    const categories = world.observed.categories as Array<{
      category: string;
      results: Record<string, number>;
    }>;
    expect(categories[0]).toMatchObject({
      category: "crypto",
      results: { P2: 1 },
    });
    expect(world.observed.timelineSql).toContain(
      "t.occurred_at AS terminal_at",
    );
    expect(world.observed.timelineSql).not.toContain(
      "t.received_at AS terminal_at",
    );
    expect(world.observed.timelineSql).not.toContain("polymarket_markets");
  });

  it("keeps the terminal category across recategorization before late materialization", async () => {
    const terminalOccurredAt = new Date("2026-08-24T09:00:00.000Z");
    const recategorizedAt = new Date("2026-08-24T10:00:00.000Z");
    const timelineMaterializedAt = new Date("2026-08-24T11:00:00.000Z");
    expect(terminalOccurredAt.getTime()).toBeLessThan(
      recategorizedAt.getTime(),
    );
    expect(recategorizedAt.getTime()).toBeLessThan(
      timelineMaterializedAt.getTime(),
    );

    const world = categoryReportWorld(
      (sql) => {
        // Model the two metadata windows around the recategorization. This
        // regression fails if terminal_at is sourced from timeline received_at.
        const metadataLookupAt = sql.includes("t.occurred_at AS terminal_at")
          ? terminalOccurredAt
          : timelineMaterializedAt;
        return [
          {
            condition_id: "0xlate-materialization",
            metadata_version_id: metadataLookupAt < recategorizedAt ? "1" : "2",
            category: metadataLookupAt < recategorizedAt ? "crypto" : "macro",
            result: "P2",
            lockup_s: "3600",
          },
        ];
      },
      [
        { category: "crypto", resolved: "1", disputed: "0", p5050: "0" },
        { category: "macro", resolved: "1", disputed: "0", p5050: "0" },
      ],
    );
    const deps: RecomputeDeps = {
      pool: world.pool,
      config: DEFAULT_RESOLUTION_CONFIG,
      lexicon: DEFAULT_RESOLUTION_LEXICON,
      scoreVersion: DEFAULT_RESOLUTION_CONFIG.scoreVersion,
    };

    await generateResolutionReport(deps, NOW);

    const categories = world.observed.categories as Array<{
      category: string;
      results: Record<string, number>;
    }>;
    expect(
      categories.find((row) => row.category === "crypto")?.results,
    ).toEqual({ P2: 1 });
    expect(categories.find((row) => row.category === "macro")?.results).toEqual(
      {},
    );
    expect(world.observed.timelineSql).toContain("t.occurred_at <= $1");
    expect(world.observed.timelineSql).toContain("t.received_at <= $1");
  });

  it("keeps pre-migration terminals in unknown without borrowing future metadata", async () => {
    const world = categoryReportWorld(
      () => [
        {
          condition_id: "0xpre-metadata-history",
          metadata_version_id: null,
          category: "unknown",
          result: "P1",
          lockup_s: "60",
        },
      ],
      [
        {
          category: "unknown",
          resolved: "1",
          disputed: "0",
          p5050: "0",
        },
      ],
    );
    const deps: RecomputeDeps = {
      pool: world.pool,
      config: DEFAULT_RESOLUTION_CONFIG,
      lexicon: DEFAULT_RESOLUTION_LEXICON,
      scoreVersion: DEFAULT_RESOLUTION_CONFIG.scoreVersion,
    };

    await generateResolutionReport(deps, NOW);

    const categories = world.observed.categories as Array<{
      category: string;
      results: Record<string, number>;
    }>;
    expect(categories).toEqual([
      expect.objectContaining({
        category: "unknown",
        results: { P1: 1 },
      }),
    ]);
    expect(world.observed.timelineSql).toContain(
      "COALESCE(m.category, 'unknown')",
    );
    expect(world.observed.timelineSql).not.toContain("polymarket_markets");
  });
});

describe("backtestVeto", () => {
  it("batches historical priors and preserves as-of universe membership", async () => {
    const proposedAts = [
      new Date("2026-08-20T10:00:00.000Z"),
      new Date("2026-08-21T10:00:00.000Z"),
    ];
    const observed = {
      priorBatchCalls: 0,
      midCloseCalls: 0,
      newestPrior: null as Date | null,
    };
    const pool = backtestPool(proposedAts, observed);
    const deps: RecomputeDeps = {
      pool,
      config: DEFAULT_RESOLUTION_CONFIG,
      lexicon: DEFAULT_RESOLUTION_LEXICON,
      scoreVersion: DEFAULT_RESOLUTION_CONFIG.scoreVersion,
    };

    const report = await backtestVeto(deps, NOW);

    expect(report.n_resolved).toBe(2);
    expect(report.n_scored).toBe(2);
    expect(report.n_skipped_no_historical_inputs).toBe(0);
    expect(report.n_skipped_outside_universe).toBe(0);
    expect(observed.priorBatchCalls).toBe(1);
    expect(observed.newestPrior).toEqual(new Date("2026-08-21T09:59:00.000Z"));
    expect(observed.newestPrior).not.toEqual(NOW);
    // Two mid reads per market prove inUniverse was reconstructed as true;
    // the old direct loader hard-coded false and disabled suspectJump here.
    expect(observed.midCloseCalls).toBe(4);
  });

  it("does not score a market without metadata valid at the decision", async () => {
    const observed = {
      priorBatchCalls: 0,
      midCloseCalls: 0,
      newestPrior: null as Date | null,
      historicalQuestionAvailable: false,
    };
    const pool = backtestPool([new Date("2026-08-20T10:00:00.000Z")], observed);
    const deps: RecomputeDeps = {
      pool,
      config: DEFAULT_RESOLUTION_CONFIG,
      lexicon: DEFAULT_RESOLUTION_LEXICON,
      scoreVersion: DEFAULT_RESOLUTION_CONFIG.scoreVersion,
    };

    const report = await backtestVeto(deps, NOW);

    expect(report.n_resolved).toBe(1);
    expect(report.n_scored).toBe(0);
    expect(report.n_skipped_no_historical_inputs).toBe(1);
    expect(observed.midCloseCalls).toBe(0);
  });
});
