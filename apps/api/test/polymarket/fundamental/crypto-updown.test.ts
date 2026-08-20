import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_FUNDAMENTAL_CONFIG,
  type FundamentalConfig,
} from "../../../src/polymarket/fundamental/config.js";
import {
  AsOfGuard,
  type FeedSample,
  type FeedSeries,
  type MarketContext,
} from "../../../src/polymarket/fundamental/features.js";
import {
  CRYPTO_FEATURE_SET_VERSION,
  CRYPTO_MODEL_FAMILY,
  CRYPTO_MODEL_VERSION,
  DEFAULT_CRYPTO_HYPERPARAMS,
  cryptoFeatureRow,
  estimateCryptoUpdown,
  parseCryptoHyperparams,
  parseCryptoMarket,
  trainCryptoCalibration,
  type CryptoHyperparams,
  type CryptoMarketSpec,
  type CryptoModelInput,
} from "../../../src/polymarket/fundamental/models/crypto-updown.js";
import { createSeededRandom } from "../../../src/polymarket/fundamental/stats.js";
import type { ModelResult } from "../../../src/polymarket/fundamental/types.js";

const MINUTE_MS = 60_000;
const DECISION_TS = new Date("2026-08-19T12:00:00.000Z");
const SYMBOL = "btc/usd";
const FEED = "twap30";

function context(
  question: string,
  endDate: Date | null = new Date("2026-08-30T20:00:00.000Z"),
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
  };
}

/**
 * Deterministic 1-minute closes: a seeded multiplicative random walk with a
 * fixed per-minute volatility, rescaled so the LAST close is exactly `last`.
 * Deterministic on purpose — the same fixture must produce the same q forever.
 */
function closes(
  count: number,
  last: number,
  volPerMinute: number,
  seed = 20_260_819,
): number[] {
  const random = createSeededRandom(seed);
  const path: number[] = [1];
  for (let index = 1; index < count; index += 1) {
    // Box-Muller-free: sum of 12 uniforms is a standard normal to well within
    // what a volatility fixture needs.
    let normal = 0;
    for (let draw = 0; draw < 12; draw += 1) {
      normal += random();
    }
    normal -= 6;
    const previous = path[index - 1] ?? 1;
    path.push(previous * Math.exp(volPerMinute * normal));
  }
  const tail = path[path.length - 1] ?? 1;
  return path.map((value) => (value / tail) * last);
}

function series(
  values: readonly number[],
  decisionTs = DECISION_TS,
): FeedSeries {
  // Mirrors loadFeedSeries: the newest bucket is the last one that had already
  // closed at the decision instant.
  const lastBucket = new Date(
    Math.floor(decisionTs.getTime() / MINUTE_MS) * MINUTE_MS - MINUTE_MS,
  );
  return {
    symbol: SYMBOL,
    feed: FEED,
    closes: [...values],
    firstBucket: new Date(
      lastBucket.getTime() - (values.length - 1) * MINUTE_MS,
    ),
    lastBucket,
  };
}

function sample(price: number, ageMs = 15_000, stale = false): FeedSample {
  return {
    feed: FEED,
    symbol: SYMBOL,
    price,
    sourceTs: new Date(DECISION_TS.getTime() - ageMs),
    ageMs,
    stale,
  };
}

function spec(overrides: Partial<CryptoMarketSpec> = {}): CryptoMarketSpec {
  return {
    symbol: SYMBOL,
    strike: 110_000,
    direction: "above",
    deadline: new Date(DECISION_TS.getTime() + 24 * 3_600_000),
    ...overrides,
  };
}

function input(overrides: Partial<CryptoModelInput> = {}): CryptoModelInput {
  const decisionTs = overrides.decisionTs ?? DECISION_TS;
  return {
    spec: spec(),
    decisionTs,
    feed: sample(110_000),
    series: series(closes(200, 110_000, 0.0006), decisionTs),
    config: DEFAULT_FUNDAMENTAL_CONFIG,
    hyperparams: DEFAULT_CRYPTO_HYPERPARAMS,
    guard: new AsOfGuard(decisionTs),
    ...overrides,
  };
}

