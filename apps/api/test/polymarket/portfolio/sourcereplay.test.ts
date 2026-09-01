// RFC-017 mode B: the source replay.
//
// The tests that matter here are the ones that stop the tool from manufacturing
// a result: no look-ahead, no interpolation over a missing shadow row, and no
// comparing a shadow row against a decision that already used one. Each of those
// would produce a number, and the number would be fiction.

import { describe, expect, it } from "vitest";

import type { QueryResult } from "../../../src/database.js";
import type { PersistedDecision } from "../../../src/polymarket/portfolio/replay.js";
import {
  baselineIsShadow,
  counterfactualPnl,
  decisionWithShadow,
  SourceReplayAccumulator,
  substituteEstimate,
  type CounterfactualEntry,
  type Label,
  type ShadowEstimate,
} from "../../../src/polymarket/portfolio/sourcereplay.js";
import { rederive } from "../../../src/polymarket/portfolio/sweep.js";
import { shadowEstimatesAsOf } from "../../../src/polymarket/portfolio/sweepstore.js";
import { CONFIG, entryDecision } from "../fixtures/portfolio-decision.js";

const DECISION_TS = new Date("2026-08-30T12:00:00Z");

function shadow(overrides: Partial<ShadowEstimate> = {}): ShadowEstimate {
  return {
    q: "0.700000",
    qLo: "0.650000",
    qHi: "0.750000",
    modelId: "crypto_updown_gbm@1.1.0",
    decisionTs: new Date("2026-08-30T11:59:50Z"),
    ...overrides,
  };
}

describe("substituteEstimate", () => {
  it("swaps only the estimate, and leaves the rest of the world alone", () => {
    const decision = entryDecision();
    const inputs = decision.inputs as { replay: Record<string, unknown> };
    const swapped = substituteEstimate({
      replay: inputs.replay,
      shadow: shadow(),
      decisionTs: DECISION_TS,
    });
    expect(swapped).not.toBeNull();
    expect(swapped?.q).toBe("0.700000");
    expect(swapped?.q_lo).toBe("0.650000");
    expect(swapped?.q_hi).toBe("0.750000");
    expect(swapped?.estimate_source).toBe("MODEL");
    // The book, the caps, the bankroll and the resolution state are the world
    // the decision was made in, and the question is what a different SOURCE
    // would have done in it.
    expect(swapped?.bankroll).toBe(inputs.replay.bankroll);
    expect(swapped?.cap_headroom).toBe(inputs.replay.cap_headroom);
    expect(swapped?.resolution_buffer).toBe(inputs.replay.resolution_buffer);
    expect(swapped?.expected_lockup_s).toBe(inputs.replay.expected_lockup_s);
  });

  it("recomputes the age from the shadow row's own instant", () => {
    const decision = entryDecision();
    const inputs = decision.inputs as { replay: Record<string, unknown> };
    // Carrying the baseline's 5 s over would let a stale shadow row through a
    // gate the live engine would have closed.
    expect(inputs.replay.estimate_age_ms).toBe(5_000);
    const swapped = substituteEstimate({
      replay: inputs.replay,
      shadow: shadow({ decisionTs: new Date("2026-08-30T11:59:00Z") }),
      decisionTs: DECISION_TS,
    });
    expect(swapped?.estimate_age_ms).toBe(60_000);
  });

  it("refuses an estimate stamped after the decision — no look-ahead", () => {
    const decision = entryDecision();
    const inputs = decision.inputs as { replay: Record<string, unknown> };
    const later = substituteEstimate({
      replay: inputs.replay,
      shadow: shadow({ decisionTs: new Date("2026-08-30T12:00:01Z") }),
      decisionTs: DECISION_TS,
    });
    expect(later).toBeNull();
  });
});

