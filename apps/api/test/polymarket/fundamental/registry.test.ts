import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryResult } from "../../../src/database.js";
import {
  activeModelFor,
  assertRegimeBoundary,
  demoteModel,
  enforceRevalidation,
  getModel,
  latestGateReport,
  listModelEvents,
  listModels,
  promoteModel,
  recordModelEvent,
  registerModel,
  RegimeBoundaryError,
  REGIME_V2_CUTOVER,
  shadowModelsFor,
  type RegisterModelInput,
} from "../../../src/polymarket/fundamental/registry.js";

// ---------------------------------------------------------------------------
// In-memory fake pool. It answers the exact statements registry.ts issues and
// keeps the tables in Maps/arrays, so a test can drive a full lifecycle
// (register -> gate report -> promote -> demote) instead of asserting SQL text.
// BIGINT columns come back as strings and jsonb as text, the way the pg driver
// and a jsonb round-trip really behave, which exercises the row mappers.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface VersionChange {
  readonly gammaCategory: string;
  readonly version: number;
  readonly validFrom: Date;
}

interface FakeDb {
  readonly models: Map<string, Row>;
  readonly gateReports: Row[];
  readonly events: Row[];
  readonly ruleVersions: VersionChange[];
  readonly paramVersions: VersionChange[];
  readonly captured: Array<{ text: string; params: unknown[] }>;
  nextGateReportId: number;
  nextEventId: number;
}

function newDb(): FakeDb {
  return {
    models: new Map<string, Row>(),
    gateReports: [],
    events: [],
    ruleVersions: [],
    paramVersions: [],
    captured: [],
    nextGateReportId: 1,
    nextEventId: 1,
  };
}

function time(value: unknown): number {
  return value instanceof Date ? value.getTime() : 0;
}

function newestChanges(
  changes: readonly VersionChange[],
  kind: string,
  at: Date,
): Row[] {
  const byCategory = new Map<string, Date>();
  for (const change of changes) {
    if (change.version <= 1 || change.validFrom.getTime() > at.getTime()) {
      continue;
    }
    const current = byCategory.get(change.gammaCategory);
    if (
      current === undefined ||
      current.getTime() < change.validFrom.getTime()
    ) {
      byCategory.set(change.gammaCategory, change.validFrom);
    }
  }
  return [...byCategory.entries()].map(([gammaCategory, changedAt]) => ({
    kind,
    gamma_category: gammaCategory,
    changed_at: changedAt,
  }));
}

