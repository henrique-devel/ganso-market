import type { PerpetualLedgerEvent } from "@ganso-market/contracts/trading";
import { assertInstrumentOrderConstraints } from "@ganso-market/contracts/trading";
import { baselineTrend } from "../trading/strategies/baseline.js";
import {
  baselineBars,
  baselineEnvironment,
  baselineHash,
  baselineIso,
  baselineTime,
  baselineRefs,
  type BaselineEnvironment,
  type BaselineBars,
  type BaselineRef,
} from "./baseline-inputs.js";
import {
  baselineAmount,
  baselineQuantity,
  type BaselineDecision,
} from "./baseline-policy.js";
import { type IocCommand, validateIocCommand } from "./broker-contract.js";

const priority = [
  "accounting_halt",
  "liquidation",
  "risk_pause",
  "stop",
  "max_holding",
  "trend",
] as const;
type ExitReason = (typeof priority)[number];
export interface BaselineExitMemory {
  schema_version: "btc.baseline-exit.v1";
  registration_hash: string;
  candidate_id: string;
  position_id: string;
  direction: "long" | "short";
  stop_usd_raw: string;
  first_fill_id: string;
  opened_at: string;
  deadline: string;
  requested_at: string | null;
  reasons: ExitReason[];
}
/** Persist once after actual broker fills. Feed the complete retained entry-fill
 * set, not merely the latest partial. Subsequent partials cannot change time/stop. */
