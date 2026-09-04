// `GET /polymarket/overview` and `GET /polymarket/events` against real
// PostgreSQL. Skipped in the source-only gate; point GANSO_TEST_DATABASE_URL at
// a migrated throwaway database to run it.
//
// SIMULAÇÃO — SEM EXECUÇÃO REAL: read-only GETs over an empty schema.
//
// Why this file exists as well as overview.test.ts: the unit suite answers
// every query from a substring-matching fake pool, so a column that does not
// exist reads back as `[]` and the route answers 200. Production answered 500
// to 100 % of authenticated calls from PR #76 (01/09) to this fix, because
// `fills_24h` selected `occurred_at` from `paper_ledger_events`, whose column
// is `event_ts` (migration 0008). Only a real schema can catch that, and the
// aggregator names 20 tables — any one of them can drift the same way.

import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { DatabasePool, QueryResult } from "../../src/database.js";
import { registerOverviewRoutes } from "../../src/polymarket/overview.js";

type Row = Record<string, unknown>;

const DATABASE_URL = process.env.GANSO_TEST_DATABASE_URL;
const FIXED_NOW = new Date("2026-09-04T12:00:00.000Z");

let raw: pg.Pool | null = null;
let app: FastifyInstance | null = null;

/** The harness of overview.test.ts, with the fake pool swapped for a real one. */
const authService = {
  session(token: string) {
    return Promise.resolve(
      token === "good-token" ? { status: "ok" } : { status: "unauthenticated" },
    );
  },
};

const AUTH = { authorization: "Bearer good-token" };

function pool(): DatabasePool {
  const instance = raw;
  if (instance === null) {
    throw new Error("pool not initialised");
  }
  return {
    async query<R extends Row>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      const result = await instance.query<R>(text, params as unknown[]);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
    transaction() {
      return Promise.reject(new Error("unused: the panel is GET-only"));
    },
    end() {
      return Promise.resolve();
    },
  };
}

async function build(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  registerOverviewRoutes(instance, {
    pool: pool(),
    authService,
    clock: () => FIXED_NOW,
    gitSha: () => Promise.resolve(null),
  });
  await instance.ready();
  app = instance;
  return instance;
}

beforeAll(() => {
  if (DATABASE_URL !== undefined) {
    raw = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  }
});

afterEach(async () => {
  await app?.close();
  app = null;
});

afterAll(async () => {
  await raw?.end();
  raw = null;
});

describe.skipIf(DATABASE_URL === undefined)(
  "RFC-015 panel aggregator against real PostgreSQL",
  () => {
    it("answers 200 — every column the aggregator names exists", async () => {
      const instance = await build();
      const response = await instance.inject({
        method: "GET",
        url: "/polymarket/overview",
        headers: AUTH,
      });
      // Before the fix this is 500 / OVERVIEW_API_FAILED with
      // `column "occurred_at" does not exist`.
      expect(response.statusCode).toBe(200);
      const body = response.json() as Row;
      expect(body["reason_code"]).toBeUndefined();
      expect(body).toHaveProperty("paper");
      expect((body["paper"] as Row)["fills_24h"]).toBe(0);
    });

    it("answers 200 on the event feed too — its 9 sources are real tables", async () => {
      const instance = await build();
      const response = await instance.inject({
        method: "GET",
        url: "/polymarket/events",
        headers: AUTH,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ events: [] });
    });

    it("still refuses an unauthenticated call before touching the database", async () => {
      const instance = await build();
      const response = await instance.inject({
        method: "GET",
        url: "/polymarket/overview",
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        reason_code: "MISSING_BEARER_TOKEN",
      });
    });
  },
);
