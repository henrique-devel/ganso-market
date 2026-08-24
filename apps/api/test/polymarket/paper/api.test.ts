import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { QueryResult, SqlExecutor } from "../../../src/database.js";
import { registerPaperRoutes } from "../../../src/polymarket/paper/api.js";
import { SIMULATION_BANNER } from "../../../src/polymarket/paper/runner.js";

type Row = Record<string, unknown>;
type Responder = (text: string, params: readonly unknown[]) => Row[];

function fakePool(rows: Row[]): SqlExecutor {
  return {
    query<R extends Row>(): Promise<QueryResult<R>> {
      return Promise.resolve({ rows: rows as R[], rowCount: rows.length });
    },
  };
}

function respondingPool(respond: Responder): SqlExecutor {
  return {
    query<R extends Row>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      const rows = respond(text, params) as R[];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  };
}

const authService = {
  session(token: string): Promise<{ status: string }> {
    return Promise.resolve(
      token === "good-token" ? { status: "ok" } : { status: "unauthenticated" },
    );
  },
};

const AUTH = { authorization: "Bearer good-token" };

const WINDOW_ROW: Row = {
  window_kind: "1m",
  window_start: new Date("2026-08-24T12:00:00.000Z"),
  window_end: new Date("2026-08-24T12:01:00.000Z"),
  source_ts: new Date("2026-08-24T12:00:59.000Z"),
  computed_at: new Date("2026-08-24T12:01:00.500Z"),
  book_valid: true,
  book_invalid_reason: null,
  best_bid: "0.480000",
  best_ask: "0.520000",
  mid: "0.500000",
  spread_quoted: "0.040000",
  half_spread_bps: "400.000000",
  exec_spread_sref: "0.045000",
  microprice: "0.498000",
  thin_book: false,
  bid_depth_top1: "100.000000",
  ask_depth_top1: "50.000000",
  bid_depth_top10: "1000.000000",
  ask_depth_top10: "500.000000",
  top_frac_bid: "0.100000",
  top_frac_ask: "0.100000",
  depth_ticks_json: { "1": { bid: "200.000000", ask: "100.000000" } },
  imbalance_top1: "0.333333",
  imbalance_top10: "0.333333",
  trades_count: 3,
  volume_unsigned: "15.500000",
  volume_signed: null,
  flow_direction_status: "UNAVAILABLE",
  cancel_events: 4,
  update_events: 11,
  levels_touched: 6,
  vol_1m: "0.095310",
  vol_5m: null,
  vol_30m: null,
  jump_count: 2,
  last_trade_age_ms: "1500",
  book_staleness_ms: "2000",
  mins_to_catalyst: 30,
  mins_to_end_date: 90,
  mins_to_uma_end: 120,
};

let app: FastifyInstance | null = null;

async function buildApp(rows: Row[]): Promise<FastifyInstance> {
  app = Fastify({ logger: false });
  registerPaperRoutes(app, { pool: fakePool(rows), authService });
  await app.ready();
  return app;
}

async function buildRespondingApp(
  respond: Responder,
): Promise<FastifyInstance> {
  app = Fastify({ logger: false });
  registerPaperRoutes(app, {
    pool: respondingPool(respond),
    authService,
    broker: {
      clock: () => new Date("2026-08-24T12:00:00.000Z"),
      latencyMs: 1_000,
      logSink: () => undefined,
    },
    newOrderId: () => "order-fixed",
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

describe("GET /polymarket/microstructure/:tokenId", () => {
  it("answers 401 without a token", async () => {
    const instance = await buildApp([WINDOW_ROW]);
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/microstructure/token-1",
    });
    expect(response.statusCode).toBe(401);
  });

  it("answers 404 when the token has no features yet", async () => {
    const instance = await buildApp([]);
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/microstructure/token-1",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      reason_code: "NO_FEATURES_FOR_TOKEN",
    });
  });

  it("serves the latest window per kind with the simulation banner", async () => {
    const instance = await buildApp([WINDOW_ROW]);
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/microstructure/token-1",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.simulation).toBe(SIMULATION_BANNER);
    expect(body.token_id).toBe("token-1");
    const windows = body.windows as Array<Record<string, unknown>>;
    expect(windows).toHaveLength(1);
    const window = windows[0];
    expect(window).toMatchObject({
      window_kind: "1m",
      book_valid: true,
      flow_direction_status: "UNAVAILABLE",
      volume_signed: null,
      last_trade_age_ms: 1500,
      book_staleness_ms: 2000,
      mins_to_catalyst: 30,
    });
    // source_ts and received_ts ride on every feature surface (RFC-011 A).
    expect(window?.["source_ts"]).not.toBeNull();
    expect(window?.["received_ts"]).not.toBeNull();
  });
});

