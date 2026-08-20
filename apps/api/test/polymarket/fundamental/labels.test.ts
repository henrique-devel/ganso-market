import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryResult } from "../../../src/database.js";
import {
  isDegenerate,
  loadLabels,
  parseOutcomeLabel,
  publiclyKnowableInstant,
  syncLabels,
} from "../../../src/polymarket/fundamental/labels.js";

type Row = Record<string, unknown>;

const NOW = new Date("2026-08-19T12:00:00Z");

function tsKey(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function asDate(value: unknown): Date | null {
  return value instanceof Date ? value : null;
}

/** The `$n` parameter a generated clause refers to, or undefined when absent. */
function paramFor(
  text: string,
  pattern: RegExp,
  params: readonly unknown[],
): unknown {
  const position = pattern.exec(text)?.[1];
  return position === undefined ? undefined : params[Number(position) - 1];
}

/**
 * In-memory stand-in for the three tables the label store touches. It
 * dispatches on the SQL the module emits and mimics the PostgreSQL semantics
 * that matter here: COALESCE(source_ts, received_at) ordering, ON CONFLICT
 * DO UPDATE with an IS DISTINCT FROM guard, and `xmax = 0` in RETURNING.
 */
class FakeLabelDb {
  public readonly markets: Row[] = [];
  public readonly events: Row[] = [];
  public readonly labels = new Map<string, Row>();
  /** Counts DO UPDATE executions, i.e. real row churn. */
  public updates = 0;
  public failNextQueries = false;
  #nextEventId = 1;

  public addMarket(
    conditionId: string,
    category: string | null,
    tokenIds: readonly string[],
    endDateIso: string | null,
  ): void {
    this.markets.push({
      condition_id: conditionId,
      category,
      clob_token_ids: [...tokenIds],
      end_date_iso: endDateIso,
    });
  }

  public addEvent(
    conditionId: string,
    eventType: string,
    payload: unknown,
    sourceTs: Date | null,
    receivedAt: Date,
  ): void {
    this.events.push({
      resolution_event_id: this.#nextEventId++,
      condition_id: conditionId,
      event_type: eventType,
      payload_json: payload,
      source_ts: sourceTs,
      received_at: receivedAt,
    });
  }

  public query<R extends Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    if (this.failNextQueries) {
      return Promise.reject(new Error("simulated database failure"));
    }
    const rows = this.dispatch(text, [...(params ?? [])]);
    return Promise.resolve({
      rows: rows as unknown as R[],
      rowCount: rows.length,
    });
  }

  private dispatch(text: string, params: unknown[]): Row[] {
    if (text.includes("FROM polymarket_resolution_events")) {
      return this.selectEvents(params);
    }
    if (text.includes("FROM polymarket_markets")) {
      const ids = new Set(
        Array.isArray(params[0]) ? (params[0] as unknown[]).map(String) : [],
      );
      return this.markets.filter((row) => ids.has(String(row.condition_id)));
    }
    if (text.includes("INSERT INTO fundamental_labels")) {
      return this.upsertLabel(text, params);
    }
    if (text.includes("FROM fundamental_labels")) {
      return this.selectLabels(text, params);
    }
    throw new Error(`FakeLabelDb: unexpected SQL: ${text}`);
  }

  private selectEvents(params: unknown[]): Row[] {
    const types = new Set(
      Array.isArray(params[0]) ? (params[0] as unknown[]).map(String) : [],
    );
    const since = asDate(params[1]);
    const effective = (row: Row): number => {
      const value = asDate(row.source_ts) ?? asDate(row.received_at);
      return value === null ? 0 : value.getTime();
    };
    return this.events
      .filter((row) => types.has(String(row.event_type)))
      .filter((row) => since === null || effective(row) >= since.getTime())
      .sort(
        (left, right) =>
          String(left.condition_id).localeCompare(String(right.condition_id)) ||
          effective(left) - effective(right) ||
          Number(left.resolution_event_id) - Number(right.resolution_event_id),
      );
  }

  private upsertLabel(text: string, params: unknown[]): Row[] {
    if (!text.includes("ON CONFLICT (token_id) DO UPDATE")) {
      throw new Error("FakeLabelDb: the label upsert must be idempotent");
    }
    const tokenId = String(params[0]);
    const next: Row = {
      token_id: tokenId,
      condition_id: params[1],
      category: params[2],
      label: params[3],
      publicly_knowable_ts: params[4],
      onchain_resolution_ts: params[5],
      disputed: params[6],
      is_final: true,
      provenance: "resolution_events",
      payload_json: JSON.parse(String(params[7])) as unknown,
      source_ts: params[8],
      received_at: params[9],
      updated_at: params[9],
    };
    const existing = this.labels.get(tokenId);
    if (existing === undefined) {
      this.labels.set(tokenId, next);
      return [{ inserted: true }];
    }
    // Only a DO UPDATE carrying an IS DISTINCT FROM guard can be a no-op:
    // without the guard PostgreSQL rewrites the row on every run, and this
    // fake must reproduce that churn instead of hiding it.
    const guarded = text.includes("IS DISTINCT FROM EXCLUDED.");
    if (
      guarded &&
      FakeLabelDb.comparable(existing) === FakeLabelDb.comparable(next)
    ) {
      return [];
    }
    this.updates += 1;
    // received_at keeps the first-seen local clock; everything else is replaced.
    this.labels.set(tokenId, { ...next, received_at: existing.received_at });
    return [{ inserted: false }];
  }

  private static comparable(row: Row): string {
    return JSON.stringify({
      condition_id: row.condition_id,
      category: row.category,
      label: row.label,
      publicly_knowable_ts: tsKey(row.publicly_knowable_ts),
      onchain_resolution_ts: tsKey(row.onchain_resolution_ts),
      disputed: row.disputed,
      is_final: row.is_final,
      provenance: row.provenance,
      payload_json: row.payload_json,
      source_ts: tsKey(row.source_ts),
    });
  }

  private selectLabels(text: string, params: unknown[]): Row[] {
    let rows = [...this.labels.values()].filter((row) => row.is_final === true);
    const category = paramFor(text, /category = \$(\d+)/, params);
    if (category !== undefined) {
      rows = rows.filter((row) => row.category === category);
    }
    const from = asDate(
      paramFor(text, /publicly_knowable_ts >= \$(\d+)/, params),
    );
    if (from !== null) {
      rows = rows.filter((row) => {
        const at = asDate(row.publicly_knowable_ts);
        return at !== null && at.getTime() >= from.getTime();
      });
    }
    const to = asDate(paramFor(text, /publicly_knowable_ts < \$(\d+)/, params));
    if (to !== null) {
      rows = rows.filter((row) => {
        const at = asDate(row.publicly_knowable_ts);
        return at !== null && at.getTime() < to.getTime();
      });
    }
    if (text.includes("disputed = FALSE")) {
      rows = rows.filter((row) => row.disputed !== true);
    }
    return rows.sort((left, right) => {
      const leftTs = asDate(left.publicly_knowable_ts);
      const rightTs = asDate(right.publicly_knowable_ts);
      const leftKey =
        leftTs === null ? Number.POSITIVE_INFINITY : leftTs.getTime();
      const rightKey =
        rightTs === null ? Number.POSITIVE_INFINITY : rightTs.getTime();
      return (
        leftKey - rightKey ||
        String(left.token_id).localeCompare(String(right.token_id))
      );
    });
  }
}

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

