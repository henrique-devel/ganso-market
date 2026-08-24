// RFC-011 Parts C/D service layer: order acceptance, the pessimistic
// processing ticks (taker execution, conservative passive queue, cancels with
// latency, GTD expiry), trinary settlement, mark-to-executable-bid and the
// kill switch. All state changes ride on idempotent ledger events: every
// apply step recomputes deterministically and only advances when the event
// append reports NEW, so replays, restarts and out-of-order ticks converge.
//
// SIMULAÇÃO — SEM EXECUÇÃO REAL: reads recorded public data, writes only to
// the paper_* tables.

import type { SqlExecutor } from "../../database.js";
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

export type PaperPool = { query: SqlExecutor["query"] };

/** A book older than this at its use instant freezes the mark (D2). */
export const MARK_MAX_BOOK_AGE_MS = 30_000;

/** Recorder silence beyond this engages the kill switch (D4). */
export const RECORDER_STALE_MS = 5 * 60_000;

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

async function bookAtOrBefore(
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

async function paramsAtOrBefore(
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

export async function loadKillSwitch(
  pool: PaperPool,
): Promise<KillSwitchState> {
  const result = await pool.query(
    "SELECT engaged, reason, frozen_markets_json FROM paper_kill_switch WHERE kill_switch_id = 1",
  );
  const row = result.rows[0];
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

export async function engageKillSwitch(
  pool: PaperPool,
  reason: string,
  now: Date,
  deps: BrokerDeps = {},
): Promise<void> {
  const log = makeLog(deps.logSink);
  await pool.query(
    "UPDATE paper_kill_switch SET engaged = TRUE, reason = $1, engaged_at = $2, updated_at = $2 WHERE kill_switch_id = 1",
    [reason, now],
  );
  await appendLedgerEvent(pool, {
    idempotencyKey: `kill:${now.getTime()}`,
    eventType: "kill_switch_engaged",
    payload: { reason },
    eventTs: now,
  });
  // Cancel every open order immediately: the switch is the hard stop.
  const open = await pool.query(
    "SELECT order_id, token_id, condition_id FROM paper_orders WHERE status = 'open'",
  );
  for (const row of open.rows) {
    const orderId = asString(row["order_id"]);
    if (orderId === null) {
      continue;
    }
    await appendLedgerEvent(pool, {
      idempotencyKey: `${orderId}:cancel_effective`,
      eventType: "cancel_effective",
      orderId,
      tokenId: asString(row["token_id"]),
      conditionId: asString(row["condition_id"]),
      payload: { reason: "KILL_SWITCH" },
      eventTs: now,
    });
    await pool.query(
      "UPDATE paper_orders SET status = 'canceled', cancel_requested_at = COALESCE(cancel_requested_at, $2), cancel_effective_at = $2, closed_at = $2 WHERE order_id = $1 AND status = 'open'",
      [orderId, now],
    );
  }
  log("error", "PAPER_KILL_SWITCH_ENGAGED", {
    reason,
    orders_canceled: open.rows.length,
  });
}

export async function rearmKillSwitch(
  pool: PaperPool,
  now: Date,
): Promise<void> {
  await pool.query(
    "UPDATE paper_kill_switch SET engaged = FALSE, reason = NULL, rearmed_at = $1, updated_at = $1 WHERE kill_switch_id = 1",
    [now],
  );
  await appendLedgerEvent(pool, {
    idempotencyKey: `rearm:${now.getTime()}`,
    eventType: "kill_switch_rearmed",
    payload: {},
    eventTs: now,
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
// Order acceptance (called by the API) and cancellation.

export interface AcceptInput {
  readonly orderId: string;
  readonly draft: OrderDraft;
  readonly conditionId: string | null;
  readonly source: "manual" | "intent";
  readonly policyReason?: string | null;
  readonly policyVersion?: string | null;
}

export type AcceptOutcome =
  | { readonly status: "accepted"; readonly acceptedAt: Date }
  | {
      readonly status: "rejected";
      readonly httpStatus: number;
      readonly reason: string;
    };

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
  const params = await paramsAtOrBefore(pool, input.conditionId, now);
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

  const acceptedAt = new Date(now.getTime() + latencyMs);
  await pool.query(
    "INSERT INTO paper_orders (order_id, token_id, condition_id, side, order_type, " +
      "limit_price, size, amount_usd, post_only, worst_price, expiration_s, " +
      "policy_reason, policy_version, source, status, decided_at, accepted_at) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'open',$15,$16)",
    [
      input.orderId,
      order.tokenId,
      input.conditionId,
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
    ],
  );
  await appendLedgerEvent(pool, {
    idempotencyKey: `${input.orderId}:accepted`,
    eventType: "order_accepted",
    orderId: input.orderId,
    tokenId: order.tokenId,
    conditionId: input.conditionId,
    payload: {
      side: order.side,
      order_type: order.orderType,
      limit_price: order.limitPrice,
      size: order.size,
      post_only: order.postOnly,
      worst_price: order.worstPrice,
      expiration_s: order.expirationS,
      simulated_latency_ms: latencyMs,
    },
    eventTs: now,
  });
  return { status: "accepted", acceptedAt };
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
  readonly postOnly: boolean;
  readonly worstPrice: string | null;
  readonly expirationS: number | null;
  readonly queueAhead: string | null;
  readonly acceptedAt: Date | null;
  readonly cancelRequestedAt: Date | null;
}

async function loadOpenOrders(pool: PaperPool): Promise<OpenOrderRow[]> {
  const result = await pool.query(
    "SELECT order_id, token_id, condition_id, side, order_type, limit_price, size, " +
      "post_only, worst_price, expiration_s, queue_ahead, accepted_at, cancel_requested_at " +
      "FROM paper_orders WHERE status = 'open' ORDER BY created_at",
  );
  const orders: OpenOrderRow[] = [];
  for (const row of result.rows) {
    const orderId = asString(row["order_id"]);
    const tokenId = asString(row["token_id"]);
    const side = row["side"];
    const orderType = row["order_type"];
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
      limitPrice === null ||
      size === null
    ) {
      continue;
    }
    const expirationRaw = row["expiration_s"];
    orders.push({
      orderId,
      tokenId,
      conditionId: asString(row["condition_id"]),
      side,
      orderType,
      limitPrice,
      size,
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
    });
  }
  return orders;
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

async function closeOrder(
  pool: PaperPool,
  orderId: string,
  status: "filled" | "canceled" | "expired",
  filledSize: string,
  at: Date,
): Promise<void> {
  await pool.query(
    "UPDATE paper_orders SET status = $2, filled_size = $3, closed_at = $4 WHERE order_id = $1 AND status = 'open'",
    [orderId, status, filledSize, at],
  );
}

/** One full processing tick. Idempotent: safe to re-run over the same data. */
export async function brokerTick(
  pool: PaperPool,
  deps: BrokerDeps = {},
): Promise<void> {
  const clock = deps.clock ?? ((): Date => new Date());
  const latencyMs = deps.latencyMs ?? DEFAULT_LATENCY_MS;
  const log = makeLog(deps.logSink);
  const now = clock();
  const orders = await loadOpenOrders(pool);

  for (const order of orders) {
    try {
      if (
        order.acceptedAt === null ||
        now.getTime() < order.acceptedAt.getTime()
      ) {
        continue;
      }

      // --- Marketable orders: execute against the book of accept + delay. ---
      if (order.orderType === "FAK" || order.orderType === "FOK") {
        const execTs = new Date(order.acceptedAt.getTime() + TAKER_DELAY_MS);
        if (now.getTime() < execTs.getTime()) {
          continue;
        }
        const book = await bookAtOrBefore(pool, order.tokenId, execTs);
        if (book === null) {
          await appendLedgerEvent(pool, {
            idempotencyKey: `${order.orderId}:cancel_effective`,
            eventType: "cancel_effective",
            orderId: order.orderId,
            tokenId: order.tokenId,
            conditionId: order.conditionId,
            payload: { reason: "NO_BOOK_AT_EXEC" },
            eventTs: execTs,
          });
          await closeOrder(pool, order.orderId, "canceled", "0", execTs);
          continue;
        }
        const params =
          order.conditionId === null
            ? null
            : await paramsAtOrBefore(pool, order.conditionId, execTs);
        const feeRate = feeRateFromBps(params?.takerFeeBps ?? null);
        const opposing = order.side === "BUY" ? book.asks : book.bids;
        const execution = executeTaker(
          order.side,
          order.size,
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
          await appendLedgerEvent(pool, {
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
          await closeOrder(pool, order.orderId, "canceled", "0", execTs);
          continue;
        }
        let inserted = false;
        for (const [index, fill] of execution.fills.entries()) {
          const isNew = await appendLedgerEvent(pool, {
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
              book_slice: execution.consumedSlice,
              exec_ts: execTs.toISOString(),
            },
            eventTs: execTs,
          });
          inserted = inserted || isNew;
        }
        const status =
          parseScaled(execution.filledSize) !== null &&
          (parseScaled(execution.filledSize) ?? 0n) > 0n
            ? "filled"
            : "canceled";
        await closeOrder(
          pool,
          order.orderId,
          status,
          execution.filledSize,
          execTs,
        );
        if (inserted) {
          await refreshPosition(pool, order.tokenId, order.conditionId);
        }
        continue;
      }

      // --- Passive orders. ---
      // Queue at accept: BEHIND all visible depth at the level (C2).
      let queueAhead = order.queueAhead;
      if (queueAhead === null) {
        const book = await bookAtOrBefore(
          pool,
          order.tokenId,
          order.acceptedAt,
        );
        queueAhead =
          book === null
            ? "0"
            : visibleSizeAtLevel(book, order.side, order.limitPrice);
        await pool.query(
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
        pool,
        order.tokenId,
        order.limitPrice,
        order.acceptedAt,
        bound,
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
          const isNew = await appendLedgerEvent(pool, {
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
        const isNew = await appendLedgerEvent(pool, {
          idempotencyKey: `${order.orderId}:fill:${trade.tradeId}`,
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
        newEvents = newEvents || isNew;
        if (filled >= size) {
          break;
        }
      }

      const filledStr = formatScaled(filled, 6);
      if (filled >= size && size > 0n) {
        // The filled portion is NOT cancelable (C2): full fill closes filled.
        await closeOrder(pool, order.orderId, "filled", filledStr, bound);
      } else if (
        cancelEffective !== null &&
        now.getTime() >= cancelEffective.getTime()
      ) {
        await appendLedgerEvent(pool, {
          idempotencyKey: `${order.orderId}:cancel_effective`,
          eventType: "cancel_effective",
          orderId: order.orderId,
          tokenId: order.tokenId,
          conditionId: order.conditionId,
          payload: { filled_before_cancel: filledStr },
          eventTs: cancelEffective,
        });
        await closeOrder(
          pool,
          order.orderId,
          "canceled",
          filledStr,
          cancelEffective,
        );
      } else if (
        expiryEffective !== null &&
        now.getTime() >= expiryEffective.getTime()
      ) {
        await appendLedgerEvent(pool, {
          idempotencyKey: `${order.orderId}:expired`,
          eventType: "expired",
          orderId: order.orderId,
          tokenId: order.tokenId,
          conditionId: order.conditionId,
          payload: { filled_before_expiry: filledStr },
          eventTs: expiryEffective,
        });
        await closeOrder(
          pool,
          order.orderId,
          "expired",
          filledStr,
          expiryEffective,
        );
      } else {
        await pool.query(
          "UPDATE paper_orders SET filled_size = $2 WHERE order_id = $1 AND status = 'open'",
          [order.orderId, filledStr],
        );
      }
      if (newEvents) {
        await refreshPosition(pool, order.tokenId, order.conditionId);
      }
    } catch (error: unknown) {
      log("error", "PAPER_ORDER_TICK_FAILED", {
        order_id: order.orderId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    }
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
      const resolution = await pool.query(
        "SELECT resolution_event_id, payload_json FROM polymarket_resolution_events " +
          "WHERE condition_id = $1 AND event_type IN ('resolved', 'market_resolved') " +
          "ORDER BY received_at DESC LIMIT 1",
        [conditionId],
      );
      const event = resolution.rows[0];
      if (event === undefined) {
        continue;
      }
      const payload =
        typeof event["payload_json"] === "object" &&
        event["payload_json"] !== null
          ? (event["payload_json"] as Record<string, unknown>)
          : {};
      const pricesRaw = payload["outcomePrices"];
      const prices = Array.isArray(pricesRaw)
        ? pricesRaw.filter((item): item is string => typeof item === "string")
        : [];
      const market = await pool.query(
        "SELECT clob_token_ids, neg_risk FROM polymarket_markets WHERE condition_id = $1",
        [conditionId],
      );
      const tokenIdsRaw = market.rows[0]?.["clob_token_ids"];
      const clobTokenIds = Array.isArray(tokenIdsRaw)
        ? tokenIdsRaw.filter((item): item is string => typeof item === "string")
        : [];
      const negRisk = market.rows[0]?.["neg_risk"] === true;
      const outcome = resolveOutcomeForToken(
        tokenId,
        clobTokenIds,
        prices,
        negRisk,
      );
      if (!outcome.ok) {
        // Never a silent liquidation: freeze the market and scream.
        log("error", "PAPER_RESOLUTION_DATA_ERROR", {
          condition_id: conditionId,
          token_id: tokenId,
          reason: outcome.reason,
        });
        await freezeMarket(pool, conditionId, now);
        continue;
      }
      const eventIdRaw = event["resolution_event_id"];
      const resolutionEventId =
        typeof eventIdRaw === "number"
          ? String(eventIdRaw)
          : (asString(eventIdRaw) ?? "0");
      const inserted = await appendLedgerEvent(pool, {
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
        await refreshPosition(pool, tokenId, conditionId);
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