export function baselinePosition(
  decision: BaselineDecision,
  fills: readonly PerpetualLedgerEvent[],
  asOf: string,
  previous: BaselineExitMemory | null = null,
): BaselineExitMemory {
  if (!decision.command || !decision.candidate)
    throw new Error("BTC_BASELINE_NOT_CANDIDATE");
  const order = decision.command.order,
    scope = decision.registration.scope;
  const entries = fills.filter(
    (f) =>
      f.payload.event_type === "fill" &&
      f.payload.position_id === order.position_id &&
      f.payload.order_id === order.order_id,
  );
  // PerpetualLedgerEvent links fills by position/execution. The caller must
  // supply only broker-validated ledger history (not market observations).
  const valid = entries.filter(
    (f) =>
      f.account_id === scope.account_id &&
      f.experiment_id === scope.experiment_id &&
      f.instrument_version === scope.instrument_version &&
      f.instrument_id === scope.instrument_id &&
      f.mode === "paper" &&
      f.payload.event_type === "fill" &&
      f.payload.side === order.side &&
      BigInt(f.payload.quantity.raw) > 0n &&
      baselineTime(f.occurred_at) >=
        baselineTime(decision.decision_at) + 1000 &&
      baselineTime(f.occurred_at) < baselineTime(order.valid_until) &&
      baselineTime(f.occurred_at) <= baselineTime(asOf) &&
      baselineTime(f.recorded_at) <= baselineTime(asOf),
  );
  if (
    valid.length !== entries.length ||
    !valid.length ||
    new Set(valid.map((f) => f.event_id)).size !== valid.length ||
    valid.reduce(
      (n, f) =>
        n +
        (f.payload.event_type === "fill" ? BigInt(f.payload.quantity.raw) : 0n),
      0n,
    ) > BigInt(order.quantity_btc_raw)
  )
    throw new Error("BTC_BASELINE_ENTRY_FILLS");
  valid.sort((a, b) =>
    a.occurred_at < b.occurred_at
      ? -1
      : a.occurred_at > b.occurred_at
        ? 1
        : BigInt(a.sequence) < BigInt(b.sequence)
          ? -1
          : 1,
  );
  const first = valid[0]!;
  const result: BaselineExitMemory = {
    schema_version: "btc.baseline-exit.v1",
    registration_hash: baselineHash(decision.registration),
    candidate_id: decision.candidate.candidate_id,
    position_id: order.position_id,
    direction: decision.candidate.direction,
    stop_usd_raw: decision.candidate.stop_usd_raw,
    first_fill_id: first.event_id,
    opened_at: first.occurred_at,
    deadline: baselineIso(baselineTime(first.occurred_at) + 21600000),
    requested_at: null,
    reasons: [],
  };
  if (previous) {
    for (const key of [
      "registration_hash",
      "candidate_id",
      "position_id",
      "direction",
      "stop_usd_raw",
      "first_fill_id",
      "opened_at",
      "deadline",
    ] as const)
      if (previous[key] !== result[key])
        throw new Error("BTC_BASELINE_POSITION_CHANGED");
    return structuredClone(previous);
  }
  return result;
}
export interface BaselineExitInput extends BaselineEnvironment {
  now: string;
  position: BaselineExitMemory;
  /** S7 assessment from readIsolatedMarginTx, never from a candle. */
  liquidatable: boolean;
  /** Optional valid 1h context only during a current decision window. */
  decision_context?: { bar_end_at: string; hours: BaselineBars };
  /** All prior IOC attempts from durable results. Identical economic books
   * cannot be reused by changing object IDs; active reductions block overlap. */
  attempts: {
    order_id: string;
    book_key: string;
    source_at: string;
    status: "active" | "terminal";
  }[];
}
export function manageBaselineExit(input: BaselineExitInput) {
  const at = baselineTime(input.now),
    env = baselineEnvironment(input, at),
    p = structuredClone(input.position);
  if (
    p.schema_version !== "btc.baseline-exit.v1" ||
    p.registration_hash !== baselineHash(input.registration) ||
    p.deadline !== baselineIso(baselineTime(p.opened_at) + 21600000) ||
    baselineTime(p.opened_at) > at ||
    BigInt(p.stop_usd_raw) <= 0n
  )
    throw new Error("BTC_BASELINE_EXIT_MEMORY");
  const quantity = BigInt(
    env.finance.positions.find((f) => f.position_id === p.position_id)
      ?.quantity_btc_raw ?? "0",
  );
  if (quantity !== 0n && (quantity > 0n ? "long" : "short") !== p.direction)
    throw new Error("BTC_BASELINE_POSITION_DIRECTION");
  const reasons = new Set<ExitReason>(p.reasons);
  const book = env.book?.payload.payload;
  const levels =
    book?.kind === "book"
      ? p.direction === "long"
        ? book.bids
        : book.asks
      : [];
  const currentHalt =
    !env.account.accounting_consistent ||
    env.account.risk.state === "HALTED" ||
    !env.account.recovery_ready ||
    env.causes.includes("account_snapshot_unavailable");
  if (currentHalt) reasons.add("accounting_halt");
  if (input.liquidatable) reasons.add("liquidation");
  if (
    env.account.risk.state === "REDUCE_ONLY" ||
    env.account.risk.reasons.some((r) =>
      ["daily_loss", "drawdown", "exposure_limit"].includes(r),
    )
  )
    reasons.add("risk_pause");
  if (
    env.finance.closing.quality === "fresh" &&
    levels[0] &&
    (p.direction === "long"
      ? BigInt(levels[0].price.raw) <= BigInt(p.stop_usd_raw)
      : BigInt(levels[0].price.raw) >= BigInt(p.stop_usd_raw))
  )
    reasons.add("stop");
  if (at >= baselineTime(p.deadline)) reasons.add("max_holding");
  const refs: BaselineRef[] = [...env.refs];
  if (input.decision_context) {
    const t = baselineTime(input.decision_context.bar_end_at);
    if (t % 900000 === 0 && at >= t + 10000 && at < t + 60000) {
      const hours = baselineBars(
        input.decision_context.hours,
        3600000,
        12,
        Math.floor((at - 10000) / 3600000) * 3600000,
        at,
        input.registration.scope.instrument_version,
      );
      refs.push(...hours.refs);
      if (
        hours.state === "ready" &&
        baselineTrend(hours.bars.map((b) => b.ohlc!.close)) !== p.direction
      )
        reasons.add("trend");
    }
  }
  p.reasons = priority.filter((r) => reasons.has(r));
  if (p.reasons.length && p.requested_at === null) p.requested_at = input.now;
  const result = {
    state: "holding" as
      | "holding"
      | "closed"
      | "reconcile"
      | "liquidation_required"
      | "exit_pending"
      | "reduce_candidate",
    position: p,
    reason: p.reasons[0] ?? null,
    pending_causes: [] as string[],
    overdue_ms: Math.max(0, at - baselineTime(p.deadline)),
    cancel_order_ids: [] as string[],
    command: null as Extract<IocCommand, { action: "submit" }> | null,
    book_key: null as string | null,
    input_refs: baselineRefs(refs),
  };
  if (quantity === 0n) {
    result.state = "closed";
    return result;
  }
  if (!p.requested_at) return result;
  result.cancel_order_ids = env.account.reservations
    .filter((r) => r.status === "active" && r.order.intent === "open")
    .map((r) => r.order.order_id)
    .sort();
  if (currentHalt) {
    result.state = "reconcile";
    return result;
  }
  if (input.liquidatable) {
    result.state = "liquidation_required";
    return result;
  }
  result.state = "exit_pending";
  if (env.causes.includes("metadata_unavailable"))
    result.pending_causes.push("metadata_unavailable");
  if (
    env.finance.closing.quality !== "fresh" ||
    !levels.length ||
    !env.book?.payload.source_timestamp
  )
    result.pending_causes.push("book_unavailable");
  if (
    input.attempts.some((a) => a.status === "active") ||
    env.account.reservations.some(
      (r) => r.status === "active" && r.order.intent === "reduce",
    )
  )
    result.pending_causes.push("ioc_in_flight");
  if (result.pending_causes.length) return result;
  const key = baselineHash([
    input.registration.scope.instrument_id,
    env.book!.payload.source_timestamp,
    env.book!.payload.payload,
  ]);
  result.book_key = key;
  if (
    input.attempts.some(
      (a) =>
        a.book_key === key ||
        baselineTime(a.source_at) >=
          baselineTime(env.book!.payload.source_timestamp!),
    )
  ) {
    result.pending_causes.push("new_observed_book_required");
    return result;
  }
  const q = quantity < 0n ? -quantity : quantity;
  const validLevels = levels.filter((l) => {
    try {
      assertInstrumentOrderConstraints(
        env.metadata!,
        baselineAmount(l.price.raw),
        baselineQuantity(q.toString()),
      );
      return true;
    } catch {
      return false;
    }
  });
  if (!validLevels.length) {
    result.pending_causes.push("order_constraints_unavailable");
    return result;
  }
  const limit = validLevels.at(-1)!.price.raw,
    cap = p.direction === "long" ? levels[0]!.price.raw : limit;
  const id = `exit:${baselineHash([p.position_id, key])}`;
  result.command = {
    action: "submit",
    operation_id: id,
    order: {
      schema_version: "btc.reservations.v1",
      order_id: id,
      position_id: p.position_id,
      source: "strategy",
      intent: "reduce",
      side: p.direction === "long" ? "sell" : "buy",
      quantity_btc_raw: q.toString(),
      price_cap_usd_raw: cap,
      fee_bps: 5,
      margin_policy: "full_notional_v1",
      valid_until: baselineIso(at + 5000),
    },
    intent: {
      schema_version: "btc.ioc.v1",
      decision_at: input.now,
      latency_ms: 1000,
      limit_price_usd_raw: limit,
      fee_metadata_id: input.metadata!.object_id,
    },
  };
  validateIocCommand(result.command);
  result.state = "reduce_candidate";
  return result;
}

