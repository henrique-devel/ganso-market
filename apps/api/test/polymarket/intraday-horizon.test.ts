// RFC-016: the real end INSTANT of a market, and the two defects the lossy
// date-only column caused. Every assertion here was verified failing against
// the previous code; the numbers in the comments are production measurements
// from 2026-08-31.

import { describe, expect, it } from "vitest";

import type { QueryResult, SqlExecutor } from "../../src/database.js";
import {
  parseExtendedMarket,
  type ExtendedMarketRecord,
} from "../../src/polymarket/gamma.js";
import { windowKindsForHorizon } from "../../src/polymarket/paper/features.js";
import { publiclyKnowableInstant } from "../../src/polymarket/fundamental/labels.js";
import {
  SHORT_HORIZON_RESERVED_MARKETS,
  applyMarketEndTsObservation,
  capPriority,
  horizonBucketLabel,
  isShortHorizon,
  runGammaCycle,
  selectUniverse,
} from "../../src/polymarket/registry.js";
import { createUmaStatusPoller } from "../../src/polymarket/samplers.js";
import { FakeDb } from "./fixtures/registry-fake-db.js";

const NOW = new Date("2026-08-31T10:00:00.000Z");

/**
 * The market the 2026-08-28 diagnosis was written against, as Gamma actually
 * returns it: a full instant in `endDate` and a date-only `endDateIso`. The
 * 13-hour gap between the two is the whole subject of this RFC.
 */
function updownRow(overrides: Record<string, unknown> = {}): unknown {
  return {
    conditionId: "0xupdown",
    question: "Bitcoin Up or Down - August 31, 6PM ET",
    slug: "bitcoin-up-or-down-august-31-6pm-et",
    description: "Resolves according to the Chainlink BTC/USD feed at 23:00Z.",
    clobTokenIds: '["tok-up","tok-down"]',
    outcomes: '["Up","Down"]',
    tags: [{ slug: "crypto" }],
    endDate: "2026-08-31T23:00:00Z",
    endDateIso: "2026-08-31",
    active: true,
    closed: false,
    enableOrderBook: true,
    updatedAt: "2026-08-31T09:59:00Z",
    ...overrides,
  };
}

function longRow(
  index: number,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    conditionId: `0xlong-${String(index)}`,
    question: `Will Bitcoin be above $${String(50_000 + index)} on December 31?`,
    slug: `btc-above-${String(index)}`,
    description: "Resolves according to the Chainlink BTC/USD feed.",
    clobTokenIds: `["tok-l-${String(index)}-a","tok-l-${String(index)}-b"]`,
    outcomes: '["Yes","No"]',
    tags: [{ slug: "crypto" }],
    endDate: "2026-12-31T23:59:00Z",
    endDateIso: "2026-12-31",
    active: true,
    closed: false,
    enableOrderBook: true,
    ...overrides,
  };
}

function shortRow(
  index: number,
  minutesAhead: number,
  overrides: Record<string, unknown> = {},
): unknown {
  const end = new Date(NOW.getTime() + minutesAhead * 60_000);
  return {
    conditionId: `0xshort-${String(index)}`,
    question: `Bitcoin Up or Down - hour ${String(index)}`,
    slug: `btc-updown-${String(index)}`,
    description: "Resolves according to the Chainlink BTC/USD feed.",
    clobTokenIds: `["tok-s-${String(index)}-a","tok-s-${String(index)}-b"]`,
    outcomes: '["Up","Down"]',
    tags: [{ slug: "crypto" }],
    endDate: end.toISOString(),
    endDateIso: end.toISOString().slice(0, 10),
    active: true,
    closed: false,
    enableOrderBook: true,
    ...overrides,
  };
}

function parsed(raw: unknown): ExtendedMarketRecord {
  const record = parseExtendedMarket(raw);
  if (record === null) {
    throw new Error("fixture must parse");
  }
  return record;
}

// ---------------------------------------------------------------------------
// Defect A — the label store's knowable instant
// ---------------------------------------------------------------------------

