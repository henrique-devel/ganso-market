import { describe, expect, it } from "vitest";

import { parseScaled } from "../../../src/polymarket/fundamental/fixed.js";
import {
  canIncreaseExposure,
  capHeadroom,
  capUtilization,
  evaluateState,
  manualHalt,
  manualResume,
  nextUtcMidnight,
  utcDayBucket,
  utcWeekStart,
  type PortfolioStateSnapshot,
  type StateLimits,
} from "../../../src/polymarket/portfolio/state.js";
import { money } from "../../../src/polymarket/portfolio/ev.js";

function s(value: string): bigint {
  const parsed = parseScaled(value);
  if (parsed === null) {
    throw new Error(`unparseable fixture value: ${value}`);
  }
  return parsed;
}

const NOW = new Date("2026-08-26T12:00:00.000Z");

const LIMITS: StateLimits = {
  perdaDiariaMaxScaled: s("0.03"),
  perdaSemanalMaxScaled: s("0.06"),
  drawdownMaxScaled: s("0.10"),
  reduceOnlyWeekDays: 7,
};

const NORMAL: PortfolioStateSnapshot = {
  state: "NORMAL",
  reason: null,
  bankrollScaled: s("1000"),
  highWaterMarkScaled: s("1000"),
  equityScaled: s("1000"),
  drawdownScaled: 0n,
  realizedPnlDayScaled: 0n,
  realizedPnlWeekScaled: 0n,
  dayBucket: utcDayBucket(NOW),
  weekStart: utcWeekStart(NOW),
  reduceOnlyUntil: null,
  haltedAt: null,
  manualHalt: false,
};

const CLEAN = {
  now: NOW,
  limits: LIMITS,
  bankrollBaseScaled: s("1000"),
  realizedPnlTotalScaled: 0n,
  realizedPnlDayScaled: 0n,
  realizedPnlWeekScaled: 0n,
  openMarkScaled: 0n,
  openCostScaled: 0n,
};

describe("calendar buckets", () => {
  it("buckets the day in UTC and the week from Monday", () => {
    expect(utcDayBucket(new Date("2026-08-26T23:59:59Z"))).toBe("2026-08-26");
    // 2026-08-26 is a Wednesday; its ISO week starts Monday 2026-08-24.
    expect(utcWeekStart(new Date("2026-08-26T12:00:00Z"))).toBe("2026-08-24");
    // A Sunday belongs to the week that started the previous Monday.
    expect(utcWeekStart(new Date("2026-08-30T12:00:00Z"))).toBe("2026-08-24");
    expect(utcWeekStart(new Date("2026-08-31T00:00:00Z"))).toBe("2026-08-31");
  });

  it("expires a daily throttle at the next 00:00 UTC, not 24h later", () => {
    expect(nextUtcMidnight(NOW).toISOString()).toBe("2026-08-27T00:00:00.000Z");
  });
});

