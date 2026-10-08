import { requireJev } from "@ganso-market/contracts/trading";
import { jevHash } from "./jev-hash.js";
import { canonicalFingerprint } from "../trading/replay.js";
export const JEV_MANIFEST_VERSION = "btc.jev-manifest.v1" as const;
export function initialJevManifest(horizon: 1 | 3 | 5) {
  requireJev([1, 3, 5].includes(horizon), "HORIZON");
  return {
    schema_version: JEV_MANIFEST_VERSION,
    horizon_minutes: horizon,
    decision: {
      criteria_version: "jev.principal.v1",
      instruction:
        "Avalie direção long/short e intenção abrir/manter/encerrar no horizonte econômico indicado. Vincule a resposta à conta, posição, corte e versão da pergunta. Tamanho, proteção, risco e execução pertencem ao código.",
      model_selection: "pinned_model_required_before_admission",
    },
    context: {
      version: "btc.jev-context.v1",
      book_levels: 5,
      rounding: "ratios_toward_zero_prices_and_depth_floor_atr_ceiling",
      trade_window_seconds: 60,
      bar_interval_ms: 900000,
      bar_count: 15,
      atr_periods: 14,
      atr_formula: "ceil_mean_true_range_14",
      rsi_periods: 14,
      rsi_formula: "simple_gain_loss_14_rate9",
      return_periods: [1, 3, 5],
      return_unit: "RATE9_closed_15m_bars",
      information_set: ["book", "flow", "returns", "atr", "rsi", "funding"],
    },
    freshness: {
      book_ms: 2000,
      mark_funding_ms: 10000,
      account_ms: 2000,
      closed_bar_lag_ms: 910000,
      response_deadline_ms: 1500,
      decision_ttl_ms: 2000,
    },
    cadence: {
      standard_ms: 60000,
      fast_ms: 2000,
      movement_atr_numerator: 1,
      movement_atr_denominator: 2,
      near_stop_atr_numerator: 1,
      near_stop_atr_denominator: 2,
      fast_minimum_ms: 10000,
      fast_maximum_ms: 30000,
      cooldown_ms: 60000,
      requires_open_position: true,
      trigger_families: ["price_atr", "stop_proximity"],
    },
    exits: {
      stop_atr_multiplier: 2,
      atr_capture: "closed_15m_at_entry_decision",
      anchor: "first_fill_price",
      partials: "first_fill_anchor_fixed_quantity_updates_only",
      rounding: "toward_entry_on_venue_grid",
      maximum_holding_ms: 21600000,
      clock_origin: "first_fill",
      stop_trigger: "mark_price",
      native_slippage_reserve_bps: 1000,
      reduce_only: true,
      take_profit: false,
      trailing: false,
      trend_exit: false,
    },
    risk: {
      entry_risk_bps: 100,
      exposure_bps: 5000,
      daily_loss_bps: 200,
      drawdown_usd_raw: "12500000",
      leverage: 1,
      margin: "isolated",
      pyramid: false,
      reverse: false,
    },
    execution: {
      entry: "post_only",
      exit: "IOC_reduce_only",
      maker_wait_after_ack_ms: 2000,
      paper_latency_ms: 1000,
      stress_latency_ms: 2000,
      stress_fee_multiplier: 2,
    },
    generator: {
      one_component_only: true,
      horizon_minutes: [1, 3, 5],
      trade_window_seconds: [30, 60, 120],
      information_sets: [
        ["book", "flow", "returns", "atr", "rsi", "funding"],
        ["book", "flow", "returns", "atr", "funding"],
      ],
      criteria_versions: ["jev.principal.v1"],
      frozen_components: [
        "freshness",
        "cadence",
        "exits",
        "risk",
        "execution",
        "generator",
      ],
    },
  } as const;
}
type InitialManifest = ReturnType<typeof initialJevManifest>;
export type JevManifest = Omit<InitialManifest, "context"> & {
  context: Omit<
    InitialManifest["context"],
    "trade_window_seconds" | "information_set"
  > & {
    trade_window_seconds: 30 | 60 | 120;
    information_set: readonly (
      "book" | "flow" | "returns" | "atr" | "rsi" | "funding"
    )[];
  };
};
/** Only approved template/ranges can be material changes. Version/hash binds every value. */
export function validateJevManifest(value: JevManifest): string {
  const baseline = initialJevManifest(value.horizon_minutes);
  for (const key of [
    "schema_version",
    "freshness",
    "cadence",
    "exits",
    "risk",
    "execution",
    "generator",
  ] as const)
    requireJev(
      canonicalFingerprint(value[key]) === canonicalFingerprint(baseline[key]),
      "FROZEN_MANIFEST",
    );
  requireJev(
    Object.keys(value).sort().join() === Object.keys(baseline).sort().join(),
    "MANIFEST_SHAPE",
  );
  requireJev(
    [30, 60, 120].includes(value.context.trade_window_seconds as number),
    "CONTEXT_WINDOW",
  );
  requireJev(
    baseline.generator.information_sets.some(
      (set) =>
        canonicalFingerprint(set) ===
        canonicalFingerprint(value.context.information_set),
    ),
    "INFORMATION_SET",
  );
  const normalized = {
    ...value,
    context: {
      ...value.context,
      trade_window_seconds: 60,
      information_set: baseline.context.information_set,
    },
  };
  requireJev(
    canonicalFingerprint(normalized) === canonicalFingerprint(baseline),
    "MANIFEST_TEMPLATE",
  );
  return jevHash(value);
}
export function validateJevSuccessor(previous: JevManifest, next: JevManifest) {
  const previousHash = validateJevManifest(previous),
    nextHash = validateJevManifest(next);
  const components = (m: JevManifest) => [
    m.horizon_minutes,
    m.context.trade_window_seconds,
    m.context.information_set,
    m.decision,
  ];
  const a = components(previous),
    b = components(next);
  requireJev(
    previousHash !== nextHash &&
      a.filter((v, i) => canonicalFingerprint(v) !== canonicalFingerprint(b[i]))
        .length === 1,
    "ONE_COMPONENT_CHANGE",
  );
  return nextHash;
}
