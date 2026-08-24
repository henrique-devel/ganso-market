import { afterEach, describe, expect, it, vi } from "vitest";

import type { QueryResult, SqlExecutor } from "../../../src/database.js";
import {
  createPaperRunner,
  SIMULATION_BANNER,
} from "../../../src/polymarket/paper/runner.js";

function createFakePool(fail = false): { calls: string[]; pool: SqlExecutor } {
  const calls: string[] = [];
  const pool: SqlExecutor = {
    query<R extends Record<string, unknown>>(
      text: string,
    ): Promise<QueryResult<R>> {
      calls.push(text);
      return fail
        ? Promise.reject(new Error("db down"))
        : Promise.resolve({ rows: [] as R[], rowCount: 0 });
    },
  };
  return { calls, pool };
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
    expect(calls).toEqual(["SELECT 1"]);
    expect(
      lines.filter((l) => l.reason_code === "PAPER_HEARTBEAT"),
    ).toHaveLength(1);
  });

  it("logs a failed probe and never throws", async () => {
    const { pool } = createFakePool(true);
    const { lines, sink } = createSink();
    const runner = createPaperRunner({
      pool,
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
