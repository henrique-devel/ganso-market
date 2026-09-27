import {
  replayDataset,
  replayHash,
  type ReplayArtifact,
} from "./replay-dataset.js";
import {
  allocatedCosts,
  drawdown,
  floor,
  METRICS_VERSION,
  ratio,
  requireMetric,
  utc,
  type CostAllocation,
} from "../trading/metrics.js";
import { record, uint } from "../models/jev-contract.js";

/** Inception-to-cut, complete account ledger. Decision selection never narrows
 * financial performance. No database scan, model call or current-price lookup. */
export function accountMetrics(
  artifact: ReplayArtifact,
  allocation?: CostAllocation,
) {
  const replay = replayDataset(artifact),
    d = artifact.dataset;
  requireMetric(d.ledger.length > 0, "GENESIS_REQUIRED");
  const start = d.identity.experiment.started_at,
    end = d.cut.captured_at;
  const from = utc(start),
    to = utc(end);
  requireMetric(to > from, "WINDOW");
  let capital = 0n,
    transfers = 0n,
    notional14 = 0n,
    exposedMs = 0,
    flatEquity = 0n;
  let lastFill = from,
    lastArrival = from,
    exposureOrder = true,
    everExposed = false,
    capitalFlowsPresent = false;
  const positions = new Map<string, bigint>(),
    curve: (string | null)[] = [];
  const daily = new Map<string, { fees: bigint; funding: bigint }>();
  const exposed = () => [...positions.values()].some((q) => q !== 0n);
  for (let i = 0; i < d.ledger.length; i++) {
    const e = d.ledger[i]!,
      p = e.payload,
      at = utc(e.occurred_at);
    requireMetric(utc(e.recorded_at) >= lastArrival, "ARRIVAL_ORDER");
    lastArrival = utc(e.recorded_at);
    if (p.event_type === "cash") {
      if (p.reason === "initial_allocation") {
        capital += BigInt(p.delta.raw);
        flatEquity += BigInt(p.delta.raw);
      } else {
        transfers += BigInt(p.delta.raw);
        capitalFlowsPresent = true;
      }
    }
    if (p.event_type === "fill") {
      if (at < lastFill) exposureOrder = false;
      if (exposed()) exposedMs += at - lastFill;
      lastFill = at;
      const q = BigInt(p.quantity.raw);
      positions.set(
        p.position_id,
        (positions.get(p.position_id) ?? 0n) + (p.side === "buy" ? q : -q),
      );
      notional14 += q * BigInt(p.price.raw);
      everExposed ||= exposed();
    }
    if (p.event_type === "fee" || p.event_type === "funding") {
      const day = e.occurred_at.slice(0, 10),
        row = daily.get(day) ?? { fees: 0n, funding: 0n };
      row[p.event_type === "fee" ? "fees" : "funding"] += BigInt(p.delta.raw);
      daily.set(day, row);
      flatEquity += BigInt(p.delta.raw);
    }
    // Only committed transaction boundaries. Closed balances are not a substitute
    // for missing intratrade equity. Bound is inherited (4096 ledger rows).
    if (d.ledger[i + 1]?.transaction_id !== e.transaction_id) {
      curve.push(everExposed ? null : flatEquity.toString());
    }
  }
  if (exposed()) exposedMs += to - lastFill;
  const f = replay.financials;
  const realizedNet =
    BigInt(f.realized_pnl_usd_raw) +
    BigInt(f.fees_usd_raw) +
    BigInt(f.funding_usd_raw);
  const net = exposed() ? null : realizedNet;
  const costs = allocatedCosts(
    allocation,
    d.identity.account.account_id,
    start,
    end,
  );
  const after =
    net === null || costs.total_usd_raw === null
      ? null
      : net - BigInt(costs.total_usd_raw);
  const veto = { real: 0, mock: 0 },
    outcomes = { real: 0, mock: 0 };
  const requests = new Set<string>(),
    groups = new Set<string>();
  let capturedAi = 0n,
    unknownAi = 0;
  for (const j of d.jev) {
    const key = `${j.origin}:${j.request_id}`;
    if (requests.has(key)) continue;
    requests.add(key);
    const o = record(j.outcome),
      result = record(o?.result) ?? o;
    if (j.origin === "real") {
      if (j.state === "final" && result && uint(result.cost_usd6))
        capturedAi += BigInt(result.cost_usd6);
      else unknownAi++;
    }
    if (
      j.state === "final" &&
      result?.reason === "ok" &&
      ["allow", "veto", "abstain"].includes(String(result.decision))
    ) {
      const origin = j.origin as "real" | "mock";
      outcomes[origin]++;
      if (result.decision === "veto") veto[origin]++;
    }
  }
  for (const { decision: decision } of d.decisions)
    groups.add(decision.bar_end_at); // Same market bar across scenarios is correlated.
  return {
    schema_version: METRICS_VERSION,
    dataset_id: artifact.dataset_id,
    scope: {
      ...f.ledger.scope,
      window: { start, end },
      financial_selection: "complete_account_ledger",
      decision_selection: replay.decision_selection,
    },
    versions: {
      code_sha: d.code_sha,
      contracts: d.contracts,
      strategy: d.identity.experiment.strategy_version,
      manifest_hash: d.identity.experiment.manifest_hash,
    },
    units: { money: "USD/6", quantity: "BTC/8", ratios: "signed_ppm_floor" },
    capital_usd_raw: capital.toString(),
    transfers_usd_raw: transfers.toString(),
    capital_flows_present: capitalFlowsPresent,
    trading: {
      realized_pnl_usd_raw: f.realized_pnl_usd_raw,
      fees_usd_raw: f.fees_usd_raw,
      funding_usd_raw: f.funding_usd_raw,
      realized_net_usd_raw: realizedNet.toString(),
      equity_usd_raw: exposed() ? null : f.balance_usd_raw,
      net_pnl_usd_raw: net?.toString() ?? null,
      net_return_ppm:
        net === null || capitalFlowsPresent ? null : ratio(net, capital),
      status: exposed()
        ? "missing_as_of_mark"
        : capitalFlowsPresent
          ? "return_unavailable_capital_flows"
          : "available",
    },
    drawdown: drawdown(everExposed ? [...curve, null] : curve),
    exposure: {
      exposed_ms: exposureOrder ? exposedMs : null,
      window_ms: to - from,
      time_exposed_ppm: exposureOrder
        ? ratio(BigInt(exposedMs), BigInt(to - from))
        : null,
      basis: "economic_fill_time_any_nonzero_position",
      status: exposureOrder ? "available" : "nonmonotonic_fill_time",
    },
    turnover: {
      gross_notional_usd_raw: floor(notional14, 100000000n).toString(),
      initial_capital_multiple_ppm: capitalFlowsPresent
        ? null
        : ratio(notional14, capital * 100000000n),
      convention: "sum_absolute_fill_notional_both_sides",
    },
    operational_costs: {
      ...costs,
      allocation_hash: allocation ? replayHash(allocation) : null,
      captured_real_ai_usd_raw: capturedAi.toString(),
      captured_unknown_ai_calls: unknownAi,
      captured_cost_scope: "selected_unique_requests_only_not_account_bill",
    },
    after_operational_costs: {
      net_pnl_usd_raw: after?.toString() ?? null,
      net_return_ppm:
        after === null || capitalFlowsPresent ? null : ratio(after, capital),
    },
    decisions: {
      count: d.decisions.length,
      by_state: Object.fromEntries(
        [...new Set(d.decisions.map((x) => x.decision.state))]
          .sort()
          .map((state) => [
            state,
            d.decisions.filter((x) => x.decision.state === state).length,
          ]),
      ),
      filter_vetoes: veto,
      captured_filter_outcomes: outcomes,
      market_bar_clusters: [...groups].sort(),
      independent_observations: null,
      causal_filter_contribution: null,
    },
    costs_by_economic_utc_day: [...daily]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, row]) => ({
        day,
        fees_usd_raw: row.fees.toString(),
        funding_usd_raw: row.funding.toString(),
      })),
    late_funding_event_ids: replay.late_funding_event_ids,
    input_audit: replay.input_audit,
    limitations: [
      ...replay.limits,
      "drawdown_unavailable_if_any_unmarked_exposure",
      "late_funding_known_only_at_capture_cut",
      "selected_vetoes_are_not_avoided_losses",
      "bar_clusters_not_independent_samples",
      "no_cost_allocation_means_unknown_not_zero",
      "no_scenario_sum",
    ],
  };
}

