import { describe, expect, it } from "vitest";

import type { QueryResult, SqlExecutor } from "../../../src/database.js";
import { computeFeatureRow } from "../../../src/polymarket/paper/features.js";
import {
  FEATURE_LOADER_SQL,
  computeAndStoreWindow,
  insertFeatureRow,
  loadFeatureInputs,
  shouldPersist,
} from "../../../src/polymarket/paper/featurestore.js";

type Row = Record<string, unknown>;
type Responder = (text: string, params: readonly unknown[]) => Row[];

interface CapturedQuery {
  readonly text: string;
  readonly params: readonly unknown[];
}

function fakePool(respond: Responder = () => []): {
  pool: SqlExecutor;
  calls: CapturedQuery[];
} {
  const calls: CapturedQuery[] = [];
  const pool: SqlExecutor = {
    query<R extends Row>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      const captured = [...(params ?? [])];
      calls.push({ text, params: captured });
      const rows = respond(text, captured) as R[];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  };
  return { pool, calls };
}

const WINDOW_START = new Date("2026-08-24T12:00:00.000Z");
const WINDOW_END = new Date("2026-08-24T12:01:00.000Z");

describe("anti-leakage: every feature loader is time-bounded", () => {
  it("carries an explicit upper bound in the SQL text", () => {
    for (const [name, sql] of Object.entries(FEATURE_LOADER_SQL)) {
      // Each loader must bound its time column by a placeholder with <= or <.
      expect(
        /(received_at|valid_from|trade_ts, received_at\)|interval '1 minute')\s*(<=|<)\s*\$\d/.test(
          sql,
        ),
        `loader ${name} lost its upper time bound: ${sql}`,
      ).toBe(true);
    }
  });

  it("passes windowEnd (never a later instant) as the bound", async () => {
    const { pool, calls } = fakePool();
    await loadFeatureInputs(
      pool,
      "token-1",
      "0xcond",
      WINDOW_START,
      WINDOW_END,
    );
    for (const call of calls) {
      for (const param of call.params) {
        if (param instanceof Date) {
          expect(param.getTime()).toBeLessThanOrEqual(WINDOW_END.getTime());
        }
      }
    }
  });
});

/**
 * An in-memory dataset behind a responder that RESPECTS the loaders' bounds.
 * The look-ahead property is proven by appending strictly-later data and
 * asserting the recomputed row is byte-identical.
 */
interface Dataset {
  snapshots: Array<{
    received_at: Date;
    source_ts: Date;
    bids_json: unknown;
    asks_json: unknown;
  }>;
  trades: Array<{ ts: Date; price: string; size: string | null }>;
  deltas: Array<{
    received_at: Date;
    side: string;
    price: string;
    size: string;
  }>;
  closes: Array<{ bucket_start: Date; mid_close: string }>;
}

