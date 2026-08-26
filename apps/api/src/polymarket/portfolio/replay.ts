// RFC-013 task 7, second half: deterministic replay of the decision log.
//
// The requirement is exact — "replay determinístico do log contra dados
// gravados reproduz as mesmas decisões" and "replay independente do TTL dos
// dados crus" — and both halves of it shape this file.
//
// DETERMINISTIC means every input the engine read is persisted with the
// decision, at the working scale (nine digits), not at the display scale the
// columns use. A six-digit round trip would lose up to 1e-9 per value, which is
// enough to move a size by a share and turn a matching replay into a mismatch
// nobody could explain.
//
// INDEPENDENT OF THE RAW TTL means the replay never reads
// polymarket_book_snapshots, fundamental_estimates or resolution_market_state.
// It reads the decision row: the book excerpt in `book_json`, the scalars in
// `inputs_json.replay`, and the parameter set in
// `portfolio_config_versions.content_json` for the version the decision names.
// Everything the raw retention job may already have pruned is therefore
// irrelevant to whether a decision can be re-derived.
//
// What the replay proves, precisely: given the recorded inputs and the recorded
// config, the engine produces byte-identical output. It does not — and cannot —
// prove the inputs were themselves recorded honestly; that is what the
// no-look-ahead CHECK, the append-only trigger and the as-of queries in store.ts
// are for.

import { formatScaled, parseScaled } from "../fundamental/fixed.js";
import { portfolioConfigHash, type PortfolioConfig } from "./config.js";
import {
  entryDecisionRow,
  exitDecisionRow,
  type EntryDecisionInput,
  type ExitDecisionInput,
} from "./decisionrow.js";
import { evaluateMarket, type EvaluationInput } from "./engine.js";
import { planExit, type PositionExitContext } from "./exitcycle.js";
import type { DecisionRow } from "./store.js";
import type {
  BookLevel,
  DecisionKind,
  MarketSide,
  PortfolioStateName,
} from "./types.js";

/** Working-scale digits. The columns show six; the replay block keeps nine. */
const EXACT_DIGITS = 9;