function stderrLines(): string[] {
  return stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
}

/**
 * Three resolved markets covering every label the RFC allows: a YES win
 * (WS `market_resolved` with winning_asset_id), a UMA 50/50 (payouts [1, 1])
 * and an outcome-price vector.
 */
function seedResolvedMarkets(db: FakeLabelDb): void {
  db.addMarket("cond-yes", "crypto", ["tok-yes-0", "tok-yes-1"], null);
  db.addEvent(
    "cond-yes",
    "proposed",
    { from: null, to: "proposed" },
    new Date("2026-08-01T12:05:00Z"),
    new Date("2026-08-01T12:06:00Z"),
  );
  db.addEvent(
    "cond-yes",
    "market_resolved",
    { event_type: "market_resolved", winning_asset_id: "tok-yes-0" },
    new Date("2026-08-02T00:00:00Z"),
    new Date("2026-08-02T00:00:30Z"),
  );

  db.addMarket("cond-half", "macro", ["tok-half-0", "tok-half-1"], null);
  db.addEvent(
    "cond-half",
    "proposed",
    { to: "proposed" },
    new Date("2026-08-03T09:00:00Z"),
    new Date("2026-08-03T09:01:00Z"),
  );
  db.addEvent(
    "cond-half",
    "resolved",
    { payouts: [1, 1] },
    new Date("2026-08-04T00:00:00Z"),
    new Date("2026-08-04T00:00:10Z"),
  );

  db.addMarket(
    "cond-prices",
    "weather",
    ["tok-prices-0", "tok-prices-1"],
    "2026-08-05T00:00:00Z",
  );
  db.addEvent(
    "cond-prices",
    "resolved",
    { outcomePrices: '["0", "1"]' },
    new Date("2026-08-06T00:00:00Z"),
    new Date("2026-08-06T00:00:05Z"),
  );
}

