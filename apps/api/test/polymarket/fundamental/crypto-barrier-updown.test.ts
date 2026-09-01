// RFC-014 (barrier / first passage) and RFC-019 (updown strike from the
// recorded feed at the window open). Every parser fixture below is a REAL
// production question, collected from polymarket_markets on 2026-09-01.

import { describe, expect, it } from "vitest";

import {
  CATEGORY_MODELS,
  openPriceKey,
  planMarket,
  runCategoryModel,
  type CycleData,
} from "../../../src/polymarket/fundamental/catalog.js";
import { DEFAULT_FUNDAMENTAL_CONFIG } from "../../../src/polymarket/fundamental/config.js";
import {
  AsOfGuard,
  LeakageError,
  type FeedSample,
  type FeedSeries,
  type FeedSeriesPoint,
  type MarketContext,
} from "../../../src/polymarket/fundamental/features.js";
import {
  classifyCryptoQuestionForm,
  CRYPTO_EXTENDED_MODEL_VERSION,
  DEFAULT_CRYPTO_HYPERPARAMS,
  estimateCryptoUpdown,
  EXTENDED_CRYPTO_HYPERPARAMS,
  parseCryptoHyperparams,
  parseCryptoMarket,
  type CryptoMarketSpec,
  type CryptoModelInput,
} from "../../../src/polymarket/fundamental/models/crypto-updown.js";
import { createSeededRandom } from "../../../src/polymarket/fundamental/stats.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const DECISION_TS = new Date("2026-08-19T12:00:00.000Z");
const FIRST_SEEN = new Date("2026-08-10T00:00:00.000Z");
const SYMBOL = "btc/usd";
const FEED = "twap30";

function context(
  question: string,
  endDate: Date | null = new Date("2026-08-30T20:00:00.000Z"),
  overrides: Partial<MarketContext> = {},
): MarketContext {
  return {
    conditionId: "0xcondition",
    question,
    slug: null,
    gammaCategory: "crypto",
    tokenIds: ["1", "2"],
    endDate,
    rulesText: null,
    resolutionSource: null,
    ruleVersion: 1,
    ruleValidFrom: null,
    paramVersion: 1,
    tickSize: "0.01",
    umaDisputeActive: false,
    ruleChangedRecently: false,
    firstSeenAt: FIRST_SEEN,
    affirmativeTokenId: "1",
    ...overrides,
  };
}

function closes(
  count: number,
  last: number,
  volPerMinute: number,
  seed = 20_260_819,
): number[] {
  const random = createSeededRandom(seed);
  const path: number[] = [1];
  for (let index = 1; index < count; index += 1) {
    let normal = 0;
    for (let draw = 0; draw < 12; draw += 1) {
      normal += random();
    }
    normal -= 6;
    path.push((path[index - 1] ?? 1) * Math.exp(volPerMinute * normal));
  }
  const tail = path[path.length - 1] ?? 1;
  return path.map((value) => (value / tail) * last);
}

function series(
  values: readonly number[],
  decisionTs = DECISION_TS,
  spikes: ReadonlyMap<number, { high?: number; low?: number }> = new Map(),
): FeedSeries {
  const lastBucket = new Date(
    Math.floor(decisionTs.getTime() / MINUTE_MS) * MINUTE_MS - MINUTE_MS,
  );
  const firstBucket = new Date(
    lastBucket.getTime() - (values.length - 1) * MINUTE_MS,
  );
  const points: FeedSeriesPoint[] = values.map((close, index) => {
    const spike = spikes.get(index);
    return {
      bucketStart: new Date(firstBucket.getTime() + index * MINUTE_MS),
      close,
      high: spike?.high ?? close,
      low: spike?.low ?? close,
    };
  });
  return {
    symbol: SYMBOL,
    feed: FEED,
    closes: [...values],
    points,
    firstBucket,
    lastBucket,
  };
}

function sample(
  price: number,
  ageMs = 15_000,
  overrides: Partial<FeedSample> = {},
): FeedSample {
  return {
    feed: FEED,
    symbol: SYMBOL,
    price,
    sourceTs: new Date(DECISION_TS.getTime() - ageMs),
    ageMs,
    stale: false,
    ...overrides,
  };
}

function spec(overrides: Partial<CryptoMarketSpec> = {}): CryptoMarketSpec {
  return {
    symbol: SYMBOL,
    form: "terminal",
    strike: 110_000,
    direction: "above",
    deadline: new Date(DECISION_TS.getTime() + 2 * DAY_MS),
    windowStartTs: null,
    windowOpensTs: null,
    touchScanFrom: null,
    ...overrides,
  };
}

function input(overrides: Partial<CryptoModelInput> = {}): CryptoModelInput {
  const decisionTs = overrides.decisionTs ?? DECISION_TS;
  return {
    spec: spec(),
    decisionTs,
    feed: sample(100_000),
    series: series(closes(600, 100_000, 0.0006), decisionTs),
    config: DEFAULT_FUNDAMENTAL_CONFIG,
    hyperparams: EXTENDED_CRYPTO_HYPERPARAMS,
    guard: new AsOfGuard(decisionTs),
    ...overrides,
  };
}

