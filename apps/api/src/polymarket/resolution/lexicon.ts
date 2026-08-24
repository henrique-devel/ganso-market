// RFC-012 rule-precision lexicon. Deterministic, lexicon-based scoring of how
// precisely a market's rule text pins down its resolution — no ML, no LLM.
// Rationale: ~43% of UMA disputes trace back to ambiguous wording; objective
// single-source rules (a price feed) dispute at ~0.6% while "consensus of
// credible reporting" style rules dispute at 3-5%. The vocabulary itself is
// versioned configuration (its own JSON file, own env var), never hardcode;
// the parser fails closed on unknown keys and out-of-range values, exactly
// like the fundamental config parser.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const RESOLUTION_LEXICON_FILE_ENV = "GANSO_RESOLUTION_LEXICON_FILE";

export class ResolutionLexiconError extends Error {
  public readonly reasonCode: string;

  public constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "ResolutionLexiconError";
    this.reasonCode = reasonCode;
  }
}

export interface LexiconComponentWeights {
  readonly source: number;
  readonly conditions: number;
  readonly disclosure: number;
  readonly byDate: number;
  readonly titleMismatch: number;
  readonly fallback: number;
}

export interface ResolutionLexicon {
  readonly schemaVersion: 1;
  readonly subjectiveTerms: readonly string[];
  readonly objectiveSingleTerms: readonly string[];
  readonly objectiveMultipleTerms: readonly string[];
  readonly conditionTerms: readonly string[];
  readonly disclosureTerms: readonly string[];
  readonly fallbackClauseTerms: readonly string[];
  /** Regex sources, compiled case-insensitively against normalized text. */
  readonly byDatePatterns: readonly string[];
  readonly componentWeights: LexiconComponentWeights;
  /** Condition-count normalizer: risk saturates at this many conditions. */
  readonly conditionsCap: number;
}

export const DEFAULT_RESOLUTION_LEXICON: ResolutionLexicon = Object.freeze({
  schemaVersion: 1 as const,
  subjectiveTerms: Object.freeze([
    "credible reporting",
    "consensus of reporting",
    "consensus",
    "significant",
    "officially",
    "agrees to",
    "widely reported",
    "credible sources",
    "reputable",
    "substantial",
    "generally accepted",
    "in the judgment",
    "at the discretion",
    "commonly understood",
  ]),
  objectiveSingleTerms: Object.freeze([
    "chainlink",
    "twap",
    "price feed",
    "resolution source is the",
    "coinbase",
    "binance",
    "bls.gov",
    "bureau of labor statistics",
    "federal reserve",
    "on-chain data",
    "onchain data",
    "official settlement price",
    "closing price",
    "the fed's target rate",
    "cme",
  ]),
  objectiveMultipleTerms: Object.freeze([
    "any of the following sources",
    "either source",
    "official website or",
    "or any other official",
    "multiple sources",
  ]),
  conditionTerms: Object.freeze([
    "unless",
    "except",
    "provided that",
    "however",
    "in the event that",
    "if and only if",
    "notwithstanding",
    "subject to",
    "as long as",
    "but not",
  ]),
  disclosureTerms: Object.freeze([
    "8-k",
    "10-q",
    "10-k",
    "press release",
    "publicly announce",
    "publicly disclose",
    "publicly confirm",
    "is announced",
    "is disclosed",
    "is reported",
    "according to a filing",
    "sec filing",
    "official announcement",
  ]),
  fallbackClauseTerms: Object.freeze([
    "cannot be determined",
    "will resolve to no",
    "resolve 50/50",
    "resolve 50-50",
    "otherwise resolve",
    "unable to be determined",
    "not able to determine",
  ]),
  byDatePatterns: Object.freeze([
    "\\bby\\s+(january|february|march|april|may|june|july|august|september|october|november|december)\\b",
    "\\bby\\s+(the\\s+end\\s+of\\s+)?(q[1-4]|\\d{4})\\b",
    "\\bby\\s+\\d{1,2}[\\/\\-]",
    "\\bbefore\\s+(january|february|march|april|may|june|july|august|september|october|november|december|\\d{4})\\b",
    "\\breach(es)?\\b",
    "\\bdip(s)?\\s+to\\b",
    "\\bhit(s)?\\b",
    "\\bat\\s+any\\s+point\\b",
  ]),
  componentWeights: Object.freeze({
    source: 0.35,
    conditions: 0.15,
    disclosure: 0.15,
    byDate: 0.1,
    titleMismatch: 0.15,
    fallback: 0.1,
  }),
  conditionsCap: 4,
});

