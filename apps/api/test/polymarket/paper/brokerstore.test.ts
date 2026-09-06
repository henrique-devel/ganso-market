import { describe, expect, it } from "vitest";

import type { QueryResult, SqlExecutor } from "../../../src/database.js";
import {
  acceptPaperOrder,
  brokerTick,
  engageKillSwitch,
  killSwitchTriggersTick,
  loadKillSwitch,
  markTick,
  requestCancel,
  settlementTick,
  type PaperPool,
} from "../../../src/polymarket/paper/brokerstore.js";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// An in-memory world behind a fake pool that implements the exact SQL the
// store issues, INCLUDING its time bounds and mutations — the scenarios below
// are the RFC-011 mandatory tests for latency, queueing, cancellation,
// expiry, fees, settlement, marks and the kill switch.

interface World {
  queries: string[];
  orders: Row[];
  ledger: Row[];
  positions: Row[];
  kill: Row;
  killRowPresent: boolean;
  snapshots: Array<{
    token_id: string;
    received_at: Date;
    source_ts: Date | null;
    bids_json: unknown;
    asks_json: unknown;
  }>;
  params: Array<{
    condition_id: string;
    param_version_id: number;
    version: number;
    valid_from: Date;
    tick_size: string;
    min_order_size: string;
    taker_fee_bps: string | null;
    neg_risk: boolean;
  }>;
  trades: Array<{
    trade_id: number;
    token_id: string;
    price: string;
    size: string | null;
    ts: Date;
  }>;
  resolutions: Array<{
    resolution_event_id: number;
    condition_id: string;
    event_type: string;
    payload_json: Record<string, unknown>;
    received_at: Date;
  }>;
  markets: Array<{
    condition_id: string;
    clob_token_ids: string[];
    neg_risk: boolean;
  }>;
  /** RFC-012 markets under an effective CIRCUIT_BREAKER. */
  breakers: string[];
  resolutionActionReads: Array<"NONE" | "BUFFER" | "VETO" | "CIRCUIT_BREAKER">;
  resolutionStateReadErrors: Array<Error | null>;
  resolutionActionAfterNextFillAppend:
    "NONE" | "BUFFER" | "VETO" | "CIRCUIT_BREAKER" | null;
  sanityVetoes: string[];
  sanityVetoReads: boolean[];
  sanityVetoReadErrors: Array<Error | null>;
  sanityVetoAfterNextFillAppend: boolean | null;
  resolutionMarketStateMode: "present" | "missing" | "invalid";
  resolutionStateError: Error | null;
  ledgerReadError: Error | null;
  acceptedEventFailures: number;
  cancelEventFailures: number;
  positionRefreshFailures: number;
  killEngagedAfterPolicyLock: boolean;
  runtime: {
    generation: string;
    ready: boolean;
    lease_expires_at: Date;
    processed_resolution_event_id: number;
    processed_rule_version_id: number;
    processed_input_change_id: number;
    event_head: number;
    rule_head: number;
    input_head: number;
    stopped_at: Date | null;
    graph_evaluated_at: Date | null;
    graph_valid_until: Date | null;
  } | null;
  databaseNow: Date;
  runtimeCheckedAt: Date[];
  databaseTimeAfterNextAcceptanceAppend: Date | null;
  databaseTimeAfterNextFillAppend: Date | null;
  /** received_at of the oldest journal entry the runtime has not processed. */
  oldestUnprocessedAt: Date | null;
}

const RUNTIME_GENERATION = "11111111-1111-4111-8111-111111111111";

function emptyWorld(): World {
  return {
    queries: [],
    orders: [],
    ledger: [],
    positions: [],
    kill: {
      engaged: false,
      reason: null,
      frozen_markets_json: [],
      daily_anchor_date: null,
      daily_anchor_equity_usd: null,
    },
    killRowPresent: true,
    snapshots: [],
    params: [],
    trades: [],
    resolutions: [],
    markets: [],
    breakers: [],
    resolutionActionReads: [],
    resolutionStateReadErrors: [],
    resolutionActionAfterNextFillAppend: null,
    sanityVetoes: [],
    sanityVetoReads: [],
    sanityVetoReadErrors: [],
    sanityVetoAfterNextFillAppend: null,
    resolutionMarketStateMode: "present",
    resolutionStateError: null,
    ledgerReadError: null,
    acceptedEventFailures: 0,
    cancelEventFailures: 0,
    positionRefreshFailures: 0,
    killEngagedAfterPolicyLock: false,
    runtime: {
      generation: RUNTIME_GENERATION,
      ready: true,
      lease_expires_at: new Date("2026-08-25T12:00:00.000Z"),
      processed_resolution_event_id: 0,
      processed_rule_version_id: 0,
      processed_input_change_id: 0,
      event_head: 0,
      rule_head: 0,
      input_head: 0,
      stopped_at: null,
      graph_evaluated_at: new Date("2026-08-24T11:59:00.000Z"),
      graph_valid_until: new Date("2026-08-25T12:00:00.000Z"),
    },
    databaseNow: new Date("2026-08-24T12:00:00.000Z"),
    runtimeCheckedAt: [],
    databaseTimeAfterNextAcceptanceAppend: null,
    databaseTimeAfterNextFillAppend: null,
    oldestUnprocessedAt: null,
  };
}

function num(value: unknown): number {
  return typeof value === "string" ? Number(value) : (value as number);
}

function hasAuditedVetoOverride(world: World, orderId: unknown): boolean {
  return world.ledger.some((event) => {
    if (
      event["order_id"] !== orderId ||
      event["event_type"] !== "order_accepted"
    ) {
      return false;
    }
    const override = (event["payload_json"] as Row)["override_veto"];
    const score = (override as Row | null)?.["score"];
    const scoreVersion = (override as Row | null)?.["score_version"];
    const justification = (override as Row | null)?.["justification"];
    return (
      typeof override === "object" &&
      override !== null &&
      !Array.isArray(override) &&
      (override as Row)["action"] === "VETO" &&
      typeof score === "string" &&
      /^(?:0\.[0-9]{6}|1\.000000)$/.test(score) &&
      typeof scoreVersion === "string" &&
      /^[0-9]+\.[0-9]+\.[0-9]+$/.test(scoreVersion) &&
      typeof justification === "string" &&
      justification.trim().length > 0
    );
  });
}

