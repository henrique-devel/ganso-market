import { describe, expect, it } from "vitest";

import type { QueryResultRow } from "pg";

import type { QueryResult, SqlExecutor } from "../../src/database.js";
import {
  createTradesBackfill,
  handleLastTrade,
  parseDataApiTrade,
} from "../../src/polymarket/trades.js";

interface CapturedQuery {
  readonly text: string;
  readonly params: unknown[];
}

type Responder = (
  text: string,
  params: readonly unknown[],
) => { rows: Record<string, unknown>[] } | undefined;

function createFakeExecutor(responder?: Responder): {
  calls: CapturedQuery[];
  executor: SqlExecutor;
} {
  const calls: CapturedQuery[] = [];
  const executor: SqlExecutor = {
    query<R extends Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      calls.push({ text, params: [...(params ?? [])] });
      const canned = responder?.(text, params ?? []);
      return Promise.resolve({
        rows: (canned?.rows ?? []) as R[],
        rowCount: canned?.rows.length ?? 0,
      });
    },
  };
  return { calls, executor };
}

function jsonResponse(
  body: unknown,
  ok = true,
  status = 200,
): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok, status, json: () => Promise.resolve(body) };
}

describe("handleLastTrade (WS provenance)", () => {
  const message = {
    event_type: "last_trade_price" as const,
    market: "0xcond",
    asset_id: "111",
    price: "0.42",
    size: "12.5",
    side: "BUY" as const,
    timestamp: "1787098643398",
    fee_rate_bps: "100",
    transaction_hash: "0xabc",
  };

  it("relies on ON CONFLICT DO NOTHING so the same tx twice is one row", async () => {
    const { calls, executor } = createFakeExecutor();
    await handleLastTrade(executor, message, () => 1_787_098_643_500);
    await handleLastTrade(executor, message, () => 1_787_098_643_600);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.text).toContain("INSERT INTO polymarket_trades");
      expect(call.text).toContain("ON CONFLICT DO NOTHING");
      expect(call.text).toContain("'ws'");
    }
    // Same dedupe key (token_id, transaction_hash, price, side) both times:
    // the database unique partial index collapses the second insert.
    const first = calls[0]?.params;
    const second = calls[1]?.params;
    expect(first?.[0]).toBe("111");
    expect(first?.[6]).toBe("0xabc");
    expect(second?.slice(0, 7)).toEqual(first?.slice(0, 7));
  });

  it("converts the epoch-ms timestamp to a Date for trade_ts", async () => {
    const { calls, executor } = createFakeExecutor();
    await handleLastTrade(executor, message, () => 0);
    const tradeTs = calls[0]?.params[7];
    expect(tradeTs).toBeInstanceOf(Date);
    expect((tradeTs as Date).getTime()).toBe(1_787_098_643_398);
  });

  it("never throws when persistence fails", async () => {
    const failing: SqlExecutor = {
      query<R extends QueryResultRow>(): Promise<QueryResult<R>> {
        return Promise.reject(new Error("db down"));
      },
    };
    await expect(
      handleLastTrade(failing, message, () => 0),
    ).resolves.toBeUndefined();
  });
});

describe("parseDataApiTrade", () => {
  it("parses a canonical trade row with seconds timestamp", () => {
    const trade = parseDataApiTrade({
      id: "t-1",
      asset: "999",
      conditionId: "0xcond",
      price: 0.37,
      size: "20",
      side: "sell",
      timestamp: 1_700_000_000,
      transactionHash: "0xdead",
    });
    expect(trade?.externalId).toBe("t-1");
    expect(trade?.price).toBe("0.37");
    expect(trade?.side).toBe("SELL");
    expect(trade?.tradeTs?.getTime()).toBe(1_700_000_000_000);
  });

  it("rejects rows without token or price", () => {
    expect(parseDataApiTrade({ price: "0.5" })).toBeNull();
    expect(parseDataApiTrade({ asset: "1" })).toBeNull();
    expect(parseDataApiTrade(null)).toBeNull();
  });
});

