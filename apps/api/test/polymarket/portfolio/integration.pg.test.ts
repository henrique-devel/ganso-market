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
  insertGateReport,
  loadClosedPositions,
  loadConfigVersions,
  loadFillReconciliationRows,
  loadGateReport,
  loadLatestGateReport,
  recordOwnerApproval,
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
import { DEFAULT_RESOLUTION_LEXICON } from "../../../src/polymarket/resolution/lexicon.js";
import { createPortfolioRunner } from "../../../src/polymarket/portfolio/runner.js";
import {
  ensureConfigVersion,
  insertDecision,
  loadEligibleMarkets,
  stampBridgedOrders,
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
  // A SECOND, earlier snapshot, so the book the decision saw and the book the
  // fill consumed are two different recorded observations. With only one row
  // they would be the same line, and the G4 slippage reference would be the
  // simulator compared against itself.
  await p.query(
    `INSERT INTO polymarket_book_snapshots
       (token_id, condition_id, received_at, bids_json, asks_json)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [
      TOKEN,
      CONDITION,
      new Date("2026-08-26T11:58:00.000Z"),
      JSON.stringify([{ price: "0.60", size: "500" }]),
      JSON.stringify([{ price: "0.61", size: "300" }]),
    ],
  );
  await p.query(
    `INSERT INTO paper_positions
       (token_id, condition_id, shares, cost_usd, realized_pnl_usd, opened_at,
        mark_value_usd, mark_stale)
     VALUES ($1, $2, '100', '50', '0', $3, '60', FALSE)`,
    [TOKEN, CONDITION, new Date("2026-08-25T12:00:00.000Z")],
  );
  // One taker execution, written the way the RFC-011 ledger writes it: ONE
  // event per book level consumed. The G4 reconciliation has to put the order
  // back together before it can compare anything.
  await p.query(
    `INSERT INTO paper_orders
       (order_id, token_id, condition_id, side, order_type, limit_price, size,
        filled_size, post_only, worst_price, status, decided_at, accepted_at)
     VALUES ($1, $2, $3, 'BUY', 'FAK', '0.63', '150', '150', FALSE, '0.63',
             'filled', $4, $4)`,
    [`ord-${RUN}`, TOKEN, CONDITION, new Date("2026-08-26T11:59:00.000Z")],
  );
  for (const [index, fill] of [
    { price: "0.62", size: "100", fee: "0.500000" },
    { price: "0.63", size: "50", fee: "0.300000" },
  ].entries()) {
    await p.query(
      `INSERT INTO paper_ledger_events
         (idempotency_key, event_type, order_id, token_id, condition_id,
          payload_json, event_ts)
       VALUES ($1, 'fill', $2, $3, $4, $5::jsonb, $6)`,
      [
        `ord-${RUN}:taker:${String(index)}`,
        `ord-${RUN}`,
        TOKEN,
        CONDITION,
        JSON.stringify({ ...fill, side: "BUY", taker: true }),
        new Date("2026-08-26T12:00:05.000Z"),
      ],
    );
  }
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
      expect(Object.keys(params.crypto ?? {}).length).toBeGreaterThan(0);
      const approval = await loadOwnerApproval(p);
      // Not asserted as null, for the same reason the risk counts above are
      // not asserted as zero: this database is shared with the other suites
      // and with the report test below. What matters here is that the query
      // runs and comes back in the shape the gate reads.
      expect(
        approval.currentReportId === null || approval.currentReportId > 0,
      ).toBe(true);
    });

    it("reconciles a taker execution as ONE order, not as one row per level", async () => {
      // The ledger writes one `fill` event per level consumed. Comparing a
      // single level's price against a walk of that level's size from the top
      // of the book pits two different quantities against each other, and the
      // number means nothing whichever way it comes out.
      const rows = await loadFillReconciliationRows(pool(), 50);
      const mine = rows.find((row) => row.orderId === `ord-${RUN}`);
      expect(mine).toBeDefined();
      expect(mine?.side).toBe("BUY");
      // 100 @ 0.62 + 50 @ 0.63 = 150 shares, notional 93.5, VWAP 0.6233...
      expect(Number(mine?.filledSize)).toBeCloseTo(150, 6);
      expect(Number(mine?.vwapPrice)).toBeCloseTo(93.5 / 150, 9);
      expect(Number(mine?.simulatedFeeUsd)).toBeCloseTo(0.8, 6);
      // sum(p x (1 - p) x size), the venue curve with the RATE factored out, so
      // the real fee stays exact instead of being taken at the VWAP.
      expect(Number(mine?.feeShape)).toBeCloseTo(
        0.62 * 0.38 * 100 + 0.63 * 0.37 * 50,
        6,
      );
      // The two instants the slippage reference depends on: the fill consumed
      // the book at exec_ts, and the decision was made a minute earlier.
      expect(mine?.decidedAt.toISOString()).toBe("2026-08-26T11:59:00.000Z");
      expect(mine?.execTs.toISOString()).toBe("2026-08-26T12:00:05.000Z");
      // No recorded trade carries a fee rate in this fixture, so the fee leg
      // has no reference at all — which is the honest answer, not zero error.
      expect(mine?.venueFeeRateBps).toBeNull();

      // End to end, against the real book: the runner rebuilds the order from
      // its two fill events and walks the book of the DECISION instant — a
      // different recorded observation from the one the fill consumed.
      //
      // The two snapshots go in HERE rather than being taken from `seed`: this
      // database is shared, and a sibling suite that prunes book snapshots
      // would otherwise turn this assertion into a coin flip.
      for (const snapshot of [
        { at: "2026-08-26T11:58:30.000Z", bid: "0.60", ask: "0.61" },
        { at: "2026-08-26T11:59:59.000Z", bid: "0.61", ask: "0.62" },
      ]) {
        await pool().query(
          `INSERT INTO polymarket_book_snapshots
             (token_id, condition_id, received_at, bids_json, asks_json)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
          [
            TOKEN,
            CONDITION,
            new Date(snapshot.at),
            JSON.stringify([{ price: snapshot.bid, size: "500" }]),
            JSON.stringify([{ price: snapshot.ask, size: "500" }]),
          ],
        );
      }

      const slippageSamples = async (at: Date): Promise<number> => {
        await createPortfolioRunner({
          pool: pool(),
          config: CONFIG,
          factorMap: DEFAULT_FACTOR_MAP,
          lexicon: DEFAULT_RESOLUTION_LEXICON,
          executionMode: "paper",
          clock: () => at,
        }).tickOnce("gates");
        const measured = await pool().query<{
          metrics: Record<string, unknown>;
          status: string;
        }>(
          `SELECT metrics_json AS metrics, status
             FROM portfolio_gate_measurements
            WHERE gate = 'G4'
            ORDER BY measurement_id DESC
            LIMIT 1`,
        );
        const row = measured.rows[0];
        expect(row?.status).toBe("INSUFFICIENT_DATA");
        expect(row?.metrics.self_referential_slippage_samples).toBe(0);
        expect(row?.metrics.samples_required).toBe(
          CONFIG.gates.g4MinReconciledFills,
        );
        return Number(row?.metrics.slippage_samples ?? 0);
      };

      // The 150-share order reconciles.
      const before = await slippageSamples(new Date(NOW.getTime() + 600_000));
      expect(before).toBeGreaterThanOrEqual(1);

      // A SECOND execution, larger than the decision book could have filled.
      // Its reference walk is incomplete, so the reference VWAP covers fewer
      // shares and is therefore a BETTER price than the order deserved — a bias
      // toward "the simulator was conservative" that would mask a real
      // optimism. It has to contribute nothing, not a flattering sample.
      //
      // Asserted as a delta rather than an absolute count, because this
      // database is shared with earlier runs of this same suite.
      await pool().query(
        `INSERT INTO paper_orders
           (order_id, token_id, condition_id, side, order_type, limit_price,
            size, filled_size, post_only, worst_price, status, decided_at,
            accepted_at)
         VALUES ($1, $2, $3, 'BUY', 'FAK', '0.70', '900', '900', FALSE, '0.70',
                 'filled', $4, $4)`,
        [`deep-${RUN}`, TOKEN, CONDITION, new Date("2026-08-26T11:59:00.000Z")],
      );
      await pool().query(
        `INSERT INTO paper_ledger_events
           (idempotency_key, event_type, order_id, token_id, condition_id,
            payload_json, event_ts)
         VALUES ($1, 'fill', $2, $3, $4, $5::jsonb, $6)`,
        [
          `deep-${RUN}:taker:0`,
          `deep-${RUN}`,
          TOKEN,
          CONDITION,
          JSON.stringify({
            side: "BUY",
            price: "0.65",
            size: "900",
            fee: "1.000000",
            taker: true,
          }),
          new Date("2026-08-26T12:00:06.000Z"),
        ],
      );
      const after = await slippageSamples(new Date(NOW.getTime() + 660_000));
      expect(after).toBe(before);
    });

    it("mints a gate report and attaches the owner's review exactly once", async () => {
      const p = pool();
      const generatedAt = new Date(NOW.getTime() + 300_000);
      const reportId = await insertGateReport(p, {
        measurements: [
          {
            gate: "G2",
            status: "INSUFFICIENT_DATA",
            reasonCode: "G2_INSUFFICIENT_PAPER",
            metrics: { closed_positions: 0 },
            windowFrom: null,
            windowTo: generatedAt,
          },
        ],
        overall: "BLOCKED",
        fingerprint: "a".repeat(64),
        generatedAt,
        windowFrom: NOW,
        windowTo: generatedAt,
        configVersion: CONFIG.version,
      });
      expect(reportId).toBeGreaterThan(0);

      const stored = await loadGateReport(p, reportId);
      expect(stored?.fingerprint).toBe("a".repeat(64));
      expect(stored?.gates.map((entry) => entry.gate)).toEqual(["G2"]);
      expect(stored?.alreadyApproved).toBe(false);
      // The calibrated expectation travels with the numbers it was printed
      // beside, so the record of what was approved carries its own warning.
      const raw = await p.query<{ expectation: string }>(
        `SELECT gates_json ->> 'calibrated_expectation' AS expectation
           FROM portfolio_gate_reports WHERE report_id = $1`,
        [reportId],
      );
      expect(raw.rows[0]?.expectation).toContain("84%");

      expect(await loadLatestGateReport(p)).toMatchObject({ reportId });

      const review = {
        reviewed_at: generatedAt.toISOString(),
        reviewer: "owner",
        note: "Revisão escrita completa do relatório de gates registrada.",
      };
      expect(await recordOwnerApproval(p, { reportId, approval: review })).toBe(
        true,
      );
      // Second attempt on the same report: an approval is never edited in
      // place, and the statement carries its own guard rather than trusting
      // the check that ran before it.
      expect(await recordOwnerApproval(p, { reportId, approval: review })).toBe(
        false,
      );

      const loaded = await loadOwnerApproval(p);
      expect(loaded.currentReportId).toBe(reportId);
      expect(loaded.approval?.reviewer).toBe("owner");

      // A newer report makes the older one unapprovable, which is the whole
      // mechanism: a review carries only against the numbers it named.
      const newer = await insertGateReport(p, {
        measurements: [],
        overall: "BLOCKED",
        fingerprint: "b".repeat(64),
        generatedAt: new Date(NOW.getTime() + 360_000),
        windowFrom: NOW,
        windowTo: new Date(NOW.getTime() + 360_000),
        configVersion: CONFIG.version,
      });
      expect(newer).toBeGreaterThan(reportId);
      expect(await recordOwnerApproval(p, { reportId, approval: review })).toBe(
        false,
      );
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

    it("deletes the exposure rows the current book no longer produces", async () => {
      // The upsert alone leaves orphans behind, and they are not cosmetic:
      // loadRiskSurvival counts `utilization > 1` over EVERY row, so an orphan
      // above its cap would report an unblocked breach for the rest of the
      // system's life and pin G3 at FAIL on a position nobody holds.
      //
      // Observed in production 2026-09-02 01:14:48Z, when RFC-018 D2 changed
      // the key of the resolution_source dimension: the two adapter-keyed rows
      // froze there while the clause-family rows advanced.
      await pool().query(
        `INSERT INTO portfolio_exposures
           (dimension, dimension_key, worst_case_usd, cap_usd, utilization,
            position_count, computed_at, updated_at)
         VALUES ('resolution_source', $1, '900.000000', '250.000000',
                 '3.600000', 1, $2, $2)
         ON CONFLICT (dimension, dimension_key) DO NOTHING`,
        [`orphan-${RUN}`, new Date(NOW.getTime() - 3_600_000)],
      );

      await createPortfolioRunner({
        pool: pool(),
        config: CONFIG,
        factorMap: DEFAULT_FACTOR_MAP,
        lexicon: DEFAULT_RESOLUTION_LEXICON,
        executionMode: "paper",
        clock: () => NOW,
      }).tickOnce("panel");

      const orphan = await pool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM portfolio_exposures
          WHERE dimension_key = $1`,
        [`orphan-${RUN}`],
      );
      expect(orphan.rows[0]?.n).toBe("0");

      // ...and the cycle's own rows survived, so the delete is not a truncate.
      const live = await pool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM portfolio_exposures
          WHERE computed_at = $1`,
        [NOW],
      );
      expect(Number(live.rows[0]?.n)).toBeGreaterThanOrEqual(7);
    });

    it("opens UMA_PROPOSED_OR_DISPUTED on a live proposal over a held position", async () => {
      // RFC-018 item 3, the whole chain against the real schema: the resolution
      // module records a live proposal, the panel cycle reads it, and the
      // breaker the RFC-013 G3 requires finally has a row.
      //
      // It had a real chance and missed it before this: paper position
      // 0x71b5721c… was opened 2026-09-01 11:59:06Z and sat through a live UMA
      // proposal from 16:04:52Z to 16:14:48Z — ~10 panel cycles — in silence,
      // because the state row had nowhere to carry the proposal.
      await pool().query(
        `UPDATE resolution_market_state SET proposal_active = TRUE
          WHERE condition_id = $1`,
        [CONDITION],
      );
      try {
        await createPortfolioRunner({
          pool: pool(),
          config: CONFIG,
          factorMap: DEFAULT_FACTOR_MAP,
          lexicon: DEFAULT_RESOLUTION_LEXICON,
          executionMode: "paper",
          clock: () => NOW,
        }).tickOnce("panel");

        const breaker = await pool().query<{
          kind: string;
          scope: string;
          detail_json: Record<string, unknown>;
        }>(
          `SELECT kind, scope, detail_json FROM portfolio_circuit_breakers
            WHERE condition_id = $1 AND kind = 'UMA_PROPOSED_OR_DISPUTED'
              AND ended_at IS NULL`,
          [CONDITION],
        );
        expect(breaker.rows).toHaveLength(1);
        expect(breaker.rows[0]?.scope).toBe("market");
        expect(breaker.rows[0]?.detail_json.proposal_active).toBe(true);
        expect(breaker.rows[0]?.detail_json.dispute_active).toBe(false);
      } finally {
        // The proposal is transient; leaving it TRUE would freeze this market
        // for every test that runs after this one in the shared database.
        await pool().query(
          `UPDATE resolution_market_state SET proposal_active = FALSE
            WHERE condition_id = $1`,
          [CONDITION],
        );
        await pool().query(
          `UPDATE portfolio_circuit_breakers SET ended_at = $2
            WHERE condition_id = $1 AND kind = 'UMA_PROPOSED_OR_DISPUTED'
              AND ended_at IS NULL`,
          [CONDITION, NOW],
        );
      }
    });

    it("runs the panel cycle end to end and writes what it decided", async () => {
      const runner = createPortfolioRunner({
        pool: pool(),
        config: CONFIG,
        factorMap: DEFAULT_FACTOR_MAP,
        lexicon: DEFAULT_RESOLUTION_LEXICON,
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
        lexicon: DEFAULT_RESOLUTION_LEXICON,
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
        lexicon: DEFAULT_RESOLUTION_LEXICON,
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

      // And the cycle leaves a report behind, which is what gives a future G6
      // review an id to be written against.
      const report = await loadLatestGateReport(pool());
      expect(report?.gates.map((entry) => entry.gate)).toEqual([
        "G1",
        "G2",
        "G3",
        "G4",
        "G5",
        "G6",
      ]);
      expect(report?.overallStatus).toBe("BLOCKED");
    });

    it("stamps a bridged order and keeps the entry's thesis after the log is pruned", async () => {
      // The whole point of portfolio_position_entries, exercised end to end
      // against the real schema. A distinct token, so the other fixtures in this
      // file cannot supply the provenance by accident.
      const token = `${TOKEN}-bridge`;
      const decisionId = await insertDecision(pool(), {
        kind: "ENTRY",
        conditionId: CONDITION,
        tokenId: token,
        marketSide: "YES",
        orderSide: "BUY",
        decisionTs: NOW,
        q: "0.800000",
        qLo: "0.750000",
        qHi: "0.850000",
        estimateSource: "MARKET_BASELINE",
        execPrice: "0.620000",
        worstPrice: "0.620000",
        bestPrice: "0.620000",
        feeExpected: "0.000000",
        slippage: "0.000000",
        capitalCost: "0.000000",
        resolutionBuffer: "0.001000",
        costsTotal: "0.001000",
        safetyMargin: "0.010000",
        edgeGross: "0.130000",
        edgeNet: "0.119000",
        sizeShares: "20.000000",
        kellyCapShares: "40.000000",
        notionalUsd: "12.400000",
        bindingConstraint: "CAP_ENTRADA",
        limiters: [{ constraint: "CAP_ENTRADA", max_shares: "20.000000" }],
        configVersion: CONFIG.version,
        configHash: portfolioConfigHash(CONFIG),
        factorMapVersion: "1.0.0",
        ruleVersion: 1,
        paramVersion: 1,
        resolutionScoreVersion: null,
        resolutionAction: "NONE",
        oldestInputTs: new Date("2026-08-26T11:30:00.000Z"),
        newestInputTs: new Date("2026-08-26T11:59:58.000Z"),
        book: { token_id: token, bids: [], asks: [], recorded_at: null },
        inputs: {
          panel: {
            resolution_source: "UMA:0xadapter",
            invalidation: { prob_lower_below: "0.621000" },
          },
          // A JSON number, which is how the runner writes it: the stamp has to
          // put it in the canonical six-digit form the column accepts.
          replay: { rule_precision_multiplier: 0.9 },
        },
        outcome: "ACCEPTED",
        reasonCode: null,
        portfolioState: "NORMAL",
      });

      // What the bridge produces, written directly: this test is about the
      // portfolio half of the contract.
      const orderId = `portfolio:${String(decisionId)}`;
      await pool().query(
        `INSERT INTO paper_orders
           (order_id, token_id, condition_id, side, order_type, limit_price,
            size, post_only, source, status, decided_at, accepted_at,
            decision_id)
         VALUES ($1,$2,$3,'BUY','GTC','0.610000','20.000000',TRUE,'portfolio',
                 'open',$4,$4,$5)`,
        [orderId, token, CONDITION, NOW, decisionId],
      );

      const first = await stampBridgedOrders(pool());
      expect(first.stamped).toBeGreaterThanOrEqual(1);
      expect(first.entriesRecorded).toBeGreaterThanOrEqual(1);

      const stamped = await pool().query<{ paper_order_id: string | null }>(
        `SELECT paper_order_id FROM portfolio_decisions WHERE decision_id = $1`,
        [decisionId],
      );
      expect(stamped.rows[0]?.paper_order_id).toBe(orderId);

      // Idempotent: nothing left to do on the next cycle.
      const second = await stampBridgedOrders(pool());
      expect(second.stamped).toBe(0);
      expect(second.entriesRecorded).toBe(0);

      const before = await entryProvenanceFor(pool(), token);
      expect(before).toMatchObject({
        decisionId,
        marketSide: "YES",
        qLo: "0.750000",
        qHi: "0.850000",
        ruleVersion: 1,
        resolutionSource: "UMA:0xadapter",
      });
      // Scaled bigints at the project's 1e9 fixed point.
      expect(before?.invalidationProbLowerBelowScaled).toBe(621_000_000n);
      expect(before?.rulePrecisionScaled).toBe(900_000_000n);

      // THE regression. This is what the quota does to the decision log after
      // about three days, and what used to take four of the seven exit criteria
      // with it: with the entry gone, invalidation, model-move, source-change
      // and precision-downgrade all defaulted to "we do not know that it moved"
      // and could never fire again for this position.
      await pool().query(
        `DELETE FROM portfolio_decisions WHERE decision_id = $1`,
        [decisionId],
      );
      const afterPrune = await entryProvenanceFor(pool(), token);
      expect(afterPrune).not.toBeNull();
      expect(afterPrune?.qLo).toBe("0.750000");
      expect(afterPrune?.invalidationProbLowerBelowScaled).toBe(621_000_000n);
      expect(afterPrune?.rulePrecisionScaled).toBe(900_000_000n);
      expect(afterPrune?.resolutionSource).toBe("UMA:0xadapter");
      expect(afterPrune?.ruleVersion).toBe(1);
    });

    it("refuses to rewrite an entry's recorded thesis", async () => {
      // Immutable for the same reason the decision log is: a rewrite would let
      // today's opinion edit the past, and the exit criteria would be comparing
      // today against today.
      const rows = await pool().query<{ decision_id: string }>(
        `SELECT decision_id FROM portfolio_position_entries LIMIT 1`,
      );
      const id = rows.rows[0]?.decision_id;
      expect(id).toBeDefined();
      await expect(
        pool().query(
          `UPDATE portfolio_position_entries SET q_lo = '0.100000'
            WHERE decision_id = $1`,
          [id],
        ),
      ).rejects.toThrow(/immutable/);
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
