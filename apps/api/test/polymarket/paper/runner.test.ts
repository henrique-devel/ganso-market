import { afterEach, describe, expect, it, vi } from "vitest";

import type { QueryResult, SqlExecutor } from "../../../src/database.js";
import {
  createPaperRunner,
  SIMULATION_BANNER,
} from "../../../src/polymarket/paper/runner.js";

type Row = Record<string, unknown>;
type Responder = (text: string, params: readonly unknown[]) => Row[];

function createFakePool(respond: Responder = () => []): {
  calls: Array<{ text: string; params: readonly unknown[] }>;
  pool: SqlExecutor;
} {
  const calls: Array<{ text: string; params: readonly unknown[] }> = [];
  const pool: SqlExecutor = {
    query<R extends Row>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      const captured = [...(params ?? [])];
      calls.push({ text, params: captured });
      const rows = respond(text, captured) as R[];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  };
  return { calls, pool };
}

function failingPool(): SqlExecutor {
  return {
    query<R extends Row>(): Promise<QueryResult<R>> {
      return Promise.reject(new Error("db down"));
    },
  };
}

function createSink(): {
  lines: Record<string, unknown>[];
  sink: (line: string) => void;
} {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    sink: (line: string): void => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
}

const NOW = new Date("2026-08-24T12:00:05.000Z");

