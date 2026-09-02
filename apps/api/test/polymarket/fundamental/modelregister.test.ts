// RFC-018 item 4: the operational path that registers a model version.
//
// Registering a version mints the lineage every future estimate points at, so
// the interesting cases are all refusals: what the CLI will NOT turn into a
// row, and with which reason code. A refusal that said only "invalid" would
// send the operator back into the schema to find out why.

import { describe, expect, it } from "vitest";

import {
  ModelRegisterArgsError,
  parseHyperparams,
  parseRegisterArgs,
} from "../../../src/polymarket/fundamental/modelregister.js";

const SHA = "a".repeat(40);

const VALID = [
  "--family",
  "crypto_updown_gbm",
  "--version",
  "1.2.0",
  "--category",
  "crypto_updown",
  "--feature-set-version",
  "1.2.0",
];

function parse(
  argv: readonly string[],
  stdin = "",
  gitSha: string | null = SHA,
) {
  return parseRegisterArgs({ argv, stdin, gitSha });
}

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof ModelRegisterArgsError) {
      return error.reasonCode;
    }
    throw error;
  }
  throw new Error("expected a refusal, got none");
}

describe("model registration arguments", () => {
  it("builds the registry input a calibrated version needs", () => {
    const input = parse(
      [
        ...VALID,
        "--seed",
        "42",
        "--train-window-start",
        "2026-05-01T00:00:00Z",
        "--train-window-end",
        "2026-08-01T00:00:00Z",
      ],
      '{"drift": 0.01}',
    );
    expect(input.modelId).toBe("crypto_updown_gbm@1.2.0");
    expect(input.modelFamily).toBe("crypto_updown_gbm");
    expect(input.category).toBe("crypto_updown");
    expect(input.gitSha).toBe(SHA);
    expect(input.seed).toBe(42);
    expect(input.hyperparams).toEqual({ drift: 0.01 });
    expect(input.trainWindowStart?.toISOString()).toBe(
      "2026-05-01T00:00:00.000Z",
    );
    expect(input.regimeMix).toBe(false);
  });

  it("refuses a version without a readable release revision", () => {
    // The same rule ensureCatalogModels applies at boot: a model whose code
    // cannot be identified cannot be reproduced, and an irreproducible model is
    // not evidence of anything.
    expect(reasonOf(() => parse(VALID, "", null))).toBe("GIT_SHA_UNAVAILABLE");
  });

  it("refuses a flag whose value is the next flag", () => {
    // What a forgotten argument looks like. Taking it literally would mint a
    // version literally named "--category".
    const argv = [
      "--family",
      "crypto_updown_gbm",
      "--version",
      "--category",
      "crypto_updown",
      "--feature-set-version",
      "1.2.0",
    ];
    expect(reasonOf(() => parse(argv))).toBe("MISSING_FLAG");
  });

  it("refuses a version that is not x.y.z", () => {
    for (const bad of ["1.2", "v1.2.0", "1.2.0-rc1", "latest"]) {
      expect(
        reasonOf(() => parse([...VALID.slice(0, 3), bad, ...VALID.slice(4)])),
        bad,
      ).toBe("INVALID_VERSION");
    }
  });

  it("refuses a category the model registry does not have", () => {
    const argv = [...VALID];
    argv[5] = "sports";
    expect(reasonOf(() => parse(argv))).toBe("UNKNOWN_CATEGORY");
  });

  it("refuses a training window bound that is not an instant", () => {
    expect(
      reasonOf(() => parse([...VALID, "--train-window-start", "last may"])),
    ).toBe("INVALID_INSTANT");
  });

  it("refuses a seed that is not a non-negative integer", () => {
    for (const bad of ["-1", "1.5", "abc"]) {
      expect(
        reasonOf(() => parse([...VALID, "--seed", bad])),
        bad,
      ).toBe("INVALID_SEED");
    }
  });

  it("carries --regime-mix through, so the registry can refuse the promotion", () => {
    // Not refused here: a regime-mixed model may EXIST in shadow. What it may
    // never be is active, and that is the registry's rule, enforced twice.
    expect(parse([...VALID, "--regime-mix"]).regimeMix).toBe(true);
  });
});

describe("hyperparameters from stdin", () => {
  it("reads empty stdin as no hyperparameters, explicitly", () => {
    expect(parseHyperparams("")).toEqual({});
    expect(parseHyperparams("  \n ")).toEqual({});
  });

  it("refuses a body that is not a JSON object", () => {
    // Never defaults to {}. Two models of the same family with different
    // hyperparameters are different models, so losing the body silently would
    // lose what the version means.
    for (const bad of ["not json", "[1,2]", '"a string"', "42", "null"]) {
      expect(
        reasonOf(() => parseHyperparams(bad)),
        bad,
      ).toBe("INVALID_HYPERPARAMS");
    }
  });
});
