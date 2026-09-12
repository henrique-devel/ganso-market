// OPS-07 / RFC-021 D4. Each case owns a schema in a disposable PostgreSQL DB.
// GANSO_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:<port>/ops07_test
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
  vi,
} from "vitest";

import type { QueryResult, SqlExecutor } from "../../src/database.js";
import { loadUniverse } from "../../src/polymarket/fundamental/estimator.js";
import { syncLabels } from "../../src/polymarket/fundamental/labels.js";
import {
  createUmaStatusPoller,
  pendingResolutionIds,
} from "../../src/polymarket/samplers.js";

const DATABASE_URL = process.env["GANSO_TEST_DATABASE_URL"];
const BASE = new Date("2026-09-11T12:00:00.000Z");
const OBSERVED = new Date("2026-09-11T12:10:00.000Z");
const CLOSED = "0xclosed";
const OTHER = "0xother";
let admin: pg.Pool;
let raw: pg.Pool;
let schema: string;
let migrations: string[];
let logged: string[];
let now: Date;
let responseRows: Record<string, unknown>[];
let openRows: Record<string, unknown>[];

function executor(): SqlExecutor {
  return {
    async query<R extends Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      const result = await raw.query<R>(text, [...params]);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
  };
}

function poller() {
  return createUmaStatusPoller({
    pool: executor(),
    clock: () => now.getTime(),
    // Status-only payloads exercise D4 independently of the pre-existing
    // metadata backfill; production metadata history triggers stay enabled.
    fetcher: (url) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url.includes("&closed=true") ? responseRows : openRows,
          ),
      }),
  });
}

async function seedMarket(
  conditionId = CLOSED,
  closed: boolean | null = false,
): Promise<void> {
  await raw.query(
    `INSERT INTO polymarket_markets
       (condition_id, question, slug, category, neg_risk, clob_token_ids,
        affirmative_token_id, rules, rules_version, tick_size, min_order_size,
        rewards_min_size, rewards_max_spread, fee_type, end_date_iso,
        active, closed, source_ts, received_at, updated_at)
     VALUES ($1,'Original question','original-slug','crypto',TRUE,'["yes","no"]',
             'yes','Original rules',2,'0.01','5','20','0.03','original-fee',
             '2026-09-11T11:00:00Z',TRUE,$2,$3,$3,$3)`,
    [conditionId, closed, BASE],
  );
  await raw.query(
    `INSERT INTO polymarket_universe_log (condition_id, action, reason, at)
     VALUES ($1,'enter','eligible',$2),($1,'exit','expired',$3)`,
    [conditionId, BASE, new Date(BASE.getTime() + 60_000)],
  );
}

async function market(conditionId = CLOSED) {
  return (
    await raw.query("SELECT * FROM polymarket_markets WHERE condition_id=$1", [
      conditionId,
    ])
  ).rows[0] as Record<string, unknown> | undefined;
}

async function events(conditionId = CLOSED) {
  return (
    await raw.query(
      `SELECT * FROM polymarket_resolution_events
        WHERE condition_id=$1 ORDER BY resolution_event_id`,
      [conditionId],
    )
  ).rows;
}

async function changes() {
  return (
    await raw.query("SELECT * FROM closed_update_audit ORDER BY audit_id")
  ).rows;
}

async function history() {
  return Promise.all(
    [
      "polymarket_market_metadata_versions",
      "polymarket_rule_versions",
      "polymarket_param_versions",
    ].map(
      async (table) =>
        (await raw.query(`SELECT * FROM ${table} ORDER BY version`)).rows,
    ),
  );
}

