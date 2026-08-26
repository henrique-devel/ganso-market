// RFC-013 against a real PostgreSQL. Skipped in the source-only gate; point
// GANSO_TEST_DATABASE_URL at a migrated throwaway database to run it.
//
// Why this file exists as well as the unit suites: every store function here is
// SQL, and SQL only type-checks against a server. A fake pool that answers by
// substring will happily accept `members_json ?| $1::text[]` with the wrong
// operand type, a `#>>` path into a column that is not JSONB, or a `count(*)
// FILTER` the planner would reject. Those failures would first appear in
// production, on the boot of a new service.
//
// It also proves the two invariants the migration owns and the unit tests
// cannot: the decision log refuses a look-ahead row, and a gate measurement is
// immutable once written.

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { QueryResult } from "../../../src/database.js";
import {
  closeBreaker,
  entryProvenanceFor,
  lastExitSignature,
  loadCorrelatedMarkets,
  loadMarketChangeStates,
  loadMidsAsOf,
  loadOpenBreakers,
  loadOpenPositions,
  loadPaperPnl,
  macroCatalystInWindow,
  openBreaker,
} from "../../../src/polymarket/portfolio/exitstore.js";
import {
  applyClockReset,
  insertGateMeasurement,
  loadClosedPositions,
  loadConfigVersions,
  loadFillReconciliationRows,
  loadForecastRows,
  loadG2Clocks,
  loadOperationalEvidence,
  loadOwnerApproval,
  loadRecentDecisions,
  loadRegimeParamsByCategory,
  loadRiskSurvival,
} from "../../../src/polymarket/portfolio/gatestore.js";
import {
  DEFAULT_PORTFOLIO_CONFIG,
  portfolioConfigHash,
} from "../../../src/polymarket/portfolio/config.js";
import { DEFAULT_FACTOR_MAP } from "../../../src/polymarket/portfolio/factors.js";
import { createPortfolioRunner } from "../../../src/polymarket/portfolio/runner.js";
import {
  ensureConfigVersion,
  insertDecision,
  loadEligibleMarkets,
} from "../../../src/polymarket/portfolio/store.js";
import { replayAudit } from "../../../src/polymarket/portfolio/replay.js";
import type { PortfolioPool } from "../../../src/polymarket/portfolio/types.js";

const DATABASE_URL = process.env.GANSO_TEST_DATABASE_URL;
const RUN = `${String(process.pid)}-${String(Date.now())}`;
const CONDITION = `0xpg-${RUN}`;
const TOKEN = `tok-pg-${RUN}`;
const NOW = new Date("2026-08-26T12:00:00.000Z");
const CONFIG = DEFAULT_PORTFOLIO_CONFIG;

let raw: pg.Pool | null = null;

function pool(): PortfolioPool {
  const instance = raw;
  if (instance === null) {
    throw new Error("pool not initialised");
  }
  return {
    async query<R extends Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      const result = await instance.query<R>(
        text,
        params === undefined ? undefined : [...params],
      );
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
  };
}

