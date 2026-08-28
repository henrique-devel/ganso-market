// RFC-013 task 8: continuous gate measurement.
//
// gates.test.ts already proves each verdict as arithmetic. What is tested here
// is the ASSEMBLY: that the right recorded rows become the right gate input,
// including the two the RFC calls out by name —
//
//   * "reset do G2 ao injetar mudança de fee schedule" (a mandatory test), and
//   * labels without leakage, which starts with refusing to score the rows a
//     Brier score cannot honestly be taken over.

import { describe, expect, it } from "vitest";

import { DEFAULT_PORTFOLIO_CONFIG } from "../../../src/polymarket/portfolio/config.js";
import {
  measureGates,
  planClockResets,
  reconcile,
  regimeFingerprint,
  selectForecasts,
  type ForecastRow,
  type MeasureGatesInput,
  type RegimeSchedule,
} from "../../../src/polymarket/portfolio/measure.js";
import { loadRegimeParamsByCategory } from "../../../src/polymarket/portfolio/gatestore.js";
import { BREAKER_KINDS } from "../../../src/polymarket/portfolio/types.js";

const NOW = new Date("2026-08-26T12:00:00Z");
const GATES = DEFAULT_PORTFOLIO_CONFIG.gates;

const CRYPTO_PARAMS: RegimeSchedule = {
  fee_base_bps: ["700"],
  maker_fee_bps: ["0"],
  taker_fee_bps: ["700"],
  tick_size: ["0.01"],
  min_order_size: ["5"],
};

describe("regime fingerprint (G5)", () => {
  it("hashes the schedule, not how it was assembled", () => {
    // Key and value order are presentation; the schedule is a set of sets.
    const one = regimeFingerprint(CRYPTO_PARAMS);
    const two = regimeFingerprint({
      min_order_size: ["5"],
      tick_size: ["0.01"],
      taker_fee_bps: ["700"],
      maker_fee_bps: ["0"],
      fee_base_bps: ["700"],
    });
    expect(two).toBe(one);
    const shuffled = regimeFingerprint({
      ...CRYPTO_PARAMS,
      tick_size: ["0.01"],
    });
    expect(shuffled).toBe(one);
  });

  it("changes when the fee schedule changes", () => {
    const changed = regimeFingerprint({
      ...CRYPTO_PARAMS,
      taker_fee_bps: ["300"],
    });
    expect(changed).not.toBe(regimeFingerprint(CRYPTO_PARAMS));
  });

  it("changes when a new tick value enters the category", () => {
    const changed = regimeFingerprint({
      ...CRYPTO_PARAMS,
      tick_size: ["0.001", "0.01"],
    });
    expect(changed).not.toBe(regimeFingerprint(CRYPTO_PARAMS));
  });
});

