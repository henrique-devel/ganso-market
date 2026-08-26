// RFC-013 API surface: the opportunity panel, exposures, limits, portfolio
// state, gates and the decision log. Read-only except for the two manual state
// controls (halt/resume), which the Nginx perimeter deliberately does NOT
// publish. Every route sits behind the RFC-002 session guard.
//
// There is no trading, wallet or deposit endpoint here, and there never will
// be: paper order and position endpoints stay in the RFC-011 surface, and real
// execution is RFC-009's exclusive scope.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { DatabasePool } from "../../database.js";
import { parseScaled } from "../fundamental/fixed.js";
import { CALIBRATED_EXPECTATION } from "./gates.js";
import {
  manualHalt,
  manualResume,
  utcDayBucket,
  utcWeekStart,
} from "./state.js";
import { SIMULATION_BANNER } from "./types.js";
import type { PortfolioStateSnapshot } from "./state.js";
import { money } from "./ev.js";

export interface AuthSessionService {
  session(token: string): Promise<{ readonly status: string }>;
}

export interface PortfolioRoutesDeps {
  readonly pool: Pick<DatabasePool, "query" | "transaction">;
  readonly authService: AuthSessionService;
  readonly clock?: () => Date;
  /** Drawdown limit, needed to refuse an unsafe resume. */
  readonly drawdownMax?: number;
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

function logApiError(reasonCode: string, error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      service: "polymarket-portfolio",
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      error_name: error instanceof Error ? error.name : "UnknownError",
      message: "polymarket_portfolio_api_failed",
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

export function registerPortfolioRoutes(
  app: FastifyInstance,
  deps: PortfolioRoutesDeps,
): void {
  const { pool, authService } = deps;
  const clock = deps.clock ?? ((): Date => new Date());
  const drawdownMax = deps.drawdownMax ?? 0.1;

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
      logApiError("PORTFOLIO_API_FAILED", error);
      await jsonError(reply, 500, "PORTFOLIO_API_FAILED");
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
        logApiError("PORTFOLIO_API_FAILED", error);
        return jsonError(reply, 500, "PORTFOLIO_API_FAILED");
      }
    };
  }

  // GET /polymarket/opportunities — the panel, newest snapshot per token.
  //
  // A vetoed market is INCLUDED, carrying its veto reason. Hiding it would let
  // the panel imply the universe is cleaner than it is; showing it without the
  // reason is what the RFC forbids.
  app.get(
    "/polymarket/opportunities",
    { preHandler: guard },
    wrap(async (_request, reply) => {
      const rows = await pool.query(
        `SELECT DISTINCT ON (token_id)
                snapshot_id, condition_id, token_id, computed_at, panel_json,
                decision_id, entrable, vetoed, veto_reason, config_version
           FROM portfolio_panel_snapshots
          ORDER BY token_id, computed_at DESC
          LIMIT ${String(LIST_LIMIT)}`,
      );
      return reply.send({
        simulation: SIMULATION_BANNER,
        opportunities: rows.rows,
      });
    }),
  );

  // GET /polymarket/opportunities/:tokenId — detail plus decision history.
  app.get(
    "/polymarket/opportunities/:tokenId",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const tokenId = paramString(request, "tokenId");
      if (tokenId === null) {
        return jsonError(reply, 400, "INVALID_TOKEN_ID");
      }
      const snapshot = await pool.query(
        `SELECT snapshot_id, condition_id, token_id, computed_at, panel_json,
                decision_id, entrable, vetoed, veto_reason, config_version
           FROM portfolio_panel_snapshots
          WHERE token_id = $1
          ORDER BY computed_at DESC
          LIMIT 1`,
        [tokenId],
      );
      if (snapshot.rows.length === 0) {
        return jsonError(reply, 404, "NO_PANEL_FOR_TOKEN");
      }
      const history = await pool.query(
        `SELECT decision_id, decision_kind, decision_ts, market_side,
                order_side, edge_net, size_shares, binding_constraint,
                outcome, reason_code, portfolio_state, config_version
           FROM portfolio_decisions
          WHERE token_id = $1
          ORDER BY decision_ts DESC
          LIMIT ${String(HISTORY_LIMIT)}`,
        [tokenId],
      );
      return reply.send({
        simulation: SIMULATION_BANNER,
        opportunity: snapshot.rows[0],
        decisions: history.rows,
      });
    }),
  );

  // GET /polymarket/portfolio/exposure — every dimension at once.
  app.get(
    "/polymarket/portfolio/exposure",
    { preHandler: guard },
    wrap(async (_request, reply) => {
      const rows = await pool.query(
        `SELECT dimension, dimension_key, worst_case_usd, cap_usd, utilization,
                position_count, unwind_cost_usd, computed_at
           FROM portfolio_exposures
          ORDER BY utilization DESC, dimension, dimension_key
          LIMIT ${String(LIST_LIMIT)}`,
      );
      return reply.send({
        simulation: SIMULATION_BANNER,
        // Stated on the exposure endpoint itself so nobody reads these numbers
        // as mark-to-market: every one assumes the position goes to zero.
        basis: "worst case = perda total da posição",
        exposures: rows.rows,
      });
    }),
  );

  // GET /polymarket/portfolio/limits — caps, consumption, binding constraints.
  app.get(
    "/polymarket/portfolio/limits",
    { preHandler: guard },
    wrap(async (_request, reply) => {
      const caps = await pool.query(
        `SELECT dimension, dimension_key, worst_case_usd, cap_usd, utilization
           FROM portfolio_exposures
          WHERE utilization::numeric > 0
          ORDER BY utilization DESC
          LIMIT ${String(LIST_LIMIT)}`,
      );
      const binding = await pool.query(
        `SELECT binding_constraint, count(*) AS decisions
           FROM portfolio_decisions
          WHERE decision_ts > now() - interval '24 hours'
          GROUP BY binding_constraint
          ORDER BY count(*) DESC`,
      );
      return reply.send({
        simulation: SIMULATION_BANNER,
        caps: caps.rows,
        binding_constraints_24h: binding.rows,
      });
    }),
  );

  // GET /polymarket/portfolio/state — NORMAL | REDUCE_ONLY | HALTED + reason.
  app.get(
    "/polymarket/portfolio/state",
    { preHandler: guard },
    wrap(async (_request, reply) => {
      const state = await pool.query(
        `SELECT state, reason, bankroll_usd, high_water_mark_usd, equity_usd,
                drawdown, realized_pnl_day_usd, realized_pnl_week_usd,
                day_bucket, week_start, reduce_only_until, halted_at,
                manual_halt, config_version, updated_at
           FROM portfolio_state WHERE portfolio_id = 1`,
      );
      const events = await pool.query(
        `SELECT state_event_id, from_state, to_state, reason, trigger_source, at
           FROM portfolio_state_events
          ORDER BY at DESC
          LIMIT 50`,
      );
      const breakers = await pool.query(
        `SELECT breaker_id, kind, scope, condition_id, token_id, started_at
           FROM portfolio_circuit_breakers
          WHERE ended_at IS NULL
          ORDER BY started_at DESC
          LIMIT ${String(LIST_LIMIT)}`,
      );
      return reply.send({
        simulation: SIMULATION_BANNER,
        state: state.rows[0] ?? null,
        transitions: events.rows,
        open_circuit_breakers: breakers.rows,
      });
    }),
  );

  // GET /polymarket/gates — G1..G6 with the numbers and intervals.
  app.get(
    "/polymarket/gates",
    { preHandler: guard },
    wrap(async (_request, reply) => {
      const latest = await pool.query(
        `SELECT DISTINCT ON (gate)
                gate, status, reason_code, metrics_json, config_version,
                window_from, window_to, measured_at
           FROM portfolio_gate_measurements
          ORDER BY gate, measured_at DESC`,
      );
      const reports = await pool.query(
        `SELECT report_id, generated_at, window_from, window_to,
                overall_status, gates_json, approval_json, config_version
           FROM portfolio_gate_reports
          ORDER BY generated_at DESC
          LIMIT 10`,
      );
      const blocked = latest.rows.some(
        (row) => (row as { status?: unknown }).status !== "PASS",
      );
      return reply.send({
        simulation: SIMULATION_BANNER,
        // The endpoint states the consequence, not only the numbers: RFC-009
        // stays blocked while any gate is anything other than PASS.
        rfc_009_status:
          latest.rows.length === 0 || blocked
            ? "BLOCKED"
            : "READY_FOR_OWNER_REVIEW",
        calibrated_expectation: CALIBRATED_EXPECTATION,
        gates: latest.rows,
        reports: reports.rows,
      });
    }),
  );

  // GET /polymarket/decisions — the decision log.
  app.get(
    "/polymarket/decisions",
    { preHandler: guard },
    wrap(async (_request, reply) => {
      const rows = await pool.query(
        `SELECT decision_id, decision_kind, condition_id, token_id,
                market_side, order_side, decision_ts, q_lo, q_hi, exec_price,
                edge_net, size_shares, binding_constraint, outcome, reason_code,
                portfolio_state, config_version, config_hash
           FROM portfolio_decisions
          ORDER BY decision_ts DESC
          LIMIT ${String(HISTORY_LIMIT)}`,
      );
      return reply.send({
        simulation: SIMULATION_BANNER,
        decisions: rows.rows,
      });
    }),
  );

  // GET /polymarket/decisions/:id — one decision with every input it used.
  app.get(
    "/polymarket/decisions/:decisionId",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const raw = paramString(request, "decisionId");
      const decisionId = raw === null ? Number.NaN : Number(raw);
      if (!Number.isInteger(decisionId) || decisionId <= 0) {
        return jsonError(reply, 400, "INVALID_DECISION_ID");
      }
      const rows = await pool.query(
        `SELECT * FROM portfolio_decisions WHERE decision_id = $1`,
        [decisionId],
      );
      if (rows.rows.length === 0) {
        return jsonError(reply, 404, "NO_SUCH_DECISION");
      }
      return reply.send({
        simulation: SIMULATION_BANNER,
        decision: rows.rows[0],
      });
    }),
  );

  async function currentState(): Promise<PortfolioStateSnapshot | null> {
    const result = await pool.query<Record<string, unknown>>(
      `SELECT state, reason, bankroll_usd, high_water_mark_usd, equity_usd,
              drawdown, realized_pnl_day_usd, realized_pnl_week_usd,
              day_bucket, week_start, reduce_only_until, halted_at, manual_halt
         FROM portfolio_state WHERE portfolio_id = 1`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    const scaled = (value: unknown): bigint =>
      parseScaled(String(value ?? "0")) ?? 0n;
    const state = String(row.state);
    return {
      state: state === "REDUCE_ONLY" || state === "HALTED" ? state : "NORMAL",
      reason:
        row.reason === null || row.reason === undefined
          ? null
          : String(row.reason),
      bankrollScaled: scaled(row.bankroll_usd),
      highWaterMarkScaled: scaled(row.high_water_mark_usd),
      equityScaled: scaled(row.equity_usd),
      drawdownScaled: scaled(row.drawdown),
      realizedPnlDayScaled: scaled(row.realized_pnl_day_usd),
      realizedPnlWeekScaled: scaled(row.realized_pnl_week_usd),
      dayBucket: String(row.day_bucket ?? utcDayBucket(clock())).slice(0, 10),
      weekStart: String(row.week_start ?? utcWeekStart(clock())).slice(0, 10),
      reduceOnlyUntil:
        row.reduce_only_until instanceof Date ? row.reduce_only_until : null,
      haltedAt: row.halted_at instanceof Date ? row.halted_at : null,
      manualHalt: row.manual_halt === true,
    };
  }

  async function writeState(
    next: PortfolioStateSnapshot,
    transition: {
      from: string;
      to: string;
      reason: string;
      triggerSource: string;
    } | null,
  ): Promise<void> {
    await pool.transaction(async (tx) => {
      await tx.query(
        `UPDATE portfolio_state
            SET state = $1, reason = $2, reduce_only_until = $3,
                halted_at = $4, manual_halt = $5,
                high_water_mark_usd = $6, drawdown = $7,
                updated_at = CURRENT_TIMESTAMP
          WHERE portfolio_id = 1`,
        [
          next.state,
          next.reason,
          next.reduceOnlyUntil,
          next.haltedAt,
          next.manualHalt,
          money(next.highWaterMarkScaled),
          money(next.drawdownScaled),
        ],
      );
      if (transition !== null) {
        await tx.query(
          `INSERT INTO portfolio_state_events
             (from_state, to_state, reason, trigger_source, detail_json)
           VALUES ($1,$2,$3,$4,$5::jsonb)`,
          [
            transition.from,
            transition.to,
            transition.reason,
            transition.triggerSource,
            JSON.stringify({ manual: true }),
          ],
        );
      }
    });
  }

  // POST /polymarket/portfolio/halt — idempotent manual halt.
  //
  // Not published by the Nginx perimeter: it is an operator action taken from
  // inside, like every other write in this module's surface.
  app.post(
    "/polymarket/portfolio/halt",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const state = await currentState();
      if (state === null) {
        return jsonError(reply, 409, "PORTFOLIO_STATE_MISSING");
      }
      const body = bodyRecord(request);
      const reasonRaw = body.reason;
      const reason =
        typeof reasonRaw === "string" && reasonRaw.trim().length > 0
          ? reasonRaw.trim().slice(0, 256)
          : "manual_halt";
      const result = manualHalt(state, clock(), reason);
      if (result.transition !== null) {
        await writeState(result.next, result.transition);
      }
      return reply.send({
        simulation: SIMULATION_BANNER,
        state: result.next.state,
        reason: result.next.reason,
        changed: result.transition !== null,
      });
    }),
  );

  // POST /polymarket/portfolio/resume — only from HALTED, and only when the
  // condition that halted the portfolio has actually cleared.
  app.post(
    "/polymarket/portfolio/resume",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const state = await currentState();
      if (state === null) {
        return jsonError(reply, 409, "PORTFOLIO_STATE_MISSING");
      }
      const body = bodyRecord(request);
      // An explicit confirmation, because leaving HALTED is exactly the action
      // that should not happen by reflex.
      if (body.confirm !== true) {
        return jsonError(reply, 400, "RESUME_REQUIRES_CONFIRMATION");
      }
      const { evaluation, refusedReason } = manualResume(state, clock(), {
        perdaDiariaMaxScaled: 0n,
        perdaSemanalMaxScaled: 0n,
        drawdownMaxScaled: BigInt(Math.round(drawdownMax * 1_000_000_000)),
        reduceOnlyWeekDays: 7,
      });
      if (refusedReason !== null) {
        return reply.code(409).send({
          reason_code: refusedReason,
          simulation: SIMULATION_BANNER,
          state: state.state,
        });
      }
      await writeState(evaluation.next, evaluation.transition);
      return reply.send({
        simulation: SIMULATION_BANNER,
        state: evaluation.next.state,
        high_water_mark_rebased: money(evaluation.next.highWaterMarkScaled),
      });
    }),
  );
}
