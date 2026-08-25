// PostgreSQL concurrency coverage for the rule/parameter chains. Skipped in
// the source-only gate; point GANSO_TEST_DATABASE_URL at a migrated throwaway
// database to exercise real transactions and advisory locks.

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  DatabasePool,
  QueryResult,
  SqlExecutor,
} from "../../src/database.js";
import {
  applyParamFields,
  applyParamObservation,
  applyRuleObservation,
  type ParamObservation,
  type RuleObservation,
} from "../../src/polymarket/versioning.js";

const DATABASE_URL = process.env.GANSO_TEST_DATABASE_URL;
const RUN_ID = `${String(process.pid)}-${String(Date.now())}`;
const CONDITION_ID = `0xparam-concurrency-${RUN_ID}`;
const RULE_CONDITION_ID = `0xrule-concurrency-${RUN_ID}`;
const T0 = new Date("2026-08-24T12:00:00.000Z");
const T1 = new Date("2026-08-24T12:00:01.000Z");
const T2 = new Date("2026-08-24T12:00:02.000Z");

function baseObservation(): ParamObservation {
  return {
    conditionId: CONDITION_ID,
    feeBaseBps: "0",
    makerFeeBps: "0",
    takerFeeBps: "0",
    feeCurveJson: null,
    tickSize: "0.001",
    minOrderSize: "5",
    negRisk: false,
    sourceTs: null,
  };
}

function baseRuleObservation(description: string): RuleObservation {
  return {
    conditionId: RULE_CONDITION_ID,
    description,
    resolutionSource: "Official publication",
    resolvedBy: "UMA",
    endDate: new Date("2026-08-31T00:00:00.000Z"),
    umaEndDate: null,
    umaBond: "500",
    umaReward: "5",
    customLiveness: "7200",
    automaticallyResolved: false,
    sourceTs: null,
  };
}

interface AdvisoryLockHooks {
  readonly before?: () => void | Promise<void>;
  readonly after?: () => void | Promise<void>;
}

function poolAdapter(
  raw: pg.Pool,
  hooks: AdvisoryLockHooks = {},
): DatabasePool {
  const query = async <R extends Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>> => {
    const result = await raw.query<R>(
      text,
      params === undefined ? undefined : [...params],
    );
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  };
  return {
    query,
    async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const client = await raw.connect();
      let lockHookRan = false;
      try {
        await client.query("BEGIN");
        const value = await run({
          async query<R extends Record<string, unknown>>(
            text: string,
            params?: readonly unknown[],
          ): Promise<QueryResult<R>> {
            const advisoryLock = text.includes("pg_advisory_xact_lock");
            if (advisoryLock && !lockHookRan) {
              await hooks.before?.();
            }
            const result = await client.query<R>(
              text,
              params === undefined ? undefined : [...params],
            );
            if (advisoryLock && !lockHookRan) {
              lockHookRan = true;
              await hooks.after?.();
            }
            return { rows: result.rows, rowCount: result.rowCount ?? 0 };
          },
        });
        await client.query("COMMIT");
        return value;
      } catch (error: unknown) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    end(): Promise<void> {
      return Promise.resolve();
    },
  };
}

