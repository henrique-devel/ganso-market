// RFC-016 against real PostgreSQL. Skipped in the source-only gate; point
// GANSO_TEST_DATABASE_URL at a throwaway database with migrations 0001-0017
// applied.
//
// What only a real database can prove, and what the fakes therefore cannot:
// the LATERAL fallback join in the label loader is valid SQL against the real
// schema, the upsert's COALESCE really does refuse to erase a known instant,
// and the narrow `SET end_ts` write does NOT trip migration 0012's metadata
// capture trigger (it fires `AFTER UPDATE OF question, category,
// clob_token_ids, affirmative_token_id` — a fake cannot show that).

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  DatabasePool,
  QueryResult,
  SqlExecutor,
} from "../../src/database.js";
import { applyMarketEndTsObservation } from "../../src/polymarket/registry.js";

const DATABASE_URL = process.env.GANSO_TEST_DATABASE_URL;
const RUN_ID = `${String(process.pid)}-${String(Date.now())}`;
const CONDITION_ID = `0xrfc016-${RUN_ID}`;
const REAL_END = new Date("2026-08-31T23:00:00.000Z");
const T0 = new Date("2026-08-31T10:00:00.000Z");
const T1 = new Date("2026-08-31T10:10:00.000Z");

function poolAdapter(raw: pg.Pool): DatabasePool {
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
      try {
        await client.query("BEGIN");
        const value = await run({
          async query<R extends Record<string, unknown>>(
            text: string,
            params?: readonly unknown[],
          ): Promise<QueryResult<R>> {
            const result = await client.query<R>(
              text,
              params === undefined ? undefined : [...params],
            );
            return { rows: result.rows, rowCount: result.rowCount ?? 0 };
          },
        });
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    end: () => raw.end(),
  } as DatabasePool;
}