/** One active token 30 minutes from resolution: full 1s/10s/1m cadence. */
function universeResponder(): Responder {
  return (text) => {
    if (text.includes("FROM polymarket_book_snapshots s")) {
      return [
        {
          token_id: "token-1",
          condition_id: "0xcond",
          end_date_iso: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
        },
      ];
    }
    if (text.includes("ORDER BY received_at DESC LIMIT 1")) {
      return [
        {
          token_id: "token-1",
          bids_json: [{ price: "0.48", size: "100" }],
          asks_json: [{ price: "0.52", size: "80" }],
          source_ts: new Date(NOW.getTime() - 3_000),
          received_at: new Date(NOW.getTime() - 2_000),
        },
      ];
    }
    if (text.includes("FROM polymarket_trades") && text.includes("< $3")) {
      return [{ price: "0.50", size: "5" }];
    }
    return [];
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("paper runner boot guard", () => {
  it("refuses to boot unless execution_mode is paper", async () => {
    const { pool } = createFakePool();
    const { lines, sink } = createSink();
    const runner = createPaperRunner({
      pool,
      executionMode: "live",
      gitSha: null,
      logSink: sink,
    });
    await expect(runner.start()).rejects.toMatchObject({
      name: "PaperScopeError",
      reasonCode: "EXECUTION_MODE_NOT_PAPER",
    });
    // A refused boot must not have announced itself as booted.
    expect(lines.filter((l) => l.reason_code === "PAPER_BOOT")).toEqual([]);
  });

  it("boots in paper mode announcing the simulation banner", async () => {
    const { pool } = createFakePool();
    const { lines, sink } = createSink();
    const runner = createPaperRunner({
      pool,
      executionMode: "paper",
      gitSha: "abc123",
      logSink: sink,
    });
    await runner.start();
    await runner.stop();
    const boot = lines.find((l) => l.reason_code === "PAPER_BOOT");
    expect(boot).toMatchObject({
      service: "polymarket-paper",
      execution_mode: "paper",
      git_sha_known: true,
      simulation: SIMULATION_BANNER,
    });
  });
});

describe("paper runner heartbeat", () => {
  it("probes the database and logs the heartbeat", async () => {
    const { calls, pool } = createFakePool();
    const { lines, sink } = createSink();
    const runner = createPaperRunner({
      pool,
      executionMode: "paper",
      gitSha: null,
      logSink: sink,
    });
    await runner.heartbeatOnce();
    expect(calls.map((c) => c.text)).toEqual(["SELECT 1"]);
    expect(
      lines.filter((l) => l.reason_code === "PAPER_HEARTBEAT"),
    ).toHaveLength(1);
  });

  it("logs a failed probe and never throws", async () => {
    const { lines, sink } = createSink();
    const runner = createPaperRunner({
      pool: failingPool(),
      executionMode: "paper",
      gitSha: null,
      logSink: sink,
    });
    await expect(runner.heartbeatOnce()).resolves.toBeUndefined();
    expect(
      lines.filter((l) => l.reason_code === "PAPER_HEARTBEAT_FAILED"),
    ).toHaveLength(1);
  });

  it("ticks on the interval and stops cleanly", async () => {
    vi.useFakeTimers();
    const { calls, pool } = createFakePool();
    const { sink } = createSink();
    const runner = createPaperRunner({
      pool,
      executionMode: "paper",
      gitSha: null,
      heartbeatMs: 1_000,
      featuresTickMs: 3_600_000,
      brokerTickMs: 3_600_000,
      settlementTickMs: 3_600_000,
      markTickMs: 3_600_000,
      calibrationTickMs: 3_600_000,
      samplerTickMs: 3_600_000,
      logSink: sink,
    });
    await runner.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toHaveLength(3);
    await runner.stop();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toHaveLength(3);
  });
});

describe("paper runner feature pipeline", () => {
  function insertCount(calls: ReadonlyArray<{ text: string }>): number {
    return calls.filter((c) =>
      c.text.includes("INSERT INTO paper_feature_windows"),
    ).length;
  }

  it("computes the latest window of every due kind on first sight", async () => {
    const { calls, pool } = createFakePool(universeResponder());
    const { lines, sink } = createSink();
    const runner = createPaperRunner({
      pool,
      executionMode: "paper",
      gitSha: null,
      clock: () => NOW,
      logSink: sink,
    });
    await runner.featuresTickOnce();
    // Horizon 30 min: 1s, 10s and 1m — one window each on first sight.
    expect(insertCount(calls)).toBe(3);
    const tick = lines.find((l) => l.reason_code === "FEATURES_TICK");
    expect(tick).toMatchObject({
      tokens: 1,
      windows_computed: 3,
      windows_persisted: 3,
      failures: 0,
    });
  });

  it("advances the cursor: a second tick at the same instant adds nothing", async () => {
    const { calls, pool } = createFakePool(universeResponder());
    const { sink } = createSink();
    const runner = createPaperRunner({
      pool,
      executionMode: "paper",
      gitSha: null,
      clock: () => NOW,
      logSink: sink,
    });
    await runner.featuresTickOnce();
    const after = insertCount(calls);
    await runner.featuresTickOnce();
    expect(insertCount(calls)).toBe(after);
  });

  it("caps the backlog and logs the skip instead of re-scanning history", async () => {
    let now = NOW;
    const { calls, pool } = createFakePool(universeResponder());
    const { lines, sink } = createSink();
    const runner = createPaperRunner({
      pool,
      executionMode: "paper",
      gitSha: null,
      clock: () => now,
      logSink: sink,
    });
    await runner.featuresTickOnce();
    const first = insertCount(calls);
    // 100 s of downtime: 1s backlog is 100 windows, 10s backlog is 10 — both
    // over the cap of 5; the 1m kind stays within it.
    now = new Date(NOW.getTime() + 100_000);
    await runner.featuresTickOnce();
    const skips = lines.filter(
      (l) => l.reason_code === "FEATURES_BACKLOG_SKIPPED",
    );
    expect(skips).toHaveLength(2);
    // 5 windows for 1s + 5 for 10s + 1 for 1m.
    expect(insertCount(calls) - first).toBe(11);
  });

  it("one broken token/kind is logged and does not kill the tick", async () => {
    const responder: Responder = (text) => {
      if (text.includes("FROM polymarket_book_snapshots s")) {
        return [
          { token_id: "token-1", condition_id: "0xcond", end_date_iso: null },
        ];
      }
      throw new Error("loader exploded");
    };
    const { pool } = createFakePool(responder);
    const { lines, sink } = createSink();
    const runner = createPaperRunner({
      pool,
      executionMode: "paper",
      gitSha: null,
      clock: () => NOW,
      logSink: sink,
    });
    await expect(runner.featuresTickOnce()).resolves.toBeUndefined();
    expect(
      lines.filter((l) => l.reason_code === "FEATURES_WINDOW_FAILED"),
    ).toHaveLength(1);
  });
});