function q(result: ReturnType<typeof estimateCryptoUpdown>): number {
  if (!result.ok) {
    throw new Error(`expected an estimate, got ${result.reason}`);
  }
  return result.value.q;
}

// ---------------------------------------------------------------------------
// Parser: real production questions classify into their forms
// ---------------------------------------------------------------------------

describe("parseCryptoMarket — barrier (RFC-014)", () => {
  it('parses the "on <date>" family: one day ending at the deadline', () => {
    const deadline = new Date("2026-09-01T04:00:00.000Z");
    const parsed = parseCryptoMarket(
      context("Will Bitcoin reach $81,000 on August 31?", deadline),
    );
    expect(parsed).toEqual({
      symbol: "btc/usd",
      form: "barrier",
      strike: 81_000,
      direction: "touch_up",
      deadline,
      windowStartTs: null,
      // One hour AFTER the true midnight-ET open: the deliberate DST pad —
      // the derived open is never earlier than the true one.
      windowOpensTs: new Date("2026-08-31T05:00:00.000Z"),
      touchScanFrom: new Date("2026-08-31T05:00:00.000Z"),
    });
  });

  it("parses the date-range family: N days ending at the deadline", () => {
    const deadline = new Date("2026-09-07T04:00:00.000Z");
    const parsed = parseCryptoMarket(
      context("Will Bitcoin dip to $68,000 August 31-September 6?", deadline),
    );
    expect(parsed).toMatchObject({
      form: "barrier",
      strike: 68_000,
      direction: "touch_down",
      windowOpensTs: new Date("2026-08-31T05:00:00.000Z"),
    });
  });

  it("parses a date range that crosses a year boundary", () => {
    const deadline = new Date("2027-01-05T05:00:00.000Z");
    const parsed = parseCryptoMarket(
      context("Will Bitcoin reach $84,000 December 29-January 4?", deadline),
    );
    expect(parsed).toMatchObject({
      form: "barrier",
      windowOpensTs: new Date("2026-12-29T06:00:00.000Z"),
    });
  });

  it('parses the "in <month>" family: the whole month', () => {
    const deadline = new Date("2026-09-01T04:00:00.000Z");
    const parsed = parseCryptoMarket(
      context("Will Solana reach $110 in August?", deadline),
    );
    expect(parsed).toMatchObject({
      symbol: "sol/usd",
      form: "barrier",
      strike: 110,
      direction: "touch_up",
      windowOpensTs: new Date("2026-08-01T05:00:00.000Z"),
    });
    // A redundant path marker does not turn a bounded barrier into a refusal.
    expect(
      parseCryptoMarket(
        context("Will BTC reach $150,000 anytime in August?", deadline),
      ),
    ).toMatchObject({ form: "barrier", strike: 150_000 });
  });

  it('refuses an "in <month>" whose month does not surround the deadline', () => {
    expect(
      parseCryptoMarket(
        context(
          "Will Solana reach $110 in July?",
          new Date("2026-09-01T04:00:00.000Z"),
        ),
      ),
    ).toBeNull();
  });

  it('parses the open "by <date>" family: scan bounded by first observation', () => {
    const deadline = new Date("2027-01-01T05:00:00.000Z");
    const parsed = parseCryptoMarket(
      context("Will Bitcoin dip to $45,000 by December 31, 2026?", deadline),
    );
    expect(parsed).toMatchObject({
      form: "barrier",
      strike: 45_000,
      direction: "touch_down",
      windowOpensTs: null,
      touchScanFrom: FIRST_SEEN,
    });
  });

  it("resolves neutral wording at estimate time, not parse time", () => {
    const parsed = parseCryptoMarket(
      context(
        "Will Bitcoin hit $80,000 on August 31?",
        new Date("2026-09-01T04:00:00.000Z"),
      ),
    );
    expect(parsed).toMatchObject({ form: "barrier", direction: "touch" });
  });
});

describe("parseCryptoMarket — updown (RFC-019)", () => {
  it("parses the hourly family: window = deadline minus one hour", () => {
    const deadline = new Date("2026-09-01T02:00:00.000Z");
    const parsed = parseCryptoMarket(
      context("Bitcoin Up or Down - August 31, 9PM ET", deadline),
    );
    expect(parsed).toEqual({
      symbol: "btc/usd",
      form: "updown",
      strike: null,
      direction: "up",
      deadline,
      windowStartTs: new Date("2026-09-01T01:00:00.000Z"),
      windowOpensTs: null,
      touchScanFrom: null,
    });
  });

  it("parses the daily family: window = deadline minus one day", () => {
    const deadline = new Date("2026-09-01T16:00:00.000Z");
    const parsed = parseCryptoMarket(
      context("Ethereum Up or Down on September 1?", deadline),
    );
    expect(parsed).toMatchObject({
      symbol: "eth/usd",
      form: "updown",
      windowStartTs: new Date("2026-08-31T16:00:00.000Z"),
    });
  });

  it("refuses the range family: an Asian payoff, not terminal", () => {
    expect(
      parseCryptoMarket(
        context(
          "Bitcoin Up or Down - August 31, 4:00PM-8:00PM ET",
          new Date("2026-09-01T00:00:00.000Z"),
        ),
      ),
    ).toBeNull();
  });

  it("refuses when the affirmative token is absent or not the first", () => {
    const deadline = new Date("2026-09-01T02:00:00.000Z");
    expect(
      parseCryptoMarket(
        context("Bitcoin Up or Down - August 31, 9PM ET", deadline, {
          affirmativeTokenId: null,
        }),
      ),
    ).toBeNull();
    expect(
      parseCryptoMarket(
        context("Bitcoin Up or Down - August 31, 9PM ET", deadline, {
          affirmativeTokenId: "2",
        }),
      ),
    ).toBeNull();
  });
});

