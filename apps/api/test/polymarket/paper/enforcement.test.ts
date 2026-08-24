// RFC-012 task 17 at the endpoint level: the paper broker consults the
// resolution gate before ANY acceptance, refusals carry the justification,
// and a manual override_veto is audited in the ledger's order_accepted event.

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { QueryResult, SqlExecutor } from "../../../src/database.js";
import { registerPaperRoutes } from "../../../src/polymarket/paper/api.js";
import type {
  ResolutionGateFn,
  ResolutionGateResult,
} from "../../../src/polymarket/resolution/enforcement.js";

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

function gateResult(
  overrides: Partial<ResolutionGateResult> = {},
): ResolutionGateResult {
  return {
    allowed: true,
    reason: null,
    action: "NONE",
    score: "0.100000",
    scoreVersion: "1.0.0",
    justification: "R=0.100 abaixo de r_buffer",
    resolutionBuffer: "0.000000",
    p5050: "0.002000",
    sanityVetoActive: false,
    overrideApplied: false,
    ...overrides,
  };
}

/** World enough for the manual-order happy path with a fresh book. */
function worldPool(record: {
  ledger: Array<{ text: string; params: readonly unknown[] }>;
}): SqlExecutor {
  return {
    query<R extends Row>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      const respond = (rows: Row[]): Promise<QueryResult<R>> =>
        Promise.resolve({ rows: rows as R[], rowCount: rows.length });
      if (text.includes("FROM polymarket_markets")) {
        return respond([{ condition_id: "0xmkt" }]);
      }
      if (text.includes("FROM paper_kill_switch")) {
        return respond([
          { engaged: false, reason: null, frozen_markets_json: [] },
        ]);
      }
      if (text.includes("FROM polymarket_param_versions")) {
        return respond([
          {
            param_version_id: "1",
            tick_size: "0.01",
            min_order_size: "5",
            taker_fee_bps: "0",
            neg_risk: false,
          },
        ]);
      }
      if (text.includes("FROM polymarket_book_snapshots")) {
        return respond([
          {
            bids_json: [{ price: "0.40", size: "100" }],
            asks_json: [{ price: "0.60", size: "100" }],
            source_ts: NOW,
            received_at: NOW,
          },
        ]);
      }
      if (text.includes("INSERT INTO paper_orders")) {
        return respond([]);
      }
      if (text.includes("INSERT INTO paper_ledger_events")) {
        record.ledger.push({ text, params });
        return respond([{ event_id: "1" }]);
      }
      if (text.includes("FROM paper_feature_windows")) {
        return respond([]);
      }
      return respond([]);
    },
  };
}