function worldPool(world: World): PaperPool {
  let acceptedEventFailures = world.acceptedEventFailures;
  let cancelEventFailures = world.cancelEventFailures;
  let positionRefreshFailures = world.positionRefreshFailures;
  let transactionTail: Promise<void> = Promise.resolve();
  const pool: PaperPool = {
    query<R extends Row>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      world.queries.push(text);
      const rows = ((): Row[] => {
        // --- paper_orders ---
        if (text.startsWith("INSERT INTO paper_orders")) {
          const acceptedGeneration = params[16];
          world.orders.push({
            order_id: params[0],
            token_id: params[1],
            condition_id: params[2],
            side: params[3],
            order_type: params[4],
            limit_price: params[5],
            size: params[6],
            amount_usd: params[7],
            post_only: params[8],
            worst_price: params[9],
            expiration_s: params[10],
            policy_reason: params[11],
            policy_version: params[12],
            source: params[13],
            status: "open",
            filled_size: "0",
            queue_ahead: null,
            decided_at: params[14],
            accepted_at: params[15],
            cancel_requested_at: null,
            cancel_effective_at: null,
            closed_at: null,
            created_at: params[14],
            resolution_generation: acceptedGeneration,
            resolution_risk_check_pending: false,
            resolution_risk_claim: null,
            resolution_risk_claimed_at: null,
            resolution_cancel_reason: null,
            resolution_cancel_details_json: {},
          });
          return [{ resolution_generation: acceptedGeneration }];
        }
        if (text.includes("FROM paper_orders o WHERE o.status = 'open'")) {
          return world.orders
            .filter((order) => order["status"] === "open")
            .map((order) => ({
              ...order,
              resolution_veto_override: hasAuditedVetoOverride(
                world,
                order["order_id"],
              ),
            }));
        }
        if (
          text.includes(
            "FROM paper_orders o WHERE o.order_id = $1 AND o.status = 'open'",
          )
        ) {
          return world.orders
            .filter(
              (order) =>
                order["order_id"] === params[0] && order["status"] === "open",
            )
            .map((order) => ({
              ...order,
              resolution_veto_override: hasAuditedVetoOverride(
                world,
                order["order_id"],
              ),
            }));
        }
        if (
          text.startsWith(
            "SELECT order_id, token_id, condition_id, order_type, status",
          )
        ) {
          return world.orders.filter((o) => o["order_id"] === params[0]);
        }
        if (
          text.includes("SET status = $2, filled_size = $3, closed_at = $4")
        ) {
          for (const order of world.orders) {
            if (order["order_id"] === params[0] && order["status"] === "open") {
              order["status"] = params[1];
              order["filled_size"] = params[2];
              order["closed_at"] = params[3];
              order["resolution_risk_check_pending"] = false;
              order["resolution_risk_claim"] = null;
              order["resolution_risk_claimed_at"] = null;
            }
          }
          return [];
        }
        if (text.includes("SET cancel_requested_at = $2")) {
          for (const order of world.orders) {
            if (order["order_id"] === params[0] && order["status"] === "open") {
              order["cancel_requested_at"] = params[1];
            }
          }
          return [];
        }
        if (text.includes("SET queue_ahead = $2")) {
          for (const order of world.orders) {
            if (
              order["order_id"] === params[0] &&
              order["queue_ahead"] === null
            ) {
              order["queue_ahead"] = params[1];
            }
          }
          return [];
        }
        if (text.includes("SET filled_size = $2 WHERE order_id = $1")) {
          for (const order of world.orders) {
            if (order["order_id"] === params[0] && order["status"] === "open") {
              order["filled_size"] = params[1];
            }
          }
          return [];
        }
        if (
          text.includes("SET resolution_risk_check_pending = TRUE") &&
          text.includes("RETURNING order_id")
        ) {
          const order = world.orders.find(
            (item) =>
              item["order_id"] === params[0] &&
              item["status"] === "open" &&
              item["resolution_risk_check_pending"] === false,
          );
          if (order === undefined) {
            return [];
          }
          order["resolution_risk_check_pending"] = true;
          order["resolution_risk_claim"] = params[1];
          order["resolution_risk_claimed_at"] = params[2];
          return [{ order_id: params[0] }];
        }
        if (text.includes("SET resolution_risk_check_pending = FALSE")) {
          for (const order of world.orders) {
            if (order["order_id"] === params[0] && order["status"] === "open") {
              order["resolution_risk_check_pending"] = false;
              order["resolution_risk_claim"] = null;
              order["resolution_risk_claimed_at"] = null;
            }
          }
          return [];
        }
        if (text.includes("SET resolution_cancel_reason = $2")) {
          for (const order of world.orders) {
            if (order["order_id"] === params[0] && order["status"] === "open") {
              order["resolution_cancel_reason"] = params[1];
              order["resolution_cancel_details_json"] = JSON.parse(
                params[2] as string,
              ) as Row;
            }
          }
          return [];
        }
        if (
          text.includes(
            "SET status = 'canceled', cancel_requested_at = COALESCE",
          )
        ) {
          for (const order of world.orders) {
            if (order["order_id"] === params[0] && order["status"] === "open") {
              order["status"] = "canceled";
              order["closed_at"] = params[1];
            }
          }
          return [];
        }
        if (
          text.startsWith(
            "SELECT order_id, token_id, condition_id FROM paper_orders WHERE status = 'open'",
          )
        ) {
          return world.orders.filter((o) => o["status"] === "open");
        }
        if (
          text.includes(
            "SELECT order_id, token_id, condition_id, filled_size",
          ) &&
          text.includes("ORDER BY order_id") &&
          text.includes("FOR UPDATE")
        ) {
          return world.orders.filter(
            (order) =>
              order["status"] === "open" &&
              (order["token_id"] === params[0] ||
                order["condition_id"] === params[1]),
          );
        }

        // --- ledger ---
        if (text.startsWith("INSERT INTO paper_ledger_events")) {
          if (params[1] === "order_accepted" && acceptedEventFailures > 0) {
            acceptedEventFailures -= 1;
            throw new Error("acceptance audit unavailable");
          }
          if (params[1] === "cancel_effective" && cancelEventFailures > 0) {
            cancelEventFailures -= 1;
            throw new Error("cancel audit unavailable");
          }
          const key = params[0] as string;
          if (world.ledger.some((e) => e["idempotency_key"] === key)) {
            return []; // duplicate absorbed; rowCount 0 via marker below
          }
          world.ledger.push({
            idempotency_key: key,
            event_type: params[1],
            order_id: params[2],
            token_id: params[3],
            condition_id: params[4],
            payload_json: JSON.parse(params[5] as string) as Row,
            event_ts: params[6],
            inserted: true,
          });
          if (
            params[1] === "order_accepted" &&
            world.databaseTimeAfterNextAcceptanceAppend !== null
          ) {
            world.databaseNow = world.databaseTimeAfterNextAcceptanceAppend;
            world.databaseTimeAfterNextAcceptanceAppend = null;
          }
          if (
            params[1] === "fill" &&
            world.databaseTimeAfterNextFillAppend !== null
          ) {
            world.databaseNow = world.databaseTimeAfterNextFillAppend;
            world.databaseTimeAfterNextFillAppend = null;
          }
          if (
            params[1] === "fill" &&
            world.resolutionActionAfterNextFillAppend !== null
          ) {
            world.resolutionActionReads.unshift(
              world.resolutionActionAfterNextFillAppend,
            );
            world.resolutionActionAfterNextFillAppend = null;
          }
          if (
            params[1] === "fill" &&
            world.sanityVetoAfterNextFillAppend !== null
          ) {
            world.sanityVetoReads.unshift(world.sanityVetoAfterNextFillAppend);
            world.sanityVetoAfterNextFillAppend = null;
          }
          return [{ inserted: true }];
        }
        if (
          text.startsWith("SELECT idempotency_key FROM paper_ledger_events") &&
          text.includes("event_type = 'fill'")
        ) {
          return world.ledger.filter(
            (event) =>
              event["order_id"] === params[0] && event["event_type"] === "fill",
          );
        }
        if (text.includes("FROM paper_ledger_events WHERE token_id = $1")) {
          if (world.ledgerReadError !== null) {
            throw world.ledgerReadError;
          }
          return world.ledger.filter((e) => e["token_id"] === params[0]);
        }

        // --- positions ---
        if (text.startsWith("INSERT INTO paper_positions")) {
          if (positionRefreshFailures > 0) {
            positionRefreshFailures -= 1;
            throw new Error("position cache unavailable");
          }
          const existing = world.positions.find(
            (p) => p["token_id"] === params[0],
          );
          const next = {
            token_id: params[0],
            condition_id: params[1],
            shares: params[2],
            cost_usd: params[3],
            realized_pnl_usd: params[4],
            fees_paid_usd: params[5],
            opened_at: params[6],
            resolved_at: params[7],
            lockup_s: params[8],
            mark_value_usd: existing?.["mark_value_usd"] ?? null,
            mark_stale: existing?.["mark_stale"] ?? null,
          };
          if (existing !== undefined) {
            Object.assign(existing, next);
          } else {
            world.positions.push(next);
          }
          return [];
        }
        if (
          text.startsWith(
            "SELECT p.token_id, p.condition_id FROM paper_positions p",
          )
        ) {
          return world.positions.filter(
            (p) => num(p["shares"]) !== 0 && p["condition_id"] !== null,
          );
        }
        if (
          text.startsWith(
            "SELECT token_id, condition_id, shares FROM paper_positions",
          )
        ) {
          return world.positions.filter((p) => num(p["shares"]) !== 0);
        }
        if (text.includes("SET mark_value_usd = $2, mark_stale = FALSE")) {
          for (const position of world.positions) {
            if (position["token_id"] === params[0]) {
              position["mark_value_usd"] = params[1];
              position["mark_stale"] = false;
            }
          }
          return [];
        }
        if (text.includes("SET mark_stale = TRUE")) {
          for (const position of world.positions) {
            if (position["token_id"] === params[0]) {
              position["mark_stale"] = true;
            }
          }
          return [];
        }
        if (text.includes("SUM(realized_pnl_usd::numeric)")) {
          let realized = 0;
          let unrealized = 0;
          for (const p of world.positions) {
            realized += num(p["realized_pnl_usd"] ?? 0);
            const shares = num(p["shares"] ?? 0);
            if (shares !== 0) {
              const mark =
                p["mark_value_usd"] === null ||
                p["mark_value_usd"] === undefined
                  ? num(p["cost_usd"] ?? 0)
                  : num(p["mark_value_usd"]);
              const cost = num(p["cost_usd"] ?? 0);
              unrealized += shares > 0 ? mark - cost : cost - mark;
            }
          }
          return [
            { realized: String(realized), unrealized: String(unrealized) },
          ];
        }

        // --- kill switch ---
        if (text.startsWith("SELECT engaged, reason, frozen_markets_json")) {
          return world.killRowPresent ? [world.kill] : [];
        }
        if (text.startsWith("SELECT daily_anchor_date")) {
          return [world.kill];
        }
        if (text.includes("SET engaged = TRUE")) {
          if (!world.killRowPresent) {
            return [];
          }
          world.kill["engaged"] = true;
          world.kill["reason"] = params[0];
          return [{ kill_switch_id: 1 }];
        }
        if (text.includes("SET engaged = FALSE")) {
          if (!world.killRowPresent) {
            return [];
          }
          world.kill["engaged"] = false;
          world.kill["reason"] = null;
          return [{ kill_switch_id: 1 }];
        }
        if (text.includes("SET frozen_markets_json")) {
          const frozen = world.kill["frozen_markets_json"] as string[];
          if (!frozen.includes(params[0] as string)) {
            frozen.push(params[0] as string);
          }
          return [];
        }
        if (text.includes("SET daily_anchor_date = $1")) {
          world.kill["daily_anchor_date"] = params[0];
          world.kill["daily_anchor_equity_usd"] = params[1];
          return [];
        }

        // --- RFC-012 resolution state (read-only) ---
        if (text.includes("FROM resolution_runtime_state r")) {
          if (world.resolutionStateError !== null) {
            throw world.resolutionStateError;
          }
          const checkedAt = world.runtimeCheckedAt.shift();
          if (checkedAt !== undefined) {
            world.databaseNow = checkedAt;
          }
          return world.runtime === null
            ? []
            : [{ ...world.runtime, checked_at: world.databaseNow }];
        }
        if (text.includes("FROM resolution_market_state")) {
          const scheduledError = world.resolutionStateReadErrors.shift();
          if (scheduledError) {
            throw scheduledError;
          }
          if (world.resolutionStateError !== null) {
            throw world.resolutionStateError;
          }
          if (world.resolutionMarketStateMode === "missing") {
            return [];
          }
          if (world.resolutionMarketStateMode === "invalid") {
            return [{ effective_action: "UNKNOWN_ACTION" }];
          }
          const scheduledAction = world.resolutionActionReads.shift();
          return [
            {
              effective_action:
                scheduledAction ??
                (world.breakers.includes(params[0] as string)
                  ? "CIRCUIT_BREAKER"
                  : "NONE"),
            },
          ];
        }
        if (text.includes("FROM graph_sanity_vetoes")) {
          const scheduledError = world.sanityVetoReadErrors.shift();
          if (scheduledError) {
            throw scheduledError;
          }
          const scheduledVeto = world.sanityVetoReads.shift();
          const active =
            scheduledVeto ?? world.sanityVetoes.includes(params[0] as string);
          return active ? [{ veto_id: 1 }] : [];
        }
        if (text.startsWith("LOCK TABLE resolution_market_state")) {
          if (world.killEngagedAfterPolicyLock) {
            world.kill["engaged"] = true;
            world.kill["reason"] = "operator stop";
            world.killEngagedAfterPolicyLock = false;
          }
          return [];
        }
        if (
          text.startsWith("LOCK TABLE polymarket_resolution_input_changes") ||
          text.includes("pg_advisory_xact_lock")
        ) {
          return [];
        }

        // --- recorder data ---
        if (text.includes("SELECT MAX(received_at) AS newest")) {
          const newest = world.snapshots.reduce<Date | null>(
            (acc, s) =>
              acc === null || s.received_at.getTime() > acc.getTime()
                ? s.received_at
                : acc,
            null,
          );
          return [{ newest }];
        }
        if (text.includes("FROM polymarket_book_snapshots")) {
          const eligible = world.snapshots
            .filter(
              (s) =>
                s.token_id === params[0] &&
                s.received_at.getTime() <= (params[1] as Date).getTime(),
            )
            .sort((a, b) => b.received_at.getTime() - a.received_at.getTime());
          const first = eligible[0];
          return first === undefined ? [] : [first as unknown as Row];
        }
        if (text.includes("FROM polymarket_param_versions")) {
          const eligible = world.params
            .filter(
              (p) =>
                p.condition_id === params[0] &&
                p.valid_from.getTime() <= (params[1] as Date).getTime(),
            )
            .sort((a, b) => b.version - a.version);
          const first = eligible[0];
          return first === undefined ? [] : [first as unknown as Row];
        }
        if (text.includes("FROM polymarket_trades")) {
          return world.trades
            .filter(
              (t) =>
                t.token_id === params[0] &&
                t.size !== null &&
                Number(t.price) === Number(params[1]) &&
                t.ts.getTime() > (params[2] as Date).getTime() &&
                t.ts.getTime() <= (params[3] as Date).getTime(),
            )
            .sort(
              (a, b) =>
                a.ts.getTime() - b.ts.getTime() || a.trade_id - b.trade_id,
            )
            .map((t) => ({
              trade_id: t.trade_id,
              size: t.size,
              effective_ts: t.ts,
            }));
        }
        if (text.includes("AS oldest_unprocessed")) {
          return [{ oldest_unprocessed: world.oldestUnprocessedAt }];
        }
        if (
          text.includes("FROM polymarket_resolution_events") &&
          text.includes("JOIN paper_positions")
        ) {
          const held = new Set(
            world.positions
              .filter((p) => num(p["shares"]) !== 0)
              .map((p) => p["condition_id"]),
          );
          const disputed = new Set(
            world.resolutions
              .filter(
                (r) => r.event_type === "disputed" && held.has(r.condition_id),
              )
              .map((r) => r.condition_id),
          );
          return [...disputed].map((condition_id) => ({ condition_id }));
        }
        if (text.includes("FROM polymarket_resolution_events")) {
          const eligible = world.resolutions
            .filter(
              (r) =>
                r.condition_id === params[0] &&
                (r.event_type === "resolved" ||
                  r.event_type === "market_resolved"),
            )
            .sort((a, b) => b.received_at.getTime() - a.received_at.getTime());
          const first = eligible[0];
          return first === undefined ? [] : [first as unknown as Row];
        }
        if (text.includes("FROM polymarket_markets")) {
          return world.markets.filter(
            (m) => m.condition_id === params[0],
          ) as unknown as Row[];
        }
        throw new Error(`world pool has no handler for: ${text.slice(0, 80)}`);
      })();
      return Promise.resolve({
        rows: rows as R[],
        rowCount: rows.length,
      });
    },
    transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const execute = async (): Promise<T> => {
        const snapshot = structuredClone(world);
        try {
          return await run({ query: pool.query });
        } catch (error) {
          const attemptedQueries = [...world.queries];
          Object.assign(world, snapshot);
          world.queries = attemptedQueries;
          throw error;
        }
      };
      const result = transactionTail.then(execute, execute);
      transactionTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  return pool;
}

