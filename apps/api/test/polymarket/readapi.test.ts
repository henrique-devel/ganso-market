import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type {
  DatabasePool,
  QueryResult,
  SqlExecutor,
} from "../../src/database.js";
import { RETENTION_TABLES } from "../../src/polymarket/retention.js";
import {
  registerPolymarketReadRoutes,
  type AuthSessionService,
  type BookAtFn,
  type DeltasPageFn,
  type PolymarketReadRoutesDeps,
} from "../../src/polymarket/readapi.js";

type Row = Record<string, unknown>;
type Responder = (text: string, params: readonly unknown[]) => Row[];

interface CapturedQuery {
  readonly text: string;
  readonly params: readonly unknown[];
}

function fakePool(respond: Responder = () => []): {
  pool: DatabasePool;
  calls: CapturedQuery[];
} {
  const calls: CapturedQuery[] = [];
  const pool: DatabasePool = {
    query<R extends Row>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      const captured = [...(params ?? [])];
      calls.push({ text, params: captured });
      const rows = respond(text, captured) as R[];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
    transaction() {
      return Promise.reject(new Error("unused"));
    },
    // RFC-023 D1 pass-through; see `test/fixtures/read-only.ts`.
    readOnly<T>(
      _statementTimeoutMs: number,
      run: (tx: SqlExecutor) => Promise<T>,
    ): Promise<T> {
      return run(this as unknown as SqlExecutor);
    },
    end() {
      return Promise.resolve();
    },
  };
  return { pool, calls };
}

const authService: AuthSessionService = {
  session(token: string) {
    return Promise.resolve(
      token === "good-token" ? { status: "ok" } : { status: "unauthenticated" },
    );
  },
};

const AUTH = { authorization: "Bearer good-token" };
const FIXED_NOW = new Date("2026-08-19T12:00:00.000Z");

let app: FastifyInstance | null = null;

async function buildApp(
  overrides: Partial<PolymarketReadRoutesDeps> & { pool: DatabasePool },
): Promise<FastifyInstance> {
  app = Fastify({ logger: false });
  registerPolymarketReadRoutes(app, {
    authService,
    clock: () => FIXED_NOW,
    ...overrides,
  });
  await app.ready();
  return app;
}

afterEach(async () => {
  if (app !== null) {
    await app.close();
    app = null;
  }
});

describe("auth guard", () => {
  it("rejects requests without a bearer token with 401", async () => {
    const { pool, calls } = fakePool();
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/markets",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      reason_code: "AUTH_UNAUTHENTICATED",
    });
    expect(response.json().correlation_id).toBeTypeOf("string");
    expect(calls).toHaveLength(0);
  });

  it("rejects an invalid token with 401", async () => {
    const { pool, calls } = fakePool();
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/markets",
      headers: { authorization: "Bearer wrong" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().reason_code).toBe("AUTH_UNAUTHENTICATED");
    expect(calls).toHaveLength(0);
  });

  it("accepts a valid token with 200", async () => {
    const { pool } = fakePool(() => []);
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/markets",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ markets: [] });
  });
});

describe("GET /polymarket/markets", () => {
  it("applies category, status and in_universe filters", async () => {
    const { pool, calls } = fakePool(() => []);
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/markets?category=crypto&status=active&in_universe=true",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const call = calls[0];
    expect(call?.text).toContain("category = $1");
    expect(call?.text).toContain("active IS TRUE AND closed IS NOT TRUE");
    expect(call?.text).toContain("DISTINCT ON (condition_id)");
    expect(call?.text).toContain("action = 'enter'");
    expect(call?.params[0]).toBe("crypto");
    expect(call?.params[1]).toEqual(FIXED_NOW);
  });

  it("rejects an unknown status with 400", async () => {
    const { pool } = fakePool();
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/markets?status=paused",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().reason_code).toBe("INVALID_STATUS");
  });

  it("serializes market rows with ISO timestamps", async () => {
    const { pool } = fakePool(() => [
      {
        condition_id: "0xcond",
        question: "Will BTC close above 100k?",
        category: "crypto",
        neg_risk: false,
        clob_token_ids: ["111", "222"],
        active: true,
        closed: false,
        received_at: new Date("2026-08-18T09:00:00.000Z"),
        updated_at: new Date("2026-08-19T09:00:00.000Z"),
      },
    ]);
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/markets",
      headers: AUTH,
    });
    const body = response.json();
    expect(body.markets).toHaveLength(1);
    expect(body.markets[0].condition_id).toBe("0xcond");
    expect(body.markets[0].received_at).toBe("2026-08-18T09:00:00.000Z");
    expect(body.markets[0].updated_at).toBe("2026-08-19T09:00:00.000Z");
  });
});

// Responder that emulates the as-of predicate over an in-memory version list,
// so boundary semantics of the handler's parameters are exercised end to end.
function asOfResponder(table: string, versions: Row[]): Responder {
  return (text, params) => {
    if (!text.includes(table)) {
      return [];
    }
    const at = params[1] as Date;
    return versions
      .filter((version) => {
        const validFrom = version["valid_from"] as Date;
        const validTo = version["valid_to"] as Date | null;
        return (
          validFrom.getTime() <= at.getTime() &&
          (validTo === null || validTo.getTime() > at.getTime())
        );
      })
      .sort((a, b) => (b["version"] as number) - (a["version"] as number))
      .slice(0, 1);
  };
}

