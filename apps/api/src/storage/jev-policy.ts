import {
  parseTradingAmount,
  requireJev,
  type JevScope,
} from "@ganso-market/contracts/trading";
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
// Compatibility export for JE03/JE05 contracts and historical callers.
export {
  initialJevProtection,
  updateJevPartialProtection,
  jevMandatoryExit,
  type JevProtection,
} from "./jev-protection.js";
