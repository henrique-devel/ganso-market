// RFC-013 task 4: the market -> economic factor map, and the correlation
// treatment that follows from it.
//
// Two markets on the same factor are ONE bet. "Will BTC be above $100k on
// Friday" and "Will BTC be above $95k on Friday" are not two independent 5%
// positions; they are one position on the price of BTC, and sizing them
// separately is how a portfolio discovers its real concentration only after the
// factor moves.
//
// The map is versioned for the same reason the config is: changing which
// markets share a factor changes what "one bet" means, so a decision records
// the map version that produced it.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { SCALE } from "../fundamental/fixed.js";

export const FACTOR_MAP_FILE_ENV = "GANSO_PORTFOLIO_FACTOR_MAP_FILE";

export class FactorMapError extends Error {
  public readonly reasonCode: string;

  public constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "FactorMapError";
    this.reasonCode = reasonCode;
  }
}

export interface FactorRule {
  /** Stable factor id, e.g. "btc_price" or "fed_rate_decision". */
  readonly factor: string;
  /** Category this rule applies to; null matches any category. */
  readonly category: string | null;
  /**
   * Case-insensitive patterns matched against the market question. All of
   * `allOf` must appear; any of `anyOf` suffices when present.
   */
  readonly allOf: readonly string[];
  readonly anyOf: readonly string[];
  /**
   * Correlation multiplier applied to the size of a market on this factor when
   * the factor already carries exposure, in [0, 1]. 1 means "no reduction",
   * which is only ever right for a factor nothing else touches.
   */
  readonly correlationMultiplier: number;
}

export interface FactorMap {
  readonly version: string;
  readonly rules: readonly FactorRule[];
  /**
   * Multiplier for a market whose factor could not be identified. Deliberately
   * conservative: an unknown factor is treated as potentially correlated with
   * everything, not as independent.
   */
  readonly unknownFactorMultiplier: number;
  /**
   * Multiplier for markets that share a negRisk event. The adapter makes them
   * mutually exclusive, so the group's worst case is one leg — but the RFC
   * still sizes the group as a single bet.
   */
  readonly negRiskMultiplier: number;
}

/**
 * Starting map for the two categories the RFC-010 models cover. Deliberately
 * small: a wrong factor grouping is worse than an unknown one, because an
 * unknown one is treated conservatively while a wrong one splits a single bet
 * into two.
 */
export const DEFAULT_FACTOR_MAP: FactorMap = Object.freeze({
  version: "1.0.0",
  unknownFactorMultiplier: 0.5,
  negRiskMultiplier: 0.5,
  rules: Object.freeze([
    Object.freeze({
      factor: "btc_price",
      category: "crypto",
      allOf: Object.freeze([] as string[]),
      anyOf: Object.freeze(["bitcoin", "btc"]),
      correlationMultiplier: 0.35,
    }),
    Object.freeze({
      factor: "eth_price",
      category: "crypto",
      allOf: Object.freeze([] as string[]),
      anyOf: Object.freeze(["ethereum", "eth"]),
      correlationMultiplier: 0.35,
    }),
    Object.freeze({
      factor: "sol_price",
      category: "crypto",
      allOf: Object.freeze([] as string[]),
      anyOf: Object.freeze(["solana", "sol"]),
      correlationMultiplier: 0.35,
    }),
    Object.freeze({
      factor: "fed_rate_decision",
      category: null,
      allOf: Object.freeze([] as string[]),
      anyOf: Object.freeze(["fed", "fomc", "interest rate"]),
      correlationMultiplier: 0.3,
    }),
    Object.freeze({
      factor: "us_cpi",
      category: null,
      allOf: Object.freeze([] as string[]),
      anyOf: Object.freeze(["cpi", "inflation"]),
      correlationMultiplier: 0.3,
    }),
    Object.freeze({
      factor: "us_jobs",
      category: null,
      allOf: Object.freeze([] as string[]),
      anyOf: Object.freeze(["nonfarm", "unemployment", "jobs report"]),
      correlationMultiplier: 0.3,
    }),
  ] as FactorRule[]),
});

export interface FactorAssignment {
  readonly factor: string;
  readonly multiplierScaled: bigint;
  readonly matchedBy: "rule" | "negrisk" | "unknown";
}

function toScaled(value: number): bigint {
  return BigInt(Math.round(value * Number(SCALE)));
}

/**
 * Resolve a market to its factor. A negRisk event is itself a factor: its legs
 * are mutually exclusive by construction, so they belong together whatever the
 * question text says.
 */
export function assignFactor(
  map: FactorMap,
  market: {
    readonly conditionId: string;
    readonly question: string;
    readonly category: string | null;
    readonly negRisk: boolean;
    readonly eventId: string | null;
  },
): FactorAssignment {
  const question = market.question.toLowerCase();
  for (const rule of map.rules) {
    if (rule.category !== null && rule.category !== market.category) {
      continue;
    }
    const allMatched = rule.allOf.every((needle) =>
      question.includes(needle.toLowerCase()),
    );
    if (!allMatched) {
      continue;
    }
    const anyMatched =
      rule.anyOf.length === 0 ||
      rule.anyOf.some((needle) => question.includes(needle.toLowerCase()));
    if (!anyMatched) {
      continue;
    }
    return {
      factor: rule.factor,
      multiplierScaled: toScaled(rule.correlationMultiplier),
      matchedBy: "rule",
    };
  }
  if (market.negRisk && market.eventId !== null) {
    return {
      factor: `negrisk:${market.eventId}`,
      multiplierScaled: toScaled(map.negRiskMultiplier),
      matchedBy: "negrisk",
    };
  }
  // Unknown is NOT independent. Treating it as independent is how an
  // unrecognised theme quietly becomes the largest bet in the book.
  return {
    factor: `unknown:${market.conditionId}`,
    multiplierScaled: toScaled(map.unknownFactorMultiplier),
    matchedBy: "unknown",
  };
}

