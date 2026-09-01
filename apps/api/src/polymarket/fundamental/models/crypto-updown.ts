// RFC-010 task 5: the `crypto_updown` model — "asset above/below K at T".
//
// This module is a PURE FUNCTION of its arguments: no database, no clock, no
// fetch. The caller reads the resolving feed and its 1-minute series through
// features.ts and hands them over, which is what makes (q, sigma) reproducible
// from the stored `data_refs` alone. The single exception is the one-line
// stderr log in the hyperparameter parser, which exists so that a malformed
// registry row degrades observably instead of silently.
//
// The primary input is the Chainlink TWAP 30/60 s — the feed that RESOLVES
// these markets. Using it removes the basis risk of a spot feed. A spot feed
// (Binance `crypto_prices`) is deliberately NOT read here and must never be
// mixed into the same quantity: the documented ~0.12% structural Binance vs
// Chainlink offset in ETH already produced one false positive. If a cross-feed
// signal is ever wanted, the offset has to be MEASURED PER SYMBOL and corrected
// first, as its own versioned feature — not assumed away here.
//
// Base map: driftless distribution of log returns over the remaining horizon.
// No drift term is estimated on purpose: over horizons of hours to days the
// drift is statistically indistinguishable from zero at these sample sizes, and
// pretending to know its sign would be fabricating alpha. The map exists in two
// versioned variants (normal and Student-t) and is evaluated once per
// configured EWMA lambda, so the spread of that ensemble is the model's own
// admission of how little it knows.
//
// Before any walk-forward evidence exists, `hyperparams.calibration` is null and
// q is the raw base map. That is the honest state, not a degradation.
//
// Nothing here creates an order, a signal, a wallet or any trading credential,
// and nothing here may.

import {
  DEFAULT_FUNDAMENTAL_CONFIG,
  type FundamentalConfig,
} from "../config.js";
import { contiguousLogReturns } from "../features.js";
import type {
  AsOfGuard,
  FeedSample,
  FeedSeries,
  MarketContext,
} from "../features.js";
import {
  applyLogistic,
  ewmaVolatility,
  fitLogistic,
  logit,
  mean,
  normalCdf,
  standardDeviation,
  studentTCdf,
} from "../stats.js";
import type { DataRefs, ModelResult } from "../types.js";

export const CRYPTO_MODEL_FAMILY = "crypto_updown_gbm";
export const CRYPTO_MODEL_VERSION = "1.0.0";

/**
 * RFC-014/RFC-019: the extended version of the SAME family, covering the
 * barrier (first-passage) and updown (strike = window open) question forms in
 * addition to terminal. One version, not one per form, because promotion is
 * one-active-per-category: an active model must cover everything it can, and
 * the gate evaluates the model whole.
 */
export const CRYPTO_EXTENDED_MODEL_VERSION = "1.1.0";

/**
 * Version of the feature vector produced by `cryptoFeatureRow`. It is tracked
 * separately from the shared feature layer's FEATURE_SET_VERSION because a
 * calibration fitted on this row is only replayable against this exact row:
 * any change to the row's contents or order must bump this string, which
 * invalidates every stored calibration that quoted the old one.
 */
export const CRYPTO_FEATURE_SET_VERSION = "1.0.0";

/**
 * Feature-set of the extended version. The row layout is the same four
 * columns, but `logit(q_base)` now comes from a form-dependent base map, so a
 * calibration fitted on one version's rows must never be replayed against the
 * other's. The registered feature-set string is what enforces that.
 */
export const CRYPTO_EXTENDED_FEATURE_SET_VERSION = "1.1.0";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const MINUTES_PER_DAY = 1_440;
/** The model's time unit is the day; the closes arrive per minute. */
const SQRT_MINUTES_PER_DAY = Math.sqrt(MINUTES_PER_DAY);

/** Number of columns in `cryptoFeatureRow`; a calibration must match it. */
const CRYPTO_FEATURE_WIDTH = 4;

/**
 * Floor of the reported dispersion, in probability units. The ensemble is small
 * (variants x lambdas) and its members can agree by coincidence — most obviously
 * exactly at the money, where every variant returns 0.5. A sigma of zero would
 * claim perfect knowledge of a crypto price hours away, so the reported
 * dispersion never goes below half a probability point.
 */
const MIN_SIGMA = 0.005;

/** q never leaves this module as exactly 0 or 1: ModelOutput.q lives in (0, 1). */
const Q_EPSILON = 1e-6;

const DEFAULT_TRAIN_L2 = 1;
const DEFAULT_TRAIN_LEARNING_RATE = 0.5;
const DEFAULT_TRAIN_ITERATIONS = 2_000;

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

/**
 * RFC-014/RFC-019 question forms. `terminal` pays on the level at T,
 * `barrier` pays on the path touching a level inside the market's window,
 * `updown` is terminal with the strike read from the recorded feed at the
 * window's open instant instead of from the question.
 */
export type CryptoQuestionForm = "terminal" | "barrier" | "updown";

export type CryptoDirection =
  | "above"
  | "below"
  | "touch_up"
  | "touch_down"
  /**
   * Neutral barrier wording ("hit"/"touch"): stays neutral for the market's
   * whole life. A side derived from the current level would invert after a
   * crossing; the touch test for this direction is containment instead.
   */
  | "touch"
  /** updown: YES is "Up", i.e. close at/above the window open. */
  | "up";

export interface CryptoMarketSpec {
  /** RTDS symbol of the recorded feed, e.g. "btc/usd". */
  readonly symbol: string;
  readonly form: CryptoQuestionForm;
  /** Strike K in USD; null only for `updown`, whose strike is read from the feed. */
  readonly strike: number | null;
  readonly direction: CryptoDirection;
  /** T, the resolution instant. */
  readonly deadline: Date;
  /** updown: open instant of the resolving window — the strike's as-of instant. */
  readonly windowStartTs: Date | null;
  /**
   * barrier: instant the payoff window opens, derived from the deadline and
   * the window length stated in the title (RFC-014 E2); null means the window
   * has been open since listing ("by <date>" family).
   */
  readonly windowOpensTs: Date | null;
  /**
   * barrier: earliest instant the touch scan may read. For bounded windows it
   * is the window open; for open windows it is the market's first observation
   * (any touch after listing is certainly inside the window). Null disables
   * the scan — the conservative direction (a touch can be missed, never
   * invented).
   */
  readonly touchScanFrom: Date | null;
}

