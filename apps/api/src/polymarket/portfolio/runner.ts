// RFC-013 runtime. Event-driven over data the recorder, estimator and
// resolution services already wrote — no external connection of its own.
//
// Three supervised jobs, each idempotent, so a restart mid-cycle costs at most
// one cycle's work:
//
//   panel  — circuit breakers, the state machine, exposures, and the entry
//            evaluation of the whole eligible universe into panel snapshots and
//            decisions;
//   exits  — the seven exit criteria over every open paper position, written to
//            the decision log when the verdict CHANGES;
//   gates  — the continuous gate measurement (task 8), the per-category G2
//            clock, and the replay audit of the decision log (task 7).
//
// Supervision follows the pattern the RFC-012 runner established: skip if still
// running, catch everything, say WHAT failed rather than logging a bare
// `error_name: "Error"` — a lesson this project paid for twice on 2026-08-26.

import { parseScaled, SCALE } from "../fundamental/fixed.js";
import {
  detectBreakers,
  entryFrozenBy,
  executableMid,
  reconcileBreakers,
  type BreakerObservation,
  type BreakerSignal,
  type OpenBreakerRow,
} from "./breakers.js";
import { portfolioConfigHash, type PortfolioConfig } from "./config.js";
import {
  entryDecisionRow,
  exitDecisionRow,
  type DecisionProvenance,
} from "./decisionrow.js";
import { bookWalk, money } from "./ev.js";
import { evaluateMarket, type EvaluationInput } from "./engine.js";
import {
  BUFFER_DAILY_HURDLE,
  planExit,
  type PositionExitContext,
} from "./exitcycle.js";
import {
  capHeadroomFor,
  computeExposures,
  unwindAlarm,
  type ExposureRow,
  type OpenPosition,
} from "./exposure.js";
import {
  closeBreaker,
  entryProvenanceFor,
  feeRateFromBps,
  lastExitSignature,
  loadCorrelatedMarkets,
  loadMarketChangeStates,
  loadMidsAsOf,
  loadOpenBreakers,
  loadOpenPositions,
  loadPaperPnl,
  macroCatalystInWindow,
  openBreaker,
  positionSide,
  ruleExcerpt,
  NO_MARKET_CHANGE,
  type MarketChangeState,
  type OpenPositionRow,
} from "./exitstore.js";
import {
  applyClockReset,
  gateVerdictFingerprint,
  insertGateMeasurement,
  insertGateReport,
  loadClosedPositions,
  loadConfigVersions,
  loadFillReconciliationRows,
  loadForecastRows,
  loadG2Clocks,
  loadLatestGateReport,
  loadOperationalEvidence,
  loadOwnerApproval,
  loadRecentDecisions,
  loadRegimeParamsByCategory,
  loadRiskSurvival,
} from "./gatestore.js";
import {
  assignFactor,
  catalystWindow,
  factorMapHash,
  type FactorMap,
} from "./factors.js";
import {
  measureGates,
  planClockResets,
  reconcile,
  regimeFingerprint,
  type ReconciliationSample,
} from "./measure.js";
import {
  replayAudit,
  serializeEntryReplay,
  serializeExitReplay,
} from "./replay.js";
import {
  bookAsOf,
  ensureConfigVersion,
  ensureFactorMapVersion,
  estimateAsOf,
  insertDecision,
  loadEligibleMarkets,
  resolutionStateFor,
  type BookAsOf,
  type EstimateAsOf,
} from "./store.js";
import {
  evaluateState,
  utcDayBucket,
  utcWeekStart,
  type PortfolioStateSnapshot,
} from "./state.js";
import { SIMULATION_BANNER, type PortfolioPool } from "./types.js";

export const PORTFOLIO_SERVICE = "polymarket-portfolio";

/**
 * How many recorded book levels the engine reads and the decision persists.
 *
 * They must be the SAME number. The replay rebuilds the engine input from
 * `book_json`, so a decision made against more levels than it stored would not
 * be reproducible — and the recorder's snapshots are top-10 per side, so this
 * truncation is a no-op today and a guarantee tomorrow.
 */
const BOOK_LEVELS = 10;

/** How many recent decisions the replay audit re-derives each gate cycle. */
const REPLAY_AUDIT_SAMPLE = 50;

/** How many taker fills the G4 reconciliation samples. */
const RECONCILIATION_SAMPLE = 500;

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
  /** Run one named job once. Test seam, and the boot path for the gates. */
  tickOnce(name: string): Promise<void>;
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

/** Minutes until an instant, or null when there is none. */
function minutesUntil(target: Date | null, now: Date): number | null {
  if (target === null) {
    return null;
  }
  const minutes = (target.getTime() - now.getTime()) / 60_000;
  return minutes < 0 ? null : minutes;
}

