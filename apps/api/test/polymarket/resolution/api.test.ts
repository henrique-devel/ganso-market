// RFC-012 phase C: the resolution API surface. Session guard on every route,
// read-only passthrough shapes from the pool, the curated-edge write path
// (author + justification mandatory, revocation), and the Fastify guarantee
// that the static routes are not captured by :marketId.

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type {
  DatabasePool,
  QueryResult,
  SqlExecutor,
} from "../../../src/database.js";
import { registerResolutionRoutes } from "../../../src/polymarket/resolution/api.js";

type Row = Record<string, unknown>;

const authService = {
  session(token: string): Promise<{ status: string }> {
    return Promise.resolve(
      token === "good-token" ? { status: "ok" } : { status: "unauthenticated" },
    );
  },
};

const AUTH = { authorization: "Bearer good-token" };
const NOW = new Date("2026-08-24T12:00:00.000Z");

interface Recorded {
  readonly text: string;
  readonly params: readonly unknown[];
}

interface WorldOptions {
  readonly revokeHits?: number;
}

/** Canned rows for every read route; graph_edges writes are recorded. */
function worldPool(
  record: { writes: Recorded[] },
  options: WorldOptions = {},
): DatabasePool {
  const executor: SqlExecutor = {
    query<R extends Row>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      const respond = (
        rows: Row[],
        rowCount = rows.length,
      ): Promise<QueryResult<R>> =>
        Promise.resolve({ rows: rows as R[], rowCount });
      if (
        text.startsWith(
          "LOCK TABLE polymarket_resolution_input_changes IN SHARE MODE",
        ) ||
        (text.includes("FROM resolution_runtime_state") &&
          text.includes("FOR UPDATE")) ||
        text.includes("UPDATE resolution_runtime_state")
      ) {
        record.writes.push({ text, params });
        return text.includes("FROM resolution_runtime_state")
          ? respond([{ generation: "11111111-1111-4111-8111-111111111111" }])
          : respond([], 1);
      }
      if (text.includes("INSERT INTO graph_edges")) {
        record.writes.push({ text, params });
        return respond([], 1);
      }
      if (text.includes("UPDATE graph_edges")) {
        record.writes.push({ text, params });
        return respond([], options.revokeHits ?? 1);
      }
      // List: current scores of the universe.
      if (
        text.includes("FROM resolution_market_state") &&
        text.includes("ORDER BY s.score DESC")
      ) {
        return respond([
          { condition_id: "0xmkt", score: "0.750000", action: "VETO" },
        ]);
      }
      // Detail: state of one market.
      if (text.includes("SELECT s.*")) {
        return params[0] === "0xmkt"
          ? respond([{ condition_id: "0xmkt", score: "0.750000" }])
          : respond([]);
      }
      // Latest score (features_json) vs. score history.
      if (
        text.includes("FROM resolution_scores") &&
        text.includes("features_json")
      ) {
        return respond([{ score_id: "7", score: "0.750000" }]);
      }
      if (text.includes("FROM resolution_scores")) {
        return respond([
          { score_id: "7", score: "0.750000" },
          { score_id: "6", score: "0.500000" },
        ]);
      }
      if (text.includes("FROM resolution_uma_timeline")) {
        return respond([{ request_index: 1, state: "proposed" }]);
      }
      if (text.includes("FROM resolution_clarifications")) {
        return respond([{ rule_version: 2, classification: "material" }]);
      }
      // Pipeline divergence count before the divergence listings.
      if (
        text.includes("COUNT(*)") &&
        text.includes("FROM resolution_layer_divergences")
      ) {
        return respond([{ active: "3" }]);
      }
      if (
        text.includes("FROM resolution_layer_divergences") &&
        text.includes("ended_at IS NULL")
      ) {
        return respond([{ divergence_id: "1" }]);
      }
      if (text.includes("FROM resolution_layer_divergences")) {
        return respond([{ divergence_id: "0" }]);
      }
      if (text.includes("FROM resolution_reports")) {
        return respond([{ report_id: "1", score_version: "1.0.0" }]);
      }
      if (text.includes("FROM paper_kill_switch")) {
        return respond([{ engaged: false, reason: null }]);
      }
      if (text.includes("FROM paper_orders")) {
        return respond([{ order_id: "o1", status: "open" }]);
      }
      if (text.includes("FROM paper_positions")) {
        return respond([{ token_id: "tok", shares: "10" }]);
      }
      if (text.includes("FROM graph_edges")) {
        return respond([{ edge_key: "IMPLIES:0xa->0xb", kind: "IMPLIES" }]);
      }
      // Graph nodes (ORDER BY s.condition_id).
      if (text.includes("FROM resolution_market_state")) {
        return respond([{ condition_id: "0xmkt", score: "0.750000" }]);
      }
      if (
        text.includes("FROM graph_violations") &&
        text.includes("ended_at IS NULL")
      ) {
        return respond([{ violation_id: "v1" }]);
      }
      if (text.includes("FROM graph_violations")) {
        return respond([]);
      }
      if (
        text.includes("FROM graph_sanity_vetoes") &&
        text.includes("ended_at IS NULL")
      ) {
        return respond([{ veto_id: "s1" }]);
      }
      if (text.includes("FROM graph_sanity_vetoes")) {
        return respond([]);
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  return {
    query: executor.query,
    async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return run(executor);
    },
    end(): Promise<void> {
      return Promise.resolve();
    },
  };
}

async function buildApp(pool: DatabasePool): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerResolutionRoutes(app, { pool, authService, clock: () => NOW });
  await app.ready();
  return app;
}

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app !== null) {
    await app.close();
    app = null;
  }
});

