// End-to-end RFC-012 check against a REAL PostgreSQL with the real migrations
// (0001..0012) applied. Skipped unless GANSO_TEST_DATABASE_URL points at a
// throwaway database, so CI (no PostgreSQL in the source gate) stays green.
// It exercises what the unit fakes cannot prove: the 0010 constraints and
// immutability triggers, the as-of look-ahead guard against PLANTED FUTURE
// data, score reproducibility, the group coupling and the enforcement gate
// over real rows.
//
// Run it with:
//   GANSO_TEST_DATABASE_URL=postgres://... npx vitest run test/polymarket/resolution/integration.test.ts

import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  DatabasePool,
  QueryResult,
  SqlExecutor,
} from "../../../src/database.js";
import { DEFAULT_RESOLUTION_CONFIG } from "../../../src/polymarket/resolution/config.js";
import { resolutionGate } from "../../../src/polymarket/resolution/enforcement.js";
import { loadMarketRef } from "../../../src/polymarket/resolution/evaluate.js";
import { DEFAULT_RESOLUTION_LEXICON } from "../../../src/polymarket/resolution/lexicon.js";
import {
  composeForMarket,
  recomputeMarkets,
  type RecomputeDeps,
} from "../../../src/polymarket/resolution/recompute.js";
import {
  ensureScoreVersion,
  historicalMarketsAsOf,
  measuredCategoryStatsBatch,
} from "../../../src/polymarket/resolution/store.js";
import { applyMarketMetadataObservation } from "../../../src/polymarket/registry.js";

const DATABASE_URL = process.env.GANSO_TEST_DATABASE_URL;

const T0 = new Date("2026-08-20T10:00:00.000Z");
const AS_OF = new Date("2026-08-20T12:00:00.000Z");
const CLEAN_ID = "0xrfc012clean";
const SUBJ_ID = "0xrfc012subjective";
const GROUP_A = "0xrfc012groupa";
const GROUP_B = "0xrfc012groupb";
const TOKEN = (id: string, index: number): string => `${id}tok${index}`;

async function migrationSql(
  version: 11 | 12,
  fileName: string,
): Promise<string> {
  const sql = await readFile(
    new URL(`../../../../../migrations/${fileName}`, import.meta.url),
    "utf8",
  );
  const checksum = version === 11 ? "1".repeat(64) : "2".repeat(64);
  return sql
    .replaceAll(":'migration_version'::INTEGER", String(version))
    .replaceAll(":'migration_checksum'", `'${checksum}'`);
}

async function reapplyMigration(
  pool: pg.Pool,
  version: 11 | 12,
  fileName: string,
): Promise<void> {
  const sql = await migrationSql(version, fileName);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function poolAdapter(pool: pg.Pool): DatabasePool {
  const query = async <R extends Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>> => {
    const result = await pool.query<R>(
      text,
      params === undefined ? undefined : [...params],
    );
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  };
  return {
    query,
    async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return run({ query });
    },
    async end(): Promise<void> {
      await pool.end();
    },
  };
}

function clientAdapter(client: pg.PoolClient): SqlExecutor {
  return {
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
  };
}

