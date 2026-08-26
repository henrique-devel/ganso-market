// RFC-013 task 4: the portfolio state machine, NORMAL -> REDUCE_ONLY -> HALTED.
//
// Two properties matter more than anything else here:
//
//  1. REDUCE_ONLY and HALTED are INVIOLABLE by any signal. No edge, however
//     large, and no config flag can raise exposure in those states. The engine
//     asks canIncreaseExposure() and there is no second path.
//
//  2. HALTED never clears on its own. Not when the drawdown recovers, not when
//     a window expires, not on restart. It takes an explicit manual resume,
//     which is the only reason `manualHalt` and the resume endpoint exist.
//
// The state is derived from REALIZED PnL for the loss limits (an unrealized
// mark must never unlock more risk) and from EQUITY for the drawdown (which is
// what a high-water mark means).

import { div, mul, SCALE } from "../fundamental/fixed.js";
import type { PortfolioStateName } from "./types.js";

export type StateTriggerSource =
  | "daily_loss"
  | "weekly_loss"
  | "drawdown"
  | "manual"
  | "window_expired"
  | "boot";

export interface PortfolioStateSnapshot {
  readonly state: PortfolioStateName;
  readonly reason: string | null;
  readonly bankrollScaled: bigint;
  readonly highWaterMarkScaled: bigint;
  readonly equityScaled: bigint;
  readonly drawdownScaled: bigint;
  readonly realizedPnlDayScaled: bigint;
  readonly realizedPnlWeekScaled: bigint;
  /** UTC calendar day the daily bucket belongs to (YYYY-MM-DD). */
  readonly dayBucket: string;
  /** UTC Monday the weekly bucket starts on (YYYY-MM-DD). */
  readonly weekStart: string;
  readonly reduceOnlyUntil: Date | null;
  readonly haltedAt: Date | null;
  readonly manualHalt: boolean;
}

export interface StateLimits {
  readonly perdaDiariaMaxScaled: bigint;
  readonly perdaSemanalMaxScaled: bigint;
  readonly drawdownMaxScaled: bigint;
  readonly reduceOnlyWeekDays: number;
}

export interface StateEvaluationInput {
  readonly now: Date;
  readonly current: PortfolioStateSnapshot;
  readonly limits: StateLimits;
  /** Configured notional bankroll: the denominator of every percentage. */
  readonly bankrollBaseScaled: bigint;
  readonly realizedPnlTotalScaled: bigint;
  readonly realizedPnlDayScaled: bigint;
  readonly realizedPnlWeekScaled: bigint;
  /** Mark value of open positions, from the executable bid (never the mid). */
  readonly openMarkScaled: bigint;
  /** Cost basis of open positions. */
  readonly openCostScaled: bigint;
}

