import { describe, expect, it } from "vitest";

import {
  formatScaled,
  parseScaled,
} from "../../../src/polymarket/fundamental/fixed.js";
import {
  evaluateEdge,
  groupArbWalk,
  pairArbWalk,
  toScaledLevels,
  type MarketLeg,
  type ScaledLevel,
} from "../../../src/polymarket/resolution/evaluate.js";
import type { ActiveEdge } from "../../../src/polymarket/resolution/graph.js";

// ---------------------------------------------------------------------------
// RFC-012 tasks 12-13: the walks price EXECUTABLE depth, never a midpoint.
// Every expected number below was computed by hand from the RFC's band:
// per-share taker fee = rate * p * (1 - p), and a walk stops at the first
// share whose net margin is at or below epsilon.

function scaled(value: string): bigint {
  const parsed = parseScaled(value);
  if (parsed === null) {
    throw new Error(`not a canonical decimal: ${value}`);
  }
  return parsed;
}

function lvl(price: string, size: string): ScaledLevel {
  return { price: scaled(price), size: scaled(size) };
}

const FEE_7PCT = scaled("0.07");
const EPSILON = scaled("0.005");
const CAP = scaled("1000");

function leg(
  conditionId: string,
  bids: ScaledLevel[],
  asks: ScaledLevel[],
  feeRate: bigint,
): MarketLeg {
  return {
    conditionId,
    tokenId: `${conditionId}-yes`,
    books: { bids, asks },
    feeRate,
  };
}

function impliesEdge(): ActiveEdge {
  return {
    edgeId: 1,
    edgeKey: "IMPLIES:0xa->0xb",
    kind: "IMPLIES",
    fromConditionId: "0xa",
    toConditionId: "0xb",
    eventId: null,
    members: [],
    confidence: "0.900000",
  };
}

// Fixture (a): beyond the band on the first level only.
const SELL_BIDS_A = [lvl("0.60", "10"), lvl("0.55", "20")];
const BUY_ASKS_A = [lvl("0.50", "5"), lvl("0.58", "50")];

// Fixture (b): inside the band once fees are paid.
const SELL_BIDS_B = [lvl("0.52", "10")];
const BUY_ASKS_B = [lvl("0.50", "10")];

describe("toScaledLevels", () => {
  it("drops non-positive and unparsable levels", () => {
    expect(
      toScaledLevels([
        { price: "0.60", size: "10" },
        { price: "0", size: "5" },
        { price: "0.50", size: "0" },
        { price: "abc", size: "1" },
      ]),
    ).toEqual([lvl("0.60", "10")]);
  });
});

describe("pairArbWalk", () => {
  it("(a) sizes the edge by the REAL depth, stopping when fees eat the step", () => {
    const walk = pairArbWalk(
      SELL_BIDS_A,
      BUY_ASKS_A,
      FEE_7PCT,
      FEE_7PCT,
      EPSILON,
      CAP,
    );
    // fee(0.60) = 0.07*0.60*0.40 = 0.0168; fee(0.50) = 0.07*0.25 = 0.0175.
    // unitNet = 0.60 - 0.50 - 0.0168 - 0.0175 = 0.0657.
    expect(formatScaled(walk.unitNet, 6)).toBe("0.065700");
    // Second step (0.60 vs 0.58) nets negative, so only 5 shares execute:
    // the ask depth, not the theoretical edge.
    expect(walk.execSize).toBe(scaled("5"));
    expect(walk.execNotional).toBe(scaled("2.5"));
  });

  it("(b) executes nothing when the spread sits inside the fee band", () => {
    const walk = pairArbWalk(
      SELL_BIDS_B,
      BUY_ASKS_B,
      FEE_7PCT,
      FEE_7PCT,
      EPSILON,
      CAP,
    );
    // net = 0.02 - 0.017472 - 0.0175 < 0.
    expect(walk.execSize).toBe(0n);
    expect(walk.execNotional).toBe(0n);
  });

  it("(h) a net margin exactly at epsilon does not execute", () => {
    const walk = pairArbWalk(
      [lvl("0.505", "10")],
      [lvl("0.50", "10")],
      0n,
      0n,
      EPSILON,
      CAP,
    );
    expect(walk.unitNet).toBe(scaled("0.005"));
    expect(walk.execSize).toBe(0n);
  });
});

describe("groupArbWalk", () => {
  it("(c) sell-all: limited by the thinnest member level", () => {
    const walk = groupArbWalk(
      [
        [lvl("0.40", "10")],
        [lvl("0.35", "10")],
        [lvl("0.30", "2"), lvl("0.20", "10")],
      ],
      [0n, 0n, 0n],
      "sell",
      EPSILON,
      CAP,
    );
    // Sum of best bids = 1.05 -> unitNet 0.05; the 2-share level bounds the
    // size, and the next composite (0.95) nets negative.
    expect(formatScaled(walk.unitNet, 6)).toBe("0.050000");
    expect(walk.execSize).toBe(scaled("2"));
    expect(walk.execNotional).toBe(scaled("2"));
  });

  it("(d) buy-all: nets 1 - sum of asks over the common depth", () => {
    const walk = groupArbWalk(
      [[lvl("0.30", "5")], [lvl("0.30", "5")], [lvl("0.30", "5")]],
      [0n, 0n, 0n],
      "buy",
      EPSILON,
      CAP,
    );
    expect(formatScaled(walk.unitNet, 6)).toBe("0.100000");
    expect(walk.execSize).toBe(scaled("5"));
    expect(walk.execNotional).toBe(scaled("4.5"));
  });
});

