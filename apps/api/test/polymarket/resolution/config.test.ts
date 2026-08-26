import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_RESOLUTION_CONFIG,
  ResolutionConfigError,
  loadResolutionConfig,
  parseResolutionConfig,
  scoreConfigHash,
} from "../../../src/polymarket/resolution/config.js";

const SHIPPED = new URL(
  "../../../../../config/resolution.json",
  import.meta.url,
).pathname;

describe("resolution config", () => {
  it("uses defaults when the env var is unset", async () => {
    const config = await loadResolutionConfig({ env: {} });
    expect(config).toEqual(DEFAULT_RESOLUTION_CONFIG);
  });

  it("rejects unknown keys anywhere", () => {
    expect(() => parseResolutionConfig({ nope: 1 })).toThrowError(
      ResolutionConfigError,
    );
    expect(() =>
      parseResolutionConfig({ thresholds: { r_veto: 0.7, nope: 1 } }),
    ).toThrowError(/thresholds.nope/);
  });

  it("rejects weights that do not sum to one", () => {
    expect(() =>
      parseResolutionConfig({
        weights: {
          rule_precision: 0.9,
          dispute_prior: 0.9,
          clarification: 0,
          uma_sensitivity: 0,
          end_date_mismatch: 0,
          holders_concentration: 0,
          p_5050: 0,
          adjudication_premium: 0,
        },
      }),
    ).toThrowError(/must sum to 1/);
  });

  it("rejects a buffer band inverted against the veto threshold", () => {
    expect(() =>
      parseResolutionConfig({ thresholds: { r_veto: 0.3, r_buffer: 0.5 } }),
    ).toThrowError(/r_buffer must be below r_veto/);
  });

  it("rejects malformed adapters and rpc urls", () => {
    expect(() =>
      parseResolutionConfig({ onchain: { adapters: ["0xNOPE"] } }),
    ).toThrowError(ResolutionConfigError);
    expect(() =>
      parseResolutionConfig({ onchain: { rpc_urls: ["http://insecure"] } }),
    ).toThrowError(ResolutionConfigError);
  });

  it("fails closed on unreadable file and invalid JSON", async () => {
    await expect(
      loadResolutionConfig({
        env: { GANSO_RESOLUTION_CONFIG_FILE: "/nope" },
        readTextFile: () => Promise.reject(new Error("nope")),
      }),
    ).rejects.toThrowError(/could not be read/);
    await expect(
      loadResolutionConfig({
        env: { GANSO_RESOLUTION_CONFIG_FILE: "/nope" },
        readTextFile: () => Promise.resolve("{"),
      }),
    ).rejects.toThrowError(/not valid JSON/);
  });

  it("parses the shipped config file", async () => {
    const text = await readFile(SHIPPED, "utf8");
    const config = parseResolutionConfig(JSON.parse(text));
    // 1.1.0 since the titleDeferralTerms fix: the lexicon content changed, so
    // the score version had to change with it (the boot gate refuses to reuse
    // a version name whose content hash differs).
    expect(config.scoreVersion).toBe("1.1.0");
    expect(config.onchain.enabled).toBe(true);
    expect(config.onchain.adapters).toContain(
      "0x6a9d222616c90fca5754cd1333cfd9b7fb6a4f74",
    );
    // The shipped file must MEAN the same score as the in-code defaults:
    // same score-material hash, so boot cannot hit the version-content gate.
    expect(scoreConfigHash(config)).toBe(
      scoreConfigHash(DEFAULT_RESOLUTION_CONFIG),
    );
  });

  it("hashes only score-material fields", () => {
    const cadenceChanged = parseResolutionConfig({
      cadence: { sweep_ms: 7_200_000 },
    });
    expect(scoreConfigHash(cadenceChanged)).toBe(
      scoreConfigHash(DEFAULT_RESOLUTION_CONFIG),
    );
    const weightChanged = parseResolutionConfig({
      weights: {
        rule_precision: 0.35,
        dispute_prior: 0.1,
        clarification: 0.1,
        uma_sensitivity: 0.1,
        end_date_mismatch: 0.05,
        holders_concentration: 0.1,
        p_5050: 0.1,
        adjudication_premium: 0.1,
      },
    });
    expect(scoreConfigHash(weightChanged)).not.toBe(
      scoreConfigHash(DEFAULT_RESOLUTION_CONFIG),
    );
  });
});
