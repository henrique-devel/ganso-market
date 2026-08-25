import { describe, expect, it } from "vitest";

import {
  parseExtendedMarket,
  type ExtendedMarketRecord,
} from "../../src/polymarket/gamma.js";
import {
  capPriority,
  exclusionReason,
  refreshParams,
  runGammaCycle,
  selectUniverse,
  type JsonFetcher,
} from "../../src/polymarket/registry.js";
import { applyParamObservation } from "../../src/polymarket/versioning.js";
import { FakeDb } from "./fixtures/registry-fake-db.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");

function gammaRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    conditionId: "0xbtc",
    question: "Will Bitcoin close above $70,000 on Friday?",
    slug: "btc-above-70k-friday",
    tags: [{ slug: "crypto" }],
    negRisk: false,
    negRiskOther: false,
    clobTokenIds: '["11","12"]',
    outcomes: '["Yes","No"]',
    description:
      "Resolves YES if BTC closes above $70,000 per the Coinbase BTC-USD close.",
    resolutionSource: "Coinbase BTC-USD",
    resolvedBy: "UMA",
    endDate: "2026-09-30T00:00:00Z",
    umaEndDate: "2026-10-01T00:00:00Z",
    umaBond: "750",
    umaReward: 5,
    customLiveness: 7200,
    automaticallyResolved: false,
    updatedAt: "2026-08-19T09:00:00Z",
    orderPriceMinTickSize: 0.001,
    orderMinSize: 5,
    active: true,
    closed: false,
    enableOrderBook: true,
    events: [
      { id: "100", slug: "btc-weekly", title: "BTC weekly", negRisk: false },
    ],
    ...overrides,
  };
}

function record(overrides: Record<string, unknown> = {}): ExtendedMarketRecord {
  const parsed = parseExtendedMarket(gammaRow(overrides));
  if (parsed === null) {
    throw new Error("expected a parsed extended market");
  }
  return parsed;
}

function macroRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return gammaRow({
    conditionId: "0xfed",
    question: "Will the Fed cut rates at the September FOMC meeting?",
    slug: "fed-cut-september",
    tags: [{ slug: "fed" }],
    clobTokenIds: '["21","22"]',
    description:
      "Resolves YES if the FOMC lowers the target rate at its September meeting per the official statement.",
    resolutionSource: "federalreserve.gov statement",
    endDate: "2026-09-05T00:00:00Z",
    events: [],
    ...overrides,
  });
}

function electionRow(): Record<string, unknown> {
  return gammaRow({
    conditionId: "0xelect",
    question: "Who will win the 2028 presidential election?",
    slug: "presidential-election-2028",
    tags: [],
    clobTokenIds: '["31","32"]',
  });
}

function stubFetcher(
  handler: (url: string) => { ok: boolean; body?: unknown },
): { fetcher: JsonFetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: JsonFetcher = (url) => {
    calls.push(url);
    const result = handler(url);
    return Promise.resolve({
      ok: result.ok,
      json: () => Promise.resolve(result.body ?? null),
    });
  };
  return { fetcher, calls };
}

