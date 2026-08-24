// RFC-012 module configuration. Same pattern as the fundamental module: one
// JSON file named by one env var, frozen in-code defaults when unset, and a
// parser that fails closed on unknown keys and out-of-range values. The score
// weights, thresholds, priors and buffer parameters here are score-version
// material: their canonical hash (together with the lexicon hash) pins a
// score_version row, and changing any of them requires a new score_version.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const RESOLUTION_CONFIG_FILE_ENV = "GANSO_RESOLUTION_CONFIG_FILE";

export class ResolutionConfigError extends Error {
  public readonly reasonCode: string;

  public constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "ResolutionConfigError";
    this.reasonCode = reasonCode;
  }
}

/** Feature weights of the composed score R. Monotonic by construction: every
 * feature is normalized into [0, 1] and the weights sum to 1. */
export interface ScoreWeights {
  readonly rulePrecision: number;
  readonly disputePrior: number;
  readonly clarification: number;
  readonly umaSensitivity: number;
  readonly endDateMismatch: number;
  readonly holdersConcentration: number;
  readonly p5050: number;
  readonly adjudicationPremium: number;
}

export interface ScoreThresholds {
  /** R at or above this (or any hard flag) vetoes new entries. */
  readonly rVeto: number;
  /** R at or above this adds resolution_buffer to the EV costs. */
  readonly rBuffer: number;
}

export interface BufferConfig {
  /** Price-independent buffer per share at R = 1 (linear ramp from rBuffer). */
  readonly maxBase: number;
  /** Capital hurdle per share-notional per day of expected lockup. */
  readonly capitalDailyHurdle: number;
}

export interface HardFlagConfig {
  /** A material clarification younger than this forces VETO. */
  readonly clarificationWindowMs: number;
  /** Linear decay horizon of the clarification feature after the window. */
  readonly clarificationDecayMs: number;
  /** Mid move within jumpWindowMs that trips the suspect circuit breaker. */
  readonly jumpThreshold: number;
  readonly jumpWindowMs: number;
  /** A catalyst within this many minutes explains a jump (no suspicion). */
  readonly catalystProximityMin: number;
}

export interface P5050Config {
  /** Base P(50/50) for a fully precise rule. */
  readonly base: number;
  /** Slope on (1 - rule precision). */
  readonly precisionMultiplier: number;
  /** Own-history sample size before the measured frequency takes over. */
  readonly measuredMinN: number;
  /** Ceiling of the estimate (and the feature normalizer). */
  readonly cap: number;
}

export interface LockupCategoryMinutes {
  readonly crypto: number;
  readonly macro: number;
  readonly default: number;
}

export interface LockupConfig {
  /** Case-base median time to settle, by Gamma category. */
  readonly baseMedianMinutes: LockupCategoryMinutes;
  /** Extra median added conditional on a dispute (research: ~49 h). */
  readonly disputeAddedMedianMinutes: number;
  /** Dispute-conditional tail (research: P99 ~4d5h; DVM 4-6 days). */
  readonly disputeP95Minutes: number;
  /** Undisputed tail, by category. */
  readonly p95BaseMinutes: LockupCategoryMinutes;
}

export interface DisputePriorExternal {
  readonly disputeRate: number;
  /** Where the number came from — reported verbatim by the API. */
  readonly source: string;
}

export interface PriorsConfig {
  readonly crypto: DisputePriorExternal;
  readonly macro: DisputePriorExternal;
  readonly default: DisputePriorExternal;
  /** Resolutions observed per category before prior_measured takes over. */
  readonly measuredMinN: number;
  /** Feature normalizer: dispute rate at which the feature saturates to 1. */
  readonly rateCap: number;
}

export interface UmaBaselines {
  /** Baseline proposal bond in USD (research: ~US$ 750). */
  readonly baselineBond: string;
  /** Baseline liveness in seconds (research: 2 h). */
  readonly baselineLivenessS: number;
}

export interface CadenceConfig {
  readonly stateTickMs: number;
  readonly sweepMs: number;
  readonly graphBuildMs: number;
  readonly graphEvalMs: number;
  readonly divergenceMs: number;
  readonly reportMs: number;
  readonly onchainPollMs: number;
  readonly heartbeatMs: number;
}