const RULE_V1: Row = {
  version: 1,
  content_hash: "h1",
  description: "original rules",
  valid_from: new Date("2026-08-01T00:00:00.000Z"),
  valid_to: new Date("2026-08-10T00:00:00.000Z"),
  received_at: new Date("2026-08-01T00:00:00.000Z"),
};
const RULE_V2: Row = {
  version: 2,
  content_hash: "h2",
  description: "clarified rules",
  valid_from: new Date("2026-08-10T00:00:00.000Z"),
  valid_to: null,
  received_at: new Date("2026-08-10T00:00:00.000Z"),
};

describe("GET /polymarket/markets/:conditionId/rules", () => {
  it("returns the version effective at the lower boundary (valid_from inclusive)", async () => {
    const { pool } = fakePool(
      asOfResponder("polymarket_rule_versions", [RULE_V1, RULE_V2]),
    );
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/markets/0xcond/rules?at=2026-08-01T00:00:00.000Z",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().rule_version.version).toBe(1);
  });

  it("switches to the next version exactly at valid_to (exclusive upper bound)", async () => {
    const { pool } = fakePool(
      asOfResponder("polymarket_rule_versions", [RULE_V1, RULE_V2]),
    );
    const server = await buildApp({ pool });
    const atBoundary = await server.inject({
      method: "GET",
      url: "/polymarket/markets/0xcond/rules?at=2026-08-10T00:00:00.000Z",
      headers: AUTH,
    });
    expect(atBoundary.json().rule_version.version).toBe(2);

    const justBefore = await server.inject({
      method: "GET",
      url: "/polymarket/markets/0xcond/rules?at=2026-08-09T23:59:59.999Z",
      headers: AUTH,
    });
    expect(justBefore.json().rule_version.version).toBe(1);
  });

  it("returns 404 when no version is effective at the timestamp", async () => {
    const { pool } = fakePool(
      asOfResponder("polymarket_rule_versions", [RULE_V1, RULE_V2]),
    );
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/markets/0xcond/rules?at=2026-07-01T00:00:00.000Z",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().reason_code).toBe("RULE_VERSION_NOT_FOUND");
  });

  it("rejects a non-ISO at with 400 INVALID_TIMESTAMP", async () => {
    const { pool, calls } = fakePool();
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/markets/0xcond/rules?at=1787098643398",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().reason_code).toBe("INVALID_TIMESTAMP");
    expect(calls).toHaveLength(0);
  });

  it("defaults at to the injected clock when omitted", async () => {
    const { pool, calls } = fakePool(
      asOfResponder("polymarket_rule_versions", [RULE_V2]),
    );
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/markets/0xcond/rules",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(calls[0]?.params[1]).toEqual(FIXED_NOW);
    expect(response.json().at).toBe(FIXED_NOW.toISOString());
  });
});

describe("GET /polymarket/markets/:conditionId/params", () => {
  it("queries param versions with the as-of predicate", async () => {
    const { pool, calls } = fakePool((text) =>
      text.includes("polymarket_param_versions")
        ? [
            {
              version: 3,
              tick_size: "0.001",
              min_order_size: "5",
              valid_from: new Date("2026-08-01T00:00:00.000Z"),
              valid_to: null,
            },
          ]
        : [],
    );
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/markets/0xcond/params?at=2026-08-15T00:00:00Z",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().param_version.version).toBe(3);
    expect(response.json().param_version.tick_size).toBe("0.001");
    const call = calls[0];
    expect(call?.text).toContain("valid_from <= $2");
    expect(call?.text).toContain("valid_to IS NULL OR valid_to > $2");
    expect((call?.params[1] as Date).toISOString()).toBe(
      "2026-08-15T00:00:00.000Z",
    );
  });

  it("returns 404 when no param version covers the timestamp", async () => {
    const { pool } = fakePool(() => []);
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/markets/0xcond/params?at=2026-08-15T00:00:00Z",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().reason_code).toBe("PARAM_VERSION_NOT_FOUND");
  });
});

describe("GET /polymarket/markets/:conditionId", () => {
  it("returns 404 for an unknown market", async () => {
    const { pool } = fakePool(() => []);
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/markets/0xmissing",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().reason_code).toBe("MARKET_NOT_FOUND");
  });

  it("joins the market with rule and param versions effective now", async () => {
    const { pool } = fakePool((text) => {
      if (text.includes("FROM polymarket_markets")) {
        return [{ condition_id: "0xcond", question: "q" }];
      }
      if (text.includes("polymarket_rule_versions")) {
        return [RULE_V2];
      }
      if (text.includes("polymarket_param_versions")) {
        return [{ version: 1, tick_size: "0.01", valid_from: FIXED_NOW }];
      }
      return [];
    });
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/markets/0xcond",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.market.condition_id).toBe("0xcond");
    expect(body.rule_version.version).toBe(2);
    expect(body.param_version.tick_size).toBe("0.01");
  });
});

