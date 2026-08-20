import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryResult } from "../../../src/database.js";
import {
  evaluateGate,
  runGate,
  type GateThresholds,
} from "../../../src/polymarket/fundamental/gate.js";
import type {
  CalibrationMetrics,
  HorizonSlice,
  ModelRecord,
  ScoreSummary,
} from "../../../src/polymarket/fundamental/types.js";

// ---------------------------------------------------------------------------
// In-memory fake pool covering the statements runGate issues (gate report
// insert, model gate pointer, lifecycle event, and the demotion path through
// registry.ts). BIGINT identifiers come back as strings, as the driver returns
// them.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface FakeDb {
  readonly models: Map<string, Row>;
  readonly gateReports: Row[];
  readonly events: Row[];
  nextGateReportId: number;
  nextEventId: number;
}

function newDb(): FakeDb {
  return {
    models: new Map<string, Row>(),
    gateReports: [],
    events: [],
    nextGateReportId: 1,
    nextEventId: 1,
  };
}

function execute(db: FakeDb, text: string, params: readonly unknown[]): Row[] {
  if (text.includes("INSERT INTO fundamental_gate_reports")) {
    const gateReportId = db.nextGateReportId;
    db.nextGateReportId += 1;
    db.gateReports.push({
      gate_report_id: String(gateReportId),
      model_id: params[0],
      category: params[1],
      verdict: params[2],
      markets_covered: params[3],
      observations: params[4],
      window_from: params[5],
      window_to: params[6],
      metrics_json: params[7],
      failures_json: params[8],
      git_sha: params[9],
      feature_set_version: params[10],
      evaluated_at: params[11],
    });
    return [{ gate_report_id: String(gateReportId) }];
  }

  if (text.includes("FROM fundamental_gate_reports")) {
    return db.gateReports
      .filter((row) => row.model_id === String(params[0]))
      .slice(-1)
      .map((row) => ({ ...row }));
  }

  if (text.includes("UPDATE fundamental_models")) {
    const row = db.models.get(String(params[0]));
    if (row === undefined) {
      return [];
    }
    if (text.includes("last_gate_report_id = $2")) {
      row.last_gate_report_id = String(params[1]);
      return [];
    }
    if (text.includes("SET status = 'shadow'")) {
      if (row.status !== "active") {
        return [];
      }
      row.status = "shadow";
      row.demoted_at = params[1];
      return [{ ...row }];
    }
    return [];
  }

  if (text.includes("FROM fundamental_models")) {
    const row = db.models.get(String(params[0]));
    return row === undefined ? [] : [{ ...row }];
  }

  if (text.includes("INSERT INTO fundamental_model_events")) {
    const modelEventId = db.nextEventId;
    db.nextEventId += 1;
    db.events.push({
      model_event_id: String(modelEventId),
      model_id: params[0],
      event_type: params[1],
      gate_report_id: params[2],
      payload_json: params[3],
      at: params[4],
    });
    return [{ model_event_id: String(modelEventId) }];
  }

  throw new Error(`unexpected statement: ${text}`);
}

function fakePool(db: FakeDb): {
  query: <R extends Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ) => Promise<QueryResult<R>>;
} {
  return {
    query<R extends Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      const rows = execute(db, text, params ?? []) as R[];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  };
}

const NOW = new Date("2026-08-19T12:00:00.000Z");
const WINDOW_FROM = new Date("2026-07-01T00:00:00.000Z");
const WINDOW_TO = new Date("2026-08-15T00:00:00.000Z");
const GIT_SHA = "c".repeat(40);

const THRESHOLDS: GateThresholds = {
  minMarkets: 100,
  maxHorizonDegradation: 0.2,
};

function summary(brier: number, logLoss: number, count = 5_000): ScoreSummary {
  return { brier, logLoss, count };
}

function slice(
  bucket: string,
  relativeBrierDegradation: number,
  count = 2_500,
): HorizonSlice {
  return {
    bucket,
    count,
    model: summary(0.07, 0.24, count),
    baseline: summary(0.072, 0.245, count),
    relativeBrierDegradation,
  };
}

