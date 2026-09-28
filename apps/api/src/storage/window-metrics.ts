import { ledgerScope, replayLedger } from "../trading/ledger.js";
import {
  projectFinancials,
  valueFinancials,
  type MarketEvidence,
  type ValuationCapture,
} from "../trading/valuation.js";
import {
  allocatedCosts,
  ratio,
  requireMetric,
  utc,
  type CostAllocation,
} from "../trading/metrics.js";
import {
  replayDataset,
  replayHash,
  type ReplayArtifact,
} from "./replay-dataset.js";
import {
  validateBaselineRegistration,
  baselineHash,
  type BaselineRegistration,
} from "./baseline-inputs.js";
import {
  validateComparisonWindow,
  type ComparisonWindow,
} from "./comparison-window.js";
import type { ChallengerBinding } from "./challenger-operations.js";
import type { EconomicComparison } from "./metrics.js";

export interface WindowComparison extends Omit<
  EconomicComparison,
  "schema_version"
> {
  schema_version: "btc.economic-comparison.v2";
  registration_evidence_id: string;
}
/** Resolve the prospectively persisted registration, never accept dates supplied
 * by a report caller. Old registrations remain v1 and cannot acquire a window. */
function registeredWindow(a: ReplayArtifact, b: ReplayArtifact, id: string) {
  const object = b.dataset.evidence.find((o) => o.object_id === id);
  const p = object?.payload as
    | { registration: BaselineRegistration; challenger: ChallengerBinding }
    | undefined;
  requireMetric(
    object &&
      b.dataset.roots.includes(id) &&
      p?.challenger?.version === "btc.jev-comparison.v2" &&
      p.challenger.evaluation,
    "COMPARISON_REGISTRATION",
  );
  const w = p.challenger.evaluation;
  const sourceObject = b.dataset.evidence.find(
    (o) => o.object_id === w.source_evidence_id,
  );
  const source = (
    sourceObject?.payload as { registration?: BaselineRegistration } | undefined
  )?.registration;
  requireMetric(
    source &&
      sourceObject &&
      object.dependencies.includes(w.source_evidence_id),
    "COMPARISON_SOURCE",
  );
  validateComparisonWindow(w, source);
  validateBaselineRegistration(source);
  validateBaselineRegistration(p.registration);
  requireMetric(
    object.recorded_at === w.registered_at &&
      sourceObject.recorded_at === source.registered_at &&
      source.registered_at <= w.registered_at &&
      p.registration.registered_at === w.registered_at &&
      p.registration.schema_version === "btc.baseline-registration.v2" &&
      p.registration.start_at === w.start_at &&
      p.challenger.comparison_start_at === w.start_at &&
      p.challenger.source_start_at === source.start_at &&
      p.challenger.source_registration_hash === baselineHash(source) &&
      p.challenger.source_account === a.dataset.identity.account.account_id &&
      replayHash(source.scope) ===
        replayHash(ledgerScope(a.dataset.identity)) &&
      replayHash(p.registration.scope) ===
        replayHash(ledgerScope(b.dataset.identity)) &&
      a.dataset.identity.experiment.started_at === source.start_at &&
      b.dataset.identity.experiment.started_at === p.registration.start_at &&
      p.registration.code_sha === w.challenger_code_sha &&
      p.registration.policy_version === w.challenger_policy &&
      p.registration.manifest_fingerprint === w.challenger_manifest,
    "COMPARISON_REGISTRATION_IDENTITY",
  );
  if (w.source_period) {
    const period = b.dataset.evidence.find(
      (o) => o.object_id === w.source_period_evidence_id,
    );
    requireMetric(
      period &&
        object.dependencies.includes(period.object_id) &&
        replayHash(period.payload) === replayHash(w.source_period) &&
        period.recorded_at === w.source_period.registered_at,
      "COMPARISON_SOURCE_PERIOD",
    );
  } else
    requireMetric(
      w.source_period_evidence_id === w.source_evidence_id,
      "COMPARISON_SOURCE_PERIOD",
    );
  return w;
}

