import { describe, expect, it } from "vitest";

import type { QueryResult } from "../../../src/database.js";
import {
  AsOfGuard,
  gammaCategoryToModelCategory,
  LeakageError,
  loadBookView,
  loadFeedSamples,
  loadFeedSeries,
  loadMacroCalendar,
  loadMacroReleases,
  loadMarketContexts,
} from "../../../src/polymarket/fundamental/features.js";

const DECISION_TS = new Date("2026-08-19T12:00:00.000Z");

interface Captured {
  readonly text: string;
  readonly params: unknown[];
}

function fakePool(
  responder: (
    text: string,
    params: readonly unknown[],
  ) => Record<string, unknown>[] | null,
): {
  captured: Captured[];
  query: <R extends Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ) => Promise<QueryResult<R>>;
} {
  const captured: Captured[] = [];
  return {
    captured,
    query<R extends Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      captured.push({ text, params: [...(params ?? [])] });
      const rows = responder(text, params ?? []) ?? [];
      return Promise.resolve({
        rows: rows as unknown as R[],
        rowCount: rows.length,
      });
    },
  };
}

describe("AsOfGuard", () => {
  it("refuses any input stamped after the decision instant", () => {
    const guard = new AsOfGuard(DECISION_TS);
    expect(() =>
      guard.record("feed", new Date(DECISION_TS.getTime() + 1), 1),
    ).toThrow(LeakageError);
  });

  it("accepts inputs at or before the decision instant and tracks the newest", () => {
    const guard = new AsOfGuard(DECISION_TS);
    const older = new Date(DECISION_TS.getTime() - 60_000);
    guard.record("book", older, "book");
    guard.record("feed", DECISION_TS, "feed");
    guard.record("no-source-ts", null, "calendar");
    expect(guard.entries()).toHaveLength(3);
    expect(guard.newestSourceTs()?.toISOString()).toBe(
      DECISION_TS.toISOString(),
    );
  });
});

// RFC-010 anti-leakage: every as-of query must bound its data by the decision
// instant. This sweep runs every loader and asserts the property on the SQL
// each one actually emits, so a future loader that forgets the bound fails here.
describe("as-of joins carry no post-decision data", () => {
  it("bounds every feature query by the decision instant", async () => {
    const rows: Record<string, Record<string, unknown>[]> = {
      polymarket_book_snapshots_full: [
        {
          bids_json: [{ price: "0.50", size: "100" }],
          asks_json: [{ price: "0.52", size: "100" }],
          source_ts: new Date(DECISION_TS.getTime() - 5_000),
          received_at: new Date(DECISION_TS.getTime() - 5_000),
        },
      ],
      polymarket_book_deltas: [],
      polymarket_markets: [
        {
          condition_id: "c1",
          question: "Will BTC be above $100,000?",
          slug: "btc-100k",
          category: "crypto",
          clob_token_ids: ["t1", "t2"],
          end_date_iso: "2026-08-20T00:00:00.000Z",
          rules: "resolves per Chainlink",
          tick_size: "0.01",
        },
      ],
      polymarket_rule_versions: [
        {
          condition_id: "c1",
          version: 2,
          resolution_source: "chainlink",
          description: "rule text",
          valid_from: new Date(DECISION_TS.getTime() - 3_600_000),
        },
      ],
      polymarket_param_versions: [
        { condition_id: "c1", version: 3, tick_size: "0.01" },
      ],
      polymarket_resolution_events: [
        { condition_id: "c1", event_type: "disputed" },
      ],
      polymarket_rtds_prices: [
        {
          symbol: "btc/usd",
          feed: "twap30",
          price: "100000",
          source_ts: new Date(DECISION_TS.getTime() - 10_000),
          received_at: new Date(DECISION_TS.getTime() - 10_000),
        },
      ],
      polymarket_rtds_1m: [
        {
          bucket_start: new Date(DECISION_TS.getTime() - 120_000),
          close: "99000",
        },
      ],
      polymarket_macro_calendar: [
        {
          source: "bls",
          event_key: "cpi-2026-09",
          event_name: "CPI",
          scheduled_at: new Date(DECISION_TS.getTime() + 86_400_000),
          version: 1,
          payload_json: { consensus: 3.1 },
          source_ts: new Date(DECISION_TS.getTime() - 86_400_000),
        },
      ],
      polymarket_macro_releases: [
        {
          source: "bls",
          event_key: "cpi-2026-08",
          value: "3.0",
          published_at: new Date(DECISION_TS.getTime() - 86_400_000),
          payload_json: {},
          source_ts: new Date(DECISION_TS.getTime() - 86_400_000),
        },
      ],
    };

    const pool = fakePool((text) => {
      for (const [table, value] of Object.entries(rows)) {
        if (text.includes(table)) {
          return value;
        }
      }
      return [];
    });

    await loadBookView(pool, "t1", DECISION_TS);
    await loadMarketContexts(pool, ["c1"], DECISION_TS, 86_400_000);
    await loadFeedSamples(pool, ["btc/usd"], DECISION_TS, 120_000);
    await loadFeedSeries(pool, "btc/usd", "twap30", DECISION_TS, 60);
    await loadMacroCalendar(pool, DECISION_TS, 2_592_000_000);
    await loadMacroReleases(pool, DECISION_TS);

    expect(pool.captured.length).toBeGreaterThan(6);
    for (const query of pool.captured) {
      // Every parameter that is a Date must be at or before the decision.
      for (const param of query.params) {
        if (param instanceof Date) {
          expect(param.getTime()).toBeLessThanOrEqual(DECISION_TS.getTime());
        }
      }
      // Every query must carry an explicit upper bound on time.
      const bounded =
        /<=\s*\$\d/.test(query.text) || /<\s*\$\d/.test(query.text);
      expect({ bounded, text: query.text.slice(0, 60) }).toEqual({
        bounded: true,
        text: query.text.slice(0, 60),
      });
    }
  });

  it("never selects a resolution field as a feature", async () => {
    const pool = fakePool(() => []);
    await loadMarketContexts(pool, ["c1"], DECISION_TS, 86_400_000);
    const resolutionQuery = pool.captured.find((query) =>
      query.text.includes("polymarket_resolution_events"),
    );
    expect(resolutionQuery).toBeDefined();
    // The only column read from the resolution timeline is the event type, and
    // it is used solely as a veto. closedTime / UMA payloads never enter the
    // feature vector.
    expect(resolutionQuery?.text).toContain("event_type");
    expect(resolutionQuery?.text).not.toContain("payload_json");
    expect(resolutionQuery?.text).not.toContain("closed_time");
  });

  it("excludes a one-minute bucket that is not entirely in the past", async () => {
    const pool = fakePool(() => []);
    await loadFeedSeries(
      pool,
      "btc/usd",
      "twap30",
      new Date("2026-08-19T12:00:30.000Z"),
      60,
    );
    const query = pool.captured[0];
    const upperBound = query?.params[3];
    expect(upperBound).toBeInstanceOf(Date);
    // 12:00:30 -> the newest complete bucket starts at 11:59, because the
    // bucket labelled 12:00 also covers ticks after the decision.
    expect((upperBound as Date).toISOString()).toBe("2026-08-19T11:59:00.000Z");
  });
});

