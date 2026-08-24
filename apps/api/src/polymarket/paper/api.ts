// RFC-011 API surface: microstructure snapshots, paper orders, positions and
// the kill switch. Read/write over the paper_* tables only, behind the
// RFC-002 auth service, every response stamped with the mandatory simulation
// banner. No route here creates a real order or touches anything live.

import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { SqlExecutor } from "../../database.js";
import {
  acceptPaperOrder,
  bookAtOrBefore,
  engageKillSwitch,
  feeRateFromBps,
  loadKillSwitch,
  paramsAtOrBefore,
  rearmKillSwitch,
  requestCancel,
  type BrokerDeps,
} from "./brokerstore.js";
import { unrealizedPnlUsd } from "./ledger.js";
import { buildPerformanceReport } from "./performance.js";
import { decideOrderType, POLICY_VERSION } from "./policy.js";
import { SIMULATION_BANNER } from "./runner.js";
import type { OrderDraft, OrderSide, OrderType } from "./validator.js";

export interface PaperRoutesDeps {
  readonly pool: { query: SqlExecutor["query"] };
  readonly authService: {
    session(token: string): Promise<{ status: string }>;
  };
  /** Test seams / operational knobs for the broker calls. */
  readonly broker?: BrokerDeps;
  readonly newOrderId?: () => string;
}

const LATEST_WINDOWS_SQL =
  "SELECT DISTINCT ON (window_kind) * FROM paper_feature_windows " +
  "WHERE token_id = $1 " +
  "ORDER BY window_kind, window_start DESC";

function jsonError(
  reply: FastifyReply,
  statusCode: number,
  reasonCode: string,
): FastifyReply {
  return reply
    .code(statusCode)
    .send({ reason_code: reasonCode, correlation_id: reply.request.id });
}

