// RFC-013 API surface: the session guard on every route, the read shapes the
// dashboard consumes, and the two manual state controls — which are the only
// writes and are deliberately not published by the Nginx perimeter.

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type {
  DatabasePool,
  QueryResult,
  SqlExecutor,
} from "../../../src/database.js";
import { registerPortfolioRoutes } from "../../../src/polymarket/portfolio/api.js";

type Row = Record<string, unknown>;

const authService = {
  session(token: string): Promise<{ status: string }> {
    return Promise.resolve(
      token === "good-token" ? { status: "ok" } : { status: "unauthenticated" },
    );
  },
};

const AUTH = { authorization: "Bearer good-token" };

interface Recorded {
  readonly text: string;
  readonly params: readonly unknown[];
}

/** The fake records writes for the state controls and reads for the pager. */
interface Journal {
  writes: Recorded[];
  reads: Recorded[];
}

function worldPool(
  record: Journal,
  overrides: { readonly state?: Row | null } = {},
): DatabasePool {
  const stateRow: Row | null =
    overrides.state === undefined
      ? {
          state: "NORMAL",
          reason: null,
          bankroll_usd: "1000.000000",
          high_water_mark_usd: "1000.000000",
          equity_usd: "1000.000000",
          drawdown: "0.000000",
          realized_pnl_day_usd: "0.000000",
          realized_pnl_week_usd: "0.000000",
          day_bucket: "2026-08-26",
          week_start: "2026-08-24",
          reduce_only_until: null,
          halted_at: null,
          manual_halt: false,
          config_version: "1.0.0",
          updated_at: new Date("2026-08-26T00:00:00Z"),
        }
      : overrides.state;

  const executor: SqlExecutor = {
    query<R extends Row>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      const respond = (rows: Row[]): Promise<QueryResult<R>> =>
        Promise.resolve({ rows: rows as R[], rowCount: rows.length });
      if (
        text.includes("UPDATE portfolio_state") ||
        text.includes("INSERT INTO portfolio_state_events")
      ) {
        record.writes.push({ text, params });
        return respond([]);
      }
      if (text.includes("FROM portfolio_state WHERE portfolio_id = 1")) {
        return respond(stateRow === null ? [] : [stateRow]);
      }
      if (text.includes("FROM portfolio_panel_snapshots")) {
        return respond([
          {
            snapshot_id: 1,
            condition_id: "0xa",
            token_id: "t1",
            computed_at: new Date("2026-08-26T00:00:00Z"),
            panel_json: { suggested_side: "YES" },
            decision_id: 7,
            entrable: false,
            vetoed: true,
            veto_reason: "RFC-012: veto de resolução",
            config_version: "1.0.0",
          },
        ]);
      }
      if (text.includes("FROM portfolio_exposures")) {
        return respond([
          {
            dimension: "market",
            dimension_key: "0xa",
            worst_case_usd: "40.000000",
            cap_usd: "50.000000",
            utilization: "0.800000",
            position_count: 1,
            unwind_cost_usd: null,
            computed_at: new Date("2026-08-26T00:00:00Z"),
          },
        ]);
      }
      if (text.includes("ORDER BY measurement_id DESC")) {
        record.reads.push({ text, params });
        // The endpoint asks for limit + 1 to learn whether a next page exists;
        // the fake obliges so the cursor logic is exercised for real.
        const limit = Number(params[5] ?? 0);
        const after =
          params[4] === null || params[4] === undefined
            ? 1_000
            : Number(params[4]);
        const rows: Row[] = [];
        for (let id = after - 1; id > 0 && rows.length < limit; id -= 1) {
          rows.push({
            measurement_id: id,
            gate: "G2",
            status: "INSUFFICIENT_DATA",
            reason_code: "G2_INSUFFICIENT_PAPER",
            metrics_json: { days: 1 },
            config_version: "1.1.0",
            window_from: null,
            window_to: null,
            measured_at: new Date("2026-08-26T00:00:00Z"),
          });
        }
        return respond(rows);
      }
      if (text.includes("FROM portfolio_gate_measurements")) {
        return respond([
          {
            gate: "G2",
            status: "INSUFFICIENT_DATA",
            reason_code: "G2_INSUFFICIENT_PAPER",
            metrics_json: { days: 1 },
            config_version: "1.0.0",
            window_from: null,
            window_to: null,
            measured_at: new Date("2026-08-26T00:00:00Z"),
          },
        ]);
      }
      if (text.includes("FROM portfolio_gate_reports")) {
        return respond([]);
      }
      if (text.includes("FROM portfolio_state_events")) {
        return respond([
          {
            state_event_id: 1,
            from_state: "NORMAL",
            to_state: "REDUCE_ONLY",
            reason: "perda_diaria_max",
            trigger_source: "daily_loss",
            at: new Date("2026-08-26T00:00:00Z"),
          },
        ]);
      }
      if (text.includes("FROM portfolio_circuit_breakers")) {
        return respond([]);
      }
      if (text.includes("FROM portfolio_decisions WHERE decision_id")) {
        return respond(
          params[0] === 7 ? [{ decision_id: 7, outcome: "REJECTED" }] : [],
        );
      }
      if (text.includes("FROM portfolio_decisions")) {
        record.reads.push({ text, params });
        return respond([
          {
            decision_id: 7,
            decision_kind: "ENTRY",
            condition_id: "0xa",
            token_id: "t1",
            decision_ts: new Date("2026-08-26T00:00:00Z"),
            market_side: "YES",
            order_side: "BUY",
            edge_net: "0.030000",
            size_shares: "10.000000",
            binding_constraint: "CAP_MERCADO",
            outcome: "REJECTED",
            reason_code: "RESOLUTION_VETO",
            portfolio_state: "NORMAL",
            config_version: "1.0.0",
            config_hash: "a".repeat(64),
          },
        ]);
      }
      return respond([]);
    },
  };
  return {
    query: executor.query.bind(executor),
    transaction: async <T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> =>
      fn(executor),
  } as unknown as DatabasePool;
}