function execute(db: FakeDb, text: string, params: readonly unknown[]): Row[] {
  if (text.includes("polymarket_rule_versions")) {
    const at = params[0] instanceof Date ? params[0] : new Date(0);
    return [
      ...newestChanges(db.ruleVersions, "RULE_VERSION_CHANGED", at),
      ...newestChanges(db.paramVersions, "PARAM_VERSION_CHANGED", at),
    ];
  }

  if (text.includes("INSERT INTO fundamental_models")) {
    const modelId = String(params[0]);
    if (db.models.has(modelId)) {
      return []; // ON CONFLICT (model_id) DO NOTHING
    }
    const row: Row = {
      model_id: modelId,
      model_family: params[1],
      category: params[2],
      version: params[3],
      git_sha: params[4],
      feature_set_version: params[5],
      hyperparams_json: params[6],
      seed: String(params[7]),
      train_window_start: params[8],
      train_window_end: params[9],
      regime_mix: params[10],
      status: "shadow",
      last_gate_report_id: null,
      created_at: params[11],
      promoted_at: null,
      demoted_at: null,
      retired_at: null,
    };
    db.models.set(modelId, row);
    return [{ ...row }];
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
    if (text.includes("SET status = 'active'")) {
      if (row.status !== "shadow" || row.regime_mix !== false) {
        return [];
      }
      row.status = "active";
      row.promoted_at = params[1];
      row.demoted_at = null;
      return [{ ...row }];
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
    if (text.includes("WHERE model_id = $1")) {
      const row = db.models.get(String(params[0]));
      return row === undefined ? [] : [{ ...row }];
    }
    const category = params[0];
    const status = params[1];
    return [...db.models.values()]
      .filter(
        (row) =>
          (category === null || row.category === category) &&
          (status === null || row.status === status),
      )
      .sort(
        (left, right) =>
          time(left.created_at) - time(right.created_at) ||
          String(left.model_id).localeCompare(String(right.model_id)),
      )
      .map((row) => ({ ...row }));
  }

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
      .sort(
        (left, right) =>
          time(right.evaluated_at) - time(left.evaluated_at) ||
          Number(right.gate_report_id) - Number(left.gate_report_id),
      )
      .slice(0, 1)
      .map((row) => ({ ...row }));
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

  if (text.includes("FROM fundamental_model_events")) {
    return db.events
      .filter((row) => row.model_id === String(params[0]))
      .sort(
        (left, right) =>
          time(right.at) - time(left.at) ||
          Number(right.model_event_id) - Number(left.model_event_id),
      )
      .slice(0, Number(params[1]))
      .map((row) => ({ ...row }));
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
      const bound = params ?? [];
      db.captured.push({ text, params: [...bound] });
      const rows = execute(db, text, bound) as R[];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  };
}

const NOW = new Date("2026-08-19T12:00:00.000Z");
const GIT_SHA = "a".repeat(40);

function registerInput(
  overrides: Partial<RegisterModelInput> = {},
): RegisterModelInput {
  return {
    modelId: "crypto_updown_t@1.0.0",
    modelFamily: "crypto_updown_t",
    category: "crypto_updown",
    version: "1.0.0",
    gitSha: GIT_SHA,
    featureSetVersion: "1.0.0",
    hyperparams: { student_df: 4 },
    seed: 20260819,
    trainWindowStart: new Date("2026-05-01T00:00:00.000Z"),
    trainWindowEnd: new Date("2026-08-01T00:00:00.000Z"),
    regimeMix: false,
    ...overrides,
  };
}

function seedGateReport(
  db: FakeDb,
  modelId: string,
  verdict: "PASS" | "NO_EVIDENCE_OF_ALPHA",
  options: {
    readonly evaluatedAt?: Date;
    readonly failures?: readonly string[];
    readonly marketsCovered?: number;
  } = {},
): number {
  const gateReportId = db.nextGateReportId;
  db.nextGateReportId += 1;
  db.gateReports.push({
    gate_report_id: String(gateReportId),
    model_id: modelId,
    category: "crypto_updown",
    verdict,
    markets_covered: options.marketsCovered ?? 120,
    observations: 5_000,
    window_from: new Date("2026-07-01T00:00:00.000Z"),
    window_to: new Date("2026-08-15T00:00:00.000Z"),
    metrics_json: JSON.stringify({ observations: 5_000 }),
    failures_json: JSON.stringify(options.failures ?? []),
    git_sha: GIT_SHA,
    feature_set_version: "1.0.0",
    evaluated_at: options.evaluatedAt ?? new Date("2026-08-18T00:00:00.000Z"),
  });
  return gateReportId;
}

function eventTypes(db: FakeDb, modelId: string): string[] {
  return db.events
    .filter((row) => row.model_id === modelId)
    .map((row) => String(row.event_type));
}

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

describe("assertRegimeBoundary", () => {
  it("accepts a window entirely before the cutover", () => {
    expect(() =>
      assertRegimeBoundary(
        new Date("2026-01-01T00:00:00.000Z"),
        new Date("2026-04-27T23:59:59.000Z"),
        false,
      ),
    ).not.toThrow();
  });

  it("accepts a window entirely after the cutover", () => {
    expect(() =>
      assertRegimeBoundary(
        new Date("2026-04-28T00:00:00.000Z"),
        new Date("2026-08-01T00:00:00.000Z"),
        false,
      ),
    ).not.toThrow();
  });

  it("accepts a window that ends exactly at the cutover and open windows", () => {
    expect(() =>
      assertRegimeBoundary(
        new Date("2026-01-01T00:00:00.000Z"),
        REGIME_V2_CUTOVER,
        false,
      ),
    ).not.toThrow();
    expect(() => assertRegimeBoundary(null, null, false)).not.toThrow();
    expect(() =>
      assertRegimeBoundary(new Date("2026-01-01T00:00:00.000Z"), null, false),
    ).not.toThrow();
  });

  it("rejects a straddling window without the regime_mix flag", () => {
    let thrown: unknown = null;
    try {
      assertRegimeBoundary(
        new Date("2026-04-01T00:00:00.000Z"),
        new Date("2026-05-01T00:00:00.000Z"),
        false,
      );
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RegimeBoundaryError);
    expect((thrown as RegimeBoundaryError).reasonCode).toBe(
      "REGIME_BOUNDARY_STRADDLED",
    );
  });

  it("accepts a straddling window when regime_mix is declared", () => {
    expect(() =>
      assertRegimeBoundary(
        new Date("2026-04-01T00:00:00.000Z"),
        new Date("2026-05-01T00:00:00.000Z"),
        true,
      ),
    ).not.toThrow();
  });

  it("pins the cutover to 2026-04-28T00:00:00Z", () => {
    expect(REGIME_V2_CUTOVER.toISOString()).toBe("2026-04-28T00:00:00.000Z");
  });
});

describe("registerModel", () => {
  it("always lands in shadow and records the registered event", async () => {
    const db = newDb();
    const pool = fakePool(db);

    const model = await registerModel(pool, registerInput(), NOW);

    expect(model.status).toBe("shadow");
    expect(model.promotedAt).toBeNull();
    expect(model.lastGateReportId).toBeNull();
    expect(model.seed).toBe(20260819);
    expect(model.hyperparams).toEqual({ student_df: 4 });
    expect(model.createdAt.toISOString()).toBe(NOW.toISOString());
    expect(eventTypes(db, model.modelId)).toEqual(["registered"]);

    const events = await listModelEvents(pool, model.modelId);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("registered");
    expect(events[0]?.payload.regime_mix).toBe(false);
    expect(events[0]?.gateReportId).toBeNull();
  });

  it("refuses a straddling training window before touching the database", async () => {
    const db = newDb();
    const pool = fakePool(db);

    await expect(
      registerModel(
        pool,
        registerInput({
          trainWindowStart: new Date("2026-04-01T00:00:00.000Z"),
          trainWindowEnd: new Date("2026-05-01T00:00:00.000Z"),
        }),
        NOW,
      ),
    ).rejects.toBeInstanceOf(RegimeBoundaryError);
    expect(db.captured).toHaveLength(0);
    expect(db.models.size).toBe(0);
  });

  it("registers a straddling window when regime_mix is declared", async () => {
    const db = newDb();
    const pool = fakePool(db);

    const model = await registerModel(
      pool,
      registerInput({
        trainWindowStart: new Date("2026-04-01T00:00:00.000Z"),
        trainWindowEnd: new Date("2026-05-01T00:00:00.000Z"),
        regimeMix: true,
      }),
      NOW,
    );

    expect(model.regimeMix).toBe(true);
    expect(model.status).toBe("shadow");
  });

  it("refuses an out-of-order training window", async () => {
    const db = newDb();
    const pool = fakePool(db);

    const thrown: unknown = await registerModel(
      pool,
      registerInput({
        trainWindowStart: new Date("2026-08-01T00:00:00.000Z"),
        trainWindowEnd: new Date("2026-05-01T00:00:00.000Z"),
      }),
      NOW,
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(RegimeBoundaryError);
    expect((thrown as RegimeBoundaryError).reasonCode).toBe(
      "TRAIN_WINDOW_OUT_OF_ORDER",
    );
    expect(db.captured).toHaveLength(0);
  });

  it("refuses to re-register an existing model id (versions are immutable)", async () => {
    const db = newDb();
    const pool = fakePool(db);
    await registerModel(pool, registerInput(), NOW);

    await expect(
      registerModel(pool, registerInput({ gitSha: "b".repeat(40) }), NOW),
    ).rejects.toThrow(/MODEL_VERSION_EXISTS/);
    expect(db.models.get("crypto_updown_t@1.0.0")?.git_sha).toBe(GIT_SHA);
  });
});

describe("registry reads", () => {
  it("filters by category and status", async () => {
    const db = newDb();
    const pool = fakePool(db);
    await registerModel(pool, registerInput(), NOW);
    await registerModel(
      pool,
      registerInput({
        modelId: "macro_scheduled_v1@1.0.0",
        modelFamily: "macro_scheduled_v1",
        category: "macro_scheduled",
      }),
      NOW,
    );

    expect(await listModels(pool)).toHaveLength(2);
    expect(
      (await listModels(pool, { category: "macro_scheduled" })).map(
        (model) => model.modelId,
      ),
    ).toEqual(["macro_scheduled_v1@1.0.0"]);
    expect(await listModels(pool, { status: "active" })).toHaveLength(0);
    expect(await activeModelFor(pool, "crypto_updown")).toBeNull();
    expect(
      (await shadowModelsFor(pool, "crypto_updown")).map(
        (model) => model.modelId,
      ),
    ).toEqual(["crypto_updown_t@1.0.0"]);
    expect(await getModel(pool, "missing")).toBeNull();
  });

  it("returns the newest gate report of a model", async () => {
    const db = newDb();
    const pool = fakePool(db);
    await registerModel(pool, registerInput(), NOW);
    seedGateReport(db, "crypto_updown_t@1.0.0", "NO_EVIDENCE_OF_ALPHA", {
      evaluatedAt: new Date("2026-08-10T00:00:00.000Z"),
      failures: ["INSUFFICIENT_MARKETS"],
    });
    const newest = seedGateReport(db, "crypto_updown_t@1.0.0", "PASS", {
      evaluatedAt: new Date("2026-08-18T00:00:00.000Z"),
    });

    const report = await latestGateReport(pool, "crypto_updown_t@1.0.0");
    expect(report?.gateReportId).toBe(newest);
    expect(report?.verdict).toBe("PASS");
    expect(report?.failures).toEqual([]);
    expect(await latestGateReport(pool, "missing")).toBeNull();
  });

  it("caps and orders the audit trail newest first", async () => {
    const db = newDb();
    const pool = fakePool(db);
    await registerModel(pool, registerInput(), NOW);
    await recordModelEvent(pool, {
      modelId: "crypto_updown_t@1.0.0",
      eventType: "retired",
      at: new Date("2026-08-20T00:00:00.000Z"),
    });

    const events = await listModelEvents(pool, "crypto_updown_t@1.0.0", 1);
    expect(events.map((event) => event.eventType)).toEqual(["retired"]);
  });
});

describe("promoteModel", () => {
  it("refuses an unknown model", async () => {
    const pool = fakePool(newDb());
    const outcome = await promoteModel(pool, "nope", NOW);
    expect(outcome).toEqual({
      ok: false,
      reasonCode: "MODEL_NOT_FOUND",
      gateReport: null,
    });
  });

  it("refuses with NO_GATE_REPORT when the model was never evaluated", async () => {
    const db = newDb();
    const pool = fakePool(db);
    const model = await registerModel(pool, registerInput(), NOW);

    const outcome = await promoteModel(pool, model.modelId, NOW);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reasonCode).toBe("NO_GATE_REPORT");
      expect(outcome.gateReport).toBeNull();
    }
    expect(db.models.get(model.modelId)?.status).toBe("shadow");
    expect(eventTypes(db, model.modelId)).toEqual(["registered"]);
  });

  it("refuses with GATE_NOT_PASSED and returns the blocking report", async () => {
    const db = newDb();
    const pool = fakePool(db);
    const model = await registerModel(pool, registerInput(), NOW);
    const reportId = seedGateReport(db, model.modelId, "NO_EVIDENCE_OF_ALPHA", {
      failures: ["INSUFFICIENT_MARKETS", "BRIER_NOT_NON_INFERIOR"],
      marketsCovered: 42,
    });

    const outcome = await promoteModel(pool, model.modelId, NOW);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reasonCode).toBe("GATE_NOT_PASSED");
      expect(outcome.gateReport?.gateReportId).toBe(reportId);
      expect(outcome.gateReport?.verdict).toBe("NO_EVIDENCE_OF_ALPHA");
      expect(outcome.gateReport?.failures).toEqual([
        "INSUFFICIENT_MARKETS",
        "BRIER_NOT_NON_INFERIOR",
      ]);
      expect(outcome.gateReport?.marketsCovered).toBe(42);
    }
    expect(db.models.get(model.modelId)?.status).toBe("shadow");
  });

  it("refuses a regime-mixed model even with a PASS report", async () => {
    const db = newDb();
    const pool = fakePool(db);
    const model = await registerModel(
      pool,
      registerInput({
        trainWindowStart: new Date("2026-04-01T00:00:00.000Z"),
        trainWindowEnd: new Date("2026-05-01T00:00:00.000Z"),
        regimeMix: true,
      }),
      NOW,
    );
    seedGateReport(db, model.modelId, "PASS");

    const outcome = await promoteModel(pool, model.modelId, NOW);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reasonCode).toBe("REGIME_MIX_INELIGIBLE");
    }
    expect(db.models.get(model.modelId)?.status).toBe("shadow");
  });

  it("promotes a shadow model whose latest report is PASS", async () => {
    const db = newDb();
    const pool = fakePool(db);
    const model = await registerModel(pool, registerInput(), NOW);
    const reportId = seedGateReport(db, model.modelId, "PASS");
    const at = new Date("2026-08-19T13:00:00.000Z");

    const outcome = await promoteModel(pool, model.modelId, at);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.model.status).toBe("active");
      expect(outcome.model.promotedAt?.toISOString()).toBe(at.toISOString());
    }
    expect((await activeModelFor(pool, "crypto_updown"))?.modelId).toBe(
      model.modelId,
    );
    expect(eventTypes(db, model.modelId)).toEqual(["registered", "promoted"]);
    const promotedEvent = db.events.find(
      (event) => event.event_type === "promoted",
    );
    expect(promotedEvent?.gate_report_id).toBe(reportId);
  });

  it("refuses a model that is already active", async () => {
    const db = newDb();
    const pool = fakePool(db);
    const model = await registerModel(pool, registerInput(), NOW);
    seedGateReport(db, model.modelId, "PASS");
    await promoteModel(pool, model.modelId, NOW);

    const outcome = await promoteModel(pool, model.modelId, NOW);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reasonCode).toBe("ALREADY_ACTIVE");
      expect(outcome.gateReport?.verdict).toBe("PASS");
    }
  });

  it("keeps exactly one active model per category", async () => {
    const db = newDb();
    const pool = fakePool(db);
    const first = await registerModel(pool, registerInput(), NOW);
    seedGateReport(db, first.modelId, "PASS");
    await promoteModel(pool, first.modelId, NOW);

    const second = await registerModel(
      pool,
      registerInput({ modelId: "crypto_updown_t@1.1.0", version: "1.1.0" }),
      NOW,
    );
    seedGateReport(db, second.modelId, "PASS");
    const at = new Date("2026-08-19T14:00:00.000Z");
    const outcome = await promoteModel(pool, second.modelId, at);

    expect(outcome.ok).toBe(true);
    expect(await listModels(pool, { status: "active" })).toHaveLength(1);
    expect((await activeModelFor(pool, "crypto_updown"))?.modelId).toBe(
      second.modelId,
    );
    expect(db.models.get(first.modelId)?.status).toBe("shadow");
    expect(eventTypes(db, first.modelId)).toEqual([
      "registered",
      "promoted",
      "demoted",
    ]);
    const demotion = db.events.find(
      (event) =>
        event.model_id === first.modelId && event.event_type === "demoted",
    );
    expect(String(demotion?.payload_json)).toContain("SUPERSEDED_BY_PROMOTION");
  });
});