// Only these four symbols exist in the RTDS recorder, so only these four can be
// modelled; anything else stays on the baseline forever.
const SYMBOL_ALIASES: ReadonlyArray<{
  readonly symbol: string;
  readonly pattern: RegExp;
}> = [
  { symbol: "btc/usd", pattern: /\b(?:btc|bitcoin)\b/ },
  { symbol: "eth/usd", pattern: /\b(?:eth|ether|ethereum)\b/ },
  { symbol: "sol/usd", pattern: /\b(?:sol|solana)\b/ },
  { symbol: "xrp/usd", pattern: /\b(?:xrp|ripple)\b/ },
];

// "over"/"under"/"at least"/"at most" only count as a direction when they sit
// immediately in front of an amount: "over the next month" is a horizon, not a
// direction, and reading it as one would invert half the universe.
const ABOVE_PATTERNS: readonly RegExp[] = [
  /\b(?:above|greater than|higher than|exceeds?)\b/,
  /\b(?:over|at least)\s+\$?\s*\d/,
];
const BELOW_PATTERNS: readonly RegExp[] = [
  /\b(?:below|less than|lower than)\b/,
  /\b(?:under|at most)\s+\$?\s*\d/,
];

// Barrier phrasings pay on the PATH, not on the level at T. Until RFC-014 they
// were refused wholesale; now they are classified and priced by the
// first-passage map — but only by a version whose `forms` hyperparameter says
// so. Ranges ("between") are still not a single-threshold payoff, and an
// all-time high has no numeric barrier in the question, so both stay refused.
// Barrier verbs, each one verified against the RESOLUTION RULES of the
// markets that use it (2026-09-01: "reach" 179 markets, "dip to" 137,
// "hit"/"touch" 4 — all resolving on any 1-minute candle crossing the level).
const BARRIER_VERB_PATTERN =
  /\b(?:hits?|reach(?:es)?|touch(?:es)?|dips?\s+to)\b/;
const REFUSED_PATTERNS: readonly RegExp[] = [
  /\ball[- ]time high\b|\bath\b/,
  /\bbetween\b/,
  // "dip/fall/drop BELOW X" reads as a path payoff (the verb) wearing terminal
  // clothing (the preposition), and no market in the measured population uses
  // it — so there is no rule text to settle which family it belongs to. The
  // RFC's stop condition governs: when the two forms cannot be separated
  // without ambiguity the market stays on the baseline, and one does not
  // "pick the more likely". Zero production markets are affected (measured
  // 2026-09-01 over the whole crypto history); a real one would arrive with
  // rules that decide the family, and then it gets classified, not guessed.
  /\b(?:dips?|falls?|drops?)\s+(?:below|under)\b/,
];
/**
 * Path markers without a barrier verb ("Will BTC ever be above…?") are still
 * path payoffs, but not a family this parser can bound a window for; with a
 * barrier verb they are redundant ("reach … anytime in August") and harmless.
 */
const PATH_MARKER_PATTERN = /\bever\b|\banytime\b|\bany time\b/;

const UPDOWN_PATTERN = /\bup or down\b/;
// "4:00PM-8:00PM ET": the range family resolves on the Chainlink TWAP of the
// whole range against its opening price — an Asian payoff, not terminal.
// Registered as a candidate future variant (RFC-014 E1), refused here.
const UPDOWN_RANGE_PATTERN =
  /\d{1,2}(?::\d{2})?\s*[ap]m\s*[-–]\s*\d{1,2}(?::\d{2})?\s*[ap]m/;
// "…August 31, 9PM ET": the 1-hour-candle family. Whole hours only — a title
// with minutes is not a family whose window length this parser knows.
const UPDOWN_HOURLY_PATTERN = /,\s*\d{1,2}\s*[ap]m\s+et\b/;
// "…Up or Down on September 1?": the daily family (noon-ET-close vs the
// previous day's noon-ET close — a 24 h window ending at the deadline).
const UPDOWN_DAILY_PATTERN = /\bup or down on\b/;

const HOUR_MS = 3_600_000;

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;
const MONTH_ALTERNATION = MONTH_NAMES.join("|");
const ON_DATE_PATTERN = new RegExp(
  `\\bon\\s+(${MONTH_ALTERNATION})\\s+(\\d{1,2})\\b`,
);
const DATE_RANGE_PATTERN = new RegExp(
  `\\b(${MONTH_ALTERNATION})\\s+(\\d{1,2})\\s*[-–]\\s*(?:(${MONTH_ALTERNATION})\\s+)?(\\d{1,2})\\b`,
);
const IN_MONTH_PATTERN = new RegExp(`\\bin\\s+(${MONTH_ALTERNATION})\\b`);