describe("loss limits", () => {
  it("stays NORMAL while losses are inside the limits", () => {
    const result = evaluateState({
      ...CLEAN,
      current: NORMAL,
      realizedPnlDayScaled: -s("20"),
      realizedPnlWeekScaled: -s("20"),
      realizedPnlTotalScaled: -s("20"),
    });
    expect(result.next.state).toBe("NORMAL");
    expect(result.transition).toBeNull();
  });

  it("throttles to REDUCE_ONLY on the daily limit, until the next 00:00 UTC", () => {
    const result = evaluateState({
      ...CLEAN,
      current: NORMAL,
      realizedPnlDayScaled: -s("30"),
      realizedPnlWeekScaled: -s("30"),
      realizedPnlTotalScaled: -s("30"),
    });
    expect(result.next.state).toBe("REDUCE_ONLY");
    expect(result.next.reason).toBe("perda_diaria_max");
    expect(result.next.reduceOnlyUntil?.toISOString()).toBe(
      "2026-08-27T00:00:00.000Z",
    );
    expect(result.transition?.triggerSource).toBe("daily_loss");
  });

  it("throttles for seven days on the weekly limit", () => {
    const result = evaluateState({
      ...CLEAN,
      current: NORMAL,
      realizedPnlDayScaled: -s("10"),
      realizedPnlWeekScaled: -s("60"),
      realizedPnlTotalScaled: -s("60"),
    });
    expect(result.next.state).toBe("REDUCE_ONLY");
    expect(result.next.reason).toBe("perda_semanal_max");
    expect(result.next.reduceOnlyUntil?.toISOString()).toBe(
      "2026-09-02T12:00:00.000Z",
    );
  });

  it("never shortens a weekly throttle with a daily one that trips inside it", () => {
    const weekly = new Date("2026-09-02T12:00:00.000Z");
    const result = evaluateState({
      ...CLEAN,
      current: {
        ...NORMAL,
        state: "REDUCE_ONLY",
        reason: "perda_semanal_max",
        reduceOnlyUntil: weekly,
      },
      realizedPnlDayScaled: -s("40"),
      realizedPnlWeekScaled: -s("40"),
      realizedPnlTotalScaled: -s("40"),
    });
    expect(result.next.reduceOnlyUntil?.toISOString()).toBe(
      weekly.toISOString(),
    );
  });

  it("recovers to NORMAL only after the window has actually expired", () => {
    const throttled: PortfolioStateSnapshot = {
      ...NORMAL,
      state: "REDUCE_ONLY",
      reason: "perda_diaria_max",
      reduceOnlyUntil: new Date("2026-08-26T18:00:00.000Z"),
    };
    const stillThrottled = evaluateState({ ...CLEAN, current: throttled });
    expect(stillThrottled.next.state).toBe("REDUCE_ONLY");

    const recovered = evaluateState({
      ...CLEAN,
      now: new Date("2026-08-26T18:00:01.000Z"),
      current: throttled,
    });
    expect(recovered.next.state).toBe("NORMAL");
    expect(recovered.transition?.triggerSource).toBe("window_expired");
  });

  it("zeroes the daily accrual when the UTC day rolls over", () => {
    const result = evaluateState({
      ...CLEAN,
      now: new Date("2026-08-27T00:00:01.000Z"),
      current: { ...NORMAL, realizedPnlDayScaled: -s("30") },
      realizedPnlDayScaled: -s("30"),
    });
    expect(result.next.realizedPnlDayScaled).toBe(0n);
    expect(result.next.state).toBe("NORMAL");
  });
});

describe("drawdown and HALTED", () => {
  it("halts at the drawdown limit against the high-water mark", () => {
    const result = evaluateState({
      ...CLEAN,
      current: { ...NORMAL, highWaterMarkScaled: s("1000") },
      realizedPnlTotalScaled: -s("100"),
    });
    expect(result.next.state).toBe("HALTED");
    expect(result.next.reason).toBe("drawdown_max");
    expect(result.next.haltedAt).toEqual(NOW);
    expect(money(result.next.drawdownScaled)).toBe("0.100000");
  });

  it("measures the drawdown on equity, including the open mark", () => {
    // Realized PnL is flat but open positions are marked down 12%: that is a
    // real drawdown and it must halt.
    const result = evaluateState({
      ...CLEAN,
      current: { ...NORMAL, highWaterMarkScaled: s("1000") },
      openCostScaled: s("500"),
      openMarkScaled: s("380"),
    });
    expect(result.next.state).toBe("HALTED");
  });

  it("does NOT release HALTED when the drawdown recovers", () => {
    // The absorbing property: nothing automatic ever leaves HALTED.
    const halted: PortfolioStateSnapshot = {
      ...NORMAL,
      state: "HALTED",
      reason: "drawdown_max",
      haltedAt: NOW,
      highWaterMarkScaled: s("1000"),
    };
    const result = evaluateState({
      ...CLEAN,
      current: halted,
      realizedPnlTotalScaled: s("200"),
    });
    expect(result.next.state).toBe("HALTED");
    expect(result.transition).toBeNull();
  });

  it("does not let a REDUCE_ONLY recovery outrank a drawdown halt", () => {
    const throttled: PortfolioStateSnapshot = {
      ...NORMAL,
      state: "REDUCE_ONLY",
      reason: "perda_diaria_max",
      reduceOnlyUntil: new Date("2026-08-26T06:00:00.000Z"),
      highWaterMarkScaled: s("1000"),
    };
    const result = evaluateState({
      ...CLEAN,
      current: throttled,
      realizedPnlTotalScaled: -s("150"),
    });
    expect(result.next.state).toBe("HALTED");
  });

  it("raises the high-water mark on new equity highs but never lowers it", () => {
    const up = evaluateState({
      ...CLEAN,
      current: NORMAL,
      realizedPnlTotalScaled: s("250"),
    });
    expect(money(up.next.highWaterMarkScaled)).toBe("1250.000000");

    const down = evaluateState({
      ...CLEAN,
      current: { ...NORMAL, highWaterMarkScaled: s("1250") },
      realizedPnlTotalScaled: -s("10"),
    });
    expect(money(down.next.highWaterMarkScaled)).toBe("1250.000000");
  });
});

