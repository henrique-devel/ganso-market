// RFC-010 module configuration. Kept in its own file (and its own JSON) on
// purpose: config/runtime.json is parsed by three services in three languages,
// and this module must not force a schema change on any of them.
//
// Every value has a defensible default in code; the JSON only overrides. The
// parser fails closed on unknown keys and out-of-range values, exactly like
// the runtime config parser.

import { readFile } from "node:fs/promises";

export const FUNDAMENTAL_CONFIG_FILE_ENV = "GANSO_FUNDAMENTAL_CONFIG_FILE";

export class FundamentalConfigError extends Error {
  public readonly reasonCode: string;

  public constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "FundamentalConfigError";
    this.reasonCode = reasonCode;
  }
}

export interface GateConfig {
  /** Minimum resolved markets covered in shadow before any promotion. */
  readonly minMarkets: number;
  /** Relative Brier degradation that fails a horizon slice (0.20 = 20%). */
  readonly maxHorizonDegradation: number;
  readonly bootstrapResamples: number;
  readonly bootstrapSeed: number;
  /** Block length of the block bootstrap, in days. */
  readonly blockDays: number;
}

export interface WalkForwardConfig {
  readonly trainDays: number;
  readonly validationDays: number;
  readonly stepDays: number;
}

export interface CryptoModelConfig {
  /** EWMA decay factors of the volatility ensemble. */
  readonly ewmaLambdas: readonly number[];
  /** Degrees of freedom of the Student-t variant. */
  readonly studentDf: number;
  /** Minutes of TWAP history required before the model will speak. */
  readonly minHistoryMinutes: number;
  /** Maximum age of the resolving feed sample, in milliseconds. */
  readonly maxFeedAgeMs: number;
}

export interface MacroModelConfig {
  /** Default consensus dispersion per variable when the calendar omits it. */
  readonly defaultSigma: Readonly<Record<string, number>>;
  /** Window after the official release in which the post-release regime holds. */
  readonly postReleaseWindowMs: number;
  /**
   * Under-reaction coefficient of the post-release regime (~0.64-per-1 in the
   * literature). A HYPOTHESIS, validated separately from the pre-release
   * regime; it is never assumed to be edge.
   */
  readonly underReactionCoefficient: number;
  readonly maxCalendarAgeMs: number;
}

export interface FundamentalConfig {
  readonly sRefUsd: number;
  readonly maxBookAgeMs: number;
  readonly maxExecSpread: number;
  readonly thinBookMultiple: number;
  readonly fallbackWidenFactor: number;
  /** Estimation cadence and the per-token rate limit (both 60 s by default). */
  readonly estimateIntervalMs: number;
  readonly minEstimateGapMs: number;
  /** A rule version newer than this at the decision instant sets the flag. */
  readonly ruleChangeWindowMs: number;
  readonly gate: GateConfig;
  readonly walkForward: WalkForwardConfig;
  readonly crypto: CryptoModelConfig;
  readonly macro: MacroModelConfig;
}

export const DEFAULT_FUNDAMENTAL_CONFIG: FundamentalConfig = Object.freeze({
  sRefUsd: 100,
  maxBookAgeMs: 30_000,
  maxExecSpread: 0.1,
  thinBookMultiple: 3,
  fallbackWidenFactor: 1.5,
  estimateIntervalMs: 60_000,
  minEstimateGapMs: 60_000,
  ruleChangeWindowMs: 24 * 3_600_000,
  gate: Object.freeze({
    minMarkets: 100,
    maxHorizonDegradation: 0.2,
    bootstrapResamples: 1_000,
    bootstrapSeed: 20_260_819,
    blockDays: 1,
  }),
  walkForward: Object.freeze({
    trainDays: 21,
    validationDays: 7,
    stepDays: 7,
  }),
  crypto: Object.freeze({
    ewmaLambdas: Object.freeze([0.94, 0.97]),
    studentDf: 4,
    minHistoryMinutes: 120,
    maxFeedAgeMs: 120_000,
  }),
  macro: Object.freeze({
    defaultSigma: Object.freeze({
      cpi_yoy: 0.15,
      cpi_mom: 0.08,
      core_cpi_yoy: 0.12,
      nonfarm_payrolls: 60_000,
      unemployment_rate: 0.12,
      fed_target_rate: 0.1,
    }),
    postReleaseWindowMs: 2 * 3_600_000,
    underReactionCoefficient: 0.64,
    maxCalendarAgeMs: 30 * 24 * 3_600_000,
  }),
});