describe("decisionWithShadow", () => {
  it("moves the columns as well as the replay block", () => {
    const swapped = decisionWithShadow({
      decision: entryDecision(),
      shadow: shadow(),
    });
    expect(swapped?.q).toBe("0.700000");
    expect(swapped?.qLo).toBe("0.650000");
    expect(swapped?.estimateSource).toBe("MODEL");
    // Leaving the columns behind would build a row whose columns and whose
    // arithmetic disagree about which estimate produced it.
    const inputs = swapped?.inputs as { replay: Record<string, unknown> };
    expect(inputs.replay.q_lo).toBe("0.650000");
  });

  it("re-derives to a different verdict when the shadow disagrees enough", () => {
    const decision = entryDecision();
    const baseline = rederive({ decision, config: CONFIG })?.row;
    expect(baseline?.outcome).toBe("ACCEPTED");

    const pessimistic = decisionWithShadow({
      decision,
      shadow: shadow({ q: "0.470000", qLo: "0.450000", qHi: "0.490000" }),
    });
    const rejected = rederive({ decision: pessimistic!, config: CONFIG })?.row;
    expect(rejected?.outcome).toBe("REJECTED");
    expect(rejected?.reasonCode).toBe("LOWER_BOUND_BELOW_COSTS");

    const optimistic = decisionWithShadow({
      decision,
      shadow: shadow({ q: "0.700000", qLo: "0.650000", qHi: "0.700000" }),
    });
    const accepted = rederive({ decision: optimistic!, config: CONFIG })?.row;
    expect(accepted?.outcome).toBe("ACCEPTED");
    expect(Number(accepted?.sizeShares)).toBeGreaterThan(
      Number(baseline?.sizeShares),
    );
  });

  it("lets the engine refuse a shadow row older than the staleness TTL", () => {
    // 400 s against `estimateMaxAgeMs` of 300 s. The substitution succeeds and
    // the ENGINE refuses it, which is the honest division of labour: mode B does
    // not get to decide what the engine would have accepted.
    const stale = decisionWithShadow({
      decision: entryDecision(),
      shadow: shadow({ decisionTs: new Date("2026-08-30T11:53:20Z") }),
    });
    const row = rederive({ decision: stale!, config: CONFIG })?.row;
    expect(row?.outcome).toBe("REJECTED");
    expect(row?.reasonCode).toBe("DATA_STALE");
  });
});

describe("baselineIsShadow", () => {
  it("flags a MODEL-sourced decision when no model was ever promoted", () => {
    // The leak measured in production on 2026-09-01: `estimateAsOf` has no
    // status filter, so a shadow row can win the LIMIT 1.
    const leaked: PersistedDecision = {
      ...entryDecision(),
      estimateSource: "MODEL",
    };
    expect(
      baselineIsShadow({ decision: leaked, anyModelPromoted: false }),
    ).toBe(true);
  });

  it("does not flag it once a model has actually been promoted", () => {
    const legitimate: PersistedDecision = {
      ...entryDecision(),
      estimateSource: "MODEL",
    };
    expect(
      baselineIsShadow({ decision: legitimate, anyModelPromoted: true }),
    ).toBe(false);
  });

  it("never flags a baseline-sourced decision", () => {
    expect(
      baselineIsShadow({
        decision: entryDecision(),
        anyModelPromoted: false,
      }),
    ).toBe(false);
  });
});

