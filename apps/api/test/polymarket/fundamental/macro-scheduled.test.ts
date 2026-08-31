import { describe, expect, it, vi } from "vitest";

import { DEFAULT_FUNDAMENTAL_CONFIG } from "../../../src/polymarket/fundamental/config.js";
import {
  AsOfGuard,
  type MacroCalendarContext,
  type MacroReleaseContext,
  type MarketContext,
} from "../../../src/polymarket/fundamental/features.js";
import {
  DEFAULT_MACRO_HYPERPARAMS,
  estimateMacroScheduled,
  MACRO_FEATURE_SET_VERSION,
  MACRO_MODEL_FAMILY,
  MACRO_MODEL_VERSION,
  type MacroMarketSpec,
  type MacroModelInput,
  parseMacroHyperparams,
  parseMacroMarket,
} from "../../../src/polymarket/fundamental/models/macro-scheduled.js";
import type { ModelResult } from "../../../src/polymarket/fundamental/types.js";

const DECISION_TS = new Date("2026-09-10T12:00:00.000Z");
const CPI_RELEASE_AT = new Date("2026-09-11T12:30:00.000Z");
const CALENDAR_SOURCE_TS = new Date("2026-09-01T00:00:00.000Z");

function calendarEntry(
  overrides: Partial<MacroCalendarContext> = {},
): MacroCalendarContext {
  return {
    source: "bls",
    eventKey: "cpi-2026-09",
    eventName: "CPI (August 2026 data)",
    scheduledAt: CPI_RELEASE_AT,
    version: 1,
    payload: {
      series_id: "CUSR0000SA0",
      year: "2026",
      period: "M08",
      consensus: 3.1,
      consensus_std: 0.15,
    },
    sourceTs: CALENDAR_SOURCE_TS,
    ...overrides,
  };
}

/** The curated RFC-007 calendar shape: several months per family in flight. */
const CALENDAR: readonly MacroCalendarContext[] = [
  calendarEntry(),
  calendarEntry({
    eventKey: "cpi-2026-10",
    eventName: "CPI (September 2026 data)",
    scheduledAt: new Date("2026-10-13T12:30:00.000Z"),
    payload: { series_id: "CUSR0000SA0", year: "2026", period: "M09" },
  }),
  calendarEntry({
    eventKey: "nfp-2026-09",
    eventName: "Employment Situation / Nonfarm Payrolls (August 2026 data)",
    scheduledAt: new Date("2026-09-04T12:30:00.000Z"),
    payload: { series_id: "CES0000000001", year: "2026", period: "M08" },
  }),
  calendarEntry({
    source: "fomc",
    eventKey: "fomc-2026-09",
    eventName: "FOMC statement (meeting Sep 15-16, 2026)",
    scheduledAt: new Date("2026-09-16T18:00:00.000Z"),
    payload: {},
  }),
];

function context(overrides: Partial<MarketContext> = {}): MarketContext {
  return {
    conditionId: "0xcondition",
    question: "Will US CPI year-over-year for August 2026 be above 3.0%?",
    slug: "us-cpi-yoy-august-2026-above-3",
    gammaCategory: "macro",
    tokenIds: ["token-yes", "token-no"],
    endDate: new Date("2026-09-30T00:00:00.000Z"),
    rulesText:
      "This market resolves to YES if the year-over-year change in the US " +
      "Consumer Price Index for All Urban Consumers for August 2026, as " +
      "first published by the Bureau of Labor Statistics on 2026-09-11, is " +
      "above 3.0%. Otherwise this market resolves to NO.",
    resolutionSource: "https://www.bls.gov/news.release/cpi.nr0.htm",
    ruleVersion: 2,
    ruleValidFrom: new Date("2026-08-01T00:00:00.000Z"),
    paramVersion: 1,
    tickSize: "0.01",
    umaDisputeActive: false,
    ruleChangedRecently: false,
    ...overrides,
  };
}

function spec(overrides: Partial<MacroMarketSpec> = {}): MacroMarketSpec {
  return {
    variable: "cpi_yoy",
    comparison: "gt",
    threshold: 3,
    source: "bls",
    eventKey: "cpi-2026-09",
    releaseAt: CPI_RELEASE_AT,
    ...overrides,
  };
}