type JsonObject = Record<string, unknown>;

function requireObject(value: unknown, field: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FundamentalConfigError(
      "FUNDAMENTAL_CONFIG_FIELD_INVALID",
      `${field} must be an object`,
    );
  }
  return value as JsonObject;
}

function rejectUnknownKeys(
  object: JsonObject,
  allowed: readonly string[],
  field: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(object).find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) {
    throw new FundamentalConfigError(
      "FUNDAMENTAL_CONFIG_FIELD_UNKNOWN",
      `${field}.${unknown} is not allowed`,
    );
  }
}

function parseNumber(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FundamentalConfigError(
      "FUNDAMENTAL_CONFIG_FIELD_INVALID",
      `${field} must be a finite number`,
    );
  }
  if (value < minimum || value > maximum) {
    throw new FundamentalConfigError(
      "FUNDAMENTAL_CONFIG_FIELD_INVALID",
      `${field} must be between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function parseInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = parseNumber(value, field, minimum, maximum);
  if (!Number.isSafeInteger(parsed)) {
    throw new FundamentalConfigError(
      "FUNDAMENTAL_CONFIG_FIELD_INVALID",
      `${field} must be an integer`,
    );
  }
  return parsed;
}

function parseNumberArray(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new FundamentalConfigError(
      "FUNDAMENTAL_CONFIG_FIELD_INVALID",
      `${field} must be a non-empty array`,
    );
  }
  return value.map((item, index) =>
    parseNumber(item, `${field}[${index}]`, minimum, maximum),
  );
}

/** Parse an override document on top of the built-in defaults. */
export function parseFundamentalConfig(raw: unknown): FundamentalConfig {
  const root = requireObject(raw, "fundamental");
  rejectUnknownKeys(
    root,
    [
      "schema_version",
      "s_ref_usd",
      "max_book_age_ms",
      "max_exec_spread",
      "thin_book_multiple",
      "fallback_widen_factor",
      "estimate_interval_ms",
      "min_estimate_gap_ms",
      "rule_change_window_ms",
      "gate",
      "walk_forward",
      "crypto",
      "macro",
    ],
    "fundamental",
  );

  if (root.schema_version !== undefined) {
    const schemaVersion = parseInteger(
      root.schema_version,
      "fundamental.schema_version",
      1,
      1,
    );
    if (schemaVersion !== 1) {
      throw new FundamentalConfigError(
        "FUNDAMENTAL_CONFIG_SCHEMA_UNSUPPORTED",
        "schema_version is unsupported",
      );
    }
  }

  const defaults = DEFAULT_FUNDAMENTAL_CONFIG;
  const gateRaw =
    root.gate === undefined ? {} : requireObject(root.gate, "fundamental.gate");
  rejectUnknownKeys(
    gateRaw,
    [
      "min_markets",
      "max_horizon_degradation",
      "bootstrap_resamples",
      "bootstrap_seed",
      "block_days",
    ],
    "fundamental.gate",
  );
  const walkRaw =
    root.walk_forward === undefined
      ? {}
      : requireObject(root.walk_forward, "fundamental.walk_forward");
  rejectUnknownKeys(
    walkRaw,
    ["train_days", "validation_days", "step_days"],
    "fundamental.walk_forward",
  );
  const cryptoRaw =
    root.crypto === undefined
      ? {}
      : requireObject(root.crypto, "fundamental.crypto");
  rejectUnknownKeys(
    cryptoRaw,
    ["ewma_lambdas", "student_df", "min_history_minutes", "max_feed_age_ms"],
    "fundamental.crypto",
  );
  const macroRaw =
    root.macro === undefined
      ? {}
      : requireObject(root.macro, "fundamental.macro");
  rejectUnknownKeys(
    macroRaw,
    [
      "default_sigma",
      "post_release_window_ms",
      "under_reaction_coefficient",
      "max_calendar_age_ms",
    ],
    "fundamental.macro",
  );

  const defaultSigma: Record<string, number> = {
    ...defaults.macro.defaultSigma,
  };
  if (macroRaw.default_sigma !== undefined) {
    const sigmaObject = requireObject(
      macroRaw.default_sigma,
      "fundamental.macro.default_sigma",
    );
    for (const [key, value] of Object.entries(sigmaObject)) {
      defaultSigma[key] = parseNumber(
        value,
        `fundamental.macro.default_sigma.${key}`,
        1e-9,
        1e9,
      );
    }
  }

  // The gate's minimum sample is a floor, never a ceiling: lowering it below
  // the RFC's 100 resolved markets would weaken the promotion criterion.
  const minMarkets =
    gateRaw.min_markets === undefined
      ? defaults.gate.minMarkets
      : parseInteger(
          gateRaw.min_markets,
          "fundamental.gate.min_markets",
          100,
          100_000,
        );

  return Object.freeze({
    sRefUsd:
      root.s_ref_usd === undefined
        ? defaults.sRefUsd
        : parseNumber(root.s_ref_usd, "fundamental.s_ref_usd", 1, 100_000),
    maxBookAgeMs:
      root.max_book_age_ms === undefined
        ? defaults.maxBookAgeMs
        : parseInteger(
            root.max_book_age_ms,
            "fundamental.max_book_age_ms",
            1_000,
            300_000,
          ),
    maxExecSpread:
      root.max_exec_spread === undefined
        ? defaults.maxExecSpread
        : parseNumber(
            root.max_exec_spread,
            "fundamental.max_exec_spread",
            0.001,
            0.5,
          ),
    thinBookMultiple:
      root.thin_book_multiple === undefined
        ? defaults.thinBookMultiple
        : parseInteger(
            root.thin_book_multiple,
            "fundamental.thin_book_multiple",
            1,
            100,
          ),
    fallbackWidenFactor:
      root.fallback_widen_factor === undefined
        ? defaults.fallbackWidenFactor
        : parseNumber(
            root.fallback_widen_factor,
            "fundamental.fallback_widen_factor",
            1.0001,
            10,
          ),
    estimateIntervalMs:
      root.estimate_interval_ms === undefined
        ? defaults.estimateIntervalMs
        : parseInteger(
            root.estimate_interval_ms,
            "fundamental.estimate_interval_ms",
            1_000,
            3_600_000,
          ),
    minEstimateGapMs:
      root.min_estimate_gap_ms === undefined
        ? defaults.minEstimateGapMs
        : parseInteger(
            root.min_estimate_gap_ms,
            "fundamental.min_estimate_gap_ms",
            1_000,
            3_600_000,
          ),
    ruleChangeWindowMs:
      root.rule_change_window_ms === undefined
        ? defaults.ruleChangeWindowMs
        : parseInteger(
            root.rule_change_window_ms,
            "fundamental.rule_change_window_ms",
            0,
            30 * 24 * 3_600_000,
          ),
    gate: Object.freeze({
      minMarkets,
      maxHorizonDegradation:
        gateRaw.max_horizon_degradation === undefined
          ? defaults.gate.maxHorizonDegradation
          : parseNumber(
              gateRaw.max_horizon_degradation,
              "fundamental.gate.max_horizon_degradation",
              0.0001,
              0.2,
            ),
      bootstrapResamples:
        gateRaw.bootstrap_resamples === undefined
          ? defaults.gate.bootstrapResamples
          : parseInteger(
              gateRaw.bootstrap_resamples,
              "fundamental.gate.bootstrap_resamples",
              200,
              20_000,
            ),
      bootstrapSeed:
        gateRaw.bootstrap_seed === undefined
          ? defaults.gate.bootstrapSeed
          : parseInteger(
              gateRaw.bootstrap_seed,
              "fundamental.gate.bootstrap_seed",
              0,
              2_147_483_647,
            ),
      blockDays:
        gateRaw.block_days === undefined
          ? defaults.gate.blockDays
          : parseInteger(
              gateRaw.block_days,
              "fundamental.gate.block_days",
              1,
              30,
            ),
    }),
    walkForward: Object.freeze({
      trainDays:
        walkRaw.train_days === undefined
          ? defaults.walkForward.trainDays
          : parseInteger(
              walkRaw.train_days,
              "fundamental.walk_forward.train_days",
              1,
              3_650,
            ),
      validationDays:
        walkRaw.validation_days === undefined
          ? defaults.walkForward.validationDays
          : parseInteger(
              walkRaw.validation_days,
              "fundamental.walk_forward.validation_days",
              1,
              3_650,
            ),
      stepDays:
        walkRaw.step_days === undefined
          ? defaults.walkForward.stepDays
          : parseInteger(
              walkRaw.step_days,
              "fundamental.walk_forward.step_days",
              1,
              3_650,
            ),
    }),
    crypto: Object.freeze({
      ewmaLambdas: Object.freeze(
        cryptoRaw.ewma_lambdas === undefined
          ? [...defaults.crypto.ewmaLambdas]
          : parseNumberArray(
              cryptoRaw.ewma_lambdas,
              "fundamental.crypto.ewma_lambdas",
              0.5,
              0.9999,
            ),
      ),
      studentDf:
        cryptoRaw.student_df === undefined
          ? defaults.crypto.studentDf
          : parseNumber(
              cryptoRaw.student_df,
              "fundamental.crypto.student_df",
              2.1,
              200,
            ),
      minHistoryMinutes:
        cryptoRaw.min_history_minutes === undefined
          ? defaults.crypto.minHistoryMinutes
          : parseInteger(
              cryptoRaw.min_history_minutes,
              "fundamental.crypto.min_history_minutes",
              10,
              100_000,
            ),
      maxFeedAgeMs:
        cryptoRaw.max_feed_age_ms === undefined
          ? defaults.crypto.maxFeedAgeMs
          : parseInteger(
              cryptoRaw.max_feed_age_ms,
              "fundamental.crypto.max_feed_age_ms",
              1_000,
              3_600_000,
            ),
    }),
    macro: Object.freeze({
      defaultSigma: Object.freeze(defaultSigma),
      postReleaseWindowMs:
        macroRaw.post_release_window_ms === undefined
          ? defaults.macro.postReleaseWindowMs
          : parseInteger(
              macroRaw.post_release_window_ms,
              "fundamental.macro.post_release_window_ms",
              0,
              7 * 24 * 3_600_000,
            ),
      underReactionCoefficient:
        macroRaw.under_reaction_coefficient === undefined
          ? defaults.macro.underReactionCoefficient
          : parseNumber(
              macroRaw.under_reaction_coefficient,
              "fundamental.macro.under_reaction_coefficient",
              0,
              1,
            ),
      maxCalendarAgeMs:
        macroRaw.max_calendar_age_ms === undefined
          ? defaults.macro.maxCalendarAgeMs
          : parseInteger(
              macroRaw.max_calendar_age_ms,
              "fundamental.macro.max_calendar_age_ms",
              60_000,
              365 * 24 * 3_600_000,
            ),
    }),
  });
}

export interface LoadFundamentalConfigOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readTextFile?: (path: string) => Promise<string>;
}

/** Load the module config; with no file configured the defaults are used. */
export async function loadFundamentalConfig(
  options: LoadFundamentalConfigOptions = {},
): Promise<FundamentalConfig> {
  const env = options.env ?? process.env;
  const path = env[FUNDAMENTAL_CONFIG_FILE_ENV];
  if (path === undefined || path === "") {
    return DEFAULT_FUNDAMENTAL_CONFIG;
  }
  const readTextFile =
    options.readTextFile ?? ((file: string) => readFile(file, "utf8"));
  let text: string;
  try {
    text = await readTextFile(path);
  } catch {
    throw new FundamentalConfigError(
      "FUNDAMENTAL_CONFIG_FILE_UNREADABLE",
      "configured fundamental config file could not be read",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new FundamentalConfigError(
      "FUNDAMENTAL_CONFIG_FILE_INVALID_JSON",
      "fundamental config file is not valid JSON",
    );
  }
  return parseFundamentalConfig(parsed);
}