export interface StateTransition {
  readonly from: PortfolioStateName;
  readonly to: PortfolioStateName;
  readonly reason: string;
  readonly triggerSource: StateTriggerSource;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface StateEvaluation {
  readonly next: PortfolioStateSnapshot;
  readonly transition: StateTransition | null;
}

const DAY_MS = 24 * 3_600_000;

export function utcDayBucket(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** ISO week start (Monday) in UTC — the bucket the weekly loss accrues into. */
export function utcWeekStart(at: Date): string {
  const day = at.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const monday = new Date(at.getTime() - daysSinceMonday * DAY_MS);
  return utcDayBucket(monday);
}

/** Next 00:00 UTC strictly after `at` — when a daily REDUCE_ONLY expires. */
export function nextUtcMidnight(at: Date): Date {
  const next = new Date(at.getTime());
  next.setUTCHours(0, 0, 0, 0);
  return new Date(next.getTime() + DAY_MS);
}

/**
 * The single question the accept path asks. Anything other than NORMAL means
 * no new risk, no larger position, no exception.
 */
export function canIncreaseExposure(state: PortfolioStateName): boolean {
  return state === "NORMAL";
}

function lossFraction(pnlScaled: bigint, bankrollScaled: bigint): bigint {
  if (bankrollScaled <= 0n || pnlScaled >= 0n) {
    return 0n;
  }
  return div(-pnlScaled, bankrollScaled);
}

/**
 * Derive the next state. Severity order is fixed: a drawdown halt outranks a
 * loss-limit throttle, and a throttle outranks a recovery back to NORMAL.
 */
export function evaluateState(input: StateEvaluationInput): StateEvaluation {
  const { current, limits, now } = input;

  const bankrollScaled =
    input.bankrollBaseScaled + input.realizedPnlTotalScaled;
  const equityScaled =
    bankrollScaled + input.openMarkScaled - input.openCostScaled;
  const highWaterMarkScaled =
    equityScaled > current.highWaterMarkScaled
      ? equityScaled
      : current.highWaterMarkScaled;
  const drawdownScaled =
    highWaterMarkScaled > 0n && equityScaled < highWaterMarkScaled
      ? div(highWaterMarkScaled - equityScaled, highWaterMarkScaled)
      : 0n;

  // Rolling the calendar bucket zeroes the accrual, and a daily REDUCE_ONLY
  // whose window expired stops being in force.
  const dayBucket = utcDayBucket(now);
  const weekStart = utcWeekStart(now);
  const realizedPnlDayScaled =
    dayBucket === current.dayBucket ? input.realizedPnlDayScaled : 0n;
  const realizedPnlWeekScaled =
    weekStart === current.weekStart ? input.realizedPnlWeekScaled : 0n;

  const base: PortfolioStateSnapshot = {
    ...current,
    bankrollScaled,
    equityScaled,
    highWaterMarkScaled,
    drawdownScaled,
    realizedPnlDayScaled,
    realizedPnlWeekScaled,
    dayBucket,
    weekStart,
  };

  // 1. HALTED is absorbing. A recovered drawdown does NOT release it; only the
  //    manual resume path may, and it does so by writing the state directly.
  if (current.state === "HALTED") {
    return { next: base, transition: null };
  }

  // 2. Drawdown against the high-water mark: halt and require manual review.
  if (drawdownScaled >= limits.drawdownMaxScaled) {
    const reason = "drawdown_max";
    return {
      next: {
        ...base,
        state: "HALTED",
        reason,
        haltedAt: now,
        manualHalt: false,
        reduceOnlyUntil: null,
      },
      transition: {
        from: current.state,
        to: "HALTED",
        reason,
        triggerSource: "drawdown",
        detail: {
          drawdown: drawdownScaled.toString(),
          limit: limits.drawdownMaxScaled.toString(),
          high_water_mark: highWaterMarkScaled.toString(),
          equity: equityScaled.toString(),
        },
      },
    };
  }

  // 3. Loss limits. The daily and weekly windows differ only in how long the
  //    throttle lasts; whichever expires LATER wins, so a weekly throttle is
  //    never shortened by a daily one that trips inside it.
  const dailyLoss = lossFraction(realizedPnlDayScaled, bankrollScaled);
  const weeklyLoss = lossFraction(realizedPnlWeekScaled, bankrollScaled);
  const dailyBreached = dailyLoss >= limits.perdaDiariaMaxScaled;
  const weeklyBreached = weeklyLoss >= limits.perdaSemanalMaxScaled;

  if (dailyBreached || weeklyBreached) {
    const dailyUntil = nextUtcMidnight(now);
    const weeklyUntil = new Date(
      now.getTime() + limits.reduceOnlyWeekDays * DAY_MS,
    );
    let until = dailyBreached ? dailyUntil : weeklyUntil;
    let triggerSource: StateTriggerSource = dailyBreached
      ? "daily_loss"
      : "weekly_loss";
    let reason = dailyBreached ? "perda_diaria_max" : "perda_semanal_max";
    if (weeklyBreached && weeklyUntil.getTime() > until.getTime()) {
      until = weeklyUntil;
      triggerSource = "weekly_loss";
      reason = "perda_semanal_max";
    }
    // An existing throttle is never shortened by a newer, closer deadline.
    if (
      current.reduceOnlyUntil !== null &&
      current.reduceOnlyUntil.getTime() > until.getTime()
    ) {
      until = current.reduceOnlyUntil;
    }
    const next: PortfolioStateSnapshot = {
      ...base,
      state: "REDUCE_ONLY",
      reason,
      reduceOnlyUntil: until,
    };
    if (current.state === "REDUCE_ONLY") {
      return { next, transition: null };
    }
    return {
      next,
      transition: {
        from: current.state,
        to: "REDUCE_ONLY",
        reason,
        triggerSource,
        detail: {
          daily_loss: dailyLoss.toString(),
          weekly_loss: weeklyLoss.toString(),
          until: until.toISOString(),
        },
      },
    };
  }

  // 4. Recovery: only from REDUCE_ONLY, and only once the window has expired.
  if (current.state === "REDUCE_ONLY") {
    const expired =
      current.reduceOnlyUntil === null ||
      current.reduceOnlyUntil.getTime() <= now.getTime();
    if (!expired) {
      return { next: { ...base, state: "REDUCE_ONLY" }, transition: null };
    }
    return {
      next: {
        ...base,
        state: "NORMAL",
        reason: null,
        reduceOnlyUntil: null,
      },
      transition: {
        from: "REDUCE_ONLY",
        to: "NORMAL",
        reason: "reduce_only_window_expired",
        triggerSource: "window_expired",
        detail: {
          daily_loss: dailyLoss.toString(),
          weekly_loss: weeklyLoss.toString(),
        },
      },
    };
  }

  return { next: base, transition: null };
}

/** Manual halt (idempotent): always allowed, from any state. */
export function manualHalt(
  current: PortfolioStateSnapshot,
  now: Date,
  reason: string,
): StateEvaluation {
  if (current.state === "HALTED") {
    return { next: current, transition: null };
  }
  return {
    next: {
      ...current,
      state: "HALTED",
      reason,
      haltedAt: now,
      manualHalt: true,
      reduceOnlyUntil: null,
    },
    transition: {
      from: current.state,
      to: "HALTED",
      reason,
      triggerSource: "manual",
      detail: { manual: true },
    },
  };
}

/**
 * Manual resume. Only from HALTED, and it lands in NORMAL only when the
 * condition that halted the portfolio has actually cleared — resuming into a
 * live drawdown breach would re-halt on the next tick anyway, so the honest
 * answer is to refuse.
 */
export function manualResume(
  current: PortfolioStateSnapshot,
  now: Date,
  limits: StateLimits,
): { evaluation: StateEvaluation; refusedReason: string | null } {
  if (current.state !== "HALTED") {
    return {
      evaluation: { next: current, transition: null },
      refusedReason: "NOT_HALTED",
    };
  }
  if (current.drawdownScaled >= limits.drawdownMaxScaled) {
    return {
      evaluation: { next: current, transition: null },
      refusedReason: "DRAWDOWN_STILL_BREACHED",
    };
  }
  return {
    evaluation: {
      next: {
        ...current,
        state: "NORMAL",
        reason: null,
        haltedAt: null,
        manualHalt: false,
        reduceOnlyUntil: null,
        // The high-water mark is re-based to the current equity on resume:
        // otherwise the portfolio would resume already at its drawdown limit
        // and halt again immediately.
        highWaterMarkScaled: current.equityScaled,
        drawdownScaled: 0n,
      },
      transition: {
        from: "HALTED",
        to: "NORMAL",
        reason: "manual_resume",
        triggerSource: "manual",
        detail: { resumed_at: now.toISOString() },
      },
    },
    refusedReason: null,
  };
}

/** Cap headroom in USD for one dimension, at total loss. Never negative. */
export function capHeadroom(
  capFractionScaled: bigint,
  bankrollScaled: bigint,
  usedScaled: bigint,
): bigint {
  const cap = mul(capFractionScaled, bankrollScaled);
  const headroom = cap - usedScaled;
  return headroom > 0n ? headroom : 0n;
}

/** Utilization of a cap in [0, ...]; 1 means exactly at the cap. */
export function capUtilization(
  capFractionScaled: bigint,
  bankrollScaled: bigint,
  usedScaled: bigint,
): bigint {
  const cap = mul(capFractionScaled, bankrollScaled);
  if (cap <= 0n) {
    return usedScaled > 0n ? SCALE : 0n;
  }
  return div(usedScaled, cap);
}
