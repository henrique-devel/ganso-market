// End-to-end RFC-012 check against a REAL PostgreSQL with the real migrations
// (0001..0010) applied. Skipped unless GANSO_TEST_DATABASE_URL points at a
// throwaway database, so CI (no PostgreSQL in the source gate) stays green.
// It exercises what the unit fakes cannot prove: the 0010 constraints and
// immutability triggers, the as-of look-ahead guard against PLANTED FUTURE
// data, score reproducibility, the group coupling and the enforcement gate
// over real rows.
//
// Run it with:
//   GANSO_TEST_DATABASE_URL=postgres://... npx vitest run test/polymarket/resolution/integration.test.ts

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  DatabasePool,
  QueryResult,
  SqlExecutor,
} from "../../../src/database.js";
import { DEFAULT_RESOLUTION_CONFIG } from "../../../src/polymarket/resolution/config.js";
import { resolutionGate } from "../../../src/polymarket/resolution/enforcement.js";
import { DEFAULT_RESOLUTION_LEXICON } from "../../../src/polymarket/resolution/lexicon.js";
import {
  composeForMarket,
  recomputeMarkets,
  type RecomputeDeps,
} from "../../../src/polymarket/resolution/recompute.js";
import { ensureScoreVersion } from "../../../src/polymarket/resolution/store.js";

const DATABASE_URL = process.env.GANSO_TEST_DATABASE_URL;

const T0 = new Date("2026-08-20T10:00:00.000Z");
const AS_OF = new Date("2026-08-20T12:00:00.000Z");
const CLEAN_ID = "0xrfc012clean";
const SUBJ_ID = "0xrfc012subjective";
const GROUP_A = "0xrfc012groupa";
const GROUP_B = "0xrfc012groupb";
const TOKEN = (id: string, index: number): string => `${id}tok${index}`;

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
        rules, tick_size, end_date_iso, active, closed, source_ts, received_at)
     VALUES ($1,$2,$3,'crypto',$4,$5::jsonb,$6,'0.01',$7,TRUE,FALSE,$8,$8)`,
    [
      conditionId,
      question,
      conditionId,
      options.negRisk === true,
      JSON.stringify([TOKEN(conditionId, 0), TOKEN(conditionId, 1)]),
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
      await pool.query(`TRUNCATE polymarket_markets, polymarket_universe_log,
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
        `INSERT INTO polymarket_events (event_id, slug, title, neg_risk)
       VALUES ('ev-rfc012','nomination','Nomination race', TRUE)`,
      );
      for (const member of [GROUP_A, GROUP_B]) {
        await pool.query(
          `INSERT INTO polymarket_event_markets (event_id, condition_id)
         VALUES ('ev-rfc012', $1)`,
          [member],
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

    it("keeps the score series immutable", async () => {
      await expect(
        pool.query(`UPDATE resolution_scores SET score = '0.000001'`),
      ).rejects.toThrow(/immutable/);
      await expect(pool.query(`DELETE FROM resolution_scores`)).rejects.toThrow(
        /immutable/,
      );
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
  },
);