describe("GET /polymarket/books/:tokenId", () => {
  it("calls bookAt with the pool, token, parsed at and clamped depth", async () => {
    const { pool } = fakePool();
    const bookAtCalls: unknown[][] = [];
    const bookAtFn: BookAtFn = (poolArg, tokenId, at, depth) => {
      bookAtCalls.push([poolArg, tokenId, at, depth]);
      return Promise.resolve({
        bids: [{ price: "0.45", size: "10" }],
        asks: [{ price: "0.55", size: "8" }],
        anchorReceivedAt: new Date("2026-08-19T11:59:00.000Z"),
        deltasApplied: 7,
      });
    };
    const server = await buildApp({ pool, bookAtFn });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/books/111?at=2026-08-19T11:59:30.000Z&depth=500",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(bookAtCalls).toHaveLength(1);
    expect(bookAtCalls[0]?.[0]).toBe(pool);
    expect(bookAtCalls[0]?.[1]).toBe("111");
    expect((bookAtCalls[0]?.[2] as Date).toISOString()).toBe(
      "2026-08-19T11:59:30.000Z",
    );
    // depth=500 is clamped to the 100 maximum.
    expect(bookAtCalls[0]?.[3]).toBe(100);
    const body = response.json();
    expect(body.bids).toEqual([{ price: "0.45", size: "10" }]);
    expect(body.anchor_received_at).toBe("2026-08-19T11:59:00.000Z");
    expect(body.deltas_applied).toBe(7);
  });

  it("defaults depth to 10 and at to the injected clock", async () => {
    const { pool } = fakePool();
    const bookAtCalls: unknown[][] = [];
    const bookAtFn: BookAtFn = (_pool, tokenId, at, depth) => {
      bookAtCalls.push([tokenId, at, depth]);
      return Promise.resolve(null);
    };
    const server = await buildApp({ pool, bookAtFn });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/books/111",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().reason_code).toBe("BOOK_NOT_FOUND");
    expect(bookAtCalls[0]?.[1]).toEqual(FIXED_NOW);
    expect(bookAtCalls[0]?.[2]).toBe(10);
  });

  it("rejects a non-numeric depth with 400 INVALID_DEPTH", async () => {
    const { pool } = fakePool();
    const bookAtFn: BookAtFn = () => Promise.resolve(null);
    const server = await buildApp({ pool, bookAtFn });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/books/111?depth=abc",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().reason_code).toBe("INVALID_DEPTH");
  });
});

