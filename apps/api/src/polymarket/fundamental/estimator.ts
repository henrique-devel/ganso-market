// RFC-010 estimation loop: for every token of the RFC-007 universe, at every
// decision instant, write exactly one consumer row (MODEL when a promoted model
// served, MARKET_BASELINE otherwise) plus one shadow row per model still being
// proved. The loop creates NOTHING else — no order, no paper order, no signal.
//
// Everything anomalous degrades: a model that throws, a stale feed, an unknown
// revision, an open UMA dispute. Only an invalid book produces silence, and
// that silence is explicit (the consumer treats an absent estimate as a veto).

import type { DatabasePool } from "../../database.js";
import { horizonBucket } from "./interval.js";
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

const SERVICE = "polymarket-fundamental";

/** Minutes of one-minute feed history pulled per symbol per cycle. */
const FEED_SERIES_MINUTES = 1_440;

/** Rows per INSERT statement; 23 bind parameters each, well under 65535. */
const INSERT_CHUNK_ROWS = 1_000;

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
  /** Tokens whose own read or decision failed; the cycle continued without them. */
  readonly tokenFailures: number;
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
  /** Modelled category, or null when no model owns this market. */
  readonly category: FundamentalCategory | null;
  /** The raw Gamma category, recorded on the estimate row either way. */
  readonly gammaCategory: string | null;
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
    const gammaCategory =
      typeof row.category === "string" ? row.category : null;
    return {
      conditionId: String(row.condition_id),
      category: gammaCategoryToModelCategory(gammaCategory),
      gammaCategory,
      tokenIds,
    };
  });
}

/**
 * Newest estimate per token, bounded by the coarsest cadence so the scan stays
 * small. The cadence itself is per token (it depends on the market's horizon),
 * so the decision is made by the caller against this map rather than by a
 * single SQL window.
 */
