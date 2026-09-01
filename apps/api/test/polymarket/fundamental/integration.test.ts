// End-to-end RFC-010 check against a REAL PostgreSQL with the real migrations
// applied. It is skipped unless GANSO_TEST_DATABASE_URL points at a throwaway
// database, so CI (which has no PostgreSQL in the source gate) stays green
// while the local run exercises the actual SQL: the schema constraints, the
// as-of joins, the estimator's writes, the gate and the promotion refusal.
//
// Run it with:
//   GANSO_TEST_DATABASE_URL=postgres://... npx vitest run test/polymarket/fundamental/integration.test.ts

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  DatabasePool,
  QueryResult,
  SqlExecutor,
} from "../../../src/database.js";
import { runCalibrationJob } from "../../../src/polymarket/fundamental/calibration.js";
import { DEFAULT_FUNDAMENTAL_CONFIG } from "../../../src/polymarket/fundamental/config.js";
import { createEstimator } from "../../../src/polymarket/fundamental/estimator.js";
import { syncLabels } from "../../../src/polymarket/fundamental/labels.js";
import {
  getModel,
  promoteModel,
} from "../../../src/polymarket/fundamental/registry.js";
import { ensureCatalogModels } from "../../../src/polymarket/fundamental/runner.js";

const DATABASE_URL = process.env.GANSO_TEST_DATABASE_URL;
const GIT_SHA = "b".repeat(40);
const DECISION_TS = new Date("2026-08-19T12:00:00.000Z");
const CONDITION_ID = "0xrfc010integration";
const TOKEN_YES = "1111111111111111111111111111111111111111111111111111111";
const TOKEN_NO = "2222222222222222222222222222222222222222222222222222222";

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