describe("regime fingerprint against the store (the 2026-08-28 flap)", () => {
  // Measured in production: 11 clock resets in ~44 h with ZERO venue changes —
  // 124 fee_base observations flipping between NULL and "1000", 93 tick_size
  // observations moving with the price band, and universe rotation vacating
  // rare tuples. The fingerprint must be a function of the venue's fee/tick
  // schedule for the category, never of which markets currently attest it.
  //
  // The fake pool serves both the released query (keyed on its
  // "p.valid_to IS NULL" filter, rows per market) and the schedule query
  // (rows per category/param/value), so this test expresses the semantics
  // rather than one implementation's SQL.

  interface MarketState {
    readonly condition: string;
    readonly fee: string | null;
    readonly tick: string;
  }

  function rowsFor(
    markets: readonly MarketState[],
    text: string,
  ): Record<string, unknown>[] {
    if (!text.includes("polymarket_param_versions")) {
      return [];
    }
    if (text.includes("p.valid_to IS NULL")) {
      // The released shape: one row per market currently in force.
      return markets.map((m) => ({
        category: "crypto",
        fee_base_bps: m.fee,
        maker_fee_bps: null,
        taker_fee_bps: null,
        tick_size: m.tick,
        min_order_size: "5",
        neg_risk: false,
      }));
    }
    // The schedule shape: distinct (category, param, value) from each
    // market's latest non-null observation.
    const domains = new Map<string, Set<string>>();
    for (const m of markets) {
      if (m.fee !== null) {
        const fees = domains.get("fee_base_bps") ?? new Set<string>();
        fees.add(m.fee);
        domains.set("fee_base_bps", fees);
      }
      const ticks = domains.get("tick_size") ?? new Set<string>();
      ticks.add(m.tick);
      domains.set("tick_size", ticks);
      const minimums = domains.get("min_order_size") ?? new Set<string>();
      minimums.add("5");
      domains.set("min_order_size", minimums);
    }
    const rows: Record<string, unknown>[] = [];
    for (const [param, values] of domains) {
      for (const value of values) {
        rows.push({ category: "crypto", param, value });
      }
    }
    return rows;
  }

  function poolFor(markets: readonly MarketState[]): {
    query: <R extends Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ) => Promise<{ rows: R[]; rowCount: number }>;
  } {
    return {
      query<R extends Record<string, unknown>>(text: string) {
        const rows = rowsFor(markets, text) as R[];
        return Promise.resolve({ rows, rowCount: rows.length });
      },
    };
  }

  async function fingerprintOf(
    markets: readonly MarketState[],
  ): Promise<string> {
    const byCategory = await loadRegimeParamsByCategory(poolFor(markets));
    const crypto = byCategory["crypto"];
    expect(crypto).toBeDefined();
    if (crypto === undefined) {
      throw new Error("unreachable");
    }
    // Typed through the function's own parameter so the test file compiles on
    // either side of the schedule change and measures behaviour, not types.
    return regimeFingerprint(crypto as Parameters<typeof regimeFingerprint>[0]);
  }

  it("holds the fingerprint under rotation and observation noise", async () => {
    // t0: A attests fee 1000 / tick 0.001; B's observation omits the fee and
    // sits in the 0.01 band. Both values of tick are venue schedule.
    const before = await fingerprintOf([
      { condition: "A", fee: "1000", tick: "0.001" },
      { condition: "B", fee: null, tick: "0.01" },
    ]);
    // t1: A left the universe but its attestation stands (schedule queries read
    // every market ever seen — modelled here by keeping A's last observation),
    // B was re-observed WITH the fee and its price moved into the 0.001 band,
    // and C joined with values the venue already applies. No venue change.
    const after = await fingerprintOf([
      { condition: "A", fee: "1000", tick: "0.01" },
      { condition: "B", fee: "1000", tick: "0.001" },
      { condition: "C", fee: "1000", tick: "0.001" },
    ]);
    expect(after).toBe(before);
  });

  it("still resets when the venue really changes the fee", async () => {
    const before = await fingerprintOf([
      { condition: "A", fee: "1000", tick: "0.001" },
      { condition: "B", fee: "1000", tick: "0.01" },
    ]);
    // The venue moves the category fee to 700: re-observed markets attest the
    // new value while A's departed attestation keeps the old one in history.
    const after = await fingerprintOf([
      { condition: "A", fee: "1000", tick: "0.001" },
      { condition: "B", fee: "700", tick: "0.01" },
      { condition: "C", fee: "700", tick: "0.001" },
    ]);
    expect(after).not.toBe(before);
    const plans = planClockResets({
      clocks: [
        {
          category: "crypto",
          clockStart: new Date("2026-06-01T00:00:00Z"),
          regimeFingerprint: before,
          lastResetReason: null,
        },
      ],
      currentFingerprints: { crypto: after },
      now: NOW,
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.reason).toBe("regime_fingerprint_changed");
  });
});