/** A non-inferior model: both CIs sit entirely at or below zero. */
function metrics(
  overrides: Partial<CalibrationMetrics> = {},
): CalibrationMetrics {
  return {
    observations: 5_000,
    marketsCovered: 120,
    model: summary(0.071, 0.245),
    baseline: summary(0.074, 0.252),
    deltaBrier: { point: -0.003, lower: -0.006, upper: -0.0005 },
    deltaLogLoss: { point: -0.007, lower: -0.012, upper: -0.001 },
    horizonSlices: [slice("lt_1h", -0.05), slice("1h_6h", 0.1)],
    reliabilityModel: [],
    reliabilityBaseline: [],
    intervalCoverage: 0.902,
    withDegenerate: {
      observations: 6_200,
      model: summary(0.041, 0.15, 6_200),
      baseline: summary(0.043, 0.16, 6_200),
    },
    bootstrapResamples: 1_000,
    bootstrapSeed: 20_260_819,
    blockLength: 1,
    ...overrides,
  };
}

function modelRecord(overrides: Partial<ModelRecord> = {}): ModelRecord {
  return {
    modelId: "crypto_updown_t@1.0.0",
    modelFamily: "crypto_updown_t",
    category: "crypto_updown",
    version: "1.0.0",
    gitSha: GIT_SHA,
    featureSetVersion: "1.0.0",
    hyperparams: { student_df: 4 },
    seed: 20_260_819,
    trainWindowStart: new Date("2026-05-01T00:00:00.000Z"),
    trainWindowEnd: new Date("2026-08-01T00:00:00.000Z"),
    regimeMix: false,
    status: "shadow",
    lastGateReportId: null,
    createdAt: NOW,
    promotedAt: null,
    demotedAt: null,
    retiredAt: null,
    ...overrides,
  };
}

function seedModel(db: FakeDb, model: ModelRecord): void {
  db.models.set(model.modelId, {
    model_id: model.modelId,
    model_family: model.modelFamily,
    category: model.category,
    version: model.version,
    git_sha: model.gitSha,
    feature_set_version: model.featureSetVersion,
    hyperparams_json: JSON.stringify(model.hyperparams),
    seed: String(model.seed),
    train_window_start: model.trainWindowStart,
    train_window_end: model.trainWindowEnd,
    regime_mix: model.regimeMix,
    status: model.status,
    last_gate_report_id: model.lastGateReportId,
    created_at: model.createdAt,
    promoted_at: model.promotedAt,
    demoted_at: model.demotedAt,
    retired_at: model.retiredAt,
  });
}

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

