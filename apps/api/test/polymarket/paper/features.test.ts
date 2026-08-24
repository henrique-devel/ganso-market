import { describe, expect, it } from "vitest";

import type { PriceLevel } from "../../../src/polymarket/types.js";
import {
  computeBookFeatures,
  computeFeatureRow,
  computeFlowFeatures,
  countJumps,
  realizedVol,
  windowKindsForHorizon,
  type FeatureBook,
  type FeatureInputs,
} from "../../../src/polymarket/paper/features.js";

const WINDOW_END = new Date("2026-08-24T12:00:00.000Z");
const WINDOW_START = new Date("2026-08-24T11:59:00.000Z");

function levels(
  start: number,
  step: number,
  size: string,
  count = 10,
): PriceLevel[] {
  return Array.from({ length: count }, (_, i) => ({
    price: (start + step * i).toFixed(2),
    size,
  }));
}

/** Bids 0.48..0.39 size 100; asks 0.52..0.61 size 50; fresh at windowEnd. */
function fixtureBook(): FeatureBook {
  return {
    tokenId: "token-1",
    bids: levels(0.48, -0.01, "100"),
    asks: levels(0.52, 0.01, "50"),
    sourceTs: new Date(WINDOW_END.getTime() - 2_000),
    observedAt: new Date(WINDOW_END.getTime() - 1_000),
  };
}

function baseInputs(): FeatureInputs {
  return {
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    book: fixtureBook(),
    tickSize: "0.01",
    trades: [
      { price: "0.50", size: "10" },
      { price: "0.51", size: "5.5" },
      { price: "0.49", size: null },
    ],
    lastTradeTs: new Date(WINDOW_END.getTime() - 1_500),
    deltaStats: { cancelEvents: 4, updateEvents: 11, levelsTouched: 6 },
    midCloses1m: ["0.500000", "0.550000"],
    snapshotMids: ["0.50", "0.53", "0.52", "0.49"],
    nextCatalystAt: new Date(WINDOW_END.getTime() + 30 * 60_000),
    endDateAt: new Date(WINDOW_END.getTime() + 90.5 * 60_000),
    umaEndDateAt: new Date(WINDOW_END.getTime() + 120 * 60_000),
  };
}

describe("A1–A3 book features", () => {
  it("computes spread, depth, fractions and imbalance exactly", () => {
    const features = computeBookFeatures(fixtureBook(), "0.01", WINDOW_END);
    expect(features.bookValid).toBe(true);
    expect(features.bestBid).toBe("0.480000");
    expect(features.bestAsk).toBe("0.520000");
    expect(features.mid).toBe("0.500000");
    expect(features.spreadQuoted).toBe("0.040000");
    // (0.04 / 2) / 0.5 * 10_000 = 400 bps.
    expect(features.halfSpreadBps).toBe("400.000000");
    expect(features.bidDepthTop1).toBe("100.000000");
    expect(features.askDepthTop1).toBe("50.000000");
    expect(features.bidDepthTop10).toBe("1000.000000");
    expect(features.askDepthTop10).toBe("500.000000");
    expect(features.topFracBid).toBe("0.100000");
    expect(features.topFracAsk).toBe("0.100000");
    // (100 - 50) / 150 and (1000 - 500) / 1500.
    expect(features.imbalanceTop1).toBe("0.333333");
    expect(features.imbalanceTop10).toBe("0.333333");
    // Cumulative size within k ticks of the touch (touch included).
    expect(features.depthTicks?.["1"]).toEqual({
      bid: "200.000000",
      ask: "100.000000",
    });
    expect(features.depthTicks?.["2"]).toEqual({
      bid: "300.000000",
      ask: "150.000000",
    });
    expect(features.depthTicks?.["5"]).toEqual({
      bid: "600.000000",
      ask: "300.000000",
    });
    expect(features.depthTicks?.["10"]).toEqual({
      bid: "1000.000000",
      ask: "500.000000",
    });
    expect(features.execSpreadSref).not.toBeNull();
    expect(features.microprice).not.toBeNull();
    // The ask side rests ~$282.5 of notional, under 3 x S_ref: thin.
    expect(features.thinBook).toBe(true);
  });

  it("still publishes quoted levels when the book is stale, flagged invalid", () => {
    const staleBook: FeatureBook = {
      ...fixtureBook(),
      sourceTs: new Date(WINDOW_END.getTime() - 120_000),
      observedAt: new Date(WINDOW_END.getTime() - 120_000),
    };
    const features = computeBookFeatures(staleBook, "0.01", WINDOW_END);
    expect(features.bookValid).toBe(false);
    expect(features.bookInvalidReason).toBe("BOOK_STALE");
    expect(features.bestBid).toBe("0.480000");
    expect(features.execSpreadSref).toBeNull();
    expect(features.microprice).toBeNull();
  });

  it("a missing book is an explicit absence", () => {
    const features = computeBookFeatures(null, "0.01", WINDOW_END);
    expect(features.bookValid).toBe(false);
    expect(features.bookInvalidReason).toBe("NO_BOOK");
    expect(features.bestBid).toBeNull();
    expect(features.imbalanceTop1).toBeNull();
  });

  it("crossed books are flagged, never priced", () => {
    const crossed: FeatureBook = {
      ...fixtureBook(),
      bids: levels(0.55, -0.01, "100"),
    };
    const features = computeBookFeatures(crossed, "0.01", WINDOW_END);
    expect(features.bookValid).toBe(false);
    expect(features.bookInvalidReason).toBe("BOOK_CROSSED");
    expect(features.microprice).toBeNull();
  });

  it("without a tick size the tick-band depth is absent, not guessed", () => {
    const features = computeBookFeatures(fixtureBook(), null, WINDOW_END);
    expect(features.depthTicks).toBeNull();
    expect(features.bidDepthTop10).toBe("1000.000000");
  });
});

