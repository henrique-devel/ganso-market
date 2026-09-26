import {
  assertInstrumentOrderConstraints,
  parseTradingAmount,
  parseTradingContract,
  tradingIdempotencyKey,
  type TradingIntent,
  type TradingInstrumentMetadata,
} from "@ganso-market/contracts/trading";
import {
  baselineAtr,
  baselineBreakout,
  baselinePrice,
  baselineTrend,
  BASELINE_POLICY,
  BASELINE_RESULT,
  type BaselineDirection,
} from "../trading/strategies/baseline.js";
import {
  plannedRisk,
  riskCeil,
  requireRiskCaps,
  grossExposure,
  breached,
  RISK_POLICY,
} from "../trading/risk.js";
import {
  reservationHold,
  requireOpeningCapacity,
  type ReservationOrder,
} from "../trading/reservations.js";
import type { IocCommand } from "./broker-contract.js";
import { validateIocCommand } from "./broker-contract.js";
import {
  baselineBars,
  baselineEnvironment,
  baselineHash,
  baselineIso,
  baselineRefs,
  baselineTime,
  validateBaselineRegistration,
  type BaselineBars,
  type BaselineEnvironment,
  type BaselineRef,
} from "./baseline-inputs.js";

export type BaselineState =
  | "disabled"
  | "missed_decision_window"
  | "data_unavailable"
  | "warmup"
  | "position_managed"
  | "neutral"
  | "candidate_long"
  | "candidate_short"
  | "rejected";
export interface BaselineCandidate {
  candidate_id: string;
  direction: BaselineDirection;
  close_usd_raw: string;
  atr_usd_raw: string;
  distance_usd_raw: string;
  lower_usd_raw: string;
  upper_usd_raw: string;
  stop_usd_raw: string;
  quantity_btc_raw: string;
  costs: ReturnType<typeof baselineCosts>;
}
/** Account-independent market candidate, retained even when a particular
 * account is already positioned or paused. Hash excludes cash/account clocks. */