function logPaperApiError(reasonCode: string, error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      service: "polymarket-paper",
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      error_name: error instanceof Error ? error.name : "UnknownError",
    })}\n`,
  );
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") {
    return null;
  }
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1] ?? null;
}

function serializeWindow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    window_kind: row["window_kind"],
    window_start: row["window_start"],
    window_end: row["window_end"],
    source_ts: row["source_ts"] ?? null,
    received_ts: row["computed_at"],
    book_valid: row["book_valid"],
    book_invalid_reason: row["book_invalid_reason"] ?? null,
    best_bid: row["best_bid"] ?? null,
    best_ask: row["best_ask"] ?? null,
    mid: row["mid"] ?? null,
    spread_quoted: row["spread_quoted"] ?? null,
    half_spread_bps: row["half_spread_bps"] ?? null,
    exec_spread_sref: row["exec_spread_sref"] ?? null,
    microprice: row["microprice"] ?? null,
    thin_book: row["thin_book"] ?? null,
    bid_depth_top1: row["bid_depth_top1"] ?? null,
    ask_depth_top1: row["ask_depth_top1"] ?? null,
    bid_depth_top10: row["bid_depth_top10"] ?? null,
    ask_depth_top10: row["ask_depth_top10"] ?? null,
    top_frac_bid: row["top_frac_bid"] ?? null,
    top_frac_ask: row["top_frac_ask"] ?? null,
    depth_ticks: row["depth_ticks_json"] ?? null,
    imbalance_top1: row["imbalance_top1"] ?? null,
    imbalance_top10: row["imbalance_top10"] ?? null,
    trades_count: row["trades_count"],
    volume_unsigned: row["volume_unsigned"] ?? null,
    volume_signed: row["volume_signed"] ?? null,
    flow_direction_status: row["flow_direction_status"],
    cancel_events: row["cancel_events"],
    update_events: row["update_events"],
    levels_touched: row["levels_touched"],
    vol_1m: row["vol_1m"] ?? null,
    vol_5m: row["vol_5m"] ?? null,
    vol_30m: row["vol_30m"] ?? null,
    jump_count: row["jump_count"],
    last_trade_age_ms:
      row["last_trade_age_ms"] === null ||
      row["last_trade_age_ms"] === undefined
        ? null
        : Number(row["last_trade_age_ms"]),
    book_staleness_ms:
      row["book_staleness_ms"] === null ||
      row["book_staleness_ms"] === undefined
        ? null
        : Number(row["book_staleness_ms"]),
    mins_to_catalyst: row["mins_to_catalyst"] ?? null,
    mins_to_end_date: row["mins_to_end_date"] ?? null,
    mins_to_uma_end: row["mins_to_uma_end"] ?? null,
  };
}

function bodyRecord(request: FastifyRequest): Record<string, unknown> {
  const body: unknown = request.body;
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function asStr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const ORDER_TYPES: readonly OrderType[] = ["GTC", "GTD", "FAK", "FOK"];
const ORDER_STATUSES = ["open", "filled", "canceled", "rejected", "expired"];

export function registerPaperRoutes(
  app: FastifyInstance,
  deps: PaperRoutesDeps,
): void {
  const { pool, authService } = deps;
  const brokerDeps: BrokerDeps = deps.broker ?? {};
  const newOrderId = deps.newOrderId ?? ((): string => randomUUID());

  async function guard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const token = bearerToken(request);
      if (token === null) {
        await jsonError(reply, 401, "AUTH_UNAUTHENTICATED");
        return;
      }
      const result = await authService.session(token);
      if (result.status !== "ok") {
        await jsonError(reply, 401, "AUTH_UNAUTHENTICATED");
      }
    } catch (error) {
      logPaperApiError("PAPER_API_FAILED", error);
      await jsonError(reply, 500, "PAPER_API_FAILED");
    }
  }

  app.get(
    "/polymarket/microstructure/:tokenId",
    { preHandler: guard },
    async (request, reply) => {
      try {
        const params: unknown = request.params;
        const tokenId =
          typeof params === "object" && params !== null
            ? (params as Record<string, unknown>)["tokenId"]
            : undefined;
        if (typeof tokenId !== "string" || tokenId.length === 0) {
          return await jsonError(reply, 400, "INVALID_TOKEN_ID");
        }
        const result = await pool.query(LATEST_WINDOWS_SQL, [tokenId]);
        if (result.rows.length === 0) {
          return await jsonError(reply, 404, "NO_FEATURES_FOR_TOKEN");
        }
        return await reply.send({
          simulation: SIMULATION_BANNER,
          token_id: tokenId,
          windows: result.rows.map(serializeWindow),
        });
      } catch (error) {
        logPaperApiError("PAPER_API_FAILED", error);
        return jsonError(reply, 500, "PAPER_API_FAILED");
      }
    },
  );

  // POST /polymarket/paper/orders — the only way a paper order is born. The
  // RFC's hard 422s: no limit_price, and no worst_price on FAK/FOK.
  app.post(
    "/polymarket/paper/orders",
    { preHandler: guard },
    async (request, reply) => {
      try {
        const body = bodyRecord(request);
        const tokenId = asStr(body["token_id"]);
        const sideRaw = body["side"];
        const side: OrderSide | null =
          sideRaw === "BUY" || sideRaw === "SELL" ? sideRaw : null;
        const size = asStr(body["size"]);
        const limitPrice = asStr(body["limit_price"]);
        const orderTypeRaw = body["order_type"] ?? "GTC";
        const orderType = ORDER_TYPES.find((t) => t === orderTypeRaw) ?? null;
        if (limitPrice === null) {
          return await jsonError(reply, 422, "MISSING_LIMIT_PRICE");
        }
        if (tokenId === null || side === null || size === null) {
          return await jsonError(reply, 422, "INVALID_ORDER_BODY");
        }
        if (orderType === null) {
          return await jsonError(reply, 422, "INVALID_ORDER_TYPE");
        }
        const worstPrice = asStr(body["worst_price"]);
        if (
          (orderType === "FAK" || orderType === "FOK") &&
          worstPrice === null
        ) {
          return await jsonError(reply, 422, "MISSING_WORST_PRICE");
        }
        const ttlRaw = body["ttl_s"];
        const ttlS =
          typeof ttlRaw === "number" && Number.isFinite(ttlRaw) ? ttlRaw : null;
        const postOnly =
          typeof body["post_only"] === "boolean"
            ? (body["post_only"] as boolean)
            : true;

        const market = await pool.query(
          "SELECT condition_id FROM polymarket_markets WHERE clob_token_ids @> to_jsonb($1::text) LIMIT 1",
          [tokenId],
        );
        const conditionId = asStr(market.rows[0]?.["condition_id"]);

        const draft: OrderDraft = {
          tokenId,
          side,
          orderType,
          limitPrice,
          size,
          postOnly,
          worstPrice,
          ttlS,
        };
        const orderId = newOrderId();
        const outcome = await acceptPaperOrder(
          pool,
          {
            orderId,
            draft,
            conditionId,
            source: "manual",
          },
          brokerDeps,
        );
        if (outcome.status === "rejected") {
          return await jsonError(reply, outcome.httpStatus, outcome.reason);
        }
        return await reply.code(201).send({
          simulation: SIMULATION_BANNER,
          order_id: orderId,
          status: "open",
          accepted_at: outcome.acceptedAt.toISOString(),
        });
      } catch (error) {
        logPaperApiError("PAPER_API_FAILED", error);
        return jsonError(reply, 500, "PAPER_API_FAILED");
      }
    },
  );

  app.delete(
    "/polymarket/paper/orders/:orderId",
    { preHandler: guard },
    async (request, reply) => {
      try {
        const params: unknown = request.params;
        const orderId =
          typeof params === "object" && params !== null
            ? asStr((params as Record<string, unknown>)["orderId"])
            : null;
        if (orderId === null) {
          return await jsonError(reply, 400, "INVALID_ORDER_ID");
        }
        const outcome = await requestCancel(pool, orderId, brokerDeps);
        if (outcome.status === "rejected") {
          return await jsonError(reply, outcome.httpStatus, outcome.reason);
        }
        return await reply.send({
          simulation: SIMULATION_BANNER,
          order_id: orderId,
          status: "cancel_requested",
        });
      } catch (error) {
        logPaperApiError("PAPER_API_FAILED", error);
        return jsonError(reply, 500, "PAPER_API_FAILED");
      }
    },
  );

  app.get(
    "/polymarket/paper/orders",
    { preHandler: guard },
    async (request, reply) => {
      try {
        const query: unknown = request.query;
        const statusRaw =
          typeof query === "object" && query !== null
            ? (query as Record<string, unknown>)["status"]
            : undefined;
        const status =
          typeof statusRaw === "string" && ORDER_STATUSES.includes(statusRaw)
            ? statusRaw
            : null;
        if (statusRaw !== undefined && status === null) {
          return await jsonError(reply, 400, "INVALID_STATUS_FILTER");
        }
        const rows =
          status === null
            ? await pool.query(
                "SELECT * FROM paper_orders ORDER BY created_at DESC LIMIT 200",
              )
            : await pool.query(
                "SELECT * FROM paper_orders WHERE status = $1 ORDER BY created_at DESC LIMIT 200",
                [status],
              );
        return await reply.send({
          simulation: SIMULATION_BANNER,
          orders: rows.rows,
        });
      } catch (error) {
        logPaperApiError("PAPER_API_FAILED", error);
        return jsonError(reply, 500, "PAPER_API_FAILED");
      }
    },
  );

  app.get(
    "/polymarket/paper/positions",
    { preHandler: guard },
    async (_request, reply) => {
      try {
        const rows = await pool.query(
          "SELECT * FROM paper_positions ORDER BY updated_at DESC LIMIT 500",
        );
        const nowMs = (brokerDeps.clock?.() ?? new Date()).getTime();
        const positions = rows.rows.map((row) => {
          const shares =
            typeof row["shares"] === "string" ? row["shares"] : "0";
          const cost =
            typeof row["cost_usd"] === "string" ? row["cost_usd"] : "0";
          const mark =
            typeof row["mark_value_usd"] === "string"
              ? row["mark_value_usd"]
              : null;
          const openedAtRaw = row["opened_at"];
          const openedAt =
            openedAtRaw instanceof Date
              ? openedAtRaw
              : typeof openedAtRaw === "string"
                ? new Date(openedAtRaw)
                : null;
          const open = shares !== "0" && !shares.startsWith("0.000000");
          return {
            ...row,
            stale_mark: row["mark_stale"] === true ? "STALE_MARK" : null,
            unrealized_pnl_usd: unrealizedPnlUsd(shares, cost, mark),
            current_lockup_s:
              open && openedAt !== null && !Number.isNaN(openedAt.getTime())
                ? Math.max(0, Math.floor((nowMs - openedAt.getTime()) / 1_000))
                : null,
          };
        });
        return await reply.send({
          simulation: SIMULATION_BANNER,
          positions,
        });
      } catch (error) {
        logPaperApiError("PAPER_API_FAILED", error);
        return jsonError(reply, 500, "PAPER_API_FAILED");
      }
    },
  );

  // Task 9: RFC-010 integration. An intent carries the fundamental estimate;
  // the deterministic policy decides the order type and the paper broker
  // simulates it. Without an active RFC-010 model the manual POST above keeps
  // working — this endpoint never requires a promoted model.
  app.post(
    "/polymarket/paper/intents",
    { preHandler: guard },
    async (request, reply) => {
      try {
        const body = bodyRecord(request);
        const tokenId = asStr(body["token_id"]);
        const sideRaw = body["side"];
        const side: OrderSide | null =
          sideRaw === "BUY" || sideRaw === "SELL" ? sideRaw : null;
        const q = asStr(body["q"]);
        const qLo = asStr(body["q_lo"]);
        const sizeMax = asStr(body["size_max"]);
        if (
          tokenId === null ||
          side === null ||
          qLo === null ||
          sizeMax === null
        ) {
          return await jsonError(reply, 422, "INVALID_INTENT_BODY");
        }
        const now = brokerDeps.clock?.() ?? new Date();

        const market = await pool.query(
          "SELECT condition_id FROM polymarket_markets WHERE clob_token_ids @> to_jsonb($1::text) LIMIT 1",
          [tokenId],
        );
        const conditionId = asStr(market.rows[0]?.["condition_id"]);
        if (conditionId === null) {
          return await jsonError(reply, 422, "UNKNOWN_MARKET");
        }
        const params = await paramsAtOrBefore(pool, conditionId, now);
        if (params === null || params.tickSize === null) {
          return await jsonError(reply, 422, "UNKNOWN_MARKET_PARAMS");
        }
        const book = await bookAtOrBefore(pool, tokenId, now);
        const reference = book?.sourceTs ?? book?.receivedAt ?? null;
        if (
          book === null ||
          reference === null ||
          now.getTime() - reference.getTime() > 30_000
        ) {
          return await jsonError(reply, 409, "NO_FRESH_BOOK");
        }

        // Catalyst clock from the latest persisted feature window (A8).
        const features = await pool.query(
          "SELECT mins_to_catalyst FROM paper_feature_windows " +
            "WHERE token_id = $1 ORDER BY window_start DESC LIMIT 1",
          [tokenId],
        );
        const minsRaw = features.rows[0]?.["mins_to_catalyst"];
        const minsToCatalyst = typeof minsRaw === "number" ? minsRaw : null;

        const decision = decideOrderType({
          side,
          qLo,
          size: sizeMax,
          bids: book.bids,
          asks: book.asks,
          tickSize: params.tickSize,
          takerFeeRate: feeRateFromBps(params.takerFeeBps),
          minsToCatalyst,
          // The defensive external-fair wire (RTDS divergence) lands with the
          // RFC-013 portfolio inputs; absent signal means no retreat, never
          // an attack.
          externalFairAgainst: false,
        });
        if (!decision.ok) {
          return await reply.send({
            simulation: SIMULATION_BANNER,
            decision: null,
            reason: decision.reason,
          });
        }
        const draft: OrderDraft = {
          tokenId,
          side,
          orderType: decision.value.orderType,
          limitPrice: decision.value.limitPrice,
          size: sizeMax,
          postOnly: decision.value.postOnly,
          worstPrice: decision.value.worstPrice,
          ttlS: decision.value.ttlS,
        };
        const orderId = newOrderId();
        const outcome = await acceptPaperOrder(
          pool,
          {
            orderId,
            draft,
            conditionId,
            source: "intent",
            policyReason: decision.value.policyReason,
            policyVersion: POLICY_VERSION,
            intent: { q, q_lo: qLo, size_max: sizeMax },
          },
          brokerDeps,
        );
        if (outcome.status === "rejected") {
          return await reply.code(outcome.httpStatus).send({
            simulation: SIMULATION_BANNER,
            decision: decision.value,
            reason_code: outcome.reason,
            correlation_id: reply.request.id,
          });
        }
        return await reply.code(201).send({
          simulation: SIMULATION_BANNER,
          decision: decision.value,
          order_id: orderId,
          status: "open",
        });
      } catch (error) {
        logPaperApiError("PAPER_API_FAILED", error);
        return jsonError(reply, 500, "PAPER_API_FAILED");
      }
    },
  );

  // Task 8: the three-column performance report. The optimistic column is
  // diagnostic only; RFC-009 gates read base or stress exclusively.
  app.get(
    "/polymarket/paper/performance",
    { preHandler: guard },
    async (_request, reply) => {
      try {
        const report = await buildPerformanceReport(pool);
        const fillReport = await pool.query(
          "SELECT generated_at, data_from, data_to, samples_total, buckets_json " +
            "FROM paper_fill_reports ORDER BY generated_at DESC LIMIT 1",
        );
        return await reply.send({
          simulation: SIMULATION_BANNER,
          ...report,
          fill_calibration: fillReport.rows[0] ?? null,
        });
      } catch (error) {
        logPaperApiError("PAPER_API_FAILED", error);
        return jsonError(reply, 500, "PAPER_API_FAILED");
      }
    },
  );

  app.post(
    "/polymarket/paper/kill-switch",
    { preHandler: guard },
    async (request, reply) => {
      try {
        const body = bodyRecord(request);
        const reason = asStr(body["reason"]) ?? "MANUAL";
        const now = brokerDeps.clock?.() ?? new Date();
        await engageKillSwitch(pool, reason, now, brokerDeps);
        return await reply.send({
          simulation: SIMULATION_BANNER,
          engaged: true,
          reason,
        });
      } catch (error) {
        logPaperApiError("PAPER_API_FAILED", error);
        return jsonError(reply, 500, "PAPER_API_FAILED");
      }
    },
  );

  app.post(
    "/polymarket/paper/kill-switch/rearm",
    { preHandler: guard },
    async (_request, reply) => {
      try {
        const now = brokerDeps.clock?.() ?? new Date();
        await rearmKillSwitch(pool, now);
        const state = await loadKillSwitch(pool);
        return await reply.send({
          simulation: SIMULATION_BANNER,
          engaged: state.engaged,
        });
      } catch (error) {
        logPaperApiError("PAPER_API_FAILED", error);
        return jsonError(reply, 500, "PAPER_API_FAILED");
      }
    },
  );
}
