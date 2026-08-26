// RFC-013 task 7 and its mandatory test: "replay do decision log reproduz
// decisões bit a bit; cada decisão persiste o trecho de book e os valores de
// entrada usados (replay independente do TTL dos dados crus)".
//
// Every fixture here goes through JSON.parse(JSON.stringify(...)) before being
// replayed. That is not decoration: it is the round trip a JSONB column
// actually performs, and a value that survives in memory but not through
// PostgreSQL would make the replay pass in a test and fail in production.
//
// No test in this file reads a book snapshot, an estimate or a resolution state.
// That is the "independente do TTL dos dados crus" half of the requirement: the
// decision row plus the stored config version has to be enough.

import { describe, expect, it } from "vitest";

import { parseScaled } from "../../../src/polymarket/fundamental/fixed.js";
import {
  DEFAULT_PORTFOLIO_CONFIG,
  parsePortfolioConfig,
  portfolioConfigHash,
} from "../../../src/polymarket/portfolio/config.js";
import {
  entryDecisionRow,
  exitDecisionRow,
} from "../../../src/polymarket/portfolio/decisionrow.js";
import {
  evaluateMarket,
  type EvaluationInput,
} from "../../../src/polymarket/portfolio/engine.js";
import {
  planExit,
  type PositionExitContext,
} from "../../../src/polymarket/portfolio/exitcycle.js";
import {
  replayAudit,
  replayDecision,
  serializeEntryReplay,
  serializeExitReplay,
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

const DECISION_TS = new Date("2026-08-26T12:00:00Z");
const CONFIG = DEFAULT_PORTFOLIO_CONFIG;
const CONFIG_HASH = portfolioConfigHash(CONFIG);

/** An entrable market: cheap ask, confident lower bound, no veto. */
const ENTRY_INPUT: EvaluationInput = {
  now: DECISION_TS,
  config: CONFIG,
  conditionId: "0xa",
  tokenId: "t1",
  question: "Will BTC be above $88,000 on August 28?",
  category: "crypto",
  q: "0.700000",
  qLo: "0.650000",
  qHi: "0.750000",
  estimateSource: "MODEL",
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
  resolutionBuffer: "0.001000",
  p5050: "0.010000",
  expectedLockupS: 3_600,
  resolutionAgeMs: 60_000,
  rulePrecisionMultiplier: 0.9,
  resolutionSource: "UMA:0xadapter",
  ruleExcerpt:
    "Resolves YES if BTC closes above $88,000 on the reference feed.",
  correlatedMarkets: ["MUTEX:0xb", "IMPLIES:0xc"],
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
  correlationMultiplier: 0.8,
  breakerOpen: false,
};

const EXIT_CONTEXT: PositionExitContext = {
  tokenId: "t1",
  conditionId: "0xa",
  side: "YES",
  sharesScaled: s("100"),
  costScaled: s("50"),
  openedAt: new Date("2026-08-25T12:00:00Z"),
  entryDecisionId: 41,
  entryDecisionTs: new Date("2026-08-25T12:00:00Z"),
  entryProbLowerScaled: s("0.650000"),
  entryRuleVersion: 3,
  entryResolutionSource: "UMA:0xadapter",
  entryRulePrecisionScaled: s("0.900000"),
  invalidationProbLowerBelowScaled: s("0.520000"),
  probLowerScaled: s("0.660000"),
  bids: [
    { price: "0.61", size: "80" },
    { price: "0.60", size: "400" },
  ],
  asks: [{ price: "0.62", size: "300" }],
  bookAgeMs: 2_000,
  ruleVersion: 3,
  resolutionSource: "UMA:0xadapter",
  rulePrecisionScaled: s("0.900000"),
  clarifiedAt: null,
  minsToCatalyst: 600,
  resolutionAction: "NONE",
  disputeActive: false,
  p5050Scaled: s("0.010000"),
  expectedLockupS: 3_600,
  breakerOpen: false,
};

/**
 * Turn a freshly built row into the shape the log stores it in — including the
 * JSONB round trip, which is the part a purely in-memory fixture would skip.
 */
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
  oldestInputTs: new Date("2026-08-26T11:59:00Z"),
  newestInputTs: new Date("2026-08-26T11:59:59Z"),
  portfolioState: "NORMAL" as PortfolioStateName,
};

