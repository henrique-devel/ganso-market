import { describe, expect, it } from "vitest";
import { jevCosts, type JevCostRequest } from "../../src/storage/jev-costs.js";
import {
  jevAccountMetrics,
  jevMetricsWindow,
} from "../../src/storage/jev-metrics.js";
import {
  jevScope,
  jevGenesis,
  materializeJevBatch,
} from "../../src/storage/jev-ledger.js";
import { jevIdentity, jevCommand, start, iso, usd } from "./jev-v2-fixture.js";
import { pricedFill, market } from "./valuation-fixture.js";
import { funding } from "./ledger-fixture.js";
import { parseTradingAmount } from "@ganso-market/contracts/trading";
const identity = jevIdentity(),
  scope = jevScope(identity.bindings[0]!.binding, identity.instrument);
const window = { start_at: iso(start), end_at: iso(start + 100000) };
const request: JevCostRequest = {
  request_id: "one",
  purpose: "operation",
  started_at: iso(start + 1000),
  cost_usd6: "100000",
  proposal_id: null,
  participants: [scope, { ...scope, account_id: "stress:h1" }],
};
function events() {
  return [
    ...materializeJevBatch(jevGenesis(identity), "0", iso(start)),
    ...materializeJevBatch(
      {
        transaction_id: "trade",
        events: [
          jevCommand(
            identity,
            "entry",
            pricedFill("entry", "buy", "100000", "64100000000"),
          ),
          jevCommand(
            identity,
            "exit",
            pricedFill("exit", "sell", "40000", "65100000000"),
          ),
          jevCommand(identity, "fee", {
            event_type: "fee",
            execution_id: "entry",
            delta: usd("-200000"),
          }),
          jevCommand(identity, "funding", funding("100000")),
        ],
      },
      "1",
      iso(start + 2000),
    ),
  ];
}
describe("JE08 costs and independent economics", () => {
  it("charges a shared request once globally and fully in each alternative", () => {
    const a = jevCosts([request], scope, window),
      b = jevCosts([request], { ...scope, account_id: "stress:h1" }, window);
    expect(a.platform.jev_usd6).toBe("100000");
    expect(a.evaluation.jev_usd6).toBe("100000");
    expect(b.evaluation.jev_usd6).toBe("100000");
    expect(a.platform.total_usd6).toBeNull();
    expect(a.evaluation.summable_as_platform_bill).toBe(false);
    expect(() => jevCosts([request, request], scope, window)).toThrow(
      /REQUEST/,
    );
  });
  it("failed/unfinished billing is unknown; infra is separate and optional", () => {
    const c = jevCosts(
      [{ ...request, cost_usd6: null }],
      scope,
      window,
      "5000000",
    );
    expect(c.platform.jev_usd6).toBeNull();
    expect(c.evaluation.jev_usd6).toBeNull();
    expect(
      jevCosts([request], scope, window, "5000000").evaluation.jev_usd6,
    ).toBe("100000");
    expect(() =>
      jevCosts(
        [{ ...request, participants: [{ ...scope, owner_id: "other" }] }],
        scope,
        window,
      ),
    ).toThrow(/OWNER/);
    expect(() =>
      jevCosts([{ ...request, cost_usd6: "-1" }], scope, window),
    ).toThrow(/AMOUNT/);
  });
  it("links generation/validation to proposal/profile, full per paper and stress; unlinked remains incomplete", () => {
    const generation = {
      ...request,
      request_id: "generation",
      purpose: "generation_validation" as const,
      proposal_id: "proposal:h1",
      participants: [scope],
    };
    const a = jevCosts([request, generation], scope, window),
      b = jevCosts(
        [request, generation],
        { ...scope, account_id: "stress:h1" },
        window,
      );
    expect(a.platform.jev_usd6).toBe("200000");
    expect(a.evaluation.jev_usd6).toBe("200000");
    expect(b.evaluation.jev_usd6).toBe("200000");
    expect(
      jevCosts([{ ...generation, proposal_id: null }], scope, window),
    ).toMatchObject({
      platform: { jev_usd6: "100000" },
      evaluation: { jev_usd6: null, unresolved_generation_requests: 1 },
    });
  });
  it("partial close/fees/signed late funding and fill slippage are counted once", () => {
    const value = jevAccountMetrics(
      identity,
      events(),
      market(),
      jevCosts([request], scope, window),
      true,
    );
    // 0.0004 BTC closed at +$1000 = $0.40; remaining 0.0006 at +$900 = $0.54.
    expect(value.trading).toMatchObject({
      realized_usd6: "400000",
      open_usd6: "540000",
      fees_usd6: "200000",
      funding_usd6: "100000",
      pnl_usd6: "840000",
    });
    expect(value.risk_equity_usd6).toBe("250840000");
    expect(value.strategy_after_jev_usd6).toBe("740000");
    expect(value.conservative_result_usd6).toBe("200000");
    expect(value.costs.platform.infrastructure_usd6).toBeNull();
    expect(() =>
      jevAccountMetrics(
        identity,
        events(),
        market(),
        jevCosts([request], { ...scope, account_id: "other" }, window),
        true,
      ),
    ).toThrow(/COST_CUT/);
  });
  it("positive open PnL never qualifies; loss does, unknown cost/funding/mark never becomes zero", () => {
    const m = market();
    if (m.context?.payload.payload.kind !== "mark_funding") throw new Error();
    m.context = {
      ...m.context,
      payload: {
        ...m.context.payload,
        payload: {
          ...m.context.payload.payload,
          mark_price: parseTradingAmount("USD_PER_BTC", {
            unit: "USD_PER_BTC",
            decimals: 6,
            raw: "63000000000",
          }),
        },
      },
    };
    const costs = jevCosts([request], scope, window);
    expect(
      jevAccountMetrics(identity, events(), m, costs, true)
        .conservative_result_usd6,
    ).toBe("-460000");
    expect(
      jevAccountMetrics(identity, events(), market(), costs, false)
        .strategy_after_jev_usd6,
    ).toBeNull();
    expect(
      jevAccountMetrics(
        identity,
        events(),
        market(),
        jevCosts([{ ...request, cost_usd6: null }], scope, window),
        true,
      ).conservative_result_usd6,
    ).toBeNull();
    expect(
      jevAccountMetrics(
        identity,
        events(),
        { ...market(), context: null },
        costs,
        true,
      ).trading.open_usd6,
    ).toBeNull();
  });
  it("a rolling cut carries opening PnL and cost basis without a genesis reset", () => {
    const a = jevAccountMetrics(
      identity,
      events(),
      market(),
      jevCosts([request], scope, window),
      true,
    );
    const later = market(start + 110000);
    if (later.context?.payload.payload.kind !== "mark_funding")
      throw new Error();
    later.context = {
      ...later.context,
      payload: {
        ...later.context.payload,
        payload: {
          ...later.context.payload.payload,
          mark_price: parseTradingAmount("USD_PER_BTC", {
            unit: "USD_PER_BTC",
            decimals: 6,
            raw: "66000000000",
          }),
        },
      },
    };
    const b = jevAccountMetrics(
      identity,
      events(),
      later,
      jevCosts([request], scope, { ...window, end_at: later.as_of }),
      true,
    );
    expect(jevMetricsWindow(a, b)).toMatchObject({
      trading_pnl_usd6: "600000",
      conservative_result_usd6: "-540000",
      jev_usd6: "0",
    });
    expect(() =>
      jevMetricsWindow({ ...a, scope: { ...scope, account_id: "other" } }, b),
    ).toThrow(/IDENTITY/);
  });
});
