import { describe, expect, it } from "vitest";

import { DEFAULT_FUNDAMENTAL_CONFIG } from "../../../src/polymarket/fundamental/config.js";
import {
  decideEstimate,
  type EstimateInputs,
  type ModelAttempt,
} from "../../../src/polymarket/fundamental/estimate.js";
import type {
  BookView,
  Estimate,
  ModelOutput,
} from "../../../src/polymarket/fundamental/types.js";

const DECISION_TS = new Date("2026-08-19T12:00:00.000Z");
const GIT_SHA = "a".repeat(40);

function book(overrides: Partial<BookView> = {}): BookView {
  return {
    tokenId: "token-1",
    bids: [
      { price: "0.50", size: "1000" },
      { price: "0.49", size: "5000" },
    ],
    asks: [
      { price: "0.52", size: "1000" },
      { price: "0.53", size: "5000" },
    ],
    sourceTs: DECISION_TS,
    observedAt: DECISION_TS,
    ...overrides,
  };
}

function modelOutput(overrides: Partial<ModelOutput> = {}): ModelOutput {
  return {
    q: 0.62,
    sigma: 0.03,
    featureSetVersion: "1.0.0",
    dataRefs: {
      bookSourceTs: DECISION_TS.toISOString(),
      bookObservedAt: DECISION_TS.toISOString(),
      feedSourceTs: DECISION_TS.toISOString(),
      feedSymbol: "btc/usd",
      feedName: "twap30",
    },
    feedStale: false,
    thinBook: false,
    ...overrides,
  };
}

function attempt(overrides: Partial<ModelAttempt> = {}): ModelAttempt {
  return {
    modelId: "crypto_updown_gbm@1.0.0",
    modelVersion: "1.0.0",
    status: "active",
    result: { ok: true, value: modelOutput() },
    ...overrides,
  };
}

function inputs(overrides: Partial<EstimateInputs> = {}): EstimateInputs {
  return {
    marketId: "condition-1",
    tokenId: "token-1",
    category: "crypto_updown",
    decisionTs: DECISION_TS,
    book: book(),
    activeModel: null,
    shadowModels: [],
    gitSha: GIT_SHA,
    umaDisputeActive: false,
    ruleChangedRecently: false,
    timeToResolutionMs: 30 * 60_000,
    config: DEFAULT_FUNDAMENTAL_CONFIG,
    ...overrides,
  };
}

function consumerOf(decision: ReturnType<typeof decideEstimate>): Estimate {
  if (decision.kind !== "estimates") {
    throw new Error(`expected estimates, got ${decision.kind}`);
  }
  return decision.consumer;
}

describe("decideEstimate - absence", () => {
  it("emits NO estimate when there is no book at all", () => {
    expect(decideEstimate(inputs({ book: null }))).toEqual({
      kind: "absent",
      reason: "NO_BOOK",
    });
  });

  it("emits no estimate (not a default value) when the book is invalid", () => {
    const cases: Array<[Partial<BookView>, string]> = [
      [{ sourceTs: new Date(DECISION_TS.getTime() - 31_000) }, "BOOK_STALE"],
      [
        {
          bids: [{ price: "0.40", size: "1000" }],
          asks: [{ price: "0.55", size: "1000" }],
        },
        "SPREAD_TOO_WIDE",
      ],
      [
        {
          bids: [{ price: "0.50", size: "1" }],
          asks: [{ price: "0.52", size: "1" }],
        },
        "DEPTH_BELOW_SREF",
      ],
    ];
    for (const [override, reason] of cases) {
      const decision = decideEstimate(inputs({ book: book(override) }));
      expect(decision).toEqual({ kind: "absent", reason });
    }
  });
});