describe("parseCryptoMarket — daily updown across a DST transition", () => {
  it("refuses the two days a year when deadline − 24h is not the previous noon ET", () => {
    // 2026-11-01 is the first Sunday of November: the fall-back transition
    // happens at 06:00Z inside the noon-to-noon window ending that day.
    expect(
      parseCryptoMarket(
        context(
          "Bitcoin Up or Down on November 1?",
          new Date("2026-11-01T17:00:00.000Z"),
        ),
      ),
    ).toBeNull();
    // The very next day the window is 24 h again and the family parses.
    expect(
      parseCryptoMarket(
        context(
          "Bitcoin Up or Down on November 2?",
          new Date("2026-11-02T17:00:00.000Z"),
        ),
      ),
    ).toMatchObject({ form: "updown" });
    // The hourly family is immune: UTC-aligned candles, whole-hour offsets.
    expect(
      parseCryptoMarket(
        context(
          "Bitcoin Up or Down - November 1, 1AM ET",
          new Date("2026-11-01T06:00:00.000Z"),
        ),
      ),
    ).toMatchObject({
      form: "updown",
      windowStartTs: new Date("2026-11-01T05:00:00.000Z"),
    });
  });
});

describe("parseCryptoMarket — findings from the adversarial review", () => {
  const deadline = new Date("2026-09-01T04:00:00.000Z");

  it("reads spelled-out magnitudes instead of truncating them to the digits", () => {
    // The boundary requirement that stopped "by" being read as billions also
    // stops the "m" of "million" — and a $1 strike on a barrier is an instant
    // "touch" and a served q of ~1 on a market trading at cents.
    expect(
      parseCryptoMarket(
        context(
          "Will Bitcoin reach $1 million by December 31, 2030?",
          new Date("2031-01-01T05:00:00.000Z"),
        ),
      ),
    ).toMatchObject({ form: "barrier", strike: 1_000_000 });
    expect(
      parseCryptoMarket(
        context("Will Bitcoin be above $1.5 million on August 31?", deadline),
      ),
    ).toMatchObject({ form: "terminal", strike: 1_500_000 });
    // And the original defect stays fixed: "by" is not billions.
    expect(
      parseCryptoMarket(
        context(
          "Will Bitcoin dip to $45,000 by December 31, 2026?",
          new Date("2027-01-01T05:00:00.000Z"),
        ),
      ),
    ).toMatchObject({ form: "barrier", strike: 45_000 });
  });

  it("counts the range's days in the END day's year, not the deadline's", () => {
    // A Dec-31 deadline is January in UTC. Counting February-December in the
    // NEXT year lands on a leap year one day too long, putting the derived
    // open ~23 h BEFORE the true one — the anticonservative direction the
    // whole pad exists to prevent.
    const parsed = parseCryptoMarket(
      context(
        "Will Bitcoin reach $84,000 February 1-December 31?",
        new Date("2028-01-01T04:59:00.000Z"),
      ),
    );
    // 2027 has 334 days from Feb 1 to Dec 31 inclusive; the leap-year count
    // would be 335 and would open the window a day early.
    expect(parsed).toMatchObject({
      form: "barrier",
      windowOpensTs: new Date("2027-02-01T05:59:00.000Z"),
    });
  });

  it("refuses when the title's end date and the deadline disagree", () => {
    // A date-only fallback parsed as UTC midnight, a rule change, a mismatched
    // series: whatever the cause, window arithmetic on a deadline that does
    // not match the title would turn the touch scan into a touch inventor.
    expect(
      parseCryptoMarket(
        context(
          "Will Bitcoin reach $81,000 on August 31?",
          new Date("2026-09-15T04:00:00.000Z"),
        ),
      ),
    ).toBeNull();
    expect(
      parseCryptoMarket(
        context(
          "Will Bitcoin dip to $68,000 August 31-September 6?",
          new Date("2026-09-20T04:00:00.000Z"),
        ),
      ),
    ).toBeNull();
  });

  it("does not let an incidental 'by' widen a bounded window", () => {
    // The open-window family is checked LAST: an open window scans from first
    // observation, which for a bounded market can precede the true open.
    const parsed = parseCryptoMarket(
      context(
        "Will Bitcoin reach $81,000 on August 31, as measured by Binance?",
        deadline,
      ),
    );
    expect(parsed).toMatchObject({
      form: "barrier",
      windowOpensTs: new Date("2026-08-31T05:00:00.000Z"),
    });
  });

  it("refuses an updown title that matches two window families", () => {
    expect(
      parseCryptoMarket(
        context(
          "Bitcoin Up or Down on September 1, 9PM ET",
          new Date("2026-09-01T02:00:00.000Z"),
        ),
      ),
    ).toBeNull();
  });

  it("refuses the new forms until the versioned rule chain has the deadline", () => {
    // The window arithmetic, the scan floor and the strike instant all hang
    // off the deadline; only the versioned rule says what was in force. The
    // TERMINAL form is deliberately NOT gated on this — 1.0.0's served
    // population must not change.
    const noRule = { ruleVersion: null };
    expect(
      parseCryptoMarket(
        context("Will Bitcoin reach $81,000 on August 31?", deadline, noRule),
      ),
    ).toBeNull();
    expect(
      parseCryptoMarket(
        context(
          "Bitcoin Up or Down - August 31, 9PM ET",
          new Date("2026-09-01T02:00:00.000Z"),
          noRule,
        ),
      ),
    ).toBeNull();
    expect(
      parseCryptoMarket(
        context(
          "Will the price of Bitcoin be above $68,000 on September 2?",
          deadline,
          noRule,
        ),
      ),
    ).toMatchObject({ form: "terminal" });
  });
});