// A strike is only recognized with a currency marker ($) or a magnitude suffix
// (k/m/b). That is what keeps "on August 30" and "at 12pm ET" out of the strike
// set: a bare integer in a question is far more often a date than a price.
// The suffix requires a word boundary: without it, "$45,000 by December 31"
// reads the "b" of "by" as billions and manufactures a strike of 45 trillion
// (latent since 1.0.0, surfaced by the RFC-014 production fixtures — the "by"
// family was refused wholesale before, so the path was unreachable).
// Spelled-out magnitudes are first-class: "reach $1 million" is a standing
// Polymarket title family, and the boundary requirement alone would silently
// degrade it to a $1 strike — which on a barrier is an instant "touch" and a
// served q of ~1 on a market priced at cents. (The pre-RFC-014 pattern got
// "$1 million" right only by accident: its unanchored `[kmb]?` captured the
// "m" of "million" — the same accident that read the "b" of "by" as billions.)
const STRIKE_PATTERN =
  /\$\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s*(k|m|b|thousand|million|billion|trillion)\b)?|\b(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([km])\b/g;

const MAGNITUDE: Readonly<Record<string, number>> = {
  k: 1_000,
  thousand: 1_000,
  m: 1_000_000,
  million: 1_000_000,
  b: 1_000_000_000,
  billion: 1_000_000_000,
  trillion: 1_000_000_000_000,
};

function parseStrikes(text: string): number[] {
  const strikes: number[] = [];
  for (const match of text.matchAll(STRIKE_PATTERN)) {
    const digits = match[1] ?? match[3];
    const suffix = match[2] ?? match[4];
    if (digits === undefined) {
      continue;
    }
    const magnitude = suffix === undefined ? 1 : (MAGNITUDE[suffix] ?? 1);
    const value = Number(digits.replace(/,/g, "")) * magnitude;
    if (Number.isFinite(value) && value > 0 && !strikes.includes(value)) {
      strikes.push(value);
    }
  }
  return strikes;
}

/**
 * Text-only form classifier, shared by the parser and the coverage section of
 * the daily calibration report so the two can never disagree about what a
 * question IS. `refused` covers everything the parser will not price:
 * ranges, all-time highs, path markers without a barrier verb, and questions
 * with no recognizable payoff wording at all.
 */
export function classifyCryptoQuestionForm(
  question: string,
): CryptoQuestionForm | "refused" {
  const text = question.toLowerCase();
  if (text.length === 0) {
    return "refused";
  }
  if (REFUSED_PATTERNS.some((pattern) => pattern.test(text))) {
    return "refused";
  }
  if (UPDOWN_PATTERN.test(text)) {
    return "updown";
  }
  if (BARRIER_VERB_PATTERN.test(text)) {
    return "barrier";
  }
  if (PATH_MARKER_PATTERN.test(text)) {
    // "ever be above" is a path payoff in terminal clothing; pricing it with
    // the terminal map would understate it, and no window family is stated.
    return "refused";
  }
  const above = ABOVE_PATTERNS.some((pattern) => pattern.test(text));
  const below = BELOW_PATTERNS.some((pattern) => pattern.test(text));
  return above === below ? "refused" : "terminal";
}

/**
 * UTC instants of the two US Eastern DST transitions of `year` (fixed in law
 * since 2007): 02:00 local on the second Sunday of March (EST, 07:00Z) and on
 * the first Sunday of November (EDT, 06:00Z). Used ONLY to refuse, never to
 * convert: a daily updown window that spans a transition is 23 h or 25 h long,
 * so `deadline − 24 h` would read the strike from the WRONG instant — and a
 * strike from another instant is a fabricated input (RFC-019).
 */
function usEasternDstTransitionsUtc(year: number): readonly [Date, Date] {
  const firstSundayOffset = (firstDow: number): number => (7 - firstDow) % 7;
  const marchFirstDow = new Date(Date.UTC(year, 2, 1)).getUTCDay();
  const secondSundayMarch = 1 + firstSundayOffset(marchFirstDow) + 7;
  const novemberFirstDow = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const firstSundayNovember = 1 + firstSundayOffset(novemberFirstDow);
  return [
    new Date(Date.UTC(year, 2, secondSundayMarch, 7)),
    new Date(Date.UTC(year, 10, firstSundayNovember, 6)),
  ];
}

/** Does `[from, to]` contain a US Eastern DST transition instant? */
function spansUsEasternDstTransition(from: Date, to: Date): boolean {
  for (const year of [from.getUTCFullYear(), to.getUTCFullYear()]) {
    for (const transition of usEasternDstTransitionsUtc(year)) {
      const at = transition.getTime();
      if (at >= from.getTime() && at <= to.getTime()) {
        return true;
      }
    }
  }
  return false;
}

/** Days in the UTC month containing `at`. */
function daysInUtcMonth(at: Date): number {
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0),
  ).getUTCDate();
}

/**
 * RFC-014 E2: the instant a bounded barrier window opens, derived from the
 * deadline (the as-of end of the market) minus the window length stated in
 * the title. Calendar-day subtraction carries a ±1 h slop across a DST
 * transition (March/November); every consumer of this value uses it in the
 * conservative direction, so the slop can delay service or shrink the touch
 * scan, never the opposite. Calendar-day subtraction alone is NOT always
 * conservative: across the March spring-forward the ET month/range is one
 * hour SHORTER than N calendar days, so `deadline - N days` lands one hour
 * BEFORE the true open — an hour in which a touch would be counted that does
 * not pay. Every bounded family therefore carries a one-hour pad toward the
 * deadline: the derived open is never earlier than the true one, at the cost
 * of at most the window's first hour of scan and service.
 * Returns null for the open "by <date>" family and undefined when no family
 * matches (refusal).
 */
const WINDOW_DST_PAD_MS = HOUR_MS;

function barrierWindowOpens(
  text: string,
  deadline: Date,
): Date | null | undefined {
  // The deadline is the last instant of the window's END day in ET, i.e. the
  // small hours (UTC) of the NEXT day; twelve hours earlier lands inside the
  // end day itself for any whole-hour offset. The bounded families CROSS-CHECK
  // the title's own end date against this: window arithmetic is only trusted
  // when the two independent sources agree, so a mismatched deadline (a rule
  // change, a date-only fallback parsed as UTC midnight) refuses instead of
  // turning the touch scan into a touch inventor.
  const endDayAnchor = new Date(deadline.getTime() - 12 * HOUR_MS);
  const range = DATE_RANGE_PATTERN.exec(text);
  if (range !== null) {
    const startMonth = MONTH_NAMES.indexOf(
      range[1] as (typeof MONTH_NAMES)[number],
    );
    const endMonth =
      range[3] === undefined
        ? startMonth
        : MONTH_NAMES.indexOf(range[3] as (typeof MONTH_NAMES)[number]);
    const startDay = Number(range[2]);
    const endDay = Number(range[4]);
    if (startMonth < 0 || endMonth < 0) {
      return undefined;
    }
    if (
      endDayAnchor.getUTCMonth() !== endMonth ||
      endDayAnchor.getUTCDate() !== endDay
    ) {
      // The title says the range ends on one day, the deadline says another:
      // whatever this market is, its window is not derivable from either.
      return undefined;
    }
    // The range END's year comes from the END-DAY ANCHOR, not from the raw
    // deadline: a Dec-31 deadline rolls into January (and possibly into a
    // LEAP year) in UTC, and counting the days in the wrong year would place
    // the derived open up to a day before the true one — the anticonservative
    // direction. A range that runs "backwards" in the same year crosses a
    // year boundary instead ("December 29-January 4").
    const endYear = endDayAnchor.getUTCFullYear();
    const end = Date.UTC(endYear, endMonth, endDay);
    let start = Date.UTC(endYear, startMonth, startDay);
    if (start > end) {
      start = Date.UTC(endYear - 1, startMonth, startDay);
    }
    const days = Math.round((end - start) / DAY_MS) + 1;
    if (!Number.isInteger(days) || days < 1 || days > 366) {
      return undefined;
    }
    return new Date(deadline.getTime() - days * DAY_MS + WINDOW_DST_PAD_MS);
  }
  const onDate = ON_DATE_PATTERN.exec(text);
  if (onDate !== null) {
    // "on August 31": 12:00 AM ET to 11:59 PM ET of that date (measured rule
    // text) — one day ending at the deadline, cross-checked against the title.
    const month = MONTH_NAMES.indexOf(
      onDate[1] as (typeof MONTH_NAMES)[number],
    );
    const day = Number(onDate[2]);
    if (
      month < 0 ||
      endDayAnchor.getUTCMonth() !== month ||
      endDayAnchor.getUTCDate() !== day
    ) {
      return undefined;
    }
    return new Date(deadline.getTime() - DAY_MS + WINDOW_DST_PAD_MS);
  }
  const inMonth = IN_MONTH_PATTERN.exec(text);
  if (inMonth !== null) {
    const named = MONTH_NAMES.indexOf(
      inMonth[1] as (typeof MONTH_NAMES)[number],
    );
    // The deadline is the first instant of the FOLLOWING month in ET; twelve
    // hours earlier lands inside the named month for any timezone offset.
    const inside = new Date(deadline.getTime() - 12 * HOUR_MS);
    if (named < 0 || inside.getUTCMonth() !== named) {
      // The stated month does not surround the deadline: whatever this window
      // is, it is not one this parser can bound.
      return undefined;
    }
    return new Date(
      deadline.getTime() - daysInUtcMonth(inside) * DAY_MS + WINDOW_DST_PAD_MS,
    );
  }
  // "by <date>" is checked LAST: an incidental "by" inside a bounded title
  // must never widen a bounded window into an open one, because an open
  // window scans from first observation — possibly before the true open.
  if (/\bby\b/.test(text)) {
    // Open since listing; the touch scan is bounded by first observation.
    return null;
  }
  return undefined;
}

