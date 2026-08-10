import { randomUUID } from "node:crypto";

import Fastify, { LogController, type FastifyInstance } from "fastify";

import type { ApiConfig } from "./config.js";
import type { ReadinessProbe } from "./database.js";
import {
  POSTGRES_UNAVAILABLE,
  serviceHealthSchema,
  type ServiceHealth,
} from "./health.js";
import { createLoggerOptions, type LogSink } from "./logger.js";

const CORRELATION_ID_HEADER = "x-correlation-id";
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface BuildApiOptions {
  readonly config: ApiConfig;
  readonly readinessProbe: ReadinessProbe;
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
            error_name: error instanceof Error ? error.name : "UnknownError",
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

  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split("?", 1)[0];
    const reasonCode =
      path === "/auth/login"
        ? "AUTH_UNAVAILABLE_IN_RFC_001"
        : "ROUTE_NOT_FOUND";
    return reply.code(404).send({
      reason_code: reasonCode,
      correlation_id: request.id,
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error(
      {
        correlation_id: request.id,
        reason_code: "INTERNAL_ERROR",
        error_name: error instanceof Error ? error.name : "UnknownError",
      },
      "request_failed",
    );
    return reply.code(500).send({
      reason_code: "INTERNAL_ERROR",
      correlation_id: request.id,
    });
  });

  app.log.info(
    { auth_state: "unavailable", reason_code: "AUTH_UNAVAILABLE_IN_RFC_001" },
    "auth_disabled",
  );
  return app;
}