describe("A4 aggressor flow", () => {
  it("publishes unsigned volume only, with the direction UNAVAILABLE", () => {
    const flow = computeFlowFeatures([
      { price: "0.50", size: "10" },
      { price: "0.51", size: "5.5" },
      { price: "0.49", size: null },
    ]);
    expect(flow.tradesCount).toBe(3);
    expect(flow.volumeUnsigned).toBe("15.500000");
    expect(flow.volumeSigned).toBeNull();
    expect(flow.flowDirectionStatus).toBe("UNAVAILABLE");
  });

  it("with no sized trade the volume is an explicit absence", () => {
    const flow = computeFlowFeatures([{ price: "0.50", size: null }]);
    expect(flow.volumeUnsigned).toBeNull();
    expect(flow.tradesCount).toBe(1);
  });
});

describe("A6 volatility and jumps", () => {
  it("computes the realized vol of 1-minute log returns", () => {
    // ln(0.55/0.50) = 0.0953101...; a single return, vol equals |return|.
    expect(realizedVol(["0.500000", "0.550000"], 1)).toBe("0.095310");
  });

  it("needs at least two usable closes", () => {
    expect(realizedVol(["0.500000"], 5)).toBeNull();
    expect(realizedVol([], 30)).toBeNull();
  });

  it("is deterministic byte for byte", () => {
    const closes = ["0.400000", "0.410000", "0.390000", "0.420000"];
    expect(realizedVol(closes, 30)).toBe(realizedVol(closes, 30));
  });

  it("counts mid moves larger than the jump threshold", () => {
    // Threshold is 2 ticks = 0.02; moves are 0.03, 0.01, 0.03.
    expect(countJumps(["0.50", "0.53", "0.52", "0.49"], "0.01")).toBe(2);
    expect(countJumps(["0.50", "0.53"], null)).toBe(0);
  });
});

describe("A7–A8 staleness and horizons", () => {
  it("ages and minutes-to are measured against window end", () => {
    const row = computeFeatureRow(baseInputs());
    expect(row.lastTradeAgeMs).toBe(1_500);
    expect(row.bookStalenessMs).toBe(2_000);
    expect(row.minsToCatalyst).toBe(30);
    expect(row.minsToEndDate).toBe(90);
    expect(row.minsToUmaEnd).toBe(120);
  });

  it("unknown horizons are explicit nulls", () => {
    const row = computeFeatureRow({
      ...baseInputs(),
      lastTradeTs: null,
      nextCatalystAt: null,
      endDateAt: null,
      umaEndDateAt: null,
    });
    expect(row.lastTradeAgeMs).toBeNull();
    expect(row.minsToCatalyst).toBeNull();
    expect(row.minsToEndDate).toBeNull();
    expect(row.minsToUmaEnd).toBeNull();
  });
});

describe("full feature row", () => {
  it("is deterministic: identical inputs produce identical rows", () => {
    expect(computeFeatureRow(baseInputs())).toEqual(
      computeFeatureRow(baseInputs()),
    );
  });

  it("carries the delta stats and the book source_ts", () => {
    const row = computeFeatureRow(baseInputs());
    expect(row.cancelEvents).toBe(4);
    expect(row.updateEvents).toBe(11);
    expect(row.levelsTouched).toBe(6);
    expect(row.sourceTs).toEqual(new Date(WINDOW_END.getTime() - 2_000));
    expect(row.flowDirectionStatus).toBe("UNAVAILABLE");
    expect(row.volumeSigned).toBeNull();
  });
});

describe("cadence gate", () => {
  it("mirrors the per-horizon cadence decision", () => {
    expect(windowKindsForHorizon(30 * 60_000)).toEqual(["1s", "10s", "1m"]);
    expect(windowKindsForHorizon(3 * 60 * 60_000)).toEqual(["10s", "1m"]);
    expect(windowKindsForHorizon(48 * 60 * 60_000)).toEqual(["1m"]);
    expect(windowKindsForHorizon(null)).toEqual(["1m"]);
  });
});