describe("loadBookView", () => {
  it("rebuilds the book from the anchor plus the deltas received by then", async () => {
    const anchorAt = new Date(DECISION_TS.getTime() - 10_000);
    const deltaAt = new Date(DECISION_TS.getTime() - 5_000);
    const pool = fakePool((text) => {
      if (text.includes("polymarket_book_snapshots_full")) {
        return [
          {
            bids_json: [{ price: "0.50", size: "100" }],
            asks_json: [{ price: "0.52", size: "100" }],
            source_ts: anchorAt,
            received_at: anchorAt,
          },
        ];
      }
      if (text.includes("polymarket_book_deltas")) {
        return [
          {
            side: "BUY",
            price: "0.51",
            size: "200",
            source_ts: deltaAt,
            received_at: deltaAt,
          },
          {
            side: "BUY",
            price: "0.50",
            size: "0",
            source_ts: deltaAt,
            received_at: deltaAt,
          },
        ];
      }
      return [];
    });

    const view = await loadBookView(pool, "t1", DECISION_TS);
    expect(view).not.toBeNull();
    expect(view?.bids).toEqual([{ price: "0.51", size: "200" }]);
    // Freshness is measured on the newest venue timestamp actually applied.
    expect(view?.sourceTs?.toISOString()).toBe(deltaAt.toISOString());
  });

  it("returns null when no anchor covers the instant", async () => {
    const pool = fakePool(() => []);
    expect(await loadBookView(pool, "t1", DECISION_TS)).toBeNull();
  });
});

describe("loadFeedSamples", () => {
  it("prefers the resolving TWAP and marks a stale sample", async () => {
    const pool = fakePool(() => [
      {
        symbol: "btc/usd",
        feed: "twap60",
        price: "100010",
        source_ts: new Date(DECISION_TS.getTime() - 1_000),
        received_at: new Date(DECISION_TS.getTime() - 1_000),
      },
      {
        symbol: "btc/usd",
        feed: "twap30",
        price: "100000",
        source_ts: new Date(DECISION_TS.getTime() - 300_000),
        received_at: new Date(DECISION_TS.getTime() - 300_000),
      },
    ]);
    const samples = await loadFeedSamples(
      pool,
      ["btc/usd"],
      DECISION_TS,
      120_000,
    );
    const sample = samples.get("btc/usd");
    // twap30 is the first preference even though twap60 is fresher: the level
    // and the volatility history must come from the same feed.
    expect(sample?.feed).toBe("twap30");
    expect(sample?.stale).toBe(true);
  });
});

describe("gammaCategoryToModelCategory", () => {
  it("maps only the two tracked categories", () => {
    expect(gammaCategoryToModelCategory("crypto")).toBe("crypto_updown");
    expect(gammaCategoryToModelCategory("macro")).toBe("macro_scheduled");
    expect(gammaCategoryToModelCategory("sports")).toBeNull();
    expect(gammaCategoryToModelCategory(null)).toBeNull();
  });
});
