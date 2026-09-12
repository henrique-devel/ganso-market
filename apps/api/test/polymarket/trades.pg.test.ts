// DB-02: use only a disposable PostgreSQL via GANSO_TEST_DATABASE_URL.
// Each case owns a schema and exercises the unchanged production backfill.
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

import type { QueryResult, SqlExecutor } from "../../src/database.js";
import { createTradesBackfill } from "../../src/polymarket/trades.js";

const DATABASE_URL = process.env["GANSO_TEST_DATABASE_URL"];
const NOW = Date.parse("2026-09-12T03:00:00Z");
const INDEX = "polymarket_trades_data_api_condition_ts_idx";
const root = new URL("../../../../", import.meta.url);

describe.skipIf(DATABASE_URL === undefined).each([false, true])(
  "DB-02 backfill PostgreSQL (candidate index: %s)",
  (indexed) => {
    let client: pg.Client;
    let schema: string | undefined;
    let ddl: string;
    let indexSql: string;
    let urls: URL[];
    let recorded: unknown[];

    beforeAll(async () => {
      client = new pg.Client({
        connectionString: DATABASE_URL,
        options: "-c statement_timeout=5000 -c lock_timeout=500",
      });
      await client.connect();
      const migration = await readFile(
        new URL("migrations/0005_polymarket_data_foundation.sql", root),
        "utf8",
      );
      const start = migration.indexOf(
        "CREATE TABLE IF NOT EXISTS polymarket_trades",
      );
      const end = migration.indexOf("-- 1-minute aggregates", start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      ddl = migration.slice(start, end);
      indexSql = await readFile(
        new URL("docs/ops/sql/db02-trades-last-recorded-index.sql", root),
        "utf8",
      );
    });

    beforeEach(async () => {
      schema = `db02_test_${randomUUID().replaceAll("-", "")}`;
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      await client.query(ddl);
      // The exact concurrent operation is deliberately outside BEGIN/COMMIT.
      if (indexed) await client.query(indexSql);
      urls = [];
      recorded = [];
    });

    afterEach(async () => {
      if (schema !== undefined) {
        await client.query("SET search_path TO public");
        await client.query(`DROP SCHEMA ${schema} CASCADE`);
        schema = undefined;
      }
    });

    afterAll(async () => {
      await client?.end();
    });

    const executor = (): SqlExecutor => ({
      async query<R extends Record<string, unknown>>(
        text: string,
        params: readonly unknown[] = [],
      ): Promise<QueryResult<R>> {
        const result = await client.query<R>(text, [...params]);
        if (text.includes("max(trade_ts)")) {
          recorded.push(result.rows[0]?.["max_ts"]);
        }
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      },
    });

    const poll = async (response: unknown[] = []) => {
      const backfill = createTradesBackfill({
        pool: executor(),
        clock: () => NOW,
        initialLookbackMs: 10 * 60_000,
        fetcher: (url) => {
          urls.push(new URL(url));
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(response),
          });
        },
      });
      await backfill.pollOnce(["target"]);
    };

    const firstStart = () => Number(urls[0]?.searchParams.get("startTs"));

    it("uses the initial lookback for an empty market", async () => {
      await poll();
      expect(recorded).toEqual([null]);
      expect(urls).toHaveLength(1);
      expect(firstStart()).toBe((NOW - 601_000) / 1_000);
      expect(urls[0]?.searchParams.get("market")).toBe("target");
    });

    it("ignores NULL trade_ts even when received_at is newer", async () => {
      await client.query(`INSERT INTO polymarket_trades
        (token_id, condition_id, price, provenance, trade_ts, received_at)
        VALUES ('yes','target','0.51','data_api',NULL,'2099-01-01')`);
      await poll();
      expect(recorded).toEqual([null]);
      expect(firstStart()).toBe((NOW - 601_000) / 1_000);
    });

    it("keeps market/source filters, tied tokens and the one-second overlap", async () => {
      await client.query(`INSERT INTO polymarket_trades
        (token_id, condition_id, price, provenance, trade_ts, received_at)
        VALUES ('yes','target','0.51','data_api','2026-09-12 02:58Z','2026-09-12 02:59Z'),
               ('no','target','0.49','data_api','2026-09-12 02:58Z','2099-01-01'),
               ('yes','target','0.52','data_api',NULL,'2099-01-01'),
               ('yes','target','0.53','ws','2026-09-12 02:59Z','2026-09-12 02:59Z'),
               ('yes','other','0.54','data_api','2099-01-01','2099-01-01'),
               ('yes',NULL,'0.55','data_api','2099-01-01','2099-01-01')`);
      await poll();
      expect(recorded).toEqual([new Date(NOW - 120_000)]);
      expect(urls).toHaveLength(1);
      expect(firstStart()).toBe((NOW - 121_000) / 1_000);
      expect(urls[0]?.searchParams.get("endTs")).toBe(String(NOW / 1_000));
    });

    it("preserves a future data_api cursor instead of substituting now", async () => {
      await client.query(`INSERT INTO polymarket_trades
        (token_id, condition_id, price, provenance, trade_ts)
        VALUES ('yes','target','0.51','data_api','2026-09-12 03:01Z')`);
      await poll();
      expect(recorded).toEqual([new Date(NOW + 60_000)]);
      expect(urls).toEqual([]);
    });

    it("preserves exact trade identity and deduplication across restarts", async () => {
      const trade = {
        id: "external-one",
        asset: "yes",
        conditionId: "target",
        price: "0.510000",
        size: "1.230000",
        side: "BUY",
        transactionHash: "0xfixture",
        timestamp: (NOW - 60_000) / 1_000,
      };
      await poll([trade, trade]);
      const before = await client.query("SELECT * FROM polymarket_trades");
      await poll([trade]);
      const after = await client.query("SELECT * FROM polymarket_trades");
      expect(after.rows).toEqual(before.rows);
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0]).toMatchObject({
        token_id: "yes",
        condition_id: "target",
        price: "0.510000",
        size: "1.230000",
        side: "BUY",
        transaction_hash: "0xfixture",
        provenance: "data_api",
        external_id: "external-one",
        trade_ts: new Date(NOW - 60_000),
        received_at: new Date(NOW),
      });
    });

    it("validates the concurrent index and rolls it back without changing rows", async () => {
      if (!indexed) await client.query(indexSql);
      const state =
        await client.query(`SELECT indisvalid, indisready, indisunique
        FROM pg_index WHERE indexrelid = '${INDEX}'::regclass`);
      expect(state.rows).toEqual([
        { indisvalid: true, indisready: true, indisunique: false },
      ]);
      await expect(client.query(indexSql)).rejects.toMatchObject({
        code: "42P07",
      });
      await client.query(`INSERT INTO polymarket_trades
        (token_id, condition_id, price, provenance, trade_ts)
        VALUES ('yes','target','0.51','data_api','2026-09-12 02:58Z')`);
      const before = await client.query("SELECT * FROM polymarket_trades");
      await poll();
      await client.query(`DROP INDEX CONCURRENTLY ${INDEX}`);
      await poll();
      expect(recorded).toEqual([
        new Date(NOW - 120_000),
        new Date(NOW - 120_000),
      ]);
      expect(
        (await client.query("SELECT * FROM polymarket_trades")).rows,
      ).toEqual(before.rows);
    });
  },
);
