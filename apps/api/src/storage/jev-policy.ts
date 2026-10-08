import {
  assertTradingQuantum,
  parseTradingAmount,
  requireJev,
  type JevScope,
  type TradingInstrumentMetadata,
} from "@ganso-market/contracts/trading";
import { venueGridPrice } from "../trading/price-grid.js";
import { canonicalFingerprint } from "../trading/replay.js";
import { jevTime, type JevAccountContext } from "./jev-context.js";
import { validateJevManifest, type JevManifest } from "./jev-manifest.js";
export interface JevCadenceState {
  schema_version: "btc.jev-cadence.v1";
  manifest_hash: string;
  scope: JevScope;
  observed_at: string;
  mode: "slow" | "fast";
  fast_started_at: string | null;
  cooldown_until: string | null;
  last_decision_at: string | null;
  reference_price_raw: string | null;
}
export function initialJevCadence(
  m: JevManifest,
  scope: JevScope,
  at: string,
): JevCadenceState {
  jevTime(at);
  return {
    schema_version: "btc.jev-cadence.v1",
    manifest_hash: validateJevManifest(m),
    scope,
    observed_at: at,
    mode: "slow",
    fast_started_at: null,
    cooldown_until: null,
    last_decision_at: null,
    reference_price_raw: null,
  };
}
/** Controlled-clock contract only. Persistence/scheduling belongs to JE07. */
export function advanceJevCadence(
  m: JevManifest,
  state: JevCadenceState,
  input: {
    now_at: string;
    account: JevAccountContext | null;
    mark_price_raw: string | null;
    atr14_raw: string | null;
    context_fresh: boolean;
  },
) {
  const now = jevTime(input.now_at),
    cfg = m.cadence;
  requireJev(
    state.schema_version === "btc.jev-cadence.v1" &&
      state.manifest_hash === validateJevManifest(m) &&
      now >= jevTime(state.observed_at),
    "CADENCE_VERSION_OR_CLOCK",
  );
  const next = { ...state, observed_at: input.now_at };
  if (input.account)
    requireJev(
      canonicalFingerprint(input.account.scope) ===
        canonicalFingerprint(state.scope),
      "CADENCE_OWNER",
    );
  const usable =
    !!input.account &&
    input.context_fresh &&
    !input.account.entries_paused &&
    !input.account.risk_blocked &&
    input.account.recovery_ready;
  const position = input.account?.position;
  const triggers: string[] = [];
  if (
    usable &&
    position &&
    input.mark_price_raw !== null &&
    input.atr14_raw !== null
  ) {
    const mark = BigInt(
        parseTradingAmount("USD_PER_BTC", {
          unit: "USD_PER_BTC",
          decimals: 6,
          raw: input.mark_price_raw,
        }).raw,
      ),
      atr = BigInt(
        parseTradingAmount("USD_PER_BTC", {
          unit: "USD_PER_BTC",
          decimals: 6,
          raw: input.atr14_raw,
        }).raw,
      ),
      stop = BigInt(position.stop_price_raw);
    requireJev(mark > 0n && atr >= 0n && stop > 0n, "TRIGGER_AMOUNTS");
    const abs = (v: bigint) => (v < 0n ? -v : v);
    if (atr > 0n) {
      if (
        state.reference_price_raw !== null &&
        abs(mark - BigInt(state.reference_price_raw)) *
          BigInt(cfg.movement_atr_denominator) >=
          atr * BigInt(cfg.movement_atr_numerator)
      )
        triggers.push("price_atr");
      if (
        abs(mark - stop) * BigInt(cfg.near_stop_atr_denominator) <=
        atr * BigInt(cfg.near_stop_atr_numerator)
      )
        triggers.push("stop_proximity");
    }
  }
  if (next.mode === "fast") {
    requireJev(next.fast_started_at !== null, "FAST_START");
    const elapsed = now - jevTime(next.fast_started_at);
    if (
      !usable ||
      !position ||
      elapsed >= cfg.fast_maximum_ms ||
      (elapsed >= cfg.fast_minimum_ms && !triggers.length)
    ) {
      next.mode = "slow";
      next.fast_started_at = null;
      next.cooldown_until = new Date(now + cfg.cooldown_ms).toISOString();
    }
  } else if (
    usable &&
    position &&
    triggers.length &&
    (next.cooldown_until === null || now >= jevTime(next.cooldown_until))
  ) {
    next.mode = "fast";
    next.fast_started_at = input.now_at;
  }
  const interval = next.mode === "fast" ? cfg.fast_ms : cfg.standard_ms;
  const due =
    usable &&
    (next.last_decision_at === null ||
      now - jevTime(next.last_decision_at) >= interval);
  return { state: next, interval_ms: interval, triggers, due };
}
export function recordJevDecision(
  state: JevCadenceState,
  at: string,
  referencePriceRaw: string,
): JevCadenceState {
  requireJev(
    jevTime(at) >= jevTime(state.observed_at) &&
      (state.last_decision_at === null ||
        jevTime(at) >= jevTime(state.last_decision_at)),
    "DECISION_CLOCK",
  );
  requireJev(
    BigInt(
      parseTradingAmount("USD_PER_BTC", {
        unit: "USD_PER_BTC",
        decimals: 6,
        raw: referencePriceRaw,
      }).raw,
    ) > 0n,
    "REFERENCE_PRICE",
  );
  return {
    ...state,
    observed_at: at,
    last_decision_at: at,
    reference_price_raw: referencePriceRaw,
  };
}
export function jevDeadlineStatus(
  m: JevManifest,
  t: {
    context_cut_at: string;
    asked_at: string;
    response_at: string;
    action_at: string;
  },
) {
  validateJevManifest(m);
  const cut = jevTime(t.context_cut_at),
    asked = jevTime(t.asked_at),
    response = jevTime(t.response_at),
    action = jevTime(t.action_at);
  requireJev(
    cut <= asked && asked <= response && response <= action,
    "DEADLINE_CLOCK",
  );
  return {
    usable:
      response - asked <= m.freshness.response_deadline_ms &&
      action - cut <= m.freshness.decision_ttl_ms,
    reason:
      response - asked > m.freshness.response_deadline_ms
        ? "RESPONSE_DEADLINE"
        : action - cut > m.freshness.decision_ttl_ms
          ? "DECISION_STALE"
          : null,
  };
}
export interface JevProtection {
  schema_version: "btc.jev-protection.v1";
  manifest_hash: string;
  scope: JevScope;
  position_id: string;
  direction: "long" | "short";
  first_fill_at: string;
  first_fill_price_raw: string;
  entry_atr14_raw: string;
  stop_price_raw: string;
  quantity_btc_raw: string;
  maximum_exit_at: string;
}
export function initialJevProtection(
  m: JevManifest,
  input: {
    scope: JevScope;
    position_id: string;
    direction: "long" | "short";
    first_fill_at: string;
    first_fill_price_raw: string;
    quantity_btc_raw: string;
    atr14_raw: string;
    atr_captured_at: string;
    decision_at: string;
  },
  metadata: TradingInstrumentMetadata,
): JevProtection {
  const hash = validateJevManifest(m),
    at = jevTime(input.first_fill_at);
  requireJev(
    jevTime(input.atr_captured_at) <= jevTime(input.decision_at) &&
      jevTime(input.decision_at) <= at &&
      input.scope.instrument_id === metadata.instrument.instrument_id &&
      input.scope.instrument_version ===
        metadata.instrument.instrument_version &&
      ["long", "short"].includes(input.direction),
    "PROTECTION_IDENTITY",
  );
  const fill = BigInt(
      parseTradingAmount("USD_PER_BTC", {
        unit: "USD_PER_BTC",
        decimals: 6,
        raw: input.first_fill_price_raw,
      }).raw,
    ),
    atr = BigInt(
      parseTradingAmount("USD_PER_BTC", {
        unit: "USD_PER_BTC",
        decimals: 6,
        raw: input.atr14_raw,
      }).raw,
    );
  const q = parseTradingAmount("BTC", {
    unit: "BTC",
    decimals: 8,
    raw: input.quantity_btc_raw,
  });
  assertTradingQuantum(q, metadata.instrument.quantity_step);
  requireJev(BigInt(q.raw) > 0n && fill > 0n && atr > 0n, "PROTECTION_AMOUNTS");
  const target = fill + (input.direction === "long" ? -1n : 1n) * 2n * atr;
  const stop = venueGridPrice(
    target,
    1n,
    input.direction === "long" ? "up" : "down",
    metadata,
  );
  requireJev(
    stop !== null && (input.direction === "long" ? stop < fill : stop > fill),
    "STOP_GRID",
  );
  return {
    schema_version: "btc.jev-protection.v1",
    manifest_hash: hash,
    scope: input.scope,
    position_id: input.position_id,
    direction: input.direction,
    first_fill_at: input.first_fill_at,
    first_fill_price_raw: input.first_fill_price_raw,
    entry_atr14_raw: input.atr14_raw,
    stop_price_raw: stop.toString(),
    quantity_btc_raw: q.raw,
    maximum_exit_at: new Date(at + m.exits.maximum_holding_ms).toISOString(),
  };
}
/** Partial fills never change price/ATR/time anchors. Only protected quantity changes. */
export function updateJevPartialProtection(
  p: JevProtection,
  fill: {
    scope: JevScope;
    position_id: string;
    occurred_at: string;
    quantity_btc_raw: string;
  },
  metadata: TradingInstrumentMetadata,
): JevProtection {
  requireJev(
    canonicalFingerprint(p.scope) === canonicalFingerprint(fill.scope) &&
      p.position_id === fill.position_id &&
      jevTime(fill.occurred_at) >= jevTime(p.first_fill_at),
    "PARTIAL_OWNER",
  );
  const q = parseTradingAmount("BTC", {
    unit: "BTC",
    decimals: 8,
    raw: fill.quantity_btc_raw,
  });
  assertTradingQuantum(q, metadata.instrument.quantity_step);
  requireJev(BigInt(q.raw) > 0n, "PARTIAL_QUANTITY");
  return {
    ...p,
    quantity_btc_raw: (BigInt(p.quantity_btc_raw) + BigInt(q.raw)).toString(),
  };
}
/** Urgent close requests are independent of JEV, cadence and response availability. */
export function jevMandatoryExit(
  m: JevManifest,
  p: JevProtection,
  input: {
    now_at: string;
    mark_price_raw: string | null;
    mark_at: string | null;
    protection_confirmed: boolean;
    risk_blocked: boolean;
  },
) {
  requireJev(p.manifest_hash === validateJevManifest(m), "PROTECTION_VERSION");
  const now = jevTime(input.now_at);
  requireJev(now >= jevTime(p.first_fill_at), "EXIT_CLOCK");
  const reasons: string[] = [];
  if (now >= jevTime(p.maximum_exit_at)) reasons.push("MAXIMUM_HOLDING_TIME");
  if (input.risk_blocked) reasons.push("RISK_BLOCKED");
  if (!input.protection_confirmed) reasons.push("PROTECTION_UNCONFIRMED");
  if (
    input.mark_at === null ||
    input.mark_price_raw === null ||
    jevTime(input.mark_at) > now ||
    now - jevTime(input.mark_at) > m.freshness.mark_funding_ms
  )
    reasons.push("PROTECTION_MARK_UNKNOWN");
  else {
    const mark = BigInt(
      parseTradingAmount("USD_PER_BTC", {
        unit: "USD_PER_BTC",
        decimals: 6,
        raw: input.mark_price_raw,
      }).raw,
    );
    requireJev(mark > 0n, "MARK_PRICE");
    if (
      p.direction === "long"
        ? mark <= BigInt(p.stop_price_raw)
        : mark >= BigInt(p.stop_price_raw)
    )
      reasons.push("FIXED_STOP");
  }
  return {
    request_close: reasons.length > 0,
    reasons,
    reduce_only: true,
    time_in_force: "IOC" as const,
  };
}
