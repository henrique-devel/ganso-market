import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryResult } from "../../src/database.js";
import { createRetentionSupervisor } from "../../src/polymarket/orchestrator.js";
import {
  createRetentionJob,
  DEFAULT_BUDGET_BYTES,
  measureTableSizes,
  QUOTA_TRIGGER_RATIO,
  RETENTION_TABLES,
  type RetentionTableConfig,
} from "../../src/polymarket/retention.js";

interface CapturedQuery {
  readonly text: string;
  readonly params: readonly unknown[];
}

type CatalogRow = Record<string, unknown>;
function fakePool(responder: (tables: readonly string[]) => CatalogRow[]) {
  const captured: CapturedQuery[] = [];
  return {
    captured,
    async query<R extends Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      captured.push({ text, params });
      // Any active application-table query or mutation fails this fixture.
      if (
        !text.startsWith("SELECT c.relname AS table_name") ||
        !text.includes("FROM pg_class c") ||
        /\b(DELETE|UPDATE|INSERT|TRUNCATE|ANALYZE|DROP|ALTER)\b/i.test(text)
      ) {
        throw new Error(`unexpected non-catalog query: ${text}`);
      }
      const rows = responder(params[0] as readonly string[]);
      return { rows: rows as R[], rowCount: rows.length };
    },
  };
}

const NOW = new Date("2026-09-12T12:00:00Z");
const GiB = 1024 ** 3;
function config(table: string): RetentionTableConfig {
  return {
    table,
    ttlDays: 1,
    quotaBytes: 1,
    timeColumn: "received_at",
    protected: false,
  };
}
function catalogRows(
  tables: readonly string[],
  override: CatalogRow = {},
): CatalogRow[] {
  return tables.map((table_name) => ({
    table_name,
    bytes: "1000000",
    reltuples: "1000",
    live_tup: "1000",
    dead_tup: "0",
    heap_width: "100",
    index_count: "0",
    index_key_width: "0",
    toast_live_tup: "0",
    ...override,
  }));
}
let stderrSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());
function logs(): Record<string, unknown>[] {
  return stderrSpy.mock.calls.map(
    (call: unknown[]) => JSON.parse(String(call[0])) as Record<string, unknown>,
  );
}

function assertCatalogOnly(pool: ReturnType<typeof fakePool>): void {
  expect(pool.captured).toHaveLength(1);
  expect(pool.captured[0]?.text).toMatch(/^SELECT c\.relname AS table_name/);
  expect(pool.captured[0]?.text).not.toMatch(
    /\b(DELETE|UPDATE|INSERT|TRUNCATE|ANALYZE|DROP|ALTER|OFFSET)\b/i,
  );
  expect(pool.captured[0]?.text).not.toMatch(
    /FROM (?:public\.)?(?:paper_|portfolio_|polymarket_)/i,
  );
}

