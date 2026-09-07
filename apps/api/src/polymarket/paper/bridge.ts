// RFC-013 bridge: the portfolio engine's accepted entries become simulated
// orders here, in the paper module, by PULLING from the decision log.
//
// SIMULAÇÃO — SEM EXECUÇÃO REAL. Nothing here gains trading auth, a key, or a
// path to a real venue; it turns a decision into a row in paper_orders and
// nothing else. Real execution stays exclusive to RFC-009, behind G1–G6.
//
// Why the consumer lives here and not in `portfolio`
// (docs/architecture/decision-to-paper-bridge.md): the portfolio module's scope
// guard forbids both writing outside `portfolio_*` and having any order path at
// all, and the paper module's guard forbids outbound network. A pull consumer in
// this module is the only shape that needs no exception in either guard — it
// reads a `portfolio_*` table (read-only) and writes only `paper_*`.
//
// The bridge produces DATA. It loosens no gate: G2 still wants 60 days, 100
// closed positions, 30 markets, two categories, dispersion, and an interval that
// survives the 50% haircut. What changes is that the counters can finally move.

import { SCALE_DIGITS, formatScaled } from "../fundamental/fixed.js";
import type { ResolutionGateFn } from "../resolution/enforcement.js";
import { resolutionGate } from "../resolution/enforcement.js";
import {
  acceptPaperOrder,
  bookAtOrBefore,
  feeRateFromBps,
  paramsAtOrBefore,
  positionShares,
  type PaperPool,
} from "./brokerstore.js";
import { POLICY_VERSION, decideOrderType } from "./policy.js";
import type { OrderSide, OrderDraft } from "./validator.js";

/**
 * How long a decision stays actionable after the LOG received it (RFC-022 D1).
 *
 * The bound that decides whether the bridge may act is the one on when the
 * bridge could first see the row, because that is the only clock the bridge
 * shares with the row. `received_at` is stamped by the database as the portfolio
 * cycle writes, and the cycle writes market by market: over the 94 accepted
 * entries retained in production on 2026-09-07 the gap
 * `received_at - decision_ts` ran p50 17.1 s, p90 27.3 s, max 42.4 s, and 5 of
 * them exceeded 30 s outright. Worse, the two clocks are phase-locked (0.26 s of
 * drift over 11 cycles): decisions were born at :30-:51 s, written at :45-:05 s,
 * and the bridge ticks at :05/:35 s — so measuring age from `decision_ts` with a
 * 30 s bound made a row already too old at the only tick that could have seen
 * it. 86 of 94 accepted entries never became orders.
 *
 * TWO ticks, not one: `bridgeTickOnce` DROPS a tick whose predecessor is still
 * running (`JOB_STILL_RUNNING`, `paper/runner.ts`). With a window equal to the
 * 30 s period, one skipped tick would lose the row for good.
 */
export const MAX_RECEIVED_AGE_MS = 60_000;

/**
 * Absolute ceiling on how old the DECISION itself may be (RFC-022 D1).
 *
 * The `received_at` window alone would let a wedged portfolio cycle dump
 * hours-old decisions onto a live book the moment it unwedges, since every row
 * it finally writes gets a fresh `received_at`. This ceiling refuses those. It
 * is not the economic protection: `MAX_BOOK_AGE_MS` still requires a book from
 * the last 30 s and `decideOrderType` re-quotes against that book inside
 * `q_lo`/`q_hi`, so a decision admitted here is still priced against the present.
 */
export const MAX_DECISION_TS_AGE_MS = 90_000;

/** A book whose reference instant is older than this cannot be quoted against. */
export const MAX_BOOK_AGE_MS = 30_000;

/** Orders created per tick. A backlog is a symptom, never something to flush. */
export const MAX_PER_TICK = 20;

export interface BridgeDeps {
  readonly clock?: () => Date;
  readonly logSink?: (line: string) => void;
  /** Test seam; defaults to the RFC-012 gate over the same pool. */
  readonly resolutionGateFn?: ResolutionGateFn;
  readonly latencyMs?: number;
  readonly maxPerTick?: number;
  /**
   * This process's PAPER_BOOT instant, supplied by the runner.
   *
   * Only `aged_out` uses it. Absent (a direct call, a test that does not care)
   * the counter keeps its pre-RFC-022 meaning and counts the whole retained
   * backlog, which is wrong for production but never hides a loss.
   */
  readonly bootAt?: Date;
}

