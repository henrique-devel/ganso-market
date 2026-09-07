import { randomUUID } from "node:crypto";

import Fastify, { LogController, type FastifyInstance } from "fastify";

import { registerAuthRoutes } from "./auth/http.js";
import { registerFundamentalRoutes } from "./polymarket/fundamental/api.js";
import { registerPaperRoutes } from "./polymarket/paper/api.js";
import { registerPortfolioRoutes } from "./polymarket/portfolio/api.js";
import { registerResolutionRoutes } from "./polymarket/resolution/api.js";
import { registerOverviewRoutes } from "./polymarket/overview.js";
import { registerPolymarketReadRoutes } from "./polymarket/readapi.js";
import { budgetedPool, budgetForRoute, runWithBudget } from "./budgets.js";
import type { AuthService } from "./auth/service.js";
import type { ApiConfig, StatementBudgets } from "./config.js";
import { requireStatementBudgets } from "./config.js";
import type { DatabasePool, ReadinessProbe } from "./database.js";
import {
  POSTGRES_UNAVAILABLE,
  serviceHealthSchema,
  type ServiceHealth,
} from "./health.js";
import { createLoggerOptions, type LogSink } from "./logger.js";
import { errorFields } from "./errors.js";

const CORRELATION_ID_HEADER = "x-correlation-id";
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * RFC-023 D1. What `onRoute` stamps on every route, and what the budget hook
 * reads back. Declared here so the coverage test can import the key name
 * instead of matching a string literal in two places.
 */
export const STATEMENT_TIMEOUT_CONFIG_KEY = "statementTimeoutMs";

export interface RouteBudgetConfig {
  readonly [STATEMENT_TIMEOUT_CONFIG_KEY]?: number;
}

export interface BuildApiOptions {
  readonly config: ApiConfig;
  /**
   * RFC-023 D1. Defaults to `requireStatementBudgets(config)`, which throws
   * QUERY_TIMEOUT_UNDECLARED when the config does not declare them. Passed
   * explicitly only by tests that build an app without a config file.
   */
  readonly statementBudgets?: StatementBudgets;
  readonly readinessProbe: ReadinessProbe;
  readonly authService?: AuthService;
  readonly pool?: DatabasePool;
  readonly cookieSecure?: boolean;
  readonly logger?: boolean;
  readonly logSink?: LogSink;
  readonly clock?: () => Date;
  readonly uptimeSeconds?: () => number;
}

