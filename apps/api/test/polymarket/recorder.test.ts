import { describe, expect, it } from "vitest";

import type {
  DatabasePool,
  QueryResult,
  SqlExecutor,
} from "../../src/database.js";
import {
  createPostgresRecorderStore,
  MarketBookTracker,
  SnapshotThrottle,
  sourceTsToDate,
  type BookSnapshot,
  type RecorderStore,
} from "../../src/polymarket/recorder.js";
import type { MarketRegistryEntry } from "../../src/polymarket/types.js";

class CapturingStore implements RecorderStore {
  public readonly markets: MarketRegistryEntry[] = [];
  public readonly snapshots: BookSnapshot[] = [];

  public upsertMarket(entry: MarketRegistryEntry): Promise<void> {
    this.markets.push(entry);
    return Promise.resolve();
  }

  public insertSnapshot(snapshot: BookSnapshot): Promise<void> {
    this.snapshots.push(snapshot);
    return Promise.resolve();
  }
}

describe("snapshot throttle", () => {
  it("permits one persist per interval per token", () => {
    const throttle = new SnapshotThrottle(3_000);
    expect(throttle.shouldPersist("t", 0)).toBe(true);
    expect(throttle.shouldPersist("t", 1_000)).toBe(false);
    expect(throttle.shouldPersist("t", 3_000)).toBe(true);
    // A different token has an independent budget.
    expect(throttle.shouldPersist("u", 1_000)).toBe(true);
  });
});

describe("source timestamp conversion", () => {
  it("converts an epoch-milliseconds string to a Date", () => {
    const converted = sourceTsToDate("1787098643398");
    expect(converted?.getTime()).toBe(1_787_098_643_398);
  });

  it("returns null for null and non-numeric values", () => {
    expect(sourceTsToDate(null)).toBeNull();
    expect(sourceTsToDate("")).toBeNull();
    expect(sourceTsToDate("2026-08-18T00:00:00Z")).toBeNull();
    expect(sourceTsToDate("12abc")).toBeNull();
  });
});

describe("postgres recorder store", () => {
  it("inserts snapshots with source_ts as a Date, not the raw string", async () => {
    const captured: unknown[][] = [];
    const pool: DatabasePool = {
      query<R extends Record<string, unknown>>(
        _text: string,
        params?: readonly unknown[],
      ): Promise<QueryResult<R>> {
        captured.push([...(params ?? [])]);
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      transaction() {
        return Promise.reject(new Error("unused"));
      },
      end() {
        return Promise.resolve();
      },
    };

    const store = createPostgresRecorderStore(pool);
    await store.insertSnapshot({
      tokenId: "111",
      conditionId: "0xcond",
      sourceTs: "1787098643398",
      bids: [{ price: "0.361", size: "992.4" }],
      asks: [{ price: "0.991", size: "3" }],
    });

    const params = captured[0];
    expect(params?.[2]).toBeInstanceOf(Date);
    expect((params?.[2] as Date).getTime()).toBe(1_787_098_643_398);
  });

  it("locks market, advisory and metadata in one transaction", async () => {
    const statements: string[] = [];
    let transactions = 0;
    const query = <R extends Record<string, unknown>>(
      text: string,
    ): Promise<QueryResult<R>> => {
      statements.push(text);
      if (text.includes("MAX(version)")) {
        return Promise.resolve({
          rows: [{ max_version: 0 }] as unknown as R[],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    };
    const pool: DatabasePool = {
      query,
      async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
        transactions += 1;
        return run({ query });
      },
      end: () => Promise.resolve(),
    };
    const entry: MarketRegistryEntry = {
      conditionId: "0xlegacy",
      question: "Will the legacy recorder stay versioned?",
      slug: "legacy-versioned",
      category: "crypto",
      negRisk: false,
      clobTokenIds: ["yes", "no"],
      affirmativeTokenId: "yes",
      rules: "objective rules",
      tickSize: "0.01",
      minOrderSize: "5",
      rewardsMinSize: null,
      rewardsMaxSpread: null,
      feeType: null,
      endDateIso: "2026-09-01T00:00:00Z",
      active: true,
      closed: false,
      enableOrderBook: true,
    };

    await createPostgresRecorderStore(pool).upsertMarket(entry);

    expect(transactions).toBe(1);
    const metadataInsert = statements.findIndex((text) =>
      text.includes("INSERT INTO polymarket_market_metadata_versions"),
    );
    const marketInsert = statements.findIndex((text) =>
      text.includes("INSERT INTO polymarket_markets"),
    );
    const sourceLock = statements.findIndex(
      (text) =>
        text.includes("FROM polymarket_markets") && text.includes("FOR UPDATE"),
    );
    const advisoryLock = statements.findIndex((text) =>
      text.includes("pg_advisory_xact_lock"),
    );
    expect(metadataInsert).toBeGreaterThanOrEqual(0);
    expect(sourceLock).toBeGreaterThan(marketInsert);
    expect(advisoryLock).toBeGreaterThan(sourceLock);
    expect(metadataInsert).toBeGreaterThan(advisoryLock);
  });
});

describe("market book tracker", () => {
  it("persists a top-of-book snapshot from a book message", async () => {
    const store = new CapturingStore();
    const tracker = new MarketBookTracker(
      store,
      new SnapshotThrottle(3_000),
      () => 0,
    );

    await tracker.handle({
      event_type: "book",
      market: "0xcond",
      asset_id: "111",
      timestamp: "1786846500810",
      hash: "h",
      bids: [
        { price: "0.010", size: "5" },
        { price: "0.361", size: "992.4" },
      ],
      asks: [{ price: "0.991", size: "3" }],
    });

    expect(store.snapshots).toHaveLength(1);
    const snapshot = store.snapshots[0];
    expect(snapshot?.tokenId).toBe("111");
    expect(snapshot?.conditionId).toBe("0xcond");
    expect(snapshot?.bids[0]?.price).toBe("0.361");
    expect(snapshot?.asks[0]?.price).toBe("0.991");
  });

  it("throttles snapshots then persists again after the interval", async () => {
    const store = new CapturingStore();
    let now = 0;
    const tracker = new MarketBookTracker(
      store,
      new SnapshotThrottle(3_000),
      () => now,
    );

    await tracker.handle({
      event_type: "book",
      market: "0xcond",
      asset_id: "111",
      timestamp: "1",
      hash: "h",
      bids: [{ price: "0.010", size: "5" }],
      asks: [{ price: "0.990", size: "1" }],
    });
    expect(store.snapshots).toHaveLength(1);

    // A delta within the interval updates the book but is not persisted.
    now = 1_000;
    await tracker.handle({
      event_type: "price_change",
      market: "0xcond",
      timestamp: "2",
      price_changes: [
        { asset_id: "111", price: "0.500", size: "9", side: "BUY" },
      ],
    });
    expect(store.snapshots).toHaveLength(1);

    // After the interval, the next delta triggers a persist reflecting the book.
    now = 4_000;
    await tracker.handle({
      event_type: "price_change",
      market: "0xcond",
      timestamp: "3",
      price_changes: [
        { asset_id: "111", price: "0.510", size: "2", side: "BUY" },
      ],
    });
    expect(store.snapshots).toHaveLength(2);
    expect(store.snapshots[1]?.bids[0]?.price).toBe("0.510");
  });
});