export interface BaselineSignal {
  hash: string;
  direction: BaselineDirection;
  close_usd6: string;
  atr_usd6: string;
  fast_mean_usd6: string;
  slow_mean_usd6: string;
  input_refs: BaselineRef[];
}
export interface BaselineDecision {
  signal?: BaselineSignal | null;
  source_decision_id?: string;
  schema_version: typeof BASELINE_RESULT;
  policy_version: typeof BASELINE_POLICY;
  decision_id: string;
  decision_at: string;
  bar_end_at: string;
  registration: BaselineEnvironment["registration"];
  state: BaselineState;
  reasons: string[];
  direction: BaselineDirection | null;
  candidate: BaselineCandidate | null;
  /** A proposal only. Persist decision + pins, then admit/revalidate under lock.
   * No caller in the runtime invokes this module in G2-07.2. */
  intent: TradingIntent | null;
  command: Extract<IocCommand, { action: "submit" }> | null;
  input_refs: BaselineRef[];
}
export interface BaselineDecisionInput extends BaselineEnvironment {
  enabled: boolean;
  decision_at: string;
  bar_end_at: string;
  hours: BaselineBars;
  quarters: BaselineBars;
  /** First persisted result wins, even after late correction or missed replay.
   * The store is responsible for the unique decision key and atomic pinning. */
  previous?: BaselineDecision;
  source?: BaselineDecision;
}
const max = (a: bigint, b: bigint) => (a > b ? a : b);
export function baselineCosts(
  order: ReservationOrder,
  rate: bigint,
  distance: bigint,
) {
  const q = BigInt(order.quantity_btc_raw),
    s = BigInt(order.risk_plan!.stop_price_usd_raw),
    u = BigInt(order.price_cap_usd_raw);
  const core = plannedRisk(order, 5);
  const fees =
    riskCeil(q * u * 5n, 10n ** 12n) + riskCeil(q * max(s, u) * 5n, 10n ** 12n);
  const slippage = riskCeil(q * s * 10n, 10n ** 12n);
  const funding = 7n * riskCeil(q * max(s, u) * rate, 10n ** 26n);
  return {
    core_usd_raw: core.toString(),
    fees_usd_raw: fees.toString(),
    exit_slippage_usd_raw: slippage.toString(),
    funding_usd_raw: funding.toString(),
    budget_usd_raw: (core + slippage + funding).toString(),
    cost_usd_raw: (fees + slippage + funding).toString(),
    distance_value_usd_raw: riskCeil(q * distance, 100000000n).toString(),
  };
}
type Environment = ReturnType<typeof baselineEnvironment>;
function openingCauses(env: Environment) {
  const a = env.account,
    reasons: string[] = [];
  if (a.risk.state === "HALTED" || !a.accounting_consistent)
    reasons.push("accounting_halt");
  if (a.risk.state !== "NORMAL") reasons.push("risk_pause");
  reasons.push(...a.risk.reasons);
  const e = env.finance.maintenance.equity_usd_raw;
  if (e !== null) {
    if (
      a.risk.daily_anchor_usd_raw === null ||
      breached(
        BigInt(e),
        BigInt(a.risk.daily_anchor_usd_raw),
        RISK_POLICY.daily_loss_bps,
      )
    )
      reasons.push("daily_loss");
    if (
      breached(
        BigInt(e),
        BigInt(a.risk.high_water_usd_raw),
        RISK_POLICY.drawdown_bps,
      )
    )
      reasons.push("drawdown");
  }
  if (!a.risk.history_complete) reasons.push("history_unobserved");
  if (a.hold) reasons.push("hold");
  if (a.entries_paused) reasons.push("entries_paused");
  return [...new Set(reasons)];
}
function fits(
  env: Environment,
  order: ReservationOrder,
  rate: bigint,
  distance: bigint,
) {
  try {
    const equity = env.finance.maintenance.equity_usd_raw;
    if (equity === null || !env.finance.maintenance.mark_price) return false;
    const mark = max(
      BigInt(env.finance.maintenance.mark_price.raw),
      BigInt(order.price_cap_usd_raw),
    );
    const q = BigInt(order.quantity_btc_raw);
    const pending = env.account.reservations.filter(
      (r) => r.order.order_id !== order.order_id,
    );
    const candidate = reservationHold(order, q);
    requireRiskCaps(
      equity,
      grossExposure(
        env.finance.positions,
        mark.toString(),
        [...pending, candidate].map((r) => ({
          ...r,
          order: {
            ...r.order,
            price_cap_usd_raw: max(
              mark,
              BigInt(r.order.price_cap_usd_raw),
            ).toString(),
          },
        })),
      ),
      BigInt(baselineCosts(order, rate, distance).budget_usd_raw),
    );
    requireOpeningCapacity(env.finance, [...pending, candidate]);
    return true;
  } catch {
    return false;
  }
}
export function baselineSize(
  env: Environment,
  order: ReservationOrder,
  rate: bigint,
  distance: bigint,
): bigint {
  const e = BigInt(env.finance.maintenance.equity_usd_raw ?? "0");
  const lot = BigInt(env.metadata!.instrument.quantity_step.raw);
  const mark = max(
    BigInt(env.finance.maintenance.mark_price?.raw ?? "0"),
    BigInt(order.price_cap_usd_raw),
  );
  if (e <= 0n || mark <= 0n || lot <= 0n) return 0n;
  let low = 0n,
    high = (e * 2500n * 100000000n) / (10000n * mark * lot);
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    if (
      fits(
        env,
        { ...order, quantity_btc_raw: (mid * lot).toString() },
        rate,
        distance,
      )
    )
      low = mid;
    else high = mid - 1n;
  }
  return low * lot;
}
export const baselineAmount = (raw: string) =>
  parseTradingAmount("USD_PER_BTC", { raw, unit: "USD_PER_BTC", decimals: 6 });
export const baselineQuantity = (raw: string) =>
  parseTradingAmount("BTC", { raw, unit: "BTC", decimals: 8 });
function validOrder(
  metadata: TradingInstrumentMetadata,
  order: ReservationOrder,
) {
  for (const price of [
    order.price_cap_usd_raw,
    order.risk_plan!.entry_floor_usd_raw,
    order.risk_plan!.stop_price_usd_raw,
  ])
    assertInstrumentOrderConstraints(
      metadata,
      baselineAmount(price),
      baselineQuantity(order.quantity_btc_raw),
    );
}
function priceCauses(
  env: Environment,
  candidate: Pick<
    BaselineCandidate,
    "direction" | "lower_usd_raw" | "upper_usd_raw" | "stop_usd_raw"
  >,
) {
  const book = env.book?.payload.payload;
  if (!book || book.kind !== "book" || env.finance.closing.quality !== "fresh")
    return ["book_unavailable"];
  const entry = candidate.direction === "long" ? book.asks[0] : book.bids[0];
  const trigger = candidate.direction === "long" ? book.bids[0] : book.asks[0];
  const reasons: string[] = [];
  if (!entry || !trigger) return ["book_unavailable"];
  if (
    BigInt(entry.price.raw) < BigInt(candidate.lower_usd_raw) ||
    BigInt(entry.price.raw) > BigInt(candidate.upper_usd_raw)
  )
    reasons.push("price_protection");
  if (
    candidate.direction === "long"
      ? BigInt(trigger.price.raw) <= BigInt(candidate.stop_usd_raw)
      : BigInt(trigger.price.raw) >= BigInt(candidate.stop_usd_raw)
  )
    reasons.push("stop_triggered");
  // S3 requires reservation cap >= mark. Preserve cap U; never silently widen it.
  if (
    BigInt(env.finance.maintenance.mark_price?.raw ?? "0") >
    BigInt(candidate.upper_usd_raw)
  )
    reasons.push("price_cap_below_mark");
  return reasons;
}

