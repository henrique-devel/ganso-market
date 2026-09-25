import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectorFailure,
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
