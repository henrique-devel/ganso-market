import { describe, it, expect } from "vitest";
import {
  projectJevLiveMetrics,
  type LivePanelSource,
} from "../../src/storage/jev-live-metrics.js";
import { liveSnapshot, liveIdentity } from "../venues/live-fixture.js";
import { jevHash } from "../../src/storage/jev-hash.js";
const now = Date.parse("2026-10-10T03:00:00.000Z"),
  at = new Date(now).toISOString();
function source(open: string, quantity = "10000"): LivePanelSource {
  const snapshot = liveSnapshot(now - 50, {
    trading_balance_raw: "253550000",
    equity_raw: (253550000n + BigInt(open)).toString(),
    open_pnl_raw: open,
    position_raw: quantity,
  });
  return {
    identity_hash: jevHash(liveIdentity),
    snapshot,
    opening_at: new Date(now - 10000),
    pilot: null,
    gap: false,
    proof: {
      version: "hyperliquid.live-balance.v1",
      identity_hash: snapshot.identity_hash,
      snapshot_id: snapshot.snapshot_id,
      opening_evidence_id: "initial-flat",
      expected_trading_balance_raw: "253550000",
      observed_trading_balance_raw: "253550000",
      reconciled: true,
      reason: "RECONCILED",
    },
  };
}
const flows = { realized: "3500000", fees: "150000", funding: "200000" };
describe("JE17 independent venue arithmetic in USD6", () => {
  it.each(["10000", "-10000"])(
    "uses reconciled long/short cash, excludes positive open PnL and keeps JEV outside risk: %s",
    (quantity) => {
      const result = projectJevLiveMetrics({
        at,
        source: source("2000000", quantity),
        flows,
        attributed_jev: "50000",
      });
      expect(result).toMatchObject({
        risk_equity_usd6: "255550000",
        trading_balance_usd6: "253550000",
        strategy_after_jev_usd6: "5500000",
        conservative_result_usd6: "3500000",
        trading: { pnl_usd6: "5550000", fees_usd6: "150000" },
        positions: [{ quantity_btc_raw: quantity }],
      });
    },
  );
  it("includes negative open PnL and signed negative funding", () => {
    const s = source("-2000000");
    s.snapshot!.trading_balance_raw = "253150000";
    s.snapshot!.equity_raw = "251150000";
    s.proof!.observed_trading_balance_raw = "253150000";
    s.proof!.expected_trading_balance_raw = "253150000";
    const result = projectJevLiveMetrics({
      at,
      source: s,
      flows: { ...flows, funding: "-200000" },
      attributed_jev: "50000",
    });
    expect(result.strategy_after_jev_usd6).toBe("1100000");
    expect(result.conservative_result_usd6).toBe("1100000");
    expect(result.risk_equity_usd6).toBe("251150000");
  });
  it("unknown JEV affects economics, not proven trading equity", () => {
    const result = projectJevLiveMetrics({
      at,
      source: source("2000000"),
      flows,
      attributed_jev: null,
    });
    expect(result.strategy_after_jev_usd6).toBeNull();
    expect(result.trading.pnl_usd6).toBe("5550000");
    expect(result.risk_equity_usd6).toBe("255550000");
    expect(result.reasons).toContain("LIVE_JEV_COST_UNKNOWN");
  });
  it.each(["stale", "gap", "balance", "history", "margin"])(
    "does not turn %s into zeros or current results",
    (failure) => {
      const s = source("2000000");
      if (failure === "stale") s.snapshot!.venue_at = now - 2001;
      if (failure === "gap") s.gap = true;
      if (failure === "balance") s.snapshot!.trading_balance_raw = "999999999";
      if (failure === "history") s.snapshot!.history_complete = false;
      if (failure === "margin") s.snapshot!.isolated_1x = false;
      const r = projectJevLiveMetrics({
        at,
        source: s,
        flows,
        attributed_jev: "50000",
      });
      expect(r.risk_equity_usd6).toBeNull();
      expect(r.trading.realized_usd6).toBeNull();
      expect(r.trading.pnl_usd6).toBeNull();
      expect(r.positions).toEqual([]);
      expect(r.source_as_of).not.toBeNull();
    },
  );
  it("absence of sources never invents capital, flat or funding zero", () => {
    const r = projectJevLiveMetrics({
      at,
      source: null,
      flows: { realized: "0", fees: "0", funding: "0" },
      attributed_jev: "0",
    });
    expect(r.capital_usd6).toBeNull();
    expect(r.trading.funding_usd6).toBeNull();
    expect(r.positions).toEqual([]);
  });
});