function release(
  overrides: Partial<MacroReleaseContext> = {},
): MacroReleaseContext {
  return {
    source: "bls",
    eventKey: "cpi-2026-09",
    value: "3.4",
    publishedAt: CPI_RELEASE_AT,
    sourceTs: null,
    payload: { year: "2026", period: "M08" },
    ...overrides,
  };
}

function modelInput(overrides: Partial<MacroModelInput> = {}): MacroModelInput {
  const decisionTs = overrides.decisionTs ?? DECISION_TS;
  return {
    spec: spec(),
    decisionTs,
    calendar: calendarEntry(),
    release: null,
    thinBook: false,
    config: DEFAULT_FUNDAMENTAL_CONFIG,
    hyperparams: DEFAULT_MACRO_HYPERPARAMS,
    guard: new AsOfGuard(decisionTs),
    ...overrides,
  };
}

function expectOk(result: ModelResult): {
  q: number;
  sigma: number;
  refs: Record<string, unknown>;
  thinBook: boolean;
  feedStale: boolean;
} {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("model abstained unexpectedly");
  }
  return {
    q: result.value.q,
    sigma: result.value.sigma,
    refs: result.value.dataRefs,
    thinBook: result.value.thinBook,
    feedStale: result.value.feedStale,
  };
}

function silenceStderr(): void {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
}