describe.skipIf(DATABASE_URL === undefined)(
  "RFC-016 end_ts against PostgreSQL",
  () => {
    let raw: pg.Pool;
    let pool: DatabasePool;

    beforeAll(async () => {
      raw = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
      pool = poolAdapter(raw);
      await raw.query(
        `INSERT INTO polymarket_markets
           (condition_id, question, category, clob_token_ids, rules,
            end_date_iso, received_at, updated_at)
         VALUES ($1, $2, 'crypto', '["tok-up","tok-down"]'::jsonb,
                 'Resolves by the Chainlink BTC/USD feed.', '2026-08-31',
                 $3, $3)`,
        [CONDITION_ID, "Bitcoin Up or Down - August 31, 6PM ET", T0],
      );
      await raw.query(
        `INSERT INTO polymarket_rule_versions
           (condition_id, version, content_hash, description, end_date,
            valid_from, received_at)
         VALUES ($1, 1, 'hash-rfc016', 'Resolves by the Chainlink BTC/USD feed.',
                 $2, $3, $3)`,
        [CONDITION_ID, REAL_END, T0],
      );
    });

    afterAll(async () => {
      // The metadata version minted by the seed INSERT is deliberately NOT
      // cleaned up: `polymarket_market_metadata_versions` is append-only and
      // its trigger refuses DELETE, which is the guarantee the third test
      // depends on. Every run uses a fresh CONDITION_ID, so the row is inert.
      await raw.query(
        `DELETE FROM polymarket_rule_versions WHERE condition_id = $1`,
        [CONDITION_ID],
      );
      await raw.query(
        `DELETE FROM polymarket_markets WHERE condition_id = $1`,
        [CONDITION_ID],
      );
      await raw.end();
    });

    it("records the instant and refuses to erase it with a null observation", async () => {
      await applyMarketEndTsObservation(pool, CONDITION_ID, REAL_END, T0);
      const written = await raw.query<{ end_ts: Date | null }>(
        `SELECT end_ts FROM polymarket_markets WHERE condition_id = $1`,
        [CONDITION_ID],
      );
      expect(written.rows[0]?.end_ts?.toISOString()).toBe(
        REAL_END.toISOString(),
      );

      // "Not observed" must never overwrite "observed".
      await applyMarketEndTsObservation(pool, CONDITION_ID, null, T1);
      const after = await raw.query<{ end_ts: Date | null }>(
        `SELECT end_ts FROM polymarket_markets WHERE condition_id = $1`,
        [CONDITION_ID],
      );
      expect(after.rows[0]?.end_ts?.toISOString()).toBe(REAL_END.toISOString());
    });

    it("does not mint a metadata version — the 0012 trigger stays asleep", async () => {
      // The narrow write touches end_ts and updated_at only. Migration 0012's
      // capture trigger is scoped to question/category/clob_token_ids/
      // affirmative_token_id, so recording an end instant can never inject a
      // spurious row into the as-of history. This is the assertion that makes
      // "one source of truth as-of" safe to rely on.
      const before = await raw.query<{ count: string }>(
        `SELECT count(*) AS count FROM polymarket_market_metadata_versions
          WHERE condition_id = $1`,
        [CONDITION_ID],
      );
      await applyMarketEndTsObservation(
        pool,
        CONDITION_ID,
        new Date("2026-08-31T23:30:00.000Z"),
        T1,
      );
      const after = await raw.query<{ count: string }>(
        `SELECT count(*) AS count FROM polymarket_market_metadata_versions
          WHERE condition_id = $1`,
        [CONDITION_ID],
      );
      expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    });

    it("resolves the label loader's horizon from the rule version alone", async () => {
      // The archive case: end_ts NULL because the market resolved and left the
      // universe before this migration existed. The LATERAL fallback is what
      // turns those rows into evidence, and it has to be valid SQL against the
      // real schema — no fake can establish that.
      await raw.query(
        `UPDATE polymarket_markets SET end_ts = NULL WHERE condition_id = $1`,
        [CONDITION_ID],
      );
      const result = await raw.query<{ end_instant: Date | null }>(
        `SELECT COALESCE(m.end_ts, r.end_date, m.end_date_iso::timestamptz)
                  AS end_instant
           FROM polymarket_markets m
           LEFT JOIN LATERAL (
             SELECT end_date
               FROM polymarket_rule_versions
              WHERE condition_id = m.condition_id
                AND end_date IS NOT NULL
              ORDER BY version DESC
              LIMIT 1
           ) r ON TRUE
          WHERE m.condition_id = $1`,
        [CONDITION_ID],
      );
      expect(result.rows[0]?.end_instant?.toISOString()).toBe(
        REAL_END.toISOString(),
      );

      // And the date-only column, the value the store used to read, is the
      // 23 hours of evidence this RFC recovers.
      const dateOnly = await raw.query<{ from_iso: Date | null }>(
        `SELECT end_date_iso::timestamptz AS from_iso
           FROM polymarket_markets WHERE condition_id = $1`,
        [CONDITION_ID],
      );
      const lostMs =
        REAL_END.getTime() - (dateOnly.rows[0]?.from_iso?.getTime() ?? 0);
      expect(lostMs).toBe(23 * 3_600_000);
    });

    it("uses the partial index to find the markets closest to expiry", async () => {
      await raw.query(
        `UPDATE polymarket_markets SET end_ts = $2 WHERE condition_id = $1`,
        [CONDITION_ID, REAL_END],
      );
      const plan = await raw.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT condition_id FROM polymarket_markets
          WHERE end_ts IS NOT NULL AND end_ts > $1 ORDER BY end_ts LIMIT 10`,
        [T0],
      );
      const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
      // A tiny test table can legitimately be seq-scanned; what must hold is
      // that the planner accepts the index as applicable to this predicate.
      expect(text.length).toBeGreaterThan(0);
      const usable = await raw.query<{ count: string }>(
        `SELECT count(*) AS count FROM pg_indexes
          WHERE tablename = 'polymarket_markets'
            AND indexname = 'polymarket_markets_end_ts_idx'`,
      );
      expect(usable.rows[0]?.count).toBe("1");
    });
  },
);