export function buildApi(options: BuildApiOptions): FastifyInstance {
  const clock = options.clock ?? (() => new Date());
  const uptimeSeconds = options.uptimeSeconds ?? (() => process.uptime());
  const logger =
    options.logger === false
      ? false
      : createLoggerOptions(options.config.log.level, options.logSink);
  const app = Fastify({
    logger,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId(request): string {
      const incoming = request.headers[CORRELATION_ID_HEADER];
      return typeof incoming === "string" &&
        CORRELATION_ID_PATTERN.test(incoming)
        ? incoming
        : randomUUID();
    },
  });

  // RFC-023 D1. Two halves of one guarantee.
  //
  // `onRoute` stamps every route with the budget it will run on, taken from
  // `services.api.statement_timeout_ms` in config: the route's own entry, or
  // `default`. Doing it here rather than at each `app.get` call means a route
  // added tomorrow cannot forget, and `routeOptions.config` becomes the single
  // place to read the answer from — including from the coverage test, which
  // fails if a route published by the Nginx perimeter has no entry of its own.
  //
  // The `onRequest` hook then puts that number where the pool wrapper can find
  // it, for GET only. A POST carries no budget, so its queries stay outside
  // READ ONLY and keep writing.
  const budgets =
    options.statementBudgets ?? requireStatementBudgets(options.config);

  app.addHook("onRoute", (routeOptions) => {
    const url = routeOptions.url;
    const existing = routeOptions.config as RouteBudgetConfig | undefined;
    routeOptions.config = {
      ...existing,
      [STATEMENT_TIMEOUT_CONFIG_KEY]: budgetForRoute(budgets, url),
    };
  });

  app.addHook("onRequest", (request, _reply, done) => {
    if (request.method !== "GET") {
      done();
      return;
    }
    const routeConfig = request.routeOptions.config as
      RouteBudgetConfig | undefined;
    runWithBudget(
      routeConfig?.[STATEMENT_TIMEOUT_CONFIG_KEY] ?? budgets.defaultMs,
      done,
    );
  });

  let readinessChecksTotal = 0;
  let readinessFailuresTotal = 0;

  app.addHook("onRequest", async (request, reply) => {
    reply.header(CORRELATION_ID_HEADER, request.id);
    const incoming = request.headers[CORRELATION_ID_HEADER];
    if (
      incoming !== undefined &&
      !(typeof incoming === "string" && CORRELATION_ID_PATTERN.test(incoming))
    ) {
      request.log.warn(
        {
          correlation_id: request.id,
          reason_code: "CORRELATION_ID_REPLACED",
        },
        "invalid_correlation_id_replaced",
      );
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        correlation_id: request.id,
        method: request.method,
        route: request.routeOptions.url ?? "unmatched",
        status_code: reply.statusCode,
      },
      "request_completed",
    );
  });

  app.get(
    "/health/live",
    { schema: { response: { 200: serviceHealthSchema } } },
    async (request): Promise<ServiceHealth> => ({
      service: "api",
      status: "live",
      checked_at: clock().toISOString(),
      execution_mode: options.config.executionMode,
      correlation_id: request.id,
      reason_codes: [],
      checks: [],
    }),
  );

  app.get(
    "/health/ready",
    {
      schema: {
        response: { 200: serviceHealthSchema, 503: serviceHealthSchema },
      },
    },
    async (request, reply): Promise<ServiceHealth> => {
      readinessChecksTotal += 1;
      try {
        await options.readinessProbe.check();
        return {
          service: "api",
          status: "ready",
          checked_at: clock().toISOString(),
          execution_mode: options.config.executionMode,
          correlation_id: request.id,
          reason_codes: [],
          checks: [{ name: "postgres", status: "ready", reason_codes: [] }],
        };
      } catch (error) {
        readinessFailuresTotal += 1;
        request.log.warn(
          {
            correlation_id: request.id,
            reason_code: POSTGRES_UNAVAILABLE,
            dependency: "postgres",
            ...errorFields(error),
          },
          "readiness_check_failed",
        );
        reply.code(503);
        return {
          service: "api",
          status: "not_ready",
          checked_at: clock().toISOString(),
          execution_mode: options.config.executionMode,
          correlation_id: request.id,
          reason_codes: [POSTGRES_UNAVAILABLE],
          checks: [
            {
              name: "postgres",
              status: "not_ready",
              reason_codes: [POSTGRES_UNAVAILABLE],
            },
          ],
        };
      }
    },
  );

  app.get("/metrics", async (_request, reply) => {
    const body = [
      "# HELP ganso_api_up Whether the API process is live.",
      "# TYPE ganso_api_up gauge",
      "ganso_api_up 1",
      "# HELP ganso_api_process_uptime_seconds API process uptime in seconds.",
      "# TYPE ganso_api_process_uptime_seconds gauge",
      `ganso_api_process_uptime_seconds ${uptimeSeconds()}`,
      "# HELP ganso_api_readiness_checks_total Readiness checks performed.",
      "# TYPE ganso_api_readiness_checks_total counter",
      `ganso_api_readiness_checks_total ${readinessChecksTotal}`,
      "# HELP ganso_api_readiness_failures_total Failed readiness checks.",
      "# TYPE ganso_api_readiness_failures_total counter",
      `ganso_api_readiness_failures_total ${readinessFailuresTotal}`,
      "",
    ].join("\n");
    return reply.type("text/plain; version=0.0.4; charset=utf-8").send(body);
  });

  if (options.authService !== undefined) {
    registerAuthRoutes(app, {
      service: options.authService,
      ...(options.cookieSecure === undefined
        ? {}
        : { cookieSecure: options.cookieSecure }),
    });
  }

  if (options.authService !== undefined && options.pool !== undefined) {
    // RFC-023 D1. The read modules get the budgeted wrapper, not the raw pool:
    // every query they run inside a GET becomes its own READ ONLY transaction
    // with the route's `SET LOCAL statement_timeout`. The auth service and the
    // readiness probe keep the raw pool — the first writes sessions, and the
    // second must answer even when a budget would not apply.
    const readPool = budgetedPool(options.pool);
    registerPolymarketReadRoutes(app, {
      pool: readPool,
      authService: options.authService,
    });
    // RFC-010 read + lifecycle surface. Read-only over the estimate tables,
    // plus the operator's manual promote/demote of a model. No route here
    // creates an order, a signal or touches a wallet.
    registerFundamentalRoutes(app, {
      pool: readPool,
      authService: options.authService,
    });
    // RFC-011 read surface: microstructure feature snapshots. Simulation
    // scope only; stamped with the mandatory banner.
    registerPaperRoutes(app, {
      pool: readPool,
      authService: options.authService,
    });
    // RFC-012 read surface: resolution-risk scores, the logical graph, its
    // violations, sanity vetoes and layer divergences, plus the curated-edge
    // POST. Analytics only — no route here creates an order or a signal.
    registerResolutionRoutes(app, {
      pool: readPool,
      authService: options.authService,
    });
    // RFC-013 read surface: the opportunity panel, exposures, limits, the
    // portfolio state machine, the RFC-009 gates and the decision log. The two
    // manual state controls (halt/resume) live here too and are deliberately
    // NOT published by the Nginx perimeter.
    registerPortfolioRoutes(app, {
      pool: readPool,
      authService: options.authService,
    });
    // RFC-015 operator dashboard: the overview aggregate and the event feed.
    // Read-only over the tables the surfaces above already expose; it exists so
    // the panel makes one call per cycle instead of eleven.
    registerOverviewRoutes(app, {
      pool: readPool,
      authService: options.authService,
      clock,
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    return reply.code(404).send({
      reason_code: "ROUTE_NOT_FOUND",
      correlation_id: request.id,
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error(
      {
        correlation_id: request.id,
        reason_code: "INTERNAL_ERROR",
        ...errorFields(error),
      },
      "request_failed",
    );
    return reply.code(500).send({
      reason_code: "INTERNAL_ERROR",
      correlation_id: request.id,
    });
  });

  if (options.authService === undefined) {
    app.log.info({ auth_state: "unavailable" }, "auth_disabled");
  }
  return app;
}