describe("decideEstimate - deterministic fallback", () => {
  const fallbackCases: Array<[string, Partial<EstimateInputs>, string]> = [
    ["no model registered", {}, "NO_ACTIVE_MODEL"],
    [
      "model still in shadow",
      { activeModel: attempt({ status: "shadow" }) },
      "MODEL_IN_SHADOW",
    ],
    [
      "model raised an error",
      {
        activeModel: attempt({ result: { ok: false, reason: "MODEL_ERROR" } }),
      },
      "MODEL_ERROR",
    ],
    [
      "model timed out",
      {
        activeModel: attempt({
          result: { ok: false, reason: "MODEL_TIMEOUT" },
        }),
      },
      "MODEL_TIMEOUT",
    ],
    [
      "model abstained",
      {
        activeModel: attempt({
          result: { ok: false, reason: "MODEL_ABSTAINED" },
        }),
      },
      "MODEL_ABSTAINED",
    ],
    [
      "external feed is stale",
      {
        activeModel: attempt({
          result: { ok: true, value: modelOutput({ feedStale: true }) },
        }),
      },
      "FEED_STALE",
    ],
    [
      "an active UMA dispute vetoes the model",
      { activeModel: attempt(), umaDisputeActive: true },
      "UMA_DISPUTE_ACTIVE",
    ],
    [
      "the running revision is unknown",
      { activeModel: attempt(), gitSha: null },
      "PROVENANCE_UNAVAILABLE",
    ],
    [
      "the model returned a non-finite q",
      {
        activeModel: attempt({
          result: { ok: true, value: modelOutput({ q: Number.NaN }) },
        }),
      },
      "MODEL_ERROR",
    ],
  ];

  for (const [name, override, reason] of fallbackCases) {
    it(`degrades to MARKET_BASELINE without throwing: ${name}`, () => {
      const consumer = consumerOf(decideEstimate(inputs(override)));
      expect(consumer.source).toBe("MARKET_BASELINE");
      expect(consumer.status).toBe("active");
      expect(consumer.fallbackReason).toBe(reason);
      expect(consumer.provenance).toBeNull();
      // The baseline is never switched off: q equals the executable microprice.
      expect(consumer.q).toBe(consumer.marketProb);
    });
  }

  it("makes the fallback interval wider than the raw baseline interval", () => {
    const fallback = consumerOf(decideEstimate(inputs()));
    const widened = Number(fallback.qHi) - Number(fallback.qLo);
    const structural = Number(fallback.execSpread);
    expect(widened).toBeGreaterThan(structural);
  });
});