describe("parseOutcomeLabel", () => {
  it("reads 1, 0 and the UMA 50/50 out of CTF payout numerators", () => {
    expect(parseOutcomeLabel({ payoutNumerators: [1, 0] }, 0)).toBe("1");
    expect(parseOutcomeLabel({ payoutNumerators: [1, 0] }, 1)).toBe("0");
    expect(parseOutcomeLabel({ payouts: ["0", "1"] }, 0)).toBe("0");
    expect(parseOutcomeLabel({ payouts: ["0", "1"] }, 1)).toBe("1");
    // [1, 1] is a real first-class label, not a parse failure.
    expect(parseOutcomeLabel({ payout_numerators: [1, 1] }, 0)).toBe("0.5");
    expect(parseOutcomeLabel({ payout_numerators: [1, 1] }, 1)).toBe("0.5");
  });

  it("reads settled outcome prices, including Gamma's JSON-encoded array", () => {
    expect(parseOutcomeLabel({ outcomePrices: ["1", "0"] }, 0)).toBe("1");
    expect(parseOutcomeLabel({ outcome_prices: '["0", "1"]' }, 1)).toBe("1");
    expect(parseOutcomeLabel({ outcomePrices: ["0.5", "0.5"] }, 0)).toBe("0.5");
  });

  it("reads a winning outcome index and the nested `raw` shape", () => {
    expect(parseOutcomeLabel({ winningOutcomeIndex: 1 }, 1)).toBe("1");
    expect(parseOutcomeLabel({ winning_outcome_index: "1" }, 0)).toBe("0");
    expect(parseOutcomeLabel({ raw: { payouts: [0, 1] } }, 1)).toBe("1");
  });

  it("refuses anything that does not decide the outcome", () => {
    // A live price vector is a market opinion, never a settlement.
    expect(parseOutcomeLabel({ outcomePrices: ["0.7", "0.3"] }, 0)).toBeNull();
    // A share the RFC does not define as a label stays undecided.
    expect(parseOutcomeLabel({ payouts: [2, 1] }, 0)).toBeNull();
    // The UMA status poller's own payload carries a transition, no outcome.
    expect(
      parseOutcomeLabel(
        { from: "proposed", to: "resolved", raw: { resolved: true } },
        0,
      ),
    ).toBeNull();
    expect(parseOutcomeLabel({ payouts: [1, 0] }, 2)).toBeNull();
    expect(parseOutcomeLabel({ payouts: [1, 0] }, -1)).toBeNull();
    expect(parseOutcomeLabel(null, 0)).toBeNull();
    expect(parseOutcomeLabel("resolved", 0)).toBeNull();
  });
});