/**
 * Deterministic parse of a market into a crypto spec, or null when the market
 * is not an unambiguous instance of a supported form. Only the question is
 * read: the rules prose carries incidental amounts (fees, tick sizes, example
 * figures) that would manufacture phantom strikes. Refusing is always safe —
 * the market simply stays on the market baseline forever, which is the RFC's
 * default state, so this parser is deliberately biased towards refusal.
 */
export function parseCryptoMarket(
  context: MarketContext,
): CryptoMarketSpec | null {
  const deadline = context.endDate;
  if (deadline === null || Number.isNaN(deadline.getTime())) {
    // Without T there is no horizon, and a horizon guessed from prose would be
    // a fabricated input to every downstream probability.
    return null;
  }
  const text = context.question.toLowerCase();
  const form = classifyCryptoQuestionForm(context.question);
  if (form === "refused") {
    return null;
  }

  const symbols = SYMBOL_ALIASES.filter((alias) =>
    alias.pattern.test(text),
  ).map((alias) => alias.symbol);
  if (symbols.length !== 1) {
    // Zero: not one of the four recorded feeds. Two or more: the question
    // compares assets, which is not this model's payoff.
    return null;
  }
  const symbol = symbols[0];
  if (symbol === undefined) {
    return null;
  }

  if (form === "updown") {
    // RFC-019: the estimator prices the FIRST token with the model's q, and
    // "Up" is the affirmative outcome. A market that does not say which token
    // is affirmative — or whose affirmative is not the first — must refuse
    // rather than risk pricing "Down" as "Up".
    if (
      context.affirmativeTokenId === null ||
      context.tokenIds[0] !== context.affirmativeTokenId
    ) {
      return null;
    }
    if (UPDOWN_RANGE_PATTERN.test(text)) {
      // Asian payoff (TWAP of the range vs its open); future variant.
      return null;
    }
    if (context.ruleVersion === null) {
      // The window arithmetic below turns the deadline into the STRIKE'S OWN
      // INSTANT, so the deadline has to be the one the versioned rule chain
      // states — not a flat-column or date-only fallback. Without a rule
      // version in force the market waits for the next registry cycle.
      return null;
    }
    const daily = UPDOWN_DAILY_PATTERN.test(text);
    const hourly = UPDOWN_HOURLY_PATTERN.test(text);
    if (daily && hourly) {
      // Two window families in one title means two candidate strike instants,
      // 23 hours apart. Picking the first branch is guessing; refuse.
      return null;
    }
    let windowMs: number | null = null;
    if (daily) {
      windowMs = DAY_MS;
      // The daily window is noon ET to noon ET — 23 h or 25 h on the two DST
      // nights of the year, when `deadline − 24 h` is NOT the previous noon.
      // The hourly family is immune (UTC-aligned candles, whole-hour offsets);
      // the barrier families are immune (their +1 h pad, and no strike
      // instant). Two refused days a year beat one wrong strike.
      if (
        spansUsEasternDstTransition(
          new Date(deadline.getTime() - 25 * HOUR_MS),
          deadline,
        )
      ) {
        return null;
      }
    } else if (hourly) {
      windowMs = HOUR_MS;
    }
    if (windowMs === null) {
      // A window length this parser cannot derive is not guessed.
      return null;
    }
    return {
      symbol,
      form,
      strike: null,
      direction: "up",
      deadline,
      windowStartTs: new Date(deadline.getTime() - windowMs),
      windowOpensTs: null,
      touchScanFrom: null,
    };
  }

  const strikes = parseStrikes(text);
  if (strikes.length !== 1) {
    return null;
  }
  const strike = strikes[0];
  if (strike === undefined) {
    return null;
  }

  if (form === "barrier") {
    if (context.ruleVersion === null) {
      // Same provenance requirement as updown: the window arithmetic and the
      // touch scan floor both hang off the deadline. TERMINAL is deliberately
      // NOT gated on this — 1.0.0's served population must not change.
      return null;
    }
    const windowOpens = barrierWindowOpens(text, deadline);
    if (windowOpens === undefined) {
      // No recognizable window family: the touch scan would have no honest
      // lower bound and the map no honest "is the window open" gate.
      return null;
    }
    const direction: CryptoDirection = /\bdips?\s+to\b/.test(text)
      ? "touch_down"
      : /\breach(?:es)?\b/.test(text)
        ? "touch_up"
        : "touch";
    return {
      symbol,
      form,
      strike,
      direction,
      deadline,
      windowStartTs: null,
      windowOpensTs: windowOpens,
      touchScanFrom: windowOpens ?? context.firstSeenAt,
    };
  }

  const above = ABOVE_PATTERNS.some((pattern) => pattern.test(text));
  return {
    symbol,
    form: "terminal",
    strike,
    direction: above ? "above" : "below",
    deadline,
    windowStartTs: null,
    windowOpensTs: null,
    touchScanFrom: null,
  };
}