export function createPortfolioRunner(
  deps: PortfolioRunnerDeps,
): PortfolioRunner {
  const clock = deps.clock ?? ((): Date => new Date());
  const timers: ReturnType<typeof setInterval>[] = [];
  const jobs = new Map<string, { everyMs: number; run: () => Promise<void> }>();
  const running = new Map<string, boolean>();
  let stopping = false;
  let started = false;

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
   * The unwind cost of one position: what the exit book-walk gives up against
   * the best bid. This is the liquidity number the RFC asks for — depth and
   * effective spread, never volume.
   */
  function unwindCostOf(
    position: OpenPositionRow,
    book: BookAsOf | null,
  ): bigint | null {
    if (book === null || position.sharesScaled <= 0n) {
      return null;
    }
    const walk = bookWalk(book.bids, position.sharesScaled);
    if (walk === null) {
      return null;
    }
    return ((walk.bestScaled - walk.vwapScaled) * walk.filledScaled) / SCALE;
  }

  function toOpenPosition(
    row: OpenPositionRow,
    unwindCostScaled: bigint | null,
  ): OpenPosition {
    const factor = assignFactor(deps.factorMap, {
      conditionId: row.conditionId,
      question: row.question,
      category: row.category,
      negRisk: row.negRisk,
      eventId: row.eventId,
    });
    return {
      tokenId: row.tokenId,
      conditionId: row.conditionId,
      sharesScaled: row.sharesScaled,
      costScaled: row.costScaled,
      category: row.category,
      eventId: row.eventId,
      resolutionSource: row.resolutionSource,
      factor: factor.factor,
      catalystWindow: catalystWindow(row.endDate),
      unresolved: row.unresolved,
      unwindCostScaled,
      negRisk: row.negRisk,
    };
  }

  async function persistExposures(
    rows: readonly ExposureRow[],
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

  /**
   * Detect every circuit breaker over the universe and the open book, and
   * reconcile against what is already open.
   *
   * Run at the START of the panel cycle, before any entry is evaluated: a
   * breaker that opens this cycle must freeze this cycle's entries, not the next
   * one's.
   */
  async function reconcileAllBreakers(input: {
    readonly now: Date;
    readonly markets: readonly {
      conditionId: string;
      tokenId: string;
      endDate: Date | null;
    }[];
    readonly positions: readonly OpenPositionRow[];
    readonly changes: ReadonlyMap<string, MarketChangeState>;
    readonly resolution: ReadonlyMap<
      string,
      { action: string; disputeActive: boolean }
    >;
    readonly books: ReadonlyMap<string, BookAsOf | null>;
  }): Promise<OpenBreakerRow[]> {
    const { now } = input;
    const windowFrom = new Date(
      now.getTime() - deps.config.breakers.jumpWindowMs,
    );
    const midsNow = new Map<string, bigint>();
    for (const [tokenId, book] of input.books) {
      if (book === null) {
        continue;
      }
      const mid = executableMid(book.bids, book.asks);
      if (mid !== null) {
        midsNow.set(tokenId, mid);
      }
    }
    const midsBefore = await loadMidsAsOf(
      deps.pool,
      [...input.books.keys()],
      windowFrom,
    );
    const macroCatalyst = await macroCatalystInWindow(
      deps.pool,
      windowFrom,
      now,
    );
    const heldConditions = new Set(
      input.positions.map((position) => position.conditionId),
    );

    const detected: BreakerSignal[] = [];
    for (const market of input.markets) {
      const change = input.changes.get(market.conditionId) ?? NO_MARKET_CHANGE;
      const resolution = input.resolution.get(market.conditionId);
      const book = input.books.get(market.tokenId) ?? null;
      const ownCatalyst =
        market.endDate !== null &&
        market.endDate.getTime() >= windowFrom.getTime() &&
        market.endDate.getTime() <= now.getTime();
      const observation: BreakerObservation = {
        conditionId: market.conditionId,
        tokenId: market.tokenId,
        holdsPosition: heldConditions.has(market.conditionId),
        disputeActive: resolution?.disputeActive === true,
        resolutionAction:
          resolution === undefined
            ? null
            : resolution.action === "BUFFER" ||
                resolution.action === "VETO" ||
                resolution.action === "CIRCUIT_BREAKER"
              ? resolution.action
              : "NONE",
        midNowScaled: midsNow.get(market.tokenId) ?? null,
        midBeforeScaled: midsBefore.get(market.tokenId) ?? null,
        knownCatalystInWindow: macroCatalyst || ownCatalyst,
        clarifiedAt: change.clarifiedAt,
        paramChangedAt: change.paramChangedAt,
        bookAgeMs:
          book === null ? null : now.getTime() - book.receivedAt.getTime(),
      };
      detected.push(
        ...detectBreakers({
          observation,
          config: {
            jumpThresholdScaled: fractionScaled(
              deps.config.breakers.jumpThreshold,
            ),
            jumpWindowMs: deps.config.breakers.jumpWindowMs,
            bookMaxAgeMs: deps.config.staleness.bookMaxAgeMs,
          },
          now,
        }),
      );
    }

    const open = await loadOpenBreakers(deps.pool);
    const { toOpen, toClose } = reconcileBreakers({ detected, open });
    for (const signal of toOpen) {
      await openBreaker(deps.pool, signal, now);
      logJson("warn", "PORTFOLIO_BREAKER_OPENED", {
        kind: signal.kind,
        scope: signal.scope,
        condition_id: signal.conditionId,
        token_id: signal.tokenId,
      });
    }
    for (const row of toClose) {
      await closeBreaker(deps.pool, row.breakerId, now);
      logJson("info", "PORTFOLIO_BREAKER_CLOSED", {
        kind: row.kind,
        scope: row.scope,
        condition_id: row.conditionId,
        token_id: row.tokenId,
      });
    }
    return loadOpenBreakers(deps.pool);
  }

  /**
   * The markets a breaker may be detected on: the eligible universe plus every
   * market with an open position, de-duplicated by token.
   */
  function observableMarkets(
    markets: readonly {
      conditionId: string;
      tokenId: string;
      endDate: Date | null;
    }[],
    positions: readonly OpenPositionRow[],
  ): { conditionId: string; tokenId: string; endDate: Date | null }[] {
    const byToken = new Map<
      string,
      { conditionId: string; tokenId: string; endDate: Date | null }
    >();
    for (const market of markets) {
      byToken.set(market.tokenId, {
        conditionId: market.conditionId,
        tokenId: market.tokenId,
        endDate: market.endDate,
      });
    }
    for (const position of positions) {
      if (!byToken.has(position.tokenId)) {
        byToken.set(position.tokenId, {
          conditionId: position.conditionId,
          tokenId: position.tokenId,
          endDate: position.endDate,
        });
      }
    }
    return [...byToken.values()];
  }

  async function panelCycle(): Promise<{
    evaluated: number;
    entrable: number;
  }> {
    const now = clock();
    const markets = await loadEligibleMarkets(deps.pool, now);
    const positions = await loadOpenPositions(deps.pool);

    // Per-market context, batched: three grouped scans instead of one round
    // trip per market per question.
    const conditionIds = [
      ...new Set([
        ...markets.map((market) => market.conditionId),
        ...positions.map((position) => position.conditionId),
      ]),
    ];
    const changes = await loadMarketChangeStates(deps.pool, conditionIds);
    const correlated = await loadCorrelatedMarkets(deps.pool, conditionIds);

    const books = new Map<string, BookAsOf | null>();
    const estimates = new Map<string, EstimateAsOf | null>();
    const resolutions = new Map<
      string,
      Awaited<ReturnType<typeof resolutionStateFor>>
    >();
    for (const market of markets) {
      const [estimate, resolution, book] = await Promise.all([
        estimateAsOf(deps.pool, market.tokenId, now),
        resolutionStateFor(deps.pool, market.conditionId),
        bookAsOf(deps.pool, market.tokenId, now),
      ]);
      estimates.set(market.tokenId, estimate);
      resolutions.set(market.conditionId, resolution);
      books.set(market.tokenId, sliceBook(book));
    }
    // Positions may sit in markets that already left the universe; their books
    // are still needed for the unwind cost and the staleness breaker.
    for (const position of positions) {
      if (!books.has(position.tokenId)) {
        books.set(
          position.tokenId,
          sliceBook(await bookAsOf(deps.pool, position.tokenId, now)),
        );
      }
      if (!resolutions.has(position.conditionId)) {
        resolutions.set(
          position.conditionId,
          await resolutionStateFor(deps.pool, position.conditionId),
        );
      }
    }

    // 1. Circuit breakers, before anything is allowed to enter.
    const resolutionForBreakers = new Map<
      string,
      { action: string; disputeActive: boolean }
    >();
    for (const [conditionId, state] of resolutions) {
      if (state !== null) {
        resolutionForBreakers.set(conditionId, {
          action: state.action,
          disputeActive: state.disputeActive,
        });
      }
    }
    const openBreakers = await reconcileAllBreakers({
      now,
      // The eligible universe PLUS every market we hold. A position can sit in
      // a market that already left the universe, and observing only the
      // universe would report its breakers as no longer detected — closing
      // them, which is the opposite of what "the condition cleared" means.
      markets: observableMarkets(markets, positions),
      positions,
      changes,
      resolution: resolutionForBreakers,
      books,
    });

    // 2. State machine over the paper book's realized and marked PnL.
    const current = await loadState(now);
    const pnl = await loadPaperPnl(deps.pool);
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
      realizedPnlTotalScaled: pnl.realizedTotalScaled,
      realizedPnlDayScaled: pnl.realizedDayScaled,
      realizedPnlWeekScaled: pnl.realizedWeekScaled,
      openMarkScaled: pnl.openMarkScaled,
      openCostScaled: pnl.openCostScaled,
    });
    await persistState(evaluation.next, evaluation.transition);

    // 3. Exposures, with the unwind cost of every position from its exit walk.
    const exposurePositions = positions.map((position) =>
      toOpenPosition(
        position,
        unwindCostOf(position, books.get(position.tokenId) ?? null),
      ),
    );
    const exposures = computeExposures({
      positions: exposurePositions,
      bankrollScaled: evaluation.next.bankrollScaled,
      caps: deps.config.caps,
    });
    await persistExposures(exposures, now);
    const alarm = unwindAlarm(
      exposures,
      pnl.openMarkScaled - pnl.openCostScaled,
      fractionScaled(deps.config.exits.unwindAlarmPctOpenPnl),
    );
    if (alarm.triggered) {
      logJson("warn", "PORTFOLIO_UNWIND_ALARM", {
        ratio: alarm.ratioScaled === null ? null : money(alarm.ratioScaled),
        threshold: deps.config.exits.unwindAlarmPctOpenPnl,
      });
    }

    // 4. Evaluate the universe.
    let entrable = 0;
    for (const market of markets) {
      const estimate = estimates.get(market.tokenId) ?? null;
      const resolution = resolutions.get(market.conditionId) ?? null;
      const book = books.get(market.tokenId) ?? null;
      const change = changes.get(market.conditionId) ?? NO_MARKET_CHANGE;
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
      const frozenBy = entryFrozenBy(
        openBreakers,
        market.conditionId,
        market.tokenId,
      );

      const engineInput: EvaluationInput = {
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
        // 1 when RFC-012 has no score yet: the multiplier can only REDUCE a
        // size, and a missing score must not silently reduce every size to
        // zero — the resolution-state gate already refuses a market with no
        // recorded risk state.
        rulePrecisionMultiplier:
          change.rulePrecisionScaled === null
            ? 1
            : Number(change.rulePrecisionScaled) / Number(SCALE),
        resolutionSource: market.resolutionSource,
        ruleExcerpt: ruleExcerpt(market.ruleDescription),
        correlatedMarkets: correlated.get(market.conditionId) ?? [],
        takerFeeRate: feeRateFromBps(market.takerFeeBps),
        minOrderSize: market.minOrderSize,
        bufferDailyHurdle: BUFFER_DAILY_HURDLE,
        portfolioState: evaluation.next.state,
        bankrollScaled: evaluation.next.bankrollScaled,
        capHeadroom: headroom,
        correlationMultiplier: Number(factor.multiplierScaled) / Number(SCALE),
        breakerOpen: frozenBy !== null,
      };

      const result = evaluateMarket(engineInput);
      if (result.entrable) {
        entrable += 1;
      }

      const bookJson = {
        token_id: market.tokenId,
        bids: book?.bids ?? [],
        asks: book?.asks ?? [],
        recorded_at: book?.receivedAt?.toISOString() ?? null,
      };
      const inputTimestamps = [
        estimate?.decisionTs ?? null,
        book?.receivedAt ?? null,
        resolution?.computedAt ?? null,
      ];
      const provenance: DecisionProvenance = {
        conditionId: market.conditionId,
        tokenId: market.tokenId,
        decisionTs: now,
        configVersion: deps.config.version,
        configHash,
        factorMapVersion: deps.factorMap.version,
        ruleVersion: market.ruleVersion,
        paramVersion: market.paramVersion,
        resolutionScoreVersion: resolution?.scoreVersion ?? null,
        resolutionAction: resolution?.action ?? null,
        oldestInputTs: oldestOf(inputTimestamps, now),
        newestInputTs: newestOf(inputTimestamps, now),
        book: bookJson,
        portfolioState: evaluation.next.state,
      };

      const row = entryDecisionRow({
        evaluation: result,
        context: {
          ...provenance,
          q: estimate?.q ?? null,
          qLo: estimate?.qLo ?? null,
          qHi: estimate?.qHi ?? null,
          estimateSource:
            estimate === null
              ? null
              : estimate.source === "MODEL"
                ? "MODEL"
                : "MARKET_BASELINE",
        },
        replay: serializeEntryReplay(engineInput),
      });
      const decisionId = await insertDecision(deps.pool, row);

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
      open_breakers: openBreakers.length,
      stale_marks: pnl.positionsWithStaleMark,
    });
    return { evaluated: markets.length, entrable };
  }

  /**
   * The exit cycle: the seven criteria over every open position.
   *
   * A decision is written when the verdict CHANGES, and on the first evaluation
   * of a position. Writing every cycle would put twenty thousand identical rows
   * behind a week-old position and bury the moment the verdict actually moved;
   * writing only on exit would lose the evidence that the engine looked at all,
   * which is exactly what the shadow measurement is for.
   */
  async function exitCycle(): Promise<{ evaluated: number; exiting: number }> {
    const now = clock();
    const positions = await loadOpenPositions(deps.pool);
    if (positions.length === 0) {
      logJson("info", "PORTFOLIO_EXIT_CYCLE", { evaluated: 0, exiting: 0 });
      return { evaluated: 0, exiting: 0 };
    }
    const state = await loadState(now);
    const openBreakers = await loadOpenBreakers(deps.pool);
    const changes = await loadMarketChangeStates(
      deps.pool,
      positions.map((position) => position.conditionId),
    );

    let exiting = 0;
    let written = 0;
    for (const position of positions) {
      const side = positionSide(position);
      const estimateToken = position.affirmativeTokenId ?? position.tokenId;
      const [book, estimate, resolution, entry, previousSignature] =
        await Promise.all([
          bookAsOf(deps.pool, position.tokenId, now),
          estimateAsOf(deps.pool, estimateToken, now),
          resolutionStateFor(deps.pool, position.conditionId),
          entryProvenanceFor(deps.pool, position.tokenId),
          lastExitSignature(deps.pool, position.tokenId),
        ]);
      const sliced = sliceBook(book);
      const change = changes.get(position.conditionId) ?? NO_MARKET_CHANGE;

      // The conservative bound, side-adjusted: q_lo for the affirmative leg,
      // 1 - q_hi for its pair. Using the wrong end would be the optimistic
      // bound wearing the name of the lower one.
      const qLo = estimate === null ? null : parseScaled(estimate.qLo);
      const qHi = estimate === null ? null : parseScaled(estimate.qHi);
      const probLowerScaled =
        side === "YES" ? qLo : qHi === null ? null : SCALE - qHi;
      const entryProbLowerScaled =
        entry === null
          ? null
          : entry.marketSide === "YES"
            ? entry.qLo === null
              ? null
              : parseScaled(entry.qLo)
            : entry.qHi === null
              ? null
              : SCALE - (parseScaled(entry.qHi) ?? 0n);

      const context: PositionExitContext = {
        tokenId: position.tokenId,
        conditionId: position.conditionId,
        side,
        sharesScaled: position.sharesScaled,
        costScaled: position.costScaled,
        openedAt: position.openedAt,
        entryDecisionId: entry?.decisionId ?? null,
        entryDecisionTs: entry?.decisionTs ?? null,
        entryProbLowerScaled,
        entryRuleVersion: entry?.ruleVersion ?? null,
        entryResolutionSource: entry?.resolutionSource ?? null,
        entryRulePrecisionScaled: entry?.rulePrecisionScaled ?? null,
        invalidationProbLowerBelowScaled:
          entry?.invalidationProbLowerBelowScaled ?? null,
        probLowerScaled,
        bids: sliced?.bids ?? [],
        asks: sliced?.asks ?? [],
        bookAgeMs:
          sliced === null ? null : now.getTime() - sliced.receivedAt.getTime(),
        ruleVersion: position.ruleVersion,
        resolutionSource: position.resolutionSource,
        rulePrecisionScaled: change.rulePrecisionScaled,
        clarifiedAt: change.clarifiedAt,
        minsToCatalyst: minutesUntil(position.endDate, now),
        resolutionAction: resolution?.action ?? null,
        disputeActive: resolution?.disputeActive === true,
        p5050Scaled:
          resolution?.p5050 == null ? null : parseScaled(resolution.p5050),
        expectedLockupS: resolution?.expectedLockupS ?? 0,
        breakerOpen:
          entryFrozenBy(
            openBreakers,
            position.conditionId,
            position.tokenId,
          ) !== null,
      };

      const plan = planExit({
        context,
        config: deps.config,
        portfolioState: state.state,
      });
      if (plan.signals.length > 0) {
        exiting += 1;
      }
      if (previousSignature === plan.signature) {
        continue;
      }

      const inputTimestamps = [
        estimate?.decisionTs ?? null,
        sliced?.receivedAt ?? null,
        resolution?.computedAt ?? null,
      ];
      const row = exitDecisionRow({
        plan,
        context: {
          conditionId: position.conditionId,
          tokenId: position.tokenId,
          decisionTs: now,
          configVersion: deps.config.version,
          configHash,
          factorMapVersion: deps.factorMap.version,
          ruleVersion: position.ruleVersion,
          paramVersion: position.paramVersion,
          resolutionScoreVersion: resolution?.scoreVersion ?? null,
          resolutionAction: resolution?.action ?? null,
          oldestInputTs: oldestOf(inputTimestamps, now),
          newestInputTs: newestOf(inputTimestamps, now),
          book: {
            token_id: position.tokenId,
            bids: sliced?.bids ?? [],
            asks: sliced?.asks ?? [],
            recorded_at: sliced?.receivedAt?.toISOString() ?? null,
          },
          portfolioState: state.state,
          side,
          q: estimate?.q ?? null,
          qLo: estimate?.qLo ?? null,
          qHi: estimate?.qHi ?? null,
          estimateSource:
            estimate === null
              ? null
              : estimate.source === "MODEL"
                ? "MODEL"
                : "MARKET_BASELINE",
        },
        replay: serializeExitReplay({ context, portfolioState: state.state }),
      });
      await insertDecision(deps.pool, row);
      written += 1;
      logJson(plan.signals.length > 0 ? "warn" : "info", "PORTFOLIO_EXIT", {
        token_id: position.tokenId,
        condition_id: position.conditionId,
        signature: plan.signature,
        frozen: plan.freeze.frozen,
        signals: plan.signals.map((signal) => signal.reason),
      });
    }

    logJson("info", "PORTFOLIO_EXIT_CYCLE", {
      evaluated: positions.length,
      exiting,
      written,
      state: state.state,
    });
    return { evaluated: positions.length, exiting };
  }

  /**
   * The gate cycle: measure G1..G6, keep the per-category G2 clock honest, and
   * audit the replay of the newest decisions.
   *
   * The clock reset happens BEFORE the measurement, so a regime change that
   * landed since the last cycle is already reflected in the G2 and G5 numbers
   * this cycle records — never averaged into a window it does not belong to.
   */
  async function gateCycle(): Promise<void> {
    const now = clock();

    // G5 first: fingerprints, then any clock that has to start or reset.
    const paramsByCategory = await loadRegimeParamsByCategory(deps.pool);
    const currentFingerprints: Record<string, string> = {};
    for (const [category, params] of Object.entries(paramsByCategory)) {
      currentFingerprints[category] = regimeFingerprint(params);
    }
    const existingClocks = await loadG2Clocks(deps.pool);
    const resets = planClockResets({
      clocks: existingClocks,
      currentFingerprints,
      now,
    });
    for (const plan of resets) {
      await applyClockReset(deps.pool, plan);
      logJson("warn", "PORTFOLIO_G2_CLOCK_RESET", {
        category: plan.category,
        reason: plan.reason,
        previous_start: plan.previousStart?.toISOString() ?? null,
        new_start: plan.newStart.toISOString(),
      });
    }
    const clocks = await loadG2Clocks(deps.pool);

    const [forecastRows, closed, risk, operational, approval] =
      await Promise.all([
        loadForecastRows(deps.pool),
        loadClosedPositions(deps.pool),
        loadRiskSurvival(deps.pool),
        loadOperationalEvidence(deps.pool, now),
        loadOwnerApproval(deps.pool),
      ]);

    const reconciliation = reconcile(await reconciliationSamples());

    // The G2 clock the aggregate window uses is the OLDEST category clock —
    // the longest continuous history any category has, not the shortest.
    //
    // Stated plainly because it is a real trade-off and the owner should get to
    // pick: taking the YOUNGEST-reset clock would make a fee change in one
    // category shrink the whole gate's window, which is what the RFC's reset
    // rule implies — but it would also mean a brand-new CATEGORY appearing in
    // the universe collapses the window to zero days and G2 can never mature as
    // the book grows. Per-category G2 measurement is the answer to both, and it
    // is not what this cycle does today. What the aggregate window DOES do
    // honestly, since 2026-08-27, is drop the closed positions that fall before
    // its start: a reset that kept its sample would be cosmetic.
    const clockStart = clocks.reduce<Date | null>(
      (oldest, clock2) =>
        oldest === null || clock2.clockStart.getTime() < oldest.getTime()
          ? clock2.clockStart
          : oldest,
      null,
    );

    const measured = measureGates({
      now,
      config: deps.config.gates,
      forecastRows,
      closed,
      clockStart,
      unblockedBreaches: risk.unblockedBreaches,
      maxDrawdown: risk.maxDrawdown,
      drawdownMax: deps.config.lossLimits.drawdownMax,
      breakersExercised: risk.breakersExercised,
      reconciliation,
      soakDays: operational.soakDays,
      killSwitchExercised: operational.killSwitchExercised,
      reduceOnlyExercised: risk.reduceOnlyExercised,
      clocks,
      currentFingerprints,
      approval: approval.approval,
      currentReportId: approval.currentReportId,
    });

    for (const measurement of measured.measurements) {
      await insertGateMeasurement(deps.pool, {
        measurement,
        configVersion: deps.config.version,
        measuredAt: now,
      });
    }

    logJson("info", "PORTFOLIO_GATES_MEASURED", {
      overall: measured.overall,
      rfc_009_status: measured.overall,
      gates: measured.measurements.map((measurement) => ({
        gate: measurement.gate,
        status: measurement.status,
        reason_code: measurement.reasonCode,
      })),
    });

    // Mint a report when — and only when — a VERDICT changed.
    //
    // This is what gives G6 something to be written against. Without a report
    // there is no id for a review to name, and `currentReportId` stays null;
    // with a report an hour there would be a new id every hour and no review
    // could survive long enough to be read. Minting on verdict change means an
    // approval lasts exactly as long as the answers it approved.
    const fingerprint = gateVerdictFingerprint(
      measured.measurements,
      measured.overall,
    );
    const latestReport = await loadLatestGateReport(deps.pool);
    if (latestReport === null || latestReport.fingerprint !== fingerprint) {
      const windowFrom =
        measured.measurements.reduce<Date | null>(
          (oldest, measurement) =>
            measurement.windowFrom !== null &&
            (oldest === null ||
              measurement.windowFrom.getTime() < oldest.getTime())
              ? measurement.windowFrom
              : oldest,
          null,
        ) ?? now;
      const reportId = await insertGateReport(deps.pool, {
        measurements: measured.measurements,
        overall: measured.overall,
        fingerprint,
        generatedAt: now,
        windowFrom,
        windowTo: now,
        configVersion: deps.config.version,
      });
      logJson("info", "PORTFOLIO_GATE_REPORT_MINTED", {
        report_id: reportId,
        overall: measured.overall,
        previous_report_id: latestReport?.reportId ?? null,
        reason: latestReport === null ? "first_report" : "verdict_changed",
      });
    }

    await auditReplay();
  }

  /**
   * Build the G4 reconciliation samples from recorded taker executions.
   *
   * Two references, and the difference between them is the whole gate:
   *
   *   - the FEE reference is the venue's own `fee_rate_bps`, off the recorded
   *     trade feed. The simulator charges with `taker_fee_bps` from
   *     `polymarket_param_versions`, a different feed entirely, so the two
   *     numbers can genuinely disagree;
   *   - the PRICE reference is a book-walk over the snapshot recorded at the
   *     DECISION instant. Re-walking the snapshot the fill consumed would be the
   *     same query over the same table for the same levels — the simulator
   *     compared against itself, bias zero by construction, `bias >= 0` unable
   *     to fail. When the book did not move between the two instants they ARE
   *     the same recorded observation, and the sample says so and is excluded.
   */
  async function reconciliationSamples(): Promise<ReconciliationSample[]> {
    const executions = await loadFillReconciliationRows(
      deps.pool,
      RECONCILIATION_SAMPLE,
    );
    const samples: ReconciliationSample[] = [];
    for (const execution of executions) {
      const size = parseScaled(execution.filledSize);
      const vwap = parseScaled(execution.vwapPrice);
      const simulatedFee = parseScaled(execution.simulatedFeeUsd);
      const feeShape = parseScaled(execution.feeShape);
      if (
        size === null ||
        size <= 0n ||
        vwap === null ||
        simulatedFee === null ||
        feeShape === null
      ) {
        continue;
      }

      // The venue's own curve, with the rate factored out of the fill loop:
      // sum(rate x p x (1 - p) x size) = rate x feeShape. Exact, not taken at
      // the VWAP.
      const rate = feeRateFromBps(execution.venueFeeRateBps);
      const rateScaled = rate === null ? null : parseScaled(rate);
      const realFee =
        rateScaled === null ? null : (rateScaled * feeShape) / SCALE;

      const decisionBook = sliceBook(
        await bookAsOf(deps.pool, execution.tokenId, execution.decidedAt),
      );
      const executionBook = sliceBook(
        await bookAsOf(deps.pool, execution.tokenId, execution.execTs),
      );
      // Same recorded observation on both sides means there is no second
      // observation: the reference would be the simulator's own input.
      const sameObservation =
        decisionBook !== null &&
        executionBook !== null &&
        decisionBook.receivedAt.getTime() ===
          executionBook.receivedAt.getTime();
      const walk =
        decisionBook === null
          ? null
          : bookWalk(
              execution.side === "BUY" ? decisionBook.asks : decisionBook.bids,
              size,
            );

      samples.push({
        side: execution.side,
        simulatedFeeUsd: Number(simulatedFee) / Number(SCALE),
        realFeeUsd: realFee === null ? null : Number(realFee) / Number(SCALE),
        feeReference: realFee === null ? null : "VENUE_TRADE_FEED",
        simulatedPrice: Number(vwap) / Number(SCALE),
        bookWalkPrice:
          walk === null ? null : Number(walk.vwapScaled) / Number(SCALE),
        priceReference:
          walk === null
            ? null
            : sameObservation
              ? "EXECUTION_BOOK"
              : "DECISION_BOOK",
      });
    }
    return samples;
  }

  /**
   * Re-derive the newest decisions from what the log persisted, and say whether
   * they still reproduce.
   *
   * A mismatch is logged at error level with the offending fields. It means one
   * of three things, all worth waking up for: the engine changed behaviour
   * without a config version change, the persisted inputs are incomplete, or
   * the stored config content no longer means what it meant.
   */
  async function auditReplay(): Promise<void> {
    const decisions = await loadRecentDecisions(deps.pool, REPLAY_AUDIT_SAMPLE);
    if (decisions.length === 0) {
      return;
    }
    const configByVersion = await loadConfigVersions(
      deps.pool,
      decisions.map((decision) => decision.configVersion),
    );
    const audit = replayAudit({ decisions, configByVersion });
    if (audit.mismatched.length === 0) {
      logJson("info", "PORTFOLIO_REPLAY_OK", {
        total: audit.total,
        matched: audit.matched,
      });
      return;
    }
    logJson("error", "PORTFOLIO_REPLAY_MISMATCH", {
      total: audit.total,
      matched: audit.matched,
      mismatched: audit.mismatched.slice(0, 5).map((outcome) => ({
        decision_id: outcome.decisionId,
        kind: outcome.kind,
        failure: outcome.failure,
        fields: outcome.differences.map((difference) => difference.field),
      })),
    });
  }

  /**
   * Truncate a recorded book to the levels the decision will persist.
   *
   * The engine must not see a level the decision does not store, or the replay
   * would be re-deriving a decision from less than it was made with.
   */
  function sliceBook(book: BookAsOf | null): BookAsOf | null {
    if (book === null) {
      return null;
    }
    return {
      bids: book.bids.slice(0, BOOK_LEVELS),
      asks: book.asks.slice(0, BOOK_LEVELS),
      receivedAt: book.receivedAt,
    };
  }

  function supervised(name: string, run: () => Promise<void>): () => void {
    return () => {
      if (stopping) {
        return;
      }
      if (running.get(name) === true) {
        logJson("warn", "PORTFOLIO_JOB_STILL_RUNNING", { job: name });
        return;
      }
      running.set(name, true);
      run()
        .catch((error: unknown) => {
          // The message, not only the name: diagnosing a bare
          // `error_name: "Error"` cost this project two manual boots.
          logJson("error", "PORTFOLIO_JOB_FAILED", {
            job: name,
            error_name: error instanceof Error ? error.name : "UnknownError",
            detail: error instanceof Error ? error.message : undefined,
          });
        })
        .finally(() => {
          running.set(name, false);
        });
    };
  }

  return {
    async start(): Promise<void> {
      if (started) {
        return;
      }
      started = true;
      stopping = false;
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

      jobs.set("panel", {
        everyMs: deps.config.cadence.panelMs,
        run: async () => {
          await panelCycle();
        },
      });
      jobs.set("exits", {
        everyMs: deps.config.cadence.exitMs,
        run: async () => {
          await exitCycle();
        },
      });
      jobs.set("gates", {
        everyMs: deps.config.cadence.gateMs,
        run: gateCycle,
      });

      await panelCycle();
      // The gates are measured once at boot so the endpoint and the panel are
      // never empty for the first hour of a fresh deployment.
      await gateCycle().catch((error: unknown) => {
        logJson("error", "PORTFOLIO_JOB_FAILED", {
          job: "gates_boot",
          error_name: error instanceof Error ? error.name : "UnknownError",
          detail: error instanceof Error ? error.message : undefined,
        });
      });

      for (const [name, job] of jobs) {
        timers.push(setInterval(supervised(name, job.run), job.everyMs));
      }
    },
    async stop(): Promise<void> {
      stopping = true;
      started = false;
      for (const timer of timers) {
        clearInterval(timer);
      }
      timers.length = 0;
      await Promise.resolve();
    },
    cycleOnce: panelCycle,
    async tickOnce(name: string): Promise<void> {
      if (name === "panel") {
        await panelCycle();
        return;
      }
      if (name === "exits") {
        await exitCycle();
        return;
      }
      if (name === "gates") {
        await gateCycle();
        return;
      }
      throw new Error(`unknown job: ${name}`);
    },
  };
}
