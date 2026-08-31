// RFC-010 task 6: the `macro_scheduled` category model (CPI / payrolls /
// unemployment / Fed target rate) and the deterministic parser of the
// VERSIONED rule text that decides which markets the model is allowed to see.
//
// This module is PURE: no database, no clock, no fetch, no randomness. The
// same (spec, calendar, release, hyperparams) always produces the same doubles
// and therefore the same stored bytes after quantization.
//
// Two things it deliberately does NOT do:
//
//   - it never reads a resolution field (`closedTime`, UMA status). The
//     official release value is a PUBLICATION, not a resolution: it is routed
//     through `AsOfGuard.record` with the publisher's own instant, so the
//     anti-leakage test proves it could not postdate the decision;
//   - it never invents an input. A market whose rule does not parse
//     unambiguously, or whose calendar entry carries no consensus, is excluded
//     and stays on the market baseline. Fabricating a consensus to keep
//     coverage up would be fabricating alpha.
//
// Two regimes, versioned and reported separately so the walk-forward pipeline
// can stratify on them (`dataRefs.macroRegime`):
//
//   pre_release  — q = P(X compared-to threshold) under a normal centred on
//                  the published consensus/nowcast;
//   post_release — inside a configurable window after the OFFICIAL publication
//                  instant, the outcome is already knowable, and the model
//                  blends it with the pre-release probability using the
//                  ~0.64-per-1 under-reaction coefficient. That coefficient is
//                  an explicit HYPOTHESIS with academic support, never an
//                  assumed edge; the gate validates it on its own stratum, and
//                  a failing stratum simply drops the market to the baseline.

import {
  DEFAULT_FUNDAMENTAL_CONFIG,
  type FundamentalConfig,
} from "../config.js";
import type {
  AsOfGuard,
  MacroCalendarContext,
  MacroReleaseContext,
  MarketContext,
} from "../features.js";
import { normalCdf } from "../stats.js";
import type { DataRefs, ModelResult } from "../types.js";

export const MACRO_MODEL_FAMILY = "macro_scheduled_consensus";
export const MACRO_MODEL_VERSION = "1.0.0";

/**
 * Version of THIS model's feature definitions (consensus/dispersion keys,
 * calendar matching, regime boundary). Bump it whenever any of them changes,
 * independently of the shared as-of feature layer's own version.
 */
export const MACRO_FEATURE_SET_VERSION: string = "1.1.0";

/** Official variables the parser is allowed to recognise. */
export type MacroVariable =
  | "cpi_yoy"
  | "cpi_mom"
  | "core_cpi_yoy"
  | "nonfarm_payrolls"
  | "unemployment_rate"
  | "fed_target_rate";

/**
 * What one macro market asks, once its versioned rule has been parsed without
 * ambiguity. `threshold` is a statistical quantity (a percentage point or a
 * job count), never money or a price, so it is a double like the rest of the
 * model internals.
 */
export interface MacroMarketSpec {
  readonly variable: MacroVariable;
  readonly comparison: "gt" | "gte" | "lt" | "lte";
  readonly threshold: number;
  readonly source: "bls" | "bea" | "fomc";
  /** Matched calendar entry, when found. */
  readonly eventKey: string | null;
  /** Scheduled release instant of the matched entry. */
  readonly releaseAt: Date | null;
}

export type MacroParseFailure =
  | "UNRECOGNIZED_VARIABLE"
  | "NO_THRESHOLD"
  | "AMBIGUOUS_THRESHOLD"
  | "NO_COMPARISON"
  | "NO_SOURCE"
  | "NO_CALENDAR_MATCH";

export type MacroParseResult =
  | { readonly ok: true; readonly spec: MacroMarketSpec }
  | { readonly ok: false; readonly reason: MacroParseFailure };

// ---------------------------------------------------------------------------
// Model constants
// ---------------------------------------------------------------------------

/**
 * Floor of the reported dispersion. A model that claims zero uncertainty would
 * collapse the 90% interval onto the structural spread floor and hide its own
 * error; RFC-010 requires the interval to never be narrower than the market's
 * executable spread, not to pretend the model is exact.
 */
const MACRO_MIN_SIGMA = 0.005;

/**
 * ASSUMPTION (versioned with MACRO_FEATURE_SET_VERSION): a published consensus
 * is the mean of a forecaster panel, so the uncertainty about its LOCATION is
 * smaller than the dispersion of the panel by sqrt(N). RFC-007 does not record
 * a panel size, so we fix an equivalent panel of 16, i.e. a location bump of
 * sigma/4. The consequence is observable: the daily report measures whether
 * the resulting 90% interval really covers the outcome ~90% of the time.
 */
const MACRO_CONSENSUS_PANEL_EQUIVALENT = 16;

/**
 * Unit-mismatch guard for the post-release regime. The official value and the
 * market threshold must live on the same scale; when the recorded release sits
 * further than this many dispersions from the consensus, we do not understand
 * the number and abstain instead of serving a poisoned q.
 */
const MACRO_RELEASE_MAX_SIGMAS = 10;

/** Probability bounds, mirroring MIN_PROB_SCALED / MAX_PROB_SCALED in fixed.ts. */
const MACRO_MIN_Q = 0.001;
const MACRO_MAX_Q = 0.999;

/**
 * Macro order books are documented as thin. q stays a pure probability, but
 * the consumer must know the executable price diverges from the mid, so this
 * model's own view of `thinBook` is always true (RFC-010 task 6).
 */
const MACRO_BOOK_IS_THIN: boolean = true;

function logLine(
  level: "info" | "warn" | "error",
  reasonCode: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  process.stderr.write(
    `${JSON.stringify({
      level,
      service: "polymarket-fundamental",
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      message,
      ...extra,
    })}\n`,
  );
}

// ---------------------------------------------------------------------------
// Deterministic rule parser
// ---------------------------------------------------------------------------

