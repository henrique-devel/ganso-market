// RFC-018 item 4: turning an operator's arguments into a model version.
//
// Split out of `models-cli.ts` so it can be tested. A CLI entry point runs on
// import, so anything worth asserting about — which arguments are refused, and
// with what reason code — has to live somewhere a test can call. The CLI is the
// plumbing: read stdin, open the pool, print JSON. This is the part with rules.
//
// Every refusal here has a reason code and says what it refused. The registry
// enforces the database-level invariants (identity immutable, born in shadow,
// regime boundary) a second time before the statement is sent; these checks
// exist so the operator gets a sentence instead of a constraint violation.

import { FUNDAMENTAL_CATEGORIES } from "./types.js";
import type { FundamentalCategory } from "./types.js";
import type { RegisterModelInput } from "./registry.js";

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export class ModelRegisterArgsError extends Error {
  public readonly reasonCode: string;

  public constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "ModelRegisterArgsError";
    this.reasonCode = reasonCode;
  }
}

export const MODELS_CLI_USAGE =
  "usage: models <list [--category <c>] [--status <s>] | show <model_id> | " +
  "register --family <f> --version <x.y.z> --category <c> " +
  "--feature-set-version <v> [--seed <n>] " +
  "[--train-window-start <iso> --train-window-end <iso>] [--regime-mix]>  " +
  "(register reads hyperparameters as a JSON object from stdin; empty stdin " +
  "means {})";

function fail(reasonCode: string, message: string): never {
  throw new ModelRegisterArgsError(reasonCode, message);
}

export function flagValue(
  argv: readonly string[],
  flag: string,
): string | null {
  const index = argv.indexOf(flag);
  if (index < 0) {
    return null;
  }
  return argv[index + 1] ?? null;
}

/**
 * A flag whose value is required.
 *
 * A value that starts with `--` is refused rather than accepted: it is what a
 * forgotten argument looks like (`--version --category crypto_updown`), and
 * taking it literally would mint a version literally named "--category".
 */
function required(argv: readonly string[], flag: string): string {
  const value = flagValue(argv, flag);
  if (value === null || value === "" || value.startsWith("--")) {
    fail("MISSING_FLAG", `${flag} is required`);
  }
  return value;
}

function parseCategory(value: string): FundamentalCategory {
  if (!(FUNDAMENTAL_CATEGORIES as readonly string[]).includes(value)) {
    fail(
      "UNKNOWN_CATEGORY",
      `category must be one of ${FUNDAMENTAL_CATEGORIES.join(", ")}`,
    );
  }
  return value as FundamentalCategory;
}

/**
 * A training window bound. Refused rather than coerced: a window silently read
 * as "now" would put a model's provenance a season away from its data.
 */
function parseInstant(value: string | null, flag: string): Date | null {
  if (value === null) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    fail("INVALID_INSTANT", `${flag} is not a valid ISO instant`);
  }
  return parsed;
}

/**
 * Hyperparameters, read as data from stdin.
 *
 * They are part of what the version MEANS — two models of the same family with
 * different hyperparameters are different models — so an unparseable body is
 * refused instead of defaulting to `{}`. Empty stdin is the one exception, and
 * it is explicit: a version with no hyperparameters of its own.
 */
export function parseHyperparams(raw: string): Record<string, unknown> {
  if (raw.trim() === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    fail("INVALID_HYPERPARAMS", "hyperparameters on stdin are not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("INVALID_HYPERPARAMS", "hyperparameters must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** Build the registry input from the operator's arguments, or refuse. */
export function parseRegisterArgs(input: {
  readonly argv: readonly string[];
  readonly stdin: string;
  /**
   * The release revision. Null is refused, exactly as `ensureCatalogModels`
   * refuses it: a model whose code cannot be identified cannot be reproduced,
   * and an irreproducible model is not evidence of anything.
   */
  readonly gitSha: string | null;
}): RegisterModelInput {
  const { argv } = input;

  const family = required(argv, "--family");
  if (!NAME_PATTERN.test(family)) {
    fail("INVALID_FAMILY", "family must be 1-64 chars of [A-Za-z0-9._-]");
  }
  const version = required(argv, "--version");
  if (!VERSION_PATTERN.test(version)) {
    fail("INVALID_VERSION", "version must be x.y.z");
  }
  const featureSetVersion = required(argv, "--feature-set-version");
  if (!NAME_PATTERN.test(featureSetVersion)) {
    fail(
      "INVALID_FEATURE_SET_VERSION",
      "feature-set-version must be 1-64 chars of [A-Za-z0-9._-]",
    );
  }
  const category = parseCategory(required(argv, "--category"));

  const seedRaw = flagValue(argv, "--seed");
  const seed = seedRaw === null ? 0 : Number(seedRaw);
  if (!Number.isSafeInteger(seed) || seed < 0) {
    fail("INVALID_SEED", "seed must be a non-negative integer");
  }

  if (input.gitSha === null) {
    fail(
      "GIT_SHA_UNAVAILABLE",
      "no release revision is readable, and a model version without complete " +
        "provenance must not exist",
    );
  }

  return {
    modelId: `${family}@${version}`,
    modelFamily: family,
    category,
    version,
    gitSha: input.gitSha,
    featureSetVersion,
    hyperparams: parseHyperparams(input.stdin),
    seed,
    trainWindowStart: parseInstant(
      flagValue(argv, "--train-window-start"),
      "--train-window-start",
    ),
    trainWindowEnd: parseInstant(
      flagValue(argv, "--train-window-end"),
      "--train-window-end",
    ),
    regimeMix: argv.includes("--regime-mix"),
  };
}