describe("the G2 clock resets on a regime change", () => {
  // Computed lazily (inside each test) so a revision where regimeFingerprint
  // rejects this shape fails the tests, never the file's collection.
  const fingerprint = () => regimeFingerprint(CRYPTO_PARAMS);

  it("starts a clock for a category that has none", () => {
    const plans = planClockResets({
      clocks: [],
      currentFingerprints: { crypto: fingerprint() },
      now: NOW,
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.reason).toBe("clock_started");
    expect(plans[0]?.previousStart).toBeNull();
  });

  it("leaves a clock alone while the regime holds", () => {
    const plans = planClockResets({
      clocks: [
        {
          category: "crypto",
          clockStart: new Date("2026-06-01T00:00:00Z"),
          regimeFingerprint: fingerprint(),
          lastResetReason: null,
        },
      ],
      currentFingerprints: { crypto: fingerprint() },
      now: NOW,
    });
    expect(plans).toEqual([]);
  });

  it("RESETS the clock when an injected fee schedule change lands", () => {
    // The RFC's mandatory test. A reset is not a smaller number averaged in: it
    // throws the elapsed days away, because they were measured under a regime
    // that no longer exists.
    const changed = regimeFingerprint({
      ...CRYPTO_PARAMS,
      taker_fee_bps: ["300"],
    });
    const clockStart = new Date("2026-06-01T00:00:00Z");
    const plans = planClockResets({
      clocks: [
        {
          category: "crypto",
          clockStart,
          regimeFingerprint: fingerprint(),
          lastResetReason: null,
        },
      ],
      currentFingerprints: { crypto: changed },
      now: NOW,
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.reason).toBe("regime_fingerprint_changed");
    expect(plans[0]?.previousStart).toEqual(clockStart);
    expect(plans[0]?.newStart).toEqual(NOW);
    expect(plans[0]?.previousFingerprint).toBe(fingerprint());
    expect(plans[0]?.newFingerprint).toBe(changed);
  });

  it("resets only the affected category", () => {
    // "reseta o relógio do G2 para as categorias afetadas" — the RFC is precise
    // about the scope, and fees differ by category.
    const changed = regimeFingerprint({
      ...CRYPTO_PARAMS,
      taker_fee_bps: ["300"],
    });
    const plans = planClockResets({
      clocks: [
        {
          category: "crypto",
          clockStart: new Date("2026-06-01T00:00:00Z"),
          regimeFingerprint: fingerprint(),
          lastResetReason: null,
        },
        {
          category: "macro",
          clockStart: new Date("2026-06-01T00:00:00Z"),
          regimeFingerprint: fingerprint(),
          lastResetReason: null,
        },
      ],
      currentFingerprints: { crypto: changed, macro: fingerprint() },
      now: NOW,
    });
    expect(plans.map((plan) => plan.category)).toEqual(["crypto"]);
  });
});

describe("forecast selection (G1)", () => {
  const base: ForecastRow = {
    conditionId: "0xa",
    modelProbability: 0.7,
    marketProbability: 0.6,
    label: "1",
    outcomeKnownAt: new Date("2026-08-20T00:00:00Z"),
    forecastAt: new Date("2026-08-19T00:00:00Z"),
    source: "MODEL",
  };

  it("keeps a clean binary forecast", () => {
    const selection = selectForecasts([base]);
    expect(selection.forecasts).toHaveLength(1);
    expect(selection.forecasts[0]?.outcome).toBe(1);
  });

  it("EXCLUDES a 0.50 label and counts it", () => {
    // A 50/50 UMA report is a real outcome on this venue, but it is not binary:
    // scoring it as 0 or 1 would be inventing an answer. The count matters
    // because a book full of 50/50s must not look like a clean sample.
    const selection = selectForecasts([{ ...base, label: "0.5" }]);
    expect(selection.forecasts).toHaveLength(0);
    expect(selection.excluded.fifty_fifty_label).toBe(1);
  });

  it("EXCLUDES a row with no publicly-knowable instant", () => {
    // With no instant to compare against, the leakage check cannot run, and a
    // forecast whose honesty cannot be checked is not evidence.
    const selection = selectForecasts([{ ...base, outcomeKnownAt: null }]);
    expect(selection.forecasts).toHaveLength(0);
    expect(selection.excluded.no_outcome_instant).toBe(1);
  });

  it("EXCLUDES a row with no recorded market probability", () => {
    // G1 requires beating the price, which needs the price.
    const selection = selectForecasts([{ ...base, marketProbability: null }]);
    expect(selection.forecasts).toHaveLength(0);
    expect(selection.excluded.no_market_probability).toBe(1);
  });
});

describe("reconciliation (G4)", () => {
  it("reports positive bias when the simulator was more expensive than the book", () => {
    // Conservative, and acceptable: paying more than the book would have is not
    // the direction that makes a paper record meaningless.
    const result = reconcile([
      {
        side: "BUY",
        simulatedFeeUsd: 0.5,
        realFeeUsd: 0.5,
        feeReference: "VENUE_TRADE_FEED",
        simulatedPrice: 0.52,
        bookWalkPrice: 0.5,
        priceReference: "DECISION_BOOK",
      },
    ]);
    expect(result.slippageBias).toBeCloseTo(0.02, 6);
    expect(result.feeMedianError).toBe(0);
  });

  it("reports NEGATIVE bias when the simulator filled better than the book", () => {
    // This is the optimistic bias the RFC forbids, and evaluateG4 fails on it.
    const result = reconcile([
      {
        side: "BUY",
        simulatedFeeUsd: 0.5,
        realFeeUsd: 0.5,
        feeReference: "VENUE_TRADE_FEED",
        simulatedPrice: 0.48,
        bookWalkPrice: 0.5,
        priceReference: "DECISION_BOOK",
      },
    ]);
    expect(result.slippageBias).toBeLessThan(0);
  });

  it("flips the sign for a SELL: receiving less is the conservative side", () => {
    const result = reconcile([
      {
        side: "SELL",
        simulatedFeeUsd: 0,
        realFeeUsd: null,
        feeReference: null,
        simulatedPrice: 0.48,
        bookWalkPrice: 0.5,
        priceReference: "DECISION_BOOK",
      },
    ]);
    expect(result.slippageBias).toBeCloseTo(0.02, 6);
    expect(result.feeMedianError).toBeNull();
    expect(result.feeSamples).toBe(0);
  });

  it("returns nulls with nothing to compare, so G4 stays INSUFFICIENT_DATA", () => {
    const result = reconcile([]);
    expect(result.feeMedianError).toBeNull();
    expect(result.slippageBias).toBeNull();
  });

  it("EXCLUDES a reference re-derived from the observation the fill consumed", () => {
    // The G1 incident, in the reconciliation. Re-walking the very snapshot the
    // simulator filled against is the same query over the same table for the
    // same levels: the bias is zero by construction, and `bias >= 0` cannot
    // fail. Such a sample is counted, never averaged — "no samples" and "no
    // HONEST samples" are different situations for whoever reads the gate.
    const result = reconcile([
      {
        side: "BUY",
        simulatedFeeUsd: 0.5,
        realFeeUsd: 0.5,
        feeReference: "SIMULATOR_OWN_RATE",
        simulatedPrice: 0.5,
        bookWalkPrice: 0.5,
        priceReference: "EXECUTION_BOOK",
      },
    ]);
    expect(result.slippageBias).toBeNull();
    expect(result.feeMedianError).toBeNull();
    expect(result.slippageSamples).toBe(0);
    expect(result.feeSamples).toBe(0);
    expect(result.selfReferentialSlippageSamples).toBe(1);
    expect(result.selfReferentialFeeSamples).toBe(1);
  });

  it("keeps the independent samples and drops only the self-referential ones", () => {
    const result = reconcile([
      {
        side: "BUY",
        simulatedFeeUsd: 0.5,
        realFeeUsd: 0.5,
        feeReference: "VENUE_TRADE_FEED",
        simulatedPrice: 0.52,
        bookWalkPrice: 0.5,
        priceReference: "DECISION_BOOK",
      },
      {
        side: "BUY",
        simulatedFeeUsd: 9,
        realFeeUsd: 9,
        feeReference: "SIMULATOR_OWN_RATE",
        simulatedPrice: 0.5,
        bookWalkPrice: 0.5,
        priceReference: "EXECUTION_BOOK",
      },
    ]);
    expect(result.slippageSamples).toBe(1);
    expect(result.feeSamples).toBe(1);
    expect(result.selfReferentialSlippageSamples).toBe(1);
    expect(result.selfReferentialFeeSamples).toBe(1);
    expect(result.slippageBias).toBeCloseTo(0.02, 6);
  });
});

describe("the full measurement", () => {
  const DAY_MS = 24 * 3_600_000;
  /** A paper book long, broad and spread enough to clear the evidence base. */
  const PAPER_BOOK = Array.from({ length: 150 }, (_unused, i) => ({
    pnl: 2 + (i % 5) * 0.2,
    conditionId: `0x${String(i % 40)}`,
    category: i % 2 === 0 ? "crypto" : "macro",
    closedAt: new Date(NOW.getTime() - (150 - i) * (DAY_MS / 2)),
  }));

  const EMPTY: MeasureGatesInput = {
    now: NOW,
    config: GATES,
    forecastRows: [],
    closed: [],
    clockStart: null,
    unblockedBreaches: 0,
    maxDrawdown: 0,
    drawdownMax: 0.1,
    breakersExercised: [],
    reconciliation: {
      feeMedianError: null,
      slippageBias: null,
      feeSamples: 0,
      slippageSamples: 0,
      selfReferentialFeeSamples: 0,
      selfReferentialSlippageSamples: 0,
    },
    soakDays: 0,
    killSwitchExercised: false,
    reduceOnlyExercised: false,
    clocks: [],
    currentFingerprints: {},
    approval: null,
    currentReportId: null,
  };

  it("produces exactly one row per gate", () => {
    const result = measureGates(EMPTY);
    expect(result.measurements.map((m) => m.gate)).toEqual([
      "G1",
      "G2",
      "G3",
      "G4",
      "G5",
      "G6",
    ]);
  });

  it("keeps RFC-009 BLOCKED on a fresh engine, and says INSUFFICIENT_DATA", () => {
    // The honest state of a portfolio that has not traded: not enough evidence,
    // deliberately distinct from "we measured and it did not work".
    const result = measureGates(EMPTY);
    expect(result.overall).toBe("BLOCKED");
    const g2 = result.measurements.find((m) => m.gate === "G2");
    expect(g2?.status).toBe("INSUFFICIENT_DATA");
    expect(g2?.reasonCode).toBe("G2_INSUFFICIENT_PAPER");
  });

  it("every non-PASS row carries a reason code", () => {
    // The migration's CHECK enforces this at the database; the measurement must
    // not be the thing that trips it.
    for (const measurement of measureGates(EMPTY).measurements) {
      if (measurement.status !== "PASS") {
        expect(measurement.reasonCode, measurement.gate).not.toBeNull();
      }
    }
  });

  it("G3 is INSUFFICIENT_DATA over an empty book, even with every breaker exercised", () => {
    // The shape the G1 incident had: zero positions produce zero unblocked
    // breaches and zero drawdown, so the survival facts read perfect over a
    // book that never existed. This measurement used to report PASS.
    const g3 = measureGates({
      ...EMPTY,
      breakersExercised: [...BREAKER_KINDS],
    }).measurements.find((m) => m.gate === "G3");
    expect(g3?.status).toBe("INSUFFICIENT_DATA");
    expect(g3?.status).not.toBe("PASS");
  });

  it("G3 fails until EVERY breaker kind has been exercised", () => {
    // Over a book that is actually long enough to have survived something.
    const withBook = {
      ...EMPTY,
      closed: PAPER_BOOK,
      clockStart: new Date(NOW.getTime() - 90 * DAY_MS),
    };
    const partial = measureGates({
      ...withBook,
      breakersExercised: [...BREAKER_KINDS].slice(0, 2),
    });
    const g3 = partial.measurements.find((m) => m.gate === "G3");
    expect(g3?.status).toBe("FAIL");
    expect(g3?.reasonCode).toBe("G3_RISK_BREACH");

    const complete = measureGates({
      ...withBook,
      breakersExercised: [...BREAKER_KINDS],
    });
    expect(complete.measurements.find((m) => m.gate === "G3")?.status).toBe(
      "PASS",
    );
  });

  it("G1 records what it excluded, so the sample cannot be read as clean", () => {
    const result = measureGates({
      ...EMPTY,
      forecastRows: [
        {
          conditionId: "0xa",
          modelProbability: 0.7,
          marketProbability: 0.6,
          label: "0.5",
          outcomeKnownAt: new Date("2026-08-20T00:00:00Z"),
          forecastAt: new Date("2026-08-19T00:00:00Z"),
          source: "MODEL",
        },
      ],
    });
    const g1 = result.measurements.find((m) => m.gate === "G1");
    expect(g1?.metrics.candidate_rows).toBe(1);
    expect(g1?.metrics.scored_forecasts).toBe(0);
    expect(g1?.status).toBe("INSUFFICIENT_DATA");
  });

  it("G1 FAILS on a leaking label rather than scoring it", () => {
    // A forecast made at or after the outcome was knowable is not a forecast,
    // and one such row poisons the whole score.
    const leaking = Array.from({ length: 120 }, (_, index) => ({
      conditionId: `0x${String(index)}`,
      modelProbability: 0.9,
      marketProbability: 0.5,
      label: index % 2 === 0 ? "1" : "0",
      outcomeKnownAt: new Date("2026-08-20T00:00:00Z"),
      // AFTER the outcome was knowable.
      forecastAt: new Date("2026-08-21T00:00:00Z"),
      source: "MODEL",
    }));
    const g1 = measureGates({
      ...EMPTY,
      forecastRows: leaking,
    }).measurements.find((m) => m.gate === "G1");
    expect(g1?.status).toBe("FAIL");
    expect(g1?.reasonCode).toBe("G1_CALIBRATION_NOT_MET");
    expect(g1?.metrics.leaking_forecasts).toBe(120);
  });

  it("one non-PASS gate is enough to keep the verdict BLOCKED", () => {
    // No weighting, no "mostly passing", no override.
    const result = measureGates({
      ...EMPTY,
      closed: PAPER_BOOK,
      clockStart: new Date(NOW.getTime() - 90 * DAY_MS),
      breakersExercised: [...BREAKER_KINDS],
    });
    expect(
      result.measurements.filter((m) => m.status === "PASS").length,
    ).toBeGreaterThan(0);
    expect(result.overall).toBe("BLOCKED");
  });
});
