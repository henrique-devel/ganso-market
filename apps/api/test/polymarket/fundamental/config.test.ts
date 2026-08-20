import { describe, expect, it } from "vitest";

import {
  DEFAULT_FUNDAMENTAL_CONFIG,
  FUNDAMENTAL_CONFIG_FILE_ENV,
  FundamentalConfigError,
  loadFundamentalConfig,
  parseFundamentalConfig,
} from "../../../src/polymarket/fundamental/config.js";

describe("parseFundamentalConfig", () => {
  it("returns the documented defaults for an empty document", () => {
    const parsed = parseFundamentalConfig({});
    expect(parsed.sRefUsd).toBe(100);
    expect(parsed.maxBookAgeMs).toBe(30_000);
    expect(parsed.maxExecSpread).toBe(0.1);
    expect(parsed.fallbackWidenFactor).toBe(1.5);
    expect(parsed.gate.minMarkets).toBe(100);
    expect(parsed.gate.maxHorizonDegradation).toBe(0.2);
  });

  it("applies overrides without losing the untouched defaults", () => {
    const parsed = parseFundamentalConfig({
      s_ref_usd: 250,
      macro: { post_release_window_ms: 60_000 },
    });
    expect(parsed.sRefUsd).toBe(250);
    expect(parsed.macro.postReleaseWindowMs).toBe(60_000);
    expect(parsed.macro.underReactionCoefficient).toBe(
      DEFAULT_FUNDAMENTAL_CONFIG.macro.underReactionCoefficient,
    );
  });

  it("fails closed on an unknown key", () => {
    expect(() => parseFundamentalConfig({ unexpected: 1 })).toThrow(
      FundamentalConfigError,
    );
    expect(() => parseFundamentalConfig({ gate: { unexpected: 1 } })).toThrow(
      FundamentalConfigError,
    );
  });

  it("refuses to weaken the gate below the RFC's floor", () => {
    // The gate's 100 resolved markets and 20% horizon degradation are the RFC's
    // criterion; configuration may tighten them, never loosen them.
    expect(() => parseFundamentalConfig({ gate: { min_markets: 10 } })).toThrow(
      FundamentalConfigError,
    );
    expect(() =>
      parseFundamentalConfig({ gate: { max_horizon_degradation: 0.5 } }),
    ).toThrow(FundamentalConfigError);
    expect(
      parseFundamentalConfig({ gate: { min_markets: 500 } }).gate.minMarkets,
    ).toBe(500);
  });

  it("refuses a fallback factor that would make the fallback narrower", () => {
    expect(() => parseFundamentalConfig({ fallback_widen_factor: 1 })).toThrow(
      FundamentalConfigError,
    );
    expect(() =>
      parseFundamentalConfig({ fallback_widen_factor: 0.5 }),
    ).toThrow(FundamentalConfigError);
  });

  it("rejects out-of-range and non-numeric values", () => {
    expect(() => parseFundamentalConfig({ s_ref_usd: 0 })).toThrow(
      FundamentalConfigError,
    );
    expect(() => parseFundamentalConfig({ max_exec_spread: 0.9 })).toThrow(
      FundamentalConfigError,
    );
    expect(() => parseFundamentalConfig({ max_book_age_ms: 1.5 })).toThrow(
      FundamentalConfigError,
    );
    expect(() =>
      parseFundamentalConfig({ crypto: { ewma_lambdas: [] } }),
    ).toThrow(FundamentalConfigError);
    expect(() => parseFundamentalConfig({ schema_version: 2 })).toThrow(
      FundamentalConfigError,
    );
  });
});

describe("loadFundamentalConfig", () => {
  it("uses the built-in defaults when no file is configured", async () => {
    const config = await loadFundamentalConfig({ env: {} });
    expect(config).toBe(DEFAULT_FUNDAMENTAL_CONFIG);
  });

  it("fails closed on an unreadable or invalid file", async () => {
    await expect(
      loadFundamentalConfig({
        env: { [FUNDAMENTAL_CONFIG_FILE_ENV]: "/nope.json" },
        readTextFile: () => Promise.reject(new Error("ENOENT")),
      }),
    ).rejects.toThrow(FundamentalConfigError);

    await expect(
      loadFundamentalConfig({
        env: { [FUNDAMENTAL_CONFIG_FILE_ENV]: "/bad.json" },
        readTextFile: () => Promise.resolve("{"),
      }),
    ).rejects.toThrow(FundamentalConfigError);
  });

  it("parses the file shipped in the repository", async () => {
    const { readFile } = await import("node:fs/promises");
    const config = await loadFundamentalConfig({
      env: { [FUNDAMENTAL_CONFIG_FILE_ENV]: "../../config/fundamental.json" },
      readTextFile: (path) => readFile(path, "utf8"),
    });
    // The shipped file must stay in sync with the defaults documented in code.
    expect(config).toEqual(DEFAULT_FUNDAMENTAL_CONFIG);
  });
});
