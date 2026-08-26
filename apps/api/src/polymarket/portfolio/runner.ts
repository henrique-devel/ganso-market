// RFC-013 runtime. Event-driven over data the recorder, estimator and
// resolution services already wrote — no external connection of its own.
//
// The runner does four things on a timer: refresh the portfolio state machine,
// recompute exposures, evaluate the universe into panel snapshots and decisions,
// and evaluate exits on open positions. Every one of them is idempotent, so a
// restart mid-cycle costs at most one cycle's work.

import { parseScaled, SCALE } from "../fundamental/fixed.js";
import { portfolioConfigHash, type PortfolioConfig } from "./config.js";
import { money } from "./ev.js";
import { evaluateMarket } from "./engine.js";
import {
  capHeadroomFor,
  computeExposures,
  type OpenPosition,
} from "./exposure.js";
import {
  assignFactor,
  catalystWindow,
  factorMapHash,
  type FactorMap,
} from "./factors.js";
import {
  bookAsOf,
  ensureConfigVersion,
  ensureFactorMapVersion,
  estimateAsOf,
  insertDecision,
  loadEligibleMarkets,
  resolutionStateFor,
} from "./store.js";
import {
  evaluateState,
  utcDayBucket,
  utcWeekStart,
  type PortfolioStateSnapshot,
} from "./state.js";
import { SIMULATION_BANNER, type PortfolioPool } from "./types.js";

export const PORTFOLIO_SERVICE = "polymarket-portfolio";

export class PortfolioScopeError extends Error {
  public readonly reasonCode: string;

  public constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "PortfolioScopeError";
    this.reasonCode = reasonCode;
  }
}

function logJson(
  level: "info" | "warn" | "error",
  reasonCode: string,
  extra: Record<string, unknown> = {},
): void {
  process.stderr.write(
    `${JSON.stringify({
      level,
      service: PORTFOLIO_SERVICE,
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      simulation: SIMULATION_BANNER,
      ...extra,
    })}\n`,
  );
}

export interface PortfolioRunnerDeps {
  readonly pool: PortfolioPool;
  readonly config: PortfolioConfig;
  readonly factorMap: FactorMap;
  readonly executionMode: string;
  readonly clock?: () => Date;
}

export interface PortfolioRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Exposed for tests and for the boot cycle. */
  cycleOnce(): Promise<{ evaluated: number; entrable: number }>;
}

const DEFAULT_STATE: Omit<PortfolioStateSnapshot, "dayBucket" | "weekStart"> = {
  state: "NORMAL",
  reason: null,
  bankrollScaled: 0n,
  highWaterMarkScaled: 0n,
  equityScaled: 0n,
  drawdownScaled: 0n,
  realizedPnlDayScaled: 0n,
  realizedPnlWeekScaled: 0n,
  reduceOnlyUntil: null,
  haltedAt: null,
  manualHalt: false,
};

function fractionScaled(value: number): bigint {
  return BigInt(Math.round(value * Number(SCALE)));
}

