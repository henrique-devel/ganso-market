// RFC-010 estimation loop: for every token of the RFC-007 universe, at every
// decision instant, write exactly one consumer row (MODEL when a promoted model
// served, MARKET_BASELINE otherwise) plus one shadow row per model still being
// proved. The loop creates NOTHING else — no order, no paper order, no signal.
//
// Everything anomalous degrades: a model that throws, a stale feed, an unknown
// revision, an open UMA dispute. Only an invalid book produces silence, and
// that silence is explicit (the consumer treats an absent estimate as a veto).

import type { DatabasePool } from "../../database.js";
import {
  planMarket,
  runCategoryModel,
  symbolsOf,
  type CycleData,
  type MarketPlan,
} from "./catalog.js";
import type { FundamentalConfig } from "./config.js";
import { decideEstimate, type ModelAttempt } from "./estimate.js";
import {
  AsOfGuard,
  FEATURE_SET_VERSION,
  gammaCategoryToModelCategory,
  loadBookView,
  loadFeedSamples,
  loadFeedSeries,
  loadMacroCalendar,
  loadMacroReleases,
  loadMarketContexts,
  type FeedSample,
  type FeedSeries,
  type MacroCalendarContext,
  type MacroReleaseContext,
  type QueryPool,
} from "./features.js";
import { computeMicroprice, isThinBook } from "./microprice.js";
import { activeModelFor, shadowModelsFor } from "./registry.js";
import type {
  Estimate,
  FundamentalCategory,
  ModelRecord,
  ModelResult,
} from "./types.js";

const SERVICE = "polymarket-estimator";

/** Minutes of one-minute feed history pulled per symbol per cycle. */
const FEED_SERIES_MINUTES = 1_440;

export interface EstimatorDeps {
  readonly pool: DatabasePool;
  readonly config: FundamentalConfig;
  /** Revision of the running code; null blocks every MODEL row. */
  readonly gitSha: string | null;
  readonly clock?: () => Date;
}

export interface EstimatorCycleReport {
  readonly decisionTs: Date;
  readonly markets: number;
  readonly tokensConsidered: number;
  readonly tokensRateLimited: number;
  readonly consumerRows: number;
  readonly shadowRows: number;
  readonly absent: number;
  readonly absentReasons: Record<string, number>;
  readonly fallbackReasons: Record<string, number>;
}

export interface Estimator {
  runCycle(): Promise<EstimatorCycleReport>;
}

function logJson(
  level: "info" | "warn" | "error",
  reasonCode: string,
  extra: Record<string, unknown> = {},
): void {
  process.stderr.write(
    `${JSON.stringify({
      level,
      service: SERVICE,
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      ...extra,
    })}\n`,
  );
}

interface UniverseMarket {
  readonly conditionId: string;
  readonly category: FundamentalCategory | null;
  readonly tokenIds: readonly string[];
}

