import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  SecretValue,
  type ApiConfig,
  type StatementBudgets,
} from "../src/config.js";
import type {
  DatabasePool,
  QueryResult,
  SqlExecutor,
} from "../src/database.js";
import { buildApi } from "../src/server.js";

const REPO = new URL("../../../", import.meta.url).pathname;

function shippedBudgets(): StatementBudgets {
  const shipped = JSON.parse(
    readFileSync(join(REPO, "config/runtime.json"), "utf8"),
  ) as {
    services: {
      api: {
        statement_timeout_ms: {
          ceiling: number;
          default: number;
          routes: Record<string, number>;
        };
      };
    };
  };
  const declared = shipped.services.api.statement_timeout_ms;
  return {
    ceilingMs: declared.ceiling,
    defaultMs: declared.default,
    routes: declared.routes,
  };
}

/**
 * RFC-023 A4. A pool double that records everything, INCLUDING the two guard
 * statements — which is why it is here and not in `test/fixtures/read-only.ts`:
 * `pg_stat_activity` shows another backend's application_name but not its GUCs,
 * so the only place the per-route `SET LOCAL statement_timeout` can be observed
 * is at the executor.
 */
function recordingPool(): { pool: DatabasePool; statements: string[] } {
  const statements: string[] = [];
  const executor: SqlExecutor = {
    query<R extends Record<string, unknown>>(
      text: string,
    ): Promise<QueryResult<R>> {
      statements.push(text);
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  const pool: DatabasePool = {
    query: executor.query.bind(executor),
    transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      statements.push("BEGIN");
      return run(executor);
    },
    async readOnly<T>(
      statementTimeoutMs: number,
      run: (tx: SqlExecutor) => Promise<T>,
    ): Promise<T> {
      statements.push("BEGIN");
      statements.push("SET TRANSACTION READ ONLY");
      statements.push(
        `SET LOCAL statement_timeout = ${String(statementTimeoutMs)}`,
      );
      return run(executor);
    },
    end(): Promise<void> {
      return Promise.resolve();
    },
  };
  return { pool, statements };
}

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

const authService = {
  session(token: string) {
    return Promise.resolve(
      token === "good-token" ? { status: "ok" } : { status: "unauthenticated" },
    );
  },
};

const AUTH = { authorization: "Bearer good-token" };

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function build(): Promise<{
  instance: FastifyInstance;
  statements: string[];
}> {
  const { pool, statements } = recordingPool();
  const instance = buildApi({
    config: testConfig(),
    statementBudgets: shippedBudgets(),
    readinessProbe: { check: () => Promise.resolve() },
    authService: authService as never,
    pool,
    logger: false,
  });
  await instance.ready();
  app = instance;
  return { instance, statements };
}

/** A concrete request path for each declared route pattern. */
const SAMPLE_PARAMS: Readonly<Record<string, string>> = {
  ":tokenId": "12345",
  ":marketId": "0xabc",
  ":decisionId": "1",
  ":conditionId": "0xabc",
  ":modelId": "m@1.0.0",
};

/**
 * Query strings for routes that refuse to run without one.
 *
 * A route that answers 400 before touching the database runs no budgeted
 * query, and this test would read that as "the budget never applied" — which
 * is true, and useless. RFC-026 D10's two series routes are the first of the
 * kind: both require `metric` and a bounded `from`. Giving them a valid call
 * is what lets the assertion below actually check them.
 */
const SAMPLE_QUERY: Readonly<Record<string, () => string>> = {
  // `from` is relative to the real clock because the window ceiling is, and a
  // fixed date here would age into a 400 the day after it was written.
  "/polymarket/series": () =>
    `?tokens=12345&metric=ohlc&from=${new Date(Date.now() - 60_000).toISOString()}`,
  "/polymarket/series/:tokenId": () =>
    `?metric=ohlc&from=${new Date(Date.now() - 60_000).toISOString()}`,
};

function concretePath(pattern: string): string {
  const path = pattern
    .split("/")
    .map((segment) =>
      segment.startsWith(":") ? (SAMPLE_PARAMS[segment] ?? "1") : segment,
    )
    .join("/");
  return `${path}${SAMPLE_QUERY[pattern]?.() ?? ""}`;
}

describe("RFC-023 A4 — the declared budget is the one that runs", () => {
  const budgets = shippedBudgets();

  it("runs each published GET inside READ ONLY at that route's budget", async () => {
    const { instance, statements } = await build();

    for (const [route, expected] of Object.entries(budgets.routes)) {
      statements.length = 0;
      const response = await instance.inject({
        method: "GET",
        url: concretePath(route),
        headers: AUTH,
      });
      // A handler-level 404 ("no such market") is fine — what matters is that
      // the query the handler did run carried this route's budget. Fastify's
      // own miss is the one that would mean the pattern in config no longer
      // names a registered route, and it is the only one that says
      // ROUTE_NOT_FOUND.
      const reasonCode =
        response.statusCode === 404
          ? (response.json() as { reason_code?: string }).reason_code
          : undefined;
      expect(reasonCode, `${route} is not a registered route`).not.toBe(
        "ROUTE_NOT_FOUND",
      );

      const budgetSets = statements.filter((text) =>
        text.startsWith("SET LOCAL statement_timeout"),
      );
      expect(
        budgetSets.length,
        `${route} ran no budgeted query`,
      ).toBeGreaterThan(0);
      for (const set of budgetSets) {
        expect(set, route).toBe(
          `SET LOCAL statement_timeout = ${String(expected)}`,
        );
      }
      // Every budgeted read is also a READ ONLY transaction.
      expect(
        statements.filter((text) => text === "SET TRANSACTION READ ONLY")
          .length,
        route,
      ).toBe(budgetSets.length);
    }
  });

  it("leaves the published POST outside READ ONLY", async () => {
    const { instance, statements } = await build();
    statements.length = 0;

    // The kill-switch rearm: the one write the perimeter publishes. It must
    // reach the database as a plain transaction, or it could not write.
    await instance.inject({
      method: "POST",
      url: "/polymarket/paper/kill-switch/rearm",
      headers: AUTH,
      payload: {},
    });

    expect(statements).not.toContain("SET TRANSACTION READ ONLY");
    expect(
      statements.filter((text) =>
        text.startsWith("SET LOCAL statement_timeout"),
      ),
    ).toEqual([]);
  });

  it("falls back to default on a GET the map does not name", async () => {
    const { instance, statements } = await build();
    statements.length = 0;

    // /polymarket/markets is registered but not published, so it has no entry.
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/markets",
      headers: AUTH,
    });
    expect(response.statusCode).not.toBe(404);
    const budgetSets = statements.filter((text) =>
      text.startsWith("SET LOCAL statement_timeout"),
    );
    expect(budgetSets.length).toBeGreaterThan(0);
    for (const set of budgetSets) {
      expect(set).toBe(
        `SET LOCAL statement_timeout = ${String(budgets.defaultMs)}`,
      );
    }
  });
});
