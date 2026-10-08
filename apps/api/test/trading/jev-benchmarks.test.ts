import { describe, expect, it } from "vitest";
import { parseTradingAmount } from "@ganso-market/contracts/trading";
import {
  startJevBenchmark,
  advanceJevBenchmark,
  jevBenchmarkWindow,
  type BenchmarkFunding,
} from "../../src/storage/jev-benchmark-engine.js";
import { metadata } from "./bars-fixture.js";
import { market } from "./valuation-fixture.js";
import { start, iso } from "./jev-v2-fixture.js";
export function benchmarkMarket(
  at = start + 10000,
  mark = "100000000000",
  bid = "99900000000",
  ask = "100000000000",
  depth = "1000000",
) {
  const m = market(at),
    amount = <U extends "USD_PER_BTC" | "BTC">(raw: string, unit: U) =>
      parseTradingAmount(unit, { raw, unit, decimals: unit === "BTC" ? 8 : 6 });
  if (
    m.context?.payload.payload.kind !== "mark_funding" ||
    m.book?.payload.payload.kind !== "book"
  )
    throw new Error();
  m.context = {
    ...m.context,
    object_id: `mark:${at}`,
    payload: {
      ...m.context.payload,
      payload: {
        ...m.context.payload.payload,
        mark_price: amount(mark, "USD_PER_BTC"),
      },
    },
  };
  m.book = {
    ...m.book,
    object_id: `book:${at}`,
    payload: {
      ...m.book.payload,
      payload: {
        ...m.book.payload.payload,
        bids: [
          {
            price: amount(bid, "USD_PER_BTC"),
            quantity: amount(depth, "BTC"),
            orders: 1,
          },
        ],
        asks: [
          {
            price: amount(ask, "USD_PER_BTC"),
            quantity: amount(depth, "BTC"),
            orders: 1,
          },
        ],
      },
    },
  };
  return m;
}
const zero: BenchmarkFunding = {
  period_hour: iso(start),
  received_at: iso(start + 10000),
  row: { coin: "BTC", fundingRate: "0", premium: "0", time: start },
  oracle: null,
};
function entered(mode: "paper" | "stress" = "paper") {
  const s = startJevBenchmark(mode, metadata, benchmarkMarket());
  return advanceJevBenchmark(s, metadata, benchmarkMarket(start + 12000), [
    zero,
  ]);
}
describe("JE08 independent protected BTC trajectory", () => {
  it("observes the peak and DD on the first partial, and rejects mixed reference cuts", () => {
    const s = startJevBenchmark("paper", metadata, benchmarkMarket(), "a");
    const peak = advanceJevBenchmark(
      s,
      metadata,
      benchmarkMarket(start + 12000, "110000000000"),
      [zero],
    );
    expect(peak.state.high_water_usd6).toBe("262443750");
    expect(
      advanceJevBenchmark(peak.state, metadata, benchmarkMarket(start + 13000))
        .state.phase,
    ).toBe("exit_pending");
    const other = advanceJevBenchmark(
      startJevBenchmark("paper", metadata, benchmarkMarket(), "b"),
      metadata,
      benchmarkMarket(start + 13000),
      [zero],
    );
    expect(() =>
      jevBenchmarkWindow(peak.observation, other.observation),
    ).toThrow(/WINDOW/);
    expect(
      advanceJevBenchmark(
        s,
        metadata,
        benchmarkMarket(start + 12000, "90000000000"),
        [zero],
      ).state.phase,
    ).toBe("exit_pending");
  });
  it("starts with fixed 50% quantity, waits latency, walks depth and charges fees independently", () => {
    const s = startJevBenchmark("paper", metadata, benchmarkMarket());
    expect(s.target_quantity_btc8).toBe("125000");
    expect(
      advanceJevBenchmark(s, metadata, benchmarkMarket(start + 10500)).state
        .events,
    ).toHaveLength(0);
    const p = entered(),
      stress = entered("stress");
    expect(p.observation).toMatchObject({
      quantity_btc8: "125000",
      fees_usd6: "56250",
      equity_usd6: "249943750",
    });
    expect(stress.observation.fees_usd6).toBe("112500");
    expect(
      advanceJevBenchmark(
        p.state,
        metadata,
        benchmarkMarket(start + 13000, "200000000000"),
      ).observation.quantity_btc8,
    ).toBe("125000");
    expect(() =>
      jevBenchmarkWindow(p.observation, {
        ...stress.observation,
        at: iso(start + 13000),
      }),
    ).toThrow(/WINDOW/);
  });
  it("one initial IOC cancels its partial remainder, with no top-up/rebalance", () => {
    const s = startJevBenchmark("paper", metadata, benchmarkMarket());
    const p = advanceJevBenchmark(
      s,
      metadata,
      benchmarkMarket(
        start + 12000,
        "100000000000",
        "99900000000",
        "100000000000",
        "50000",
      ),
      [zero],
    );
    expect(p.state.initial_quantity_btc8).toBe("50000");
    expect(
      advanceJevBenchmark(p.state, metadata, benchmarkMarket(start + 13000))
        .observation.quantity_btc8,
    ).toBe("50000");
  });
  it("latches peak DD, requests latency-aware reduction, preserves residual through gap, then stays cash", () => {
    let r = entered();
    r = advanceJevBenchmark(
      r.state,
      metadata,
      benchmarkMarket(start + 13000, "110000000000"),
    );
    expect(r.state.high_water_usd6).toBe("262443750");
    const opening = r.observation;
    r = advanceJevBenchmark(r.state, metadata, benchmarkMarket(start + 14000));
    expect(r.state.phase).toBe("exit_pending");
    expect(r.observation.quantity_btc8).toBe("125000");
    r = advanceJevBenchmark(r.state, metadata, {
      ...benchmarkMarket(start + 15000),
      book: null,
    });
    expect(r.observation.quantity_btc8).toBe("125000");
    r = advanceJevBenchmark(
      r.state,
      metadata,
      benchmarkMarket(
        start + 16000,
        "100000000000",
        "99500000000",
        "100000000000",
        "50000",
      ),
    );
    expect(r.observation.quantity_btc8).toBe("75000");
    expect(r.state.phase).toBe("exit_pending");
    r = advanceJevBenchmark(
      r.state,
      metadata,
      benchmarkMarket(start + 17000, "100000000000", "99000000000"),
    );
    expect(r.state.phase).toBe("cash");
    expect(r.observation.quantity_btc8).toBe("0");
    const final = advanceJevBenchmark(
      r.state,
      metadata,
      benchmarkMarket(start + 18000, "200000000000"),
    );
    expect(final.state.events).toEqual(r.state.events);
    expect(final.state.high_water_usd6).toBe("262443750");
    // $12.50 opening profit + $1 realized exit loss + $0.055801 exit fees.
    expect(jevBenchmarkWindow(opening, final.observation)).toMatchObject({
      cash: { pnl_usd6: "0" },
      real_capital_reserved_usd6: "0",
      btc_protected: { pnl_usd6: "-13555801" },
    });
    expect(
      advanceJevBenchmark(
        final.state,
        metadata,
        benchmarkMarket(start + 7200000),
      ).observation.equity_usd6,
    ).toBe(final.observation.equity_usd6);
  });
  it("gap above initial limit does not fabricate a fill or retry buying", () => {
    const s = startJevBenchmark("paper", metadata, benchmarkMarket());
    const r = advanceJevBenchmark(
      s,
      metadata,
      benchmarkMarket(
        start + 12000,
        "101000000000",
        "100000000000",
        "101000000000",
      ),
    );
    expect(r.state.phase).toBe("cash");
    expect(r.state.events).toEqual([]);
    expect(
      advanceJevBenchmark(r.state, metadata, benchmarkMarket(start + 13000))
        .state.events,
    ).toEqual([]);
  });
  it("missing/future funding is unavailable; late observed funding debits this trajectory once", () => {
    let r = entered();
    const at = start + 3601000,
      oracle = benchmarkMarket(start + 3599000).context!;
    if (oracle.payload.payload.kind !== "mark_funding") throw new Error();
    const received = iso(start + 3599000);
    const f: BenchmarkFunding = {
      period_hour: iso(start + 3600000),
      received_at: iso(at),
      row: {
        coin: "BTC",
        fundingRate: "0.001",
        premium: "0",
        time: start + 3600000,
      },
      oracle: {
        ...oracle,
        payload: {
          ...oracle.payload,
          source_id: "hyperliquid:mainnet:info",
          parser_version: "hyperliquid.context-snapshot.v1",
          source_timestamp: null,
          quality: "unknown",
          payload: {
            ...oracle.payload.payload,
            oracle_price: parseTradingAmount("USD_PER_BTC", {
              unit: "USD_PER_BTC",
              decimals: 6,
              raw: "60000000000",
            }),
            snapshot: {
              basis: "http_response_date",
              requested_at: received,
              received_at: received,
              server_date: new Date(received).toUTCString(),
              cache_status: "Miss from cloudfront",
              age: null,
              raw_context: { coin: "BTC" },
            },
          },
        },
      },
    };
    expect(
      advanceJevBenchmark(r.state, metadata, benchmarkMarket(at)).observation
        .equity_usd6,
    ).toBeNull();
    r = advanceJevBenchmark(r.state, metadata, benchmarkMarket(at), [f]);
    expect(r.observation.funding_usd6).toBe("-75000");
    expect(r.observation.equity_usd6).toBe("249868750");
    expect(
      advanceJevBenchmark(r.state, metadata, benchmarkMarket(at + 1000), [
        { ...f, received_at: iso(at + 1000) },
      ]).observation.funding_usd6,
    ).toBe("-75000");
    expect(
      advanceJevBenchmark(r.state, metadata, benchmarkMarket(at + 1000), [
        { ...f, row: { ...(f.row as object), fundingRate: "-0.001" } },
      ]).observation.equity_usd6,
    ).toBeNull();
    expect(() =>
      advanceJevBenchmark(r.state, metadata, benchmarkMarket(at + 1000), [
        { ...f, received_at: iso(at + 2000) },
      ]),
    ).toThrow(/FUTURE/);
  });
});