describe("GET /polymarket/books/:tokenId/deltas", () => {
  it("passes filters through to deltasPage and clamps the limit", async () => {
    const { pool } = fakePool();
    const pageCalls: unknown[][] = [];
    const deltasPageFn: DeltasPageFn = (poolArg, tokenId, query) => {
      pageCalls.push([poolArg, tokenId, query]);
      return Promise.resolve({
        deltas: [
          {
            deltaId: "42",
            side: "BUY",
            price: "0.5",
            size: "3",
            sourceTs: new Date("2026-08-19T11:00:00.000Z"),
            receivedAt: new Date("2026-08-19T11:00:00.100Z"),
          },
        ],
        nextAfterId: "42",
      });
    };
    const server = await buildApp({ pool, deltasPageFn });
    const response = await server.inject({
      method: "GET",
      url:
        "/polymarket/books/111/deltas?from=2026-08-19T10:00:00Z" +
        "&to=2026-08-19T11:00:00Z&after_id=41&limit=999999",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const [, tokenId, query] = pageCalls[0] ?? [];
    expect(tokenId).toBe("111");
    expect(query).toMatchObject({ afterId: "41", limit: 5000 });
    const body = response.json();
    expect(body.deltas[0]).toEqual({
      delta_id: "42",
      side: "BUY",
      price: "0.5",
      size: "3",
      source_ts: "2026-08-19T11:00:00.000Z",
      received_at: "2026-08-19T11:00:00.100Z",
    });
    expect(body.next_after_id).toBe("42");
  });

  it("rejects a non-numeric after_id with 400", async () => {
    const { pool } = fakePool();
    const deltasPageFn: DeltasPageFn = () =>
      Promise.resolve({ deltas: [], nextAfterId: null });
    const server = await buildApp({ pool, deltasPageFn });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/books/111/deltas?after_id=abc",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().reason_code).toBe("INVALID_AFTER_ID");
  });

  it("rejects an after_id beyond the BIGINT maximum with 400, not 500", async () => {
    const { pool } = fakePool();
    const pageCalls: unknown[] = [];
    const deltasPageFn: DeltasPageFn = (_pool, _tokenId, query) => {
      pageCalls.push(query);
      return Promise.resolve({ deltas: [], nextAfterId: null });
    };
    const server = await buildApp({ pool, deltasPageFn });

    // 2^63 (one past the signed BIGINT max, 19 digits so it passes the
    // length check): must be a client error, never a database 500.
    const overMax = await server.inject({
      method: "GET",
      url: "/polymarket/books/111/deltas?after_id=9223372036854775808",
      headers: AUTH,
    });
    expect(overMax.statusCode).toBe(400);
    expect(overMax.json().reason_code).toBe("INVALID_AFTER_ID");
    expect(pageCalls).toHaveLength(0);

    // Exactly the BIGINT max (2^63 - 1) is still a valid cursor.
    const atMax = await server.inject({
      method: "GET",
      url: "/polymarket/books/111/deltas?after_id=9223372036854775807",
      headers: AUTH,
    });
    expect(atMax.statusCode).toBe(200);
    expect(pageCalls).toHaveLength(1);
  });
});

describe("GET /polymarket/trades", () => {
  it("filters by token and window and serializes rows", async () => {
    const { pool, calls } = fakePool(() => [
      {
        trade_id: "1",
        token_id: "111",
        price: "0.52",
        size: "10",
        side: "BUY",
        provenance: "ws",
        trade_ts: new Date("2026-08-19T10:30:00.000Z"),
        received_at: new Date("2026-08-19T10:30:00.200Z"),
      },
    ]);
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url:
        "/polymarket/trades?token_id=111&from=2026-08-19T10:00:00Z" +
        "&to=2026-08-19T11:00:00Z&limit=50",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const call = calls[0];
    expect(call?.text).toContain("FROM polymarket_trades");
    expect(call?.text).toContain("LIMIT 50");
    expect(call?.params[0]).toBe("111");
    const body = response.json();
    expect(body.trades[0].price).toBe("0.52");
    expect(body.trades[0].trade_ts).toBe("2026-08-19T10:30:00.000Z");
  });

  it("rejects a non-numeric limit with 400", async () => {
    const { pool } = fakePool();
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/trades?limit=lots",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().reason_code).toBe("INVALID_LIMIT");
  });

  it("orders by the exact expression migration 0005 indexes", async () => {
    const { pool, calls } = fakePool(() => []);
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/trades?token_id=111",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(calls[0]?.text).toContain(
      "ORDER BY COALESCE(trade_ts, received_at), trade_id",
    );

    // Query and index must stay aligned: the migration ships an expression
    // index on (token_id, COALESCE(trade_ts, received_at)).
    const migration = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../migrations/0005_polymarket_data_foundation.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(migration).toContain("polymarket_trades_token_effective_ts_idx");
    expect(migration).toContain(
      "(token_id, (COALESCE(trade_ts, received_at)))",
    );
  });
});

describe("GET /polymarket/series/:tokenId", () => {
  it("rejects an unknown metric with 400", async () => {
    const { pool } = fakePool();
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/series/111?metric=volume",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().reason_code).toBe("INVALID_METRIC");
  });

  it("reads spread points from polymarket_series_1m", async () => {
    const { pool, calls } = fakePool(() => [
      {
        bucket_start: new Date("2026-08-19T11:00:00.000Z"),
        best_bid: "0.51",
        best_ask: "0.53",
        spread: "0.02",
        mid_close: "0.52",
      },
    ]);
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/series/111?metric=spread",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(calls[0]?.text).toContain("FROM polymarket_series_1m");
    const body = response.json();
    expect(body.points[0].spread).toBe("0.02");
    expect(body.points[0].bucket_start).toBe("2026-08-19T11:00:00.000Z");
  });

  // RFC-026 D10 (PR 3).
  it("returns the six OHLC columns for metric=ohlc", async () => {
    const { pool, calls } = fakePool(() => [
      {
        bucket_start: new Date("2026-08-19T11:00:00.000Z"),
        mid_open: "0.51",
        mid_high: "0.55",
        mid_low: "0.50",
        mid_close: "0.52",
        updates_count: 7,
      },
    ]);
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/series/111?metric=ohlc&from=2026-08-19T11:00:00Z",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(calls[0]?.text).toContain("FROM polymarket_series_1m");
    const point = response.json().points[0];
    expect(Object.keys(point).sort()).toEqual([
      "bucket_start",
      "mid_close",
      "mid_high",
      "mid_low",
      "mid_open",
      "updates_count",
    ]);
    // Money stays the decimal text Postgres returned; only the timestamp is
    // rewritten.
    expect(point.mid_open).toBe("0.51");
    expect(point.mid_close).toBe("0.52");
    expect(point.bucket_start).toBe("2026-08-19T11:00:00.000Z");
  });

  it("refuses metric=ohlc without `from` with 400", async () => {
    const { pool, calls } = fakePool();
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/series/111?metric=ohlc",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().reason_code).toBe("FROM_REQUIRED");
    // The point of the 400 is that the scan never starts.
    expect(calls).toEqual([]);
  });

  it("refuses an ohlc window wider than the measured ceiling with 400", async () => {
    const { pool, calls } = fakePool();
    const server = await buildApp({ pool });
    // 24 h back from the fixed clock: the window D10 asked for, and the one
    // that measured p95 700 ms in production. A wider window is a 400 and not
    // a slow answer, because a slow answer here is a statement timeout.
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/series/111?metric=ohlc&from=2026-08-18T12:00:00Z",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().reason_code).toBe("WINDOW_TOO_WIDE");
    expect(calls).toEqual([]);
  });

  it("accepts an ohlc window exactly at the ceiling", async () => {
    const { pool, calls } = fakePool(() => []);
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/series/111?metric=ohlc&from=2026-08-19T00:00:00Z",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("accepts a token_id or condition_id for oi/holders metrics", async () => {
    const { pool, calls } = fakePool(() => []);
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/series/0xcond?metric=oi",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const call = calls[0];
    expect(call?.text).toContain("FROM polymarket_oi_holders");
    expect(call?.text).toContain("token_id = $1 OR condition_id = $1");
    expect(call?.text).toContain("clob_token_ids @> $2::jsonb");
    expect(call?.params[0]).toBe("0xcond");
    expect(call?.params[1]).toBe(JSON.stringify(["0xcond"]));
  });
});

// RFC-026 D10 (PR 3). The batch behind the Mesa's sparklines.
describe("GET /polymarket/series?tokens=", () => {
  const withTokens = (count: number): string =>
    Array.from({ length: count }, (_, i) => `t${i}`).join(",");

  it("groups points by token and answers for every token asked", async () => {
    const { pool, calls } = fakePool(() => [
      {
        token_id: "a",
        bucket_start: new Date("2026-08-19T11:58:00.000Z"),
        mid_open: "0.41",
        mid_high: "0.42",
        mid_low: "0.40",
        mid_close: "0.41",
        updates_count: 3,
      },
      {
        token_id: "a",
        bucket_start: new Date("2026-08-19T11:59:00.000Z"),
        mid_open: "0.41",
        mid_high: "0.43",
        mid_low: "0.41",
        mid_close: "0.43",
        updates_count: 5,
      },
    ]);
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/series?tokens=a,b&metric=ohlc&from=2026-08-19T11:30:00Z",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.tokens).toEqual(["a", "b"]);
    expect(body.series.a).toHaveLength(2);
    // `b` has no series. It still gets a key, because "sem serie" is an answer
    // the Mesa renders and a missing key reads as a request never made.
    expect(body.series.b).toEqual([]);
    // The grouping key does not survive into each point.
    expect(body.series.a[0]).not.toHaveProperty("token_id");
    expect(body.series.a[0].mid_close).toBe("0.41");
    expect(body.series.a[0].bucket_start).toBe("2026-08-19T11:58:00.000Z");
    // One request, one query.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params[0]).toEqual(["a", "b"]);
  });

  it("refuses 26 tokens with 400 and accepts 25", async () => {
    const { pool, calls } = fakePool(() => []);
    const server = await buildApp({ pool });
    const tooMany = await server.inject({
      method: "GET",
      url: `/polymarket/series?tokens=${withTokens(26)}&metric=ohlc&from=2026-08-19T11:30:00Z`,
      headers: AUTH,
    });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().reason_code).toBe("TOO_MANY_TOKENS");
    expect(calls).toEqual([]);

    const atCeiling = await server.inject({
      method: "GET",
      url: `/polymarket/series?tokens=${withTokens(25)}&metric=ohlc&from=2026-08-19T11:30:00Z`,
      headers: AUTH,
    });
    expect(atCeiling.statusCode).toBe(200);
    expect(atCeiling.json().tokens).toHaveLength(25);
  });

  it("counts a repeated token once against the ceiling", async () => {
    const { pool } = fakePool(() => []);
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: `/polymarket/series?tokens=${Array(30).fill("a").join(",")}&metric=ohlc&from=2026-08-19T11:30:00Z`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().tokens).toEqual(["a"]);
  });

  it("caps the batch at SERIES_LIMIT rows and says when it truncated", async () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({
      token_id: "a",
      bucket_start: new Date(1_755_000_000_000 + i * 60_000),
      mid_open: "0.5",
      mid_high: "0.5",
      mid_low: "0.5",
      mid_close: "0.5",
      updates_count: 1,
    }));
    const { pool, calls } = fakePool(() => rows);
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/series?tokens=a&metric=ohlc&from=2026-08-19T11:30:00Z",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(calls[0]?.text).toContain("LIMIT 10000");
    // Ordered by token first, so the cap drops whole trailing tokens instead of
    // shaving a bucket off every one of them.
    expect(calls[0]?.text).toContain("ORDER BY token_id, bucket_start");
    expect(response.json().truncated).toBe(true);
  });

  it("refuses the batch without `from`, and refuses a window past 60 minutes", async () => {
    const { pool, calls } = fakePool(() => []);
    const server = await buildApp({ pool });
    const noFrom = await server.inject({
      method: "GET",
      url: "/polymarket/series?tokens=a&metric=ohlc",
      headers: AUTH,
    });
    expect(noFrom.statusCode).toBe(400);
    expect(noFrom.json().reason_code).toBe("FROM_REQUIRED");

    // 24 h over 25 tokens is the call that measured 612 ms in production, past
    // both the route's budget and the API's statement timeout.
    const tooWide = await server.inject({
      method: "GET",
      url: "/polymarket/series?tokens=a&metric=ohlc&from=2026-08-18T12:00:00Z",
      headers: AUTH,
    });
    expect(tooWide.statusCode).toBe(400);
    expect(tooWide.json().reason_code).toBe("WINDOW_TOO_WIDE");
    expect(calls).toEqual([]);
  });

  it("refuses a metric other than ohlc, and a missing tokens list", async () => {
    const { pool } = fakePool(() => []);
    const server = await buildApp({ pool });
    const wrongMetric = await server.inject({
      method: "GET",
      url: "/polymarket/series?tokens=a&metric=spread&from=2026-08-19T11:30:00Z",
      headers: AUTH,
    });
    expect(wrongMetric.statusCode).toBe(400);
    expect(wrongMetric.json().reason_code).toBe("INVALID_METRIC");

    const noTokens = await server.inject({
      method: "GET",
      url: "/polymarket/series?metric=ohlc&from=2026-08-19T11:30:00Z",
      headers: AUTH,
    });
    expect(noTokens.statusCode).toBe(400);
    expect(noTokens.json().reason_code).toBe("TOKENS_REQUIRED");
  });

  it("stays behind the session guard", async () => {
    const { pool, calls } = fakePool(() => []);
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/series?tokens=a&metric=ohlc&from=2026-08-19T11:30:00Z",
      headers: { authorization: "Bearer nope" },
    });
    expect(response.statusCode).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe("GET /polymarket/resolution-events", () => {
  it("filters the timeline by condition_id", async () => {
    const { pool, calls } = fakePool(() => [
      {
        resolution_event_id: "1",
        condition_id: "0xcond",
        event_type: "proposed",
        payload_json: {},
        received_at: new Date("2026-08-18T00:00:00.000Z"),
      },
    ]);
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/resolution-events?condition_id=0xcond",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(calls[0]?.text).toContain("FROM polymarket_resolution_events");
    expect(calls[0]?.params[0]).toBe("0xcond");
    expect(response.json().events[0].event_type).toBe("proposed");
  });
});