describe("classifyCryptoQuestionForm", () => {
  it("agrees with the parser on the production distribution", () => {
    expect(
      classifyCryptoQuestionForm(
        "Will the price of Bitcoin be above $68,000 on September 2?",
      ),
    ).toBe("terminal");
    expect(
      classifyCryptoQuestionForm(
        "Will Bitcoin dip to $68,000 August 31-September 6?",
      ),
    ).toBe("barrier");
    expect(
      classifyCryptoQuestionForm("Bitcoin Up or Down - August 31, 9PM ET"),
    ).toBe("updown");
    // The range title is still the updown FAMILY for coverage purposes; the
    // parser refuses it, so it shows up as updown-and-uncovered, which is the
    // honest reading.
    expect(
      classifyCryptoQuestionForm(
        "Bitcoin Up or Down - August 31, 4:00PM-8:00PM ET",
      ),
    ).toBe("updown");
    expect(
      classifyCryptoQuestionForm("Will BTC be between $100k and $120k?"),
    ).toBe("refused");
    expect(
      classifyCryptoQuestionForm(
        "Will Bitcoin hit a new all-time high in August?",
      ),
    ).toBe("refused");
  });
});

// ---------------------------------------------------------------------------
// Barrier map
// ---------------------------------------------------------------------------

describe("estimateCryptoUpdown — barrier map", () => {
  const openWindow = { windowOpensTs: null, touchScanFrom: null } as const;

  it("prices the touch at exactly twice the terminal tail while that is < 1", () => {
    const terminal = estimateCryptoUpdown(
      input({ spec: spec({ strike: 103_000 }) }),
    );
    const barrier = estimateCryptoUpdown(
      input({
        spec: spec({
          form: "barrier",
          strike: 103_000,
          direction: "touch_up",
          ...openWindow,
        }),
      }),
    );
    expect(q(barrier)).toBeCloseTo(Math.min(1, 2 * q(terminal)), 10);
    expect(q(barrier)).toBeLessThan(1);
  });

  it("mirrors: a barrier the same log-distance above or below prices the same", () => {
    const up = estimateCryptoUpdown(
      input({
        spec: spec({
          form: "barrier",
          strike: 100_000 * Math.exp(0.03),
          direction: "touch_up",
          ...openWindow,
        }),
      }),
    );
    const down = estimateCryptoUpdown(
      input({
        spec: spec({
          form: "barrier",
          strike: 100_000 * Math.exp(-0.03),
          direction: "touch_down",
          ...openWindow,
        }),
      }),
    );
    expect(q(up)).toBeCloseTo(q(down), 12);
  });

  it("P(touch) >= P(terminal) for the same strike, always", () => {
    for (const strike of [101_000, 103_000, 108_000, 115_000]) {
      const terminal = estimateCryptoUpdown(input({ spec: spec({ strike }) }));
      const barrier = estimateCryptoUpdown(
        input({
          spec: spec({
            form: "barrier",
            strike,
            direction: "touch_up",
            ...openWindow,
          }),
        }),
      );
      expect(q(barrier)).toBeGreaterThanOrEqual(q(terminal));
    }
  });

  it("a level already beyond the barrier is a touch in progress: q saturates", () => {
    const result = estimateCryptoUpdown(
      input({
        spec: spec({
          form: "barrier",
          strike: 99_000,
          direction: "touch_up",
          ...openWindow,
        }),
      }),
    );
    expect(q(result)).toBe(0.999999);
    expect(result.ok && result.value.dataRefs.touchDetected).toBe(true);
  });

  it("an observed touch is never dragged below certainty by the calibration", () => {
    // A correction that would collapse everything toward 0 if applied.
    const dragged = {
      ...EXTENDED_CRYPTO_HYPERPARAMS,
      calibration: { intercept: -5, coefficients: [0.1, 0, 0, 0] },
    };
    const touched = estimateCryptoUpdown(
      input({
        hyperparams: dragged,
        spec: spec({
          form: "barrier",
          strike: 99_000,
          direction: "touch_up",
          windowOpensTs: null,
          touchScanFrom: null,
        }),
      }),
    );
    // The touch is a fact: the logistic correction is bypassed.
    expect(q(touched)).toBe(0.999999);
    // On an UNtouched barrier the same correction does apply.
    const untouched = estimateCryptoUpdown(
      input({
        hyperparams: dragged,
        spec: spec({
          form: "barrier",
          strike: 103_000,
          direction: "touch_up",
          windowOpensTs: null,
          touchScanFrom: null,
        }),
      }),
    );
    const uncorrected = estimateCryptoUpdown(
      input({
        spec: spec({
          form: "barrier",
          strike: 103_000,
          direction: "touch_up",
          windowOpensTs: null,
          touchScanFrom: null,
        }),
      }),
    );
    expect(q(untouched)).toBeLessThan(q(uncorrected));
  });

  it("neutral wording keeps its neutral side and never inverts after a crossing", () => {
    const neutral = (strike: number): ReturnType<typeof estimateCryptoUpdown> =>
      estimateCryptoUpdown(
        input({
          spec: spec({
            form: "barrier",
            strike,
            direction: "touch",
            ...openWindow,
          }),
        }),
      );
    // Barrier above the level (not yet crossed) and barrier below it (the
    // level has moved past): the same neutral question, the same recorded
    // direction. A side re-derived from the current level would flip here,
    // and a flipped "hit $X" market answers "not touched" about the crossing
    // that settled it.
    for (const strike of [103_000, 97_000]) {
      const result = neutral(strike);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.dataRefs.direction).toBe("touch");
      }
    }
    // Same log-distance either side of the level prices identically: the map
    // needs only |ln(B/S)|, so dropping the re-derivation costs nothing.
    const up = neutral(100_000 * Math.exp(0.03));
    const down = neutral(100_000 * Math.exp(-0.03));
    expect(q(up)).toBeCloseTo(q(down), 12);
  });

  it("neutral wording detects a crossing by containment, in both directions", () => {
    const values = closes(600, 100_000, 0.0006);
    const withSpike = (
      index: number,
      spike: { high?: number; low?: number },
    ): FeedSeries => series(values, DECISION_TS, new Map([[index, spike]]));
    // A bucket whose range straddles the barrier is a crossing, whichever way
    // the price was travelling.
    for (const [spike, strike] of [
      [{ high: 112_000 }, 110_000],
      [{ low: 88_000 }, 90_000],
    ] as const) {
      const result = estimateCryptoUpdown(
        input({
          series: withSpike(400, spike),
          spec: spec({
            form: "barrier",
            strike,
            direction: "touch",
            windowOpensTs: null,
            touchScanFrom: FIRST_SEEN,
          }),
        }),
      );
      expect(q(result)).toBe(0.999999);
      expect(result.ok && result.value.dataRefs.touchDetected).toBe(true);
    }
  });
});