const T0 = new Date("2026-08-24T12:00:00.000Z");
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);
const silentSink = (): void => undefined;

function seedMarket(world: World): void {
  world.markets.push({
    condition_id: "0xcond",
    clob_token_ids: ["tok-yes", "tok-no"],
    neg_risk: false,
  });
  world.params.push({
    condition_id: "0xcond",
    param_version_id: 7,
    version: 1,
    valid_from: at(-86_400_000),
    tick_size: "0.01",
    min_order_size: "5",
    taker_fee_bps: "700",
    neg_risk: false,
  });
}

function seedBook(
  world: World,
  offsetMs: number,
  bidPrice: string,
  askPrice: string,
  size = "100",
): void {
  world.snapshots.push({
    token_id: "tok-yes",
    received_at: at(offsetMs),
    source_ts: at(offsetMs - 500),
    bids_json: [{ price: bidPrice, size }],
    asks_json: [{ price: askPrice, size }],
  });
}

async function acceptOrder(
  world: World,
  overrides: Partial<{
    orderId: string;
    side: "BUY" | "SELL";
    orderType: "GTC" | "GTD" | "FAK" | "FOK";
    limitPrice: string;
    size: string;
    worstPrice: string | null;
    ttlS: number | null;
    clockMs: number;
    source: "manual" | "intent";
    resolutionOverride: Record<string, unknown> | null;
  }> = {},
): Promise<ReturnType<typeof acceptPaperOrder>> {
  const pool = worldPool(world);
  return acceptPaperOrder(
    pool,
    {
      orderId: overrides.orderId ?? "order-1",
      draft: {
        tokenId: "tok-yes",
        side: overrides.side ?? "BUY",
        orderType: overrides.orderType ?? "GTC",
        limitPrice: overrides.limitPrice ?? "0.48",
        size: overrides.size ?? "20",
        worstPrice: overrides.worstPrice ?? null,
        ttlS: overrides.ttlS ?? null,
      },
      conditionId: "0xcond",
      source: overrides.source ?? "manual",
      resolutionOverride: overrides.resolutionOverride ?? null,
    },
    {
      clock: () => at(overrides.clockMs ?? 0),
      latencyMs: 1_000,
      logSink: silentSink,
    },
  );
}

function seedSignedPosition(world: World, shares: string): void {
  const signed = Number(shares);
  if (!Number.isFinite(signed) || signed === 0) {
    throw new Error("seedSignedPosition requires a non-zero position");
  }
  const size = String(Math.abs(signed));
  const side = signed > 0 ? "BUY" : "SELL";
  world.positions.push({
    token_id: "tok-yes",
    condition_id: "0xcond",
    shares,
    cost_usd: String(Math.abs(signed) * 0.5),
    realized_pnl_usd: "0",
    fees_paid_usd: "0",
    opened_at: at(-3_600_000),
    resolved_at: null,
    lockup_s: null,
    mark_value_usd: null,
    mark_stale: null,
  });
  world.ledger.push({
    idempotency_key: `seed:${side}:${size}`,
    event_type: "fill",
    order_id: "seed",
    token_id: "tok-yes",
    condition_id: "0xcond",
    payload_json: { side, price: "0.50", size, fee: "0" },
    event_ts: at(-3_600_000),
  });
}

function fillsForOrder(world: World): Row[] {
  return world.ledger.filter(
    (event) =>
      event["event_type"] === "fill" && event["order_id"] === "order-1",
  );
}

describe("acceptance", () => {
  it("accepts a passive order with the simulated latency", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.48", "0.52");
    const outcome = await acceptOrder(world);
    expect(outcome.status).toBe("accepted");
    expect(world.orders[0]?.["status"]).toBe("open");
    expect(
      world.ledger.filter((e) => e["event_type"] === "order_accepted"),
    ).toHaveLength(1);
  });

  it("rolls back the order when its immutable acceptance audit fails", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.48", "0.52");
    world.acceptedEventFailures = 1;

    await expect(acceptOrder(world)).rejects.toThrow(
      "acceptance audit unavailable",
    );

    expect(world.orders).toHaveLength(0);
    expect(
      world.ledger.filter((event) => event["event_type"] === "order_accepted"),
    ).toHaveLength(0);
  });

  it("rejects an orphaned acceptance ledger-key collision", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.48", "0.52");
    world.ledger.push({
      idempotency_key: "order-1:accepted",
      event_type: "order_accepted",
      order_id: "orphan",
      token_id: "tok-yes",
      condition_id: "0xcond",
      payload_json: {},
      event_ts: at(-10_000),
    });

    await expect(acceptOrder(world)).rejects.toThrow(
      "PAPER_ACCEPTANCE_LEDGER_CONFLICT",
    );

    expect(world.orders).toHaveLength(0);
    expect(world.ledger).toHaveLength(1);
  });

  it.each([
    {
      name: "non-canonical score",
      override: {
        action: "VETO",
        score: "0.75",
        score_version: "1.0.0",
        justification: "operator override",
      },
    },
    {
      name: "non-version score version",
      override: {
        action: "VETO",
        score: "0.750000",
        score_version: "latest",
        justification: "operator override",
      },
    },
    {
      name: "blank justification",
      override: {
        action: "VETO",
        score: "0.750000",
        score_version: "1.0.0",
        justification: "   ",
      },
    },
  ])("rejects a $name override before persistence", async (testCase) => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.48", "0.52");

    const outcome = await acceptOrder(world, {
      resolutionOverride: testCase.override,
    });

    expect(outcome).toMatchObject({
      status: "rejected",
      httpStatus: 422,
      reason: "INVALID_RESOLUTION_OVERRIDE",
    });
    expect(world.orders).toHaveLength(0);
  });

  it("post-only that would cross is rejected with a ledger event", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.48", "0.52");
    const outcome = await acceptOrder(world, { limitPrice: "0.53" });
    expect(outcome).toMatchObject({
      status: "rejected",
      httpStatus: 422,
      reason: "POST_ONLY_WOULD_CROSS",
    });
    expect(
      world.ledger.filter((e) => e["event_type"] === "order_rejected"),
    ).toHaveLength(1);
    expect(world.orders).toHaveLength(0);
  });

  it("validator failures surface as 422 with the exact reason", async () => {
    const world = emptyWorld();
    seedMarket(world);
    const outcome = await acceptOrder(world, { size: "4" });
    expect(outcome).toMatchObject({
      status: "rejected",
      httpStatus: 422,
      reason: "SIZE_BELOW_MIN",
    });
  });

  it("does not bind an order to a runtime whose lease expires at decision time", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.48", "0.52");
    if (world.runtime !== null) {
      world.runtime.lease_expires_at = at(0);
    }

    const outcome = await acceptOrder(world);

    expect(outcome).toMatchObject({
      status: "rejected",
      httpStatus: 503,
      reason: "RESOLUTION_RUNTIME_STALE",
    });
    expect(world.orders).toHaveLength(0);
  });

  it.each(["missing", "expired"] as const)(
    "does not bind an order when graph freshness is %s",
    async (testCase) => {
      const world = emptyWorld();
      seedMarket(world);
      seedBook(world, -2_000, "0.48", "0.52");
      if (world.runtime !== null) {
        if (testCase === "missing") {
          world.runtime.graph_evaluated_at = null;
        } else {
          world.runtime.graph_valid_until = at(0);
        }
      }

      const outcome = await acceptOrder(world);

      expect(outcome).toMatchObject({
        status: "rejected",
        httpStatus: 503,
        reason:
          testCase === "missing"
            ? "RESOLUTION_GRAPH_NOT_READY"
            : "RESOLUTION_GRAPH_STALE",
      });
      expect(world.orders).toHaveLength(0);
    },
  );

  it("rolls back when the runtime expires while acceptance is persisted", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.48", "0.52");
    if (world.runtime !== null) {
      world.runtime.lease_expires_at = at(500);
    }
    world.databaseTimeAfterNextAcceptanceAppend = at(500);

    const outcome = await acceptOrder(world);

    expect(outcome).toMatchObject({
      status: "rejected",
      httpStatus: 503,
      reason: "RESOLUTION_RUNTIME_STALE",
    });
    expect(world.orders).toHaveLength(0);
    expect(world.ledger).toHaveLength(0);
  });

  it("rejects CIRCUIT_BREAKER inside the authoritative transaction", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.48", "0.52");
    world.breakers.push("0xcond");

    const outcome = await acceptOrder(world);

    expect(outcome).toMatchObject({
      status: "rejected",
      httpStatus: 409,
      reason: "RESOLUTION_CIRCUIT_BREAKER",
    });
    expect(world.orders).toHaveLength(0);
  });

  it("rejects a terminal market under the input-journal lock", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.48", "0.52");
    world.resolutions.push({
      resolution_event_id: 99,
      condition_id: "0xcond",
      event_type: "resolved",
      payload_json: { outcomePrices: ["1", "0"] },
      received_at: at(0),
    });

    const outcome = await acceptOrder(world);

    expect(outcome).toMatchObject({
      status: "rejected",
      httpStatus: 409,
      reason: "MARKET_ALREADY_RESOLVED",
    });
    expect(world.orders).toHaveLength(0);
    const journalLock = world.queries.findIndex((query) =>
      query.startsWith("LOCK TABLE polymarket_resolution_input_changes"),
    );
    const settlementStart = world.queries.findIndex((query) =>
      query.startsWith(
        "SELECT p.token_id, p.condition_id FROM paper_positions p",
      ),
    );
    const terminalRead = world.queries.findIndex(
      (query, index) =>
        index > settlementStart &&
        query.includes("FROM polymarket_resolution_events"),
    );
    expect(journalLock).toBeGreaterThanOrEqual(0);
    expect(terminalRead).toBeGreaterThan(journalLock);
  });

  it("fails closed when the singleton kill row is missing", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.48", "0.52");
    world.killRowPresent = false;

    await expect(acceptOrder(world)).rejects.toThrow(
      "PAPER_KILL_SWITCH_STATE_MISSING",
    );
    expect(world.orders).toHaveLength(0);
  });
});