describe("demoteModel", () => {
  it("kills an active model back to shadow and records the reason", async () => {
    const db = newDb();
    const pool = fakePool(db);
    const model = await registerModel(pool, registerInput(), NOW);
    seedGateReport(db, model.modelId, "PASS");
    await promoteModel(pool, model.modelId, NOW);
    const at = new Date("2026-08-19T15:00:00.000Z");

    const outcome = await demoteModel(pool, model.modelId, at, "OPERATOR_KILL");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.model.status).toBe("shadow");
      expect(outcome.model.demotedAt?.toISOString()).toBe(at.toISOString());
    }
    expect(await activeModelFor(pool, "crypto_updown")).toBeNull();
    expect(eventTypes(db, model.modelId)).toEqual([
      "registered",
      "promoted",
      "demoted",
    ]);
    const demotion = db.events.find((event) => event.event_type === "demoted");
    expect(String(demotion?.payload_json)).toContain("OPERATOR_KILL");
  });

  it("is idempotent for a model already in shadow", async () => {
    const db = newDb();
    const pool = fakePool(db);
    const model = await registerModel(pool, registerInput(), NOW);

    const outcome = await demoteModel(
      pool,
      model.modelId,
      NOW,
      "OPERATOR_KILL",
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.model.status).toBe("shadow");
    }
    expect(eventTypes(db, model.modelId)).toEqual(["registered"]);
  });

  it("refuses an unknown model", async () => {
    const pool = fakePool(newDb());
    const outcome = await demoteModel(pool, "nope", NOW, "OPERATOR_KILL");
    expect(outcome).toEqual({
      ok: false,
      reasonCode: "MODEL_NOT_FOUND",
      gateReport: null,
    });
  });
});