/** Execution fence for a persisted reduction proposal. No entry permission,
 * funding coverage or bar warmup is required; the broker still owns fee capacity,
 * executable depth, ledger effects and cancellation of the IOC remainder. */
export function revalidateBaselineExit(
  plan: ReturnType<typeof manageBaselineExit>,
  current: BaselineEnvironment & { liquidatable: boolean },
  now: string,
) {
  const command = plan.command;
  if (
    !command ||
    plan.position.registration_hash !== baselineHash(current.registration)
  )
    throw new Error("BTC_BASELINE_EXIT_PROPOSAL");
  const at = baselineTime(now),
    env = baselineEnvironment(current, at),
    reasons: string[] = [];
  if (current.liquidatable) reasons.push("liquidation_required");
  if (
    env.account.risk.state === "HALTED" ||
    !env.account.accounting_consistent ||
    !env.account.recovery_ready ||
    env.causes.includes("account_snapshot_unavailable")
  )
    reasons.push("accounting_halt");
  if (env.causes.includes("metadata_unavailable"))
    reasons.push("metadata_unavailable");
  if (env.finance.closing.quality !== "fresh") reasons.push("book_unavailable");
  if (
    at < baselineTime(command.intent.decision_at) ||
    at >= baselineTime(command.order.valid_until)
  )
    reasons.push("intent_expired");
  const position = env.finance.positions.find(
    (p) => p.position_id === command.order.position_id,
  );
  const q = BigInt(position?.quantity_btc_raw ?? "0"),
    wanted = BigInt(command.order.quantity_btc_raw);
  if (command.order.side === "sell" ? q < wanted : -q < wanted)
    reasons.push("inventory_changed");
  if (
    !env.account.reservations.some(
      (r) =>
        r.status === "active" &&
        baselineHash(r.order) === baselineHash(command.order),
    )
  )
    reasons.push("reservation_changed");
  const source = env.book?.payload.source_timestamp,
    received = env.book?.payload.received_at;
  const eligible = baselineTime(command.intent.decision_at) + 1000;
  const waiting =
    !source ||
    !received ||
    baselineTime(source) <= eligible ||
    baselineTime(received) <= eligible;
  return {
    state: reasons.length
      ? ("rejected" as const)
      : waiting
        ? ("waiting" as const)
        : ("ready" as const),
    reasons: reasons.length
      ? reasons
      : waiting
        ? ["post_latency_book_required"]
        : [],
    input_refs: env.refs,
  };
}
