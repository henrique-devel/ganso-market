import { describe, expect, it } from "vitest";

import {
  parseExtendedMarket,
  type ExtendedMarketRecord,
} from "../../src/polymarket/gamma.js";
import {
  FAST_SERIES_MAX_MARKETS,
  HOURLY_SERIES_SLUG_PATTERN,
  MAX_UNIVERSE_MARKETS,
  MAX_UNIVERSE_TOKENS,
  SHORT_HORIZON_RESERVED_MARKETS,
  SHORT_SERIES_PATTERN,
  capPriority,
  exclusionReason,
  isShortHorizon,
  refreshParams,
  runGammaCycle,
  selectUniverse,
  type JsonFetcher,
} from "../../src/polymarket/registry.js";
import { applyParamObservation } from "../../src/polymarket/versioning.js";
import { FakeDb } from "./fixtures/registry-fake-db.js";
import type { QueryResult, SqlExecutor } from "../../src/database.js";

/** FakeDb that records every statement with the transaction depth it ran at. */
class TracingFakeDb extends FakeDb {
  public readonly trace: Array<{ text: string; depth: number }> = [];
  private depth = 0;

  public override query<R extends Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    this.trace.push({ text, depth: this.depth });
    return super.query<R>(text, params);
  }

  public override async transaction<T>(
    run: (tx: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    this.depth += 1;
    try {
      return await super.transaction(run);
    } finally {
      this.depth -= 1;
    }
  }
}