describe("evaluateGate", () => {
  it("passes a non-inferior model with enough resolved markets", () => {
    const result = evaluateGate(
      metrics(),
      120,
      5_000,
      WINDOW_FROM,
      WINDOW_TO,
      THRESHOLDS,
    );
    expect(result.verdict).toBe("PASS");
    expect(result.failures).toEqual([]);
    expect(result.marketsCovered).toBe(120);
  });

  it("returns NO_EVIDENCE_OF_ALPHA for too few resolved markets", () => {
    const result = evaluateGate(
      metrics(),
      99,
      5_000,
      WINDOW_FROM,
      WINDOW_TO,
      THRESHOLDS,
    );
    expect(result.verdict).toBe("NO_EVIDENCE_OF_ALPHA");
    expect(result.failures).toEqual(["INSUFFICIENT_MARKETS"]);
  });

  it("never accepts a minimum below the RFC's 100 markets", () => {
    const result = evaluateGate(metrics(), 42, 5_000, WINDOW_FROM, WINDOW_TO, {
      minMarkets: 10,
      maxHorizonDegradation: 0.2,
    });
    expect(result.failures).toEqual(["INSUFFICIENT_MARKETS"]);
  });

  it("honours a stricter minimum than the RFC's", () => {
    const result = evaluateGate(metrics(), 120, 5_000, WINDOW_FROM, WINDOW_TO, {
      minMarkets: 500,
      maxHorizonDegradation: 0.2,
    });
    expect(result.failures).toEqual(["INSUFFICIENT_MARKETS"]);
  });

  it("fails when the Brier CI upper bound is above zero", () => {
    const result = evaluateGate(
      metrics({ deltaBrier: { point: -0.001, lower: -0.004, upper: 0.002 } }),
      120,
      5_000,
      WINDOW_FROM,
      WINDOW_TO,
      THRESHOLDS,
    );
    expect(result.verdict).toBe("NO_EVIDENCE_OF_ALPHA");
    expect(result.failures).toEqual(["BRIER_NOT_NON_INFERIOR"]);
  });

  it("fails when the log loss CI upper bound is above zero", () => {
    const result = evaluateGate(
      metrics({ deltaLogLoss: { point: -0.002, lower: -0.01, upper: 0.004 } }),
      120,
      5_000,
      WINDOW_FROM,
      WINDOW_TO,
      THRESHOLDS,
    );
    expect(result.failures).toEqual(["LOG_LOSS_NOT_NON_INFERIOR"]);
  });

  it("fails when a CI bound is unreadable", () => {
    const result = evaluateGate(
      metrics({
        deltaBrier: {
          point: Number.NaN,
          lower: Number.NaN,
          upper: Number.NaN,
        },
      }),
      120,
      5_000,
      WINDOW_FROM,
      WINDOW_TO,
      THRESHOLDS,
    );
    expect(result.failures).toEqual(["BRIER_NOT_NON_INFERIOR"]);
  });

  it("fails a horizon slice degraded by more than 20%", () => {
    const result = evaluateGate(
      metrics({
        horizonSlices: [slice("lt_1h", -0.02), slice("6h_24h", 0.21)],
      }),
      120,
      5_000,
      WINDOW_FROM,
      WINDOW_TO,
      THRESHOLDS,
    );
    expect(result.verdict).toBe("NO_EVIDENCE_OF_ALPHA");
    expect(result.failures).toEqual(["HORIZON_DEGRADATION:6h_24h"]);
  });

  it("never accepts a horizon tolerance looser than 20%", () => {
    const result = evaluateGate(
      metrics({ horizonSlices: [slice("1d_7d", 0.5)] }),
      120,
      5_000,
      WINDOW_FROM,
      WINDOW_TO,
      { minMarkets: 100, maxHorizonDegradation: 0.9 },
    );
    expect(result.failures).toEqual(["HORIZON_DEGRADATION:1d_7d"]);
  });

  it("ignores empty horizon slices but requires the stratification", () => {
    const withEmpty = evaluateGate(
      metrics({
        horizonSlices: [
          slice("lt_1h", -0.02),
          { ...slice("gt_7d", Number.NaN), count: 0 },
        ],
      }),
      120,
      5_000,
      WINDOW_FROM,
      WINDOW_TO,
      THRESHOLDS,
    );
    expect(withEmpty.verdict).toBe("PASS");

    const unstratified = evaluateGate(
      metrics({ horizonSlices: [] }),
      120,
      5_000,
      WINDOW_FROM,
      WINDOW_TO,
      THRESHOLDS,
    );
    expect(unstratified.failures).toEqual(["HORIZON_SLICES_MISSING"]);
  });

  it("lists every failed criterion", () => {
    const result = evaluateGate(
      metrics({
        deltaBrier: { point: 0.002, lower: 0.001, upper: 0.004 },
        deltaLogLoss: { point: 0.01, lower: 0.004, upper: 0.02 },
        horizonSlices: [slice("lt_1h", 0.4)],
      }),
      12,
      0,
      WINDOW_TO,
      WINDOW_FROM,
      THRESHOLDS,
    );
    expect(result.failures).toEqual([
      "INVALID_WINDOW",
      "NO_OBSERVATIONS",
      "INSUFFICIENT_MARKETS",
      "BRIER_NOT_NON_INFERIOR",
      "LOG_LOSS_NOT_NON_INFERIOR",
      "HORIZON_DEGRADATION:lt_1h",
    ]);
  });
});

