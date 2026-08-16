import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  AUTH_COOKIE_PATH,
  clearCookie,
  CSRF_COOKIE_NAME,
  parseCookies,
  REFRESH_COOKIE_NAME,
  serializeCookie,
} from "./cookies.js";
import {
  REFRESH_TTL_SECONDS,
  type AuthService,
  type TokenBundle,
} from "./service.js";
import { timingSafeEqualHex } from "./tokens.js";

export interface RegisterAuthRoutesOptions {
  readonly service: AuthService;
  // Secure flag for cookies; false while the beta serves over HTTP.
  readonly cookieSecure?: boolean;
}

function jsonError(
  reply: FastifyReply,
  statusCode: number,
  reasonCode: string,
): FastifyReply {
  return reply
    .code(statusCode)
    .send({ reason_code: reasonCode, correlation_id: reply.request.id });
}

// Every mutating request must originate from the same site: Origin must be
// present and its host must equal the Host header (AUTH-11). Returns a reason
// code when the check fails.
function sameOriginViolation(request: FastifyRequest): string | null {
  const host = request.headers.host;
  if (typeof host !== "string" || host.length === 0) {
    return "HOST_HEADER_MISSING";
  }
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) {
    return "ORIGIN_HEADER_MISSING";
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return "ORIGIN_HEADER_INVALID";
  }
  if (originHost !== host) {
    return "ORIGIN_HOST_MISMATCH";
  }
  return null;
}

function csrfValid(request: FastifyRequest): boolean {
  const header = request.headers["x-csrf-token"];
  const jar = parseCookies(request.headers.cookie);
  const cookie = jar.get(CSRF_COOKIE_NAME);
  if (typeof header !== "string" || cookie === undefined) {
    return false;
  }
  return timingSafeEqualHex(header, cookie);
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") {
    return null;
  }
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1] ?? null;
}

function setSessionCookies(
  reply: FastifyReply,
  tokens: TokenBundle,
  cookieSecure: boolean,
): void {
  reply.header("set-cookie", [
    serializeCookie(REFRESH_COOKIE_NAME, tokens.refreshToken, {
      maxAgeSeconds: REFRESH_TTL_SECONDS,
      httpOnly: true,
      secure: cookieSecure,
    }),
    serializeCookie(CSRF_COOKIE_NAME, tokens.csrfToken, {
      maxAgeSeconds: REFRESH_TTL_SECONDS,
      httpOnly: false,
      secure: cookieSecure,
    }),
  ]);
}

function clearSessionCookies(reply: FastifyReply): void {
  reply.header("set-cookie", [
    clearCookie(REFRESH_COOKIE_NAME, true),
    clearCookie(CSRF_COOKIE_NAME, false),
  ]);
}

function isCredentialBody(
  body: unknown,
): body is { username: string; password: string } {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as Record<string, unknown>).username === "string" &&
    typeof (body as Record<string, unknown>).password === "string"
  );
}

export function registerAuthRoutes(
  app: FastifyInstance,
  options: RegisterAuthRoutesOptions,
): void {
  const { service } = options;
  const cookieSecure = options.cookieSecure ?? false;

  app.post("/auth/login", async (request, reply) => {
    const violation = sameOriginViolation(request);
    if (violation !== null) {
      return jsonError(reply, 403, "AUTH_ORIGIN_REJECTED");
    }
    if (!isCredentialBody(request.body)) {
      return jsonError(reply, 400, "AUTH_REQUEST_INVALID");
    }
    const result = await service.login(
      request.body.username,
      request.body.password,
    );
    if (result.status === "locked") {
      reply.header("retry-after", String(result.retryAfterSeconds));
      return jsonError(reply, 429, "AUTH_TEMPORARILY_LOCKED");
    }
    if (result.status === "invalid_credentials") {
      return jsonError(reply, 401, "AUTH_INVALID_CREDENTIALS");
    }
    setSessionCookies(reply, result.tokens, cookieSecure);
    request.log.info(
      { correlation_id: request.id, event_type: "AUTH_LOGIN_SUCCEEDED" },
      "auth_login_succeeded",
    );
    return reply.code(200).send({
      access_token: result.tokens.accessToken,
      token_type: "Bearer",
      expires_at: result.tokens.accessExpiresAt.toISOString(),
      username: result.tokens.username,
    });
  });

  app.post("/auth/refresh", async (request, reply) => {
    const violation = sameOriginViolation(request);
    if (violation !== null) {
      return jsonError(reply, 403, "AUTH_ORIGIN_REJECTED");
    }
    if (!csrfValid(request)) {
      return jsonError(reply, 403, "AUTH_CSRF_INVALID");
    }
    const jar = parseCookies(request.headers.cookie);
    const refreshToken = jar.get(REFRESH_COOKIE_NAME);
    if (refreshToken === undefined) {
      return jsonError(reply, 401, "AUTH_REFRESH_MISSING");
    }
    const result = await service.refresh(refreshToken);
    if (result.status === "reuse_detected") {
      clearSessionCookies(reply);
      request.log.warn(
        { correlation_id: request.id, reason_code: "AUTH_REFRESH_REUSE" },
        "auth_refresh_reuse_detected",
      );
      return jsonError(reply, 401, "AUTH_REFRESH_REUSE");
    }
    if (result.status === "invalid") {
      clearSessionCookies(reply);
      return jsonError(reply, 401, "AUTH_REFRESH_INVALID");
    }
    setSessionCookies(reply, result.tokens, cookieSecure);
    return reply.code(200).send({
      access_token: result.tokens.accessToken,
      token_type: "Bearer",
      expires_at: result.tokens.accessExpiresAt.toISOString(),
    });
  });

  app.post("/auth/logout", async (request, reply) => {
    const violation = sameOriginViolation(request);
    if (violation !== null) {
      return jsonError(reply, 403, "AUTH_ORIGIN_REJECTED");
    }
    if (!csrfValid(request)) {
      return jsonError(reply, 403, "AUTH_CSRF_INVALID");
    }
    const token = bearerToken(request);
    if (token !== null) {
      await service.logout(token);
    }
    clearSessionCookies(reply);
    return reply.code(204).send();
  });

  app.get("/auth/session", async (request, reply) => {
    const token = bearerToken(request);
    if (token === null) {
      return jsonError(reply, 401, "AUTH_UNAUTHENTICATED");
    }
    const result = await service.session(token);
    if (result.status === "unauthenticated") {
      return jsonError(reply, 401, "AUTH_UNAUTHENTICATED");
    }
    return reply.code(200).send({
      username: result.username,
      expires_at: result.expiresAt.toISOString(),
    });
  });

  app.log.info(
    { auth_state: "enabled", cookie_path: AUTH_COOKIE_PATH },
    "auth_enabled",
  );
}