function windowMetrics(
  artifact: ReplayArtifact,
  w: ComparisonWindow,
  replay: ReturnType<typeof replayDataset>,
  allocation?: CostAllocation,
) {
  const d = artifact.dataset;
  requireMetric(
    utc(d.cut.captured_at) >= utc(w.end_at) &&
      utc(d.identity.experiment.started_at) <= utc(w.start_at),
    "COMPARISON_WINDOW_NOT_COVERED",
  );
  const boundary = (at: string, opening: boolean) => {
    let events = d.ledger.filter((e) => e.recorded_at <= at);
    // A new account's contractual genesis is its opening endowment. It is not
    // a historical mark. Disclose its later persistence time; admit no other row.
    const genesis = d.ledger[0];
    if (
      !events.length &&
      opening &&
      d.identity.experiment.started_at === at &&
      genesis?.payload.event_type === "cash" &&
      genesis.payload.reason === "initial_allocation"
    )
      events = [genesis];
    requireMetric(events.length > 0, "COMPARISON_OPENING_GENESIS");
    requireMetric(
      events.every((e) => e.occurred_at <= at),
      "COMPARISON_BOUNDARY_LOOKAHEAD",
    );
    const n = events.length;
    requireMetric(
      !d.ledger[n] ||
        d.ledger[n]?.transaction_id !== d.ledger[n - 1]?.transaction_id,
      "COMPARISON_ATOMIC_BOUNDARY",
    );
    const reservations = d.reservations.filter((r) => r.recorded_at <= at);
    const txs = new Set(events.map((e) => e.transaction_id));
    requireMetric(
      d.reservations.every(
        (r) =>
          r.ledger_transaction_id === null ||
          txs.has(r.ledger_transaction_id) === r.recorded_at <= at,
      ),
      "COMPARISON_ATOMIC_BOUNDARY",
    );
    const financials = projectFinancials(
      replayLedger(d.identity, events),
      events,
    );
    const observation = replay.equity_history?.points
      .filter((p) => p.at <= at)
      .at(-1);
    const payload = d.evidence.find(
      (o) => o.object_id === observation?.evidence_id,
    )?.payload as
      | {
          mark: { evidence: string | null };
          capture_evidence_id: string | null;
        }
      | undefined;
    const context = d.evidence.find(
      (o) => o.object_id === payload?.mark.evidence,
    );
    const capture = d.evidence.find(
      (o) => o.object_id === payload?.capture_evidence_id,
    );
    const valued = valueFinancials(financials, {
      as_of: at,
      book: null,
      context: context
        ? {
            object_id: context.object_id,
            payload: context.payload as MarketEvidence["payload"],
          }
        : null,
      capture: capture ? (capture.payload as ValuationCapture) : null,
    });
    const active = [
      ...new Map(
        reservations.map((r) => [r.reservation.order.order_id, r.reservation]),
      ).values(),
    ].filter((r) => r.status === "active");
    const cash = (initial: boolean) =>
      events
        .reduce(
          (sum, e) =>
            sum +
            (e.payload.event_type === "cash" &&
            (e.payload.reason === "initial_allocation") === initial
              ? BigInt(e.payload.delta.raw)
              : 0n),
          0n,
        )
        .toString();
    return {
      at,
      ledger_sequence: events.at(-1)!.sequence,
      ledger_hash: replayHash(events),
      reservation_sequence: String(reservations.length),
      reservation_hash: replayHash(reservations),
      capital_usd_raw: cash(true),
      external_flows_usd_raw: cash(false),
      positions: financials.positions,
      reservations: active,
      reserved_usd_raw: active
        .reduce(
          (n, r) => n + BigInt(r.margin_usd_raw) + BigInt(r.fee_usd_raw),
          0n,
        )
        .toString(),
      balance_usd_raw: financials.balance_usd_raw,
      realized_pnl_usd_raw: financials.realized_pnl_usd_raw,
      fees_usd_raw: financials.fees_usd_raw,
      funding_usd_raw: financials.funding_usd_raw,
      equity_usd_raw: valued.maintenance.equity_usd_raw,
      unrealized_pnl_usd_raw: valued.maintenance.unrealized_pnl_usd_raw,
      mark_quality: valued.maintenance.quality,
      mark_evidence_id: context?.object_id ?? null,
      genesis_recorded_at: genesis!.recorded_at,
    };
  };
  const opening = boundary(w.start_at, true),
    closing = boundary(w.end_at, false);
  const difference = (a: string | null, b: string | null) =>
    a === null || b === null ? null : (BigInt(b) - BigInt(a)).toString();
  const flows = difference(
    opening.external_flows_usd_raw,
    closing.external_flows_usd_raw,
  )!;
  const equityChange = difference(
    opening.equity_usd_raw,
    closing.equity_usd_raw,
  );
  const net =
    equityChange === null ? null : BigInt(equityChange) - BigInt(flows);
  const costs = allocatedCosts(
    allocation,
    d.identity.account.account_id,
    w.start_at,
    w.end_at,
  );
  const selected = d.ledger.filter(
    (e) =>
      BigInt(e.sequence) > BigInt(opening.ledger_sequence) &&
      BigInt(e.sequence) <= BigInt(closing.ledger_sequence),
  );
  const prior = selected.filter((e) => e.occurred_at <= w.start_at);
  const hasFlows = selected.some(
    (e) =>
      e.payload.event_type === "cash" &&
      e.payload.reason !== "initial_allocation",
  );
  return {
    schema_version: "btc.window-metrics.v1",
    dataset_id: artifact.dataset_id,
    units: {
      money: "USD/6",
      quantity: "BTC/8",
      position_cost_basis: "USD/14",
      ratios: "signed_ppm_floor",
      time: "UTC",
    },
    scope: {
      ...ledgerScope(d.identity),
      financial_start_at: d.identity.experiment.started_at,
      window: { start: w.start_at, end: w.end_at },
      attribution: "recorded_after_opening_through_end_inclusive",
    },
    versions: {
      code_sha: d.code_sha,
      contracts: d.contracts,
      strategy: d.identity.experiment.strategy_version,
      manifest_hash: d.identity.experiment.manifest_hash,
    },
    opening,
    closing,
    transfers_usd_raw: flows,
    capital_flows_present: hasFlows,
    trading: {
      realized_pnl_usd_raw: difference(
        opening.realized_pnl_usd_raw,
        closing.realized_pnl_usd_raw,
      ),
      fees_usd_raw: difference(opening.fees_usd_raw, closing.fees_usd_raw),
      funding_usd_raw: difference(
        opening.funding_usd_raw,
        closing.funding_usd_raw,
      ),
      unrealized_change_usd_raw: difference(
        opening.unrealized_pnl_usd_raw,
        closing.unrealized_pnl_usd_raw,
      ),
      net_pnl_usd_raw: net?.toString() ?? null,
      net_return_ppm:
        net === null || hasFlows || opening.equity_usd_raw === null
          ? null
          : ratio(net, BigInt(opening.equity_usd_raw)),
    },
    operational_costs: {
      ...costs,
      allocation_hash: allocation ? replayHash(allocation) : null,
    },
    after_operational_costs: {
      net_pnl_usd_raw:
        net === null || costs.total_usd_raw === null
          ? null
          : (net - BigInt(costs.total_usd_raw)).toString(),
    },
    prior_obligations_received: prior.map((e) => ({
      event_id: e.event_id,
      type: e.payload.event_type,
      occurred_at: e.occurred_at,
      recorded_at: e.recorded_at,
    })),
    post_window_event_count: d.ledger.length - Number(closing.ledger_sequence),
    limitations: [
      "opening_state_reconstructed_from_full_prefix_no_genesis_reset",
      "missing_or_stale_boundary_mark_is_unknown",
      "late_obligations_included_on_arrival_economic_time_preserved",
      "events_received_after_end_excluded_not_forgiven",
      "reservations_not_expenses_slippage_in_fills",
      "no_causal_filter_attribution",
      "full_window_drawdown_requires_window_equity_coverage",
    ],
  };
}