describe.skipIf(DATABASE_URL === undefined)(
  "OPS-07 observed closure — PostgreSQL",
  () => {
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
      const readMigration = async (name: string) =>
        (
          await readFile(
            new URL(`../../../../migrations/${name}`, import.meta.url),
            "utf8",
          )
        ).split("INSERT INTO schema_versions")[0] ?? "";
      const journal = await readMigration("0011_resolution_runtime_safety.sql");
      // 0012 requires the real input journal from 0011. The surrounding score
      // and broker DDL is unrelated; execute this prerequisite section verbatim.
      const journalStart = journal.indexOf(
        "CREATE TABLE IF NOT EXISTS polymarket_resolution_input_changes",
      );
      const journalEnd = journal.indexOf("-- One durable lease");
      expect(journalStart).toBeGreaterThan(0);
      expect(journalEnd).toBeGreaterThan(journalStart);
      migrations = [
        await readMigration("0004_polymarket.sql"),
        await readMigration("0005_polymarket_data_foundation.sql"),
        journal.slice(journalStart, journalEnd),
        await readMigration("0012_polymarket_market_metadata_history.sql"),
      ];
    });

    beforeEach(async () => {
      schema = `ops07_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`CREATE SCHEMA ${schema}`);
      raw = new pg.Pool({
        connectionString: DATABASE_URL,
        max: 2,
        options: `-c search_path=${schema} -c statement_timeout=5000`,
        application_name: schema,
      });
      for (const migration of migrations) await raw.query(migration);
      await raw.query(`
        CREATE TABLE closed_update_audit (
          audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          condition_id text NOT NULL, updated_at timestamptz NOT NULL
        );
        CREATE FUNCTION audit_closed_update() RETURNS trigger AS $$
        BEGIN
          INSERT INTO closed_update_audit (condition_id, updated_at)
          VALUES (NEW.condition_id, NEW.updated_at);
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER audit_closed_update_trg
          AFTER UPDATE OF closed ON polymarket_markets
          FOR EACH ROW EXECUTE FUNCTION audit_closed_update();
      `);
      logged = [];
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        logged.push(String(chunk));
        return true;
      });
      now = OBSERVED;
      responseRows = [{ conditionId: CLOSED, closed: true }];
      openRows = [];
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await raw?.end();
      if (schema !== undefined) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
    });

    afterAll(async () => {
      await admin?.end();
    });

    it("writes closure once across repeats/restart, preserves metadata/history, and leaves unresolved markets pending", async () => {
      await seedMarket();
      await seedMarket(OTHER);
      await raw.query(
        `INSERT INTO polymarket_rule_versions
           (condition_id, version, content_hash, description, valid_from, valid_to)
         VALUES ($1,1,'hash-one','Prior rules',$2,$3),
                ($1,2,'hash-two','Original rules',$3,NULL)`,
        [CLOSED, new Date(BASE.getTime() - 60_000), BASE],
      );
      await raw.query(
        `INSERT INTO polymarket_param_versions
           (condition_id, version, content_hash, tick_size, valid_from, valid_to)
         VALUES ($1,1,'param-one','0.001',$2,$3),
                ($1,2,'param-two','0.01',$3,NULL)`,
        [CLOSED, new Date(BASE.getTime() - 60_000), BASE],
      );
      const original = await market();
      const other = await market(OTHER);
      const originalHistory = await history();
      // Both belonged to the universe at BASE. The public consumer reads the
      // current closure flag even when membership is selected as of BASE.
      expect(
        (await loadUniverse(executor(), BASE)).map((m) => m.conditionId),
      ).toEqual([CLOSED, OTHER]);
      const sweep = poller();
      await sweep.pollPendingOnce();
      expect(await market()).toEqual({
        ...original,
        closed: true,
        updated_at: OBSERVED,
      });
      const firstEvents = await events();
      expect(firstEvents).toHaveLength(1);
      expect(firstEvents[0]).toMatchObject({
        event_type: "closed",
        payload_json: {
          raw: { resolved: false, outcomePrices: null, outcomes: null },
        },
      });
      now = new Date(OBSERVED.getTime() + 60_000);
      await sweep.pollPendingOnce();
      await poller().pollPendingOnce();
      responseRows = [
        { conditionId: CLOSED, closed: false },
        { conditionId: CLOSED },
      ];
      await sweep.pollPendingOnce();
      expect(await events()).toEqual(firstEvents);
      expect(await changes()).toHaveLength(1);
      expect(await market()).toEqual({
        ...original,
        closed: true,
        updated_at: OBSERVED,
      });
      expect(await market(OTHER)).toEqual(other);
      expect(await history()).toEqual(originalHistory);
      expect(await pendingResolutionIds(executor(), now)).toContain(CLOSED);
      expect(
        (await loadUniverse(executor(), BASE)).map((m) => m.conditionId),
      ).toEqual([OTHER]);
      expect(await syncLabels({ pool: executor(), clock: () => now })).toEqual({
        inserted: 0,
        updated: 0,
        skippedNotFinal: 0,
        skippedUnparsable: 0,
      });
      expect(logged.join("")).not.toContain("LABEL_SYNC_READ_FAILED");
    });

    it("accepts only literal true, changes NULL to true and never inserts a missing registry row", async () => {
      await seedMarket(CLOSED, null);
      await seedMarket(OTHER);
      const original = await market(OTHER);
      responseRows = [
        { condition_id: CLOSED, closed: true },
        { conditionId: OTHER, closed: false },
        { conditionId: OTHER },
        { conditionId: OTHER, closed: "true" },
        { conditionId: "0xmissing", closed: true },
      ];
      await poller().pollPendingOnce();
      expect((await market())?.["closed"]).toBe(true);
      expect(await market(OTHER)).toEqual(original);
      expect(await market("0xmissing")).toBeUndefined();
      expect((await changes()).map((row) => row["condition_id"])).toEqual([
        CLOSED,
      ]);
      expect(await events(OTHER)).toEqual([]);
      expect(
        (await raw.query("SELECT count(*)::int AS n FROM polymarket_markets"))
          .rows,
      ).toEqual([{ n: 2 }]);
    });

    it("repairs a legacy hydrated closed status without duplicating its event", async () => {
      await seedMarket();
      await raw.query(
        `INSERT INTO polymarket_resolution_events (condition_id, event_type, received_at)
         VALUES ($1,'closed',$2)`,
        [CLOSED, BASE],
      );
      const originalEvents = await events();
      await poller().pollPendingOnce();
      expect((await market())?.["closed"]).toBe(true);
      expect(await changes()).toHaveLength(1);
      expect(await events()).toEqual(originalEvents);
    });

    it("logs a real UPDATE failure, keeps the market pending and converges on retry before emitting resolution", async () => {
      await seedMarket();
      await seedMarket(OTHER);
      const original = await market();
      const originalHistory = await history();
      await raw.query(`
        CREATE FUNCTION reject_closure() RETURNS trigger AS $$
        BEGIN
          IF NEW.condition_id = '0xclosed' THEN
            RAISE EXCEPTION 'OPS07 injected UPDATE failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER reject_closure_trg BEFORE UPDATE OF closed ON polymarket_markets
          FOR EACH ROW EXECUTE FUNCTION reject_closure();
      `);
      responseRows = [
        {
          conditionId: CLOSED,
          closed: true,
          umaResolutionStatus: "resolved",
          outcomePrices: ["1", "0"],
        },
        { conditionId: OTHER, closed: true },
      ];
      // Conflicting snapshots of one id must not emit a terminal status from
      // the open response before the closed response's UPDATE succeeds.
      openRows = [
        { conditionId: CLOSED, closed: false, umaResolutionStatus: "resolved" },
      ];
      const sweep = poller();
      await sweep.pollPendingOnce();
      expect(await market()).toEqual(original);
      expect(await events()).toEqual([]);
      expect((await market(OTHER))?.["closed"]).toBe(true);
      expect(await pendingResolutionIds(executor(), now)).toContain(CLOSED);
      expect(logged.join("")).toContain(
        '"reason_code":"UMA_CLOSED_PERSIST_FAILED"',
      );
      expect(logged.join("")).toContain('"condition_id":"0xclosed"');
      expect(logged.join("")).toContain("OPS07 injected UPDATE failure");
      await raw.query("DROP TRIGGER reject_closure_trg ON polymarket_markets");
      await sweep.pollPendingOnce();
      await poller().pollPendingOnce();
      expect(await market()).toEqual({
        ...original,
        closed: true,
        updated_at: OBSERVED,
      });
      expect(await events()).toHaveLength(1);
      expect((await events())[0]).toMatchObject({ event_type: "resolved" });
      expect(await pendingResolutionIds(executor(), now)).not.toContain(CLOSED);
      expect(
        (await changes()).filter((row) => row["condition_id"] === CLOSED),
      ).toHaveLength(1);
      expect(await history()).toEqual(originalHistory);
    });

    it("retries an INSERT failure after closure is persisted without another UPDATE or terminal duplicate", async () => {
      await seedMarket();
      await raw.query(`
        CREATE FUNCTION reject_resolution() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'OPS07 injected INSERT failure'; END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER reject_resolution_trg BEFORE INSERT ON polymarket_resolution_events
          FOR EACH ROW EXECUTE FUNCTION reject_resolution();
      `);
      responseRows = [
        { conditionId: CLOSED, closed: true, umaResolutionStatus: "resolved" },
      ];
      const sweep = poller();
      await sweep.pollPendingOnce();
      const persisted = await market();
      expect(persisted?.["closed"]).toBe(true);
      expect(await events()).toEqual([]);
      expect(await pendingResolutionIds(executor(), now)).toContain(CLOSED);
      expect(logged.join("")).toContain(
        '"reason_code":"RESOLUTION_EVENT_PERSIST_FAILED"',
      );
      expect(logged.join("")).toContain("OPS07 injected INSERT failure");
      await raw.query(
        "DROP TRIGGER reject_resolution_trg ON polymarket_resolution_events",
      );
      now = new Date(OBSERVED.getTime() + 60_000);
      await sweep.pollPendingOnce();
      await poller().pollPendingOnce();
      expect(await market()).toEqual(persisted);
      expect(await changes()).toHaveLength(1);
      expect(await events()).toHaveLength(1);
      expect((await events())[0]).toMatchObject({
        event_type: "resolved",
        received_at: now,
      });
      expect(await pendingResolutionIds(executor(), now)).not.toContain(CLOSED);
    });
  },
);