async function seedMarket(
  pool: DatabasePool,
  conditionId: string,
  question: string,
  description: string,
  options: { negRisk?: boolean; resolutionSource?: string | null } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO polymarket_markets
       (condition_id, question, slug, category, neg_risk, clob_token_ids,
        affirmative_token_id, rules, tick_size, end_date_iso, active, closed,
        source_ts, received_at, updated_at)
     VALUES ($1,$2,$3,'crypto',$4,$5::jsonb,$6,$7,'0.01',$8,TRUE,FALSE,$9,$9,$9)`,
    [
      conditionId,
      question,
      conditionId,
      options.negRisk === true,
      JSON.stringify([TOKEN(conditionId, 0), TOKEN(conditionId, 1)]),
      TOKEN(conditionId, 0),
      description,
      "2026-08-25T00:00:00Z",
      T0,
    ],
  );
  await pool.query(
    `INSERT INTO polymarket_universe_log (condition_id, action, reason, at)
     VALUES ($1,'enter','priority_2_crypto',$2)`,
    [conditionId, T0],
  );
  await pool.query(
    `INSERT INTO polymarket_rule_versions
       (condition_id, version, content_hash, description, resolution_source,
        end_date, uma_end_date, uma_bond, custom_liveness, valid_from, received_at)
     VALUES ($1,1,'hash1',$2,$3,$4,$4,'750','7200',$5,$5)`,
    [
      conditionId,
      description,
      options.resolutionSource ?? "chainlink",
      new Date("2026-08-25T00:00:00Z"),
      T0,
    ],
  );
  await pool.query(
    `INSERT INTO polymarket_param_versions
       (condition_id, version, content_hash, taker_fee_bps, tick_size,
        min_order_size, neg_risk, valid_from, received_at)
     VALUES ($1,1,'phash','700','0.01','5',$2,$3,$3)`,
    [conditionId, options.negRisk === true, T0],
  );
  await pool.query(
    `INSERT INTO polymarket_book_snapshots
       (token_id, condition_id, bids_json, asks_json, source_ts, received_at)
     VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$5)`,
    [
      TOKEN(conditionId, 0),
      conditionId,
      JSON.stringify([{ price: "0.48", size: "100" }]),
      JSON.stringify([{ price: "0.52", size: "100" }]),
      new Date(AS_OF.getTime() - 10_000),
    ],
  );
  await pool.query(
    `INSERT INTO polymarket_oi_holders
       (condition_id, token_id, holders_count, top1_share, top5_share, received_at)
     VALUES ($1,$2,20,'0.100000','0.300000',$3)`,
    [conditionId, TOKEN(conditionId, 0), T0],
  );
}

describe.skipIf(DATABASE_URL === undefined)(
  "RFC-012 against PostgreSQL",
  () => {
    let raw: pg.Pool;
    let pool: DatabasePool;
    let deps: RecomputeDeps;

    beforeAll(async () => {
      raw = new pg.Pool({ connectionString: DATABASE_URL });
      pool = poolAdapter(raw);
      // TRUNCATE, not DELETE: several 0010 tables carry append-only triggers,
      // which is exactly what production wants and a throwaway DB works around.
      await pool.query(`TRUNCATE resolution_scores, resolution_score_versions,
        resolution_market_state, resolution_clarifications,
        resolution_uma_timeline, resolution_onchain_events,
        resolution_onchain_cursor, resolution_adjudication_samples,
        graph_violations, graph_sanity_vetoes, graph_edges,
        resolution_layer_divergences, resolution_reports CASCADE`);
      await pool.query(`TRUNCATE polymarket_resolution_input_changes,
        resolution_runtime_state, polymarket_markets,
        polymarket_market_metadata_versions, polymarket_universe_log,
        polymarket_book_snapshots, polymarket_rule_versions,
        polymarket_param_versions, polymarket_resolution_events,
        polymarket_oi_holders, polymarket_events, polymarket_event_markets,
        polymarket_series_1m CASCADE`);

      await seedMarket(
        pool,
        CLEAN_ID,
        "Will the price of Bitcoin be above $68,000 on August 25?",
        "Resolves YES if the price of Bitcoin is above $68,000 on August 25 per the Chainlink TWAP price feed.",
      );
      await seedMarket(
        pool,
        SUBJ_ID,
        "Will the agreement be signed?",
        "Resolves YES per the consensus of credible reporting that the agreement was signed by both parties before the deadline.",
        { resolutionSource: null },
      );
      await seedMarket(
        pool,
        GROUP_A,
        "Will candidate Alpha win the nomination race in 2026?",
        "Resolves YES if Alpha wins per the official announcement published by the organizing committee.",
        { negRisk: true },
      );
      await seedMarket(
        pool,
        GROUP_B,
        "Will candidate Beta win the nomination race in 2026?",
        "Resolves YES if Beta wins per the official announcement published by the organizing committee.",
        { negRisk: true },
      );
      await pool.query(
        `INSERT INTO polymarket_events
           (event_id, slug, title, neg_risk, received_at)
         VALUES ('ev-rfc012','nomination','Nomination race', TRUE, $1)`,
        [T0],
      );
      for (const member of [GROUP_A, GROUP_B]) {
        await pool.query(
          `INSERT INTO polymarket_event_markets
             (event_id, condition_id, received_at)
           VALUES ('ev-rfc012', $1, $2)`,
          [member, T0],
        );
      }
      // GROUP_B is in an active UMA dispute at AS_OF.
      for (const [eventType, minutes] of [
        ["proposed", 60],
        ["disputed", 90],
      ] as const) {
        await pool.query(
          `INSERT INTO polymarket_resolution_events
           (condition_id, event_type, payload_json, received_at)
         VALUES ($1,$2,'{}'::jsonb,$3)`,
          [GROUP_B, eventType, new Date(T0.getTime() + minutes * 60_000)],
        );
      }

      deps = {
        pool,
        config: DEFAULT_RESOLUTION_CONFIG,
        lexicon: DEFAULT_RESOLUTION_LEXICON,
        scoreVersion: DEFAULT_RESOLUTION_CONFIG.scoreVersion,
      };
      await ensureScoreVersion(pool, {
        scoreVersion: deps.scoreVersion,
        configHash: "a".repeat(64),
        lexiconHash: "b".repeat(64),
        weights: {},
        thresholds: {},
        priors: {},
      });
    });

    afterAll(async () => {
      await pool.end();
    });

    it("keeps the database constraints as the last line of defence", async () => {
      await expect(
        pool.query(
          `INSERT INTO resolution_scores
           (condition_id, score_version, score, action, prior_kind, trigger, computed_at)
         VALUES ('0xbad','1.0.0','0.5','NONE','external','sweep',$1)`,
          [AS_OF],
        ),
      ).rejects.toThrow(/resolution_scores_score_check/);

      await expect(
        pool.query(
          `INSERT INTO graph_edges
           (edge_key, kind, from_condition_id, to_condition_id, origin, confidence)
         VALUES ('IMPLIES:x->y','IMPLIES','0xx','0xy','curated','1.000000')`,
        ),
      ).rejects.toThrow(/graph_edges_curated_needs_author/);
    });

    it("keeps membership sources append-only without blocking insert or truncate", async () => {
      await reapplyMigration(raw, 11, "0011_resolution_runtime_safety.sql");
      const suffix = Date.now().toString(36);
      const eventId = `ev-append-only-${suffix}`;
      const conditionId = `0xappendonly${suffix}`;
      await raw.query(
        `INSERT INTO polymarket_events (event_id, title, neg_risk)
         VALUES ($1, 'Append-only guard fixture', FALSE)`,
        [eventId],
      );
      await raw.query(
        `INSERT INTO polymarket_event_markets (event_id, condition_id)
         VALUES ($1, $2)`,
        [eventId, conditionId],
      );
      await raw.query(
        `INSERT INTO polymarket_universe_log (condition_id, action, reason, at)
         VALUES ($1, 'rejected_filter', 'append_only_guard_fixture', $2)`,
        [conditionId, AS_OF],
      );

      await expect(
        raw.query(
          `UPDATE polymarket_event_markets
              SET received_at = received_at
            WHERE event_id = $1 AND condition_id = $2`,
          [eventId, conditionId],
        ),
      ).rejects.toThrow(/polymarket_event_markets rows are append-only/);
      await expect(
        raw.query(
          `DELETE FROM polymarket_event_markets
            WHERE event_id = $1 AND condition_id = $2`,
          [eventId, conditionId],
        ),
      ).rejects.toThrow(/polymarket_event_markets rows are append-only/);
      await expect(
        raw.query(
          `UPDATE polymarket_universe_log
              SET reason = reason
            WHERE condition_id = $1 AND reason = 'append_only_guard_fixture'`,
          [conditionId],
        ),
      ).rejects.toThrow(/polymarket_universe_log rows are append-only/);
      await expect(
        raw.query(
          `DELETE FROM polymarket_universe_log
            WHERE condition_id = $1 AND reason = 'append_only_guard_fixture'`,
          [conditionId],
        ),
      ).rejects.toThrow(/polymarket_universe_log rows are append-only/);

      const client = await raw.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "TRUNCATE polymarket_event_markets, polymarket_universe_log",
        );
        await client.query("ROLLBACK");
      } catch (error: unknown) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });

    it("journals all six live resolution input sources with collision-free keys", async () => {
      const sources = await raw.query<Record<string, unknown>>(
        `SELECT DISTINCT source
           FROM polymarket_resolution_input_changes
          WHERE condition_id = ANY($1)
          ORDER BY source`,
        [[CLEAN_ID, SUBJ_ID, GROUP_A, GROUP_B]],
      );
      expect(sources.rows.map((row) => row.source)).toEqual([
        "event_membership",
        "market_metadata",
        "param_version",
        "resolution_event",
        "rule_version",
        "universe_membership",
      ]);

      const suffix = Date.now().toString(36);
      const pairs = [
        { eventId: `ev-${suffix}:a:b`, conditionId: "c" },
        { eventId: `ev-${suffix}:a`, conditionId: "b:c" },
      ];
      for (const pair of pairs) {
        await raw.query(
          `INSERT INTO polymarket_events (event_id, title, neg_risk)
           VALUES ($1, 'Composite-key collision fixture', FALSE)`,
          [pair.eventId],
        );
        await raw.query(
          `INSERT INTO polymarket_event_markets (event_id, condition_id)
           VALUES ($1, $2)`,
          [pair.eventId, pair.conditionId],
        );
      }
      const compositeKeys = await raw.query<Record<string, unknown>>(
        `SELECT source_key
           FROM polymarket_resolution_input_changes
          WHERE source = 'event_membership' AND condition_id = ANY($1)
          ORDER BY source_key`,
        [pairs.map((pair) => pair.conditionId)],
      );
      expect(compositeKeys.rows).toHaveLength(2);
      expect(
        new Set(compositeKeys.rows.map((row) => row.source_key)).size,
      ).toBe(2);
    });

    it("captures one metadata version and journal row from a legacy market update", async () => {
      const conditionId = `0xlegacymetadata${Date.now().toString(36)}`;
      const insertedAt = new Date("2026-08-21T08:00:00.000Z");
      const updatedAt = new Date("2026-08-21T08:01:00.000Z");
      await raw.query(
        `INSERT INTO polymarket_markets
           (condition_id, question, category, clob_token_ids,
            affirmative_token_id, received_at, updated_at)
         VALUES ($1, 'Legacy question', 'crypto', '["yes","no"]'::jsonb,
                 'yes', $2, $2)`,
        [conditionId, insertedAt],
      );

      await raw.query(
        `UPDATE polymarket_markets
            SET question = 'Legacy question updated', category = 'macro',
                clob_token_ids = '["up","down"]'::jsonb, updated_at = $2
          WHERE condition_id = $1`,
        [conditionId, updatedAt],
      );

      const versions = await raw.query<Record<string, unknown>>(
        `SELECT version, question, category, clob_token_ids, valid_from,
                valid_to, affirmative_token_id
           FROM polymarket_market_metadata_versions
          WHERE condition_id = $1
          ORDER BY version`,
        [conditionId],
      );
      expect(versions.rows).toEqual([
        expect.objectContaining({
          version: 1,
          question: "Legacy question",
          category: "crypto",
          clob_token_ids: ["yes", "no"],
          affirmative_token_id: "yes",
          valid_from: insertedAt,
          valid_to: updatedAt,
        }),
        expect.objectContaining({
          version: 2,
          question: "Legacy question updated",
          category: "macro",
          clob_token_ids: ["up", "down"],
          affirmative_token_id: null,
          valid_from: updatedAt,
          valid_to: null,
        }),
      ]);
      const journal = await raw.query<Record<string, unknown>>(
        `SELECT COUNT(*)::integer AS count
           FROM polymarket_resolution_input_changes
          WHERE source = 'market_metadata' AND condition_id = $1`,
        [conditionId],
      );
      expect(journal.rows[0]?.count).toBe(2);
      await expect(
        loadMarketRef(pool, conditionId, updatedAt),
      ).resolves.toBeNull();
      await expect(
        raw.query(
          `UPDATE polymarket_markets
              SET question = 'Stale legacy question', updated_at = $2
            WHERE condition_id = $1`,
          [conditionId, insertedAt],
        ),
      ).rejects.toThrow(/MARKET_METADATA_OBSERVATION_TIME_NOT_MONOTONIC/);
      const afterStale = await raw.query<Record<string, unknown>>(
        `SELECT COUNT(*)::integer AS count
           FROM polymarket_market_metadata_versions
          WHERE condition_id = $1`,
        [conditionId],
      );
      expect(afterStale.rows[0]?.count).toBe(2);
    });

    it("keeps the current writer idempotent after database capture", async () => {
      const conditionId = `0xcurrentmetadata${Date.now().toString(36)}`;
      const question = "Will the current writer remain idempotent?";
      const tokenIds = ["current-no", "current-yes"];
      const affirmativeTokenId = tokenIds[1] ?? null;

      const write = async (observedAt: Date): Promise<void> => {
        const client = await raw.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `INSERT INTO polymarket_markets
               (condition_id, question, category, clob_token_ids,
                affirmative_token_id, received_at, updated_at)
             VALUES ($1, $2, 'crypto', $3::jsonb, $4, $5, $5)
             ON CONFLICT (condition_id) DO UPDATE SET
               question = EXCLUDED.question,
               category = EXCLUDED.category,
               clob_token_ids = EXCLUDED.clob_token_ids,
               affirmative_token_id = EXCLUDED.affirmative_token_id,
               updated_at = EXCLUDED.updated_at`,
            [
              conditionId,
              question,
              JSON.stringify(tokenIds),
              affirmativeTokenId,
              observedAt,
            ],
          );
          await applyMarketMetadataObservation(
            clientAdapter(client),
            {
              conditionId,
              question,
              category: "crypto",
              clobTokenIds: tokenIds,
              affirmativeTokenId,
              sourceTs: null,
            },
            observedAt,
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      };

      await write(new Date("2026-08-21T09:00:00.000Z"));
      await write(new Date("2026-08-21T09:01:00.000Z"));

      const counts = await raw.query<Record<string, unknown>>(
        `SELECT
           (SELECT COUNT(*)::integer
              FROM polymarket_market_metadata_versions
             WHERE condition_id = $1) AS versions,
           (SELECT COUNT(*)::integer
              FROM polymarket_resolution_input_changes
             WHERE source = 'market_metadata' AND condition_id = $1) AS journal,
           (SELECT affirmative_token_id
              FROM polymarket_market_metadata_versions
             WHERE condition_id = $1 AND valid_to IS NULL) AS affirmative_token_id`,
        [conditionId],
      );
      expect(counts.rows[0]).toEqual({
        versions: 1,
        journal: 1,
        affirmative_token_id: "current-yes",
      });
      await expect(
        loadMarketRef(pool, conditionId, new Date("2026-08-21T09:01:00.000Z")),
      ).resolves.toEqual({ conditionId, tokenId: "current-yes" });
    });

    it("serializes legacy and current metadata writers without deadlock", async () => {
      const conditionId = `0xconcurrentmetadata${Date.now().toString(36)}`;
      const tokenIds = ["concurrent-yes", "concurrent-no"];
      const insertedAt = new Date("2026-08-21T10:00:00.000Z");
      const legacyAt = new Date("2026-08-21T10:01:00.000Z");
      const currentAt = new Date("2026-08-21T10:02:00.000Z");
      await raw.query(
        `INSERT INTO polymarket_markets
           (condition_id, question, category, clob_token_ids,
            affirmative_token_id, received_at, updated_at)
         VALUES ($1, 'Initial question', 'crypto', $2::jsonb, $3, $4, $4)`,
        [conditionId, JSON.stringify(tokenIds), tokenIds[0], insertedAt],
      );

      const legacy = await raw.connect();
      const current = await raw.connect();
      let legacyOpen = false;
      let currentOpen = false;
      try {
        await legacy.query("BEGIN");
        legacyOpen = true;
        await legacy.query(`SET LOCAL lock_timeout = '5s'`);
        await legacy.query(
          `UPDATE polymarket_markets
              SET question = 'Legacy concurrent question', updated_at = $2
            WHERE condition_id = $1`,
          [conditionId, legacyAt],
        );

        await current.query("BEGIN");
        currentOpen = true;
        await current.query(`SET LOCAL lock_timeout = '5s'`);
        let currentSettled = false;
        const currentUpsert = current
          .query(
            `INSERT INTO polymarket_markets
               (condition_id, question, category, clob_token_ids,
                affirmative_token_id, received_at, updated_at)
             VALUES ($1, 'Current concurrent question', 'crypto', $2::jsonb,
                     $3, $4, $4)
             ON CONFLICT (condition_id) DO UPDATE SET
               question = EXCLUDED.question,
               category = EXCLUDED.category,
               clob_token_ids = EXCLUDED.clob_token_ids,
               affirmative_token_id = EXCLUDED.affirmative_token_id,
               updated_at = EXCLUDED.updated_at`,
            [conditionId, JSON.stringify(tokenIds), tokenIds[0], currentAt],
          )
          .then(() => {
            currentSettled = true;
          });

        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(currentSettled).toBe(false);
        await legacy.query("COMMIT");
        legacyOpen = false;
        await currentUpsert;
        await applyMarketMetadataObservation(
          clientAdapter(current),
          {
            conditionId,
            question: "Current concurrent question",
            category: "crypto",
            clobTokenIds: tokenIds,
            affirmativeTokenId: tokenIds[0] ?? null,
            sourceTs: null,
          },
          currentAt,
        );
        await current.query("COMMIT");
        currentOpen = false;
      } finally {
        if (legacyOpen) {
          await legacy.query("ROLLBACK").catch(() => undefined);
        }
        if (currentOpen) {
          await current.query("ROLLBACK").catch(() => undefined);
        }
        legacy.release();
        current.release();
      }

      const counts = await raw.query<Record<string, unknown>>(
        `SELECT
           (SELECT COUNT(*)::integer
              FROM polymarket_market_metadata_versions
             WHERE condition_id = $1) AS versions,
           (SELECT COUNT(*)::integer
              FROM polymarket_resolution_input_changes
             WHERE source = 'market_metadata' AND condition_id = $1) AS journal`,
        [conditionId],
      );
      expect(counts.rows[0]).toEqual({ versions: 3, journal: 3 });
    });

    it("backfills every resolution input, upgrades the runtime cursor and reapplies migrations idempotently", async () => {
      const conditionId = `0xjournalupgrade${Date.now().toString(36)}`;
      const registryOnlyId = `${conditionId}registry`;
      const eventId = `ev-${conditionId}`;
      const observedAt = new Date("2026-08-20T09:00:00.000Z");
      const client = await raw.connect();
      let resolutionEventId = "";
      let ruleVersionId = "";
      let paramVersionId = "";
      let universeLogId = "";
      let metadataVersionId = "";
      let membershipKey = "";
      try {
        await client.query("BEGIN");
        await client.query(
          `ALTER TABLE polymarket_resolution_events
             DISABLE TRIGGER resolution_event_input_change_trg;
           ALTER TABLE polymarket_rule_versions
             DISABLE TRIGGER rule_version_input_change_trg;
           ALTER TABLE polymarket_param_versions
             DISABLE TRIGGER param_version_input_change_trg;
           ALTER TABLE polymarket_event_markets
             DISABLE TRIGGER event_membership_input_change_trg;
           ALTER TABLE polymarket_universe_log
             DISABLE TRIGGER universe_membership_input_change_trg;
           ALTER TABLE polymarket_market_metadata_versions
             DISABLE TRIGGER market_metadata_input_change_trg;`,
        );
        await client.query(
          `INSERT INTO polymarket_events
             (event_id, title, neg_risk, received_at)
           VALUES ($1, 'Journal upgrade fixture', FALSE, $2)`,
          [eventId, observedAt],
        );
        const resolutionEvent = await client.query<Record<string, unknown>>(
          `INSERT INTO polymarket_resolution_events
             (condition_id, event_type, payload_json, received_at)
           VALUES ($1, 'proposed', '{}'::jsonb, $2)
           RETURNING resolution_event_id`,
          [conditionId, observedAt],
        );
        resolutionEventId = String(
          resolutionEvent.rows[0]?.resolution_event_id,
        );
        const rule = await client.query<Record<string, unknown>>(
          `INSERT INTO polymarket_rule_versions
             (condition_id, version, content_hash, description, valid_from,
              received_at)
           VALUES ($1, 1, 'journal-rule', 'Journal rule fixture', $2, $2)
           RETURNING rule_version_id`,
          [conditionId, observedAt],
        );
        ruleVersionId = String(rule.rows[0]?.rule_version_id);
        const param = await client.query<Record<string, unknown>>(
          `INSERT INTO polymarket_param_versions
             (condition_id, version, content_hash, neg_risk, valid_from,
              received_at)
           VALUES ($1, 1, 'journal-param', FALSE, $2, $2)
           RETURNING param_version_id`,
          [conditionId, observedAt],
        );
        paramVersionId = String(param.rows[0]?.param_version_id);
        const membership = await client.query<Record<string, unknown>>(
          `INSERT INTO polymarket_event_markets
             (event_id, condition_id, received_at)
           VALUES ($1, $2, $3)
           RETURNING jsonb_build_array(event_id, condition_id)::text AS source_key`,
          [eventId, conditionId, observedAt],
        );
        membershipKey = String(membership.rows[0]?.source_key);
        const universe = await client.query<Record<string, unknown>>(
          `INSERT INTO polymarket_universe_log
             (condition_id, action, reason, at)
           VALUES ($1, 'rejected_filter', 'journal_upgrade_fixture', $2)
           RETURNING universe_log_id`,
          [conditionId, observedAt],
        );
        universeLogId = String(universe.rows[0]?.universe_log_id);
        const metadata = await client.query<Record<string, unknown>>(
          `INSERT INTO polymarket_market_metadata_versions
             (condition_id, version, question, category, clob_token_ids,
              valid_from, received_at)
           VALUES ($1, 1, 'Journal metadata fixture', 'crypto',
                   '["yes","no"]'::jsonb, $2, $2)
           RETURNING metadata_version_id`,
          [conditionId, observedAt],
        );
        metadataVersionId = String(metadata.rows[0]?.metadata_version_id);
        await client.query(
          `INSERT INTO polymarket_markets
             (condition_id, question, category, neg_risk, clob_token_ids,
              active, closed, received_at, updated_at)
           VALUES ($1, 'Prospective registry backfill', 'crypto', FALSE,
                   '["yes","no"]'::jsonb, TRUE, FALSE, $2, $2)`,
          [registryOnlyId, observedAt],
        );
        await client.query(
          `ALTER TABLE polymarket_resolution_events
             ENABLE TRIGGER resolution_event_input_change_trg;
           ALTER TABLE polymarket_rule_versions
             ENABLE TRIGGER rule_version_input_change_trg;
           ALTER TABLE polymarket_param_versions
             ENABLE TRIGGER param_version_input_change_trg;
           ALTER TABLE polymarket_event_markets
             ENABLE TRIGGER event_membership_input_change_trg;
           ALTER TABLE polymarket_universe_log
             ENABLE TRIGGER universe_membership_input_change_trg;
           ALTER TABLE polymarket_market_metadata_versions
             ENABLE TRIGGER market_metadata_input_change_trg;`,
        );
        await client.query(
          `INSERT INTO resolution_runtime_state
             (runtime_id, generation, score_version, ready, started_at,
              heartbeat_at, lease_expires_at, processed_input_change_id)
           VALUES (1, '11111111-1111-4111-8111-111111111111', 'upgrade-test',
                   FALSE, $1, $1, $1, 17)`,
          [observedAt],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      const missingBefore = await raw.query(
        `SELECT 1 FROM polymarket_resolution_input_changes
          WHERE condition_id = $1`,
        [conditionId],
      );
      expect(missingBefore.rows).toHaveLength(0);

      await reapplyMigration(raw, 11, "0011_resolution_runtime_safety.sql");
      await reapplyMigration(
        raw,
        12,
        "0012_polymarket_market_metadata_history.sql",
      );

      const journal = await raw.query<Record<string, unknown>>(
        `SELECT source, source_key, condition_id
           FROM polymarket_resolution_input_changes
          WHERE condition_id = ANY($1)
          ORDER BY condition_id, source`,
        [[conditionId, registryOnlyId]],
      );
      expect(journal.rows).toEqual([
        {
          source: "event_membership",
          source_key: membershipKey,
          condition_id: conditionId,
        },
        {
          source: "market_metadata",
          source_key: metadataVersionId,
          condition_id: conditionId,
        },
        {
          source: "param_version",
          source_key: paramVersionId,
          condition_id: conditionId,
        },
        {
          source: "resolution_event",
          source_key: resolutionEventId,
          condition_id: conditionId,
        },
        {
          source: "rule_version",
          source_key: ruleVersionId,
          condition_id: conditionId,
        },
        {
          source: "universe_membership",
          source_key: universeLogId,
          condition_id: conditionId,
        },
        expect.objectContaining({
          source: "market_metadata",
          condition_id: registryOnlyId,
        }),
      ]);

      const runtime = await raw.query<Record<string, unknown>>(
        `SELECT processed_input_change_id
           FROM resolution_runtime_state WHERE runtime_id = 1`,
      );
      expect(runtime.rows[0]).toMatchObject({
        processed_input_change_id: "17",
      });

      const beforeReapply = await raw.query<Record<string, unknown>>(
        `SELECT COUNT(*)::bigint AS n
           FROM polymarket_resolution_input_changes`,
      );
      await reapplyMigration(raw, 11, "0011_resolution_runtime_safety.sql");
      await reapplyMigration(
        raw,
        12,
        "0012_polymarket_market_metadata_history.sql",
      );
      const afterReapply = await raw.query<Record<string, unknown>>(
        `SELECT COUNT(*)::bigint AS n
           FROM polymarket_resolution_input_changes`,
      );
      expect(afterReapply.rows[0]?.n).toBe(beforeReapply.rows[0]?.n);

      const upgradedMetadata = await raw.query<Record<string, unknown>>(
        `SELECT affirmative_token_id
           FROM polymarket_market_metadata_versions
          WHERE condition_id = $1 AND valid_to IS NULL`,
        [registryOnlyId],
      );
      expect(upgradedMetadata.rows[0]?.affirmative_token_id).toBeNull();
      await expect(
        loadMarketRef(pool, registryOnlyId, observedAt),
      ).resolves.toBeNull();

      await expect(
        raw.query(
          `INSERT INTO polymarket_resolution_input_changes
             (source, source_key, condition_id, observed_at)
           VALUES ('unsupported_source', $1, $2, $3)`,
          [`unsupported-${conditionId}`, conditionId, observedAt],
        ),
      ).rejects.toThrow(/polymarket_resolution_input_changes_source_check/);

      await expect(
        raw.query(
          `UPDATE polymarket_resolution_input_changes
              SET observed_at = observed_at
            WHERE condition_id = $1`,
          [conditionId],
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        raw.query(
          `DELETE FROM polymarket_resolution_input_changes
            WHERE condition_id = $1`,
          [conditionId],
        ),
      ).rejects.toThrow(/immutable/);
    });

    it("holds source inserts behind the journal SHARE barrier until the fill transaction commits", async () => {
      const conditionId = `0xjournalbarrier${Date.now().toString(36)}`;
      const barrier = await raw.connect();
      const writer = await raw.connect();
      let barrierOpen = false;
      let writerOpen = false;
      try {
        await barrier.query("BEGIN");
        barrierOpen = true;
        await barrier.query(
          `LOCK TABLE polymarket_resolution_input_changes IN SHARE MODE`,
        );

        await writer.query("BEGIN");
        writerOpen = true;
        await writer.query(`SET LOCAL lock_timeout = '5s'`);
        let insertSettled = false;
        const insert = writer
          .query(
            `INSERT INTO polymarket_resolution_events
                 (condition_id, event_type, payload_json, received_at)
               VALUES ($1, 'proposed', '{}'::jsonb, $2)`,
            [conditionId, AS_OF],
          )
          .then(() => {
            insertSettled = true;
          });

        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(insertSettled).toBe(false);

        await barrier.query("COMMIT");
        barrierOpen = false;
        await insert;
        await writer.query("COMMIT");
        writerOpen = false;

        const captured = await raw.query<Record<string, unknown>>(
          `SELECT source, condition_id
               FROM polymarket_resolution_input_changes
              WHERE source = 'resolution_event' AND condition_id = $1`,
          [conditionId],
        );
        expect(captured.rows).toEqual([
          { source: "resolution_event", condition_id: conditionId },
        ]);
      } finally {
        if (barrierOpen) {
          await barrier.query("ROLLBACK").catch(() => undefined);
        }
        if (writerOpen) {
          await writer.query("ROLLBACK").catch(() => undefined);
        }
        barrier.release();
        writer.release();
      }
    }, 10_000);

    it("enforces consistent pending resolution-risk claims", async () => {
      await expect(
        raw.query(
          `INSERT INTO paper_orders
             (order_id, token_id, side, order_type, limit_price, size,
              post_only, source, status, decided_at,
              resolution_risk_check_pending)
           VALUES ($1, 'claim-token', 'BUY', 'GTC', '0.40', '1', TRUE,
                   'manual', 'rejected', $2, TRUE)`,
          [`claim-invalid-${Date.now().toString(36)}`, AS_OF],
        ),
      ).rejects.toThrow(/paper_orders_resolution_risk_claim_check/);
    });

    it("runs the batched historical loaders against PostgreSQL", async () => {
      const markets = await historicalMarketsAsOf(pool, [
        { conditionId: CLEAN_ID, asOf: AS_OF },
      ]);
      expect(markets.get(CLEAN_ID)).toMatchObject({
        question: "Will the price of Bitcoin be above $68,000 on August 25?",
        category: "crypto",
        negRisk: false,
        tokenIds: [TOKEN(CLEAN_ID, 0), TOKEN(CLEAN_ID, 1)],
        affirmativeTokenId: TOKEN(CLEAN_ID, 0),
        inUniverse: true,
        historicalInputsAvailable: true,
      });

      const stats = await measuredCategoryStatsBatch(pool, [AS_OF]);
      expect(stats.get(AS_OF.getTime())).toEqual([]);
    });

    it("scores every market with action, justification and state (<= 60s path)", async () => {
      const summary = await recomputeMarkets(deps, "boot", AS_OF, null);
      expect(summary.failed).toBe(0);
      expect(summary.scored).toBe(4);

      const states = await pool.query<Record<string, unknown>>(
        `SELECT condition_id, action, effective_action, dispute_active,
              hard_flags_json, justification
         FROM resolution_market_state ORDER BY condition_id`,
      );
      const byId = new Map(states.rows.map((row) => [row.condition_id, row]));

      const clean = byId.get(CLEAN_ID);
      expect(clean?.action).toBe("NONE");
      expect(clean?.justification).toBeTruthy();

      const subjective = byId.get(SUBJ_ID);
      expect(subjective?.action).toBe("VETO");
      expect(JSON.stringify(subjective?.hard_flags_json)).toContain(
        "SUBJECTIVE_SOURCE",
      );

      const disputed = byId.get(GROUP_B);
      expect(disputed?.action).toBe("CIRCUIT_BREAKER");
      expect(disputed?.dispute_active).toBe(true);

      // Task 15: the sibling in the same negRisk event inherits the breaker.
      const sibling = byId.get(GROUP_A);
      expect(sibling?.action).not.toBe("CIRCUIT_BREAKER");
      expect(sibling?.effective_action).toBe("CIRCUIT_BREAKER");
    });

    it("persists the UMA timeline (proposed -> disputed -> reset)", async () => {
      const timeline = await pool.query<Record<string, unknown>>(
        `SELECT request_index, state FROM resolution_uma_timeline
        WHERE condition_id = $1 ORDER BY occurred_at ASC, timeline_id ASC`,
        [GROUP_B],
      );
      expect(
        timeline.rows.map((row) => [Number(row.request_index), row.state]),
      ).toEqual([
        [1, "proposed"],
        [1, "disputed"],
        [1, "reset"],
      ]);
    });

    it("ignores planted FUTURE data at the decision instant (look-ahead)", async () => {
      const market = {
        conditionId: CLEAN_ID,
        question: "Will the price of Bitcoin be above $68,000 on August 25?",
        category: "crypto",
        negRisk: false,
        tokenIds: [TOKEN(CLEAN_ID, 0), TOKEN(CLEAN_ID, 1)],
        affirmativeTokenId: TOKEN(CLEAN_ID, 0),
        inUniverse: true,
      };
      const before = await composeForMarket(
        deps,
        market,
        new Map(),
        AS_OF,
        false,
      );

      // Plant a dispute and a material rule change AFTER the decision instant.
      const future = new Date(AS_OF.getTime() + 3_600_000);
      await pool.query(
        `INSERT INTO polymarket_resolution_events
         (condition_id, event_type, payload_json, received_at)
       VALUES ($1,'disputed','{}'::jsonb,$2)`,
        [CLEAN_ID, future],
      );
      await pool.query(
        `UPDATE polymarket_rule_versions SET valid_to = $2
        WHERE condition_id = $1 AND valid_to IS NULL`,
        [CLEAN_ID, future],
      );
      await pool.query(
        `INSERT INTO polymarket_rule_versions
         (condition_id, version, content_hash, description, resolution_source,
          end_date, uma_end_date, uma_bond, valid_from, received_at)
       VALUES ($1,2,'hash2','Resolves YES if the price of Bitcoin is above $80,000 on August 25 per the Chainlink TWAP price feed.','chainlink',$2,$2,'750',$3,$3)`,
        [CLEAN_ID, new Date("2026-08-25T00:00:00Z"), future],
      );

      const after = await composeForMarket(
        deps,
        market,
        new Map(),
        AS_OF,
        false,
      );
      // Identical at the same instant: the future dispute and the future rule
      // version leaked nowhere.
      expect(after.composed.scoreText).toBe(before.composed.scoreText);
      expect(after.composed.action).toBe(before.composed.action);
      expect(after.disputeActive).toBe(false);

      // And at a LATER instant the same pipeline does see them.
      const later = await composeForMarket(
        deps,
        market,
        new Map(),
        new Date(future.getTime() + 60_000),
        false,
      );
      expect(later.disputeActive).toBe(true);
      expect(later.composed.action).toBe("CIRCUIT_BREAKER");
    });

    it("reproduces the same score for the same version and instant", async () => {
      const market = {
        conditionId: SUBJ_ID,
        question: "Will the agreement be signed?",
        category: "crypto",
        negRisk: false,
        tokenIds: [TOKEN(SUBJ_ID, 0), TOKEN(SUBJ_ID, 1)],
        affirmativeTokenId: TOKEN(SUBJ_ID, 0),
        inUniverse: true,
      };
      const one = await composeForMarket(deps, market, new Map(), AS_OF, false);
      const two = await composeForMarket(deps, market, new Map(), AS_OF, false);
      expect(one.composed.scoreText).toBe(two.composed.scoreText);
      expect(one.composed.features).toEqual(two.composed.features);
    });

    it("classifies the planted rule change as a material clarification", async () => {
      const afterChange = new Date(AS_OF.getTime() + 2 * 3_600_000);
      await recomputeMarkets(deps, "rule_change", afterChange, [CLEAN_ID]);
      const clarifications = await pool.query<Record<string, unknown>>(
        `SELECT rule_version, classification FROM resolution_clarifications
        WHERE condition_id = $1`,
        [CLEAN_ID],
      );
      expect(clarifications.rows).toHaveLength(1);
      expect(clarifications.rows[0]?.classification).toBe("material");

      // Fresh material clarification (< 24h) forces the hard-flag VETO — and
      // an active dispute beats it with the circuit breaker.
      const state = await pool.query<Record<string, unknown>>(
        `SELECT action, dispute_active FROM resolution_market_state
        WHERE condition_id = $1`,
        [CLEAN_ID],
      );
      expect(state.rows[0]?.action).toBe("CIRCUIT_BREAKER");
    });

    it("refuses to reuse a score_version name for different content", async () => {
      await expect(
        ensureScoreVersion(pool, {
          scoreVersion: deps.scoreVersion,
          configHash: "c".repeat(64),
          lexiconHash: "b".repeat(64),
          weights: {},
          thresholds: {},
          priors: {},
        }),
      ).rejects.toThrow(/SCORE_VERSION_CONTENT_MISMATCH/);
    });

    it("blocks score mutation, permits score retention deletes and freezes score versions", async () => {
      await expect(
        pool.query(`UPDATE resolution_scores SET score = '0.000001'`),
      ).rejects.toThrow(/immutable/);

      const stored = await pool.query<Record<string, unknown>>(
        `SELECT COUNT(*)::bigint AS n
           FROM resolution_scores
          WHERE condition_id = $1`,
        [CLEAN_ID],
      );
      expect(Number(stored.rows[0]?.n)).toBeGreaterThan(0);

      const deleted = await pool.query(
        `DELETE FROM resolution_scores WHERE condition_id = $1`,
        [CLEAN_ID],
      );
      expect(deleted.rowCount).toBe(Number(stored.rows[0]?.n));

      await expect(
        pool.query(
          `UPDATE resolution_score_versions
              SET config_hash = config_hash
            WHERE score_version = $1`,
          [deps.scoreVersion],
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        pool.query(
          `DELETE FROM resolution_score_versions WHERE score_version = $1`,
          [deps.scoreVersion],
        ),
      ).rejects.toThrow(/immutable/);
    });

    it("enforces the gate against the real state rows (task 17)", async () => {
      const intent = await resolutionGate(pool, {
        conditionId: SUBJ_ID,
        tokenId: TOKEN(SUBJ_ID, 0),
        source: "intent",
      });
      expect(intent.allowed).toBe(false);
      expect(intent.reason).toBe("RESOLUTION_VETO");

      const manual = await resolutionGate(pool, {
        conditionId: SUBJ_ID,
        source: "manual",
      });
      expect(manual.allowed).toBe(false);

      const overridden = await resolutionGate(pool, {
        conditionId: SUBJ_ID,
        source: "manual",
        overrideVeto: true,
      });
      expect(overridden.allowed).toBe(true);
      expect(overridden.overrideApplied).toBe(true);

      // The group sibling is frozen through the EFFECTIVE action: no override.
      const sibling = await resolutionGate(pool, {
        conditionId: GROUP_A,
        source: "manual",
        overrideVeto: true,
      });
      expect(sibling.allowed).toBe(false);
      expect(sibling.reason).toBe("RESOLUTION_CIRCUIT_BREAKER");
    });

    it("records a LIVE UMA proposal on the market state (RFC-018 item 3)", async () => {
      // The column the RFC-013 breaker needs. Before it existed the state row
      // carried only `dispute_active`, which has been false in 781 of 781
      // production markets while 482 went through `proposed` — so the half of
      // UMA_PROPOSED_OR_DISPUTED the RFC names first could never fire.
      const proposedAt = new Date(AS_OF.getTime() - 5 * 60_000);
      await pool.query(
        `INSERT INTO polymarket_resolution_events
           (condition_id, event_type, payload_json, received_at)
         VALUES ($1,'proposed','{}'::jsonb,$2)`,
        [CLEAN_ID, proposedAt],
      );
      const summary = await recomputeMarkets(deps, "status_change", AS_OF, [
        CLEAN_ID,
      ]);
      expect(summary).toEqual({ scored: 1, failed: 0 });

      const state = await pool.query<Record<string, unknown>>(
        `SELECT proposal_active, dispute_active FROM resolution_market_state
          WHERE condition_id = $1`,
        [CLEAN_ID],
      );
      expect(state.rows[0]).toMatchObject({
        proposal_active: true,
        dispute_active: false,
      });
    });

    it("absorbs timeline replays without duplicating events", async () => {
      const before = await pool.query<Record<string, unknown>>(
        `SELECT COUNT(*)::bigint AS n FROM resolution_uma_timeline WHERE condition_id = $1`,
        [GROUP_B],
      );
      await recomputeMarkets(deps, "sweep", AS_OF, [GROUP_B]);
      const after = await pool.query<Record<string, unknown>>(
        `SELECT COUNT(*)::bigint AS n FROM resolution_uma_timeline WHERE condition_id = $1`,
        [GROUP_B],
      );
      expect(Number(after.rows[0]?.n)).toBe(Number(before.rows[0]?.n));
    });

    it("releases a settled market and its coupled group despite a delayed proposal", async () => {
      const settledAt = new Date(AS_OF.getTime() + 4 * 3_600_000);
      const delayedAt = new Date(settledAt.getTime() + 60_000);
      await pool.query(
        `INSERT INTO polymarket_universe_log (condition_id, action, reason, at)
         VALUES ($1,'exit','terminal_fixture',$2)`,
        [GROUP_B, new Date(settledAt.getTime() - 60_000)],
      );
      await pool.query(
        `INSERT INTO polymarket_resolution_events
           (condition_id, event_type, payload_json, received_at)
         VALUES ($1,'market_resolved','{}'::jsonb,$2)`,
        [GROUP_B, settledAt],
      );
      await pool.query(
        `INSERT INTO polymarket_resolution_events
           (condition_id, event_type, payload_json, received_at)
         VALUES ($1,'proposed','{}'::jsonb,$2)`,
        [GROUP_B, delayedAt],
      );

      const summary = await recomputeMarkets(deps, "status_change", delayedAt, [
        GROUP_B,
      ]);
      expect(summary).toEqual({ scored: 1, failed: 0 });

      const states = await pool.query<Record<string, unknown>>(
        `SELECT condition_id, action, effective_action, dispute_active,
                proposal_active, justification
           FROM resolution_market_state
          WHERE condition_id = ANY($1)
          ORDER BY condition_id`,
        [[GROUP_A, GROUP_B]],
      );
      const byId = new Map(states.rows.map((row) => [row.condition_id, row]));

      expect(byId.get(GROUP_B)).toMatchObject({
        action: "NONE",
        effective_action: "NONE",
        dispute_active: false,
        // RFC-018 item 3: a settled market is not under a live proposal, even
        // when the proposal event arrives after the settle. The portfolio
        // breaker reads this column, and a stuck TRUE here would freeze a
        // market whose outcome is already decided.
        proposal_active: false,
      });
      expect(String(byId.get(GROUP_B)?.justification)).toContain("terminal");
      expect(byId.get(GROUP_A)?.effective_action).toBe("NONE");

      const sibling = await resolutionGate(pool, {
        conditionId: GROUP_A,
        source: "manual",
      });
      expect(sibling.allowed).toBe(true);
    });

    it("keeps prospective metadata replayable without projecting the backfill backward", async () => {
      const changedAt = new Date("2026-08-20T18:00:00.000Z");
      const laterPollAt = new Date("2026-08-20T20:00:00.000Z");
      const futureDecision = new Date("2026-08-20T19:00:00.000Z");
      const futureQuestion = "Will the Fed cut rates before October?";
      const futureTokens = ["future-yes", "future-no"];

      await pool.query(
        `UPDATE polymarket_market_metadata_versions
            SET valid_to = $2
          WHERE condition_id = $1 AND valid_to IS NULL`,
        [CLEAN_ID, changedAt],
      );
      await pool.query(
        `INSERT INTO polymarket_market_metadata_versions
           (condition_id, version, question, category, clob_token_ids,
            affirmative_token_id, valid_from, source_ts, received_at)
         VALUES ($1,2,$2,'macro',$3::jsonb,$4,$5,$5,$5)`,
        [
          CLEAN_ID,
          futureQuestion,
          JSON.stringify(futureTokens),
          futureTokens[0],
          changedAt,
        ],
      );
      // A later unchanged registry poll advances updated_at beyond the
      // decision. The version's validity, not that mutable timestamp, governs.
      await pool.query(
        `UPDATE polymarket_markets
            SET question = $2, category = 'macro', clob_token_ids = $3::jsonb,
                affirmative_token_id = $4, updated_at = $5
          WHERE condition_id = $1`,
        [
          CLEAN_ID,
          futureQuestion,
          JSON.stringify(futureTokens),
          futureTokens[0],
          laterPollAt,
        ],
      );

      const snapshots = await historicalMarketsAsOf(pool, [
        {
          conditionId: CLEAN_ID,
          asOf: new Date(changedAt.getTime() - 60_000),
        },
      ]);
      expect(snapshots.get(CLEAN_ID)).toMatchObject({
        question: "Will the price of Bitcoin be above $68,000 on August 25?",
        category: "crypto",
        tokenIds: [TOKEN(CLEAN_ID, 0), TOKEN(CLEAN_ID, 1)],
        affirmativeTokenId: TOKEN(CLEAN_ID, 0),
        historicalInputsAvailable: true,
      });

      const future = await historicalMarketsAsOf(pool, [
        { conditionId: CLEAN_ID, asOf: futureDecision },
      ]);
      expect(future.get(CLEAN_ID)).toMatchObject({
        question: futureQuestion,
        category: "macro",
        tokenIds: futureTokens,
        affirmativeTokenId: futureTokens[0],
        historicalInputsAvailable: true,
      });

      const beforeBackfill = await historicalMarketsAsOf(pool, [
        {
          conditionId: CLEAN_ID,
          asOf: new Date(T0.getTime() - 1),
        },
      ]);
      expect(beforeBackfill.get(CLEAN_ID)).toMatchObject({
        question: "",
        category: null,
        tokenIds: [],
        affirmativeTokenId: null,
        historicalInputsAvailable: false,
      });

      await expect(
        pool.query(
          `UPDATE polymarket_market_metadata_versions
              SET question = question
            WHERE condition_id = $1 AND version = 1`,
          [CLEAN_ID],
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        pool.query(
          `DELETE FROM polymarket_market_metadata_versions
            WHERE condition_id = $1`,
          [CLEAN_ID],
        ),
      ).rejects.toThrow(/append-only/);

      const integrityId = "0xmetadata-integrity";
      await expect(
        pool.query(
          `INSERT INTO polymarket_market_metadata_versions
             (condition_id, version, question, category, clob_token_ids,
              valid_from, received_at)
           VALUES ($1,2,'invalid first version','crypto','["yes","no"]'::jsonb,$2,$2)`,
          [integrityId, changedAt],
        ),
      ).rejects.toThrow(/first metadata version/);
      await pool.query(
        `INSERT INTO polymarket_market_metadata_versions
           (condition_id, version, question, category, clob_token_ids,
            valid_from, received_at)
         VALUES ($1,1,'valid first version','crypto','["yes","no"]'::jsonb,$2,$2)`,
        [integrityId, changedAt],
      );
      await pool.query(
        `UPDATE polymarket_market_metadata_versions
            SET valid_to = $2
          WHERE condition_id = $1 AND valid_to IS NULL`,
        [integrityId, laterPollAt],
      );
      await expect(
        pool.query(
          `INSERT INTO polymarket_market_metadata_versions
             (condition_id, version, question, category, clob_token_ids,
              valid_from, received_at)
           VALUES ($1,2,'gapped version','crypto','["yes","no"]'::jsonb,$2,$2)`,
          [integrityId, new Date(laterPollAt.getTime() + 1)],
        ),
      ).rejects.toThrow(/contiguous and sequential/);
    });
  },
);