/**
 * The 24h catalyst window a market's resolution falls into. Markets resolving
 * in the same window share a catalyst cap: one Fed decision settling a dozen
 * markets is temporal concentration even when the factors differ.
 */
export function catalystWindow(endDate: Date | null): string {
  if (endDate === null || !Number.isFinite(endDate.getTime())) {
    return "unknown";
  }
  return endDate.toISOString().slice(0, 10);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FactorMapError(
      "FACTOR_MAP_INVALID",
      `${where} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, where: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    !value.every((item): item is string => typeof item === "string")
  ) {
    throw new FactorMapError(
      "FACTOR_MAP_INVALID",
      `${where} must be an array of strings`,
    );
  }
  return [...value];
}

function fraction(value: unknown, fallback: number, where: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FactorMapError(
      "FACTOR_MAP_INVALID",
      `${where} must be a finite number`,
    );
  }
  if (value < 0 || value > 1) {
    throw new FactorMapError(
      "FACTOR_MAP_OUT_OF_RANGE",
      `${where} must be within [0, 1]`,
    );
  }
  return value;
}

export function parseFactorMap(raw: unknown): FactorMap {
  const top = record(raw, "factorMap");
  for (const key of Object.keys(top)) {
    if (
      ![
        "version",
        "rules",
        "unknownFactorMultiplier",
        "negRiskMultiplier",
      ].includes(key)
    ) {
      throw new FactorMapError(
        "FACTOR_MAP_UNKNOWN_KEY",
        `factorMap.${key} is not a known key`,
      );
    }
  }
  const version = top.version ?? DEFAULT_FACTOR_MAP.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new FactorMapError(
      "FACTOR_MAP_INVALID",
      "factorMap.version must be a non-empty string",
    );
  }
  const rawRules = top.rules;
  if (rawRules !== undefined && !Array.isArray(rawRules)) {
    throw new FactorMapError(
      "FACTOR_MAP_INVALID",
      "factorMap.rules must be an array",
    );
  }
  const rules = ((rawRules ?? DEFAULT_FACTOR_MAP.rules) as unknown[]).map(
    (item, index) => {
      const ruleRaw = record(item, `factorMap.rules[${String(index)}]`);
      const factor = ruleRaw.factor;
      if (typeof factor !== "string" || factor.length === 0) {
        throw new FactorMapError(
          "FACTOR_MAP_INVALID",
          `factorMap.rules[${String(index)}].factor must be a non-empty string`,
        );
      }
      const category = ruleRaw.category;
      if (
        category !== undefined &&
        category !== null &&
        typeof category !== "string"
      ) {
        throw new FactorMapError(
          "FACTOR_MAP_INVALID",
          `factorMap.rules[${String(index)}].category must be a string or null`,
        );
      }
      const allOf = stringArray(
        ruleRaw.allOf,
        `factorMap.rules[${String(index)}].allOf`,
      );
      const anyOf = stringArray(
        ruleRaw.anyOf,
        `factorMap.rules[${String(index)}].anyOf`,
      );
      if (allOf.length === 0 && anyOf.length === 0) {
        throw new FactorMapError(
          "FACTOR_MAP_INVALID",
          `factorMap.rules[${String(index)}] must have at least one pattern`,
        );
      }
      return Object.freeze({
        factor,
        category: (category ?? null) as string | null,
        allOf: Object.freeze(allOf),
        anyOf: Object.freeze(anyOf),
        correlationMultiplier: fraction(
          ruleRaw.correlationMultiplier,
          0.35,
          `factorMap.rules[${String(index)}].correlationMultiplier`,
        ),
      });
    },
  );

  return Object.freeze({
    version,
    rules: Object.freeze(rules),
    unknownFactorMultiplier: fraction(
      top.unknownFactorMultiplier,
      DEFAULT_FACTOR_MAP.unknownFactorMultiplier,
      "factorMap.unknownFactorMultiplier",
    ),
    negRiskMultiplier: fraction(
      top.negRiskMultiplier,
      DEFAULT_FACTOR_MAP.negRiskMultiplier,
      "factorMap.negRiskMultiplier",
    ),
  });
}

export interface LoadFactorMapOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readTextFile?: (path: string) => Promise<string>;
}

export async function loadFactorMap(
  options: LoadFactorMapOptions = {},
): Promise<FactorMap> {
  const env = options.env ?? process.env;
  const path = env[FACTOR_MAP_FILE_ENV];
  if (path === undefined || path === "") {
    return DEFAULT_FACTOR_MAP;
  }
  const readTextFile =
    options.readTextFile ?? ((file: string) => readFile(file, "utf8"));
  let text: string;
  try {
    text = await readTextFile(path);
  } catch {
    throw new FactorMapError(
      "FACTOR_MAP_FILE_UNREADABLE",
      "configured factor map file could not be read",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new FactorMapError(
      "FACTOR_MAP_FILE_INVALID_JSON",
      "factor map file is not valid JSON",
    );
  }
  return parseFactorMap(parsed);
}

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

export function factorMapHash(map: FactorMap): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(map)))
    .digest("hex");
}
