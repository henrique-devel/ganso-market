import { describe, expect, it } from "vitest";

import type { QueryResult } from "../../../src/database.js";
import {
  historicalMarketsAsOf,
  loadScoreableMarkets,
  marketsByIds,
  measuredCategoryStats,
  measuredCategoryStatsBatch,
  midCloseAt,
  statusAsOf,
} from "../../../src/polymarket/resolution/store.js";
import type { ResolutionPool } from "../../../src/polymarket/resolution/types.js";

type Row = Record<string, unknown>;

function poolWithRows(rows: readonly Row[]): ResolutionPool {
  return {
    query<R extends Row>(): Promise<QueryResult<R>> {
      return Promise.resolve({
        rows: [...rows] as unknown as R[],
        rowCount: rows.length,
      });
    },
  };
}

describe("as-of market loaders", () => {
  it("loads the scoreable universe from metadata and params valid at asOf", async () => {
    const asOf = new Date("2026-08-24T12:00:00.000Z");
    let observedSql = "";
    let observedParams: readonly unknown[] | undefined;
    const pool: ResolutionPool = {
      query<R extends Row>(
        text: string,
        params?: readonly unknown[],
      ): Promise<QueryResult<R>> {
        observedSql = text;
        observedParams = params;
        return Promise.resolve({
          rows: [
            {
              condition_id: "0xscoreable",
              metadata_version_id: "101",
              param_version_id: "201",
              question: "Historical question?",
              category: null,
              neg_risk: false,
              clob_token_ids: ["yes", "no"],
              affirmative_token_id: "yes",
              in_universe: true,
            },
          ] as unknown as R[],
          rowCount: 1,
        });
      },
    };

    await expect(loadScoreableMarkets(pool, asOf)).resolves.toEqual([
      {
        conditionId: "0xscoreable",
        question: "Historical question?",
        category: null,
        negRisk: false,
        tokenIds: ["yes", "no"],
        affirmativeTokenId: "yes",
        inUniverse: true,
      },
    ]);
    expect(observedSql).toContain("polymarket_market_metadata_versions");
    expect(observedSql).toContain("h.metadata_version_id");
    expect(observedSql).toContain("metadata.valid_from <= $1");
    expect(observedSql).toContain("polymarket_param_versions");
    expect(observedSql).toContain("p.param_version_id");
    expect(observedSql).toContain("params.valid_from <= $1");
    expect(observedSql).toContain("LEFT JOIN LATERAL");
    expect(observedSql).not.toContain("polymarket_markets");
    expect(observedParams?.[0]).toEqual(asOf);
  });

  it("loads named markets from metadata and params valid at the requested instant", async () => {
    const asOf = new Date("2026-08-24T13:00:00.000Z");
    let observedSql = "";
    let observedParams: readonly unknown[] | undefined;
    const pool: ResolutionPool = {
      query<R extends Row>(
        text: string,
        params?: readonly unknown[],
      ): Promise<QueryResult<R>> {
        observedSql = text;
        observedParams = params;
        return Promise.resolve({
          rows: [
            {
              condition_id: "0xnamed",
              metadata_version_id: "102",
              param_version_id: "202",
              question: "Question at recompute time?",
              category: "politics",
              neg_risk: true,
              clob_token_ids: '["yes-id","no-id"]',
              affirmative_token_id: "yes-id",
            },
          ] as unknown as R[],
          rowCount: 1,
        });
      },
    };

    await expect(marketsByIds(pool, ["0xnamed"], asOf)).resolves.toEqual([
      {
        conditionId: "0xnamed",
        question: "Question at recompute time?",
        category: "politics",
        negRisk: true,
        tokenIds: ["yes-id", "no-id"],
        affirmativeTokenId: "yes-id",
        inUniverse: false,
      },
    ]);
    expect(observedSql).toContain("polymarket_market_metadata_versions");
    expect(observedSql).toContain("metadata.valid_from <= $2");
    expect(observedSql).toContain("polymarket_param_versions");
    expect(observedSql).toContain("params.valid_from <= $2");
    expect(observedSql).not.toContain("polymarket_markets");
    expect(observedParams).toEqual([["0xnamed"], asOf]);
  });

  it("rejects a scoreable market without an as-of metadata version", async () => {
    const pool = poolWithRows([
      {
        condition_id: "0xmissing-metadata",
        metadata_version_id: null,
        param_version_id: "201",
        question: null,
        category: null,
        neg_risk: false,
        clob_token_ids: null,
        in_universe: true,
      },
    ]);

    await expect(
      loadScoreableMarkets(pool, new Date("2026-08-24T12:00:00.000Z")),
    ).rejects.toThrow(
      "RESOLUTION_MARKET_METADATA_VERSION_MISSING:0xmissing-metadata",
    );
  });

  it("rejects a scoreable market without an as-of param version", async () => {
    const pool = poolWithRows([
      {
        condition_id: "0xmissing-param",
        metadata_version_id: "101",
        param_version_id: null,
        question: "Valid question?",
        category: null,
        neg_risk: null,
        clob_token_ids: ["yes", "no"],
        affirmative_token_id: "yes",
        in_universe: true,
      },
    ]);

    await expect(
      loadScoreableMarkets(pool, new Date("2026-08-24T12:00:00.000Z")),
    ).rejects.toThrow(
      "RESOLUTION_MARKET_PARAM_VERSION_MISSING:0xmissing-param",
    );
  });

  it("rejects a scoreable market without an explicit affirmative token", async () => {
    const pool = poolWithRows([
      {
        condition_id: "0xmissing-affirmative",
        metadata_version_id: "101",
        param_version_id: "201",
        question: "Valid question?",
        category: "crypto",
        neg_risk: false,
        clob_token_ids: ["possible-yes", "possible-no"],
        affirmative_token_id: null,
        in_universe: true,
      },
    ]);

    await expect(
      loadScoreableMarkets(pool, new Date("2026-08-24T12:00:00.000Z")),
    ).rejects.toThrow(
      "RESOLUTION_MARKET_AFFIRMATIVE_TOKEN_MISSING:0xmissing-affirmative",
    );
  });

  it("rejects a requested market without an as-of metadata version", async () => {
    const pool = poolWithRows([
      {
        condition_id: "0xrequested-metadata",
        metadata_version_id: null,
        param_version_id: "202",
        question: null,
        category: null,
        neg_risk: true,
        clob_token_ids: null,
      },
    ]);

    await expect(
      marketsByIds(
        pool,
        ["0xrequested-metadata"],
        new Date("2026-08-24T12:00:00.000Z"),
      ),
    ).rejects.toThrow(
      "RESOLUTION_MARKET_METADATA_VERSION_MISSING:0xrequested-metadata",
    );
  });

  it("rejects a requested market without an as-of param version", async () => {
    const pool = poolWithRows([
      {
        condition_id: "0xrequested-param",
        metadata_version_id: "102",
        param_version_id: null,
        question: "Valid requested question?",
        category: "politics",
        neg_risk: null,
        clob_token_ids: ["yes", "no"],
        affirmative_token_id: "yes",
      },
    ]);

    await expect(
      marketsByIds(
        pool,
        ["0xrequested-param"],
        new Date("2026-08-24T12:00:00.000Z"),
      ),
    ).rejects.toThrow(
      "RESOLUTION_MARKET_PARAM_VERSION_MISSING:0xrequested-param",
    );
  });
});