describe("taker execution (C1 + B5)", () => {
  it("executes against the book of accept + 250ms, not the decision book", async () => {
    const world = emptyWorld();
    seedMarket(world);
    // Decision-time book: cheap ask. Book at exec (accept+delay): worse ask.
    seedBook(world, -2_000, "0.40", "0.50");
    seedBook(world, 1_100, "0.40", "0.55");
    await acceptOrder(world, {
      orderType: "FAK",
      limitPrice: "0.60",
      worstPrice: "0.60",
      size: "20",
    });
    // accepted_at = T0+1000; exec at T0+1250; now = T0+2000.
    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });
    const fills = world.ledger.filter((e) => e["event_type"] === "fill");
    expect(fills).toHaveLength(1);
    const payload = fills[0]?.["payload_json"] as Row;
    expect(payload["price"]).toBe("0.550000");
    expect(payload["taker"]).toBe(true);
    // The fee comes from the versioned schedule (700 bps) at the exec price.
    expect(payload["fee_param_version_id"]).toBe(7);
    expect(payload["fee"]).toBe("0.346500");
    // The consumed slice rides inside the event for TTL-proof replay.
    expect(payload["book_slice"]).toEqual([
      { price: "0.550000", size: "20.000000" },
    ]);
    expect(world.orders[0]?.["status"]).toBe("filled");
    // Position cache refreshed from the ledger replay.
    expect(world.positions[0]?.["shares"]).toBe("20.000000");
  });

  it("cancels an accepted order when resolution wins the race to fill", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.40", "0.50");
    seedBook(world, 1_100, "0.40", "0.50");
    await acceptOrder(world, {
      orderType: "FAK",
      limitPrice: "0.60",
      worstPrice: "0.60",
      size: "20",
    });
    world.resolutions.push({
      resolution_event_id: 99,
      condition_id: "0xcond",
      event_type: "resolved",
      payload_json: { outcomePrices: ["1", "0"] },
      received_at: at(1_500),
    });

    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    expect(fillsForOrder(world)).toHaveLength(0);
    expect(world.orders[0]?.["status"]).toBe("canceled");
    const cancel = world.ledger.find(
      (event) =>
        event["order_id"] === "order-1" &&
        event["event_type"] === "cancel_effective",
    );
    expect((cancel?.["payload_json"] as Row)["reason"]).toBe(
      "MARKET_ALREADY_RESOLVED",
    );
  });

  it("cancel is BLOCKED during the taker delay", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.40", "0.50");
    await acceptOrder(world, {
      orderType: "FAK",
      limitPrice: "0.60",
      worstPrice: "0.60",
    });
    // now = T0+1100: inside [accepted_at, accepted_at + 250ms).
    const outcome = await requestCancel(worldPool(world), "order-1", {
      clock: () => at(1_100),
      logSink: silentSink,
    });
    expect(outcome).toMatchObject({
      status: "rejected",
      reason: "CANCEL_BLOCKED_TAKER_DELAY",
    });
  });

  it("FOK dies whole when the size cannot fill within worst", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.40", "0.50", "10");
    seedBook(world, 1_100, "0.40", "0.50", "10");
    await acceptOrder(world, {
      orderType: "FOK",
      limitPrice: "0.50",
      worstPrice: "0.50",
      size: "20",
    });
    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });
    expect(world.ledger.filter((e) => e["event_type"] === "fill")).toHaveLength(
      0,
    );
    expect(world.orders[0]?.["status"]).toBe("canceled");
  });
});

describe("RFC-012 policy revalidation at fill", () => {
  async function prepareTaker(
    world: World,
    source: "manual" | "intent" = "manual",
    resolutionOverride: Record<string, unknown> | null = null,
  ): Promise<void> {
    seedMarket(world);
    seedBook(world, -2_000, "0.40", "0.50");
    seedBook(world, 1_100, "0.40", "0.50");
    await acceptOrder(world, {
      source,
      resolutionOverride,
      orderType: "FAK",
      limitPrice: "0.60",
      worstPrice: "0.60",
      size: "20",
    });
  }

  const auditedOverride = {
    score: "0.750000",
    score_version: "1.0.0",
    action: "VETO",
    justification: "manual operator override for r_veto",
  };

  it.each(["manual", "intent"] as const)(
    "cancels a %s order when VETO appears after acceptance",
    async (source) => {
      const world = emptyWorld();
      await prepareTaker(world, source);
      world.resolutionActionReads = ["NONE", "VETO"];

      await brokerTick(worldPool(world), {
        clock: () => at(2_000),
        latencyMs: 1_000,
        logSink: silentSink,
      });

      expect(fillsForOrder(world)).toHaveLength(0);
      expect(world.orders[0]?.["status"]).toBe("canceled");
      expect(world.orders[0]?.["resolution_cancel_reason"]).toBe(
        "RESOLUTION_VETO",
      );
    },
  );

  it("cancels an intent when a sanity veto appears after acceptance", async () => {
    const world = emptyWorld();
    await prepareTaker(world, "intent");
    world.resolutionActionReads = ["NONE", "NONE"];
    world.sanityVetoReads = [false, true];

    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    expect(fillsForOrder(world)).toHaveLength(0);
    expect(world.orders[0]?.["resolution_cancel_reason"]).toBe(
      "SANITY_VETO_ACTIVE",
    );
  });

  it("does not increase exposure when a circuit breaker appears before fill", async () => {
    const world = emptyWorld();
    await prepareTaker(world);
    world.resolutionActionReads = ["NONE", "CIRCUIT_BREAKER"];

    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    expect(fillsForOrder(world)).toHaveLength(0);
    expect(world.orders[0]?.["resolution_cancel_reason"]).toBe(
      "RESOLUTION_CIRCUIT_BREAKER_EXPOSURE_INCREASE",
    );
  });

  it("cancels when the hard kill switch commits before its locked recheck", async () => {
    const world = emptyWorld();
    await prepareTaker(world);
    world.killEngagedAfterPolicyLock = true;

    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    expect(fillsForOrder(world)).toHaveLength(0);
    expect(world.orders[0]?.["status"]).toBe("canceled");
    expect(world.orders[0]?.["resolution_cancel_reason"]).toBe(
      "KILL_SWITCH_ENGAGED",
    );
  });

  it("allows manual VETO only with the immutable audited override object", async () => {
    const world = emptyWorld();
    await prepareTaker(world, "manual", auditedOverride);
    world.resolutionActionReads = ["VETO", "VETO", "VETO", "VETO"];

    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    expect(fillsForOrder(world)).toHaveLength(1);
    expect(world.orders[0]?.["status"]).toBe("filled");
    const accepted = world.ledger.find(
      (event) => event["event_type"] === "order_accepted",
    );
    expect((accepted?.["payload_json"] as Row)["override_veto"]).toEqual(
      auditedOverride,
    );
    const lockedOrderQuery = world.queries.find((query) =>
      query.includes("FOR UPDATE OF o"),
    );
    expect(lockedOrderQuery).toContain(
      "jsonb_typeof(accepted.payload_json->'override_veto') = 'object'",
    );
    expect(lockedOrderQuery).toContain(
      "accepted.payload_json->'override_veto'->>'action' = 'VETO'",
    );
    expect(lockedOrderQuery).toContain(
      "jsonb_typeof(accepted.payload_json->'override_veto'->'score') = 'string'",
    );
    expect(lockedOrderQuery).toContain(
      "btrim(accepted.payload_json->'override_veto'->>'justification') <> ''",
    );
  });

  it.each([
    { name: "null", override: null },
    { name: "boolean", override: true },
    { name: "empty object", override: {} },
    {
      name: "null score",
      override: { ...auditedOverride, score: null },
    },
    {
      name: "out-of-range score",
      override: { ...auditedOverride, score: "1.000001" },
    },
    {
      name: "blank score version",
      override: { ...auditedOverride, score_version: "" },
    },
    {
      name: "blank justification",
      override: { ...auditedOverride, justification: "   " },
    },
  ])("does not treat a $name override payload as audited", async (testCase) => {
    const world = emptyWorld();
    await prepareTaker(world, "manual", auditedOverride);
    const accepted = world.ledger.find(
      (event) => event["event_type"] === "order_accepted",
    );
    if (accepted === undefined) throw new Error("missing accepted event");
    (accepted["payload_json"] as Row)["override_veto"] = testCase.override;
    world.resolutionActionReads = ["VETO"];

    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    expect(fillsForOrder(world)).toHaveLength(0);
    expect(world.orders[0]?.["resolution_cancel_reason"]).toBe(
      "RESOLUTION_VETO",
    );
  });

  it.each(["state", "sanity"] as const)(
    "fails closed when the %s policy read fails immediately before fill",
    async (kind) => {
      const world = emptyWorld();
      await prepareTaker(world, kind === "sanity" ? "intent" : "manual");
      world.resolutionActionReads = ["NONE", "NONE"];
      if (kind === "state") {
        world.resolutionStateReadErrors = [
          null,
          new Error("state read unavailable"),
        ];
      } else {
        world.sanityVetoReadErrors = [
          null,
          new Error("sanity read unavailable"),
        ];
      }

      await brokerTick(worldPool(world), {
        clock: () => at(2_000),
        latencyMs: 1_000,
        logSink: silentSink,
      });

      expect(fillsForOrder(world)).toHaveLength(0);
      expect(world.orders[0]?.["resolution_cancel_reason"]).toBe(
        kind === "state"
          ? "RESOLUTION_STATE_UNAVAILABLE"
          : "RESOLUTION_SANITY_VETO_UNAVAILABLE",
      );
    },
  );

  it.each(["VETO", "sanity"] as const)(
    "rolls back a fill when %s appears during its append",
    async (kind) => {
      const world = emptyWorld();
      await prepareTaker(world, "intent");
      world.resolutionActionReads = ["NONE", "NONE"];
      world.sanityVetoReads = [false, false];
      if (kind === "VETO") {
        world.resolutionActionAfterNextFillAppend = "VETO";
      } else {
        world.sanityVetoAfterNextFillAppend = true;
      }

      await brokerTick(worldPool(world), {
        clock: () => at(2_000),
        latencyMs: 1_000,
        logSink: silentSink,
      });

      expect(fillsForOrder(world)).toHaveLength(0);
      expect(world.positions).toHaveLength(0);
      expect(world.orders[0]?.["status"]).toBe("canceled");
      expect(world.orders[0]?.["resolution_cancel_reason"]).toBe(
        kind === "VETO" ? "RESOLUTION_VETO" : "SANITY_VETO_ACTIVE",
      );
    },
  );

  it.each(["VETO", "sanity"] as const)(
    "rolls back a fill when %s appears after close and position refresh",
    async (kind) => {
      const world = emptyWorld();
      await prepareTaker(world, "intent");
      world.resolutionActionReads =
        kind === "VETO"
          ? ["NONE", "NONE", "NONE", "VETO"]
          : ["NONE", "NONE", "NONE", "NONE"];
      world.sanityVetoReads =
        kind === "sanity" ? [false, false, false, true] : [];

      await brokerTick(worldPool(world), {
        clock: () => at(2_000),
        latencyMs: 1_000,
        logSink: silentSink,
      });

      expect(fillsForOrder(world)).toHaveLength(0);
      expect(world.positions).toHaveLength(0);
      expect(world.orders[0]?.["status"]).toBe("canceled");
      expect(world.orders[0]?.["resolution_cancel_reason"]).toBe(
        kind === "VETO" ? "RESOLUTION_VETO" : "SANITY_VETO_ACTIVE",
      );
    },
  );

  it("locks journal, runtime and derived policy in deadlock-safe order", async () => {
    const world = emptyWorld();
    await prepareTaker(world);

    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    const journalSql =
      "LOCK TABLE polymarket_resolution_input_changes IN SHARE MODE";
    const journal = world.queries.findIndex((query) => query === journalSql);
    const runtime = world.queries.findIndex(
      (query, index) =>
        index > journal && query.startsWith("SELECT r.generation"),
    );
    const derived = world.queries.findIndex((query) =>
      query.startsWith("LOCK TABLE resolution_market_state"),
    );
    const kill = world.queries.findIndex(
      (query, index) =>
        index > derived &&
        query.includes("FROM paper_kill_switch") &&
        query.includes("FOR SHARE"),
    );
    const order = world.queries.findIndex(
      (query, index) => index > kill && query.includes("FOR UPDATE OF o"),
    );
    const token = world.queries.findIndex(
      (query, index) =>
        index > order && query.includes("pg_advisory_xact_lock"),
    );
    const policy = world.queries.findIndex(
      (query, index) =>
        index > token && query.includes("FROM resolution_market_state"),
    );
    const fill = world.queries.findLastIndex((query) =>
      query.startsWith("INSERT INTO paper_ledger_events"),
    );
    expect([
      journal,
      runtime,
      derived,
      kill,
      order,
      token,
      policy,
      fill,
    ]).toEqual(
      [...[journal, runtime, derived, kill, order, token, policy, fill]].sort(
        (a, b) => a - b,
      ),
    );
    expect(journal).toBeGreaterThanOrEqual(0);
    expect(
      world.queries.some((query) =>
        query.startsWith("LOCK TABLE polymarket_resolution_events"),
      ),
    ).toBe(false);
    expect(
      world.queries.some((query) =>
        query.startsWith("LOCK TABLE polymarket_rule_versions"),
      ),
    ).toBe(false);
  });
});