describe("resolution API auth guard", () => {
  it("refuses without a token, refuses a bad token, accepts a good one", async () => {
    app = await buildApp(worldPool({ writes: [] }));

    const missing = await app.inject({
      method: "GET",
      url: "/polymarket/resolution-risk",
    });
    expect(missing.statusCode).toBe(401);
    expect((missing.json() as Row).reason_code).toBe("AUTH_UNAUTHENTICATED");

    const bad = await app.inject({
      method: "GET",
      url: "/polymarket/resolution-risk",
      headers: { authorization: "Bearer bad-token" },
    });
    expect(bad.statusCode).toBe(401);
    expect((bad.json() as Row).reason_code).toBe("AUTH_UNAUTHENTICATED");

    const good = await app.inject({
      method: "GET",
      url: "/polymarket/resolution-risk",
      headers: AUTH,
    });
    expect(good.statusCode).toBe(200);
  });
});

describe("resolution read routes", () => {
  it("lists the scored universe with the pool rows passing through", async () => {
    app = await buildApp(worldPool({ writes: [] }));
    const response = await app.inject({
      method: "GET",
      url: "/polymarket/resolution-risk",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { markets: Row[] };
    expect(body.markets).toHaveLength(1);
    expect(body.markets[0]?.score).toBe("0.750000");
  });

  it("returns 404 MARKET_NOT_SCORED for an unknown market", async () => {
    app = await buildApp(worldPool({ writes: [] }));
    const response = await app.inject({
      method: "GET",
      url: "/polymarket/resolution-risk/0xunknown",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as Row).reason_code).toBe("MARKET_NOT_SCORED");
  });

  it("returns state, latest score, timeline and clarifications for a market", async () => {
    app = await buildApp(worldPool({ writes: [] }));
    const response = await app.inject({
      method: "GET",
      url: "/polymarket/resolution-risk/0xmkt",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Row;
    expect((body.state as Row).condition_id).toBe("0xmkt");
    expect((body.latest_score as Row).score_id).toBe("7");
    expect(body.uma_timeline as Row[]).toHaveLength(1);
    expect(body.clarifications as Row[]).toHaveLength(1);
  });

  it("returns the score history", async () => {
    app = await buildApp(worldPool({ writes: [] }));
    const response = await app.inject({
      method: "GET",
      url: "/polymarket/resolution-risk/0xmkt/history",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { scores: Row[] };
    expect(body.scores).toHaveLength(2);
    expect(body.scores[0]?.score_id).toBe("7");
  });

  it("returns the graph nodes and edges", async () => {
    app = await buildApp(worldPool({ writes: [] }));
    const response = await app.inject({
      method: "GET",
      url: "/polymarket/graph",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { nodes: Row[]; edges: Row[] };
    expect(body.nodes[0]?.condition_id).toBe("0xmkt");
    expect(body.edges[0]?.edge_key).toBe("IMPLIES:0xa->0xb");
  });

  it("returns active and recent violations and sanity vetoes", async () => {
    app = await buildApp(worldPool({ writes: [] }));
    const violations = await app.inject({
      method: "GET",
      url: "/polymarket/graph/violations",
      headers: AUTH,
    });
    expect(violations.statusCode).toBe(200);
    const violationsBody = violations.json() as {
      active: Row[];
      recent: Row[];
    };
    expect(violationsBody.active[0]?.violation_id).toBe("v1");
    expect(violationsBody.recent).toEqual([]);

    const vetoes = await app.inject({
      method: "GET",
      url: "/polymarket/graph/vetoes",
      headers: AUTH,
    });
    expect(vetoes.statusCode).toBe(200);
    const vetoesBody = vetoes.json() as { active: Row[]; recent: Row[] };
    expect(vetoesBody.active[0]?.veto_id).toBe("s1");
    expect(vetoesBody.recent).toEqual([]);
  });

  it("returns the layer divergences", async () => {
    app = await buildApp(worldPool({ writes: [] }));
    const response = await app.inject({
      method: "GET",
      url: "/polymarket/resolution-risk/divergences",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { active: Row[]; recent: Row[] };
    expect(body.active[0]?.divergence_id).toBe("1");
    expect(body.recent[0]?.divergence_id).toBe("0");
  });

  it("returns the measurement reports", async () => {
    app = await buildApp(worldPool({ writes: [] }));
    const response = await app.inject({
      method: "GET",
      url: "/polymarket/resolution-risk/reports",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { reports: Row[] };
    expect(body.reports[0]?.report_id).toBe("1");
  });

  it("returns the paper pipeline snapshot", async () => {
    app = await buildApp(worldPool({ writes: [] }));
    const response = await app.inject({
      method: "GET",
      url: "/polymarket/resolution-risk/pipeline",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Row;
    expect((body.kill_switch as Row).engaged).toBe(false);
    expect(body.open_orders as Row[]).toHaveLength(1);
    expect(body.positions as Row[]).toHaveLength(1);
    expect(body.divergences_active).toBe(3);
    expect(body.checked_at).toBe(NOW.toISOString());
  });

  it("does not let :marketId capture the static /divergences route", async () => {
    app = await buildApp(worldPool({ writes: [] }));
    const response = await app.inject({
      method: "GET",
      url: "/polymarket/resolution-risk/divergences",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Row;
    expect(body.reason_code).toBeUndefined();
    expect(Object.keys(body).sort()).toEqual(["active", "recent"]);
  });
});

describe("POST /polymarket/graph/edges", () => {
  it("inserts a curated IMPLIES edge with author and justification", async () => {
    const record = { writes: [] as Recorded[] };
    app = await buildApp(worldPool(record));
    const response = await app.inject({
      method: "POST",
      url: "/polymarket/graph/edges",
      headers: AUTH,
      payload: {
        kind: "IMPLIES",
        from_condition_id: "0xa",
        to_condition_id: "0xb",
        author: "henrique",
        justification: "A resolvendo YES implica B",
      },
    });
    expect(response.statusCode).toBe(201);
    expect((response.json() as Row).edge_key).toBe("IMPLIES:0xa->0xb");

    const insert = record.writes.find((w) =>
      w.text.includes("INSERT INTO graph_edges"),
    );
    expect(insert).toBeDefined();
    expect(insert?.text).toContain("'curated'");
    expect(insert?.params[0]).toBe("IMPLIES:0xa->0xb");
    expect(insert?.params[1]).toBe("IMPLIES");
    expect(insert?.params[2]).toBe("0xa");
    expect(insert?.params[3]).toBe("0xb");
    expect(insert?.params[6]).toBe("henrique");
    const paramsJson = JSON.parse(String(insert?.params[8])) as Row;
    expect(paramsJson.source).toBe("api");
    const journalLock = record.writes.findIndex((entry) =>
      entry.text.startsWith(
        "LOCK TABLE polymarket_resolution_input_changes IN SHARE MODE",
      ),
    );
    const runtimeLock = record.writes.findIndex(
      (entry) =>
        entry.text.includes("FROM resolution_runtime_state") &&
        entry.text.includes("FOR UPDATE"),
    );
    const graphMutation = record.writes.findIndex((entry) =>
      entry.text.includes("INSERT INTO graph_edges"),
    );
    const invalidation = record.writes.findIndex((entry) =>
      entry.text.includes("UPDATE resolution_runtime_state"),
    );
    expect([journalLock, runtimeLock, graphMutation, invalidation]).toEqual([
      0, 1, 2, 3,
    ]);
    expect(record.writes[invalidation]?.text).toContain(
      "failure_reason = 'CURATED_EDGE_CHANGED'",
    );
    expect(record.writes[invalidation]?.params).toEqual([NOW]);
  });

  it("refuses an edge without an author", async () => {
    const record = { writes: [] as Recorded[] };
    app = await buildApp(worldPool(record));
    const response = await app.inject({
      method: "POST",
      url: "/polymarket/graph/edges",
      headers: AUTH,
      payload: {
        kind: "IMPLIES",
        from_condition_id: "0xa",
        to_condition_id: "0xb",
        justification: "sem autor",
      },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as Row).reason_code).toBe("INVALID_EDGE_BODY");
    expect(record.writes).toHaveLength(0);
  });

  it("revokes an existing curated edge", async () => {
    const record = { writes: [] as Recorded[] };
    app = await buildApp(worldPool(record));
    const response = await app.inject({
      method: "POST",
      url: "/polymarket/graph/edges",
      headers: AUTH,
      payload: {
        revoke: true,
        edge_key: "IMPLIES:0xa->0xb",
        author: "henrique",
        justification: "aresta superada",
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Row;
    expect(body.edge_key).toBe("IMPLIES:0xa->0xb");
    expect(body.revoked).toBe(true);
    const update = record.writes.find((w) =>
      w.text.includes("UPDATE graph_edges"),
    );
    expect(update?.params).toEqual([
      "IMPLIES:0xa->0xb",
      "henrique",
      "aresta superada",
    ]);
    const graphMutation = record.writes.findIndex((entry) =>
      entry.text.includes("UPDATE graph_edges"),
    );
    const invalidation = record.writes.findIndex((entry) =>
      entry.text.includes("UPDATE resolution_runtime_state"),
    );
    expect(graphMutation).toBe(2);
    expect(invalidation).toBe(3);
  });

  it("returns 404 when the revocation matches no curated edge", async () => {
    const record = { writes: [] as Recorded[] };
    app = await buildApp(worldPool(record, { revokeHits: 0 }));
    const response = await app.inject({
      method: "POST",
      url: "/polymarket/graph/edges",
      headers: AUTH,
      payload: {
        revoke: true,
        edge_key: "IMPLIES:0xa->0xz",
        author: "henrique",
        justification: "nao existe",
      },
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as Row).reason_code).toBe("EDGE_NOT_FOUND");
    expect(
      record.writes.some((entry) =>
        entry.text.includes("UPDATE resolution_runtime_state"),
      ),
    ).toBe(false);
  });

  it("refuses a revocation without a justification", async () => {
    const record = { writes: [] as Recorded[] };
    app = await buildApp(worldPool(record));
    const response = await app.inject({
      method: "POST",
      url: "/polymarket/graph/edges",
      headers: AUTH,
      payload: {
        revoke: true,
        edge_key: "IMPLIES:0xa->0xb",
        author: "henrique",
      },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as Row).reason_code).toBe(
      "INVALID_EDGE_REVOCATION",
    );
    expect(record.writes).toHaveLength(0);
  });
});
