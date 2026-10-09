import { activateJevLive, rearmJevLive } from "./storage/jev-promotion.js";
import { commandJevQueue } from "./storage/jev-queue.js";
import { commandJevOperator } from "./storage/jev-operator.js";
import { sameOriginViolation, csrfValid } from "./auth/http.js";
import {
  recordJevInfrastructure,
  JevPanelCommandError,
} from "./storage/jev-infrastructure.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthService } from "./auth/service.js";
import type { DatabasePool } from "./database.js";
import { readJevPanel } from "./storage/jev-panel.js";
export function registerJevPanelRoutes(
  app: FastifyInstance,
  deps: {
    pool: Pick<DatabasePool, "readOnly" | "transaction">;
    authService: Pick<AuthService, "session">;
  },
) {
  const owners = new WeakMap<FastifyRequest, string>();
  let busy = false;
  async function guard(request: FastifyRequest, reply: FastifyReply) {
    reply.header("Cache-Control", "no-store");
    const token = /^Bearer (.+)$/.exec(
      request.headers.authorization ?? "",
    )?.[1];
    const session = token ? await deps.authService.session(token) : null;
    if (session?.status !== "ok" || !session.username)
      return reply.code(401).send({ reason_code: "AUTH_UNAUTHENTICATED" });
    owners.set(request, session.username);
  }
  function liveHandler(command: typeof activateJevLive | typeof rearmJevLive) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const violation = sameOriginViolation(request);
      if (violation) return reply.code(403).send({ reason_code: violation });
      if (!csrfValid(request))
        return reply.code(403).send({ reason_code: "CSRF_INVALID" });
      try {
        const key = request.headers["idempotency-key"];
        if (
          typeof key !== "string" ||
          Object.keys(request.query as object).length
        )
          throw new JevPanelCommandError(400, "JEV_LIVE_INVALID_COMMAND");
        return await command(
          deps.pool,
          owners.get(request)!,
          request.body,
          key,
        );
      } catch (e) {
        return reply
          .code(e instanceof JevPanelCommandError ? e.status : 503)
          .send({
            reason_code:
              e instanceof JevPanelCommandError
                ? e.code
                : "JEV_LIVE_UNAVAILABLE",
          });
      }
    };
  }
  app.post(
    "/trading/jev/activate",
    { preHandler: guard, bodyLimit: 2048 },
    liveHandler(activateJevLive),
  );
  app.post(
    "/trading/jev/rearm",
    { preHandler: guard, bodyLimit: 2048 },
    liveHandler(rearmJevLive),
  );
  app.post(
    "/trading/jev/control",
    { preHandler: guard, bodyLimit: 2048 },
    async (request, reply) => {
      const violation = sameOriginViolation(request);
      if (violation) return reply.code(403).send({ reason_code: violation });
      if (!csrfValid(request))
        return reply.code(403).send({ reason_code: "CSRF_INVALID" });
      try {
        if (Object.keys(request.query as object).length)
          throw new JevPanelCommandError(400, "JEV_PANEL_INVALID_COMMAND");
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string")
          throw new JevPanelCommandError(400, "JEV_PANEL_INVALID_COMMAND");
        return await commandJevOperator(
          deps.pool,
          owners.get(request)!,
          request.body,
          key,
        );
      } catch (e) {
        return reply
          .code(e instanceof JevPanelCommandError ? e.status : 503)
          .send({
            reason_code:
              e instanceof JevPanelCommandError
                ? e.code
                : "JEV_PANEL_COMMAND_UNAVAILABLE",
          });
      }
    },
  );
  app.post(
    "/trading/jev/infrastructure",
    { preHandler: guard, bodyLimit: 2048 },
    async (request, reply) => {
      const violation = sameOriginViolation(request);
      if (violation) return reply.code(403).send({ reason_code: violation });
      if (!csrfValid(request))
        return reply.code(403).send({ reason_code: "CSRF_INVALID" });
      try {
        if (Object.keys(request.query as object).length)
          throw new JevPanelCommandError(400, "JEV_PANEL_INVALID_COMMAND");
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string")
          throw new JevPanelCommandError(400, "JEV_PANEL_INVALID_COMMAND");
        return await recordJevInfrastructure(
          deps.pool,
          owners.get(request)!,
          request.body,
          key,
        );
      } catch (e) {
        return reply
          .code(e instanceof JevPanelCommandError ? e.status : 503)
          .send({
            reason_code:
              e instanceof JevPanelCommandError
                ? e.code
                : "JEV_PANEL_COMMAND_UNAVAILABLE",
          });
      }
    },
  );
  app.post(
    "/trading/jev/queue",
    { preHandler: guard, bodyLimit: 2048 },
    async (request, reply) => {
      const violation = sameOriginViolation(request);
      if (violation) return reply.code(403).send({ reason_code: violation });
      if (!csrfValid(request))
        return reply.code(403).send({ reason_code: "CSRF_INVALID" });
      try {
        if (Object.keys(request.query as object).length)
          throw new JevPanelCommandError(400, "JEV_QUEUE_INVALID_COMMAND");
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string")
          throw new JevPanelCommandError(400, "JEV_QUEUE_INVALID_COMMAND");
        return await commandJevQueue(
          deps.pool,
          owners.get(request)!,
          request.body,
          key,
        );
      } catch (e) {
        return reply
          .code(e instanceof JevPanelCommandError ? e.status : 503)
          .send({
            reason_code:
              e instanceof JevPanelCommandError
                ? e.code
                : "JEV_QUEUE_UNAVAILABLE",
          });
      }
    },
  );
  app.get(
    "/trading/jev/panel",
    { preHandler: guard },
    async (request, reply) => {
      if (Object.keys(request.query as object).length)
        return reply.code(400).send({ reason_code: "JEV_PANEL_INVALID_QUERY" });
      if (busy) return reply.code(503).send({ reason_code: "JEV_PANEL_BUSY" });
      busy = true;
      try {
        return await readJevPanel(deps.pool, owners.get(request)!);
      } catch {
        return reply.code(503).send({ reason_code: "JEV_PANEL_UNAVAILABLE" });
      } finally {
        busy = false;
      }
    },
  );
}