export interface EconomicComparison {
  schema_version: "btc.economic-comparison.v1";
  baseline_dataset_id: string;
  challenger_dataset_id: string;
  market_dataset_hash: string;
  baseline_risk_hash: string;
  challenger_risk_hash: string;
  /** Name all changed code/strategy/manifest fields intentionally compared. */
  declared_version_differences: ("code_sha" | "strategy" | "manifest_hash")[];
}
/** Explicit authorization of two different account snapshots for economic
 * comparison. This does not weaken requireSameReplayDataset reproducibility. */
export function compareMetrics(
  baseline: ReturnType<typeof accountMetrics>,
  challenger: ReturnType<typeof accountMetrics> | null,
  contract?: EconomicComparison,
) {
  if (!challenger)
    return {
      status: "challenger_absent",
      baseline,
      challenger: null,
      delta: null,
    };
  requireMetric(
    contract &&
      contract.schema_version === "btc.economic-comparison.v1" &&
      contract.baseline_dataset_id === baseline.dataset_id &&
      contract.challenger_dataset_id === challenger.dataset_id,
    "COMPARISON_DATASETS",
  );
  for (const hash of [
    contract.market_dataset_hash,
    contract.baseline_risk_hash,
    contract.challenger_risk_hash,
  ])
    requireMetric(/^sha256:[a-f0-9]{64}$/.test(hash), "COMPARISON_PROVENANCE");
  requireMetric(
    baseline.scope.account_id !== challenger.scope.account_id,
    "COMPARISON_ACCOUNTS",
  );
  requireMetric(
    baseline.scope.window.start === challenger.scope.window.start &&
      baseline.scope.window.end === challenger.scope.window.end &&
      baseline.scope.instrument_id === challenger.scope.instrument_id &&
      baseline.scope.instrument_version ===
        challenger.scope.instrument_version &&
      baseline.schema_version === challenger.schema_version &&
      replayHash(baseline.versions.contracts) ===
        replayHash(challenger.versions.contracts),
    "COMPARISON_WINDOW_OR_CONTRACT",
  );
  const differences = (
    ["code_sha", "strategy", "manifest_hash"] as const
  ).filter((key) => baseline.versions[key] !== challenger.versions[key]);
  requireMetric(
    replayHash([...differences].sort()) ===
      replayHash([...contract.declared_version_differences].sort()),
    "COMPARISON_VERSION_DECLARATION",
  );
  requireMetric(
    !baseline.operational_costs.allocation_hash ||
      !challenger.operational_costs.allocation_hash ||
      baseline.operational_costs.allocation_hash ===
        challenger.operational_costs.allocation_hash,
    "COMPARISON_COST_ALLOCATION",
  );
  const comparable =
    contract.baseline_risk_hash === contract.challenger_risk_hash &&
    baseline.capital_usd_raw === challenger.capital_usd_raw &&
    !baseline.capital_flows_present &&
    !challenger.capital_flows_present;
  const a = baseline.trading.net_pnl_usd_raw,
    b = challenger.trading.net_pnl_usd_raw;
  const ao = baseline.after_operational_costs.net_pnl_usd_raw,
    bo = challenger.after_operational_costs.net_pnl_usd_raw;
  return {
    status: comparable ? "observational_comparison" : "risk_or_capital_differs",
    baseline,
    challenger,
    contract,
    delta:
      comparable && a !== null && b !== null
        ? {
            trading_usd_raw: (BigInt(b) - BigInt(a)).toString(),
            after_operational_usd_raw:
              ao !== null && bo !== null
                ? (BigInt(bo) - BigInt(ao)).toString()
                : null,
          }
        : null,
    market_bar_cluster_count: new Set([
      ...baseline.decisions.market_bar_clusters,
      ...challenger.decisions.market_bar_clusters,
    ]).size,
    independent_observations: null,
    causal_filter_contribution: null,
    provenance_status: "comparison_manifest_declared_not_external_audit",
  };
}
