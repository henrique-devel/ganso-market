import { parseTradingAmount } from "@ganso-market/contracts/trading";
import { describe, it, expect } from "vitest";
import {
  accountMetrics,
  compareMetrics,
  type EconomicComparison,
} from "../../src/storage/metrics.js";
import {
  allocatedCosts,
  drawdown,
  normalizedReference,
  ratio,
  utc,
  type CostAllocation,
  type ReferenceInput,
} from "../../src/trading/metrics.js";
import {
  REPLAY_CONTRACTS,
  REPLAY_VERSION,
  sealReplayDataset,
  type ReplayDataset,
} from "../../src/storage/replay-dataset.js";
import {
  genesisBatch,
  materializeLedgerBatch,
} from "../../src/storage/ledger-contract.js";
import {
  identity,
  command,
  fill,
  funding,
  usd,
  iso,
  start,
} from "./ledger-fixture.js";
import { ledgerScope } from "../../src/trading/ledger.js";
import { fixture as baselineFixture, AT } from "./baseline-fixture.js";
import { decideBaseline } from "../../src/storage/baseline-policy.js";
import { replayHash } from "../../src/storage/replay-dataset.js";

function fixture(account = "manual"): ReplayDataset {
  const id = identity(account);
  return {
    schema_version: REPLAY_VERSION,
    contracts: REPLAY_CONTRACTS,
    code_sha: "a".repeat(40),
    cut: {
      captured_at: iso(start + 5000),
      ledger_sequence: "1",
      reservation_sequence: "0",
      semantics: "locked_account_snapshot",
    },
    identity: id,
    ledger: materializeLedgerBatch(genesisBatch(id), "0", iso(start)),
    reservations: [],
    decisions: [],
    jev: [],
    roots: [],
    evidence: [],
  };
}
function traded() {
  const d = fixture();
  const close = fill("exec:2", "sell");
  if (close.event_type !== "fill") throw new Error("fixture");
  const events = [
    command("open", fill()),
    command("fee", {
      event_type: "fee",
      execution_id: "exec:1",
      delta: usd("-100000"),
    }),
    command(
      "close",
      {
        ...close,
        price: parseTradingAmount("USD_PER_BTC", {
          ...close.price,
          raw: "65000000000",
        }),
      },
      undefined,
      start + 3000,
    ),
    command("late", funding(), undefined, start + 1000),
  ];
  for (const [i, event] of events.entries()) {
    d.ledger.push(
      ...materializeLedgerBatch(
        { transaction_id: `tx:${i}`, events: [event] },
        String(d.ledger.length),
        iso(start + (i === 3 ? 4000 : i < 2 ? 2000 : 3000)),
      ),
    );
  }
  d.cut.ledger_sequence = String(d.ledger.length);
  return d;
}
const report = (d = fixture(), cost?: CostAllocation) =>
  accountMetrics(sealReplayDataset(d), cost);
function allocation(): CostAllocation {
  return {
    schema_version: "btc.cost-allocation.v1",
    window: { start: iso(start), end: iso(start + 5000) },
    complete: true,
    basis: "invoice:test:shared equally; no other costs in this fixture",
    bills: [
      {
        id: "invoice:ai",
        kind: "ai",
        total_usd_raw: "6000000",
        shares: [
          { account_id: "manual", usd_raw: "3000000" },
          { account_id: "challenger", usd_raw: "3000000" },
        ],
      },
      {
        id: "invoice:infra",
        kind: "infrastructure",
        total_usd_raw: "2000000",
        shares: [
          { account_id: "manual", usd_raw: "1000000" },
          { account_id: "challenger", usd_raw: "1000000" },
        ],
      },
    ],
  };
}
function reference(
  kind: ReferenceInput["kind"],
  exposure: 0 | 2500 | 10000,
): ReferenceInput {
  return {
    kind,
    exposure_bps: exposure,
    capital_usd_raw: "1000000000",
    window: { start: iso(start), end: iso(start + 5000) },
    prices: {
      start: { at: iso(start), usd_raw: "50000000000", evidence_id: "start" },
      end: {
        at: iso(start + 5000),
        usd_raw: "60000000000",
        evidence_id: "end",
      },
    },
    fees_usd_raw: "0",
    funding_usd_raw: "0",
  };
}
function comparison(
  a: ReturnType<typeof report>,
  b: ReturnType<typeof report>,
): EconomicComparison {
  return {
    schema_version: "btc.economic-comparison.v1",
    baseline_dataset_id: a.dataset_id,
    challenger_dataset_id: b.dataset_id,
    market_dataset_hash: `sha256:${"b".repeat(64)}`,
    baseline_risk_hash: `sha256:${"c".repeat(64)}`,
    challenger_risk_hash: `sha256:${"c".repeat(64)}`,
    declared_version_differences: [],
  };
}