describe("extended market parsing", () => {
  it("parses rule and event fields tolerantly", () => {
    const parsed = record();
    expect(parsed.resolutionSource).toBe("Coinbase BTC-USD");
    expect(parsed.resolvedBy).toBe("UMA");
    expect(parsed.umaBond).toBe("750");
    expect(parsed.umaReward).toBe("5");
    expect(parsed.customLiveness).toBe("7200");
    expect(parsed.automaticallyResolved).toBe(false);
    expect(parsed.updatedAt).toBe("2026-08-19T09:00:00Z");
    expect(parsed.events).toEqual([
      {
        eventId: "100",
        slug: "btc-weekly",
        title: "BTC weekly",
        negRisk: false,
      },
    ]);
    expect(parsed.outcomes).toEqual(["Yes", "No"]);
    expect(parsed.affirmativeTokenId).toBe("11");
  });

  it("degrades missing optional fields to null/empty without throwing", () => {
    const parsed = parseExtendedMarket({
      conditionId: "0xbare",
      question: "Will BTC be up?",
      clobTokenIds: '["1","2"]',
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.resolutionSource).toBeNull();
    expect(parsed?.umaBond).toBeNull();
    expect(parsed?.automaticallyResolved).toBeNull();
    expect(parsed?.events).toEqual([]);
    expect(parsed?.outcomes).toEqual([]);
    expect(parsed?.affirmativeTokenId).toBeNull();
  });

  it("returns null (never throws) for unusable payloads", () => {
    expect(parseExtendedMarket(42)).toBeNull();
    expect(parseExtendedMarket(null)).toBeNull();
    expect(parseExtendedMarket({})).toBeNull();
    expect(parseExtendedMarket({ question: "no ids" })).toBeNull();
  });

  it("drops augmented-negRisk placeholder outcomes, keeping named ones", () => {
    const parsed = record({
      outcomes: '["Yes","No","Person A","Candidate B2","  ",""]',
    });
    expect(parsed.outcomes).toEqual(["Yes", "No"]);
  });
});

describe("universe exclusions", () => {
  it("hard-excludes elections, sports, mentions and geopolitics", () => {
    expect(exclusionReason(record(electionRow()))).toBe("election");
    expect(
      exclusionReason(
        record({ question: "Lakers vs Celtics: who wins tonight?" }),
      ),
    ).toBe("live_sports");
    expect(
      exclusionReason(
        record({ question: "Will Powell mention inflation twice?" }),
      ),
    ).toBe("mentions");
    expect(
      exclusionReason(record({ question: "Ceasefire agreement by March?" })),
    ).toBe("geopolitics");
  });

  it("excludes empty/short descriptions and subjective resolution sources", () => {
    expect(exclusionReason(record({ description: "short" }))).toBe(
      "description_empty_or_short",
    );
    expect(
      exclusionReason(
        record({
          description:
            "Resolution will be decided by media consensus of major outlets.",
        }),
      ),
    ).toBe("subjective_resolution_source");
  });

  it("excludes untracked categories (weather) and admits crypto/macro", () => {
    expect(
      exclusionReason(
        record({
          question: "Highest temperature in NYC on Aug 20?",
          tags: [{ slug: "weather" }],
        }),
      ),
    ).toBe("category_not_tracked");
    expect(exclusionReason(record())).toBeNull();
    expect(exclusionReason(record(macroRow()))).toBeNull();
  });
});

describe("universe caps and priority", () => {
  it("orders macro (near catalyst) before crypto threshold before short series", () => {
    const shortSeries = record({
      conditionId: "0xshort",
      question: "Bitcoin Up or Down - 3PM ET",
      slug: "btc-updown-3pm",
      clobTokenIds: '["41","42"]',
    });
    const threshold = record();
    const macroNear = record(macroRow());
    expect(capPriority(macroNear, NOW)).toBe(1);
    expect(capPriority(threshold, NOW)).toBe(2);
    expect(capPriority(shortSeries, NOW)).toBe(3);

    const selection = selectUniverse([shortSeries, threshold, macroNear], NOW, {
      maxMarkets: 2,
      maxTokens: 10,
    });
    expect(selection.selected.map((entry) => entry.conditionId)).toEqual([
      "0xfed",
      "0xbtc",
    ]);
    expect(selection.rejectedCap).toEqual([
      { conditionId: "0xshort", reason: "cap_markets_exceeded" },
    ]);
  });

  it("macro without a near catalyst ranks last", () => {
    const farMacro = record(macroRow({ endDate: "2027-08-01T00:00:00Z" }));
    expect(capPriority(farMacro, NOW)).toBe(4);
  });

  it("enforces the token cap", () => {
    const a = record({ conditionId: "0xa", clobTokenIds: '["1","2"]' });
    const b = record({ conditionId: "0xb", clobTokenIds: '["3","4"]' });
    const c = record({ conditionId: "0xc", clobTokenIds: '["5","6"]' });
    const selection = selectUniverse([a, b, c], NOW, {
      maxMarkets: 10,
      maxTokens: 4,
    });
    expect(selection.selected).toHaveLength(2);
    expect(selection.rejectedCap).toEqual([
      { conditionId: "0xc", reason: "cap_tokens_exceeded" },
    ]);
  });

  it("caps at 100 markets / 200 tokens by default, rejecting the rest", () => {
    const records = Array.from({ length: 105 }, (_, index) =>
      record({
        conditionId: `0xc${String(index)}`,
        clobTokenIds: JSON.stringify([
          `${String(index)}-yes`,
          `${String(index)}-no`,
        ]),
      }),
    );
    const selection = selectUniverse(records, NOW);
    expect(selection.selected).toHaveLength(100);
    expect(selection.rejectedCap).toHaveLength(5);
    expect(
      selection.rejectedCap.every(
        (entry) => entry.reason === "cap_markets_exceeded",
      ),
    ).toBe(true);
  });
});

describe("runGammaCycle", () => {
  it("selects, upserts, versions and logs enters and rejections", async () => {
    const db = new FakeDb();
    const { fetcher } = stubFetcher(() => ({
      ok: true,
      body: [gammaRow(), macroRow(), electionRow(), 42],
    }));

    const result = await runGammaCycle({
      pool: db,
      fetcher,
      now: () => NOW,
      baseUrl: "https://gamma.test",
    });

    expect(new Set(result.entered)).toEqual(new Set(["0xbtc", "0xfed"]));
    expect(result.exited).toEqual([]);
    expect(result.universe).toHaveLength(2);
    const btc = result.universe.find((m) => m.conditionId === "0xbtc");
    expect(btc).toEqual({
      conditionId: "0xbtc",
      tokenIds: ["11", "12"],
      category: "crypto",
    });

    // Membership log: two enters plus one filter rejection for the election.
    const enters = db.universeLog.filter((row) => row.action === "enter");
    expect(enters).toHaveLength(2);
    const rejected = db.universeLog.filter(
      (row) => row.action === "rejected_filter",
    );
    expect(rejected).toEqual([
      expect.objectContaining({ condition_id: "0xelect", reason: "election" }),
    ]);

    // Registry upserts and versioning ran for both members.
    expect(db.markets).toHaveLength(2);
    expect(db.metadataVersions).toHaveLength(2);
    expect(db.events).toHaveLength(1); // Only the BTC row carries an event.
    expect(db.eventMarkets).toHaveLength(1);
    expect(db.ruleVersions).toHaveLength(2);
    expect(db.paramVersions).toHaveLength(2);
    const btcParams = db.paramVersions.find(
      (row) => row.condition_id === "0xbtc",
    );
    expect(btcParams).toMatchObject({ tick_size: "0.001", neg_risk: false });
  });

  it("versions market metadata only when its content changes", async () => {
    const db = new FakeDb();
    const initial = stubFetcher(() => ({ ok: true, body: [gammaRow()] }));
    await runGammaCycle({
      pool: db,
      fetcher: initial.fetcher,
      now: () => NOW,
    });

    const unchangedAt = new Date(NOW.getTime() + 60_000);
    await runGammaCycle({
      pool: db,
      fetcher: initial.fetcher,
      now: () => unchangedAt,
    });
    expect(db.metadataVersions).toHaveLength(1);

    const changedAt = new Date(NOW.getTime() + 120_000);
    const changed = stubFetcher(() => ({
      ok: true,
      body: [
        gammaRow({
          question: "Will the Fed cut rates before October?",
          slug: "fed-cut-before-october",
          tags: [{ slug: "fed" }],
          clobTokenIds: '["21","22"]',
        }),
      ],
    }));
    await runGammaCycle({
      pool: db,
      fetcher: changed.fetcher,
      now: () => changedAt,
    });

    expect(db.metadataVersions).toEqual([
      expect.objectContaining({
        condition_id: "0xbtc",
        version: 1,
        question: "Will Bitcoin close above $70,000 on Friday?",
        category: "crypto",
        clob_token_ids: ["11", "12"],
        affirmative_token_id: "11",
        valid_from: NOW,
        valid_to: changedAt,
      }),
      expect.objectContaining({
        condition_id: "0xbtc",
        version: 2,
        question: "Will the Fed cut rates before October?",
        category: "macro",
        clob_token_ids: ["21", "22"],
        affirmative_token_id: "21",
        valid_from: changedAt,
        valid_to: null,
      }),
    ]);
  });

  it("logs an exit when a previous member leaves the universe", async () => {
    const db = new FakeDb();
    const first = stubFetcher(() => ({
      ok: true,
      body: [gammaRow(), macroRow()],
    }));
    await runGammaCycle({ pool: db, fetcher: first.fetcher, now: () => NOW });

    const second = stubFetcher(() => ({ ok: true, body: [gammaRow()] }));
    const result = await runGammaCycle({
      pool: db,
      fetcher: second.fetcher,
      now: () => NOW,
    });

    expect(result.entered).toEqual([]); // Still-member markets do not re-enter.
    expect(result.exited).toEqual(["0xfed"]);
    const exits = db.universeLog.filter((row) => row.action === "exit");
    expect(exits).toEqual([
      expect.objectContaining({
        condition_id: "0xfed",
        reason: "not_selected",
      }),
    ]);
  });

  it("does not re-log an identical rejection every cycle", async () => {
    const db = new FakeDb();
    const pages = stubFetcher(() => ({
      ok: true,
      body: [gammaRow(), electionRow()],
    }));
    await runGammaCycle({ pool: db, fetcher: pages.fetcher, now: () => NOW });
    await runGammaCycle({ pool: db, fetcher: pages.fetcher, now: () => NOW });

    const rejected = db.universeLog.filter(
      (row) => row.condition_id === "0xelect",
    );
    expect(rejected).toHaveLength(1);
  });

  it("records a gamma gap and keeps the universe on fetch failure", async () => {
    const db = new FakeDb();
    const good = stubFetcher(() => ({ ok: true, body: [gammaRow()] }));
    await runGammaCycle({ pool: db, fetcher: good.fetcher, now: () => NOW });

    const bad = stubFetcher(() => ({ ok: false }));
    const result = await runGammaCycle({
      pool: db,
      fetcher: bad.fetcher,
      now: () => NOW,
    });

    expect(result.entered).toEqual([]);
    expect(result.exited).toEqual([]); // No mass-exit on a failed poll.
    expect(db.dataGaps).toEqual([
      expect.objectContaining({ source: "gamma", cause: "gamma_fetch_failed" }),
    ]);
    expect(db.universeLog.filter((row) => row.action === "exit")).toHaveLength(
      0,
    );
  });

  it("survives per-market persistence failures without aborting the cycle", async () => {
    const db = new FakeDb();
    const pages = stubFetcher(() => ({ ok: true, body: [gammaRow()] }));
    // First cycle establishes membership; second cycle fails all writes.
    await runGammaCycle({ pool: db, fetcher: pages.fetcher, now: () => NOW });
    db.failNextQueries = true;
    const result = await runGammaCycle({
      pool: db,
      fetcher: pages.fetcher,
      now: () => NOW,
    });
    expect(result.universe).toHaveLength(1); // Cycle completed, not crashed.
  });
});

describe("refreshParams", () => {
  it("versions a fee change while carrying tick size from the open version", async () => {
    const db = new FakeDb();
    await applyParamObservation(
      db,
      {
        conditionId: "0xbtc",
        feeBaseBps: "0",
        makerFeeBps: null,
        takerFeeBps: null,
        feeCurveJson: null,
        tickSize: "0.001",
        minOrderSize: "5",
        negRisk: false,
        sourceTs: null,
      },
      NOW,
    );

    const { fetcher, calls } = stubFetcher(() => ({
      ok: true,
      body: { fee_rate_bps: 25 },
    }));
    await refreshParams(
      { pool: db, fetcher, now: () => NOW, clobBaseUrl: "https://clob.test" },
      [{ conditionId: "0xbtc", tokenIds: ["11", "12"], category: "crypto" }],
    );

    expect(calls).toEqual(["https://clob.test/fee-rate?token_id=11"]);
    expect(db.paramVersions).toHaveLength(2);
    expect(db.paramVersions[1]).toMatchObject({
      fee_base_bps: "25",
      tick_size: "0.001",
    });
  });

  it("records a clob_rest gap on HTTP failure and continues", async () => {
    const db = new FakeDb();
    const { fetcher } = stubFetcher(() => ({ ok: false }));
    await refreshParams({ pool: db, fetcher, now: () => NOW }, [
      { conditionId: "0xbtc", tokenIds: ["11"], category: "crypto" },
      { conditionId: "0xfed", tokenIds: ["21"], category: "macro" },
    ]);

    expect(db.dataGaps).toHaveLength(2);
    expect(db.dataGaps[0]).toMatchObject({
      source: "clob_rest",
      token_id: "11",
      cause: "fee_poll_failed",
    });
    expect(db.paramVersions).toHaveLength(0);
  });
});