describe("RFC-012 circuit breaker over resting orders", () => {
  const directionCases = [
    {
      name: "SELL reduces a long",
      position: "20",
      side: "SELL" as const,
      size: "20",
      expectedStatus: "filled",
      expectedPosition: 0,
      expectedFills: 1,
    },
    {
      name: "BUY cannot increase a long",
      position: "20",
      side: "BUY" as const,
      size: "5",
      expectedStatus: "canceled",
      expectedPosition: 20,
      expectedFills: 0,
    },
    {
      name: "BUY reduces a short",
      position: "-20",
      side: "BUY" as const,
      size: "20",
      expectedStatus: "filled",
      expectedPosition: 0,
      expectedFills: 1,
    },
    {
      name: "SELL cannot increase a short",
      position: "-20",
      side: "SELL" as const,
      size: "5",
      expectedStatus: "canceled",
      expectedPosition: -20,
      expectedFills: 0,
    },
  ];

  it.each(directionCases)("$name under the breaker", async (testCase) => {
    const world = emptyWorld();
    seedMarket(world);
    seedSignedPosition(world, testCase.position);
    seedBook(world, -2_000, "0.40", "0.50");
    seedBook(world, 1_100, "0.40", "0.50");
    await acceptOrder(world, {
      side: testCase.side,
      orderType: "FAK",
      limitPrice: testCase.side === "BUY" ? "0.60" : "0.30",
      worstPrice: testCase.side === "BUY" ? "0.60" : "0.30",
      size: testCase.size,
    });
    world.breakers = ["0xcond"];

    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    expect(fillsForOrder(world)).toHaveLength(testCase.expectedFills);
    expect(world.orders[0]?.["status"]).toBe(testCase.expectedStatus);
    expect(Number(world.positions[0]?.["shares"])).toBe(
      testCase.expectedPosition,
    );
  });

  it.each(["BUY", "SELL"] as const)(
    "cancels %s from a flat position",
    async (side) => {
      const world = emptyWorld();
      seedMarket(world);
      seedBook(world, -2_000, "0.40", "0.50");
      seedBook(world, 1_100, "0.40", "0.50");
      await acceptOrder(world, {
        side,
        orderType: "FAK",
        limitPrice: side === "BUY" ? "0.60" : "0.30",
        worstPrice: side === "BUY" ? "0.60" : "0.30",
        size: "5",
      });
      world.breakers = ["0xcond"];

      await brokerTick(worldPool(world), {
        clock: () => at(2_000),
        latencyMs: 1_000,
        logSink: silentSink,
      });

      expect(fillsForOrder(world)).toHaveLength(0);
      expect(world.orders[0]?.["status"]).toBe("canceled");
    },
  );

  it.each([
    { position: "10", side: "SELL" as const },
    { position: "-10", side: "BUY" as const },
  ])(
    "$side clips position $position at zero and cancels the remainder",
    async ({ position, side }) => {
      const world = emptyWorld();
      seedMarket(world);
      seedSignedPosition(world, position);
      seedBook(world, -2_000, "0.40", "0.50");
      seedBook(world, 1_100, "0.40", "0.50");
      await acceptOrder(world, {
        side,
        orderType: "FAK",
        limitPrice: side === "BUY" ? "0.60" : "0.30",
        worstPrice: side === "BUY" ? "0.60" : "0.30",
        size: "20",
      });
      world.breakers = ["0xcond"];

      await brokerTick(worldPool(world), {
        clock: () => at(2_000),
        latencyMs: 1_000,
        logSink: silentSink,
      });

      const fills = fillsForOrder(world);
      expect(fills).toHaveLength(1);
      expect((fills[0]?.["payload_json"] as Row)["size"]).toBe("10.000000");
      expect(world.orders[0]?.["status"]).toBe("canceled");
      expect(Number(world.positions[0]?.["shares"])).toBe(0);
      const cancel = world.ledger.find(
        (event) =>
          event["order_id"] === "order-1" &&
          event["event_type"] === "cancel_effective",
      );
      expect((cancel?.["payload_json"] as Row)["reason"]).toBe(
        "RESOLUTION_CIRCUIT_BREAKER_CROSS_ZERO_REMAINDER",
      );
    },
  );

  it.each(["FOK", "GTC", "GTD"] as const)(
    "cancels a cross-zero %s without a partial fill",
    async (orderType) => {
      const world = emptyWorld();
      seedMarket(world);
      seedSignedPosition(world, "10");
      seedBook(world, -2_000, "0.40", "0.50");
      seedBook(world, 1_100, "0.40", "0.50");
      await acceptOrder(world, {
        side: "SELL",
        orderType,
        limitPrice: orderType === "FOK" ? "0.30" : "0.41",
        worstPrice: orderType === "FOK" ? "0.30" : null,
        size: "20",
        ttlS: orderType === "GTD" ? 120 : null,
      });
      world.breakers = ["0xcond"];

      await brokerTick(worldPool(world), {
        clock: () => at(2_000),
        latencyMs: 1_000,
        logSink: silentSink,
      });

      expect(fillsForOrder(world)).toHaveLength(0);
      expect(world.orders[0]?.["status"]).toBe("canceled");
      expect(Number(world.positions[0]?.["shares"])).toBe(10);
    },
  );

  it("does not let two reducing orders consume the same exposure", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedSignedPosition(world, "10");
    seedBook(world, -2_000, "0.40", "0.50");
    seedBook(world, 1_100, "0.40", "0.50");
    for (const orderId of ["order-1", "order-2"]) {
      await acceptOrder(world, {
        orderId,
        side: "SELL",
        orderType: "FAK",
        limitPrice: "0.30",
        worstPrice: "0.30",
        size: "6",
      });
    }
    world.breakers = ["0xcond"];

    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    const fills = world.ledger.filter(
      (event) => event["event_type"] === "fill" && event["order_id"] !== "seed",
    );
    expect(
      fills.map((event) => (event["payload_json"] as Row)["size"]),
    ).toEqual(["6.000000", "4.000000"]);
    expect(Number(world.positions[0]?.["shares"])).toBe(0);
    expect(world.orders.map((order) => order["status"])).toEqual([
      "filled",
      "canceled",
    ]);
  });

  it("fails closed when the authoritative resolution state cannot be read", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.40", "0.50");
    seedBook(world, 1_100, "0.40", "0.50");
    await acceptOrder(world, {
      orderType: "FAK",
      limitPrice: "0.60",
      worstPrice: "0.60",
      size: "20",
    });
    world.resolutionStateError = new Error("database unavailable");
    const logs: string[] = [];

    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: (line) => logs.push(line),
    });

    expect(fillsForOrder(world)).toHaveLength(0);
    expect(world.orders[0]?.["status"]).toBe("canceled");
    expect(logs.join("\n")).toContain("RESOLUTION_STATE_READ_FAILED");
    const cancel = world.ledger.find(
      (event) =>
        event["order_id"] === "order-1" &&
        event["event_type"] === "cancel_effective",
    );
    expect((cancel?.["payload_json"] as Row)["reason"]).toBe(
      "RESOLUTION_STATE_UNAVAILABLE",
    );
  });

  it.each([
    {
      mode: "missing" as const,
      reason: "RESOLUTION_MARKET_STATE_MISSING",
    },
    {
      mode: "invalid" as const,
      reason: "RESOLUTION_MARKET_STATE_INVALID",
    },
  ])("fails closed when the market state is $mode", async (testCase) => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.40", "0.50");
    seedBook(world, 1_100, "0.40", "0.50");
    await acceptOrder(world, {
      orderType: "FAK",
      limitPrice: "0.60",
      worstPrice: "0.60",
      size: "20",
    });
    world.resolutionMarketStateMode = testCase.mode;

    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    expect(fillsForOrder(world)).toHaveLength(0);
    expect(world.orders[0]?.["status"]).toBe("canceled");
    expect(world.orders[0]?.["resolution_cancel_reason"]).toBe(testCase.reason);
  });

  it("fails closed when the canonical ledger position cannot be read", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedSignedPosition(world, "10");
    seedBook(world, -2_000, "0.40", "0.50");
    seedBook(world, 1_100, "0.40", "0.50");
    await acceptOrder(world, {
      side: "SELL",
      orderType: "FAK",
      limitPrice: "0.30",
      worstPrice: "0.30",
      size: "5",
    });
    world.breakers = ["0xcond"];
    world.ledgerReadError = new Error("ledger unavailable");
    const logs: string[] = [];

    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: (line) => logs.push(line),
    });

    expect(fillsForOrder(world)).toHaveLength(0);
    expect(world.orders[0]?.["status"]).toBe("canceled");
    expect(logs.join("\n")).toContain(
      "PAPER_POSITION_READ_FAILED_CIRCUIT_BREAKER",
    );
    const cancel = world.ledger.find(
      (event) =>
        event["order_id"] === "order-1" &&
        event["event_type"] === "cancel_effective",
    );
    expect((cancel?.["payload_json"] as Row)["reason"]).toBe(
      "RESOLUTION_POSITION_UNAVAILABLE",
    );
  });

  it.each([
    {
      name: "missing",
      mutate(world: World): void {
        world.runtime = null;
      },
      reason: "RESOLUTION_RUNTIME_MISSING",
    },
    {
      name: "not ready",
      mutate(world: World): void {
        if (world.runtime !== null) world.runtime.ready = false;
      },
      reason: "RESOLUTION_RUNTIME_NOT_READY",
    },
    {
      name: "stale",
      mutate(world: World): void {
        if (world.runtime !== null) world.runtime.lease_expires_at = at(-1);
      },
      reason: "RESOLUTION_RUNTIME_STALE",
    },
    {
      name: "missing graph freshness",
      mutate(world: World): void {
        if (world.runtime !== null) world.runtime.graph_evaluated_at = null;
      },
      reason: "RESOLUTION_GRAPH_NOT_READY",
    },
    {
      name: "expired graph freshness",
      mutate(world: World): void {
        if (world.runtime !== null) world.runtime.graph_valid_until = at(0);
      },
      reason: "RESOLUTION_GRAPH_STALE",
    },
    {
      name: "behind the event head",
      mutate(world: World): void {
        if (world.runtime !== null) world.runtime.event_head = 1;
      },
      reason: "RESOLUTION_RUNTIME_LAGGING",
    },
    {
      name: "behind the input journal",
      mutate(world: World): void {
        if (world.runtime !== null) world.runtime.input_head = 1;
      },
      reason: "RESOLUTION_RUNTIME_LAGGING",
    },
  ])("cancels without a fill when the runtime is $name", async (testCase) => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.40", "0.50");
    seedBook(world, 1_100, "0.40", "0.50");
    await acceptOrder(world, {
      orderType: "FAK",
      limitPrice: "0.60",
      worstPrice: "0.60",
      size: "20",
    });
    testCase.mutate(world);

    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    expect(fillsForOrder(world)).toHaveLength(0);
    expect(world.orders[0]?.["status"]).toBe("canceled");
    const cancel = world.ledger.find(
      (event) =>
        event["order_id"] === "order-1" &&
        event["event_type"] === "cancel_effective",
    );
    expect((cancel?.["payload_json"] as Row)["reason"]).toBe(testCase.reason);
  });

  it("holds an open order through a transient runtime lag instead of canceling it", async () => {
    // The 2026-08-28 production defect: the journals move all day (49-286
    // input changes per hour) and the runtime catches up on its ~1-minute
    // cycle, so "processed < head" is routinely true for a moment. That moment
    // canceled 7 of the 9 paper orders ever canceled (lags of 1-17 input ids,
    // lifetimes 14 s - 9 min) and throttled throughput to ~1 fill/day. A lag
    // whose oldest unprocessed entry is seconds old is the journal advancing,
    // not the runtime failing — the order must survive it.
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.40", "0.50");
    seedBook(world, 1_100, "0.40", "0.50");
    await acceptOrder(world, {
      orderType: "FAK",
      limitPrice: "0.60",
      worstPrice: "0.60",
      size: "20",
    });
    if (world.runtime !== null) {
      world.runtime.input_head = world.runtime.processed_input_change_id + 1;
    }
    // The unprocessed entry arrived 5 s before this tick: transient.
    world.oldestUnprocessedAt = at(-3_000);
    const logs: string[] = [];

    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: (line) => logs.push(line),
    });

    expect(world.orders[0]?.["status"]).toBe("open");
    // No fill either: the fill gate still requires the runtime caught up.
    expect(fillsForOrder(world)).toHaveLength(0);
    // The claim was released so the next tick re-examines the order.
    expect(world.orders[0]?.["resolution_risk_check_pending"]).toBe(false);
    expect(logs.join("\n")).toContain("PAPER_ORDER_RUNTIME_LAG_GRACE");
  });

  it("still cancels when the lag persists past the grace window", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.40", "0.50");
    seedBook(world, 1_100, "0.40", "0.50");
    await acceptOrder(world, {
      orderType: "FAK",
      limitPrice: "0.60",
      worstPrice: "0.60",
      size: "20",
    });
    if (world.runtime !== null) {
      world.runtime.input_head = world.runtime.processed_input_change_id + 1;
    }
    // The unprocessed entry has been waiting far beyond three runtime cycles
    // (the 180 s RESOLUTION_LAG_CANCEL_GRACE_MS): the runtime is wedged, not
    // catching up. Written as a literal so this file also runs against the
    // pre-grace revision, where the constant does not exist.
    world.oldestUnprocessedAt = at(2_000 - 180_000 - 1);

    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    expect(fillsForOrder(world)).toHaveLength(0);
    expect(world.orders[0]?.["status"]).toBe("canceled");
    expect(world.orders[0]?.["resolution_cancel_reason"]).toBe(
      "RESOLUTION_RUNTIME_LAGGING",
    );
  });

  it("never fills while the runtime is behind, grace or no grace", async () => {
    // The unchanged invariant, asserted on its own: whatever the cancel policy
    // does with a lagging runtime, a fill against one is refused. This test
    // passes before and after the grace change — the grace loosened only the
    // CANCEL, never the fill gate.
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.40", "0.50");
    seedBook(world, 1_100, "0.40", "0.50");
    await acceptOrder(world, {
      orderType: "FAK",
      limitPrice: "0.60",
      worstPrice: "0.60",
      size: "20",
    });
    if (world.runtime !== null) {
      world.runtime.input_head = world.runtime.processed_input_change_id + 1;
    }
    world.oldestUnprocessedAt = at(1_500);

    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    expect(fillsForOrder(world)).toHaveLength(0);
  });

  it("cancels an order accepted by a previous runtime generation", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.40", "0.50");
    seedBook(world, 1_100, "0.40", "0.50");
    await acceptOrder(world, {
      orderType: "FAK",
      limitPrice: "0.60",
      worstPrice: "0.60",
      size: "20",
    });
    if (world.runtime !== null) {
      world.runtime.generation = "22222222-2222-4222-8222-222222222222";
    }

    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    expect(fillsForOrder(world)).toHaveLength(0);
    expect(world.orders[0]?.["status"]).toBe("canceled");
    expect(world.orders[0]?.["resolution_cancel_reason"]).toBe(
      "RESOLUTION_RUNTIME_GENERATION_MISMATCH",
    );
  });

  it("cancels when the runtime lease expires immediately before a fill", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.40", "0.50");
    seedBook(world, 1_100, "0.40", "0.50");
    if (world.runtime !== null) {
      world.runtime.lease_expires_at = at(2_500);
    }
    await acceptOrder(world, {
      orderType: "FAK",
      limitPrice: "0.60",
      worstPrice: "0.60",
      size: "20",
    });
    world.runtimeCheckedAt = [at(1_500), at(3_000)];

    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    expect(fillsForOrder(world)).toHaveLength(0);
    expect(world.orders[0]?.["status"]).toBe("canceled");
    expect(world.orders[0]?.["resolution_cancel_reason"]).toBe(
      "RESOLUTION_RUNTIME_STALE",
    );
  });

  it("rolls back a taker fill when the lease expires during its append", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.40", "0.50");
    seedBook(world, 1_100, "0.40", "0.50");
    if (world.runtime !== null) {
      world.runtime.lease_expires_at = at(2_500);
    }
    await acceptOrder(world, {
      orderType: "FAK",
      limitPrice: "0.60",
      worstPrice: "0.60",
      size: "20",
    });
    world.databaseNow = at(2_000);
    world.databaseTimeAfterNextFillAppend = at(2_500);

    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    expect(fillsForOrder(world)).toHaveLength(0);
    expect(world.orders[0]?.["status"]).toBe("canceled");
    expect(world.orders[0]?.["resolution_cancel_reason"]).toBe(
      "RESOLUTION_RUNTIME_STALE",
    );
  });

  it("rolls back a taker fill when graph freshness expires during its append", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.40", "0.50");
    seedBook(world, 1_100, "0.40", "0.50");
    if (world.runtime !== null) {
      world.runtime.graph_valid_until = at(2_500);
    }
    await acceptOrder(world, {
      orderType: "FAK",
      limitPrice: "0.60",
      worstPrice: "0.60",
      size: "20",
    });
    world.databaseNow = at(2_000);
    world.databaseTimeAfterNextFillAppend = at(2_500);

    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    expect(fillsForOrder(world)).toHaveLength(0);
    expect(world.orders[0]?.["status"]).toBe("canceled");
    expect(world.orders[0]?.["resolution_cancel_reason"]).toBe(
      "RESOLUTION_GRAPH_STALE",
    );
  });

  it("keeps a failed risk check quarantined across recovery in the same generation", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.40", "0.50");
    seedBook(world, 1_100, "0.40", "0.50");
    await acceptOrder(world, {
      orderType: "FAK",
      limitPrice: "0.60",
      worstPrice: "0.60",
      size: "20",
    });
    world.resolutionStateError = new Error("runtime read unavailable");
    world.cancelEventFailures = 1;
    const pool = worldPool(world);

    await brokerTick(pool, {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });
    expect(world.orders[0]?.["status"]).toBe("open");
    expect(world.orders[0]?.["resolution_risk_check_pending"]).toBe(true);
    expect(fillsForOrder(world)).toHaveLength(0);

    // The runtime recovers without rotating generation. The old claim is
    // still cancel-only; it must not get a second chance to fill.
    world.resolutionStateError = null;
    await brokerTick(pool, {
      clock: () => at(8_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    expect(fillsForOrder(world)).toHaveLength(0);
    expect(world.orders[0]?.["status"]).toBe("canceled");
    expect(world.orders[0]?.["resolution_cancel_reason"]).toBe(
      "RESOLUTION_RISK_CHECK_INCOMPLETE",
    );
  });

  it("rolls back fill, remainder cancel, close and cache when refresh fails", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedSignedPosition(world, "10");
    seedBook(world, -2_000, "0.40", "0.50");
    seedBook(world, 1_100, "0.40", "0.50");
    await acceptOrder(world, {
      side: "SELL",
      orderType: "FAK",
      limitPrice: "0.30",
      worstPrice: "0.30",
      size: "20",
    });
    world.breakers = ["0xcond"];
    world.positionRefreshFailures = 1;

    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    expect(fillsForOrder(world)).toHaveLength(0);
    expect(Number(world.positions[0]?.["shares"])).toBe(10);
    expect(world.orders[0]?.["status"]).toBe("canceled");
  });

  it("serializes concurrent ticks so two orders cannot cross zero", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedSignedPosition(world, "10");
    seedBook(world, -2_000, "0.40", "0.50");
    seedBook(world, 1_100, "0.40", "0.50");
    for (const orderId of ["order-1", "order-2"]) {
      await acceptOrder(world, {
        orderId,
        side: "SELL",
        orderType: "FAK",
        limitPrice: "0.30",
        worstPrice: "0.30",
        size: "6",
      });
    }
    world.breakers = ["0xcond"];
    const pool = worldPool(world);

    await Promise.all([
      brokerTick(pool, {
        clock: () => at(2_000),
        latencyMs: 1_000,
        logSink: silentSink,
      }),
      brokerTick(pool, {
        clock: () => at(2_000),
        latencyMs: 1_000,
        logSink: silentSink,
      }),
    ]);

    expect(Number(world.positions[0]?.["shares"])).toBe(0);
    const filled = world.ledger
      .filter(
        (event) =>
          event["event_type"] === "fill" && event["order_id"] !== "seed",
      )
      .reduce(
        (sum, event) => sum + Number((event["payload_json"] as Row)["size"]),
        0,
      );
    expect(filled).toBe(10);
  });
});