/** Lossless serialization of a scaled value. */
export function exact(scaled: bigint): string {
  return formatScaled(scaled, EXACT_DIGITS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function scaled(value: unknown): bigint | null {
  const text = str(value);
  return text === null ? null : parseScaled(text);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOr(value: unknown, fallback: number): number {
  return numberOrNull(value) ?? fallback;
}

function dateOrNull(value: unknown): Date | null {
  const text = str(value);
  if (text === null) {
    return null;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function levels(value: unknown): BookLevel[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: BookLevel[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const price = str(item.price);
    const size = str(item.size);
    if (price !== null && size !== null) {
      out.push({ price, size });
    }
  }
  return out;
}

function portfolioState(value: unknown): PortfolioStateName {
  const text = str(value);
  return text === "REDUCE_ONLY" || text === "HALTED" ? text : "NORMAL";
}

function resolutionAction(
  value: unknown,
): "NONE" | "BUFFER" | "VETO" | "CIRCUIT_BREAKER" | null {
  const text = str(value);
  return text === "NONE" ||
    text === "BUFFER" ||
    text === "VETO" ||
    text === "CIRCUIT_BREAKER"
    ? text
    : null;
}

// ---------------------------------------------------------------------------
// Entry path.
// ---------------------------------------------------------------------------

/**
 * Serialize the engine input for one entry evaluation.
 *
 * The book is deliberately NOT copied here: it already lives in the decision's
 * `book_json`, and a third copy of a twenty-level book on every row of a log
 * that grows at one row per market per minute is a real cost against the disk
 * quota. The deserializer takes the levels from `book_json`, which is why the
 * runner must hand the engine exactly the levels it persists.
 */
export function serializeEntryReplay(
  input: EvaluationInput,
): Record<string, unknown> {
  const headroom: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.capHeadroom)) {
    headroom[key] = exact(value);
  }
  return {
    engine: "evaluateMarket",
    book_source: "book_json",
    question: input.question,
    category: input.category,
    q: input.q,
    q_lo: input.qLo,
    q_hi: input.qHi,
    estimate_source: input.estimateSource,
    estimate_age_ms: input.estimateAgeMs,
    book_age_ms: input.bookAgeMs,
    resolution_action: input.resolutionAction,
    resolution_buffer: input.resolutionBuffer,
    p_5050: input.p5050,
    expected_lockup_s: input.expectedLockupS,
    resolution_age_ms: input.resolutionAgeMs,
    rule_precision_multiplier: input.rulePrecisionMultiplier,
    taker_fee_rate: input.takerFeeRate,
    min_order_size: input.minOrderSize,
    buffer_daily_hurdle: input.bufferDailyHurdle,
    portfolio_state: input.portfolioState,
    bankroll: exact(input.bankrollScaled),
    cap_headroom: headroom,
    correlation_multiplier: input.correlationMultiplier,
    breaker_open: input.breakerOpen,
  };
}

/**
 * Rebuild the engine input from the persisted replay block plus `book_json`.
 *
 * Three fields come from the persisted PANEL rather than the replay block:
 * `resolution_source`, `rule_excerpt` and `correlated_markets`. They are pure
 * pass-through — the engine copies them into the panel and no arithmetic reads
 * them — so persisting them twice would cost bytes on every row of a log that
 * grows once per market per minute, and would buy nothing: a comparison of a
 * value against a copy of itself proves nothing either way. The COMPUTED fields
 * are the ones the replay actually checks.
 */
export function deserializeEntryReplay(input: {
  readonly raw: unknown;
  readonly book: unknown;
  readonly panel: unknown;
  readonly config: PortfolioConfig;
  readonly conditionId: string;
  readonly tokenId: string;
  readonly decisionTs: Date;
}): EvaluationInput | null {
  if (!isRecord(input.raw)) {
    return null;
  }
  const raw = input.raw;
  const bookRecord = isRecord(input.book) ? input.book : {};
  const headroomRaw = isRecord(raw.cap_headroom) ? raw.cap_headroom : {};
  const capHeadroom: Record<string, bigint> = {};
  for (const [key, value] of Object.entries(headroomRaw)) {
    const parsed = scaled(value);
    if (parsed === null) {
      return null;
    }
    capHeadroom[key] = parsed;
  }
  const bankrollScaled = scaled(raw.bankroll);
  if (bankrollScaled === null) {
    return null;
  }
  const panel = isRecord(input.panel) ? input.panel : {};
  const correlated = Array.isArray(panel.correlated_markets)
    ? panel.correlated_markets.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  return {
    now: input.decisionTs,
    config: input.config,
    conditionId: input.conditionId,
    tokenId: input.tokenId,
    question: str(raw.question) ?? "",
    category: str(raw.category),
    q: str(raw.q),
    qLo: str(raw.q_lo),
    qHi: str(raw.q_hi),
    estimateSource:
      str(raw.estimate_source) === "MODEL"
        ? "MODEL"
        : str(raw.estimate_source) === "MARKET_BASELINE"
          ? "MARKET_BASELINE"
          : null,
    estimateAgeMs: numberOrNull(raw.estimate_age_ms),
    bids: levels(bookRecord.bids),
    asks: levels(bookRecord.asks),
    bookAgeMs: numberOrNull(raw.book_age_ms),
    resolutionAction: resolutionAction(raw.resolution_action),
    resolutionBuffer: str(raw.resolution_buffer),
    p5050: str(raw.p_5050),
    expectedLockupS: numberOr(raw.expected_lockup_s, 0),
    resolutionAgeMs: numberOrNull(raw.resolution_age_ms),
    rulePrecisionMultiplier: numberOr(raw.rule_precision_multiplier, 1),
    resolutionSource: str(panel.resolution_source),
    ruleExcerpt: str(panel.rule_excerpt),
    correlatedMarkets: correlated,
    takerFeeRate: str(raw.taker_fee_rate),
    minOrderSize: str(raw.min_order_size),
    bufferDailyHurdle: numberOr(raw.buffer_daily_hurdle, 0),
    portfolioState: portfolioState(raw.portfolio_state),
    bankrollScaled,
    capHeadroom,
    correlationMultiplier: numberOr(raw.correlation_multiplier, 1),
    breakerOpen: raw.breaker_open === true,
  };
}

// ---------------------------------------------------------------------------
// Exit path.
// ---------------------------------------------------------------------------

export function serializeExitReplay(input: {
  readonly context: PositionExitContext;
  readonly portfolioState: PortfolioStateName;
}): Record<string, unknown> {
  const c = input.context;
  const maybe = (value: bigint | null): string | null =>
    value === null ? null : exact(value);
  return {
    engine: "planExit",
    book_source: "book_json",
    side: c.side,
    shares: exact(c.sharesScaled),
    cost: exact(c.costScaled),
    opened_at: c.openedAt?.toISOString() ?? null,
    entry_decision_id: c.entryDecisionId,
    entry_decision_ts: c.entryDecisionTs?.toISOString() ?? null,
    entry_prob_lower: maybe(c.entryProbLowerScaled),
    entry_rule_version: c.entryRuleVersion,
    entry_resolution_source: c.entryResolutionSource,
    entry_rule_precision: maybe(c.entryRulePrecisionScaled),
    invalidation_prob_lower_below: maybe(c.invalidationProbLowerBelowScaled),
    prob_lower: maybe(c.probLowerScaled),
    book_age_ms: c.bookAgeMs,
    rule_version: c.ruleVersion,
    resolution_source: c.resolutionSource,
    rule_precision: maybe(c.rulePrecisionScaled),
    clarified_at: c.clarifiedAt?.toISOString() ?? null,
    mins_to_catalyst: c.minsToCatalyst,
    resolution_action: c.resolutionAction,
    dispute_active: c.disputeActive,
    p_5050: maybe(c.p5050Scaled),
    expected_lockup_s: c.expectedLockupS,
    breaker_open: c.breakerOpen,
    portfolio_state: input.portfolioState,
  };
}

export function deserializeExitReplay(input: {
  readonly raw: unknown;
  readonly book: unknown;
  readonly conditionId: string;
  readonly tokenId: string;
}): {
  readonly context: PositionExitContext;
  readonly portfolioState: PortfolioStateName;
} | null {
  if (!isRecord(input.raw)) {
    return null;
  }
  const raw = input.raw;
  const bookRecord = isRecord(input.book) ? input.book : {};
  const shares = scaled(raw.shares);
  const cost = scaled(raw.cost);
  if (shares === null || cost === null) {
    return null;
  }
  const side: MarketSide = str(raw.side) === "NO" ? "NO" : "YES";
  return {
    context: {
      tokenId: input.tokenId,
      conditionId: input.conditionId,
      side,
      sharesScaled: shares,
      costScaled: cost,
      openedAt: dateOrNull(raw.opened_at),
      entryDecisionId: numberOrNull(raw.entry_decision_id),
      entryDecisionTs: dateOrNull(raw.entry_decision_ts),
      entryProbLowerScaled: scaled(raw.entry_prob_lower),
      entryRuleVersion: numberOrNull(raw.entry_rule_version),
      entryResolutionSource: str(raw.entry_resolution_source),
      entryRulePrecisionScaled: scaled(raw.entry_rule_precision),
      invalidationProbLowerBelowScaled: scaled(
        raw.invalidation_prob_lower_below,
      ),
      probLowerScaled: scaled(raw.prob_lower),
      bids: levels(bookRecord.bids),
      asks: levels(bookRecord.asks),
      bookAgeMs: numberOrNull(raw.book_age_ms),
      ruleVersion: numberOrNull(raw.rule_version),
      resolutionSource: str(raw.resolution_source),
      rulePrecisionScaled: scaled(raw.rule_precision),
      clarifiedAt: dateOrNull(raw.clarified_at),
      minsToCatalyst: numberOrNull(raw.mins_to_catalyst),
      resolutionAction: resolutionAction(raw.resolution_action),
      disputeActive: raw.dispute_active === true,
      p5050Scaled: scaled(raw.p_5050),
      expectedLockupS: numberOr(raw.expected_lockup_s, 0),
      breakerOpen: raw.breaker_open === true,
    },
    portfolioState: portfolioState(raw.portfolio_state),
  };
}

// ---------------------------------------------------------------------------
// The replay itself.
// ---------------------------------------------------------------------------

/** A persisted decision, as the log stores it. */
export interface PersistedDecision {
  readonly decisionId: number;
  readonly decisionKind: DecisionKind;
  readonly conditionId: string;
  readonly tokenId: string;
  readonly marketSide: MarketSide;
  readonly orderSide: "BUY" | "SELL";
  readonly decisionTs: Date;
  readonly q: string | null;
  readonly qLo: string | null;
  readonly qHi: string | null;
  readonly estimateSource: "MODEL" | "MARKET_BASELINE" | null;
  readonly execPrice: string | null;
  readonly worstPrice: string | null;
  readonly bestPrice: string | null;
  readonly feeExpected: string | null;
  readonly slippage: string | null;
  readonly capitalCost: string | null;
  readonly resolutionBuffer: string | null;
  readonly costsTotal: string | null;
  readonly safetyMargin: string | null;
  readonly edgeGross: string | null;
  readonly edgeNet: string | null;
  readonly sizeShares: string | null;
  readonly kellyCapShares: string | null;
  readonly notionalUsd: string | null;
  readonly bindingConstraint: string;
  readonly limiters: unknown;
  readonly configVersion: string;
  readonly configHash: string;
  readonly factorMapVersion: string;
  readonly ruleVersion: number | null;
  readonly paramVersion: number | null;
  readonly resolutionScoreVersion: string | null;
  readonly resolutionAction: string | null;
  readonly oldestInputTs: Date;
  readonly newestInputTs: Date;
  readonly book: unknown;
  readonly inputs: unknown;
  readonly outcome: string;
  readonly reasonCode: string | null;
  readonly portfolioState: PortfolioStateName;
}

export interface ReplayDifference {
  readonly field: string;
  readonly persisted: string;
  readonly replayed: string;
}

export type ReplayFailure =
  | "MATCHED"
  | "NO_REPLAY_BLOCK"
  | "CONFIG_HASH_MISMATCH"
  | "UNSUPPORTED_KIND"
  | "OUTPUT_MISMATCH";

export interface ReplayOutcome {
  readonly decisionId: number;
  readonly kind: DecisionKind;
  readonly matched: boolean;
  readonly failure: ReplayFailure;
  readonly differences: readonly ReplayDifference[];
}

/**
 * Fields whose value the ENGINE produced. Provenance the row merely carried
 * (config version, rule version, timestamps, the book excerpt) is excluded on
 * purpose: it is copied into the rebuild, so comparing it would compare a value
 * against itself and report a match that means nothing.
 */
const COMPARED_FIELDS: readonly (keyof DecisionRow)[] = [
  "kind",
  "marketSide",
  "orderSide",
  "execPrice",
  "worstPrice",
  "bestPrice",
  "feeExpected",
  "slippage",
  "capitalCost",
  "resolutionBuffer",
  "costsTotal",
  "safetyMargin",
  "edgeGross",
  "edgeNet",
  "sizeShares",
  "kellyCapShares",
  "notionalUsd",
  "bindingConstraint",
  "outcome",
  "reasonCode",
];

function canonical(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, item: unknown) => {
    if (isRecord(item)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(item).sort()) {
        sorted[key] = item[key];
      }
      return sorted;
    }
    return item;
  });
}