export type CryptoVariant = "normal" | "student_t";

export interface CryptoHyperparams {
  readonly variant: CryptoVariant;
  readonly ewmaLambdas: readonly number[];
  readonly studentDf: number;
  /** Walk-forward calibration correction; null means "no correction yet". */
  readonly calibration: {
    readonly intercept: number;
    readonly coefficients: readonly number[];
  } | null;
  /**
   * RFC-014/RFC-019: question forms this version may price. Part of the
   * immutable registered row; a stored row without the field is the 1.0.0
   * generation, which only ever priced terminal payoffs — so the parse
   * default is `["terminal"]` and its behaviour cannot change underneath it.
   */
  readonly forms: readonly CryptoQuestionForm[];
}

const CRYPTO_FORMS: readonly CryptoQuestionForm[] = [
  "terminal",
  "barrier",
  "updown",
];

/**
 * The state of a freshly registered model: the raw base map with the module's
 * default ensemble and no calibration. Derived from the config defaults so the
 * two can never drift apart.
 */
export const DEFAULT_CRYPTO_HYPERPARAMS: CryptoHyperparams = Object.freeze({
  variant: "normal",
  ewmaLambdas: DEFAULT_FUNDAMENTAL_CONFIG.crypto.ewmaLambdas,
  studentDf: DEFAULT_FUNDAMENTAL_CONFIG.crypto.studentDf,
  calibration: null,
  forms: Object.freeze(["terminal"] as CryptoQuestionForm[]),
});

