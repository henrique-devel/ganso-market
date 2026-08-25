import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DatabasePool,
  QueryResult,
  SqlExecutor,
} from "../../../src/database.js";
import { DEFAULT_RESOLUTION_CONFIG } from "../../../src/polymarket/resolution/config.js";
import { DEFAULT_RESOLUTION_LEXICON } from "../../../src/polymarket/resolution/lexicon.js";

const mocked = vi.hoisted(() => ({
  recompute: vi.fn(),
  ensureScoreVersion: vi.fn(),
  loadScoreableMarkets: vi.fn(),
  buildGraph: vi.fn(),
  evaluateGraph: vi.fn(),
  sanityCheck: vi.fn(),
  reportDue: vi.fn(),
  generateReport: vi.fn(),
}));

vi.mock("../../../src/polymarket/resolution/recompute.js", () => ({
  recomputeMarkets: mocked.recompute,
}));
vi.mock("../../../src/polymarket/resolution/store.js", () => ({
  ensureScoreVersion: mocked.ensureScoreVersion,
  loadScoreableMarkets: mocked.loadScoreableMarkets,
}));
vi.mock("../../../src/polymarket/resolution/graph.js", () => ({
  buildGraph: mocked.buildGraph,
}));
vi.mock("../../../src/polymarket/resolution/evaluate.js", () => ({
  evaluateGraph: mocked.evaluateGraph,
}));
vi.mock("../../../src/polymarket/resolution/sanity.js", () => ({
  sanityCheck: mocked.sanityCheck,
}));
vi.mock("../../../src/polymarket/resolution/report.js", () => ({
  reportDue: mocked.reportDue,
  generateResolutionReport: mocked.generateReport,
}));

import { createResolutionRunner } from "../../../src/polymarket/resolution/runner.js";

type Row = Record<string, unknown>;

interface RuntimeRow {
  generation: string;
  ready: boolean;
  started_at: Date;
  ready_at: Date | null;
  heartbeat_at: Date;
  lease_expires_at: Date;
  last_success_at: Date | null;
  processed_resolution_event_id: bigint;
  processed_rule_version_id: bigint;
  processed_input_change_id: bigint;
  graph_evaluated_at: Date | null;
  graph_valid_until: Date | null;
  failure_reason: string | null;
  stopped_at: Date | null;
}

interface RunnerWorld {
  runtime: RuntimeRow | null;
  events: Row[];
  rules: Row[];
  changes: Row[];
  statements: string[];
  runtimeLockHook: (() => Promise<void> | void) | null;
}

const NOW = new Date("2026-08-24T12:00:00.000Z");
const GENERATION_A = "11111111-1111-4111-8111-111111111111";
const GENERATION_B = "22222222-2222-4222-8222-222222222222";