function value(result: ModelResult): { q: number; sigma: number } {
  if (!result.ok) {
    throw new Error(`expected an estimate, got ${result.reason}`);
  }
  return { q: result.value.q, sigma: result.value.sigma };
}

describe("parseCryptoMarket", () => {
  it("parses real Polymarket phrasings into an unambiguous spec", () => {
    expect(
      parseCryptoMarket(context("Will BTC be above $110,000 on August 30?")),
    ).toEqual({
      symbol: "btc/usd",
      strike: 110_000,
      direction: "above",
      deadline: new Date("2026-08-30T20:00:00.000Z"),
    });

    expect(
      parseCryptoMarket(context("Ethereum above $4,500 at 12pm ET?")),
    ).toMatchObject({
      symbol: "eth/usd",
      strike: 4_500,
      direction: "above",
    });

    expect(
      parseCryptoMarket(context("Will Bitcoin dip below $95k in August?")),
    ).toMatchObject({ symbol: "btc/usd", strike: 95_000, direction: "below" });

    expect(
      parseCryptoMarket(context("Will Solana close above $180 on Friday?")),
    ).toMatchObject({ symbol: "sol/usd", strike: 180, direction: "above" });

    expect(
      parseCryptoMarket(context("Will XRP be under $2.50 on August 31?")),
    ).toMatchObject({ symbol: "xrp/usd", strike: 2.5, direction: "below" });

    expect(
      parseCryptoMarket(context("Will ETH be over $4.5k on August 30?")),
    ).toMatchObject({ symbol: "eth/usd", strike: 4_500, direction: "above" });
  });

  it("refuses everything ambiguous instead of guessing", () => {
    // No recognized asset.
    expect(
      parseCryptoMarket(context("Will gold be above $3,000 on August 30?")),
    ).toBeNull();
    // Two assets in one question.
    expect(
      parseCryptoMarket(context("Will BTC be above $110k before ETH?")),
    ).toBeNull();
    // No parsable strike ("30" is a date, not a price).
    expect(
      parseCryptoMarket(
        context("Will BTC be above its June high on August 30?"),
      ),
    ).toBeNull();
    // Two distinct strikes.
    expect(
      parseCryptoMarket(
        context("Will BTC be above $110,000 or above $120,000 in August?"),
      ),
    ).toBeNull();
    // No direction word.
    expect(
      parseCryptoMarket(context("What will BTC be worth at $110,000 volume?")),
    ).toBeNull();
    // Both directions.
    expect(
      parseCryptoMarket(context("Will BTC be above or below $110,000?")),
    ).toBeNull();
    // Barrier payoff: pays on the path, not on the level at T.
    expect(
      parseCryptoMarket(context("Will Bitcoin hit $150k in 2026?")),
    ).toBeNull();
    expect(
      parseCryptoMarket(context("Will BTC reach $150,000 anytime in August?")),
    ).toBeNull();
    // Range payoff.
    expect(
      parseCryptoMarket(context("Will BTC be between $100k and $120k?")),
    ).toBeNull();
    // No endDate.
    expect(
      parseCryptoMarket(context("Will BTC be above $110,000?", null)),
    ).toBeNull();
  });

  it("does not read a direction out of a horizon word", () => {
    // "over the next month" is a horizon; without a real direction word the
    // market must stay on the baseline.
    expect(
      parseCryptoMarket(
        context("Will BTC trade at $110,000 over the next month?"),
      ),
    ).toBeNull();
  });

  it("accepts the same strike written twice but not two different ones", () => {
    expect(
      parseCryptoMarket(
        context("Will BTC be above $110,000 (110k) on August 30?"),
      ),
    ).toMatchObject({ strike: 110_000 });
  });
});