export interface GraphConfig {
  /** ε added on top of measured costs in the tolerance band. */
  readonly epsilon: number;
  /** Consecutive evaluations beyond the band before a violation opens. */
  readonly persistenceK: number;
  /** Book snapshots older than this are skipped, never evaluated. */
  readonly maxBookAgeMs: number;
  /** Structural edges below this confidence are not evaluated. */
  readonly minConfidence: number;
  /** Book-walk cap when sizing a violation, in shares. */
  readonly walkSizeCapShares: string;
  /** Executable-price notional reference for graph checks, in USD. */
  readonly sRefUsd: number;
}

export interface OnchainConfig {
  readonly enabled: boolean;
  readonly rpcUrls: readonly string[];
  /** UMA CTF Adapter addresses (v2 and v3), lowercase 0x hex. */
  readonly adapters: readonly string[];
  /** Blocks behind the head the collector stays (reorg safety). */
  readonly confirmations: number;
  readonly chunkBlocks: number;
  readonly maxChunksPerPoll: number;
  /** First-boot lookback from the head, in blocks. */
  readonly lookbackBlocks: number;
  readonly requestTimeoutMs: number;
}

export interface ResolutionConfig {
  readonly scoreVersion: string;
  readonly weights: ScoreWeights;
  readonly thresholds: ScoreThresholds;
  readonly buffer: BufferConfig;
  readonly hardFlags: HardFlagConfig;
  readonly p5050: P5050Config;
  readonly lockup: LockupConfig;
  readonly priors: PriorsConfig;
  readonly uma: UmaBaselines;
  readonly cadence: CadenceConfig;
  readonly graph: GraphConfig;
  readonly onchain: OnchainConfig;
}

export const DEFAULT_RESOLUTION_CONFIG: ResolutionConfig = Object.freeze({
  scoreVersion: "1.0.0",
  weights: Object.freeze({
    rulePrecision: 0.3,
    disputePrior: 0.15,
    clarification: 0.1,
    umaSensitivity: 0.1,
    endDateMismatch: 0.05,
    holdersConcentration: 0.1,
    p5050: 0.1,
    adjudicationPremium: 0.1,
  }),
  thresholds: Object.freeze({ rVeto: 0.7, rBuffer: 0.4 }),
  buffer: Object.freeze({ maxBase: 0.05, capitalDailyHurdle: 0.0005 }),
  hardFlags: Object.freeze({
    clarificationWindowMs: 24 * 3_600_000,
    clarificationDecayMs: 7 * 24 * 3_600_000,
    jumpThreshold: 0.25,
    jumpWindowMs: 300_000,
    catalystProximityMin: 60,
  }),
  p5050: Object.freeze({
    base: 0.002,
    precisionMultiplier: 0.03,
    measuredMinN: 200,
    cap: 0.1,
  }),
  lockup: Object.freeze({
    baseMedianMinutes: Object.freeze({ crypto: 38, macro: 120, default: 60 }),
    disputeAddedMedianMinutes: 2_940,
    disputeP95Minutes: 6_060,
    p95BaseMinutes: Object.freeze({ crypto: 120, macro: 360, default: 240 }),
  }),
  priors: Object.freeze({
    crypto: Object.freeze({
      disputeRate: 0.006,
      source: "pesquisa 2026-08: cripto-preço 0,6%",
    }),
    macro: Object.freeze({
      disputeRate: 0.034,
      source: "pesquisa 2026-08: politics-policy 3,4% como proxy conservador",
    }),
    default: Object.freeze({
      disputeRate: 0.048,
      source: "pesquisa 2026-08: geopolítica 4,8% — teto observado",
    }),
    measuredMinN: 200,
    rateCap: 0.05,
  }),
  uma: Object.freeze({ baselineBond: "750", baselineLivenessS: 7_200 }),
  cadence: Object.freeze({
    stateTickMs: 10_000,
    sweepMs: 3_600_000,
    graphBuildMs: 600_000,
    graphEvalMs: 60_000,
    divergenceMs: 60_000,
    reportMs: 86_400_000,
    onchainPollMs: 300_000,
    heartbeatMs: 60_000,
  }),
  graph: Object.freeze({
    epsilon: 0.005,
    persistenceK: 3,
    maxBookAgeMs: 90_000,
    minConfidence: 0.5,
    walkSizeCapShares: "1000",
    sRefUsd: 100,
  }),
  onchain: Object.freeze({
    enabled: false,
    rpcUrls: Object.freeze(["https://polygon-rpc.com"]),
    // The RFC-named V2 adapter plus the deployments Gamma's resolvedBy names
    // today (verified live 2026-08-24: both emit exactly the verified event
    // signatures). Addresses are config: a new deployment is a config change.
    adapters: Object.freeze([
      "0x6a9d222616c90fca5754cd1333cfd9b7fb6a4f74",
      "0x157ce2d672854c848c9b79c49a8cc6cc89176a49",
      "0x65070be91477460d8a7aeeb94ef92fe056c2f2a7",
      "0x69c47de9d4d3dad79590d61b9e05918e03775f24",
    ]),
    confirmations: 60,
    chunkBlocks: 2_000,
    maxChunksPerPoll: 5,
    lookbackBlocks: 200_000,
    requestTimeoutMs: 10_000,
  }),
});

