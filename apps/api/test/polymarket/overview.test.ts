import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { DatabasePool, QueryResult } from "../../src/database.js";
import {
  formatEventCursor,
  parseEventCursor,
  registerOverviewRoutes,
} from "../../src/polymarket/overview.js";
import { RETENTION_TABLES } from "../../src/polymarket/retention.js";

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
    end() {
      return Promise.resolve();
    },
  };
  return { pool, calls };
}

const authService = {
  session(token: string) {
    return Promise.resolve(
      token === "good-token" ? { status: "ok" } : { status: "unauthenticated" },
    );
  },
};

const AUTH = { authorization: "Bearer good-token" };
const FIXED_NOW = new Date("2026-09-01T17:00:00.000Z");

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function build(
  respond: Responder,
  gitSha: () => Promise<string | null> = () => Promise.resolve(null),
): Promise<{ instance: FastifyInstance; calls: CapturedQuery[] }> {
  const { pool, calls } = fakePool(respond);
  const instance = Fastify({ logger: false });
  registerOverviewRoutes(instance, {
    pool,
    authService,
    clock: () => FIXED_NOW,
    gitSha,
  });
  await instance.ready();
  app = instance;
  return { instance, calls };
}

// ---------------------------------------------------------------------------

describe("GET /polymarket/overview", () => {
  it("refuses a request without a bearer token", async () => {
    const { instance } = await build(() => []);
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/overview",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      reason_code: "MISSING_BEARER_TOKEN",
    });
  });

  it("refuses a request whose session is not ok", async () => {
    const { instance } = await build(() => []);
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/overview",
      headers: { authorization: "Bearer wrong" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ reason_code: "INVALID_SESSION" });
  });

  it("aggregates every domain into one response", async () => {
    const { instance } = await build((text) => {
      if (text.includes("FROM portfolio_state WHERE")) {
        return [
          {
            state: "NORMAL",
            reason: null,
            bankroll_usd: "1000.000000",
            equity_usd: "998.791000",
            drawdown: "0.002670",
            realized_pnl_day_usd: "0.000000",
            realized_pnl_week_usd: "0.000000",
          },
        ];
      }
      if (text.includes("portfolio_circuit_breakers")) {
        return [{ abertos: 41, ultima_hora: 88, mais_recente: null }];
      }
      if (text.includes("paper_kill_switch")) {
        return [{ engaged: false, rearmed_at: "2026-09-01T01:46:56Z" }];
      }
      if (text.includes("portfolio_gate_measurements")) {
        return ["G1", "G2", "G3", "G4", "G5", "G6"].map((gate) => ({
          gate,
          status: "INSUFFICIENT_DATA",
          reason_code: `${gate}_SOMETHING`,
          measured_at: "2026-09-01T16:27:18Z",
        }));
      }
      if (text.includes("polymarket_book_deltas")) {
        return [
          {
            ultimo_delta: "2026-09-01T16:59:52.722Z",
            gaps_abertos: 0,
            gaps_24h: 0,
            universo: 64,
          },
        ];
      }
      if (text.includes("fundamental_estimates")) {
        return [
          {
            estimativas_1h: 1233,
            ultima_estimativa: "2026-09-01T16:59:39Z",
            modelos_ativos: 0,
            modelos_shadow: 2,
          },
        ];
      }
      if (text.includes("resolution_market_state")) {
        return [
          {
            mercados: 750,
            bloqueados: 3,
            com_buffer: 12,
            violacoes: 0,
            divergencias: 0,
          },
        ];
      }
      if (text.includes("paper_orders")) {
        return [{ ordens_abertas: 0, posicoes: 2, fills_24h: 0 }];
      }
      if (text.includes("pg_total_relation_size")) {
        return [
          {
            table_name: "portfolio_decisions",
            bytes: "1000",
            reltuples: 10,
            live_tup: "10",
            dead_tup: "0",
            toast_live_tup: "0",
            heap_width: 10,
            index_count: 1,
            index_key_width: 8,
          },
        ];
      }
      return [];
    });

    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/overview",
      headers: AUTH,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.simulation).toBe("SIMULAÇÃO — SEM EXECUÇÃO REAL");
    expect(body.generated_at).toBe(FIXED_NOW.toISOString());
    expect(body.portfolio.state).toBe("NORMAL");
    expect(body.circuit_breakers.open).toBe(41);
    expect(body.kill_switch.engaged).toBe(false);
    expect(body.gates).toHaveLength(6);
    expect(body.collection.universe_members).toBe(64);
    expect(body.model.shadow_models).toBe(2);
    expect(body.resolution.markets).toBe(750);
    expect(body.paper.positions).toBe(2);
    expect(body.limits.drawdown_limit).toBe(0.1);
  });

  it("reports BLOCKED while any gate is not PASS, and only then", async () => {
    const gates = (status: string): Row[] => [
      { gate: "G1", status: "PASS" },
      { gate: "G2", status },
    ];
    for (const [status, expected] of [
      ["INSUFFICIENT_DATA", "BLOCKED"],
      ["FAIL", "BLOCKED"],
      ["PASS", "READY_FOR_OWNER_REVIEW"],
    ] as const) {
      const { instance } = await build((text) =>
        text.includes("portfolio_gate_measurements") ? gates(status) : [],
      );
      const response = await instance.inject({
        method: "GET",
        url: "/polymarket/overview",
        headers: AUTH,
      });
      expect(response.json().rfc_009_status).toBe(expected);
      await instance.close();
      app = null;
    }
  });

  it("reports BLOCKED when no gate has been measured at all", async () => {
    const { instance } = await build(() => []);
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/overview",
      headers: AUTH,
    });
    expect(response.json().rfc_009_status).toBe("BLOCKED");
  });

  it("measures storage over the retention list, in live bytes", async () => {
    const { instance, calls } = await build((text) =>
      text.includes("pg_total_relation_size")
        ? [
            {
              table_name: "polymarket_book_deltas",
              bytes: "1000000",
              reltuples: 100,
              live_tup: "50",
              dead_tup: "50",
              // No pg_stats width -> dead-fraction fallback: 1000000 * 50/100.
              heap_width: null,
              index_count: null,
              index_key_width: null,
              toast_live_tup: null,
            },
          ]
        : [],
    );
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/overview",
      headers: AUTH,
    });
    const body = response.json();
    expect(body.storage.live_bytes).toBe(500_000);
    expect(body.storage.physical_bytes).toBe(1_000_000);
    // Bloat is what a DELETE cannot give back — reported, never pruned.
    expect(body.storage.bloat_bytes).toBe(500_000);

    // The whole retention list is asked for, not just the polymarket_ subset:
    // that population mismatch is half of what RFC-015 §9 fixes.
    const sizeCall = calls.find((call) =>
      call.text.includes("pg_total_relation_size"),
    );
    const requested = sizeCall?.params[0] as string[];
    expect(requested).toHaveLength(RETENTION_TABLES.length);
    expect(requested).toContain("portfolio_decisions");
    expect(requested).toContain("paper_ledger_events");
    expect(requested).toContain("resolution_scores");
  });

  it("carries the release sha so the panel can spot a stale bundle", async () => {
    const sha = "a".repeat(40);
    const { instance } = await build(
      () => [],
      () => Promise.resolve(sha),
    );
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/overview",
      headers: AUTH,
    });
    expect(response.json().release_sha).toBe(sha);
  });

  it("answers 500 with a reason code when a query throws", async () => {
    const { instance } = await build((text) => {
      if (text.includes("portfolio_state WHERE")) {
        throw new Error("boom");
      }
      return [];
    });
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/overview",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      reason_code: "OVERVIEW_API_FAILED",
    });
  });
});