describe("crypto base map", () => {
  it("maps deep in the money to ~1, deep out to ~0 and at the money to 0.5", () => {
    const deepIn = value(
      estimateCryptoUpdown(input({ spec: spec({ strike: 40_000 }) })),
    );
    const deepOut = value(
      estimateCryptoUpdown(input({ spec: spec({ strike: 400_000 }) })),
    );
    const atTheMoney = value(
      estimateCryptoUpdown(input({ spec: spec({ strike: 110_000 }) })),
    );

    expect(deepIn.q).toBeGreaterThan(0.99);
    expect(deepOut.q).toBeLessThan(0.01);
    expect(atTheMoney.q).toBeCloseTo(0.5, 12);
  });

  it("mirrors 'below' against 'above'", () => {
    const above = value(
      estimateCryptoUpdown(
        input({ spec: spec({ strike: 112_000, direction: "above" }) }),
      ),
    );
    const below = value(
      estimateCryptoUpdown(
        input({ spec: spec({ strike: 112_000, direction: "below" }) }),
      ),
    );
    expect(below.q).toBeCloseTo(1 - above.q, 12);
    expect(below.sigma).toBeCloseTo(above.sigma, 12);
  });

  it("moves an out-of-the-money q towards 0.5 as volatility rises", () => {
    const calm = value(
      estimateCryptoUpdown(
        input({
          spec: spec({ strike: 114_000 }),
          series: series(closes(200, 110_000, 0.0002)),
        }),
      ),
    );
    const wild = value(
      estimateCryptoUpdown(
        input({
          spec: spec({ strike: 114_000 }),
          series: series(closes(200, 110_000, 0.0015)),
        }),
      ),
    );
    expect(calm.q).toBeLessThan(wild.q);
    expect(wild.q).toBeLessThan(0.5);
  });

  it("moves an out-of-the-money q towards 0.5 as the horizon grows", () => {
    const near = value(
      estimateCryptoUpdown(
        input({
          spec: spec({
            strike: 114_000,
            deadline: new Date(DECISION_TS.getTime() + 2 * 3_600_000),
          }),
        }),
      ),
    );
    const far = value(
      estimateCryptoUpdown(
        input({
          spec: spec({
            strike: 114_000,
            deadline: new Date(DECISION_TS.getTime() + 10 * 24 * 3_600_000),
          }),
        }),
      ),
    );
    expect(near.q).toBeLessThan(far.q);
  });

  it("is deterministic: identical inputs produce byte-identical q and sigma", () => {
    const first = value(estimateCryptoUpdown(input()));
    const second = value(estimateCryptoUpdown(input()));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("records provenance of the exact data it used", () => {
    const result = estimateCryptoUpdown(input());
    if (!result.ok) {
      throw new Error(`expected an estimate, got ${result.reason}`);
    }
    const refs = result.value.dataRefs;
    expect(refs.feedName).toBe(FEED);
    expect(refs.feedSymbol).toBe(SYMBOL);
    expect(refs.feedSourceTs).toBe(
      new Date(DECISION_TS.getTime() - 15_000).toISOString(),
    );
    expect(refs.sampleCount).toBe(200);
    expect(refs.windowTo).toBe(
      new Date(DECISION_TS.getTime() - MINUTE_MS).toISOString(),
    );
    expect(refs.windowFrom).toBe(
      new Date(DECISION_TS.getTime() - 200 * MINUTE_MS).toISOString(),
    );
    expect(result.value.featureSetVersion).toBe(CRYPTO_FEATURE_SET_VERSION);
    expect(result.value.feedStale).toBe(false);
  });

  it("routes every input through the as-of guard", () => {
    const guard = new AsOfGuard(DECISION_TS);
    estimateCryptoUpdown(input({ guard }));
    expect(guard.entries().map((entry) => entry.name)).toEqual([
      "crypto_spec",
      "crypto_feed_twap",
      "crypto_feed_series_1m",
    ]);
    for (const entry of guard.entries()) {
      if (entry.sourceTs !== null) {
        expect(entry.sourceTs.getTime()).toBeLessThanOrEqual(
          DECISION_TS.getTime(),
        );
      }
    }
  });
});

describe("crypto abstention", () => {
  it("abstains on a stale feed", () => {
    const result = estimateCryptoUpdown(
      input({ feed: sample(110_000, 300_000, true) }),
    );
    expect(result).toEqual({ ok: false, reason: "FEED_STALE" });
  });

  it("abstains when there is no feed sample at all", () => {
    expect(estimateCryptoUpdown(input({ feed: null }))).toEqual({
      ok: false,
      reason: "FEED_STALE",
    });
  });

  it("abstains when the minute history is shorter than the configured floor", () => {
    const result = estimateCryptoUpdown(
      input({ series: series(closes(119, 110_000, 0.0006)) }),
    );
    expect(result).toEqual({ ok: false, reason: "MODEL_ABSTAINED" });
  });

  it("abstains once the horizon is gone", () => {
    expect(
      estimateCryptoUpdown(input({ spec: spec({ deadline: DECISION_TS }) })),
    ).toEqual({ ok: false, reason: "MODEL_ABSTAINED" });
    expect(
      estimateCryptoUpdown(
        input({
          spec: spec({ deadline: new Date(DECISION_TS.getTime() - 1_000) }),
        }),
      ),
    ).toEqual({ ok: false, reason: "MODEL_ABSTAINED" });
  });

  it("abstains on a frozen feed (zero realized volatility)", () => {
    const flat = new Array<number>(200).fill(110_000);
    expect(estimateCryptoUpdown(input({ series: series(flat) }))).toEqual({
      ok: false,
      reason: "MODEL_ABSTAINED",
    });
  });

  it("abstains when the series is not the same feed as the level", () => {
    const other: FeedSeries = {
      ...series(closes(200, 110_000, 0.0006)),
      feed: "spot",
    };
    expect(estimateCryptoUpdown(input({ series: other }))).toEqual({
      ok: false,
      reason: "MODEL_ABSTAINED",
    });
  });

  it("errors on a non-positive strike", () => {
    expect(estimateCryptoUpdown(input({ spec: spec({ strike: 0 }) }))).toEqual({
      ok: false,
      reason: "MODEL_ERROR",
    });
    expect(estimateCryptoUpdown(input({ spec: spec({ strike: -1 }) }))).toEqual(
      { ok: false, reason: "MODEL_ERROR" },
    );
    expect(
      estimateCryptoUpdown(input({ spec: spec({ strike: Number.NaN }) })),
    ).toEqual({ ok: false, reason: "MODEL_ERROR" });
  });
});

describe("crypto dispersion", () => {
  it("never reports a zero dispersion, even when every variant agrees", () => {
    // Exactly at the money every variant returns 0.5, so the ensemble has no
    // spread at all; the floor is what stops the model claiming certainty.
    const atTheMoney = value(estimateCryptoUpdown(input()));
    expect(atTheMoney.sigma).toBeCloseTo(0.005, 12);
    expect(atTheMoney.sigma).toBeGreaterThan(0);
  });

  it("grows when the variants disagree in the tail", () => {
    // ~1 sigma out of the money, where the variance-matched Student-t and the
    // normal disagree most in absolute probability.
    const tail = value(
      estimateCryptoUpdown(input({ spec: spec({ strike: 112_500 }) })),
    );
    const atTheMoney = value(estimateCryptoUpdown(input()));
    expect(tail.sigma).toBeGreaterThan(atTheMoney.sigma);
    expect(tail.sigma).toBeGreaterThan(0);
  });

  it("keeps sigma positive across a sweep of strikes and horizons", () => {
    for (const strike of [40_000, 90_000, 110_000, 130_000, 400_000]) {
      for (const hours of [0.5, 6, 24, 24 * 30]) {
        const result = value(
          estimateCryptoUpdown(
            input({
              spec: spec({
                strike,
                deadline: new Date(DECISION_TS.getTime() + hours * 3_600_000),
              }),
            }),
          ),
        );
        expect(result.sigma).toBeGreaterThan(0);
        expect(result.q).toBeGreaterThan(0);
        expect(result.q).toBeLessThan(1);
      }
    }
  });
});

describe("crypto calibration correction", () => {
  const strike = 114_000;

  it("is a no-op when the fit is the identity on logit(q_base)", () => {
    const uncorrected = value(
      estimateCryptoUpdown(input({ spec: spec({ strike }) })),
    );
    const identity: CryptoHyperparams = {
      ...DEFAULT_CRYPTO_HYPERPARAMS,
      calibration: { intercept: 0, coefficients: [1, 0, 0, 0] },
    };
    const corrected = value(
      estimateCryptoUpdown(
        input({ spec: spec({ strike }), hyperparams: identity }),
      ),
    );
    expect(corrected.q).toBeCloseTo(uncorrected.q, 6);
  });

  it("changes q when a real correction is present", () => {
    const shifted: CryptoHyperparams = {
      ...DEFAULT_CRYPTO_HYPERPARAMS,
      calibration: { intercept: 0.75, coefficients: [1, 0, 0, 0] },
    };
    const uncorrected = value(
      estimateCryptoUpdown(input({ spec: spec({ strike }) })),
    );
    const corrected = value(
      estimateCryptoUpdown(
        input({ spec: spec({ strike }), hyperparams: shifted }),
      ),
    );
    expect(corrected.q).toBeGreaterThan(uncorrected.q);
  });

  it("leaves the dispersion to the ensemble, not to the correction", () => {
    const shifted: CryptoHyperparams = {
      ...DEFAULT_CRYPTO_HYPERPARAMS,
      calibration: { intercept: 0.75, coefficients: [1, 0, 0, 0] },
    };
    const uncorrected = value(
      estimateCryptoUpdown(input({ spec: spec({ strike }) })),
    );
    const corrected = value(
      estimateCryptoUpdown(
        input({ spec: spec({ strike }), hyperparams: shifted }),
      ),
    );
    expect(corrected.sigma).toBeCloseTo(uncorrected.sigma, 12);
  });

  it("errors instead of silently zero-padding a correction of the wrong width", () => {
    const wrongWidth: CryptoHyperparams = {
      ...DEFAULT_CRYPTO_HYPERPARAMS,
      calibration: { intercept: 0, coefficients: [1, 0] },
    };
    expect(
      estimateCryptoUpdown(
        input({ spec: spec({ strike }), hyperparams: wrongWidth }),
      ),
    ).toEqual({ ok: false, reason: "MODEL_ERROR" });
  });
});

describe("cryptoFeatureRow", () => {
  it("starts with logit(q_base) and keeps a fixed column order", () => {
    const row = cryptoFeatureRow({
      qBase: 0.75,
      logDistance: 0.02,
      sqrtTau: 1.5,
      volEwma: 0.03,
    });
    expect(row).toHaveLength(4);
    expect(row[0]).toBeCloseTo(Math.log(0.75 / 0.25), 9);
    expect(row[1]).toBe(0.02);
    expect(row[2]).toBe(1.5);
    expect(row[3]).toBe(0.03);
  });
});

describe("trainCryptoCalibration", () => {
  function trainingSet(): Array<{ row: number[]; label: number }> {
    const random = createSeededRandom(7);
    const samples: Array<{ row: number[]; label: number }> = [];
    for (let index = 0; index < 200; index += 1) {
      const qBase = 0.05 + 0.9 * random();
      const row = cryptoFeatureRow({
        qBase,
        logDistance: -Math.log(qBase / (1 - qBase)) / 50,
        sqrtTau: 1,
        volEwma: 0.03,
      });
      // A deliberately learnable signal: the outcome follows the base map.
      samples.push({ row, label: qBase > 0.5 ? 1 : 0 });
    }
    return samples;
  }

  it("is deterministic: the same samples produce the same coefficients", () => {
    const samples = trainingSet();
    const first = trainCryptoCalibration(samples);
    const second = trainCryptoCalibration(samples);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("fits the signal it was given", () => {
    const fit = trainCryptoCalibration(trainingSet());
    expect(fit.coefficients[0]).toBeGreaterThan(0);

    const high = cryptoFeatureRow({
      qBase: 0.9,
      logDistance: 0,
      sqrtTau: 1,
      volEwma: 0.03,
    });
    const low = cryptoFeatureRow({
      qBase: 0.1,
      logDistance: 0,
      sqrtTau: 1,
      volEwma: 0.03,
    });
    const predict = (row: readonly number[]): number => {
      let z = fit.intercept;
      for (let index = 0; index < fit.coefficients.length; index += 1) {
        z += (fit.coefficients[index] ?? 0) * (row[index] ?? 0);
      }
      return 1 / (1 + Math.exp(-z));
    };
    expect(predict(high)).toBeGreaterThan(0.5);
    expect(predict(low)).toBeLessThan(0.5);
    expect(predict(high)).toBeGreaterThan(predict(low));
  });

  it("returns the identity fit rather than a 0.5 collapse for unusable samples", () => {
    expect(trainCryptoCalibration([])).toEqual({
      intercept: 0,
      coefficients: [1, 0, 0, 0],
      converged: false,
    });
    expect(
      trainCryptoCalibration([
        { row: [Number.NaN, 0, 1, 0.03], label: 1 },
        { row: [0.5, 0, 1, 0.03], label: 0 },
      ]),
    ).toEqual({ intercept: 0, coefficients: [1, 0, 0, 0], converged: false });
  });
});

describe("parseCryptoHyperparams", () => {
  it("falls back to the config defaults when nothing is stored", () => {
    expect(parseCryptoHyperparams(null, DEFAULT_FUNDAMENTAL_CONFIG)).toEqual({
      variant: "normal",
      ewmaLambdas: DEFAULT_FUNDAMENTAL_CONFIG.crypto.ewmaLambdas,
      studentDf: DEFAULT_FUNDAMENTAL_CONFIG.crypto.studentDf,
      calibration: null,
    });
  });

  it("accepts both spellings of the stored fields", () => {
    expect(
      parseCryptoHyperparams(
        {
          variant: "student_t",
          ewma_lambdas: [0.9],
          student_df: 6,
          calibration: { intercept: 0.1, coefficients: [1, 0, 0, 0] },
        },
        DEFAULT_FUNDAMENTAL_CONFIG,
      ),
    ).toEqual({
      variant: "student_t",
      ewmaLambdas: [0.9],
      studentDf: 6,
      calibration: { intercept: 0.1, coefficients: [1, 0, 0, 0] },
    });
    expect(
      parseCryptoHyperparams(
        { ewmaLambdas: [0.8], studentDf: 5 },
        DEFAULT_FUNDAMENTAL_CONFIG,
      ),
    ).toMatchObject({ ewmaLambdas: [0.8], studentDf: 5 });
  });

  it("rejects an invalid field observably instead of using it", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const parsed = parseCryptoHyperparams(
      {
        variant: "lognormal",
        ewma_lambdas: [2],
        student_df: 1,
        calibration: { intercept: 0, coefficients: [1, 0] },
      },
      DEFAULT_FUNDAMENTAL_CONFIG,
    );
    expect(parsed).toEqual(DEFAULT_CRYPTO_HYPERPARAMS);
    const reasons = stderrSpy.mock.calls.map(
      (call: unknown[]) =>
        (JSON.parse(String(call[0])) as { reason_code: string }).reason_code,
    );
    expect(reasons).toEqual([
      "CRYPTO_HYPERPARAM_INVALID",
      "CRYPTO_HYPERPARAM_INVALID",
      "CRYPTO_HYPERPARAM_INVALID",
      "CRYPTO_HYPERPARAM_INVALID",
    ]);
  });

  it("serves the student_t variant when it is the one stored", () => {
    const studentT = parseCryptoHyperparams(
      { variant: "student_t" },
      DEFAULT_FUNDAMENTAL_CONFIG,
    );
    const normal = value(estimateCryptoUpdown(input()));
    const heavy = value(
      estimateCryptoUpdown(
        input({ spec: spec({ strike: 118_000 }), hyperparams: studentT }),
      ),
    );
    const light = value(
      estimateCryptoUpdown(input({ spec: spec({ strike: 118_000 }) })),
    );
    // Both variants price the same width, so they differ only in tail shape.
    expect(heavy.q).not.toBe(light.q);
    expect(normal.q).toBeCloseTo(0.5, 12);
  });
});

describe("crypto model identity", () => {
  it("pins the family, version and feature-set version", () => {
    expect(CRYPTO_MODEL_FAMILY).toBe("crypto_updown_gbm");
    expect(CRYPTO_MODEL_VERSION).toBe("1.0.0");
    expect(CRYPTO_FEATURE_SET_VERSION).toBe("1.0.0");
  });

  it("honours a narrowed configuration", () => {
    const tightened: FundamentalConfig = {
      ...DEFAULT_FUNDAMENTAL_CONFIG,
      crypto: { ...DEFAULT_FUNDAMENTAL_CONFIG.crypto, minHistoryMinutes: 300 },
    };
    expect(estimateCryptoUpdown(input({ config: tightened }))).toEqual({
      ok: false,
      reason: "MODEL_ABSTAINED",
    });
  });
});