function runnerPool(world: RunnerWorld): DatabasePool {
  const query = async <R extends Row>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<R>> => {
    world.statements.push(text);
    const respond = (rows: Row[], rowCount = rows.length) => ({
      rows: rows as R[],
      rowCount,
    });

    if (text.startsWith("INSERT INTO resolution_runtime_state")) {
      const at = params[2] as Date;
      world.runtime = {
        generation: params[0] as string,
        ready: false,
        started_at: at,
        ready_at: null,
        heartbeat_at: at,
        lease_expires_at: at,
        last_success_at: null,
        processed_resolution_event_id: 0n,
        processed_rule_version_id: 0n,
        processed_input_change_id: 0n,
        graph_evaluated_at: null,
        graph_valid_until: null,
        failure_reason: null,
        stopped_at: null,
      };
      return respond([], 1);
    }
    if (
      text.includes("SELECT generation FROM resolution_runtime_state") &&
      text.includes("FOR UPDATE")
    ) {
      await world.runtimeLockHook?.();
      const runtime = world.runtime;
      return runtime !== null &&
        runtime.generation === params[0] &&
        runtime.stopped_at === null
        ? respond([{ generation: runtime.generation }])
        : respond([]);
    }
    if (
      text.includes("SELECT processed_resolution_event_id") &&
      text.includes("FOR UPDATE")
    ) {
      await world.runtimeLockHook?.();
      const runtime = world.runtime;
      return runtime !== null &&
        runtime.generation === params[0] &&
        runtime.stopped_at === null
        ? respond([runtime as unknown as Row])
        : respond([]);
    }
    if (
      text.includes("SELECT generation, lease_expires_at") &&
      text.includes("FOR UPDATE")
    ) {
      await world.runtimeLockHook?.();
      const runtime = world.runtime;
      return runtime !== null &&
        runtime.generation === params[0] &&
        runtime.ready &&
        runtime.stopped_at === null
        ? respond([runtime as unknown as Row])
        : respond([]);
    }
    if (
      text.includes("SELECT lease_expires_at") &&
      text.includes("FROM resolution_runtime_state") &&
      text.includes("FOR UPDATE")
    ) {
      await world.runtimeLockHook?.();
      const runtime = world.runtime;
      return runtime !== null &&
        runtime.generation === params[0] &&
        runtime.ready &&
        runtime.stopped_at === null
        ? respond([runtime as unknown as Row])
        : respond([]);
    }
    if (
      text.includes("AS input_head") &&
      text.includes("AS event_head") &&
      text.includes("AS rule_head")
    ) {
      return respond([
        {
          input_head: world.changes.at(-1)?.["input_change_id"] ?? 0,
          event_head: world.events.at(-1)?.["resolution_event_id"] ?? 0,
          rule_head: world.rules.at(-1)?.["rule_version_id"] ?? 0,
        },
      ]);
    }
    if (text.includes("FROM polymarket_resolution_input_changes c")) {
      const after = BigInt(String(params[0] ?? 0));
      return respond(
        world.changes
          .filter((row) => BigInt(String(row["input_change_id"])) > after)
          .slice(0, 500)
          .map((change) => {
            const sourceKey = String(change["source_key"]);
            const event = world.events.find(
              (row) => String(row["resolution_event_id"]) === sourceKey,
            );
            const rule = world.rules.find(
              (row) => String(row["rule_version_id"]) === sourceKey,
            );
            return {
              ...change,
              resolution_event_id:
                change["source"] === "resolution_event"
                  ? (event?.["resolution_event_id"] ?? null)
                  : null,
              event_type:
                change["source"] === "resolution_event"
                  ? (event?.["event_type"] ?? null)
                  : null,
              rule_version_id:
                change["source"] === "rule_version"
                  ? (rule?.["rule_version_id"] ?? null)
                  : null,
            };
          }),
      );
    }
    if (
      text.startsWith("UPDATE resolution_runtime_state") &&
      text.includes("SET ready = TRUE")
    ) {
      if (world.runtime === null || world.runtime.generation !== params[0]) {
        return respond([]);
      }
      if (world.runtime.stopped_at !== null) {
        return respond([]);
      }
      const asOf = params[1] as Date;
      world.runtime.ready = true;
      world.runtime.ready_at ??= asOf;
      world.runtime.heartbeat_at = asOf;
      world.runtime.lease_expires_at = params[2] as Date;
      world.runtime.last_success_at = asOf;
      world.runtime.processed_resolution_event_id = BigInt(String(params[3]));
      world.runtime.processed_rule_version_id = BigInt(String(params[4]));
      world.runtime.processed_input_change_id = BigInt(String(params[5]));
      world.runtime.graph_evaluated_at = params[6] as Date;
      world.runtime.graph_valid_until = params[7] as Date;
      world.runtime.failure_reason = null;
      return respond([], 1);
    }
    if (
      text.startsWith("UPDATE resolution_runtime_state") &&
      text.includes("SET ready = FALSE") &&
      text.includes("failure_reason")
    ) {
      const runtime = world.runtime;
      if (runtime !== null && runtime.generation === params[0]) {
        runtime.ready = false;
        runtime.failure_reason = params[1] as string;
        runtime.lease_expires_at = params[2] as Date;
        return respond([], 1);
      }
      return respond([]);
    }
    if (
      text.startsWith("UPDATE resolution_runtime_state") &&
      text.includes("SET ready = FALSE, stopped_at")
    ) {
      const runtime = world.runtime;
      if (runtime !== null && runtime.generation === params[0]) {
        runtime.ready = false;
        runtime.stopped_at = params[1] as Date;
        runtime.lease_expires_at = params[1] as Date;
        return respond([], 1);
      }
      return respond([]);
    }
    if (
      text.startsWith("UPDATE resolution_runtime_state") &&
      text.includes("SET heartbeat_at")
    ) {
      const runtime = world.runtime;
      if (
        runtime !== null &&
        runtime.generation === params[0] &&
        runtime.ready &&
        runtime.stopped_at === null &&
        runtime.lease_expires_at.getTime() > (params[1] as Date).getTime()
      ) {
        runtime.heartbeat_at = params[1] as Date;
        runtime.lease_expires_at = params[2] as Date;
        if (text.includes("graph_evaluated_at")) {
          runtime.graph_evaluated_at = params[3] as Date;
          runtime.graph_valid_until = params[4] as Date;
        }
        return respond([], 1);
      }
      return respond([]);
    }
    return respond([]);
  };

  return {
    query,
    async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const snapshot = structuredClone(world.runtime);
      try {
        return await run({ query });
      } catch (error) {
        const stoppedAt = world.runtime?.stopped_at ?? null;
        world.runtime = snapshot;
        if (stoppedAt !== null && world.runtime !== null) {
          world.runtime.ready = false;
          world.runtime.stopped_at = stoppedAt;
          world.runtime.lease_expires_at = stoppedAt;
        }
        throw error;
      }
    },
    end(): Promise<void> {
      return Promise.resolve();
    },
  };
}