describe("publiclyKnowableInstant", () => {
  const endDate = new Date("2026-08-01T12:00:00Z");
  const proposedAt = new Date("2026-08-01T18:00:00Z");
  // The on-chain resolution lands after the liveness window, but the test
  // deliberately places it FIRST: choosing it must be impossible, not merely
  // unlikely.
  const resolvedAt = new Date("2026-07-01T00:00:00Z");

  it("takes the earliest knowable instant and never the on-chain one", () => {
    expect(
      publiclyKnowableInstant({ endDate, proposedAt, resolvedAt }),
    ).toEqual(endDate);
    expect(
      publiclyKnowableInstant({
        endDate: new Date("2026-08-02T00:00:00Z"),
        proposedAt,
        resolvedAt,
      }),
    ).toEqual(proposedAt);
    expect(
      publiclyKnowableInstant({ endDate: null, proposedAt, resolvedAt }),
    ).toEqual(proposedAt);
    expect(
      publiclyKnowableInstant({ endDate, proposedAt: null, resolvedAt }),
    ).toEqual(endDate);
  });

  it("returns null when nothing but the on-chain instant is known", () => {
    expect(
      publiclyKnowableInstant({
        endDate: null,
        proposedAt: null,
        resolvedAt: new Date("2026-08-09T00:00:00Z"),
      }),
    ).toBeNull();
    expect(
      publiclyKnowableInstant({
        endDate: new Date(Number.NaN),
        proposedAt: null,
        resolvedAt: null,
      }),
    ).toBeNull();
  });
});

describe("isDegenerate", () => {
  it("treats exactly 0.01 and exactly 0.99 as non-degenerate", () => {
    expect(isDegenerate(0.01)).toBe(false);
    expect(isDegenerate(0.99)).toBe(false);
    expect(isDegenerate(0.5)).toBe(false);
  });

  it("excludes anything strictly outside the boundaries", () => {
    expect(isDegenerate(0.009999)).toBe(true);
    expect(isDegenerate(0.990001)).toBe(true);
    expect(isDegenerate(0)).toBe(true);
    expect(isDegenerate(1)).toBe(true);
    expect(isDegenerate(Number.NaN)).toBe(true);
  });
});

