// RFC-012 API surface: resolution-risk scores, the logical market graph, its
// violations and sanity vetoes, layer divergences, the measurement reports
// and the paper-pipeline snapshot the dashboard renders. Read-only except for
// POST /polymarket/graph/edges (curated edge with author + justification),
// which the Nginx perimeter deliberately does NOT publish. Every route sits
// behind the RFC-002 session guard.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { DatabasePool } from "../../database.js";
import { edgeKeyOf } from "./graph.js";
import { parseCuratedEdges } from "./curated.js";
import type { GraphEdgeKind } from "./types.js";

export interface AuthSessionService {
  session(token: string): Promise<{ readonly status: string }>;
}

export interface ResolutionRoutesDeps {
  readonly pool: Pick<DatabasePool, "query">;
  readonly authService: AuthSessionService;
  readonly clock?: () => Date;
}

const LIST_LIMIT = 200;
const HISTORY_LIMIT = 500;

function jsonError(
  reply: FastifyReply,
  statusCode: number,
  reasonCode: string,
): FastifyReply {
  return reply
    .code(statusCode)
    .send({ reason_code: reasonCode, correlation_id: reply.request.id });
}

function logResolutionApiError(reasonCode: string, error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      service: "polymarket-resolution",
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      error_name: error instanceof Error ? error.name : "UnknownError",
      message: "polymarket_resolution_api_failed",
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

function paramString(request: FastifyRequest, name: string): string | null {
  const params: unknown = request.params;
  if (typeof params !== "object" || params === null) {
    return null;
  }
  const value = (params as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function bodyRecord(request: FastifyRequest): Record<string, unknown> {
  const body: unknown = request.body;
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

export function registerResolutionRoutes(
  app: FastifyInstance,
  deps: ResolutionRoutesDeps,
): void {
  const { pool, authService } = deps;
  const clock = deps.clock ?? ((): Date => new Date());

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
      logResolutionApiError("RESOLUTION_API_FAILED", error);
      await jsonError(reply, 500, "RESOLUTION_API_FAILED");
    }
  }

  type RouteHandler = (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<unknown>;

  function wrap(handler: RouteHandler): RouteHandler {
    return async (request, reply) => {
      try {
        return await handler(request, reply);
      } catch (error) {
        logResolutionApiError("RESOLUTION_API_FAILED", error);
        return jsonError(reply, 500, "RESOLUTION_API_FAILED");
      }
    };
  }

  // Scores correntes do universo: score, ação, versão, features principais.
  app.get(
    "/polymarket/resolution-risk",
    { preHandler: guard },
    wrap(async (_request, reply) => {
      const states = await pool.query(
        `SELECT s.condition_id, m.question, m.category, m.neg_risk,
                s.score, s.score_version, s.action, s.effective_action,
                s.resolution_buffer, s.p_5050, s.expected_lockup_s,
                s.p95_lockup_s, s.dispute_active, s.suspect_jump,
                s.hard_flags_json, s.event_ids_json, s.group_worst_score,
                s.justification, s.prior_kind, s.computed_at
           FROM resolution_market_state s
           LEFT JOIN polymarket_markets m ON m.condition_id = s.condition_id
          ORDER BY s.score DESC NULLS LAST
          LIMIT ${LIST_LIMIT}`,
      );
      return reply.send({ markets: states.rows });
    }),
  );

  // Divergências entre as camadas de circuit breaker (decisão 4).
  app.get(
    "/polymarket/resolution-risk/divergences",
    { preHandler: guard },
    wrap(async (_request, reply) => {
      const active = await pool.query(
        `SELECT * FROM resolution_layer_divergences
          WHERE ended_at IS NULL
          ORDER BY started_at DESC
          LIMIT ${LIST_LIMIT}`,
      );
      const recent = await pool.query(
        `SELECT * FROM resolution_layer_divergences
          WHERE ended_at IS NOT NULL
          ORDER BY ended_at DESC
          LIMIT ${LIST_LIMIT}`,
      );
      return reply.send({ active: active.rows, recent: recent.rows });
    }),
  );

  // Últimos relatórios de medição própria (priors, P1..P4, lockup, backtest).
  app.get(
    "/polymarket/resolution-risk/reports",
    { preHandler: guard },
    wrap(async (_request, reply) => {
      const reports = await pool.query(
        `SELECT report_id, generated_at, data_from, data_to,
                categories_json, backtest_json, score_version
           FROM resolution_reports
          ORDER BY generated_at DESC
          LIMIT 10`,
      );
      return reply.send({ reports: reports.rows });
    }),
  );

  // Estado do pipeline paper para o painel: ordens abertas, posições e kill
  // switch — leitura agregada, nenhum caminho de escrita.
  app.get(
    "/polymarket/resolution-risk/pipeline",
    { preHandler: guard },
    wrap(async (_request, reply) => {
      const killSwitch = await pool.query(
        `SELECT engaged, reason, engaged_at, rearmed_at, frozen_markets_json
           FROM paper_kill_switch WHERE kill_switch_id = 1`,
      );
      const orders = await pool.query(
        `SELECT order_id, token_id, condition_id, side, order_type,
                limit_price, size, filled_size, status, source, created_at
           FROM paper_orders
          WHERE status = 'open'
          ORDER BY created_at DESC
          LIMIT ${LIST_LIMIT}`,
      );
      const positions = await pool.query(
        `SELECT token_id, condition_id, shares, cost_usd, realized_pnl_usd,
                mark_value_usd, mark_stale, updated_at
           FROM paper_positions
          ORDER BY updated_at DESC
          LIMIT ${LIST_LIMIT}`,
      );
      const divergences = await pool.query(
        `SELECT COUNT(*)::bigint AS active
           FROM resolution_layer_divergences
          WHERE ended_at IS NULL`,
      );
      return reply.send({
        kill_switch: killSwitch.rows[0] ?? null,
        open_orders: orders.rows,
        positions: positions.rows,
        divergences_active: Number(divergences.rows[0]?.active ?? 0),
        checked_at: clock().toISOString(),
      });
    }),
  );

  // Detalhe de um mercado: estado, decomposição do último score, timeline UMA
  // e clarificações (diffs de regra classificados).
  app.get(
    "/polymarket/resolution-risk/:marketId",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const marketId = paramString(request, "marketId");
      if (marketId === null) {
        return jsonError(reply, 400, "INVALID_MARKET_ID");
      }
      const state = await pool.query(
        `SELECT s.*, m.question, m.category, m.neg_risk, m.question_id
           FROM resolution_market_state s
           LEFT JOIN polymarket_markets m ON m.condition_id = s.condition_id
          WHERE s.condition_id = $1`,
        [marketId],
      );
      if (state.rows.length === 0) {
        return jsonError(reply, 404, "MARKET_NOT_SCORED");
      }
      const score = await pool.query(
        `SELECT score_id, score_version, rule_version, score, action,
                resolution_buffer, p_5050, expected_lockup_s, p95_lockup_s,
                prior_kind, features_json, hard_flags_json, justification,
                trigger, computed_at
           FROM resolution_scores
          WHERE condition_id = $1
          ORDER BY computed_at DESC, score_id DESC
          LIMIT 1`,
        [marketId],
      );
      const timeline = await pool.query(
        `SELECT request_index, state, result, payouts_json, bond,
                custom_liveness, source, source_ref, occurred_at
           FROM resolution_uma_timeline
          WHERE condition_id = $1
          ORDER BY occurred_at ASC, timeline_id ASC
          LIMIT ${HISTORY_LIMIT}`,
        [marketId],
      );
      const clarifications = await pool.query(
        `SELECT rule_version, classification, changed_fields_json,
                detail_json, valid_from
           FROM resolution_clarifications
          WHERE condition_id = $1
          ORDER BY rule_version ASC
          LIMIT ${HISTORY_LIMIT}`,
        [marketId],
      );
      return reply.send({
        state: state.rows[0],
        latest_score: score.rows[0] ?? null,
        uma_timeline: timeline.rows,
        clarifications: clarifications.rows,
      });
    }),
  );

  // Série de scores e transições de estado.
  app.get(
    "/polymarket/resolution-risk/:marketId/history",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const marketId = paramString(request, "marketId");
      if (marketId === null) {
        return jsonError(reply, 400, "INVALID_MARKET_ID");
      }
      const scores = await pool.query(
        `SELECT score_id, score_version, rule_version, score, action,
                resolution_buffer, prior_kind, hard_flags_json, trigger,
                computed_at
           FROM resolution_scores
          WHERE condition_id = $1
          ORDER BY computed_at DESC, score_id DESC
          LIMIT ${HISTORY_LIMIT}`,
        [marketId],
      );
      return reply.send({ scores: scores.rows });
    }),
  );

  // Grafo: nós (estados correntes) e arestas com origem e confidence.
  app.get(
    "/polymarket/graph",
    { preHandler: guard },
    wrap(async (_request, reply) => {
      const edges = await pool.query(
        `SELECT edge_id, edge_key, kind, from_condition_id, to_condition_id,
                event_id, members_json, origin, confidence, author,
                justification, params_json, created_at, updated_at, revoked_at
           FROM graph_edges
          WHERE revoked_at IS NULL
          ORDER BY kind, edge_key
          LIMIT 1000`,
      );
      const nodes = await pool.query(
        `SELECT s.condition_id, m.question, s.action, s.effective_action,
                s.score
           FROM resolution_market_state s
           LEFT JOIN polymarket_markets m ON m.condition_id = s.condition_id
          ORDER BY s.condition_id
          LIMIT 1000`,
      );
      return reply.send({ nodes: nodes.rows, edges: edges.rows });
    }),
  );

  // Violações ativas e históricas, com magnitude líquida e tamanho executável.
  app.get(
    "/polymarket/graph/violations",
    { preHandler: guard },
    wrap(async (_request, reply) => {
      const active = await pool.query(
        `SELECT * FROM graph_violations
          WHERE ended_at IS NULL
          ORDER BY started_at DESC
          LIMIT ${LIST_LIMIT}`,
      );
      const recent = await pool.query(
        `SELECT * FROM graph_violations
          WHERE ended_at IS NOT NULL
          ORDER BY ended_at DESC
          LIMIT ${LIST_LIMIT}`,
      );
      return reply.send({ active: active.rows, recent: recent.rows });
    }),
  );

  // Vetos de sanidade emitidos contra o modelo fundamental.
  app.get(
    "/polymarket/graph/vetoes",
    { preHandler: guard },
    wrap(async (_request, reply) => {
      const active = await pool.query(
        `SELECT * FROM graph_sanity_vetoes
          WHERE ended_at IS NULL
          ORDER BY started_at DESC
          LIMIT ${LIST_LIMIT}`,
      );
      const recent = await pool.query(
        `SELECT * FROM graph_sanity_vetoes
          WHERE ended_at IS NOT NULL
          ORDER BY ended_at DESC
          LIMIT ${LIST_LIMIT}`,
      );
      return reply.send({ active: active.rows, recent: recent.rows });
    }),
  );

  // Inserir/revisar aresta curada. Autor e justificativa obrigatórios; a
  // revisão só toca arestas de origem curada criadas por esta API.
  app.post(
    "/polymarket/graph/edges",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const body = bodyRecord(request);
      if (body.revoke === true) {
        const edgeKey =
          typeof body.edge_key === "string" ? body.edge_key : null;
        const author = typeof body.author === "string" ? body.author : null;
        const justification =
          typeof body.justification === "string" ? body.justification : null;
        if (edgeKey === null || author === null || justification === null) {
          return jsonError(reply, 422, "INVALID_EDGE_REVOCATION");
        }
        const revoked = await pool.query(
          `UPDATE graph_edges
              SET revoked_at = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP,
                  author = $2,
                  justification = $3
            WHERE edge_key = $1
              AND origin = 'curated'
              AND revoked_at IS NULL`,
          [edgeKey, author, justification],
        );
        if (revoked.rowCount === 0) {
          return jsonError(reply, 404, "EDGE_NOT_FOUND");
        }
        return reply.send({ edge_key: edgeKey, revoked: true });
      }

      let parsed;
      try {
        parsed = parseCuratedEdges({ schema_version: 1, edges: [body] });
      } catch (error) {
        logResolutionApiError("EDGE_BODY_INVALID", error);
        return jsonError(reply, 422, "INVALID_EDGE_BODY");
      }
      const edge = parsed[0];
      if (edge === undefined) {
        return jsonError(reply, 422, "INVALID_EDGE_BODY");
      }
      const edgeKey = edgeKeyOf({
        kind: edge.kind as GraphEdgeKind,
        fromConditionId: edge.fromConditionId,
        toConditionId: edge.toConditionId,
        eventId: null,
        members: edge.members,
      });
      await pool.query(
        `INSERT INTO graph_edges
           (edge_key, kind, from_condition_id, to_condition_id, event_id,
            members_json, origin, confidence, author, justification,
            params_json)
         VALUES ($1,$2,$3,$4,NULL,$5::jsonb,'curated',$6,$7,$8,$9::jsonb)
         ON CONFLICT (edge_key) DO UPDATE SET
           confidence = EXCLUDED.confidence,
           author = EXCLUDED.author,
           justification = EXCLUDED.justification,
           params_json = EXCLUDED.params_json,
           revoked_at = NULL,
           updated_at = CURRENT_TIMESTAMP`,
        [
          edgeKey,
          edge.kind,
          edge.fromConditionId,
          edge.toConditionId,
          JSON.stringify(edge.members),
          edge.confidence,
          edge.author,
          edge.justification,
          JSON.stringify({ ...edge.params, source: "api" }),
        ],
      );
      return reply.code(201).send({ edge_key: edgeKey });
    }),
  );
}