describe("estimateCryptoUpdown — touch scan (as-of, bounded)", () => {
  it("detects a touch inside the scan window from the bucket extremes", () => {
    const values = closes(600, 100_000, 0.0006);
    const spiked = series(
      values,
      DECISION_TS,
      new Map([[400, { high: 112_000 }]]),
    );
    const scanFrom = spiked.points[300]?.bucketStart ?? FIRST_SEEN;
    const result = estimateCryptoUpdown(
      input({
        series: spiked,
        spec: spec({
          form: "barrier",
          strike: 110_000,
          direction: "touch_up",
          windowOpensTs: null,
          touchScanFrom: scanFrom,
        }),
      }),
    );
    expect(q(result)).toBe(0.999999);
    expect(result.ok && result.value.dataRefs.touchDetected).toBe(true);
  });

  it("ignores a touch BEFORE the scan floor: outside the payoff window", () => {
    const values = closes(600, 100_000, 0.0006);
    const spiked = series(
      values,
      DECISION_TS,
      new Map([[100, { high: 112_000 }]]),
    );
    const scanFrom = spiked.points[300]?.bucketStart ?? FIRST_SEEN;
    const result = estimateCryptoUpdown(
      input({
        series: spiked,
        spec: spec({
          form: "barrier",
          strike: 110_000,
          direction: "touch_up",
          windowOpensTs: null,
          touchScanFrom: scanFrom,
        }),
      }),
    );
    expect(q(result)).toBeLessThan(0.9);
    expect(result.ok && result.value.dataRefs.touchDetected).toBe(false);
  });

  it("a series reaching past the decision instant trips the as-of guard before any scan", () => {
    const base = series(closes(600, 100_000, 0.0006));
    const future: FeedSeries = {
      ...base,
      points: [
        ...base.points,
        {
          bucketStart: new Date(DECISION_TS.getTime() + MINUTE_MS),
          close: 100_000,
          high: 150_000,
          low: 100_000,
        },
      ],
      lastBucket: new Date(DECISION_TS.getTime() + MINUTE_MS),
    };
    expect(() =>
      estimateCryptoUpdown(
        input({
          series: future,
          spec: spec({
            form: "barrier",
            strike: 110_000,
            direction: "touch_up",
            windowOpensTs: null,
            touchScanFrom: FIRST_SEEN,
          }),
        }),
      ),
    ).toThrow(LeakageError);
  });

  it("abstains while the payoff window has not opened", () => {
    const result = estimateCryptoUpdown(
      input({
        spec: spec({
          form: "barrier",
          strike: 110_000,
          direction: "touch_up",
          windowOpensTs: new Date(DECISION_TS.getTime() + HOUR_MS),
          touchScanFrom: new Date(DECISION_TS.getTime() + HOUR_MS),
        }),
      }),
    );
    expect(result).toEqual({ ok: false, reason: "MODEL_ABSTAINED" });
  });
});