describe("syncLabels", () => {
  it("stores labels 1, 0, 0.5 with the honest knowable instant", async () => {
    const db = new FakeLabelDb();
    seedResolvedMarkets(db);
    const report = await syncLabels({ pool: db, clock: () => NOW });

    expect(report).toEqual({
      inserted: 6,
      updated: 0,
      skippedNotFinal: 0,
      skippedUnparsable: 0,
    });
    expect(db.labels.get("tok-yes-0")?.label).toBe("1");
    expect(db.labels.get("tok-yes-1")?.label).toBe("0");
    expect(db.labels.get("tok-half-0")?.label).toBe("0.5");
    expect(db.labels.get("tok-half-1")?.label).toBe("0.5");
    expect(db.labels.get("tok-prices-0")?.label).toBe("0");
    expect(db.labels.get("tok-prices-1")?.label).toBe("1");

    // Gamma categories map to the model category the gate counts on; a
    // category no model owns keeps its own name.
    expect(db.labels.get("tok-yes-0")?.category).toBe("crypto_updown");
    expect(db.labels.get("tok-half-0")?.category).toBe("macro_scheduled");
    expect(db.labels.get("tok-prices-0")?.category).toBe("weather");

    // No end date: the earliest UMA proposal is the knowable instant, and the
    // on-chain resolution is recorded apart from it.
    expect(db.labels.get("tok-yes-0")?.publicly_knowable_ts).toEqual(
      new Date("2026-08-01T12:05:00Z"),
    );
    expect(db.labels.get("tok-yes-0")?.onchain_resolution_ts).toEqual(
      new Date("2026-08-02T00:00:00Z"),
    );
    // End date earlier than the resolution: the end date wins.
    expect(db.labels.get("tok-prices-0")?.publicly_knowable_ts).toEqual(
      new Date("2026-08-05T00:00:00Z"),
    );
    expect(db.labels.get("tok-prices-0")?.disputed).toBe(false);
    expect(db.labels.get("tok-prices-0")?.provenance).toBe("resolution_events");
  });

  it("skips a disputed market until the final resolution, then labels it from that resolution only", async () => {
    const db = new FakeLabelDb();
    db.addMarket("cond-disp", "crypto", ["tok-d-0", "tok-d-1"], null);
    db.addEvent(
      "cond-disp",
      "proposed",
      { to: "proposed" },
      new Date("2026-08-05T01:00:00Z"),
      new Date("2026-08-05T01:00:10Z"),
    );
    // The challenged resolution asserts YES...
    db.addEvent(
      "cond-disp",
      "resolved",
      { payouts: [1, 0] },
      new Date("2026-08-05T02:00:00Z"),
      new Date("2026-08-05T02:00:10Z"),
    );
    db.addEvent(
      "cond-disp",
      "disputed",
      { to: "disputed" },
      new Date("2026-08-06T00:00:00Z"),
      new Date("2026-08-06T00:00:10Z"),
    );

    const pending = await syncLabels({ pool: db, clock: () => NOW });
    expect(pending).toEqual({
      inserted: 0,
      updated: 0,
      skippedNotFinal: 2,
      skippedUnparsable: 0,
    });
    expect(db.labels.size).toBe(0);
    expect(
      stderrLines().some((line) => line.includes("LABEL_RESOLUTION_NOT_FINAL")),
    ).toBe(true);

    // ...and the final resolution reverses it.
    db.addEvent(
      "cond-disp",
      "resolved",
      { payouts: [0, 1] },
      new Date("2026-08-07T00:00:00Z"),
      new Date("2026-08-07T00:00:10Z"),
    );
    const settled = await syncLabels({ pool: db, clock: () => NOW });
    expect(settled).toEqual({
      inserted: 2,
      updated: 0,
      skippedNotFinal: 0,
      skippedUnparsable: 0,
    });
    // The pre-dispute payout [1, 0] must not survive anywhere.
    expect(db.labels.get("tok-d-0")?.label).toBe("0");
    expect(db.labels.get("tok-d-1")?.label).toBe("1");
    // The row is flagged, not dropped: headline metrics exclude it, the
    // separate dispute analysis reads it back.
    expect(db.labels.get("tok-d-0")?.disputed).toBe(true);
    expect(db.labels.get("tok-d-0")?.onchain_resolution_ts).toEqual(
      new Date("2026-08-07T00:00:00Z"),
    );
  });

  it("is idempotent: a second run inserts nothing and rewrites nothing", async () => {
    const db = new FakeLabelDb();
    seedResolvedMarkets(db);
    const first = await syncLabels({ pool: db, clock: () => NOW });
    expect(first.inserted).toBe(6);
    const firstUpdatedAt = db.labels.get("tok-yes-0")?.updated_at;

    const later = new Date(NOW.getTime() + 3_600_000);
    const second = await syncLabels({ pool: db, clock: () => later });
    expect(second).toEqual({
      inserted: 0,
      updated: 0,
      skippedNotFinal: 0,
      skippedUnparsable: 0,
    });
    expect(db.labels.size).toBe(6);
    expect(db.updates).toBe(0);
    // The clock moved but no row was touched, so updated_at did not churn.
    expect(db.labels.get("tok-yes-0")?.updated_at).toEqual(firstUpdatedAt);
  });

  it("still updates the row when the outcome itself changed", async () => {
    const db = new FakeLabelDb();
    db.addMarket("cond-flip", "crypto", ["tok-f-0", "tok-f-1"], null);
    db.addEvent(
      "cond-flip",
      "resolved",
      { payouts: [1, 0] },
      new Date("2026-08-05T02:00:00Z"),
      new Date("2026-08-05T02:00:10Z"),
    );
    await syncLabels({ pool: db, clock: () => NOW });
    expect(db.labels.get("tok-f-0")?.label).toBe("1");

    db.addEvent(
      "cond-flip",
      "resolved",
      { payouts: [1, 1] },
      new Date("2026-08-05T03:00:00Z"),
      new Date("2026-08-05T03:00:10Z"),
    );
    const report = await syncLabels({ pool: db, clock: () => NOW });
    expect(report.inserted).toBe(0);
    expect(report.updated).toBe(2);
    expect(db.labels.get("tok-f-0")?.label).toBe("0.5");
  });

  it("counts and logs a final resolution whose payload decides nothing", async () => {
    const db = new FakeLabelDb();
    db.addMarket("cond-opaque", "crypto", ["tok-o-0", "tok-o-1"], null);
    // Exactly what the UMA status poller records: a status transition with no
    // outcome anywhere in it.
    db.addEvent(
      "cond-opaque",
      "resolved",
      {
        from: "proposed",
        to: "resolved",
        raw: { umaResolutionStatus: "resolved", closed: true, resolved: true },
      },
      null,
      new Date("2026-08-08T00:00:00Z"),
    );
    const report = await syncLabels({ pool: db, clock: () => NOW });
    expect(report).toEqual({
      inserted: 0,
      updated: 0,
      skippedNotFinal: 0,
      skippedUnparsable: 2,
    });
    expect(db.labels.size).toBe(0);
    expect(
      stderrLines().some((line) => line.includes("LABEL_OUTCOME_UNPARSABLE")),
    ).toBe(true);
  });

  it("uses when we OBSERVED the proposal when the venue gave no clock", async () => {
    const db = new FakeLabelDb();
    db.addMarket("cond-blind", "crypto", ["tok-b-0"], null);
    // No end date, and RFC-007's UMA poller stores the transition with a NULL
    // source_ts (it has no emitter clock to copy). The instant we RECEIVED the
    // proposal is still a valid upper bound on when the outcome became
    // knowable — and it is far earlier than the on-chain resolution, which may
    // never be used for this.
    db.addEvent(
      "cond-blind",
      "proposed",
      { to: "proposed" },
      null,
      new Date("2026-08-08T00:00:00Z"),
    );
    db.addEvent(
      "cond-blind",
      "resolved",
      { payouts: [1, 0] },
      new Date("2026-08-09T00:00:00Z"),
      new Date("2026-08-09T00:00:10Z"),
    );
    const report = await syncLabels({ pool: db, clock: () => NOW });

    expect(report.inserted).toBe(1);
    expect(db.labels.get("tok-b-0")?.publicly_knowable_ts).toEqual(
      new Date("2026-08-08T00:00:00Z"),
    );
    expect(db.labels.get("tok-b-0")?.onchain_resolution_ts).toEqual(
      new Date("2026-08-09T00:00:00Z"),
    );
  });

  it("stores a null knowable instant when nothing honest is available", async () => {
    const db = new FakeLabelDb();
    db.addMarket("cond-dark", "crypto", ["tok-d-0"], null);
    // No end date and no proposal at all: only the on-chain resolution exists,
    // and that one may never index a metric.
    db.addEvent(
      "cond-dark",
      "resolved",
      { payouts: [1, 0] },
      new Date("2026-08-09T00:00:00Z"),
      new Date("2026-08-09T00:00:10Z"),
    );
    const report = await syncLabels({ pool: db, clock: () => NOW });

    expect(report.inserted).toBe(1);
    expect(db.labels.get("tok-d-0")?.publicly_knowable_ts).toBeNull();
    expect(
      stderrLines().some((line) => line.includes("LABEL_KNOWABLE_TS_UNKNOWN")),
    ).toBe(true);
  });

  it("ignores resolutions older than the lookback window", async () => {
    const db = new FakeLabelDb();
    seedResolvedMarkets(db);
    const report = await syncLabels({
      pool: db,
      clock: () => NOW,
      lookbackMs: 24 * 3_600_000,
    });
    expect(report).toEqual({
      inserted: 0,
      updated: 0,
      skippedNotFinal: 0,
      skippedUnparsable: 0,
    });
    expect(db.labels.size).toBe(0);
  });

  it("never throws when the database fails", async () => {
    const db = new FakeLabelDb();
    seedResolvedMarkets(db);
    db.failNextQueries = true;
    const report = await syncLabels({ pool: db, clock: () => NOW });
    expect(report).toEqual({
      inserted: 0,
      updated: 0,
      skippedNotFinal: 0,
      skippedUnparsable: 0,
    });
    expect(
      stderrLines().some((line) => line.includes("LABEL_SYNC_READ_FAILED")),
    ).toBe(true);
  });

  it("reports a resolution whose market the registry has not caught up with", async () => {
    const db = new FakeLabelDb();
    db.addEvent(
      "cond-unknown",
      "resolved",
      { payouts: [1, 0] },
      new Date("2026-08-09T00:00:00Z"),
      new Date("2026-08-09T00:00:10Z"),
    );
    const report = await syncLabels({ pool: db, clock: () => NOW });
    expect(report.inserted).toBe(0);
    expect(
      stderrLines().some((line) => line.includes("LABEL_MARKET_NOT_FOUND")),
    ).toBe(true);
  });
});