const MONTH_NAMES: Readonly<Record<string, number>> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const MONTH_ALTERNATION = Object.keys(MONTH_NAMES).join("|");

/**
 * Wording that hands the outcome to someone's judgement. Such a rule does not
 * pin a mechanical threshold at all, so it is reported as AMBIGUOUS_THRESHOLD
 * and the market stays on the baseline. NLP of resolution ambiguity is out of
 * RFC-010's scope; this list is a deliberately blunt, deterministic veto.
 */
const DISCRETION_PHRASES: readonly string[] = [
  "discretion",
  "sole judgment",
  "sole judgement",
  "reasonable judgment",
  "reasonable judgement",
  "at its option",
  "as it deems",
];

/** Rate-change wording: such a market is about a move, not about a level. */
const RATE_CHANGE_PHRASES: readonly string[] = [
  "basis point",
  "basis points",
  "bps",
  "rate cut",
  "rate hike",
  "cut rates",
  "raise rates",
  "hike rates",
];

function maskRun(match: string): string {
  return " ".repeat(match.length);
}

/**
 * Blank out every number that can never be a threshold: URLs (series ids and
 * release-note filenames carry digits), ISO dates, clock times, ordinals,
 * calendar day numbers and years. Masking preserves length, so the remaining
 * text keeps its shape for clause splitting.
 */
function maskNonThresholdNumbers(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, maskRun)
    .replace(/\bwww\.\S+/g, maskRun)
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, maskRun)
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?/g, maskRun)
    .replace(
      // A calendar day, not a threshold. The trailing lookahead keeps
      // "CPI may be above 3.0%" intact: "3.0" is not the third of May.
      new RegExp(
        `\\b(?:${MONTH_ALTERNATION})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?![\\w.%])`,
        "g",
      ),
      maskRun,
    )
    .replace(/\b\d{1,2}(?:st|nd|rd|th)\b/g, maskRun)
    .replace(/\b(?:19|20)\d{2}\b/g, maskRun);
}

interface NumberCandidate {
  readonly value: number;
  readonly percent: boolean;
  readonly scaled: boolean;
}

// A number is only a candidate when it is not glued to letters or to another
// number: `CUSR0000SA0` and `1.2.3` must never yield a threshold.
const NUMBER_PATTERN =
  /(?<![\w.])\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(%|k|thousand|thousands|million|millions|billion|billions)?(?!\w)/g;

const SUFFIX_MULTIPLIERS: Readonly<Record<string, number>> = {
  k: 1_000,
  thousand: 1_000,
  thousands: 1_000,
  million: 1_000_000,
  millions: 1_000_000,
  billion: 1_000_000_000,
  billions: 1_000_000_000,
};

function collectNumbers(masked: string): NumberCandidate[] {
  const candidates: NumberCandidate[] = [];
  for (const match of masked.matchAll(NUMBER_PATTERN)) {
    const digits = match[1];
    if (digits === undefined) {
      continue;
    }
    const grouped = digits.includes(",");
    const base = Number(digits.replace(/,/g, ""));
    if (!Number.isFinite(base)) {
      continue;
    }
    const suffix = match[2];
    const multiplier =
      suffix === undefined || suffix === "%"
        ? 1
        : (SUFFIX_MULTIPLIERS[suffix] ?? 1);
    candidates.push({
      value: base * multiplier,
      percent: suffix === "%",
      scaled: grouped || multiplier > 1,
    });
  }
  return candidates;
}

const RATE_VARIABLES: ReadonlySet<MacroVariable> = new Set<MacroVariable>([
  "cpi_yoy",
  "cpi_mom",
  "core_cpi_yoy",
  "unemployment_rate",
  "fed_target_rate",
]);

/**
 * Keep only the candidates that could be a threshold FOR THIS VARIABLE:
 * a rate is a plain percentage point ("3.2%" => 3.2), a payroll print is a job
 * count that must carry its own magnitude ("250,000", "250k", "250000"). A
 * bare "250" for payrolls is refused: thousands or units cannot be told apart
 * without guessing.
 */
function plausibleThresholds(
  variable: MacroVariable,
  candidates: readonly NumberCandidate[],
): number[] {
  const kept: number[] = [];
  for (const candidate of candidates) {
    if (RATE_VARIABLES.has(variable)) {
      if (!candidate.scaled && candidate.value <= 100) {
        kept.push(candidate.value);
      }
      continue;
    }
    if (!candidate.percent && (candidate.scaled || candidate.value >= 1_000)) {
      kept.push(candidate.value);
    }
  }
  return kept;
}

type MacroComparison = MacroMarketSpec["comparison"];

const GTE_PREFIXES = [
  "greater than or equal to",
  "at or above",
  "at least",
  ">=",
  "≥",
];
const LTE_PREFIXES = [
  "less than or equal to",
  "at or below",
  "at most",
  "<=",
  "≤",
];
const GT_PREFIXES = [
  "greater than",
  "higher than",
  "more than",
  "above",
  "exceeds",
  "exceed",
  "over",
  ">",
];
const LT_PREFIXES = ["less than", "lower than", "below", "under", "<"];

const GTE_SUFFIXES = ["or more", "or higher", "or above", "or greater"];
const LTE_SUFFIXES = ["or less", "or lower", "or below", "or fewer"];

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function alternation(phrases: readonly string[]): string {
  return phrases.map(escapeForRegExp).join("|");
}

/**
 * Comparison detection is positional on purpose. A prefix comparator only
 * counts when a number follows it, and a suffix comparator only when a number
 * precedes it — "the above criteria" and "under the terms of this market" are
 * boilerplate, not comparisons.
 */
