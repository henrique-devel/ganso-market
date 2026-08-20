import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { DatabasePool, QueryResult } from "../../../src/database.js";
import {
  registerFundamentalRoutes,
  type FundamentalRoutesDeps,
  type GateReportRecord,
  type LifecycleResult,
} from "../../../src/polymarket/fundamental/api.js";
import type { ModelRecord } from "../../../src/polymarket/fundamental/types.js";

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
  session(token: string): Promise<{ readonly status: string }> {
    return Promise.resolve(
      token === "good-token" ? { status: "ok" } : { status: "unauthenticated" },
    );
  },
};

const AUTH = { authorization: "Bearer good-token" };
const FIXED_NOW = new Date("2026-08-19T12:00:00.000Z");

const MODEL_ID = "crypto_updown_normal-1.0.0";

const SHADOW_MODEL: ModelRecord = {
  modelId: MODEL_ID,
  modelFamily: "crypto_updown_normal",
  category: "crypto_updown",
  version: "1.0.0",
  gitSha: "a".repeat(40),
  featureSetVersion: "1.0.0",
  hyperparams: { lambda: 0.94 },
  seed: 20_260_819,
  trainWindowStart: new Date("2026-05-01T00:00:00.000Z"),
  trainWindowEnd: new Date("2026-06-01T00:00:00.000Z"),
  regimeMix: false,
  status: "shadow",
  lastGateReportId: 7,
  createdAt: new Date("2026-06-02T00:00:00.000Z"),
  promotedAt: null,
  demotedAt: null,
  retiredAt: null,
};

const ACTIVE_MODEL: ModelRecord = {
  ...SHADOW_MODEL,
  status: "active",
  promotedAt: new Date("2026-08-19T12:00:00.000Z"),
};

const FAILED_GATE: GateReportRecord = {
  gateReportId: 7,
  modelId: MODEL_ID,
  category: "crypto_updown",
  verdict: "NO_EVIDENCE_OF_ALPHA",
  failures: ["BRIER_NOT_NON_INFERIOR", "HORIZON_SLICE_DEGRADED:6h_24h"],
  marketsCovered: 118,
  observations: 4_200,
  windowFrom: new Date("2026-07-01T00:00:00.000Z"),
  windowTo: new Date("2026-08-01T00:00:00.000Z"),
  metrics: {
    deltaBrier: { point: 0.004, lower: 0.001, upper: 0.008 },
    intervalCoverage: 0.87,
  },
  gitSha: "b".repeat(40),
  featureSetVersion: "1.0.0",
  evaluatedAt: new Date("2026-08-01T01:00:00.000Z"),
};

// One MARKET_BASELINE row exactly as the table stores it: fallback_reason set,
// model provenance null, probabilities as six-digit decimal strings.
const BASELINE_ROW: Row = {
  estimate_id: "10",
  market_id: "0xcond",
  token_id: "111",
  category: "crypto_updown",
  decision_ts: new Date("2026-08-19T11:59:00.000Z"),
  q: "0.512000",
  q_lo: "0.482000",
  q_hi: "0.542000",
  source: "MARKET_BASELINE",
  status: "active",
  model_id: null,
  model_version: null,
  feature_set_version: null,
  git_sha: null,
  data_refs: { bookSourceTs: "2026-08-19T11:58:58.000Z" },
  market_prob: "0.512000",
  exec_spread: "0.020000",
  book_stale: false,
  feed_stale: false,
  thin_book: true,
  rule_changed_recently: false,
  fallback_reason: "NO_ACTIVE_MODEL",
  interval_version: "1.0.0",
  microprice_version: "1.0.0",
  received_at: new Date("2026-08-19T11:59:00.100Z"),
};

const SHADOW_ROW: Row = {
  ...BASELINE_ROW,
  estimate_id: "11",
  source: "MODEL",
  status: "shadow",
  model_id: MODEL_ID,
  model_version: "1.0.0",
  feature_set_version: "1.0.0",
  git_sha: "a".repeat(40),
  fallback_reason: null,
};

let app: FastifyInstance | null = null;

