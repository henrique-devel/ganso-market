import { describe, expect, it, vi } from "vitest";

import { SecretValue, type ApiConfig } from "../src/config.js";
import { buildApi } from "../src/server.js";

function configWithPassword(password: string): ApiConfig {
  return {
    executionMode: "paper",
    server: { host: "127.0.0.1", port: 3000 },
    database: {
      host: "postgres",
      port: 5432,
      name: "ganso_market",
      user: "ganso_market",
      password: new SecretValue(password),
      ssl: false,
      connectTimeoutMs: 1_000,
    },
    log: { level: "info" },
  };
}

describe("structured logging redaction", () => {
  it("redacts wrapped config secrets and explicitly marked password fields", async () => {
    let output = "";
    const config = configWithPassword("sensitive-unit-test-value");
    const app = buildApi({
      config,
      readinessProbe: { check: vi.fn() },
      logSink: {
        write(message: string): void {
          output += message;
        },
      },
    });

    config.database.password.use((password) => {
      app.log.info({ config, password }, "redaction_test");
    });
    await app.close();

    expect(output).toContain("redaction_test");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("sensitive-unit-test-value");
    for (const line of output.trim().split("\n")) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });

  it("never records query-string values in request logs", async () => {
    let output = "";
    const marker = "sensitive-query-marker";
    const app = buildApi({
      config: configWithPassword("unit-test-password"),
      readinessProbe: { check: vi.fn() },
      logSink: {
        write(message: string): void {
          output += message;
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/health/live?token=${marker}`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(output).toContain('"route":"/health/live"');
    expect(output).not.toContain(marker);
    for (const line of output.trim().split("\n")) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });

  it("records correlation-ID replacement without recording the rejected value", async () => {
    let output = "";
    const rejected = ".rejected-correlation";
    const app = buildApi({
      config: configWithPassword("unit-test-password"),
      readinessProbe: { check: vi.fn() },
      logSink: {
        write(message: string): void {
          output += message;
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-correlation-id": rejected },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-correlation-id"]).not.toBe(rejected);
    expect(output).toContain("CORRELATION_ID_REPLACED");
    expect(output).not.toContain(rejected);
  });
});