function comparisonsIn(clause: string): Set<MacroComparison> {
  // Longest phrase first: "greater than or equal to" must be consumed before
  // it can also be read as a bare "greater than".
  const tokenized = clause
    .replace(/\bnot?\s+less\s+than\b/g, " at least ")
    .replace(/\bnot?\s+lower\s+than\b/g, " at least ")
    .replace(/\bnot?\s+more\s+than\b/g, " at most ")
    .replace(/\bnot?\s+higher\s+than\b/g, " at most ")
    .replace(/\bnot?\s+greater\s+than\b/g, " at most ")
    .replace(new RegExp(alternation(GTE_PREFIXES), "g"), " ~gte~ ")
    .replace(new RegExp(alternation(LTE_PREFIXES), "g"), " ~lte~ ")
    .replace(new RegExp(alternation(GT_PREFIXES), "g"), " ~gt~ ")
    .replace(new RegExp(alternation(LT_PREFIXES), "g"), " ~lt~ ");

  const found = new Set<MacroComparison>();
  const prefixed: ReadonlyArray<readonly [string, MacroComparison]> = [
    ["~gte~", "gte"],
    ["~lte~", "lte"],
    ["~gt~", "gt"],
    ["~lt~", "lt"],
  ];
  for (const [token, comparison] of prefixed) {
    if (new RegExp(`${token}\\s*\\$?\\s*\\d`).test(tokenized)) {
      found.add(comparison);
    }
  }
  const suffixed: ReadonlyArray<readonly [readonly string[], MacroComparison]> =
    [
      [GTE_SUFFIXES, "gte"],
      [LTE_SUFFIXES, "lte"],
    ];
  for (const [phrases, comparison] of suffixed) {
    if (new RegExp(`(?:\\d|%)\\s*(?:${alternation(phrases)})`).test(clause)) {
      found.add(comparison);
    }
  }
  return found;
}

/**
 * Split on sentence punctuation that is not inside a number: "3.0" and
 * "250,000" must survive intact.
 */
function splitClauses(text: string): string[] {
  return text
    .split(/(?<!\d)[.;](?!\d)|\n|,(?!\d)/)
    .filter((part) => part.length > 0);
}

/**
 * The comparison of the YES side. A rule that spells out both sides
 * ("YES if above 3.0%, NO if below 3.0%") is not ambiguous, so the YES clause
 * wins; only when that clause is silent do we fall back to a text that must
 * then carry exactly one comparison.
 */
function detectComparison(masked: string): MacroComparison | null {
  const yesFound = new Set<MacroComparison>();
  for (const clause of splitClauses(masked)) {
    if (!/\byes\b/.test(clause)) {
      continue;
    }
    for (const comparison of comparisonsIn(clause)) {
      yesFound.add(comparison);
    }
  }
  if (yesFound.size === 1) {
    return [...yesFound][0] ?? null;
  }
  const allFound = comparisonsIn(masked);
  return allFound.size === 1 ? ([...allFound][0] ?? null) : null;
}

type MacroFamily = "cpi" | "employment" | "fomc";

function detectVariable(text: string): MacroVariable | null {
  const families = new Set<MacroFamily>();
  const hasCpi = /\bcpi\b/.test(text) || text.includes("consumer price index");
  const hasPayrolls =
    /\bnfp\b/.test(text) ||
    text.includes("nonfarm payroll") ||
    text.includes("non-farm payroll") ||
    text.includes("non farm payroll");
  const hasUnemployment =
    text.includes("unemployment rate") || text.includes("jobless rate");
  const hasFed =
    text.includes("federal funds target") ||
    text.includes("federal funds rate") ||
    text.includes("fed funds rate") ||
    text.includes("fed funds target") ||
    text.includes("fed target rate") ||
    text.includes("target range for the federal funds");

  if (hasCpi) {
    families.add("cpi");
  }
  if (hasPayrolls || hasUnemployment) {
    families.add("employment");
  }
  if (hasFed) {
    families.add("fomc");
  }
  // Two different official variables in one rule: the market is asking
  // something this model cannot express, so it is excluded.
  if (families.size !== 1) {
    return null;
  }
  if (hasPayrolls && hasUnemployment) {
    return null;
  }
  if (hasUnemployment) {
    return "unemployment_rate";
  }
  if (hasPayrolls) {
    return "nonfarm_payrolls";
  }
  if (hasFed) {
    // A market about a CUT or a HIKE is about a change, not about a level;
    // this model only prices levels.
    return RATE_CHANGE_PHRASES.some((phrase) => text.includes(phrase))
      ? null
      : "fed_target_rate";
  }
  const yearOverYear =
    text.includes("year-over-year") ||
    text.includes("year over year") ||
    /\byoy\b/.test(text) ||
    text.includes("12-month") ||
    text.includes("annual rate");
  const monthOverMonth =
    text.includes("month-over-month") ||
    text.includes("month over month") ||
    /\bmom\b/.test(text) ||
    text.includes("monthly rate");
  // Without a stated basis a CPI threshold is unreadable: 3.2 is a plausible
  // year-over-year print and 0.3 a plausible month-over-month one, and we do
  // not guess from the magnitude.
  if (yearOverYear === monthOverMonth) {
    return null;
  }
  const core =
    text.includes("core cpi") || text.includes("core consumer price");
  if (monthOverMonth) {
    // core_cpi_mom is not a variable of this model version.
    return core ? null : "cpi_mom";
  }
  return core ? "core_cpi_yoy" : "cpi_yoy";
}

function variableFamily(variable: MacroVariable): MacroFamily {
  if (variable === "fed_target_rate") {
    return "fomc";
  }
  if (variable === "nonfarm_payrolls" || variable === "unemployment_rate") {
    return "employment";
  }
  return "cpi";
}

/**
 * The official agency, corroborated by the market's own resolution source or
 * rule text. The variable pins the canonical agency (BLS publishes CPI, the
 * payrolls and the unemployment rate; the FOMC sets the target rate), and the
 * text must name it — an unnamed source is NO_SOURCE, never an inference.
 *
 * BEA belongs to the union because RFC-007 records its calendar, but none of
 * this version's variables is a BEA series, so the parser never selects it.
 */