function replayBlock(inputs: unknown): unknown {
  return isRecord(inputs) ? inputs.replay : undefined;
}

function persistedPanel(inputs: unknown): unknown {
  return isRecord(inputs) ? inputs.panel : undefined;
}

function persistedExit(inputs: unknown): unknown {
  return isRecord(inputs) ? inputs.exit : undefined;
}

function diffRows(
  persisted: PersistedDecision,
  rebuilt: DecisionRow,
): ReplayDifference[] {
  const differences: ReplayDifference[] = [];
  const persistedAsRow: Record<string, unknown> = {
    kind: persisted.decisionKind,
    marketSide: persisted.marketSide,
    orderSide: persisted.orderSide,
    execPrice: persisted.execPrice,
    worstPrice: persisted.worstPrice,
    bestPrice: persisted.bestPrice,
    feeExpected: persisted.feeExpected,
    slippage: persisted.slippage,
    capitalCost: persisted.capitalCost,
    resolutionBuffer: persisted.resolutionBuffer,
    costsTotal: persisted.costsTotal,
    safetyMargin: persisted.safetyMargin,
    edgeGross: persisted.edgeGross,
    edgeNet: persisted.edgeNet,
    sizeShares: persisted.sizeShares,
    kellyCapShares: persisted.kellyCapShares,
    notionalUsd: persisted.notionalUsd,
    bindingConstraint: persisted.bindingConstraint,
    outcome: persisted.outcome,
    reasonCode: persisted.reasonCode,
  };
  for (const field of COMPARED_FIELDS) {
    const before = canonical(persistedAsRow[field]);
    const after = canonical(rebuilt[field]);
    if (before !== after) {
      differences.push({ field, persisted: before, replayed: after });
    }
  }
  const limitersBefore = canonical(persisted.limiters);
  const limitersAfter = canonical(rebuilt.limiters);
  if (limitersBefore !== limitersAfter) {
    differences.push({
      field: "limiters_json",
      persisted: limitersBefore,
      replayed: limitersAfter,
    });
  }
  return differences;
}