async function buildApp(
  overrides: Partial<FundamentalRoutesDeps> & { pool: DatabasePool },
): Promise<FastifyInstance> {
  app = Fastify({ logger: false });
  registerFundamentalRoutes(app, {
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
      url: "/polymarket/estimates?market_id=0xcond",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      reason_code: "AUTH_UNAUTHENTICATED",
    });
    expect(response.json().correlation_id).toBeTypeOf("string");
    expect(calls).toHaveLength(0);
  });

  it("rejects a token the auth service does not accept with 401", async () => {
    const { pool, calls } = fakePool();
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/estimates/latest",
      headers: { authorization: "Bearer wrong" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().reason_code).toBe("AUTH_UNAUTHENTICATED");
    expect(calls).toHaveLength(0);
  });

  it("guards the lifecycle routes too", async () => {
    const { pool } = fakePool();
    const promoted: string[] = [];
    const server = await buildApp({
      pool,
      promoteModelFn: (_pool, modelId) => {
        promoted.push(modelId);
        return Promise.resolve<LifecycleResult>({
          ok: true,
          model: ACTIVE_MODEL,
        });
      },
    });
    const response = await server.inject({
      method: "POST",
      url: `/polymarket/models/${MODEL_ID}/promote`,
    });
    expect(response.statusCode).toBe(401);
    expect(promoted).toHaveLength(0);
  });
});

describe("GET /polymarket/estimates", () => {
  it("requires market_id", async () => {
    const { pool, calls } = fakePool();
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/estimates",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().reason_code).toBe("MARKET_ID_REQUIRED");
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-ISO window with 400 INVALID_TIMESTAMP", async () => {
    const { pool, calls } = fakePool();
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/estimates?market_id=0xcond&from=1787098643398",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().reason_code).toBe("INVALID_TIMESTAMP");
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-numeric limit with 400 INVALID_LIMIT", async () => {
    const { pool, calls } = fakePool();
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/estimates?market_id=0xcond&limit=all",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().reason_code).toBe("INVALID_LIMIT");
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-boolean include_shadow with 400", async () => {
    const { pool } = fakePool();
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/estimates?market_id=0xcond&include_shadow=yes",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().reason_code).toBe("INVALID_INCLUDE_SHADOW");
  });

  it("hides shadow rows by default and returns complete provenance", async () => {
    const { pool, calls } = fakePool(() => [BASELINE_ROW]);
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url:
        "/polymarket/estimates?market_id=0xcond" +
        "&from=2026-08-19T10:00:00Z&to=2026-08-19T12:00:00Z&limit=50",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const call = calls[0];
    expect(call?.text).toContain("FROM fundamental_estimates");
    expect(call?.text).toContain("status = 'active'");
    expect(call?.text).toContain("decision_ts >= $2");
    expect(call?.text).toContain("decision_ts < $3");
    expect(call?.text).toContain("LIMIT 50");
    expect(call?.params[0]).toBe("0xcond");

    const body = response.json();
    expect(body.include_shadow).toBe(false);
    expect(body.estimates).toHaveLength(1);
    expect(body.estimates[0]).toEqual({
      estimate_id: "10",
      market_id: "0xcond",
      token_id: "111",
      category: "crypto_updown",
      decision_ts: "2026-08-19T11:59:00.000Z",
      q: "0.512000",
      q_lo: "0.482000",
      q_hi: "0.542000",
      source: "MARKET_BASELINE",
      status: "active",
      model_id: null,
      model_version: null,
      feature_set_version: null,
      git_sha: null,
      data_refs: { bookSourceTs: "2026-08-19T11:58:58.000Z" },
      market_prob: "0.512000",
      exec_spread: "0.020000",
      book_stale: false,
      feed_stale: false,
      thin_book: true,
      rule_changed_recently: false,
      fallback_reason: "NO_ACTIVE_MODEL",
      interval_version: "1.0.0",
      microprice_version: "1.0.0",
      received_at: "2026-08-19T11:59:00.100Z",
    });
  });

  it("includes shadow rows only when include_shadow=true", async () => {
    const { pool, calls } = fakePool(() => [BASELINE_ROW, SHADOW_ROW]);
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/estimates?market_id=0xcond&include_shadow=true",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(calls[0]?.text).not.toContain("status = 'active'");
    const body = response.json();
    expect(body.include_shadow).toBe(true);
    expect(body.estimates.map((row: Row) => row["status"])).toEqual([
      "active",
      "shadow",
    ]);
    expect(body.estimates[1].model_id).toBe(MODEL_ID);
    expect(body.estimates[1].git_sha).toBe("a".repeat(40));
  });
});