describe("GET /polymarket/data-quality", () => {
  // RFC-015 §9. The old answer summed PHYSICAL bytes over tables matching
  // `polymarket_%` and divided by the whole budget, while QUOTA_GLOBAL_ALARM
  // summed LIVE bytes over the WHOLE retention list against that same budget.
  // Two errors stacked, so `budget_used_pct` was never the number the alarm
  // acts on. These tests are written so that reverting either half fails.

  function catalogRow(
    table: string,
    bytes: string,
    liveTup: string,
    deadTup: string,
  ): Record<string, unknown> {
    return {
      table_name: table,
      bytes,
      reltuples: liveTup,
      live_tup: liveTup,
      dead_tup: deadTup,
      toast_live_tup: "0",
      // No pg_stats width: measureTableSizes falls back to the dead-tuple
      // discount, which is arithmetic this test can state exactly.
      heap_width: null,
      index_count: null,
      index_key_width: null,
    };
  }

  it("aggregates gaps, lag percentiles and storage against the module budget", async () => {
    const { pool, calls } = fakePool((text) => {
      if (text.includes("polymarket_data_gaps")) {
        return [
          { source: "clob_ws", gap_count: "3", total_gap_seconds: "12.5" },
          { source: "rtds", gap_count: "1", total_gap_seconds: "60" },
        ];
      }
      if (text.includes("percentile_cont")) {
        return [{ p50: 45.5, p99: 900 }];
      }
      if (text.includes("pg_total_relation_size")) {
        return [
          // 20 GiB of file, half of it dead: 10 GiB retained.
          catalogRow("polymarket_book_deltas", "21474836480", "50", "50"),
          // A retention-list table that does NOT match `polymarket_%`. Under
          // the old definition this contributed nothing at all.
          catalogRow("portfolio_decisions", "1073741824", "10", "0"),
        ];
      }
      return [];
    });
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/data-quality",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.generated_at).toBe(FIXED_NOW.toISOString());
    expect(body.gaps_24h).toEqual([
      { source: "clob_ws", count: 3, total_duration_ms: 12500 },
      { source: "rtds", count: 1, total_duration_ms: 60000 },
    ]);
    expect(body.ingest_lag_ms_last_hour).toEqual({ p50: 45.5, p99: 900 });

    // 10 GiB live (half of 20) + 1 GiB live = 11 GiB of the 110 GiB budget.
    expect(body.storage.total_bytes).toBe(11 * 1024 ** 3);
    expect(body.storage.budget_used_pct).toBe(10);
    expect(body.storage.budget_bytes).toBe(110 * 1024 ** 3);

    // Physical and bloat are reported alongside, because "how much is
    // retained" and "how much disk is this costing" are different questions
    // and the panel needs both. 21 GiB of file for 11 GiB of data.
    expect(body.storage.physical_bytes).toBe(21 * 1024 ** 3);
    expect(body.storage.bloat_bytes).toBe(10 * 1024 ** 3);
    expect(body.storage.basis).toContain("vivos");

    // The population: the whole retention list, asked for by name.
    const sizeCall = calls.find((call) =>
      call.text.includes("pg_total_relation_size"),
    );
    const requested = sizeCall?.params[0] as string[];
    expect(requested).toEqual(RETENTION_TABLES.map((config) => config.table));
    expect(requested).toContain("portfolio_decisions");
    expect(requested).toContain("paper_ledger_events");
    // And the old predicate is gone: nothing selects by name pattern any more.
    expect(sizeCall?.text).not.toContain("LIKE");
  });

  it("counts a retention table the catalog does not know as zero", async () => {
    const { pool } = fakePool((text) =>
      text.includes("pg_total_relation_size")
        ? [catalogRow("polymarket_trades", "1073741824", "10", "0")]
        : [],
    );
    const server = await buildApp({ pool });
    const body = (
      await server.inject({
        method: "GET",
        url: "/polymarket/data-quality",
        headers: AUTH,
      })
    ).json();
    // Every retention table still gets a row; the absent ones are zero rather
    // than missing, so the panel never has to reason about a hole.
    expect(body.storage.tables).toHaveLength(RETENTION_TABLES.length);
    expect(body.storage.total_bytes).toBe(1024 ** 3);
    const absent = body.storage.tables.find(
      (table: { table_name: string }) =>
        table.table_name === "portfolio_decisions",
    );
    expect(absent).toMatchObject({ live_bytes: 0, physical_bytes: 0 });
  });
});