describe("counterfactualPnl", () => {
  const entries: CounterfactualEntry[] = [
    {
      decisionId: 1,
      conditionId: "0xa",
      tokenId: "win",
      marketSide: "YES",
      execPrice: 0.5,
      costsTotal: 0.001,
      sizeShares: 40,
    },
    {
      decisionId: 2,
      conditionId: "0xb",
      tokenId: "lose",
      marketSide: "NO",
      execPrice: 0.3,
      costsTotal: 0.002,
      sizeShares: 10,
    },
    {
      decisionId: 3,
      conditionId: "0xc",
      tokenId: "half",
      marketSide: "YES",
      execPrice: 0.4,
      costsTotal: 0,
      sizeShares: 100,
    },
    {
      decisionId: 4,
      conditionId: "0xd",
      tokenId: "unresolved",
      marketSide: "YES",
      execPrice: 0.5,
      costsTotal: 0,
      sizeShares: 10,
    },
  ];

  const labels = new Map<string, Label>([
    ["win", { tokenId: "win", label: "1", isFinal: true }],
    ["lose", { tokenId: "lose", label: "1", isFinal: true }],
    ["half", { tokenId: "half", label: "0.5", isFinal: true }],
    ["unresolved", { tokenId: "unresolved", label: "1", isFinal: false }],
  ]);

  it("matches the arithmetic done by hand", () => {
    const pnl = counterfactualPnl({
      entries,
      labels,
      degradationPerShare: 0.01,
    });

    // By hand:
    //   win  YES pays 1.0   -> (1.0 - 0.50) x 40  = +20.00
    //   lose NO  pays 1 - 1 -> (0.0 - 0.30) x 10  =  -3.00
    //   half YES pays 0.5   -> (0.5 - 0.40) x 100 = +10.00
    //   gross        = 27.00
    //   engine costs = 0.001x40 + 0.002x10 + 0x100 = 0.06
    //   degradation  = 0.01 x (40 + 10 + 100)      = 1.50
    //   net          = 27.00 - 0.06 - 1.50         = 25.44
    expect(pnl.grossUsd).toBeCloseTo(27, 9);
    expect(pnl.costsUsd).toBeCloseTo(0.06, 9);
    expect(pnl.degradationUsd).toBeCloseTo(1.5, 9);
    expect(pnl.netUsd).toBeCloseTo(25.44, 9);
  });

  it("counts the settled and the unsettled separately", () => {
    const pnl = counterfactualPnl({
      entries,
      labels,
      degradationPerShare: 0.01,
    });
    expect(pnl.entriesConsidered).toBe(4);
    expect(pnl.entriesSettled).toBe(3);
    // A non-final label is not an outcome. Settling against it would be reading
    // a result that could still change.
    expect(pnl.entriesWithoutFinalLabel).toBe(1);
    expect(pnl.wins).toBe(1);
    expect(pnl.losses).toBe(1);
    expect(pnl.halves).toBe(1);
  });

  it("charges the degradation on every settled entry, win or lose", () => {
    const cheap = counterfactualPnl({
      entries,
      labels,
      degradationPerShare: 0,
    });
    const dear = counterfactualPnl({
      entries,
      labels,
      degradationPerShare: 0.01,
    });
    expect(dear.netUsd).toBeLessThan(cheap.netUsd);
  });
});