async function buildApp(
  pool: SqlExecutor,
  gate: ResolutionGateFn,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerPaperRoutes(app, {
    pool,
    authService,
    resolutionGateFn: gate,
    broker: { clock: () => NOW },
    newOrderId: () => "order-1",
  });
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

describe("paper endpoints under the RFC-012 gate", () => {
  it("refuses an intent under VETO with the justification", async () => {
    const calls: unknown[] = [];
    app = await buildApp(worldPool({ ledger: [] }), (input) => {
      calls.push(input);
      return Promise.resolve(
        gateResult({
          allowed: false,
          reason: "RESOLUTION_VETO",
          action: "VETO",
          score: "0.810000",
          justification: "flag dura: SUBJECTIVE_SOURCE",
        }),
      );
    });
    const response = await app.inject({
      method: "POST",
      url: "/polymarket/paper/intents",
      headers: AUTH,
      payload: { token_id: "tok", side: "BUY", q_lo: "0.55", size_max: "10" },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json() as Row;
    expect(body.reason_code).toBe("RESOLUTION_VETO");
    expect((body.resolution as Row).justification).toContain(
      "SUBJECTIVE_SOURCE",
    );
    expect(calls).toHaveLength(1);
    expect((calls[0] as Row).source).toBe("intent");
  });

  it("refuses an intent under CIRCUIT_BREAKER", async () => {
    app = await buildApp(worldPool({ ledger: [] }), () =>
      Promise.resolve(
        gateResult({
          allowed: false,
          reason: "RESOLUTION_CIRCUIT_BREAKER",
          action: "CIRCUIT_BREAKER",
        }),
      ),
    );
    const response = await app.inject({
      method: "POST",
      url: "/polymarket/paper/intents",
      headers: AUTH,
      payload: { token_id: "tok", side: "BUY", q_lo: "0.55", size_max: "10" },
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as Row).reason_code).toBe(
      "RESOLUTION_CIRCUIT_BREAKER",
    );
  });

  it("returns the resolution_buffer on an accepted intent", async () => {
    app = await buildApp(worldPool({ ledger: [] }), () =>
      Promise.resolve(
        gateResult({
          action: "BUFFER",
          resolutionBuffer: "0.020000",
          p5050: "0.050000",
        }),
      ),
    );
    const response = await app.inject({
      method: "POST",
      url: "/polymarket/paper/intents",
      headers: AUTH,
      payload: { token_id: "tok", side: "BUY", q_lo: "0.70", size_max: "10" },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as Row;
    expect(body.resolution_action).toBe("BUFFER");
    // q_lo 0.70 >> ask 0.60: the policy takes at 0.60, so the 50/50 tail adds
    // p5050 x (0.60 - 0.50) = 0.005 on top of the 0.02 base.
    expect(body.resolution_buffer).toBe("0.025000");
  });

  it("refuses a manual order under CIRCUIT_BREAKER", async () => {
    app = await buildApp(worldPool({ ledger: [] }), () =>
      Promise.resolve(
        gateResult({
          allowed: false,
          reason: "RESOLUTION_CIRCUIT_BREAKER",
          action: "CIRCUIT_BREAKER",
        }),
      ),
    );
    const response = await app.inject({
      method: "POST",
      url: "/polymarket/paper/orders",
      headers: AUTH,
      payload: {
        token_id: "tok",
        side: "BUY",
        size: "10",
        limit_price: "0.40",
      },
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as Row).reason_code).toBe(
      "RESOLUTION_CIRCUIT_BREAKER",
    );
  });

  it("audits a manual VETO override in the ledger", async () => {
    const record = {
      ledger: [] as Array<{ text: string; params: readonly unknown[] }>,
    };
    const inputs: unknown[] = [];
    app = await buildApp(worldPool(record), (input) => {
      inputs.push(input);
      if (input.overrideVeto === true) {
        return Promise.resolve(
          gateResult({
            action: "VETO",
            score: "0.750000",
            justification: "R=0.750 >= r_veto=0.7",
            overrideApplied: true,
          }),
        );
      }
      return Promise.resolve(
        gateResult({
          allowed: false,
          reason: "RESOLUTION_VETO",
          action: "VETO",
        }),
      );
    });

    const refused = await app.inject({
      method: "POST",
      url: "/polymarket/paper/orders",
      headers: AUTH,
      payload: {
        token_id: "tok",
        side: "BUY",
        size: "10",
        limit_price: "0.40",
      },
    });
    expect(refused.statusCode).toBe(409);

    const overridden = await app.inject({
      method: "POST",
      url: "/polymarket/paper/orders",
      headers: AUTH,
      payload: {
        token_id: "tok",
        side: "BUY",
        size: "10",
        limit_price: "0.40",
        override_veto: true,
      },
    });
    expect(overridden.statusCode).toBe(201);
    const body = overridden.json() as Row;
    expect((body.override_veto as Row).score).toBe("0.750000");

    // The order_accepted ledger event carries the override audit trail.
    const accepted = record.ledger.find((entry) =>
      String(entry.params[1]).includes("accepted"),
    );
    expect(accepted).toBeDefined();
    const payload = JSON.parse(
      String(
        accepted?.params.find(
          (p) => typeof p === "string" && String(p).includes("override_veto"),
        ),
      ),
    ) as Row;
    expect((payload.override_veto as Row).action).toBe("VETO");
    expect((payload.override_veto as Row).justification).toContain("r_veto");
  });
});
