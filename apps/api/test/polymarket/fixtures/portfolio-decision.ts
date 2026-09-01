// RFC-017: the decision fixture both sweep tests build on.
//
// A shared file rather than an export from one test into another: importing a
// `.test.ts` re-runs its whole suite in the importer, which double-counts every
// assertion and makes a failure report point at the wrong file.
//
// The lockup here is 180 days, and production's are 38 minutes and 3.67 hours.
// That is deliberate: at the horizons the book actually trades,
// `capitalCostAnnual` cannot flip anything at any rate in the candidate list (it
// would take ~5400% a.a.), so a fixture built from production values would test
// that the sweep reports zero — which is also what a sweep that did nothing at
// all would report. The long lockup is what makes the flip observable, and
// therefore what makes the zero meaningful.

import { parseScaled } from "../../../src/polymarket/fundamental/fixed.js";
import {
  DEFAULT_PORTFOLIO_CONFIG,
  portfolioConfigHash,
} from "../../../src/polymarket/portfolio/config.js";
import { entryDecisionRow } from "../../../src/polymarket/portfolio/decisionrow.js";
import {
  evaluateMarket,
  type EvaluationInput,
} from "../../../src/polymarket/portfolio/engine.js";
import {
  serializeEntryReplay,
  type PersistedDecision,
} from "../../../src/polymarket/portfolio/replay.js";
import type { DecisionRow } from "../../../src/polymarket/portfolio/store.js";
import type { PortfolioStateName } from "../../../src/polymarket/portfolio/types.js";

function s(value: string): bigint {
  const parsed = parseScaled(value);
  if (parsed === null) {
    throw new Error(`unparseable fixture value: ${value}`);
  }
  return parsed;
}

export const DECISION_TS = new Date("2026-08-30T12:00:00Z");
export const CONFIG = DEFAULT_PORTFOLIO_CONFIG;
export const CONFIG_HASH = portfolioConfigHash(CONFIG);
export const LOCKUP_180_DAYS_S = 180 * 86_400;

/**
 * An entrable market with a thin margin and a long lockup.
 *
 * q_lo 0.53 against an executable 0.50 leaves a gross lower edge of 0.03 with no
 * resolution buffer, so `edge_net` sits at 0.03 — clear of the 0.01 safety
 * margin and of the 0.02 `edgeLiqMin`, and close enough to both that a capital
 * charge can be watched crossing each in turn.
 */
const ENTRY_INPUT: EvaluationInput = {
  now: DECISION_TS,
  config: CONFIG,
  conditionId: "0xa",
  tokenId: "t1",
  question: "Will BTC be above $88,000 in six months?",
  category: "crypto",
  q: "0.550000",
  qLo: "0.530000",
  qHi: "0.580000",
  estimateSource: "MARKET_BASELINE",
  estimateAgeMs: 5_000,
  bids: [
    { price: "0.49", size: "500" },
    { price: "0.48", size: "800" },
  ],
  asks: [
    { price: "0.50", size: "500" },
    { price: "0.52", size: "800" },
  ],
  bookAgeMs: 1_000,
  resolutionAction: "NONE",
  resolutionBuffer: "0.000000",
  p5050: "0.010000",
  expectedLockupS: LOCKUP_180_DAYS_S,
  resolutionAgeMs: 60_000,
  rulePrecisionMultiplier: 1,
  resolutionSource: "UMA:0xadapter",
  ruleExcerpt: "Resolves YES if BTC closes above $88,000.",
  correlatedMarkets: [],
  takerFeeRate: "0.070000",
  minOrderSize: "5",
  bufferDailyHurdle: 0.0005,
  portfolioState: "NORMAL",
  bankrollScaled: s("1000"),
  capHeadroom: {
    entrada: s("20"),
    mercado: s("50"),
    grupoCorrelacionado: s("200"),
    categoria: s("350"),
    fonteResolucao: s("250"),
    catalisadorJanela: s("250"),
    capitalBloqueado: s("600"),
  },
  correlationMultiplier: 1,
  breakerOpen: false,
};

const PROVENANCE = {
  conditionId: "0xa",
  tokenId: "t1",
  decisionTs: DECISION_TS,
  configVersion: CONFIG.version,
  configHash: CONFIG_HASH,
  factorMapVersion: "1.0.0",
  ruleVersion: 3,
  paramVersion: 2,
  resolutionScoreVersion: "1.1.1",
  resolutionAction: "NONE",
  oldestInputTs: new Date("2026-08-30T11:59:00Z"),
  newestInputTs: new Date("2026-08-30T11:59:59Z"),
  portfolioState: "NORMAL" as PortfolioStateName,
};

function persist(row: DecisionRow, decisionId: number): PersistedDecision {
  const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  return {
    decisionId,
    decisionKind: row.kind,
    conditionId: row.conditionId,
    tokenId: row.tokenId,
    marketSide: row.marketSide,
    orderSide: row.orderSide,
    decisionTs: row.decisionTs,
    q: row.q,
    qLo: row.qLo,
    qHi: row.qHi,
    estimateSource: row.estimateSource,
    execPrice: row.execPrice,
    worstPrice: row.worstPrice,
    bestPrice: row.bestPrice,
    feeExpected: row.feeExpected,
    slippage: row.slippage,
    capitalCost: row.capitalCost,
    resolutionBuffer: row.resolutionBuffer,
    costsTotal: row.costsTotal,
    safetyMargin: row.safetyMargin,
    edgeGross: row.edgeGross,
    edgeNet: row.edgeNet,
    sizeShares: row.sizeShares,
    kellyCapShares: row.kellyCapShares,
    notionalUsd: row.notionalUsd,
    bindingConstraint: row.bindingConstraint,
    limiters: roundTrip(row.limiters),
    configVersion: row.configVersion,
    configHash: row.configHash,
    factorMapVersion: row.factorMapVersion,
    ruleVersion: row.ruleVersion,
    paramVersion: row.paramVersion,
    resolutionScoreVersion: row.resolutionScoreVersion,
    resolutionAction: row.resolutionAction,
    oldestInputTs: row.oldestInputTs,
    newestInputTs: row.newestInputTs,
    book: roundTrip(row.book),
    inputs: roundTrip(row.inputs),
    outcome: row.outcome,
    reasonCode: row.reasonCode,
    portfolioState: row.portfolioState,
  };
}

export function entryDecision(
  overrides: Partial<EvaluationInput> = {},
  decisionId = 1,
  conditionId = "0xa",
): PersistedDecision {
  const input: EvaluationInput = { ...ENTRY_INPUT, ...overrides, conditionId };
  const evaluation = evaluateMarket(input);
  const row = entryDecisionRow({
    evaluation,
    context: {
      ...PROVENANCE,
      conditionId,
      book: {
        token_id: input.tokenId,
        bids: input.bids,
        asks: input.asks,
        recorded_at: "2026-08-30T11:59:59.000Z",
      },
      q: input.q,
      qLo: input.qLo,
      qHi: input.qHi,
      estimateSource: input.estimateSource,
    },
    replay: serializeEntryReplay(input),
  });
  return persist(row, decisionId);
}