describe("BTC read-only economic metrics", () => {
  it("counts only successful captured real/mock vetoes and keeps uncertain AI charges separate", () => {
    const d = fixture("baseline"),
      decision = decideBaseline(baselineFixture());
    d.cut.captured_at = iso(AT + 1000);
    d.decisions = [{ decision, evidence_id: "decision" }];
    d.decision_selection = { mode: "ids", ids: [decision.decision_id] };
    d.evidence_mode = "references";
    d.roots = ["decision"];
    d.evidence = [
      {
        object_id: "decision",
        class: "decision",
        identity: ledgerScope(d.identity),
        recorded_at: decision.decision_at,
        payload: decision,
        payload_hash: replayHash(decision),
        dependencies: [],
      },
    ];
    d.jev = [
      {
        decision_id: decision.decision_id,
        evidence_id: "decision",
        state: "final",
        origin: "real",
        model: "fixture",
        request_id: "request:1",
        request: {},
        outcome: {
          result: { decision: "veto", reason: "ok", cost_usd6: "1000" },
        },
      },
    ];
    expect(report(d)).toMatchObject({
      trading: { net_pnl_usd_raw: "0" },
      decisions: {
        filter_vetoes: { real: 1, mock: 0 },
        causal_filter_contribution: null,
      },
      operational_costs: {
        captured_real_ai_usd_raw: "1000",
        total_usd_raw: null,
      },
    });
    d.jev[0]!.origin = "mock";
    expect(report(d).decisions.filter_vetoes).toEqual({ real: 0, mock: 1 });
    d.jev[0]!.origin = "real";
    d.jev[0]!.outcome = {
      result: { decision: "veto", reason: "timeout", cost_usd6: null },
    };
    expect(report(d)).toMatchObject({
      decisions: { filter_vetoes: { real: 0, mock: 0 } },
      operational_costs: { captured_unknown_ai_calls: 1 },
    });
  });
  it("preserves zero/negative final equity and losses exceeding the initial capital", () => {
    for (const [fee, equity, ret] of [
      ["-1009750000", "0", "-1000000"],
      ["-1109750000", "-100000000", "-1100000"],
    ]) {
      const d = traded(),
        e = d.ledger[2]!;
      if (e.payload.event_type !== "fee") throw new Error("fixture");
      d.ledger[2] = { ...e, payload: { ...e.payload, delta: usd(fee!) } };
      expect(report(d).trading).toMatchObject({
        equity_usd_raw: equity,
        net_return_ppm: ret,
      });
    }
  });
  it("hand calculation: .01 BTC, 64k→65k: $10 gain - $.10 fee - $.25 funding = $9.65; 2s/5s exposed", () => {
    const r = report(traded(), allocation());
    expect(r.trading).toMatchObject({
      realized_pnl_usd_raw: "10000000",
      fees_usd_raw: "-100000",
      funding_usd_raw: "-250000",
      net_pnl_usd_raw: "9650000",
      net_return_ppm: "9650",
      equity_usd_raw: "1009650000",
    });
    expect(r.turnover).toMatchObject({
      gross_notional_usd_raw: "1290000000",
      initial_capital_multiple_ppm: "1290000",
    });
    expect(r.exposure).toMatchObject({
      exposed_ms: 2000,
      time_exposed_ppm: "400000",
    });
    expect(r.drawdown.max_usd_raw).toBeNull();
    expect(r.equity_curve.status).toBe("missing_equity_history");
    expect(r.equity_curve.points.some((p) => p.equity_usd_raw === null)).toBe(
      true,
    );
    expect(r.after_operational_costs.net_pnl_usd_raw).toBe("5650000");
    expect(r.operational_costs.total_usd_raw).toBe("4000000");
  });
  it("does not turn absent allocation/challenger into zero or block known baseline results", () => {
    const r = report();
    expect(r.trading.net_pnl_usd_raw).toBe("0");
    expect(r.drawdown).toMatchObject({ max_usd_raw: "0", max_ppm: "0" });
    expect(r.after_operational_costs.net_pnl_usd_raw).toBeNull();
    expect(r.operational_costs.ai_usd_raw).toBeNull();
    expect(compareMetrics(r, null).status).toBe("challenger_absent");
    expect(
      report(fixture(), { ...allocation(), bills: [] }).after_operational_costs
        .net_pnl_usd_raw,
    ).toBe("0");
  });
  it("keeps open equity and total return unknown without historical as-of marks", () => {
    const d = traded();
    d.ledger = d.ledger.slice(0, 3);
    d.cut.ledger_sequence = "3";
    const r = report(d);
    expect(r.trading).toMatchObject({
      realized_net_usd_raw: "-100000",
      net_pnl_usd_raw: null,
      equity_usd_raw: null,
      net_return_ppm: null,
    });
    expect(r.exposure.exposed_ms).toBe(4000);
  });
  it("assigns late funding to its UTC economic date but only after its arrival cut", () => {
    const d = traded(),
      r = report(d);
    expect(r.late_funding_event_ids).toEqual(["late"]);
    expect(r.costs_by_economic_utc_day[0]).toEqual({
      day: iso(start).slice(0, 10),
      fees_usd_raw: "-100000",
      funding_usd_raw: "-250000",
    });
    d.ledger.pop();
    d.cut.ledger_sequence = "4";
    d.cut.captured_at = iso(start + 3500);
    expect(report(d).trading.net_pnl_usd_raw).toBe("9900000");
    expect(() => utc("2026-09-26T01:00:00.000-03:00")).toThrow("UTC");
    expect(
      utc("2026-09-27T00:00:00.000Z") - utc("2026-09-26T23:59:59.999Z"),
    ).toBe(1);
  });
  it("calculates drawdown including losses past zero and rejects missing history", () => {
    expect(
      drawdown(["1000000000", "1200000000", "900000000", "1100000000"]),
    ).toMatchObject({ max_usd_raw: "300000000", max_ppm: "250000" });
    expect(drawdown(["100", "0", "-50"])).toMatchObject({
      max_usd_raw: "150",
      max_ppm: "1500000",
    });
    expect(drawdown(["0", "-50"]).max_ppm).toBeNull();
    expect(drawdown(["-10", "-50"]).max_usd_raw).toBe("40");
    expect(drawdown(["100", null, "110"]).max_ppm).toBeNull();
    expect(ratio(1n, 0n)).toBeNull();
    expect(ratio(1n, -10n)).toBeNull();
    expect(ratio(-1n, 3n)).toBe("-333334");
  });
  it("conserves shared costs, forbids duplicate bills and wrong windows, never reallocates a full bill per account", () => {
    const c = allocation(),
      window = c.window;
    const a = allocatedCosts(c, "manual", window.start, window.end),
      b = allocatedCosts(c, "challenger", window.start, window.end);
    expect(BigInt(a.total_usd_raw!) + BigInt(b.total_usd_raw!)).toBe(8000000n);
    c.bills.push(c.bills[0]!);
    expect(() => report(fixture(), c)).toThrow("BILL_ID");
    const bad = allocation();
    bad.bills[0]!.shares[0]!.usd_raw = "3000001";
    expect(() => report(fixture(), bad)).toThrow("CONSERVATION");
    expect(() =>
      report(fixture(), {
        ...allocation(),
        window: { ...window, end: iso(start + 6000) },
      }),
    ).toThrow("COST_SCOPE");
  });
  it("distinguishes 25%/100% spot exposure and perpetual funding", () => {
    expect(normalizedReference(reference("spot", 2500))).toMatchObject({
      quantity_btc_raw: "500000",
      net_pnl_usd_raw: "50000000",
      net_return_ppm: "50000",
    });
    expect(normalizedReference(reference("spot", 10000)).net_return_ppm).toBe(
      "200000",
    );
    expect(
      normalizedReference({
        ...reference("perpetual", 2500),
        fees_usd_raw: "-1000000",
        funding_usd_raw: "-2000000",
      }).net_pnl_usd_raw,
    ).toBe("47000000");
    expect(
      normalizedReference({
        ...reference("perpetual", 2500),
        funding_usd_raw: null,
      }).net_pnl_usd_raw,
    ).toBeNull();
    expect(() =>
      normalizedReference({
        ...reference("spot", 2500),
        funding_usd_raw: "-1",
      }),
    ).toThrow("NO_FUNDING");
    expect(normalizedReference(reference("cash", 0)).net_return_ppm).toBe("0");
  });
  it("does not fabricate prices, allows loss references, rejects lookahead endpoints", () => {
    const ref = reference("spot", 2500);
    expect(
      normalizedReference({ ...ref, prices: null }).net_pnl_usd_raw,
    ).toBeNull();
    ref.prices!.end.usd_raw = "40000000000";
    expect(normalizedReference(ref).net_pnl_usd_raw).toBe("-50000000");
    ref.prices!.end.at = iso(start + 6000);
    expect(() => normalizedReference(ref)).toThrow("PRICE_TIME");
  });
  it("explicitly compares separate accounts/datasets, refuses unannounced versions/windows and labels different risk", () => {
    const a = report(),
      b = report(fixture("challenger")),
      c = comparison(a, b);
    expect(() => compareMetrics(a, b)).toThrow("COMPARISON_DATASETS");
    expect(compareMetrics(a, b, c)).toMatchObject({
      status: "observational_comparison",
      delta: { trading_usd_raw: "0", after_operational_usd_raw: null },
      causal_filter_contribution: null,
    });
    expect(
      compareMetrics(a, b, {
        ...c,
        challenger_risk_hash: `sha256:${"d".repeat(64)}`,
      }),
    ).toMatchObject({ status: "risk_or_capital_differs", delta: null });
    expect(() =>
      compareMetrics(
        a,
        { ...b, versions: { ...b.versions, strategy: "new" } },
        c,
      ),
    ).toThrow("VERSION_DECLARATION");
    expect(() =>
      compareMetrics(
        a,
        {
          ...b,
          scope: {
            ...b.scope,
            window: { ...b.scope.window, end: iso(start + 6000) },
          },
        },
        c,
      ),
    ).toThrow("WINDOW_OR_CONTRACT");
  });
  it("does not count correlated market bars twice or infer independent observations", () => {
    const a = report(),
      b = report(fixture("challenger"));
    a.decisions.market_bar_clusters = [iso(start), iso(start + 1000)];
    b.decisions.market_bar_clusters = [iso(start)];
    expect(compareMetrics(a, b, comparison(a, b))).toMatchObject({
      market_bar_cluster_count: 2,
      independent_observations: null,
    });
  });
  it("does not hide capital flows when a deposit and withdrawal cancel", () => {
    const d = fixture();
    for (const [i, raw] of ["1000000000", "-1000000000"].entries()) {
      d.ledger.push(
        ...materializeLedgerBatch(
          {
            transaction_id: `transfer:${i}`,
            events: [
              command(
                `transfer:${i}`,
                { event_type: "cash", reason: "transfer", delta: usd(raw) },
                ledgerScope(d.identity),
                start + (i + 1) * 1000,
              ),
            ],
          },
          String(d.ledger.length),
          iso(start + (i + 1) * 1000),
        ),
      );
    }
    d.cut.ledger_sequence = "3";
    const a = report(d),
      b = report(fixture("challenger"));
    expect(a).toMatchObject({
      transfers_usd_raw: "0",
      capital_flows_present: true,
      trading: { net_pnl_usd_raw: "0", net_return_ppm: null },
      turnover: { initial_capital_multiple_ppm: null },
    });
    expect(compareMetrics(a, b, comparison(a, b))).toMatchObject({
      status: "risk_or_capital_differs",
      delta: null,
    });
  });
  it("keeps account-level ledger financials with a decision subset and excludes capital transfers from profit", () => {
    const d = fixture();
    d.ledger.push(
      ...materializeLedgerBatch(
        {
          transaction_id: "transfer",
          events: [
            command(
              "deposit",
              {
                event_type: "cash",
                reason: "transfer",
                delta: usd("1000000000"),
              },
              ledgerScope(d.identity),
            ),
          ],
        },
        "1",
        iso(start + 1000),
      ),
    );
    d.cut.ledger_sequence = "2";
    const r = report(d);
    expect(r.trading).toMatchObject({
      net_pnl_usd_raw: "0",
      equity_usd_raw: "2000000000",
      net_return_ppm: null,
    });
    expect(r.drawdown.max_usd_raw).toBe("0");
    expect(r.scope.financial_selection).toBe("complete_account_ledger");
  });
});
