// RFC-011 Part D1: the append-only, idempotent paper ledger. Events are the
// ONLY source of truth: replaying them reconstructs positions and P&L bit for
// bit (the replay test shuffles and duplicates events and demands the same
// state). The paper_positions table is a cache of this fold, never an
// authority. All money math is exact fixed-point.

import type { SqlExecutor } from "../../database.js";
import {
  SCALE,
  div,
  formatScaled,
  mul,
  parseScaled,
} from "../fundamental/fixed.js";

export type LedgerEventType =
  | "order_accepted"
  | "order_rejected"
  | "cancel_requested"
  | "cancel_effective"
  | "fill"
  | "fill_denied_degradation"
  | "expired"
  | "resolution"
  | "mark"
  | "kill_switch_engaged"
  | "kill_switch_rearmed";

export interface LedgerEventInput {
  readonly idempotencyKey: string;
  readonly eventType: LedgerEventType;
  readonly orderId?: string | null;
  readonly tokenId?: string | null;
  readonly conditionId?: string | null;
  readonly payload: Record<string, unknown>;
  readonly eventTs: Date;
}

export interface LedgerEventRecord {
  readonly idempotencyKey: string;
  readonly eventType: LedgerEventType;
  readonly orderId: string | null;
  readonly tokenId: string | null;
  readonly conditionId: string | null;
  readonly payload: Record<string, unknown>;
  readonly eventTs: Date;
}

const INSERT_EVENT_SQL =
  "INSERT INTO paper_ledger_events " +
  "(idempotency_key, event_type, order_id, token_id, condition_id, payload_json, event_ts) " +
  "VALUES ($1, $2, $3, $4, $5, $6, $7) " +
  "ON CONFLICT (idempotency_key) DO NOTHING";

/**
 * Append one event; returns true when the event was NEW. A duplicate key is
 * absorbed silently (idempotent replays), and the caller must only apply
 * state changes when the append reports true.
 */
export async function appendLedgerEvent(
  pool: SqlExecutor,
  input: LedgerEventInput,
): Promise<boolean> {
  const result = await pool.query(INSERT_EVENT_SQL, [
    input.idempotencyKey,
    input.eventType,
    input.orderId ?? null,
    input.tokenId ?? null,
    input.conditionId ?? null,
    JSON.stringify(input.payload),
    input.eventTs,
  ]);
  return result.rowCount > 0;
}

// ---------------------------------------------------------------------------
// Replay: a pure fold over events.

export interface PositionState {
  /** Signed shares (long positive), scaled decimal string. */
  readonly shares: string;
  /** Cost basis of the open exposure, USD. */
  readonly costUsd: string;
  readonly realizedPnlUsd: string;
  readonly feesPaidUsd: string;
  readonly openedAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly lockupS: number | null;
}

export interface LedgerState {
  readonly positions: ReadonlyMap<string, PositionState>;
  readonly realizedPnlUsd: string;
  readonly feesPaidUsd: string;
  readonly eventCount: number;
}