export function decideBaseline(input: BaselineDecisionInput): BaselineDecision {
  validateBaselineRegistration(input.registration);
  const r = input.registration,
    t = baselineTime(input.bar_end_at),
    at = baselineTime(input.decision_at);
  if (t % 900000 !== 0) throw new TypeError("BTC_BASELINE_BAR_BOUNDARY");
  const key = baselineHash([
    r.scope.account_id,
    r.scope.experiment_id,
    r.policy_version,
    r.manifest_fingerprint,
    r.scope.instrument_version,
    input.bar_end_at,
  ]);
  if (input.previous) {
    if (
      input.previous.decision_id !== key ||
      baselineHash(input.previous.registration) !== baselineHash(r)
    )
      throw new Error("BTC_BASELINE_REPLAY_SCOPE");
    return structuredClone(input.previous);
  }
  const env = baselineEnvironment(input, at);
  const hours = baselineBars(
    input.hours,
    3600000,
    12,
    Math.floor((at - 10000) / 3600000) * 3600000,
    at,
    r.scope.instrument_version,
  );
  const quarters = baselineBars(
    input.quarters,
    900000,
    15,
    t,
    at,
    r.scope.instrument_version,
  );
  const reasons: string[] = [];
  if (
    !input.enabled ||
    t < baselineTime(r.start_at) ||
    t >= baselineTime(r.start_at) + 30 * 86400000
  )
    reasons.push("disabled");
  if (at < t + 10000 || at >= t + 60000) reasons.push("missed_decision_window");
  const unavailable = [...env.causes];
  if (!input.source && hours.state === "data_unavailable")
    unavailable.push("context_bars_unavailable");
  if (!input.source && quarters.state === "data_unavailable")
    unavailable.push("decision_bars_unavailable");
  if (unavailable.length) reasons.push("data_unavailable", ...unavailable);
  if (
    !input.source &&
    (hours.state === "warmup" || quarters.state === "warmup")
  )
    reasons.push("warmup");
  const managed =
    env.finance.positions.some((p) => p.quantity_btc_raw !== "0") ||
    env.account.reservations.some((r) => r.status === "active") ||
    env.account.exit_pending ||
    (env.account.last_closed_bar_end_at !== null &&
      input.bar_end_at <= env.account.last_closed_bar_end_at);
  if (managed) reasons.push("position_managed");
  let signal: BaselineSignal | null = null;
  if (input.source) {
    const source = input.source;
    if (
      source.bar_end_at !== input.bar_end_at ||
      source.registration.policy_version !== r.policy_version ||
      source.registration.manifest_fingerprint !== r.manifest_fingerprint ||
      source.registration.metadata_hash !== r.metadata_hash ||
      source.registration.scope.instrument_version !==
        r.scope.instrument_version ||
      source.registration.scope.instrument_id !== r.scope.instrument_id ||
      source.registration.scope.mode !== "paper" ||
      source.registration.scope.account_id === r.scope.account_id
    )
      throw new Error("BTC_CHALLENGER_SOURCE_MISMATCH");
    signal = structuredClone(source.signal ?? null);
    if (
      at < baselineTime(source.decision_at) ||
      at >= baselineTime(source.decision_at) + 5000
    )
      reasons.push("missed_decision_window");
    if (!signal && source.state !== "neutral")
      reasons.push("data_unavailable", "source_signal_unavailable");
  } else if (hours.state === "ready" && quarters.state === "ready") {
    const candles = quarters.bars.map((b) => b.ohlc!);
    const direction = baselineBreakout(
      baselineTrend(hours.bars.map((b) => b.ohlc!.close)),
      candles[0]!,
      candles[1]!,
    );
    if (direction) {
      const closes = hours.bars.map((b) => BigInt(b.ohlc!.close));
      const observations = {
        direction,
        close_usd6: candles[0]!.close,
        atr_usd6: baselineAtr(candles).toString(),
        fast_mean_usd6: (
          closes.slice(0, 4).reduce((a, b) => a + b, 0n) / 4n
        ).toString(),
        slow_mean_usd6: (closes.reduce((a, b) => a + b, 0n) / 12n).toString(),
        input_refs: baselineRefs([...hours.refs, ...quarters.refs]),
      };
      signal = {
        ...observations,
        hash: `sha256:${baselineHash([r.policy_version, r.manifest_fingerprint, r.scope.instrument_version, input.bar_end_at, observations])}`,
      };
    }
  }
  const result: BaselineDecision = {
    signal,
    ...(input.source ? { source_decision_id: input.source.decision_id } : {}),
    schema_version: BASELINE_RESULT,
    policy_version: BASELINE_POLICY,
    decision_id: key,
    decision_at: input.decision_at,
    bar_end_at: input.bar_end_at,
    registration: structuredClone(r),
    state: "neutral",
    reasons: [],
    direction: null,
    candidate: null,
    intent: null,
    command: null,
    input_refs: baselineRefs([
      ...env.refs,
      ...(input.source
        ? (signal?.input_refs ?? [])
        : [...hours.refs, ...quarters.refs]),
    ]),
  };
  const pauses = openingCauses(env);
  const finish = (state: BaselineState) => {
    result.state = state;
    result.reasons = [...new Set([...reasons, ...pauses])];
    return result;
  };
  for (const state of [
    "disabled",
    "missed_decision_window",
    "data_unavailable",
    "warmup",
    "position_managed",
  ] as const)
    if (reasons.includes(state)) return finish(state);
  const direction = signal?.direction ?? null;
  result.direction = direction;
  if (!direction) {
    reasons.push("neutral");
    return finish("neutral");
  }
  reasons.push(`candidate_${direction}`);
  const reject = (cause: string) => {
    reasons.push(cause);
    return finish("rejected");
  };
  const atr = BigInt(signal!.atr_usd6),
    distance = 2n * atr,
    c = BigInt(signal!.close_usd6),
    metadata = env.metadata!;
  if (atr === 0n) return reject("zero_volatility");
  const lower = baselinePrice(c * 9990n, 10000n, "up", metadata),
    upper = baselinePrice(c * 10010n, 10000n, "down", metadata);
  const stop = baselinePrice(
    direction === "long" ? c - distance : c + distance,
    1n,
    direction === "long" ? "down" : "up",
    metadata,
  );
  if (
    lower === null ||
    upper === null ||
    stop === null ||
    lower > upper ||
    (direction === "long" ? stop >= lower : stop <= upper)
  )
    return reject("invalid_stop_or_band");
  const id = `baseline:${key}`;
  const order: ReservationOrder = {
    schema_version: "btc.reservations.v1",
    order_id: id,
    position_id: id,
    source: "strategy",
    intent: "open",
    side: direction === "long" ? "buy" : "sell",
    quantity_btc_raw: "0",
    price_cap_usd_raw: upper.toString(),
    fee_bps: 5,
    margin_policy: "full_notional_v1",
    valid_until: baselineIso(
      (input.source ? baselineTime(input.source.decision_at) : at) + 5000,
    ),
    risk_plan: {
      stop_price_usd_raw: stop.toString(),
      entry_floor_usd_raw: lower.toString(),
    },
  };
  const quantity = baselineSize(env, order, env.rate!, distance);
  order.quantity_btc_raw = quantity.toString();
  const costs = baselineCosts(order, env.rate!, distance);
  result.candidate = {
    candidate_id: id,
    direction,
    close_usd_raw: c.toString(),
    atr_usd_raw: atr.toString(),
    distance_usd_raw: distance.toString(),
    lower_usd_raw: lower.toString(),
    upper_usd_raw: upper.toString(),
    stop_usd_raw: stop.toString(),
    quantity_btc_raw: quantity.toString(),
    costs,
  };
  if (quantity === 0n) return reject("size_below_minimum");
  const vetos: string[] = [];
  if (BigInt(costs.cost_usd_raw) >= BigInt(costs.distance_value_usd_raw))
    vetos.push("cost_veto");
  try {
    validOrder(metadata, order);
  } catch {
    vetos.push("size_below_minimum");
  }
  vetos.push(...priceCauses(env, result.candidate), ...pauses);
  if (vetos.length) {
    reasons.push(...vetos);
    return finish("rejected");
  }
  const limit = direction === "long" ? upper : lower;
  result.intent = parseTradingContract("intent", {
    schema_version: "trading.v1",
    ...r.scope,
    intent_id: id,
    idempotency_key: tradingIdempotencyKey(r.scope, "intent", id),
    decision: {
      decision_id: key,
      decided_at: input.decision_at,
      origin: {
        kind: "strategy",
        strategy_id: "baseline",
        strategy_version: BASELINE_POLICY,
      },
      // The extended receipt pins every nullable-timestamp input without inventing
      // a venue timestamp for HTTP context. trading.v1 carries metadata + bars.
      inputs: [
        metadata.instrument.origin,
        ...[...hours.bars, ...quarters.bars].map((b) => ({
          schema_version: "trading.v1",
          instrument_id: b.instrument_id,
          instrument_version: b.instrument_version,
          source_id: b.source_id,
          source_event_id: `bar:${b.interval_ms}:${b.end_at}`,
          kind: "bar",
          source_timestamp: b.end_at,
          received_at: b.closed_at,
          parser_version: b.build_version,
          payload_hash: baselineHash(b),
          quality: "unknown",
        })),
      ],
    },
    terms: {
      side: order.side,
      quantity: baselineQuantity(quantity.toString()),
      limit_price: baselineAmount(limit.toString()),
      time_in_force: "IOC",
      reduce_only: false,
    },
  });
  result.command = {
    action: "submit",
    operation_id: id,
    order,
    intent: {
      schema_version: "btc.ioc.v1",
      decision_at: input.decision_at,
      latency_ms: 1000,
      limit_price_usd_raw: limit.toString(),
      fee_metadata_id: input.metadata!.object_id,
    },
  };
  validateIocCommand(result.command);
  return finish(direction === "long" ? "candidate_long" : "candidate_short");
}

