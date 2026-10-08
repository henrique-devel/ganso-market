import { sizingInput } from "./jev-risk-fixture.js";
import { describe, expect, it } from "vitest";
import {
  jevRiskCheckpoint,
  JEV_RISK_POLICY,
  type JevRiskCheckpoint,
} from "../../src/trading/jev-risk.js";
import { sizeJevEntry, jevSizedOrder } from "../../src/storage/jev-sizing.js";
import { initialJevManifest } from "../../src/storage/jev-manifest.js";
import { jevHash } from "../../src/storage/jev-hash.js";
import { metadata } from "./bars-fixture.js";
import { iso, start } from "./jev-v2-fixture.js";
const m = initialJevManifest(1);
function checkpoint(
  e = "250000000",
  previous: JevRiskCheckpoint | null = null,
  changes: Partial<Parameters<typeof jevRiskCheckpoint>[0]> = {},
) {
  return jevRiskCheckpoint({
    previous,
    now_at: iso(start + 1000),
    ledger_sequence: "1",
    equity_usd_raw: e,
    daily_anchor_usd_raw: "250000000",
    initial_equity_usd_raw: "250000000",
    history_complete: true,
    fresh: true,
    reconciled: true,
    flat: true,
    global_blocked: false,
    ...changes,
  });
}
describe("JEV persistent fixed-dollar risk and independent sizing", () => {
  it("checks before/at/after daily and fixed DD boundaries including growth", () => {
    expect(checkpoint("245000001").entries_paused).toBe(false);
    expect(checkpoint("245000000").reasons).toContain("DAILY_LOSS");
    const peak = checkpoint("270000000");
    expect(peak.drawdown_floor_usd_raw).toBe("257500000");
    expect(checkpoint("257500001", peak).drawdown_blocked).toBe(false);
    expect(checkpoint("257500000", peak).drawdown_blocked).toBe(true);
    expect(checkpoint("257499999", peak).drawdown_blocked).toBe(true);
    expect(JEV_RISK_POLICY.drawdown_usd_raw).toBe("12500000");
  });
  it("daily rearm waits for next UTC, flat, fresh, reconciled and no global block", () => {
    const pause = checkpoint("245000000");
    expect(checkpoint("250000000", pause).entries_paused).toBe(true);
    const next = {
      now_at: iso(start + 86400000),
      daily_anchor_usd_raw: "250000000",
    };
    for (const gate of [
      { flat: false },
      { fresh: false },
      { reconciled: false },
      { global_blocked: true },
    ])
      expect(
        checkpoint("250000000", pause, { ...next, ...gate }).entries_paused,
      ).toBe(true);
    expect(checkpoint("250000000", pause, next).entries_paused).toBe(false);
    const dd = checkpoint("237500000");
    expect(checkpoint("260000000", dd, next).drawdown_blocked).toBe(true);
    expect(checkpoint("260000000", dd, next).high_water_usd_raw).toBe(
      "260000000",
    );
  });
  it("missing midnight evidence never substitutes a later flat equity", () => {
    const before = checkpoint();
    const next = checkpoint("270000000", before, {
      now_at: iso(start + 86400000),
      daily_anchor_usd_raw: null,
    });
    expect(next.entries_paused).toBe(true);
    expect(next.daily_anchor_usd_raw).toBeNull();
    expect(next.high_water_usd_raw).toBe("270000000");
  });
  it.each(["long", "short"] as const)(
    "sizes %s with independent integer enumeration of all costs",
    (direction) => {
      const input = { ...sizingInput, direction };
      const plan = sizeJevEntry(m, metadata, input, "250000000");
      // Independent rational economics: 2ATR and full 10% native tolerance.
      const stop = direction === "long" ? 64600000000n : 65400000000n;
      const exit = direction === "long" ? 58140000000n : 71940000000n;
      const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
      const costs = (q: bigint) => {
        const distance =
          direction === "long" ? 65000000000n - exit : exit - 65000000000n;
        const max = exit > 65000000000n ? exit : 65000000000n;
        return (
          ceil(q * distance, 100000000n) +
          ceil(
            q * 65000000000n * BigInt(metadata.fees.maker.raw),
            100000000000000000n,
          ) +
          ceil(q * max * BigInt(metadata.fees.taker.raw), 100000000000000000n) +
          ceil(q * max * 600000n, 100000000000000000n)
        );
      };
      let expected = 0n;
      for (
        let q = 1000n;
        q * 65000000000n <= 125000000n * 100000000n;
        q += 1000n
      )
        if (costs(q) <= 2500000n) expected = q;
      expect(plan.stop_price_raw).toBe(stop.toString());
      expect(plan.worst_exit_price_raw).toBe(exit.toString());
      expect(plan.quantity_btc_raw).toBe(expected.toString());
      expect(plan.total_risk_usd_raw).toBe(costs(expected).toString());
      expect(costs(expected + 1000n)).toBeGreaterThan(2500000n);
      expect(jevSizedOrder(plan, jevHash(plan)).quantity_btc_raw).toBe(
        plan.quantity_btc_raw,
      );
      expect(() =>
        jevSizedOrder({ ...plan, quantity_btc_raw: "999999" }, jevHash(plan)),
      ).toThrow(/PLAN_HASH/);
    },
  );
  it("stress doubles fees, preserves funding and never tops up to the minimum", () => {
    const stress = sizeJevEntry(
      m,
      metadata,
      { ...sizingInput, scope: { ...sizingInput.scope, mode: "stress" } },
      "250000000",
    );
    const normal = sizeJevEntry(m, metadata, sizingInput, "250000000");
    expect(BigInt(stress.quantity_btc_raw)).toBeLessThanOrEqual(
      BigInt(normal.quantity_btc_raw),
    );
    expect(BigInt(stress.planned_entry_fee_usd_raw)).toBeGreaterThan(
      BigInt(normal.planned_entry_fee_usd_raw),
    );
    expect(() => sizeJevEntry(m, metadata, sizingInput, "10000000")).toThrow(
      /MINIMUM_OR_BUDGET/,
    );
    expect(() =>
      sizeJevEntry(
        m,
        metadata,
        { ...sizingInput, atr14_raw: "32500000000" },
        "250000000",
      ),
    ).toThrow(/STOP/);
  });
  it("refuses unknown costs, invalid price/quantity grids and inexact metadata", () => {
    for (const key of [
      "maker_fee_rate9_raw",
      "exit_fee_rate9_raw",
      "funding_debit_rate9_raw",
    ] as const)
      expect(() =>
        sizeJevEntry(m, metadata, { ...sizingInput, [key]: null }, "250000000"),
      ).toThrow(/UNKNOWN/);
    expect(() =>
      sizeJevEntry(
        m,
        metadata,
        { ...sizingInput, entry_price_raw: "65000000001" },
        "250000000",
      ),
    ).toThrow(/GRID/);
    expect(() =>
      sizeJevEntry(
        m,
        metadata,
        { ...sizingInput, maker_fee_rate9_raw: "0" },
        "250000000",
      ),
    ).toThrow(/COST_RATE/);
    const huge = {
      ...metadata,
      instrument: {
        ...metadata.instrument,
        quantity_step: {
          ...metadata.instrument.quantity_step,
          raw: "100000000" as typeof metadata.instrument.quantity_step.raw,
        },
      },
    };
    expect(() => sizeJevEntry(m, huge, sizingInput, "250000000")).toThrow(
      /MINIMUM_OR_BUDGET/,
    );
  });
});
