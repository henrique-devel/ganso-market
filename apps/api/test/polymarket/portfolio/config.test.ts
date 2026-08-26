import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PORTFOLIO_CONFIG,
  PortfolioConfigError,
  loadPortfolioConfig,
  parsePortfolioConfig,
  portfolioConfigHash,
} from "../../../src/polymarket/portfolio/config.js";
import {
  DEFAULT_FACTOR_MAP,
  factorMapHash,
  parseFactorMap,
} from "../../../src/polymarket/portfolio/factors.js";

const SHIPPED_CONFIG = new URL(
  "../../../../../config/portfolio.json",
  import.meta.url,
).pathname;
const SHIPPED_MAP = new URL(
  "../../../../../config/factor-map.json",
  import.meta.url,
).pathname;

describe("shipped configuration files", () => {
  it("parses and means exactly what the in-code defaults mean", async () => {
    const text = await readFile(SHIPPED_CONFIG, "utf8");
    const config = parsePortfolioConfig(JSON.parse(text));
    expect(portfolioConfigHash(config)).toBe(
      portfolioConfigHash(DEFAULT_PORTFOLIO_CONFIG),
    );
  });

  it("is COMPLETE, so an old binary can never mint a version with new defaults", async () => {
    // The deploy-ordering hazard that burned score_version 1.1.0 on 2026-08-26:
    // config/ is bind-mounted and lands with the CD, while the image updates
    // only on a profile rebuild. If the file omitted a value, the parser would
    // fill it from whichever binary happened to be running, and the same
    // version name could be pinned to two different parameter sets.
    //
    // A complete file makes the hash a property of the FILE alone.
    const raw: unknown = JSON.parse(await readFile(SHIPPED_CONFIG, "utf8"));
    const record = raw as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_PORTFOLIO_CONFIG)) {
      expect(record[key], key).toBeDefined();
    }
    const nested = [
      "kelly",
      "costs",
      "priceBand",
      "depth",
      "caps",
      "lossLimits",
      "exits",
      "staleness",
      "breakers",
      "gates",
      "cadence",
    ] as const;
    for (const group of nested) {
      const defaults = DEFAULT_PORTFOLIO_CONFIG[group] as unknown as Record<
        string,
        unknown
      >;
      const shipped = record[group] as Record<string, unknown>;
      for (const key of Object.keys(defaults)) {
        expect(shipped[key], `${group}.${key}`).toBeDefined();
      }
    }
  });

  it("ships a complete factor map too", async () => {
    const text = await readFile(SHIPPED_MAP, "utf8");
    const map = parseFactorMap(JSON.parse(text));
    expect(factorMapHash(map)).toBe(factorMapHash(DEFAULT_FACTOR_MAP));
    const record = JSON.parse(text) as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_FACTOR_MAP)) {
      expect(record[key], key).toBeDefined();
    }
  });
});

describe("portfolio config parsing", () => {
  it("uses the in-code defaults when no file is configured", async () => {
    const config = await loadPortfolioConfig({ env: {} });
    expect(config).toBe(DEFAULT_PORTFOLIO_CONFIG);
  });

  it("rejects an unknown key rather than ignoring it silently", () => {
    expect(() => parsePortfolioConfig({ nope: 1 })).toThrow(
      PortfolioConfigError,
    );
  });

  it("rejects a value outside its range", () => {
    expect(() => parsePortfolioConfig({ kelly: { lambda: 1.5 } })).toThrow(
      PortfolioConfigError,
    );
  });

  it("rejects lambda above its own ceiling", () => {
    expect(() =>
      parsePortfolioConfig({ kelly: { lambda: 0.6, maxLambda: 0.5 } }),
    ).toThrow(PortfolioConfigError);
  });

  it("rejects caps that would make a wider cap unreachable", () => {
    // entrada > mercado means the per-market cap can never bind, which quietly
    // removes it.
    expect(() =>
      parsePortfolioConfig({ caps: { entrada: 0.1, mercado: 0.05 } }),
    ).toThrow(PortfolioConfigError);
  });

  it("rejects a daily loss limit above the weekly one", () => {
    expect(() =>
      parsePortfolioConfig({
        lossLimits: { perdaDiariaMax: 0.08, perdaSemanalMax: 0.06 },
      }),
    ).toThrow(PortfolioConfigError);
  });

  it("rejects a price band whose floor is not below its ceiling", () => {
    expect(() =>
      parsePortfolioConfig({ priceBand: { minBuy: 0.9, maxBuy: 0.5 } }),
    ).toThrow(PortfolioConfigError);
  });

  it("REFUSES any gate loosened below the RFC-013 thresholds", () => {
    // The gates are what would ever unlock real money. Loosening them in the
    // same config is a stop condition, so the parser refuses rather than
    // trusting whoever edited the file.
    const loosened: Record<string, unknown>[] = [
      { gates: { g1MinResolvedMarkets: 50 } },
      { gates: { g1MaxBrier: 0.4 } },
      { gates: { g2MinDays: 30 } },
      { gates: { g2MinClosedPositions: 50 } },
      { gates: { g2MinDistinctMarkets: 10 } },
      { gates: { g2MinCategories: 1 } },
      { gates: { g2EdgeHaircut: 0.2 } },
      { gates: { g4MaxFeeMedianError: 0.2 } },
      { gates: { g4MinSoakDays: 7 } },
    ];
    for (const candidate of loosened) {
      expect(
        () => parsePortfolioConfig(candidate),
        JSON.stringify(candidate),
      ).toThrow(PortfolioConfigError);
    }
  });

  it("ALLOWS a gate made stricter", () => {
    const stricter = parsePortfolioConfig({
      gates: { g2MinDays: 90, g1MinResolvedMarkets: 200 },
    });
    expect(stricter.gates.g2MinDays).toBe(90);
    expect(stricter.gates.g1MinResolvedMarkets).toBe(200);
  });

  it("keeps cadence out of the hash: when it runs is not what it decides", () => {
    const faster = parsePortfolioConfig({
      cadence: { panelMs: 5_000 },
    });
    expect(portfolioConfigHash(faster)).toBe(
      portfolioConfigHash(DEFAULT_PORTFOLIO_CONFIG),
    );
  });

  it("changes the hash when a decision parameter changes", () => {
    const changed = parsePortfolioConfig({ kelly: { lambda: 0.2 } });
    expect(portfolioConfigHash(changed)).not.toBe(
      portfolioConfigHash(DEFAULT_PORTFOLIO_CONFIG),
    );
  });

  it("fails closed when a configured file cannot be read", async () => {
    await expect(
      loadPortfolioConfig({
        env: { GANSO_PORTFOLIO_CONFIG_FILE: "/nope/missing.json" },
      }),
    ).rejects.toThrow(PortfolioConfigError);
  });
});