async function lastEstimateByToken(
  pool: QueryPool,
  tokenIds: readonly string[],
  decisionTs: Date,
  maxGapMs: number,
): Promise<Map<string, number>> {
  const last = new Map<string, number>();
  if (tokenIds.length === 0 || maxGapMs <= 0) {
    return last;
  }
  const since = new Date(decisionTs.getTime() - maxGapMs);
  const result = await pool.query<Record<string, unknown>>(
    `SELECT token_id, max(decision_ts) AS last_ts
       FROM fundamental_estimates
      WHERE token_id = ANY($1::text[])
        AND decision_ts > $2
        AND decision_ts <= $3
      GROUP BY token_id`,
    [[...tokenIds], since, decisionTs],
  );
  for (const row of result.rows) {
    const value = row.last_ts;
    const at =
      value instanceof Date
        ? value.getTime()
        : typeof value === "string"
          ? Date.parse(value)
          : Number.NaN;
    if (Number.isFinite(at)) {
      last.set(String(row.token_id), at);
    }
  }
  return last;
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
  // PostgreSQL accepts at most 65535 bind parameters per statement. At 23
  // parameters per row that is 2849 rows, and a single oversized statement
  // would fail and lose the WHOLE cycle rather than the overflow. Chunk.
  if (estimates.length > INSERT_CHUNK_ROWS) {
    let written = 0;
    for (let start = 0; start < estimates.length; start += INSERT_CHUNK_ROWS) {
      written += await insertEstimates(
        pool,
        estimates.slice(start, start + INSERT_CHUNK_ROWS),
      );
    }
    return written;
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
  /**
   * Last instant each token was EVALUATED, not just written. An absent
   * estimate writes no row on purpose, so keying the cadence on stored rows
   * alone would re-evaluate a token whose book is permanently invalid on every
   * single tick — at a 10 s tick that is six book reads a minute, per token,
   * that can never produce anything. The cadence governs attempts.
   *
   * In memory by design: it is a rate limiter, not a record. After a restart
   * every token is attempted once more, which is harmless.
   */
  const lastAttemptMs = new Map<string, number>();

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

      // Which tokens are DUE this tick. The cadence is per horizon bucket, so
      // a market resolving within the hour is sampled every 10 s while one
      // resolving in months is sampled every 10 min. Deciding this BEFORE any
      // expensive read is what makes a 10 s loop affordable: on most ticks
      // almost nothing is due, and the cycle costs one query.
      const cadence = deps.config.estimateCadenceMs;
      const maxGapMs = Math.max(...Object.values(cadence));
      const allTokens = universe.flatMap((market) => [...market.tokenIds]);
      const lastEstimate = await lastEstimateByToken(
        pool,
        allTokens,
        decisionTs,
        maxGapMs,
      );
      const deadlineOf = (market: UniverseMarket): Date | null =>
        plans.get(market.conditionId)?.deadline ??
        contexts.get(market.conditionId)?.endDate ??
        null;
      const isDue = (market: UniverseMarket, tokenId: string): boolean => {
        const deadline = deadlineOf(market);
        const bucket = horizonBucket(
          deadline === null ? null : deadline.getTime() - decisionTs.getTime(),
        );
        const previous = Math.max(
          lastEstimate.get(tokenId) ?? 0,
          lastAttemptMs.get(tokenId) ?? 0,
        );
        return (
          previous === 0 || decisionTs.getTime() - previous >= cadence[bucket]
        );
      };
      const dueTokens = new Set<string>();
      for (const market of universe) {
        for (const tokenId of market.tokenIds) {
          if (isDue(market, tokenId)) {
            dueTokens.add(tokenId);
          }
        }
      }
      const rateLimited = allTokens.length - dueTokens.size;

      // Forget tokens that left the universe so the map cannot grow forever.
      if (lastAttemptMs.size > allTokens.length * 2) {
        const current = new Set(allTokens);
        for (const tokenId of [...lastAttemptMs.keys()]) {
          if (!current.has(tokenId)) {
            lastAttemptMs.delete(tokenId);
          }
        }
      }

      if (dueTokens.size === 0) {
        // Nothing to price: skip the feed windows entirely. Loading a day of
        // one-minute closes per symbol on every 10 s tick would cost far more
        // than the estimates it would produce.
        return {
          decisionTs,
          markets: universe.length,
          tokensConsidered: 0,
          tokensRateLimited: rateLimited,
          consumerRows: 0,
          shadowRows: 0,
          absent: 0,
          absentReasons: {},
          fallbackReasons: {},
          tokenFailures: 0,
        };
      }

      // Only the plans of markets with a due token: the feed series is the
      // expensive read and it is fetched per symbol.
      const duePlans = universe
        .filter((market) => market.tokenIds.some((id) => dueTokens.has(id)))
        .flatMap((market) => {
          const plan = plans.get(market.conditionId);
          return plan === undefined ? [] : [plan];
        });
      const cycle = await loadCycleData(
        pool,
        duePlans,
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

      const absentReasons: Record<string, number> = {};
      const fallbackReasons: Record<string, number> = {};
      const pending: Estimate[] = [];
      let tokensConsidered = 0;
      let shadowRows = 0;
      let absent = 0;
      let tokenFailures = 0;

      for (const market of universe) {
        const context = contexts.get(market.conditionId);
        if (context === undefined) {
          continue;
        }
        // A market whose category no model owns still gets a baseline estimate
        // for every one of its tokens: the acceptance criterion is coverage of
        // the WHOLE universe, and silently skipping a category would look like
        // "no opportunity" instead of "no model".
        // The models estimate P(YES) for a binary market and the second token
        // is priced as the complement. A market with any other number of
        // outcome tokens has no such complement, so no model may serve it: it
        // gets the baseline for every token instead of two contradictory rows.
        const categoryModelled =
          market.category !== null && market.tokenIds.length === 2;
        const recordedCategory =
          market.category ?? market.gammaCategory ?? "unmodelled";
        const plan = plans.get(market.conditionId);
        const models =
          market.category === null
            ? { active: null, shadow: [] }
            : (modelsByCategory.get(market.category) ?? {
                active: null,
                shadow: [],
              });
        const deadline = plan?.deadline ?? context.endDate;

        for (const [outcomeIndex, tokenId] of market.tokenIds.entries()) {
          if (!dueTokens.has(tokenId)) {
            continue;
          }
          tokensConsidered += 1;
          // Recorded before the work, so a token that throws is not retried on
          // the very next tick either.
          lastAttemptMs.set(tokenId, decisionTs.getTime());
          try {
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

            const evaluate = (
              model: ModelRecord | null,
            ): ModelAttempt | null => {
              if (model === null || plan === undefined || !categoryModelled) {
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
              category: recordedCategory,
              categoryModelled,
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
          } catch (error: unknown) {
            // One token failing (a transient read error, a malformed recorded
            // book) must cost exactly that token. Letting it escape would
            // discard every estimate the cycle had already computed.
            tokenFailures += 1;
            logJson("error", "TOKEN_CYCLE_FAILED", {
              token_id: tokenId,
              market_id: market.conditionId,
              error_name: error instanceof Error ? error.name : "UnknownError",
            });
          }
        }
      }

      const written = await insertEstimates(pool, pending);
      const report: EstimatorCycleReport = {
        decisionTs,
        markets: universe.length,
        tokensConsidered,
        tokensRateLimited: rateLimited,
        consumerRows: pending.length - shadowRows,
        shadowRows,
        absent,
        absentReasons,
        fallbackReasons,
        tokenFailures,
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
        token_failures: report.tokenFailures,
      });
      return report;
    },
  };
}
