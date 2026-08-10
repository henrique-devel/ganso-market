import { describe, expect, it } from "vitest";

import {
  API_CONFIG_FILE_ENV,
  API_SECRET_FILE_ENV,
  loadConfig,
} from "../src/config.js";

function memoryReader(files: Readonly<Record<string, string>>) {
  return async (path: string): Promise<string> => {
    const content = files[path];
    if (content === undefined) {
      throw new Error("missing test file");
    }
    return content;
  };
}

describe("loadConfig", () => {
  it("applies defaults, then non-secret JSON, then the mounted secret", async () => {
    const config = await loadConfig({
      env: {
        [API_CONFIG_FILE_ENV]: "/config/runtime.json",
        [API_SECRET_FILE_ENV]: "/secrets/postgres_password",
      },
      readTextFile: memoryReader({
        "/config/runtime.json": JSON.stringify({
          schema_version: 1,
          execution_mode: "paper",
          database: {
            host: "database.internal",
            connect_timeout_ms: 1_500,
          },
          services: {
            api: { bind_address: "127.0.0.1", port: 3100 },
            market_engine: { bind_address: "127.0.0.1", port: 8081 },
            model_worker: { bind_address: "127.0.0.1", port: 8090 },
          },
          logging: { level: "debug" },
        }),
        "/secrets/postgres_password": "unit-test-password\n",
      }),
    });

    expect(config).toMatchObject({
      executionMode: "paper",
      server: { host: "127.0.0.1", port: 3100 },
      database: {
        host: "database.internal",
        port: 5432,
        name: "ganso_market",
        user: "ganso_market",
        ssl: false,
        connectTimeoutMs: 1_500,
      },
      log: { level: "debug" },
    });
    expect(JSON.stringify(config)).not.toContain("unit-test-password");
    expect(String(config.database.password)).toBe("[REDACTED]");
  });

  it("rejects live execution mode", async () => {
    const promise = loadConfig({
      env: {
        [API_CONFIG_FILE_ENV]: "/config/runtime.json",
        [API_SECRET_FILE_ENV]: "/secrets/postgres_password",
      },
      readTextFile: memoryReader({
        "/config/runtime.json": JSON.stringify({ execution_mode: "live" }),
        "/secrets/postgres_password": "unit-test-password",
      }),
    });

    await expect(promise).rejects.toMatchObject({
      name: "ConfigError",
      reasonCode: "CONFIG_FIELD_INVALID",
    });
  });

  it("rejects secret fields in the non-secret JSON", async () => {
    const promise = loadConfig({
      env: {
        [API_CONFIG_FILE_ENV]: "/config/runtime.json",
        [API_SECRET_FILE_ENV]: "/secrets/postgres_password",
      },
      readTextFile: memoryReader({
        "/config/runtime.json": JSON.stringify({
          database: { password: "must-not-be-here" },
        }),
        "/secrets/postgres_password": "unit-test-password",
      }),
    });

    await expect(promise).rejects.toMatchObject({
      reasonCode: "CONFIG_FIELD_UNKNOWN",
    });
  });

  it("fails closed when the secret-file locator is absent", async () => {
    const promise = loadConfig({ env: {}, readTextFile: memoryReader({}) });

    await expect(promise).rejects.toMatchObject({
      reasonCode: "SECRET_FILE_REQUIRED",
    });
  });

  it("rejects multiline secret-file content", async () => {
    const promise = loadConfig({
      env: { [API_SECRET_FILE_ENV]: "/secrets/postgres_password" },
      readTextFile: memoryReader({
        "/secrets/postgres_password": "line-one\nline-two\n",
      }),
    });

    await expect(promise).rejects.toMatchObject({
      reasonCode: "SECRET_FILE_INVALID",
    });
  });

  it("rejects an oversized secret file", async () => {
    const promise = loadConfig({
      env: { [API_SECRET_FILE_ENV]: "/secrets/postgres_password" },
      readTextFile: memoryReader({
        "/secrets/postgres_password": "x".repeat(4_097),
      }),
    });

    await expect(promise).rejects.toMatchObject({
      reasonCode: "SECRET_FILE_INVALID",
    });
  });
});