/**
 * Re-derive one decision from what the log persisted, and diff it.
 *
 * The config is looked up by the version the decision names, and its hash is
 * checked against the hash the decision recorded before anything is computed. A
 * mismatch is not a difference to report — it means the parameter set that
 * produced the decision is not the one in hand, and any comparison after that
 * would be measuring the wrong thing.
 */
export function replayDecision(input: {
  readonly decision: PersistedDecision;
  readonly config: PortfolioConfig;
}): ReplayOutcome {
  const { decision, config } = input;
  const base = { decisionId: decision.decisionId, kind: decision.decisionKind };

  if (portfolioConfigHash(config) !== decision.configHash) {
    return {
      ...base,
      matched: false,
      failure: "CONFIG_HASH_MISMATCH",
      differences: [
        {
          field: "config_hash",
          persisted: decision.configHash,
          replayed: portfolioConfigHash(config),
        },
      ],
    };
  }

  const raw = replayBlock(decision.inputs);
  if (raw === undefined) {
    return {
      ...base,
      matched: false,
      failure: "NO_REPLAY_BLOCK",
      differences: [],
    };
  }

  const provenance = {
    conditionId: decision.conditionId,
    tokenId: decision.tokenId,
    decisionTs: decision.decisionTs,
    configVersion: decision.configVersion,
    configHash: decision.configHash,
    factorMapVersion: decision.factorMapVersion,
    ruleVersion: decision.ruleVersion,
    paramVersion: decision.paramVersion,
    resolutionScoreVersion: decision.resolutionScoreVersion,
    resolutionAction: decision.resolutionAction,
    oldestInputTs: decision.oldestInputTs,
    newestInputTs: decision.newestInputTs,
    book: decision.book,
    portfolioState: decision.portfolioState,
  };

  if (
    decision.decisionKind === "ENTRY" ||
    decision.decisionKind === "VETO" ||
    decision.decisionKind === "RESIZE"
  ) {
    const engineInput = deserializeEntryReplay({
      raw,
      book: decision.book,
      panel: persistedPanel(decision.inputs),
      config,
      conditionId: decision.conditionId,
      tokenId: decision.tokenId,
      decisionTs: decision.decisionTs,
    });
    if (engineInput === null) {
      return {
        ...base,
        matched: false,
        failure: "NO_REPLAY_BLOCK",
        differences: [],
      };
    }
    const evaluation = evaluateMarket(engineInput);
    const context: EntryDecisionInput = {
      ...provenance,
      q: decision.q,
      qLo: decision.qLo,
      qHi: decision.qHi,
      estimateSource: decision.estimateSource,
    };
    const rebuilt = entryDecisionRow({
      evaluation,
      context,
      replay: isRecord(raw) ? raw : {},
    });
    const differences = diffRows(decision, rebuilt);
    const panelBefore = canonical(persistedPanel(decision.inputs));
    const panelAfter = canonical(evaluation.panel);
    if (panelBefore !== panelAfter) {
      differences.push({
        field: "inputs_json.panel",
        persisted: panelBefore,
        replayed: panelAfter,
      });
    }
    return {
      ...base,
      matched: differences.length === 0,
      failure: differences.length === 0 ? "MATCHED" : "OUTPUT_MISMATCH",
      differences,
    };
  }

  if (decision.decisionKind === "EXIT") {
    const restored = deserializeExitReplay({
      raw,
      book: decision.book,
      conditionId: decision.conditionId,
      tokenId: decision.tokenId,
    });
    if (restored === null) {
      return {
        ...base,
        matched: false,
        failure: "NO_REPLAY_BLOCK",
        differences: [],
      };
    }
    const plan = planExit({
      context: restored.context,
      config,
      portfolioState: restored.portfolioState,
    });
    const context: ExitDecisionInput = {
      ...provenance,
      side: restored.context.side,
      q: decision.q,
      qLo: decision.qLo,
      qHi: decision.qHi,
      estimateSource: decision.estimateSource,
    };
    const rebuilt = exitDecisionRow({
      plan,
      context,
      replay: isRecord(raw) ? raw : {},
    });
    const differences = diffRows(decision, rebuilt);
    const exitBefore = canonical(persistedExit(decision.inputs));
    const exitAfter = canonical(
      isRecord(rebuilt.inputs) ? rebuilt.inputs.exit : undefined,
    );
    if (exitBefore !== exitAfter) {
      differences.push({
        field: "inputs_json.exit",
        persisted: exitBefore,
        replayed: exitAfter,
      });
    }
    return {
      ...base,
      matched: differences.length === 0,
      failure: differences.length === 0 ? "MATCHED" : "OUTPUT_MISMATCH",
      differences,
    };
  }

  return {
    ...base,
    matched: false,
    failure: "UNSUPPORTED_KIND",
    differences: [],
  };
}

export interface ReplayAudit {
  readonly total: number;
  readonly matched: number;
  readonly mismatched: readonly ReplayOutcome[];
}

/** Replay a batch and summarize; the runner logs the summary every gate cycle. */
export function replayAudit(input: {
  readonly decisions: readonly PersistedDecision[];
  readonly configByVersion: ReadonlyMap<string, PortfolioConfig>;
}): ReplayAudit {
  const mismatched: ReplayOutcome[] = [];
  let matched = 0;
  for (const decision of input.decisions) {
    const config = input.configByVersion.get(decision.configVersion);
    if (config === undefined) {
      mismatched.push({
        decisionId: decision.decisionId,
        kind: decision.decisionKind,
        matched: false,
        failure: "CONFIG_HASH_MISMATCH",
        differences: [
          {
            field: "config_version",
            persisted: decision.configVersion,
            replayed: "unavailable",
          },
        ],
      });
      continue;
    }
    const outcome = replayDecision({ decision, config });
    if (outcome.matched) {
      matched += 1;
    } else {
      mismatched.push(outcome);
    }
  }
  return { total: input.decisions.length, matched, mismatched };
}
