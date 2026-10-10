/** Read-only presentation contract. USD6 values are never summed across banks. */
export interface JevPanelMetrics {
  as_of: string;
  capital_usd6: string | null;
  risk_equity_usd6: string | null;
  trading: {
    realized_usd6: string | null;
    open_usd6: string | null;
    fees_usd6: string | null;
    funding_usd6: string | null;
    pnl_usd6: string | null;
    funding_complete: boolean;
  };
  attributed_jev_usd6: string | null;
  strategy_after_jev_usd6: string | null;
  conservative_result_usd6: string | null;
  quality: string;
  source?: "hyperliquid_live_reconciled";
  source_as_of?: string | null;
  snapshot_id?: string | null;
  reasons?: string[];
  trading_balance_usd6?: string | null;
  high_water_usd6?: string | null;
  positions: { position_id: string; quantity_btc_raw: string }[];
}
export interface JevPanelDecision {
  profile_id?: string;
  profile_version?: string;
  experiment_id?: string;
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
  control_available?: boolean;
  intervention?: {
    action: string;
    recorded_at: string;
    status:
      | "pending_reconciliation"
      | "cancelling"
      | "reducing"
      | "protected"
      | "reconciled_flat"
      | "unavailable";
    observed_at?: string;
    position_btc_raw?: string;
    reasons?: string[];
  };
  metrics: JevPanelMetrics | null;
  live_state?: JevPanelLiveState;
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
export interface JevLiveHistoryCursor {
  started_at: string;
  experiment_id: string;
}
export interface JevPanelLiveState {
  version: "jev.live-account-panel.v1";
  source_as_of: string | null;
  position_btc_raw: string | null;
  orders: {
    order_id: string;
    side: string;
    quantity_btc_raw: string;
    limit_price_usd6: string;
    reduce_only: boolean;
    position_stop: boolean;
  }[];
  orders_truncated: boolean;
  receipts: {
    operation_id: string;
    kind: string;
    state: string;
    observed_at: string | null;
    order_id: string | null;
    planned_btc_raw: string | null;
    filled_btc_raw: string;
    profile_id: string;
    profile_version: string;
    experiment_id: string;
  }[];
  protection: {
    state: "confirmed" | "pending" | "flat" | "unavailable";
    observed_at: string | null;
    quantity_btc_raw: string | null;
    stop_price_usd6: string | null;
    maximum_exit_at: string | null;
  };
  funding: { key: string; occurred_at: string; amount_usd6: string }[];
  runtime: {
    observed_at: string;
    current: boolean;
    connected: boolean;
    entries_ready: boolean;
    reasons: string[];
  } | null;
  history: {
    experiment_id: string;
    profile_id: string;
    profile_version: string;
    start_at: string;
    end_at: string | null;
    realized_usd6: string | null;
    fees_usd6: string | null;
    funding_usd6: string | null;
    attributed_jev_usd6: string | null;
    realized_after_jev_usd6: string | null;
  }[];
  history_next_cursor: string | null;
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
export interface JevLivePanel {
  version: string;
  limits: {
    capital_usd6: string;
    entry_risk_bps: number;
    exposure_bps: number;
    daily_loss_bps: number;
    drawdown_usd6: string;
    leverage: number;
    margin: string;
  };
  identity_hash: string | null;
  pilot_sequence: string;
  activated: boolean;
  can_activate: boolean;
  can_rearm: boolean;
  reasons: string[];
  equity_usd6: string | null;
  high_water_usd6: string | null;
  global_blocked: boolean;
  promotion: {
    sequence: string;
    state: "active" | "draining" | "waiting";
    profile_id: string;
    profile_version: string;
    experiment_id: string;
  } | null;
}
export interface JevPanelSnapshot {
  live?: JevLivePanel;
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
  live_activation_available: boolean;
  alternative_banks_summable: false;
}