describe("GET /polymarket/estimates/latest", () => {
  it("returns the latest active estimate per token, shadow rows excluded", async () => {
    const { pool, calls } = fakePool(() => [BASELINE_ROW]);
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/estimates/latest?category=crypto_updown",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const call = calls[0];
    expect(call?.text).toContain("SELECT DISTINCT ON (token_id)");
    // Shadow rows are gate material; the consumer surface never sees them.
    expect(call?.text).toContain("status = 'active'");
    expect(call?.text).toContain("category = $1");
    expect(call?.text).toContain(
      "ORDER BY token_id, decision_ts DESC, estimate_id DESC",
    );
    expect(call?.params[0]).toBe("crypto_updown");
    const body = response.json();
    expect(body.as_of).toBe(FIXED_NOW.toISOString());
    expect(body.category).toBe("crypto_updown");
    expect(body.estimates[0].token_id).toBe("111");
  });

  it("returns every category when none is given", async () => {
    const { pool, calls } = fakePool(() => []);
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/estimates/latest",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(calls[0]?.text).not.toContain("category = $1");
    expect(calls[0]?.params).toHaveLength(0);
    expect(response.json().category).toBeNull();
  });

  it("rejects a category outside the two allowed values with 400", async () => {
    const { pool, calls } = fakePool();
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/estimates/latest?category=sports",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().reason_code).toBe("INVALID_CATEGORY");
    expect(calls).toHaveLength(0);
  });
});

