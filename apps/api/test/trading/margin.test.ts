import { describe, expect, it } from "vitest";
import {
  maintenanceMargin,
  projectIsolatedMargin,
  validMarginMetadata,
} from "../../src/trading/margin.js";
import { financial, history, pricedFill } from "./valuation-fixture.js";
import { funding, usd, iso, start } from "./ledger-fixture.js";
import { marginMetadata } from "./margin-fixture.js";
import type { LedgerPayload } from "../../src/storage/ledger-contract.js";
const at = start + 100_000;
const meta = marginMetadata(at);
const open = (side: "buy" | "sell" = "buy") => pricedFill("open", side);
const fee = (delta: string): LedgerPayload => ({
  event_type: "fee",
  execution_id: "open",
  delta: usd(delta),
});
function project(events: LedgerPayload[], mark: string | null = "65000000000") {
  return projectIsolatedMargin(
    financial(events),
    history(events),
    mark,
    meta,
    iso(at),
  );
}
describe("isolated 1x margin independent arithmetic", () => {
  it("does not liquidate a funded 1x long merely because its mark collapses", () => {
    const p = project([open()], "1000000");
    expect(p.positions[0]).toMatchObject({
      allocated_usd_raw: "640000000",
      equity_usd_raw: "10000",
      maintenance_usd_raw: "125",
      liquidatable: false,
    });
    expect(p.free_cash_usd_raw).toBe("360000000");
  });
  it("short liquidation level at 40x max tier is 128000/1.0125, not entry or stop", () => {
    expect(
      project([open("sell")], "126419000000").positions[0]!.liquidatable,
    ).toBe(false);
    expect(
      project([open("sell")], "126420000000").positions[0]!.liquidatable,
    ).toBe(true);
  });
  it.each(["buy", "sell"] as const)(
    "funding consumes the %s position's own budget",
    (side) => {
      const p = project([open(side), funding("-639000000")], "64000000000");
      expect(p.positions[0]).toMatchObject({
        collateral_usd_raw: "1000000",
        maintenance_usd_raw: "8000000",
        liquidatable: true,
      });
      expect(p.free_cash_usd_raw).toBe("360000000");
      expect(p.balance_usd_raw).toBe("361000000");
    },
  );
  it("opening fee can make a near-zero long liquidatable", () => {
    expect(
      project([open(), fee("-300000")], "10000000").positions[0],
    ).toMatchObject({
      equity_usd_raw: "-200000",
      deficit_usd_raw: "200000",
      liquidatable: true,
    });
  });
  it("retains budget and PnL on partial close, then returns only residual", () => {
    const part = [open(), pricedFill("part", "sell", "400000", "65000000000")];
    expect(project(part).positions[0]).toMatchObject({
      collateral_usd_raw: "644000000",
      quantity_btc_raw: "600000",
    });
    expect(project(part).free_cash_usd_raw).toBe("360000000");
    const closed = project([
      ...part,
      pricedFill("end", "sell", "600000", "65000000000"),
    ]);
    expect(closed.positions[0]!.residual_usd_raw).toBe("650000000");
    expect(closed.free_cash_usd_raw).toBe("1010000000");
  });
  it("gap deficit stays separate from unallocated cash and reconciles raw ledger balance", () => {
    const p = project([
      open("sell"),
      pricedFill("gap", "buy", "1000000", "140000000000"),
    ]);
    expect(p).toMatchObject({
      free_cash_usd_raw: "360000000",
      closed_deficit_usd_raw: "120000000",
      balance_usd_raw: "240000000",
      rounding_residual_usd_raw: "0",
    });
    expect(p.positions[0]!.residual_usd_raw).toBe("0");
  });
  it("delayed funding after close adjusts that residual without a second cash debit", () => {
    const p = project([
      open(),
      pricedFill("close", "sell"),
      funding("-250000"),
    ]);
    expect(p.positions[0]!.residual_usd_raw).toBe("639750000");
    expect(p.free_cash_usd_raw).toBe(p.balance_usd_raw);
  });
  it("does not infer maintenance from an unknown mark", () => {
    expect(project([open()], null).positions[0]).toMatchObject({
      maintenance_usd_raw: null,
      equity_usd_raw: null,
      deficit_usd_raw: null,
      liquidatable: false,
    });
  });
  it("rejects a reused position identity and reversal history", () => {
    expect(
      project([open(), pricedFill("close", "sell"), pricedFill("reuse", "buy")])
        .compatible,
    ).toBe(false);
    expect(
      project([open(), pricedFill("reverse", "sell", "2000000")]).compatible,
    ).toBe(false);
  });
  it("integrates cumulative tier deductions exactly with one final upward rounding", () => {
    const tiers = [
      {
        lower_bound: usd("0"),
        max_leverage: 3,
        maintenance_rate: { numerator: "1", denominator: "6" },
      },
      {
        lower_bound: usd("100000000"),
        max_leverage: 2,
        maintenance_rate: { numerator: "1", denominator: "4" },
      },
    ];
    expect(maintenanceMargin(100000000n * 100000000n, tiers)).toBe(16666667n);
    expect(maintenanceMargin(200000000n * 100000000n, tiers)).toBe(41666667n);
    expect(maintenanceMargin(1n, tiers)).toBe(1n);
  });
  it.each(["missing", "old", "future", "version", "fraction", "tiers", "fee"])(
    "fails closed for %s metadata",
    (kind) => {
      const m = structuredClone(meta);
      if (kind === "old")
        m.instrument.origin = {
          ...m.instrument.origin,
          received_at: iso(at - 86_400_001),
        };
      if (kind === "future")
        m.instrument.origin = {
          ...m.instrument.origin,
          received_at: iso(at + 1),
        };
      if (kind === "version")
        m.instrument = { ...m.instrument, instrument_version: "wrong" };
      if (kind === "fraction")
        Object.assign(m.margin.tiers[0]!.maintenance_rate, {
          denominator: "79",
        });
      if (kind === "tiers") Object.assign(m.margin, { tiers: [] });
      if (kind === "fee") Object.assign(m.fees.taker, { decimals: 6 });
      expect(
        validMarginMetadata(
          kind === "missing" ? null : m,
          financial([]).ledger.scope,
          iso(at),
        ),
      ).toBe(false);
    },
  );
});