async function seed(): Promise<void> {
  const p = pool();
  await p.query(
    `INSERT INTO polymarket_universe_log (condition_id, action, reason, at)
     VALUES ($1, 'enter', 'integration_fixture', $2)`,
    [CONDITION, new Date("2026-08-01T00:00:00.000Z")],
  );
  await p.query(
    `INSERT INTO polymarket_market_metadata_versions
       (condition_id, version, question, category, clob_token_ids,
        affirmative_token_id, valid_from)
     VALUES ($1, 1, $2, 'crypto', $3::jsonb, $4, $5)`,
    [
      CONDITION,
      "Will BTC be above $88,000?",
      JSON.stringify([TOKEN, `${TOKEN}-no`]),
      TOKEN,
      new Date("2026-08-01T00:00:00.000Z"),
    ],
  );
  await p.query(
    `INSERT INTO polymarket_rule_versions
       (condition_id, version, content_hash, description, resolution_source,
        resolved_by, end_date, valid_from)
     VALUES ($1, 1, $2, $3, NULL, 'UMA:0xadapter', $4, $5)`,
    [
      CONDITION,
      "b".repeat(64),
      "  Resolves YES if BTC closes above\n  $88,000 on the reference feed.  ",
      new Date("2026-08-28T12:00:00.000Z"),
      new Date("2026-08-01T00:00:00.000Z"),
    ],
  );
  await p.query(
    `INSERT INTO polymarket_param_versions
       (condition_id, version, content_hash, fee_base_bps, maker_fee_bps,
        taker_fee_bps, tick_size, min_order_size, neg_risk, valid_from)
     VALUES ($1, 1, $2, '700', '0', '700', '0.01', '5', FALSE, $3)`,
    [CONDITION, "c".repeat(64), new Date("2026-08-01T00:00:00.000Z")],
  );
  await p.query(
    `INSERT INTO polymarket_events (event_id, title) VALUES ($1, 'evt')
     ON CONFLICT (event_id) DO NOTHING`,
    [`evt-${RUN}`],
  );
  await p.query(
    `INSERT INTO polymarket_event_markets (event_id, condition_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [`evt-${RUN}`, CONDITION],
  );
  await p.query(
    `INSERT INTO polymarket_book_snapshots
       (token_id, condition_id, received_at, bids_json, asks_json)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [
      TOKEN,
      CONDITION,
      new Date("2026-08-26T11:59:58.000Z"),
      JSON.stringify([{ price: "0.61", size: "500" }]),
      JSON.stringify([{ price: "0.62", size: "300" }]),
    ],
  );
  await p.query(
    `INSERT INTO paper_positions
       (token_id, condition_id, shares, cost_usd, realized_pnl_usd, opened_at,
        mark_value_usd, mark_stale)
     VALUES ($1, $2, '100', '50', '0', $3, '60', FALSE)`,
    [TOKEN, CONDITION, new Date("2026-08-25T12:00:00.000Z")],
  );
  await p.query(
    `INSERT INTO resolution_market_state
       (condition_id, action, effective_action, resolution_buffer, p_5050,
        expected_lockup_s, dispute_active, computed_at)
     VALUES ($1, 'NONE', 'NONE', '0.001000', '0.010000', 3600, FALSE, $2)`,
    [CONDITION, new Date("2026-08-26T11:30:00.000Z")],
  );
  // An estimate confident enough to clear the lower-bound criterion, so the
  // panel cycle exercises the sizing path and not only a rejection.
  await p.query(
    `INSERT INTO fundamental_estimates
       (market_id, token_id, category, decision_ts, q, q_lo, q_hi, source,
        status, market_prob, fallback_reason, data_refs, interval_version,
        microprice_version)
     VALUES ($1, $2, 'crypto', $3, '0.800000', '0.750000', '0.850000',
             'MARKET_BASELINE', 'active', '0.615000', 'no_promoted_model',
             '{}'::jsonb, '1.0.0', '1.0.0')`,
    [CONDITION, TOKEN, new Date("2026-08-26T11:59:30.000Z")],
  );
  await p.query(
    `INSERT INTO graph_edges
       (edge_key, kind, from_condition_id, to_condition_id, origin, confidence)
     VALUES ($1, 'IMPLIES', $2, $3, 'structural', '0.900000')`,
    [`edge-${RUN}`, CONDITION, `${CONDITION}-sibling`],
  );
  await ensureConfigVersion(p, {
    version: CONFIG.version,
    configHash: portfolioConfigHash(CONFIG),
    content: CONFIG,
    validFrom: NOW,
  });
}

beforeAll(async () => {
  if (DATABASE_URL === undefined) {
    return;
  }
  raw = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  await seed();
});

afterAll(async () => {
  await raw?.end();
  raw = null;
});