describe("enforceRevalidation", () => {
  it("sends an active model back to shadow after a newer param version", async () => {
    const db = newDb();
    const pool = fakePool(db);
    const model = await registerModel(pool, registerInput(), NOW);
    seedGateReport(db, model.modelId, "PASS");
    await promoteModel(pool, model.modelId, NOW);
    db.paramVersions.push({
      gammaCategory: "crypto",
      version: 2,
      validFrom: new Date("2026-08-19T13:00:00.000Z"),
    });
    const at = new Date("2026-08-19T14:00:00.000Z");

    const revalidated = await enforceRevalidation(pool, at);

    expect(revalidated).toEqual([
      { modelId: model.modelId, cause: "PARAM_VERSION_CHANGED" },
    ]);
    expect(db.models.get(model.modelId)?.status).toBe("shadow");
    expect(eventTypes(db, model.modelId)).toEqual([
      "registered",
      "promoted",
      "revalidation_required",
    ]);
    const event = db.events.find(
      (row) => row.event_type === "revalidation_required",
    );
    expect(String(event?.payload_json)).toContain("PARAM_VERSION_CHANGED");
    expect(await activeModelFor(pool, "crypto_updown")).toBeNull();
  });

  it("also revalidates on a rule change and leaves other categories alone", async () => {
    const db = newDb();
    const pool = fakePool(db);
    const crypto = await registerModel(pool, registerInput(), NOW);
    seedGateReport(db, crypto.modelId, "PASS");
    await promoteModel(pool, crypto.modelId, NOW);
    const macro = await registerModel(
      pool,
      registerInput({
        modelId: "macro_scheduled_v1@1.0.0",
        modelFamily: "macro_scheduled_v1",
        category: "macro_scheduled",
      }),
      NOW,
    );
    seedGateReport(db, macro.modelId, "PASS");
    await promoteModel(pool, macro.modelId, NOW);
    db.ruleVersions.push({
      gammaCategory: "crypto",
      version: 3,
      validFrom: new Date("2026-08-19T13:00:00.000Z"),
    });

    const revalidated = await enforceRevalidation(
      pool,
      new Date("2026-08-19T14:00:00.000Z"),
    );

    expect(revalidated).toEqual([
      { modelId: crypto.modelId, cause: "RULE_VERSION_CHANGED" },
    ]);
    expect(db.models.get(macro.modelId)?.status).toBe("active");
  });

  it("leaves a model promoted after the change untouched", async () => {
    const db = newDb();
    const pool = fakePool(db);
    const model = await registerModel(pool, registerInput(), NOW);
    seedGateReport(db, model.modelId, "PASS");
    db.paramVersions.push({
      gammaCategory: "crypto",
      version: 2,
      validFrom: new Date("2026-08-19T10:00:00.000Z"),
    });
    await promoteModel(
      pool,
      model.modelId,
      new Date("2026-08-19T11:00:00.000Z"),
    );

    const revalidated = await enforceRevalidation(
      pool,
      new Date("2026-08-19T12:00:00.000Z"),
    );

    expect(revalidated).toEqual([]);
    expect(db.models.get(model.modelId)?.status).toBe("active");
  });

  it("ignores the first version of a market's rules and future-dated changes", async () => {
    const db = newDb();
    const pool = fakePool(db);
    const model = await registerModel(pool, registerInput(), NOW);
    seedGateReport(db, model.modelId, "PASS");
    await promoteModel(pool, model.modelId, NOW);
    db.ruleVersions.push({
      gammaCategory: "crypto",
      version: 1,
      validFrom: new Date("2026-08-19T13:00:00.000Z"),
    });
    db.paramVersions.push({
      gammaCategory: "crypto",
      version: 2,
      validFrom: new Date("2026-08-20T00:00:00.000Z"),
    });

    const revalidated = await enforceRevalidation(
      pool,
      new Date("2026-08-19T14:00:00.000Z"),
    );

    expect(revalidated).toEqual([]);
    expect(db.models.get(model.modelId)?.status).toBe("active");
  });
});