describe("midCloseAt", () => {
  it("queries only buckets whose full one-minute window closed by the instant", async () => {
    const asOf = new Date("2026-08-24T12:00:30.000Z");
    let observedSql = "";
    let observedParams: readonly unknown[] | undefined;
    const pool: ResolutionPool = {
      query<R extends Row>(
        text: string,
        params?: readonly unknown[],
      ): Promise<QueryResult<R>> {
        observedSql = text;
        observedParams = params;
        return Promise.resolve({
          rows: [{ mid_close: "0.420000" }] as unknown as R[],
          rowCount: 1,
        });
      },
    };

    await expect(midCloseAt(pool, "token-yes", asOf)).resolves.toBe(0.42);

    expect(observedSql).toContain("bucket_start <= $2");
    expect(observedSql).toContain("ORDER BY bucket_start DESC");
    expect(observedParams?.[0]).toBe("token-yes");
    expect(observedParams?.[1]).toEqual(new Date("2026-08-24T11:59:30.000Z"));
  });
});

describe("historicalMarketsAsOf", () => {
  it("uses the metadata version valid at the decision without current-state fallbacks", async () => {
    const decision = new Date("2026-08-20T09:59:00.000Z");
    let observedSql = "";
    const pool: ResolutionPool = {
      query<R extends Row>(text: string): Promise<QueryResult<R>> {
        observedSql = text;
        return Promise.resolve({
          rows: [
            {
              condition_id: "0xchanged",
              action: "enter",
              question: "Will the historic threshold be reached?",
              category: "crypto",
              neg_risk: false,
              token_ids: ["historic-yes", "historic-no"],
              affirmative_token_id: "historic-yes",
            },
          ] as unknown as R[],
          rowCount: 1,
        });
      },
    };

    const markets = await historicalMarketsAsOf(pool, [
      { conditionId: "0xchanged", asOf: decision },
    ]);

    expect(markets.get("0xchanged")).toMatchObject({
      question: "Will the historic threshold be reached?",
      category: "crypto",
      tokenIds: ["historic-yes", "historic-no"],
      affirmativeTokenId: "historic-yes",
      inUniverse: true,
      historicalInputsAvailable: true,
    });
    expect(observedSql).toContain("polymarket_market_metadata_versions h");
    expect(observedSql).toContain("h.valid_from <= r.decision_at");
    expect(observedSql).toContain("h.valid_to > r.decision_at");
    expect(observedSql).not.toContain("FROM polymarket_markets");
    expect(observedSql).not.toContain("FROM polymarket_book_snapshots");
  });

  it("marks decisions before the prospective backfill as unavailable", async () => {
    const pool: ResolutionPool = {
      query<R extends Row>(): Promise<QueryResult<R>> {
        return Promise.resolve({
          rows: [
            {
              condition_id: "0xpre-backfill",
              action: "enter",
              question: null,
              category: null,
              neg_risk: false,
              token_ids: [],
            },
          ] as unknown as R[],
          rowCount: 1,
        });
      },
    };

    const markets = await historicalMarketsAsOf(pool, [
      {
        conditionId: "0xpre-backfill",
        asOf: new Date("2026-08-01T00:00:00.000Z"),
      },
    ]);

    expect(markets.get("0xpre-backfill")).toMatchObject({
      question: "",
      category: null,
      tokenIds: [],
      affirmativeTokenId: null,
      historicalInputsAvailable: false,
    });
  });

  it("rejects duplicate condition ids because the result is keyed by condition", async () => {
    const pool: ResolutionPool = {
      query<R extends Row>(): Promise<QueryResult<R>> {
        throw new Error("query should not run");
      },
    };

    await expect(
      historicalMarketsAsOf(pool, [
        { conditionId: "0xduplicate", asOf: new Date("2026-08-20T10:00:00Z") },
        { conditionId: "0xduplicate", asOf: new Date("2026-08-21T10:00:00Z") },
      ]),
    ).rejects.toThrow("HISTORICAL_MARKET_REQUEST_DUPLICATE_CONDITION");
  });
});

