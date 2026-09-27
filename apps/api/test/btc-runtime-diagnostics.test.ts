import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectorFailure,
  createDeskRuntimeDiagnostics,
  createCollectorRuntimeDiagnostics,
} from "../src/btc/runtime-diagnostics.js";
import {
  fetchBtcBookSnapshot,
  fetchBtcContextSnapshot,
} from "../src/venues/hyperliquid/context-snapshot.js";
import { metadata } from "./trading/bars-fixture.js";
afterEach(() => vi.unstubAllGlobals());
describe("BTC terminal runtime diagnostics", () => {
  it.each([
    ["book_snapshot", fetchBtcBookSnapshot],
    ["context_snapshot", fetchBtcContextSnapshot],
  ] as const)(
    "identifies a reproducible %s deadline without retry or timestamp replacement",
    async (stage, fetcher) => {
      const error = new DOMException(
        "private transport detail",
        "TimeoutError",
      );
      const fetch = vi.fn(async () => {
        throw error;
      });
      vi.stubGlobal("fetch", fetch);
      const diagnostics = createCollectorRuntimeDiagnostics();
      await expect(
        diagnostics.run(stage, () => fetcher(metadata)),
      ).rejects.toBe(error);
      expect(fetch).toHaveBeenCalledOnce();
      expect(diagnostics.failure()).toEqual({
        stage,
        error_type: "TimeoutError",
        error_code: null,
      });
      expect(JSON.stringify(diagnostics.failure())).not.toContain("private");
    },
  );
  it("distinguishes transport causes and PostgreSQL timeouts without raw messages", () => {
    expect(
      collectorFailure(
        "book_snapshot",
        new TypeError("private URL", { cause: { code: "ECONNRESET" } }),
      ),
    ).toEqual({
      stage: "book_snapshot",
      error_type: "TypeError",
      error_code: "ECONNRESET",
    });
    expect(
      collectorFailure(
        "capture",
        Object.assign(new Error("private SQL"), { code: "57014" }),
      ),
    ).toEqual({ stage: "capture", error_type: "Error", error_code: "57014" });
    expect(
      collectorFailure("capacity", {
        name: "private",
        code: "PRIVATE",
        cause: { code: "PRIVATE" },
        message: "private",
      }),
    ).toEqual({ stage: "capacity", error_type: "unknown", error_code: null });
    expect(collectorFailure("capacity", null).error_type).toBe("unknown");
  });
  it("preserves the first concurrent failure and terminal refusal identity", async () => {
    const diagnostics = createCollectorRuntimeDiagnostics();
    const error = new Error("BTC_COLLECTOR_STORAGE_LIMIT");
    await expect(
      diagnostics.run("capacity", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    await expect(
      diagnostics.run("publish", async () => {
        throw new Error("later");
      }),
    ).rejects.toThrow("later");
    expect(diagnostics.failure()?.stage).toBe("capacity");
    expect(await diagnostics.run("publish", async () => "written")).toBe(
      "written",
    );
    expect(diagnostics.failure()?.stage).toBe("capacity");
  });
  it("adds no failure to successful operations", async () => {
    const diagnostics = createCollectorRuntimeDiagnostics();
    expect(
      await diagnostics.run("capture", async () => ({ stored: 2 })),
    ).toEqual({ stored: 2 });
    expect(diagnostics.failure()).toBeNull();
  });
});

describe("sanitized desk diagnostics", () => {
  it.each([
    [
      Object.assign(new Error("secret SQL parameters"), {
        name: "error",
        code: "55P03",
        detail: "secret payload",
        query: "secret SQL",
        headers: { authorization: "secret token" },
      }),
      "PostgresError",
      "55P03",
      "lock_unavailable",
    ],
    [
      Object.assign(new Error("secret"), { code: "57014" }),
      "Error",
      "57014",
      "query_canceled",
    ],
    [new Error("Query read timeout"), "Error", null, "timeout"],
    [
      new DOMException("secret URL", "TimeoutError"),
      "TimeoutError",
      null,
      "timeout",
    ],
    [
      new Error("secret", { cause: { code: "42P01", detail: "secret" } }),
      "Error",
      "42P01",
      "database_error",
    ],
    [
      {
        name: "secret",
        code: "secret",
        message: "secret",
        cause: { code: "secret" },
      },
      "unknown",
      null,
      "unknown",
    ],
    ["secret", "unknown", null, "unknown"],
    [null, "unknown", null, "unknown"],
    [new Error("BTC_SECRET_TOKEN"), "Error", null, "unknown"],
  ])(
    "preserves technical cause without serializing input %#",
    (error, type, sqlstate, cause) => {
      let now = 10;
      const log = vi.fn();
      const diagnostics = createDeskRuntimeDiagnostics(log, () => now);
      const op = diagnostics.start(
        "baseline_cycle",
        "secret account",
        "baseline",
      );
      now = 20;
      op.stage("baseline_prepare");
      now = 42;
      op.fail(error, "BTC_DESK_CONSUMER_FAILED");
      const fields = log.mock.calls[0]![1];
      expect(fields).toMatchObject({
        diagnostic_version: "btc.desk-diagnostics.v1",
        component: "desk_consumer",
        account_purpose: "baseline",
        stage: "baseline_prepare",
        duration_ms: 22,
        operation_duration_ms: 32,
        error_type: type,
        sqlstate,
        cause,
        suppressed_since_last_log: 0,
      });
      expect(fields.account_ref).toMatch(/^[a-f0-9]{64}$/);
      expect(fields.correlation_id).toMatch(/^[a-f0-9-]{36}$/);
      expect(JSON.stringify(log.mock.calls)).not.toMatch(
        /secret|SQL|parameters|payload|headers|authorization|stack/,
      );
    },
  );
  it("bounds cyclic causes and preserves a recognized refusal", () => {
    const log = vi.fn();
    const diagnostics = createDeskRuntimeDiagnostics(log);
    const error = Object.assign(new Error("BTC_RECOVERY_OWNED"), { cause: {} });
    error.cause = error;
    const reason = diagnostics
      .start("manual_cycle", "manual", "manual")
      .fail(error, "BTC_DESK_CONSUMER_FAILED");
    expect(reason).toBe("BTC_RECOVERY_OWNED");
    expect(log.mock.calls[0]![1].cause).toBe("domain_refusal");
  });
  it("caps repeated and changing-account errors, reports suppression and reopens the window", () => {
    let now = 0;
    const log = vi.fn();
    const diagnostics = createDeskRuntimeDiagnostics(log, () => now);
    const fail = (account = "baseline") =>
      diagnostics
        .start("baseline_prepare", account, "baseline")
        .fail(new Error("Query read timeout"), "BTC_DESK_CONSUMER_FAILED");
    for (let i = 0; i < 1000; i++) fail();
    expect(log).toHaveBeenCalledTimes(1);
    now = 30000;
    fail();
    expect(log.mock.calls[1]![1].suppressed_since_last_log).toBe(999);
    for (let i = 0; i < 1000; i++) fail(String(i));
    expect(log).toHaveBeenCalledTimes(9); // one in prior window, eight in current
    now += 30000;
    fail();
    expect(log).toHaveBeenCalledTimes(10);
    expect(log.mock.calls[9]![1].suppressed_since_last_log).toBe(993);
  });
});