describe.skipIf(DATABASE_URL === undefined)(
  "RFC-010 against PostgreSQL",
  () => {
    let raw: pg.Pool;
    let pool: DatabasePool;

    beforeAll(async () => {
      raw = new pg.Pool({ connectionString: DATABASE_URL });
      pool = poolAdapter(raw);
      // TRUNCATE ... CASCADE, not DELETE: model rows are protected by the
      // immutability trigger, which is exactly what production wants and what a
      // throwaway test database has to get around.
      await pool.query(`TRUNCATE fundamental_estimates, fundamental_gate_reports,
                               fundamental_calibration_reports,
                               fundamental_model_events, fundamental_labels,
                               fundamental_models CASCADE`);
      await pool.query(`TRUNCATE polymarket_markets, polymarket_universe_log,
                               polymarket_book_snapshots_full, polymarket_book_deltas,
                               polymarket_rule_versions, polymarket_param_versions,
                               polymarket_resolution_events, polymarket_rtds_prices,
                               polymarket_rtds_1m`);

      const bookAt = new Date(DECISION_TS.getTime() - 5_000);
      await pool.query(
        `INSERT INTO polymarket_markets
         (condition_id, question, slug, category, clob_token_ids, rules,
          tick_size, end_date_iso, active, closed, source_ts, received_at)
       VALUES ($1, $2, $3, 'crypto', $4::jsonb, $5, '0.01', $6, TRUE, FALSE, $7, $7)`,
        [
          CONDITION_ID,
          "Will BTC be above $100,000 on August 19?",
          "btc-above-100000",
          JSON.stringify([TOKEN_YES, TOKEN_NO]),
          "Resolves YES if the Chainlink BTC/USD price is above 100000 at the deadline.",
          "2026-08-19T20:00:00.000Z",
          new Date(DECISION_TS.getTime() - 3_600_000),
        ],
      );
      await pool.query(
        `INSERT INTO polymarket_universe_log (condition_id, action, reason, at)
       VALUES ($1, 'enter', 'priority_2_crypto', $2)`,
        [CONDITION_ID, new Date(DECISION_TS.getTime() - 3_600_000)],
      );
      await pool.query(
        `INSERT INTO polymarket_rule_versions
         (condition_id, version, content_hash, description, resolution_source,
          end_date, valid_from, source_ts, received_at)
       VALUES ($1, 1, 'hash-1', $2, 'chainlink', $3, $4, $4, $4)`,
        [
          CONDITION_ID,
          "Resolves YES if the Chainlink BTC/USD price is above 100000 at the deadline.",
          new Date("2026-08-19T20:00:00.000Z"),
          new Date(DECISION_TS.getTime() - 3_600_000),
        ],
      );

      for (const [tokenId, bidPrice, askPrice] of [
        [TOKEN_YES, "0.50", "0.52"],
        [TOKEN_NO, "0.48", "0.50"],
      ] as const) {
        await pool.query(
          `INSERT INTO polymarket_book_snapshots_full
           (token_id, reason, bids_json, asks_json, source_ts, received_at)
         VALUES ($1, 'subscribe', $2::jsonb, $3::jsonb, $4, $4)`,
          [
            tokenId,
            JSON.stringify([
              { price: bidPrice, size: "1000" },
              { price: "0.40", size: "5000" },
            ]),
            JSON.stringify([
              { price: askPrice, size: "1000" },
              { price: "0.60", size: "5000" },
            ]),
            bookAt,
          ],
        );
      }

      // Resolving feed: Chainlink TWAP plus enough one-minute history for the
      // model's volatility windows.
      await pool.query(
        `INSERT INTO polymarket_rtds_prices (feed, symbol, price, source_ts, received_at)
       VALUES ('twap30', 'btc/usd', '101000', $1, $1)`,
        [new Date(DECISION_TS.getTime() - 10_000)],
      );
      const buckets: string[] = [];
      const values: unknown[] = [];
      for (let index = 0; index < 300; index += 1) {
        const bucketStart = new Date(
          DECISION_TS.getTime() - (index + 2) * 60_000,
        );
        const price = (100_000 + index * 3).toString();
        const offset = values.length;
        buckets.push(
          `('twap30', 'btc/usd', $${offset + 1}, $${offset + 2}, $${offset + 2}, $${offset + 2}, $${offset + 2}, 30)`,
        );
        values.push(bucketStart, price);
      }
      await pool.query(
        `INSERT INTO polymarket_rtds_1m
         (feed, symbol, bucket_start, open, high, low, close, samples)
       VALUES ${buckets.join(", ")}`,
        values,
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it("writes a baseline estimate per token when no model is promoted", async () => {
      const estimator = createEstimator({
        pool,
        config: DEFAULT_FUNDAMENTAL_CONFIG,
        gitSha: GIT_SHA,
        clock: () => DECISION_TS,
      });
      const report = await estimator.runCycle();
      expect(report.markets).toBe(1);
      expect(report.tokensConsidered).toBe(2);
      expect(report.consumerRows).toBe(2);
      expect(report.fallbackReasons.NO_ACTIVE_MODEL).toBe(2);

      const rows = await pool.query<Record<string, unknown>>(
        `SELECT token_id, source, status, q, q_lo, q_hi, market_prob,
              fallback_reason, model_id, data_refs
         FROM fundamental_estimates ORDER BY token_id`,
      );
      expect(rows.rowCount).toBe(2);
      for (const row of rows.rows) {
        expect(row.source).toBe("MARKET_BASELINE");
        expect(row.status).toBe("active");
        expect(row.fallback_reason).toBe("NO_ACTIVE_MODEL");
        expect(row.model_id).toBeNull();
        // The database itself enforces q_lo <= q <= q_hi and the provenance
        // constraints; reaching this point means both held.
        expect(String(row.q)).toMatch(/^[01]\.\d{6}$/);
        expect(row.q).toBe(row.market_prob);
        expect(row.data_refs).toHaveProperty("bookSourceTs");
      }
    });

    it("rate-limits a second cycle inside the same minute", async () => {
      const estimator = createEstimator({
        pool,
        config: DEFAULT_FUNDAMENTAL_CONFIG,
        gitSha: GIT_SHA,
        clock: () => new Date(DECISION_TS.getTime() + 30_000),
      });
      const report = await estimator.runCycle();
      expect(report.tokensRateLimited).toBe(2);
      expect(report.consumerRows).toBe(0);
    });

    it("registers the catalog models in shadow and writes shadow rows", async () => {
      const registered = await ensureCatalogModels(pool, GIT_SHA, DECISION_TS);
      expect(registered.length).toBeGreaterThan(0);
      const model = await getModel(pool, registered[0] ?? "");
      expect(model?.status).toBe("shadow");

      // A fresh anchor: the first one is already older than the 30 s staleness
      // threshold at this instant, and a stale book means no estimate at all.
      const laterBookAt = new Date(DECISION_TS.getTime() + 355_000);
      for (const [tokenId, bidPrice, askPrice] of [
        [TOKEN_YES, "0.50", "0.52"],
        [TOKEN_NO, "0.48", "0.50"],
      ] as const) {
        await pool.query(
          `INSERT INTO polymarket_book_snapshots_full
             (token_id, reason, bids_json, asks_json, source_ts, received_at)
           VALUES ($1, 'anchor', $2::jsonb, $3::jsonb, $4, $4)`,
          [
            tokenId,
            JSON.stringify([
              { price: bidPrice, size: "1000" },
              { price: "0.40", size: "5000" },
            ]),
            JSON.stringify([
              { price: askPrice, size: "1000" },
              { price: "0.60", size: "5000" },
            ]),
            laterBookAt,
          ],
        );
      }

      const estimator = createEstimator({
        pool,
        config: DEFAULT_FUNDAMENTAL_CONFIG,
        gitSha: GIT_SHA,
        // Past the 5-minute cadence of this market's horizon bucket.
        clock: () => new Date(DECISION_TS.getTime() + 360_000),
      });
      const report = await estimator.runCycle();
      expect(report.consumerRows).toBe(2);
      // The consumer still reads the baseline while the model is in shadow.
      expect(report.fallbackReasons.MODEL_IN_SHADOW ?? 0).toBeGreaterThan(0);

      const shadowRows = await pool.query<Record<string, unknown>>(
        `SELECT model_id, model_version, feature_set_version, git_sha, data_refs
         FROM fundamental_estimates WHERE status = 'shadow'`,
      );
      for (const row of shadowRows.rows) {
        expect(row.model_id).not.toBeNull();
        expect(row.model_version).not.toBeNull();
        expect(row.feature_set_version).not.toBeNull();
        expect(row.git_sha).toBe(GIT_SHA);
        expect(row.data_refs).not.toBeNull();
      }
    });

    it("does not re-evaluate a token whose book is invalid on every tick", async () => {
      // An absent estimate writes no row on purpose. If the cadence keyed only on
      // stored rows, a token with a permanently invalid book would be re-read six
      // times a minute forever, producing nothing.
      await pool.query(`DELETE FROM polymarket_book_snapshots_full`);
      let now = DECISION_TS.getTime() + 3_600_000;
      const estimator = createEstimator({
        pool,
        config: DEFAULT_FUNDAMENTAL_CONFIG,
        gitSha: GIT_SHA,
        clock: () => new Date(now),
      });

      const first = await estimator.runCycle();
      expect(first.tokensConsidered).toBeGreaterThan(0);
      expect(first.absent).toBe(first.tokensConsidered);
      expect(first.consumerRows).toBe(0);

      // One tick later, the same instance: the attempt itself counted against
      // the cadence, so nothing is due.
      now += 10_000;
      const nextTick = await estimator.runCycle();
      expect(nextTick.tokensConsidered).toBe(0);
      expect(nextTick.tokensRateLimited).toBeGreaterThan(0);

      // Past this market's 5-minute bucket, it is evaluated again.
      now += 300_000;
      const afterCadence = await estimator.runCycle();
      expect(afterCadence.tokensConsidered).toBeGreaterThan(0);
    });

    it("refuses to promote a model without a passing gate", async () => {
      const models = await pool.query<{ model_id: string }>(
        `SELECT model_id FROM fundamental_models ORDER BY model_id LIMIT 1`,
      );
      const modelId = models.rows[0]?.model_id ?? "";
      const outcome = await promoteModel(pool, modelId, DECISION_TS);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(["NO_GATE_REPORT", "GATE_NOT_PASSED"]).toContain(
          outcome.reasonCode,
        );
      }
    });

    it("produces a NO_EVIDENCE_OF_ALPHA gate report with too little coverage", async () => {
      await syncLabels({ pool, clock: () => DECISION_TS });
      const report = await runCalibrationJob({
        pool,
        config: DEFAULT_FUNDAMENTAL_CONFIG,
        gitSha: GIT_SHA,
        clock: () => new Date(DECISION_TS.getTime() + 300_000),
      });
      expect(report.entries.length).toBeGreaterThan(0);
      for (const entry of report.entries) {
        expect(entry.gate?.verdict).toBe("NO_EVIDENCE_OF_ALPHA");
        expect(entry.gate?.failures).toContain("INSUFFICIENT_MARKETS");
      }

      const events = await pool.query<{ event_type: string }>(
        `SELECT event_type FROM fundamental_model_events
        WHERE event_type = 'no_evidence_of_alpha'`,
      );
      expect(events.rowCount).toBeGreaterThan(0);

      const promotion = await promoteModel(
        pool,
        report.entries[0]?.modelId ?? "",
        DECISION_TS,
      );
      expect(promotion.ok).toBe(false);
      if (!promotion.ok) {
        expect(promotion.reasonCode).toBe("GATE_NOT_PASSED");
        expect(promotion.gateReport?.verdict).toBe("NO_EVIDENCE_OF_ALPHA");
      }
    });

    it("RFC-014/019: 1.1.0 covers barrier and updown in shadow while 1.0.0 abstains", async () => {
      // Two hours after the base fixture, with fresh markets of the two new
      // forms. The catalog is already registered (both crypto versions).
      const t2 = new Date(DECISION_TS.getTime() + 2 * 3_600_000); // 14:00Z
      const enterAt = new Date(t2.getTime() - 3_600_000);
      const UPDOWN_ID = "0xrfc019updown";
      const UPDOWN_UP =
        "3333333333333333333333333333333333333333333333333333333";
      const UPDOWN_DOWN =
        "4444444444444444444444444444444444444444444444444444444";
      const BARRIER_ID = "0xrfc014barrier";
      const BARRIER_YES =
        "5555555555555555555555555555555555555555555555555555555";
      const BARRIER_NO =
        "6666666666666666666666666666666666666666666666666666666";

      // Hourly updown: deadline 14:30Z, window open = 13:30Z, strike = the
      // recorded feed at the open.
      const updownDeadline = new Date(t2.getTime() + 30 * 60_000);
      const windowStart = new Date(updownDeadline.getTime() - 3_600_000);
      await pool.query(
        `INSERT INTO polymarket_markets
           (condition_id, question, slug, category, clob_token_ids,
            affirmative_token_id, rules, tick_size, end_date_iso, end_ts,
            active, closed, source_ts, received_at)
         VALUES ($1, $2, $3, 'crypto', $4::jsonb, $5, $6, '0.01', $7, $8,
                 TRUE, FALSE, $9, $9)`,
        [
          UPDOWN_ID,
          "Bitcoin Up or Down - August 19, 9AM ET",
          "bitcoin-up-or-down-august-19-9am",
          JSON.stringify([UPDOWN_UP, UPDOWN_DOWN]),
          UPDOWN_UP,
          "Resolves Up if the close price is greater than or equal to the open price.",
          "2026-08-19",
          updownDeadline,
          enterAt,
        ],
      );
      await pool.query(
        `INSERT INTO polymarket_rule_versions
           (condition_id, version, content_hash, description,
            resolution_source, end_date, valid_from, source_ts, received_at)
         VALUES ($1, 1, 'hash-updown-1', 'up or down rules', 'binance', $2, $3, $3, $3)`,
        [UPDOWN_ID, updownDeadline, enterAt],
      );

      // Barrier "on <date>": one-day window already open at t2.
      const barrierDeadline = new Date("2026-08-20T04:00:00.000Z");
      await pool.query(
        `INSERT INTO polymarket_markets
           (condition_id, question, slug, category, clob_token_ids,
            affirmative_token_id, rules, tick_size, end_date_iso, end_ts,
            active, closed, source_ts, received_at)
         VALUES ($1, $2, $3, 'crypto', $4::jsonb, $5, $6, '0.01', $7, $8,
                 TRUE, FALSE, $9, $9)`,
        [
          BARRIER_ID,
          "Will Bitcoin reach $102,000 on August 19?",
          "bitcoin-reach-102000-august-19",
          JSON.stringify([BARRIER_YES, BARRIER_NO]),
          BARRIER_YES,
          "Resolves Yes if any candle high reaches the level.",
          "2026-08-19",
          barrierDeadline,
          enterAt,
        ],
      );
      await pool.query(
        `INSERT INTO polymarket_rule_versions
           (condition_id, version, content_hash, description,
            resolution_source, end_date, valid_from, source_ts, received_at)
         VALUES ($1, 1, 'hash-barrier-1', 'barrier rules', 'binance', $2, $3, $3, $3)`,
        [BARRIER_ID, barrierDeadline, enterAt],
      );

      for (const conditionId of [UPDOWN_ID, BARRIER_ID]) {
        await pool.query(
          `INSERT INTO polymarket_universe_log (condition_id, action, reason, at)
           VALUES ($1, 'enter', 'priority_2_crypto', $2)`,
          [conditionId, enterAt],
        );
      }
      for (const tokenId of [UPDOWN_UP, UPDOWN_DOWN, BARRIER_YES, BARRIER_NO]) {
        await pool.query(
          `INSERT INTO polymarket_book_snapshots_full
             (token_id, reason, bids_json, asks_json, source_ts, received_at)
           VALUES ($1, 'anchor', $2::jsonb, $3::jsonb, $4, $4)`,
          [
            tokenId,
            JSON.stringify([
              { price: "0.50", size: "1000" },
              { price: "0.40", size: "5000" },
            ]),
            JSON.stringify([
              { price: "0.52", size: "1000" },
              { price: "0.60", size: "5000" },
            ]),
            new Date(t2.getTime() - 5_000),
          ],
        );
      }
      // Current level at t2, and the window-open sample that becomes the
      // updown strike (30 s before the open, well inside max_strike_age_ms).
      await pool.query(
        `INSERT INTO polymarket_rtds_prices (feed, symbol, price, source_ts, received_at)
         VALUES ('twap30', 'btc/usd', '101000', $1, $1),
                ('twap30', 'btc/usd', '100500', $2, $2)`,
        [
          new Date(t2.getTime() - 10_000),
          new Date(windowStart.getTime() - 30_000),
        ],
      );

      const estimator = createEstimator({
        pool,
        config: DEFAULT_FUNDAMENTAL_CONFIG,
        gitSha: GIT_SHA,
        clock: () => t2,
      });
      const report = await estimator.runCycle();
      expect(report.shadowRows).toBeGreaterThan(0);

      const shadowRows = await pool.query<Record<string, unknown>>(
        `SELECT token_id, model_version, feature_set_version,
                data_refs->>'form' AS form, data_refs->>'strike' AS strike,
                data_refs->>'direction' AS direction, fallback_reason
           FROM fundamental_estimates
          WHERE status = 'shadow' AND token_id = ANY($1::text[])
          ORDER BY token_id, model_version`,
        [[UPDOWN_UP, UPDOWN_DOWN, BARRIER_YES, BARRIER_NO]],
      );
      // Exactly one shadow row per token, all from 1.1.0: the terminal-only
      // 1.0.0 abstained on both new forms, and abstention writes no row.
      expect(shadowRows.rowCount).toBe(4);
      for (const row of shadowRows.rows) {
        expect(row.model_version).toBe("1.1.0");
        expect(row.feature_set_version).toBe("1.1.0");
      }
      const updownRow = shadowRows.rows.find(
        (row) => row.token_id === UPDOWN_UP,
      );
      expect(updownRow?.form).toBe("updown");
      expect(updownRow?.direction).toBe("up");
      // The strike is the recorded feed at the window open — not the current
      // level, not the question (which has no strike at all).
      expect(Number(updownRow?.strike)).toBe(100_500);
      const barrierRow = shadowRows.rows.find(
        (row) => row.token_id === BARRIER_YES,
      );
      expect(barrierRow?.form).toBe("barrier");
      expect(barrierRow?.direction).toBe("touch_up");
      expect(Number(barrierRow?.strike)).toBe(102_000);

      // The consumer keeps reading the baseline: nothing serves from shadow.
      const consumerRows = await pool.query<Record<string, unknown>>(
        `SELECT source, fallback_reason FROM fundamental_estimates
          WHERE status = 'active' AND decision_ts = $1
            AND token_id = ANY($2::text[])`,
        [t2, [UPDOWN_UP, UPDOWN_DOWN, BARRIER_YES, BARRIER_NO]],
      );
      expect(consumerRows.rowCount).toBe(4);
      for (const row of consumerRows.rows) {
        expect(row.source).toBe("MARKET_BASELINE");
        expect(row.fallback_reason).toBe("MODEL_IN_SHADOW");
      }
    });

    it("keeps the database constraints as the last line of defence", async () => {
      // A MODEL row without provenance must be impossible even by direct SQL.
      await expect(
        pool.query(
          `INSERT INTO fundamental_estimates
           (market_id, token_id, category, decision_ts, q, q_lo, q_hi, source,
            status, interval_version, microprice_version)
         VALUES ($1, $2, 'crypto_updown', now(), '0.500000', '0.400000',
                 '0.600000', 'MODEL', 'shadow', '1.0.0', '1.0.0')`,
          [CONDITION_ID, TOKEN_YES],
        ),
      ).rejects.toThrow(/fundamental_estimates_model_provenance/);

      // And an inverted interval must be impossible too.
      await expect(
        pool.query(
          `INSERT INTO fundamental_estimates
           (market_id, token_id, category, decision_ts, q, q_lo, q_hi, source,
            status, data_refs, fallback_reason, interval_version, microprice_version)
         VALUES ($1, $2, 'crypto_updown', now(), '0.500000', '0.600000',
                 '0.400000', 'MARKET_BASELINE', 'active', '{}', 'NO_ACTIVE_MODEL',
                 '1.0.0', '1.0.0')`,
          [CONDITION_ID, TOKEN_YES],
        ),
      ).rejects.toThrow(/fundamental_estimates_interval_ordered/);
    });
  },
);