describe("statusAsOf", () => {
  it("keeps terminal status after delayed non-terminal events", async () => {
    const proposedAt = new Date("2026-08-20T10:00:00.000Z");
    const resolvedAt = new Date("2026-08-20T11:00:00.000Z");
    const pool: ResolutionPool = {
      query<R extends Row>(): Promise<QueryResult<R>> {
        return Promise.resolve({
          rows: [
            { event_type: "proposed", received_at: proposedAt },
            { event_type: "resolved", received_at: resolvedAt },
            {
              event_type: "disputed",
              received_at: new Date("2026-08-20T12:00:00.000Z"),
            },
            {
              event_type: "proposed",
              received_at: new Date("2026-08-20T13:00:00.000Z"),
            },
          ] as unknown as R[],
          rowCount: 4,
        });
      },
    };

    await expect(
      statusAsOf(pool, "0xterminal", new Date("2026-08-20T14:00:00.000Z")),
    ).resolves.toEqual({
      status: "resolved",
      statusAt: resolvedAt,
      proposedAt,
      disputeCount: 1,
    });
  });
});

describe("measuredCategoryStatsBatch", () => {
  it("loads terminal facts once and accumulates priors at every instant", async () => {
    const first = new Date("2026-08-20T10:00:00.000Z");
    const second = new Date("2026-08-20T12:00:00.000Z");
    let queryCount = 0;
    let observedNewest: unknown;
    let observedSql = "";
    const pool: ResolutionPool = {
      query<R extends Row>(
        text: string,
        params?: readonly unknown[],
      ): Promise<QueryResult<R>> {
        queryCount += 1;
        observedSql = text;
        observedNewest = params?.[0];
        return Promise.resolve({
          rows: [
            {
              condition_id: "0xprior-a",
              terminal_at: new Date("2026-08-20T09:00:00.000Z"),
              disputed_at: new Date("2026-08-20T09:30:00.000Z"),
              category: "crypto",
              is_p5050: false,
            },
            {
              condition_id: "0xprior-b",
              terminal_at: new Date("2026-08-20T11:00:00.000Z"),
              disputed_at: null,
              category: "crypto",
              is_p5050: true,
            },
          ] as unknown as R[],
          rowCount: 2,
        });
      },
    };

    const stats = await measuredCategoryStatsBatch(pool, [second, first]);

    expect(queryCount).toBe(1);
    expect(observedNewest).toEqual(second);
    expect(observedSql).toContain("polymarket_market_metadata_versions h");
    expect(observedSql).toContain("h.valid_from <= t.terminal_at");
    expect(observedSql).not.toContain("FROM polymarket_universe_log u");
    expect(stats.get(first.getTime())).toEqual([
      { category: "crypto", resolved: 1, disputed: 1, p5050: 0 },
    ]);
    expect(stats.get(second.getTime())).toEqual([
      { category: "crypto", resolved: 2, disputed: 1, p5050: 1 },
    ]);
  });
});

describe("measuredCategoryStats", () => {
  it("attributes each resolution to the metadata category valid at terminal_at", async () => {
    const asOf = new Date("2026-08-24T14:00:00.000Z");
    let observedSql = "";
    const pool: ResolutionPool = {
      query<R extends Row>(text: string): Promise<QueryResult<R>> {
        observedSql = text;
        return Promise.resolve({
          rows: [
            {
              category: "crypto",
              resolved: "4",
              disputed: "1",
              p5050: "2",
            },
          ] as unknown as R[],
          rowCount: 1,
        });
      },
    };

    await expect(measuredCategoryStats(pool, asOf)).resolves.toEqual([
      { category: "crypto", resolved: 4, disputed: 1, p5050: 2 },
    ]);
    expect(observedSql).toContain("e.received_at AS terminal_at");
    expect(observedSql).toContain("polymarket_market_metadata_versions");
    expect(observedSql).toContain("metadata.valid_from <= t.terminal_at");
    expect(observedSql).not.toContain("polymarket_markets");
  });
});
