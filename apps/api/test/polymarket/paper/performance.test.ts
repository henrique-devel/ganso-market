import { describe, expect, it } from "vitest";

import type { QueryResult, SqlExecutor } from "../../../src/database.js";
import {
  buildPerformanceReport,
  optimisticEvents,
} from "../../../src/polymarket/paper/performance.js";
import type { LedgerEventRecord } from "../../../src/polymarket/paper/ledger.js";

type Row = Record<string, unknown>;

const T0 = new Date("2026-08-24T12:00:00.000Z");

function ledgerRow(
  key: string,
  eventType: string,
  orderId: string | null,
  payload: Record<string, unknown>,
  offsetMs: number,
): Row {
  return {
    idempotency_key: key,
    event_type: eventType,
    order_id: orderId,
    token_id: "tok",
    condition_id: "0xcond",
    payload_json: payload,
    event_ts: new Date(T0.getTime() + offsetMs),
  };
}

// A taker buy of 10 at 0.50 (fee 0.10, tick 0.01), a denied passive fill of
// 10 at 0.40, and a resolution at 1.00.
const LEDGER: Row[] = [
  ledgerRow(
    "o1:accepted",
    "order_accepted",
    "o1",
    { side: "BUY", worst_price: "0.52" },
    0,
  ),
  ledgerRow(
    "o1:taker:0",
    "fill",
    "o1",
    {
      side: "BUY",
      price: "0.50",
      size: "10",
      fee: "0.1",
      taker: true,
      tick_size: "0.01",
    },
    1_000,
  ),
  ledgerRow(
    "o2:deny:5",
    "fill_denied_degradation",
    "o2",
    { side: "BUY", price: "0.40", size: "10" },
    2_000,
  ),
  ledgerRow(
    "resolution:tok:9",
    "resolution",
    null,
    { outcome_price: "1.000000" },
    3_000,
  ),
];

function fakePool(): SqlExecutor {
  return {
    query<R extends Row>(text: string): Promise<QueryResult<R>> {
      const rows = ((): Row[] => {
        if (text.includes("FROM paper_ledger_events")) {
          return LEDGER;
        }
        if (text.includes("FROM paper_positions")) {
          return [{ unrealized: "0", unmarked: false }];
        }
        if (text.includes("FROM paper_orders")) {
          return [
            { order_type: "FAK", orders: 1, filled: 1 },
            { order_type: "GTC", orders: 2, filled: 0 },
          ];
        }
        if (text.includes("FROM paper_markouts")) {
          return [{ horizon_s: 60, fills: 3, avg_mid: "-0.012" }];
        }
        return [];
      })();
      return Promise.resolve({ rows: rows as R[], rowCount: rows.length });
    },
  };
}

describe("three-column performance report (RFC-011 task 8)", () => {
  it("always publishes optimistic, base and stress — base never optimistic", async () => {
    const report = await buildPerformanceReport(fakePool());
    // Base: buy 10 at 0.50 (cost 5, fee 0.1), resolve at 1 => realized 4.9;
    // minus the 1-tick taker haircut (10 x 0.01) => 4.8.
    expect(report.columns.base_realized_usd).toBe("4.800000");
    // Stress: 5c per taker share => 4.9 - 0.5 = 4.4.
    expect(report.columns.stress_realized_usd).toBe("4.400000");
    // Optimistic (diagnostic): the denied 10 at 0.40 also resolves at 1.00,
    // adding 6.00 of realized => 10.9 (no haircut by definition).
    expect(report.columns.optimistic_realized_usd).toBe("10.900000");
    expect(Number(report.columns.base_realized_usd)).toBeLessThan(
      Number(report.columns.optimistic_realized_usd),
    );
    expect(report.columns.note).toContain("diagnostic");
    expect(report.baseline_no_trade_usd).toBe("0.000000");
    expect(report.fees_paid_usd).toBe("0.100000");
  });

  it("reports fill rates, taker slippage and markout buckets", async () => {
    const report = await buildPerformanceReport(fakePool());
    expect(report.fill_rates_by_type["FAK"]).toMatchObject({
      orders: 1,
      filled: 1,
      rate: "1.000000",
    });
    expect(report.fill_rates_by_type["GTC"]).toMatchObject({
      orders: 2,
      filled: 0,
      rate: "0.000000",
    });
    // Declared worst 0.52, filled at 0.50: 0.02 per share better.
    expect(report.taker_slippage).toEqual({
      orders: 1,
      avg_predicted_vs_realized_usd: "0.020000",
    });
    expect(report.markouts_by_horizon["60s"]).toEqual({
      fills: 3,
      avg_mid_markout: "-0.012000",
    });
  });
});

describe("optimistic transformation", () => {
  it("turns denials into fills without touching anything else", () => {
    const events: LedgerEventRecord[] = [
      {
        idempotencyKey: "a",
        eventType: "fill_denied_degradation",
        orderId: "o",
        tokenId: "tok",
        conditionId: null,
        payload: { side: "BUY", price: "0.4", size: "10" },
        eventTs: T0,
      },
      {
        idempotencyKey: "b",
        eventType: "mark",
        orderId: null,
        tokenId: "tok",
        conditionId: null,
        payload: {},
        eventTs: T0,
      },
    ];
    const transformed = optimisticEvents(events);
    expect(transformed[0]?.eventType).toBe("fill");
    expect(transformed[0]?.payload["fee"]).toBe("0");
    expect(transformed[1]?.eventType).toBe("mark");
  });
});