export function compareWindowArtifacts(
  a: ReplayArtifact,
  b: ReplayArtifact,
  c: WindowComparison,
  allocation?: CostAllocation,
) {
  const ar = replayDataset(a),
    br = replayDataset(b);
  requireMetric(
    c.schema_version === "btc.economic-comparison.v2" &&
      c.baseline_dataset_id === a.dataset_id &&
      c.challenger_dataset_id === b.dataset_id,
    "COMPARISON_DATASETS",
  );
  for (const h of [
    c.market_dataset_hash,
    c.baseline_risk_hash,
    c.challenger_risk_hash,
  ])
    requireMetric(/^sha256:[a-f0-9]{64}$/.test(h), "COMPARISON_PROVENANCE");
  requireMetric(
    a.dataset.identity.account.account_id !==
      b.dataset.identity.account.account_id,
    "COMPARISON_ACCOUNTS",
  );
  requireMetric(
    replayHash(a.dataset.identity.instrument) ===
      replayHash(b.dataset.identity.instrument) &&
      replayHash(a.dataset.contracts) === replayHash(b.dataset.contracts),
    "COMPARISON_WINDOW_OR_CONTRACT",
  );
  const w = registeredWindow(a, b, c.registration_evidence_id);
  const baseline = windowMetrics(a, w, ar, allocation),
    challenger = windowMetrics(b, w, br, allocation);
  const differences = (
    ["code_sha", "strategy", "manifest_hash"] as const
  ).filter(
    (key) =>
      baseline.versions[key] !== challenger.versions[key] ||
      (key === "code_sha" && w.source_code_sha !== w.challenger_code_sha) ||
      (key === "strategy" && w.source_policy !== w.challenger_policy) ||
      (key === "manifest_hash" && w.source_manifest !== w.challenger_manifest),
  );
  requireMetric(
    replayHash([...differences].sort()) ===
      replayHash([...c.declared_version_differences].sort()),
    "COMPARISON_VERSION_DECLARATION",
  );
  const reasons = [
    ...(c.baseline_risk_hash !== c.challenger_risk_hash
      ? ["risk_differs"]
      : []),
    ...(baseline.opening.equity_usd_raw === null ||
    challenger.opening.equity_usd_raw === null
      ? ["opening_equity_unknown"]
      : []),
    ...(baseline.opening.equity_usd_raw !== challenger.opening.equity_usd_raw ||
    baseline.opening.capital_usd_raw !== challenger.opening.capital_usd_raw
      ? ["opening_capital_differs"]
      : []),
    ...(baseline.capital_flows_present || challenger.capital_flows_present
      ? ["external_flows"]
      : []),
    ...(baseline.opening.positions.some((p) => p.quantity_btc_raw !== "0") ||
    challenger.opening.positions.some((p) => p.quantity_btc_raw !== "0") ||
    baseline.opening.reservations.length ||
    challenger.opening.reservations.length
      ? ["opening_exposure_or_reservations"]
      : []),
  ];
  const x = baseline.trading.net_pnl_usd_raw,
    y = challenger.trading.net_pnl_usd_raw;
  const ax = baseline.after_operational_costs.net_pnl_usd_raw,
    ay = challenger.after_operational_costs.net_pnl_usd_raw;
  return {
    schema_version: "btc.window-comparison.v1",
    status: reasons.length
      ? "risk_or_capital_differs"
      : "observational_comparison",
    reasons,
    window: w,
    contract: c,
    baseline,
    challenger,
    delta:
      !reasons.length && x !== null && y !== null
        ? {
            trading_usd_raw: (BigInt(y) - BigInt(x)).toString(),
            after_operational_usd_raw:
              ax === null || ay === null
                ? null
                : (BigInt(ay) - BigInt(ax)).toString(),
          }
        : null,
    causal_filter_contribution: null,
    independent_observations: null,
    provenance_status:
      "persisted_prospective_registration_risk_and_market_hashes_declared_not_external_audit",
  };
}
