import { tradingIdempotencyKey } from "@ganso-market/contracts/trading";
import { ledgerScope } from "../../src/trading/ledger.js";
import { dailyFinancialCosts } from "../../src/trading/valuation.js";
import { parseLedgerEvent } from "../../src/storage/ledger-contract.js";
import { describe, expect, it } from "vitest";
import {
  fundingDelta,
  fundingPositions,
  fundingCoverage,
} from "../../src/trading/funding.js";
import { parseFinalFunding } from "../../src/venues/hyperliquid/funding.js";
import { history } from "./valuation-fixture.js";
import { fill, iso, identity } from "./ledger-fixture.js";
import { replayLedger } from "../../src/trading/ledger.js";
import { cut, hour, observation } from "./funding-fixture.js";

describe("economic funding arithmetic and public semantics", () => {
  it.each([
    ["1000000", "100000", "-64000"],
    ["-1000000", "100000", "64000"],
    ["1000000", "-100000", "64000"],
    ["-1000000", "-100000", "-64000"],
    ["1000000", "0", "0"],
  ])("BTC8 %s and RATE9 %s => USD6 %s", (q, r, expected) => {
    expect(fundingDelta(q, "64000000000", r)).toBe(expected);
  });
  it("floors signed cash once; does not discard sub-micro debits or divide hourly rate by eight", () => {
    expect(fundingDelta("1", "1", "1")).toBe("-1");
    expect(fundingDelta("-1", "1", "1")).toBe("0");
    expect(fundingDelta("100000000", "100000000000", "12500")).toBe("-1250000");
  });
  it("uses economic fills and distinguishes before, same millisecond and after cutoff", () => {
    const events = history([fill("a"), fill("b", "sell"), fill("c", "sell")]);
    events[1] = { ...events[1]!, occurred_at: iso(cut - 1) };
    events[2] = { ...events[2]!, occurred_at: iso(cut + 1) };
    events[3] = { ...events[3]!, occurred_at: iso(cut + 2) };
    expect(fundingPositions([...events].reverse(), iso(cut))).toEqual({
      ambiguous: [],
      positions: [{ position_id: "position:1", quantity_btc_raw: "1000000" }],
    });
    expect(fundingPositions(events, iso(cut + 1)).ambiguous).toEqual([
      "position:1",
    ]);
    expect(
      fundingPositions(events, iso(cut + 3)).positions[0]?.quantity_btc_raw,
    ).toBe("-1000000");
  });
  it("preserves final source timestamp including its milliseconds", () => {
    const o = observation();
    expect(parseFinalFunding(o.row, iso(hour), o.received_at)).toEqual({
      cutoff: iso(cut),
      rate_raw: "100000",
      precision: "exact",
    });
    expect(
      parseFinalFunding(
        observation("0.00001234567").row,
        iso(hour),
        o.received_at,
      ).rate_raw,
    ).toBeNull();
  });
  it.each([
    { funding: "0.0001", oraclePx: "64000" },
    { coin: "BTC", time: cut, fundingRate: 0.0001, premium: "0" },
    { coin: "ETH", time: cut, fundingRate: "0.0001", premium: "0" },
    { coin: "BTC", time: cut, fundingRate: "0.041", premium: "0" },
    { coin: "BTC", time: cut + 3600000, fundingRate: "0.0001", premium: "0" },
  ])("refuses nonfinal, incompatible, invalid or out-of-period data", (row) => {
    expect(() => parseFinalFunding(row, iso(hour), iso(cut + 9000))).toThrow();
  });
  it("exposes missing periods and bounded overflow instead of zero funding", () => {
    const events = history([fill()]);
    expect(fundingCoverage(events, [], iso(cut))).toMatchObject({
      status: "pending",
      usable_for_risk: false,
    });
    expect(fundingCoverage(events, [], iso(cut + 800 * 3600000))).toMatchObject(
      { overflow: true, usable_for_risk: false },
    );
    expect(fundingCoverage(history([]), [], iso(cut)).status).toBe("complete");
  });
  it("counts delayed funding in its economic UTC day, exactly once", () => {
    const events = history([fill()]);
    events.push(
      parseLedgerEvent({
        ...events[1]!,
        sequence: "3",
        event_id: "f",
        idempotency_key: tradingIdempotencyKey(
          ledgerScope(identity()),
          "ledger",
          "f",
        ),
        transaction_id: "fund",
        occurred_at: iso(cut),
        recorded_at: iso(cut + 86400000),
        payload: {
          event_type: "funding",
          position_id: "position:1",
          period_start: iso(hour - 3600000),
          period_end: iso(cut),
          delta: { unit: "USD", decimals: 6, raw: "-64000" },
          rate: { unit: "RATE", decimals: 9, raw: "100000" },
          origin: {
            ...identity().instrument.origin,
            kind: "funding",
            source_timestamp: iso(cut),
            received_at: iso(cut + 9000),
          },
        },
      }),
    );
    const ledger = replayLedger(identity(), events);
    expect(dailyFinancialCosts(ledger, events, iso(cut + 10000))).toMatchObject(
      { funding_usd_raw: "-64000", net_realized_costs_usd_raw: "-64000" },
    );
    expect(
      dailyFinancialCosts(ledger, events, iso(cut + 86400000)),
    ).toMatchObject({ funding_usd_raw: "0", net_realized_costs_usd_raw: "0" });
  });
});
