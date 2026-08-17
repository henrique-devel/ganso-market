import { describe, expect, it, vi } from "vitest";

import { SecretValue, type ApiConfig } from "../src/config.js";
import { POSTGRES_UNAVAILABLE } from "../src/health.js";
import { buildApi } from "../src/server.js";

const FIXED_TIME = new Date("2026-08-10T12:00:00.000Z");

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

describe("API operational endpoints", () => {
  it("reports liveness with the ServiceHealth v1 shape and correlation ID", async () => {
    const app = buildApi({
      config: testConfig(),
      readinessProbe: { check: vi.fn() },
      logger: false,
      clock: () => FIXED_TIME,
    });

    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-correlation-id": "request-123" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-correlation-id"]).toBe("request-123");
    expect(response.json()).toEqual({
      service: "api",
      status: "live",
      checked_at: FIXED_TIME.toISOString(),
      execution_mode: "paper",
      correlation_id: "request-123",
      reason_codes: [],
      checks: [],
    });
    await app.close();
  });

  it("replaces an oversized inbound correlation ID", async () => {
    const app = buildApi({
      config: testConfig(),
      readinessProbe: { check: vi.fn() },
      logger: false,
      clock: () => FIXED_TIME,
    });
    const oversized = "a".repeat(65);

    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-correlation-id": oversized },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-correlation-id"]).not.toBe(oversized);
    expect(response.json()).toMatchObject({
      correlation_id: response.headers["x-correlation-id"],
    });
    await app.close();
  });

  it("reports ready only after PostgreSQL SELECT 1 succeeds", async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const app = buildApi({
      config: testConfig(),
      readinessProbe: { check },
      logger: false,
      clock: () => FIXED_TIME,
    });

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(check).toHaveBeenCalledOnce();
    expect(response.json()).toMatchObject({
      service: "api",
      status: "ready",
      execution_mode: "paper",
      reason_codes: [],
      checks: [{ name: "postgres", status: "ready", reason_codes: [] }],
    });
    await app.close();
  });

  it("fails readiness closed with a stable reason code", async () => {
    const app = buildApi({
      config: testConfig(),
      readinessProbe: {
        check: vi.fn().mockRejectedValue(new Error("database unavailable")),
      },
      logger: false,
      clock: () => FIXED_TIME,
    });

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      service: "api",
      status: "not_ready",
      checked_at: FIXED_TIME.toISOString(),
      execution_mode: "paper",
      reason_codes: [POSTGRES_UNAVAILABLE],
      checks: [
        {
          name: "postgres",
          status: "not_ready",
          reason_codes: [POSTGRES_UNAVAILABLE],
        },
      ],
    });
    await app.close();
  });

  it("does not register auth routes when no auth service is provided", async () => {
    const app = buildApi({
      config: testConfig(),
      readinessProbe: { check: vi.fn() },
      logger: false,
      clock: () => FIXED_TIME,
    });

    expect(app.hasRoute({ method: "POST", url: "/auth/login" })).toBe(false);
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "owner", password: "not-processed" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      reason_code: "ROUTE_NOT_FOUND",
    });
    await app.close();
  });

  it("exposes internal metrics without probing the database", async () => {
    const check = vi.fn();
    const app = buildApi({
      config: testConfig(),
      readinessProbe: { check },
      logger: false,
      uptimeSeconds: () => 12,
    });

    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("ganso_api_up 1");
    expect(response.body).toContain("ganso_api_process_uptime_seconds 12");
    expect(check).not.toHaveBeenCalled();
    await app.close();
  });
});
