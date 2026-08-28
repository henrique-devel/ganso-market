// RFC-011 Parts C/D service layer: order acceptance, the pessimistic
// processing ticks (taker execution, conservative passive queue, cancels with
// latency, GTD expiry), trinary settlement, mark-to-executable-bid and the
// kill switch. All state changes ride on idempotent ledger events: every
// apply step recomputes deterministically and only advances when the event
// append reports NEW, so replays, restarts and out-of-order ticks converge.
//
// SIMULAÇÃO — SEM EXECUÇÃO REAL: reads recorded public data, writes only to
// the paper_* tables.

import { randomUUID } from "node:crypto";

import type { DatabasePool, SqlExecutor } from "../../database.js";
import type { PriceLevel } from "../types.js";
import {
  SCALE,
  divRound,
  formatScaled,
  parseScaled,
} from "../fundamental/fixed.js";
import {
  DEFAULT_LATENCY_MS,
  TAKER_DELAY_MS,
  executeTaker,
  isFillDegraded,
  markToExecutable,
  passiveFilledFromVolume,
  resolveOutcomeForToken,
} from "./broker.js";
import {
  appendLedgerEvent,
  replayLedger,
  type LedgerEventRecord,
  type LedgerEventType,
} from "./ledger.js";
import { validateOrder, type OrderDraft } from "./validator.js";
import type { ResolutionAction } from "../resolution/types.js";

export type PaperPool = Pick<SqlExecutor, "query"> &
  Partial<Pick<DatabasePool, "transaction">>;

/** A book older than this at its use instant freezes the mark (D2). */
export const MARK_MAX_BOOK_AGE_MS = 30_000;

/** Recorder silence beyond this engages the kill switch (D4). */
export const RECORDER_STALE_MS = 5 * 60_000;

/** A competing tick may reclaim a broker claim only after this gap. */
export const RESOLUTION_RISK_CLAIM_STALE_MS = 5_000;
/**
 * How old the oldest UNPROCESSED journal entry may be before a lagging
 * resolution runtime cancels open orders.
 *
 * "processed < head" alone does not distinguish "the journal advanced a tick
 * and the runtime has not cycled yet" from "the runtime is wedged". The
 * journals move all day (49-286 input changes per hour measured in production
 * on 2026-08-28) and the runtime catches up on its ~1-minute cycle, so the
 * instantaneous comparison is routinely behind by one entry. That routine
 * canceled 7 of the 9 paper orders ever canceled — lags of 1 to 17 input ids,
 * order lifetimes of 14 s to 9 min — throttling throughput to ~1 fill/day
 * against the 2-3/day the G2 gate needs.
 *
 * Three runtime cycles of headroom: a runtime that has not caught up after
 * that is genuinely stalled, and its orders are canceled exactly as before.
 * A DEAD runtime never waits for this grace — its lease expires and
 * RESOLUTION_RUNTIME_STALE cancels immediately. FILLS never use the grace:
 * filling still requires the runtime caught up to every head, unchanged.
 */
export const RESOLUTION_LAG_CANCEL_GRACE_MS = 180_000;

/** Default daily paper loss (USD) that engages the kill switch (D4). */
export const DEFAULT_DAILY_LOSS_LIMIT_USD = "100";

export interface BrokerDeps {
  readonly clock?: () => Date;
  readonly latencyMs?: number;
  readonly dailyLossLimitUsd?: string;
  readonly logSink?: (line: string) => void;
}

function makeLog(
  sink: ((line: string) => void) | undefined,
): (
  level: "info" | "warn" | "error",
  reasonCode: string,
  extra?: Record<string, unknown>,
) => void {
  const write =
    sink ??
    ((line: string): void => {
      process.stderr.write(line);
    });
  return (level, reasonCode, extra = {}) => {
    write(
      `${JSON.stringify({
        level,
        service: "polymarket-paper",
        timestamp: new Date().toISOString(),
        reason_code: reasonCode,
        ...extra,
      })}\n`,
    );
  };
}

// ---------------------------------------------------------------------------
// Shared row helpers.

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseLevels(value: unknown): PriceLevel[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const levels: PriceLevel[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.price === "string" && typeof record.size === "string") {
      levels.push({ price: record.price, size: record.size });
    }
  }
  return levels;
}

interface BookAt {
  readonly bids: PriceLevel[];
  readonly asks: PriceLevel[];
  readonly sourceTs: Date | null;
  readonly receivedAt: Date;
}