/** Markets whose latest universe action at `at` is `enter`. */
export async function loadUniverse(
  pool: QueryPool,
  at: Date,
): Promise<UniverseMarket[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT m.condition_id, m.category, m.clob_token_ids
       FROM polymarket_markets m
       JOIN (
         SELECT condition_id
           FROM (
             SELECT DISTINCT ON (condition_id) condition_id, action
               FROM polymarket_universe_log
              WHERE at <= $1 AND action IN ('enter', 'exit')
              ORDER BY condition_id, at DESC, universe_log_id DESC
           ) latest
          WHERE action = 'enter'
       ) member ON member.condition_id = m.condition_id
      WHERE m.closed IS NOT TRUE
      ORDER BY m.condition_id`,
    [at],
  );
  return result.rows.map((row) => {
    let tokenIds: string[] = [];
    const raw = row.clob_token_ids;
    let parsed: unknown = raw;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = [];
      }
    }
    if (Array.isArray(parsed)) {
      tokenIds = parsed.filter(
        (item): item is string => typeof item === "string",
      );
    }
    return {
      conditionId: String(row.condition_id),
      category: gammaCategoryToModelCategory(
        typeof row.category === "string" ? row.category : null,
      ),
      tokenIds,
    };
  });
}

/** Tokens whose newest estimate is younger than the per-token rate limit. */
async function rateLimitedTokens(
  pool: QueryPool,
  tokenIds: readonly string[],
  decisionTs: Date,
  minGapMs: number,
): Promise<Set<string>> {
  if (tokenIds.length === 0 || minGapMs <= 0) {
    return new Set();
  }
  const since = new Date(decisionTs.getTime() - minGapMs);
  const result = await pool.query<Record<string, unknown>>(
    `SELECT DISTINCT token_id
       FROM fundamental_estimates
      WHERE token_id = ANY($1::text[])
        AND decision_ts > $2
        AND decision_ts <= $3`,
    [[...tokenIds], since, decisionTs],
  );
  return new Set(result.rows.map((row) => String(row.token_id)));
}

function increment(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

/** Insert a batch of estimates; a duplicate (token, instant, model) is a no-op. */
export async function insertEstimates(
  pool: QueryPool,
  estimates: readonly Estimate[],
): Promise<number> {
  if (estimates.length === 0) {
    return 0;
  }
  const columns = 23;
  const values: unknown[] = [];
  const tuples: string[] = [];
  for (const estimate of estimates) {
    const offset = values.length;
    tuples.push(
      `(${Array.from({ length: columns }, (_unused, index) => `$${offset + index + 1}`).join(", ")})`,
    );
    values.push(
      estimate.marketId,
      estimate.tokenId,
      estimate.category,
      estimate.decisionTs,
      estimate.q,
      estimate.qLo,
      estimate.qHi,
      estimate.source,
      estimate.status,
      estimate.provenance?.modelId ?? null,
      estimate.provenance?.modelVersion ?? null,
      estimate.provenance?.featureSetVersion ?? null,
      estimate.provenance?.gitSha ?? null,
      JSON.stringify(estimate.dataRefs),
      estimate.marketProb,
      estimate.execSpread,
      estimate.flags.bookStale,
      estimate.flags.feedStale,
      estimate.flags.thinBook,
      estimate.flags.ruleChangedRecently,
      estimate.fallbackReason,
      estimate.intervalVersion,
      estimate.micropriceVersion,
    );
  }
  const result = await pool.query(
    `INSERT INTO fundamental_estimates (
       market_id, token_id, category, decision_ts, q, q_lo, q_hi, source, status,
       model_id, model_version, feature_set_version, git_sha, data_refs,
       market_prob, exec_spread, book_stale, feed_stale, thin_book,
       rule_changed_recently, fallback_reason, interval_version, microprice_version
     ) VALUES ${tuples.join(", ")}
     ON CONFLICT (token_id, decision_ts, COALESCE(model_id, '')) DO NOTHING`,
    values,
  );
  return result.rowCount;
}

async function loadCycleData(
  pool: QueryPool,
  plans: readonly MarketPlan[],
  decisionTs: Date,
  config: FundamentalConfig,
): Promise<CycleData> {
  const symbols = symbolsOf(plans);
  const feeds: Map<string, FeedSample> = await loadFeedSamples(
    pool,
    symbols,
    decisionTs,
    config.crypto.maxFeedAgeMs,
  );
  const series = new Map<string, FeedSeries>();
  for (const symbol of symbols) {
    // The volatility history must come from the SAME feed as the level, so a
    // symbol whose sample is missing is simply left without a series and its
    // model abstains.
    const sample = feeds.get(symbol);
    if (sample === undefined) {
      continue;
    }
    series.set(
      symbol,
      await loadFeedSeries(
        pool,
        symbol,
        sample.feed,
        decisionTs,
        FEED_SERIES_MINUTES,
      ),
    );
  }

  const needsMacro = plans.some((plan) => plan.category === "macro_scheduled");
  const calendar: MacroCalendarContext[] = needsMacro
    ? await loadMacroCalendar(pool, decisionTs, config.macro.maxCalendarAgeMs)
    : [];
  const releases: Map<string, MacroReleaseContext> = needsMacro
    ? await loadMacroReleases(pool, decisionTs)
    : new Map();

  return { feeds, series, calendar, releases };
}

interface CategoryModels {
  readonly active: ModelRecord | null;
  readonly shadow: readonly ModelRecord[];
}

function attemptFor(
  model: ModelRecord,
  result: ModelResult,
  outcomeIndex: number,
): ModelAttempt {
  // Models estimate P(YES). A market's second token is the complementary
  // outcome, so its probability is the complement; the dispersion is unchanged.
  const adjusted: ModelResult =
    result.ok && outcomeIndex !== 0
      ? { ok: true, value: { ...result.value, q: 1 - result.value.q } }
      : result;
  return {
    modelId: model.modelId,
    modelVersion: model.version,
    status: model.status,
    result: adjusted,
  };
}

export function createEstimator(deps: EstimatorDeps): Estimator {
  const pool = deps.pool;
  const clock = deps.clock ?? ((): Date => new Date());

  return {
    async runCycle(): Promise<EstimatorCycleReport> {
      const decisionTs = clock();
      const universe = await loadUniverse(pool, decisionTs);
      const contexts = await loadMarketContexts(
        pool,
        universe.map((market) => market.conditionId),
        decisionTs,
        deps.config.ruleChangeWindowMs,
      );

      const modelled = universe.filter((market) => market.category !== null);
      const plans = new Map<string, MarketPlan>();
      // The macro calendar is needed to plan macro markets, so it is loaded
      // once up front and reused by loadCycleData.
      const calendar = modelled.some(
        (market) => market.category === "macro_scheduled",
      )
        ? await loadMacroCalendar(
            pool,
            decisionTs,
            deps.config.macro.maxCalendarAgeMs,
          )
        : [];
      for (const market of modelled) {
        const context = contexts.get(market.conditionId);
        if (context === undefined) {
          continue;
        }
        const plan = planMarket(market.category, context, calendar);
        if (plan !== null) {
          plans.set(market.conditionId, plan);
        }
      }

      const cycle = await loadCycleData(
        pool,
        [...plans.values()],
        decisionTs,
        deps.config,
      );

      const modelsByCategory = new Map<FundamentalCategory, CategoryModels>();
      for (const category of new Set(
        modelled.map((market) => market.category),
      )) {
        if (category === null) {
          continue;
        }
        modelsByCategory.set(category, {
          active: await activeModelFor(pool, category),
          shadow: await shadowModelsFor(pool, category),
        });
      }

      const allTokens = universe.flatMap((market) => [...market.tokenIds]);
      const limited = await rateLimitedTokens(
        pool,
        allTokens,
        decisionTs,
        deps.config.minEstimateGapMs,
      );

      const absentReasons: Record<string, number> = {};
      const fallbackReasons: Record<string, number> = {};
      const pending: Estimate[] = [];
      let tokensConsidered = 0;
      let shadowRows = 0;
      let absent = 0;

      for (const market of universe) {
        const context = contexts.get(market.conditionId);
        if (context === undefined || market.category === null) {
          continue;
        }
        const plan = plans.get(market.conditionId);
        const models = modelsByCategory.get(market.category) ?? {
          active: null,
          shadow: [],
        };
        const deadline = plan?.deadline ?? context.endDate;

        for (const [outcomeIndex, tokenId] of market.tokenIds.entries()) {
          if (limited.has(tokenId)) {
            continue;
          }
          tokensConsidered += 1;
          const book = await loadBookView(pool, tokenId, decisionTs);
          // The macro model must know whether the book is thin, and thinness
          // comes from the microprice. It is computed here from the same book
          // decideEstimate will use; the function is deterministic, so the two
          // computations always agree.
          const priced =
            book === null
              ? null
              : computeMicroprice(book, decisionTs, {
                  sRefUsd: deps.config.sRefUsd,
                  maxBookAgeMs: deps.config.maxBookAgeMs,
                  maxExecSpread: deps.config.maxExecSpread,
                });
          const thinBook =
            priced !== null && priced.ok
              ? isThinBook(priced.value, deps.config.thinBookMultiple)
              : false;

          const evaluate = (model: ModelRecord | null): ModelAttempt | null => {
            if (model === null || plan === undefined) {
              return null;
            }
            const guard = new AsOfGuard(decisionTs);
            const result = runCategoryModel({
              plan,
              decisionTs,
              cycle,
              config: deps.config,
              hyperparams: model.hyperparams,
              thinBook,
              guard,
            });
            return attemptFor(model, result, outcomeIndex);
          };

          const decision = decideEstimate({
            marketId: market.conditionId,
            tokenId,
            category: market.category,
            decisionTs,
            book,
            activeModel: evaluate(models.active),
            shadowModels: models.shadow
              .map((model) => evaluate(model))
              .filter((attempt): attempt is ModelAttempt => attempt !== null),
            gitSha: deps.gitSha,
            umaDisputeActive: context.umaDisputeActive,
            ruleChangedRecently: context.ruleChangedRecently,
            timeToResolutionMs:
              deadline === null
                ? null
                : deadline.getTime() - decisionTs.getTime(),
            config: deps.config,
          });

          if (decision.kind === "absent") {
            absent += 1;
            increment(absentReasons, decision.reason);
            continue;
          }
          pending.push(decision.consumer);
          if (decision.consumer.fallbackReason !== null) {
            increment(fallbackReasons, decision.consumer.fallbackReason);
          }
          for (const row of decision.shadow) {
            pending.push(row);
            shadowRows += 1;
          }
        }
      }

      const written = await insertEstimates(pool, pending);
      const report: EstimatorCycleReport = {
        decisionTs,
        markets: universe.length,
        tokensConsidered,
        tokensRateLimited: limited.size,
        consumerRows: pending.length - shadowRows,
        shadowRows,
        absent,
        absentReasons,
        fallbackReasons,
      };
      logJson("info", "ESTIMATOR_CYCLE", {
        decision_ts: decisionTs.toISOString(),
        feature_set_version: FEATURE_SET_VERSION,
        rows_written: written,
        markets: report.markets,
        tokens_considered: report.tokensConsidered,
        tokens_rate_limited: report.tokensRateLimited,
        consumer_rows: report.consumerRows,
        shadow_rows: report.shadowRows,
        absent: report.absent,
        absent_reasons: report.absentReasons,
        fallback_reasons: report.fallbackReasons,
      });
      return report;
    },
  };
}