export function createPortfolioRunner(
  deps: PortfolioRunnerDeps,
): PortfolioRunner {
  const clock = deps.clock ?? ((): Date => new Date());
  const timers: ReturnType<typeof setInterval>[] = [];
  let running = false;

  // Last line of defence, mirroring the RFC-010/011/012 runners: this process
  // simulates, and refuses to boot in any other mode.
  if (deps.executionMode !== "paper") {
    throw new PortfolioScopeError(
      "EXECUTION_MODE_NOT_PAPER",
      "the portfolio engine runs only in paper mode",
    );
  }

  const configHash = portfolioConfigHash(deps.config);
  const mapHash = factorMapHash(deps.factorMap);

  async function loadState(now: Date): Promise<PortfolioStateSnapshot> {
    const result = await deps.pool.query<Record<string, unknown>>(
      `SELECT state, reason, bankroll_usd, high_water_mark_usd, equity_usd,
              drawdown, realized_pnl_day_usd, realized_pnl_week_usd,
              day_bucket, week_start, reduce_only_until, halted_at, manual_halt
         FROM portfolio_state WHERE portfolio_id = 1`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      return {
        ...DEFAULT_STATE,
        bankrollScaled: fractionScaled(deps.config.bankrollUsd),
        highWaterMarkScaled: fractionScaled(deps.config.bankrollUsd),
        equityScaled: fractionScaled(deps.config.bankrollUsd),
        dayBucket: utcDayBucket(now),
        weekStart: utcWeekStart(now),
      };
    }
    const scaled = (value: unknown): bigint =>
      parseScaled(String(value ?? "0")) ?? 0n;
    const state = String(row.state);
    return {
      state: state === "REDUCE_ONLY" || state === "HALTED" ? state : "NORMAL",
      reason:
        row.reason === null || row.reason === undefined
          ? null
          : String(row.reason),
      bankrollScaled: scaled(row.bankroll_usd),
      highWaterMarkScaled: scaled(row.high_water_mark_usd),
      equityScaled: scaled(row.equity_usd),
      drawdownScaled: scaled(row.drawdown),
      realizedPnlDayScaled: scaled(row.realized_pnl_day_usd),
      realizedPnlWeekScaled: scaled(row.realized_pnl_week_usd),
      dayBucket: String(row.day_bucket ?? utcDayBucket(now)).slice(0, 10),
      weekStart: String(row.week_start ?? utcWeekStart(now)).slice(0, 10),
      reduceOnlyUntil:
        row.reduce_only_until instanceof Date ? row.reduce_only_until : null,
      haltedAt: row.halted_at instanceof Date ? row.halted_at : null,
      manualHalt: row.manual_halt === true,
    };
  }

  async function persistState(
    next: PortfolioStateSnapshot,
    transition: {
      from: string;
      to: string;
      reason: string;
      triggerSource: string;
      detail: unknown;
    } | null,
  ): Promise<void> {
    await deps.pool.query(
      `INSERT INTO portfolio_state
         (portfolio_id, state, reason, bankroll_usd, high_water_mark_usd,
          equity_usd, drawdown, realized_pnl_day_usd, realized_pnl_week_usd,
          day_bucket, week_start, reduce_only_until, halted_at, manual_halt,
          config_version, updated_at)
       VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,CURRENT_TIMESTAMP)
       ON CONFLICT (portfolio_id) DO UPDATE SET
         state = EXCLUDED.state,
         reason = EXCLUDED.reason,
         bankroll_usd = EXCLUDED.bankroll_usd,
         high_water_mark_usd = EXCLUDED.high_water_mark_usd,
         equity_usd = EXCLUDED.equity_usd,
         drawdown = EXCLUDED.drawdown,
         realized_pnl_day_usd = EXCLUDED.realized_pnl_day_usd,
         realized_pnl_week_usd = EXCLUDED.realized_pnl_week_usd,
         day_bucket = EXCLUDED.day_bucket,
         week_start = EXCLUDED.week_start,
         reduce_only_until = EXCLUDED.reduce_only_until,
         halted_at = EXCLUDED.halted_at,
         manual_halt = EXCLUDED.manual_halt,
         config_version = EXCLUDED.config_version,
         updated_at = CURRENT_TIMESTAMP`,
      [
        next.state,
        next.reason,
        money(next.bankrollScaled),
        money(next.highWaterMarkScaled),
        money(next.equityScaled),
        money(next.drawdownScaled),
        money(next.realizedPnlDayScaled),
        money(next.realizedPnlWeekScaled),
        next.dayBucket,
        next.weekStart,
        next.reduceOnlyUntil,
        next.haltedAt,
        next.manualHalt,
        deps.config.version,
      ],
    );
    if (transition !== null) {
      await deps.pool.query(
        `INSERT INTO portfolio_state_events
           (from_state, to_state, reason, trigger_source, detail_json)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [
          transition.from,
          transition.to,
          transition.reason,
          transition.triggerSource,
          JSON.stringify(transition.detail),
        ],
      );
      logJson("info", "PORTFOLIO_STATE_CHANGED", {
        from: transition.from,
        to: transition.to,
        reason: transition.reason,
      });
    }
  }

  /**
   * Open paper positions, joined to the metadata the exposure dimensions need.
   * Read-only over the RFC-011 tables: this module never writes to them.
   */
  async function loadOpenPositions(now: Date): Promise<OpenPosition[]> {
    const result = await deps.pool.query<Record<string, unknown>>(
      `SELECT p.token_id, p.condition_id, p.shares, p.cost_usd,
              meta.category, meta.question,
              COALESCE(par.neg_risk, FALSE) AS neg_risk,
              ev.event_id,
              COALESCE(r.resolution_source, r.resolved_by) AS resolution_source,
              r.end_date,
              p.resolved_at
         FROM paper_positions p
         LEFT JOIN LATERAL (
           SELECT question, category FROM polymarket_market_metadata_versions v
            WHERE v.condition_id = p.condition_id AND v.valid_to IS NULL
            ORDER BY v.version DESC LIMIT 1
         ) meta ON TRUE
         LEFT JOIN LATERAL (
           SELECT neg_risk FROM polymarket_param_versions pv
            WHERE pv.condition_id = p.condition_id AND pv.valid_to IS NULL
            ORDER BY pv.version DESC LIMIT 1
         ) par ON TRUE
         LEFT JOIN LATERAL (
           SELECT resolution_source, resolved_by, end_date
             FROM polymarket_rule_versions rv
            WHERE rv.condition_id = p.condition_id AND rv.valid_to IS NULL
            ORDER BY rv.version DESC LIMIT 1
         ) r ON TRUE
         LEFT JOIN LATERAL (
           SELECT event_id FROM polymarket_event_markets em
            WHERE em.condition_id = p.condition_id ORDER BY em.event_id LIMIT 1
         ) ev ON TRUE
        WHERE p.shares <> '0'`,
    );
    void now;
    return result.rows.map((row) => {
      const conditionId = String(row.condition_id ?? "");
      const question = String(row.question ?? "");
      const category =
        row.category === null || row.category === undefined
          ? null
          : String(row.category);
      const eventId =
        row.event_id === null || row.event_id === undefined
          ? null
          : String(row.event_id);
      const negRisk = row.neg_risk === true;
      const factor = assignFactor(deps.factorMap, {
        conditionId,
        question,
        category,
        negRisk,
        eventId,
      });
      return {
        tokenId: String(row.token_id ?? ""),
        conditionId,
        sharesScaled: parseScaled(String(row.shares ?? "0")) ?? 0n,
        costScaled: parseScaled(String(row.cost_usd ?? "0")) ?? 0n,
        category,
        eventId,
        resolutionSource:
          row.resolution_source === null || row.resolution_source === undefined
            ? null
            : String(row.resolution_source),
        factor: factor.factor,
        catalystWindow: catalystWindow(
          row.end_date instanceof Date ? row.end_date : null,
        ),
        unresolved: row.resolved_at === null || row.resolved_at === undefined,
        unwindCostScaled: null,
        negRisk,
      };
    });
  }

  async function persistExposures(
    rows: ReturnType<typeof computeExposures>,
    now: Date,
  ): Promise<void> {
    for (const row of rows) {
      await deps.pool.query(
        `INSERT INTO portfolio_exposures
           (dimension, dimension_key, worst_case_usd, cap_usd, utilization,
            position_count, unwind_cost_usd, computed_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP)
         ON CONFLICT (dimension, dimension_key) DO UPDATE SET
           worst_case_usd = EXCLUDED.worst_case_usd,
           cap_usd = EXCLUDED.cap_usd,
           utilization = EXCLUDED.utilization,
           position_count = EXCLUDED.position_count,
           unwind_cost_usd = EXCLUDED.unwind_cost_usd,
           computed_at = EXCLUDED.computed_at,
           updated_at = CURRENT_TIMESTAMP`,
        [
          row.dimension,
          row.key,
          money(row.worstCaseScaled),
          money(row.capScaled),
          money(row.utilizationScaled),
          row.positionCount,
          row.unwindCostScaled === null ? null : money(row.unwindCostScaled),
          now,
        ],
      );
    }
  }

  async function cycleOnce(): Promise<{ evaluated: number; entrable: number }> {
    const now = clock();

    // 1. State machine over realized PnL and equity.
    const current = await loadState(now);
    const positions = await loadOpenPositions(now);
    const openCost = positions.reduce((sum, p) => sum + p.costScaled, 0n);
    const evaluation = evaluateState({
      now,
      current,
      limits: {
        perdaDiariaMaxScaled: fractionScaled(
          deps.config.lossLimits.perdaDiariaMax,
        ),
        perdaSemanalMaxScaled: fractionScaled(
          deps.config.lossLimits.perdaSemanalMax,
        ),
        drawdownMaxScaled: fractionScaled(deps.config.lossLimits.drawdownMax),
        reduceOnlyWeekDays: deps.config.lossLimits.reduceOnlyWeekDays,
      },
      bankrollBaseScaled: fractionScaled(deps.config.bankrollUsd),
      realizedPnlTotalScaled: 0n,
      realizedPnlDayScaled: current.realizedPnlDayScaled,
      realizedPnlWeekScaled: current.realizedPnlWeekScaled,
      // Marks come from the RFC-011 ledger; until a position exists the two
      // sides cancel, which is the honest value of an empty book.
      openMarkScaled: openCost,
      openCostScaled: openCost,
    });
    await persistState(evaluation.next, evaluation.transition);

    // 2. Exposures.
    const exposures = computeExposures({
      positions,
      bankrollScaled: evaluation.next.bankrollScaled,
      caps: deps.config.caps,
    });
    await persistExposures(exposures, now);

    // 3. Evaluate the universe.
    const markets = await loadEligibleMarkets(deps.pool, now);
    let entrable = 0;
    for (const market of markets) {
      const [estimate, resolution, book] = await Promise.all([
        estimateAsOf(deps.pool, market.tokenId, now),
        resolutionStateFor(deps.pool, market.conditionId),
        bookAsOf(deps.pool, market.tokenId, now),
      ]);
      const factor = assignFactor(deps.factorMap, {
        conditionId: market.conditionId,
        question: market.question,
        category: market.category,
        negRisk: market.negRisk,
        eventId: market.eventId,
      });
      const window = catalystWindow(market.endDate);
      const headroom = capHeadroomFor(
        exposures,
        {
          conditionId: market.conditionId,
          eventId: market.eventId,
          category: market.category,
          resolutionSource: market.resolutionSource,
          factor: factor.factor,
          catalystWindow: window,
        },
        evaluation.next.bankrollScaled,
        deps.config.caps,
      );

      const result = evaluateMarket({
        now,
        config: deps.config,
        conditionId: market.conditionId,
        tokenId: market.tokenId,
        question: market.question,
        category: market.category,
        q: estimate?.q ?? null,
        qLo: estimate?.qLo ?? null,
        qHi: estimate?.qHi ?? null,
        estimateSource:
          estimate === null
            ? null
            : estimate.source === "MODEL"
              ? "MODEL"
              : "MARKET_BASELINE",
        estimateAgeMs:
          estimate === null
            ? null
            : now.getTime() - estimate.decisionTs.getTime(),
        bids: book?.bids ?? [],
        asks: book?.asks ?? [],
        bookAgeMs:
          book === null ? null : now.getTime() - book.receivedAt.getTime(),
        resolutionAction: resolution?.action ?? null,
        resolutionBuffer: resolution?.resolutionBuffer ?? null,
        p5050: resolution?.p5050 ?? null,
        expectedLockupS: resolution?.expectedLockupS ?? 0,
        resolutionAgeMs:
          resolution?.computedAt == null
            ? null
            : now.getTime() - resolution.computedAt.getTime(),
        rulePrecisionMultiplier: 1,
        takerFeeRate: null,
        minOrderSize: market.minOrderSize,
        bufferDailyHurdle: 0.0005,
        portfolioState: evaluation.next.state,
        bankrollScaled: evaluation.next.bankrollScaled,
        capHeadroom: headroom,
        correlationMultiplier: Number(factor.multiplierScaled) / Number(SCALE),
        breakerOpen: false,
      });

      if (result.entrable) {
        entrable += 1;
      }

      const decisionId = await insertDecision(deps.pool, {
        kind: result.entrable ? "ENTRY" : result.vetoed ? "VETO" : "ENTRY",
        conditionId: market.conditionId,
        tokenId: market.tokenId,
        marketSide: result.best?.side ?? "YES",
        orderSide: result.best?.orderSide ?? "BUY",
        decisionTs: now,
        q: estimate?.q ?? null,
        qLo: estimate?.qLo ?? null,
        qHi: estimate?.qHi ?? null,
        estimateSource:
          estimate === null
            ? null
            : estimate.source === "MODEL"
              ? "MODEL"
              : "MARKET_BASELINE",
        execPrice:
          result.best === null ? null : money(result.best.ev.execPriceScaled),
        worstPrice:
          result.best === null ? null : money(result.best.ev.worstPriceScaled),
        bestPrice:
          result.best === null ? null : money(result.best.ev.bestPriceScaled),
        feeExpected:
          result.best === null ? null : money(result.best.ev.feeScaled),
        slippage:
          result.best === null ? null : money(result.best.ev.slippageScaled),
        capitalCost:
          result.best === null ? null : money(result.best.ev.capitalCostScaled),
        resolutionBuffer:
          result.best === null
            ? null
            : money(result.best.ev.resolutionBufferScaled),
        costsTotal:
          result.best === null ? null : money(result.best.ev.costsTotalScaled),
        safetyMargin:
          result.best === null
            ? null
            : money(result.best.ev.safetyMarginScaled),
        edgeGross:
          result.best === null ? null : money(result.best.ev.edgeGrossScaled),
        edgeNet:
          result.best === null ? null : money(result.best.ev.edgeNetScaled),
        sizeShares:
          result.sizing === null ? null : money(result.sizing.sizeScaled),
        kellyCapShares:
          result.sizing === null
            ? null
            : money(result.sizing.kellyCapSharesScaled),
        notionalUsd:
          result.sizing === null ? null : money(result.sizing.notionalScaled),
        bindingConstraint: result.sizing?.bindingConstraint ?? "NOT_SIZED",
        limiters:
          result.sizing?.limiters.map((limiter) => ({
            constraint: limiter.constraint,
            max_shares: money(limiter.maxSizeScaled),
            note: limiter.note,
          })) ?? [],
        configVersion: deps.config.version,
        configHash,
        factorMapVersion: deps.factorMap.version,
        ruleVersion: market.ruleVersion,
        paramVersion: market.paramVersion,
        resolutionScoreVersion: resolution?.scoreVersion ?? null,
        resolutionAction: resolution?.action ?? null,
        // The oldest input bounds the staleness; the newest bounds look-ahead,
        // and the migration's CHECK refuses anything later than the decision.
        oldestInputTs: oldestOf(
          [
            estimate?.decisionTs ?? null,
            book?.receivedAt ?? null,
            resolution?.computedAt ?? null,
          ],
          now,
        ),
        newestInputTs: newestOf(
          [
            estimate?.decisionTs ?? null,
            book?.receivedAt ?? null,
            resolution?.computedAt ?? null,
          ],
          now,
        ),
        book: {
          token_id: market.tokenId,
          bids: (book?.bids ?? []).slice(0, 10),
          asks: (book?.asks ?? []).slice(0, 10),
          recorded_at: book?.receivedAt?.toISOString() ?? null,
        },
        inputs: result.panel,
        outcome: result.entrable ? "ACCEPTED" : "REJECTED",
        reasonCode: result.entrable
          ? null
          : (result.rejectionCode ?? "ESTIMATE_MISSING"),
        portfolioState: evaluation.next.state,
      });

      await deps.pool.query(
        `INSERT INTO portfolio_panel_snapshots
           (condition_id, token_id, computed_at, panel_json, decision_id,
            entrable, vetoed, veto_reason, config_version)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)
         ON CONFLICT (token_id, computed_at) DO NOTHING`,
        [
          market.conditionId,
          market.tokenId,
          now,
          JSON.stringify(result.panel),
          decisionId,
          result.entrable,
          result.vetoed,
          result.vetoReason,
          deps.config.version,
        ],
      );
    }

    logJson("info", "PORTFOLIO_CYCLE", {
      evaluated: markets.length,
      entrable,
      state: evaluation.next.state,
      positions: positions.length,
    });
    return { evaluated: markets.length, entrable };
  }

  return {
    async start(): Promise<void> {
      if (running) {
        return;
      }
      running = true;
      await ensureConfigVersion(deps.pool, {
        version: deps.config.version,
        configHash,
        content: deps.config,
        validFrom: clock(),
      });
      await ensureFactorMapVersion(deps.pool, {
        version: deps.factorMap.version,
        contentHash: mapHash,
        content: deps.factorMap,
        validFrom: clock(),
      });
      logJson("info", "PORTFOLIO_BOOT", {
        config_version: deps.config.version,
        config_hash: configHash,
        factor_map_version: deps.factorMap.version,
        factor_map_hash: mapHash,
      });
      await cycleOnce();
      const tick = (): void => {
        void cycleOnce().catch((error: unknown) => {
          logJson("error", "PORTFOLIO_CYCLE_FAILED", {
            error_name: error instanceof Error ? error.name : "UnknownError",
            detail: error instanceof Error ? error.message : undefined,
          });
        });
      };
      timers.push(setInterval(tick, deps.config.cadence.panelMs));
    },
    async stop(): Promise<void> {
      running = false;
      for (const timer of timers) {
        clearInterval(timer);
      }
      timers.length = 0;
      await Promise.resolve();
    },
    cycleOnce,
  };
}

function oldestOf(dates: readonly (Date | null)[], fallback: Date): Date {
  const present = dates.filter((date): date is Date => date !== null);
  if (present.length === 0) {
    return fallback;
  }
  return present.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
}

function newestOf(dates: readonly (Date | null)[], fallback: Date): Date {
  const present = dates.filter((date): date is Date => date !== null);
  if (present.length === 0) {
    return fallback;
  }
  const newest = present.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
  // Never later than the decision itself: a clock skew must not become a
  // look-ahead violation the database then refuses.
  return newest.getTime() > fallback.getTime() ? fallback : newest;
}