function entryDecision(
  overrides: Partial<EvaluationInput> = {},
  decisionId = 1,
): PersistedDecision {
  const input: EvaluationInput = { ...ENTRY_INPUT, ...overrides };
  const evaluation = evaluateMarket(input);
  const row = entryDecisionRow({
    evaluation,
    context: {
      ...PROVENANCE,
      book: {
        token_id: input.tokenId,
        bids: input.bids,
        asks: input.asks,
        recorded_at: "2026-08-26T11:59:59.000Z",
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

function exitDecision(
  overrides: Partial<PositionExitContext> = {},
  portfolioState: PortfolioStateName = "NORMAL",
  decisionId = 2,
): PersistedDecision {
  const context: PositionExitContext = { ...EXIT_CONTEXT, ...overrides };
  const plan = planExit({ context, config: CONFIG, portfolioState });
  const row = exitDecisionRow({
    plan,
    context: {
      ...PROVENANCE,
      portfolioState,
      book: {
        token_id: context.tokenId,
        bids: context.bids,
        asks: context.asks,
        recorded_at: "2026-08-26T11:59:58.000Z",
      },
      side: context.side,
      q: "0.700000",
      qLo: "0.660000",
      qHi: "0.740000",
      estimateSource: "MODEL",
    },
    replay: serializeExitReplay({ context, portfolioState }),
  });
  return persist(row, decisionId);
}

describe("deterministic replay of an entry decision", () => {
  it("reproduces the decision bit for bit from the persisted row alone", () => {
    const decision = entryDecision();
    // The fixture has to be a decision worth replaying, not a rejection that
    // computes nothing.
    expect(decision.outcome).toBe("ACCEPTED");
    expect(decision.sizeShares).not.toBeNull();
    expect(decision.bindingConstraint).not.toBe("NOT_SIZED");

    const outcome = replayDecision({ decision, config: CONFIG });
    expect(outcome.differences).toEqual([]);
    expect(outcome.matched).toBe(true);
    expect(outcome.failure).toBe("MATCHED");
  });

  it("replays a VETO the same way, with its reason", () => {
    const decision = entryDecision({ resolutionAction: "VETO" });
    expect(decision.decisionKind).toBe("VETO");
    expect(decision.reasonCode).toBe("RESOLUTION_VETO");
    expect(replayDecision({ decision, config: CONFIG }).matched).toBe(true);
  });

  it("replays a rejection on the lower-bound criterion", () => {
    // Favourable MEAN, lower bound below costs: the RFC's central invariant.
    const decision = entryDecision({ qLo: "0.505000", qHi: "0.900000" });
    expect(decision.outcome).toBe("REJECTED");
    expect(decision.reasonCode).toBe("LOWER_BOUND_BELOW_COSTS");
    expect(replayDecision({ decision, config: CONFIG }).matched).toBe(true);
  });

  it("keeps the nine-digit inputs, so the six-digit columns still reproduce", () => {
    // The columns are formatted to six digits; the engine works at nine. If the
    // replay block stored six, a headroom of 20.0000005 would come back as
    // 20.000000 and the size could move by a share.
    const decision = entryDecision({
      capHeadroom: { ...ENTRY_INPUT.capHeadroom, entrada: s("20.000000500") },
    });
    const block = (
      decision.inputs as { replay: { cap_headroom: Record<string, string> } }
    ).replay;
    expect(block.cap_headroom.entrada).toBe("20.000000500");
    expect(replayDecision({ decision, config: CONFIG }).matched).toBe(true);
  });

  it("reports the exact field when a persisted output was altered", () => {
    const decision = entryDecision();
    const tampered: PersistedDecision = {
      ...decision,
      sizeShares: "999.000000",
    };
    const outcome = replayDecision({ decision: tampered, config: CONFIG });
    expect(outcome.matched).toBe(false);
    expect(outcome.failure).toBe("OUTPUT_MISMATCH");
    expect(outcome.differences.map((d) => d.field)).toContain("sizeShares");
  });

  it("detects an altered PANEL, not only altered columns", () => {
    const decision = entryDecision();
    const inputs = decision.inputs as {
      panel: Record<string, unknown>;
      replay: unknown;
    };
    const tampered: PersistedDecision = {
      ...decision,
      inputs: {
        replay: inputs.replay,
        panel: { ...inputs.panel, entry_reason: "porque eu quis" },
      },
    };
    const outcome = replayDecision({ decision: tampered, config: CONFIG });
    expect(outcome.matched).toBe(false);
    expect(outcome.differences.map((d) => d.field)).toContain(
      "inputs_json.panel",
    );
  });

  it("refuses to compare against a different parameter set", () => {
    // A decision made under one config replayed against another is not a
    // mismatch to report — it is the wrong comparison entirely.
    const decision = entryDecision();
    const other = parsePortfolioConfig({
      ...JSON.parse(JSON.stringify(CONFIG)),
      version: "9.9.9",
      caps: { ...CONFIG.caps, mercado: 0.04 },
    });
    const outcome = replayDecision({ decision, config: other });
    expect(outcome.failure).toBe("CONFIG_HASH_MISMATCH");
    expect(outcome.matched).toBe(false);
  });

  it("fails closed when the replay block is missing", () => {
    // Every decision written by this engine carries one. A row without it is a
    // row from before the block existed, and the audit must say so rather than
    // silently reporting a match.
    const decision = entryDecision();
    const inputs = decision.inputs as { panel: unknown };
    const outcome = replayDecision({
      decision: { ...decision, inputs: { panel: inputs.panel } },
      config: CONFIG,
    });
    expect(outcome.failure).toBe("NO_REPLAY_BLOCK");
    expect(outcome.matched).toBe(false);
  });
});

describe("deterministic replay of an exit decision", () => {
  it("reproduces a hold, with its verdict in the protected column", () => {
    const decision = exitDecision();
    expect(decision.decisionKind).toBe("EXIT");
    expect(decision.outcome).toBe("REJECTED");
    expect(decision.reasonCode).toBe("HOLD_NO_EXIT_SIGNAL");
    const outcome = replayDecision({ decision, config: CONFIG });
    expect(outcome.differences).toEqual([]);
    expect(outcome.matched).toBe(true);
  });

  it("reproduces a firing exit and its signal set", () => {
    // The bid has risen to where it captures the advantage: criterion 1.
    const decision = exitDecision({
      bids: [
        { price: "0.659", size: "500" },
        { price: "0.658", size: "500" },
      ],
    });
    expect(decision.outcome).toBe("ACCEPTED");
    const signals = (
      decision.inputs as { exit: { signals: { reason: string }[] } }
    ).exit.signals;
    expect(signals.map((signal) => signal.reason)).toContain(
      "EDGE_CAPTURED_AT_BID",
    );
    expect(replayDecision({ decision, config: CONFIG }).matched).toBe(true);
  });

  it("reproduces an exit forced by REDUCE_ONLY", () => {
    const decision = exitDecision({}, "REDUCE_ONLY");
    expect(decision.outcome).toBe("ACCEPTED");
    const outcome = replayDecision({ decision, config: CONFIG });
    expect(outcome.matched).toBe(true);
  });

  it("detects an altered exit signal set", () => {
    const decision = exitDecision();
    const inputs = decision.inputs as {
      exit: Record<string, unknown>;
      replay: unknown;
    };
    const outcome = replayDecision({
      decision: {
        ...decision,
        inputs: {
          replay: inputs.replay,
          exit: {
            ...inputs.exit,
            signals: [{ reason: "MODEL_MOVED", detail: "inventado" }],
          },
        },
      },
      config: CONFIG,
    });
    expect(outcome.matched).toBe(false);
    expect(outcome.differences.map((d) => d.field)).toContain(
      "inputs_json.exit",
    );
  });
});

describe("replay audit over a batch", () => {
  it("counts matches and names the ones that did not", () => {
    const good = entryDecision({}, 10);
    const alsoGood = exitDecision({}, "NORMAL", 11);
    const bad: PersistedDecision = {
      ...entryDecision({}, 12),
      edgeNet: "1.000000",
    };
    const audit = replayAudit({
      decisions: [good, alsoGood, bad],
      configByVersion: new Map([[CONFIG.version, CONFIG]]),
    });
    expect(audit.total).toBe(3);
    expect(audit.matched).toBe(2);
    expect(audit.mismatched.map((outcome) => outcome.decisionId)).toEqual([12]);
  });

  it("reports a decision whose config version is no longer stored", () => {
    // Not a mismatch: an unreplayable decision. Reporting it as a match would
    // be claiming a check that never ran.
    const audit = replayAudit({
      decisions: [entryDecision({}, 20)],
      configByVersion: new Map(),
    });
    expect(audit.matched).toBe(0);
    expect(audit.mismatched[0]?.failure).toBe("CONFIG_HASH_MISMATCH");
  });
});
