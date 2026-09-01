// RFC-010 model catalog. Every model belongs to exactly ONE category and is
// reached only through this dispatch; there is deliberately no way to register
// a cross-category model, because a universal model is forbidden by the RFC.
//
// A market whose rule does not parse unambiguously into its category's spec is
// EXCLUDED from the model and stays on the market baseline forever. Refusing to
// model is always safe; guessing a strike or a threshold is not.

import type { FundamentalConfig } from "./config.js";
import type {
  AsOfGuard,
  FeedSample,
  FeedSeries,
  MacroCalendarContext,
  MacroReleaseContext,
  MarketContext,
} from "./features.js";
import {
  CRYPTO_EXTENDED_FEATURE_SET_VERSION,
  CRYPTO_EXTENDED_MODEL_VERSION,
  CRYPTO_FEATURE_SET_VERSION,
  CRYPTO_MODEL_FAMILY,
  CRYPTO_MODEL_VERSION,
  DEFAULT_CRYPTO_HYPERPARAMS,
  EXTENDED_CRYPTO_HYPERPARAMS,
  estimateCryptoUpdown,
  parseCryptoHyperparams,
  parseCryptoMarket,
  type CryptoMarketSpec,
} from "./models/crypto-updown.js";
import {
  DEFAULT_MACRO_HYPERPARAMS,
  estimateMacroScheduled,
  MACRO_FEATURE_SET_VERSION,
  MACRO_MODEL_FAMILY,
  MACRO_MODEL_VERSION,
  parseMacroHyperparams,
  parseMacroMarket,
  type MacroMarketSpec,
} from "./models/macro-scheduled.js";
import type {
  FallbackReason,
  FundamentalCategory,
  ModelResult,
} from "./types.js";

export interface CategoryModelDescriptor {
  readonly category: FundamentalCategory;
  readonly family: string;
  readonly version: string;
  readonly featureSetVersion: string;
  /** Hyperparameters the boot registers for this version (immutable after). */
  readonly defaultHyperparams: Record<string, unknown>;
}

/**
 * The catalog is closed: exactly one model FAMILY per category. A family may
 * carry more than one version proving itself in shadow at the same time
 * (RFC-014/RFC-019: 1.0.0 terminal-only and 1.1.0 with every form coexist,
 * so the incumbent's evidence stream is never disturbed by the candidate's).
 */
export const CATEGORY_MODELS: readonly CategoryModelDescriptor[] = [
  {
    category: "crypto_updown",
    family: CRYPTO_MODEL_FAMILY,
    version: CRYPTO_MODEL_VERSION,
    featureSetVersion: CRYPTO_FEATURE_SET_VERSION,
    defaultHyperparams: DEFAULT_CRYPTO_HYPERPARAMS as unknown as Record<
      string,
      unknown
    >,
  },
  {
    category: "crypto_updown",
    family: CRYPTO_MODEL_FAMILY,
    version: CRYPTO_EXTENDED_MODEL_VERSION,
    featureSetVersion: CRYPTO_EXTENDED_FEATURE_SET_VERSION,
    defaultHyperparams: EXTENDED_CRYPTO_HYPERPARAMS as unknown as Record<
      string,
      unknown
    >,
  },
  {
    category: "macro_scheduled",
    family: MACRO_MODEL_FAMILY,
    version: MACRO_MODEL_VERSION,
    featureSetVersion: MACRO_FEATURE_SET_VERSION,
    defaultHyperparams: DEFAULT_MACRO_HYPERPARAMS as unknown as Record<
      string,
      unknown
    >,
  },
];

export function descriptorFor(
  category: FundamentalCategory,
): CategoryModelDescriptor | null {
  return CATEGORY_MODELS.find((entry) => entry.category === category) ?? null;
}

/** External data shared by every market in one estimation cycle. */
export interface CycleData {
  readonly feeds: ReadonlyMap<string, FeedSample>;
  readonly series: ReadonlyMap<string, FeedSeries>;
  readonly calendar: readonly MacroCalendarContext[];
  readonly releases: ReadonlyMap<string, MacroReleaseContext>;
  /**
   * RFC-019: feed samples as-of each updown window open, keyed by
   * `openPriceKey`. Loaded once per distinct (symbol, open instant) per
   * cycle; a missing entry is an abstention downstream, never a default.
   */
  readonly openPrices: ReadonlyMap<string, FeedSample>;
}

/** Key of one updown strike request inside `CycleData.openPrices`. */
export function openPriceKey(symbol: string, at: Date): string {
  return `${symbol}|${at.toISOString()}`;
}