// ---------------------------------------------------------------------------
// RFC-024 D4 — a métrica de cobertura do universo rápido
// ---------------------------------------------------------------------------

describe("GET /polymarket/data-quality — fast_coverage (RFC-024 D4)", () => {
  /** One `fast_coverage` day row, as the aggregation SQL returns it. */
  function coberturaRow(
    dia: string,
    emitidos: string,
    comLivro: string,
    catalogados: string,
    porSerie: string,
    leadMin: number | null,
  ): Record<string, unknown> {
    return {
      dia: new Date(`${dia}T00:00:00.000Z`),
      emitidos,
      com_livro_t15: comLivro,
      catalogados_60min: catalogados,
      entradas_por_serie: porSerie,
      lead_mediano_min: leadMin,
    };
  }

  function coveragePool(
    rows: Array<Record<string, unknown>>,
    missing?: {
      total: string;
      abertas: string;
    },
  ) {
    return fakePool((text) => {
      if (text.includes("com_livro_t15")) {
        return rows;
      }
      if (text.includes("subscribe_book_missing")) {
        return [missing ?? { total: "0", abertas: "0" }];
      }
      return [];
    });
  }

  it("publica dia, cobertura, lead e a origem da descoberta", async () => {
    const { pool } = coveragePool(
      [
        coberturaRow("2026-08-18", "24", "22", "23", "24", 68.4),
        coberturaRow("2026-08-17", "24", "20", "21", "24", 64.1),
      ],
      { total: "7", abertas: "2" },
    );
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/data-quality",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const coverage = response.json().fast_coverage;
    expect(coverage.serie).toBe("btc-up-or-down-hourly");
    // The RFC's target: >= 90 %, i.e. >= 22 of 24.
    expect(coverage.dias[0]).toEqual({
      dia: "2026-08-18",
      emitidos: 24,
      com_livro_t15: 22,
      com_livro_t15_pct: 91.7,
      catalogados_60min: 23,
      catalogados_60min_pct: 95.8,
      entradas_por_serie: 24,
      lead_mediano_min: 68.4,
    });
    expect(coverage.dias[1].com_livro_t15_pct).toBe(83.3);
    expect(coverage.subscribe_book_missing_24h).toEqual({
      total: 7,
      abertas: 2,
    });
  });

  it("24/22 dá 91,7 % e 24/20 dá 83,3 %", async () => {
    const { pool } = coveragePool([
      coberturaRow("2026-08-18", "24", "22", "24", "24", 70),
      coberturaRow("2026-08-17", "24", "20", "24", "24", 70),
    ]);
    const server = await buildApp({ pool });
    const body = (
      await server.inject({
        method: "GET",
        url: "/polymarket/data-quality",
        headers: AUTH,
      })
    ).json();
    expect(
      body.fast_coverage.dias.map(
        (day: { com_livro_t15_pct: number }) => day.com_livro_t15_pct,
      ),
    ).toEqual([91.7, 83.3]);
  });

  it("emitidos = 0 ⇒ campos null, NUNCA 100 %", async () => {
    // The degeneration lens: a day the series did not answer has no markets,
    // and 0/0 published as 100 % would declare victory over an empty set.
    const { pool } = coveragePool([
      coberturaRow("2026-08-18", "0", "0", "0", "0", null),
    ]);
    const server = await buildApp({ pool });
    const body = (
      await server.inject({
        method: "GET",
        url: "/polymarket/data-quality",
        headers: AUTH,
      })
    ).json();
    expect(body.fast_coverage.dias[0]).toEqual({
      dia: "2026-08-18",
      emitidos: 0,
      com_livro_t15: null,
      com_livro_t15_pct: null,
      catalogados_60min: null,
      catalogados_60min_pct: null,
      entradas_por_serie: null,
      lead_mediano_min: null,
    });
  });

  it("dia sem nenhum enter: lead null em vez de 0", async () => {
    // 0 would read as "discovered at the buzzer" — the opposite of "not
    // discovered at all", and the two must never look alike.
    const { pool } = coveragePool([
      coberturaRow("2026-08-18", "24", "0", "0", "0", null),
    ]);
    const server = await buildApp({ pool });
    const day = (
      await server.inject({
        method: "GET",
        url: "/polymarket/data-quality",
        headers: AUTH,
      })
    ).json().fast_coverage.dias[0];
    expect(day.lead_mediano_min).toBeNull();
    expect(day.com_livro_t15).toBe(0);
    expect(day.com_livro_t15_pct).toBe(0);
  });

  it("série sem resposta nenhuma: dias vazio, não um 100 % inventado", async () => {
    const { pool } = coveragePool([]);
    const server = await buildApp({ pool });
    const coverage = (
      await server.inject({
        method: "GET",
        url: "/polymarket/data-quality",
        headers: AUTH,
      })
    ).json().fast_coverage;
    expect(coverage.dias).toEqual([]);
    expect(coverage.subscribe_book_missing_24h).toEqual({
      total: 0,
      abertas: 0,
    });
  });

  it("a consulta cobre 3 dias UTC e usa a régua exata da RFC", async () => {
    const { pool, calls } = coveragePool([]);
    const server = await buildApp({ pool });
    await server.inject({
      method: "GET",
      url: "/polymarket/data-quality",
      headers: AUTH,
    });
    const coverageCall = calls.find((call) =>
      call.text.includes("com_livro_t15"),
    );
    expect(coverageCall).toBeDefined();
    expect(coverageCall?.params[0]).toEqual(FIXED_NOW);
    // Three UTC days: the soak's window.
    expect(coverageCall?.params[1]).toBe(3);
    // The ruler, spelled out: the 1-minute bucket at T-15 with a real update.
    expect(coverageCall?.text).toContain("INTERVAL '15 minutes'");
    expect(coverageCall?.text).toContain("INTERVAL '14 minutes'");
    expect(coverageCall?.text).toContain("updates_count >= 1");
    // The hourly slug, not the 5min/15min/4h pattern.
    expect(coverageCall?.text).toContain("bitcoin-up-or-down-");
    expect(coverageCall?.text).toContain("(am|pm)-et");
    // The `_series` suffix is what separates the two discovery sources — and
    // the underscore MUST be escaped: `_` is a single-character wildcard in
    // LIKE, so the unescaped pattern also matches `xseries`. Proved against
    // the production Postgres: `'xseries' LIKE '%_series'` is TRUE, and with
    // `ESCAPE` it is FALSE.
    expect(coverageCall?.text).toContain("LIKE '%\\_series' ESCAPE '\\'");
    expect(coverageCall?.text).not.toContain("LIKE '%_series'");
  });

  it("continua GET-only: todo outro método é 404 no perímetro", async () => {
    // The route is `location =` in nginx and GET-only; the new field does not
    // add a verb, a location, or a write.
    const { pool } = coveragePool([]);
    const server = await buildApp({ pool });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await server.inject({
        method,
        url: "/polymarket/data-quality",
        headers: AUTH,
      });
      expect(response.statusCode).toBe(404);
    }
  });
});