describe("trades backfill windowing", () => {
  const NOW = 1_000_000_000_000;
  const LAST_TS = NOW - 90 * 60_000; // 90 minutes behind: needs two windows.

  function makeTrade(id: string, tsSeconds: number): Record<string, unknown> {
    return {
      id,
      asset: "999",
      conditionId: "0xcond",
      price: "0.5",
      size: "1",
      side: "BUY",
      timestamp: tsSeconds,
      transactionHash: `0x${id}`,
    };
  }

  it("covers the range in overlapping windows without losing or duplicating boundary trades", async () => {
    const fetchedUrls: string[] = [];
    const window1Start = Math.floor((LAST_TS - 1_000) / 1_000);
    const window2Start = Math.floor((LAST_TS + 3_600_000 - 1_000) / 1_000);
    // "B" sits in the 1s overlap between the two windows.
    const boundaryTs = window2Start;
    const fetcher = (url: string): Promise<ReturnType<typeof jsonResponse>> => {
      fetchedUrls.push(url);
      const startTs = Number(new URL(url).searchParams.get("startTs"));
      if (startTs === window1Start) {
        return Promise.resolve(
          jsonResponse([
            makeTrade("A", window1Start + 60),
            makeTrade("B", boundaryTs),
          ]),
        );
      }
      return Promise.resolve(
        jsonResponse([
          makeTrade("B", boundaryTs),
          makeTrade("C", boundaryTs + 60),
        ]),
      );
    };

    const { calls, executor } = createFakeExecutor((text) => {
      if (text.includes("max(trade_ts)")) {
        return { rows: [{ max_ts: new Date(LAST_TS) }] };
      }
      return undefined;
    });

    const backfill = createTradesBackfill({
      pool: executor,
      fetcher,
      clock: () => NOW,
      sleep: () => Promise.resolve(),
    });
    await backfill.pollOnce(["0xcond"]);

    // Two timestamp windows, the second starting 1s before the first ended.
    expect(fetchedUrls).toHaveLength(2);
    const params1 = new URL(fetchedUrls[0] ?? "").searchParams;
    const params2 = new URL(fetchedUrls[1] ?? "").searchParams;
    expect(params1.get("takerOnly")).toBe("false");
    expect(Number(params2.get("startTs"))).toBe(
      Number(params1.get("endTs")) - 1,
    );

    const maxQuery = calls.find((call) => call.text.includes("max(trade_ts)"));
    expect(maxQuery?.text).toContain("provenance = 'data_api'");

    const inserts = calls.filter((call) =>
      call.text.includes("INSERT INTO polymarket_trades"),
    );
    for (const insert of inserts) {
      expect(insert.text).toContain("ON CONFLICT DO NOTHING");
      expect(insert.text).toContain("'data_api'");
    }
    // A, B, C exactly once each: the boundary trade B is deduped in memory.
    const externalIds = inserts.map((insert) => insert.params[6]);
    expect(externalIds.sort()).toEqual(["A", "B", "C"]);
  });

  it("records a trades_window_overflow gap when a window exceeds the 10k offset clamp", async () => {
    const lastTs = NOW - 30 * 60_000; // one window: [lastTs - 1s, NOW]
    // Every page comes back full, so the offset keeps growing past the clamp.
    const fullPage = Array.from({ length: 1_000 }, () => ({}));
    let fetches = 0;
    const fetcher = (): Promise<ReturnType<typeof jsonResponse>> => {
      fetches += 1;
      return Promise.resolve(jsonResponse(fullPage));
    };
    const { calls, executor } = createFakeExecutor((text) => {
      if (text.includes("max(trade_ts)")) {
        return { rows: [{ max_ts: new Date(lastTs) }] };
      }
      return undefined;
    });

    const backfill = createTradesBackfill({
      pool: executor,
      fetcher,
      clock: () => NOW,
      sleep: () => Promise.resolve(),
    });
    await backfill.pollOnce(["0xcond"]);

    // offsets 0..10000 were fetched (11 pages); 11000 hits the clamp.
    expect(fetches).toBe(11);
    const gaps = calls.filter((call) =>
      call.text.includes("INSERT INTO polymarket_data_gaps"),
    );
    // Exactly once per occurrence, with source data_api and the window bounds.
    expect(gaps).toHaveLength(1);
    const gap = gaps[0];
    expect(gap?.text).toContain("'data_api'");
    expect(gap?.params[2]).toBe("trades_window_overflow");
    expect((gap?.params[0] as Date).getTime()).toBe(lastTs - 1_000); // fetchStart
    expect((gap?.params[1] as Date).getTime()).toBe(NOW); // fetchEnd
    expect(String(gap?.params[3])).toContain("0xcond");
  });

  it("records a data_api gap when fetches keep failing and the window is >15 min behind", async () => {
    let attempts = 0;
    const fetcher = (): Promise<ReturnType<typeof jsonResponse>> => {
      attempts += 1;
      return Promise.resolve(jsonResponse(null, false, 503));
    };
    const behindTs = NOW - 20 * 60_000;
    const { calls, executor } = createFakeExecutor((text) => {
      if (text.includes("max(trade_ts)")) {
        return { rows: [{ max_ts: new Date(behindTs) }] };
      }
      return undefined;
    });

    const backfill = createTradesBackfill({
      pool: executor,
      fetcher,
      clock: () => NOW,
      sleep: () => Promise.resolve(),
    });
    await backfill.pollOnce(["0xcond"]);

    expect(attempts).toBe(4); // initial try + 3 backoff retries
    const gap = calls.find((call) =>
      call.text.includes("INSERT INTO polymarket_data_gaps"),
    );
    expect(gap).toBeDefined();
    expect(gap?.text).toContain("'data_api'");
    expect(gap?.params[0]).toBeInstanceOf(Date);
    expect((gap?.params[0] as Date).getTime()).toBe(behindTs);
    expect((gap?.params[1] as Date).getTime()).toBe(NOW);
    expect(gap?.params[2]).toBe("trades_backfill_behind");
    expect(String(gap?.params[3])).toContain("0xcond");
  });

  it("does not record a gap when the failing window is less than 15 min behind", async () => {
    const fetcher = (): Promise<ReturnType<typeof jsonResponse>> =>
      Promise.resolve(jsonResponse(null, false, 429));
    const { calls, executor } = createFakeExecutor((text) => {
      if (text.includes("max(trade_ts)")) {
        return { rows: [{ max_ts: new Date(NOW - 5 * 60_000) }] };
      }
      return undefined;
    });

    const backfill = createTradesBackfill({
      pool: executor,
      fetcher,
      clock: () => NOW,
      sleep: () => Promise.resolve(),
    });
    await backfill.pollOnce(["0xcond"]);

    expect(
      calls.some((call) => call.text.includes("polymarket_data_gaps")),
    ).toBe(false);
  });
});