export type MarketPlan =
  | {
      readonly category: "crypto_updown";
      readonly spec: CryptoMarketSpec;
      readonly deadline: Date | null;
    }
  | {
      readonly category: "macro_scheduled";
      readonly spec: MacroMarketSpec;
      readonly deadline: Date | null;
    }
  | {
      readonly category: FundamentalCategory;
      readonly excluded: FallbackReason;
      readonly deadline: Date | null;
    };

export function isExcluded(
  plan: MarketPlan,
): plan is Extract<MarketPlan, { excluded: FallbackReason }> {
  return "excluded" in plan;
}

/**
 * Decide which model, if any, owns a market. The Gamma category is the outer
 * filter; the inner test is whether that category's parser can read the
 * versioned rule without ambiguity.
 */
export function planMarket(
  category: FundamentalCategory | null,
  context: MarketContext,
  calendar: readonly MacroCalendarContext[],
): MarketPlan | null {
  if (category === null) {
    return null;
  }
  if (category === "crypto_updown") {
    const spec = parseCryptoMarket(context);
    return spec === null
      ? {
          category,
          excluded: "RULE_NOT_PARSEABLE",
          deadline: context.endDate,
        }
      : { category, spec, deadline: spec.deadline };
  }
  const parsed = parseMacroMarket(context, calendar);
  return parsed.ok
    ? {
        category,
        spec: parsed.spec,
        deadline: parsed.spec.releaseAt ?? context.endDate,
      }
    : {
        category,
        excluded: "RULE_NOT_PARSEABLE",
        deadline: context.endDate,
      };
}

export interface RunModelInput {
  readonly plan: MarketPlan;
  readonly decisionTs: Date;
  readonly cycle: CycleData;
  readonly config: FundamentalConfig;
  readonly hyperparams: Record<string, unknown>;
  /** Registered feature-set of the invoking version (RFC-014/RFC-019). */
  readonly featureSetVersion?: string;
  readonly thinBook: boolean;
  readonly guard: AsOfGuard;
}

/**
 * Invoke the category model behind its plan. A thrown model is caught here and
 * converted into MODEL_ERROR: an exception must degrade to the baseline, never
 * reach the consumer.
 */
export function runCategoryModel(input: RunModelInput): ModelResult {
  const { plan } = input;
  if (isExcluded(plan)) {
    return { ok: false, reason: plan.excluded };
  }
  try {
    if (plan.category === "crypto_updown") {
      const feed = input.cycle.feeds.get(plan.spec.symbol) ?? null;
      const series = input.cycle.series.get(plan.spec.symbol);
      if (series === undefined) {
        return { ok: false, reason: "MODEL_ABSTAINED" };
      }
      const openFeed =
        plan.spec.form === "updown" && plan.spec.windowStartTs !== null
          ? (input.cycle.openPrices.get(
              openPriceKey(plan.spec.symbol, plan.spec.windowStartTs),
            ) ?? null)
          : null;
      return estimateCryptoUpdown({
        spec: plan.spec,
        decisionTs: input.decisionTs,
        feed,
        series,
        openFeed,
        config: input.config,
        hyperparams: parseCryptoHyperparams(input.hyperparams, input.config),
        guard: input.guard,
        ...(input.featureSetVersion === undefined
          ? {}
          : { featureSetVersion: input.featureSetVersion }),
      });
    }
    const eventKey = plan.spec.eventKey;
    const calendar =
      eventKey === null
        ? null
        : (input.cycle.calendar.find(
            (entry) =>
              entry.eventKey === eventKey && entry.source === plan.spec.source,
          ) ?? null);
    const release =
      eventKey === null
        ? null
        : (input.cycle.releases.get(`${plan.spec.source}:${eventKey}`) ?? null);
    return estimateMacroScheduled({
      spec: plan.spec,
      decisionTs: input.decisionTs,
      calendar,
      release,
      thinBook: input.thinBook,
      config: input.config,
      hyperparams: parseMacroHyperparams(input.hyperparams, input.config),
      guard: input.guard,
    });
  } catch (error: unknown) {
    // The fallback reason is already recorded on the stored row, but the cause
    // must not vanish: a model that starts throwing has to be diagnosable from
    // the logs alone.
    process.stderr.write(
      `${JSON.stringify({
        level: "error",
        service: "polymarket-fundamental",
        timestamp: new Date().toISOString(),
        reason_code: "MODEL_THREW",
        category: plan.category,
        error_name: error instanceof Error ? error.name : "UnknownError",
      })}\n`,
    );
    return { ok: false, reason: "MODEL_ERROR" };
  }
}

/** RTDS symbols referenced by the crypto plans of one cycle. */
export function symbolsOf(plans: Iterable<MarketPlan>): string[] {
  const symbols = new Set<string>();
  for (const plan of plans) {
    if (!isExcluded(plan) && plan.category === "crypto_updown") {
      symbols.add(plan.spec.symbol);
    }
  }
  return [...symbols].sort();
}