export async function bookAtOrBefore(
  pool: PaperPool,
  tokenId: string,
  at: Date,
): Promise<BookAt | null> {
  const result = await pool.query(
    "SELECT bids_json, asks_json, source_ts, received_at " +
      "FROM polymarket_book_snapshots " +
      "WHERE token_id = $1 AND received_at <= $2 " +
      "ORDER BY received_at DESC LIMIT 1",
    [tokenId, at],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  const receivedAt = toDate(row["received_at"]);
  if (receivedAt === null) {
    return null;
  }
  return {
    bids: parseLevels(row["bids_json"]),
    asks: parseLevels(row["asks_json"]),
    sourceTs: toDate(row["source_ts"]),
    receivedAt,
  };
}

interface MarketParamsAt {
  readonly tickSize: string | null;
  readonly minOrderSize: string | null;
  readonly takerFeeBps: string | null;
  readonly negRisk: boolean;
  readonly paramVersionId: number | null;
}

export async function paramsAtOrBefore(
  pool: PaperPool,
  conditionId: string,
  at: Date,
): Promise<MarketParamsAt | null> {
  const result = await pool.query(
    "SELECT param_version_id, tick_size, min_order_size, taker_fee_bps, neg_risk " +
      "FROM polymarket_param_versions " +
      "WHERE condition_id = $1 AND valid_from <= $2 " +
      "ORDER BY version DESC LIMIT 1",
    [conditionId, at],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  const versionRaw = row["param_version_id"];
  return {
    tickSize: asString(row["tick_size"]),
    minOrderSize: asString(row["min_order_size"]),
    takerFeeBps: asString(row["taker_fee_bps"]),
    negRisk: row["neg_risk"] === true,
    paramVersionId:
      typeof versionRaw === "number"
        ? versionRaw
        : typeof versionRaw === "string" && /^\d+$/.test(versionRaw)
          ? Number(versionRaw)
          : null,
  };
}

/** Taker fee RATE from bps (e.g. 700 bps -> "0.07"); null when unknown. */
export function feeRateFromBps(bps: string | null): string | null {
  const parsed = bps === null ? null : parseScaled(bps);
  if (parsed === null || parsed < 0n) {
    return null;
  }
  return formatScaled(divRound(parsed, 10_000n), 6);
}

// ---------------------------------------------------------------------------
// Kill switch.

export interface KillSwitchState {
  readonly engaged: boolean;
  readonly reason: string | null;
  readonly frozenMarkets: readonly string[];
}

function parseKillSwitchState(
  row: Record<string, unknown> | undefined,
): KillSwitchState {
  const frozen = Array.isArray(row?.["frozen_markets_json"])
    ? (row["frozen_markets_json"] as unknown[]).filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  return {
    engaged: row?.["engaged"] === true,
    reason: asString(row?.["reason"]),
    frozenMarkets: frozen,
  };
}

export async function loadKillSwitch(
  pool: PaperPool,
): Promise<KillSwitchState> {
  const result = await pool.query(
    "SELECT engaged, reason, frozen_markets_json FROM paper_kill_switch WHERE kill_switch_id = 1",
  );
  return parseKillSwitchState(result.rows[0]);
}

async function loadLockedKillSwitch(pool: PaperPool): Promise<KillSwitchState> {
  const result = await pool.query(
    "SELECT engaged, reason, frozen_markets_json FROM paper_kill_switch " +
      "WHERE kill_switch_id = 1 FOR SHARE",
  );
  if (result.rows.length !== 1) {
    throw new Error("PAPER_KILL_SWITCH_STATE_MISSING");
  }
  return parseKillSwitchState(result.rows[0]);
}

export async function engageKillSwitch(
  pool: PaperPool,
  reason: string,
  now: Date,
  deps: BrokerDeps = {},
): Promise<void> {
  const log = makeLog(deps.logSink);
  if (!hasTransaction(pool)) {
    throw new Error("PAPER_BROKER_TRANSACTION_UNAVAILABLE");
  }
  const ordersCanceled = await pool.transaction(async (tx: SqlExecutor) => {
    // Lock order shared with acceptance/fill: kill -> orders. Holding the kill
    // row until every audit and cancellation commits makes engage linearizable
    // with both rearm and a concurrent acceptance.
    const engaged = await tx.query(
      "UPDATE paper_kill_switch SET engaged = TRUE, reason = $1, engaged_at = $2, updated_at = $2 WHERE kill_switch_id = 1",
      [reason, now],
    );
    if (engaged.rowCount !== 1) {
      throw new Error("PAPER_KILL_SWITCH_STATE_MISSING");
    }
    await appendLedgerEvent(tx, {
      idempotencyKey: `kill:${now.getTime()}`,
      eventType: "kill_switch_engaged",
      payload: { reason },
      eventTs: now,
    });
    const open = await tx.query(
      "SELECT order_id, token_id, condition_id FROM paper_orders WHERE status = 'open' FOR UPDATE",
    );
    for (const row of open.rows) {
      const orderId = asString(row["order_id"]);
      if (orderId === null) {
        continue;
      }
      await appendLedgerEvent(tx, {
        idempotencyKey: `${orderId}:cancel_effective`,
        eventType: "cancel_effective",
        orderId,
        tokenId: asString(row["token_id"]),
        conditionId: asString(row["condition_id"]),
        payload: { reason: "KILL_SWITCH" },
        eventTs: now,
      });
      await tx.query(
        "UPDATE paper_orders SET status = 'canceled', cancel_requested_at = COALESCE(cancel_requested_at, $2), cancel_effective_at = $2, closed_at = $2 WHERE order_id = $1 AND status = 'open'",
        [orderId, now],
      );
    }
    return open.rows.length;
  });
  log("error", "PAPER_KILL_SWITCH_ENGAGED", {
    reason,
    orders_canceled: ordersCanceled,
  });
}

export async function rearmKillSwitch(
  pool: PaperPool,
  now: Date,
): Promise<void> {
  if (!hasTransaction(pool)) {
    throw new Error("PAPER_BROKER_TRANSACTION_UNAVAILABLE");
  }
  await pool.transaction(async (tx: SqlExecutor) => {
    const rearmed = await tx.query(
      "UPDATE paper_kill_switch SET engaged = FALSE, reason = NULL, rearmed_at = $1, updated_at = $1 WHERE kill_switch_id = 1",
      [now],
    );
    if (rearmed.rowCount !== 1) {
      throw new Error("PAPER_KILL_SWITCH_STATE_MISSING");
    }
    await appendLedgerEvent(tx, {
      idempotencyKey: `rearm:${now.getTime()}`,
      eventType: "kill_switch_rearmed",
      payload: {},
      eventTs: now,
    });
  });
}

export async function freezeMarket(
  pool: PaperPool,
  conditionId: string,
  now: Date,
): Promise<void> {
  await pool.query(
    "UPDATE paper_kill_switch SET frozen_markets_json = (" +
      "SELECT jsonb_agg(DISTINCT value) FROM jsonb_array_elements_text(frozen_markets_json || to_jsonb($1::text)) AS t(value)" +
      "), updated_at = $2 WHERE kill_switch_id = 1",
    [conditionId, now],
  );
}

// ---------------------------------------------------------------------------
// Order acceptance (called by the API and by the RFC-013 bridge) and
// cancellation.

/**
 * Where a simulated order came from. `portfolio` is the RFC-013 bridge: the
 * portfolio engine's accepted entry, consumed here rather than pushed by it.
 */
export type OrderSource = "manual" | "intent" | "portfolio";

/**
 * True for every source that is a MODEL speaking rather than an operator.
 *
 * The resolution policy has to branch on this, and it deliberately branches on
 * "not manual" instead of listing the model-driven sources: a new source added
 * later inherits the strict side by default. Listing them would mean a future
 * source silently skips the sanity veto, which is how a veto stops being one.
 */
function modelDependent(source: OrderSource): boolean {
  return source !== "manual";
}

export interface AcceptInput {
  readonly orderId: string;
  readonly draft: OrderDraft;
  readonly conditionId: string | null;
  readonly source: OrderSource;
  /**
   * RFC-013 bridge: the portfolio decision this order came from. Required for
   * `source: "portfolio"` and forbidden otherwise (the migration checks both
   * directions), and unique, so one decision can never produce two orders.
   */
  readonly decisionId?: number | null;
  readonly policyReason?: string | null;
  readonly policyVersion?: string | null;
  /** Intent audit trail (task 9): q/q_lo/size_max as received. */
  readonly intent?: Record<string, unknown> | null;
  /**
   * RFC-012 task 17: when a manual order proceeds over a resolution VETO,
   * the override rides into the ledger (score/action/justification at the
   * decision instant) — the operator may disagree with the score, but the
   * disagreement stays auditable.
   */
  readonly resolutionOverride?: Record<string, unknown> | null;
}

export type AcceptOutcome =
  | { readonly status: "accepted"; readonly acceptedAt: Date }
  | {
      readonly status: "rejected";
      readonly httpStatus: number;
      readonly reason: string;
    };

class PaperAcceptanceRejected extends Error {
  public readonly httpStatus: number;
  public readonly reason: string;

  public constructor(httpStatus: number, reason: string) {
    super(reason);
    this.name = "PaperAcceptanceRejected";
    this.httpStatus = httpStatus;
    this.reason = reason;
  }
}

function isAuditedVetoOverride(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const override = value as Record<string, unknown>;
  const score = override["score"];
  const scoreVersion = override["score_version"];
  const justification = override["justification"];
  return (
    override["action"] === "VETO" &&
    typeof score === "string" &&
    /^(?:0\.[0-9]{6}|1\.000000)$/.test(score) &&
    typeof scoreVersion === "string" &&
    /^[0-9]+\.[0-9]+\.[0-9]+$/.test(scoreVersion) &&
    typeof justification === "string" &&
    justification.trim().length > 0
  );
}

export async function acceptPaperOrder(
  pool: PaperPool,
  input: AcceptInput,
  deps: BrokerDeps = {},
): Promise<AcceptOutcome> {
  const clock = deps.clock ?? ((): Date => new Date());
  const latencyMs = deps.latencyMs ?? DEFAULT_LATENCY_MS;
  const now = clock();

  const killSwitch = await loadKillSwitch(pool);
  if (killSwitch.engaged) {
    return {
      status: "rejected",
      httpStatus: 409,
      reason: "KILL_SWITCH_ENGAGED",
    };
  }
  if (
    input.conditionId !== null &&
    killSwitch.frozenMarkets.includes(input.conditionId)
  ) {
    return {
      status: "rejected",
      httpStatus: 409,
      reason: "MARKET_FROZEN_DISPUTE",
    };
  }

  if (input.conditionId === null) {
    return { status: "rejected", httpStatus: 422, reason: "UNKNOWN_MARKET" };
  }
  const conditionId = input.conditionId;
  const params = await paramsAtOrBefore(pool, conditionId, now);
  if (
    params === null ||
    params.tickSize === null ||
    params.minOrderSize === null
  ) {
    return {
      status: "rejected",
      httpStatus: 422,
      reason: "UNKNOWN_MARKET_PARAMS",
    };
  }

  const validated = validateOrder(
    input.draft,
    {
      tickSize: params.tickSize,
      minOrderSize: params.minOrderSize,
      negRisk: params.negRisk,
    },
    now.getTime(),
  );
  if (!validated.ok) {
    return { status: "rejected", httpStatus: 422, reason: validated.reason };
  }
  const order = validated.value;

  if (
    input.resolutionOverride !== undefined &&
    input.resolutionOverride !== null &&
    (input.source !== "manual" ||
      !isAuditedVetoOverride(input.resolutionOverride))
  ) {
    return {
      status: "rejected",
      httpStatus: 422,
      reason: "INVALID_RESOLUTION_OVERRIDE",
    };
  }

  // post-only: an order that would cross the recorded spread is rejected, as
  // the venue's post-only flag would do.
  if (order.postOnly) {
    const book = await bookAtOrBefore(pool, order.tokenId, now);
    const bestAsk = parseScaled(book?.asks[0]?.price ?? "");
    const bestBid = parseScaled(book?.bids[0]?.price ?? "");
    const limit = parseScaled(order.limitPrice);
    if (limit !== null) {
      const crosses =
        order.side === "BUY"
          ? bestAsk !== null && limit >= bestAsk
          : bestBid !== null && limit <= bestBid;
      if (crosses) {
        await appendLedgerEvent(pool, {
          idempotencyKey: `${input.orderId}:rejected`,
          eventType: "order_rejected",
          orderId: input.orderId,
          tokenId: order.tokenId,
          conditionId: input.conditionId,
          payload: { reason: "POST_ONLY_WOULD_CROSS" },
          eventTs: now,
        });
        return {
          status: "rejected",
          httpStatus: 422,
          reason: "POST_ONLY_WOULD_CROSS",
        };
      }
    }
  }

  if (!hasTransaction(pool)) {
    return {
      status: "rejected",
      httpStatus: 503,
      reason: "PAPER_BROKER_TRANSACTION_UNAVAILABLE",
    };
  }

  const acceptedAt = new Date(now.getTime() + latencyMs);
  try {
    return await pool.transaction(async (tx: SqlExecutor) => {
      // One authoritative acceptance revision: journal -> runtime -> derived
      // policy -> kill -> order/ledger. Source writers and the resolution
      // runner cannot publish a conflicting revision before this commit.
      await lockResolutionInputs(tx);
      try {
        if (await hasTerminalResolution(tx, conditionId)) {
          throw new PaperAcceptanceRejected(409, "MARKET_ALREADY_RESOLVED");
        }
      } catch (error: unknown) {
        if (error instanceof PaperAcceptanceRejected) {
          throw error;
        }
        throw new PaperAcceptanceRejected(503, "RESOLUTION_STATE_UNAVAILABLE");
      }
      let runtime: ResolutionRuntimeSnapshot | null;
      try {
        runtime = await loadLockedResolutionRuntime(tx);
      } catch {
        throw new PaperAcceptanceRejected(503, "RESOLUTION_STATE_UNAVAILABLE");
      }
      if (runtime === null) {
        throw new PaperAcceptanceRejected(503, "RESOLUTION_RUNTIME_MISSING");
      }
      const runtimeFailure = resolutionRuntimeFailure(
        runtime,
        runtime.generation,
      );
      if (runtimeFailure !== null) {
        throw new PaperAcceptanceRejected(503, runtimeFailure.reason);
      }
      await lockResolutionPolicyTables(tx);
      const policySubject: ResolutionPolicySubject = {
        conditionId,
        tokenId: order.tokenId,
        source: input.source,
        resolutionVetoOverride: isAuditedVetoOverride(input.resolutionOverride),
      };
      let policyResult: ResolutionOrderPolicyResult;
      try {
        policyResult = await loadResolutionOrderPolicy(tx, policySubject);
      } catch {
        throw new PaperAcceptanceRejected(503, "RESOLUTION_STATE_UNAVAILABLE");
      }
      if (!policyResult.ok) {
        throw new PaperAcceptanceRejected(503, policyResult.failure.reason);
      }
      const policyDenial = resolutionAcceptancePolicyDenial(
        policySubject,
        policyResult.policy,
      );
      if (policyDenial !== null) {
        throw new PaperAcceptanceRejected(409, policyDenial.reason);
      }

      const lockedKillSwitch = await loadLockedKillSwitch(tx);
      if (lockedKillSwitch.engaged) {
        throw new PaperAcceptanceRejected(409, "KILL_SWITCH_ENGAGED");
      }
      if (lockedKillSwitch.frozenMarkets.includes(conditionId)) {
        throw new PaperAcceptanceRejected(409, "MARKET_FROZEN_DISPUTE");
      }

      const resolutionGeneration = runtime.generation;
      await tx.query(
        "INSERT INTO paper_orders (order_id, token_id, condition_id, side, order_type, " +
          "limit_price, size, amount_usd, post_only, worst_price, expiration_s, " +
          "policy_reason, policy_version, source, status, decided_at, accepted_at, " +
          "resolution_generation, decision_id) " +
          "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'open',$15,$16,$17::uuid,$18)",
        [
          input.orderId,
          order.tokenId,
          conditionId,
          order.side,
          order.orderType,
          order.limitPrice,
          order.size,
          order.amountUsd,
          order.postOnly,
          order.worstPrice,
          order.expirationS,
          input.policyReason ?? null,
          input.policyVersion ?? null,
          input.source,
          now,
          acceptedAt,
          resolutionGeneration,
          input.decisionId ?? null,
        ],
      );
      const acceptedEventInserted = await appendLedgerEvent(tx, {
        idempotencyKey: `${input.orderId}:accepted`,
        eventType: "order_accepted",
        orderId: input.orderId,
        tokenId: order.tokenId,
        conditionId,
        payload: {
          side: order.side,
          order_type: order.orderType,
          limit_price: order.limitPrice,
          size: order.size,
          post_only: order.postOnly,
          worst_price: order.worstPrice,
          expiration_s: order.expirationS,
          simulated_latency_ms: latencyMs,
          source: input.source,
          decision_id: input.decisionId ?? null,
          policy_reason: input.policyReason ?? null,
          resolution_generation: resolutionGeneration,
          intent: input.intent ?? null,
          override_veto: input.resolutionOverride ?? null,
        },
        eventTs: now,
      });
      if (!acceptedEventInserted) {
        throw new Error("PAPER_ACCEPTANCE_LEDGER_CONFLICT");
      }
      // Locks prevent source/policy mutation, but time still advances. Re-read
      // clock_timestamp after persistence so equality with either expiry rolls
      // back both order and immutable acceptance audit.
      let finalRuntime: ResolutionRuntimeSnapshot | null;
      try {
        finalRuntime = await loadLockedResolutionRuntime(tx);
      } catch {
        throw new PaperAcceptanceRejected(503, "RESOLUTION_STATE_UNAVAILABLE");
      }
      const finalRuntimeFailure = resolutionRuntimeFailure(
        finalRuntime,
        resolutionGeneration,
      );
      if (finalRuntimeFailure !== null) {
        throw new PaperAcceptanceRejected(503, finalRuntimeFailure.reason);
      }
      try {
        policyResult = await loadResolutionOrderPolicy(tx, policySubject);
      } catch {
        throw new PaperAcceptanceRejected(503, "RESOLUTION_STATE_UNAVAILABLE");
      }
      if (!policyResult.ok) {
        throw new PaperAcceptanceRejected(503, policyResult.failure.reason);
      }
      const finalPolicyDenial = resolutionAcceptancePolicyDenial(
        policySubject,
        policyResult.policy,
      );
      if (finalPolicyDenial !== null) {
        throw new PaperAcceptanceRejected(409, finalPolicyDenial.reason);
      }
      return { status: "accepted", acceptedAt };
    });
  } catch (error: unknown) {
    if (error instanceof PaperAcceptanceRejected) {
      return {
        status: "rejected",
        httpStatus: error.httpStatus,
        reason: error.reason,
      };
    }
    throw error;
  }
}

export type CancelOutcome =
  | { readonly status: "requested" }
  | {
      readonly status: "rejected";
      readonly httpStatus: number;
      readonly reason: string;
    };

export async function requestCancel(
  pool: PaperPool,
  orderId: string,
  deps: BrokerDeps = {},
): Promise<CancelOutcome> {
  const clock = deps.clock ?? ((): Date => new Date());
  const now = clock();
  const result = await pool.query(
    "SELECT order_id, token_id, condition_id, order_type, status, accepted_at, cancel_requested_at " +
      "FROM paper_orders WHERE order_id = $1",
    [orderId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return { status: "rejected", httpStatus: 404, reason: "ORDER_NOT_FOUND" };
  }
  if (row["status"] !== "open") {
    return { status: "rejected", httpStatus: 409, reason: "ORDER_NOT_OPEN" };
  }
  const orderType = asString(row["order_type"]);
  const acceptedAt = toDate(row["accepted_at"]);
  if (
    (orderType === "FAK" || orderType === "FOK") &&
    acceptedAt !== null &&
    now.getTime() < acceptedAt.getTime() + TAKER_DELAY_MS
  ) {
    // B5: cancels are BLOCKED during the marketable-order delay.
    return {
      status: "rejected",
      httpStatus: 409,
      reason: "CANCEL_BLOCKED_TAKER_DELAY",
    };
  }
  if (row["cancel_requested_at"] !== null) {
    return { status: "requested" };
  }
  await pool.query(
    "UPDATE paper_orders SET cancel_requested_at = $2 WHERE order_id = $1 AND status = 'open'",
    [orderId, now],
  );
  await appendLedgerEvent(pool, {
    idempotencyKey: `${orderId}:cancel_requested`,
    eventType: "cancel_requested",
    orderId,
    tokenId: asString(row["token_id"]),
    conditionId: asString(row["condition_id"]),
    payload: {},
    eventTs: now,
  });
  return { status: "requested" };
}

// ---------------------------------------------------------------------------
// Position cache refresh: replay the token's events and upsert the cache row.

async function refreshPosition(
  pool: PaperPool,
  tokenId: string,
  conditionId: string | null,
): Promise<void> {
  const events = await loadTokenLedger(pool, tokenId);
  const state = replayLedger(events);
  const position = state.positions.get(tokenId);
  if (position === undefined) {
    return;
  }
  await pool.query(
    "INSERT INTO paper_positions (token_id, condition_id, shares, cost_usd, realized_pnl_usd, fees_paid_usd, opened_at, resolved_at, lockup_s, updated_at) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_TIMESTAMP) " +
      "ON CONFLICT (token_id) DO UPDATE SET " +
      "condition_id = EXCLUDED.condition_id, shares = EXCLUDED.shares, " +
      "cost_usd = EXCLUDED.cost_usd, realized_pnl_usd = EXCLUDED.realized_pnl_usd, " +
      "fees_paid_usd = EXCLUDED.fees_paid_usd, opened_at = EXCLUDED.opened_at, " +
      "resolved_at = EXCLUDED.resolved_at, lockup_s = EXCLUDED.lockup_s, " +
      "updated_at = CURRENT_TIMESTAMP",
    [
      tokenId,
      conditionId,
      position.shares,
      position.costUsd,
      position.realizedPnlUsd,
      position.feesPaidUsd,
      position.openedAt,
      position.resolvedAt,
      position.lockupS,
    ],
  );
}

async function loadTokenLedger(
  pool: PaperPool,
  tokenId: string,
): Promise<LedgerEventRecord[]> {
  const result = await pool.query(
    "SELECT idempotency_key, event_type, order_id, token_id, condition_id, payload_json, event_ts " +
      "FROM paper_ledger_events WHERE token_id = $1 ORDER BY event_id",
    [tokenId],
  );
  const events: LedgerEventRecord[] = [];
  for (const row of result.rows) {
    const key = asString(row["idempotency_key"]);
    const type = asString(row["event_type"]);
    const ts = toDate(row["event_ts"]);
    if (key === null || type === null || ts === null) {
      continue;
    }
    events.push({
      idempotencyKey: key,
      eventType: type as LedgerEventType,
      orderId: asString(row["order_id"]),
      tokenId,
      conditionId: asString(row["condition_id"]),
      payload:
        typeof row["payload_json"] === "object" && row["payload_json"] !== null
          ? (row["payload_json"] as Record<string, unknown>)
          : {},
      eventTs: ts,
    });
  }
  return events;
}

async function loadPositionShares(
  pool: PaperPool,
  tokenId: string,
): Promise<bigint> {
  const state = replayLedger(await loadTokenLedger(pool, tokenId));
  const position = state.positions.get(tokenId);
  if (position === undefined) {
    return 0n;
  }
  const shares = parseScaled(position.shares);
  if (shares === null) {
    throw new Error("INVALID_LEDGER_POSITION_SHARES");
  }
  return shares;
}

// ---------------------------------------------------------------------------
// The processing tick.

interface OpenOrderRow {
  readonly orderId: string;
  readonly tokenId: string;
  readonly conditionId: string | null;
  readonly side: "BUY" | "SELL";
  readonly orderType: "GTC" | "GTD" | "FAK" | "FOK";
  readonly limitPrice: string;
  readonly size: string;
  readonly filledSize: string;
  readonly postOnly: boolean;
  readonly worstPrice: string | null;
  readonly expirationS: number | null;
  readonly queueAhead: string | null;
  readonly acceptedAt: Date | null;
  readonly cancelRequestedAt: Date | null;
  readonly resolutionGeneration: string | null;
  readonly resolutionRiskCheckPending: boolean;
  readonly resolutionRiskClaim: string | null;
  readonly resolutionRiskClaimedAt: Date | null;
  readonly source: OrderSource;
  readonly resolutionVetoOverride: boolean;
}

function parseOpenOrder(row: Record<string, unknown>): OpenOrderRow | null {
  const orderId = asString(row["order_id"]);
  const tokenId = asString(row["token_id"]);
  const side = row["side"];
  const orderType = row["order_type"];
  const source = row["source"];
  const limitPrice = asString(row["limit_price"]);
  const size = asString(row["size"]);
  if (
    orderId === null ||
    tokenId === null ||
    (side !== "BUY" && side !== "SELL") ||
    (orderType !== "GTC" &&
      orderType !== "GTD" &&
      orderType !== "FAK" &&
      orderType !== "FOK") ||
    (source !== "manual" && source !== "intent" && source !== "portfolio") ||
    limitPrice === null ||
    size === null
  ) {
    return null;
  }
  const expirationRaw = row["expiration_s"];
  return {
    orderId,
    tokenId,
    conditionId: asString(row["condition_id"]),
    side,
    orderType,
    limitPrice,
    size,
    filledSize: asString(row["filled_size"]) ?? "0",
    postOnly: row["post_only"] === true,
    worstPrice: asString(row["worst_price"]),
    expirationS:
      typeof expirationRaw === "number"
        ? expirationRaw
        : typeof expirationRaw === "string" && /^\d+$/.test(expirationRaw)
          ? Number(expirationRaw)
          : null,
    queueAhead: asString(row["queue_ahead"]),
    acceptedAt: toDate(row["accepted_at"]),
    cancelRequestedAt: toDate(row["cancel_requested_at"]),
    resolutionGeneration: asString(row["resolution_generation"]),
    resolutionRiskCheckPending: row["resolution_risk_check_pending"] === true,
    resolutionRiskClaim: asString(row["resolution_risk_claim"]),
    resolutionRiskClaimedAt: toDate(row["resolution_risk_claimed_at"]),
    source,
    resolutionVetoOverride: row["resolution_veto_override"] === true,
  };
}

async function loadOpenOrders(pool: PaperPool): Promise<OpenOrderRow[]> {
  const result = await pool.query(
    "SELECT o.order_id, o.token_id, o.condition_id, o.side, o.order_type, o.limit_price, o.size, o.filled_size, " +
      "o.post_only, o.worst_price, o.expiration_s, o.queue_ahead, o.accepted_at, o.cancel_requested_at, " +
      "o.resolution_generation, o.resolution_risk_check_pending, " +
      "o.resolution_risk_claim, o.resolution_risk_claimed_at, o.source, " +
      "EXISTS (SELECT 1 FROM paper_ledger_events accepted " +
      "WHERE accepted.order_id = o.order_id AND accepted.event_type = 'order_accepted' " +
      "AND jsonb_typeof(accepted.payload_json->'override_veto') = 'object' " +
      "AND jsonb_typeof(accepted.payload_json->'override_veto'->'action') = 'string' " +
      "AND accepted.payload_json->'override_veto'->>'action' = 'VETO' " +
      "AND jsonb_typeof(accepted.payload_json->'override_veto'->'score') = 'string' " +
      "AND accepted.payload_json->'override_veto'->>'score' ~ '^(0\\.[0-9]{6}|1\\.000000)$' " +
      "AND jsonb_typeof(accepted.payload_json->'override_veto'->'score_version') = 'string' " +
      "AND accepted.payload_json->'override_veto'->>'score_version' ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$' " +
      "AND jsonb_typeof(accepted.payload_json->'override_veto'->'justification') = 'string' " +
      "AND btrim(accepted.payload_json->'override_veto'->>'justification') <> '') AS resolution_veto_override " +
      "FROM paper_orders o WHERE o.status = 'open' ORDER BY o.created_at",
  );
  const orders: OpenOrderRow[] = [];
  for (const row of result.rows) {
    const parsed = parseOpenOrder(row);
    if (parsed !== null) {
      orders.push(parsed);
    }
  }
  return orders;
}

async function loadLockedOpenOrder(
  pool: PaperPool,
  orderId: string,
): Promise<OpenOrderRow | null> {
  const result = await pool.query(
    "SELECT o.order_id, o.token_id, o.condition_id, o.side, o.order_type, o.limit_price, o.size, o.filled_size, " +
      "o.post_only, o.worst_price, o.expiration_s, o.queue_ahead, o.accepted_at, o.cancel_requested_at, " +
      "o.resolution_generation, o.resolution_risk_check_pending, " +
      "o.resolution_risk_claim, o.resolution_risk_claimed_at, o.source, " +
      "EXISTS (SELECT 1 FROM paper_ledger_events accepted " +
      "WHERE accepted.order_id = o.order_id AND accepted.event_type = 'order_accepted' " +
      "AND jsonb_typeof(accepted.payload_json->'override_veto') = 'object' " +
      "AND jsonb_typeof(accepted.payload_json->'override_veto'->'action') = 'string' " +
      "AND accepted.payload_json->'override_veto'->>'action' = 'VETO' " +
      "AND jsonb_typeof(accepted.payload_json->'override_veto'->'score') = 'string' " +
      "AND accepted.payload_json->'override_veto'->>'score' ~ '^(0\\.[0-9]{6}|1\\.000000)$' " +
      "AND jsonb_typeof(accepted.payload_json->'override_veto'->'score_version') = 'string' " +
      "AND accepted.payload_json->'override_veto'->>'score_version' ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$' " +
      "AND jsonb_typeof(accepted.payload_json->'override_veto'->'justification') = 'string' " +
      "AND btrim(accepted.payload_json->'override_veto'->>'justification') <> '') AS resolution_veto_override " +
      "FROM paper_orders o WHERE o.order_id = $1 AND o.status = 'open' FOR UPDATE OF o",
    [orderId],
  );
  const row = result.rows[0];
  return row === undefined ? null : parseOpenOrder(row);
}

function exposureReductionCapacity(
  positionShares: bigint,
  side: "BUY" | "SELL",
): bigint {
  if (positionShares > 0n && side === "SELL") {
    return positionShares;
  }
  if (positionShares < 0n && side === "BUY") {
    return -positionShares;
  }
  return 0n;
}

/** Sum of visible size resting at exactly `price` on the order's own side. */
function visibleSizeAtLevel(
  book: BookAt,
  side: "BUY" | "SELL",
  priceStr: string,
): string {
  const target = parseScaled(priceStr);
  const levels = side === "BUY" ? book.bids : book.asks;
  let total = 0n;
  for (const level of levels) {
    const price = parseScaled(level.price);
    const size = parseScaled(level.size);
    if (
      price !== null &&
      size !== null &&
      target !== null &&
      price === target
    ) {
      total += size;
    }
  }
  return formatScaled(total, 6);
}

interface LevelTrade {
  readonly tradeId: string;
  readonly size: string;
  readonly ts: Date;
}

async function tradesAtLevel(
  pool: PaperPool,
  tokenId: string,
  price: string,
  after: Date,
  until: Date,
): Promise<LevelTrade[]> {
  const result = await pool.query(
    "SELECT trade_id, size, COALESCE(trade_ts, received_at) AS effective_ts " +
      "FROM polymarket_trades " +
      "WHERE token_id = $1 AND size IS NOT NULL AND price::numeric = $2::numeric " +
      "AND COALESCE(trade_ts, received_at) > $3 " +
      "AND COALESCE(trade_ts, received_at) <= $4 " +
      "ORDER BY COALESCE(trade_ts, received_at), trade_id",
    [tokenId, price, after, until],
  );
  const trades: LevelTrade[] = [];
  for (const row of result.rows) {
    const size = asString(row["size"]);
    const ts = toDate(row["effective_ts"]);
    const idRaw = row["trade_id"];
    const tradeId =
      typeof idRaw === "string"
        ? idRaw
        : typeof idRaw === "number"
          ? String(idRaw)
          : null;
    if (size === null || ts === null || tradeId === null) {
      continue;
    }
    trades.push({ tradeId, size, ts });
  }
  return trades;
}

async function persistedPassiveFillKeys(
  pool: PaperPool,
  orderId: string,
): Promise<Set<string>> {
  const result = await pool.query(
    "SELECT idempotency_key FROM paper_ledger_events " +
      "WHERE order_id = $1 AND event_type = 'fill'",
    [orderId],
  );
  return new Set(
    result.rows
      .map((row) => asString(row["idempotency_key"]))
      .filter((key): key is string => key !== null),
  );
}

async function closeOrder(
  pool: PaperPool,
  orderId: string,
  status: "filled" | "canceled" | "expired",
  filledSize: string,
  at: Date,
): Promise<void> {
  await pool.query(
    "UPDATE paper_orders SET status = $2, filled_size = $3, closed_at = $4, " +
      "resolution_risk_check_pending = FALSE, resolution_risk_claim = NULL, " +
      "resolution_risk_claimed_at = NULL WHERE order_id = $1 AND status = 'open'",
    [orderId, status, filledSize, at],
  );
}

async function cancelForResolutionRisk(
  pool: PaperPool,
  order: OpenOrderRow,
  reason: string,
  at: Date,
  details: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  await pool.query(
    "UPDATE paper_orders SET resolution_cancel_reason = $2, " +
      "resolution_cancel_details_json = $3::jsonb " +
      "WHERE order_id = $1 AND status = 'open'",
    [order.orderId, reason, JSON.stringify(details)],
  );
  await appendLedgerEvent(pool, {
    idempotencyKey: `${order.orderId}:resolution_circuit_breaker`,
    eventType: "cancel_effective",
    orderId: order.orderId,
    tokenId: order.tokenId,
    conditionId: order.conditionId,
    payload: { reason, side: order.side, ...details },
    eventTs: at,
  });
  await closeOrder(pool, order.orderId, "canceled", order.filledSize, at);
}

interface ResolutionRuntimeSnapshot {
  readonly generation: string;
  readonly ready: boolean;
  readonly stoppedAt: Date | null;
  readonly leaseExpiresAt: Date | null;
  readonly graphEvaluatedAt: Date | null;
  readonly graphValidUntil: Date | null;
  readonly checkedAt: Date;
  readonly processedEventId: bigint;
  readonly processedRuleVersionId: bigint;
  readonly processedInputChangeId: bigint;
  readonly eventHead: bigint;
  readonly ruleHead: bigint;
  readonly inputHead: bigint;
}

class ResolutionRiskCheckError extends Error {
  public readonly cancellationReason: string;
  public readonly logReason: string;

  public constructor(
    cancellationReason: string,
    logReason: string,
    cause: unknown,
  ) {
    super(
      cause instanceof Error ? cause.message : "resolution risk check failed",
    );
    this.name = "ResolutionRiskCheckError";
    this.cancellationReason = cancellationReason;
    this.logReason = logReason;
  }
}

interface ResolutionOrderPolicy {
  readonly effectiveAction: ResolutionAction;
  readonly sanityVetoActive: boolean;
}

interface ResolutionPolicySubject {
  readonly conditionId: string | null;
  readonly tokenId: string;
  readonly source: OrderSource;
  readonly resolutionVetoOverride: boolean;
}

interface ResolutionOrderPolicyFailure {
  readonly reason: string;
  readonly details: Readonly<Record<string, unknown>>;
}

type ResolutionOrderPolicyResult =
  | { readonly ok: true; readonly policy: ResolutionOrderPolicy }
  | { readonly ok: false; readonly failure: ResolutionOrderPolicyFailure };

async function loadResolutionOrderPolicy(
  pool: PaperPool,
  order: ResolutionPolicySubject,
): Promise<ResolutionOrderPolicyResult> {
  if (order.conditionId === null) {
    return {
      ok: false,
      failure: {
        reason: "RESOLUTION_MARKET_STATE_MISSING",
        details: { condition_id: null },
      },
    };
  }
  let state;
  try {
    state = await pool.query(
      `SELECT effective_action FROM resolution_market_state
        WHERE condition_id = $1`,
      [order.conditionId],
    );
  } catch (error: unknown) {
    throw new ResolutionRiskCheckError(
      "RESOLUTION_STATE_UNAVAILABLE",
      "RESOLUTION_STATE_READ_FAILED",
      error,
    );
  }
  const effectiveAction = state.rows[0]?.["effective_action"];
  if (effectiveAction === undefined) {
    return {
      ok: false,
      failure: {
        reason: "RESOLUTION_MARKET_STATE_MISSING",
        details: { condition_id: order.conditionId },
      },
    };
  }
  if (
    effectiveAction !== "NONE" &&
    effectiveAction !== "BUFFER" &&
    effectiveAction !== "VETO" &&
    effectiveAction !== "CIRCUIT_BREAKER"
  ) {
    return {
      ok: false,
      failure: {
        reason: "RESOLUTION_MARKET_STATE_INVALID",
        details: {
          condition_id: order.conditionId,
          effective_action:
            typeof effectiveAction === "string" ? effectiveAction : null,
        },
      },
    };
  }

  let sanityVetoActive = false;
  if (modelDependent(order.source)) {
    let veto;
    try {
      veto = await pool.query(
        `SELECT veto_id FROM graph_sanity_vetoes
          WHERE token_id = $1 AND ended_at IS NULL
          LIMIT 1`,
        [order.tokenId],
      );
    } catch (error: unknown) {
      throw new ResolutionRiskCheckError(
        "RESOLUTION_SANITY_VETO_UNAVAILABLE",
        "RESOLUTION_SANITY_VETO_READ_FAILED",
        error,
      );
    }
    sanityVetoActive = veto.rows.length > 0;
  }
  return {
    ok: true,
    policy: { effectiveAction, sanityVetoActive },
  };
}

function resolutionOrderPolicyDenial(
  order: ResolutionPolicySubject,
  policy: ResolutionOrderPolicy,
): ResolutionOrderPolicyFailure | null {
  if (
    policy.effectiveAction === "VETO" &&
    (modelDependent(order.source) || !order.resolutionVetoOverride)
  ) {
    return {
      reason: "RESOLUTION_VETO",
      details: {
        source: order.source,
        override_veto_audited: order.resolutionVetoOverride,
      },
    };
  }
  if (modelDependent(order.source) && policy.sanityVetoActive) {
    return {
      reason: "SANITY_VETO_ACTIVE",
      details: { source: order.source, token_id: order.tokenId },
    };
  }
  return null;
}

function resolutionAcceptancePolicyDenial(
  order: ResolutionPolicySubject,
  policy: ResolutionOrderPolicy,
): ResolutionOrderPolicyFailure | null {
  if (policy.effectiveAction === "CIRCUIT_BREAKER") {
    return {
      reason: "RESOLUTION_CIRCUIT_BREAKER",
      details: { source: order.source, condition_id: order.conditionId },
    };
  }
  return resolutionOrderPolicyDenial(order, policy);
}

async function assertResolutionPolicyForFill(
  pool: PaperPool,
  order: OpenOrderRow,
  fillSize: string,
): Promise<void> {
  const result = await loadResolutionOrderPolicy(pool, order);
  if (!result.ok) {
    throw new ResolutionRiskCheckError(
      result.failure.reason,
      "RESOLUTION_POLICY_RECHECK_FAILED",
      new Error(result.failure.reason),
    );
  }
  const denial = resolutionOrderPolicyDenial(order, result.policy);
  if (denial !== null) {
    throw new ResolutionRiskCheckError(
      denial.reason,
      "RESOLUTION_POLICY_RECHECK_FAILED",
      new Error(denial.reason),
    );
  }
  if (result.policy.effectiveAction !== "CIRCUIT_BREAKER") {
    return;
  }
  const parsedFillSize = parseScaled(fillSize);
  let positionShares: bigint;
  try {
    positionShares = await loadPositionShares(pool, order.tokenId);
  } catch (error: unknown) {
    throw new ResolutionRiskCheckError(
      "RESOLUTION_POSITION_UNAVAILABLE",
      "PAPER_POSITION_READ_FAILED_CIRCUIT_BREAKER",
      error,
    );
  }
  const capacity = exposureReductionCapacity(positionShares, order.side);
  if (
    parsedFillSize === null ||
    parsedFillSize <= 0n ||
    capacity < parsedFillSize
  ) {
    throw new ResolutionRiskCheckError(
      "RESOLUTION_CIRCUIT_BREAKER_EXPOSURE_INCREASE",
      "RESOLUTION_POLICY_RECHECK_FAILED",
      new Error("circuit breaker forbids this fill"),
    );
  }
}

async function assertResolutionPolicyStillAuthorizesOrder(
  pool: PaperPool,
  order: OpenOrderRow,
): Promise<void> {
  const result = await loadResolutionOrderPolicy(pool, order);
  if (!result.ok) {
    throw new ResolutionRiskCheckError(
      result.failure.reason,
      "RESOLUTION_POLICY_RECHECK_FAILED",
      new Error(result.failure.reason),
    );
  }
  const denial = resolutionOrderPolicyDenial(order, result.policy);
  if (denial !== null) {
    throw new ResolutionRiskCheckError(
      denial.reason,
      "RESOLUTION_POLICY_RECHECK_FAILED",
      new Error(denial.reason),
    );
  }
}

function parseBigInt(value: unknown): bigint | null {
  try {
    return BigInt(String(value));
  } catch {
    return null;
  }
}

async function loadLockedResolutionRuntime(
  pool: PaperPool,
): Promise<ResolutionRuntimeSnapshot | null> {
  const result = await pool.query(
    `SELECT r.generation, r.ready, r.stopped_at, r.lease_expires_at,
            r.graph_evaluated_at, r.graph_valid_until,
            clock_timestamp() AS checked_at,
            r.processed_resolution_event_id,
            r.processed_rule_version_id,
            r.processed_input_change_id,
            (SELECT COALESCE(MAX(resolution_event_id), 0)
               FROM polymarket_resolution_events) AS event_head,
            (SELECT COALESCE(MAX(rule_version_id), 0)
               FROM polymarket_rule_versions) AS rule_head,
            (SELECT COALESCE(MAX(input_change_id), 0)
               FROM polymarket_resolution_input_changes) AS input_head
       FROM resolution_runtime_state r
      WHERE r.runtime_id = 1
      FOR SHARE OF r`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  const generation = asString(row["generation"]);
  const checkedAt = toDate(row["checked_at"]);
  const processedEventId = parseBigInt(row["processed_resolution_event_id"]);
  const processedRuleVersionId = parseBigInt(row["processed_rule_version_id"]);
  const processedInputChangeId = parseBigInt(row["processed_input_change_id"]);
  const eventHead = parseBigInt(row["event_head"]);
  const ruleHead = parseBigInt(row["rule_head"]);
  const inputHead = parseBigInt(row["input_head"]);
  if (
    generation === null ||
    checkedAt === null ||
    processedEventId === null ||
    processedRuleVersionId === null ||
    processedInputChangeId === null ||
    eventHead === null ||
    ruleHead === null ||
    inputHead === null
  ) {
    return null;
  }
  return {
    generation,
    ready: row["ready"] === true,
    stoppedAt: toDate(row["stopped_at"]),
    leaseExpiresAt: toDate(row["lease_expires_at"]),
    graphEvaluatedAt: toDate(row["graph_evaluated_at"]),
    graphValidUntil: toDate(row["graph_valid_until"]),
    checkedAt,
    processedEventId,
    processedRuleVersionId,
    processedInputChangeId,
    eventHead,
    ruleHead,
    inputHead,
  };
}

function resolutionRuntimeFailure(
  runtime: ResolutionRuntimeSnapshot | null,
  expectedGeneration: string | null,
): {
  readonly reason: string;
  readonly details: Record<string, unknown>;
} | null {
  if (runtime === null) {
    return { reason: "RESOLUTION_RUNTIME_MISSING", details: {} };
  }
  if (!runtime.ready) {
    return {
      reason: "RESOLUTION_RUNTIME_NOT_READY",
      details: { generation: runtime.generation },
    };
  }
  if (runtime.stoppedAt !== null) {
    return {
      reason: "RESOLUTION_RUNTIME_STOPPED",
      details: {
        generation: runtime.generation,
        stopped_at: runtime.stoppedAt.toISOString(),
      },
    };
  }
  if (
    runtime.leaseExpiresAt === null ||
    runtime.leaseExpiresAt.getTime() <= runtime.checkedAt.getTime()
  ) {
    return {
      reason: "RESOLUTION_RUNTIME_STALE",
      details: {
        generation: runtime.generation,
        lease_expires_at: runtime.leaseExpiresAt?.toISOString() ?? null,
        checked_at: runtime.checkedAt.toISOString(),
      },
    };
  }
  if (runtime.graphEvaluatedAt === null || runtime.graphValidUntil === null) {
    return {
      reason: "RESOLUTION_GRAPH_NOT_READY",
      details: {
        generation: runtime.generation,
        graph_evaluated_at: runtime.graphEvaluatedAt?.toISOString() ?? null,
        graph_valid_until: runtime.graphValidUntil?.toISOString() ?? null,
      },
    };
  }
  if (runtime.graphValidUntil.getTime() <= runtime.checkedAt.getTime()) {
    return {
      reason: "RESOLUTION_GRAPH_STALE",
      details: {
        generation: runtime.generation,
        graph_evaluated_at: runtime.graphEvaluatedAt.toISOString(),
        graph_valid_until: runtime.graphValidUntil.toISOString(),
        checked_at: runtime.checkedAt.toISOString(),
      },
    };
  }
  if (
    runtime.processedEventId < runtime.eventHead ||
    runtime.processedRuleVersionId < runtime.ruleHead ||
    runtime.processedInputChangeId < runtime.inputHead
  ) {
    return {
      reason: "RESOLUTION_RUNTIME_LAGGING",
      details: {
        processed_event_id: runtime.processedEventId.toString(),
        event_head: runtime.eventHead.toString(),
        processed_rule_version_id: runtime.processedRuleVersionId.toString(),
        rule_head: runtime.ruleHead.toString(),
        processed_input_change_id: runtime.processedInputChangeId.toString(),
        input_head: runtime.inputHead.toString(),
      },
    };
  }
  if (expectedGeneration !== runtime.generation) {
    return {
      reason: "RESOLUTION_RUNTIME_GENERATION_MISMATCH",
      details: {
        order_generation: expectedGeneration,
        runtime_generation: runtime.generation,
      },
    };
  }
  return null;
}

function hasTransaction(
  pool: PaperPool,
): pool is PaperPool & Pick<DatabasePool, "transaction"> {
  return typeof pool.transaction === "function";
}

async function claimResolutionRiskCheck(
  pool: PaperPool,
  orderId: string,
  at: Date,
): Promise<string | null> {
  const claim = randomUUID();
  const result = await pool.query(
    `UPDATE paper_orders
        SET resolution_risk_check_pending = TRUE,
            resolution_risk_claim = $2::uuid,
            resolution_risk_claimed_at = $3
      WHERE order_id = $1 AND status = 'open'
        AND resolution_risk_check_pending = FALSE
      RETURNING order_id`,
    [orderId, claim, at],
  );
  return result.rowCount === 1 ? claim : null;
}

async function clearResolutionRiskCheck(
  pool: PaperPool,
  orderId: string,
): Promise<void> {
  await pool.query(
    `UPDATE paper_orders
        SET resolution_risk_check_pending = FALSE,
            resolution_risk_claim = NULL,
            resolution_risk_claimed_at = NULL
      WHERE order_id = $1 AND status = 'open'`,
    [orderId],
  );
}

async function lockResolutionInputs(pool: PaperPool): Promise<void> {
  // SHARE conflicts with the ROW EXCLUSIVE lock taken by INSERT/UPDATE. The
  // journal trigger cannot advance between the watermark check and fill. It
  // also avoids a cross-source lock cycle with versioning writers: their
  // source changes are invisible until the trigger can append and commit.
  await pool.query(
    "LOCK TABLE polymarket_resolution_input_changes IN SHARE MODE",
  );
}

async function hasTerminalResolution(
  pool: PaperPool,
  conditionId: string,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT resolution_event_id
       FROM polymarket_resolution_events
      WHERE condition_id = $1
        AND event_type IN ('resolved', 'market_resolved')
      ORDER BY received_at DESC, resolution_event_id DESC
      LIMIT 1`,
    [conditionId],
  );
  return result.rows.length > 0;
}

async function lockResolutionPolicyTables(pool: PaperPool): Promise<void> {
  // Acquired after the runtime row. This closes the last policy-to-fill window:
  // neither recompute nor graph sanity may UPDATE/INSERT policy rows before the
  // execution transaction commits.
  await pool.query(
    "LOCK TABLE resolution_market_state, graph_sanity_vetoes IN SHARE MODE",
  );
}

async function revalidateResolutionRuntimeForFill(
  pool: PaperPool,
  expectedGeneration: string | null,
): Promise<void> {
  let runtime: ResolutionRuntimeSnapshot | null;
  try {
    runtime = await loadLockedResolutionRuntime(pool);
  } catch (error: unknown) {
    throw new ResolutionRiskCheckError(
      "RESOLUTION_STATE_UNAVAILABLE",
      "RESOLUTION_RUNTIME_RECHECK_FAILED",
      error,
    );
  }
  const failure = resolutionRuntimeFailure(runtime, expectedGeneration);
  if (failure !== null) {
    throw new ResolutionRiskCheckError(
      failure.reason,
      "RESOLUTION_RUNTIME_RECHECK_FAILED",
      new Error(failure.reason),
    );
  }
}

async function lockToken(pool: PaperPool, tokenId: string): Promise<void> {
  await pool.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    tokenId,
  ]);
}

/**
 * When the oldest journal entry the runtime has not processed arrived.
 *
 * This is what "how long has the runtime been behind" means without any
 * per-order memory: the journals are append-only and timestamped, so the age
 * of the first unprocessed row IS the age of the lag, and it survives process
 * restarts. Journals the runtime is caught up on contribute nothing (LEAST
 * ignores their NULL).
 */
async function oldestUnprocessedReceivedAt(
  pool: PaperPool,
  runtime: ResolutionRuntimeSnapshot,
): Promise<Date | null> {
  const result = await pool.query(
    `SELECT LEAST(
        (SELECT min(received_at) FROM polymarket_resolution_events
          WHERE resolution_event_id > $1),
        (SELECT min(received_at) FROM polymarket_rule_versions
          WHERE rule_version_id > $2),
        (SELECT min(received_at) FROM polymarket_resolution_input_changes
          WHERE input_change_id > $3)
      ) AS oldest_unprocessed`,
    [
      runtime.processedEventId.toString(),
      runtime.processedRuleVersionId.toString(),
      runtime.processedInputChangeId.toString(),
    ],
  );
  return toDate(result.rows[0]?.["oldest_unprocessed"] ?? null);
}

async function finalizePendingRiskCancellation(
  pool: PaperPool & Pick<DatabasePool, "transaction">,
  orderId: string,
  at: Date,
  ownedClaim: string | null,
  reason: string,
): Promise<boolean> {
  return pool.transaction(async (tx: SqlExecutor) => {
    const order = await loadLockedOpenOrder(tx, orderId);
    if (order === null || !order.resolutionRiskCheckPending) {
      return false;
    }
    const owned =
      ownedClaim !== null && order.resolutionRiskClaim === ownedClaim;
    const abandoned =
      ownedClaim === null &&
      order.resolutionRiskClaimedAt !== null &&
      at.getTime() - order.resolutionRiskClaimedAt.getTime() >=
        RESOLUTION_RISK_CLAIM_STALE_MS;
    if (!owned && !abandoned) {
      return false;
    }
    await lockToken(tx, order.tokenId);
    await cancelForResolutionRisk(tx, order, reason, at);
    return true;
  });
}

/** One full processing tick. Idempotent: safe to re-run over the same data. */
export async function brokerTick(
  pool: PaperPool,
  deps: BrokerDeps = {},
): Promise<void> {
  const clock = deps.clock ?? ((): Date => new Date());
  const latencyMs = deps.latencyMs ?? DEFAULT_LATENCY_MS;
  const log = makeLog(deps.logSink);
  const orders = await loadOpenOrders(pool);
  if (!hasTransaction(pool)) {
    // Executing without a single PostgreSQL transaction would reopen the
    // runtime/head and position TOCTOU windows. Fail closed before claiming or
    // touching an order; production always supplies DatabasePool.
    log("error", "PAPER_BROKER_TRANSACTION_UNAVAILABLE", {
      open_orders: orders.length,
    });
    return;
  }
  let ordersCanceled = 0;

  for (const snapshot of orders) {
    // A tick may contain many orders. Lease validity is checked against a
    // fresh instant per order so an early tick timestamp cannot outlive the
    // resolution runtime while later orders are still being processed.
    const now = clock();
    const claim = await claimResolutionRiskCheck(pool, snapshot.orderId, now);
    if (claim === null) {
      try {
        if (
          await finalizePendingRiskCancellation(
            pool,
            snapshot.orderId,
            now,
            null,
            "RESOLUTION_RISK_CHECK_INCOMPLETE",
          )
        ) {
          ordersCanceled += 1;
        }
      } catch (error: unknown) {
        log("error", "PAPER_RISK_CANCEL_RETRY_FAILED", {
          order_id: snapshot.orderId,
          error_name: error instanceof Error ? error.name : "UnknownError",
        });
      }
      continue;
    }
    try {
      await pool.transaction(async (tx: SqlExecutor) => {
        // Freeze new resolution inputs, then freeze the runtime generation.
        // Recorder INSERTs take ROW EXCLUSIVE and wait until this short
        // execution transaction commits.
        await lockResolutionInputs(tx);
        let runtime: ResolutionRuntimeSnapshot | null;
        try {
          runtime = await loadLockedResolutionRuntime(tx);
        } catch (error: unknown) {
          throw new ResolutionRiskCheckError(
            "RESOLUTION_STATE_UNAVAILABLE",
            "RESOLUTION_STATE_READ_FAILED",
            error,
          );
        }
        await lockResolutionPolicyTables(tx);
        // Keep the global order journal -> runtime -> policy -> kill -> order
        // -> token. engage/freeze update this row before touching orders, so a
        // committed hard stop is either observed here or waits until this
        // transaction has fully completed.
        const killSwitch = await loadLockedKillSwitch(tx);
        const order = await loadLockedOpenOrder(tx, snapshot.orderId);
        if (order === null) {
          return;
        }
        await lockToken(tx, order.tokenId);

        if (order.conditionId !== null) {
          let terminal: boolean;
          try {
            terminal = await hasTerminalResolution(tx, order.conditionId);
          } catch (error: unknown) {
            throw new ResolutionRiskCheckError(
              "RESOLUTION_STATE_UNAVAILABLE",
              "RESOLUTION_TERMINAL_READ_FAILED",
              error,
            );
          }
          if (terminal) {
            await cancelForResolutionRisk(
              tx,
              order,
              "MARKET_ALREADY_RESOLVED",
              now,
            );
            ordersCanceled += 1;
            return;
          }
        }

        if (killSwitch.engaged) {
          await cancelForResolutionRisk(tx, order, "KILL_SWITCH_ENGAGED", now, {
            kill_switch_reason: killSwitch.reason,
          });
          ordersCanceled += 1;
          return;
        }
        if (
          order.conditionId !== null &&
          killSwitch.frozenMarkets.includes(order.conditionId)
        ) {
          await cancelForResolutionRisk(
            tx,
            order,
            "MARKET_FROZEN_DISPUTE",
            now,
          );
          ordersCanceled += 1;
          return;
        }

        const runtimeFailure = resolutionRuntimeFailure(
          runtime,
          order.resolutionGeneration,
        );
        if (runtimeFailure !== null) {
          let cancelDetails = runtimeFailure.details;
          if (
            runtimeFailure.reason === "RESOLUTION_RUNTIME_LAGGING" &&
            runtime !== null
          ) {
            // An OPEN order under a lagging runtime is only canceled when the
            // lag PERSISTS — the journal advancing one tick before the
            // runtime's next cycle is routine, not a failure. FILLS are a
            // different question and keep the strict rule: every fill path
            // revalidates the runtime against every head and refuses while any
            // journal is ahead, grace or no grace.
            let lagSince: Date | null = null;
            try {
              lagSince = await oldestUnprocessedReceivedAt(tx, runtime);
            } catch {
              // Unmeasurable lag age: fall through to the cancel, as before.
              lagSince = null;
            }
            const lagAgeMs =
              lagSince === null
                ? null
                : Math.max(now.getTime() - lagSince.getTime(), 0);
            if (
              lagAgeMs !== null &&
              lagAgeMs < RESOLUTION_LAG_CANCEL_GRACE_MS
            ) {
              await clearResolutionRiskCheck(tx, order.orderId);
              log("warn", "PAPER_ORDER_RUNTIME_LAG_GRACE", {
                order_id: order.orderId,
                lag_age_ms: lagAgeMs,
                grace_ms: RESOLUTION_LAG_CANCEL_GRACE_MS,
                ...runtimeFailure.details,
              });
              return;
            }
            cancelDetails = {
              ...runtimeFailure.details,
              lag_age_ms: lagAgeMs,
              grace_ms: RESOLUTION_LAG_CANCEL_GRACE_MS,
            };
          }
          await cancelForResolutionRisk(
            tx,
            order,
            runtimeFailure.reason,
            now,
            cancelDetails,
          );
          ordersCanceled += 1;
          return;
        }

        const policyResult = await loadResolutionOrderPolicy(tx, order);
        if (!policyResult.ok) {
          await cancelForResolutionRisk(
            tx,
            order,
            policyResult.failure.reason,
            now,
            policyResult.failure.details,
          );
          ordersCanceled += 1;
          return;
        }
        const policyDenial = resolutionOrderPolicyDenial(
          order,
          policyResult.policy,
        );
        if (policyDenial !== null) {
          await cancelForResolutionRisk(
            tx,
            order,
            policyDenial.reason,
            now,
            policyDenial.details,
          );
          ordersCanceled += 1;
          return;
        }
        const underBreaker =
          policyResult.policy.effectiveAction === "CIRCUIT_BREAKER";

        // RFC-012 runtime invariant: a dispute never coexists with a position
        // increase. The acceptance gate stops new orders; this tick also
        // cancels already-open orders unless their whole remaining quantity
        // strictly reduces the signed ledger position without crossing zero.
        let reduceOnlyCap: bigint | null = null;
        if (
          order.acceptedAt === null ||
          now.getTime() < order.acceptedAt.getTime()
        ) {
          await clearResolutionRiskCheck(tx, order.orderId);
          return;
        }
        if (underBreaker) {
          const size = parseScaled(order.size);
          const alreadyFilled = parseScaled(order.filledSize);
          const remaining =
            size === null || alreadyFilled === null
              ? null
              : size - alreadyFilled;
          let positionShares: bigint;
          try {
            positionShares = await loadPositionShares(tx, order.tokenId);
          } catch (error: unknown) {
            log("error", "PAPER_POSITION_READ_FAILED_CIRCUIT_BREAKER", {
              order_id: order.orderId,
              token_id: order.tokenId,
              error_name: error instanceof Error ? error.name : "UnknownError",
              order_canceled: false,
            });
            throw new ResolutionRiskCheckError(
              "RESOLUTION_POSITION_UNAVAILABLE",
              "PAPER_POSITION_READ_FAILED_CIRCUIT_BREAKER",
              error,
            );
          }
          const capacity = exposureReductionCapacity(
            positionShares,
            order.side,
          );
          const crossesZero = remaining !== null && remaining > capacity;
          const canClipTaker =
            order.orderType === "FAK" && capacity > 0n && crossesZero;
          if (
            remaining === null ||
            remaining <= 0n ||
            capacity === 0n ||
            (crossesZero && !canClipTaker)
          ) {
            await cancelForResolutionRisk(
              tx,
              order,
              "RESOLUTION_CIRCUIT_BREAKER_EXPOSURE_INCREASE",
              now,
              {
                position_shares: formatScaled(positionShares, 6),
                remaining_size:
                  remaining === null ? null : formatScaled(remaining, 6),
              },
            );
            ordersCanceled += 1;
            return;
          }
          if (canClipTaker) {
            reduceOnlyCap = capacity;
          }
        }

        // --- Marketable orders: execute against the book of accept + delay. ---
        if (order.orderType === "FAK" || order.orderType === "FOK") {
          const execTs = new Date(order.acceptedAt.getTime() + TAKER_DELAY_MS);
          if (now.getTime() < execTs.getTime()) {
            await clearResolutionRiskCheck(tx, order.orderId);
            return;
          }
          const book = await bookAtOrBefore(tx, order.tokenId, execTs);
          if (book === null) {
            await appendLedgerEvent(tx, {
              idempotencyKey: `${order.orderId}:cancel_effective`,
              eventType: "cancel_effective",
              orderId: order.orderId,
              tokenId: order.tokenId,
              conditionId: order.conditionId,
              payload: { reason: "NO_BOOK_AT_EXEC" },
              eventTs: execTs,
            });
            await closeOrder(tx, order.orderId, "canceled", "0", execTs);
            return;
          }
          const params =
            order.conditionId === null
              ? null
              : await paramsAtOrBefore(tx, order.conditionId, execTs);
          const feeRate = feeRateFromBps(params?.takerFeeBps ?? null);
          const opposing = order.side === "BUY" ? book.asks : book.bids;
          const executionSize =
            reduceOnlyCap === null
              ? order.size
              : formatScaled(reduceOnlyCap, 6);
          const execution = executeTaker(
            order.side,
            executionSize,
            order.worstPrice ?? order.limitPrice,
            opposing,
            feeRate,
            order.orderType === "FOK",
          );
          if (
            execution === null ||
            execution.killed ||
            execution.fills.length === 0
          ) {
            await appendLedgerEvent(tx, {
              idempotencyKey: `${order.orderId}:cancel_effective`,
              eventType: "cancel_effective",
              orderId: order.orderId,
              tokenId: order.tokenId,
              conditionId: order.conditionId,
              payload: {
                reason:
                  execution !== null && execution.killed
                    ? "FOK_KILLED"
                    : "NO_FILL_WITHIN_WORST",
              },
              eventTs: execTs,
            });
            await closeOrder(tx, order.orderId, "canceled", "0", execTs);
            return;
          }
          let inserted = false;
          for (const [index, fill] of execution.fills.entries()) {
            await revalidateResolutionRuntimeForFill(
              tx,
              order.resolutionGeneration,
            );
            await assertResolutionPolicyForFill(tx, order, fill.size);
            const isNew = await appendLedgerEvent(tx, {
              idempotencyKey: `${order.orderId}:taker:${index}`,
              eventType: "fill",
              orderId: order.orderId,
              tokenId: order.tokenId,
              conditionId: order.conditionId,
              payload: {
                side: order.side,
                price: fill.price,
                size: fill.size,
                fee: fill.feeUsd,
                taker: true,
                fee_param_version_id: params?.paramVersionId ?? null,
                tick_size: params?.tickSize ?? null,
                book_slice: execution.consumedSlice,
                exec_ts: execTs.toISOString(),
              },
              eventTs: execTs,
            });
            await revalidateResolutionRuntimeForFill(
              tx,
              order.resolutionGeneration,
            );
            await assertResolutionPolicyStillAuthorizesOrder(tx, order);
            inserted = inserted || isNew;
          }
          if (reduceOnlyCap !== null) {
            await appendLedgerEvent(tx, {
              idempotencyKey: `${order.orderId}:resolution_circuit_breaker`,
              eventType: "cancel_effective",
              orderId: order.orderId,
              tokenId: order.tokenId,
              conditionId: order.conditionId,
              payload: {
                reason: "RESOLUTION_CIRCUIT_BREAKER_CROSS_ZERO_REMAINDER",
                side: order.side,
                max_reducible_size: executionSize,
                filled_size: execution.filledSize,
              },
              eventTs: execTs,
            });
            ordersCanceled += 1;
          }
          const status =
            reduceOnlyCap !== null
              ? "canceled"
              : parseScaled(execution.filledSize) !== null &&
                  (parseScaled(execution.filledSize) ?? 0n) > 0n
                ? "filled"
                : "canceled";
          await closeOrder(
            tx,
            order.orderId,
            status,
            execution.filledSize,
            execTs,
          );
          if (inserted) {
            await refreshPosition(tx, order.tokenId, order.conditionId);
            await revalidateResolutionRuntimeForFill(
              tx,
              order.resolutionGeneration,
            );
          }
          await assertResolutionPolicyStillAuthorizesOrder(tx, order);
          return;
        }

        // --- Passive orders. ---
        // Queue at accept: BEHIND all visible depth at the level (C2).
        let queueAhead = order.queueAhead;
        if (queueAhead === null) {
          const book = await bookAtOrBefore(
            tx,
            order.tokenId,
            order.acceptedAt,
          );
          queueAhead =
            book === null
              ? "0"
              : visibleSizeAtLevel(book, order.side, order.limitPrice);
          await tx.query(
            "UPDATE paper_orders SET queue_ahead = $2 WHERE order_id = $1 AND queue_ahead IS NULL",
            [order.orderId, queueAhead],
          );
        }

        // Effective processing bound: cancels take latency to land (C3) and GTD
        // expires one minute BEFORE the declared expiration (B2). Trades inside
        // the bound still fill — realistic adverse selection.
        const cancelEffective =
          order.cancelRequestedAt === null
            ? null
            : new Date(order.cancelRequestedAt.getTime() + latencyMs);
        const expiryEffective =
          order.expirationS === null
            ? null
            : new Date((order.expirationS - 60) * 1_000);
        let bound = now;
        if (
          cancelEffective !== null &&
          cancelEffective.getTime() < bound.getTime()
        ) {
          bound = cancelEffective;
        }
        if (
          expiryEffective !== null &&
          expiryEffective.getTime() < bound.getTime()
        ) {
          bound = expiryEffective;
        }

        const trades = await tradesAtLevel(
          tx,
          order.tokenId,
          order.limitPrice,
          order.acceptedAt,
          bound,
        );
        const persistedFills = await persistedPassiveFillKeys(
          tx,
          order.orderId,
        );
        let cumulative = 0n;
        let filled = 0n;
        const size = parseScaled(order.size) ?? 0n;
        let newEvents = false;
        for (const trade of trades) {
          const tradeSize = parseScaled(trade.size);
          if (tradeSize === null || tradeSize <= 0n) {
            continue;
          }
          const beforeTotal =
            parseScaled(
              passiveFilledFromVolume(
                queueAhead,
                order.size,
                formatScaled(cumulative, 6),
              ),
            ) ?? 0n;
          cumulative += tradeSize;
          const afterTotal =
            parseScaled(
              passiveFilledFromVolume(
                queueAhead,
                order.size,
                formatScaled(cumulative, 6),
              ),
            ) ?? 0n;
          const delta = afterTotal - beforeTotal;
          if (delta <= 0n) {
            continue;
          }
          if (isFillDegraded(order.orderId, trade.tradeId)) {
            // C6: a denied fill is a diagnostic event only — the liquidity is
            // gone (someone else took it), the order keeps waiting.
            const isNew = await appendLedgerEvent(tx, {
              idempotencyKey: `${order.orderId}:deny:${trade.tradeId}`,
              eventType: "fill_denied_degradation",
              orderId: order.orderId,
              tokenId: order.tokenId,
              conditionId: order.conditionId,
              payload: {
                side: order.side,
                price: order.limitPrice,
                size: formatScaled(delta, 6),
                trade_id: trade.tradeId,
              },
              eventTs: trade.ts,
            });
            newEvents = newEvents || isNew;
            continue;
          }
          filled += delta;
          const fillKey = `${order.orderId}:fill:${trade.tradeId}`;
          if (persistedFills.has(fillKey)) {
            // Historical volume still contributes to cumulative filled size,
            // but its already-committed fill is not a new risk decision.
            continue;
          }
          await revalidateResolutionRuntimeForFill(
            tx,
            order.resolutionGeneration,
          );
          await assertResolutionPolicyForFill(
            tx,
            order,
            formatScaled(delta, 6),
          );
          const isNew = await appendLedgerEvent(tx, {
            idempotencyKey: fillKey,
            eventType: "fill",
            orderId: order.orderId,
            tokenId: order.tokenId,
            conditionId: order.conditionId,
            payload: {
              side: order.side,
              price: order.limitPrice,
              size: formatScaled(delta, 6),
              fee: "0.000000",
              taker: false,
              queue_ahead_at_accept: queueAhead,
              trade_id: trade.tradeId,
            },
            eventTs: trade.ts,
          });
          await revalidateResolutionRuntimeForFill(
            tx,
            order.resolutionGeneration,
          );
          await assertResolutionPolicyStillAuthorizesOrder(tx, order);
          newEvents = newEvents || isNew;
          if (isNew) {
            persistedFills.add(fillKey);
          }
          if (filled >= size) {
            break;
          }
        }

        const filledStr = formatScaled(filled, 6);
        if (filled >= size && size > 0n) {
          // The filled portion is NOT cancelable (C2): full fill closes filled.
          await closeOrder(tx, order.orderId, "filled", filledStr, bound);
        } else if (
          cancelEffective !== null &&
          now.getTime() >= cancelEffective.getTime()
        ) {
          await appendLedgerEvent(tx, {
            idempotencyKey: `${order.orderId}:cancel_effective`,
            eventType: "cancel_effective",
            orderId: order.orderId,
            tokenId: order.tokenId,
            conditionId: order.conditionId,
            payload: { filled_before_cancel: filledStr },
            eventTs: cancelEffective,
          });
          await closeOrder(
            tx,
            order.orderId,
            "canceled",
            filledStr,
            cancelEffective,
          );
        } else if (
          expiryEffective !== null &&
          now.getTime() >= expiryEffective.getTime()
        ) {
          await appendLedgerEvent(tx, {
            idempotencyKey: `${order.orderId}:expired`,
            eventType: "expired",
            orderId: order.orderId,
            tokenId: order.tokenId,
            conditionId: order.conditionId,
            payload: { filled_before_expiry: filledStr },
            eventTs: expiryEffective,
          });
          await closeOrder(
            tx,
            order.orderId,
            "expired",
            filledStr,
            expiryEffective,
          );
        } else {
          await tx.query(
            "UPDATE paper_orders SET filled_size = $2 WHERE order_id = $1 AND status = 'open'",
            [order.orderId, filledStr],
          );
        }
        if (newEvents) {
          await refreshPosition(tx, order.tokenId, order.conditionId);
        }
        await clearResolutionRiskCheck(tx, order.orderId);
        if (newEvents) {
          await revalidateResolutionRuntimeForFill(
            tx,
            order.resolutionGeneration,
          );
        }
        await assertResolutionPolicyStillAuthorizesOrder(tx, order);
      });
    } catch (error: unknown) {
      if (error instanceof ResolutionRiskCheckError) {
        log("error", error.logReason, {
          order_id: snapshot.orderId,
          error_name: error.name,
        });
      }
      log("error", "PAPER_ORDER_TICK_FAILED", {
        order_id: snapshot.orderId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
      try {
        if (
          await finalizePendingRiskCancellation(
            pool,
            snapshot.orderId,
            now,
            claim,
            error instanceof ResolutionRiskCheckError
              ? error.cancellationReason
              : "RESOLUTION_RISK_CHECK_INCOMPLETE",
          )
        ) {
          ordersCanceled += 1;
        }
      } catch (cancelError: unknown) {
        log("error", "PAPER_RISK_CANCEL_RETRY_FAILED", {
          order_id: snapshot.orderId,
          error_name:
            cancelError instanceof Error ? cancelError.name : "UnknownError",
        });
      }
    }
  }
  if (ordersCanceled > 0) {
    log("warn", "PAPER_ORDERS_CANCELED_RESOLUTION_RISK", {
      orders_canceled: ordersCanceled,
    });
  }
}

// ---------------------------------------------------------------------------
// Settlement (C5).

export async function settlementTick(
  pool: PaperPool,
  deps: BrokerDeps = {},
): Promise<void> {
  const log = makeLog(deps.logSink);
  const clock = deps.clock ?? ((): Date => new Date());
  const now = clock();

  if (!hasTransaction(pool)) {
    log("error", "PAPER_SETTLEMENT_TRANSACTION_UNAVAILABLE");
    return;
  }

  const holdings = await pool.query(
    "SELECT p.token_id, p.condition_id FROM paper_positions p " +
      "WHERE p.shares::numeric <> 0 AND p.condition_id IS NOT NULL",
  );
  for (const row of holdings.rows) {
    const tokenId = asString(row["token_id"]);
    const conditionId = asString(row["condition_id"]);
    if (tokenId === null || conditionId === null) {
      continue;
    }
    try {
      const resolutionError = await pool.transaction(
        async (tx: SqlExecutor): Promise<string | null> => {
          // Freeze terminal input first. Lock every affected open order in a
          // deterministic order before the token advisory lock, matching the
          // broker's order -> token path and avoiding an inversion deadlock.
          await lockResolutionInputs(tx);
          const resolution = await tx.query(
            "SELECT resolution_event_id, payload_json FROM polymarket_resolution_events " +
              "WHERE condition_id = $1 AND event_type IN ('resolved', 'market_resolved') " +
              "ORDER BY received_at DESC, resolution_event_id DESC LIMIT 1",
            [conditionId],
          );
          const event = resolution.rows[0];
          if (event === undefined) {
            return null;
          }
          const openOrders = await tx.query(
            `SELECT order_id, token_id, condition_id, filled_size
               FROM paper_orders
              WHERE status = 'open'
                AND (token_id = $1 OR condition_id = $2)
              ORDER BY order_id
              FOR UPDATE`,
            [tokenId, conditionId],
          );
          await lockToken(tx, tokenId);

          const eventIdRaw = event["resolution_event_id"];
          const resolutionEventId =
            typeof eventIdRaw === "number"
              ? String(eventIdRaw)
              : (asString(eventIdRaw) ?? "0");
          for (const openOrder of openOrders.rows) {
            const orderId = asString(openOrder["order_id"]);
            if (orderId === null) {
              continue;
            }
            await appendLedgerEvent(tx, {
              idempotencyKey: `${orderId}:market_resolved:${resolutionEventId}`,
              eventType: "cancel_effective",
              orderId,
              tokenId: asString(openOrder["token_id"]),
              conditionId: asString(openOrder["condition_id"]),
              payload: {
                reason: "MARKET_ALREADY_RESOLVED",
                resolution_event_id: resolutionEventId,
              },
              eventTs: now,
            });
            await closeOrder(
              tx,
              orderId,
              "canceled",
              asString(openOrder["filled_size"]) ?? "0",
              now,
            );
          }

          // The advisory key protects fills and settlement. Re-read the
          // canonical ledger under it: paper_positions is discovery/cache only.
          const positionShares = await loadPositionShares(tx, tokenId);
          if (positionShares === 0n) {
            return null;
          }
          const payload =
            typeof event["payload_json"] === "object" &&
            event["payload_json"] !== null
              ? (event["payload_json"] as Record<string, unknown>)
              : {};
          const pricesRaw = payload["outcomePrices"];
          const prices = Array.isArray(pricesRaw)
            ? pricesRaw.filter(
                (item): item is string => typeof item === "string",
              )
            : [];
          const market = await tx.query(
            "SELECT clob_token_ids, neg_risk FROM polymarket_markets WHERE condition_id = $1",
            [conditionId],
          );
          const tokenIdsRaw = market.rows[0]?.["clob_token_ids"];
          const clobTokenIds = Array.isArray(tokenIdsRaw)
            ? tokenIdsRaw.filter(
                (item): item is string => typeof item === "string",
              )
            : [];
          const negRisk = market.rows[0]?.["neg_risk"] === true;
          const outcome = resolveOutcomeForToken(
            tokenId,
            clobTokenIds,
            prices,
            negRisk,
          );
          if (!outcome.ok) {
            return outcome.reason;
          }
          const inserted = await appendLedgerEvent(tx, {
            idempotencyKey: `resolution:${tokenId}:${resolutionEventId}`,
            eventType: "resolution",
            tokenId,
            conditionId,
            payload: {
              outcome_price: outcome.value.outcomePrice,
              resolution_event_id: resolutionEventId,
            },
            eventTs: now,
          });
          if (inserted) {
            await refreshPosition(tx, tokenId, conditionId);
          }
          return null;
        },
      );
      if (resolutionError !== null) {
        // Freeze after releasing the token advisory lock. Taking kill-switch
        // UPDATE while holding token would invert the broker's kill -> token
        // order and create a deadlock cycle.
        log("error", "PAPER_RESOLUTION_DATA_ERROR", {
          condition_id: conditionId,
          token_id: tokenId,
          reason: resolutionError,
        });
        await freezeMarket(pool, conditionId, now);
      }
    } catch (error: unknown) {
      log("error", "PAPER_SETTLEMENT_FAILED", {
        condition_id: conditionId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Mark to executable bid (D2).

export async function markTick(
  pool: PaperPool,
  deps: BrokerDeps = {},
): Promise<void> {
  const log = makeLog(deps.logSink);
  const clock = deps.clock ?? ((): Date => new Date());
  const now = clock();
  const positions = await pool.query(
    "SELECT token_id, condition_id, shares FROM paper_positions WHERE shares::numeric <> 0",
  );
  for (const row of positions.rows) {
    const tokenId = asString(row["token_id"]);
    const shares = asString(row["shares"]);
    if (tokenId === null || shares === null) {
      continue;
    }
    try {
      const book = await bookAtOrBefore(pool, tokenId, now);
      const reference = book?.sourceTs ?? book?.receivedAt ?? null;
      const fresh =
        book !== null &&
        reference !== null &&
        now.getTime() - reference.getTime() <= MARK_MAX_BOOK_AGE_MS;
      const sharesScaled = parseScaled(shares) ?? 0n;
      const exitLevels =
        sharesScaled >= 0n ? (book?.bids ?? []) : (book?.asks ?? []);
      const value = fresh ? markToExecutable(shares, exitLevels) : null;
      const minuteKey = Math.floor(now.getTime() / 60_000);
      if (value !== null) {
        await pool.query(
          "UPDATE paper_positions SET mark_value_usd = $2, mark_stale = FALSE, marked_at = $3, updated_at = $3 WHERE token_id = $1",
          [tokenId, value, now],
        );
        await appendLedgerEvent(pool, {
          idempotencyKey: `mark:${tokenId}:${minuteKey}`,
          eventType: "mark",
          tokenId,
          conditionId: asString(row["condition_id"]),
          payload: { value_usd: value, stale: false },
          eventTs: now,
        });
      } else {
        // STALE_MARK: freeze the previous value, flag it, never invent one.
        await pool.query(
          "UPDATE paper_positions SET mark_stale = TRUE, marked_at = $2, updated_at = $2 WHERE token_id = $1",
          [tokenId, now],
        );
        await appendLedgerEvent(pool, {
          idempotencyKey: `mark:${tokenId}:${minuteKey}`,
          eventType: "mark",
          tokenId,
          conditionId: asString(row["condition_id"]),
          payload: { stale: true },
          eventTs: now,
        });
      }
    } catch (error: unknown) {
      log("error", "PAPER_MARK_FAILED", {
        token_id: tokenId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Kill-switch automatic triggers (D4).

export async function killSwitchTriggersTick(
  pool: PaperPool,
  deps: BrokerDeps = {},
): Promise<void> {
  const log = makeLog(deps.logSink);
  const clock = deps.clock ?? ((): Date => new Date());
  const now = clock();
  const state = await loadKillSwitch(pool);

  // 1. Global recorder staleness: without fresh books the simulator is blind.
  const newest = await pool.query(
    "SELECT MAX(received_at) AS newest FROM polymarket_book_snapshots",
  );
  const newestAt = toDate(newest.rows[0]?.["newest"]);
  if (
    !state.engaged &&
    newestAt !== null &&
    now.getTime() - newestAt.getTime() > RECORDER_STALE_MS
  ) {
    await engageKillSwitch(pool, "RECORDER_STALE", now, deps);
    return;
  }

  // 2. Daily paper loss above the limit (equity vs the UTC-day anchor).
  const totals = await pool.query(
    "SELECT COALESCE(SUM(realized_pnl_usd::numeric), 0)::text AS realized, " +
      "COALESCE(SUM(CASE " +
      "WHEN shares::numeric > 0 THEN COALESCE(mark_value_usd::numeric, cost_usd::numeric) - cost_usd::numeric " +
      "WHEN shares::numeric < 0 THEN cost_usd::numeric - COALESCE(mark_value_usd::numeric, cost_usd::numeric) " +
      "ELSE 0 END), 0)::text AS unrealized " +
      "FROM paper_positions",
  );
  const realized =
    parseScaled(asString(totals.rows[0]?.["realized"]) ?? "0") ?? 0n;
  const unrealized =
    parseScaled(asString(totals.rows[0]?.["unrealized"]) ?? "0") ?? 0n;
  const equity = realized + unrealized;
  const today = now.toISOString().slice(0, 10);
  const anchorRow = await pool.query(
    "SELECT daily_anchor_date, daily_anchor_equity_usd FROM paper_kill_switch WHERE kill_switch_id = 1",
  );
  const anchorDateRaw = anchorRow.rows[0]?.["daily_anchor_date"];
  const anchorDate =
    anchorDateRaw instanceof Date
      ? anchorDateRaw.toISOString().slice(0, 10)
      : (asString(anchorDateRaw)?.slice(0, 10) ?? null);
  const anchorEquity = parseScaled(
    asString(anchorRow.rows[0]?.["daily_anchor_equity_usd"]) ?? "",
  );
  if (anchorDate !== today || anchorEquity === null) {
    await pool.query(
      "UPDATE paper_kill_switch SET daily_anchor_date = $1, daily_anchor_equity_usd = $2, updated_at = $3 WHERE kill_switch_id = 1",
      [today, formatScaled(equity, 6), now],
    );
  } else if (!state.engaged) {
    const limit =
      parseScaled(deps.dailyLossLimitUsd ?? DEFAULT_DAILY_LOSS_LIMIT_USD) ?? 0n;
    if (limit > 0n && anchorEquity - equity > limit) {
      await engageKillSwitch(pool, "DAILY_LOSS_LIMIT", now, deps);
      return;
    }
  }

  // 3. A UMA dispute on a market we hold freezes entries in THAT market.
  const disputes = await pool.query(
    "SELECT DISTINCT r.condition_id FROM polymarket_resolution_events r " +
      "JOIN paper_positions p ON p.condition_id = r.condition_id " +
      "WHERE r.event_type = 'disputed' AND p.shares::numeric <> 0",
  );
  for (const row of disputes.rows) {
    const conditionId = asString(row["condition_id"]);
    if (conditionId !== null && !state.frozenMarkets.includes(conditionId)) {
      await freezeMarket(pool, conditionId, now);
      log("warn", "PAPER_MARKET_FROZEN_DISPUTE", { condition_id: conditionId });
    }
  }
}

export { SCALE };