interface MutablePosition {
  shares: bigint;
  costUsd: bigint;
  realized: bigint;
  fees: bigint;
  openedAt: Date | null;
  resolvedAt: Date | null;
  lockupS: number | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Average-cost accounting for one fill on a signed position. Increasing the
 * exposure moves the cost basis; reducing it realizes against the average
 * cost; crossing zero realizes the whole old side and opens the remainder.
 */
export function applyFill(
  position: MutablePosition,
  side: "BUY" | "SELL",
  priceScaled: bigint,
  sizeScaled: bigint,
  feeScaled: bigint,
  at: Date,
): void {
  position.fees += feeScaled;
  const signed = side === "BUY" ? sizeScaled : -sizeScaled;
  const before = position.shares;
  const after = before + signed;
  const sameDirection = before === 0n || before > 0n === signed > 0n;

  if (sameDirection) {
    position.shares = after;
    position.costUsd += mul(priceScaled, sizeScaled);
    if (position.openedAt === null) {
      position.openedAt = at;
    }
    return;
  }

  const absBefore = before < 0n ? -before : before;
  const closing = sizeScaled < absBefore ? sizeScaled : absBefore;
  const avgCost = absBefore === 0n ? 0n : div(position.costUsd, absBefore);
  // A long realizes price - avg; a short realizes avg - price.
  const perShare = before > 0n ? priceScaled - avgCost : avgCost - priceScaled;
  position.realized += mul(perShare, closing);
  position.costUsd -= mul(avgCost, closing);
  position.shares = after;

  const leftover = sizeScaled - closing;
  if (leftover > 0n) {
    // Crossed zero: the remainder opens a fresh position at this price.
    position.costUsd = mul(priceScaled, leftover);
    position.openedAt = at;
  } else if (position.shares === 0n) {
    position.costUsd = 0n;
  }
}

function blankPosition(): MutablePosition {
  return {
    shares: 0n,
    costUsd: 0n,
    realized: 0n,
    fees: 0n,
    openedAt: null,
    resolvedAt: null,
    lockupS: null,
  };
}

/**
 * Deterministic replay. Events are ordered by (event_ts, idempotency_key) and
 * deduplicated by key, so duplicates and out-of-order arrivals cannot change
 * the outcome. Degradation denials and marks are diagnostic: they never touch
 * the canonical state.
 */
export function replayLedger(
  events: readonly LedgerEventRecord[],
): LedgerState {
  const ordered = [...events].sort((a, b) => {
    const dt = a.eventTs.getTime() - b.eventTs.getTime();
    if (dt !== 0) {
      return dt;
    }
    return a.idempotencyKey < b.idempotencyKey ? -1 : 1;
  });
  const seen = new Set<string>();
  const positions = new Map<string, MutablePosition>();
  let count = 0;

  for (const event of ordered) {
    if (seen.has(event.idempotencyKey)) {
      continue;
    }
    seen.add(event.idempotencyKey);
    count += 1;

    if (event.eventType === "fill" && event.tokenId !== null) {
      const side = event.payload["side"];
      const price = parseScaled(str(event.payload["price"]) ?? "");
      const size = parseScaled(str(event.payload["size"]) ?? "");
      const fee = parseScaled(str(event.payload["fee"]) ?? "0") ?? 0n;
      if (
        (side !== "BUY" && side !== "SELL") ||
        price === null ||
        size === null
      ) {
        continue;
      }
      const position = positions.get(event.tokenId) ?? blankPosition();
      applyFill(position, side, price, size, fee, event.eventTs);
      positions.set(event.tokenId, position);
    } else if (event.eventType === "resolution" && event.tokenId !== null) {
      const outcome = parseScaled(str(event.payload["outcome_price"]) ?? "");
      if (outcome === null) {
        continue;
      }
      const position = positions.get(event.tokenId) ?? blankPosition();
      // Shares liquidate at the outcome (1, 0 or 0.5 USD per share). costUsd
      // is a positive basis magnitude for BOTH directions (a short's basis is
      // the proceeds received), so the sign flips with the side.
      const qty = position.shares < 0n ? -position.shares : position.shares;
      const proceeds = mul(qty, outcome);
      position.realized +=
        position.shares >= 0n
          ? proceeds - position.costUsd
          : position.costUsd - proceeds;
      position.shares = 0n;
      position.costUsd = 0n;
      position.resolvedAt = event.eventTs;
      if (position.openedAt !== null) {
        position.lockupS = Math.max(
          0,
          Math.floor(
            (event.eventTs.getTime() - position.openedAt.getTime()) / 1_000,
          ),
        );
      }
      positions.set(event.tokenId, position);
    }
  }

  let realizedTotal = 0n;
  let feesTotal = 0n;
  const out = new Map<string, PositionState>();
  for (const [tokenId, position] of positions) {
    realizedTotal += position.realized;
    feesTotal += position.fees;
    out.set(tokenId, {
      shares: formatScaled(position.shares, 6),
      costUsd: formatScaled(position.costUsd, 6),
      realizedPnlUsd: formatScaled(position.realized - position.fees, 6),
      feesPaidUsd: formatScaled(position.fees, 6),
      openedAt: position.openedAt,
      resolvedAt: position.resolvedAt,
      lockupS: position.lockupS,
    });
  }
  return {
    positions: out,
    realizedPnlUsd: formatScaled(realizedTotal - feesTotal, 6),
    feesPaidUsd: formatScaled(feesTotal, 6),
    eventCount: count,
  };
}

/** Load the full ledger (for replay verification and the performance report). */
export async function loadLedgerEvents(
  pool: SqlExecutor,
): Promise<LedgerEventRecord[]> {
  const result = await pool.query(
    "SELECT idempotency_key, event_type, order_id, token_id, condition_id, " +
      "payload_json, event_ts FROM paper_ledger_events ORDER BY event_id",
  );
  const events: LedgerEventRecord[] = [];
  for (const row of result.rows) {
    const key = row["idempotency_key"];
    const type = row["event_type"];
    const ts = row["event_ts"];
    if (typeof key !== "string" || typeof type !== "string") {
      continue;
    }
    const eventTs =
      ts instanceof Date ? ts : typeof ts === "string" ? new Date(ts) : null;
    if (eventTs === null || Number.isNaN(eventTs.getTime())) {
      continue;
    }
    events.push({
      idempotencyKey: key,
      eventType: type as LedgerEventType,
      orderId: typeof row["order_id"] === "string" ? row["order_id"] : null,
      tokenId: typeof row["token_id"] === "string" ? row["token_id"] : null,
      conditionId:
        typeof row["condition_id"] === "string" ? row["condition_id"] : null,
      payload:
        typeof row["payload_json"] === "object" && row["payload_json"] !== null
          ? (row["payload_json"] as Record<string, unknown>)
          : {},
      eventTs,
    });
  }
  return events;
}

/**
 * Unrealized P&L of a marked position. For a long, the mark is the exit
 * book-walk proceeds and the P&L is mark - cost; for a short, the mark is the
 * cost to buy back and the P&L is proceeds(basis) - mark.
 */
export function unrealizedPnlUsd(
  shares: string,
  costUsd: string,
  markValueUsd: string | null,
): string | null {
  const cost = parseScaled(costUsd);
  const mark = markValueUsd === null ? null : parseScaled(markValueUsd);
  const qty = parseScaled(shares);
  if (cost === null || mark === null || qty === null || qty === 0n) {
    return null;
  }
  return formatScaled(qty >= 0n ? mark - cost : cost - mark, 6);
}

export { SCALE };