type JsonObject = Record<string, unknown>;

function requireObject(value: unknown, field: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ResolutionLexiconError(
      "RESOLUTION_LEXICON_FIELD_INVALID",
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
    throw new ResolutionLexiconError(
      "RESOLUTION_LEXICON_FIELD_UNKNOWN",
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
    throw new ResolutionLexiconError(
      "RESOLUTION_LEXICON_FIELD_INVALID",
      `${field} must be a finite number`,
    );
  }
  if (value < minimum || value > maximum) {
    throw new ResolutionLexiconError(
      "RESOLUTION_LEXICON_FIELD_INVALID",
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
    throw new ResolutionLexiconError(
      "RESOLUTION_LEXICON_FIELD_INVALID",
      `${field} must be an integer`,
    );
  }
  return parsed;
}

/**
 * Terms are matched against lowercase normalized text; a mixed-case term could
 * never match, so a document that ships one is a silent bug — refuse it.
 */
function parseTermArray(
  value: unknown,
  field: string,
  fallback: readonly string[],
): readonly string[] {
  if (value === undefined) {
    return fallback;
  }
  if (!Array.isArray(value)) {
    throw new ResolutionLexiconError(
      "RESOLUTION_LEXICON_FIELD_INVALID",
      `${field} must be an array of strings`,
    );
  }
  const terms = value.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new ResolutionLexiconError(
        "RESOLUTION_LEXICON_FIELD_INVALID",
        `${field}[${index}] must be a non-empty string`,
      );
    }
    if (item !== item.toLowerCase()) {
      throw new ResolutionLexiconError(
        "RESOLUTION_LEXICON_FIELD_INVALID",
        `${field}[${index}] must be lowercase`,
      );
    }
    return item;
  });
  return Object.freeze(terms);
}

/** Every pattern must compile; an invalid regex fails the whole document. */
function parsePatternArray(
  value: unknown,
  field: string,
  fallback: readonly string[],
): readonly string[] {
  const patterns = parseTermArray(value, field, fallback);
  for (const [index, source] of patterns.entries()) {
    try {
      new RegExp(source, "i");
    } catch {
      throw new ResolutionLexiconError(
        "RESOLUTION_LEXICON_FIELD_INVALID",
        `${field}[${index}] is not a valid regular expression`,
      );
    }
  }
  return patterns;
}