describe("GET /polymarket/universe", () => {
  it("reconstructs membership from the latest enter/exit at the timestamp", async () => {
    const { pool, calls } = fakePool((text) =>
      text.includes("polymarket_universe_log")
        ? [
            {
              condition_id: "0xcond-a",
              reason: "crypto threshold daily",
              at: new Date("2026-08-15T00:00:00.000Z"),
            },
          ]
        : [],
    );
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/universe?at=2026-08-16T00:00:00Z",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const call = calls[0];
    // Latest action per condition wins; only current members (enter) are kept.
    expect(call?.text).toContain("DISTINCT ON (condition_id)");
    expect(call?.text).toContain("at <= $1");
    expect(call?.text).toContain("ORDER BY condition_id, at DESC");
    expect(call?.text).toContain("WHERE action = 'enter'");
    expect((call?.params[0] as Date).toISOString()).toBe(
      "2026-08-16T00:00:00.000Z",
    );
    const body = response.json();
    expect(body.members).toEqual([
      {
        condition_id: "0xcond-a",
        reason: "crypto threshold daily",
        entered_at: "2026-08-15T00:00:00.000Z",
      },
    ]);
  });

  it("rejects an invalid at with 400", async () => {
    const { pool } = fakePool();
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/universe?at=not-a-date",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().reason_code).toBe("INVALID_TIMESTAMP");
  });
});

describe("failure handling", () => {
  it("answers 500 READ_API_FAILED when the database throws", async () => {
    const pool: DatabasePool = {
      query() {
        return Promise.reject(new Error("connection refused"));
      },
      transaction() {
        return Promise.reject(new Error("unused"));
      },
      // RFC-023 D1 pass-through; see `test/fixtures/read-only.ts`.
      readOnly<T>(
        _statementTimeoutMs: number,
        run: (tx: SqlExecutor) => Promise<T>,
      ): Promise<T> {
        return run(this as unknown as SqlExecutor);
      },
      end() {
        return Promise.resolve();
      },
    };
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/markets",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().reason_code).toBe("READ_API_FAILED");
    expect(response.json().correlation_id).toBeTypeOf("string");
  });

  it("answers 500 READ_API_FAILED when the auth service throws", async () => {
    const { pool } = fakePool();
    const throwingAuth: AuthSessionService = {
      session() {
        return Promise.reject(new Error("auth store down"));
      },
    };
    const server = await buildApp({ pool, authService: throwingAuth });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/markets",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().reason_code).toBe("READ_API_FAILED");
  });
});
