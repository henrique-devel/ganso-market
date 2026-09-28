import { order } from "./reservation-fixture.js";
import { reservationHold, release } from "../../src/trading/reservations.js";
import { describe, it, expect } from "vitest";
import { iso, start, usd, funding } from "./ledger-fixture.js";
import { pricedFill } from "./valuation-fixture.js";
import { sealReplayDataset } from "../../src/storage/replay-dataset.js";
import { compareWindowArtifacts } from "../../src/storage/window-metrics.js";
import { accountMetrics, compareMetrics } from "../../src/storage/metrics.js";
import type { CostAllocation } from "../../src/trading/metrics.js";
import { pair } from "./comparison-fixture.js";
describe("prospective common window without financial resets", () => {
  it("different starts compare on the immutable common window; legacy same-start guard remains", () => {
    const f = pair();
    const r = f.report();
    expect(r.status).toBe("observational_comparison");
    expect(r.delta?.trading_usd_raw).toBe("0");
    expect(r.baseline.scope.financial_start_at).not.toBe(
      r.challenger.scope.financial_start_at,
    );
    const { x, y, c } = f.seal();
    expect(() =>
      compareMetrics(accountMetrics(x), accountMetrics(y), {
        ...c,
        schema_version: "btc.economic-comparison.v1",
        declared_version_differences: [],
      }),
    ).toThrow("COMPARISON_WINDOW_OR_CONTRACT");
    expect(f.report()).toEqual(r);
  });
  it("values positions crossing both boundaries; subtracts opening unrealized PnL and flows, includes old funding and fees once", () => {
    const f = pair(true);
    f.a.sample(900000, "74000000000");
    f.a.append(
      { event_type: "cash", reason: "transfer", delta: usd("400000000") },
      start + 1000000,
    );
    f.a.append(funding("-2000000"), start + 1100000, start + 1000);
    f.a.append(
      { event_type: "fee", execution_id: "open", delta: usd("-1000000") },
      start + 1200000,
    );
    f.a.sample(1800000, "84000000000");
    f.a.append(pricedFill("close", "sell"), start + 1800500);
    const costs: CostAllocation = {
      schema_version: "btc.cost-allocation.v1",
      window: { start: f.w.start_at, end: f.w.end_at },
      complete: true,
      basis: "MOCK-bill",
      bills: [
        {
          id: "bill",
          kind: "infrastructure",
          total_usd_raw: "5000000",
          shares: [{ account_id: "baseline", usd_raw: "5000000" }],
        },
      ],
    };
    const r = f.report(costs);
    expect(r.baseline.opening.equity_usd_raw).toBe("1100000000");
    expect(r.baseline.closing.equity_usd_raw).toBe("1597000000");
    expect(r.baseline.trading.net_pnl_usd_raw).toBe("97000000");
    expect(r.baseline.after_operational_costs.net_pnl_usd_raw).toBe("92000000");
    expect(r.baseline.prior_obligations_received).toHaveLength(1);
    expect(r.baseline.post_window_event_count).toBe(1);
    expect(r.delta).toBeNull();
    expect(r.causal_filter_contribution).toBeNull();
  });
  it("missing opening mark is unknown even if the final mark is healthy", () => {
    const f = pair(true);
    f.a.sample(1800000, "84000000000");
    const r = f.report();
    expect(r.baseline.opening.equity_usd_raw).toBeNull();
    expect(r.baseline.trading.net_pnl_usd_raw).toBeNull();
    expect(r.delta).toBeNull();
  });
  it("a close inside the window realizes only change since opening, including the old position cost basis", () => {
    const f = pair(true);
    f.a.sample(900000, "74000000000");
    f.a.append(
      pricedFill("close", "sell", "1000000", "84000000000"),
      start + 1200000,
    );
    const r = f.report();
    expect(r.baseline.trading.net_pnl_usd_raw).toBe("100000000");
  });
  it("opening reservations are disclosed and releasing them is not profit or expense", () => {
    const f = pair();
    const o = order("pending", { valid_until: iso(start + 1800000) }),
      held = reservationHold(o, BigInt(o.quantity_btc_raw));
    f.a.d.reservations = [
      {
        sequence: "1",
        recorded_at: iso(start + 1000),
        request: { action: "reserve", operation_id: "hold", order: o },
        reservation: held,
        ledger_transaction_id: null,
      },
      {
        sequence: "2",
        recorded_at: iso(start + 1200000),
        request: {
          action: "release",
          operation_id: "release",
          order_id: o.order_id,
          reason: "cancelled",
        },
        reservation: release(held, "cancelled"),
        ledger_transaction_id: null,
      },
    ];
    f.a.d.cut.reservation_sequence = "2";
    const r = f.report();
    expect(r.baseline.opening.reservations).toHaveLength(1);
    expect(r.baseline.closing.reserved_usd_raw).toBe("0");
    expect(r.baseline.trading.net_pnl_usd_raw).toBe("0");
    expect(r.delta).toBeNull();
  });
  it("net-zero transfers still disable return/delta; a late charge after end cannot rewrite that cut", () => {
    const f = pair(true);
    f.a.append(pricedFill("close-before", "sell"), start + 2000);
    f.a.append(
      { event_type: "cash", reason: "transfer", delta: usd("1000000") },
      start + 1000000,
    );
    f.a.append(
      { event_type: "cash", reason: "transfer", delta: usd("-1000000") },
      start + 1100000,
    );
    f.a.append(funding("-2000000"), start + 1800500, start + 1000);
    const r = f.report();
    expect(r.baseline.trading.net_pnl_usd_raw).toBe("0");
    expect(r.baseline.trading.net_return_ppm).toBeNull();
    expect(r.baseline.post_window_event_count).toBe(1);
    expect(r.delta).toBeNull();
  });
  it("refuses a prefix containing an economic event beyond the boundary", () => {
    const f = pair();
    f.a.append(
      { event_type: "cash", reason: "transfer", delta: usd("1000000") },
      start + 1000000,
      start + 1000000,
    );
    Object.assign(f.a.d.ledger[1]!, { recorded_at: iso(start + 1000) });
    expect(() => f.report()).toThrow(/before occurrence/);
  });
  it("refuses retroactive, empty, unaligned, expired and falsely thirty-day pilot windows", () => {
    for (const patch of [
      { registered_at: iso(start + 900000) },
      { end_at: iso(start + 900000) },
      { start_at: iso(start + 900001) },
      { end_at: iso(start + 31 * 86400000) },
      { purpose: "economic_evaluation" as const },
    ]) {
      const f = pair();
      Object.assign(f.w, patch);
      expect(() => f.report()).toThrow("COMPARISON_PROSPECTIVE_WINDOW");
    }
  });
  it("refuses incomplete coverage and undeclared version differences; mismatched risk permits only side by side", () => {
    const f = pair();
    const { x, y, c } = f.seal();
    expect(() =>
      compareWindowArtifacts(x, y, { ...c, declared_version_differences: [] }),
    ).toThrow("COMPARISON_VERSION_DECLARATION");
    expect(
      compareWindowArtifacts(x, y, {
        ...c,
        challenger_risk_hash: "sha256:" + "c".repeat(64),
      }).delta,
    ).toBeNull();
    x.dataset.cut.captured_at = iso(start + 900001);
    const short = sealReplayDataset(x.dataset);
    expect(() =>
      compareWindowArtifacts(short, y, {
        ...c,
        baseline_dataset_id: short.dataset_id,
      }),
    ).toThrow("COMPARISON_WINDOW_NOT_COVERED");
  });
});
