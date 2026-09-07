import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  API_CONFIG_FILE_ENV,
  API_SECRET_FILE_ENV,
  ConfigError,
  loadConfig,
  requireStatementBudgets,
  STATEMENT_TIMEOUT_CEILING_MAX,
  type StatementBudgets,
} from "../src/config.js";
import { budgetForRoute } from "../src/budgets.js";

function memoryReader(files: Readonly<Record<string, string>>) {
  return async (path: string): Promise<string> => {
    const content = files[path];
    if (content === undefined) {
      throw new Error("missing test file");
    }
    return content;
  };
}

async function load(api: Record<string, unknown>) {
  return loadConfig({
    env: {
      [API_CONFIG_FILE_ENV]: "/config/runtime.json",
      [API_SECRET_FILE_ENV]: "/secrets/postgres_password",
    },
    readTextFile: memoryReader({
      "/config/runtime.json": JSON.stringify({
        schema_version: 1,
        services: { api },
      }),
      "/secrets/postgres_password": "unit-test-password\n",
    }),
  });
}

const VALID = {
  bind_address: "0.0.0.0",
  port: 3000,
  statement_timeout_ms: {
    ceiling: 4_000,
    default: 2_000,
    routes: { "/polymarket/overview": 1_500 },
  },
};

describe("RFC-023 D1 — services.api.statement_timeout_ms", () => {
  it("parses ceiling, default and the route map", async () => {
    const config = await load(VALID);
    const budgets = requireStatementBudgets(config);
    expect(budgets.ceilingMs).toBe(4_000);
    expect(budgets.defaultMs).toBe(2_000);
    expect(budgets.routes["/polymarket/overview"]).toBe(1_500);
  });

  it("refuses a ceiling above the edge's own timeout", async () => {
    // `proxy_read_timeout 5s` in infra/nginx/nginx.conf: a budget above 4 s can
    // never fire before Nginx gives up, so it is a budget in name only.
    await expect(
      load({
        ...VALID,
        statement_timeout_ms: {
          ceiling: STATEMENT_TIMEOUT_CEILING_MAX + 1,
          default: 2_000,
        },
      }),
    ).rejects.toThrow(ConfigError);
  });

  it("refuses a route budget above the ceiling", async () => {
    await expect(
      load({
        ...VALID,
        statement_timeout_ms: {
          ceiling: 2_000,
          default: 1_000,
          routes: { "/polymarket/overview": 2_001 },
        },
      }),
    ).rejects.toThrow(/routes\.\/polymarket\/overview/);
  });

  it("refuses a default above the ceiling", async () => {
    await expect(
      load({
        ...VALID,
        statement_timeout_ms: { ceiling: 1_000, default: 1_001 },
      }),
    ).rejects.toThrow(/default/);
  });

  it("refuses a budget below the 100 ms floor", async () => {
    await expect(
      load({
        ...VALID,
        statement_timeout_ms: { ceiling: 4_000, default: 99 },
      }),
    ).rejects.toThrow(ConfigError);
  });

  it("refuses an unknown key inside statement_timeout_ms", async () => {
    await expect(
      load({
        ...VALID,
        statement_timeout_ms: { ceiling: 4_000, default: 2_000, celing: 1_000 },
      }),
    ).rejects.toThrow(/celing is not allowed/);
  });

  it("refuses a route key that is not a path", async () => {
    await expect(
      load({
        ...VALID,
        statement_timeout_ms: {
          ceiling: 4_000,
          default: 2_000,
          routes: { "polymarket/overview": 500 },
        },
      }),
    ).rejects.toThrow(/starting with/);
  });

  it("does not accept statement_timeout_ms on the other services", async () => {
    await expect(
      loadConfig({
        env: {
          [API_CONFIG_FILE_ENV]: "/config/runtime.json",
          [API_SECRET_FILE_ENV]: "/secrets/postgres_password",
        },
        readTextFile: memoryReader({
          "/config/runtime.json": JSON.stringify({
            schema_version: 1,
            services: {
              api: VALID,
              model_worker: {
                port: 8090,
                statement_timeout_ms: { ceiling: 1_000, default: 500 },
              },
            },
          }),
          "/secrets/postgres_password": "unit-test-password\n",
        }),
      }),
    ).rejects.toThrow(/statement_timeout_ms is not allowed/);
  });

  it("fails closed with QUERY_TIMEOUT_UNDECLARED when the key is absent", async () => {
    const config = await load({ bind_address: "0.0.0.0", port: 3000 });
    expect(config.statementBudgets).toBeUndefined();
    expect(() => requireStatementBudgets(config)).toThrow(
      expect.objectContaining({
        reasonCode: "QUERY_TIMEOUT_UNDECLARED",
      }) as Error,
    );
  });
});

describe("RFC-023 D1 — budgetForRoute", () => {
  const budgets: StatementBudgets = {
    ceilingMs: 4_000,
    defaultMs: 2_000,
    routes: { "/polymarket/overview": 1_500 },
  };

  it("uses the route's own budget when it has one", () => {
    expect(budgetForRoute(budgets, "/polymarket/overview")).toBe(1_500);
  });

  it("falls back to default for a route with no entry", () => {
    expect(budgetForRoute(budgets, "/polymarket/markets")).toBe(2_000);
    expect(budgetForRoute(budgets, undefined)).toBe(2_000);
  });
});

describe("RFC-023 D1 — the shipped config/runtime.json", () => {
  const shipped = JSON.parse(
    readFileSync(
      new URL("../../../config/runtime.json", import.meta.url),
      "utf8",
    ),
  ) as {
    services: {
      api: {
        statement_timeout_ms?: {
          ceiling: number;
          default: number;
          routes: Record<string, number>;
        };
      };
    };
  };

  it("declares budgets at all — the API does not boot without them", () => {
    expect(shipped.services.api.statement_timeout_ms).toBeDefined();
  });

  it("keeps every declared budget inside the ceiling", () => {
    const declared = shipped.services.api.statement_timeout_ms;
    expect(declared).toBeDefined();
    if (declared === undefined) {
      return;
    }
    expect(declared.ceiling).toBeLessThanOrEqual(STATEMENT_TIMEOUT_CEILING_MAX);
    expect(declared.default).toBeLessThanOrEqual(declared.ceiling);
    for (const [route, ms] of Object.entries(declared.routes)) {
      expect(ms, route).toBeGreaterThanOrEqual(100);
      expect(ms, route).toBeLessThanOrEqual(declared.ceiling);
    }
  });
});