describe("RFC-016 defect A: the publicly knowable instant", () => {
  it("is the market's real end, not the midnight of its end date", () => {
    // Production, 2026-08-31: 1,572 of 1,670 labels (94%) carried
    // publicly_knowable_ts at exactly 00:00:00, a median of 16 h before the
    // market's real end, because loadMarketRows read the date-only column and
    // publiclyKnowableInstant takes the MINIMUM of its candidates.
    const dateOnly = publiclyKnowableInstant({
      endDate: new Date("2026-08-31T00:00:00.000Z"),
      proposedAt: new Date("2026-08-31T23:20:00.000Z"),
      resolvedAt: new Date("2026-09-01T01:30:00.000Z"),
    });
    const realInstant = publiclyKnowableInstant({
      endDate: new Date("2026-08-31T23:00:00.000Z"),
      proposedAt: new Date("2026-08-31T23:20:00.000Z"),
      resolvedAt: new Date("2026-09-01T01:30:00.000Z"),
    });

    expect(dateOnly?.toISOString()).toBe("2026-08-31T00:00:00.000Z");
    expect(realInstant?.toISOString()).toBe("2026-08-31T23:00:00.000Z");
    // Twenty-three hours of estimates that the date-only value declared
    // "already knowable" and calibration therefore discarded.
    const lostHours =
      ((realInstant?.getTime() ?? 0) - (dateOnly?.getTime() ?? 0)) / 3_600_000;
    expect(lostHours).toBe(23);
  });

  it("keeps the estimates of the last hour inside the scoring window", () => {
    // calibration.ts filters evidence with `decision_ts < publicly_knowable_ts`.
    // Production, 2026-08-31: 0 of 8,063 estimates made in a market's last hour
    // of life were scoreable, and 36,212 of 74,412 MODEL estimates overall.
    const lastHourDecision = new Date("2026-08-31T22:30:00.000Z");
    const scoreable = (knowable: Date | null): boolean =>
      knowable !== null && lastHourDecision.getTime() < knowable.getTime();

    const beforeFix = publiclyKnowableInstant({
      endDate: new Date("2026-08-31T00:00:00.000Z"),
      proposedAt: null,
      resolvedAt: null,
    });
    const afterFix = publiclyKnowableInstant({
      endDate: new Date("2026-08-31T23:00:00.000Z"),
      proposedAt: null,
      resolvedAt: null,
    });

    expect(scoreable(beforeFix)).toBe(false);
    expect(scoreable(afterFix)).toBe(true);
  });

  it("still lets an early UMA proposal win over the end instant", () => {
    // The instant is the EARLIEST honest upper bound, and a proposal before
    // the end date means the world already knew. Making end_ts precise must
    // not turn that rule off.
    const knowable = publiclyKnowableInstant({
      endDate: new Date("2026-08-31T23:00:00.000Z"),
      proposedAt: new Date("2026-08-31T14:00:00.000Z"),
      resolvedAt: null,
    });
    expect(knowable?.toISOString()).toBe("2026-08-31T14:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Defect B — the negative horizon bought the finest windows
// ---------------------------------------------------------------------------

describe("RFC-016 defect B: window cadence for an elapsed horizon", () => {
  it("gives the coarse cadence to a negative horizon, not the finest", () => {
    // The old test was `msToEnd <= 60 * 60_000`, which every negative number
    // satisfies. With the date-only end date upstream, a market closing at
    // 23:00Z reported −10 h at 10:00Z and got ["1s","10s","1m"] all day.
    // Production, 2026-08-31: 63,951 of 84,772 10s windows in six hours
    // (75%) belonged to markets whose real horizon exceeded 6 h.
    expect(windowKindsForHorizon(-10 * 3_600_000)).toEqual(["1m"]);
    expect(windowKindsForHorizon(-1)).toEqual(["1m"]);
    expect(windowKindsForHorizon(null)).toEqual(["1m"]);
  });

  it("still spends the fine cadence where a decision can happen", () => {
    expect(windowKindsForHorizon(0)).toEqual(["1s", "10s", "1m"]);
    expect(windowKindsForHorizon(30 * 60_000)).toEqual(["1s", "10s", "1m"]);
    expect(windowKindsForHorizon(3 * 3_600_000)).toEqual(["10s", "1m"]);
    expect(windowKindsForHorizon(13 * 3_600_000)).toEqual(["1m"]);
  });

  it("is defended twice over: the right instant, and a safe elapsed horizon", () => {
    // The defect needed both halves to bite: the query handed back a date-only
    // end date, AND the classifier rewarded the resulting negative number with
    // the finest cadence. Each fix alone closes it, so both are asserted.
    const now = new Date("2026-08-31T10:00:00.000Z");
    const realEnd = new Date("2026-08-31T23:00:00.000Z");
    const dateOnlyEnd = new Date("2026-08-31T00:00:00.000Z");

    // Half one: the horizon the query now yields is the honest +13 h.
    const realHorizon = realEnd.getTime() - now.getTime();
    expect(realHorizon).toBe(13 * 3_600_000);
    expect(windowKindsForHorizon(realHorizon)).toEqual(["1m"]);

    // Half two: even fed the old date-only value, the classifier no longer
    // hands out ["1s","10s","1m"] for a horizon that has already elapsed.
    const staleHorizon = dateOnlyEnd.getTime() - now.getTime();
    expect(staleHorizon).toBeLessThan(0);
    expect(windowKindsForHorizon(staleHorizon)).toEqual(["1m"]);
  });
});

// ---------------------------------------------------------------------------
// Capture at both Gamma call sites (the lesson of PR #49)
// ---------------------------------------------------------------------------

describe("RFC-016 capture: the two Gamma call sites agree", () => {
  it("records the same end_ts from the registry cycle and the pending sweep", async () => {
    // PR #49: the registry and the pending sweep query Gamma with different
    // parameters, and the asymmetry between them was the root cause of the
    // category bug. Both of them capture the instant, from the same payload,
    // and must land on the same value.
    const registryDb = new FakeDb();
    await runGammaCycle({
      pool: registryDb,
      now: () => NOW,
      fetcher: (url: string) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(url.includes("offset=0") ? [updownRow()] : []),
        }),
    });
    const fromRegistry = registryDb.markets.find(
      (row) => row.condition_id === "0xupdown",
    );

    // The sweep's own path: `pollPendingOnce` re-observes markets that already
    // LEFT the universe — the population the registry cycle never sees again.
    // It does not own the registry row, so the row exists first and the narrow
    // write touches only end_ts.
    const sweepRow: Record<string, unknown> = {
      condition_id: "0xupdown",
      end_ts: null,
    };
    const sweepPool: SqlExecutor = {
      query<R extends Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ): Promise<QueryResult<R>> {
        if (text.includes("WITH membership AS")) {
          return Promise.resolve({
            rows: [{ condition_id: "0xupdown" }] as unknown as R[],
            rowCount: 1,
          });
        }
        if (text.includes("SET end_ts") && params?.[1] != null) {
          sweepRow.end_ts = params[1];
        }
        return Promise.resolve({ rows: [] as R[], rowCount: 0 });
      },
    };
    const poller = createUmaStatusPoller({
      pool: sweepPool,
      clock: () => NOW.getTime(),
      fetcher: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([updownRow()]),
        }) as never,
    });
    await poller.pollPendingOnce();
    const fromSweep = sweepRow;

    expect((fromRegistry?.end_ts as Date | null)?.toISOString()).toBe(
      "2026-08-31T23:00:00.000Z",
    );
    expect((fromSweep?.end_ts as Date | null)?.toISOString()).toBe(
      "2026-08-31T23:00:00.000Z",
    );
    expect((fromRegistry?.end_ts as Date).getTime()).toBe(
      (fromSweep?.end_ts as Date).getTime(),
    );
  });

  it("never erases a known end_ts when the payload omits endDate", async () => {
    // Null means "not observed", never "this market has no end" — the same
    // rule categoryToRecord applies to categories, and the reason a Gamma
    // response missing a field cannot undo a fact we already recorded.
    const known = new Date("2026-08-31T23:00:00.000Z");
    const rows: Record<string, unknown>[] = [
      { condition_id: "0xupdown", end_ts: known },
    ];
    const executor: SqlExecutor = {
      query<R extends Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ): Promise<QueryResult<R>> {
        if (text.includes("SET end_ts")) {
          const target = rows.find((row) => row.condition_id === params?.[0]);
          if (target !== undefined && params?.[1] != null) {
            target.end_ts = params[1];
          }
        }
        return Promise.resolve({ rows: [] as R[], rowCount: 0 });
      },
    };

    await applyMarketEndTsObservation(executor, "0xupdown", null, NOW);

    expect((rows[0]?.end_ts as Date).getTime()).toBe(known.getTime());
  });

  it("does not create a registry row from the sweep", async () => {
    // The narrow write records a fact about a row; it does not invent one.
    // A market the registry has never seen is a no-op, not an insert.
    const seen: string[] = [];
    const executor: SqlExecutor = {
      query<R extends Record<string, unknown>>(
        text: string,
      ): Promise<QueryResult<R>> {
        seen.push(text);
        return Promise.resolve({ rows: [] as R[], rowCount: 0 });
      },
    };

    await applyMarketEndTsObservation(
      executor,
      "0xunknown",
      new Date("2026-08-31T23:00:00.000Z"),
      NOW,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("UPDATE polymarket_markets");
    expect(seen.join(" ")).not.toContain("INSERT INTO polymarket_markets");
  });
});