function detectSource(
  variable: MacroVariable,
  context: MarketContext,
  text: string,
): MacroMarketSpec["source"] | null {
  const haystack = `${context.resolutionSource ?? ""} ${text}`.toLowerCase();
  const canonical: MacroMarketSpec["source"] =
    variable === "fed_target_rate" ? "fomc" : "bls";
  const mentionsBls =
    /\bbls\b/.test(haystack) ||
    haystack.includes("bureau of labor statistics") ||
    haystack.includes("bls.gov");
  const mentionsFomc =
    /\bfomc\b/.test(haystack) ||
    haystack.includes("federal open market committee") ||
    haystack.includes("federal reserve") ||
    haystack.includes("federalreserve.gov");
  const mentioned = canonical === "bls" ? mentionsBls : mentionsFomc;
  return mentioned ? canonical : null;
}

interface PeriodReferences {
  /** "YYYY-MM" months the text names ("August 2026", "2026-08"). */
  readonly months: ReadonlySet<string>;
  /** "YYYY-MM-DD" full dates the text names; these are RELEASE days. */
  readonly days: ReadonlySet<string>;
}

/**
 * The periods a market text names. Months and full dates are kept apart on
 * purpose: "August 2026" almost always names the DATA month, while a full date
 * such as 2026-09-11 names the day of the RELEASE. Collapsing both into one
 * set makes a rule that mentions its own release date collide with the next
 * month's entry, which would exclude a perfectly parseable market.
 */