// ---------------------------------------------------------------------------
// Updown strike (RFC-019)
// ---------------------------------------------------------------------------

describe("estimateCryptoUpdown — updown strike from the recorded open", () => {
  const windowStart = new Date(DECISION_TS.getTime() - 30 * MINUTE_MS);
  const updownSpec = spec({
    form: "updown",
    strike: null,
    direction: "up",
    deadline: new Date(DECISION_TS.getTime() + 30 * MINUTE_MS),
    windowStartTs: windowStart,
  });
  const openSample: FeedSample = {
    feed: FEED,
    symbol: SYMBOL,
    price: 99_500,
    sourceTs: new Date(windowStart.getTime() - MINUTE_MS),
    ageMs: MINUTE_MS,
    stale: false,
  };

  it("prices Up as the terminal map above the window-open price", () => {
    const result = estimateCryptoUpdown(
      input({ spec: updownSpec, openFeed: openSample }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The level (100 000) sits above the open (99 500): Up is favoured.
    expect(result.value.q).toBeGreaterThan(0.5);
    expect(result.value.dataRefs).toMatchObject({
      form: "updown",
      strike: 99_500,
      direction: "up",
      windowStart: windowStart.toISOString(),
      strikeSourceTs: openSample.sourceTs?.toISOString(),
      strikeAgeMs: MINUTE_MS,
    });
  });

  it("abstains on every unusable strike, never substituting another instant", () => {
    const abstained = { ok: false, reason: "MODEL_ABSTAINED" };
    // No open sample at all.
    expect(
      estimateCryptoUpdown(input({ spec: updownSpec, openFeed: null })),
    ).toEqual(abstained);
    // A sample AFTER the open would be look-ahead relative to the strike.
    expect(
      estimateCryptoUpdown(
        input({
          spec: updownSpec,
          openFeed: {
            ...openSample,
            sourceTs: new Date(windowStart.getTime() + 1_000),
          },
        }),
      ),
    ).toEqual(abstained);
    // A sample too old means the RTDS had a gap at the open.
    expect(
      estimateCryptoUpdown(
        input({
          spec: updownSpec,
          openFeed: {
            ...openSample,
            sourceTs: new Date(
              windowStart.getTime() -
                DEFAULT_FUNDAMENTAL_CONFIG.crypto.maxStrikeAgeMs -
                1_000,
            ),
          },
        }),
      ),
    ).toEqual(abstained);
    // The strike must come from the SAME feed as the level and the series.
    expect(
      estimateCryptoUpdown(
        input({
          spec: updownSpec,
          openFeed: { ...openSample, feed: "twap60" },
        }),
      ),
    ).toEqual(abstained);
    // A window that has not opened yet has no strike.
    expect(
      estimateCryptoUpdown(
        input({
          spec: spec({
            form: "updown",
            strike: null,
            direction: "up",
            windowStartTs: new Date(DECISION_TS.getTime() + HOUR_MS),
          }),
          openFeed: openSample,
        }),
      ),
    ).toEqual(abstained);
    // No derivable window at all.
    expect(
      estimateCryptoUpdown(
        input({
          spec: spec({
            form: "updown",
            strike: null,
            direction: "up",
            windowStartTs: null,
          }),
          openFeed: openSample,
        }),
      ),
    ).toEqual(abstained);
  });
});

// ---------------------------------------------------------------------------
// Version separation: 1.0.0 is untouched
// ---------------------------------------------------------------------------

describe("version separation (RFC-014 E5)", () => {
  it("the 1.0.0 hyperparameters abstain on the new forms", () => {
    for (const form of ["barrier", "updown"] as const) {
      const result = estimateCryptoUpdown(
        input({
          hyperparams: DEFAULT_CRYPTO_HYPERPARAMS,
          spec:
            form === "barrier"
              ? spec({
                  form,
                  strike: 103_000,
                  direction: "touch_up",
                  windowOpensTs: null,
                  touchScanFrom: null,
                })
              : spec({
                  form,
                  strike: null,
                  direction: "up",
                  windowStartTs: new Date(
                    DECISION_TS.getTime() - 30 * MINUTE_MS,
                  ),
                }),
        }),
      );
      expect(result).toEqual({ ok: false, reason: "MODEL_ABSTAINED" });
    }
  });

  it("golden regression: 1.0.0 terminal outputs are unchanged to the last bit", () => {
    // Captured from the pre-RFC-014 code on this exact fixture (2026-09-01),
    // BEFORE any of the barrier/updown changes were written. If either number
    // moves, the incumbent's evidence stream is being disturbed — stop.
    const above = estimateCryptoUpdown(
      input({
        hyperparams: DEFAULT_CRYPTO_HYPERPARAMS,
        feed: sample(100_000, 5_000),
        spec: spec({
          strike: 120_000,
          deadline: new Date("2026-08-21T12:00:00.000Z"),
        }),
      }),
    );
    const below = estimateCryptoUpdown(
      input({
        hyperparams: DEFAULT_CRYPTO_HYPERPARAMS,
        feed: sample(100_000, 5_000),
        spec: spec({
          strike: 95_000,
          direction: "below",
          deadline: new Date("2026-08-21T12:00:00.000Z"),
        }),
      }),
    );
    expect(above.ok && below.ok).toBe(true);
    if (!above.ok || !below.ok) {
      return;
    }
    expect(above.value.q).toBe(0.000001);
    expect(above.value.sigma).toBe(0.005);
    expect(below.value.q).toBe(0.0697352762303845);
    expect(below.value.sigma).toBe(0.010183624047246917);
    expect(above.value.dataRefs.form).toBe("terminal");
  });

  it("determinism: the same input produces byte-identical results", () => {
    const make = (): unknown =>
      estimateCryptoUpdown(
        input({
          spec: spec({
            form: "barrier",
            strike: 103_000,
            direction: "touch_up",
            windowOpensTs: null,
            touchScanFrom: null,
          }),
        }),
      );
    expect(JSON.stringify(make())).toBe(JSON.stringify(make()));
  });
});

// ---------------------------------------------------------------------------
// Catalog and dispatch
// ---------------------------------------------------------------------------

describe("catalog (RFC-014 E5)", () => {
  it("carries both crypto versions of the ONE family, macro untouched", () => {
    const crypto = CATEGORY_MODELS.filter(
      (entry) => entry.category === "crypto_updown",
    );
    expect(crypto.map((entry) => entry.version)).toEqual([
      "1.0.0",
      CRYPTO_EXTENDED_MODEL_VERSION,
    ]);
    expect(new Set(crypto.map((entry) => entry.family)).size).toBe(1);
    expect(
      CATEGORY_MODELS.filter((entry) => entry.category === "macro_scheduled"),
    ).toHaveLength(1);
    // The registered hyperparameters are what separates the two: 1.0.0 stays
    // terminal-only, 1.1.0 declares every form.
    expect(
      parseCryptoHyperparams(
        crypto[0]?.defaultHyperparams,
        DEFAULT_FUNDAMENTAL_CONFIG,
      ).forms,
    ).toEqual(["terminal"]);
    expect(
      parseCryptoHyperparams(
        crypto[1]?.defaultHyperparams,
        DEFAULT_FUNDAMENTAL_CONFIG,
      ).forms,
    ).toEqual(["terminal", "barrier", "updown"]);
  });

  it("runCategoryModel hands the updown model its window-open sample", () => {
    const deadline = new Date(DECISION_TS.getTime() + 30 * MINUTE_MS);
    const windowStart = new Date(deadline.getTime() - HOUR_MS);
    const plan = planMarket(
      "crypto_updown",
      context("Bitcoin Up or Down - August 19, 8AM ET", deadline),
      [],
    );
    expect(plan !== null && !("excluded" in plan)).toBe(true);
    const openSample: FeedSample = {
      feed: FEED,
      symbol: SYMBOL,
      price: 99_500,
      sourceTs: new Date(windowStart.getTime() - MINUTE_MS),
      ageMs: MINUTE_MS,
      stale: false,
    };
    const cycle: CycleData = {
      feeds: new Map([[SYMBOL, sample(100_000)]]),
      series: new Map([[SYMBOL, series(closes(600, 100_000, 0.0006))]]),
      calendar: [],
      releases: new Map(),
      openPrices: new Map([[openPriceKey(SYMBOL, windowStart), openSample]]),
    };
    const served = runCategoryModel({
      plan: plan as never,
      decisionTs: DECISION_TS,
      cycle,
      config: DEFAULT_FUNDAMENTAL_CONFIG,
      hyperparams: EXTENDED_CRYPTO_HYPERPARAMS as unknown as Record<
        string,
        unknown
      >,
      thinBook: false,
      guard: new AsOfGuard(DECISION_TS),
    });
    expect(served.ok).toBe(true);

    // Without the open sample the same market abstains — no default strike.
    const starved = runCategoryModel({
      plan: plan as never,
      decisionTs: DECISION_TS,
      cycle: { ...cycle, openPrices: new Map() },
      config: DEFAULT_FUNDAMENTAL_CONFIG,
      hyperparams: EXTENDED_CRYPTO_HYPERPARAMS as unknown as Record<
        string,
        unknown
      >,
      thinBook: false,
      guard: new AsOfGuard(DECISION_TS),
    });
    expect(starved).toEqual({ ok: false, reason: "MODEL_ABSTAINED" });
  });
});

// ---------------------------------------------------------------------------
// Daily report: coverage by form (RFC-019)
// ---------------------------------------------------------------------------

describe("loadFormCoverage", () => {
  it("tallies the window's markets by form against the model's MODEL rows", async () => {
    const { loadFormCoverage } =
      await import("../../../src/polymarket/fundamental/calibration.js");
    const markets = [
      {
        id: "m1",
        question: "Will the price of Bitcoin be above $68,000 on September 2?",
        covered: true,
      },
      {
        id: "m2",
        question: "Will Bitcoin reach $81,000 on August 31?",
        covered: true,
      },
      {
        id: "m3",
        question: "Will Bitcoin dip to $68,000 August 31-September 6?",
        covered: false,
      },
      {
        id: "m4",
        question: "Bitcoin Up or Down - August 31, 9PM ET",
        covered: true,
      },
      {
        id: "m5",
        question: "Will BTC be between $100k and $120k?",
        covered: false,
      },
    ];
    const pool = {
      query: (sql: string): Promise<{ rows: Record<string, unknown>[] }> => {
        if (sql.includes("bool_or")) {
          return Promise.resolve({
            rows: markets.map((market) => ({
              market_id: market.id,
              covered: market.covered,
            })),
          });
        }
        return Promise.resolve({
          rows: markets.map((market) => ({
            condition_id: market.id,
            question: market.question,
          })),
        });
      },
    };
    const coverage = await loadFormCoverage(
      pool as never,
      "crypto_updown",
      "crypto_updown_gbm@1.1.0",
      new Date("2026-08-31T00:00:00.000Z"),
      new Date("2026-09-01T00:00:00.000Z"),
    );
    expect(coverage).toEqual({
      barrier: { markets: 2, covered: 1 },
      refused: { markets: 1, covered: 0 },
      terminal: { markets: 1, covered: 1 },
      updown: { markets: 1, covered: 1 },
    });
  });
});

// ---------------------------------------------------------------------------
// Coverage: the production question distribution
// ---------------------------------------------------------------------------

describe("coverage over the production distribution", () => {
  // Verbatim from polymarket_markets, 2026-09-01. One entry per family shape.
  const QUESTIONS: ReadonlyArray<{ question: string; end: Date }> = [
    {
      question: "Will the price of Bitcoin be above $68,000 on September 2?",
      end: new Date("2026-09-02T16:00:00.000Z"),
    },
    {
      question: "Will the price of Bitcoin be above $88,000 on September 2?",
      end: new Date("2026-09-02T16:00:00.000Z"),
    },
    {
      question: "Will Bitcoin reach $81,000 on August 31?",
      end: new Date("2026-09-01T04:00:00.000Z"),
    },
    {
      question: "Will Bitcoin reach $84,000 August 31-September 6?",
      end: new Date("2026-09-07T04:00:00.000Z"),
    },
    {
      question: "Will Bitcoin dip to $74,000 on August 31?",
      end: new Date("2026-09-01T04:00:00.000Z"),
    },
    {
      question: "Will Bitcoin dip to $68,000 August 31-September 6?",
      end: new Date("2026-09-07T04:00:00.000Z"),
    },
    {
      question: "Will Solana reach $110 in August?",
      end: new Date("2026-09-01T04:00:00.000Z"),
    },
    {
      question: "Will Bitcoin dip to $45,000 by December 31, 2026?",
      end: new Date("2027-01-01T05:00:00.000Z"),
    },
    {
      question: "Bitcoin Up or Down - August 31, 9PM ET",
      end: new Date("2026-09-01T02:00:00.000Z"),
    },
    {
      question: "Bitcoin Up or Down - August 31, 3PM ET",
      end: new Date("2026-08-31T20:00:00.000Z"),
    },
    {
      question: "Ethereum Up or Down on September 1?",
      end: new Date("2026-09-01T16:00:00.000Z"),
    },
    {
      question: "Bitcoin Up or Down - August 31, 4:00PM-8:00PM ET",
      end: new Date("2026-09-01T00:00:00.000Z"),
    },
    {
      question: "Will BTC be between $100k and $120k?",
      end: new Date("2026-09-02T16:00:00.000Z"),
    },
  ];

  it("the served fraction rises, and no terminal market changes form", () => {
    const parsed = QUESTIONS.map(({ question, end }) =>
      parseCryptoMarket(context(question, end)),
    );
    const terminalOnly = parsed.filter(
      (item) => item !== null && item.form === "terminal",
    );
    const nowParseable = parsed.filter((item) => item !== null);
    // 2 terminal; 6 barrier + 3 updown on top (the range updown and the
    // "between" stay refused).
    expect(terminalOnly).toHaveLength(2);
    expect(nowParseable).toHaveLength(11);
    // Every terminal question is still terminal — no market changed form.
    for (const [index, item] of parsed.entries()) {
      const entry = QUESTIONS[index];
      if (item !== null && entry !== undefined) {
        expect(item.form).toBe(classifyCryptoQuestionForm(entry.question));
      }
    }
  });
});
