// RFC-012 recomputation pipeline: for a set of markets, synchronize the
// derived artifacts (clarifications, UMA timeline, adjudication samples),
// assemble the as-of feature inputs, compose the score and persist it, then
// run the group-coupling pass (negRisk groups share the worst action/score).
// Everything reads through store.ts, which enforces the look-ahead guard.

import { classifyRuleChange } from "./clarify.js";
import { scoreRulePrecision, type ResolutionLexicon } from "./lexicon.js";
import { composeScore, type MeasuredPriorInput } from "./score.js";
import {
  bookAsOf,
  eventGroupsFor,
  holdersAsOf,
  insertScore,
  loadScoreableMarkets,
  measuredCategoryStats,
  midCloseAt,
  ruleAsOf,
  ruleVersionText,
  statusAsOf,
  upsertMarketState,
  type RuleAsOf,
  type ScoreableMarket,
} from "./store.js";
import {
  deriveGammaTimeline,
  loadGammaEvents,
  persistTimeline,
} from "./timeline.js";
import {
  worstAction,
  type ResolutionAction,
  type ResolutionPool,
  type ScoreTrigger,
} from "./types.js";
import type { ResolutionConfig } from "./config.js";

function logJson(
  level: "info" | "warn" | "error",
  reasonCode: string,
  extra: Record<string, unknown> = {},
): void {
  process.stderr.write(
    `${JSON.stringify({
      level,
      service: "polymarket-resolution",
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      ...extra,
    })}\n`,
  );
}

/** Classify any rule versions not yet classified (task 2). */
export async function syncClarifications(
  pool: ResolutionPool,
  conditionId: string,
  asOf: Date,
): Promise<void> {
  const pending = await pool.query<Record<string, unknown>>(
    `SELECT v.version, v.valid_from
       FROM polymarket_rule_versions v
      WHERE v.condition_id = $1
        AND v.version > 1
        AND v.valid_from <= $2
        AND NOT EXISTS (
          SELECT 1 FROM resolution_clarifications c
           WHERE c.condition_id = v.condition_id AND c.rule_version = v.version
        )
      ORDER BY v.version ASC`,
    [conditionId, asOf],
  );
  for (const row of pending.rows) {
    const version = Number(row.version);
    const validFrom =
      row.valid_from instanceof Date
        ? row.valid_from
        : new Date(String(row.valid_from));
    if (!Number.isFinite(version) || Number.isNaN(validFrom.getTime())) {
      continue;
    }
    const previous = await ruleVersionText(pool, conditionId, version - 1);
    const next = await ruleVersionText(pool, conditionId, version);
    if (previous === null || next === null) {
      continue;
    }
    const verdict = classifyRuleChange(previous, next);
    await pool.query(
      `INSERT INTO resolution_clarifications
         (condition_id, rule_version, classification, changed_fields_json,
          detail_json, valid_from, computed_at)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)
       ON CONFLICT ON CONSTRAINT resolution_clarifications_dedupe DO NOTHING`,
      [
        conditionId,
        version,
        verdict.classification,
        JSON.stringify(verdict.changedFields),
        JSON.stringify(verdict.detail),
        validFrom,
        asOf,
      ],
    );
  }
}