/** Registered hyperparameters of `crypto_updown_gbm@1.1.0`: every form. */
export const EXTENDED_CRYPTO_HYPERPARAMS: CryptoHyperparams = Object.freeze({
  ...DEFAULT_CRYPTO_HYPERPARAMS,
  forms: Object.freeze([...CRYPTO_FORMS]),
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Registry rows are written in camelCase; hand-edited JSON tends to snake. */
function pick(
  raw: Record<string, unknown>,
  camel: string,
  snake: string,
): unknown {
  return raw[camel] ?? raw[snake];
}

function parseCalibration(
  value: unknown,
): { readonly intercept: number; readonly coefficients: number[] } | undefined {
  const record = asRecord(value);
  if (record === null) {
    return undefined;
  }
  const intercept = record.intercept;
  const coefficients = record.coefficients;
  if (typeof intercept !== "number" || !Number.isFinite(intercept)) {
    return undefined;
  }
  if (
    !Array.isArray(coefficients) ||
    coefficients.length !== CRYPTO_FEATURE_WIDTH ||
    !coefficients.every(
      (item): item is number =>
        typeof item === "number" && Number.isFinite(item),
    )
  ) {
    // A correction of the wrong width cannot be replayed against this feature
    // row; applying it would quietly read zeros for the missing columns.
    return undefined;
  }
  return { intercept, coefficients: [...coefficients] };
}

/**
 * Parse the hyperparameters stored with a model version. Every field falls back
 * to the module/config default when it is absent or invalid, and every FALLBACK
 * IS LOGGED with a stable reason code: a registry row that does not parse is an
 * operational fault that must be visible, not a silent change of model.
 */
export function parseCryptoHyperparams(
  raw: unknown,
  config: FundamentalConfig,
): CryptoHyperparams {
  const defaults: CryptoHyperparams = {
    variant: DEFAULT_CRYPTO_HYPERPARAMS.variant,
    ewmaLambdas: config.crypto.ewmaLambdas,
    studentDf: config.crypto.studentDf,
    calibration: null,
    forms: DEFAULT_CRYPTO_HYPERPARAMS.forms,
  };
  const record = asRecord(raw);
  if (record === null) {
    // No stored hyperparameters at all is the legitimate "defaults" case, not
    // a fault: a model registered without overrides gets the config values.
    return defaults;
  }

  let variant = defaults.variant;
  const rawVariant = record.variant;
  if (rawVariant !== undefined) {
    if (rawVariant === "normal" || rawVariant === "student_t") {
      variant = rawVariant;
    } else {
      logLine(
        "warn",
        "CRYPTO_HYPERPARAM_INVALID",
        "crypto_hyperparam_invalid",
        {
          field: "variant",
        },
      );
    }
  }

  let ewmaLambdas = defaults.ewmaLambdas;
  const rawLambdas = pick(record, "ewmaLambdas", "ewma_lambdas");
  if (rawLambdas !== undefined) {
    const valid =
      Array.isArray(rawLambdas) &&
      rawLambdas.length > 0 &&
      rawLambdas.every(
        (item): item is number =>
          typeof item === "number" &&
          Number.isFinite(item) &&
          item >= 0.5 &&
          item <= 0.9999,
      );
    if (valid) {
      ewmaLambdas = [...rawLambdas];
    } else {
      logLine(
        "warn",
        "CRYPTO_HYPERPARAM_INVALID",
        "crypto_hyperparam_invalid",
        {
          field: "ewma_lambdas",
        },
      );
    }
  }

  let studentDf = defaults.studentDf;
  const rawDf = pick(record, "studentDf", "student_df");
  if (rawDf !== undefined) {
    // df <= 2 has infinite variance, so the variance-matched scaling below
    // would not exist; the config's own floor (2.1) is enforced here too.
    if (
      typeof rawDf === "number" &&
      Number.isFinite(rawDf) &&
      rawDf >= 2.1 &&
      rawDf <= 200
    ) {
      studentDf = rawDf;
    } else {
      logLine(
        "warn",
        "CRYPTO_HYPERPARAM_INVALID",
        "crypto_hyperparam_invalid",
        {
          field: "student_df",
        },
      );
    }
  }

  let calibration = defaults.calibration;
  const rawCalibration = record.calibration;
  if (rawCalibration !== undefined && rawCalibration !== null) {
    const parsed = parseCalibration(rawCalibration);
    if (parsed === undefined) {
      logLine(
        "warn",
        "CRYPTO_HYPERPARAM_INVALID",
        "crypto_hyperparam_invalid",
        {
          field: "calibration",
        },
      );
    } else {
      calibration = parsed;
    }
  }

  // A malformed `forms` falls back to terminal-only — the conservative
  // pre-RFC-014 behaviour — never to "every form".
  let forms = defaults.forms;
  const rawForms = record.forms;
  if (rawForms !== undefined) {
    const valid =
      Array.isArray(rawForms) &&
      rawForms.length > 0 &&
      rawForms.every((item): item is CryptoQuestionForm =>
        (CRYPTO_FORMS as readonly string[]).includes(item as string),
      ) &&
      new Set(rawForms).size === rawForms.length;
    if (valid) {
      forms = [...rawForms];
    } else {
      logLine(
        "warn",
        "CRYPTO_HYPERPARAM_INVALID",
        "crypto_hyperparam_invalid",
        {
          field: "forms",
        },
      );
    }
  }

  return { variant, ewmaLambdas, studentDf, calibration, forms };
}

export interface CryptoModelInput {
  readonly spec: CryptoMarketSpec;
  readonly decisionTs: Date;
  /** The recorded-feed sample as-of the decision instant. */
  readonly feed: FeedSample | null;
  /** 1-minute closes of the SAME feed, all buckets already closed. */
  readonly series: FeedSeries;
  /**
   * RFC-019: sample of the SAME feed as-of the updown window open — the
   * strike. Absent or unusable ⇒ abstention, never a strike from another
   * instant.
   */
  readonly openFeed?: FeedSample | null;
  readonly config: FundamentalConfig;
  readonly hyperparams: CryptoHyperparams;
  readonly guard: AsOfGuard;
  /**
   * Registered feature-set of the invoking model version; the 1.0.0 string
   * when absent, so existing callers and fixtures are unchanged.
   */
  readonly featureSetVersion?: string;
}

/**
 * Probability that the terminal level is above the strike, under a driftless
 * log-return distribution of standard deviation `sigma * sqrt(tau)`:
 *
 *   z = ln(S/K) / (sigma * sqrt(tau))
 *   normal    -> Phi(z)
 *   student_t -> F_t(z * sqrt(df/(df-2)), df)
 *
 * The Student-t argument is scaled by the t's own standard deviation so that
 * BOTH variants describe a distribution of the same width — they differ only in
 * tail shape, which is exactly the disagreement the ensemble is meant to price.
 */
function baseMapAbove(z: number, variant: CryptoVariant, df: number): number {
  if (variant === "student_t") {
    return studentTCdf(z * Math.sqrt(df / (df - 2)), df);
  }
  return normalCdf(z);
}

/**
 * Feature row used both at inference and at training, so the two can never
 * drift. Column order is part of CRYPTO_FEATURE_SET_VERSION:
 *   0: logit(q_base) — the base map is the prior the correction adjusts;
 *   1: ln(K/S)       — signed log distance to the strike;
 *   2: sqrt(tau)     — tau in days, the natural scale of the diffusion;
 *   3: EWMA vol      — per-day realized volatility of the resolving feed.
 * Every column is O(1) in magnitude, which matters for a fixed-learning-rate
 * gradient descent.
 */
export function cryptoFeatureRow(base: {
  qBase: number;
  logDistance: number;
  sqrtTau: number;
  volEwma: number;
}): number[] {
  return [logit(base.qBase), base.logDistance, base.sqrtTau, base.volEwma];
}

interface EnsembleMember {
  readonly volDaily: number;
  readonly variant: CryptoVariant;
  readonly q: number;
}

/**
 * Estimate q for one crypto up/down market at one decision instant, or abstain.
 * The model never returns a poisoned number: a missing or stale feed, too
 * little history, a dead feed, an expired horizon or a malformed spec all
 * degrade explicitly, and the caller turns that into the market baseline.
 */
export function estimateCryptoUpdown(input: CryptoModelInput): ModelResult {
  const { spec, decisionTs, series, config, hyperparams, guard } = input;

  // The spec is metadata derived from the question, and its deadline is a
  // SCHEDULED FUTURE instant rather than an observation, so it is recorded with
  // a null source_ts (recording the deadline itself would trip the as-of guard
  // for exactly the wrong reason).
  guard.record("crypto_spec", null, spec);

  if (!hyperparams.forms.includes(spec.form)) {
    // This version does not price this question form. The 1.0.0 generation
    // parses `forms` to ["terminal"], so its served population is exactly what
    // it was before RFC-014.
    return { ok: false, reason: "MODEL_ABSTAINED" };
  }

  if (
    spec.form !== "updown" &&
    (spec.strike === null || !Number.isFinite(spec.strike) || spec.strike <= 0)
  ) {
    return { ok: false, reason: "MODEL_ERROR" };
  }

  const feed = guard.record(
    "crypto_feed_twap",
    input.feed?.sourceTs ?? null,
    input.feed,
  );
  if (
    feed === null ||
    feed.stale ||
    !Number.isFinite(feed.price) ||
    feed.price <= 0
  ) {
    return { ok: false, reason: "FEED_STALE" };
  }

  // A 1-minute aggregate is knowable only once its bucket has closed, so the
  // as-of stamp of the series is the END of its newest bucket.
  const seriesSourceTs =
    series.lastBucket === null
      ? null
      : new Date(series.lastBucket.getTime() + MINUTE_MS);
  const history = guard.record("crypto_feed_series_1m", seriesSourceTs, series);

  if (feed.symbol !== spec.symbol || history.symbol !== spec.symbol) {
    // Wrong symbol: abstain rather than price one asset off another's level.
    return { ok: false, reason: "MODEL_ABSTAINED" };
  }
  if (history.feed !== feed.feed) {
    // Level and series must come from the SAME feed. Mixing a spot series with
    // a TWAP level injects the structural inter-feed offset straight into the
    // volatility and the log distance.
    return { ok: false, reason: "MODEL_ABSTAINED" };
  }
  if (history.points.length < config.crypto.minHistoryMinutes) {
    return { ok: false, reason: "MODEL_ABSTAINED" };
  }

  const tauMs = spec.deadline.getTime() - decisionTs.getTime();
  if (!Number.isFinite(tauMs) || tauMs <= 0) {
    // At or past T there is no horizon left to diffuse over.
    return { ok: false, reason: "MODEL_ABSTAINED" };
  }
  const tauDays = tauMs / DAY_MS;
  const sqrtTau = Math.sqrt(tauDays);

  // Returns across CONSECUTIVE minutes only. An RTDS gap leaves a hole in the
  // series, and pricing the jump across that hole as a one-minute move would
  // inflate the realized volatility — and with it q — for every window that
  // contains the gap.
  const returns = contiguousLogReturns(history.points);
  // A window made mostly of gaps is not a volatility estimate. Requiring the
  // usable returns to reach the configured minimum keeps a shredded feed from
  // producing a confident number out of a handful of points.
  if (returns.length + 1 < config.crypto.minHistoryMinutes) {
    return { ok: false, reason: "MODEL_ABSTAINED" };
  }

  // RFC-019: the updown strike is the recorded feed AT THE WINDOW OPEN. Every
  // failure here is an abstention: a strike from any other instant would be a
  // fabricated input.
  let strike: number;
  let updownRefs: Record<string, unknown> | null = null;
  if (spec.form === "updown") {
    const windowStart = spec.windowStartTs;
    if (windowStart === null || Number.isNaN(windowStart.getTime())) {
      return { ok: false, reason: "MODEL_ABSTAINED" };
    }
    if (windowStart.getTime() > decisionTs.getTime()) {
      // The window has not opened yet: the strike does not exist.
      return { ok: false, reason: "MODEL_ABSTAINED" };
    }
    const open = guard.record(
      "crypto_open_feed",
      input.openFeed?.sourceTs ?? null,
      input.openFeed ?? null,
    );
    if (open === null || !Number.isFinite(open.price) || open.price <= 0) {
      return { ok: false, reason: "MODEL_ABSTAINED" };
    }
    if (open.symbol !== spec.symbol || open.feed !== feed.feed) {
      // The strike must come from the SAME feed as the level and the series;
      // mixing feeds injects the structural inter-feed offset into K/S.
      return { ok: false, reason: "MODEL_ABSTAINED" };
    }
    if (open.sourceTs === null) {
      return { ok: false, reason: "MODEL_ABSTAINED" };
    }
    const strikeAgeMs = windowStart.getTime() - open.sourceTs.getTime();
    if (strikeAgeMs < 0 || strikeAgeMs > config.crypto.maxStrikeAgeMs) {
      // A sample after the open would be look-ahead relative to the strike's
      // instant; one too old means the RTDS had a gap at the open.
      return { ok: false, reason: "MODEL_ABSTAINED" };
    }
    strike = open.price;
    updownRefs = {
      windowStart: windowStart.toISOString(),
      strikeSourceTs: open.sourceTs.toISOString(),
      strikeAgeMs,
    };
  } else {
    // Validated non-null and positive at the top of the function.
    strike = spec.strike as number;
  }

  // RFC-014: barrier gates. The map from now to T only prices touches that
  // pay, so the payoff window must already be open; and a touch that already
  // happened — right now, or inside the scannable window — is q = 1, not a
  // diffusion question.
  //
  // Neutral wording ("hit"/"touch") keeps its neutral direction instead of
  // being resolved against the current level: a side re-derived every cycle
  // INVERTS after a crossing — a "hit $80k" market listed below the barrier
  // reads as touch_up, and the moment the price rallies past $80k it would
  // re-read as a dip and answer "not touched" about the very crossing that
  // settled it. The diffusion map needs only |ln(B/S)|, so direction matters
  // in the touch tests alone, and there the honest neutral test is
  // direction-free containment: the barrier lies inside the bucket's range.
  let touchDetected = false;
  let touchScanBuckets = 0;
  if (spec.form === "barrier") {
    if (
      spec.windowOpensTs !== null &&
      decisionTs.getTime() < spec.windowOpensTs.getTime()
    ) {
      return { ok: false, reason: "MODEL_ABSTAINED" };
    }
    touchDetected =
      spec.direction === "touch_up"
        ? feed.price >= strike
        : spec.direction === "touch_down"
          ? feed.price <= strike
          : feed.price === strike;
    if (!touchDetected && spec.touchScanFrom !== null) {
      // As-of by construction: the series only carries buckets that had
      // already closed at the decision instant, and the scan floor keeps it
      // inside the payoff window (bounded) or after listing (open window).
      const from = spec.touchScanFrom.getTime();
      for (const pt of history.points) {
        if (pt.bucketStart.getTime() < from) {
          continue;
        }
        touchScanBuckets += 1;
        const touched =
          spec.direction === "touch_up"
            ? pt.high >= strike
            : spec.direction === "touch_down"
              ? pt.low <= strike
              : pt.low <= strike && pt.high >= strike;
        if (touched) {
          touchDetected = true;
          break;
        }
      }
    }
  }

  const logDistance = Math.log(strike / feed.price);
  const members: EnsembleMember[] = [];
  for (const lambda of hyperparams.ewmaLambdas) {
    // Per-minute EWMA volatility scaled to the model's day unit. The sqrt-of-
    // time scaling is exact under the same driftless i.i.d. assumption the base
    // map already makes; it introduces no extra hypothesis.
    const volDaily = ewmaVolatility(returns, lambda) * SQRT_MINUTES_PER_DAY;
    if (!Number.isFinite(volDaily) || volDaily <= 0) {
      // A frozen feed has zero realized volatility, and a zero-volatility map
      // claims certainty about a future price. Abstain instead.
      return { ok: false, reason: "MODEL_ABSTAINED" };
    }
    const z = -logDistance / (volDaily * sqrtTau);
    if (!Number.isFinite(z)) {
      return { ok: false, reason: "MODEL_ERROR" };
    }
    for (const variant of ["normal", "student_t"] as const) {
      let q: number;
      if (spec.form === "barrier") {
        if (touchDetected) {
          q = 1;
        } else {
          // RFC-014 first-passage map: by reflection, the touch probability is
          // twice the terminal tail beyond the barrier, saturated at 1 — the
          // same formula for both sides on |ln(B/S)|. ASSUMPTIONS REGISTERED:
          // continuous monitoring OVERSTATES the touch against the discrete
          // resolving feed, while the recorded TWAP smooths the candle wicks
          // the market actually resolves on, which UNDERSTATES it (RFC-014
          // E1/E2). The walk-forward judges the net; neither bias is hidden.
          // For the Student-t member the reflection is the same tail-shape
          // heuristic the terminal ensemble already prices, not an exact law.
          const zAbs = Math.abs(logDistance) / (volDaily * sqrtTau);
          q = Math.min(
            1,
            2 * baseMapAbove(-zAbs, variant, hyperparams.studentDf),
          );
        }
      } else {
        const above = baseMapAbove(z, variant, hyperparams.studentDf);
        // Terminal "above" and updown "up" are both P(level at T >= K).
        q = spec.direction === "below" ? 1 - above : above;
      }
      members.push({ volDaily, variant, q });
    }
  }

  const point = members.filter(
    (member) => member.variant === hyperparams.variant,
  );
  if (point.length === 0) {
    return { ok: false, reason: "MODEL_ERROR" };
  }
  // Averaging the configured variant across lambdas beats picking one lambda
  // arbitrarily; the FULL ensemble (both variants x every lambda) is what the
  // dispersion below is measured on.
  const qBaseRaw = mean(point.map((member) => member.q));
  const volEwma = mean(point.map((member) => member.volDaily));
  // The barrier map saturates at exactly 1 (a detected touch always does), and
  // logit(1) is not finite; the new forms clamp before the feature row. The
  // terminal path keeps the raw value so 1.0.0's bytes cannot change.
  const qBase =
    spec.form === "terminal"
      ? qBaseRaw
      : Math.min(Math.max(qBaseRaw, Q_EPSILON), 1 - Q_EPSILON);

  const row = cryptoFeatureRow({ qBase, logDistance, sqrtTau, volEwma });
  let qCorrected = qBase;
  // An observed touch is a FACT, not a forecast. The logistic correction
  // exists to recalibrate the diffusion map's errors; letting it drag a
  // certainty-by-observation below 1 would overrule data with statistics.
  const observedCertainty = spec.form === "barrier" && touchDetected;
  if (hyperparams.calibration !== null && !observedCertainty) {
    if (hyperparams.calibration.coefficients.length !== row.length) {
      // Caught in the parser as well; a mismatch here means the correction was
      // built against a different feature set version.
      return { ok: false, reason: "MODEL_ERROR" };
    }
    qCorrected = applyLogistic(hyperparams.calibration, row);
  }

  const sigma = Math.max(
    standardDeviation(members.map((member) => member.q)),
    MIN_SIGMA,
  );
  if (!Number.isFinite(qCorrected) || !Number.isFinite(sigma)) {
    return { ok: false, reason: "MODEL_ERROR" };
  }
  const q = Math.min(Math.max(qCorrected, Q_EPSILON), 1 - Q_EPSILON);

  // Provenance of THIS estimate: the exact feed sample and the exact window of
  // closes it was computed from. The two book keys are required by the pinned
  // DataRefs contract but this model never reads a book, so it states that
  // plainly (null venue stamp, the decision instant as the as-of instant); the
  // estimator adds the executable-book refs of the same row alongside them.
  const dataRefs: DataRefs = {
    bookSourceTs: null,
    bookObservedAt: decisionTs.toISOString(),
    feedSourceTs: feed.sourceTs === null ? null : feed.sourceTs.toISOString(),
    feedName: feed.feed,
    feedSymbol: feed.symbol,
    windowFrom:
      history.firstBucket === null ? null : history.firstBucket.toISOString(),
    windowTo:
      history.lastBucket === null ? null : history.lastBucket.toISOString(),
    sampleCount: returns.length + 1,
    feedAgeMs: feed.ageMs,
    strike,
    direction: spec.direction,
    form: spec.form,
    tauDays,
    variant: hyperparams.variant,
    ewmaLambdas: [...hyperparams.ewmaLambdas],
    calibrated: hyperparams.calibration !== null,
    modelFamily: CRYPTO_MODEL_FAMILY,
    ...(spec.form === "barrier"
      ? {
          touchDetected,
          touchScanFrom:
            spec.touchScanFrom === null
              ? null
              : spec.touchScanFrom.toISOString(),
          touchScanBuckets,
          windowOpens:
            spec.windowOpensTs === null
              ? null
              : spec.windowOpensTs.toISOString(),
        }
      : {}),
    ...(updownRefs ?? {}),
  };

  return {
    ok: true,
    value: {
      q,
      sigma,
      featureSetVersion: input.featureSetVersion ?? CRYPTO_FEATURE_SET_VERSION,
      dataRefs,
      // Staleness of the resolving feed is an abstention above, never a served
      // estimate; the book is not an input to this model at all. The feed's
      // age still travels with the output: the interval widens with it, so a
      // fresh-but-not-instant sample must not be reported as instant.
      feedStale: false,
      feedAgeMs: feed.ageMs,
      thinBook: false,
    },
  };
}

export interface CryptoCalibrationFit {
  readonly intercept: number;
  readonly coefficients: readonly number[];
  readonly converged: boolean;
}

/**
 * The refusal fit: the identity map on logit(q_base), i.e. exactly the
 * uncorrected base map. A refusal must never be the all-zero fit, which would
 * collapse every market to 0.5 if it were ever stored and applied.
 */
function identityFit(width: number): CryptoCalibrationFit {
  const coefficients = new Array<number>(Math.max(width, 1)).fill(0);
  coefficients[0] = 1;
  return { intercept: 0, coefficients, converged: false };
}

/**
 * Deterministic walk-forward calibration fit. The caller owns the temporal
 * split (train strictly before validation, never k-fold, never shuffled); this
 * function only turns the rows it is given into coefficients, with no
 * randomness and a fixed iteration budget, so the same samples always produce
 * the same model version.
 *
 * Labels are the resolved outcome in [0, 1]; a 50/50 resolution enters as 0.5,
 * which the logistic loss handles as a half-weight observation of each class.
 */
export function trainCryptoCalibration(
  samples: ReadonlyArray<{
    readonly row: readonly number[];
    readonly label: number;
  }>,
  options: {
    readonly l2?: number;
    readonly iterations?: number;
    readonly learningRate?: number;
  } = {},
): CryptoCalibrationFit {
  const width = samples[0]?.row.length ?? CRYPTO_FEATURE_WIDTH;
  const usable =
    samples.length > 0 &&
    samples.every(
      (sample) =>
        sample.row.length === width &&
        sample.row.every((value) => Number.isFinite(value)) &&
        Number.isFinite(sample.label) &&
        sample.label >= 0 &&
        sample.label <= 1,
    );
  if (!usable) {
    // A malformed training set does not produce a "best effort" correction:
    // it produces the identity, and `converged: false` says so.
    return identityFit(width);
  }

  const fit = fitLogistic(
    samples.map((sample) => [...sample.row]),
    samples.map((sample) => sample.label),
    {
      l2: options.l2 ?? DEFAULT_TRAIN_L2,
      learningRate: options.learningRate ?? DEFAULT_TRAIN_LEARNING_RATE,
      iterations: options.iterations ?? DEFAULT_TRAIN_ITERATIONS,
    },
  );
  if (
    !Number.isFinite(fit.intercept) ||
    !fit.coefficients.every((value) => Number.isFinite(value))
  ) {
    return identityFit(width);
  }
  return {
    intercept: fit.intercept,
    coefficients: [...fit.coefficients],
    converged: fit.converged,
  };
}
