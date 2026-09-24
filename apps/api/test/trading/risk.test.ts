import { describe, expect, it } from "vitest";
import {
  breached,
  flowAnchor,
  grossExposure,
  plannedRisk,
  requireRiskCaps,
  riskCheckpoint,
} from "../../src/trading/risk.js";
import { reservationHold } from "../../src/trading/reservations.js";
import { order } from "./reservation-fixture.js";
const now = "2026-09-23T12:00:00.000Z";
const initial = () =>
  riskCheckpoint({
    previous: null,
    now,
    equity: "1000000000",
    external: "0",
    initial_anchor: "1000000000",
    daily_anchor: "1000000000",
    sequence: "1",
    usable: true,
    accounting: true,
  });
describe("S8 fixed account risk policy", () => {
  it.each([150, 500])("pauses at exact %i bps, not one micro before", (bps) => {
    const limit = (1000000000n * (10000n - BigInt(bps))) / 10000n;
    expect(breached(limit + 1n, 1000000000n, bps)).toBe(false);
    expect(breached(limit, 1000000000n, bps)).toBe(true);
    expect(breached(limit - 1n, 1000000000n, bps)).toBe(true);
  });
  it("accepts exact exposure/planned caps, rejects one micro above", () => {
    expect(() =>
      requireRiskCaps("1000000000", 250000000n, 2500000n),
    ).not.toThrow();
    expect(() => requireRiskCaps("1000000000", 250000001n, 2500000n)).toThrow(
      "EXPOSURE_LIMIT",
    );
    expect(() => requireRiskCaps("1000000000", 250000000n, 2500001n)).toThrow(
      "PLANNED_LIMIT",
    );
  });
  it("ceil rounds both fee legs and loss independently", () => {
    expect(
      plannedRisk(
        order("p", {
          quantity_btc_raw: "1",
          price_cap_usd_raw: "65000000001",
          risk_plan: {
            entry_floor_usd_raw: "65000000000",
            stop_price_usd_raw: "64999999999",
          },
        }),
        5,
      ),
    ).toBe(3n);
    expect(() =>
      plannedRisk(
        order("p", {
          fee_bps: 0,
          risk_plan: {
            entry_floor_usd_raw: "65000000000",
            stop_price_usd_raw: "64000000000",
          },
        }),
        5,
      ),
    ).toThrow("FEE_UNDERESTIMATED");
  });
  it("bounds short planned risk from the entry floor with stop above cap", () => {
    const o = order("s", {
      side: "sell",
      quantity_btc_raw: "100000",
      risk_plan: {
        entry_floor_usd_raw: "64000000000",
        stop_price_usd_raw: "66000000000",
      },
    });
    expect(plannedRisk(o, 5)).toBe(2131000n);
    expect(() =>
      plannedRisk(
        {
          ...o,
          risk_plan: {
            entry_floor_usd_raw: "64000000000",
            stop_price_usd_raw: "64000000000",
          },
        },
        5,
      ),
    ).toThrow("PLAN_DIRECTION");
  });
  it("does not count a partial fill twice or deduct holds from equity", () => {
    const o = order("p", { quantity_btc_raw: "300000" });
    expect(
      grossExposure([{ quantity_btc_raw: "100000" }], "65000000000", [
        reservationHold(o, 200000n),
      ]),
    ).toBe(195000000n);
  });
  it("a deposit or withdrawal preserves loss percentages conservatively", () => {
    expect(flowAnchor(1000000000n, 980000000n, 980000000n)).toBe(2000000000n);
    expect(flowAnchor(1000000000n, 980000000n, -490000000n)).toBe(500000000n);
    expect(
      breached(
        1960000000n,
        flowAnchor(1000000000n, 980000000n, 980000000n),
        150,
      ),
    ).toBe(true);
    expect(() => flowAnchor(100n, 0n, 100n)).toThrow("EXTERNAL_FLOW_EQUITY");
  });
  it("recovery/restart and day rollover do not automatically rearm or reset HWM", () => {
    const loss = riskCheckpoint({
      previous: initial(),
      now,
      equity: "950000000",
      external: "0",
      initial_anchor: "0",
      daily_anchor: "0",
      sequence: "2",
      usable: true,
      accounting: true,
    });
    expect(loss.state).toBe("REDUCE_ONLY");
    const recovered = riskCheckpoint({
      previous: JSON.parse(JSON.stringify(loss)),
      now: "2026-09-24T00:00:01.000Z",
      equity: "1000000000",
      external: "0",
      initial_anchor: "0",
      daily_anchor: "1000000000",
      sequence: "2",
      usable: true,
      accounting: true,
    });
    expect(recovered.state).toBe("REDUCE_ONLY");
    expect(recovered.high_water_usd_raw).toBe("1000000000");
    expect(recovered.reasons).toEqual([]);
  });
  it("an unvalued external flow remains halted after recapitalization", () => {
    const base = initial();
    const drained = riskCheckpoint({
      previous: base,
      now,
      equity: "0",
      external: "-1000000000",
      initial_anchor: "0",
      daily_anchor: "0",
      sequence: "2",
      usable: true,
      accounting: true,
    });
    const restored = riskCheckpoint({
      previous: drained,
      now,
      equity: "1000000000",
      external: "0",
      initial_anchor: "0",
      daily_anchor: "0",
      sequence: "3",
      usable: true,
      accounting: true,
    });
    const observed = riskCheckpoint({
      previous: restored,
      now,
      equity: "1000000000",
      external: "0",
      initial_anchor: "0",
      daily_anchor: "0",
      sequence: "3",
      usable: true,
      accounting: true,
    });
    expect(observed.state).toBe("HALTED");
    expect(observed.reasons).toContain("external_flow_unvalued");
  });
});
