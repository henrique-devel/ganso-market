import { describe, expect, it } from "vitest";

import {
  extractLadderKey,
  inferLadders,
} from "../../../src/polymarket/resolution/ladder.js";

// ---------------------------------------------------------------------------
// RFC-012 task 11: LADDER key extraction and edge inference. Every expected
// value below was computed by hand from the RFC semantics: the harder event
// implies the easier one, and only barrier payoffs are monotone in the date.

describe("extractLadderKey", () => {
  it("parses a terminal threshold question (above ON date)", () => {
    expect(
      extractLadderKey("Will Bitcoin be above $68,000 on August 25?"),
    ).toEqual({
      asset: "BTC",
      direction: "up",
      threshold: 68_000,
      barrier: false,
    });
  });

  it("parses a barrier question (reach BY date)", () => {
    expect(extractLadderKey("Will Bitcoin reach $100,000 by March?")).toEqual({
      asset: "BTC",
      direction: "up",
      threshold: 100_000,
      barrier: true,
    });
  });

  it("parses a downward barrier question (dip to)", () => {
    expect(extractLadderKey("Will Ethereum dip to $1,250 in August?")).toEqual({
      asset: "ETH",
      direction: "down",
      threshold: 1_250,
      barrier: true,
    });
  });

  it("expands a bare k-suffixed threshold", () => {
    expect(extractLadderKey("Will Bitcoin hit 100k by 2027?")).toEqual({
      asset: "BTC",
      direction: "up",
      threshold: 100_000,
      barrier: true,
    });
  });

  it("refuses when no tracked asset appears", () => {
    expect(extractLadderKey("Will the CPI be above 3%?")).toBeNull();
  });

  it("refuses when two assets appear", () => {
    expect(extractLadderKey("Will Bitcoin flip Ethereum?")).toBeNull();
  });

  it("refuses when both directions appear", () => {
    expect(
      extractLadderKey("Will BTC be above $50,000 or below $40,000?"),
    ).toBeNull();
  });

  it("refuses when no threshold appears", () => {
    expect(
      extractLadderKey("Will Bitcoin reach a new high by March?"),
    ).toBeNull();
  });
});

const END = new Date("2026-08-25T00:00:00.000Z");

describe("inferLadders", () => {
  it("threshold family: the higher 'up' threshold implies the lower", () => {
    const edges = inferLadders([
      {
        conditionId: "0xhigh",
        question: "Will Bitcoin be above $120,000 on August 25?",
        endDate: END,
      },
      {
        conditionId: "0xlow",
        question: "Will Bitcoin be above $100,000 on August 25?",
        endDate: new Date(END),
      },
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      fromConditionId: "0xhigh",
      toConditionId: "0xlow",
      kind: "LADDER",
      confidence: "0.800000",
    });
    expect(edges[0]?.params).toMatchObject({
      family: "threshold",
      asset: "BTC",
      direction: "up",
      from_threshold: 120_000,
      to_threshold: 100_000,
    });
  });

  it("threshold family 'down': the lower target implies the higher floor", () => {
    const edges = inferLadders([
      {
        conditionId: "0xfloor-high",
        question: "Will Ethereum dip to $1,250 in August?",
        endDate: END,
      },
      {
        conditionId: "0xfloor-low",
        question: "Will Ethereum dip to $1,000 in August?",
        endDate: new Date(END),
      },
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      fromConditionId: "0xfloor-low",
      toConditionId: "0xfloor-high",
      kind: "LADDER",
      confidence: "0.800000",
    });
    expect(edges[0]?.params).toMatchObject({
      family: "threshold",
      direction: "down",
      from_threshold: 1_000,
      to_threshold: 1_250,
    });
  });

  it("date family: first passage by the earlier date implies the later", () => {
    const march = new Date("2026-03-31T00:00:00.000Z");
    const june = new Date("2026-06-30T00:00:00.000Z");
    const edges = inferLadders([
      {
        conditionId: "0xjune",
        question: "Will Bitcoin reach $100,000 by June?",
        endDate: june,
      },
      {
        conditionId: "0xmarch",
        question: "Will Bitcoin reach $100,000 by March?",
        endDate: march,
      },
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      fromConditionId: "0xmarch",
      toConditionId: "0xjune",
      kind: "LADDER",
      confidence: "0.700000",
    });
    expect(edges[0]?.params).toMatchObject({
      family: "date",
      asset: "BTC",
      direction: "up",
      threshold: 100_000,
      from_end_date: march.toISOString(),
      to_end_date: june.toISOString(),
    });
  });

  it("terminal 'above ON date' markets never join a date ladder", () => {
    const edges = inferLadders([
      {
        conditionId: "0xmarch",
        question: "Will Bitcoin be above $100,000 on March 31?",
        endDate: new Date("2026-03-31T00:00:00.000Z"),
      },
      {
        conditionId: "0xjune",
        question: "Will Bitcoin be above $100,000 on June 30?",
        endDate: new Date("2026-06-30T00:00:00.000Z"),
      },
    ]);
    expect(edges).toHaveLength(0);
  });

  it("does not mix barrier and terminal payoffs in a threshold ladder", () => {
    const edges = inferLadders([
      {
        conditionId: "0xbarrier",
        question: "Will Bitcoin reach $120,000 by August 25?",
        endDate: END,
      },
      {
        conditionId: "0xterminal",
        question: "Will Bitcoin be above $100,000 on August 25?",
        endDate: new Date(END),
      },
    ]);
    expect(edges).toHaveLength(0);
  });

  it("does not join different thresholds whose exact deadlines differ", () => {
    const edges = inferLadders([
      {
        conditionId: "0xhigh",
        question: "Will Bitcoin be above $120,000 on August 25?",
        endDate: END,
      },
      {
        conditionId: "0xlow",
        question: "Will Bitcoin be above $100,000 on August 25?",
        endDate: new Date(END.getTime() + 30 * 60_000),
      },
    ]);

    expect(edges).toHaveLength(0);
  });

  it("a null endDate never joins a date ladder", () => {
    const edges = inferLadders([
      {
        conditionId: "0xdated",
        question: "Will Bitcoin reach $100,000 by March?",
        endDate: new Date("2026-03-31T00:00:00.000Z"),
      },
      {
        conditionId: "0xundated",
        question: "Will Bitcoin reach $100,000 by June?",
        endDate: null,
      },
    ]);
    expect(edges).toHaveLength(0);
  });

  it("same threshold at the same date yields no edge", () => {
    const edges = inferLadders([
      {
        conditionId: "0xa",
        question: "Will Bitcoin reach $100,000 by March?",
        endDate: END,
      },
      {
        conditionId: "0xb",
        question: "Will Bitcoin reach $100,000 by March?",
        endDate: new Date(END),
      },
    ]);
    expect(edges).toHaveLength(0);
  });
});
