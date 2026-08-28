import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryResult } from "../../src/database.js";
import {
  createRetentionJob,
  DEFAULT_BUDGET_BYTES,
  QUOTA_TRIGGER_RATIO,
  RETENTION_TABLES,
  type RetentionTableConfig,
} from "../../src/polymarket/retention.js";

interface CapturedQuery {
  readonly text: string;
  readonly params: unknown[];
}

type Responder = (
  text: string,
  params: readonly unknown[],
  captured: readonly CapturedQuery[],
) => { rows: Record<string, unknown>[]; rowCount: number } | null;

function fakePool(responder: Responder): {
  captured: CapturedQuery[];
  query: <R extends Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ) => Promise<QueryResult<R>>;
} {
  const captured: CapturedQuery[] = [];
  return {
    captured,
    query<R extends Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      const canned = responder(text, params ?? [], captured);
      captured.push({ text, params: [...(params ?? [])] });
      return Promise.resolve(
        (canned as QueryResult<R> | null) ?? { rows: [], rowCount: 0 },
      );
    },
  };
}

const NOW = new Date("2026-08-19T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

function stderrLines(): string[] {
  return stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
}

describe("retention config", () => {
  it("marks the RFC metadata tables as protected and keeps the RFC TTL/quota values", () => {
    const byName = new Map(RETENTION_TABLES.map((t) => [t.table, t]));
    for (const name of [
      "polymarket_markets",
      "polymarket_events",
      "polymarket_event_markets",
      "polymarket_rule_versions",
      "polymarket_param_versions",
      "polymarket_market_metadata_versions",
      "polymarket_resolution_input_changes",
      "polymarket_resolution_events",
      "polymarket_data_gaps",
      "polymarket_universe_log",
      "polymarket_macro_calendar",
      "polymarket_macro_releases",
      "polymarket_retention_log",
    ]) {
      expect(byName.get(name)?.protected, name).toBe(true);
      expect(byName.get(name)?.ttlDays, name).toBeNull();
    }
    // Quotas amended by the owner on 2026-08-25 after production measurement
    // (~15.3 GB/day of deltas, ~1.6 GB/day of snapshots, ~100 MB/day of 1m
    // aggregates): 12 -> 60 GB, 4 -> 8 GB and 3 -> 10 GB. RFC-013 then took
    // 8 GB back from the deltas (60 -> 52) to fund the expansion of the
    // RFC-010..013 reserve from 6 to 8 GB, keeping the declared total at 89 GB.
    expect(byName.get("polymarket_book_deltas")?.ttlDays).toBe(14);
    expect(byName.get("polymarket_book_deltas")?.quotaBytes).toBe(
      52 * 1024 ** 3,
    );
    expect(byName.get("polymarket_book_deltas")?.requiresSeriesCoverage).toBe(
      true,
    );
    expect(byName.get("polymarket_book_snapshots_full")?.ttlDays).toBe(30);
    expect(byName.get("polymarket_book_snapshots")?.ttlDays).toBe(90);
    expect(byName.get("polymarket_trades")?.ttlDays).toBe(365);
    expect(byName.get("polymarket_series_1m")?.ttlDays).toBeNull();
    expect(byName.get("polymarket_series_1m")?.quotaBytes).toBe(10 * 1024 ** 3);
    expect(byName.get("polymarket_book_snapshots")?.quotaBytes).toBe(
      8 * 1024 ** 3,
    );
    expect(byName.get("polymarket_rtds_prices")?.ttlDays).toBe(90);
    expect(byName.get("resolution_scores")).toMatchObject({
      ttlDays: 180,
      quotaBytes: 0.35 * 1024 ** 3,
      timeColumn: "received_at",
      protected: false,
    });
    expect(byName.get("resolution_score_versions")).toMatchObject({
      ttlDays: null,
      protected: true,
    });
    expect(byName.get("resolution_market_state")).toMatchObject({
      ttlDays: null,
      protected: true,
    });
    expect(byName.get("graph_sanity_vetoes")).toMatchObject({
      ttlDays: 180,
      timeColumn: "ended_at",
      protected: false,
      closedRowsOnly: true,
    });
  });

  it("keeps the declared quotas inside the global alarm trigger", () => {
    // The global alarm is a backstop, not a routine condition: a retention plan
    // whose own declared quotas already reach the trigger would alarm forever
    // while behaving exactly as designed. Asserted so a future quota raise has
    // to move the budget with it instead of silently arming the alarm.
    const GiB = 1024 ** 3;
    const trigger = DEFAULT_BUDGET_BYTES * QUOTA_TRIGGER_RATIO;
    const declared = RETENTION_TABLES.reduce((sum, t) => sum + t.quotaBytes, 0);
    const prunable = RETENTION_TABLES.filter((t) => !t.protected).reduce(
      (sum, t) => sum + t.quotaBytes,
      0,
    );
    expect(declared / GiB).toBeCloseTo(95, 3);
    expect(prunable / GiB).toBeCloseTo(85.875, 3);
    expect(declared).toBeLessThan(trigger);

    // What the pruner can actually reach is smaller still, and that is the
    // point: with every prunable table pinned at quota the live total is
    // 85.875 GiB against a 99 GiB trigger, so the alarm can only be raised by
    // the protected tables overrunning their declared sizes — which the alarm's
    // TTL reduction cannot touch, because protected tables are never pruned.
    // The remedy therefore does not fit the only cause. Open for the owner.
    expect(prunable).toBeLessThan(trigger);
  });
});

describe("retention job", () => {
  it("never issues a DELETE against a protected table", async () => {
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        return { rows: [{ bytes: "1000", reltuples: "10" }], rowCount: 1 };
      }
      // book_deltas precondition finds no prunable tokens.
      if (text.includes("LEFT JOIN polymarket_series_1m")) {
        return { rows: [], rowCount: 0 };
      }
      return null;
    });
    const job = createRetentionJob({ pool, clock: () => NOW });
    await job.runOnce();

    const protectedTables = RETENTION_TABLES.filter((t) => t.protected).map(
      (t) => t.table,
    );
    const deletes = pool.captured.filter((q) => q.text.includes("DELETE FROM"));
    expect(deletes.length).toBeGreaterThan(0);
    for (const query of deletes) {
      for (const table of protectedTables) {
        expect(query.text).not.toContain(`DELETE FROM ${table}\n`);
        expect(query.text.startsWith(`DELETE FROM ${table} `)).toBe(false);
      }
    }
  });

  it("prunes nothing (and logs) when the token's first uncovered minute is its oldest", async () => {
    const config: RetentionTableConfig = {
      table: "polymarket_book_deltas",
      ttlDays: 14,
      quotaBytes: 12 * 1024 ** 3,
      timeColumn: "received_at",
      protected: false,
      requiresSeriesCoverage: true,
    };
    const cutoff = new Date(NOW.getTime() - 14 * DAY_MS);
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        return { rows: [{ bytes: "1000", reltuples: "10" }], rowCount: 1 };
      }
      if (
        text.includes("min(received_at)") &&
        text.includes("WHERE token_id = $1")
      ) {
        // Six hours of retained history: one 12h slice covers it exactly.
        return {
          rows: [
            {
              oldest: new Date(NOW.getTime() - 14 * DAY_MS - 6 * 3_600_000),
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("jsonb_array_elements_text")) {
        return { rows: [{ token_id: "t1" }], rowCount: 1 };
      }
      if (text.includes("LEFT JOIN polymarket_series_1m")) {
        // The very first minute below the cutoff has no bucket, so the prune
        // is truncated to it and nothing is actually deletable.
        return {
          rows: [
            {
              first_uncovered: new Date(
                NOW.getTime() - 14 * DAY_MS - 6 * 3_600_000,
              ),
            },
          ],
          rowCount: 1,
        };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    const report = await job.runOnce();

    // The delete is issued, but bounded by the hole rather than the cutoff.
    const deletes = pool.captured.filter((q) =>
      q.text.includes("DELETE FROM polymarket_book_deltas"),
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.params?.[0]).toEqual(
      new Date(NOW.getTime() - 14 * DAY_MS - 6 * 3_600_000),
    );
    expect(deletes[0]?.params?.[0]).not.toEqual(cutoff);
    expect(
      pool.captured.some((q) => q.text.includes("polymarket_retention_log")),
    ).toBe(false);
    expect(report.skipped).toEqual([
      {
        table: "polymarket_book_deltas",
        reason: "series_coverage_missing",
        tokenId: "t1",
      },
    ]);
    expect(
      stderrLines().some((line) => line.includes("SERIES_COVERAGE_MISSING")),
    ).toBe(true);
  });

  it("truncates the prune at the hole instead of freezing the token forever", async () => {
    // The regression this guards: a recorder restart leaves one unaggregated
    // minute, and the old all-or-nothing check froze that token's deltas
    // permanently. Every restart froze more tokens, so the quota could never
    // be met and the table grew without bound. A hole must only bound the
    // prune, never cancel it.
    const config: RetentionTableConfig = {
      table: "polymarket_book_deltas",
      ttlDays: 14,
      quotaBytes: 12 * 1024 ** 3,
      timeColumn: "received_at",
      protected: false,
      requiresSeriesCoverage: true,
    };
    const hole = new Date(NOW.getTime() - 14 * DAY_MS - 3 * 3_600_000);
    let coverageCalls = 0;
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        return { rows: [{ bytes: "1000", reltuples: "10" }], rowCount: 1 };
      }
      if (
        text.includes("min(received_at)") &&
        text.includes("WHERE token_id = $1")
      ) {
        // Six hours of retained history: one 12h slice covers it exactly.
        return {
          rows: [
            {
              oldest: new Date(NOW.getTime() - 14 * DAY_MS - 6 * 3_600_000),
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("jsonb_array_elements_text")) {
        return { rows: [{ token_id: "t1" }, { token_id: "t2" }], rowCount: 2 };
      }
      if (text.includes("LEFT JOIN polymarket_series_1m")) {
        // t1 has a hole inside its slice; t2 is fully covered.
        coverageCalls += 1;
        return {
          rows: [{ first_uncovered: coverageCalls === 1 ? hole : null }],
          rowCount: 1,
        };
      }
      if (text.includes("DELETE FROM polymarket_book_deltas")) {
        return { rows: [], rowCount: 5 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    const report = await job.runOnce();

    const deletes = pool.captured.filter((q) =>
      q.text.includes("DELETE FROM polymarket_book_deltas"),
    );
    // BOTH tokens were pruned: t1 up to its hole, t2 up to the TTL cutoff.
    expect(deletes).toHaveLength(2);
    expect(deletes[0]?.params?.[0]).toEqual(hole);
    expect(deletes[0]?.params?.[1]).toBe("t1");
    expect(deletes[1]?.params?.[0]).toEqual(
      new Date(NOW.getTime() - 14 * DAY_MS),
    );
    expect(deletes[1]?.params?.[1]).toBe("t2");
    // The hole is reported, never silent.
    expect(report.skipped).toEqual([
      {
        table: "polymarket_book_deltas",
        reason: "series_coverage_missing",
        tokenId: "t1",
      },
    ]);
    expect(report.actions[0]?.rowsDeleted).toBe(10);
  });

  it("scopes the coverage query per token so it rides the (token_id, received_at) index", async () => {
    // Measured in production: the single-query form was a full scan of 262 M
    // rows that blew through the recorder's 30 s statement_timeout and threw,
    // aborting the quota step on every run. Per token it is an index-only scan.
    const config: RetentionTableConfig = {
      table: "polymarket_book_deltas",
      ttlDays: 14,
      quotaBytes: 12 * 1024 ** 3,
      timeColumn: "received_at",
      protected: false,
      requiresSeriesCoverage: true,
    };
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        return { rows: [{ bytes: "1000", reltuples: "10" }], rowCount: 1 };
      }
      if (
        text.includes("min(received_at)") &&
        text.includes("WHERE token_id = $1")
      ) {
        // Six hours of retained history: one 12h slice covers it exactly.
        return {
          rows: [
            {
              oldest: new Date(NOW.getTime() - 14 * DAY_MS - 6 * 3_600_000),
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("jsonb_array_elements_text")) {
        return { rows: [{ token_id: "t1" }], rowCount: 1 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    await job.runOnce();

    const coverage = pool.captured.find((q) =>
      q.text.includes("LEFT JOIN polymarket_series_1m"),
    );
    expect(coverage?.text).toContain("d.token_id = $1");
    expect(coverage?.text).toContain("d.received_at < $2");
    expect(coverage?.text).toContain("min(m.minute)");
    expect(coverage?.params?.[0]).toBe("t1");
    // The token list comes from the protected registry table, never from a
    // DISTINCT over the 262-million-row delta table.
    const tokenList = pool.captured.find((q) =>
      q.text.includes("jsonb_array_elements_text"),
    );
    expect(tokenList?.text).toContain("FROM polymarket_markets");
  });

  it("keeps pruning the other tokens when one token's coverage query fails", async () => {
    const config: RetentionTableConfig = {
      table: "polymarket_book_deltas",
      ttlDays: 14,
      quotaBytes: 12 * 1024 ** 3,
      timeColumn: "received_at",
      protected: false,
      requiresSeriesCoverage: true,
    };
    let coverageCalls = 0;
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        return { rows: [{ bytes: "1000", reltuples: "10" }], rowCount: 1 };
      }
      if (
        text.includes("min(received_at)") &&
        text.includes("WHERE token_id = $1")
      ) {
        // Six hours of retained history: one 12h slice covers it exactly.
        return {
          rows: [
            {
              oldest: new Date(NOW.getTime() - 14 * DAY_MS - 6 * 3_600_000),
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("jsonb_array_elements_text")) {
        return { rows: [{ token_id: "t1" }, { token_id: "t2" }], rowCount: 2 };
      }
      if (text.includes("LEFT JOIN polymarket_series_1m")) {
        coverageCalls += 1;
        if (coverageCalls === 1) {
          throw new Error("statement timeout");
        }
        return { rows: [{ first_uncovered: null }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM polymarket_book_deltas")) {
        return { rows: [], rowCount: 4 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    const report = await job.runOnce();

    const deletes = pool.captured.filter((q) =>
      q.text.includes("DELETE FROM polymarket_book_deltas"),
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.params?.[1]).toBe("t2");
    expect(report.skipped).toEqual([
      {
        table: "polymarket_book_deltas",
        reason: "coverage_query_failed",
        tokenId: "t1",
      },
    ]);
    expect(report.actions[0]?.rowsDeleted).toBe(4);
  });

  it("prunes book_deltas in batches for covered tokens and writes the retention log", async () => {
    const config: RetentionTableConfig = {
      table: "polymarket_book_deltas",
      ttlDays: 14,
      quotaBytes: 12 * 1024 ** 3,
      timeColumn: "received_at",
      protected: false,
      requiresSeriesCoverage: true,
    };
    let deleteCalls = 0;
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        return { rows: [{ bytes: "1000", reltuples: "10" }], rowCount: 1 };
      }
      if (
        text.includes("min(received_at)") &&
        text.includes("WHERE token_id = $1")
      ) {
        // Six hours of retained history: one 12h slice covers it exactly.
        return {
          rows: [
            {
              oldest: new Date(NOW.getTime() - 14 * DAY_MS - 6 * 3_600_000),
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("jsonb_array_elements_text")) {
        return { rows: [{ token_id: "t1" }], rowCount: 1 };
      }
      if (text.includes("LEFT JOIN polymarket_series_1m")) {
        // No uncovered minute: prune the whole requested window.
        return { rows: [{ first_uncovered: null }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM polymarket_book_deltas")) {
        deleteCalls += 1;
        // First batch full (2 rows = batchSize), second partial: stop.
        return { rows: [], rowCount: deleteCalls === 1 ? 2 : 1 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
      batchSize: 2,
    });
    const report = await job.runOnce();

    expect(deleteCalls).toBe(2);
    const deletes = pool.captured.filter((q) =>
      q.text.includes("DELETE FROM polymarket_book_deltas"),
    );
    // TTL cutoff = now - 14d; deletes are limited to the covered token.
    expect(deletes[0]?.params?.[0]).toEqual(
      new Date(NOW.getTime() - 14 * DAY_MS),
    );
    expect(deletes[0]?.params?.[1]).toBe("t1");
    expect(deletes[0]?.text).toContain("LIMIT 2");

    expect(report.actions).toEqual([
      {
        table: "polymarket_book_deltas",
        cause: "ttl",
        prunedBefore: new Date(NOW.getTime() - 14 * DAY_MS),
        rowsDeleted: 3,
      },
    ]);
    const logInsert = pool.captured.find((q) =>
      q.text.includes("polymarket_retention_log"),
    );
    expect(logInsert?.params).toEqual([
      "polymarket_book_deltas",
      "ttl",
      new Date(NOW.getTime() - 14 * DAY_MS),
      3,
    ]);
  });

  it("applies sanity-veto TTL only to rows that are already closed", async () => {
    const config = RETENTION_TABLES.find(
      (table) => table.table === "graph_sanity_vetoes",
    );
    if (config === undefined) {
      throw new Error("graph_sanity_vetoes retention config missing");
    }
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        return { rows: [{ bytes: "100", reltuples: "2" }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM graph_sanity_vetoes")) {
        return { rows: [], rowCount: 1 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });

    await job.runOnce();

    const deletion = pool.captured.find((query) =>
      query.text.includes("DELETE FROM graph_sanity_vetoes"),
    );
    expect(deletion?.text).toContain("ended_at < $1");
    expect(deletion?.text).toContain("ended_at IS NOT NULL");
    expect(deletion?.params[0]).toEqual(new Date(NOW.getTime() - 180 * DAY_MS));
  });

  it("applies sanity-veto quota only to rows that are already closed", async () => {
    const config: RetentionTableConfig = {
      table: "graph_sanity_vetoes",
      ttlDays: null,
      quotaBytes: 1_000,
      timeColumn: "ended_at",
      protected: false,
      closedRowsOnly: true,
    };
    const cutoff = new Date("2026-01-01T00:00:00.000Z");
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        return { rows: [{ bytes: "1000", reltuples: "2" }], rowCount: 1 };
      }
      if (
        text.includes("SELECT ended_at AS cutoff") &&
        text.includes("FROM graph_sanity_vetoes")
      ) {
        return { rows: [{ cutoff }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM graph_sanity_vetoes")) {
        return { rows: [], rowCount: 1 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
      maxQuotaIterations: 1,
    });

    await job.runOnce();

    const cutoffQuery = pool.captured.find((query) =>
      query.text.includes("SELECT ended_at AS cutoff"),
    );
    expect(cutoffQuery?.text).toContain("WHERE ended_at IS NOT NULL");
    const deletion = pool.captured.find((query) =>
      query.text.includes("DELETE FROM graph_sanity_vetoes"),
    );
    expect(deletion?.text).toContain("ended_at < $1");
    expect(deletion?.text).toContain("ended_at IS NOT NULL");
  });

  it("allows pruning sparse tokens when every minute that has deltas has a bucket", async () => {
    // Bug scenario: deltas at 00:00, 00:05 and 00:10 only. An earlier check
    // demanded a bucket for EVERY minute of 00:00..00:10 (11 buckets), but
    // buckets only exist for minutes with events (3) — so book_deltas was
    // never prunable. Coverage compares against minutes that actually have
    // deltas, which is what the LEFT JOIN over the DISTINCT minutes does.
    const config: RetentionTableConfig = {
      table: "polymarket_book_deltas",
      ttlDays: 14,
      quotaBytes: 12 * 1024 ** 3,
      timeColumn: "received_at",
      protected: false,
      requiresSeriesCoverage: true,
    };
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        return { rows: [{ bytes: "1000", reltuples: "10" }], rowCount: 1 };
      }
      if (
        text.includes("min(received_at)") &&
        text.includes("WHERE token_id = $1")
      ) {
        // Six hours of retained history: one 12h slice covers it exactly.
        return {
          rows: [
            {
              oldest: new Date(NOW.getTime() - 14 * DAY_MS - 6 * 3_600_000),
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("jsonb_array_elements_text")) {
        return { rows: [{ token_id: "t1" }], rowCount: 1 };
      }
      if (text.includes("LEFT JOIN polymarket_series_1m")) {
        return { rows: [{ first_uncovered: null }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM polymarket_book_deltas")) {
        return { rows: [], rowCount: 7 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    const report = await job.runOnce();

    const coverageQuery = pool.captured.find((q) =>
      q.text.includes("LEFT JOIN polymarket_series_1m"),
    );
    expect(coverageQuery?.text).toContain("SELECT DISTINCT date_trunc");
    expect(coverageQuery?.text).toContain(
      "date_trunc('minute', d.received_at)",
    );

    expect(report.skipped).toEqual([]);
    expect(report.actions).toEqual([
      {
        table: "polymarket_book_deltas",
        cause: "ttl",
        prunedBefore: new Date(NOW.getTime() - 14 * DAY_MS),
        rowsDeleted: 7,
      },
    ]);
  });

  it("slices a long token history so no single coverage query spans it all", async () => {
    // Measured in production: the per-token coverage check is an index-only
    // scan, but its cost still grows with the range. At a 2-day cutoff the
    // heaviest token took 14.3 s; once the quota prune pushed the cutoff to
    // ~3.5 days it crossed the 30 s statement_timeout and that token lost its
    // whole prune. Slicing keeps each query small and advances in pieces.
    const config: RetentionTableConfig = {
      table: "polymarket_book_deltas",
      ttlDays: 14,
      quotaBytes: 12 * 1024 ** 3,
      timeColumn: "received_at",
      protected: false,
      requiresSeriesCoverage: true,
    };
    const cutoff = new Date(NOW.getTime() - 14 * DAY_MS);
    // Three days of retained history below the cutoff: six 12h slices.
    const oldest = new Date(cutoff.getTime() - 3 * DAY_MS);
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        return { rows: [{ bytes: "1000", reltuples: "10" }], rowCount: 1 };
      }
      if (
        text.includes("min(received_at)") &&
        text.includes("WHERE token_id = $1")
      ) {
        return { rows: [{ oldest }], rowCount: 1 };
      }
      if (text.includes("jsonb_array_elements_text")) {
        return { rows: [{ token_id: "t1" }], rowCount: 1 };
      }
      if (text.includes("LEFT JOIN polymarket_series_1m")) {
        return { rows: [{ first_uncovered: null }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM polymarket_book_deltas")) {
        return { rows: [], rowCount: 1 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    await job.runOnce();

    const coverage = pool.captured.filter((q) =>
      q.text.includes("LEFT JOIN polymarket_series_1m"),
    );
    expect(coverage.length).toBeGreaterThanOrEqual(6);
    // No individual query spans more than one slice.
    let previous = oldest.getTime();
    for (const query of coverage) {
      const sliceEnd = query.params?.[1] as Date;
      expect(sliceEnd.getTime() - previous).toBeLessThanOrEqual(
        12 * 60 * 60 * 1_000,
      );
      previous = sliceEnd.getTime();
    }
    // And the last slice lands exactly on the requested cutoff, never past it.
    const last = coverage[coverage.length - 1]?.params?.[1] as Date;
    expect(last.getTime()).toBe(cutoff.getTime());
  });

  it("keeps the table alive when one token's DELETE fails", async () => {
    // Measured in production on 2026-08-26: a batch on a heavy token exceeded
    // the 30 s statement_timeout (three indexes to maintain, one of them
    // 39 GB, under live write load). The exception escaped past the coverage
    // guard and aborted the WHOLE table's quota step, losing the prune for all
    // 1142 tokens on every run.
    const config: RetentionTableConfig = {
      table: "polymarket_book_deltas",
      ttlDays: 14,
      quotaBytes: 12 * 1024 ** 3,
      timeColumn: "received_at",
      protected: false,
      requiresSeriesCoverage: true,
    };
    const pool = fakePool((text, params) => {
      if (text.includes("pg_total_relation_size")) {
        return { rows: [{ bytes: "1000", reltuples: "10" }], rowCount: 1 };
      }
      if (
        text.includes("min(received_at)") &&
        text.includes("WHERE token_id = $1")
      ) {
        return {
          rows: [
            {
              oldest: new Date(NOW.getTime() - 14 * DAY_MS - 6 * 3_600_000),
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("jsonb_array_elements_text")) {
        return { rows: [{ token_id: "t1" }, { token_id: "t2" }], rowCount: 2 };
      }
      if (text.includes("LEFT JOIN polymarket_series_1m")) {
        return { rows: [{ first_uncovered: null }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM polymarket_book_deltas")) {
        if (params[1] === "t1") {
          throw new Error("statement timeout");
        }
        return { rows: [], rowCount: 6 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    const report = await job.runOnce();

    // t2 was still pruned; only t1 was lost.
    const deletes = pool.captured.filter((q) =>
      q.text.includes("DELETE FROM polymarket_book_deltas"),
    );
    expect(deletes.some((q) => q.params?.[1] === "t2")).toBe(true);
    expect(report.actions[0]?.rowsDeleted).toBe(6);
    expect(report.skipped).toEqual([
      {
        table: "polymarket_book_deltas",
        reason: "delete_failed",
        tokenId: "t1",
      },
    ]);
  });

  it("uses a smaller DELETE batch on coverage-gated tables", async () => {
    // Index maintenance dominates the cost there, so the batch that finishes
    // matters more than the batch that is theoretically fastest.
    const config: RetentionTableConfig = {
      table: "polymarket_book_deltas",
      ttlDays: 14,
      quotaBytes: 12 * 1024 ** 3,
      timeColumn: "received_at",
      protected: false,
      requiresSeriesCoverage: true,
    };
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        return { rows: [{ bytes: "1000", reltuples: "10" }], rowCount: 1 };
      }
      if (
        text.includes("min(received_at)") &&
        text.includes("WHERE token_id = $1")
      ) {
        return {
          rows: [
            {
              oldest: new Date(NOW.getTime() - 14 * DAY_MS - 6 * 3_600_000),
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("jsonb_array_elements_text")) {
        return { rows: [{ token_id: "t1" }], rowCount: 1 };
      }
      if (text.includes("LEFT JOIN polymarket_series_1m")) {
        return { rows: [{ first_uncovered: null }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM polymarket_book_deltas")) {
        return { rows: [], rowCount: 1 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    await job.runOnce();

    const deletion = pool.captured.find((q) =>
      q.text.includes("DELETE FROM polymarket_book_deltas"),
    );
    expect(deletion?.text).toContain("LIMIT 5000");
    expect(deletion?.text).not.toContain("LIMIT 50000");
  });

  it("stops a token at the first hole instead of walking every remaining slice", async () => {
    const config: RetentionTableConfig = {
      table: "polymarket_book_deltas",
      ttlDays: 14,
      quotaBytes: 12 * 1024 ** 3,
      timeColumn: "received_at",
      protected: false,
      requiresSeriesCoverage: true,
    };
    const cutoff = new Date(NOW.getTime() - 14 * DAY_MS);
    const oldest = new Date(cutoff.getTime() - 3 * DAY_MS);
    const hole = new Date(oldest.getTime() + 6 * 3_600_000);
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        return { rows: [{ bytes: "1000", reltuples: "10" }], rowCount: 1 };
      }
      if (
        text.includes("min(received_at)") &&
        text.includes("WHERE token_id = $1")
      ) {
        return { rows: [{ oldest }], rowCount: 1 };
      }
      if (text.includes("jsonb_array_elements_text")) {
        return { rows: [{ token_id: "t1" }], rowCount: 1 };
      }
      if (text.includes("LEFT JOIN polymarket_series_1m")) {
        return { rows: [{ first_uncovered: hole }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM polymarket_book_deltas")) {
        return { rows: [], rowCount: 3 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    const report = await job.runOnce();

    // One slice only: the hole ends the token's prune for this run.
    const coverage = pool.captured.filter((q) =>
      q.text.includes("LEFT JOIN polymarket_series_1m"),
    );
    expect(coverage).toHaveLength(1);
    const deletes = pool.captured.filter((q) =>
      q.text.includes("DELETE FROM polymarket_book_deltas"),
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.params?.[0]).toEqual(hole);
    expect(report.skipped).toEqual([
      {
        table: "polymarket_book_deltas",
        reason: "series_coverage_missing",
        tokenId: "t1",
      },
    ]);
  });

  it("interpolates the quota cutoff on a large table instead of probing by OFFSET", async () => {
    // Measured in production: OFFSET 100 000 000 on polymarket_book_deltas took
    // 42.7 s against a 30 s statement_timeout. It threw, the quota step aborted
    // on every run, and the table grew to 104 GB. Above the row threshold the
    // cutoff comes from the time range, which is two index lookups.
    const config: RetentionTableConfig = {
      table: "polymarket_rtds_prices",
      ttlDays: null,
      quotaBytes: 160_000_000,
      timeColumn: "received_at",
      protected: false,
    };
    const oldest = new Date("2026-08-01T00:00:00Z");
    const newest = new Date("2026-08-11T00:00:00Z");
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        // 160 MB over 10 M rows = 16 B/row (so the byte-budgeted batch stays
        // above the single 2 M-row batch this test wants); target is 80% of
        // the quota, so 2 M rows must go — 20% of the table.
        return {
          rows: [
            {
              bytes: "160000000",
              reltuples: "10000000",
              live_tup: "10000000",
              dead_tup: "0",
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("min(received_at)")) {
        return { rows: [{ oldest, newest }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM polymarket_rtds_prices")) {
        return { rows: [], rowCount: 2_000_000 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
      // One batch big enough to hold the whole prune, so the assertion below
      // reads the interpolation and not the batching loop.
      batchSize: 3_000_000,
    });
    const report = await job.runOnce();

    // No OFFSET probe at all on a table this size.
    expect(pool.captured.some((q) => q.text.includes("OFFSET"))).toBe(false);
    const bounds = pool.captured.find((q) =>
      q.text.includes("min(received_at)"),
    );
    expect(bounds?.text).toContain("max(received_at)");
    // 20% of the rows must go, so the cutoff lands 20% into the 10-day span.
    const deletion = pool.captured.find((q) =>
      q.text.includes("DELETE FROM polymarket_rtds_prices"),
    );
    expect(deletion?.params?.[0]).toEqual(new Date("2026-08-03T00:00:00Z"));
    expect(report.actions[0]?.rowsDeleted).toBe(2_000_000);
  });

  it("reads the quota cutoff from the column histogram, not the linear span", async () => {
    // Measured in production 2026-08-27: polymarket_book_deltas ran from 0.5 M
    // rows/day to 27 M rows/day inside one 8-day window as the universe grew.
    // The linear estimate assumes a uniform arrival rate, so it asked for 56%
    // of the rows and picked a timestamp holding 23% of them — the table sat at
    // 95 GB against a 52 GB quota. The equi-depth histogram answers correctly.
    const config: RetentionTableConfig = {
      table: "polymarket_rtds_prices",
      ttlDays: null,
      quotaBytes: 10_000_000_000,
      timeColumn: "received_at",
      protected: false,
    };
    // Ten equal-ROW buckets over a ten-day span, with the mass late: 20% of the
    // rows are older than Aug 8, where a uniform reading would say Aug 3.
    const bounds = [
      new Date("2026-08-01T00:00:00Z"),
      new Date("2026-08-07T00:00:00Z"),
      new Date("2026-08-08T00:00:00Z"),
      new Date("2026-08-09T00:00:00Z"),
      new Date("2026-08-09T12:00:00Z"),
      new Date("2026-08-10T00:00:00Z"),
      new Date("2026-08-10T06:00:00Z"),
      new Date("2026-08-10T12:00:00Z"),
      new Date("2026-08-10T18:00:00Z"),
      new Date("2026-08-10T21:00:00Z"),
      new Date("2026-08-11T00:00:00Z"),
    ];
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        // 10 GB over 10 M rows = 1 kB/row; target is 80% of the quota, so 2 M
        // rows must go — two of the ten equal-row buckets.
        return {
          rows: [
            {
              bytes: "10000000000",
              reltuples: "10000000",
              live_tup: "10000000",
              dead_tup: "0",
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("histogram_bounds")) {
        return { rows: [{ bounds }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM polymarket_rtds_prices")) {
        return { rows: [], rowCount: 2_000_000 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
      batchSize: 3_000_000,
    });
    await job.runOnce();

    const deletion = pool.captured.find((q) =>
      q.text.includes("DELETE FROM polymarket_rtds_prices"),
    );
    // bounds[2], the real 20% mark — not 2026-08-03, the uniform one.
    expect(deletion?.params?.[0]).toEqual(new Date("2026-08-08T00:00:00Z"));
    // The histogram answered, so the min()/max() span was never asked for.
    expect(pool.captured.some((q) => q.text.includes("min(received_at)"))).toBe(
      false,
    );
  });

  it("falls back to the linear span when the histogram omits too many rows", async () => {
    // histogram_bounds describes only the rows that are neither NULL nor a most
    // common value. That is ~all of them for a sub-second timestamp column, but
    // it is a property of the data, so it is checked rather than assumed.
    const config: RetentionTableConfig = {
      table: "polymarket_rtds_prices",
      ttlDays: null,
      quotaBytes: 10_000_000_000,
      timeColumn: "received_at",
      protected: false,
    };
    const oldest = new Date("2026-08-01T00:00:00Z");
    const newest = new Date("2026-08-11T00:00:00Z");
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        return {
          rows: [
            {
              bytes: "10000000000",
              reltuples: "10000000",
              live_tup: "10000000",
              dead_tup: "0",
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("histogram_bounds")) {
        // Half the column sits in most-common values: the bucket fractions no
        // longer describe the table.
        return {
          rows: [
            {
              bounds: [oldest, newest],
              null_frac: 0.1,
              mcv_frac: 0.4,
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("min(received_at)")) {
        return { rows: [{ oldest, newest }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM polymarket_rtds_prices")) {
        return { rows: [], rowCount: 2_000_000 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
      batchSize: 3_000_000,
    });
    await job.runOnce();

    expect(
      stderrLines().some((line) =>
        line.includes("RETENTION_HISTOGRAM_UNUSABLE"),
      ),
    ).toBe(true);
    // 20% of the rows over the 10-day span: the linear answer, as before.
    const deletion = pool.captured.find((q) =>
      q.text.includes("DELETE FROM polymarket_rtds_prices"),
    );
    expect(deletion?.params?.[0]).toEqual(new Date("2026-08-03T00:00:00Z"));
  });

  it("advances the cutoff when a pass deletes less than planned", async () => {
    // Regression: the loop used to move BACKWARDS. A short pass leaves a larger
    // shortfall, but rowsToDelete is measured against the target and something
    // was deleted, so the next fraction was SMALLER and the next cutoff earlier
    // than the one just pruned to — deleting nothing and aborting. The
    // maxQuotaIterations budget was worth one pass, every run.
    const config: RetentionTableConfig = {
      table: "polymarket_rtds_prices",
      ttlDays: null,
      quotaBytes: 40_000_000,
      timeColumn: "received_at",
      protected: false,
    };
    const bounds = Array.from(
      { length: 11 },
      (_, i) => new Date(Date.UTC(2026, 7, 1 + i)),
    );
    const pool = fakePool((text, _params, captured) => {
      if (text.includes("pg_total_relation_size")) {
        // 16 B rows: the byte-budgeted batch cap stays above the canned 1 M-row
        // first pass, so the assertions read the cutoff walk, not the batching.
        return {
          rows: [
            {
              bytes: "160000000",
              reltuples: "10000000",
              live_tup: "10000000",
              dead_tup: "0",
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("histogram_bounds")) {
        return { rows: [{ bounds }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM polymarket_rtds_prices")) {
        // The first pass under-delivers: 1 M rows against the 8 M it planned.
        const previous = captured.filter((q) =>
          q.text.includes("DELETE FROM polymarket_rtds_prices"),
        ).length;
        return { rows: [], rowCount: previous === 0 ? 1_000_000 : 0 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
      batchSize: 9_000_000,
    });
    await job.runOnce();

    const cutoffs = pool.captured
      .filter((q) => q.text.includes("DELETE FROM polymarket_rtds_prices"))
      .map((q) => q.params?.[0] as Date);
    expect(cutoffs.length).toBeGreaterThanOrEqual(2);
    // 8 of 10 equal-row buckets on the first pass, then strictly forward.
    expect(cutoffs[0]).toEqual(bounds[8]);
    expect(cutoffs[1]!.getTime()).toBeGreaterThan(cutoffs[0]!.getTime());
  });

  it("stops instead of spinning when the cutoff cannot advance", async () => {
    // Backstop for the forward-only invariant on the exact-probe path, which
    // has no floor of its own: if a later probe answers with an earlier row,
    // the pass would re-delete nothing. Stop and say so.
    const config: RetentionTableConfig = {
      table: "polymarket_rtds_prices",
      ttlDays: null,
      quotaBytes: 1_000,
      timeColumn: "received_at",
      protected: false,
    };
    const late = new Date("2026-08-10T00:00:00Z");
    const early = new Date("2026-08-02T00:00:00Z");
    const pool = fakePool((text, _params, captured) => {
      if (text.includes("pg_total_relation_size")) {
        return {
          rows: [
            { bytes: "10000", reltuples: "10", live_tup: "10", dead_tup: "0" },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("OFFSET")) {
        const previous = captured.filter((q) =>
          q.text.includes("OFFSET"),
        ).length;
        return {
          rows: [{ cutoff: previous === 0 ? late : early }],
          rowCount: 1,
        };
      }
      if (text.includes("DELETE FROM polymarket_rtds_prices")) {
        return { rows: [], rowCount: 1 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    await job.runOnce();

    const deletions = pool.captured.filter((q) =>
      q.text.includes("DELETE FROM polymarket_rtds_prices"),
    );
    expect(deletions).toHaveLength(1);
    expect(deletions[0]?.params?.[0]).toEqual(late);
    expect(
      stderrLines().some((line) =>
        line.includes("RETENTION_QUOTA_NO_PROGRESS"),
      ),
    ).toBe(true);
  });

  it("clamps the interpolated cutoff so it can never reach the newest row", async () => {
    // The clamp is what stops an over-estimate from becoming "delete
    // everything below now" — the exact failure the COUNT fallback guards
    // against on the small-table path.
    const config: RetentionTableConfig = {
      table: "polymarket_rtds_prices",
      ttlDays: null,
      quotaBytes: 1_000_000_000,
      timeColumn: "received_at",
      protected: false,
    };
    const oldest = new Date("2026-08-01T00:00:00Z");
    const newest = new Date("2026-08-11T00:00:00Z");
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        // 100x over quota: the naive fraction would be 0.992, and an even
        // larger overshoot would exceed 1 outright.
        return {
          rows: [
            {
              bytes: "100000000000",
              reltuples: "10000000",
              live_tup: "10000000",
              dead_tup: "0",
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("min(received_at)")) {
        return { rows: [{ oldest, newest }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM polymarket_rtds_prices")) {
        return { rows: [], rowCount: 1 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    await job.runOnce();

    const deletion = pool.captured.find((q) =>
      q.text.includes("DELETE FROM polymarket_rtds_prices"),
    );
    const cutoff = deletion?.params?.[0] as Date;
    // 90% of the span, never 100%.
    expect(cutoff.toISOString()).toBe("2026-08-10T00:00:00.000Z");
    expect(cutoff.getTime()).toBeLessThan(newest.getTime());
  });

  it("keeps the exact OFFSET probe for tables small enough to afford it", async () => {
    const config: RetentionTableConfig = {
      table: "polymarket_rtds_prices",
      ttlDays: null,
      quotaBytes: 1_000,
      timeColumn: "received_at",
      protected: false,
    };
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        return {
          rows: [
            { bytes: "1000", reltuples: "100", live_tup: "100", dead_tup: "0" },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("OFFSET 19")) {
        return {
          rows: [{ cutoff: new Date("2026-05-01T00:00:00Z") }],
          rowCount: 1,
        };
      }
      if (text.includes("DELETE FROM polymarket_rtds_prices")) {
        return { rows: [], rowCount: 25 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    await job.runOnce();

    expect(pool.captured.some((q) => q.text.includes("OFFSET 19"))).toBe(true);
    expect(pool.captured.some((q) => q.text.includes("min(received_at)"))).toBe(
      false,
    );
  });

  it("measures the quota against LIVE bytes, so bloat never drives a second prune", async () => {
    // Production shape after a large prune: the file still measures 1000 bytes
    // but 52% of the tuples are dead, so only 480 bytes are actually retained.
    // Using the physical size here is the data-destroying bug: it would prune
    // another 20% of the LIVE rows on every run until the table was empty.
    const config: RetentionTableConfig = {
      table: "polymarket_rtds_prices",
      ttlDays: null,
      quotaBytes: 1_000,
      timeColumn: "received_at",
      protected: false,
    };
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        return {
          rows: [
            {
              bytes: "1000",
              reltuples: "100",
              live_tup: "48",
              dead_tup: "52",
            },
          ],
          rowCount: 1,
        };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    const report = await job.runOnce();

    expect(pool.captured.some((q) => q.text.includes("DELETE FROM"))).toBe(
      false,
    );
    expect(pool.captured.some((q) => q.text.includes("OFFSET"))).toBe(false);
    expect(report.actions).toHaveLength(0);
    // The disk footprint is still reported, never silently swallowed.
    const bloat = stderrLines().filter((line) =>
      line.includes("RETENTION_BLOAT"),
    );
    expect(bloat).toHaveLength(1);
    expect(bloat[0]).toContain('"physical_bytes":1000');
    expect(bloat[0]).toContain('"live_bytes":480');
    // The global budget still counts the physical bytes: the disk is really
    // holding them.
    expect(report.totalBytes).toBe(1000);
  });

  it("sizes the quota cutoff from live bytes and live rows, not from the bloated file", async () => {
    const config: RetentionTableConfig = {
      table: "polymarket_rtds_prices",
      ttlDays: null,
      quotaBytes: 1_000,
      timeColumn: "received_at",
      protected: false,
    };
    const cutoff = new Date("2026-05-01T00:00:00Z");
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        // 2000 physical, half the tuples dead => 1000 live bytes over 50 live
        // rows => 20 bytes/row. Target 800 => delete 10 rows => OFFSET 9.
        // Reading the physical 2000 with the stale reltuples of 200 would have
        // asked for 60 rows at OFFSET 59.
        return {
          rows: [
            {
              bytes: "2000",
              reltuples: "200",
              live_tup: "50",
              dead_tup: "50",
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("OFFSET 9")) {
        return { rows: [{ cutoff }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM polymarket_rtds_prices")) {
        // 15 rows removed for the 10 requested (partial batch), so the
        // estimate lands at 700 and the loop stops.
        return { rows: [], rowCount: 15 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    const report = await job.runOnce();

    const offsets = pool.captured.filter((q) => q.text.includes("OFFSET"));
    expect(offsets).toHaveLength(1);
    expect(offsets[0]?.text).toContain("OFFSET 9");
    expect(report.actions).toHaveLength(1);
    expect(report.actions[0]).toMatchObject({
      table: "polymarket_rtds_prices",
      cause: "quota",
      prunedBefore: cutoff,
    });
  });

  it("falls back to the physical size when the stats collector has no row for the table", async () => {
    // Freshly created table (or a stats reset): live/dead are unavailable, so
    // the quota must behave exactly as it did before live-byte accounting.
    const config: RetentionTableConfig = {
      table: "polymarket_rtds_prices",
      ttlDays: null,
      quotaBytes: 1_000,
      timeColumn: "received_at",
      protected: false,
    };
    const cutoff = new Date("2026-05-01T00:00:00Z");
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        return {
          rows: [
            { bytes: "1000", reltuples: "100", live_tup: null, dead_tup: null },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("OFFSET 19")) {
        return { rows: [{ cutoff }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM polymarket_rtds_prices")) {
        return { rows: [], rowCount: 20 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    const report = await job.runOnce();

    // 1000 bytes / 100 rows = 10 bytes/row, target 800 => 20 rows.
    expect(pool.captured.some((q) => q.text.includes("OFFSET 19"))).toBe(true);
    expect(report.actions).toHaveLength(1);
  });

  it("reads live and dead tuple counts from the stats collector", async () => {
    const config: RetentionTableConfig = {
      table: "polymarket_rtds_prices",
      ttlDays: null,
      quotaBytes: 1_000,
      timeColumn: "received_at",
      protected: false,
    };
    const pool = fakePool(() => null);
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    await job.runOnce();

    const sizeQuery = pool.captured.find((q) =>
      q.text.includes("pg_total_relation_size"),
    );
    expect(sizeQuery?.text).toContain("pg_stat_all_tables");
    expect(sizeQuery?.text).toContain("n_live_tup");
    expect(sizeQuery?.text).toContain("n_dead_tup");
  });

  it("aborts the quota pass (no DELETE, never cutoff=now) when the OFFSET probe and COUNT find no rows", async () => {
    // Bug scenario: reltuples is stale/overestimated right after a TTL prune,
    // so the OFFSET probe lands beyond the last row. The old code fell back
    // to cutoff = now, deleting the ENTIRE table.
    const config: RetentionTableConfig = {
      table: "polymarket_rtds_prices",
      ttlDays: null,
      quotaBytes: 1_000,
      timeColumn: "received_at",
      protected: false,
    };
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        return { rows: [{ bytes: "1000", reltuples: "100" }], rowCount: 1 };
      }
      if (text.includes("OFFSET")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("COUNT(*)")) {
        return { rows: [{ live_rows: "0" }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM")) {
        return { rows: [], rowCount: 999 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    const report = await job.runOnce();

    expect(pool.captured.some((q) => q.text.includes("DELETE FROM"))).toBe(
      false,
    );
    expect(report.actions).toEqual([]);
    expect(
      stderrLines().some((line) =>
        line.includes("RETENTION_CUTOFF_UNAVAILABLE"),
      ),
    ).toBe(true);
  });

  it("clamps rowsToDelete by the real COUNT(*) when the OFFSET probe overshoots", async () => {
    const config: RetentionTableConfig = {
      table: "polymarket_rtds_prices",
      ttlDays: null,
      quotaBytes: 1_000,
      timeColumn: "received_at",
      protected: false,
    };
    const realCutoff = new Date("2026-07-01T00:00:00Z");
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        return { rows: [{ bytes: "1000", reltuples: "100" }], rowCount: 1 };
      }
      // First probe: OFFSET 19 lands past the end (only 5 live rows exist).
      if (text.includes("OFFSET 19")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("COUNT(*)")) {
        return { rows: [{ live_rows: "5" }], rowCount: 1 };
      }
      // Clamped probe: OFFSET 4 (COUNT(*) - 1) hits the newest live row.
      if (text.includes("OFFSET 4")) {
        return { rows: [{ cutoff: realCutoff }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM polymarket_rtds_prices")) {
        return { rows: [], rowCount: 4 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
      maxQuotaIterations: 1,
    });
    const report = await job.runOnce();

    const deletes = pool.captured.filter((q) =>
      q.text.includes("DELETE FROM polymarket_rtds_prices"),
    );
    expect(deletes).toHaveLength(1);
    // The cutoff is the real row timestamp — never `now`.
    expect(deletes[0]?.params?.[0]).toEqual(realCutoff);
    expect(report.actions).toEqual([
      {
        table: "polymarket_rtds_prices",
        cause: "quota",
        prunedBefore: realCutoff,
        rowsDeleted: 4,
      },
    ]);
  });

  it("reports global bloat without alarming or shrinking TTLs", async () => {
    // Physical over the trigger, retained data far under it. Production was
    // NOT in this state on 2026-08-27 (114 GiB physical, 110 GiB live: the
    // retained data really was over budget), but this is the state the old
    // physical-bytes alarm could not tell apart from a real overshoot. Here the
    // alarm must NOT fire: its only lever is deleting rows, no delete shrinks a
    // file, so a haircut on every declared TTL would chase a number that cannot
    // move.
    const config: RetentionTableConfig = {
      table: "polymarket_book_snapshots",
      ttlDays: 90,
      quotaBytes: 4 * 1024 ** 3,
      timeColumn: "received_at",
      protected: false,
    };
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        // 950 physical, 40% of tuples live => 380 live bytes.
        return {
          rows: [
            {
              bytes: "950",
              reltuples: "100",
              live_tup: "40",
              dead_tup: "60",
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("DELETE FROM")) {
        return { rows: [], rowCount: 0 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
      budgetBytes: 1_000,
    });
    const report = await job.runOnce();

    expect(report.globalAlarm).toBe(false);
    expect(report.totalBytes).toBe(950);
    expect(report.totalLiveBytes).toBe(380);
    expect(
      stderrLines().some((line) => line.includes("QUOTA_GLOBAL_ALARM")),
    ).toBe(false);
    expect(
      stderrLines().some((line) => line.includes("RETENTION_GLOBAL_BLOAT")),
    ).toBe(true);
    // The declared 90-day TTL is honoured in full: no 67.5-day haircut.
    const ttlDelete = pool.captured.find((q) =>
      q.text.includes("DELETE FROM polymarket_book_snapshots"),
    );
    expect(ttlDelete?.params?.[0]).toEqual(
      new Date(NOW.getTime() - 90 * DAY_MS),
    );
  });

  it("alarms at 90% of the global budget and shrinks effective TTLs by 25%", async () => {
    const config: RetentionTableConfig = {
      table: "polymarket_book_snapshots",
      ttlDays: 90,
      quotaBytes: 4 * 1024 ** 3,
      timeColumn: "received_at",
      protected: false,
    };
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        // 1000 physical of which 95% is live => 950 live bytes, over the 900
        // trigger. Stated as live tuples on purpose: the alarm is armed on
        // retained bytes, and this is the case where retained data really is
        // the thing over budget.
        return {
          rows: [
            {
              bytes: "1000",
              reltuples: "100",
              live_tup: "95",
              dead_tup: "5",
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("DELETE FROM")) {
        return { rows: [], rowCount: 0 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
      budgetBytes: 1_000,
    });
    const report = await job.runOnce();

    expect(report.globalAlarm).toBe(true);
    expect(
      stderrLines().some((line) => line.includes("QUOTA_GLOBAL_ALARM")),
    ).toBe(true);
    // Effective TTL: 90d * 0.75 = 67.5d.
    const ttlDelete = pool.captured.find((q) =>
      q.text.includes("DELETE FROM polymarket_book_snapshots"),
    );
    expect(ttlDelete?.params?.[0]).toEqual(
      new Date(NOW.getTime() - 67.5 * DAY_MS),
    );
  });

  it("survives a failing table without crashing the run", async () => {
    const config: RetentionTableConfig = {
      table: "polymarket_trades",
      ttlDays: 365,
      quotaBytes: 3 * 1024 ** 3,
      timeColumn: "received_at",
      protected: false,
    };
    const pool = fakePool((text) => {
      if (text.includes("DELETE FROM")) {
        throw new Error("connection lost");
      }
      if (text.includes("pg_total_relation_size")) {
        return { rows: [{ bytes: "1000", reltuples: "10" }], rowCount: 1 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    const report = await job.runOnce();
    expect(report.actions).toEqual([]);
    expect(
      stderrLines().some((line) => line.includes("RETENTION_STEP_FAILED")),
    ).toBe(true);
  });

  it("asks for no deletion when autovacuum zeroes the dead tuples on a bloated file", async () => {
    // The 2026-08-28 production shape, verbatim: autovacuum finished
    // (n_dead_tup = 0) and the file kept every page it ever grew, so the
    // dead-fraction discount degenerates to live == physical — 104.5 GB "live"
    // against a 52 GB quota, and the run asked to delete 33.9 M LIVE rows with
    // the retained data actually ~20 GB. The width-based meter reads the rows,
    // not the file, and must ask for nothing.
    const config = RETENTION_TABLES[0];
    if (config === undefined) {
      throw new Error("missing book_deltas config");
    }
    expect(config.table).toBe("polymarket_book_deltas");
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        return {
          rows: [
            {
              bytes: "104557125632",
              reltuples: "66135696",
              live_tup: "66368290",
              dead_tup: "0",
              toast_live_tup: "0",
              heap_width: "119",
              index_count: "3",
              index_key_width: "102",
            },
          ],
          rowCount: 1,
        };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    const report = await job.runOnce();

    expect(pool.captured.some((q) => q.text.includes("DELETE FROM"))).toBe(
      false,
    );
    expect(report.actions).toHaveLength(0);
    const lines = stderrLines();
    expect(lines.some((l) => l.includes("RETENTION_QUOTA_UNMET"))).toBe(false);
    expect(lines.some((l) => l.includes("RETENTION_CUTOFF_HISTOGRAM"))).toBe(
      false,
    );
    // The 84 GB of empty pages are surfaced as bloat, never as a prune.
    const bloat = lines.filter((l) => l.includes("RETENTION_BLOAT"));
    expect(bloat).toHaveLength(1);
    expect(bloat[0]).toContain('"table":"polymarket_book_deltas"');
  });

  it("counts live TOAST chunks in the live bytes", async () => {
    // jsonb-heavy rows keep most of their bytes in the TOAST relation, where
    // pg_stats.avg_width cannot see them (measured in production: the decision
    // log reads 1.4 kB by widths, 3.4 kB by pg_column_size). The toast side is
    // counted from its own live-chunk stats, never from its file size.
    const config: RetentionTableConfig = {
      table: "polymarket_rtds_prices",
      ttlDays: null,
      quotaBytes: 1_000_000,
      timeColumn: "received_at",
      protected: false,
    };
    const cutoff = new Date("2026-05-01T00:00:00Z");
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        // Heap-side live: 1000 x (100 + 28 + (8 + 16) / 0.9) = 154,667 bytes —
        // far under the 900,000 trigger. The 500 live toast chunks add
        // 1,024,000 bytes, and only with them does the quota trip.
        return {
          rows: [
            {
              bytes: "5000000",
              reltuples: "1000",
              live_tup: "1000",
              dead_tup: "0",
              toast_live_tup: "500",
              heap_width: "100",
              index_count: "1",
              index_key_width: "8",
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("OFFSET")) {
        return { rows: [{ cutoff }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM polymarket_rtds_prices")) {
        return { rows: [], rowCount: 400 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    const report = await job.runOnce();

    expect(report.actions).toHaveLength(1);
    expect(report.actions[0]?.cause).toBe("quota");
    // Live bytes carried the toast term into the report totals too.
    expect(Math.round(report.totalLiveBytes)).toBe(1_178_667);
  });

  it("clamps the quota cutoff to the floor persisted in the retention log", async () => {
    // The 13:37Z 2026-08-28 shape: a previous RUN had already pruned to
    // 08-18T00:00 (recorded in polymarket_retention_log), the process
    // restarted, and pg_stats still described the pre-prune table. The old
    // code had no memory across runs: the stale histogram picked a cutoff
    // 1.9 days behind the floor, deleted nothing and gave the run up.
    const floorMs = Date.parse("2026-08-18T00:00:00Z");
    const config: RetentionTableConfig = {
      table: "polymarket_rtds_prices",
      ttlDays: null,
      quotaBytes: 1024 ** 3,
      timeColumn: "received_at",
      protected: false,
    };
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        // 10 M live rows x 104.67 bytes/row = ~1.047 GB live, over the 0.966 GB
        // trigger, and large enough for the estimated (non-OFFSET) cutoff path.
        return {
          rows: [
            {
              bytes: "9000000000",
              reltuples: "10000000",
              live_tup: "10000000",
              dead_tup: "0",
              toast_live_tup: "0",
              heap_width: "50",
              index_count: "1",
              index_key_width: "8",
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("max(pruned_before)")) {
        return {
          rows: [{ floor: new Date(floorMs) }],
          rowCount: 1,
        };
      }
      if (text.includes("histogram_bounds")) {
        // Every bound predates the persisted floor: the histogram is a map of
        // a table state that no longer exists.
        return {
          rows: [
            {
              bounds: [
                new Date("2026-08-15T00:00:00Z"),
                new Date("2026-08-16T00:00:00Z"),
                new Date("2026-08-17T00:00:00Z"),
              ],
              null_frac: 0,
              mcv_frac: 0,
            },
          ],
          rowCount: 1,
        };
      }
      if (
        text.includes("min(received_at)") &&
        text.includes("max(received_at)")
      ) {
        return {
          rows: [
            {
              oldest: new Date("2026-08-10T00:00:00Z"),
              newest: new Date("2026-08-19T11:00:00Z"),
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("DELETE FROM polymarket_rtds_prices")) {
        return { rows: [], rowCount: 40_000 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
      maxQuotaIterations: 1,
    });
    await job.runOnce();

    // The floor was read from the log, and every DELETE landed beyond it.
    expect(
      pool.captured.some((q) => q.text.includes("max(pruned_before)")),
    ).toBe(true);
    const deletes = pool.captured.filter((q) =>
      q.text.includes("DELETE FROM polymarket_rtds_prices"),
    );
    expect(deletes.length).toBeGreaterThan(0);
    for (const del of deletes) {
      const cutoffParam = del.params[0];
      expect(cutoffParam).toBeInstanceOf(Date);
      expect((cutoffParam as Date).getTime()).toBeGreaterThan(floorMs);
    }
    // The estimate re-anchored at the floor, not at the stale histogram.
    expect(
      stderrLines().some(
        (l) =>
          l.includes("RETENTION_CUTOFF_INTERPOLATED") &&
          l.includes('"anchored_at":"2026-08-18T00:00:00.000Z"'),
      ),
    ).toBe(true);
  });

  it("runs ANALYZE after a prune so the next cutoff sees the new distribution", async () => {
    const config: RetentionTableConfig = {
      table: "polymarket_rtds_prices",
      ttlDays: null,
      quotaBytes: 1_000,
      timeColumn: "received_at",
      protected: false,
    };
    const cutoff = new Date("2026-05-01T00:00:00Z");
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        return {
          rows: [
            { bytes: "2000", reltuples: "200", live_tup: "50", dead_tup: "50" },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("OFFSET 9")) {
        return { rows: [{ cutoff }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM polymarket_rtds_prices")) {
        return { rows: [], rowCount: 15 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    const report = await job.runOnce();

    expect(report.actions).toHaveLength(1);
    const analyzeIndex = pool.captured.findIndex((q) =>
      q.text.startsWith("ANALYZE polymarket_rtds_prices"),
    );
    const deleteIndex = pool.captured.findIndex((q) =>
      q.text.includes("DELETE FROM polymarket_rtds_prices"),
    );
    expect(analyzeIndex).toBeGreaterThan(deleteIndex);
    expect(stderrLines().some((l) => l.includes("RETENTION_ANALYZE"))).toBe(
      true,
    );
  });

  it("sizes the quota DELETE batch by bytes, so fat rows fit the timeout", async () => {
    // Measured 2026-08-28: 50 000 rows of portfolio_decisions are ~220 MB
    // across six indexes plus TOAST, and the batch died on the pool's query
    // timeout ("Query read timeout") on EVERY run — the fat tables' quotas
    // were never enforced. 4096-byte rows against the 32 MiB budget must clamp
    // the batch at 8192 rows; slim tables keep the full row-count batch.
    const config: RetentionTableConfig = {
      table: "portfolio_decisions",
      ttlDays: null,
      quotaBytes: 40_000_000,
      timeColumn: "received_at",
      protected: false,
    };
    const cutoff = new Date("2026-08-18T00:00:00Z");
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        // perRow = 4068 + 28 = 4096 bytes exactly; 10 000 live rows.
        return {
          rows: [
            {
              bytes: "90000000",
              reltuples: "10000",
              live_tup: "10000",
              dead_tup: "0",
              toast_live_tup: "0",
              heap_width: "4068",
              index_count: "0",
              index_key_width: "0",
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("OFFSET")) {
        return { rows: [{ cutoff }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM portfolio_decisions")) {
        return { rows: [], rowCount: 2_188 };
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    await job.runOnce();

    const del = pool.captured.find((q) =>
      q.text.includes("DELETE FROM portfolio_decisions"),
    );
    expect(del).toBeDefined();
    expect(del?.text).toContain("LIMIT 8192");
    expect(del?.text).not.toContain("LIMIT 50000");
  });

  it("logs the real error message when a retention step fails", async () => {
    // The 2026-08-28 13:38Z failures logged only error_name "Error" — the
    // same diagnosability hole PR #37 closed in the supervised jobs. The
    // message names the cause (here: the statement timeout) without re-running
    // the query by hand inside the container.
    const config: RetentionTableConfig = {
      table: "polymarket_book_deltas",
      ttlDays: 14,
      quotaBytes: 12 * 1024 ** 3,
      timeColumn: "received_at",
      protected: false,
      requiresSeriesCoverage: true,
    };
    const pool = fakePool((text) => {
      if (text.includes("pg_total_relation_size")) {
        return { rows: [{ bytes: "1000", reltuples: "10" }], rowCount: 1 };
      }
      if (
        text.includes("min(received_at)") &&
        text.includes("WHERE token_id = $1")
      ) {
        return {
          rows: [
            { oldest: new Date(NOW.getTime() - 14 * DAY_MS - 6 * 3_600_000) },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("jsonb_array_elements_text")) {
        return { rows: [{ token_id: "t1" }], rowCount: 1 };
      }
      if (text.includes("LEFT JOIN polymarket_series_1m")) {
        return { rows: [{ first_uncovered: null }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM polymarket_book_deltas")) {
        throw new Error("canceling statement due to statement timeout");
      }
      return null;
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config],
    });
    await job.runOnce();

    const failure = stderrLines().find((l) =>
      l.includes("RETENTION_STEP_FAILED"),
    );
    expect(failure).toBeDefined();
    expect(failure).toContain("canceling statement due to statement timeout");
  });
});