type JsonObject = Record<string, unknown>;

function requireObject(value: unknown, field: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ResolutionConfigError(
      "RESOLUTION_CONFIG_FIELD_INVALID",
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
    throw new ResolutionConfigError(
      "RESOLUTION_CONFIG_FIELD_UNKNOWN",
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
    throw new ResolutionConfigError(
      "RESOLUTION_CONFIG_FIELD_INVALID",
      `${field} must be a finite number`,
    );
  }
  if (value < minimum || value > maximum) {
    throw new ResolutionConfigError(
      "RESOLUTION_CONFIG_FIELD_INVALID",
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
    throw new ResolutionConfigError(
      "RESOLUTION_CONFIG_FIELD_INVALID",
      `${field} must be an integer`,
    );
  }
  return parsed;
}

function parseString(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ResolutionConfigError(
      "RESOLUTION_CONFIG_FIELD_INVALID",
      `${field} must be a non-empty string`,
    );
  }
  if (pattern !== undefined && !pattern.test(value)) {
    throw new ResolutionConfigError(
      "RESOLUTION_CONFIG_FIELD_INVALID",
      `${field} does not match the required format`,
    );
  }
  return value;
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ResolutionConfigError(
      "RESOLUTION_CONFIG_FIELD_INVALID",
      `${field} must be a boolean`,
    );
  }
  return value;
}

function parseStringArray(
  value: unknown,
  field: string,
  pattern?: RegExp,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ResolutionConfigError(
      "RESOLUTION_CONFIG_FIELD_INVALID",
      `${field} must be a non-empty array`,
    );
  }
  return Object.freeze(
    value.map((item, index) =>
      parseString(item, `${field}[${index}]`, pattern),
    ),
  );
}

/** Numbers only where a field is present; defaults everywhere else. */
function numberOr(
  object: JsonObject,
  key: string,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  if (object[key] === undefined) {
    return fallback;
  }
  return integer
    ? parseInteger(object[key], field, minimum, maximum)
    : parseNumber(object[key], field, minimum, maximum);
}