// ---------------------------------------------------------------------------

describe("event cursor", () => {
  it("round-trips a cursor", () => {
    const parsed = parseEventCursor("estado:7,decisao:998");
    expect(parsed.get("estado")).toBe(7);
    expect(parsed.get("decisao")).toBe(998);
    expect(formatEventCursor(parsed)).toBe("estado:7,decisao:998");
  });

  it("drops unknown sources instead of rejecting the cursor", () => {
    // A cursor has to survive a deploy that renames or removes a source.
    // Rejecting would strand the client on a cursor it can never advance past;
    // dropping costs one replay of that source's lookback window.
    const parsed = parseEventCursor("estado:7,fonte-que-nao-existe:3");
    expect(parsed.get("estado")).toBe(7);
    expect(parsed.has("fonte-que-nao-existe")).toBe(false);
  });

  it("drops malformed ids", () => {
    const parsed = parseEventCursor("estado:abc,decisao:-1,ordem:1.5,veto:9");
    expect(parsed.has("estado")).toBe(false);
    expect(parsed.has("decisao")).toBe(false);
    expect(parsed.has("ordem")).toBe(false);
    expect(parsed.get("veto")).toBe(9);
  });

  it("treats an absent cursor as empty", () => {
    expect(parseEventCursor(null).size).toBe(0);
    expect(parseEventCursor("").size).toBe(0);
    expect(formatEventCursor(new Map())).toBe("");
  });
});