let app: FastifyInstance | null = null;

async function buildApp(pool: DatabasePool): Promise<FastifyInstance> {
  const instance = Fastify();
  registerPortfolioRoutes(instance, { pool, authService });
  await instance.ready();
  app = instance;
  return instance;
}

afterEach(async () => {
  await app?.close();
  app = null;
});

const READ_ROUTES = [
  "/polymarket/opportunities",
  "/polymarket/portfolio/exposure",
  "/polymarket/portfolio/limits",
  "/polymarket/portfolio/state",
  "/polymarket/gates",
  "/polymarket/gates/measurements",
  "/polymarket/decisions",
];

describe("GET /polymarket/decisions", () => {
  // RFC-015 §3: the 500 of 2026-08-31 18:21Z. There is no index on
  // decision_ts alone, so `ORDER BY decision_ts DESC LIMIT 500` was a parallel
  // seq scan plus a top-N sort over the whole table — 715 ms measured in
  // production against the API pool's 1000 ms statement_timeout, on a table
  // that grows ~545 MB/day. decision_id is the primary key: index-only scan
  // backward, 0.17 ms measured, and a TOTAL order where decision_ts ties.
  it("pages the decision log on the primary key, never on decision_ts", async () => {
    const record = { writes: [] as Recorded[], reads: [] as Recorded[] };
    const instance = await buildApp(worldPool(record));
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/decisions",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const read = record.reads.find(
      (query) =>
        query.text.includes("FROM portfolio_decisions") &&
        query.text.includes("LIMIT"),
    );
    expect(read).toBeDefined();
    expect(read?.text).toContain("ORDER BY decision_id DESC");
    expect(read?.text).not.toContain("ORDER BY decision_ts DESC");
  });
});

