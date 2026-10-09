/** Read-only presentation contract. USD6 values are never summed across banks. */
export interface JevPanelMetrics {
  as_of: string;
  capital_usd6: string;
  risk_equity_usd6: string | null;
  trading: {
    realized_usd6: string;
    open_usd6: string | null;
    fees_usd6: string;
    funding_usd6: string;
    pnl_usd6: string | null;
    funding_complete: boolean;
  };
  attributed_jev_usd6: string | null;
  strategy_after_jev_usd6: string | null;
  conservative_result_usd6: string | null;
  quality: string;
  positions: { position_id: string; quantity_btc_raw: string }[];
}
export interface JevPanelDecision {
  request_id: string;
  started_at: string;
  finished_at: string | null;
  model: string;
  questions_version: string;
  reason: string;
  latency_ms: number | null;
  context_id: string;
  direction: {
    choice: string;
    confidence: number;
    probabilities: Record<string, number>;
  } | null;
  intent: {
    choice: string;
    confidence: number;
    probabilities: Record<string, number>;
  } | null;
  attributed_cost_usd6: string | null;
}
export interface JevPanelExecution {
  observed_at: string;
  reason: string;
  maker: {
    status: string;
    order_id: string;
    filled_btc_raw: string;
    planned_btc_raw: string;
    ack_at: string | null;
    cancel_at: string | null;
  } | null;
  protection: {
    direction: string;
    quantity_btc_raw: string;
    stop_price_raw: string;
    maximum_exit_at: string;
  } | null;
  close: { pending: boolean; requested_at: string } | null;
}
export interface JevPlatformCosts {
  month: string;
  scope: "captured_principal_requests_only";
  invoice_complete: false;
  captured_requests: number;
  unknown_requests: number;
  known_jev_usd6: string;
  captured_jev_usd6: string | null;
  infrastructure_usd6: string | null;
  captured_total_usd6: string | null;
}
export interface JevPanelAccount {
  account_id: string;
  mode: "paper" | "stress" | "live";
  profile_id: string;
  profile_version: string;
  manifest_hash: string;
  horizon_minutes: number;
  admitted: boolean;
  entries_paused: boolean;
  intervention?: {
    action: string;
    recorded_at: string;
    status: "pending_reconciliation" | "reconciled_flat";
  };
  metrics: JevPanelMetrics | null;
  fills?: {
    execution_id: string;
    order_id: string;
    position_id: string;
    side: "buy" | "sell";
    occurred_at: string;
    kind: "maker" | "IOC";
    quantity_btc_raw: string;
    price_usd_raw: string;
    fee_usd_raw: string;
  }[];
  decisions?: JevPanelDecision[];
  execution?: JevPanelExecution | null;
  risk: {
    observed_at: string;
    day: string;
    daily_anchor_usd_raw: string | null;
    equity_usd_raw: string | null;
    high_water_usd_raw: string;
    drawdown_floor_usd_raw: string;
    daily_pause_day: string | null;
    drawdown_blocked: boolean;
    entries_paused: boolean;
    reasons: string[];
  } | null;
  evaluation: { state: string; as_of: string; evidence_id: string } | null;
}
export interface JevQueueProposal {
  proposal_id: string;
  fingerprint: string;
  profile_id: string;
  profile_version: string;
  reason: string;
  horizon_minutes: 1 | 3 | 5;
  rank: number;
  cost_usd6: string | null;
  origin: "real" | "mock";
}
export interface JevQueueSnapshot {
  revision: string;
  proposal_ids: string[];
  proposals: JevQueueProposal[];
}
export interface JevPanelSnapshot {
  queue?: JevQueueSnapshot;
  schema_version: "jev.panel.v1";
  as_of: string;
  accounts: JevPanelAccount[];
  readiness?: {
    schema_version: string;
    status: string;
    reasons: string[];
    observed_at: string | null;
    engine_version: string;
    code_sha: string | null;
    resources: {
      scope: string;
      rss_bytes: number;
      cpu_user_us: number;
      cpu_system_us: number;
    } | null;
    qualification: {
      status: string;
      qualified: boolean;
      start_at: string | null;
      end_at: string | null;
      evidence_id: string | null;
      exercised: Record<string, boolean> | null;
    };
    operational_admission: false;
  };
  platform?: JevPlatformCosts;
  live_activation_available: false;
  alternative_banks_summable: false;
}