describe("GET /polymarket/models", () => {
  it("lists the registry with each model's latest gate verdict", async () => {
    const { pool, calls } = fakePool((text) =>
      text.includes("fundamental_gate_reports")
        ? [
            {
              model_id: MODEL_ID,
              gate_report_id: "7",
              verdict: "NO_EVIDENCE_OF_ALPHA",
              failures_json: ["BRIER_NOT_NON_INFERIOR"],
              markets_covered: 118,
              observations: 4200,
              window_from: new Date("2026-07-01T00:00:00.000Z"),
              window_to: new Date("2026-08-01T00:00:00.000Z"),
              evaluated_at: new Date("2026-08-01T01:00:00.000Z"),
            },
          ]
        : [],
    );
    const server = await buildApp({
      pool,
      listModelsFn: () => Promise.resolve([SHADOW_MODEL]),
    });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/models",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(calls[0]?.text).toContain("FROM fundamental_gate_reports");
    expect(calls[0]?.params[0]).toEqual([MODEL_ID]);

    const body = response.json();
    expect(body.as_of).toBe(FIXED_NOW.toISOString());
    expect(body.models).toHaveLength(1);
    expect(body.models[0]).toMatchObject({
      model_id: MODEL_ID,
      model_family: "crypto_updown_normal",
      category: "crypto_updown",
      version: "1.0.0",
      git_sha: "a".repeat(40),
      feature_set_version: "1.0.0",
      status: "shadow",
      regime_mix: false,
      train_window_start: "2026-05-01T00:00:00.000Z",
      train_window_end: "2026-06-01T00:00:00.000Z",
      created_at: "2026-06-02T00:00:00.000Z",
      promoted_at: null,
      demoted_at: null,
    });
    expect(body.models[0].last_gate).toMatchObject({
      gate_report_id: "7",
      verdict: "NO_EVIDENCE_OF_ALPHA",
      failures: ["BRIER_NOT_NON_INFERIOR"],
      window_from: "2026-07-01T00:00:00.000Z",
      evaluated_at: "2026-08-01T01:00:00.000Z",
    });
  });

  it("skips the gate query when the registry is empty", async () => {
    const { pool, calls } = fakePool();
    const server = await buildApp({
      pool,
      listModelsFn: () => Promise.resolve([]),
    });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/models",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().models).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("GET /polymarket/models/:modelId/calibration", () => {
  it("returns 404 MODEL_NOT_FOUND for an unknown model", async () => {
    const { pool, calls } = fakePool();
    const server = await buildApp({
      pool,
      getModelFn: () => Promise.resolve(null),
    });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/models/nope-9.9.9/calibration",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().reason_code).toBe("MODEL_NOT_FOUND");
    expect(calls).toHaveLength(0);
  });

  it("returns 404 NO_CALIBRATION_REPORT when the model has no report yet", async () => {
    const { pool } = fakePool(() => []);
    const server = await buildApp({
      pool,
      getModelFn: () => Promise.resolve(SHADOW_MODEL),
      latestGateReportFn: () => Promise.resolve(null),
    });
    const response = await server.inject({
      method: "GET",
      url: `/polymarket/models/${MODEL_ID}/calibration`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().reason_code).toBe("NO_CALIBRATION_REPORT");
  });

  it("joins the gate report, the calibration report and the fallback rate", async () => {
    const { pool, calls } = fakePool((text) => {
      if (text.includes("fundamental_calibration_reports")) {
        return [
          {
            calibration_report_id: "21",
            category: "crypto_updown",
            model_id: MODEL_ID,
            window_from: new Date("2026-07-15T00:00:00.000Z"),
            window_to: new Date("2026-08-15T00:00:00.000Z"),
            observations: 3_100,
            markets_covered: 104,
            payload_json: {
              intervalCoverage: 0.903,
              reliabilityModel: [{ lower: 0, upper: 0.1, count: 12 }],
            },
            git_sha: "c".repeat(40),
            generated_at: new Date("2026-08-15T02:00:00.000Z"),
          },
        ];
      }
      if (text.includes("GROUP BY source, fallback_reason")) {
        return [
          {
            source: "MARKET_BASELINE",
            fallback_reason: "NO_ACTIVE_MODEL",
            estimate_count: "120",
          },
          {
            source: "MARKET_BASELINE",
            fallback_reason: "FEED_STALE",
            estimate_count: "30",
          },
          { source: "MODEL", fallback_reason: null, estimate_count: "50" },
        ];
      }
      return [];
    });
    const server = await buildApp({
      pool,
      getModelFn: () => Promise.resolve(SHADOW_MODEL),
      latestGateReportFn: () => Promise.resolve(FAILED_GATE),
    });
    const response = await server.inject({
      method: "GET",
      url: `/polymarket/models/${MODEL_ID}/calibration`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.model.model_id).toBe(MODEL_ID);
    expect(body.gate_report).toMatchObject({
      gate_report_id: 7,
      verdict: "NO_EVIDENCE_OF_ALPHA",
      failures: ["BRIER_NOT_NON_INFERIOR", "HORIZON_SLICE_DEGRADED:6h_24h"],
      markets_covered: 118,
      observations: 4200,
      window_from: "2026-07-01T00:00:00.000Z",
      window_to: "2026-08-01T00:00:00.000Z",
      evaluated_at: "2026-08-01T01:00:00.000Z",
    });
    expect(body.gate_report.metrics).toEqual({
      deltaBrier: { point: 0.004, lower: 0.001, upper: 0.008 },
      intervalCoverage: 0.87,
    });
    expect(body.calibration_report).toMatchObject({
      calibration_report_id: "21",
      observations: 3100,
      markets_covered: 104,
      window_from: "2026-07-15T00:00:00.000Z",
      window_to: "2026-08-15T00:00:00.000Z",
      generated_at: "2026-08-15T02:00:00.000Z",
    });
    expect(body.calibration_report.metrics.intervalCoverage).toBe(0.903);

    // The fallback window follows the calibration report, not the gate.
    expect(body.fallback).toEqual({
      window_from: "2026-07-15T00:00:00.000Z",
      window_to: "2026-08-15T00:00:00.000Z",
      category: "crypto_updown",
      estimates: 200,
      fallback_estimates: 150,
      fallback_rate: 0.75,
      reasons: [
        { fallback_reason: "NO_ACTIVE_MODEL", count: 120 },
        { fallback_reason: "FEED_STALE", count: 30 },
      ],
    });
    const breakdown = calls.find((call) =>
      call.text.includes("GROUP BY source, fallback_reason"),
    );
    expect(breakdown?.params[0]).toBe("crypto_updown");
    expect((breakdown?.params[1] as Date).toISOString()).toBe(
      "2026-07-15T00:00:00.000Z",
    );
  });

  it("never fabricates a fallback rate for an empty window", async () => {
    const { pool } = fakePool((text) =>
      text.includes("fundamental_calibration_reports")
        ? [
            {
              calibration_report_id: "22",
              category: "crypto_updown",
              model_id: MODEL_ID,
              window_from: new Date("2026-07-15T00:00:00.000Z"),
              window_to: new Date("2026-08-15T00:00:00.000Z"),
              observations: 0,
              markets_covered: 0,
              payload_json: {},
              generated_at: new Date("2026-08-15T02:00:00.000Z"),
            },
          ]
        : [],
    );
    const server = await buildApp({
      pool,
      getModelFn: () => Promise.resolve(SHADOW_MODEL),
      latestGateReportFn: () => Promise.resolve(null),
    });
    const response = await server.inject({
      method: "GET",
      url: `/polymarket/models/${MODEL_ID}/calibration`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.gate_report).toBeNull();
    expect(body.fallback.estimates).toBe(0);
    expect(body.fallback.fallback_rate).toBeNull();
  });
});

describe("POST /polymarket/models/:modelId/promote", () => {
  it("answers 409 NO_EVIDENCE_OF_ALPHA with the blocking gate report", async () => {
    const { pool } = fakePool();
    const server = await buildApp({
      pool,
      // The registry's own code for a gate that did not say PASS; RFC-010
      // names that outcome NO_EVIDENCE_OF_ALPHA at the API boundary.
      promoteModelFn: () =>
        Promise.resolve<LifecycleResult>({
          ok: false,
          reasonCode: "GATE_NOT_PASSED",
          gateReport: FAILED_GATE,
        }),
    });
    const response = await server.inject({
      method: "POST",
      url: `/polymarket/models/${MODEL_ID}/promote`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.reason_code).toBe("NO_EVIDENCE_OF_ALPHA");
    expect(body.correlation_id).toBeTypeOf("string");
    expect(body.gate_report.verdict).toBe("NO_EVIDENCE_OF_ALPHA");
    expect(body.gate_report.failures).toEqual([
      "BRIER_NOT_NON_INFERIOR",
      "HORIZON_SLICE_DEGRADED:6h_24h",
    ]);
  });

  it("falls back to the latest gate report when the refusal carries none", async () => {
    const { pool } = fakePool();
    const lookups: string[] = [];
    const server = await buildApp({
      pool,
      promoteModelFn: () =>
        Promise.resolve<LifecycleResult>({
          ok: false,
          reasonCode: "NO_EVIDENCE_OF_ALPHA",
          gateReport: null,
        }),
      latestGateReportFn: (_pool, modelId) => {
        lookups.push(modelId);
        return Promise.resolve(FAILED_GATE);
      },
    });
    const response = await server.inject({
      method: "POST",
      url: `/polymarket/models/${MODEL_ID}/promote`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(409);
    expect(lookups).toEqual([MODEL_ID]);
    expect(response.json().gate_report.gate_report_id).toBe(7);
  });

  it("passes through the registry's own reason code for other refusals", async () => {
    const { pool } = fakePool();
    const server = await buildApp({
      pool,
      promoteModelFn: () =>
        Promise.resolve<LifecycleResult>({
          ok: false,
          reasonCode: "REGIME_MIX_INELIGIBLE",
          gateReport: FAILED_GATE,
        }),
    });
    const response = await server.inject({
      method: "POST",
      url: `/polymarket/models/${MODEL_ID}/promote`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().reason_code).toBe("REGIME_MIX_INELIGIBLE");
  });

  it("falls back to a stable reason code when a refusal names none", async () => {
    const { pool } = fakePool();
    const server = await buildApp({
      pool,
      // Shape drift from the registry must not leak `undefined` to the operator.
      promoteModelFn: () =>
        Promise.resolve({ ok: false, gateReport: null } as LifecycleResult),
    });
    const response = await server.inject({
      method: "POST",
      url: `/polymarket/models/${MODEL_ID}/promote`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().reason_code).toBe("REGISTRY_REFUSED");
  });

  it("answers 404 when the registry does not know the model", async () => {
    const { pool } = fakePool();
    const server = await buildApp({
      pool,
      promoteModelFn: () =>
        Promise.resolve<LifecycleResult>({
          ok: false,
          reasonCode: "MODEL_NOT_FOUND",
          gateReport: null,
        }),
    });
    const response = await server.inject({
      method: "POST",
      url: "/polymarket/models/nope-9.9.9/promote",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().reason_code).toBe("MODEL_NOT_FOUND");
  });

  it("returns 200 with the updated model when the gate passed", async () => {
    const { pool } = fakePool();
    const promoted: Array<readonly [string, Date]> = [];
    const server = await buildApp({
      pool,
      promoteModelFn: (_pool, modelId, at) => {
        promoted.push([modelId, at]);
        return Promise.resolve<LifecycleResult>({
          ok: true,
          model: ACTIVE_MODEL,
        });
      },
    });
    const response = await server.inject({
      method: "POST",
      url: `/polymarket/models/${MODEL_ID}/promote`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    // The transition instant comes from the injected clock, never from the
    // database default, so the audit trail is reproducible in tests.
    expect(promoted).toEqual([[MODEL_ID, FIXED_NOW]]);
    expect(response.json().model).toMatchObject({
      model_id: MODEL_ID,
      status: "active",
      promoted_at: "2026-08-19T12:00:00.000Z",
    });
  });
});

describe("POST /polymarket/models/:modelId/demote", () => {
  it("forwards the operator reason and returns the demoted model", async () => {
    const { pool } = fakePool();
    const calls: Array<readonly [string, string]> = [];
    const server = await buildApp({
      pool,
      demoteModelFn: (_pool, modelId, _at, reason) => {
        calls.push([modelId, reason]);
        return Promise.resolve<LifecycleResult>({
          ok: true,
          model: {
            ...SHADOW_MODEL,
            demotedAt: new Date("2026-08-19T12:00:00.000Z"),
          },
        });
      },
    });
    const response = await server.inject({
      method: "POST",
      url: `/polymarket/models/${MODEL_ID}/demote`,
      headers: AUTH,
      payload: { reason: "fee schedule changed" },
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([[MODEL_ID, "fee schedule changed"]]);
    expect(response.json().model).toMatchObject({
      status: "shadow",
      demoted_at: "2026-08-19T12:00:00.000Z",
    });
  });

  it("accepts a demote with no body and still records a reason", async () => {
    const { pool } = fakePool();
    const reasons: string[] = [];
    const server = await buildApp({
      pool,
      demoteModelFn: (_pool, _modelId, _at, reason) => {
        reasons.push(reason);
        return Promise.resolve<LifecycleResult>({
          ok: true,
          model: SHADOW_MODEL,
        });
      },
    });
    const response = await server.inject({
      method: "POST",
      url: `/polymarket/models/${MODEL_ID}/demote`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    // The registry's audit trail always carries a reason; an omitted one is
    // an explicit default, never an empty string.
    expect(reasons).toEqual(["manual demote via API"]);
  });

  it("rejects a non-string reason with 400 INVALID_REASON", async () => {
    const { pool } = fakePool();
    const demoted: string[] = [];
    const server = await buildApp({
      pool,
      demoteModelFn: (_pool, modelId) => {
        demoted.push(modelId);
        return Promise.resolve<LifecycleResult>({
          ok: true,
          model: SHADOW_MODEL,
        });
      },
    });
    const response = await server.inject({
      method: "POST",
      url: `/polymarket/models/${MODEL_ID}/demote`,
      headers: AUTH,
      payload: { reason: 42 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().reason_code).toBe("INVALID_REASON");
    expect(demoted).toHaveLength(0);
  });
});

describe("failure handling", () => {
  it("answers 500 FUNDAMENTAL_API_FAILED when the database throws", async () => {
    const pool: DatabasePool = {
      query() {
        return Promise.reject(new Error("connection refused"));
      },
      transaction() {
        return Promise.reject(new Error("unused"));
      },
      end() {
        return Promise.resolve();
      },
    };
    const server = await buildApp({ pool });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/estimates?market_id=0xcond",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().reason_code).toBe("FUNDAMENTAL_API_FAILED");
    expect(response.json().correlation_id).toBeTypeOf("string");
  });

  it("answers 500 FUNDAMENTAL_API_FAILED when the registry throws", async () => {
    const { pool } = fakePool();
    const server = await buildApp({
      pool,
      listModelsFn: () => Promise.reject(new Error("registry unavailable")),
    });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/models",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().reason_code).toBe("FUNDAMENTAL_API_FAILED");
  });

  it("answers 500 FUNDAMENTAL_API_FAILED when the auth service throws", async () => {
    const { pool } = fakePool();
    const server = await buildApp({
      pool,
      authService: {
        session() {
          return Promise.reject(new Error("auth store down"));
        },
      },
    });
    const response = await server.inject({
      method: "GET",
      url: "/polymarket/estimates/latest",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().reason_code).toBe("FUNDAMENTAL_API_FAILED");
  });
});
