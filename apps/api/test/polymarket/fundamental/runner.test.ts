import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DatabasePool,
  QueryResult,
  SqlExecutor,
} from "../../../src/database.js";
import { CATEGORY_MODELS } from "../../../src/polymarket/fundamental/catalog.js";
import { DEFAULT_FUNDAMENTAL_CONFIG } from "../../../src/polymarket/fundamental/config.js";
import {
  createRunner,
  ensureCatalogModels,
} from "../../../src/polymarket/fundamental/runner.js";

const GIT_SHA = "c".repeat(40);
const NOW = new Date("2026-08-19T12:00:00.000Z");

/**
 * A pool that answers every read with no rows and records the writes. That is
 * exactly the state of a fresh database, which is when the boot path has to
 * register the catalog.
 */
function recordingPool(): DatabasePool & { readonly statements: string[] } {
  const statements: string[] = [];
  const query = <R extends Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>> => {
    statements.push(text);
    if (text.includes("INSERT INTO fundamental_model_events")) {
      // The event insert uses RETURNING; a registration whose audit trail is
      // not written is refused, so the fake has to answer like PostgreSQL.
      return Promise.resolve({
        rows: [{ model_event_id: 1 } as unknown as R],
        rowCount: 1,
      });
    }
    if (text.includes("INSERT INTO fundamental_models")) {
      // RETURNING row, as PostgreSQL would answer.
      const row = {
        model_id: params?.[0],
        model_family: params?.[1],
        category: params?.[2],
        version: params?.[3],
        git_sha: params?.[4],
        feature_set_version: params?.[5],
        hyperparams_json: params?.[6],
        seed: params?.[7],
        train_window_start: params?.[8],
        train_window_end: params?.[9],
        regime_mix: params?.[10],
        status: "shadow",
        last_gate_report_id: null,
        created_at: NOW,
        promoted_at: null,
        demoted_at: null,
        retired_at: null,
      };
      return Promise.resolve({ rows: [row as unknown as R], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
  return {
    statements,
    query,
    transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return run({ query });
    },
    end(): Promise<void> {
      return Promise.resolve();
    },
  };
}

/** A complete model row, as PostgreSQL would return it. */
function existingRow(): Record<string, unknown> {
  return {
    model_id: "crypto_updown_gbm@1.0.0",
    model_family: "crypto_updown_gbm",
    category: "crypto_updown",
    version: "1.0.0",
    git_sha: GIT_SHA,
    feature_set_version: "1.0.0",
    hyperparams_json: {},
    seed: 0,
    train_window_start: null,
    train_window_end: null,
    regime_mix: false,
    status: "shadow",
    last_gate_report_id: null,
    created_at: NOW,
    promoted_at: null,
    demoted_at: null,
    retired_at: null,
  };
}

const stderr: string[] = [];

beforeEach(() => {
  stderr.length = 0;
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createRunner boot path", () => {
  it("registers every catalog model in shadow before the first cycle", async () => {
    const pool = recordingPool();
    const runner = createRunner({
      pool,
      config: DEFAULT_FUNDAMENTAL_CONFIG,
      gitSha: GIT_SHA,
      clock: () => NOW,
    });
    await runner.start();
    await runner.stop();

    const inserts = pool.statements.filter((text) =>
      text.includes("INSERT INTO fundamental_models"),
    );
    // Without this the estimator would run forever with an empty registry and
    // no model would ever accumulate shadow evidence.
    expect(inserts).toHaveLength(CATEGORY_MODELS.length);
    expect(CATEGORY_MODELS.length).toBeGreaterThan(0);

    const events = pool.statements.filter((text) =>
      text.includes("INSERT INTO fundamental_model_events"),
    );
    expect(events.length).toBeGreaterThanOrEqual(CATEGORY_MODELS.length);

    // The first estimation cycle really ran at boot.
    expect(
      pool.statements.some((text) => text.includes("polymarket_universe_log")),
    ).toBe(true);
  });

  it("reports an already-registered model as benign, not as a failure", async () => {
    // The insert uses ON CONFLICT DO NOTHING and therefore returns no row when
    // the model exists — which happens whenever a read hiccups before it, or
    // two containers overlap during a recreate. That is not an error.
    const statements: string[] = [];
    const pool: DatabasePool = {
      query<R extends Record<string, unknown>>(
        text: string,
      ): Promise<QueryResult<R>> {
        statements.push(text);
        if (text.includes("SELECT") && text.includes("fundamental_models")) {
          // The pre-check fails to see it, the post-failure re-check does.
          const seen = statements.filter(
            (entry) =>
              entry.includes("SELECT") && entry.includes("fundamental_models"),
          ).length;
          return Promise.resolve(
            seen % 2 === 0
              ? { rows: [], rowCount: 0 }
              : {
                  rows: [existingRow() as unknown as R],
                  rowCount: 1,
                },
          );
        }
        // INSERT ... ON CONFLICT DO NOTHING RETURNING: no row.
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
        return run({ query: this.query });
      },
      end(): Promise<void> {
        return Promise.resolve();
      },
    };

    const registered = await ensureCatalogModels(pool, GIT_SHA, NOW);
    expect(registered).toEqual([]);
    expect(stderr.join("\n")).not.toContain("MODEL_REGISTRATION_FAILED");
  });

  it("registers nothing when the running revision is unknown", async () => {
    const pool = recordingPool();
    const runner = createRunner({
      pool,
      config: DEFAULT_FUNDAMENTAL_CONFIG,
      gitSha: null,
      clock: () => NOW,
    });
    await runner.start();
    await runner.stop();

    // A model without complete provenance must not exist at all.
    expect(
      pool.statements.filter((text) =>
        text.includes("INSERT INTO fundamental_models"),
      ),
    ).toHaveLength(0);
  });

  it("stops every timer so a stopped runner writes nothing more", async () => {
    vi.useFakeTimers();
    const pool = recordingPool();
    const runner = createRunner({
      pool,
      config: DEFAULT_FUNDAMENTAL_CONFIG,
      gitSha: GIT_SHA,
      clock: () => NOW,
    });
    await runner.start();
    await runner.stop();
    const afterStop = pool.statements.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(pool.statements.length).toBe(afterStop);
  });
});