function datasetResponder(data: Dataset): Responder {
  return (text, params) => {
    const p = (i: number): Date => params[i] as Date;
    if (text === FEATURE_LOADER_SQL.latestBook) {
      const eligible = data.snapshots
        .filter((s) => s.received_at.getTime() <= p(1).getTime())
        .sort((a, b) => b.received_at.getTime() - a.received_at.getTime());
      const first = eligible[0];
      return first === undefined
        ? []
        : [
            {
              token_id: params[0],
              bids_json: first.bids_json,
              asks_json: first.asks_json,
              source_ts: first.source_ts,
              received_at: first.received_at,
            },
          ];
    }
    if (text === FEATURE_LOADER_SQL.tickSize) {
      return [{ tick_size: "0.01" }];
    }
    if (text === FEATURE_LOADER_SQL.windowTrades) {
      return data.trades
        .filter(
          (t) =>
            t.ts.getTime() >= p(1).getTime() && t.ts.getTime() < p(2).getTime(),
        )
        .map((t) => ({ price: t.price, size: t.size }));
    }
    if (text === FEATURE_LOADER_SQL.lastTrade) {
      const eligible = data.trades
        .filter((t) => t.ts.getTime() <= p(1).getTime())
        .sort((a, b) => b.ts.getTime() - a.ts.getTime());
      const first = eligible[0];
      return first === undefined ? [] : [{ effective_ts: first.ts }];
    }
    if (text === FEATURE_LOADER_SQL.deltaStats) {
      const inWindow = data.deltas.filter(
        (d) =>
          d.received_at.getTime() >= p(1).getTime() &&
          d.received_at.getTime() < p(2).getTime(),
      );
      const levels = new Set(inWindow.map((d) => `${d.side}:${d.price}`));
      // PostgreSQL returns COUNT() as a string; the loader must cope.
      return [
        {
          cancel_events: String(inWindow.filter((d) => d.size === "0").length),
          update_events: String(inWindow.filter((d) => d.size !== "0").length),
          levels_touched: String(levels.size),
        },
      ];
    }
    if (text === FEATURE_LOADER_SQL.midCloses) {
      return data.closes
        .filter(
          (c) =>
            c.bucket_start.getTime() >= p(1).getTime() &&
            c.bucket_start.getTime() + 60_000 <= p(2).getTime(),
        )
        .sort((a, b) => a.bucket_start.getTime() - b.bucket_start.getTime())
        .map((c) => ({ mid_close: c.mid_close }));
    }
    if (text === FEATURE_LOADER_SQL.snapshotMids) {
      return data.snapshots
        .filter(
          (s) =>
            s.received_at.getTime() >= p(1).getTime() &&
            s.received_at.getTime() < p(2).getTime(),
        )
        .sort((a, b) => a.received_at.getTime() - b.received_at.getTime())
        .map((s) => ({ bids_json: s.bids_json, asks_json: s.asks_json }));
    }
    if (text === FEATURE_LOADER_SQL.nextCatalyst) {
      return [{ next_at: new Date("2026-08-24T14:00:00.000Z") }];
    }
    if (text === FEATURE_LOADER_SQL.ruleDates) {
      return [
        {
          end_date: new Date("2026-08-24T18:00:00.000Z"),
          uma_end_date: new Date("2026-08-24T20:00:00.000Z"),
        },
      ];
    }
    return [];
  };
}

function fixtureDataset(): Dataset {
  const book = (
    bid: string,
    ask: string,
  ): Pick<Dataset["snapshots"][number], "bids_json" | "asks_json"> => ({
    bids_json: [{ price: bid, size: "100" }],
    asks_json: [{ price: ask, size: "80" }],
  });
  return {
    snapshots: [
      {
        received_at: new Date("2026-08-24T12:00:10.000Z"),
        source_ts: new Date("2026-08-24T12:00:09.500Z"),
        ...book("0.48", "0.52"),
      },
      {
        received_at: new Date("2026-08-24T12:00:40.000Z"),
        source_ts: new Date("2026-08-24T12:00:39.500Z"),
        ...book("0.49", "0.53"),
      },
    ],
    trades: [
      {
        ts: new Date("2026-08-24T12:00:30.000Z"),
        price: "0.50",
        size: "12",
      },
    ],
    deltas: [
      {
        received_at: new Date("2026-08-24T12:00:20.000Z"),
        side: "BUY",
        price: "0.48",
        size: "0",
      },
      {
        received_at: new Date("2026-08-24T12:00:21.000Z"),
        side: "BUY",
        price: "0.48",
        size: "50",
      },
    ],
    closes: [
      {
        bucket_start: new Date("2026-08-24T11:58:00.000Z"),
        mid_close: "0.500000",
      },
      {
        bucket_start: new Date("2026-08-24T11:59:00.000Z"),
        mid_close: "0.510000",
      },
    ],
  };
}

