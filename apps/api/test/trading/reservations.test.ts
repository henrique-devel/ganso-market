import { describe, expect, it } from "vitest";
import {
  consume,
  positionMargin,
  release,
  reservationHold,
  reserve,
  requireOpeningCapacity,
} from "../../src/trading/reservations.js";
import { validateReservationCommand } from "../../src/storage/reservation-contract.js";
import { valueFinancials } from "../../src/trading/valuation.js";
import { financial, market, pricedFill } from "./valuation-fixture.js";
import { order } from "./reservation-fixture.js";
const flat = () => valueFinancials(financial([]), market());
describe("S3 pure margin and inventory", () => {
  it("reserves full notional collateral plus ceiling fees without changing cash", () => {
    const f = flat(),
      before = structuredClone(f);
    expect(reserve(order(), f, [])).toMatchObject({
      margin_usd_raw: "650000000",
      fee_usd_raw: "650000",
      remaining_btc_raw: "1000000",
    });
    expect(f).toEqual(before);
    expect(
      reservationHold(
        order("tiny", {
          quantity_btc_raw: "1",
          price_cap_usd_raw: "1",
          fee_bps: 1,
        }),
        1n,
      ),
    ).toMatchObject({ margin_usd_raw: "1", fee_usd_raw: "1" });
  });
  it("includes pending orders and estimated fees, never netting opposing orders", () => {
    const f = flat(),
      a = reserve(order(), f, []);
    expect(() =>
      reserve(order("b", { position_id: "b", side: "sell" }), f, [a]),
    ).toThrow("MARGIN_UNAVAILABLE");
    expect(() =>
      reserve(
        order("fee", {
          quantity_btc_raw: "1000000",
          price_cap_usd_raw: "100000000000",
        }),
        f,
        [],
      ),
    ).toThrow("MARGIN_UNAVAILABLE");
  });
  it.each(["buy", "sell"] as const)(
    "splits %s position reduction from opening and never oversells inventory",
    (side) => {
      const f = valueFinancials(financial([pricedFill("a", side)]), market());
      const close = order("exit", {
        side: side === "buy" ? "sell" : "buy",
        intent: "reduce",
        quantity_btc_raw: "600000",
      });
      const a = reserve(close, f, []);
      expect(a.margin_usd_raw).toBe("0");
      expect(() => reserve({ ...close, order_id: "exit2" }, f, [a])).toThrow(
        "INVENTORY_UNAVAILABLE",
      );
      expect(() => reserve({ ...close, intent: "open" }, f, [])).toThrow(
        "SPLIT_REDUCTION_REQUIRED",
      );
    },
  );
  it("uses gross per-position margin, includes untracked S1 positions, and does not pledge unrealized gains", () => {
    const f = valueFinancials(financial([pricedFill("a", "buy")]), market());
    expect(positionMargin(f)).toBe(650_000_000n);
    expect(() =>
      reserve(order("more", { quantity_btc_raw: "550000", fee_bps: 0 }), f, []),
    ).toThrow("MARGIN_UNAVAILABLE");
    const loss = structuredClone(f);
    loss.maintenance.equity_usd_raw = "600000000";
    expect(() => requireOpeningCapacity(loss, [])).toThrow(
      "MARGIN_UNAVAILABLE",
    );
    expect(() =>
      reserve(order("cheap", { price_cap_usd_raw: "64000000000" }), flat(), []),
    ).toThrow("PRICE_CAP_BELOW_MARK");
  });
  it.each(["missing", "stale", "degraded"])(
    "blocks %s finance for openings even with a positive balance",
    (quality) => {
      const m = market();
      if (quality === "missing") m.context = null;
      if (quality === "stale")
        m.as_of = new Date(Date.parse(m.as_of) + 10_001).toISOString();
      if (quality === "degraded")
        m.context!.payload = { ...m.context!.payload, source_timestamp: null };
      const f = valueFinancials(financial([]), m);
      expect(() => reserve(order(), f, [])).toThrow("FINANCE_UNAVAILABLE");
      const exits = valueFinancials(financial([pricedFill("a", "buy")]), m);
      expect(
        reserve(order("exit", { intent: "reduce", side: "sell" }), exits, [])
          .margin_usd_raw,
      ).toBe("0");
    },
  );
  it("retains ceiling on the remaining partial reservation, then explicitly releases", () => {
    const f = flat(),
      a = reserve(order(), f, []);
    const b = consume(a, "400000", "65000000000", "260000", f);
    expect(b).toMatchObject({
      remaining_btc_raw: "600000",
      margin_usd_raw: "390000000",
      fee_usd_raw: "390000",
    });
    expect(release(b, "expired")).toMatchObject({
      status: "expired",
      remaining_btc_raw: "0",
      margin_usd_raw: "0",
      fee_usd_raw: "0",
    });
    expect(consume(a, "1000000", "65000000000", "650000", f).status).toBe(
      "filled",
    );
  });
  it("rejects excessive fills, fee/price overruns and closed orders", () => {
    const f = flat(),
      a = reserve(order(), f, []);
    expect(() => consume(a, "1000001", "65000000000", "0", f)).toThrow(
      "QUANTITY_UNAVAILABLE",
    );
    expect(() => consume(a, "1000000", "65000000001", "0", f)).toThrow(
      "PRICE_CAP",
    );
    expect(() => consume(a, "1000000", "65000000000", "650001", f)).toThrow(
      "FEE_CAP",
    );
    expect(() =>
      consume(release(a, "cancelled"), "1000000", "65000000000", "0", f),
    ).toThrow("ORDER_CLOSED");
  });
  it.each([
    { quantity_btc_raw: "1.0" },
    { quantity_btc_raw: "0" },
    { fee_bps: 0.1 },
    { fee_bps: -1 },
    { price_cap_usd_raw: "1e5" },
    { valid_until: "bad" },
    { extra: true },
    { margin_policy: "leveraged" },
  ])("validates exact adapter contract %j", (change) => {
    expect(() =>
      validateReservationCommand({
        action: "reserve",
        operation_id: "a",
        order: { ...order(), ...change } as ReturnType<typeof order>,
      }),
    ).toThrow("BTC_RESERVATION");
  });
});