/**
 * The two decision kinds the bridge turns into orders.
 *
 * `EXIT` arrived with RFC-022 D4-A. Until then the only reader of an `EXIT` row
 * was `exitstore.ts`'s own signature check, and production accumulated 293
 * `EXIT ACCEPTED` decisions with `paper_order_id` null in 293 of 293 — a
 * position could only ever close by resolution.
 */
export type DecisionKind = "ENTRY" | "EXIT";

export interface BridgeOutcome {
  readonly considered: number;
  readonly accepted: number;
  readonly skipped: number;
  /** Decisions that aged past a freshness bound before an order existed. */
  readonly agedOut: number;
  /** The same three counts, for exits. Kept apart so neither number lies. */
  readonly exitsConsidered: number;
  readonly exitsAccepted: number;
  readonly exitsSkipped: number;
  readonly exitsAgedOut: number;
}

interface PendingDecision {
  readonly kind: DecisionKind;
  readonly decisionId: number;
  readonly conditionId: string;
  readonly tokenId: string;
  readonly marketSide: "YES" | "NO";
  readonly orderSide: OrderSide;
  readonly decisionTs: Date;
  readonly qLo: string | null;
  readonly qHi: string | null;
  readonly sizeShares: string | null;
}

/**
 * Pending work: accepted entries, still fresh, with no order of their own.
 *
 * `paper_order_id IS NULL` is the index-friendly prefilter, not the authority.
 * The stamp back into the decision log is done by the portfolio module on its
 * own next cycle (up to a minute later), so between the accept and the stamp the
 * decision still looks unstamped — the NOT EXISTS against `paper_orders` is what
 * actually keeps the bridge from acting twice. The unique index on
 * `paper_orders.decision_id` is the backstop underneath both.
 */
function pendingSql(kind: DecisionKind): string {
  return (
    "SELECT d.decision_id, d.condition_id, d.token_id, d.market_side, " +
    "d.order_side, d.decision_ts, d.q_lo, d.q_hi, d.size_shares " +
    "FROM portfolio_decisions d " +
    `WHERE d.outcome = 'ACCEPTED' AND d.decision_kind = '${kind}' ` +
    "AND d.paper_order_id IS NULL " +
    "AND d.received_at > $1 AND d.decision_ts > $2 " +
    "AND NOT EXISTS (SELECT 1 FROM paper_orders o WHERE o.decision_id = d.decision_id) " +
    "ORDER BY d.decision_id LIMIT $3"
  );
}

/**
 * One exit order open per token at a time (RFC-022 D4-A).
 *
 * The exit verdict oscillates — 186 `EXIT ACCEPTED` on one BTC market in 4 h,
 * the verdict flipping about every 77 s — and reposting a sale on every flip
 * would destroy the position's place in the queue, which is the whole point of
 * a passive exit. The hysteresis that decides WHETHER to exit is the RFC-013
 * exit planner's; this is only the guard that keeps one decision from becoming
 * many orders.
 *
 * Joined against the decision log rather than filtered on `side = 'SELL'`,
 * because an ENTRY on the NO leg is also a SELL of the affirmative token: the
 * side alone cannot tell an exit from an entry.
 */
const OPEN_EXIT_SQL =
  "SELECT 1 FROM paper_orders o " +
  "JOIN portfolio_decisions d ON d.decision_id = o.decision_id " +
  "WHERE o.token_id = $1 AND o.status = 'open' " +
  "AND d.decision_kind = 'EXIT' LIMIT 1";

/**
 * Accepted entries that will never become orders because they aged out.
 *
 * Counted and logged rather than silently dropped: a non-zero value means the
 * gap between deciding and bridging exceeded a freshness bound, which is an
 * operational fault (a stalled tick, a slow cycle) and not a market condition.
 *
 * Bounded below by this process's own boot (RFC-022 D1). Without that bound the
 * count is the whole retained backlog and can only grow: production printed
 * `aged_out: 86` on every tick, 30 s apart, for rows whose newest was 30 hours
 * older than the running process — a number that says nothing about the tick
 * that printed it, and that no fix could ever bring back to zero. Everything
 * received before boot is somebody else's history; what this counter must report
 * is what THIS process is losing now.
 */