describe("GET /polymarket/events", () => {
  it("refuses a request without a session", async () => {
    const { instance } = await build(() => []);
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/events",
    });
    expect(response.statusCode).toBe(401);
  });

  it("queries every source with a keyset predicate, never an offset", async () => {
    const { instance, calls } = await build(() => []);
    await instance.inject({
      method: "GET",
      url: "/polymarket/events",
      headers: AUTH,
    });
    const pages = calls.filter((call) => call.text.includes("LIMIT $2::int"));
    expect(pages.length).toBeGreaterThanOrEqual(8);
    for (const call of pages) {
      expect(call.text).toContain("> COALESCE(");
      expect(call.text).not.toContain("OFFSET");
      // A first load passes a null cursor; the SQL falls back to the id
      // lookback window rather than scanning the table for its tail.
      expect(call.params[0]).toBeNull();
    }
  });

  it("returns the newest first and advances the cursor past every source", async () => {
    const { instance } = await build((text, params) => {
      if (text.includes("MAX(") && !text.includes("LIMIT $2::int")) {
        return [{ head: 500 }];
      }
      if (text.includes("FROM portfolio_state_events")) {
        expect(params[0]).toBeNull();
        return [
          {
            event_id: 4,
            occurred_at: "2026-09-01T10:00:00Z",
            from_state: "NORMAL",
            to_state: "HALTED",
          },
        ];
      }
      if (text.includes("FROM portfolio_decisions")) {
        return [
          {
            event_id: 9,
            occurred_at: "2026-09-01T12:00:00Z",
            decision_kind: "ENTRY",
            market_side: "YES",
            size_shares: "10",
            outcome: "ACCEPTED",
          },
        ];
      }
      return [];
    });

    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/events",
      headers: AUTH,
    });
    const body = response.json();
    expect(body.events).toHaveLength(2);
    expect(body.events[0].source).toBe("decisao");
    expect(body.events[0].occurred_at).toBe("2026-09-01T12:00:00Z");
    expect(body.events[1].source).toBe("estado");
    expect(body.events[1].severity).toBe("alert");
    expect(body.events[1].summary).toBe("NORMAL → HALTED");
    // The detail carries the row minus the two columns already promoted.
    expect(body.events[1].detail).toEqual({
      from_state: "NORMAL",
      to_state: "HALTED",
    });

    // Every source names a floor, including the ones that returned nothing:
    // without it the next poll replays their lookback window every 5 seconds.
    const cursor = parseEventCursor(body.page.next_cursor);
    expect(cursor.size).toBe(8);
    for (const id of cursor.values()) {
      expect(id).toBe(500);
    }
  });

  it("advances a resumed source to the last id it returned", async () => {
    const { instance } = await build((text, params) => {
      if (text.includes("FROM portfolio_decisions") && params[0] === 9) {
        return [
          { event_id: 10, occurred_at: "2026-09-01T13:00:00Z" },
          { event_id: 11, occurred_at: "2026-09-01T13:05:00Z" },
        ];
      }
      if (text.includes("MAX(") && !text.includes("LIMIT $2::int")) {
        return [{ head: 500 }];
      }
      return [];
    });
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/events?after=decisao:9",
      headers: AUTH,
    });
    const cursor = parseEventCursor(response.json().page.next_cursor);
    expect(cursor.get("decisao")).toBe(11);
  });

  it("clamps the limit to the hard cap and to at least one", async () => {
    for (const [asked, expected] of [
      ["9999", 200],
      ["0", 1],
      ["-4", 1],
      ["abc", 60],
    ] as const) {
      const { instance, calls } = await build(() => []);
      await instance.inject({
        method: "GET",
        url: `/polymarket/events?limit=${asked}`,
        headers: AUTH,
      });
      const page = calls.find((call) => call.text.includes("LIMIT $2::int"));
      expect(page?.params[1]).toBe(expected);
      await instance.close();
      app = null;
    }
  });

  it("answers 500 with a reason code when a source throws", async () => {
    const { instance } = await build((text) => {
      if (text.includes("FROM graph_violations")) {
        throw new Error("boom");
      }
      return [];
    });
    const response = await instance.inject({
      method: "GET",
      url: "/polymarket/events",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ reason_code: "EVENTS_API_FAILED" });
  });
});