function parseWeights(raw: unknown, defaults: ScoreWeights): ScoreWeights {
  if (raw === undefined) {
    return defaults;
  }
  const object = requireObject(raw, "resolution.weights");
  const keys = [
    "rule_precision",
    "dispute_prior",
    "clarification",
    "uma_sensitivity",
    "end_date_mismatch",
    "holders_concentration",
    "p_5050",
    "adjudication_premium",
  ];
  rejectUnknownKeys(object, keys, "resolution.weights");
  const weights: ScoreWeights = Object.freeze({
    rulePrecision: numberOr(
      object,
      "rule_precision",
      "resolution.weights.rule_precision",
      defaults.rulePrecision,
      0,
      1,
    ),
    disputePrior: numberOr(
      object,
      "dispute_prior",
      "resolution.weights.dispute_prior",
      defaults.disputePrior,
      0,
      1,
    ),
    clarification: numberOr(
      object,
      "clarification",
      "resolution.weights.clarification",
      defaults.clarification,
      0,
      1,
    ),
    umaSensitivity: numberOr(
      object,
      "uma_sensitivity",
      "resolution.weights.uma_sensitivity",
      defaults.umaSensitivity,
      0,
      1,
    ),
    endDateMismatch: numberOr(
      object,
      "end_date_mismatch",
      "resolution.weights.end_date_mismatch",
      defaults.endDateMismatch,
      0,
      1,
    ),
    holdersConcentration: numberOr(
      object,
      "holders_concentration",
      "resolution.weights.holders_concentration",
      defaults.holdersConcentration,
      0,
      1,
    ),
    p5050: numberOr(
      object,
      "p_5050",
      "resolution.weights.p_5050",
      defaults.p5050,
      0,
      1,
    ),
    adjudicationPremium: numberOr(
      object,
      "adjudication_premium",
      "resolution.weights.adjudication_premium",
      defaults.adjudicationPremium,
      0,
      1,
    ),
  });
  const sum =
    weights.rulePrecision +
    weights.disputePrior +
    weights.clarification +
    weights.umaSensitivity +
    weights.endDateMismatch +
    weights.holdersConcentration +
    weights.p5050 +
    weights.adjudicationPremium;
  if (Math.abs(sum - 1) > 1e-9) {
    throw new ResolutionConfigError(
      "RESOLUTION_CONFIG_FIELD_INVALID",
      `resolution.weights must sum to 1 (got ${sum})`,
    );
  }
  return weights;
}

function parseCategoryMinutes(
  raw: unknown,
  field: string,
  defaults: LockupCategoryMinutes,
): LockupCategoryMinutes {
  if (raw === undefined) {
    return defaults;
  }
  const object = requireObject(raw, field);
  rejectUnknownKeys(object, ["crypto", "macro", "default"], field);
  return Object.freeze({
    crypto: numberOr(
      object,
      "crypto",
      `${field}.crypto`,
      defaults.crypto,
      1,
      1_000_000,
    ),
    macro: numberOr(
      object,
      "macro",
      `${field}.macro`,
      defaults.macro,
      1,
      1_000_000,
    ),
    default: numberOr(
      object,
      "default",
      `${field}.default`,
      defaults.default,
      1,
      1_000_000,
    ),
  });
}

function parsePriorEntry(
  raw: unknown,
  field: string,
  defaults: DisputePriorExternal,
): DisputePriorExternal {
  if (raw === undefined) {
    return defaults;
  }
  const object = requireObject(raw, field);
  rejectUnknownKeys(object, ["dispute_rate", "source"], field);
  return Object.freeze({
    disputeRate: numberOr(
      object,
      "dispute_rate",
      `${field}.dispute_rate`,
      defaults.disputeRate,
      0,
      1,
    ),
    source:
      object.source === undefined
        ? defaults.source
        : parseString(object.source, `${field}.source`),
  });
}