describe("retention declarations under DATA-02 protection", () => {
  it("holds economic references, provenance, gate evidence and raw research history", () => {
    const byName = new Map(
      RETENTION_TABLES.map((table) => [table.table, table]),
    );
    for (const table of [
      "paper_ledger_events",
      "paper_orders",
      "paper_positions",
      "paper_markouts",
      "paper_fill_samples",
      "portfolio_position_entries",
      "portfolio_decisions",
      "portfolio_panel_snapshots",
      "portfolio_config_versions",
      "strategy_decisions",
      "fundamental_models",
      "fundamental_estimates",
      "fundamental_labels",
      "portfolio_gate_measurements",
      "resolution_scores",
      "polymarket_book_deltas",
      "polymarket_book_snapshots_full",
      "polymarket_trades",
      "polymarket_rtds_prices",
    ]) {
      expect(byName.get(table)?.protected, table).toBe(true);
    }
    expect(RETENTION_TABLES.every((table) => table.protected)).toBe(true);
  });

  it("preserves declared TTLs and quotas as monitoring baselines", () => {
    const byName = new Map(
      RETENTION_TABLES.map((table) => [table.table, table]),
    );
    expect(byName.get("polymarket_book_deltas")).toMatchObject({
      ttlDays: 14,
      quotaBytes: 52 * GiB,
      requiresSeriesCoverage: true,
    });
    expect(byName.get("polymarket_book_snapshots_full")?.ttlDays).toBe(30);
    expect(byName.get("polymarket_book_snapshots")).toMatchObject({
      ttlDays: 90,
      quotaBytes: 8 * GiB,
    });
    expect(byName.get("polymarket_trades")?.ttlDays).toBe(365);
    expect(byName.get("polymarket_series_1m")).toMatchObject({
      ttlDays: null,
      quotaBytes: 10 * GiB,
    });
    expect(byName.get("polymarket_rtds_prices")?.ttlDays).toBe(90);
    expect(byName.get("resolution_scores")).toMatchObject({
      ttlDays: 180,
      quotaBytes: 0.35 * GiB,
    });
    expect(byName.get("portfolio_decisions")).toMatchObject({
      ttlDays: 90,
      quotaBytes: 0.9 * GiB,
    });
    expect(byName.get("portfolio_panel_snapshots")).toMatchObject({
      ttlDays: 2,
      quotaBytes: 0.53 * GiB,
    });
    expect(byName.get("graph_sanity_vetoes")).toMatchObject({
      ttlDays: 180,
      timeColumn: "ended_at",
      closedRowsOnly: true,
    });
    for (const name of [
      "portfolio_decision_hourly",
      "portfolio_cycle_summary",
    ]) {
      expect(byName.get(name)).toMatchObject({
        ttlDays: 90,
        quotaBytes: 0.005 * GiB,
        protected: true,
      });
    }
  });

  it("does not raise the declared budget or funded reserve to implement holds", () => {
    const declared = RETENTION_TABLES.reduce(
      (sum, table) => sum + table.quotaBytes,
      0,
    );
    const otherDeclared = RETENTION_TABLES.filter(
      (table) => table.table !== "polymarket_book_deltas",
    ).reduce((sum, table) => sum + table.quotaBytes, 0);
    expect(DEFAULT_BUDGET_BYTES).toBe(110 * GiB);
    expect(declared / GiB).toBeCloseTo(96, 3);
    expect(declared).toBeLessThan(DEFAULT_BUDGET_BYTES * QUOTA_TRIGGER_RATIO);
    expect(otherDeclared / GiB).toBeCloseTo(44, 3);
    expect(
      (DEFAULT_BUDGET_BYTES * QUOTA_TRIGGER_RATIO - otherDeclared) / GiB,
    ).toBeCloseTo(55, 3);
  });
});

