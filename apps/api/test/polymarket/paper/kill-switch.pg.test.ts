// OPS-03 / RFC-021 D2-D3. Run only against a disposable PostgreSQL database:
// GANSO_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:<port>/ops03_test
// Each test creates its own schema; the real 0008 ledger guards remain enabled.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { QueryResult, SqlExecutor } from "../../../src/database.js";
import {
  KILL_SWITCH_HEALTHY_TICKS,
  KILL_SWITCH_TICK_MS,
  createKillSwitchRecoveryState,
  engageKillSwitch,
  killSwitchTriggersTick,
  type PaperPool,
} from "../../../src/polymarket/paper/brokerstore.js";

const DATABASE_URL = process.env["GANSO_TEST_DATABASE_URL"];
const BASE = new Date("2026-09-11T12:00:00.000Z");
const silentSink = (): void => undefined;
type Recovery = ReturnType<typeof createKillSwitchRecoveryState>;

let admin: pg.Pool;
let raw: pg.Pool;
let schema: string;
let migration: string;

function executor(client: pg.Pool | pg.PoolClient): SqlExecutor {
  return {
    async query<R extends Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      const result = await client.query<R>(text, [...params]);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
  };
}

function pool(beforeCommit?: () => Promise<void>): PaperPool {
  return {
    query: executor(raw).query,
    async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const client = await raw.connect();
      try {
        await client.query("BEGIN");
        const result = await run(executor(client));
        await beforeCommit?.();
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function at(tick: number): Date {
  return new Date(BASE.getTime() + tick * KILL_SWITCH_TICK_MS);
}

async function fresh(tick: number): Promise<void> {
  const now = at(tick);
  await raw.query("UPDATE polymarket_book_snapshots SET received_at = $1", [
    now,
  ]);
  await raw.query("UPDATE polymarket_book_deltas SET received_at = $1", [now]);
}

function trigger(tick: number, recovery: Recovery): Promise<void> {
  return killSwitchTriggersTick(pool(), {
    clock: () => at(tick),
    killSwitchRecovery: recovery,
    logSink: silentSink,
  });
}

async function observeThrough(
  ticks: number,
  ...recoveries: Recovery[]
): Promise<void> {
  for (let tick = 1; tick <= ticks; tick += 1) {
    await fresh(tick);
    for (const recovery of recoveries) {
      await trigger(tick, recovery);
    }
  }
}

async function engagements(): Promise<Record<string, unknown>[]> {
  return (
    await raw.query("SELECT * FROM paper_ledger_events ORDER BY event_id")
  ).rows;
}

async function switchState(): Promise<Record<string, unknown>> {
  return (
    await raw.query("SELECT * FROM paper_kill_switch WHERE kill_switch_id = 1")
  ).rows[0] as Record<string, unknown>;
}

describe.skipIf(DATABASE_URL === undefined)(
  "OPS-03 kill switch — PostgreSQL transactions",
  () => {
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
      const original = await readFile(
        new URL(
          "../../../../../migrations/0008_polymarket_paper_broker.sql",
          import.meta.url,
        ),
        "utf8",
      );
      // Execute the production DDL verbatim; only the migration-runner receipt
      // needs psql variables/schema_versions outside this isolated schema.
      migration = original.split("INSERT INTO schema_versions")[0] ?? "";
      expect(migration).toContain(
        "CREATE TRIGGER paper_ledger_events_guard_trg",
      );
    });

    beforeEach(async () => {
      schema = `ops03_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`CREATE SCHEMA ${schema}`);
      raw = new pg.Pool({
        connectionString: DATABASE_URL,
        max: 6,
        options: `-c search_path=${schema} -c statement_timeout=5000`,
        application_name: schema,
      });
      await raw.query(migration);
      await raw.query(`
      CREATE TABLE polymarket_book_snapshots (received_at timestamptz NOT NULL);
      CREATE TABLE polymarket_book_deltas (received_at timestamptz NOT NULL);
      CREATE TABLE polymarket_data_gaps (cause text NOT NULL, gap_end timestamptz);
      CREATE TABLE polymarket_resolution_events (condition_id text, event_type text);
      INSERT INTO polymarket_book_snapshots VALUES ('2026-09-11T11:50:00Z');
      INSERT INTO polymarket_book_deltas VALUES ('2026-09-11T11:50:00Z');
    `);
      // Engage through the real automatic D2 path: even a public/manual call
      // using the reason RECORDER_STALE must not become eligible for D3.
      await killSwitchTriggersTick(pool(), {
        clock: () => BASE,
        logSink: silentSink,
      });
    });

    afterEach(async () => {
      await raw?.end();
      if (schema !== undefined) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
    });

    afterAll(async () => {
      await admin?.end();
    });

    it("requires 15 observed minutes and appends exactly one auto event while preserving frozen markets and history", async () => {
      expect(KILL_SWITCH_HEALTHY_TICKS).toBe(15);
      expect(KILL_SWITCH_TICK_MS).toBe(60_000);
      const recovery = createKillSwitchRecoveryState(BASE);
      await raw.query(
        "UPDATE paper_kill_switch SET frozen_markets_json = '[\"disputed-market\"]'::jsonb",
      );
      const original = await engagements();

      await observeThrough(14, recovery);
      expect((await switchState())["engaged"]).toBe(true);
      expect(await engagements()).toEqual(original);

      await fresh(15);
      await trigger(15, recovery);
      await trigger(15, recovery);
      await fresh(16);
      await trigger(16, recovery);

      const state = await switchState();
      expect(state["engaged"]).toBe(false);
      expect(state["frozen_markets_json"]).toEqual(["disputed-market"]);
      const ledger = await engagements();
      expect(ledger.slice(0, original.length)).toEqual(original);
      expect(ledger).toHaveLength(original.length + 1);
      expect(ledger.at(-1)).toMatchObject({
        event_type: "kill_switch_rearmed",
        payload_json: { mode: "auto", healthy_ticks: 15 },
        event_ts: at(15),
      });
    });

    it("rolls back the state transition when the rearm audit INSERT fails", async () => {
      const recovery = createKillSwitchRecoveryState(BASE);
      await observeThrough(14, recovery);
      const before = await switchState();
      const ledger = await engagements();
      await raw.query(`
      CREATE FUNCTION reject_auto_rearm() RETURNS trigger AS $$
      BEGIN
        IF NEW.event_type = 'kill_switch_rearmed' THEN
          RAISE EXCEPTION 'OPS03 audit unavailable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER ops03_reject_auto_rearm BEFORE INSERT ON paper_ledger_events
        FOR EACH ROW EXECUTE FUNCTION reject_auto_rearm();
    `);
      await fresh(15);
      await expect(trigger(15, recovery)).rejects.toThrow(
        "OPS03 audit unavailable",
      );
      expect(await switchState()).toEqual(before);
      expect(await engagements()).toEqual(ledger);

      await raw.query(
        "DROP TRIGGER ops03_reject_auto_rearm ON paper_ledger_events",
      );
      await fresh(16);
      await trigger(16, recovery);
      expect((await switchState())["engaged"]).toBe(true);
      expect(await engagements()).toEqual(ledger);
    });

    it("serializes two workers reaching the fifteenth healthy tick into one rearm", async () => {
      const first = createKillSwitchRecoveryState(BASE);
      const second = createKillSwitchRecoveryState(BASE);
      await observeThrough(14, first, second);
      await fresh(15);
      await Promise.all([trigger(15, first), trigger(15, second)]);
      expect((await switchState())["engaged"]).toBe(false);
      expect(
        (await engagements()).filter(
          (event) => event["event_type"] === "kill_switch_rearmed",
        ),
      ).toHaveLength(1);
    });

    it("does not clear the switch when the automatic audit key already exists", async () => {
      const recovery = createKillSwitchRecoveryState(BASE);
      await observeThrough(14, recovery);
      await raw.query(
        "INSERT INTO paper_ledger_events (idempotency_key, event_type, payload_json, event_ts) VALUES ($1, 'kill_switch_rearmed', $2, $3)",
        [
          `rearm:auto:${BASE.toISOString()}`,
          JSON.stringify({ mode: "auto", healthy_ticks: 15 }),
          BASE,
        ],
      );
      const state = await switchState();
      const ledger = await engagements();
      await fresh(15);
      await expect(trigger(15, recovery)).rejects.toThrow(
        "PAPER_KILL_SWITCH_REARM_AUDIT_CONFLICT",
      );
      expect(await switchState()).toEqual(state);
      expect(await engagements()).toEqual(ledger);
    });

    it("rechecks a concurrent stream_silent insertion after waiting for the gap table lock", async () => {
      const recovery = createKillSwitchRecoveryState(BASE);
      await observeThrough(14, recovery);
      await fresh(15);
      const writer = await raw.connect();
      await writer.query("BEGIN");
      await writer.query(
        "INSERT INTO polymarket_data_gaps (cause, gap_end) VALUES ('stream_silent', NULL)",
      );
      const automatic = trigger(15, recovery);
      try {
        await expect
          .poll(
            async () => {
              const result = await admin.query(
                "SELECT COUNT(*)::int AS waiting FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
                [schema],
              );
              return result.rows[0]?.["waiting"];
            },
            { timeout: 2_000, interval: 10 },
          )
          .toBe(1);
      } finally {
        await writer.query("COMMIT");
        writer.release();
        await automatic;
      }
      expect(await switchState()).toMatchObject({
        engaged: true,
        reason: "RECORDER_STALE",
      });
      expect(
        (await engagements()).filter(
          (event) => event["event_type"] === "kill_switch_rearmed",
        ),
      ).toHaveLength(0);
    });

    it("preserves a concurrent manual engagement committed while the automatic tick waits for the row lock", async () => {
      const recovery = createKillSwitchRecoveryState(BASE);
      await observeThrough(14, recovery);
      await fresh(15);
      let markManualReady: () => void = () => undefined;
      let releaseManual: () => void = () => undefined;
      const manualReady = new Promise<void>((resolve) => {
        markManualReady = resolve;
      });
      const manualGate = new Promise<void>((resolve) => {
        releaseManual = resolve;
      });
      const manual = engageKillSwitch(
        pool(async () => {
          markManualReady();
          await manualGate;
        }),
        "MANUAL",
        at(15),
        { logSink: silentSink },
      );
      await manualReady;
      const automatic = trigger(15, recovery);
      try {
        // Evidence that the automatic worker is actually blocked by PostgreSQL,
        // rather than relying on sleeps to assume a particular Promise ordering.
        await expect
          .poll(
            async () => {
              const result = await admin.query(
                "SELECT COUNT(*)::int AS waiting FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
                [schema],
              );
              return result.rows[0]?.["waiting"];
            },
            { timeout: 2_000, interval: 10 },
          )
          .toBe(1);
      } finally {
        releaseManual();
        await Promise.all([manual, automatic]);
      }
      expect(await switchState()).toMatchObject({
        engaged: true,
        reason: "MANUAL",
      });
      expect(
        (await engagements()).filter(
          (event) => event["event_type"] === "kill_switch_rearmed",
        ),
      ).toHaveLength(0);
    });

    it("keeps the production append-only guards active after automatic rearm", async () => {
      const recovery = createKillSwitchRecoveryState(BASE);
      await observeThrough(15, recovery);
      const before = await engagements();
      expect(before).toHaveLength(2);
      await expect(
        raw.query("UPDATE paper_ledger_events SET payload_json = '{}'::jsonb"),
      ).rejects.toThrow("immutable (append-only ledger)");
      await expect(
        raw.query("DELETE FROM paper_ledger_events"),
      ).rejects.toThrow("immutable (append-only ledger)");
      expect(await engagements()).toEqual(before);
    });

    it("preserves a manual engagement even when its supplied reason is RECORDER_STALE", async () => {
      const manuallyEngagedAt = at(0.5);
      await engageKillSwitch(pool(), "RECORDER_STALE", manuallyEngagedAt, {
        logSink: silentSink,
      });
      const recovery = createKillSwitchRecoveryState(manuallyEngagedAt);
      const ledger = await engagements();
      expect(ledger.at(-1)).toMatchObject({
        event_type: "kill_switch_engaged",
        payload_json: { reason: "RECORDER_STALE", mode: "manual" },
      });
      await observeThrough(16, recovery);
      expect(await switchState()).toMatchObject({
        engaged: true,
        reason: "RECORDER_STALE",
        engaged_at: manuallyEngagedAt,
      });
      expect(await engagements()).toEqual(ledger);
    });
  },
);