describe("session guard", () => {
  it("refuses every route without a token", async () => {
    const instance = await buildApp(worldPool({ writes: [], reads: [] }));
    for (const url of READ_ROUTES) {
      const response = await instance.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
    }
    for (const url of [
      "/polymarket/portfolio/halt",
      "/polymarket/portfolio/resume",
    ]) {
      const response = await instance.inject({ method: "POST", url });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it("refuses a bad token", async () => {
    const instance = await buildApp(worldPool({ writes: [], reads: [] }));
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/opportunities",
      headers: { authorization: "Bearer nope" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("read surface", () => {
  it("SHOWS a vetoed opportunity, carrying its reason", async () => {
    // Hiding it would let the panel imply the universe is cleaner than it is.
    const instance = await buildApp(worldPool({ writes: [], reads: [] }));
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/opportunities",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      simulation: string;
      opportunities: { vetoed: boolean; veto_reason: string }[];
    };
    expect(body.simulation).toContain("SIMULAÇÃO");
    expect(body.opportunities[0]?.vetoed).toBe(true);
    expect(body.opportunities[0]?.veto_reason).toContain("veto");
  });

  it("states that exposures are measured at TOTAL LOSS", async () => {
    const instance = await buildApp(worldPool({ writes: [], reads: [] }));
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/portfolio/exposure",
      headers: AUTH,
    });
    const body = response.json() as { basis: string };
    expect(body.basis).toContain("perda total");
  });

  it("reports RFC-009 as BLOCKED while any gate is not PASS", async () => {
    const instance = await buildApp(worldPool({ writes: [], reads: [] }));
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/gates",
      headers: AUTH,
    });
    const body = response.json() as {
      rfc_009_status: string;
      calibrated_expectation: string;
    };
    expect(body.rfc_009_status).toBe("BLOCKED");
    expect(body.calibrated_expectation).toContain("84%");
  });

  it("404s an unknown decision instead of returning an empty object", async () => {
    const instance = await buildApp(worldPool({ writes: [], reads: [] }));
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/decisions/999",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects a non-numeric decision id", async () => {
    const instance = await buildApp(worldPool({ writes: [], reads: [] }));
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/decisions/abc",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("manual state controls", () => {
  it("halts and records the transition", async () => {
    const record: Journal = { writes: [], reads: [] };
    const instance = await buildApp(worldPool(record));
    const response = await instance.inject({
      method: "POST",
      url: "/polymarket/portfolio/halt",
      headers: AUTH,
      payload: { reason: "operator" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { state: string; changed: boolean };
    expect(body.state).toBe("HALTED");
    expect(body.changed).toBe(true);
    expect(
      record.writes.some((write) =>
        write.text.includes("INSERT INTO portfolio_state_events"),
      ),
    ).toBe(true);
  });

  it("is idempotent: halting an already halted portfolio writes nothing", async () => {
    const record: Journal = { writes: [], reads: [] };
    const instance = await buildApp(
      worldPool(record, {
        state: {
          state: "HALTED",
          reason: "drawdown_max",
          bankroll_usd: "900.000000",
          high_water_mark_usd: "1000.000000",
          equity_usd: "900.000000",
          drawdown: "0.100000",
          realized_pnl_day_usd: "0.000000",
          realized_pnl_week_usd: "0.000000",
          day_bucket: "2026-08-26",
          week_start: "2026-08-24",
          reduce_only_until: null,
          halted_at: new Date("2026-08-26T00:00:00Z"),
          manual_halt: false,
        },
      }),
    );
    const response = await instance.inject({
      method: "POST",
      url: "/polymarket/portfolio/halt",
      headers: AUTH,
      payload: {},
    });
    const body = response.json() as { changed: boolean };
    expect(body.changed).toBe(false);
    expect(record.writes).toHaveLength(0);
  });

  it("REQUIRES an explicit confirmation to resume", async () => {
    // Leaving HALTED is exactly the action that must not happen by reflex.
    const instance = await buildApp(worldPool({ writes: [], reads: [] }));
    const response = await instance.inject({
      method: "POST",
      url: "/polymarket/portfolio/resume",
      headers: AUTH,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { reason_code: string }).reason_code).toBe(
      "RESUME_REQUIRES_CONFIRMATION",
    );
  });

  it("refuses to resume something that is not HALTED", async () => {
    const instance = await buildApp(worldPool({ writes: [], reads: [] }));
    const response = await instance.inject({
      method: "POST",
      url: "/polymarket/portfolio/resume",
      headers: AUTH,
      payload: { confirm: true },
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { reason_code: string }).reason_code).toBe(
      "NOT_HALTED",
    );
  });

  it("refuses to resume while the drawdown is still breached", async () => {
    const instance = await buildApp(
      worldPool(
        { writes: [], reads: [] },
        {
          state: {
            state: "HALTED",
            reason: "drawdown_max",
            bankroll_usd: "880.000000",
            high_water_mark_usd: "1000.000000",
            equity_usd: "880.000000",
            drawdown: "0.120000",
            realized_pnl_day_usd: "0.000000",
            realized_pnl_week_usd: "0.000000",
            day_bucket: "2026-08-26",
            week_start: "2026-08-24",
            reduce_only_until: null,
            halted_at: new Date("2026-08-26T00:00:00Z"),
            manual_halt: false,
          },
        },
      ),
    );
    const response = await instance.inject({
      method: "POST",
      url: "/polymarket/portfolio/resume",
      headers: AUTH,
      payload: { confirm: true },
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { reason_code: string }).reason_code).toBe(
      "DRAWDOWN_STILL_BREACHED",
    );
  });

  it("resumes a cleared halt and re-bases the high-water mark", async () => {
    const record: Journal = { writes: [], reads: [] };
    const instance = await buildApp(
      worldPool(record, {
        state: {
          state: "HALTED",
          reason: "manual",
          bankroll_usd: "950.000000",
          high_water_mark_usd: "1000.000000",
          equity_usd: "950.000000",
          drawdown: "0.050000",
          realized_pnl_day_usd: "0.000000",
          realized_pnl_week_usd: "0.000000",
          day_bucket: "2026-08-26",
          week_start: "2026-08-24",
          reduce_only_until: null,
          halted_at: new Date("2026-08-26T00:00:00Z"),
          manual_halt: true,
        },
      }),
    );
    const response = await instance.inject({
      method: "POST",
      url: "/polymarket/portfolio/resume",
      headers: AUTH,
      payload: { confirm: true },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      state: string;
      high_water_mark_rebased: string;
    };
    expect(body.state).toBe("NORMAL");
    // Without re-basing it would halt again on the next tick.
    expect(body.high_water_mark_rebased).toBe("950.000000");
  });
});

// ---------------------------------------------------------------------------
// The query space that stands in for the RFC's weekly report.
// ---------------------------------------------------------------------------

describe("gate measurement history", () => {
  it("returns a page and a cursor for the next one", async () => {
    const record: Journal = { writes: [], reads: [] };
    const instance = await buildApp(worldPool(record));
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/gates/measurements?limit=3",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      measurements: { measurement_id: number }[];
      page: { limit: number; next_cursor: string | null };
      calibrated_expectation: string;
    };
    expect(body.measurements).toHaveLength(3);
    expect(body.page.limit).toBe(3);
    expect(body.page.next_cursor).toBe("997");
    // The expectation travels with the numbers: nobody paging through months of
    // measurements should have to remember that a PASS is not a promise.
    expect(body.calibrated_expectation).toContain("84%");
  });

  it("pages forward by cursor, never by OFFSET", async () => {
    const record: Journal = { writes: [], reads: [] };
    const instance = await buildApp(worldPool(record));
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/gates/measurements?limit=2&cursor=500",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      measurements: { measurement_id: number }[];
    };
    expect(body.measurements.map((row) => row.measurement_id)).toEqual([
      499, 498,
    ]);
    const query = record.reads.at(-1);
    expect(query?.text).toContain("measurement_id < $5");
    expect(query?.text).not.toContain("OFFSET");
  });

  it("stops offering a cursor on the last page", async () => {
    const record: Journal = { writes: [], reads: [] };
    const instance = await buildApp(worldPool(record));
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/gates/measurements?limit=5&cursor=3",
      headers: AUTH,
    });
    const body = response.json() as {
      measurements: unknown[];
      page: { next_cursor: string | null };
    };
    expect(body.measurements).toHaveLength(2);
    expect(body.page.next_cursor).toBeNull();
  });

  it("passes the filters through to the query", async () => {
    const record: Journal = { writes: [], reads: [] };
    const instance = await buildApp(worldPool(record));
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/gates/measurements?gate=G2&status=FAIL&from=2026-08-01T00:00:00Z",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const params = record.reads.at(-1)?.params ?? [];
    expect(params[0]).toBe("G2");
    expect(params[1]).toBe("FAIL");
    expect(params[2]).toBeInstanceOf(Date);
    expect(params[3]).toBeNull();
  });

  it("refuses malformed input instead of quietly answering another question", async () => {
    // Ignoring a bad `from` would return a different result set than the one
    // asked for, and the caller would have no way to tell.
    const record: Journal = { writes: [], reads: [] };
    const instance = await buildApp(worldPool(record));
    const cases: readonly [string, string][] = [
      ["?gate=G9", "INVALID_GATE"],
      ["?status=MAYBE", "INVALID_GATE_STATUS"],
      ["?from=not-a-date", "INVALID_TIME_RANGE"],
      ["?limit=0", "INVALID_LIMIT"],
      ["?limit=5000", "INVALID_LIMIT"],
      ["?cursor=-1", "INVALID_CURSOR"],
      ["?cursor=abc", "INVALID_CURSOR"],
    ];
    for (const [query, reasonCode] of cases) {
      const response = await instance.inject({
        method: "GET",
        url: `/polymarket/gates/measurements${query}`,
        headers: AUTH,
      });
      expect(response.statusCode, query).toBe(400);
      expect((response.json() as { reason_code: string }).reason_code).toBe(
        reasonCode,
      );
    }
  });
});