describe("loadLabels", () => {
  it("excludes disputed markets from the default (headline) read", async () => {
    const db = new FakeLabelDb();
    seedResolvedMarkets(db);
    db.addMarket("cond-disp", "crypto", ["tok-d-0"], "2026-08-10T00:00:00Z");
    db.addEvent(
      "cond-disp",
      "disputed",
      { to: "disputed" },
      new Date("2026-08-10T01:00:00Z"),
      new Date("2026-08-10T01:00:10Z"),
    );
    db.addEvent(
      "cond-disp",
      "resolved",
      { payouts: [1, 0] },
      new Date("2026-08-11T00:00:00Z"),
      new Date("2026-08-11T00:00:10Z"),
    );
    await syncLabels({ pool: db, clock: () => NOW });

    const headline = await loadLabels(db, {});
    expect(headline.map((row) => row.tokenId)).not.toContain("tok-d-0");

    const withDisputed = await loadLabels(db, { includeDisputed: true });
    const disputedRow = withDisputed.find((row) => row.tokenId === "tok-d-0");
    expect(disputedRow?.disputed).toBe(true);
    expect(disputedRow?.label).toBe("1");
    expect(disputedRow?.isFinal).toBe(true);
  });

  it("filters by category and by a half-open knowable-instant window", async () => {
    const db = new FakeLabelDb();
    seedResolvedMarkets(db);
    await syncLabels({ pool: db, clock: () => NOW });

    const crypto = await loadLabels(db, { category: "crypto_updown" });
    expect(crypto.map((row) => row.tokenId).sort()).toEqual([
      "tok-yes-0",
      "tok-yes-1",
    ]);

    // `from` is inclusive, `to` is exclusive: the 12:05 row is in, the
    // 2026-08-03T09:00 row is out of [12:05, 09:00).
    const window = await loadLabels(db, {
      from: new Date("2026-08-01T12:05:00Z"),
      to: new Date("2026-08-03T09:00:00Z"),
    });
    expect(window.map((row) => row.tokenId).sort()).toEqual([
      "tok-yes-0",
      "tok-yes-1",
    ]);
    expect(window[0]?.publiclyKnowableTs).toEqual(
      new Date("2026-08-01T12:05:00Z"),
    );
    expect(window[0]?.onchainResolutionTs).toEqual(
      new Date("2026-08-02T00:00:00Z"),
    );
  });
});
