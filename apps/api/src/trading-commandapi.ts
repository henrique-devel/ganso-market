import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DeskCommand } from "@ganso-market/contracts/trading";
import type { AuthService } from "./auth/service.js";
import type { DatabasePool } from "./database.js";
import { csrfValid, sameOriginViolation } from "./auth/http.js";
import {
  acceptDeskCommand,
  previewDeskCommand,
  validateDeskCommand,
  DeskCommandError,
} from "./storage/desk-commandstore.js";

export function registerTradingCommandRoutes(
  app: FastifyInstance,
  deps: {
    pool: Pick<DatabasePool, "transaction" | "readOnly">;
    authService: Pick<AuthService, "session">;
  },
) {
  const error = (reply: FastifyReply, status: number, code: string) =>
    reply.code(status).send({
      schema_version: "trading.commands.v1",
      mode: "paper",
      simulation: "SIMULAÇÃO",
      reason_code: code,
      correlation_id: reply.request.id,
    });
  async function guard(request: FastifyRequest, reply: FastifyReply) {
    reply.header("Cache-Control", "no-store");
    const token = /^Bearer (.+)$/.exec(
      request.headers.authorization ?? "",
    )?.[1];
    if (!token || (await deps.authService.session(token)).status !== "ok")
      return error(reply, 401, "AUTH_UNAUTHENTICATED");
    const violation = sameOriginViolation(request);
    if (violation) return error(reply, 403, violation);
    if (!csrfValid(request)) return error(reply, 403, "CSRF_INVALID");
  }
  function handler(action: DeskCommand["action"] | "preview") {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const token = request.headers.authorization!.slice(7),
        key = request.headers["idempotency-key"];
      try {
        if (Object.keys(request.query as object).length)
          throw new DeskCommandError(400, "TRADING_INVALID_COMMAND");
        if (action === "preview") {
          validateDeskCommand(request.body, key);
          return await previewDeskCommand(
            deps.pool,
            token,
            request.body,
            key as string,
          );
        }
        const body = request.body as { intent?: unknown } | null;
        if (
          !body ||
          typeof body !== "object" ||
          Object.keys(body).join() !== "intent" ||
          typeof key !== "string"
        )
          throw new DeskCommandError(400, "TRADING_INVALID_COMMAND");
        return await acceptDeskCommand(
          deps.pool,
          token,
          action,
          body.intent,
          key,
        );
      } catch (e) {
        if (e instanceof DeskCommandError)
          return error(reply, e.status, e.code);
        if (e instanceof Error && /^BTC_[A-Z0-9_]+$/.test(e.message))
          return error(reply, 409, e.message);
        // Structured contract validation errors contain no caller payload in the response.
        if (
          e instanceof Error &&
          "reasonCode" in e &&
          typeof e.reasonCode === "string" &&
          /^(TRADING|BTC_PASSIVE)_[A-Z0-9_]+$/.test(e.reasonCode)
        )
          return error(
            reply,
            e.reasonCode.startsWith("BTC_") ? 409 : 400,
            e.reasonCode,
          );
        request.log.error(
          { reason_code: "TRADING_COMMAND_UNAVAILABLE" },
          "trading_command_failed",
        );
        return error(reply, 503, "TRADING_COMMAND_UNAVAILABLE");
      }
    };
  }
  const options = { preHandler: guard, bodyLimit: 20000 };
  app.post("/trading/preview", options, handler("preview"));
  app.post("/trading/submit", options, handler("submit"));
  app.post("/trading/cancel", options, handler("cancel"));
  app.post("/trading/close", options, handler("close"));
  app.post("/trading/pause", options, handler("pause"));
}