describe("SourceReplayAccumulator", () => {
  it("counts every exclusion by name", () => {
    const accumulator = new SourceReplayAccumulator();
    accumulator.excluded("0xa", "SHADOW_MISSING");
    accumulator.excluded("0xb", "SHADOW_MISSING");
    accumulator.excluded("0xc", "BASELINE_ALREADY_SHADOW");
    accumulator.excluded("0xd", "BASELINE_MISMATCH");

    const totals = accumulator.totals();
    expect(totals.decisionsSeen).toBe(4);
    expect(totals.decisionsAdmitted).toBe(0);
    expect(totals.exclusions.SHADOW_MISSING).toBe(2);
    expect(totals.exclusions.BASELINE_ALREADY_SHADOW).toBe(1);
    expect(totals.exclusions.BASELINE_MISMATCH).toBe(1);
  });

  it("splits accepted-by-shadow-only from accepted-by-baseline-only", () => {
    const accumulator = new SourceReplayAccumulator();
    accumulator.add({
      conditionId: "0xa",
      decisionTs: new Date("2026-08-30T10:00:00Z"),
      modelId: "crypto_updown_gbm@1.1.0",
      baselineOutcome: "REJECTED",
      baselineReason: "LOWER_BOUND_BELOW_COSTS",
      shadowOutcome: "ACCEPTED",
      shadowReason: null,
      reachedEstimate: true,
    });
    accumulator.add({
      conditionId: "0xb",
      decisionTs: new Date("2026-08-30T14:00:00Z"),
      modelId: "crypto_updown_gbm@1.1.0",
      baselineOutcome: "ACCEPTED",
      baselineReason: null,
      shadowOutcome: "REJECTED",
      shadowReason: "EDGE_BELOW_MIN",
      reachedEstimate: true,
    });
    accumulator.add({
      conditionId: "0xb",
      decisionTs: new Date("2026-08-30T15:00:00Z"),
      modelId: "crypto_updown_gbm@1.1.0",
      baselineOutcome: "REJECTED",
      baselineReason: "BOOK_STALE",
      shadowOutcome: "REJECTED",
      shadowReason: "BOOK_STALE",
      reachedEstimate: false,
    });

    const totals = accumulator.totals();
    expect(totals.decisionsAdmitted).toBe(3);
    expect(totals.marketsAdmitted).toBe(2);
    // The stale-book row replayed and found its shadow, but it was refused
    // before the estimate was ever read: no source swap could move it, so it is
    // admitted and still out of the denominator the question applies to.
    expect(totals.decisionsReachingEstimate).toBe(2);
    expect(totals.shadowOnlyAccepted).toBe(1);
    expect(totals.baselineOnlyAccepted).toBe(1);
    expect(totals.linesOutcomeChanged).toBe(2);
    expect(totals.marketsOutcomeChanged).toBe(2);
    expect(totals.modelIds).toEqual(["crypto_updown_gbm@1.1.0"]);
  });

  it("reports the window it actually covered, not the one requested", () => {
    const accumulator = new SourceReplayAccumulator();
    accumulator.add({
      conditionId: "0xa",
      decisionTs: new Date("2026-08-30T14:00:00Z"),
      modelId: "m",
      baselineOutcome: "REJECTED",
      baselineReason: "BOOK_STALE",
      shadowOutcome: "REJECTED",
      shadowReason: "BOOK_STALE",
      reachedEstimate: false,
    });
    accumulator.add({
      conditionId: "0xa",
      decisionTs: new Date("2026-08-30T10:00:00Z"),
      modelId: "m",
      baselineOutcome: "REJECTED",
      baselineReason: "BOOK_STALE",
      shadowOutcome: "REJECTED",
      shadowReason: "BOOK_STALE",
      reachedEstimate: false,
    });
    const totals = accumulator.totals();
    expect(totals.coveredFrom).toBe("2026-08-30T10:00:00.000Z");
    expect(totals.coveredTo).toBe("2026-08-30T14:00:00.000Z");
  });
});

describe("shadowEstimatesAsOf", () => {
  function capturingPool(): {
    captured: { text: string; params: unknown[] }[];
    pool: {
      query: <R extends Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ) => Promise<QueryResult<R>>;
    };
  } {
    const captured: { text: string; params: unknown[] }[] = [];
    return {
      captured,
      pool: {
        query<R extends Record<string, unknown>>(
          text: string,
          params?: readonly unknown[],
        ): Promise<QueryResult<R>> {
          captured.push({ text, params: [...(params ?? [])] });
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
      },
    };
  }

  it("asks only for shadow MODEL rows, at or before the instant", async () => {
    const { captured, pool } = capturingPool();
    await shadowEstimatesAsOf(
      pool,
      [{ tokenId: "t1", at: DECISION_TS }],
      300_000,
    );
    const sql = captured[0]?.text ?? "";
    expect(sql).toContain("e.status = 'shadow'");
    expect(sql).toContain("e.source = 'MODEL'");
    // The no-look-ahead guarantee, at the SQL level.
    expect(sql).toContain("e.decision_ts <= w.at");
    expect(sql).not.toContain("e.decision_ts >= w.at\n");
    // And the lower bound is the engine's own staleness TTL, so a row the live
    // engine would have refused as DATA_STALE never enters the sample.
    expect(sql).toContain("w.at - ($3::bigint * interval '1 millisecond')");
    expect(captured[0]?.params[2]).toBe(300_000);
  });

  it("breaks ties deterministically, newest row first", async () => {
    const { captured, pool } = capturingPool();
    await shadowEstimatesAsOf(pool, [{ tokenId: "t1", at: DECISION_TS }], 1);
    expect(captured[0]?.text).toContain(
      "ORDER BY w.token_id, w.at, e.decision_ts DESC, e.estimate_id DESC",
    );
  });

  it("does not query at all for an empty page", async () => {
    const { captured, pool } = capturingPool();
    const result = await shadowEstimatesAsOf(pool, [], 300_000);
    expect(result.size).toBe(0);
    expect(captured).toEqual([]);
  });
});