describe("re-validation cannot be undone by a stale PASS", () => {
  it("refuses promotion on a gate report older than the demotion", async () => {
    const db = newDb();
    const pool = fakePool(db);
    const at = new Date("2026-08-20T12:00:00.000Z");
    const model = await registerModel(pool, registerInput(), at);

    // A PASS, then a promotion, then a forced re-validation: a fee-schedule or
    // rule change sent the model back to shadow.
    const gateReportId = seedGateReport(db, model.modelId, "PASS", {
      evaluatedAt: new Date("2026-08-18T00:00:00.000Z"),
    });
    const row = db.models.get(model.modelId);
    if (row === undefined) {
      throw new Error("model row missing");
    }
    row.last_gate_report_id = String(gateReportId);
    row.status = "shadow";
    row.demoted_at = new Date("2026-08-19T12:00:00.000Z");

    const outcome = await promoteModel(pool, model.modelId, at);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // The stale PASS predates the change that forced the demotion, so it is
      // not evidence about the current regime.
      expect(outcome.reasonCode).toBe("REVALIDATION_REQUIRED");
    }
    expect(db.models.get(model.modelId)?.status).toBe("shadow");

    // A fresh PASS, evaluated after the demotion, unblocks it.
    const freshId = seedGateReport(db, model.modelId, "PASS", {
      evaluatedAt: new Date("2026-08-20T00:00:00.000Z"),
    });
    const fresh = db.models.get(model.modelId);
    if (fresh !== undefined) {
      fresh.last_gate_report_id = String(freshId);
    }
    const promoted = await promoteModel(pool, model.modelId, at);
    expect(promoted.ok).toBe(true);
    expect(db.models.get(model.modelId)?.status).toBe("active");
  });
});