/** Mandatory immediately before admission/execution under the existing account
 * lock. Reuses the frozen quantity/stop/band. Caller must still use applyIocTx,
 * which guards ledger, reservations, risk, net depth, metadata and real fills. */
export function revalidateBaseline(
  decision: BaselineDecision,
  current: BaselineEnvironment,
  now: string,
  phase: "admit" | "execute",
) {
  if (
    !decision.candidate ||
    !decision.command ||
    !decision.intent ||
    !["candidate_long", "candidate_short"].includes(decision.state)
  )
    throw new Error("BTC_BASELINE_NOT_CANDIDATE");
  if (
    baselineHash(decision.registration) !== baselineHash(current.registration)
  )
    throw new Error("BTC_BASELINE_REGISTRATION_CHANGED");
  const at = baselineTime(now),
    env = baselineEnvironment(current, at),
    c = decision.candidate,
    order = decision.command.order;
  const reasons = [
    ...env.causes,
    ...openingCauses(env),
    ...priceCauses(env, c),
  ];
  if (!current.enabled) reasons.push("disabled");
  if (
    env.account.last_closed_bar_end_at !== null &&
    decision.bar_end_at <= env.account.last_closed_bar_end_at
  )
    reasons.push("same_bar_reentry");
  if (
    at < baselineTime(decision.decision_at) ||
    at >= baselineTime(order.valid_until)
  )
    reasons.push("intent_expired");
  if (
    env.finance.positions.some((p) => p.quantity_btc_raw !== "0") ||
    env.account.exit_pending ||
    env.account.reservations.some(
      (r) =>
        r.status === "active" &&
        (phase === "admit" || r.order.order_id !== order.order_id),
    )
  )
    reasons.push("position_managed");
  if (
    phase === "execute" &&
    !env.account.reservations.some(
      (r) =>
        r.status === "active" && baselineHash(r.order) === baselineHash(order),
    )
  )
    reasons.push("reservation_changed");
  if (
    env.rate === null ||
    !fits(env, order, env.rate, BigInt(c.distance_usd_raw))
  )
    reasons.push("risk_or_capacity_changed");
  if (env.rate !== null) {
    const costs = baselineCosts(order, env.rate, BigInt(c.distance_usd_raw));
    if (BigInt(costs.cost_usd_raw) >= BigInt(costs.distance_value_usd_raw))
      reasons.push("cost_veto");
  }
  if (env.metadata) {
    try {
      validOrder(env.metadata, order);
    } catch {
      reasons.push("order_constraints_changed");
    }
  }
  const source = env.book?.payload.source_timestamp,
    received = env.book?.payload.received_at;
  const waiting =
    phase === "execute" &&
    (!source ||
      !received ||
      baselineTime(source) <= baselineTime(decision.decision_at) + 1000 ||
      baselineTime(received) <= baselineTime(decision.decision_at) + 1000);
  return {
    state: reasons.length
      ? ("rejected" as const)
      : waiting
        ? ("waiting" as const)
        : ("ready" as const),
    reasons: [
      ...new Set(
        reasons.length
          ? reasons
          : waiting
            ? ["post_latency_book_required"]
            : [],
      ),
    ],
    input_refs: env.refs,
  };
}