describe("conservative passive queue (C2 + C3)", () => {
  it("joins behind all visible depth and fills only beyond the queue", async () => {
    const world = emptyWorld();
    seedMarket(world);
    // 100 resting at our level: the queue ahead.
    seedBook(world, -2_000, "0.48", "0.52", "100");
    seedBook(world, 900, "0.48", "0.52", "100");
    await acceptOrder(world, { size: "20" });
    // 60 traded: still behind the queue.
    world.trades.push({
      trade_id: 10,
      token_id: "tok-yes",
      price: "0.48",
      size: "60",
      ts: at(2_000),
    });
    await brokerTick(worldPool(world), {
      clock: () => at(3_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });
    expect(world.ledger.filter((e) => e["event_type"] === "fill")).toHaveLength(
      0,
    );
    // 70 more traded: 130 total, 30 beyond the queue -> at most 20 for us.
    world.trades.push({
      trade_id: 2,
      token_id: "tok-yes",
      price: "0.48",
      size: "70",
      ts: at(4_000),
    });
    await brokerTick(worldPool(world), {
      clock: () => at(5_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });
    const events = world.ledger.filter(
      (e) =>
        e["event_type"] === "fill" ||
        e["event_type"] === "fill_denied_degradation",
    );
    expect(events).toHaveLength(1);
    const payload = events[0]?.["payload_json"] as Row;
    expect(payload["size"]).toBe("20.000000");
    // Maker pays zero fee when the fill lands (denials carry no fee at all).
    if (events[0]?.["event_type"] === "fill") {
      expect(payload["fee"]).toBe("0.000000");
      expect(world.orders[0]?.["status"]).toBe("filled");
    } else {
      expect(world.orders[0]?.["status"]).toBe("open");
    }
  });

  it("a trade between cancel_requested and cancel_effective still fills", async () => {
    const world = emptyWorld();
    seedMarket(world);
    // Empty level: queue ahead is zero.
    seedBook(world, -2_000, "0.47", "0.52", "0");
    seedBook(world, 900, "0.47", "0.52", "0");
    await acceptOrder(world, { limitPrice: "0.48", size: "20" });
    // Cancel requested at T0+2000; latency 1000 -> effective T0+3000.
    await requestCancel(worldPool(world), "order-1", {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });
    // Adverse trade inside the window still hits us.
    world.trades.push({
      trade_id: 1,
      token_id: "tok-yes",
      price: "0.48",
      size: "10",
      ts: at(2_500),
    });
    await brokerTick(worldPool(world), {
      clock: () => at(4_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });
    const fills = world.ledger.filter(
      (e) =>
        e["event_type"] === "fill" ||
        e["event_type"] === "fill_denied_degradation",
    );
    expect(fills).toHaveLength(1);
    expect(
      world.ledger.filter((e) => e["event_type"] === "cancel_effective"),
    ).toHaveLength(1);
    expect(world.orders[0]?.["status"]).toBe("canceled");
  });

  it("rolls back a passive fill when the lease expires during its append", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.47", "0.52", "0");
    seedBook(world, 900, "0.47", "0.52", "0");
    if (world.runtime !== null) {
      world.runtime.lease_expires_at = at(3_500);
    }
    await acceptOrder(world, { limitPrice: "0.48", size: "5" });
    world.trades.push({
      trade_id: 10,
      token_id: "tok-yes",
      price: "0.48",
      size: "10",
      ts: at(2_000),
    });
    world.databaseNow = at(3_000);
    world.databaseTimeAfterNextFillAppend = at(3_500);

    await brokerTick(worldPool(world), {
      clock: () => at(3_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    expect(fillsForOrder(world)).toHaveLength(0);
    expect(world.orders[0]?.["status"]).toBe("canceled");
    expect(world.orders[0]?.["resolution_cancel_reason"]).toBe(
      "RESOLUTION_RUNTIME_STALE",
    );
  });

  it("fails closed when the sanity policy read fails before a passive fill", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.47", "0.52", "0");
    seedBook(world, 900, "0.47", "0.52", "0");
    await acceptOrder(world, {
      source: "intent",
      limitPrice: "0.48",
      size: "5",
    });
    world.trades.push({
      trade_id: 10,
      token_id: "tok-yes",
      price: "0.48",
      size: "10",
      ts: at(2_000),
    });
    world.resolutionActionReads = ["NONE", "NONE"];
    world.sanityVetoReadErrors = [null, new Error("sanity policy unavailable")];

    await brokerTick(worldPool(world), {
      clock: () => at(3_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    expect(fillsForOrder(world)).toHaveLength(0);
    expect(world.orders[0]?.["status"]).toBe("canceled");
    expect(world.orders[0]?.["resolution_cancel_reason"]).toBe(
      "RESOLUTION_SANITY_VETO_UNAVAILABLE",
    );
  });

  it("re-running the tick over the same data adds nothing (idempotent)", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.47", "0.52", "0");
    seedBook(world, 900, "0.47", "0.52", "0");
    await acceptOrder(world, { limitPrice: "0.48", size: "5" });
    world.trades.push({
      trade_id: 1,
      token_id: "tok-yes",
      price: "0.48",
      size: "10",
      ts: at(2_000),
    });
    const deps = {
      clock: () => at(3_000),
      latencyMs: 1_000,
      logSink: silentSink,
    };
    await brokerTick(worldPool(world), deps);
    const after = world.ledger.length;
    await brokerTick(worldPool(world), deps);
    await brokerTick(worldPool(world), deps);
    expect(world.ledger.length).toBe(after);
  });

  it("rechecks only the new passive fill after a partial fill", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedSignedPosition(world, "10");
    seedBook(world, -2_000, "0.48", "0.52", "0");
    seedBook(world, 900, "0.48", "0.52", "0");
    await acceptOrder(world, {
      side: "SELL",
      limitPrice: "0.52",
      size: "10",
    });
    world.trades.push({
      trade_id: 10,
      token_id: "tok-yes",
      price: "0.52",
      size: "6",
      ts: at(2_000),
    });

    await brokerTick(worldPool(world), {
      clock: () => at(3_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });
    expect(world.orders[0]?.["filled_size"]).toBe("6.000000");
    expect(Number(world.positions[0]?.["shares"])).toBe(4);

    world.breakers = ["0xcond"];
    world.trades.push({
      trade_id: 11,
      token_id: "tok-yes",
      price: "0.52",
      size: "4",
      ts: at(4_000),
    });
    await brokerTick(worldPool(world), {
      clock: () => at(5_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });

    expect(fillsForOrder(world)).toHaveLength(2);
    expect(world.orders[0]?.["status"]).toBe("filled");
    expect(Number(world.positions[0]?.["shares"])).toBe(0);
  });

  it("GTD expires one minute before the declared expiration", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.47", "0.52", "0");
    seedBook(world, 900, "0.47", "0.52", "0");
    // ttl 120s: declared = T0 + 60 + 120 = T0+180s; venue expiry T0+120s.
    await acceptOrder(world, {
      orderType: "GTD",
      limitPrice: "0.48",
      ttlS: 120,
    });
    await brokerTick(worldPool(world), {
      clock: () => at(121_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });
    expect(world.orders[0]?.["status"]).toBe("expired");
    expect(
      world.ledger.filter((e) => e["event_type"] === "expired"),
    ).toHaveLength(1);
  });
});

describe("settlement (C5)", () => {
  function seedPosition(world: World, shares: string, cost: string): void {
    world.positions.push({
      token_id: "tok-yes",
      condition_id: "0xcond",
      shares,
      cost_usd: cost,
      realized_pnl_usd: "0",
      fees_paid_usd: "0",
      opened_at: at(-3_600_000),
      resolved_at: null,
      lockup_s: null,
      mark_value_usd: null,
      mark_stale: null,
    });
    // The replay needs the fill that built the position.
    world.ledger.push({
      idempotency_key: "seed:fill",
      event_type: "fill",
      order_id: "seed",
      token_id: "tok-yes",
      condition_id: "0xcond",
      payload_json: { side: "BUY", price: "0.50", size: shares, fee: "0" },
      event_ts: at(-3_600_000),
    });
  }

  it("settles YES at 1.00 through the ledger and records the lockup", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.48", "0.52");
    await acceptOrder(world);
    seedPosition(world, "10", "5");
    world.resolutions.push({
      resolution_event_id: 99,
      condition_id: "0xcond",
      event_type: "resolved",
      payload_json: { outcomePrices: ["1", "0"] },
      received_at: at(0),
    });
    await settlementTick(worldPool(world), {
      clock: () => at(0),
      logSink: silentSink,
    });
    const resolution = world.ledger.find(
      (e) => e["event_type"] === "resolution",
    );
    expect((resolution?.["payload_json"] as Row)["outcome_price"]).toBe(
      "1.000000",
    );
    expect(world.positions[0]?.["shares"]).toBe("0.000000");
    expect(world.positions[0]?.["realized_pnl_usd"]).toBe("5.000000");
    expect(world.positions[0]?.["lockup_s"]).toBe(3_600);
    expect(world.orders[0]?.["status"]).toBe("canceled");
    const terminalRead = world.queries.findIndex((query) =>
      query.includes("FROM polymarket_resolution_events"),
    );
    const orderLock = world.queries.findIndex(
      (query, index) =>
        index > terminalRead &&
        query.includes("ORDER BY order_id") &&
        query.includes("FOR UPDATE"),
    );
    const advisory = world.queries.findIndex((query) =>
      query.includes("pg_advisory_xact_lock"),
    );
    const ledgerRead = world.queries.findIndex(
      (query, index) =>
        index > advisory &&
        query.includes("FROM paper_ledger_events WHERE token_id = $1"),
    );
    const resolutionAppend = world.queries.findIndex(
      (query, index) =>
        index > ledgerRead &&
        query.startsWith("INSERT INTO paper_ledger_events"),
    );
    const refresh = world.queries.findIndex(
      (query, index) =>
        index > resolutionAppend &&
        query.startsWith("INSERT INTO paper_positions"),
    );
    expect([
      terminalRead,
      orderLock,
      advisory,
      ledgerRead,
      resolutionAppend,
      refresh,
    ]).toEqual(
      [
        terminalRead,
        orderLock,
        advisory,
        ledgerRead,
        resolutionAppend,
        refresh,
      ].sort((a, b) => a - b),
    );
  });

  it("rolls back the resolution event when the position refresh fails", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedPosition(world, "10", "5");
    world.resolutions.push({
      resolution_event_id: 99,
      condition_id: "0xcond",
      event_type: "resolved",
      payload_json: { outcomePrices: ["1", "0"] },
      received_at: at(0),
    });
    world.positionRefreshFailures = 1;

    await settlementTick(worldPool(world), {
      clock: () => at(0),
      logSink: silentSink,
    });

    expect(
      world.ledger.filter((event) => event["event_type"] === "resolution"),
    ).toHaveLength(0);
    expect(world.positions[0]?.["shares"]).toBe("10");
    expect(world.positions[0]?.["realized_pnl_usd"]).toBe("0");
  });

  it("a 50/50 outcome in a negRisk market freezes the market, never settles", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.48", "0.52");
    await acceptOrder(world);
    const market = world.markets[0];
    if (market !== undefined) {
      market.neg_risk = true;
    }
    seedPosition(world, "10", "5");
    world.resolutions.push({
      resolution_event_id: 99,
      condition_id: "0xcond",
      event_type: "resolved",
      payload_json: { outcomePrices: ["0.5", "0.5"] },
      received_at: at(0),
    });
    await settlementTick(worldPool(world), {
      clock: () => at(0),
      logSink: silentSink,
    });
    expect(
      world.ledger.filter((e) => e["event_type"] === "resolution"),
    ).toHaveLength(0);
    expect(world.kill["frozen_markets_json"]).toContain("0xcond");
    expect(world.positions[0]?.["shares"]).toBe("10");
    expect(world.orders[0]?.["status"]).toBe("canceled");
  });

  // Every settlement test above hands settlement a FLAT `outcomePrices`, and
  // production never writes that shape: the UMA status poller nests it under
  // `raw` (samplers.ts). 1.017 of 1.017 resolved markets carried
  // `payload_json.raw.outcomePrices`, settlement read `payload_json
  // .outcomePrices`, found nothing, and answered TOKEN_NOT_IN_MARKET 60x/h
  // for as long as the book existed. `closed_positions` was 0 by defect, not
  // by clock.
  it("settles from the nested payload the collector actually writes", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.48", "0.52");
    await acceptOrder(world);
    seedPosition(world, "10", "5");
    world.resolutions.push({
      resolution_event_id: 99,
      condition_id: "0xcond",
      event_type: "resolved",
      // The production shape: nested, and NO flat key to fall back on.
      payload_json: { raw: { outcomePrices: ["0", "1"] } },
      received_at: at(0),
    });

    await settlementTick(worldPool(world), {
      clock: () => at(0),
      logSink: silentSink,
    });

    // Before the fix: zero resolution events and a frozen market.
    const resolution = world.ledger.find(
      (e) => e["event_type"] === "resolution",
    );
    expect((resolution?.["payload_json"] as Row)["outcome_price"]).toBe(
      "0.000000",
    );
    // tok-yes is index 0, and index 0 resolved at 0: the whole cost is lost.
    expect(world.positions[0]?.["shares"]).toBe("0.000000");
    expect(world.positions[0]?.["realized_pnl_usd"]).toBe("-5.000000");
    expect(world.kill["frozen_markets_json"]).not.toContain("0xcond");
  });

  it("still reads the flat payload the WS market_resolved event delivers", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedPosition(world, "10", "5");
    world.resolutions.push({
      resolution_event_id: 99,
      condition_id: "0xcond",
      event_type: "resolved",
      payload_json: { outcomePrices: ["1", "0"] },
      received_at: at(0),
    });

    await settlementTick(worldPool(world), {
      clock: () => at(0),
      logSink: silentSink,
    });

    const resolution = world.ledger.find(
      (e) => e["event_type"] === "resolution",
    );
    expect((resolution?.["payload_json"] as Row)["outcome_price"]).toBe(
      "1.000000",
    );
  });

  it("a payload with no prices anywhere freezes with the new reason code", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedPosition(world, "10", "5");
    const lines: string[] = [];
    world.resolutions.push({
      resolution_event_id: 99,
      condition_id: "0xcond",
      event_type: "resolved",
      payload_json: { raw: { closed: true } },
      received_at: at(0),
    });

    await settlementTick(worldPool(world), {
      clock: () => at(0),
      logSink: (line) => lines.push(line),
    });

    const error = lines
      .map((line) => JSON.parse(line) as Row)
      .find((line) => line["reason_code"] === "PAPER_RESOLUTION_DATA_ERROR");
    // The token IS in the market; only the price is missing. Saying
    // TOKEN_NOT_IN_MARKET here is what hid the defect for as long as it did.
    expect(error?.["reason"]).toBe("RESOLUTION_PRICES_MISSING");
    expect(
      world.ledger.filter((e) => e["event_type"] === "resolution"),
    ).toHaveLength(0);
    expect(world.kill["frozen_markets_json"]).toContain("0xcond");
  });
});

describe("mark to executable bid (D2)", () => {
  it("marks with a full-size walk and freezes under a stale book", async () => {
    const world = emptyWorld();
    seedMarket(world);
    world.positions.push({
      token_id: "tok-yes",
      condition_id: "0xcond",
      shares: "100",
      cost_usd: "48",
      realized_pnl_usd: "0",
      fees_paid_usd: "0",
      opened_at: at(-3_600_000),
      resolved_at: null,
      lockup_s: null,
      mark_value_usd: null,
      mark_stale: null,
    });
    world.snapshots.push({
      token_id: "tok-yes",
      received_at: at(-1_000),
      source_ts: at(-1_500),
      bids_json: [
        { price: "0.50", size: "60" },
        { price: "0.45", size: "40" },
      ],
      asks_json: [{ price: "0.55", size: "100" }],
    });
    await markTick(worldPool(world), {
      clock: () => at(0),
      logSink: silentSink,
    });
    // 60 x 0.50 + 40 x 0.45 = 48: the whole size, never the touch.
    expect(world.positions[0]?.["mark_value_usd"]).toBe("48.000000");
    expect(world.positions[0]?.["mark_stale"]).toBe(false);

    // One hour later with no fresh book: STALE_MARK, value frozen.
    await markTick(worldPool(world), {
      clock: () => at(3_600_000),
      logSink: silentSink,
    });
    expect(world.positions[0]?.["mark_stale"]).toBe(true);
    expect(world.positions[0]?.["mark_value_usd"]).toBe("48.000000");
  });
});

describe("kill switch (D4)", () => {
  it("rolls back engage, its audit and cancellations as one transaction", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.48", "0.52");
    await acceptOrder(world);
    world.cancelEventFailures = 1;

    await expect(
      engageKillSwitch(worldPool(world), "MANUAL", at(1_000), {
        logSink: silentSink,
      }),
    ).rejects.toThrow("cancel audit unavailable");

    expect(world.kill["engaged"]).toBe(false);
    expect(world.orders[0]?.["status"]).toBe("open");
    expect(
      world.ledger.filter(
        (event) => event["event_type"] === "kill_switch_engaged",
      ),
    ).toHaveLength(0);
  });

  it("engaging cancels every open order and blocks new ones until rearm", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.48", "0.52");
    await acceptOrder(world);
    await engageKillSwitch(worldPool(world), "MANUAL", at(1_000), {
      logSink: silentSink,
    });
    expect(world.orders[0]?.["status"]).toBe("canceled");
    const blocked = await acceptOrder(world, { orderId: "order-2" });
    expect(blocked).toMatchObject({
      status: "rejected",
      reason: "KILL_SWITCH_ENGAGED",
    });
    const state = await loadKillSwitch(worldPool(world));
    expect(state.engaged).toBe(true);
  });

  it("global recorder staleness engages the switch", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -10 * 60_000, "0.48", "0.52");
    await killSwitchTriggersTick(worldPool(world), {
      clock: () => at(0),
      logSink: silentSink,
    });
    expect(world.kill["engaged"]).toBe(true);
    expect(world.kill["reason"]).toBe("RECORDER_STALE");
  });

  it("a daily loss beyond the limit engages the switch", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -1_000, "0.48", "0.52");
    world.positions.push({
      token_id: "tok-yes",
      condition_id: "0xcond",
      shares: "0",
      cost_usd: "0",
      realized_pnl_usd: "0",
      fees_paid_usd: "0",
      mark_value_usd: null,
      mark_stale: null,
      opened_at: null,
      resolved_at: null,
      lockup_s: null,
    });
    const deps = {
      clock: () => at(0),
      logSink: silentSink,
      dailyLossLimitUsd: "50",
    };
    // First tick anchors the day at equity 0.
    await killSwitchTriggersTick(worldPool(world), deps);
    expect(world.kill["engaged"]).toBe(false);
    // The day turns against us beyond the limit.
    const position = world.positions[0];
    if (position !== undefined) {
      position["realized_pnl_usd"] = "-80";
    }
    await killSwitchTriggersTick(worldPool(world), deps);
    expect(world.kill["engaged"]).toBe(true);
    expect(world.kill["reason"]).toBe("DAILY_LOSS_LIMIT");
  });

  it("a UMA dispute on a held market freezes that market only", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -1_000, "0.48", "0.52");
    world.positions.push({
      token_id: "tok-yes",
      condition_id: "0xcond",
      shares: "10",
      cost_usd: "5",
      realized_pnl_usd: "0",
      fees_paid_usd: "0",
      mark_value_usd: "5",
      mark_stale: false,
      opened_at: at(-1_000),
      resolved_at: null,
      lockup_s: null,
    });
    world.resolutions.push({
      resolution_event_id: 1,
      condition_id: "0xcond",
      event_type: "disputed",
      payload_json: {},
      received_at: at(-500),
    });
    await killSwitchTriggersTick(worldPool(world), {
      clock: () => at(0),
      logSink: silentSink,
    });
    expect(world.kill["engaged"]).toBe(false);
    expect(world.kill["frozen_markets_json"]).toContain("0xcond");
    const blocked = await acceptOrder(world, { orderId: "order-9" });
    expect(blocked).toMatchObject({
      status: "rejected",
      reason: "MARKET_FROZEN_DISPUTE",
    });
  });
});
