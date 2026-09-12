// DATA-02: no horizon/closure has yet been proved safe for evidence pruning.
// Explicit, versioned policy. Unknown objects fail closed; quotas are monitoring.
export const RETENTION_POLICY_VERSION = "data-02-v1";
export const RETENTION_LOCK_NAMESPACE = 741041;
export const RETENTION_LOCK_KEY = 2;

export const EVIDENCE_TABLES: readonly string[] = Object.freeze([
  "app_settings",
  "audit_events",
  "fast_config_versions",
  "fast_wallet_state",
  "fundamental_calibration_reports",
  "fundamental_estimates",
  "fundamental_gate_reports",
  "fundamental_labels",
  "fundamental_model_events",
  "fundamental_models",
  "graph_edges",
  "graph_sanity_vetoes",
  "graph_violations",
  "paper_feature_windows",
  "paper_fill_reports",
  "paper_fill_samples",
  "paper_kill_switch",
  "paper_ledger_events",
  "paper_markouts",
  "paper_orders",
  "paper_positions",
  "polymarket_book_deltas",
  "polymarket_book_snapshots",
  "polymarket_book_snapshots_full",
  "polymarket_data_gaps",
  "polymarket_event_markets",
  "polymarket_events",
  "polymarket_macro_calendar",
  "polymarket_macro_releases",
  "polymarket_market_metadata_versions",
  "polymarket_markets",
  "polymarket_oi_holders",
  "polymarket_param_versions",
  "polymarket_resolution_events",
  "polymarket_resolution_input_changes",
  "polymarket_retention_log",
  "polymarket_rtds_1m",
  "polymarket_rtds_prices",
  "polymarket_rule_versions",
  "polymarket_series_1m",
  "polymarket_trades",
  "polymarket_universe_log",
  "portfolio_circuit_breakers",
  "portfolio_config_versions",
  "portfolio_cycle_summary",
  "portfolio_decision_hourly",
  "portfolio_decisions",
  "portfolio_exposures",
  "portfolio_factor_map_versions",
  "portfolio_g2_clock",
  "portfolio_g2_clock_events",
  "portfolio_gate_measurements",
  "portfolio_gate_reports",
  "portfolio_panel_snapshots",
  "portfolio_position_entries",
  "portfolio_state",
  "portfolio_state_events",
  "resolution_adjudication_samples",
  "resolution_clarifications",
  "resolution_layer_divergences",
  "resolution_market_state",
  "resolution_onchain_cursor",
  "resolution_onchain_events",
  "resolution_reports",
  "resolution_runtime_state",
  "resolution_score_versions",
  "resolution_scores",
  "resolution_uma_timeline",
  "strategy_decisions",
]);

// DATA-01 found no runtime consumers, and empty tables only in its snapshot.
// These are review candidates, NEVER a grant to delete rows that appear later.
export const RESIDUAL_TABLES = Object.freeze({
  domain_events: {
    key: "domain_event_id",
    keyType: "bigint",
    time: "received_at",
  },
  event_quarantine: {
    key: "quarantine_id",
    keyType: "bigint",
    time: "received_at",
  },
  bonding_curve_state: { key: "mint", keyType: "text", time: "updated_at" },
  pumpswap_pool_state: { key: "pool", keyType: "text", time: "updated_at" },
} as const);

export const RETENTION_OBJECTS: readonly string[] = Object.freeze(
  [...EVIDENCE_TABLES, ...Object.keys(RESIDUAL_TABLES)].sort(),
);

export function getRetentionProtection(table: string): {
  protected: boolean;
  reason: string;
} {
  if (EVIDENCE_TABLES.includes(table)) {
    return {
      protected: true,
      reason:
        "ECONOMIC_OR_DATASET_CLOSURE_HELD: horizons, anchors and pins require evidence before release",
    };
  }
  if (Object.hasOwn(RESIDUAL_TABLES, table)) {
    return {
      protected: false,
      reason:
        "LEGACY_SOLANA_REVIEW_ONLY: no runtime consumer at DATA-01; new rows require closure/export review",
    };
  }
  return { protected: true, reason: "UNKNOWN_REFERENCE_CLOSURE" };
}