describe("legacy retention remains catalog monitoring under pressure", () => {
  it("cannot mutate any existing table even when every quota and the global budget are exceeded", async () => {
    const pool = fakePool((tables) =>
      catalogRows(tables, {
        bytes: String(1024 * GiB),
        heap_width: "10000000000",
      }),
    );
    const report = await createRetentionJob({
      pool,
      clock: () => NOW,
      budgetBytes: 1,
    }).runOnce();
    assertCatalogOnly(pool);
    expect(pool.captured[0]?.params[0]).toEqual(
      RETENTION_TABLES.map((table) => table.table),
    );
    expect(report.actions).toEqual([]);
    expect(report.skipped).toHaveLength(RETENTION_TABLES.length);
    expect(report.globalAlarm).toBe(true);
    expect(report.failedSteps).toBe(0);
    const holds = logs().filter(
      (entry) => entry.reason_code === "RETENTION_PROTECTED",
    );
    expect(holds).toHaveLength(RETENTION_TABLES.length);
    expect(
      holds.every(
        (entry) =>
          entry.quota_alarm === true && entry.mutation_enabled === false,
      ),
    ).toBe(true);
    expect(
      logs().some((entry) => entry.reason_code === "QUOTA_GLOBAL_ALARM"),
    ).toBe(true);
  });

  it("caller overrides cannot unprotect orders, positions, raw pins or logical references", async () => {
    const tables = [
      "paper_orders",
      "paper_positions",
      "portfolio_decisions",
      "polymarket_book_deltas",
    ].map(config);
    const pool = fakePool(catalogRows);
    const report = await createRetentionJob({
      pool,
      clock: () => NOW,
      tables,
      budgetBytes: 1,
      batchSize: 500000,
      maxQuotaIterations: 100000,
    }).runOnce();
    assertCatalogOnly(pool);
    expect(report.actions).toEqual([]);
    expect(report.skipped.map((entry) => entry.table)).toEqual(
      tables.map((entry) => entry.table),
    );
    // There is no application-row read: an unseen open order, source timestamp,
    // or newly pinned dataset is held without status/FK/aggregate assumptions.
    expect(report.failedSteps).toBe(0);
  });

  it("holds unknown tables and treats caller identifiers as catalog parameters", async () => {
    const table = "future_economic_evidence; DELETE FROM paper_orders";
    const pool = fakePool(catalogRows);
    const report = await createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config(table)],
      budgetBytes: 1,
    }).runOnce();
    assertCatalogOnly(pool);
    expect(pool.captured[0]?.text).not.toContain(table);
    expect(pool.captured[0]?.params).toEqual([[table]]);
    expect(report.skipped).toEqual([{ table, reason: expect.any(String) }]);
    expect(report.actions).toEqual([]);
  });

  it("does not grant execution to a dry-run-only legacy candidate", async () => {
    const pool = fakePool(catalogRows);
    const report = await createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config("domain_events")],
      budgetBytes: 1,
    }).runOnce();
    assertCatalogOnly(pool);
    expect(report.skipped).toEqual([
      { table: "domain_events", reason: "legacy_job_monitor_only" },
    ]);
    expect(report.actions).toEqual([]);
  });

  it("reports the declared TTL and no effective pruning TTL during hold", async () => {
    const pool = fakePool(catalogRows);
    await createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [{ ...config("polymarket_book_deltas"), ttlDays: 14 }],
      budgetBytes: 1,
    }).runOnce();
    const hold = logs().find(
      (entry) => entry.reason_code === "RETENTION_PROTECTED",
    );
    expect(hold).toMatchObject({
      declared_ttl_days: 14,
      effective_ttl_days: null,
      mutation_enabled: false,
    });
    expect(
      logs().some((entry) => entry.reason_code === "QUOTA_GLOBAL_TTL_REDUCED"),
    ).toBe(false);
    assertCatalogOnly(pool);
  });

  it("uses one measurement per unique table and adds physical/live totals separately", async () => {
    const pool = fakePool((tables) =>
      catalogRows(tables, { bytes: "1000000", heap_width: "100" }),
    );
    const report = await createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [
        config("paper_orders"),
        config("paper_positions"),
        config("paper_orders"),
      ],
    }).runOnce();
    assertCatalogOnly(pool);
    expect(pool.captured[0]?.params).toEqual([
      ["paper_orders", "paper_positions"],
    ]);
    expect(report.totalBytes).toBe(2000000);
    expect(report.totalLiveBytes).toBe(256000);
    expect(report.skipped).toHaveLength(2);
  });

  it("does not present physical minus estimated live bytes as recoverable space", async () => {
    const pool = fakePool((tables) =>
      catalogRows(tables, {
        bytes: "104557125632",
        heap_width: "119",
        live_tup: "66368290",
        reltuples: "66135696",
        index_count: "3",
        index_key_width: "102",
      }),
    );
    const report = await createRetentionJob({
      pool,
      clock: () => NOW,
      tables: RETENTION_TABLES.filter(
        (table) => table.table === "polymarket_book_deltas",
      ),
    }).runOnce();
    expect(report.totalBytes).toBe(104557125632);
    expect(report.totalLiveBytes).toBeLessThan(52 * GiB * QUOTA_TRIGGER_RATIO);
    expect(report.globalAlarm).toBe(false);
    expect(report.actions).toEqual([]);
    expect(
      logs().find(
        (entry) => entry.reason_code === "RETENTION_STORAGE_ESTIMATE_GAP",
      ),
    ).toMatchObject({ recoverable_bytes: null });
    assertCatalogOnly(pool);
  });

  it("reports a catalog timeout once and does not retry expensive probes in the run", async () => {
    const pool = fakePool(() => {
      throw new Error("canceling statement due to statement timeout");
    });
    const report = await createRetentionJob({
      pool,
      clock: () => NOW,
    }).runOnce();
    assertCatalogOnly(pool);
    expect(report.failedSteps).toBe(1);
    expect(report.actions).toEqual([]);
    expect(report.skipped).toHaveLength(RETENTION_TABLES.length);
    expect(
      logs().find((entry) => entry.reason_code === "RETENTION_STEP_FAILED"),
    ).toMatchObject({ detail: "canceling statement due to statement timeout" });
    expect(
      logs()
        .filter((entry) => entry.reason_code === "RETENTION_PROTECTED")
        .every((entry) => entry.live_bytes_estimate === null),
    ).toBe(true);
  });

  it("reports a missing table as unavailable rather than treating absence as measured zero", async () => {
    const pool = fakePool(() => []);
    const report = await createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config("paper_orders")],
    }).runOnce();
    expect(report.failedSteps).toBe(1);
    expect(report.actions).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(
      logs().find(
        (entry) => entry.message === "polymarket_retention_table_missing",
      ),
    ).toMatchObject({ table: "paper_orders" });
    assertCatalogOnly(pool);
  });

  it("clears a previous run failure when the next catalog read succeeds", async () => {
    let broken = true;
    const pool = fakePool((tables) => {
      if (broken) throw new Error("EAI_AGAIN postgres");
      return catalogRows(tables);
    });
    const job = createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [config("paper_orders")],
    });
    expect((await job.runOnce()).failedSteps).toBe(1);
    broken = false;
    expect((await job.runOnce()).failedSteps).toBe(0);
    expect(pool.captured).toHaveLength(2);
  });

  it("does no database work for an empty monitoring set", async () => {
    const pool = fakePool(() => {
      throw new Error("must not query");
    });
    const report = await createRetentionJob({
      pool,
      clock: () => NOW,
      tables: [],
    }).runOnce();
    expect(pool.captured).toEqual([]);
    expect(report).toMatchObject({
      failedSteps: 0,
      actions: [],
      skipped: [],
      totalBytes: 0,
      totalLiveBytes: 0,
    });
  });
});

