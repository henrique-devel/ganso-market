import { describe, expect, it, vi } from "vitest";

import type {
  AuthService,
  LoginResult,
  RefreshResult,
  SessionResult,
  TokenBundle,
} from "../../src/auth/service.js";
import { SecretValue, type ApiConfig } from "../../src/config.js";
import { buildApi } from "../../src/server.js";

const SAME_ORIGIN_HEADERS = {
  host: "127.0.0.1:8080",
  origin: "http://127.0.0.1:8080",
};

function testConfig(): ApiConfig {
  return {
    executionMode: "paper",
    server: { host: "127.0.0.1", port: 3000 },
    database: {
      host: "postgres",
      port: 5432,
      name: "ganso_market",
      user: "ganso_market",
      password: new SecretValue("unit-test-password"),
      ssl: false,
      connectTimeoutMs: 1_000,
    },
    log: { level: "info" },
  };
}

function tokens(): TokenBundle {
  return {
    accessToken: "access-token-value",
    accessExpiresAt: new Date("2026-08-15T12:15:00.000Z"),
    refreshToken: "refresh-token-value",
    refreshExpiresAt: new Date("2026-08-22T12:00:00.000Z"),
    csrfToken: "csrf-token-value",
    username: "owner",
  };
}

function fakeService(overrides: Partial<AuthService> = {}): AuthService {
  return {
    login: (): Promise<LoginResult> =>
      Promise.resolve({ status: "ok", tokens: tokens() }),
    refresh: (): Promise<RefreshResult> =>
      Promise.resolve({ status: "ok", tokens: tokens() }),
    logout: (): Promise<void> => Promise.resolve(),
    session: (): Promise<SessionResult> =>
      Promise.resolve({
        status: "ok",
        username: "owner",
        expiresAt: new Date("2026-08-15T12:15:00.000Z"),
      }),
    ...overrides,
  };
}

function buildAuthApi(service: AuthService) {
  return buildApi({
    config: testConfig(),
    readinessProbe: { check: vi.fn() },
    authService: service,
    logger: false,
  });
}

describe("auth routes", () => {
  it("rejects login without a same-site Origin", async () => {
    const app = buildAuthApi(fakeService());
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { host: "127.0.0.1:8080" },
      payload: { username: "owner", password: "correct-horse-battery-staple" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      reason_code: "AUTH_ORIGIN_REJECTED",
    });
    await app.close();
  });

  it("rejects login when Origin host does not match Host", async () => {
    const app = buildAuthApi(fakeService());
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { host: "127.0.0.1:8080", origin: "http://evil.example" },
      payload: { username: "owner", password: "correct-horse-battery-staple" },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("sets HttpOnly refresh and CSRF cookies on successful login", async () => {
    const app = buildAuthApi(fakeService());
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: SAME_ORIGIN_HEADERS,
      payload: { username: "owner", password: "correct-horse-battery-staple" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      access_token: "access-token-value",
      token_type: "Bearer",
      username: "owner",
    });
    const setCookie = response.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const refresh = cookies.find((c) => c?.startsWith("ganso_refresh="));
    const csrf = cookies.find((c) => c?.startsWith("ganso_csrf="));
    expect(refresh).toContain("HttpOnly");
    expect(refresh).toContain("SameSite=Strict");
    expect(refresh).toContain("Path=/api/auth");
    expect(refresh).not.toContain("Secure");
    expect(csrf).toBeDefined();
    expect(csrf).not.toContain("HttpOnly");
    await app.close();
  });

  it("maps locked login to 429 with Retry-After", async () => {
    const app = buildAuthApi(
      fakeService({
        login: (): Promise<LoginResult> =>
          Promise.resolve({ status: "locked", retryAfterSeconds: 900 }),
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: SAME_ORIGIN_HEADERS,
      payload: { username: "owner", password: "bad" },
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("900");
    await app.close();
  });

  it("requires a matching CSRF token to refresh", async () => {
    const app = buildAuthApi(fakeService());
    const response = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie:
          "ganso_refresh=refresh-token-value; ganso_csrf=csrf-token-value",
        "x-csrf-token": "wrong-token",
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ reason_code: "AUTH_CSRF_INVALID" });
    await app.close();
  });

  it("rotates on a valid refresh with matching CSRF", async () => {
    const app = buildAuthApi(fakeService());
    const response = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie:
          "ganso_refresh=refresh-token-value; ganso_csrf=csrf-token-value",
        "x-csrf-token": "csrf-token-value",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ token_type: "Bearer" });
    await app.close();
  });

  it("clears cookies and returns 401 when refresh reuse is detected", async () => {
    const app = buildAuthApi(
      fakeService({
        refresh: (): Promise<RefreshResult> =>
          Promise.resolve({ status: "reuse_detected" }),
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie:
          "ganso_refresh=refresh-token-value; ganso_csrf=csrf-token-value",
        "x-csrf-token": "csrf-token-value",
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      reason_code: "AUTH_REFRESH_REUSE",
    });
    const setCookie = response.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    expect(cookies.some((c) => c?.includes("ganso_refresh=;"))).toBe(true);
    await app.close();
  });

  it("returns 401 when refresh cookie is missing", async () => {
    const app = buildAuthApi(fakeService());
    const response = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: {
        ...SAME_ORIGIN_HEADERS,
        cookie: "ganso_csrf=csrf-token-value",
        "x-csrf-token": "csrf-token-value",
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      reason_code: "AUTH_REFRESH_MISSING",
    });
    await app.close();
  });

  it("logs out with a valid CSRF token and clears cookies", async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    const app = buildAuthApi(fakeService({ logout }));
    const response = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        ...SAME_ORIGIN_HEADERS,
        authorization: "Bearer access-token-value",
        cookie: "ganso_csrf=csrf-token-value",
        "x-csrf-token": "csrf-token-value",
      },
    });
    expect(response.statusCode).toBe(204);
    expect(logout).toHaveBeenCalledWith("access-token-value");
    await app.close();
  });

  it("returns the session for a valid bearer token", async () => {
    const app = buildAuthApi(fakeService());
    const response = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { authorization: "Bearer access-token-value" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ username: "owner" });
    await app.close();
  });

  it("returns 401 for a session request without a bearer token", async () => {
    const app = buildAuthApi(fakeService());
    const response = await app.inject({ method: "GET", url: "/auth/session" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      reason_code: "AUTH_UNAUTHENTICATED",
    });
    await app.close();
  });
});