describe("look-ahead property", () => {
  it("data arriving after windowEnd cannot change the computed row", async () => {
    const data = fixtureDataset();
    const { pool } = fakePool(datasetResponder(data));
    const before = computeFeatureRow(
      await loadFeatureInputs(
        pool,
        "token-1",
        "0xcond",
        WINDOW_START,
        WINDOW_END,
      ),
    );

    // Strictly-later arrivals: a fresher book, a trade, a delta, a close.
    data.snapshots.push({
      received_at: new Date("2026-08-24T12:01:05.000Z"),
      source_ts: new Date("2026-08-24T12:01:04.000Z"),
      bids_json: [{ price: "0.60", size: "999" }],
      asks_json: [{ price: "0.61", size: "999" }],
    });
    data.trades.push({
      ts: new Date("2026-08-24T12:01:02.000Z"),
      price: "0.99",
      size: "1000",
    });
    data.deltas.push({
      received_at: new Date("2026-08-24T12:01:01.000Z"),
      side: "SELL",
      price: "0.53",
      size: "0",
    });
    data.closes.push({
      bucket_start: new Date("2026-08-24T12:01:00.000Z"),
      mid_close: "0.990000",
    });

    const { pool: poolAfter } = fakePool(datasetResponder(data));
    const after = computeFeatureRow(
      await loadFeatureInputs(
        poolAfter,
        "token-1",
        "0xcond",
        WINDOW_START,
        WINDOW_END,
      ),
    );
    expect(after).toEqual(before);
  });

  it("counts window activity from bounded loads", async () => {
    const { pool } = fakePool(datasetResponder(fixtureDataset()));
    const inputs = await loadFeatureInputs(
      pool,
      "token-1",
      "0xcond",
      WINDOW_START,
      WINDOW_END,
    );
    expect(inputs.trades).toHaveLength(1);
    expect(inputs.deltaStats).toEqual({
      cancelEvents: 1,
      updateEvents: 1,
      levelsTouched: 1,
    });
    expect(inputs.midCloses1m).toEqual(["0.500000", "0.510000"]);
    expect(inputs.snapshotMids).toEqual(["0.500000", "0.510000"]);
    expect(inputs.tickSize).toBe("0.01");
  });
});

describe("persistence", () => {
  it("inserts with ON CONFLICT DO NOTHING and all 40 columns", async () => {
    const { pool, calls } = fakePool(datasetResponder(fixtureDataset()));
    const inputs = await loadFeatureInputs(
      pool,
      "token-1",
      "0xcond",
      WINDOW_START,
      WINDOW_END,
    );
    const row = computeFeatureRow(inputs);
    await insertFeatureRow(pool, "token-1", "1m", row);
    const insert = calls.find((c) =>
      c.text.includes("INSERT INTO paper_feature_windows"),
    );
    expect(insert).toBeDefined();
    expect(insert?.text).toContain(
      "ON CONFLICT (token_id, window_kind, window_start) DO NOTHING",
    );
    expect(insert?.params).toHaveLength(40);
    expect(insert?.params[0]).toBe("token-1");
    expect(insert?.params[1]).toBe("1m");
    // Signed flow can never be written without the onchain status.
    expect(insert?.params[26]).toBeNull();
    expect(insert?.params[27]).toBe("UNAVAILABLE");
  });

  it("quiet fine windows are not persisted; 1m always is", async () => {
    const quiet = fixtureDataset();
    quiet.trades = [];
    quiet.deltas = [];
    quiet.snapshots = quiet.snapshots.slice(0, 1);
    const { pool } = fakePool(datasetResponder(quiet));
    const inputs = await loadFeatureInputs(
      pool,
      "token-1",
      "0xcond",
      WINDOW_START,
      WINDOW_END,
    );
    const row = computeFeatureRow(inputs);
    expect(shouldPersist("1s", row)).toBe(false);
    expect(shouldPersist("10s", row)).toBe(false);
    expect(shouldPersist("1m", row)).toBe(true);
  });

  it("computeAndStoreWindow returns whether a row was written", async () => {
    const { pool, calls } = fakePool(datasetResponder(fixtureDataset()));
    const stored = await computeAndStoreWindow(
      pool,
      "token-1",
      "0xcond",
      "1s",
      WINDOW_START,
      WINDOW_END,
    );
    expect(stored).toBe(true);
    expect(
      calls.filter((c) => c.text.includes("INSERT INTO paper_feature_windows")),
    ).toHaveLength(1);
  });
});
