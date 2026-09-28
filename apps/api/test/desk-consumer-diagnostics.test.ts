import { sampleAdmittedEquity } from "../src/storage/equity-history.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabasePool, SqlExecutor } from "../src/database.js";
import { consumeBaselineAccount } from "../src/storage/baseline-runtime.js";
import { fetchFinalBtcFunding } from "../src/venues/hyperliquid/funding.js";
import { startDeskConsumer } from "../src/storage/desk-consumer.js";

vi.mock("../src/storage/baseline-runtime.js", () => ({
  consumeBaselineAccount: vi.fn(),
}));
vi.mock("../src/venues/hyperliquid/funding.js", () => ({
  fetchFinalBtcFunding: vi.fn(),
  FUNDING_SOURCE: "fixture",
}));
vi.mock("../src/storage/challenger-operations.js", () => ({
  createOperationalChallenger: () => ({ tick: vi.fn(), stop: vi.fn() }),
}));

vi.mock("../src/storage/equity-history.js", () => ({
  sampleAdmittedEquity: vi.fn(),
}));

function fixture() {
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("SELECT c.account_id"))
      return {
        rows: [{ account_id: "baseline", purpose: "baseline" }],
        rowCount: 1,
      };
    if (sql.startsWith("SELECT a.identity"))
      return {
        rows: [
          {
            identity: {
              account: { mode: "paper", purpose: "baseline" },
              experiment: { started_at: "2026-01-01T00:00:00.000Z" },
            },
          },
        ],
        rowCount: 1,
      };
    if (sql.startsWith("SELECT h AS hour"))
      return {
        rows: [{ hour: new Date("2026-09-27T00:00:00.000Z") }],
        rowCount: 1,
      };
    return { rows: [], rowCount: 0 };
  });
  const tx = { query } as unknown as SqlExecutor;
  const pool = {
    readOnly: vi.fn(
      async <T>(_budget: number, run: (tx: SqlExecutor) => Promise<T>) =>
        run(tx),
    ),
    transaction: vi.fn(async <T>(run: (tx: SqlExecutor) => Promise<T>) =>
      run(tx),
    ),
  };
  return {
    pool: pool as unknown as Pick<DatabasePool, "transaction" | "readOnly">,
    query,
    calls: pool,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(sampleAdmittedEquity).mockReset().mockResolvedValue();
  vi.setSystemTime(new Date("2026-09-27T21:00:00Z"));
  vi.mocked(consumeBaselineAccount).mockReset();
  vi.mocked(fetchFinalBtcFunding)
    .mockReset()
    .mockRejectedValue(new DOMException("secret HTTP headers", "TimeoutError"));
});
afterEach(() => vi.useRealTimers());

describe("desk consumer catch diagnostics", () => {
  it("preserves the account failure before a failed status write, sharing correlation and keeping the loop bounded", async () => {
    const { pool, calls } = fixture();
    vi.mocked(consumeBaselineAccount).mockImplementation(
      async (_pool, _account, _challenger, stage) => {
        stage?.("baseline_prepare");
        throw Object.assign(new Error("secret SQL params"), { code: "55P03" });
      },
    );
    calls.transaction.mockRejectedValue(
      Object.assign(new Error("secret persistence"), { code: "08006" }),
    );
    const log = vi.fn();
    const stop = startDeskConsumer(pool, log);
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledTimes(2);
    const first = log.mock.calls[0]![1],
      second = log.mock.calls[1]![1];
    expect(first).toMatchObject({
      stage: "baseline_prepare",
      account_purpose: "baseline",
      sqlstate: "55P03",
    });
    expect(second).toMatchObject({
      stage: "persist_failure",
      sqlstate: "08006",
      correlation_id: first.correlation_id,
      account_ref: first.account_ref,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(consumeBaselineAccount).toHaveBeenCalledTimes(6);
    expect(log).toHaveBeenCalledTimes(2);
    expect(fetchFinalBtcFunding).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    await stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(consumeBaselineAccount).toHaveBeenCalledTimes(6);
  });
  it("persists a safe reason while funding has its own account, duration and correlation", async () => {
    const { pool, query } = fixture();
    vi.mocked(consumeBaselineAccount).mockRejectedValue(
      new Error("BTC_SECRET_TOKEN"),
    );
    const log = vi.fn();
    const stop = startDeskConsumer(pool, log);
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]![0]).toBe("BTC_DESK_CONSUMER_FAILED");
    expect(log.mock.calls[1]![1]).toMatchObject({
      stage: "funding",
      cause: "timeout",
      account_purpose: "baseline",
    });
    expect(log.mock.calls[1]![1].correlation_id).not.toBe(
      log.mock.calls[0]![1].correlation_id,
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO btc_desk_runtime"),
      ["baseline", "BTC_DESK_CONSUMER_FAILED"],
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/SECRET|secret/);
    await stop();
  });
  it("identifies selection failure without inventing an account and retries after the normal delay", async () => {
    const { pool, calls } = fixture();
    calls.readOnly.mockRejectedValue(
      Object.assign(new Error("secret"), { code: "53300" }),
    );
    const log = vi.fn();
    const stop = startDeskConsumer(pool, log);
    await vi.advanceTimersByTimeAsync(3000);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![1]).toMatchObject({
      stage: "select_accounts",
      account_ref: null,
      sqlstate: "53300",
    });
    expect(pool.readOnly).toHaveBeenCalledTimes(4);
    expect(consumeBaselineAccount).not.toHaveBeenCalled();
    await stop();
  });
});

it("equity runs once per five minutes without delaying trading and shutdown joins it", async () => {
  const { pool } = fixture();
  const log = vi.fn();
  let complete!: () => void;
  vi.mocked(sampleAdmittedEquity).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const stop = startDeskConsumer(pool, log);
  await vi.advanceTimersByTimeAsync(5000);
  expect(consumeBaselineAccount).toHaveBeenCalled();
  expect(sampleAdmittedEquity).toHaveBeenCalledTimes(1);
  const stopped = stop();
  complete();
  await stopped;
});