/** Age (ms) of the newest material clarification at the instant. */
async function materialClarificationAgeMs(
  pool: ResolutionPool,
  conditionId: string,
  asOf: Date,
): Promise<number | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT valid_from
       FROM resolution_clarifications
      WHERE condition_id = $1
        AND classification = 'material'
        AND valid_from <= $2
      ORDER BY valid_from DESC
      LIMIT 1`,
    [conditionId, asOf],
  );
  const raw = result.rows[0]?.valid_from;
  const validFrom =
    raw instanceof Date ? raw : typeof raw === "string" ? new Date(raw) : null;
  if (validFrom === null || Number.isNaN(validFrom.getTime())) {
    return null;
  }
  return Math.max(asOf.getTime() - validFrom.getTime(), 0);
}

/** Derive + persist the Gamma-sourced UMA timeline (task 1, v1). */
export async function syncTimeline(
  pool: ResolutionPool,
  conditionId: string,
  rule: RuleAsOf | null,
  questionId: string | null,
  asOf: Date,
): Promise<void> {
  const events = await loadGammaEvents(pool, conditionId, asOf);
  if (events.length === 0) {
    return;
  }
  const entries = deriveGammaTimeline(conditionId, events);
  if (entries.length === 0) {
    return;
  }
  await persistTimeline(pool, entries, {
    questionId,
    bond: rule?.umaBond ?? null,
    customLiveness: rule?.customLiveness ?? null,
  });
}

interface AdjudicationSampleResult {
  readonly premium: number | null;
}

/**
 * Task 7: while the outcome sits in the settlement window (proposed), the
 * executable price's distance to 0/1 is the market-implied adjudication risk.
 * Persisted as a series; also feeds the score's adjudication feature.
 */
async function sampleAdjudicationPremium(
  pool: ResolutionPool,
  market: ScoreableMarket,
  proposedAt: Date | null,
  asOf: Date,
  maxBookAgeMs: number,
): Promise<AdjudicationSampleResult> {
  const tokenId = market.tokenIds[0];
  if (tokenId === undefined) {
    return { premium: null };
  }
  const book = await bookAsOf(pool, tokenId, asOf);
  if (book === null || book.bestBid === null || book.bestAsk === null) {
    return { premium: null };
  }
  const reference = book.sourceTs ?? book.receivedAt;
  if (asOf.getTime() - reference.getTime() > maxBookAgeMs) {
    return { premium: null };
  }
  const mid = (book.bestBid + book.bestAsk) / 2;
  const premium = Math.min(Math.max(mid, 0), Math.max(1 - mid, 0));
  const premiumText = (Math.round(premium * 1e6) / 1e6).toFixed(6);
  try {
    await pool.query(
      `INSERT INTO resolution_adjudication_samples
         (condition_id, token_id, exec_bid, exec_ask, premium, proposed_at, sampled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT ON CONSTRAINT resolution_adjudication_dedupe DO NOTHING`,
      [
        market.conditionId,
        tokenId,
        book.bestBid.toFixed(6),
        book.bestAsk.toFixed(6),
        premiumText,
        proposedAt,
        asOf,
      ],
    );
  } catch (error: unknown) {
    logJson("error", "ADJUDICATION_SAMPLE_FAILED", {
      condition_id: market.conditionId,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
  }
  return { premium };
}

/**
 * Unexplained price jump (task 9): the mid moved more than the threshold
 * within the window while no catalyst (endDate/umaEndDate) was near. The
 * 17%->95% and 9%->100% patterns of the documented manipulations both clear
 * the default 25¢ threshold.
 */
async function detectSuspectJump(
  pool: ResolutionPool,
  market: ScoreableMarket,
  rule: RuleAsOf | null,
  asOf: Date,
  config: ResolutionConfig,
): Promise<boolean> {
  if (!market.inUniverse) {
    return false;
  }
  const tokenId = market.tokenIds[0];
  if (tokenId === undefined) {
    return false;
  }
  const nowMid = await midCloseAt(pool, tokenId, asOf);
  const thenMid = await midCloseAt(
    pool,
    tokenId,
    new Date(asOf.getTime() - config.hardFlags.jumpWindowMs),
  );
  if (nowMid === null || thenMid === null) {
    return false;
  }
  if (Math.abs(nowMid - thenMid) < config.hardFlags.jumpThreshold) {
    return false;
  }
  const catalystMs = config.hardFlags.catalystProximityMin * 60_000;
  const nearCatalyst = [rule?.endDate ?? null, rule?.umaEndDate ?? null].some(
    (date) =>
      date !== null && Math.abs(date.getTime() - asOf.getTime()) <= catalystMs,
  );
  return !nearCatalyst;
}

export interface RecomputeDeps {
  readonly pool: ResolutionPool;
  readonly config: ResolutionConfig;
  readonly lexicon: ResolutionLexicon;
  readonly scoreVersion: string;
}

export interface RecomputeSummary {
  readonly scored: number;
  readonly failed: number;
}

/**
 * Recompute the given markets (or every scoreable market when none are
 * named), then run the group-coupling pass over the touched groups.
 */
export async function recomputeMarkets(
  deps: RecomputeDeps,
  trigger: ScoreTrigger,
  asOf: Date,
  onlyConditionIds: readonly string[] | null = null,
): Promise<RecomputeSummary> {
  const { pool } = deps;
  const all = await loadScoreableMarkets(pool, asOf);
  const targets =
    onlyConditionIds === null
      ? all
      : all.filter((market) => onlyConditionIds.includes(market.conditionId));
  if (targets.length === 0) {
    return { scored: 0, failed: 0 };
  }

  const stats = await measuredCategoryStats(pool, asOf);
  const statsByCategory = new Map<string, MeasuredPriorInput>();
  for (const row of stats) {
    statsByCategory.set(row.category, {
      resolved: row.resolved,
      disputed: row.disputed,
      p5050: row.p5050,
    });
  }

  let scored = 0;
  let failed = 0;
  for (const market of targets) {
    try {
      await recomputeOne(deps, market, statsByCategory, trigger, asOf);
      scored += 1;
    } catch (error: unknown) {
      failed += 1;
      logJson("error", "SCORE_RECOMPUTE_FAILED", {
        condition_id: market.conditionId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  try {
    await groupCouplingPass(
      pool,
      targets.map((market) => market.conditionId),
    );
  } catch (error: unknown) {
    logJson("error", "GROUP_COUPLING_FAILED", {
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
  }
  return { scored, failed };
}

async function questionIdOf(
  pool: ResolutionPool,
  conditionId: string,
): Promise<string | null> {
  const result = await pool.query<Record<string, unknown>>(
    "SELECT question_id FROM polymarket_markets WHERE condition_id = $1",
    [conditionId],
  );
  const value = result.rows[0]?.question_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function recomputeOne(
  deps: RecomputeDeps,
  market: ScoreableMarket,
  statsByCategory: ReadonlyMap<string, MeasuredPriorInput>,
  trigger: ScoreTrigger,
  asOf: Date,
): Promise<void> {
  const { pool, config, lexicon } = deps;
  const rule = await ruleAsOf(pool, market.conditionId, asOf);
  const questionId = await questionIdOf(pool, market.conditionId);

  await syncClarifications(pool, market.conditionId, asOf);
  await syncTimeline(pool, market.conditionId, rule, questionId, asOf);

  const status = await statusAsOf(pool, market.conditionId, asOf);
  const holders = await holdersAsOf(pool, market.conditionId, asOf);
  const clarificationAge = await materialClarificationAgeMs(
    pool,
    market.conditionId,
    asOf,
  );

  const proposalActive = status.status === "proposed";
  let adjudicationPremium: number | null = null;
  if (proposalActive) {
    const sample = await sampleAdjudicationPremium(
      pool,
      market,
      status.proposedAt,
      asOf,
      config.graph.maxBookAgeMs,
    );
    adjudicationPremium = sample.premium;
  }

  const suspectJump = await detectSuspectJump(pool, market, rule, asOf, config);

  const precision =
    rule === null
      ? null
      : scoreRulePrecision(
          {
            question: market.question,
            description: rule.description,
            resolutionSource: rule.resolutionSource,
          },
          lexicon,
        );

  const customLivenessS =
    rule?.customLiveness === null || rule?.customLiveness === undefined
      ? null
      : Number(rule.customLiveness);

  const composed = composeScore(
    {
      conditionId: market.conditionId,
      category: market.category,
      negRisk: market.negRisk,
      precision,
      materialClarificationAgeMs: clarificationAge,
      umaBond: rule?.umaBond ?? null,
      customLivenessS:
        customLivenessS !== null && Number.isFinite(customLivenessS)
          ? customLivenessS
          : null,
      endDate: rule?.endDate ?? null,
      umaEndDate: rule?.umaEndDate ?? null,
      top1Share: holders.top1Share,
      disputeActive: status.status === "disputed",
      proposalActive,
      adjudicationPremium,
      measuredPrior: statsByCategory.get(market.category ?? "unknown") ?? null,
      suspectJump,
    },
    config,
  );

  const scoreId = await insertScore(pool, {
    conditionId: market.conditionId,
    scoreVersion: deps.scoreVersion,
    ruleVersion: rule?.ruleVersion ?? null,
    score: composed.scoreText,
    action: composed.action,
    resolutionBuffer: composed.bufferBase,
    p5050: composed.p5050Text,
    expectedLockupS: composed.expectedLockupS,
    p95LockupS: composed.p95LockupS,
    priorKind: composed.priorKind,
    features: composed.features as unknown as Record<string, unknown>,
    hardFlags: composed.hardFlags,
    justification: composed.justification,
    trigger,
    computedAt: asOf,
  });

  await upsertMarketState(pool, {
    conditionId: market.conditionId,
    scoreId,
    score: composed.scoreText,
    scoreVersion: deps.scoreVersion,
    action: composed.action,
    // The group pass may raise this; a market's own action is the floor.
    effectiveAction: composed.action,
    resolutionBuffer: composed.bufferBase,
    p5050: composed.p5050Text,
    expectedLockupS: composed.expectedLockupS,
    p95LockupS: composed.p95LockupS,
    disputeActive: status.status === "disputed",
    suspectJump,
    hardFlags: composed.hardFlags,
    eventIds: [],
    groupWorstScore: null,
    justification: composed.justification,
    priorKind: composed.priorKind,
    computedAt: asOf,
  });
}

/**
 * Task 15 (coupling): markets in the same event group inherit the group's
 * worst own-action and worst score. Derives from OWN actions only — never
 * from effective ones — so coupling cannot feed back on itself.
 */
export async function groupCouplingPass(
  pool: ResolutionPool,
  touchedConditionIds: readonly string[],
): Promise<void> {
  if (touchedConditionIds.length === 0) {
    return;
  }
  const groups = await eventGroupsFor(pool, touchedConditionIds);
  const byEvent = new Map<string, { members: readonly string[] }>();
  for (const entries of groups.values()) {
    for (const entry of entries) {
      if (!byEvent.has(entry.eventId)) {
        byEvent.set(entry.eventId, { members: entry.members });
      }
    }
  }
  for (const [eventId, group] of byEvent) {
    if (group.members.length === 0) {
      continue;
    }
    const states = await pool.query<Record<string, unknown>>(
      `SELECT condition_id, action, score, event_ids_json
         FROM resolution_market_state
        WHERE condition_id = ANY($1)`,
      [[...group.members]],
    );
    if (states.rows.length === 0) {
      continue;
    }
    let worst: ResolutionAction = "NONE";
    let worstScore: string | null = null;
    for (const row of states.rows) {
      const action = row.action as ResolutionAction;
      worst = worstAction(worst, action);
      const score = typeof row.score === "string" ? row.score : null;
      if (score !== null && (worstScore === null || score > worstScore)) {
        worstScore = score;
      }
    }
    for (const row of states.rows) {
      const conditionId = String(row.condition_id);
      const own = row.action as ResolutionAction;
      const eventIds = mergeEventIds(row.event_ids_json, eventId);
      await pool.query(
        `UPDATE resolution_market_state
            SET effective_action = $2,
                group_worst_score = $3,
                event_ids_json = $4::jsonb,
                updated_at = CURRENT_TIMESTAMP
          WHERE condition_id = $1`,
        [
          conditionId,
          worstAction(own, worst),
          worstScore,
          JSON.stringify(eventIds),
        ],
      );
    }
  }
}

function mergeEventIds(existing: unknown, eventId: string): string[] {
  const ids = new Set<string>();
  if (Array.isArray(existing)) {
    for (const item of existing) {
      if (typeof item === "string") {
        ids.add(item);
      }
    }
  }
  ids.add(eventId);
  return [...ids].sort();
}
