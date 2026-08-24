// RFC-012 phase C: the measurement report's statistical honesty. Wilson
// intervals at tiny and growing n, and the due-check against the last STORED
// report (deploys must not starve the cadence).

import { describe, expect, it } from "vitest";

import type { QueryResult } from "../../../src/database.js";
import {
  reportDue,
  wilsonInterval,
} from "../../../src/polymarket/resolution/report.js";
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