describe("evaluateEdge", () => {
  it("(e) IMPLIES beyond the band reports the walked numbers", () => {
    const legs = new Map<string, MarketLeg>([
      ["0xa", leg("0xa", SELL_BIDS_A, [], FEE_7PCT)],
      ["0xb", leg("0xb", [], BUY_ASKS_A, FEE_7PCT)],
    ]);
    const verdict = evaluateEdge(impliesEdge(), legs, EPSILON, CAP, true);
    expect(verdict).toEqual({
      kind: "beyond",
      unitNet: scaled("0.0657"),
      execSize: scaled("5"),
      execNotional: scaled("2.5"),
      tolerance: EPSILON,
      details: {
        direction: "from_over_to",
        sell_condition_id: "0xa",
        buy_condition_id: "0xb",
      },
    });
  });

  it("(e) IMPLIES inside the band", () => {
    const legs = new Map<string, MarketLeg>([
      ["0xa", leg("0xa", SELL_BIDS_B, [], FEE_7PCT)],
      ["0xb", leg("0xb", [], BUY_ASKS_B, FEE_7PCT)],
    ]);
    expect(evaluateEdge(impliesEdge(), legs, EPSILON, CAP, true)).toEqual({
      kind: "inside",
    });
  });

  it("(e) IMPLIES with a missing leg is skipped", () => {
    const legs = new Map<string, MarketLeg>([
      ["0xa", leg("0xa", SELL_BIDS_A, [], FEE_7PCT)],
    ]);
    expect(evaluateEdge(impliesEdge(), legs, EPSILON, CAP, true)).toEqual({
      kind: "skipped",
      reason: "missing_leg",
    });
  });

  it("(f) EQUIV picks the profitable direction", () => {
    const edge: ActiveEdge = { ...impliesEdge(), kind: "EQUIV" };
    // from is cheap, to is expensive: only selling `to` / buying `from` pays.
    const legs = new Map<string, MarketLeg>([
      ["0xa", leg("0xa", [lvl("0.28", "10")], [lvl("0.30", "10")], 0n)],
      ["0xb", leg("0xb", [lvl("0.60", "10")], [lvl("0.62", "10")], 0n)],
    ]);
    const verdict = evaluateEdge(edge, legs, EPSILON, CAP, true);
    expect(verdict.kind).toBe("beyond");
    if (verdict.kind === "beyond") {
      expect(verdict.details["direction"]).toBe("to_over_from");
      expect(verdict.unitNet).toBe(scaled("0.30"));
    }
  });

  function groupEdge(): ActiveEdge {
    return {
      edgeId: 2,
      edgeKey: "NEGRISK:event:ev1",
      kind: "NEGRISK",
      fromConditionId: null,
      toConditionId: null,
      eventId: "ev1",
      members: ["0xm1", "0xm2", "0xm3"],
      confidence: "1.000000",
    };
  }

  it("(g) the buy-all test only runs under full membership", () => {
    // Coherent bids (sum 0.75), cheap asks (sum 0.90).
    const legs = new Map<string, MarketLeg>([
      ["0xm1", leg("0xm1", [lvl("0.25", "5")], [lvl("0.30", "5")], 0n)],
      ["0xm2", leg("0xm2", [lvl("0.25", "5")], [lvl("0.30", "5")], 0n)],
      ["0xm3", leg("0xm3", [lvl("0.25", "5")], [lvl("0.30", "5")], 0n)],
    ]);
    expect(evaluateEdge(groupEdge(), legs, EPSILON, CAP, false)).toEqual({
      kind: "inside",
    });
    const full = evaluateEdge(groupEdge(), legs, EPSILON, CAP, true);
    expect(full.kind).toBe("beyond");
    if (full.kind === "beyond") {
      expect(full.details["test"]).toBe("sum_asks_lt_1");
      expect(full.unitNet).toBe(scaled("0.10"));
      expect(full.execSize).toBe(scaled("5"));
    }
  });

  it("(g) the sell-all violation fires regardless of membership", () => {
    const legs = new Map<string, MarketLeg>([
      ["0xm1", leg("0xm1", [lvl("0.40", "10")], [], 0n)],
      ["0xm2", leg("0xm2", [lvl("0.35", "10")], [], 0n)],
      ["0xm3", leg("0xm3", [lvl("0.30", "2"), lvl("0.20", "10")], [], 0n)],
    ]);
    const verdict = evaluateEdge(groupEdge(), legs, EPSILON, CAP, false);
    expect(verdict.kind).toBe("beyond");
    if (verdict.kind === "beyond") {
      expect(verdict.details["test"]).toBe("sum_bids_gt_1");
      expect(verdict.unitNet).toBe(scaled("0.05"));
      expect(verdict.execSize).toBe(scaled("2"));
      expect(verdict.execNotional).toBe(scaled("2"));
    }
  });
});