// ---------------------------------------------------------------------------
// Horizon-aware cap priority and the reserved block
// ---------------------------------------------------------------------------

describe("RFC-016 cap: short horizon stops being the first thing dropped", () => {
  it("lifts a short series inside the window and leaves a distant one down", () => {
    // SHORT_SERIES_PATTERN is a name test, not a clock: the same question
    // matches it three weeks before the market is worth anything. The horizon
    // is the clock.
    const soon = parsed(shortRow(1, 45));
    const distant = parsed(
      shortRow(2, 45, { endDate: "2026-12-31T23:00:00Z" }),
    );

    expect(capPriority(soon, NOW)).toBe(2);
    expect(capPriority(distant, NOW)).toBe(3);
    expect(isShortHorizon(soon, NOW)).toBe(true);
    expect(isShortHorizon(distant, NOW)).toBe(false);
  });

  it("keeps scheduled macro at priority 1", () => {
    const macro = parsed({
      ...(updownRow() as Record<string, unknown>),
      conditionId: "0xmacro",
      question: "Will the Fed cut rates in September?",
      slug: "fed-september",
      tags: [{ slug: "fed" }],
      endDate: "2026-09-16T00:00:00Z",
      endDateIso: "2026-09-16",
    });
    expect(capPriority(macro, NOW)).toBe(1);
  });

  it("reserves exactly the short block when short markets are plentiful", () => {
    const longs = Array.from({ length: 100 }, (_, index) =>
      parsed(longRow(index)),
    );
    const shorts = Array.from({ length: 30 }, (_, index) =>
      parsed(shortRow(index, 30 + index)),
    );
    // Longs first in the fetch order, exactly the case where the old code
    // dropped every short market: without the reserve the 100-market cap is
    // full before a single one is considered.
    const selection = selectUniverse([...longs, ...shorts], NOW, {
      maxMarkets: 100,
      maxTokens: 200,
    });

    const shortsSelected = selection.selected.filter((record) =>
      isShortHorizon(record, NOW),
    );
    expect(selection.selected).toHaveLength(100);
    expect(shortsSelected).toHaveLength(SHORT_HORIZON_RESERVED_MARKETS);
    // Soonest first inside the reserve: "resolves next" beats "traded most".
    expect(shortsSelected[0]?.conditionId).toBe("0xshort-0");
  });

  it("gives unused reserved slots back to the general queue", () => {
    // Opportunistic, never wasteful: five short markets must not cost the
    // universe twenty empty slots.
    const longs = Array.from({ length: 100 }, (_, index) =>
      parsed(longRow(index)),
    );
    const shorts = Array.from({ length: 5 }, (_, index) =>
      parsed(shortRow(index, 30 + index)),
    );
    const selection = selectUniverse([...longs, ...shorts], NOW, {
      maxMarkets: 100,
      maxTokens: 200,
    });

    expect(selection.selected).toHaveLength(100);
    expect(
      selection.selected.filter((record) => isShortHorizon(record, NOW)),
    ).toHaveLength(5);
    // 95 of the longs, and no duplicates.
    const ids = new Set(selection.selected.map((r) => r.conditionId));
    expect(ids.size).toBe(100);
  });

  it("rejects a capped market exactly once", () => {
    const longs = Array.from({ length: 100 }, (_, index) =>
      parsed(longRow(index)),
    );
    const shorts = Array.from({ length: 30 }, (_, index) =>
      parsed(shortRow(index, 30 + index)),
    );
    const selection = selectUniverse([...longs, ...shorts], NOW, {
      maxMarkets: 100,
      maxTokens: 200,
    });

    const rejectedIds = selection.rejectedCap.map((r) => r.conditionId);
    expect(new Set(rejectedIds).size).toBe(rejectedIds.length);
    expect(selection.selected.length + rejectedIds.length).toBe(130);
  });

  it("labels the horizon bucket on the membership log", () => {
    expect(horizonBucketLabel(parsed(shortRow(1, 30)), NOW)).toBe("lt_1h");
    expect(horizonBucketLabel(parsed(shortRow(2, 200)), NOW)).toBe("1h_6h");
    expect(horizonBucketLabel(parsed(longRow(1)), NOW)).toBe("gt_7d");
    expect(
      horizonBucketLabel(
        parsed(shortRow(3, 30, { endDate: "2026-08-30T10:00:00Z" })),
        NOW,
      ),
    ).toBe("past");
  });
});