function agedOutSql(kind: DecisionKind): string {
  return (
    "SELECT count(*) AS aged_out FROM portfolio_decisions d " +
    `WHERE d.outcome = 'ACCEPTED' AND d.decision_kind = '${kind}' ` +
    "AND d.paper_order_id IS NULL " +
    "AND (d.received_at <= $1 OR d.decision_ts <= $2) " +
    "AND d.received_at > $3 " +
    "AND NOT EXISTS (SELECT 1 FROM paper_orders o WHERE o.decision_id = d.decision_id)"
  );
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

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

function toInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

function parsePending(
  kind: DecisionKind,
  row: Record<string, unknown>,
): PendingDecision | null {
  const decisionId = toInteger(row["decision_id"]);
  const conditionId = asString(row["condition_id"]);
  const tokenId = asString(row["token_id"]);
  const marketSide = row["market_side"];
  const orderSide = row["order_side"];
  const decisionTs = toDate(row["decision_ts"]);
  if (
    decisionId === null ||
    conditionId === null ||
    tokenId === null ||
    (marketSide !== "YES" && marketSide !== "NO") ||
    (orderSide !== "BUY" && orderSide !== "SELL") ||
    decisionTs === null
  ) {
    return null;
  }
  return {
    kind,
    decisionId,
    conditionId,
    tokenId,
    marketSide,
    orderSide,
    decisionTs,
    qLo: asString(row["q_lo"]),
    qHi: asString(row["q_hi"]),
    sizeShares: asString(row["size_shares"]),
  };
}

/**
 * The order id IS the decision id.
 *
 * Deterministic on purpose: a crash between accepting the order and stamping the
 * decision cannot produce a second order on the next tick, because the primary
 * key is already taken. Idempotency lives in the database, not in the job's
 * memory.
 */
export function bridgeOrderId(decisionId: number): string {
  return `portfolio:${String(decisionId)}`;
}

/**
 * The conservative bound to quote against, in the traded token's price space.
 *
 * The portfolio engine models the NO leg as SELLING the affirmative token, so
 * every decision names the affirmative token and `order_side` carries the leg.
 * The bound has to flip with the leg: for a BUY the pessimistic case is that the
 * probability is as LOW as `q_lo`, and for a SELL it is that the probability is
 * as HIGH as `q_hi`. Passing `q_lo` for a sell would hand the policy the
 * optimistic bound wearing the name of the conservative one, and the taker
 * branch (`edge = worst - qLo`) would read a profit that the interval does not
 * support.
 */
export function conservativeBound(
  orderSide: OrderSide,
  qLo: string | null,
  qHi: string | null,
): string | null {
  return orderSide === "BUY" ? qLo : qHi;
}

export async function bridgeTick(
  pool: PaperPool,
  deps: BridgeDeps = {},
): Promise<BridgeOutcome> {
  const clock = deps.clock ?? ((): Date => new Date());
  const write =
    deps.logSink ??
    ((line: string): void => {
      process.stderr.write(line);
    });
  const log = (
    level: "info" | "warn" | "error",
    reasonCode: string,
    extra: Record<string, unknown> = {},
  ): void => {
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
  const gateFn: ResolutionGateFn =
    deps.resolutionGateFn ?? ((input) => resolutionGate(pool, input));
  const now = clock();
  const receivedCutoff = new Date(now.getTime() - MAX_RECEIVED_AGE_MS);
  const decisionTsCutoff = new Date(now.getTime() - MAX_DECISION_TS_AGE_MS);
  const bootAt = deps.bootAt ?? new Date(0);
  const maxPerTick = deps.maxPerTick ?? MAX_PER_TICK;

  const pending: PendingDecision[] = [];
  const unreadable: Record<DecisionKind, number> = { ENTRY: 0, EXIT: 0 };
  const agedOutByKind: Record<DecisionKind, number> = { ENTRY: 0, EXIT: 0 };
  const consideredByKind: Record<DecisionKind, number> = { ENTRY: 0, EXIT: 0 };
  for (const kind of ["ENTRY", "EXIT"] as const) {
    const rows = await pool.query<Record<string, unknown>>(pendingSql(kind), [
      receivedCutoff,
      decisionTsCutoff,
      maxPerTick,
    ]);
    consideredByKind[kind] = rows.rows.length;
    for (const row of rows.rows) {
      const parsed = parsePending(kind, row);
      if (parsed === null) {
        unreadable[kind] += 1;
        log("error", "BRIDGE_DECISION_UNREADABLE", { decision_kind: kind });
        continue;
      }
      pending.push(parsed);
    }
    const agedRows = await pool.query<Record<string, unknown>>(
      agedOutSql(kind),
      [receivedCutoff, decisionTsCutoff, bootAt],
    );
    agedOutByKind[kind] = toInteger(agedRows.rows[0]?.["aged_out"]) ?? 0;
  }

  const acceptedByKind: Record<DecisionKind, number> = { ENTRY: 0, EXIT: 0 };
  const skippedByKind: Record<DecisionKind, number> = { ...unreadable };

  for (const decision of pending) {
    const skip = (
      reason: string,
      extra: Record<string, unknown> = {},
    ): void => {
      skippedByKind[decision.kind] += 1;
      log("warn", "BRIDGE_DECISION_SKIPPED", {
        decision_id: decision.decisionId,
        decision_kind: decision.kind,
        token_id: decision.tokenId,
        reason,
        ...extra,
      });
    };

    const bound = conservativeBound(
      decision.orderSide,
      decision.qLo,
      decision.qHi,
    );
    if (bound === null) {
      skip("DECISION_INCOMPLETE");
      continue;
    }

    // An EXIT row is NOT sized: `decisionrow.ts` writes `size_shares` null and
    // `binding_constraint` NOT_SIZED, because leaving a position is not sized by
    // the entry limiters. The size is the position, read from the ledger — the
    // same replay `reduceOnlyCap` uses, so the sale can never exceed what the
    // ledger says is held. The validator rounds DOWN to the tick's size digits,
    // which is the right direction for a reduce-only sale.
    let size = decision.sizeShares;
    if (decision.kind === "EXIT") {
      if (await hasOpenExitOrder(pool, decision.tokenId)) {
        skip("EXIT_ORDER_ALREADY_OPEN");
        continue;
      }
      let shares: bigint;
      try {
        shares = await positionShares(pool, decision.tokenId);
      } catch {
        skip("EXIT_POSITION_UNREADABLE");
        continue;
      }
      if (shares <= 0n) {
        skip("EXIT_NO_POSITION");
        continue;
      }
      size = formatScaled(shares, SCALE_DIGITS);
    }
    if (size === null) {
      skip("DECISION_INCOMPLETE");
      continue;
    }

    // The RFC-012 gate, with intent semantics: a decision is a MODEL speaking,
    // so a missing resolution state fails closed, a VETO refuses with no
    // override available, and an active sanity veto refuses. The portfolio
    // engine checked its own resolution state when it decided; this re-checks at
    // the instant the order would exist, which is the instant that matters.
    const gate = await gateFn({
      conditionId: decision.conditionId,
      tokenId: decision.tokenId,
      source: "intent",
    });
    if (!gate.allowed) {
      skip(gate.reason ?? "RESOLUTION_REFUSED", { action: gate.action });
      continue;
    }

    const params = await paramsAtOrBefore(pool, decision.conditionId, now);
    if (params === null || params.tickSize === null) {
      skip("UNKNOWN_MARKET_PARAMS");
      continue;
    }

    const book = await bookAtOrBefore(pool, decision.tokenId, now);
    const reference = book?.sourceTs ?? book?.receivedAt ?? null;
    if (
      book === null ||
      reference === null ||
      now.getTime() - reference.getTime() > MAX_BOOK_AGE_MS
    ) {
      skip("NO_FRESH_BOOK");
      continue;
    }

    const minsToCatalyst = await catalystMinutes(pool, decision.tokenId);
    const policy = decideOrderType({
      side: decision.orderSide,
      qLo: bound,
      size,
      bids: book.bids,
      asks: book.asks,
      tickSize: params.tickSize,
      takerFeeRate: feeRateFromBps(params.takerFeeBps),
      minsToCatalyst,
      // The defensive external-fair wire is not part of a decision's payload;
      // absent signal means no retreat, never an attack.
      externalFairAgainst: false,
    });
    if (!policy.ok) {
      skip(policy.reason);
      continue;
    }

    const draft: OrderDraft = {
      tokenId: decision.tokenId,
      side: decision.orderSide,
      orderType: policy.value.orderType,
      limitPrice: policy.value.limitPrice,
      size,
      postOnly: policy.value.postOnly,
      worstPrice: policy.value.worstPrice,
      ttlS: policy.value.ttlS,
    };
    const outcome = await acceptPaperOrder(
      pool,
      {
        orderId: bridgeOrderId(decision.decisionId),
        draft,
        conditionId: decision.conditionId,
        source: "portfolio",
        decisionId: decision.decisionId,
        policyReason: policy.value.policyReason,
        policyVersion: POLICY_VERSION,
        intent: {
          q_lo: decision.qLo,
          q_hi: decision.qHi,
          size_max: size,
          market_side: decision.marketSide,
          decision_id: decision.decisionId,
          decision_kind: decision.kind,
        },
      },
      {
        ...(deps.clock === undefined ? {} : { clock: deps.clock }),
        ...(deps.latencyMs === undefined ? {} : { latencyMs: deps.latencyMs }),
        logSink: write,
      },
    );
    if (outcome.status === "rejected") {
      skip(outcome.reason, { http_status: outcome.httpStatus });
      continue;
    }
    acceptedByKind[decision.kind] += 1;
    log("info", "BRIDGE_ORDER_ACCEPTED", {
      decision_id: decision.decisionId,
      decision_kind: decision.kind,
      order_id: bridgeOrderId(decision.decisionId),
      token_id: decision.tokenId,
      market_side: decision.marketSide,
      order_side: decision.orderSide,
      order_type: policy.value.orderType,
      limit_price: policy.value.limitPrice,
      size,
      policy_reason: policy.value.policyReason,
    });
  }

  const outcome: BridgeOutcome = {
    considered: consideredByKind.ENTRY,
    accepted: acceptedByKind.ENTRY,
    skipped: skippedByKind.ENTRY,
    agedOut: agedOutByKind.ENTRY,
    exitsConsidered: consideredByKind.EXIT,
    exitsAccepted: acceptedByKind.EXIT,
    exitsSkipped: skippedByKind.EXIT,
    exitsAgedOut: agedOutByKind.EXIT,
  };
  const anyWork =
    outcome.considered > 0 ||
    outcome.agedOut > 0 ||
    outcome.exitsConsidered > 0 ||
    outcome.exitsAgedOut > 0;
  if (anyWork) {
    log(
      outcome.agedOut > 0 || outcome.exitsAgedOut > 0 ? "warn" : "info",
      "BRIDGE_TICK",
      {
        considered: outcome.considered,
        accepted: outcome.accepted,
        skipped: outcome.skipped,
        aged_out: outcome.agedOut,
        exits_considered: outcome.exitsConsidered,
        exits_accepted: outcome.exitsAccepted,
        exits_skipped: outcome.exitsSkipped,
        exits_aged_out: outcome.exitsAgedOut,
        boot_at: deps.bootAt?.toISOString() ?? null,
      },
    );
  }
  return outcome;
}

/** Whether this token already has an exit order resting in the book. */
async function hasOpenExitOrder(
  pool: PaperPool,
  tokenId: string,
): Promise<boolean> {
  const result = await pool.query<Record<string, unknown>>(OPEN_EXIT_SQL, [
    tokenId,
  ]);
  return result.rows.length > 0;
}

/** Catalyst clock from the newest persisted feature window, as the API does. */
async function catalystMinutes(
  pool: PaperPool,
  tokenId: string,
): Promise<number | null> {
  const result = await pool.query<Record<string, unknown>>(
    "SELECT mins_to_catalyst FROM paper_feature_windows " +
      "WHERE token_id = $1 ORDER BY window_start DESC LIMIT 1",
    [tokenId],
  );
  const raw = result.rows[0]?.["mins_to_catalyst"];
  return typeof raw === "number" ? raw : null;
}