describe.skipIf(DATABASE_URL === undefined)(
  "parameter version serialization (PostgreSQL)",
  () => {
    let raw: pg.Pool;

    beforeAll(async () => {
      raw = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
      await raw.query(
        `DELETE FROM polymarket_param_versions WHERE condition_id = $1`,
        [CONDITION_ID],
      );
      await raw.query(
        `DELETE FROM polymarket_rule_versions WHERE condition_id = $1`,
        [RULE_CONDITION_ID],
      );
    });

    afterAll(async () => {
      if (raw !== undefined) {
        await raw
          .query(
            `DELETE FROM polymarket_param_versions WHERE condition_id = $1`,
            [CONDITION_ID],
          )
          .catch(() => undefined);
        await raw
          .query(
            `DELETE FROM polymarket_rule_versions WHERE condition_id = $1`,
            [RULE_CONDITION_ID],
          )
          .catch(() => undefined);
        await raw.end();
      }
    });

    it("preserves disjoint out-of-order patches in one contiguous chain", async () => {
      await applyParamObservation(poolAdapter(raw), baseObservation(), T0);

      let releaseFirst!: () => void;
      const holdFirst = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let markFirstLocked!: () => void;
      const firstLocked = new Promise<void>((resolve) => {
        markFirstLocked = resolve;
      });
      const firstPool = poolAdapter(raw, {
        after: async () => {
          markFirstLocked();
          await holdFirst;
        },
      });

      // The first writer owns the lock with the later timestamp. The second
      // writer carries an older timestamp and must still merge over its result.
      const tickPatch = applyParamFields(
        firstPool,
        CONDITION_ID,
        { tickSize: "0.01" },
        T2,
      );
      await firstLocked;

      let secondAttempted = false;
      let secondAcquired = false;
      let markSecondAttempted!: () => void;
      const secondAttemptedBarrier = new Promise<void>((resolve) => {
        markSecondAttempted = resolve;
      });
      const feePatch = applyParamFields(
        poolAdapter(raw, {
          before: () => {
            secondAttempted = true;
            markSecondAttempted();
          },
          after: () => {
            secondAcquired = true;
          },
        }),
        CONDITION_ID,
        { feeBaseBps: "40", makerFeeBps: "0", takerFeeBps: "40" },
        T1,
      );
      let secondSettled = false;
      void feePatch.then(
        () => {
          secondSettled = true;
        },
        () => {
          secondSettled = true;
        },
      );
      await secondAttemptedBarrier;
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(secondAttempted).toBe(true);
      expect(secondAcquired).toBe(false);
      expect(secondSettled).toBe(false);
      releaseFirst();

      await expect(Promise.all([tickPatch, feePatch])).resolves.toHaveLength(2);
      expect(secondAcquired).toBe(true);

      const chain = await raw.query<{
        version: number;
        fee_base_bps: string | null;
        taker_fee_bps: string | null;
        tick_size: string | null;
        valid_from: Date;
        valid_to: Date | null;
        received_at: Date;
      }>(
        `SELECT version, fee_base_bps, taker_fee_bps, tick_size,
                valid_from, valid_to, received_at
           FROM polymarket_param_versions
          WHERE condition_id = $1
          ORDER BY version`,
        [CONDITION_ID],
      );

      expect(chain.rows.map((row) => row.version)).toEqual([1, 2, 3]);
      expect(chain.rows[2]).toMatchObject({
        fee_base_bps: "40",
        taker_fee_bps: "40",
        tick_size: "0.01",
        valid_to: null,
      });
      expect(chain.rows.filter((row) => row.valid_to === null)).toHaveLength(1);
      expect(chain.rows[1]?.received_at).toEqual(T2);
      expect(chain.rows[2]?.received_at).toEqual(T1);
      expect(chain.rows[2]?.valid_from.getTime()).toBeGreaterThan(
        chain.rows[1]?.valid_from.getTime() ?? Number.POSITIVE_INFINITY,
      );
      for (let index = 0; index < chain.rows.length - 1; index += 1) {
        const current = chain.rows[index];
        const next = chain.rows[index + 1];
        expect(current).toBeDefined();
        expect(next).toBeDefined();
        expect(current?.valid_to).toEqual(next?.valid_from);
        expect(current?.valid_to?.getTime()).toBeGreaterThan(
          current?.valid_from.getTime() ?? Number.POSITIVE_INFINITY,
        );
      }

      await expect(
        applyParamFields(
          poolAdapter(raw),
          CONDITION_ID,
          { tickSize: "0.005" },
          T1,
        ),
      ).rejects.toThrow("PARAM_PATCH_CAUSAL_CONFLICT:tick_size");
      const head = await raw.query<{ tick_size: string | null }>(
        `SELECT tick_size
           FROM polymarket_param_versions
          WHERE condition_id = $1 AND valid_to IS NULL`,
        [CONDITION_ID],
      );
      expect(head.rows).toEqual([{ tick_size: "0.01" }]);
    });

    it("blocks then rejects an out-of-order complete rule observation", async () => {
      await applyRuleObservation(
        poolAdapter(raw),
        baseRuleObservation("Initial resolution rule."),
        T0,
      );

      let releaseFirst!: () => void;
      const holdFirst = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let markFirstLocked!: () => void;
      const firstLocked = new Promise<void>((resolve) => {
        markFirstLocked = resolve;
      });
      const firstPool = poolAdapter(raw, {
        after: async () => {
          markFirstLocked();
          await holdFirst;
        },
      });

      const laterObservation = applyRuleObservation(
        firstPool,
        baseRuleObservation("Rule observed later but committed first."),
        T2,
      );
      await firstLocked;

      let secondAcquired = false;
      let markSecondAttempted!: () => void;
      const secondAttempted = new Promise<void>((resolve) => {
        markSecondAttempted = resolve;
      });
      const earlierObservation = applyRuleObservation(
        poolAdapter(raw, {
          before: markSecondAttempted,
          after: () => {
            secondAcquired = true;
          },
        }),
        baseRuleObservation("Earlier timestamp, serialized second."),
        T1,
      );
      let earlierSettled = false;
      void earlierObservation.then(
        () => {
          earlierSettled = true;
        },
        () => {
          earlierSettled = true;
        },
      );
      const rejectedEarlier = expect(earlierObservation).rejects.toThrow(
        "RULE_OBSERVATION_TIME_NOT_MONOTONIC",
      );
      await secondAttempted;
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(secondAcquired).toBe(false);
      expect(earlierSettled).toBe(false);
      releaseFirst();

      await expect(laterObservation).resolves.toMatchObject({
        version: 2,
        changed: true,
      });
      await rejectedEarlier;
      expect(secondAcquired).toBe(true);

      const chain = await raw.query<{
        version: number;
        description: string;
        valid_from: Date;
        valid_to: Date | null;
      }>(
        `SELECT version, description, valid_from, valid_to
           FROM polymarket_rule_versions
          WHERE condition_id = $1
          ORDER BY version`,
        [RULE_CONDITION_ID],
      );
      expect(chain.rows.map((row) => row.version)).toEqual([1, 2]);
      expect(chain.rows[1]).toMatchObject({
        description: "Rule observed later but committed first.",
        valid_to: null,
      });
      expect(chain.rows.filter((row) => row.valid_to === null)).toHaveLength(1);
      for (let index = 0; index < chain.rows.length - 1; index += 1) {
        const current = chain.rows[index];
        const next = chain.rows[index + 1];
        expect(current?.valid_to).toEqual(next?.valid_from);
        expect(current?.valid_to?.getTime()).toBeGreaterThan(
          current?.valid_from.getTime() ?? Number.POSITIVE_INFINITY,
        );
      }

      const events = await raw.query<{ received_at: Date }>(
        `SELECT received_at
           FROM polymarket_resolution_events
          WHERE condition_id = $1 AND event_type = 'rule_change'
          ORDER BY received_at`,
        [RULE_CONDITION_ID],
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]?.received_at).toEqual(T2);
      expect(events.rows[0]?.received_at).toEqual(chain.rows[1]?.valid_from);
    });
  },
);