describe("manual halt and resume", () => {
  it("halts manually from any state and is idempotent", () => {
    const halted = manualHalt(NORMAL, NOW, "operator");
    expect(halted.next.state).toBe("HALTED");
    expect(halted.next.manualHalt).toBe(true);

    const again = manualHalt(halted.next, NOW, "operator");
    expect(again.next).toEqual(halted.next);
    expect(again.transition).toBeNull();
  });

  it("refuses to resume anything that is not HALTED", () => {
    const { refusedReason } = manualResume(NORMAL, NOW, LIMITS);
    expect(refusedReason).toBe("NOT_HALTED");
  });

  it("refuses to resume while the drawdown is still breached", () => {
    const halted: PortfolioStateSnapshot = {
      ...NORMAL,
      state: "HALTED",
      reason: "drawdown_max",
      haltedAt: NOW,
      drawdownScaled: s("0.12"),
    };
    const { refusedReason, evaluation } = manualResume(halted, NOW, LIMITS);
    expect(refusedReason).toBe("DRAWDOWN_STILL_BREACHED");
    expect(evaluation.next.state).toBe("HALTED");
  });

  it("resumes to NORMAL and re-bases the high-water mark", () => {
    // Without re-basing, the portfolio would resume already at its drawdown
    // limit and halt again on the next tick.
    const halted: PortfolioStateSnapshot = {
      ...NORMAL,
      state: "HALTED",
      reason: "drawdown_max",
      haltedAt: NOW,
      highWaterMarkScaled: s("1000"),
      equityScaled: s("905"),
      drawdownScaled: s("0.095"),
    };
    const { refusedReason, evaluation } = manualResume(halted, NOW, LIMITS);
    expect(refusedReason).toBeNull();
    expect(evaluation.next.state).toBe("NORMAL");
    expect(evaluation.next.haltedAt).toBeNull();
    expect(money(evaluation.next.highWaterMarkScaled)).toBe("905.000000");
    expect(evaluation.next.drawdownScaled).toBe(0n);
  });
});

describe("exposure gate", () => {
  it("allows new risk only in NORMAL", () => {
    expect(canIncreaseExposure("NORMAL")).toBe(true);
    expect(canIncreaseExposure("REDUCE_ONLY")).toBe(false);
    expect(canIncreaseExposure("HALTED")).toBe(false);
  });
});

describe("cap arithmetic", () => {
  it("computes headroom at total loss and clamps at zero", () => {
    expect(money(capHeadroom(s("0.05"), s("1000"), s("20")))).toBe("30.000000");
    expect(capHeadroom(s("0.05"), s("1000"), s("80"))).toBe(0n);
  });

  it("reports utilization, and treats a zero cap with usage as fully used", () => {
    expect(money(capUtilization(s("0.05"), s("1000"), s("25")))).toBe(
      "0.500000",
    );
    expect(money(capUtilization(0n, s("1000"), s("1")))).toBe("1.000000");
    expect(capUtilization(0n, s("1000"), 0n)).toBe(0n);
  });
});