/** Parse an override document on top of the built-in defaults. */
export function parseResolutionConfig(raw: unknown): ResolutionConfig {
  const root = requireObject(raw, "resolution");
  rejectUnknownKeys(
    root,
    [
      "schema_version",
      "score_version",
      "weights",
      "thresholds",
      "buffer",
      "hard_flags",
      "p5050",
      "lockup",
      "priors",
      "uma",
      "cadence",
      "graph",
      "onchain",
    ],
    "resolution",
  );
  if (root.schema_version !== undefined) {
    const schemaVersion = parseInteger(
      root.schema_version,
      "resolution.schema_version",
      1,
      1,
    );
    if (schemaVersion !== 1) {
      throw new ResolutionConfigError(
        "RESOLUTION_CONFIG_SCHEMA_UNSUPPORTED",
        "schema_version is unsupported",
      );
    }
  }
  const defaults = DEFAULT_RESOLUTION_CONFIG;

  const thresholdsRaw =
    root.thresholds === undefined
      ? {}
      : requireObject(root.thresholds, "resolution.thresholds");
  rejectUnknownKeys(
    thresholdsRaw,
    ["r_veto", "r_buffer"],
    "resolution.thresholds",
  );
  const thresholds: ScoreThresholds = Object.freeze({
    rVeto: numberOr(
      thresholdsRaw,
      "r_veto",
      "resolution.thresholds.r_veto",
      defaults.thresholds.rVeto,
      0.01,
      1,
    ),
    rBuffer: numberOr(
      thresholdsRaw,
      "r_buffer",
      "resolution.thresholds.r_buffer",
      defaults.thresholds.rBuffer,
      0,
      1,
    ),
  });
  if (thresholds.rBuffer >= thresholds.rVeto) {
    throw new ResolutionConfigError(
      "RESOLUTION_CONFIG_FIELD_INVALID",
      "resolution.thresholds.r_buffer must be below r_veto",
    );
  }

  const bufferRaw =
    root.buffer === undefined
      ? {}
      : requireObject(root.buffer, "resolution.buffer");
  rejectUnknownKeys(
    bufferRaw,
    ["max_base", "capital_daily_hurdle"],
    "resolution.buffer",
  );
  const buffer: BufferConfig = Object.freeze({
    maxBase: numberOr(
      bufferRaw,
      "max_base",
      "resolution.buffer.max_base",
      defaults.buffer.maxBase,
      0,
      0.5,
    ),
    capitalDailyHurdle: numberOr(
      bufferRaw,
      "capital_daily_hurdle",
      "resolution.buffer.capital_daily_hurdle",
      defaults.buffer.capitalDailyHurdle,
      0,
      0.1,
    ),
  });

  const hardRaw =
    root.hard_flags === undefined
      ? {}
      : requireObject(root.hard_flags, "resolution.hard_flags");
  rejectUnknownKeys(
    hardRaw,
    [
      "clarification_window_ms",
      "clarification_decay_ms",
      "jump_threshold",
      "jump_window_ms",
      "catalyst_proximity_min",
    ],
    "resolution.hard_flags",
  );
  const hardFlags: HardFlagConfig = Object.freeze({
    clarificationWindowMs: numberOr(
      hardRaw,
      "clarification_window_ms",
      "resolution.hard_flags.clarification_window_ms",
      defaults.hardFlags.clarificationWindowMs,
      0,
      30 * 24 * 3_600_000,
      true,
    ),
    clarificationDecayMs: numberOr(
      hardRaw,
      "clarification_decay_ms",
      "resolution.hard_flags.clarification_decay_ms",
      defaults.hardFlags.clarificationDecayMs,
      0,
      90 * 24 * 3_600_000,
      true,
    ),
    jumpThreshold: numberOr(
      hardRaw,
      "jump_threshold",
      "resolution.hard_flags.jump_threshold",
      defaults.hardFlags.jumpThreshold,
      0.01,
      1,
    ),
    jumpWindowMs: numberOr(
      hardRaw,
      "jump_window_ms",
      "resolution.hard_flags.jump_window_ms",
      defaults.hardFlags.jumpWindowMs,
      10_000,
      3_600_000,
      true,
    ),
    catalystProximityMin: numberOr(
      hardRaw,
      "catalyst_proximity_min",
      "resolution.hard_flags.catalyst_proximity_min",
      defaults.hardFlags.catalystProximityMin,
      0,
      100_000,
      true,
    ),
  });
  if (hardFlags.clarificationDecayMs < hardFlags.clarificationWindowMs) {
    throw new ResolutionConfigError(
      "RESOLUTION_CONFIG_FIELD_INVALID",
      "resolution.hard_flags.clarification_decay_ms must not be shorter than the window",
    );
  }

  const p5050Raw =
    root.p5050 === undefined
      ? {}
      : requireObject(root.p5050, "resolution.p5050");
  rejectUnknownKeys(
    p5050Raw,
    ["base", "precision_multiplier", "measured_min_n", "cap"],
    "resolution.p5050",
  );
  const p5050: P5050Config = Object.freeze({
    base: numberOr(
      p5050Raw,
      "base",
      "resolution.p5050.base",
      defaults.p5050.base,
      0,
      0.5,
    ),
    precisionMultiplier: numberOr(
      p5050Raw,
      "precision_multiplier",
      "resolution.p5050.precision_multiplier",
      defaults.p5050.precisionMultiplier,
      0,
      0.5,
    ),
    measuredMinN: numberOr(
      p5050Raw,
      "measured_min_n",
      "resolution.p5050.measured_min_n",
      defaults.p5050.measuredMinN,
      1,
      1_000_000,
      true,
    ),
    cap: numberOr(
      p5050Raw,
      "cap",
      "resolution.p5050.cap",
      defaults.p5050.cap,
      0.001,
      0.5,
    ),
  });

  const lockupRaw =
    root.lockup === undefined
      ? {}
      : requireObject(root.lockup, "resolution.lockup");
  rejectUnknownKeys(
    lockupRaw,
    [
      "base_median_minutes",
      "dispute_added_median_minutes",
      "dispute_p95_minutes",
      "p95_base_minutes",
    ],
    "resolution.lockup",
  );
  const lockup: LockupConfig = Object.freeze({
    baseMedianMinutes: parseCategoryMinutes(
      lockupRaw.base_median_minutes,
      "resolution.lockup.base_median_minutes",
      defaults.lockup.baseMedianMinutes,
    ),
    disputeAddedMedianMinutes: numberOr(
      lockupRaw,
      "dispute_added_median_minutes",
      "resolution.lockup.dispute_added_median_minutes",
      defaults.lockup.disputeAddedMedianMinutes,
      1,
      1_000_000,
    ),
    disputeP95Minutes: numberOr(
      lockupRaw,
      "dispute_p95_minutes",
      "resolution.lockup.dispute_p95_minutes",
      defaults.lockup.disputeP95Minutes,
      1,
      1_000_000,
    ),
    p95BaseMinutes: parseCategoryMinutes(
      lockupRaw.p95_base_minutes,
      "resolution.lockup.p95_base_minutes",
      defaults.lockup.p95BaseMinutes,
    ),
  });

  const priorsRaw =
    root.priors === undefined
      ? {}
      : requireObject(root.priors, "resolution.priors");
  rejectUnknownKeys(
    priorsRaw,
    ["crypto", "macro", "default", "measured_min_n", "rate_cap"],
    "resolution.priors",
  );
  const priors: PriorsConfig = Object.freeze({
    crypto: parsePriorEntry(
      priorsRaw.crypto,
      "resolution.priors.crypto",
      defaults.priors.crypto,
    ),
    macro: parsePriorEntry(
      priorsRaw.macro,
      "resolution.priors.macro",
      defaults.priors.macro,
    ),
    default: parsePriorEntry(
      priorsRaw.default,
      "resolution.priors.default",
      defaults.priors.default,
    ),
    measuredMinN: numberOr(
      priorsRaw,
      "measured_min_n",
      "resolution.priors.measured_min_n",
      defaults.priors.measuredMinN,
      1,
      1_000_000,
      true,
    ),
    rateCap: numberOr(
      priorsRaw,
      "rate_cap",
      "resolution.priors.rate_cap",
      defaults.priors.rateCap,
      0.001,
      1,
    ),
  });

  const umaRaw =
    root.uma === undefined ? {} : requireObject(root.uma, "resolution.uma");
  rejectUnknownKeys(
    umaRaw,
    ["baseline_bond", "baseline_liveness_s"],
    "resolution.uma",
  );
  const uma: UmaBaselines = Object.freeze({
    baselineBond:
      umaRaw.baseline_bond === undefined
        ? defaults.uma.baselineBond
        : parseString(
            umaRaw.baseline_bond,
            "resolution.uma.baseline_bond",
            /^[0-9]+(\.[0-9]+)?$/,
          ),
    baselineLivenessS: numberOr(
      umaRaw,
      "baseline_liveness_s",
      "resolution.uma.baseline_liveness_s",
      defaults.uma.baselineLivenessS,
      1,
      1_000_000,
      true,
    ),
  });

  const cadenceRaw =
    root.cadence === undefined
      ? {}
      : requireObject(root.cadence, "resolution.cadence");
  rejectUnknownKeys(
    cadenceRaw,
    [
      "state_tick_ms",
      "sweep_ms",
      "graph_build_ms",
      "graph_eval_ms",
      "divergence_ms",
      "report_ms",
      "onchain_poll_ms",
      "heartbeat_ms",
    ],
    "resolution.cadence",
  );
  const cadence: CadenceConfig = Object.freeze({
    stateTickMs: numberOr(
      cadenceRaw,
      "state_tick_ms",
      "resolution.cadence.state_tick_ms",
      defaults.cadence.stateTickMs,
      1_000,
      600_000,
      true,
    ),
    sweepMs: numberOr(
      cadenceRaw,
      "sweep_ms",
      "resolution.cadence.sweep_ms",
      defaults.cadence.sweepMs,
      60_000,
      24 * 3_600_000,
      true,
    ),
    graphBuildMs: numberOr(
      cadenceRaw,
      "graph_build_ms",
      "resolution.cadence.graph_build_ms",
      defaults.cadence.graphBuildMs,
      60_000,
      24 * 3_600_000,
      true,
    ),
    graphEvalMs: numberOr(
      cadenceRaw,
      "graph_eval_ms",
      "resolution.cadence.graph_eval_ms",
      defaults.cadence.graphEvalMs,
      10_000,
      3_600_000,
      true,
    ),
    divergenceMs: numberOr(
      cadenceRaw,
      "divergence_ms",
      "resolution.cadence.divergence_ms",
      defaults.cadence.divergenceMs,
      10_000,
      3_600_000,
      true,
    ),
    reportMs: numberOr(
      cadenceRaw,
      "report_ms",
      "resolution.cadence.report_ms",
      defaults.cadence.reportMs,
      3_600_000,
      7 * 24 * 3_600_000,
      true,
    ),
    onchainPollMs: numberOr(
      cadenceRaw,
      "onchain_poll_ms",
      "resolution.cadence.onchain_poll_ms",
      defaults.cadence.onchainPollMs,
      30_000,
      3_600_000,
      true,
    ),
    heartbeatMs: numberOr(
      cadenceRaw,
      "heartbeat_ms",
      "resolution.cadence.heartbeat_ms",
      defaults.cadence.heartbeatMs,
      10_000,
      600_000,
      true,
    ),
  });

  const graphRaw =
    root.graph === undefined
      ? {}
      : requireObject(root.graph, "resolution.graph");
  rejectUnknownKeys(
    graphRaw,
    [
      "epsilon",
      "persistence_k",
      "max_book_age_ms",
      "min_confidence",
      "walk_size_cap_shares",
      "s_ref_usd",
    ],
    "resolution.graph",
  );
  const graph: GraphConfig = Object.freeze({
    epsilon: numberOr(
      graphRaw,
      "epsilon",
      "resolution.graph.epsilon",
      defaults.graph.epsilon,
      0,
      0.2,
    ),
    persistenceK: numberOr(
      graphRaw,
      "persistence_k",
      "resolution.graph.persistence_k",
      defaults.graph.persistenceK,
      1,
      100,
      true,
    ),
    maxBookAgeMs: numberOr(
      graphRaw,
      "max_book_age_ms",
      "resolution.graph.max_book_age_ms",
      defaults.graph.maxBookAgeMs,
      1_000,
      3_600_000,
      true,
    ),
    minConfidence: numberOr(
      graphRaw,
      "min_confidence",
      "resolution.graph.min_confidence",
      defaults.graph.minConfidence,
      0,
      1,
    ),
    walkSizeCapShares:
      graphRaw.walk_size_cap_shares === undefined
        ? defaults.graph.walkSizeCapShares
        : parseString(
            graphRaw.walk_size_cap_shares,
            "resolution.graph.walk_size_cap_shares",
            /^[0-9]+(\.[0-9]+)?$/,
          ),
    sRefUsd: numberOr(
      graphRaw,
      "s_ref_usd",
      "resolution.graph.s_ref_usd",
      defaults.graph.sRefUsd,
      1,
      100_000,
    ),
  });

  const onchainRaw =
    root.onchain === undefined
      ? {}
      : requireObject(root.onchain, "resolution.onchain");
  rejectUnknownKeys(
    onchainRaw,
    [
      "enabled",
      "rpc_urls",
      "adapters",
      "confirmations",
      "chunk_blocks",
      "max_chunks_per_poll",
      "lookback_blocks",
      "request_timeout_ms",
    ],
    "resolution.onchain",
  );
  const onchain: OnchainConfig = Object.freeze({
    enabled:
      onchainRaw.enabled === undefined
        ? defaults.onchain.enabled
        : parseBoolean(onchainRaw.enabled, "resolution.onchain.enabled"),
    rpcUrls:
      onchainRaw.rpc_urls === undefined
        ? defaults.onchain.rpcUrls
        : parseStringArray(
            onchainRaw.rpc_urls,
            "resolution.onchain.rpc_urls",
            /^https:\/\/[^\s]+$/,
          ),
    adapters:
      onchainRaw.adapters === undefined
        ? defaults.onchain.adapters
        : parseStringArray(
            onchainRaw.adapters,
            "resolution.onchain.adapters",
            /^0x[0-9a-f]{40}$/,
          ),
    confirmations: numberOr(
      onchainRaw,
      "confirmations",
      "resolution.onchain.confirmations",
      defaults.onchain.confirmations,
      0,
      10_000,
      true,
    ),
    chunkBlocks: numberOr(
      onchainRaw,
      "chunk_blocks",
      "resolution.onchain.chunk_blocks",
      defaults.onchain.chunkBlocks,
      100,
      100_000,
      true,
    ),
    maxChunksPerPoll: numberOr(
      onchainRaw,
      "max_chunks_per_poll",
      "resolution.onchain.max_chunks_per_poll",
      defaults.onchain.maxChunksPerPoll,
      1,
      100,
      true,
    ),
    lookbackBlocks: numberOr(
      onchainRaw,
      "lookback_blocks",
      "resolution.onchain.lookback_blocks",
      defaults.onchain.lookbackBlocks,
      0,
      10_000_000,
      true,
    ),
    requestTimeoutMs: numberOr(
      onchainRaw,
      "request_timeout_ms",
      "resolution.onchain.request_timeout_ms",
      defaults.onchain.requestTimeoutMs,
      1_000,
      120_000,
      true,
    ),
  });

  return Object.freeze({
    scoreVersion:
      root.score_version === undefined
        ? defaults.scoreVersion
        : parseString(
            root.score_version,
            "resolution.score_version",
            /^[0-9]+\.[0-9]+\.[0-9]+$/,
          ),
    weights: parseWeights(root.weights, defaults.weights),
    thresholds,
    buffer,
    hardFlags,
    p5050,
    lockup,
    priors,
    uma,
    cadence,
    graph,
    onchain,
  });
}