describe("parseMacroMarket", () => {
  it("parses an unambiguous CPI rule into a complete spec", () => {
    const result = parseMacroMarket(context(), CALENDAR);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.spec).toEqual({
      variable: "cpi_yoy",
      comparison: "gt",
      threshold: 3,
      source: "bls",
      // The rule names its own release DAY, which is the most precise
      // identifier of which release the market is about.
      eventKey: "cpi-2026-09",
      releaseAt: CPI_RELEASE_AT,
    });
  });

  it("prefers the comparison of the YES clause over the NO clause", () => {
    const result = parseMacroMarket(
      context({
        rulesText:
          "This market resolves to YES if the year-over-year US Consumer " +
          "Price Index for August 2026 published by the Bureau of Labor " +
          "Statistics is above 3.0%. This market resolves to NO if it is " +
          "below 3.0%.",
      }),
      CALENDAR,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.spec.comparison).toBe("gt");
    expect(result.spec.eventKey).toBe("cpi-2026-09");
  });

  it("excludes conflicting comparisons when no YES clause disambiguates", () => {
    // Same two comparisons as the test above, with the YES marker removed:
    // without it there is nothing to prefer, and the market is excluded. This
    // is what makes the YES-clause preference load-bearing rather than decorative.
    expect(
      parseMacroMarket(
        context({
          rulesText:
            "The outcome is decided by the year-over-year US Consumer Price " +
            "Index for August 2026 published by the Bureau of Labor " +
            "Statistics being above 3.0%. The opposite outcome applies if it " +
            "is below 3.0%.",
          question: "US CPI year-over-year for August 2026",
        }),
        CALENDAR,
      ),
    ).toEqual({ ok: false, reason: "NO_COMPARISON" });
  });

  it("parses a core CPI rule and a month-over-month rule apart", () => {
    const core = parseMacroMarket(
      context({
        question: "Will core CPI year-over-year for August 2026 be below 3.0%?",
        rulesText:
          "Resolves to YES if the year-over-year core CPI for August 2026 " +
          "published by the Bureau of Labor Statistics is below 3.0%.",
      }),
      CALENDAR,
    );
    expect(core.ok).toBe(true);
    if (core.ok) {
      expect(core.spec.variable).toBe("core_cpi_yoy");
      expect(core.spec.comparison).toBe("lt");
    }

    const monthly = parseMacroMarket(
      context({
        question: "Will CPI month-over-month for August 2026 be at least 0.3%?",
        rulesText:
          "Resolves to YES if the month-over-month CPI for August 2026 " +
          "published by the Bureau of Labor Statistics is at least 0.3%.",
      }),
      CALENDAR,
    );
    expect(monthly.ok).toBe(true);
    if (monthly.ok) {
      expect(monthly.spec.variable).toBe("cpi_mom");
      expect(monthly.spec.comparison).toBe("gte");
      expect(monthly.spec.threshold).toBeCloseTo(0.3, 12);
    }
  });

  it("parses payroll counts written with separators or a k suffix", () => {
    const grouped = parseMacroMarket(
      context({
        question: "Will August 2026 nonfarm payrolls come in above 150,000?",
        rulesText:
          "Resolves to YES if the change in total nonfarm payroll " +
          "employment for August 2026 first published by the Bureau of " +
          "Labor Statistics is above 150,000.",
      }),
      CALENDAR,
    );
    expect(grouped.ok).toBe(true);
    if (grouped.ok) {
      expect(grouped.spec.variable).toBe("nonfarm_payrolls");
      expect(grouped.spec.threshold).toBe(150_000);
      expect(grouped.spec.eventKey).toBe("nfp-2026-09");
    }

    const suffixed = parseMacroMarket(
      context({
        question: "Will August 2026 nonfarm payrolls come in above 150k?",
        rulesText:
          "Resolves to YES if the change in total nonfarm payroll " +
          "employment for August 2026 first published by the Bureau of " +
          "Labor Statistics is above 150k.",
      }),
      CALENDAR,
    );
    expect(suffixed.ok).toBe(true);
    if (suffixed.ok) {
      expect(suffixed.spec.threshold).toBe(150_000);
    }
  });

  it("parses the unemployment rate and the Fed target rate", () => {
    const unemployment = parseMacroMarket(
      context({
        question:
          "Will the US unemployment rate for August 2026 be at least 4.5%?",
        rulesText:
          "Resolves to YES if the unemployment rate for August 2026 first " +
          "published by the Bureau of Labor Statistics is at least 4.5%.",
        resolutionSource: "https://www.bls.gov/news.release/empsit.nr0.htm",
      }),
      CALENDAR,
    );
    expect(unemployment.ok).toBe(true);
    if (unemployment.ok) {
      expect(unemployment.spec.variable).toBe("unemployment_rate");
      expect(unemployment.spec.source).toBe("bls");
      expect(unemployment.spec.eventKey).toBe("nfp-2026-09");
    }

    const fed = parseMacroMarket(
      context({
        question:
          "Will the federal funds target rate be above 3.5% after the " +
          "September 2026 meeting?",
        rulesText:
          "Resolves to YES if the upper bound of the federal funds target " +
          "rate announced by the Federal Open Market Committee on " +
          "2026-09-16 is above 3.5%.",
        resolutionSource:
          "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
      }),
      CALENDAR,
    );
    expect(fed.ok).toBe(true);
    if (fed.ok) {
      expect(fed.spec.variable).toBe("fed_target_rate");
      expect(fed.spec.source).toBe("fomc");
      expect(fed.spec.eventKey).toBe("fomc-2026-09");
      expect(fed.spec.threshold).toBeCloseTo(3.5, 12);
    }
  });

  it("excludes a rule carrying two distinct thresholds", () => {
    const result = parseMacroMarket(
      context({
        rulesText:
          "This market resolves to YES if the year-over-year US Consumer " +
          "Price Index for August 2026 published by the Bureau of Labor " +
          "Statistics is above 3.0%. The market is void if the BLS later " +
          "revises the print by more than 0.2 percentage points.",
      }),
      CALENDAR,
    );
    expect(result).toEqual({ ok: false, reason: "AMBIGUOUS_THRESHOLD" });
  });

  it("excludes a rule that reserves discretion, threshold or not", () => {
    const result = parseMacroMarket(
      context({
        rulesText:
          "This market resolves to YES if the year-over-year US Consumer " +
          "Price Index for August 2026 published by the Bureau of Labor " +
          "Statistics is above 3.0%, at the discretion of the resolver.",
      }),
      CALENDAR,
    );
    expect(result).toEqual({ ok: false, reason: "AMBIGUOUS_THRESHOLD" });
  });

  it("excludes an unknown variable and a CPI rule with no stated basis", () => {
    expect(
      parseMacroMarket(
        context({
          question: "Will the S&P 500 close above 6,000 in August 2026?",
          rulesText:
            "Resolves to YES if the S&P 500 index closes above 6,000 on any " +
            "trading day in August 2026.",
        }),
        CALENDAR,
      ),
    ).toEqual({ ok: false, reason: "UNRECOGNIZED_VARIABLE" });

    // 3.2 is a plausible year-over-year print and 0.3 a plausible
    // month-over-month one: without a stated basis the parser refuses.
    expect(
      parseMacroMarket(
        context({
          question: "Will US CPI for August 2026 be above 3.0%?",
          rulesText:
            "Resolves to YES if the CPI for August 2026 published by the " +
            "Bureau of Labor Statistics is above 3.0%.",
        }),
        CALENDAR,
      ),
    ).toEqual({ ok: false, reason: "UNRECOGNIZED_VARIABLE" });
  });

  it("excludes a Fed market that is about a change rather than a level", () => {
    expect(
      parseMacroMarket(
        context({
          question:
            "Will the FOMC deliver a 25 bps rate cut in September 2026?",
          rulesText:
            "Resolves to YES if the Federal Open Market Committee announces " +
            "a rate cut of 25 basis points on 2026-09-16.",
          resolutionSource:
            "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
        }),
        CALENDAR,
      ),
    ).toEqual({ ok: false, reason: "UNRECOGNIZED_VARIABLE" });
  });

  it("reports the missing piece: threshold, comparison, source, calendar", () => {
    expect(
      parseMacroMarket(
        context({
          question: "Will US CPI year-over-year rise in August 2026?",
          rulesText:
            "Resolves to YES if the year-over-year CPI for August 2026 " +
            "published by the Bureau of Labor Statistics increases.",
        }),
        CALENDAR,
      ),
    ).toEqual({ ok: false, reason: "NO_THRESHOLD" });

    expect(
      parseMacroMarket(
        context({
          question: "Will US CPI year-over-year for August 2026 print 3.0%?",
          rulesText:
            "Resolves to YES if the year-over-year CPI for August 2026 " +
            "published by the Bureau of Labor Statistics prints 3.0%.",
        }),
        CALENDAR,
      ),
    ).toEqual({ ok: false, reason: "NO_COMPARISON" });

    expect(
      parseMacroMarket(
        context({
          rulesText:
            "Resolves to YES if the year-over-year CPI for August 2026 " +
            "published by the official statistical agency is above 3.0%.",
          resolutionSource: null,
        }),
        CALENDAR,
      ),
    ).toEqual({ ok: false, reason: "NO_SOURCE" });

    expect(
      parseMacroMarket(
        context({
          question:
            "Will US CPI year-over-year for December 2026 be above 3.0%?",
          rulesText:
            "Resolves to YES if the year-over-year CPI for December 2026 " +
            "published by the Bureau of Labor Statistics is above 3.0%.",
        }),
        CALENDAR,
      ),
    ).toEqual({ ok: false, reason: "NO_CALENDAR_MATCH" });
  });

  it("excludes a market with no rule text and no question", () => {
    expect(
      parseMacroMarket(context({ rulesText: null, question: "" }), CALENDAR),
    ).toEqual({ ok: false, reason: "UNRECOGNIZED_VARIABLE" });
  });

  it("is deterministic: the same context parses to the same spec", () => {
    const first = parseMacroMarket(context(), CALENDAR);
    const second = parseMacroMarket(context(), CALENDAR);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("parseMacroHyperparams", () => {
  it("falls back to the module config when nothing is stored", () => {
    const parsed = parseMacroHyperparams(undefined, DEFAULT_FUNDAMENTAL_CONFIG);
    expect(parsed).toEqual(DEFAULT_MACRO_HYPERPARAMS);
    expect(parsed.underReactionCoefficient).toBeCloseTo(0.64, 12);
  });

  it("applies valid overrides and keeps the per-variable sigma map", () => {
    const parsed = parseMacroHyperparams(
      {
        default_sigma: { cpi_yoy: 0.2 },
        post_release_window_ms: 3_600_000,
        under_reaction_coefficient: 0.5,
      },
      DEFAULT_FUNDAMENTAL_CONFIG,
    );
    expect(parsed.defaultSigma.cpi_yoy).toBeCloseTo(0.2, 12);
    expect(parsed.defaultSigma.nonfarm_payrolls).toBe(60_000);
    expect(parsed.postReleaseWindowMs).toBe(3_600_000);
    expect(parsed.underReactionCoefficient).toBeCloseTo(0.5, 12);
  });

  it("ignores out-of-range and unknown fields with a logged reason code", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const parsed = parseMacroHyperparams(
      {
        default_sigma: { cpi_yoy: -1 },
        under_reaction_coefficient: 4,
        surprise_edge: true,
      },
      DEFAULT_FUNDAMENTAL_CONFIG,
    );
    expect(parsed.defaultSigma.cpi_yoy).toBe(0.15);
    expect(parsed.underReactionCoefficient).toBeCloseTo(0.64, 12);
    expect(writes.join("")).toContain("MACRO_HYPERPARAM_INVALID");
    expect(writes.join("")).toContain("MACRO_HYPERPARAM_UNKNOWN");
  });
});

describe("estimateMacroScheduled (pre-release)", () => {
  it("prices the consensus normal and reports the model identity", () => {
    const output = expectOk(estimateMacroScheduled(modelInput()));
    // consensus 3.1, sigma 0.15, threshold 3.0, "gt":
    // q = 1 - Phi((3.0 - 3.1) / 0.15) = Phi(0.6667) = 0.747507.
    expect(output.q).toBeCloseTo(0.747507, 6);
    expect(output.refs.macroRegime).toBe("pre_release");
    expect(output.refs.macroConsensusKey).toBe("consensus");
    expect(output.refs.macroSigmaKey).toBe("consensus_std");
    expect(output.refs.macroSigmaSource).toBe("payload");
    expect(output.refs.macroEventKey).toBe("cpi-2026-09");
    expect(MACRO_MODEL_FAMILY).toBe("macro_scheduled_consensus");
    expect(MACRO_MODEL_VERSION).toBe("1.0.0");
    expect(MACRO_FEATURE_SET_VERSION).toBe("1.1.0");
  });

  it("reads the consensus of the market's own variable, not the entry's first number", () => {
    // One CPI release publishes three of this model's variables, and
    // matchCalendar pairs a market with the entry by FAMILY. The keyed form is
    // what lets the same entry serve a year-over-year and a month-over-month
    // market without either being priced on the other's scale.
    const payload = {
      series_id: "CUSR0000SA0",
      year: "2026",
      period: "M08",
      consensus_by_variable: {
        cpi_yoy: 3.37,
        cpi_mom: 0.36,
        core_cpi_yoy: 2.38,
      },
    };

    const yoy = expectOk(
      estimateMacroScheduled(
        modelInput({
          calendar: calendarEntry({ payload }),
          spec: spec({ variable: "cpi_yoy", threshold: 3.0 }),
        }),
      ),
    );
    // consensus 3.37, default sigma 0.15, threshold 3.0, "gt":
    // q = Phi((3.37 - 3.0) / 0.15) = Phi(2.46667) = 0.993181.
    expect(yoy.q).toBeCloseTo(0.993181, 6);
    expect(yoy.refs.macroConsensusKey).toBe("consensus_by_variable.cpi_yoy");
    expect(yoy.refs.macroSigmaSource).toBe("config_default");

    const mom = expectOk(
      estimateMacroScheduled(
        modelInput({
          calendar: calendarEntry({ payload }),
          spec: spec({ variable: "cpi_mom", threshold: 0.3 }),
        }),
      ),
    );
    // consensus 0.36, default sigma 0.08, threshold 0.3, "gt":
    // q = Phi((0.36 - 0.3) / 0.08) = Phi(0.75) = 0.773373. Had the model read
    // the year-over-year 3.37 here, q would have been pinned at the 0.999 cap.
    expect(mom.q).toBeCloseTo(0.773373, 6);
    expect(mom.refs.macroConsensusKey).toBe("consensus_by_variable.cpi_mom");
    expect(mom.q).toBeLessThan(0.999);

    const core = expectOk(
      estimateMacroScheduled(
        modelInput({
          calendar: calendarEntry({ payload }),
          spec: spec({ variable: "core_cpi_yoy", threshold: 3.0 }),
        }),
      ),
    );
    // 2.38 is BELOW the 3.0 threshold, so the same "gt" market that is nearly
    // certain on headline is nearly certain the other way on core.
    expect(core.q).toBeLessThan(0.001 + 1e-9);
  });

  it("abstains on a variable the entry's keyed consensus is silent about", () => {
    // Silence is not a licence to reach for a sibling variable's number.
    const result = estimateMacroScheduled(
      modelInput({
        calendar: calendarEntry({
          payload: { consensus_by_variable: { cpi_yoy: 3.37 } },
        }),
        spec: spec({ variable: "cpi_mom", threshold: 0.3 }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("MODEL_ABSTAINED");
    }
  });

  it("prefers the keyed consensus over a flat one and reads the keyed sigma", () => {
    const output = expectOk(
      estimateMacroScheduled(
        modelInput({
          calendar: calendarEntry({
            payload: {
              consensus: 9.9,
              consensus_std: 5,
              consensus_by_variable: { cpi_yoy: 3.1 },
              consensus_std_by_variable: { cpi_yoy: 0.15 },
            },
          }),
        }),
      ),
    );
    expect(output.q).toBeCloseTo(0.747507, 6);
    expect(output.refs.macroConsensusKey).toBe("consensus_by_variable.cpi_yoy");
    expect(output.refs.macroSigmaKey).toBe("consensus_std_by_variable.cpi_yoy");
    expect(output.refs.macroSigmaSource).toBe("payload");
  });

  it("still accepts the flat keys, which stay unambiguous for a one-variable family", () => {
    const output = expectOk(
      estimateMacroScheduled(
        modelInput({
          calendar: calendarEntry({
            source: "fomc",
            eventKey: "fomc-2026-09",
            payload: { consensus: 3.875 },
          }),
          spec: spec({
            variable: "fed_target_rate",
            source: "fomc",
            eventKey: "fomc-2026-09",
            threshold: 3.75,
          }),
        }),
      ),
    );
    expect(output.refs.macroConsensusKey).toBe("consensus");
    expect(output.refs.macroSigmaSource).toBe("config_default");
    expect(output.q).toBeGreaterThan(0.5);
  });

  it("moves q with the consensus, the threshold and the dispersion", () => {
    const base = expectOk(estimateMacroScheduled(modelInput()));

    const higherConsensus = expectOk(
      estimateMacroScheduled(
        modelInput({
          calendar: calendarEntry({
            payload: { consensus: 3.4, consensus_std: 0.15 },
          }),
        }),
      ),
    );
    expect(higherConsensus.q).toBeGreaterThan(base.q);

    const higherThreshold = expectOk(
      estimateMacroScheduled(modelInput({ spec: spec({ threshold: 3.3 }) })),
    );
    expect(higherThreshold.q).toBeLessThan(base.q);

    // Wider dispersion pulls a q above one half back toward one half.
    const widerSigma = expectOk(
      estimateMacroScheduled(
        modelInput({
          calendar: calendarEntry({
            payload: { consensus: 3.1, consensus_std: 0.6 },
          }),
        }),
      ),
    );
    expect(widerSigma.q).toBeLessThan(base.q);
    expect(widerSigma.q).toBeGreaterThan(0.5);
  });

  it("flips q when the comparison direction flips", () => {
    const above = expectOk(estimateMacroScheduled(modelInput()));
    const below = expectOk(
      estimateMacroScheduled(modelInput({ spec: spec({ comparison: "lt" }) })),
    );
    expect(above.q + below.q).toBeCloseTo(1, 12);

    // Under a continuous normal the closed comparisons coincide with the open
    // ones; 1.0.0 does not model the reporting grid.
    const atLeast = expectOk(
      estimateMacroScheduled(modelInput({ spec: spec({ comparison: "gte" }) })),
    );
    expect(atLeast.q).toBeCloseTo(above.q, 12);
  });

  it("uses the configured per-variable sigma when the payload omits one", () => {
    const output = expectOk(
      estimateMacroScheduled(
        modelInput({
          calendar: calendarEntry({ payload: { nowcast: 3.1 } }),
        }),
      ),
    );
    expect(output.refs.macroConsensusKey).toBe("nowcast");
    expect(output.refs.macroSigmaKey).toBeNull();
    expect(output.refs.macroSigmaSource).toBe("config_default");
    expect(output.refs.macroSigma).toBe((0.15).toFixed(6));
  });

  it("reports a dispersion in probability units, floored but never zero", () => {
    const output = expectOk(estimateMacroScheduled(modelInput()));
    expect(output.sigma).toBeGreaterThan(0.005);
    expect(output.sigma).toBeLessThan(0.5);

    // Consensus far from the threshold with a tiny dispersion: the finite
    // difference collapses to zero and the floor takes over.
    const floored = expectOk(
      estimateMacroScheduled(
        modelInput({
          calendar: calendarEntry({
            payload: { consensus: 9, consensus_std: 0.0001 },
          }),
        }),
      ),
    );
    expect(floored.sigma).toBe(0.005);
    expect(floored.q).toBeLessThanOrEqual(0.999);
  });

  it("always reports a thin book and propagates the caller's view", () => {
    expect(expectOk(estimateMacroScheduled(modelInput())).thinBook).toBe(true);
    expect(
      expectOk(estimateMacroScheduled(modelInput({ thinBook: true }))).thinBook,
    ).toBe(true);
  });

  it("flags a stale calendar row against the configured maximum age", () => {
    expect(expectOk(estimateMacroScheduled(modelInput())).feedStale).toBe(
      false,
    );
    const stale = expectOk(
      estimateMacroScheduled(
        modelInput({
          calendar: calendarEntry({
            sourceTs: new Date("2026-06-01T00:00:00.000Z"),
          }),
        }),
      ),
    );
    expect(stale.feedStale).toBe(true);
  });

  it("routes every input through the as-of guard", () => {
    const guard = new AsOfGuard(DECISION_TS);
    expectOk(estimateMacroScheduled(modelInput({ guard })));
    const names = guard.entries().map((entry) => entry.name);
    expect(names).toContain("macro_calendar");
    expect(names).toContain("macro_consensus");
    expect(names).toContain("macro_consensus_sigma");
    for (const entry of guard.entries()) {
      if (entry.sourceTs !== null) {
        expect(entry.sourceTs.getTime()).toBeLessThanOrEqual(
          DECISION_TS.getTime(),
        );
      }
    }
  });

  it("is deterministic: identical calls produce identical q, sigma and refs", () => {
    const first = expectOk(estimateMacroScheduled(modelInput()));
    const second = expectOk(estimateMacroScheduled(modelInput()));
    expect(second.q).toBe(first.q);
    expect(second.sigma).toBe(first.sigma);
    expect(JSON.stringify(second.refs)).toBe(JSON.stringify(first.refs));
  });
});

describe("estimateMacroScheduled (post-release)", () => {
  const insideWindow = new Date("2026-09-11T13:00:00.000Z");
  const outsideWindow = new Date("2026-09-11T15:00:00.000Z");

  it("blends the known outcome with the pre-release q inside the window", () => {
    const output = expectOk(
      estimateMacroScheduled(
        modelInput({ decisionTs: insideWindow, release: release() }),
      ),
    );
    // Pre-release q = 0.747507; the official 3.4 clears the 3.0 threshold, so
    // the outcome is 1 and the 0.64-per-1 hypothesis moves 64% of the gap.
    expect(output.q).toBeCloseTo(0.747507 + 0.64 * (1 - 0.747507), 6);
    expect(output.sigma).toBeCloseTo(0.36 * (1 - 0.747507), 6);
    expect(output.refs.macroRegime).toBe("post_release");
    expect(output.refs.macroKnownOutcome).toBe(1);
    expect(output.refs.macroReleaseValue).toBe((3.4).toFixed(6));
    expect(output.refs.macroUnderReaction).toBe((0.64).toFixed(6));
    expect(output.refs.releaseSourceTs).toBe(CPI_RELEASE_AT.toISOString());
  });

  it("moves toward zero when the official value misses the threshold", () => {
    const output = expectOk(
      estimateMacroScheduled(
        modelInput({
          decisionTs: insideWindow,
          release: release({ value: "2.8" }),
        }),
      ),
    );
    expect(output.refs.macroKnownOutcome).toBe(0);
    expect(output.q).toBeCloseTo(0.747507 * (1 - 0.64), 6);
  });

  it("stays pre-release while nothing is published", () => {
    const output = expectOk(
      estimateMacroScheduled(modelInput({ decisionTs: insideWindow })),
    );
    expect(output.refs.macroRegime).toBe("pre_release");
    expect(output.refs.releaseSourceTs).toBeNull();
  });

  it("abstains once the official value is older than the window", () => {
    expect(
      estimateMacroScheduled(
        modelInput({ decisionTs: outsideWindow, release: release() }),
      ),
    ).toEqual({ ok: false, reason: "MODEL_ABSTAINED" });
  });

  it("honours a hyperparameter window that reopens the regime", () => {
    const output = expectOk(
      estimateMacroScheduled(
        modelInput({
          decisionTs: outsideWindow,
          release: release(),
          hyperparams: parseMacroHyperparams(
            { post_release_window_ms: 6 * 3_600_000 },
            DEFAULT_FUNDAMENTAL_CONFIG,
          ),
        }),
      ),
    );
    expect(output.refs.macroRegime).toBe("post_release");
  });

  it("abstains on an unparsable or untimed official value", () => {
    expect(
      estimateMacroScheduled(
        modelInput({
          decisionTs: insideWindow,
          release: release({ value: "n/a" }),
        }),
      ),
    ).toEqual({ ok: false, reason: "MODEL_ABSTAINED" });

    expect(
      estimateMacroScheduled(
        modelInput({
          decisionTs: insideWindow,
          release: release({ publishedAt: null, sourceTs: null }),
        }),
      ),
    ).toEqual({ ok: false, reason: "MODEL_ABSTAINED" });
  });

  it("abstains when the official value is not on the consensus scale", () => {
    silenceStderr();
    // The motivating case is the payroll series: BLS publishes a LEVEL in
    // thousands while the market asks about the monthly change. A value that
    // far from the consensus is not on the consensus scale, and the guard
    // must catch it instead of pricing it.
    expect(
      estimateMacroScheduled(
        modelInput({
          decisionTs: insideWindow,
          release: release({ value: "160000" }),
        }),
      ),
    ).toEqual({ ok: false, reason: "MODEL_ABSTAINED" });
  });

  it("fails closed when a release from the future is handed to it", () => {
    silenceStderr();
    // The decision instant precedes the publication: the as-of guard refuses
    // the input and the model degrades to MODEL_ERROR instead of leaking.
    expect(estimateMacroScheduled(modelInput({ release: release() }))).toEqual({
      ok: false,
      reason: "MODEL_ERROR",
    });
  });
});

describe("estimateMacroScheduled (abstention paths)", () => {
  it("abstains without a matched calendar entry", () => {
    expect(estimateMacroScheduled(modelInput({ calendar: null }))).toEqual({
      ok: false,
      reason: "MODEL_ABSTAINED",
    });
  });

  it("abstains rather than invent a consensus", () => {
    expect(
      estimateMacroScheduled(
        modelInput({
          calendar: calendarEntry({
            payload: { series_id: "CUSR0000SA0", year: "2026", period: "M08" },
          }),
        }),
      ),
    ).toEqual({ ok: false, reason: "MODEL_ABSTAINED" });
  });

  it("abstains on a non-finite threshold or an unusable dispersion", () => {
    expect(
      estimateMacroScheduled(
        modelInput({ spec: spec({ threshold: Number.NaN }) }),
      ),
    ).toEqual({ ok: false, reason: "MODEL_ABSTAINED" });

    expect(
      estimateMacroScheduled(
        modelInput({
          spec: spec({ variable: "cpi_yoy" }),
          calendar: calendarEntry({ payload: { consensus: 3.1 } }),
          hyperparams: {
            defaultSigma: {},
            postReleaseWindowMs: DEFAULT_MACRO_HYPERPARAMS.postReleaseWindowMs,
            underReactionCoefficient: 0.64,
          },
        }),
      ),
    ).toEqual({ ok: false, reason: "MODEL_ABSTAINED" });
  });

  it("fails closed when the guard was built for another decision instant", () => {
    silenceStderr();
    expect(
      estimateMacroScheduled(
        modelInput({ guard: new AsOfGuard(new Date("2026-09-09T00:00:00Z")) }),
      ),
    ).toEqual({ ok: false, reason: "MODEL_ERROR" });
  });
});