describe("catalog size monitoring", () => {
  it("includes live TOAST and index rows in the estimate without using empty physical pages", async () => {
    const pool = fakePool((tables) =>
      catalogRows(tables, {
        bytes: "5000000",
        heap_width: "100",
        index_count: "1",
        index_key_width: "8",
        toast_live_tup: "500",
      }),
    );
    const sizes = await measureTableSizes(pool, ["portfolio_decisions"]);
    expect(Math.round(sizes.get("portfolio_decisions")?.liveBytes ?? 0)).toBe(
      1178667,
    );
    expect(sizes.get("portfolio_decisions")?.bytes).toBe(5000000);
    assertCatalogOnly(pool);
  });

  it("keeps the existing catalog fallbacks explicit when width statistics are absent", async () => {
    const pool = fakePool(() => [
      {
        table_name: "paper_orders",
        bytes: "2000",
        reltuples: "100",
        live_tup: "50",
        dead_tup: "50",
      },
      { table_name: "paper_positions", bytes: "500", reltuples: "-1" },
    ]);
    const sizes = await measureTableSizes(pool, [
      "paper_orders",
      "paper_positions",
    ]);
    expect(sizes.get("paper_orders")).toMatchObject({
      bytes: 2000,
      liveBytes: 1000,
      liveRows: 50,
    });
    expect(sizes.get("paper_positions")).toMatchObject({
      bytes: 500,
      liveBytes: 500,
      liveRows: 0,
      reltuples: 0,
    });
    assertCatalogOnly(pool);
  });
});

describe("retention supervisor reschedules a failed boot run (RFC-020 D4.4)", () => {
  it("arms one retry ten minutes out when a step failed", async () => {
    const timers: { run: () => void; delayMs: number }[] = [];
    const log = vi.fn();
    const runOnce = vi.fn().mockResolvedValue({ failedSteps: 4 });
    const supervisor = createRetentionSupervisor({
      runOnce,
      setTimer: (run, delayMs) => {
        timers.push({ run, delayMs });
        return timers.length;
      },
      log,
    });

    await supervisor.run();

    expect(timers).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(600_000);
    expect(log).toHaveBeenCalledWith(
      "warn",
      "RETENTION_RETRY_SCHEDULED",
      expect.objectContaining({ failed_steps: 4, retry_in_ms: 600_000 }),
    );
  });

  it("does not wait 24 h: the retry actually runs the job again", async () => {
    const timers: { run: () => void }[] = [];
    const runOnce = vi
      .fn()
      .mockResolvedValueOnce({ failedSteps: 2 })
      .mockResolvedValue({ failedSteps: 0 });
    const supervisor = createRetentionSupervisor({
      runOnce,
      setTimer: (run) => {
        timers.push({ run });
        return timers.length;
      },
      log: vi.fn(),
    });

    await supervisor.run();
    expect(runOnce).toHaveBeenCalledTimes(1);
    timers[0]?.run();
    await Promise.resolve();
    await Promise.resolve();

    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it("arms nothing on a clean run", async () => {
    const timers: unknown[] = [];
    const supervisor = createRetentionSupervisor({
      runOnce: vi.fn().mockResolvedValue({ failedSteps: 0 }),
      setTimer: (run, delayMs) => {
        timers.push({ run, delayMs });
        return timers.length;
      },
      log: vi.fn(),
    });

    await supervisor.run();

    expect(timers).toHaveLength(0);
  });

  it("is ONE retry, not a ten-minute loop", async () => {
    const timers: { run: () => void }[] = [];
    const log = vi.fn();
    const supervisor = createRetentionSupervisor({
      runOnce: vi.fn().mockResolvedValue({ failedSteps: 1 }),
      setTimer: (run) => {
        timers.push({ run });
        return timers.length;
      },
      log,
    });

    await supervisor.run();
    timers[0]?.run();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(timers).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      "warn",
      "RETENTION_RUN_DEGRADED",
      expect.objectContaining({ retry_scheduled: false }),
    );
  });
});