describe("runGate", () => {
  it("persists the report, points the model at it and records gate_pass", async () => {
    const db = newDb();
    const pool = fakePool(db);
    const model = modelRecord();
    seedModel(db, model);

    const { result, gateReportId } = await runGate({
      pool,
      model,
      metrics: metrics(),
      marketsCovered: 120,
      observations: 5_000,
      windowFrom: WINDOW_FROM,
      windowTo: WINDOW_TO,
      thresholds: THRESHOLDS,
      gitSha: GIT_SHA,
      at: NOW,
    });

    expect(result.verdict).toBe("PASS");
    expect(gateReportId).toBe(1);
    expect(db.gateReports).toHaveLength(1);
    const report = db.gateReports[0];
    expect(report?.verdict).toBe("PASS");
    expect(report?.markets_covered).toBe(120);
    expect(report?.git_sha).toBe(GIT_SHA);
    expect(String(report?.failures_json)).toBe("[]");
    expect(db.models.get(model.modelId)?.last_gate_report_id).toBe("1");
    expect(db.events.map((event) => event.event_type)).toEqual(["gate_pass"]);
    expect(db.events[0]?.gate_report_id).toBe(1);
  });

  it("records no_evidence_of_alpha with the failures and keeps a shadow model in shadow", async () => {
    const db = newDb();
    const pool = fakePool(db);
    const model = modelRecord();
    seedModel(db, model);

    const { result } = await runGate({
      pool,
      model,
      metrics: metrics(),
      marketsCovered: 40,
      observations: 900,
      windowFrom: WINDOW_FROM,
      windowTo: WINDOW_TO,
      thresholds: THRESHOLDS,
      gitSha: GIT_SHA,
      at: NOW,
    });

    expect(result.verdict).toBe("NO_EVIDENCE_OF_ALPHA");
    expect(result.failures).toEqual(["INSUFFICIENT_MARKETS"]);
    expect(db.gateReports[0]?.verdict).toBe("NO_EVIDENCE_OF_ALPHA");
    expect(String(db.gateReports[0]?.failures_json)).toContain(
      "INSUFFICIENT_MARKETS",
    );
    expect(db.events.map((event) => event.event_type)).toEqual([
      "no_evidence_of_alpha",
    ]);
    expect(db.models.get(model.modelId)?.status).toBe("shadow");
  });

  it("demotes an active model that fails the gate", async () => {
    const db = newDb();
    const pool = fakePool(db);
    const model = modelRecord({
      status: "active",
      promotedAt: new Date("2026-08-01T00:00:00.000Z"),
      lastGateReportId: 7,
    });
    seedModel(db, model);
    const at = new Date("2026-08-19T13:00:00.000Z");

    const { result } = await runGate({
      pool,
      model,
      metrics: metrics({
        deltaBrier: { point: 0.004, lower: 0.001, upper: 0.008 },
      }),
      marketsCovered: 300,
      observations: 9_000,
      windowFrom: WINDOW_FROM,
      windowTo: WINDOW_TO,
      thresholds: THRESHOLDS,
      gitSha: GIT_SHA,
      at,
    });

    expect(result.verdict).toBe("NO_EVIDENCE_OF_ALPHA");
    expect(db.models.get(model.modelId)?.status).toBe("shadow");
    expect(db.models.get(model.modelId)?.demoted_at).toBe(at);
    expect(db.events.map((event) => event.event_type)).toEqual([
      "no_evidence_of_alpha",
      "demoted",
    ]);
    expect(String(db.events[1]?.payload_json)).toContain(
      "NO_EVIDENCE_OF_ALPHA",
    );
  });

  it("stores non-negative counts even when the caller passes garbage", async () => {
    const db = newDb();
    const pool = fakePool(db);
    const model = modelRecord();
    seedModel(db, model);

    await runGate({
      pool,
      model,
      metrics: metrics(),
      marketsCovered: Number.NaN,
      observations: -5,
      windowFrom: WINDOW_FROM,
      windowTo: WINDOW_TO,
      thresholds: THRESHOLDS,
      gitSha: GIT_SHA,
      at: NOW,
    });

    expect(db.gateReports[0]?.verdict).toBe("NO_EVIDENCE_OF_ALPHA");
    expect(db.gateReports[0]?.markets_covered).toBe(0);
    expect(db.gateReports[0]?.observations).toBe(0);
  });
});