/** FakeDb whose metadata-version insert always fails. */
class MetadataFailingFakeDb extends FakeDb {
  public override query<R extends Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    if (text.includes("INSERT INTO polymarket_market_metadata_versions")) {
      return Promise.reject(new Error("simulated metadata insert failure"));
    }
    return super.query<R>(text, params);
  }
}

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

  // RESOLUTION_MARKET_METADATA_VERSION_MISSING, measured in production on
  // 2026-08-31: 34 of the 78 daily failures were markets whose `enter` row had
  // committed 0,41 s before their first metadata version. Migration 0011
  // publishes the log insert to the resolution input journal the instant it
  // commits, and loadScoreableMarkets then reads a member it cannot map.
  it("logs the entry in the same transaction and instant as the first metadata version", async () => {
    const db = new TracingFakeDb();
    const { fetcher } = stubFetcher(() => ({ ok: true, body: [gammaRow()] }));

    const result = await runGammaCycle({
      pool: db,
      fetcher,
      now: () => NOW,
    });

    expect(result.entered).toEqual(["0xbtc"]);
    const metadataInsert = db.trace.findIndex((entry) =>
      entry.text.includes("INSERT INTO polymarket_market_metadata_versions"),
    );
    const enterInsert = db.trace.findIndex((entry) =>
      entry.text.includes("INSERT INTO polymarket_universe_log"),
    );
    expect(metadataInsert).toBeGreaterThanOrEqual(0);
    // Ordered AND inside the transaction: nothing can observe the membership
    // before the mapping, because they become visible in the same commit.
    expect(enterInsert).toBeGreaterThan(metadataInsert);
    expect(db.trace[enterInsert]?.depth).toBe(1);
    // Same instant, so an as-of read at the entry sees valid_from <= asOf.
    expect(db.universeLog).toEqual([
      expect.objectContaining({
        condition_id: "0xbtc",
        action: "enter",
        at: NOW,
      }),
    ]);
    expect(db.metadataVersions[0]?.valid_from).toEqual(NOW);
  });

  it("does not log the entry when the metadata observation fails", async () => {
    const db = new MetadataFailingFakeDb();
    const { fetcher } = stubFetcher(() => ({ ok: true, body: [gammaRow()] }));

    const result = await runGammaCycle({
      pool: db,
      fetcher,
      now: () => NOW,
    });

    // Fail-closed on entry: a market only becomes a universe member once its
    // mapping is persisted. It is retried in the next cycle.
    expect(result.entered).toEqual([]);
    expect(db.universeLog.filter((row) => row.action === "enter")).toEqual([]);
    expect(db.metadataVersions).toEqual([]);
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

// ---------------------------------------------------------------------------
// RFC-024 D2 — descoberta por série horária
// ---------------------------------------------------------------------------

/**
 * The 24 real hourly slugs of one day, captured live from Gamma on 2026-09-08
 * via `GET /events?series_id=10114&closed=false`, plus every neighbouring
 * cadence the venue publishes in the same family. The regex has to take the
 * 24 and refuse all the rest — the `SHORT_SERIES_PATTERN` it sits beside
 * matches 5min, 15min and 4h too, and using that one would put the whole
 * sub-hourly population into the fast universe.
 */
const HOURLY_SLUGS_REAIS = [
  "bitcoin-up-or-down-september-8-2026-12am-et",
  "bitcoin-up-or-down-september-8-2026-1am-et",
  "bitcoin-up-or-down-september-8-2026-2am-et",
  "bitcoin-up-or-down-september-8-2026-3am-et",
  "bitcoin-up-or-down-september-8-2026-4am-et",
  "bitcoin-up-or-down-september-8-2026-5am-et",
  "bitcoin-up-or-down-september-8-2026-6am-et",
  "bitcoin-up-or-down-september-8-2026-7am-et",
  "bitcoin-up-or-down-september-8-2026-8am-et",
  "bitcoin-up-or-down-september-8-2026-9am-et",
  "bitcoin-up-or-down-september-8-2026-10am-et",
  "bitcoin-up-or-down-september-8-2026-11am-et",
  "bitcoin-up-or-down-september-8-2026-12pm-et",
  "bitcoin-up-or-down-september-8-2026-1pm-et",
  "bitcoin-up-or-down-september-8-2026-2pm-et",
  "bitcoin-up-or-down-september-8-2026-3pm-et",
  "bitcoin-up-or-down-september-8-2026-4pm-et",
  "bitcoin-up-or-down-september-8-2026-5pm-et",
  "bitcoin-up-or-down-september-8-2026-6pm-et",
  "bitcoin-up-or-down-september-8-2026-7pm-et",
  "bitcoin-up-or-down-september-8-2026-8pm-et",
  "bitcoin-up-or-down-september-8-2026-9pm-et",
  "bitcoin-up-or-down-september-8-2026-10pm-et",
  "bitcoin-up-or-down-september-8-2026-11pm-et",
];

/** Real slugs of every other cadence in the same family, same listing. */
const NAO_HORARIOS_REAIS = [
  "btc-updown-5m-1788807600",
  "btc-updown-15m-1788827400",
  "btc-updown-4h-1788811200",
  "bitcoin-up-or-down-on-september-7-2026",
];

const SERIE_URL =
  "https://gamma.test/events?series_id=10114&closed=false&limit=100";

/** One `/events` row, shaped exactly like the live response. */
function serieEvent(
  slug: string,
  endDate: string,
  overrides: {
    conditionId?: string;
    tokenIds?: string;
    tags?: unknown;
    markets?: unknown;
  } = {},
): Record<string, unknown> {
  return {
    id: `evt-${slug}`,
    ticker: slug,
    slug,
    title: slug,
    endDate,
    // The tags live on the EVENT; the nested market has none.
    tags: overrides.tags ?? [{ slug: "crypto" }, { slug: "crypto-prices" }],
    markets: overrides.markets ?? [
      {
        conditionId: overrides.conditionId ?? `0x${slug.slice(-8)}`,
        question: `Bitcoin Up or Down - ${slug}`,
        slug,
        clobTokenIds: overrides.tokenIds ?? '["u1","d1"]',
        outcomes: '["Up","Down"]',
        description:
          'This market will resolve to "Up" if the close price is greater than or equal to the open price for the BTC/USDT 1 hour candle.',
        resolutionSource: "https://www.binance.com/en/trade/BTC_USDT",
        resolvedBy: "0x65070BE91477460D8A7AeEb94ef92fe056C2f2A7",
        endDate,
        umaBond: "250",
        umaReward: "0.6",
        updatedAt: "2026-08-19T11:59:00Z",
        orderPriceMinTickSize: 0.001,
        orderMinSize: 5,
        active: true,
        closed: false,
        enableOrderBook: true,
        negRisk: false,
        negRiskOther: false,
      },
    ],
  };
}

/** Splits the two Gamma calls the cycle now makes. */
function seriesFetcher(
  seriesBody: unknown,
  options: { top500?: unknown; seriesOk?: boolean } = {},
): { fetcher: JsonFetcher; calls: string[] } {
  return stubFetcher((url) =>
    url.includes("/events?series_id=")
      ? { ok: options.seriesOk ?? true, body: seriesBody }
      : { ok: true, body: options.top500 ?? [gammaRow()] },
  );
}

/** ISO of a market ending `minutes` after NOW. */
function endIn(minutes: number): string {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

describe("RFC-024 D2 — a regex horária", () => {
  it("casa os 24 slugs reais do dia", () => {
    expect(HOURLY_SLUGS_REAIS).toHaveLength(24);
    for (const slug of HOURLY_SLUGS_REAIS) {
      expect(HOURLY_SERIES_SLUG_PATTERN.test(slug), slug).toBe(true);
    }
  });

  it("recusa 5 min, 15 min, 4 h e diário — que a SHORT_SERIES_PATTERN casava", () => {
    for (const slug of NAO_HORARIOS_REAIS) {
      expect(HOURLY_SERIES_SLUG_PATTERN.test(slug), slug).toBe(false);
      // The regression this replaces: the old pattern took all of them.
      expect(
        SHORT_SERIES_PATTERN.test(`Bitcoin Up or Down ${slug}`),
        slug,
      ).toBe(true);
    }
  });

  it("recusa vizinhos malformados e outros ativos", () => {
    for (const slug of [
      "ethereum-up-or-down-september-8-2026-3pm-et",
      "bitcoin-up-or-down-september-8-2026-13pm-et",
      "bitcoin-up-or-down-sept-8-2026-3pm-et",
      "bitcoin-up-or-down-september-8-2026-3pm-et-resolved",
      "x-bitcoin-up-or-down-september-8-2026-3pm-et",
      "bitcoin-up-or-down-september-32-2026-3pm-et",
    ]) {
      expect(HOURLY_SERIES_SLUG_PATTERN.test(slug), slug).toBe(false);
    }
  });
});

describe("RFC-024 D2 — a janela de lookahead", () => {
  it("mercado a 80 min do fim NÃO entra; a 70 min entra", async () => {
    const db = new FakeDb();
    const { fetcher, calls } = seriesFetcher([
      serieEvent("bitcoin-up-or-down-september-8-2026-3pm-et", endIn(80), {
        conditionId: "0xlonge",
        tokenIds: '["l1","l2"]',
      }),
      serieEvent("bitcoin-up-or-down-september-8-2026-2pm-et", endIn(70), {
        conditionId: "0xperto",
        tokenIds: '["p1","p2"]',
      }),
    ]);

    const result = await runGammaCycle({
      pool: db,
      fetcher,
      now: () => NOW,
      baseUrl: "https://gamma.test",
    });

    expect(calls).toContain(SERIE_URL);
    const ids = result.universe.map((member) => member.conditionId);
    expect(ids).toContain("0xperto");
    expect(ids).not.toContain("0xlonge");
    expect(result.series.candidates).toBe(1);
    expect(result.series.entered).toBe(1);
    // 70 min of lead: the RFC's target is >= 60.
    expect(result.series.leadMinutes).toEqual([70]);
  });

  it("mercado já vencido não entra, mesmo com closed=false", async () => {
    // The live listing carried a May event still marked `closed=false`.
    const db = new FakeDb();
    const { fetcher } = seriesFetcher([
      serieEvent("bitcoin-up-or-down-may-20-2026-6am-et", endIn(-159_290), {
        conditionId: "0xvelho",
      }),
    ]);
    const result = await runGammaCycle({
      pool: db,
      fetcher,
      now: () => NOW,
      baseUrl: "https://gamma.test",
    });
    expect(result.universe.map((member) => member.conditionId)).not.toContain(
      "0xvelho",
    );
    expect(result.series.candidates).toBe(0);
  });

  it("com 4 já dentro, o 5.º é recusado — os 4 mais próximos do fim", async () => {
    const db = new FakeDb();
    const { fetcher } = seriesFetcher(
      [10, 20, 30, 40, 50].map((minutes, index) =>
        serieEvent(
          `bitcoin-up-or-down-september-8-2026-${String(index + 1)}pm-et`,
          endIn(minutes),
          {
            conditionId: `0xh${String(minutes)}`,
            tokenIds: `["a${String(minutes)}","b${String(minutes)}"]`,
          },
        ),
      ),
    );
    const result = await runGammaCycle({
      pool: db,
      fetcher,
      now: () => NOW,
      baseUrl: "https://gamma.test",
    });
    expect(result.series.candidates).toBe(FAST_SERIES_MAX_MARKETS);
    const ids = result.universe.map((member) => member.conditionId);
    for (const minutes of [10, 20, 30, 40]) {
      expect(ids).toContain(`0xh${String(minutes)}`);
    }
    expect(ids).not.toContain("0xh50");
  });
});

describe("RFC-024 D2 — a falha da série não custa o ciclo", () => {
  it("série falhando: top-500 intacto e lacuna gamma/series_fetch_failed", async () => {
    const db = new FakeDb();
    const { fetcher } = seriesFetcher(null, { seriesOk: false });

    const result = await runGammaCycle({
      pool: db,
      fetcher,
      now: () => NOW,
      baseUrl: "https://gamma.test",
    });

    // The top-500 selection is untouched.
    expect(result.universe.map((member) => member.conditionId)).toEqual([
      "0xbtc",
    ]);
    expect(result.fetchFailed).toBe(false);
    expect(result.series.fetchFailed).toBe(true);
    expect(result.series.candidates).toBe(0);

    const gap = db.dataGaps.find((row) => row.cause === "series_fetch_failed");
    expect(gap).toBeDefined();
    expect(gap?.source).toBe("gamma");
    // No token: the gap is about the listing, not about one market.
    expect(gap?.token_id).toBeNull();
    expect(gap?.details_json).toMatchObject({ series_id: "10114" });
  });

  it("série com corpo inesperado não derruba o ciclo", async () => {
    const db = new FakeDb();
    const { fetcher } = seriesFetcher({ nao: "um array" });
    const result = await runGammaCycle({
      pool: db,
      fetcher,
      now: () => NOW,
      baseUrl: "https://gamma.test",
    });
    expect(result.universe.map((member) => member.conditionId)).toEqual([
      "0xbtc",
    ]);
    expect(result.series.fetchFailed).toBe(false);
    expect(result.series.candidates).toBe(0);
  });
});

describe("RFC-024 D2 — o motivo do enter", () => {
  it("entrada pela série termina em _series; pelo top-500 não", async () => {
    const db = new FakeDb();
    const { fetcher } = seriesFetcher([
      serieEvent("bitcoin-up-or-down-september-8-2026-2pm-et", endIn(70), {
        conditionId: "0xserie",
        tokenIds: '["s1","s2"]',
      }),
    ]);

    await runGammaCycle({
      pool: db,
      fetcher,
      now: () => NOW,
      baseUrl: "https://gamma.test",
    });

    const enters = db.universeLog.filter((row) => row.action === "enter");
    const bySeries = enters.find((row) => row.condition_id === "0xserie");
    const byTop500 = enters.find((row) => row.condition_id === "0xbtc");
    expect(String(bySeries?.reason)).toMatch(/_series$/);
    // Priority 2 and the horizon bucket are still in there: the suffix ADDS
    // the source, it does not replace the RFC-016 information.
    expect(String(bySeries?.reason)).toMatch(/^priority_2_crypto_/);
    expect(String(byTop500?.reason)).not.toMatch(/_series$/);
  });

  it("mercado que o top-500 já achou não conta como entrada por série", async () => {
    const db = new FakeDb();
    // The same conditionId in both sources.
    const both = gammaRow({
      conditionId: "0xdupla",
      slug: "bitcoin-up-or-down-september-8-2026-2pm-et",
      endDate: endIn(70),
      clobTokenIds: '["x1","x2"]',
    });
    const { fetcher } = seriesFetcher(
      [
        serieEvent("bitcoin-up-or-down-september-8-2026-2pm-et", endIn(70), {
          conditionId: "0xdupla",
          tokenIds: '["x1","x2"]',
        }),
      ],
      { top500: [both] },
    );

    const result = await runGammaCycle({
      pool: db,
      fetcher,
      now: () => NOW,
      baseUrl: "https://gamma.test",
    });

    expect(result.series.candidates).toBe(1);
    expect(result.series.newToUniverse).toBe(0);
    expect(result.series.entered).toBe(0);
    // One market, not two: the merge dedupes by condition_id.
    expect(result.universe).toHaveLength(1);
    const enter = db.universeLog.find(
      (row) => row.action === "enter" && row.condition_id === "0xdupla",
    );
    expect(String(enter?.reason)).not.toMatch(/_series$/);
  });
});

describe("RFC-024 D2 — cap e reserva intocados", () => {
  it("a série não altera o cap de 100 mercados nem a reserva de 25", () => {
    expect(MAX_UNIVERSE_MARKETS).toBe(100);
    expect(MAX_UNIVERSE_TOKENS).toBe(200);
    expect(SHORT_HORIZON_RESERVED_MARKETS).toBe(25);
  });

  it("um horário a 70 min cai em capPriority 2 e na fila reservada", () => {
    const hourly = record({
      conditionId: "0xh",
      slug: "bitcoin-up-or-down-september-8-2026-2pm-et",
      question: "Bitcoin Up or Down - September 8, 2PM ET",
      endDate: endIn(70),
      tags: [{ slug: "crypto" }],
    });
    expect(capPriority(hourly, NOW)).toBe(2);
    expect(isShortHorizon(hourly, NOW)).toBe(true);
  });

  it("a série obedece ao cap: com o universo cheio, ela não entra", async () => {
    const db = new FakeDb();
    // 100 top-500 markets fill the cap; two tokens each hits the token cap
    // first, which is the tighter of the two.
    const top500 = Array.from({ length: 100 }, (_, index) =>
      gammaRow({
        conditionId: `0xfill${String(index)}`,
        slug: `fill-${String(index)}`,
        question: `Will Bitcoin close above $${String(index)}k?`,
        clobTokenIds: `["f${String(index)}a","f${String(index)}b"]`,
        endDate: endIn(30),
      }),
    );
    const { fetcher } = seriesFetcher(
      [
        serieEvent("bitcoin-up-or-down-september-8-2026-2pm-et", endIn(70), {
          conditionId: "0xserie",
          tokenIds: '["s1","s2"]',
        }),
      ],
      { top500 },
    );
    const result = await runGammaCycle({
      pool: db,
      fetcher,
      now: () => NOW,
      baseUrl: "https://gamma.test",
    });
    expect(result.universe.length).toBeLessThanOrEqual(MAX_UNIVERSE_MARKETS);
    const tokens = result.universe.flatMap((member) => member.tokenIds);
    expect(tokens.length).toBeLessThanOrEqual(MAX_UNIVERSE_TOKENS);
  });
});

describe("RFC-024 D2 — a consulta é a que funciona", () => {
  it("usa /events?series_id, nunca /markets?series_id", async () => {
    const db = new FakeDb();
    const { fetcher, calls } = seriesFetcher([]);
    await runGammaCycle({
      pool: db,
      fetcher,
      now: () => NOW,
      baseUrl: "https://gamma.test",
    });
    expect(calls).toContain(SERIE_URL);
    // Measured 2026-09-08: /markets?series_id ignores the filter and answers
    // with unrelated markets. Using it would put politics in the fast universe.
    expect(calls.some((url) => url.includes("/markets?series_id="))).toBe(
      false,
    );
  });

  it("o mercado aninhado herda as tags do evento (classifica como crypto)", async () => {
    const db = new FakeDb();
    const { fetcher } = seriesFetcher([
      serieEvent("bitcoin-up-or-down-september-8-2026-2pm-et", endIn(70), {
        conditionId: "0xtags",
        tokenIds: '["t1","t2"]',
      }),
    ]);
    const result = await runGammaCycle({
      pool: db,
      fetcher,
      now: () => NOW,
      baseUrl: "https://gamma.test",
    });
    const member = result.universe.find(
      (entry) => entry.conditionId === "0xtags",
    );
    // Without the graft the nested market has no tags at all and would fall
    // through to the keyword classifier.
    expect(member?.category).toBe("crypto");
  });
});