describe.skipIf(DATABASE_URL === undefined)(
  "RFC-013 store layer against real PostgreSQL",
  () => {
    it("loads the eligible universe with the rule text and the fee schedule", async () => {
      const markets = await loadEligibleMarkets(pool(), NOW);
      const market = markets.find((row) => row.conditionId === CONDITION);
      expect(market).toBeDefined();
      expect(market?.tokenId).toBe(TOKEN);
      expect(market?.takerFeeBps).toBe("700");
      expect(market?.ruleDescription).toContain("Resolves YES");
      // The RFC caps by resolutionSource/oracle, and Gamma populates almost no
      // resolutionSource: the COALESCE onto the adapter is what makes the cap
      // mean anything.
      expect(market?.resolutionSource).toBe("UMA:0xadapter");
    });

    it("loads open positions with the metadata the exit cycle needs", async () => {
      const positions = await loadOpenPositions(pool());
      const position = positions.find((row) => row.tokenId === TOKEN);
      expect(position?.affirmativeTokenId).toBe(TOKEN);
      expect(position?.category).toBe("crypto");
      expect(position?.ruleVersion).toBe(1);
      expect(position?.endDate).toBeInstanceOf(Date);
    });

    it("reads the paper PnL, taking cost over a missing mark", async () => {
      const pnl = await loadPaperPnl(pool());
      // The seeded position has a fresh mark of 60 against a cost of 50.
      expect(pnl.openCostScaled).toBeGreaterThan(0n);
      expect(pnl.openMarkScaled).toBeGreaterThanOrEqual(pnl.openCostScaled);
      expect(pnl.positionsWithStaleMark).toBe(0);
    });

    it("batches the market change state in one grouped scan", async () => {
      const states = await loadMarketChangeStates(pool(), [
        CONDITION,
        `${CONDITION}-absent`,
      ]);
      expect(states.size).toBe(2);
      expect(states.get(CONDITION)?.paramChangedAt).toBeInstanceOf(Date);
      // No clarification and no RFC-012 score for this market yet.
      expect(states.get(CONDITION)?.clarifiedAt).toBeNull();
      expect(states.get(CONDITION)?.rulePrecisionScaled).toBeNull();
    });

    it("finds correlated markets through the logical graph", async () => {
      const related = await loadCorrelatedMarkets(pool(), [CONDITION]);
      expect(related.get(CONDITION)).toEqual([`IMPLIES:${CONDITION}-sibling`]);
    });

    it("reads mids as of an instant, for the jump breaker", async () => {
      const mids = await loadMidsAsOf(pool(), [TOKEN], NOW);
      expect(mids.get(TOKEN)).toBeDefined();
      const earlier = await loadMidsAsOf(
        pool(),
        [TOKEN],
        new Date("2026-08-26T11:00:00.000Z"),
      );
      // As-of really means as-of: a book recorded later is not visible earlier.
      expect(earlier.get(TOKEN)).toBeUndefined();
    });

    it("answers the macro catalyst window", async () => {
      const present = await macroCatalystInWindow(
        pool(),
        new Date("2026-08-26T11:00:00.000Z"),
        NOW,
      );
      expect(typeof present).toBe("boolean");
    });

    it("opens, lists and closes a circuit breaker", async () => {
      await openBreaker(
        pool(),
        {
          kind: "DATA_STALENESS",
          scope: "token",
          conditionId: CONDITION,
          tokenId: TOKEN,
          detail: { book_age_ms: 45_000 },
        },
        NOW,
      );
      const open = await loadOpenBreakers(pool());
      const mine = open.find((row) => row.tokenId === TOKEN);
      expect(mine?.kind).toBe("DATA_STALENESS");
      // A token-scoped breaker keeps its condition_id: the market is what an
      // operator looks it up by, and the migration's CHECK allows both.
      expect(mine?.conditionId).toBe(CONDITION);
      await closeBreaker(pool(), mine?.breakerId ?? 0, NOW);
      const after = await loadOpenBreakers(pool());
      expect(after.find((row) => row.tokenId === TOKEN)).toBeUndefined();
    });

    it("writes a decision the log accepts, and reads it back for replay", async () => {
      const decisionId = await insertDecision(pool(), {
        kind: "EXIT",
        conditionId: CONDITION,
        tokenId: TOKEN,
        marketSide: "YES",
        orderSide: "SELL",
        decisionTs: NOW,
        q: "0.700000",
        qLo: "0.660000",
        qHi: "0.740000",
        estimateSource: "MODEL",
        execPrice: "0.608000",
        worstPrice: null,
        bestPrice: "0.610000",
        feeExpected: null,
        slippage: null,
        capitalCost: null,
        resolutionBuffer: null,
        costsTotal: null,
        safetyMargin: null,
        edgeGross: null,
        edgeNet: "0.052000",
        sizeShares: null,
        kellyCapShares: null,
        notionalUsd: null,
        bindingConstraint: "NOT_SIZED",
        limiters: [],
        configVersion: CONFIG.version,
        configHash: portfolioConfigHash(CONFIG),
        factorMapVersion: "1.0.0",
        ruleVersion: 1,
        paramVersion: 1,
        resolutionScoreVersion: null,
        resolutionAction: "NONE",
        oldestInputTs: new Date("2026-08-26T11:30:00.000Z"),
        newestInputTs: new Date("2026-08-26T11:59:58.000Z"),
        book: { token_id: TOKEN, bids: [], asks: [], recorded_at: null },
        inputs: {
          exit: { signature: "hold", signals: [] },
          replay: { engine: "planExit", shares: "100.000000000" },
        },
        outcome: "REJECTED",
        reasonCode: "HOLD_NO_EXIT_SIGNAL",
        portfolioState: "NORMAL",
      });
      expect(decisionId).toBeGreaterThan(0);

      const signature = await lastExitSignature(pool(), TOKEN);
      expect(signature).toBe("hold");

      const recent = await loadRecentDecisions(pool(), 5);
      const mine = recent.find((row) => row.decisionId === decisionId);
      expect(mine?.decisionKind).toBe("EXIT");
      // The JSONB round trip has to survive: the replay reads these.
      expect(
        (mine?.inputs as { replay: { engine: string } }).replay.engine,
      ).toBe("planExit");
    });

    it("REFUSES a decision whose newest input postdates it", async () => {
      // The migration's look-ahead CHECK, exercised. No amount of care in the
      // runner replaces it.
      await expect(
        insertDecision(pool(), {
          kind: "ENTRY",
          conditionId: CONDITION,
          tokenId: TOKEN,
          marketSide: "YES",
          orderSide: "BUY",
          decisionTs: NOW,
          q: null,
          qLo: null,
          qHi: null,
          estimateSource: null,
          execPrice: null,
          worstPrice: null,
          bestPrice: null,
          feeExpected: null,
          slippage: null,
          capitalCost: null,
          resolutionBuffer: null,
          costsTotal: null,
          safetyMargin: null,
          edgeGross: null,
          edgeNet: null,
          sizeShares: null,
          kellyCapShares: null,
          notionalUsd: null,
          bindingConstraint: "NOT_SIZED",
          limiters: [],
          configVersion: CONFIG.version,
          configHash: portfolioConfigHash(CONFIG),
          factorMapVersion: "1.0.0",
          ruleVersion: null,
          paramVersion: null,
          resolutionScoreVersion: null,
          resolutionAction: null,
          oldestInputTs: NOW,
          // AFTER the decision.
          newestInputTs: new Date(NOW.getTime() + 60_000),
          book: {},
          inputs: {},
          outcome: "REJECTED",
          reasonCode: "NO_BOOK",
          portfolioState: "NORMAL",
        }),
      ).rejects.toThrow(/no_lookahead/i);
    });

    it("finds the entry provenance an exit compares against", async () => {
      await insertDecision(pool(), {
        kind: "ENTRY",
        conditionId: CONDITION,
        tokenId: TOKEN,
        marketSide: "YES",
        orderSide: "BUY",
        decisionTs: new Date("2026-08-25T12:00:00.000Z"),
        q: "0.700000",
        qLo: "0.650000",
        qHi: "0.750000",
        estimateSource: "MODEL",
        execPrice: "0.500000",
        worstPrice: "0.500000",
        bestPrice: "0.500000",
        feeExpected: "0.000000",
        slippage: "0.000000",
        capitalCost: "0.000000",
        resolutionBuffer: "0.001000",
        costsTotal: "0.001000",
        safetyMargin: "0.037250",
        edgeGross: "0.200000",
        edgeNet: "0.149000",
        sizeShares: "20.000000",
        kellyCapShares: "40.000000",
        notionalUsd: "10.000000",
        bindingConstraint: "CAP_ENTRADA",
        limiters: [{ constraint: "CAP_ENTRADA", max_shares: "20.000000" }],
        configVersion: CONFIG.version,
        configHash: portfolioConfigHash(CONFIG),
        factorMapVersion: "1.0.0",
        ruleVersion: 1,
        paramVersion: 1,
        resolutionScoreVersion: null,
        resolutionAction: "NONE",
        oldestInputTs: new Date("2026-08-25T11:00:00.000Z"),
        newestInputTs: new Date("2026-08-25T11:59:00.000Z"),
        book: { token_id: TOKEN, bids: [], asks: [], recorded_at: null },
        inputs: {
          panel: {
            resolution_source: "UMA:0xadapter",
            invalidation: { prob_lower_below: "0.501000" },
          },
          replay: { rule_precision_multiplier: 0.9 },
        },
        outcome: "ACCEPTED",
        reasonCode: null,
        portfolioState: "NORMAL",
      });
      const entry = await entryProvenanceFor(pool(), TOKEN);
      expect(entry?.marketSide).toBe("YES");
      expect(entry?.resolutionSource).toBe("UMA:0xadapter");
      expect(entry?.invalidationProbLowerBelowScaled).toBe(501_000_000n);
      // 0.9 scaled to the working scale.
      expect(entry?.rulePrecisionScaled).toBe(900_000_000n);
    });

    it("runs every gate input query without a type error", async () => {
      const p = pool();
      // The point of this test is that each of these is real SQL against real
      // columns; a fake pool cannot fail any of them.
      await expect(loadForecastRows(p)).resolves.toBeInstanceOf(Array);
      await expect(loadClosedPositions(p)).resolves.toBeInstanceOf(Array);
      await expect(loadFillReconciliationRows(p, 10)).resolves.toBeInstanceOf(
        Array,
      );
      const risk = await loadRiskSurvival(p);
      // Not asserted as zero: this database is shared with the other
      // integration suites, whose positions and exposures are also in it. What
      // matters here is that the query runs and returns a count.
      expect(risk.unblockedBreaches).toBeGreaterThanOrEqual(0);
      expect(risk.breakersExercised).toContain("DATA_STALENESS");
      const operational = await loadOperationalEvidence(p, NOW);
      expect(operational.soakDays).toBeGreaterThanOrEqual(0);
      expect(operational.killSwitchExercised).toBe(false);
      const params = await loadRegimeParamsByCategory(p);
      expect(params.crypto?.length).toBeGreaterThan(0);
      const approval = await loadOwnerApproval(p);
      expect(approval.approval).toBeNull();
    });

    it("starts and resets the G2 clock, keeping the event trail", async () => {
      const category = `crypto-${RUN}`;
      await applyClockReset(pool(), {
        category,
        previousStart: null,
        newStart: new Date("2026-06-01T00:00:00.000Z"),
        previousFingerprint: null,
        newFingerprint: "d".repeat(64),
        reason: "clock_started",
      });
      await applyClockReset(pool(), {
        category,
        previousStart: new Date("2026-06-01T00:00:00.000Z"),
        newStart: NOW,
        previousFingerprint: "d".repeat(64),
        newFingerprint: "e".repeat(64),
        reason: "regime_fingerprint_changed",
      });
      const clocks = await loadG2Clocks(pool());
      const clock = clocks.find((row) => row.category === category);
      expect(clock?.clockStart).toEqual(NOW);
      expect(clock?.regimeFingerprint).toBe("e".repeat(64));
      const events = await pool().query<{ count: string }>(
        `SELECT count(*) AS count FROM portfolio_g2_clock_events
          WHERE category = $1`,
        [category],
      );
      // Both resets are on record: a 60-day clock and a clock reset three times
      // must not look the same.
      expect(Number(events.rows[0]?.count)).toBe(2);
    });

    it("writes an IMMUTABLE gate measurement", async () => {
      await insertGateMeasurement(pool(), {
        measurement: {
          gate: "G2",
          status: "INSUFFICIENT_DATA",
          reasonCode: "G2_INSUFFICIENT_PAPER",
          metrics: { days: 0, shortfalls: { days: { have: 0, need: 60 } } },
          windowFrom: null,
          windowTo: NOW,
        },
        configVersion: CONFIG.version,
        measuredAt: NOW,
      });
      const stored = await pool().query<{ measurement_id: string }>(
        `SELECT measurement_id FROM portfolio_gate_measurements
          ORDER BY measurement_id DESC LIMIT 1`,
      );
      const id = stored.rows[0]?.measurement_id;
      await expect(
        pool().query(
          `UPDATE portfolio_gate_measurements SET status = 'PASS'
            WHERE measurement_id = $1`,
          [id],
        ),
      ).rejects.toThrow(/immutable/i);
    });

    it("reads back the stored config so a replay uses the right parameters", async () => {
      const versions = await loadConfigVersions(pool(), [
        CONFIG.version,
        "does-not-exist",
      ]);
      expect(versions.size).toBe(1);
      expect(portfolioConfigHash(versions.get(CONFIG.version)!)).toBe(
        portfolioConfigHash(CONFIG),
      );
    });

    // -----------------------------------------------------------------------
    // The three jobs, driven against the real schema.
    // -----------------------------------------------------------------------

    it("runs the panel cycle end to end and writes what it decided", async () => {
      const runner = createPortfolioRunner({
        pool: pool(),
        config: CONFIG,
        factorMap: DEFAULT_FACTOR_MAP,
        executionMode: "paper",
        clock: () => NOW,
      });
      await runner.tickOnce("panel");

      const state = await pool().query<{ state: string; equity_usd: string }>(
        `SELECT state, equity_usd FROM portfolio_state WHERE portfolio_id = 1`,
      );
      expect(state.rows[0]?.state).toBe("NORMAL");

      const exposures = await pool().query<{
        dimension: string;
        unwind_cost_usd: string | null;
      }>(
        `SELECT dimension, unwind_cost_usd FROM portfolio_exposures
          ORDER BY dimension`,
      );
      // Every dimension the RFC names, plus the reported total.
      expect(exposures.rows.length).toBeGreaterThanOrEqual(7);
      // The unwind cost is a real book-walk over the seeded position, not null.
      expect(exposures.rows.some((row) => row.unwind_cost_usd !== null)).toBe(
        true,
      );

      const panel = await pool().query<{ panel_json: unknown }>(
        `SELECT panel_json FROM portfolio_panel_snapshots
          WHERE token_id = $1 ORDER BY computed_at DESC LIMIT 1`,
        [TOKEN],
      );
      const fields = panel.rows[0]?.panel_json as Record<string, unknown>;
      // The seeded estimate clears the lower-bound criterion, so this is a
      // SIZED entry and not a rejection with an empty panel.
      const decision = await pool().query<{
        decision_kind: string;
        outcome: string;
        reason_code: string | null;
        exec_price: string;
        edge_net: string;
        safety_margin: string;
        costs_total: string;
        size_shares: string;
        binding_constraint: string;
        entry_reason: string | null;
      }>(
        `SELECT decision_kind, outcome, reason_code, exec_price, edge_net,
                safety_margin, costs_total, size_shares, binding_constraint,
                inputs_json #>> '{panel,entry_reason}' AS entry_reason
           FROM portfolio_decisions
          WHERE token_id = $1 AND decision_ts = $2
          ORDER BY decision_id DESC LIMIT 1`,
        [TOKEN, NOW],
      );
      const row = decision.rows[0];
      expect(row?.decision_kind).toBe("ENTRY");

      // The economics, which do not depend on what else is in this shared
      // database. Book-walk over the recorded ask, never a midpoint:
      expect(row?.exec_price).toBe("0.620000");
      // q_lo 0.750000 - 0.620000 = 0.130000, less costs 0.001000.
      expect(row?.costs_total).toBe("0.001000");
      expect(row?.edge_net).toBe("0.129000");
      // max($0.01, 25% of the gross edge on the LOWER bound).
      expect(row?.safety_margin).toBe("0.032500");
      // The RFC's central invariant, cleared on the lower bound and not the
      // mean, with the reason written out.
      expect(row?.entry_reason).toContain("limite inferior 0.750000 supera");

      // The sizing outcome DOES depend on the caps, and the caps are consumed
      // by every open position in this database — including the one this
      // fixture seeds, whose $50 cost is exactly the 5% cap_mercado of the
      // $1,000 notional bankroll. So the honest assertion is that the decision
      // is internally consistent: either sized and accepted, or refused with
      // the cap that refused it named.
      if (row?.outcome === "ACCEPTED") {
        expect(Number(row.size_shares)).toBeGreaterThan(0);
        expect(row.binding_constraint).not.toBe("NOT_SIZED");
        expect(row.reason_code).toBeNull();
      } else {
        expect(row?.reason_code).toBe("CAP_EXHAUSTED");
        expect(row?.binding_constraint).toMatch(/^CAP_/);
        expect(row?.size_shares).toBe("0.000000");
      }

      // Fields 9, 10 and 12 of task 6, which were null before this phase.
      expect(fields.resolution_source).toBe("UMA:0xadapter");
      expect(fields.rule_excerpt).toContain("Resolves YES");
      expect(fields.correlated_markets).toEqual([
        `IMPLIES:${CONDITION}-sibling`,
      ]);
      expect(fields.invalidation).toBeDefined();
      // The worst case is always total loss. There is no stop that changes it.
      expect((fields.scenarios as Record<string, unknown>).worst).toBe(
        "perda total da posição",
      );
    });

    it("runs the exit cycle and the replay of what it wrote agrees", async () => {
      const runner = createPortfolioRunner({
        pool: pool(),
        config: CONFIG,
        factorMap: DEFAULT_FACTOR_MAP,
        executionMode: "paper",
        clock: () => new Date(NOW.getTime() + 60_000),
      });
      await runner.tickOnce("exits");

      const decisions = await loadRecentDecisions(pool(), 20);
      const exits = decisions.filter((row) => row.decisionKind === "EXIT");
      expect(exits.length).toBeGreaterThan(0);

      // The mandatory replay, over rows that actually round-tripped through
      // PostgreSQL: JSONB, numerics and timestamps included.
      const configs = await loadConfigVersions(
        pool(),
        decisions.map((row) => row.configVersion),
      );
      const audit = replayAudit({ decisions, configByVersion: configs });
      const unexplained = audit.mismatched.filter(
        (outcome) => outcome.failure !== "NO_REPLAY_BLOCK",
      );
      expect(unexplained).toEqual([]);
      expect(audit.matched).toBeGreaterThan(0);
    });

    it("runs the gate cycle and records six immutable measurements", async () => {
      const runner = createPortfolioRunner({
        pool: pool(),
        config: CONFIG,
        factorMap: DEFAULT_FACTOR_MAP,
        executionMode: "paper",
        clock: () => new Date(NOW.getTime() + 120_000),
      });
      await runner.tickOnce("gates");

      const measured = await pool().query<{ gate: string; status: string }>(
        `SELECT DISTINCT ON (gate) gate, status
           FROM portfolio_gate_measurements
          WHERE measured_at = $1
          ORDER BY gate, measured_at DESC`,
        [new Date(NOW.getTime() + 120_000)],
      );
      expect(measured.rows.map((row) => row.gate)).toEqual([
        "G1",
        "G2",
        "G3",
        "G4",
        "G5",
        "G6",
      ]);
      // RFC-009 stays blocked: nothing here can pass a gate on an empty book.
      expect(measured.rows.every((row) => row.status !== "PASS")).toBe(true);
    });

    it("refuses to mint the same config version with different content", async () => {
      // The reproducibility gate the score_version incident of 2026-08-26 paid
      // for: a version name may never come to mean two parameter sets.
      await expect(
        ensureConfigVersion(pool(), {
          version: CONFIG.version,
          configHash: "f".repeat(64),
          content: { different: true },
          validFrom: NOW,
        }),
      ).rejects.toThrow(/CONTENT_MISMATCH/);
    });
  },
);