/** Parse an override document on top of the built-in defaults. */
export function parseResolutionLexicon(raw: unknown): ResolutionLexicon {
  const root = requireObject(raw, "resolution_lexicon");
  rejectUnknownKeys(
    root,
    [
      "schema_version",
      "subjective_terms",
      "objective_single_terms",
      "objective_multiple_terms",
      "condition_terms",
      "disclosure_terms",
      "fallback_clause_terms",
      "by_date_patterns",
      "component_weights",
      "conditions_cap",
    ],
    "resolution_lexicon",
  );

  if (root.schema_version !== undefined) {
    const schemaVersion = parseInteger(
      root.schema_version,
      "resolution_lexicon.schema_version",
      1,
      1_000_000,
    );
    if (schemaVersion !== 1) {
      throw new ResolutionLexiconError(
        "RESOLUTION_LEXICON_SCHEMA_UNSUPPORTED",
        "schema_version is unsupported",
      );
    }
  }

  const defaults = DEFAULT_RESOLUTION_LEXICON;
  const weightsRaw =
    root.component_weights === undefined
      ? {}
      : requireObject(
          root.component_weights,
          "resolution_lexicon.component_weights",
        );
  rejectUnknownKeys(
    weightsRaw,
    [
      "source",
      "conditions",
      "disclosure",
      "by_date",
      "title_mismatch",
      "fallback",
    ],
    "resolution_lexicon.component_weights",
  );
  const parseWeight = (
    value: unknown,
    key: string,
    fallback: number,
  ): number =>
    value === undefined
      ? fallback
      : parseNumber(value, `resolution_lexicon.component_weights.${key}`, 0, 1);
  const componentWeights: LexiconComponentWeights = Object.freeze({
    source: parseWeight(
      weightsRaw.source,
      "source",
      defaults.componentWeights.source,
    ),
    conditions: parseWeight(
      weightsRaw.conditions,
      "conditions",
      defaults.componentWeights.conditions,
    ),
    disclosure: parseWeight(
      weightsRaw.disclosure,
      "disclosure",
      defaults.componentWeights.disclosure,
    ),
    byDate: parseWeight(
      weightsRaw.by_date,
      "by_date",
      defaults.componentWeights.byDate,
    ),
    titleMismatch: parseWeight(
      weightsRaw.title_mismatch,
      "title_mismatch",
      defaults.componentWeights.titleMismatch,
    ),
    fallback: parseWeight(
      weightsRaw.fallback,
      "fallback",
      defaults.componentWeights.fallback,
    ),
  });
  // Weights form a convex combination: a document whose weights do not sum to
  // one would silently rescale every precision score, so it is refused.
  const weightSum =
    componentWeights.source +
    componentWeights.conditions +
    componentWeights.disclosure +
    componentWeights.byDate +
    componentWeights.titleMismatch +
    componentWeights.fallback;
  if (Math.abs(weightSum - 1) > 1e-9) {
    throw new ResolutionLexiconError(
      "RESOLUTION_LEXICON_FIELD_INVALID",
      "component_weights must sum to 1",
    );
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    subjectiveTerms: parseTermArray(
      root.subjective_terms,
      "resolution_lexicon.subjective_terms",
      defaults.subjectiveTerms,
    ),
    objectiveSingleTerms: parseTermArray(
      root.objective_single_terms,
      "resolution_lexicon.objective_single_terms",
      defaults.objectiveSingleTerms,
    ),
    objectiveMultipleTerms: parseTermArray(
      root.objective_multiple_terms,
      "resolution_lexicon.objective_multiple_terms",
      defaults.objectiveMultipleTerms,
    ),
    conditionTerms: parseTermArray(
      root.condition_terms,
      "resolution_lexicon.condition_terms",
      defaults.conditionTerms,
    ),
    disclosureTerms: parseTermArray(
      root.disclosure_terms,
      "resolution_lexicon.disclosure_terms",
      defaults.disclosureTerms,
    ),
    fallbackClauseTerms: parseTermArray(
      root.fallback_clause_terms,
      "resolution_lexicon.fallback_clause_terms",
      defaults.fallbackClauseTerms,
    ),
    byDatePatterns: parsePatternArray(
      root.by_date_patterns,
      "resolution_lexicon.by_date_patterns",
      defaults.byDatePatterns,
    ),
    componentWeights,
    conditionsCap:
      root.conditions_cap === undefined
        ? defaults.conditionsCap
        : parseInteger(
            root.conditions_cap,
            "resolution_lexicon.conditions_cap",
            1,
            1_000,
          ),
  });
}