function referencedPeriods(text: string): PeriodReferences {
  const months = new Set<string>();
  const days = new Set<string>();
  const named = new RegExp(
    `\\b(${MONTH_ALTERNATION})\\.?\\s+(?:of\\s+)?((?:19|20)\\d{2})\\b`,
    "g",
  );
  for (const match of text.matchAll(named)) {
    const month = MONTH_NAMES[match[1] ?? ""];
    const year = match[2];
    if (month !== undefined && year !== undefined) {
      months.add(`${year}-${String(month).padStart(2, "0")}`);
    }
  }
  const isoDay = /\b((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g;
  for (const match of text.matchAll(isoDay)) {
    const [, year, month, day] = match;
    if (year !== undefined && month !== undefined && day !== undefined) {
      days.add(`${year}-${month}-${day}`);
    }
  }
  const isoMonth = /\b((?:19|20)\d{2})-(0[1-9]|1[0-2])(?![-\d])/g;
  for (const match of text.matchAll(isoMonth)) {
    const year = match[1];
    const month = match[2];
    if (year !== undefined && month !== undefined) {
      months.add(`${year}-${month}`);
    }
  }
  return { months, days };
}

function calendarFamily(entry: MacroCalendarContext): MacroFamily | null {
  const key = entry.eventKey.toLowerCase();
  const name = entry.eventName.toLowerCase();
  if (
    key.startsWith("cpi") ||
    name.includes("cpi") ||
    name.includes("consumer price")
  ) {
    return "cpi";
  }
  if (
    key.startsWith("nfp") ||
    key.startsWith("empsit") ||
    name.includes("payroll") ||
    name.includes("employment situation") ||
    name.includes("unemployment")
  ) {
    return "employment";
  }
  if (
    key.startsWith("fomc") ||
    name.includes("fomc") ||
    name.includes("federal open market")
  ) {
    return "fomc";
  }
  return null;
}

/** Period of the DATA a calendar entry publishes, from its BLS year/period. */
function dataPeriodOf(entry: MacroCalendarContext): string | null {
  const year = entry.payload.year;
  const period = entry.payload.period;
  if (typeof year !== "string" || typeof period !== "string") {
    return null;
  }
  const match = /^m(0[1-9]|1[0-2])$/i.exec(period);
  const month = match?.[1];
  if (month === undefined || !/^(?:19|20)\d{2}$/.test(year)) {
    return null;
  }
  return `${year}-${month}`;
}

/** Calendar day on which a calendar entry is PUBLISHED, in UTC. */
function releaseDayOf(entry: MacroCalendarContext): string | null {
  return entry.scheduledAt === null
    ? null
    : (entry.scheduledAt.toISOString().slice(0, 10) ?? null);
}

/** Month in which a calendar entry is PUBLISHED. */
function releasePeriodOf(entry: MacroCalendarContext): string | null {
  if (entry.scheduledAt !== null) {
    const year = entry.scheduledAt.getUTCFullYear();
    const month = entry.scheduledAt.getUTCMonth() + 1;
    return `${String(year)}-${String(month).padStart(2, "0")}`;
  }
  const match = /-((?:19|20)\d{2})-(0[1-9]|1[0-2])$/.exec(entry.eventKey);
  const year = match?.[1];
  const month = match?.[2];
  return year === undefined || month === undefined ? null : `${year}-${month}`;
}

/**
 * Match one calendar entry, or none. Precedence, applied to the entries of the
 * right source and event family:
 *
 *   1. an entry published on a full date the market names (the most precise
 *      identifier a rule can give of WHICH release it means);
 *   2. an entry whose DATA period is a month the market names ("August 2026
 *      CPI");
 *   3. an entry whose RELEASE month is a month the market names;
 *   4. when the market names no period at all, the latest entry scheduled at
 *      or before the market's own end date — a release after resolution cannot
 *      be what the market is about.
 *
 * A tier that produces more than one entry is a tie we refuse to break: the
 * market is excluded rather than priced off a guessed release.
 */
function matchCalendar(
  variable: MacroVariable,
  source: MacroMarketSpec["source"],
  context: MarketContext,
  text: string,
  calendar: readonly MacroCalendarContext[],
): MacroCalendarContext | null {
  const family = variableFamily(variable);
  const candidates = calendar.filter(
    (entry) => entry.source === source && calendarFamily(entry) === family,
  );
  if (candidates.length === 0) {
    return null;
  }

  const periods = referencedPeriods(text);
  if (periods.days.size > 0 || periods.months.size > 0) {
    const tiers: ReadonlyArray<(entry: MacroCalendarContext) => boolean> = [
      (entry) => {
        const day = releaseDayOf(entry);
        return day !== null && periods.days.has(day);
      },
      (entry) => {
        const period = dataPeriodOf(entry);
        return period !== null && periods.months.has(period);
      },
      (entry) => {
        const period = releasePeriodOf(entry);
        return period !== null && periods.months.has(period);
      },
    ];
    for (const matches of tiers) {
      const tier = candidates.filter(matches);
      if (tier.length === 1) {
        return tier[0] ?? null;
      }
      if (tier.length > 1) {
        return null;
      }
    }
    return null;
  }

  const endDate = context.endDate;
  if (endDate === null) {
    return null;
  }
  const eligible = candidates.filter(
    (entry) =>
      entry.scheduledAt !== null &&
      entry.scheduledAt.getTime() <= endDate.getTime(),
  );
  let best: MacroCalendarContext | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  let tied = false;
  for (const entry of eligible) {
    const at = entry.scheduledAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (at > bestMs) {
      best = entry;
      bestMs = at;
      tied = false;
    } else if (at === bestMs) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/**
 * Deterministic parse of the VERSIONED rule text. A market whose rule does not
 * parse unambiguously is excluded from the model and stays on the baseline.
 */
export function parseMacroMarket(
  context: MarketContext,
  calendar: readonly MacroCalendarContext[],
): MacroParseResult {
  // Rule text and question are parsed together: Polymarket states the
  // threshold in the question and the mechanics in the versioned rule, and
  // either half alone is routinely incomplete. Non-breaking spaces and the
  // typographic dashes are normalised so the patterns below see plain ASCII.
  const raw = `${context.rulesText ?? ""}\n${context.question}`
    .toLowerCase()
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/[\u2010-\u2015\u2212]/g, "-");

  const variable = detectVariable(raw);
  if (variable === null) {
    return { ok: false, reason: "UNRECOGNIZED_VARIABLE" };
  }
  if (DISCRETION_PHRASES.some((phrase) => raw.includes(phrase))) {
    return { ok: false, reason: "AMBIGUOUS_THRESHOLD" };
  }

  const masked = maskNonThresholdNumbers(raw);
  const thresholds = new Set(
    plausibleThresholds(variable, collectNumbers(masked)),
  );
  if (thresholds.size === 0) {
    return { ok: false, reason: "NO_THRESHOLD" };
  }
  if (thresholds.size > 1) {
    return { ok: false, reason: "AMBIGUOUS_THRESHOLD" };
  }
  const threshold = [...thresholds][0];
  if (threshold === undefined) {
    return { ok: false, reason: "NO_THRESHOLD" };
  }

  const comparison = detectComparison(masked);
  if (comparison === null) {
    return { ok: false, reason: "NO_COMPARISON" };
  }

  const source = detectSource(variable, context, raw);
  if (source === null) {
    return { ok: false, reason: "NO_SOURCE" };
  }

  const entry = matchCalendar(variable, source, context, raw, calendar);
  if (entry === null) {
    return { ok: false, reason: "NO_CALENDAR_MATCH" };
  }

  return {
    ok: true,
    spec: {
      variable,
      comparison,
      threshold,
      source,
      eventKey: entry.eventKey,
      releaseAt: entry.scheduledAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Hyperparameters
// ---------------------------------------------------------------------------

export interface MacroHyperparams {
  readonly defaultSigma: Readonly<Record<string, number>>;
  readonly postReleaseWindowMs: number;
  readonly underReactionCoefficient: number;
}

export const DEFAULT_MACRO_HYPERPARAMS: MacroHyperparams = Object.freeze({
  defaultSigma: DEFAULT_FUNDAMENTAL_CONFIG.macro.defaultSigma,
  postReleaseWindowMs: DEFAULT_FUNDAMENTAL_CONFIG.macro.postReleaseWindowMs,
  underReactionCoefficient:
    DEFAULT_FUNDAMENTAL_CONFIG.macro.underReactionCoefficient,
});

const MACRO_HYPERPARAM_KEYS: readonly string[] = [
  "default_sigma",
  "post_release_window_ms",
  "under_reaction_coefficient",
];

const MAX_POST_RELEASE_WINDOW_MS = 7 * 24 * 3_600_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Read one model version's serialized hyperparameters on top of the module
 * config. Unlike the config parser this never throws: hyperparams come from a
 * stored registry row, and a malformed row must degrade to the configured
 * default with a logged reason code, not take the estimation job down.
 */
export function parseMacroHyperparams(
  raw: unknown,
  config: FundamentalConfig,
): MacroHyperparams {
  const base = config.macro;
  const defaultSigma: Record<string, number> = { ...base.defaultSigma };
  let postReleaseWindowMs = base.postReleaseWindowMs;
  let underReactionCoefficient = base.underReactionCoefficient;

  if (raw !== undefined && raw !== null && !isRecord(raw)) {
    logLine("warn", "MACRO_HYPERPARAMS_INVALID", "macro_hyperparams_ignored", {
      field: "hyperparams",
    });
    return Object.freeze({
      defaultSigma: Object.freeze(defaultSigma),
      postReleaseWindowMs,
      underReactionCoefficient,
    });
  }

  if (isRecord(raw)) {
    for (const key of Object.keys(raw)) {
      if (!MACRO_HYPERPARAM_KEYS.includes(key)) {
        logLine(
          "warn",
          "MACRO_HYPERPARAM_UNKNOWN",
          "macro_hyperparam_ignored",
          {
            field: key,
          },
        );
      }
    }

    const rawSigma = raw.default_sigma;
    if (rawSigma !== undefined) {
      if (isRecord(rawSigma)) {
        for (const [key, value] of Object.entries(rawSigma)) {
          const parsed = finiteNumber(value);
          if (parsed !== null && parsed > 0 && parsed <= 1e9) {
            defaultSigma[key] = parsed;
          } else {
            logLine(
              "warn",
              "MACRO_HYPERPARAM_INVALID",
              "macro_hyperparam_ignored",
              { field: `default_sigma.${key}` },
            );
          }
        }
      } else {
        logLine(
          "warn",
          "MACRO_HYPERPARAM_INVALID",
          "macro_hyperparam_ignored",
          { field: "default_sigma" },
        );
      }
    }

    const rawWindow = raw.post_release_window_ms;
    if (rawWindow !== undefined) {
      const parsed = finiteNumber(rawWindow);
      if (
        parsed !== null &&
        Number.isSafeInteger(parsed) &&
        parsed >= 0 &&
        parsed <= MAX_POST_RELEASE_WINDOW_MS
      ) {
        postReleaseWindowMs = parsed;
      } else {
        logLine(
          "warn",
          "MACRO_HYPERPARAM_INVALID",
          "macro_hyperparam_ignored",
          { field: "post_release_window_ms" },
        );
      }
    }

    const rawCoefficient = raw.under_reaction_coefficient;
    if (rawCoefficient !== undefined) {
      const parsed = finiteNumber(rawCoefficient);
      if (parsed !== null && parsed >= 0 && parsed <= 1) {
        underReactionCoefficient = parsed;
      } else {
        logLine(
          "warn",
          "MACRO_HYPERPARAM_INVALID",
          "macro_hyperparam_ignored",
          { field: "under_reaction_coefficient" },
        );
      }
    }
  }

  return Object.freeze({
    defaultSigma: Object.freeze(defaultSigma),
    postReleaseWindowMs,
    underReactionCoefficient,
  });
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export interface MacroModelInput {
  readonly spec: MacroMarketSpec;
  readonly decisionTs: Date;
  /** The matched calendar entry. */
  readonly calendar: MacroCalendarContext | null;
  /** Official value, when already published. */
  readonly release: MacroReleaseContext | null;
  /** From the caller's microprice. */
  readonly thinBook: boolean;
  readonly config: FundamentalConfig;
  readonly hyperparams: MacroHyperparams;
  readonly guard: AsOfGuard;
}

/**
 * Consensus keys this model accepts in the calendar payload, in priority
 * order: "consensus", then "nowcast", then "forecast". Dispersion keys, also
 * in priority order: "consensus_std", then "std", then "sigma". Anything else
 * is not a consensus, and a payload without one makes the model ABSTAIN — the
 * baseline is a strong prior, an invented consensus is a fabricated input.
 */
const CONSENSUS_KEYS: readonly string[] = ["consensus", "nowcast", "forecast"];
const CONSENSUS_SIGMA_KEYS: readonly string[] = [
  "consensus_std",
  "std",
  "sigma",
];

/**
 * Per-variable consensus maps, read BEFORE the flat keys above.
 *
 * One calendar entry publishes several of this model's variables at once —
 * the September CPI release carries cpi_yoy, cpi_mom AND core_cpi_yoy, and
 * the Employment Situation carries nonfarm_payrolls AND unemployment_rate —
 * while `matchCalendar` pairs a market with an entry by FAMILY, not by
 * variable. A single flat number therefore cannot say which scale it is on,
 * and a year-over-year nowcast served to a month-over-month market would be a
 * silent unit mismatch in the pre-release regime, where the post-release
 * `MACRO_RELEASE_MAX_SIGMAS` guard cannot see it.
 *
 * The keyed form removes the ambiguity by naming the variable. The flat keys
 * stay valid and unchanged — they are unambiguous for a family with exactly
 * one variable (FOMC) — and `config/macro-calendar.json` is held to the keyed
 * form for the multi-variable families by its own shape test.
 */
const CONSENSUS_MAP_KEYS: readonly string[] = [
  "consensus_by_variable",
  "nowcast_by_variable",
];
const CONSENSUS_SIGMA_MAP_KEYS: readonly string[] = [
  "consensus_std_by_variable",
];

const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

/** JSONB round-trips numbers as numbers or as strings; accept both, exactly. */
function readNumeric(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!DECIMAL_PATTERN.test(trimmed)) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

interface ConsensusReading {
  readonly value: number;
  readonly key: string;
  readonly sigma: number | null;
  readonly sigmaKey: string | null;
}

/**
 * Read `variable`'s entry out of one of `mapKeys`, as "<mapKey>.<variable>".
 * A map that is absent, not an object, or silent about this variable simply
 * does not answer — it never falls through to another variable's number.
 */
function readFromVariableMap(
  payload: Record<string, unknown>,
  mapKeys: readonly string[],
  variable: MacroVariable,
): { readonly value: number; readonly key: string } | null {
  for (const mapKey of mapKeys) {
    const map = payload[mapKey];
    if (typeof map !== "object" || map === null || Array.isArray(map)) {
      continue;
    }
    const parsed = readNumeric((map as Record<string, unknown>)[variable]);
    if (parsed !== null) {
      return { value: parsed, key: `${mapKey}.${variable}` };
    }
  }
  return null;
}

function readConsensus(
  payload: Record<string, unknown>,
  variable: MacroVariable,
): ConsensusReading | null {
  let value: number | null = null;
  let key: string | null = null;
  const keyed = readFromVariableMap(payload, CONSENSUS_MAP_KEYS, variable);
  if (keyed !== null) {
    value = keyed.value;
    key = keyed.key;
  } else {
    for (const candidate of CONSENSUS_KEYS) {
      const parsed = readNumeric(payload[candidate]);
      if (parsed !== null) {
        value = parsed;
        key = candidate;
        break;
      }
    }
  }
  if (value === null || key === null) {
    return null;
  }
  let sigma: number | null = null;
  let sigmaKey: string | null = null;
  const keyedSigma = readFromVariableMap(
    payload,
    CONSENSUS_SIGMA_MAP_KEYS,
    variable,
  );
  if (keyedSigma !== null && keyedSigma.value > 0) {
    sigma = keyedSigma.value;
    sigmaKey = keyedSigma.key;
  } else {
    for (const candidate of CONSENSUS_SIGMA_KEYS) {
      const parsed = readNumeric(payload[candidate]);
      if (parsed !== null && parsed > 0) {
        sigma = parsed;
        sigmaKey = candidate;
        break;
      }
    }
  }
  return { value, key, sigma, sigmaKey };
}

/** P(X compared-to threshold) for X ~ Normal(mu, sigma). */
function tailProbability(
  comparison: MacroComparison,
  threshold: number,
  mu: number,
  sigma: number,
): number {
  const z = (threshold - mu) / sigma;
  const below = normalCdf(z);
  // Under a continuous distribution P(X = threshold) is zero, so gte coincides
  // with gt and lte with lt. The discrete reporting grid of the official
  // series (one decimal for CPI, thousands for payrolls) is NOT modelled in
  // 1.0.0: doing so would need a per-variable tick we have no evidence for.
  return comparison === "gt" || comparison === "gte" ? 1 - below : below;
}

function outcomeOf(
  comparison: MacroComparison,
  value: number,
  threshold: number,
): 0 | 1 {
  if (comparison === "gt") {
    return value > threshold ? 1 : 0;
  }
  if (comparison === "gte") {
    return value >= threshold ? 1 : 0;
  }
  if (comparison === "lt") {
    return value < threshold ? 1 : 0;
  }
  return value <= threshold ? 1 : 0;
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }
  return value < MACRO_MIN_Q
    ? MACRO_MIN_Q
    : value > MACRO_MAX_Q
      ? MACRO_MAX_Q
      : value;
}

/** Fixed-precision rendering so `data_refs` is byte-stable across runs. */
function stat(value: number): string {
  return value.toFixed(6);
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * The model does not see the order book, so it must not emit the book keys of
 * `DataRefs`: `decideEstimate` spreads the model's refs OVER the book refs it
 * computed itself, and a book key emitted here would overwrite real provenance
 * with a fabricated one. `DataRefs` declares those keys as required, so the
 * model-side subset is handed over through this one documented widening.
 */
function toModelDataRefs(fields: Record<string, unknown>): DataRefs {
  return fields as DataRefs;
}

interface MacroEvaluation {
  readonly q: number;
  readonly sigma: number;
  readonly regime: "pre_release" | "post_release";
  readonly refs: Record<string, unknown>;
}

function evaluate(input: MacroModelInput): MacroEvaluation | ModelResult {
  const { spec, guard, hyperparams } = input;
  if (guard.decisionTs.getTime() !== input.decisionTs.getTime()) {
    // A guard built for another instant cannot prove anything about this one.
    logLine("error", "MACRO_GUARD_MISMATCH", "macro_guard_mismatch", {
      guard_decision_ts: guard.decisionTs.toISOString(),
      decision_ts: input.decisionTs.toISOString(),
    });
    return { ok: false, reason: "MODEL_ERROR" };
  }

  const calendar = input.calendar;
  if (calendar === null) {
    return { ok: false, reason: "MODEL_ABSTAINED" };
  }
  // Only the row's own emitter clock is a source_ts. `scheduledAt` is a
  // SCHEDULE — it legitimately lies in the future and is not an observation,
  // so it is never routed through the guard.
  guard.record("macro_calendar", calendar.sourceTs, calendar.eventKey);

  const consensus = readConsensus(calendar.payload, spec.variable);
  if (consensus === null) {
    return { ok: false, reason: "MODEL_ABSTAINED" };
  }
  guard.record("macro_consensus", calendar.sourceTs, consensus.value);

  const defaultSigma = hyperparams.defaultSigma[spec.variable];
  const sigma = consensus.sigma ?? defaultSigma ?? null;
  if (consensus.sigma !== null) {
    guard.record("macro_consensus_sigma", calendar.sourceTs, consensus.sigma);
  }
  if (sigma === null || !Number.isFinite(sigma) || sigma <= 0) {
    return { ok: false, reason: "MODEL_ABSTAINED" };
  }
  if (!Number.isFinite(spec.threshold)) {
    return { ok: false, reason: "MODEL_ABSTAINED" };
  }

  const qPre = tailProbability(
    spec.comparison,
    spec.threshold,
    consensus.value,
    sigma,
  );
  if (!Number.isFinite(qPre)) {
    return { ok: false, reason: "MODEL_ERROR" };
  }
  // Dispersion in PROBABILITY units by central finite difference of the normal
  // CDF: bump the consensus location by +/- h and halve the swing, which is
  // exactly |dq/dmu| * h to first order. h is the standard error of the
  // consensus location (see MACRO_CONSENSUS_PANEL_EQUIVALENT).
  const bump = sigma / Math.sqrt(MACRO_CONSENSUS_PANEL_EQUIVALENT);
  const qUp = tailProbability(
    spec.comparison,
    spec.threshold,
    consensus.value + bump,
    sigma,
  );
  const qDown = tailProbability(
    spec.comparison,
    spec.threshold,
    consensus.value - bump,
    sigma,
  );
  const sigmaPre = Math.max(Math.abs(qUp - qDown) / 2, MACRO_MIN_SIGMA);

  const baseRefs: Record<string, unknown> = {
    calendarSourceTs: iso(calendar.sourceTs),
    macroVariable: spec.variable,
    macroComparison: spec.comparison,
    macroThreshold: stat(spec.threshold),
    macroSource: spec.source,
    macroEventKey: spec.eventKey,
    macroScheduledAt: iso(spec.releaseAt),
    macroConsensus: stat(consensus.value),
    macroConsensusKey: consensus.key,
    macroSigma: stat(sigma),
    macroSigmaKey: consensus.sigmaKey,
    macroSigmaSource: consensus.sigma === null ? "config_default" : "payload",
    macroPreReleaseQ: stat(qPre),
    macroPostReleaseWindowMs: hyperparams.postReleaseWindowMs,
    macroModelVersion: MACRO_MODEL_VERSION,
  };

  const release = input.release;
  if (release === null) {
    return {
      q: clampProbability(qPre),
      sigma: sigmaPre,
      regime: "pre_release",
      refs: { ...baseRefs, releaseSourceTs: null, macroRegime: "pre_release" },
    };
  }

  // The OFFICIAL publication instant: the publisher's own clock when it gave
  // us one, the scheduled publication otherwise. Routed through the guard, so
  // a release handed to us from the future fails loudly instead of leaking.
  const officialTs = release.sourceTs ?? release.publishedAt;
  guard.record("macro_release", officialTs, release.eventKey);
  if (officialTs === null) {
    // A published value we cannot place in time cannot be used as-of anything.
    return { ok: false, reason: "MODEL_ABSTAINED" };
  }
  const ageMs = input.decisionTs.getTime() - officialTs.getTime();
  if (ageMs > hyperparams.postReleaseWindowMs) {
    // The official number has been public for longer than the drift window:
    // the pre-release consensus distribution no longer describes anything, and
    // this model has no hypothesis left. Abstain to the market baseline.
    return { ok: false, reason: "MODEL_ABSTAINED" };
  }

  const value = readNumeric(release.value);
  if (value === null) {
    // Published but unreadable: abstaining is the only honest answer.
    return { ok: false, reason: "MODEL_ABSTAINED" };
  }
  guard.record("macro_release_value", officialTs, value);
  if (Math.abs(value - consensus.value) > MACRO_RELEASE_MAX_SIGMAS * sigma) {
    // Unit-mismatch guard: the recorded value is not on the consensus scale.
    logLine("warn", "MACRO_RELEASE_OFF_SCALE", "macro_release_off_scale", {
      event_key: spec.eventKey,
      variable: spec.variable,
    });
    return { ok: false, reason: "MODEL_ABSTAINED" };
  }

  const outcome = outcomeOf(spec.comparison, value, spec.threshold);
  const coefficient = hyperparams.underReactionCoefficient;
  // HYPOTHESIS (RFC-010, "sub-reação a sinal público ~0,64-por-1"): after a
  // public macro print the move is only partly incorporated, and the rest
  // drifts in. The blend below is the literal encoding of that claim and
  // nothing more — it is NOT an assumed edge. It lives on its own
  // `macroRegime` stratum precisely so the walk-forward gate can score it
  // separately from the pre-release regime and reject it on its own evidence.
  // With coefficient 1 the blend degenerates to the known outcome.
  const qPost = qPre + coefficient * (outcome - qPre);
  // What the hypothesis says has NOT been incorporated yet is exactly the
  // residual distance to the known outcome; that is the scale of our error.
  const sigmaPost = Math.max(
    (1 - coefficient) * Math.abs(outcome - qPre),
    MACRO_MIN_SIGMA,
  );

  return {
    q: clampProbability(qPost),
    sigma: sigmaPost,
    regime: "post_release",
    refs: {
      ...baseRefs,
      releaseSourceTs: iso(officialTs),
      macroRegime: "post_release",
      macroReleaseValue: stat(value),
      macroReleaseAgeMs: ageMs,
      macroKnownOutcome: outcome,
      macroUnderReaction: stat(coefficient),
    },
  };
}

function isModelResult(
  value: MacroEvaluation | ModelResult,
): value is ModelResult {
  return "ok" in value;
}

/**
 * Estimate q for one macro market at one decision instant. Never throws: any
 * unexpected failure is logged with a stable reason code and degrades to
 * MODEL_ERROR, which the deterministic fallback turns into MARKET_BASELINE.
 */
export function estimateMacroScheduled(input: MacroModelInput): ModelResult {
  let evaluated: MacroEvaluation | ModelResult;
  try {
    evaluated = evaluate(input);
  } catch (error: unknown) {
    logLine("error", "MACRO_MODEL_FAILED", "macro_model_failed", {
      error_name: error instanceof Error ? error.name : "UnknownError",
      event_key: input.spec.eventKey,
      variable: input.spec.variable,
    });
    return { ok: false, reason: "MODEL_ERROR" };
  }
  if (isModelResult(evaluated)) {
    return evaluated;
  }
  if (!Number.isFinite(evaluated.q) || !Number.isFinite(evaluated.sigma)) {
    return { ok: false, reason: "MODEL_ERROR" };
  }

  // Staleness of this model's own "feed" is the calendar row's age. RFC-007
  // records the curated calendar with a NULL source_ts (there is no emitter
  // clock to copy), so an entry without one is never called stale — the
  // release-window abstention above is what protects us there.
  const calendarSourceTs = input.calendar?.sourceTs ?? null;
  const feedStale =
    calendarSourceTs !== null &&
    input.decisionTs.getTime() - calendarSourceTs.getTime() >
      input.config.macro.maxCalendarAgeMs;

  return {
    ok: true,
    value: {
      q: evaluated.q,
      sigma: evaluated.sigma,
      featureSetVersion: MACRO_FEATURE_SET_VERSION,
      dataRefs: toModelDataRefs(evaluated.refs),
      feedStale,
      // Age of this model's own input clock, so the interval widens with it.
      feedAgeMs:
        calendarSourceTs === null
          ? null
          : input.decisionTs.getTime() - calendarSourceTs.getTime(),
      // The caller's microprice view is OR-ed with ours so the flag can only
      // ever be strengthened downstream, never weakened.
      thinBook: input.thinBook || MACRO_BOOK_IS_THIN,
    },
  };
}