describe("decideEstimate - model path", () => {
  it("serves a promoted model with complete provenance", () => {
    const consumer = consumerOf(
      decideEstimate(inputs({ activeModel: attempt() })),
    );
    expect(consumer.source).toBe("MODEL");
    expect(consumer.status).toBe("active");
    expect(consumer.fallbackReason).toBeNull();
    expect(consumer.provenance).toEqual({
      modelId: "crypto_updown_gbm@1.0.0",
      modelVersion: "1.0.0",
      featureSetVersion: "1.0.0",
      gitSha: GIT_SHA,
    });
    expect(consumer.dataRefs.feedSymbol).toBe("btc/usd");
    expect(consumer.q).toBe("0.620000");
  });

  it("writes shadow rows that never become the consumer row", () => {
    const decision = decideEstimate(
      inputs({
        activeModel: null,
        shadowModels: [
          attempt({ modelId: "shadow@1.0.0", status: "shadow" }),
          attempt({ modelId: "shadow@1.1.0", status: "shadow" }),
        ],
      }),
    );
    if (decision.kind !== "estimates") {
      throw new Error("expected estimates");
    }
    expect(decision.consumer.source).toBe("MARKET_BASELINE");
    // A registered but unpromoted model reports MODEL_IN_SHADOW, not
    // NO_ACTIVE_MODEL: the operator needs to see that the gate is the blocker.
    expect(decision.consumer.fallbackReason).toBe("MODEL_IN_SHADOW");
    expect(decision.shadow).toHaveLength(2);
    for (const row of decision.shadow) {
      expect(row.source).toBe("MODEL");
      expect(row.status).toBe("shadow");
      expect(row.provenance).not.toBeNull();
    }
  });

  it("suppresses shadow rows when provenance or the dispute veto applies", () => {
    const noSha = decideEstimate(
      inputs({
        gitSha: null,
        shadowModels: [attempt({ status: "shadow" })],
      }),
    );
    const disputed = decideEstimate(
      inputs({
        umaDisputeActive: true,
        shadowModels: [attempt({ status: "shadow" })],
      }),
    );
    if (noSha.kind !== "estimates" || disputed.kind !== "estimates") {
      throw new Error("expected estimates");
    }
    expect(noSha.shadow).toHaveLength(0);
    expect(disputed.shadow).toHaveLength(0);
  });

  it("propagates the flags the consumer needs", () => {
    const thin = consumerOf(
      decideEstimate(
        inputs({
          book: book({
            bids: [{ price: "0.50", size: "300" }],
            asks: [{ price: "0.52", size: "300" }],
          }),
          ruleChangedRecently: true,
        }),
      ),
    );
    expect(thin.flags.thinBook).toBe(true);
    expect(thin.flags.ruleChangedRecently).toBe(true);
  });

  it("is byte-deterministic for the same inputs and model version", () => {
    const first = decideEstimate(inputs({ activeModel: attempt() }));
    const second = decideEstimate(inputs({ activeModel: attempt() }));
    expect(JSON.stringify(first, replacer)).toBe(
      JSON.stringify(second, replacer),
    );
  });
});

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

describe("provenance merge", () => {
  it("keeps the recorded book's source_ts over a model's placeholder", () => {
    const bookSourceTs = new Date(DECISION_TS.getTime() - 4_000);
    const consumer = consumerOf(
      decideEstimate(
        inputs({
          book: book({ sourceTs: bookSourceTs, observedAt: bookSourceTs }),
          activeModel: attempt({
            result: {
              ok: true,
              value: modelOutput({
                dataRefs: {
                  // A model that reads no book still has to fill these keys.
                  bookSourceTs: null,
                  bookObservedAt: DECISION_TS.toISOString(),
                  feedSourceTs: DECISION_TS.toISOString(),
                  feedSymbol: "btc/usd",
                },
              }),
            },
          }),
        }),
      ),
    );
    expect(consumer.dataRefs.bookSourceTs).toBe(bookSourceTs.toISOString());
    expect(consumer.dataRefs.bookObservedAt).toBe(bookSourceTs.toISOString());
    // The model's own provenance is preserved alongside it.
    expect(consumer.dataRefs.feedSymbol).toBe("btc/usd");
  });
});

describe("categories without a model", () => {
  it("still emits a baseline estimate, flagged CATEGORY_NOT_MODELLED", () => {
    // RFC-010 acceptance: EVERY token of the universe with a valid book has an
    // estimate. A category no model owns must produce a baseline row, never
    // silence — silence reads as "no opportunity" instead of "no model".
    const consumer = consumerOf(
      decideEstimate(
        inputs({
          category: "sports",
          categoryModelled: false,
          activeModel: attempt(),
        }),
      ),
    );
    expect(consumer.source).toBe("MARKET_BASELINE");
    expect(consumer.fallbackReason).toBe("CATEGORY_NOT_MODELLED");
    expect(consumer.category).toBe("sports");
    expect(consumer.q).toBe(consumer.marketProb);
  });

  it("writes no shadow row for an unmodelled category", () => {
    const decision = decideEstimate(
      inputs({
        category: "sports",
        categoryModelled: false,
        shadowModels: [attempt({ status: "shadow" })],
      }),
    );
    if (decision.kind !== "estimates") {
      throw new Error("expected estimates");
    }
    expect(decision.shadow).toHaveLength(0);
  });
});