describe("POST /polymarket/paper/orders — RFC-011 hard 422s", () => {
  it("an order without limit_price is a 422 before anything else", async () => {
    const instance = await buildRespondingApp(() => {
      throw new Error("must not touch the database");
    });
    const response = await instance.inject({
      method: "POST",
      url: "/polymarket/paper/orders",
      headers: AUTH,
      payload: { token_id: "tok-yes", side: "BUY", size: "20" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      reason_code: "MISSING_LIMIT_PRICE",
    });
  });

  it("FAK and FOK without worst_price are a 422", async () => {
    for (const orderType of ["FAK", "FOK"]) {
      const instance = await buildRespondingApp(() => {
        throw new Error("must not touch the database");
      });
      const response = await instance.inject({
        method: "POST",
        url: "/polymarket/paper/orders",
        headers: AUTH,
        payload: {
          token_id: "tok-yes",
          side: "BUY",
          size: "20",
          limit_price: "0.50",
          order_type: orderType,
        },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        reason_code: "MISSING_WORST_PRICE",
      });
      await instance.close();
      app = null;
    }
  });

  it("accepts a valid passive order and answers with the banner", async () => {
    const inserts: string[] = [];
    const instance = await buildRespondingApp((text) => {
      if (text.includes("FROM polymarket_markets")) {
        return [{ condition_id: "0xcond" }];
      }
      if (text.startsWith("SELECT engaged")) {
        return [{ engaged: false, reason: null, frozen_markets_json: [] }];
      }
      if (text.includes("FROM polymarket_param_versions")) {
        return [
          {
            param_version_id: 7,
            tick_size: "0.01",
            min_order_size: "5",
            taker_fee_bps: "700",
            neg_risk: false,
          },
        ];
      }
      if (text.includes("FROM polymarket_book_snapshots")) {
        return [
          {
            bids_json: [{ price: "0.48", size: "100" }],
            asks_json: [{ price: "0.52", size: "100" }],
            source_ts: new Date("2026-08-24T11:59:59.000Z"),
            received_at: new Date("2026-08-24T11:59:59.500Z"),
          },
        ];
      }
      if (text.startsWith("INSERT INTO")) {
        inserts.push(text);
        return [{ inserted: true }];
      }
      return [];
    });
    const response = await instance.inject({
      method: "POST",
      url: "/polymarket/paper/orders",
      headers: AUTH,
      payload: {
        token_id: "tok-yes",
        side: "BUY",
        size: "20",
        limit_price: "0.48",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      simulation: SIMULATION_BANNER,
      order_id: "order-fixed",
      status: "open",
    });
    expect(inserts.some((text) => text.includes("paper_orders"))).toBe(true);
    expect(inserts.some((text) => text.includes("paper_ledger_events"))).toBe(
      true,
    );
  });
});

describe("kill switch endpoints", () => {
  it("engages, reports and rearms through the API", async () => {
    let engaged = false;
    const instance = await buildRespondingApp((text) => {
      if (text.includes("SET engaged = TRUE")) {
        engaged = true;
        return [];
      }
      if (text.includes("SET engaged = FALSE")) {
        engaged = false;
        return [];
      }
      if (text.startsWith("SELECT engaged")) {
        return [{ engaged, reason: null, frozen_markets_json: [] }];
      }
      if (
        text.startsWith(
          "SELECT order_id, token_id, condition_id FROM paper_orders",
        )
      ) {
        return [];
      }
      if (text.startsWith("INSERT INTO paper_ledger_events")) {
        return [{ inserted: true }];
      }
      return [];
    });
    const engage = await instance.inject({
      method: "POST",
      url: "/polymarket/paper/kill-switch",
      headers: AUTH,
      payload: { reason: "MANUAL" },
    });
    expect(engage.statusCode).toBe(200);
    expect(engage.json()).toMatchObject({ engaged: true, reason: "MANUAL" });
    const rearm = await instance.inject({
      method: "POST",
      url: "/polymarket/paper/kill-switch/rearm",
      headers: AUTH,
    });
    expect(rearm.statusCode).toBe(200);
    expect(rearm.json()).toMatchObject({ engaged: false });
  });
});
