// RFC-011 read surface: the current microstructure feature snapshot per token.
// Read-only, behind the RFC-002 auth service, and stamped with the mandatory
// simulation banner. No route here creates an order or touches anything real.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { SqlExecutor } from "../../database.js";
import { SIMULATION_BANNER } from "./runner.js";

export interface PaperRoutesDeps {
  readonly pool: { query: SqlExecutor["query"] };
  readonly authService: {
    session(token: string): Promise<{ status: string }>;
  };
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

export function registerPaperRoutes(
  app: FastifyInstance,
  deps: PaperRoutesDeps,
): void {
  const { pool, authService } = deps;

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
}