export interface LoadResolutionConfigOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readTextFile?: (path: string) => Promise<string>;
}

/** Load the module config; with no file configured the defaults are used. */
export async function loadResolutionConfig(
  options: LoadResolutionConfigOptions = {},
): Promise<ResolutionConfig> {
  const env = options.env ?? process.env;
  const path = env[RESOLUTION_CONFIG_FILE_ENV];
  if (path === undefined || path === "") {
    return DEFAULT_RESOLUTION_CONFIG;
  }
  const readTextFile =
    options.readTextFile ?? ((file: string) => readFile(file, "utf8"));
  let text: string;
  try {
    text = await readTextFile(path);
  } catch {
    throw new ResolutionConfigError(
      "RESOLUTION_CONFIG_FILE_UNREADABLE",
      "configured resolution config file could not be read",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ResolutionConfigError(
      "RESOLUTION_CONFIG_FILE_INVALID_JSON",
      "resolution config file is not valid JSON",
    );
  }
  return parseResolutionConfig(parsed);
}

/** Recursively sort object keys so the hash is independent of key order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Hash of everything that changes what a score MEANS: weights, thresholds,
 * buffer/p5050/lockup parameters, priors and UMA baselines. Cadences and
 * onchain plumbing are excluded on purpose — they change when the score runs,
 * never what it computes. Together with the lexicon hash this pins a
 * score_version row; the runner refuses to reuse a version name whose stored
 * hashes differ (reproducibility of every historical paper decision).
 */
export function scoreConfigHash(config: ResolutionConfig): string {
  const material = canonicalize({
    score_version: config.scoreVersion,
    weights: config.weights,
    thresholds: config.thresholds,
    buffer: config.buffer,
    hard_flags: config.hardFlags,
    p5050: config.p5050,
    lockup: config.lockup,
    priors: config.priors,
    uma: config.uma,
  });
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}