/** Load the lexicon; with no file configured the defaults are used. */
export async function loadResolutionLexicon(
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    readTextFile?: (path: string) => Promise<string>;
  } = {},
): Promise<ResolutionLexicon> {
  const env = options.env ?? process.env;
  const path = env[RESOLUTION_LEXICON_FILE_ENV];
  if (path === undefined || path === "") {
    return DEFAULT_RESOLUTION_LEXICON;
  }
  const readTextFile =
    options.readTextFile ?? ((file: string) => readFile(file, "utf8"));
  let text: string;
  try {
    text = await readTextFile(path);
  } catch {
    throw new ResolutionLexiconError(
      "RESOLUTION_LEXICON_FILE_UNREADABLE",
      "configured resolution lexicon file could not be read",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ResolutionLexiconError(
      "RESOLUTION_LEXICON_FILE_INVALID_JSON",
      "resolution lexicon file is not valid JSON",
    );
  }
  return parseResolutionLexicon(parsed);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep((value as JsonObject)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Content hash of a lexicon, for stamping scores with the vocabulary version
 * that produced them. Keys are sorted recursively before serialization so the
 * hash depends only on content, never on key insertion order.
 */
export function lexiconHash(lexicon: ResolutionLexicon): string {
  return createHash("sha256")
    .update(JSON.stringify(sortKeysDeep(lexicon)))
    .digest("hex");
}

export interface RulePrecisionResult {
  /** "0.000000".."1.000000", six fraction digits; 1 = objective and precise. */
  readonly precision: string;
  readonly riskComponents: Readonly<Record<string, number>>;
  readonly hardFlags: readonly string[];
  readonly byDateForm: boolean;
  readonly fallbackClause: boolean;
  readonly occurrenceVsDisclosure: boolean;
  readonly conditionsCount: number;
}

/**
 * Normalization makes the score stable under cosmetic edits: lowercase,
 * thousands commas removed from inside digit groups (so $82,500 survives as
 * one threshold), the punctuation , ; : ! ? " ' ( ) [ ] replaced by spaces
 * ($ % . / - and digits are kept), whitespace runs collapsed to one space.
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/(\d),(?=\d)/g, "$1")
    .replace(/[,;:!?"'()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Substring matching with word-ish boundaries: "consensus" must not match
 * inside another word. Lookarounds (not consuming groups) so that adjacent
 * occurrences separated by a single character are all counted.
 */
function termPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<=^|[^a-z])${escaped}(?=[^a-z]|$)`, "g");
}

function hasAnyTerm(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => termPattern(term).test(text));
}

function countTerms(text: string, terms: readonly string[]): number {
  let count = 0;
  for (const term of terms) {
    count += [...text.matchAll(termPattern(term))].length;
  }
  return count;
}

/**
 * Numeric thresholds extracted from RAW text: "$82,500", "82500", "$1.25",
 * "100k"/"1m" (suffixes expanded x1e3/x1e6). Thousands commas are removed
 * first so both spellings of a threshold compare equal.
 */
function extractNumbers(raw: string): Set<number> {
  const stripped = raw.replace(/(\d),(?=\d)/g, "$1");
  const values = new Set<number>();
  for (const match of stripped.matchAll(
    /(?<![a-z0-9.])(\d+(?:\.\d+)?)([km])?(?![a-z0-9])/gi,
  )) {
    const digits = match[1];
    if (digits === undefined) {
      continue;
    }
    const base = Number.parseFloat(digits);
    const suffix = match[2]?.toLowerCase();
    values.add(
      suffix === "k" ? base * 1e3 : suffix === "m" ? base * 1e6 : base,
    );
  }
  return values;
}

/** Calendar years only (19xx/20xx), so prices are not mistaken for years. */
function extractYears(raw: string): Set<number> {
  const stripped = raw.replace(/(\d),(?=\d)/g, "$1");
  const years = new Set<number>();
  for (const match of stripped.matchAll(/\b(?:19|20)\d{2}\b/g)) {
    years.add(Number.parseInt(match[0], 10));
  }
  return years;
}

const MONTH_INDEX: Readonly<Record<string, number>> = Object.freeze({
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
});

const MONTH_PATTERN =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/gi;

function extractMonths(raw: string): Set<number> {
  const months = new Set<number>();
  for (const match of raw.matchAll(MONTH_PATTERN)) {
    const index = MONTH_INDEX[match[0].toLowerCase()];
    if (index !== undefined) {
      months.add(index);
    }
  }
  return months;
}

/** A kind only mismatches when BOTH sides name it and they share no value. */
function disjoint(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size === 0 || b.size === 0) {
    return false;
  }
  for (const value of a) {
    if (b.has(value)) {
      return false;
    }
  }
  return true;
}

/**
 * Deterministic rule-precision score. Floats are used internally; the only
 * score that leaves is `precision`, a canonical 6-fraction-digit string.
 */
export function scoreRulePrecision(
  input: {
    question: string;
    description: string;
    resolutionSource: string | null;
  },
  lexicon: ResolutionLexicon,
): RulePrecisionResult {
  const question = normalizeText(input.question);
  const description = normalizeText(input.description);
  const sourceText = normalizeText(
    `${input.description} ${input.resolutionSource ?? ""}`,
  );

  const hardFlags: string[] = [];

  // Source risk: a subjective vocabulary dominates everything (the 3-5%
  // dispute bucket); a single objective source is the 0.6% bucket; multiple
  // acceptable sources sit in between; naming no source at all is itself risk.
  let sourceRisk: number;
  if (hasAnyTerm(sourceText, lexicon.subjectiveTerms)) {
    sourceRisk = 1;
    hardFlags.push("SUBJECTIVE_SOURCE");
  } else if (hasAnyTerm(sourceText, lexicon.objectiveSingleTerms)) {
    sourceRisk = 0;
  } else if (hasAnyTerm(sourceText, lexicon.objectiveMultipleTerms)) {
    sourceRisk = 0.35;
  } else {
    sourceRisk = 0.6;
  }

  // Conditions risk: every carve-out is a branch a disputant can argue about;
  // risk saturates once the count reaches the configured cap.
  const conditionsCount = countTerms(description, lexicon.conditionTerms);
  const conditionsRisk = Math.min(conditionsCount / lexicon.conditionsCap, 1);

  // Disclosure risk (the Strategy/BTC pattern): the event happened in May but
  // the 8-K was filed in June — payoff hinges on the DISCLOSURE, not the
  // occurrence, so any disclosure-gated wording is full component risk.
  const occurrenceVsDisclosure = hasAnyTerm(
    description,
    lexicon.disclosureTerms,
  );
  const disclosureRisk = occurrenceVsDisclosure ? 1 : 0;

  // By-date risk: "by <date>" / "reaches" forms are P4/early-resolution
  // eligible — the market can resolve the moment the threshold prints.
  const byDateForm = lexicon.byDatePatterns.some((source) => {
    const pattern = new RegExp(source, "i");
    return pattern.test(question) || pattern.test(description);
  });
  const byDateRisk = byDateForm ? 0.5 : 0;

  // Title-mismatch risk: numbers, months and years are extracted from the RAW
  // title and rule text; any kind present on both sides with no common value
  // means the title promises one market and the rules settle another.
  const mismatch =
    disjoint(
      extractNumbers(input.question),
      extractNumbers(input.description),
    ) ||
    disjoint(extractMonths(input.question), extractMonths(input.description)) ||
    disjoint(extractYears(input.question), extractYears(input.description));
  if (mismatch) {
    hardFlags.push("TITLE_RULE_MISMATCH");
  }
  const titleMismatchRisk = mismatch ? 1 : 0;

  // Fallback risk: an explicit "otherwise resolve ..." clause is a second
  // outcome path baked into the rules.
  const fallbackClause = hasAnyTerm(description, lexicon.fallbackClauseTerms);
  const fallbackRisk = fallbackClause ? 0.7 : 0;

  const weights = lexicon.componentWeights;
  const totalRisk =
    weights.source * sourceRisk +
    weights.conditions * conditionsRisk +
    weights.disclosure * disclosureRisk +
    weights.byDate * byDateRisk +
    weights.titleMismatch * titleMismatchRisk +
    weights.fallback * fallbackRisk;
  const clamped = Math.min(Math.max(1 - totalRisk, 0), 1);
  const precision = (Math.round(clamped * 1e6) / 1e6).toFixed(6);

  return Object.freeze({
    precision,
    riskComponents: Object.freeze({
      source: sourceRisk,
      conditions: conditionsRisk,
      disclosure: disclosureRisk,
      by_date: byDateRisk,
      title_mismatch: titleMismatchRisk,
      fallback: fallbackRisk,
    }),
    hardFlags: Object.freeze(hardFlags),
    byDateForm,
    fallbackClause,
    occurrenceVsDisclosure,
    conditionsCount,
  });
}
