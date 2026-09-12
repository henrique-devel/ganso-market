// DB-03: only a disposable PostgreSQL, never production.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  loadFeedSamples,
  type QueryPool,
} from "../../../src/polymarket/fundamental/features.js";

const DATABASE_URL = process.env["GANSO_TEST_DATABASE_URL"];
const root = new URL("../../../../../", import.meta.url);
const NOW = new Date("2026-09-12T03:00:00Z");
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const INDEX = "polymarket_rtds_prices_asof_idx";

describe.skipIf(DATABASE_URL === undefined).each([false, true])(
  "DB-03 RTDS as-of PostgreSQL (candidate index: %s)",
  (indexed) => {
    let client: pg.Client;
    let schema: string | undefined;
    let candidateSql: string;
    let baselineSql: string;

    beforeAll(async () => {
      client = new pg.Client({
        connectionString: DATABASE_URL,
        options: "-c statement_timeout=5000 -c lock_timeout=500",
      });
      await client.connect();
      schema = `db03_test_${randomUUID().replaceAll("-", "")}`;
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      const migration = await readFile(
        new URL("migrations/0005_polymarket_data_foundation.sql", root),
        "utf8",
      );
      const start = migration.indexOf(
        "CREATE TABLE IF NOT EXISTS polymarket_rtds_prices (",
      );
      const end = migration.indexOf(
        "CREATE TABLE IF NOT EXISTS polymarket_rtds_1m (",
        start,
      );
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      await client.query(migration.slice(start, end));
      candidateSql = await readFile(
        new URL("docs/ops/sql/db03-rtds-asof-query.sql", root),
        "utf8",
      );
      // Freeze the old selection independently of any future runtime rewrite.
      baselineSql = `SELECT DISTINCT ON (symbol, feed)
          symbol, feed, price, source_ts, received_at
        FROM polymarket_rtds_prices
        WHERE symbol = ANY($1::text[]) AND feed = ANY($2::text[])
          AND COALESCE(source_ts, received_at) <= $3 AND received_at <= $3
        ORDER BY symbol, feed, COALESCE(source_ts, received_at) DESC,
          rtds_price_id DESC`;
      if (indexed) {
        await client.query(
          await readFile(
            new URL("docs/ops/sql/db03-rtds-asof-index.sql", root),
            "utf8",
          ),
        );
      }
    });

    beforeEach(async () => {
      await client.query("TRUNCATE polymarket_rtds_prices RESTART IDENTITY");
    });

    afterAll(async () => {
      if (schema !== undefined) {
        await client.query("SET search_path TO public");
        await client.query(`DROP SCHEMA ${schema} CASCADE`);
      }
      await client?.end();
    });

    async function add(
      symbol: string,
      feed: string,
      price: string,
      source: number | null,
      received: number,
    ) {
      await client.query(
        `INSERT INTO polymarket_rtds_prices
          (symbol,feed,price,source_ts,received_at) VALUES ($1,$2,$3,$4,$5)`,
        [
          symbol,
          feed,
          price,
          source === null ? null : at(source),
          at(received),
        ],
      );
    }

    // Exercise the real feature selection using the old and proposed SQL. Also
    // compare the unmodified runtime path, so promotion cannot diverge silently.
    function pool(sql?: string): QueryPool {
      return {
        async query<R extends Record<string, unknown>>(
          text: string,
          params: readonly unknown[] = [],
        ) {
          const result = await client.query<R>(sql ?? text, [...params]);
          return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        },
      };
    }

    async function compare(
      symbols: readonly string[],
      decision = NOW,
      feeds: readonly string[] = ["twap30", "twap60"],
    ) {
      const params = [[...symbols], [...feeds], decision];
      const previous = await client.query(baselineSql, params);
      const candidate = await client.query(candidateSql, params);
      expect(candidate.rows).toEqual(previous.rows);
      for (const row of candidate.rows) {
        expect(
          (row.source_ts ?? row.received_at).getTime(),
        ).toBeLessThanOrEqual(decision.getTime());
        expect(row.received_at.getTime()).toBeLessThanOrEqual(
          decision.getTime(),
        );
      }
      const before = await loadFeedSamples(
        pool(baselineSql),
        symbols,
        decision,
        120_000,
        feeds,
      );
      const after = await loadFeedSamples(
        pool(candidateSql),
        symbols,
        decision,
        120_000,
        feeds,
      );
      expect(after).toEqual(before);
      expect(
        await loadFeedSamples(pool(), symbols, decision, 120_000, feeds),
      ).toEqual(before);
      return after;
    }

    it("preserves NULL fallback, both future barriers, id ties and inclusive boundaries", async () => {
      await add("btc/usd", "twap30", "100", -300, -299);
      await add("btc/usd", "twap30", "101", -10, -9);
      await add("btc/usd", "twap30", "102", -10, -8); // higher id wins
      await add("btc/usd", "twap30", "900", 1, -1); // source future
      await add("btc/usd", "twap30", "901", -1, 1); // received future
      await add("btc/usd", "twap30", "902", null, 2); // NULL received future
      await add("eth/usd", "twap30", "201", null, -2);
      await add("eth/usd", "twap30", "202", 0, 0);
      for (const cutoff of [-400, -300, -299, -10, -9, -8, -2, 0, 1, 2]) {
        await compare(["btc/usd", "eth/usd", "missing"], at(cutoff));
      }
      const samples = await compare(["btc/usd", "eth/usd"]);
      expect(samples.get("btc/usd")?.price).toBe(102);
      expect(samples.get("eth/usd")?.price).toBe(202);
      expect(
        (await compare(["eth/usd"], at(-2))).get("eth/usd")?.sourceTs,
      ).toEqual(at(-2));
    });

    it("orders by effective source and then id even when receive order disagrees", async () => {
      await add("btc/usd", "twap30", "100", -10, -1);
      await add("btc/usd", "twap30", "101", -5, -4);
      expect((await compare(["btc/usd"])).get("btc/usd")?.price).toBe(101);
      await add("btc/usd", "twap30", "102", -5, -5);
      expect((await compare(["btc/usd"])).get("btc/usd")?.price).toBe(102);
    });

    it("retains a stale preferred feed instead of manufacturing freshness", async () => {
      await add("btc/usd", "twap30", "100", -300, -1);
      await add("btc/usd", "twap60", "101", -1, -1);
      await add("btc/usd", "spot", "999", 0, 0);
      const sample = (await compare(["btc/usd"])).get("btc/usd");
      expect(sample).toMatchObject({
        feed: "twap30",
        price: 100,
        stale: true,
        ageMs: 300_000,
      });
      expect(
        (await compare(["btc/usd"], NOW, ["twap60", "twap30"])).get("btc/usd")
          ?.feed,
      ).toBe("twap60");
    });

    it("does not fall back to an older valid price in the same feed", async () => {
      await add("btc/usd", "twap30", "100", -2, -2);
      await add("btc/usd", "twap30", "invalid", -1, -1);
      await add("btc/usd", "twap60", "101", -2, -2);
      expect((await compare(["btc/usd"])).get("btc/usd")?.feed).toBe("twap60");
      expect(await compare(["btc/usd"], NOW, ["twap30"])).toEqual(new Map());
      for (const [i, price] of ["0", "-1", "NaN", "Infinity"].entries()) {
        await add(`bad-${i}`, "twap30", price, 0, 0);
      }
      expect(await compare(["bad-0", "bad-1", "bad-2", "bad-3"])).toEqual(
        new Map(),
      );
    });

    it("preserves empty/missing series and deduplicates repeated input pairs", async () => {
      await add("btc/usd", "twap30", "100", -1, -1);
      await compare(["btc/usd", "btc/usd", "missing"], NOW, [
        "twap30",
        "twap30",
        "twap60",
      ]);
      expect(await compare([])).toEqual(new Map());
      expect(await compare(["missing"])).toEqual(new Map());
      expect(await compare(["btc/usd"], NOW, [])).toEqual(new Map());
      expect(await compare(["btc/usd"], NOW, ["not-a-feed"])).toEqual(
        new Map(),
      );
    });

    it("skips a long run of late arrivals without leaking or imposing a TTL", async () => {
      await add("btc/usd", "twap30", "100", -10_000, -10_000);
      await client.query(
        `INSERT INTO polymarket_rtds_prices
        (symbol,feed,price,source_ts,received_at)
        SELECT 'btc/usd','twap30','999',$1::timestamptz,$2::timestamptz
        FROM generate_series(1,2000)`,
        [at(-1), at(1)],
      );
      expect((await compare(["btc/usd"])).get("btc/usd")).toMatchObject({
        price: 100,
        stale: true,
      });
      expect((await compare(["btc/usd"], at(1))).get("btc/usd")?.price).toBe(
        999,
      );
    });

    it.skipIf(!indexed)(
      "builds and drops only the exact concurrent candidate without changing results",
      async () => {
        await add("btc/usd", "twap30", "100", null, -1);
        const catalog = await client.query(
          `SELECT indisvalid,indisready,indislive,
        indisunique,pg_get_indexdef(indexrelid) AS definition FROM pg_index
        WHERE indexrelid=to_regclass($1)`,
          [INDEX],
        );
        expect(catalog.rows[0]).toMatchObject({
          indisvalid: true,
          indisready: true,
          indislive: true,
          indisunique: false,
        });
        expect(catalog.rows[0]?.definition).toContain(
          "COALESCE(source_ts, received_at) DESC, rtds_price_id DESC",
        );
        const before = await compare(["btc/usd"]);
        await client.query(`DROP INDEX CONCURRENTLY ${INDEX}`);
        expect(await compare(["btc/usd"])).toEqual(before);
        expect(
          (
            await client.query(
              "SELECT count(*)::integer AS n FROM polymarket_rtds_prices",
            )
          ).rows[0]?.n,
        ).toBe(1);
      },
    );
  },
);