function emptyWorld(): RunnerWorld {
  return {
    runtime: null,
    events: [],
    rules: [],
    changes: [],
    statements: [],
    runtimeLockHook: null,
  };
}

beforeEach(() => {
  mocked.recompute.mockReset().mockResolvedValue({ scored: 1, failed: 0 });
  mocked.ensureScoreVersion.mockReset().mockResolvedValue(undefined);
  mocked.loadScoreableMarkets.mockReset().mockResolvedValue([]);
  mocked.buildGraph.mockReset().mockResolvedValue({ inserted: 0, closed: 0 });
  mocked.evaluateGraph.mockReset().mockResolvedValue({
    checked: 0,
    beyond: 0,
    opened: 0,
    closed: 0,
    skipped: 0,
    suppressed: 0,
  });
  mocked.sanityCheck.mockReset().mockResolvedValue({
    checked: 0,
    active: 0,
    opened: 0,
    closed: 0,
  });
  mocked.reportDue.mockReset().mockResolvedValue(false);
  mocked.generateReport.mockReset().mockResolvedValue({ reportId: "1" });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("resolution runtime durability", () => {
  it("publishes readiness and source watermarks only after a successful boot", async () => {
    const world = emptyWorld();
    world.events.push({
      resolution_event_id: 7,
      condition_id: "0xevent",
      event_type: "disputed",
    });
    world.rules.push({ rule_version_id: 9, condition_id: "0xrule" });
    world.changes.push({
      input_change_id: 11,
      source: "rule_version",
      source_key: "9",
      condition_id: "0xrule",
    });
    const runner = createResolutionRunner({
      pool: runnerPool(world),
      config: DEFAULT_RESOLUTION_CONFIG,
      lexicon: DEFAULT_RESOLUTION_LEXICON,
      curatedEdges: [],
      executionMode: "paper",
      clock: () => NOW,
      generationFactory: () => GENERATION_A,
    });

    await runner.start();

    expect(world.runtime).toMatchObject({
      generation: GENERATION_A,
      ready: true,
      processed_resolution_event_id: 7n,
      processed_rule_version_id: 9n,
      processed_input_change_id: 11n,
      graph_evaluated_at: NOW,
      failure_reason: null,
    });
    expect(world.runtime?.graph_valid_until?.getTime()).toBe(
      NOW.getTime() + 120_000,
    );
    expect(mocked.buildGraph).toHaveBeenCalledTimes(1);
    expect(mocked.evaluateGraph).toHaveBeenCalledTimes(1);
    expect(mocked.sanityCheck).toHaveBeenCalledTimes(1);
    expect(world.runtime?.lease_expires_at.getTime()).toBe(
      NOW.getTime() + 60_000,
    );
    const bootLock = world.statements.findIndex((text) =>
      text.startsWith(
        "LOCK TABLE polymarket_resolution_input_changes IN SHARE MODE",
      ),
    );
    const bootHeads = world.statements.findIndex((text) =>
      text.includes("AS input_head"),
    );
    expect(bootLock).toBeGreaterThanOrEqual(0);
    expect(bootLock).toBeLessThan(bootHeads);
    await runner.stop();
    expect(world.runtime?.ready).toBe(false);
  });

  it("does not publish ready when boot reports a partial recompute failure", async () => {
    const world = emptyWorld();
    mocked.recompute.mockResolvedValueOnce({ scored: 3, failed: 1 });
    const runner = createResolutionRunner({
      pool: runnerPool(world),
      config: DEFAULT_RESOLUTION_CONFIG,
      lexicon: DEFAULT_RESOLUTION_LEXICON,
      curatedEdges: [],
      executionMode: "paper",
      clock: () => NOW,
      generationFactory: () => GENERATION_A,
    });

    await expect(runner.start()).rejects.toMatchObject({
      reasonCode: "RESOLUTION_RECOMPUTE_INCOMPLETE",
    });
    expect(world.runtime).toMatchObject({
      generation: GENERATION_A,
      ready: false,
      processed_resolution_event_id: 0n,
      processed_input_change_id: 0n,
    });
  });

  it("does not publish ready until boot build, evaluation and sanity all complete", async () => {
    const world = emptyWorld();
    mocked.sanityCheck.mockRejectedValueOnce(new Error("sanity failed"));
    const runner = createResolutionRunner({
      pool: runnerPool(world),
      config: DEFAULT_RESOLUTION_CONFIG,
      lexicon: DEFAULT_RESOLUTION_LEXICON,
      curatedEdges: [],
      executionMode: "paper",
      clock: () => NOW,
      generationFactory: () => GENERATION_A,
    });

    await expect(runner.start()).rejects.toThrow("sanity failed");
    expect(mocked.buildGraph).toHaveBeenCalledTimes(1);
    expect(mocked.evaluateGraph).toHaveBeenCalledTimes(1);
    expect(mocked.sanityCheck).toHaveBeenCalledTimes(1);
    expect(world.runtime).toMatchObject({
      generation: GENERATION_A,
      ready: false,
      processed_input_change_id: 0n,
      graph_evaluated_at: null,
      graph_valid_until: null,
    });
  });

  it("rolls back watermarks and marks not-ready when an incremental recompute is partial", async () => {
    const world = emptyWorld();
    const runner = createResolutionRunner({
      pool: runnerPool(world),
      config: DEFAULT_RESOLUTION_CONFIG,
      lexicon: DEFAULT_RESOLUTION_LEXICON,
      curatedEdges: [],
      executionMode: "paper",
      clock: () => NOW,
      generationFactory: () => GENERATION_A,
    });
    await runner.start();
    world.events.push({
      resolution_event_id: 1,
      condition_id: "0xevent",
      event_type: "proposed",
    });
    world.changes.push({
      input_change_id: 1,
      source: "resolution_event",
      source_key: "1",
      condition_id: "0xevent",
    });
    mocked.recompute.mockResolvedValueOnce({ scored: 0, failed: 1 });

    await expect(runner.tickOnce("state_tick")).rejects.toMatchObject({
      reasonCode: "RESOLUTION_RECOMPUTE_INCOMPLETE",
    });

    expect(world.runtime).toMatchObject({
      ready: false,
      processed_resolution_event_id: 0n,
      processed_input_change_id: 0n,
      failure_reason: "STATE_TICK_FAILED",
    });
    await runner.stop();
  });

  it("keeps a topology change behind the cursor until build/evaluate/sanity succeed and recovers by generation", async () => {
    const world = emptyWorld();
    const generations = [GENERATION_A, GENERATION_B];
    const runner = createResolutionRunner({
      pool: runnerPool(world),
      config: DEFAULT_RESOLUTION_CONFIG,
      lexicon: DEFAULT_RESOLUTION_LEXICON,
      curatedEdges: [],
      executionMode: "paper",
      clock: () => NOW,
      generationFactory: () => generations.shift() ?? GENERATION_B,
    });
    await runner.start();
    world.changes.push({
      input_change_id: 1,
      source: "event_membership",
      source_key: '["event","0xmember"]',
      condition_id: "0xmember",
    });
    mocked.buildGraph.mockRejectedValueOnce(new Error("build failed"));

    await expect(runner.tickOnce("state_tick")).rejects.toThrow("build failed");
    expect(world.runtime).toMatchObject({
      generation: GENERATION_A,
      ready: false,
      processed_input_change_id: 0n,
      failure_reason: "STATE_TICK_FAILED",
    });

    await runner.tickOnce("state_tick");
    expect(world.runtime).toMatchObject({
      generation: GENERATION_B,
      ready: true,
      processed_input_change_id: 1n,
      graph_evaluated_at: NOW,
    });
    await runner.stop();
  });

  it.each([
    {
      job: "graph_build",
      reason: "GRAPH_BUILD_FAILED",
      fail: (): void => {
        mocked.buildGraph.mockRejectedValueOnce(new Error("build failed"));
      },
    },
    {
      job: "graph_eval",
      reason: "GRAPH_EVAL_FAILED",
      fail: (): void => {
        mocked.evaluateGraph.mockRejectedValueOnce(new Error("eval failed"));
      },
    },
    {
      job: "graph_eval",
      reason: "GRAPH_EVAL_FAILED",
      fail: (): void => {
        mocked.sanityCheck.mockRejectedValueOnce(new Error("sanity failed"));
      },
    },
  ])(
    "marks the runtime not-ready when $job fails",
    async ({ job, reason, fail }) => {
      const world = emptyWorld();
      const runner = createResolutionRunner({
        pool: runnerPool(world),
        config: DEFAULT_RESOLUTION_CONFIG,
        lexicon: DEFAULT_RESOLUTION_LEXICON,
        curatedEdges: [],
        executionMode: "paper",
        clock: () => NOW,
        generationFactory: () => GENERATION_A,
      });
      await runner.start();
      fail();

      await expect(runner.tickOnce(job)).rejects.toThrow(/failed/);
      expect(world.runtime).toMatchObject({
        ready: false,
        failure_reason: reason,
      });
      await runner.stop();
    },
  );

  it("rotates generation and performs a full boot after the lease expires", async () => {
    const world = emptyWorld();
    let now = NOW;
    const generations = [GENERATION_A, GENERATION_B];
    const runner = createResolutionRunner({
      pool: runnerPool(world),
      config: DEFAULT_RESOLUTION_CONFIG,
      lexicon: DEFAULT_RESOLUTION_LEXICON,
      curatedEdges: [],
      executionMode: "paper",
      clock: () => now,
      generationFactory: () => generations.shift() ?? GENERATION_B,
    });
    await runner.start();
    now = new Date(NOW.getTime() + 60_001);

    await runner.tickOnce("state_tick");

    expect(world.runtime).toMatchObject({
      generation: GENERATION_B,
      ready: true,
    });
    expect(
      mocked.recompute.mock.calls.filter((call) => call[1] === "boot"),
    ).toHaveLength(2);
    await runner.stop();
  });

  it("serializes graph build and graph eval through one pipeline mutex", async () => {
    const world = emptyWorld();
    const runner = createResolutionRunner({
      pool: runnerPool(world),
      config: DEFAULT_RESOLUTION_CONFIG,
      lexicon: DEFAULT_RESOLUTION_LEXICON,
      curatedEdges: [],
      executionMode: "paper",
      clock: () => NOW,
      generationFactory: () => GENERATION_A,
    });
    await runner.start();
    const evaluationsBefore = mocked.evaluateGraph.mock.calls.length;
    let releaseBuild: (() => void) | undefined;
    let buildReached: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      buildReached = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    mocked.buildGraph.mockImplementationOnce(async () => {
      buildReached?.();
      await blocked;
      return { inserted: 0, closed: 0 };
    });

    const build = runner.tickOnce("graph_build");
    await reached;
    const evaluation = runner.tickOnce("graph_eval");
    await Promise.resolve();
    expect(mocked.evaluateGraph.mock.calls).toHaveLength(evaluationsBefore);

    releaseBuild?.();
    await Promise.all([build, evaluation]);
    expect(mocked.evaluateGraph.mock.calls).toHaveLength(evaluationsBefore + 2);
    await runner.stop();
  });

  it("does not carry a rolled-back streak into the recovery generation", async () => {
    const world = emptyWorld();
    const generations = [GENERATION_A, GENERATION_B];
    const runner = createResolutionRunner({
      pool: runnerPool(world),
      config: DEFAULT_RESOLUTION_CONFIG,
      lexicon: DEFAULT_RESOLUTION_LEXICON,
      curatedEdges: [],
      executionMode: "paper",
      clock: () => NOW,
      generationFactory: () => generations.shift() ?? GENERATION_B,
    });
    await runner.start();
    let failedClone: Map<string, number> | null = null;
    mocked.evaluateGraph.mockImplementationOnce(
      async (_pool, _config, next: Map<string, number>) => {
        failedClone = next;
        next.set("edge", 2);
        return {
          checked: 1,
          beyond: 1,
          opened: 0,
          closed: 0,
          skipped: 0,
          suppressed: 0,
        };
      },
    );
    mocked.sanityCheck.mockRejectedValueOnce(new Error("sanity failed"));

    await expect(runner.tickOnce("graph_eval")).rejects.toThrow(
      "sanity failed",
    );
    expect((failedClone as Map<string, number> | null)?.get("edge")).toBe(2);

    let recoveredInput: number | undefined;
    mocked.evaluateGraph.mockImplementationOnce(
      async (_pool, _config, next: Map<string, number>) => {
        recoveredInput = next.get("edge");
        return {
          checked: 0,
          beyond: 0,
          opened: 0,
          closed: 0,
          skipped: 0,
          suppressed: 0,
        };
      },
    );
    await runner.tickOnce("state_tick");

    expect(recoveredInput).toBeUndefined();
    expect(world.runtime).toMatchObject({
      generation: GENERATION_B,
      ready: true,
    });
    await runner.stop();
  });

  it("never lets heartbeat extend graph freshness and rotates at equality", async () => {
    const world = emptyWorld();
    let now = NOW;
    const generations = [GENERATION_A, GENERATION_B];
    const runner = createResolutionRunner({
      pool: runnerPool(world),
      config: DEFAULT_RESOLUTION_CONFIG,
      lexicon: DEFAULT_RESOLUTION_LEXICON,
      curatedEdges: [],
      executionMode: "paper",
      clock: () => now,
      generationFactory: () => generations.shift() ?? GENERATION_B,
    });
    await runner.start();
    const originalGraphExpiry = world.runtime?.graph_valid_until;
    now = new Date(NOW.getTime() + 30_000);

    await runner.tickOnce("heartbeat");
    expect(world.runtime?.graph_valid_until).toEqual(originalGraphExpiry);

    now = new Date(NOW.getTime() + 120_000);
    if (world.runtime !== null) {
      world.runtime.lease_expires_at = new Date(NOW.getTime() + 180_000);
    }
    await runner.tickOnce("state_tick");
    expect(world.runtime).toMatchObject({
      generation: GENERATION_B,
      ready: true,
      graph_evaluated_at: now,
    });
    await runner.stop();
  });

  it("consumes param and membership changes from the authoritative journal", async () => {
    const world = emptyWorld();
    const runner = createResolutionRunner({
      pool: runnerPool(world),
      config: DEFAULT_RESOLUTION_CONFIG,
      lexicon: DEFAULT_RESOLUTION_LEXICON,
      curatedEdges: [],
      executionMode: "paper",
      clock: () => NOW,
      generationFactory: () => GENERATION_A,
    });
    await runner.start();
    world.statements.length = 0;
    world.changes.push(
      {
        input_change_id: 1,
        source: "param_version",
        source_key: "21",
        condition_id: "0xparam",
      },
      {
        input_change_id: 2,
        source: "event_membership",
        source_key: '["event","0xmember"]',
        condition_id: "0xmember",
      },
    );
    const buildsBefore = mocked.buildGraph.mock.calls.length;
    const evaluationsBefore = mocked.evaluateGraph.mock.calls.length;
    const sanityBefore = mocked.sanityCheck.mock.calls.length;

    await runner.tickOnce("state_tick");

    const stateLock = world.statements.findIndex((text) =>
      text.startsWith(
        "LOCK TABLE polymarket_resolution_input_changes IN SHARE MODE",
      ),
    );
    const cursorRead = world.statements.findIndex((text) =>
      text.includes("SELECT processed_resolution_event_id"),
    );
    const journalRead = world.statements.findIndex((text) =>
      text.includes("FROM polymarket_resolution_input_changes c"),
    );
    expect(stateLock).toBeGreaterThanOrEqual(0);
    expect(stateLock).toBeLessThan(cursorRead);
    expect(stateLock).toBeLessThan(journalRead);
    const incremental = mocked.recompute.mock.calls.find(
      (call) => call[1] === "rule_change",
    );
    expect(incremental?.[3]).toEqual(["0xparam", "0xmember"]);
    expect(mocked.buildGraph.mock.calls).toHaveLength(buildsBefore + 1);
    expect(mocked.evaluateGraph.mock.calls).toHaveLength(evaluationsBefore + 1);
    expect(mocked.sanityCheck.mock.calls).toHaveLength(sanityBefore + 1);
    expect(world.runtime?.processed_input_change_id).toBe(2n);
    await runner.stop();
  });

  it.each([
    {
      source: "resolution_event",
      sourceKey: "1",
      eventType: "proposed",
    },
    { source: "rule_version", sourceKey: "1", eventType: null },
    { source: "param_version", sourceKey: "1", eventType: null },
    {
      source: "event_membership",
      sourceKey: '["event","0xmarket"]',
      eventType: null,
    },
    { source: "market_metadata", sourceKey: "1", eventType: null },
    { source: "universe_membership", sourceKey: "1", eventType: null },
  ])(
    "runs build/evaluate/sanity before publishing a $source cursor",
    async ({ source, sourceKey, eventType }) => {
      const world = emptyWorld();
      const runner = createResolutionRunner({
        pool: runnerPool(world),
        config: DEFAULT_RESOLUTION_CONFIG,
        lexicon: DEFAULT_RESOLUTION_LEXICON,
        curatedEdges: [],
        executionMode: "paper",
        clock: () => NOW,
        generationFactory: () => GENERATION_A,
      });
      await runner.start();
      if (source === "resolution_event") {
        world.events.push({
          resolution_event_id: 1,
          condition_id: "0xmarket",
          event_type: eventType,
        });
      }
      if (source === "rule_version") {
        world.rules.push({ rule_version_id: 1, condition_id: "0xmarket" });
      }
      world.changes.push({
        input_change_id: 1,
        source,
        source_key: sourceKey,
        condition_id: "0xmarket",
      });
      const buildsBefore = mocked.buildGraph.mock.calls.length;
      const evaluationsBefore = mocked.evaluateGraph.mock.calls.length;
      const sanityBefore = mocked.sanityCheck.mock.calls.length;

      await runner.tickOnce("state_tick");

      expect(mocked.buildGraph.mock.calls).toHaveLength(buildsBefore + 1);
      expect(mocked.evaluateGraph.mock.calls).toHaveLength(
        evaluationsBefore + 1,
      );
      expect(mocked.sanityCheck.mock.calls).toHaveLength(sanityBefore + 1);
      expect(world.runtime?.processed_input_change_id).toBe(1n);
      await runner.stop();
    },
  );

  it.each([
    {
      name: "market metadata",
      source: "market_metadata",
      eventType: null,
      trigger: "rule_change",
    },
    {
      name: "disputed event",
      source: "resolution_event",
      eventType: "disputed",
      trigger: "status_change",
    },
    {
      name: "resolved event",
      source: "resolution_event",
      eventType: "resolved",
      trigger: "status_change",
    },
    {
      name: "market_resolved event",
      source: "resolution_event",
      eventType: "market_resolved",
      trigger: "status_change",
    },
  ] as const)(
    "runs one full $trigger recompute when the batch contains $name",
    async ({ source, eventType, trigger }) => {
      const world = emptyWorld();
      const runner = createResolutionRunner({
        pool: runnerPool(world),
        config: DEFAULT_RESOLUTION_CONFIG,
        lexicon: DEFAULT_RESOLUTION_LEXICON,
        curatedEdges: [],
        executionMode: "paper",
        clock: () => NOW,
        generationFactory: () => GENERATION_A,
      });
      await runner.start();
      const sourceKey = "7";
      if (eventType !== null) {
        world.events.push({
          resolution_event_id: 7,
          condition_id: "0xfanout",
          event_type: eventType,
        });
      }
      world.changes.push({
        input_change_id: 1,
        source,
        source_key: sourceKey,
        condition_id: "0xfanout",
      });
      const callsBefore = mocked.recompute.mock.calls.length;
      const buildsBefore = mocked.buildGraph.mock.calls.length;
      const evaluationsBefore = mocked.evaluateGraph.mock.calls.length;

      await runner.tickOnce("state_tick");

      const calls = mocked.recompute.mock.calls.slice(callsBefore);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toBe(trigger);
      expect(calls[0]?.[3]).toBeNull();
      expect(mocked.buildGraph.mock.calls).toHaveLength(buildsBefore + 1);
      expect(mocked.evaluateGraph.mock.calls).toHaveLength(
        evaluationsBefore + 1,
      );
      expect(world.runtime?.processed_input_change_id).toBe(1n);
      await runner.stop();
    },
  );

  it("classifies resolution journal rows and commits all three cursors atomically", async () => {
    const world = emptyWorld();
    const runner = createResolutionRunner({
      pool: runnerPool(world),
      config: DEFAULT_RESOLUTION_CONFIG,
      lexicon: DEFAULT_RESOLUTION_LEXICON,
      curatedEdges: [],
      executionMode: "paper",
      clock: () => NOW,
      generationFactory: () => GENERATION_A,
    });
    await runner.start();
    world.events.push(
      {
        resolution_event_id: 7,
        condition_id: "0xstatus",
        event_type: "proposed",
      },
      {
        resolution_event_id: 8,
        condition_id: "0xrule-event",
        event_type: "rule_change",
      },
    );
    world.rules.push({ rule_version_id: 9, condition_id: "0xrule" });
    world.changes.push(
      {
        input_change_id: 1,
        source: "resolution_event",
        source_key: "7",
        condition_id: "0xstatus",
      },
      {
        input_change_id: 2,
        source: "resolution_event",
        source_key: "8",
        condition_id: "0xrule-event",
      },
      {
        input_change_id: 3,
        source: "rule_version",
        source_key: "9",
        condition_id: "0xrule",
      },
    );

    await runner.tickOnce("state_tick");

    expect(
      mocked.recompute.mock.calls.find(
        (call) => call[1] === "rule_change",
      )?.[3],
    ).toEqual(["0xrule-event", "0xrule"]);
    expect(
      mocked.recompute.mock.calls.find(
        (call) => call[1] === "status_change",
      )?.[3],
    ).toEqual(["0xstatus"]);
    expect(world.runtime).toMatchObject({
      processed_input_change_id: 3n,
      processed_resolution_event_id: 8n,
      processed_rule_version_id: 9n,
    });
    await runner.stop();
  });

  it("rotates and performs a full boot when work crosses the lease boundary", async () => {
    const world = emptyWorld();
    let now = NOW;
    const generations = [GENERATION_A, GENERATION_B];
    const runner = createResolutionRunner({
      pool: runnerPool(world),
      config: DEFAULT_RESOLUTION_CONFIG,
      lexicon: DEFAULT_RESOLUTION_LEXICON,
      curatedEdges: [],
      executionMode: "paper",
      clock: () => now,
      generationFactory: () => generations.shift() ?? GENERATION_B,
    });
    await runner.start();
    now = new Date(NOW.getTime() + 59_000);
    world.changes.push({
      input_change_id: 1,
      source: "param_version",
      source_key: "1",
      condition_id: "0xparam",
    });
    mocked.recompute.mockImplementation(async (_deps, trigger) => {
      if (trigger === "rule_change") {
        now = new Date(NOW.getTime() + 60_001);
      }
      return { scored: 1, failed: 0 };
    });

    await runner.tickOnce("state_tick");

    expect(world.runtime).toMatchObject({
      generation: GENERATION_B,
      ready: true,
      processed_input_change_id: 1n,
    });
    expect(
      mocked.recompute.mock.calls.filter((call) => call[1] === "boot"),
    ).toHaveLength(2);
    await runner.stop();
  });

  it("marks the runtime not-ready when a full sweep is incomplete", async () => {
    const world = emptyWorld();
    const runner = createResolutionRunner({
      pool: runnerPool(world),
      config: DEFAULT_RESOLUTION_CONFIG,
      lexicon: DEFAULT_RESOLUTION_LEXICON,
      curatedEdges: [],
      executionMode: "paper",
      clock: () => NOW,
      generationFactory: () => GENERATION_A,
    });
    await runner.start();
    mocked.recompute.mockResolvedValueOnce({ scored: 2, failed: 1 });

    await expect(runner.tickOnce("sweep")).rejects.toMatchObject({
      reasonCode: "RESOLUTION_RECOMPUTE_INCOMPLETE",
    });

    expect(world.runtime).toMatchObject({
      ready: false,
      failure_reason: "SWEEP_FAILED",
    });
    await runner.stop();
  });

  it("cannot publish readiness again after the runtime is stopped", async () => {
    const world = emptyWorld();
    const runner = createResolutionRunner({
      pool: runnerPool(world),
      config: DEFAULT_RESOLUTION_CONFIG,
      lexicon: DEFAULT_RESOLUTION_LEXICON,
      curatedEdges: [],
      executionMode: "paper",
      clock: () => NOW,
      generationFactory: () => GENERATION_A,
    });
    await runner.start();
    await runner.stop();

    await expect(runner.tickOnce("state_tick")).rejects.toMatchObject({
      reasonCode: "RESOLUTION_RUNTIME_STOPPING",
    });

    expect(world.runtime?.ready).toBe(false);
    expect(
      world.statements.some(
        (text) =>
          text.includes("processed_input_change_id") &&
          text.includes("stopped_at IS NULL"),
      ),
    ).toBe(true);
  });

  it("does not reopen when stop races with a state tick waiting for ownership", async () => {
    const world = emptyWorld();
    const runner = createResolutionRunner({
      pool: runnerPool(world),
      config: DEFAULT_RESOLUTION_CONFIG,
      lexicon: DEFAULT_RESOLUTION_LEXICON,
      curatedEdges: [],
      executionMode: "paper",
      clock: () => NOW,
      generationFactory: () => GENERATION_A,
    });
    await runner.start();

    let releaseLock: (() => void) | undefined;
    let lockReached: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      lockReached = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    world.runtimeLockHook = async () => {
      world.runtimeLockHook = null;
      lockReached?.();
      await blocked;
    };

    const tick = runner.tickOnce("state_tick");
    await reached;
    const stopped = runner.stop();
    releaseLock?.();
    await stopped;
    await expect(tick).rejects.toMatchObject({
      reasonCode: "RESOLUTION_GENERATION_LOST",
    });

    expect(world.runtime).toMatchObject({ ready: false, stopped_at: NOW });
  });
});
