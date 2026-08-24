import { describe, expect, it } from "vitest";

import {
  replayLedger,
  unrealizedPnlUsd,
  type LedgerEventRecord,
} from "../../../src/polymarket/paper/ledger.js";

function event(
  key: string,
  eventType: LedgerEventRecord["eventType"],
  tokenId: string,
  payload: Record<string, unknown>,
  tsMs: number,
): LedgerEventRecord {
  return {
    idempotencyKey: key,
    eventType,
    orderId: null,
    tokenId,
    conditionId: "0xcond",
    payload,
    eventTs: new Date(tsMs),
  };
}

const T0 = 1_787_000_000_000;

const LONG_STORY: LedgerEventRecord[] = [
  event(
    "o1:fill:1",
    "fill",
    "tok",
    { side: "BUY", price: "0.50", size: "10", fee: "0.1" },
    T0,
  ),
  event(
    "o2:fill:2",
    "fill",
    "tok",
    { side: "SELL", price: "0.60", size: "4", fee: "0" },
    T0 + 60_000,
  ),
  event(
    "resolution:tok:9",
    "resolution",
    "tok",
    { outcome_price: "1.000000" },
    T0 + 120_000,
  ),
];

describe("ledger replay accounting", () => {
  it("realizes partial exits against average cost and settles the rest", () => {
    const state = replayLedger(LONG_STORY);
    const position = state.positions.get("tok");
    // Sell 4 at 0.60 vs avg 0.50 realizes 0.40; the remaining 6 shares with
    // cost 3.00 settle at 1.00 realizing 3.00; fees paid 0.10.
    expect(position?.shares).toBe("0.000000");
    expect(position?.feesPaidUsd).toBe("0.100000");
    expect(position?.realizedPnlUsd).toBe("3.300000");
    expect(position?.lockupS).toBe(120);
    expect(state.realizedPnlUsd).toBe("3.300000");
  });

  it("a short realizes proceeds minus buyback and settles at the outcome", () => {
    const state = replayLedger([
      event(
        "s1:fill:1",
        "fill",
        "tok",
        { side: "SELL", price: "0.60", size: "10", fee: "0" },
        T0,
      ),
      event(
        "resolution:tok:9",
        "resolution",
        "tok",
        { outcome_price: "0.000000" },
        T0 + 60_000,
      ),
    ]);
    // Short 10 at 0.60 collects 6.00 of basis; the outcome 0 keeps all of it.
    expect(state.positions.get("tok")?.realizedPnlUsd).toBe("6.000000");
  });

  it("crossing zero opens the remainder at the crossing price", () => {
    const state = replayLedger([
      event(
        "b:fill:1",
        "fill",
        "tok",
        { side: "BUY", price: "0.40", size: "10", fee: "0" },
        T0,
      ),
      event(
        "s:fill:2",
        "fill",
        "tok",
        { side: "SELL", price: "0.50", size: "15", fee: "0" },
        T0 + 1_000,
      ),
    ]);
    const position = state.positions.get("tok");
    // 10 close at +0.10 each; 5 open short at 0.50 (basis 2.50).
    expect(position?.shares).toBe("-5.000000");
    expect(position?.costUsd).toBe("2.500000");
    expect(position?.realizedPnlUsd).toBe("1.000000");
  });
});

describe("ledger replay determinism (RFC-011 mandatory)", () => {
  it("duplicated and out-of-order events reconstruct the same state", () => {
    const canonical = replayLedger(LONG_STORY);
    const shuffled = [
      LONG_STORY[2],
      LONG_STORY[0],
      LONG_STORY[1],
      // Exact duplicates of every event.
      ...LONG_STORY,
    ].filter((item): item is LedgerEventRecord => item !== undefined);
    const replayed = replayLedger(shuffled);
    expect(replayed.eventCount).toBe(canonical.eventCount);
    expect(JSON.stringify([...replayed.positions.entries()])).toBe(
      JSON.stringify([...canonical.positions.entries()]),
    );
    expect(replayed.realizedPnlUsd).toBe(canonical.realizedPnlUsd);
  });

  it("degradation denials and marks never touch the canonical state", () => {
    const withDiagnostics = [
      ...LONG_STORY,
      event(
        "o1:deny:7",
        "fill_denied_degradation",
        "tok",
        { side: "BUY", price: "0.50", size: "99" },
        T0 + 1,
      ),
      event(
        "mark:tok:1",
        "mark",
        "tok",
        { value_usd: "99", stale: false },
        T0 + 2,
      ),
    ];
    expect(replayLedger(withDiagnostics).realizedPnlUsd).toBe(
      replayLedger(LONG_STORY).realizedPnlUsd,
    );
  });
});

describe("unrealized P&L", () => {
  it("longs mark proceeds minus cost; shorts basis minus buyback", () => {
    expect(unrealizedPnlUsd("10", "5", "6.5")).toBe("1.500000");
    expect(unrealizedPnlUsd("-10", "6", "5")).toBe("1.000000");
    expect(unrealizedPnlUsd("0", "0", "1")).toBeNull();
    expect(unrealizedPnlUsd("10", "5", null)).toBeNull();
  });
});
