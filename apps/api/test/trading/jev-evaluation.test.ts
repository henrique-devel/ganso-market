import { describe, it, expect } from "vitest";
import {
  jevDurationCoverage,
  jevEpisodes,
  evaluateJevProfile,
  jevEvaluationWindow,
  type CoverageCapture,
  type EvaluationAccount,
} from "../../src/storage/jev-evaluation.js";
import { jevIdentity, jevCommand, iso, start, fill } from "./jev-v2-fixture.js";
import {
  jevScope,
  jevGenesis,
  materializeJevBatch,
} from "../../src/storage/jev-ledger.js";
const identity = jevIdentity(),
  scope = jevScope(identity.bindings[0]!.binding, identity.instrument);
const day = 86400000;
function capture(from: number, at: number): CoverageCapture {
  return {
    object_id: `capture:${at}`,
    recorded_at: iso(at),
    received_at: iso(at),
    payload: {
      id: `capture:${at}`,
      from,
      at,
      session: "one",
      health: {
        socket: { connected: true, alive: true },
        channels: Object.fromEntries(
          ["book", "context", "trades"].map((k) => [
            k,
            {
              status: "healthy",
              needs_revalidation: false,
              last_source_at: from,
              last_received_at: from,
              source_quality: "fresh",
            },
          ]),
        ),
        gaps: [],
      },
    },
  };
}
function trajectory(count: number, partial = false) {
  const events = materializeJevBatch(jevGenesis(identity), "0", iso(start));
  for (let n = 0; n < count; n++)
    for (const [j, side] of (
      ["buy", "buy", "sell", "sell"] as const
    ).entries()) {
      if (partial && n === count - 1 && j === 3) continue;
      const payload = fill(`exec:${n}:${j}`, side, "1000");
      if (payload.event_type !== "fill") throw new Error();
      const positioned = { ...payload, position_id: `position:${n}` };
      const at = start + 1000 + n * 4000 + j * 1000;
      events.push(
        ...materializeJevBatch(
          {
            transaction_id: `trade:${n}:${j}`,
            events: [jevCommand(identity, `fill:${n}:${j}`, positioned, at)],
          },
          String(events.length),
          iso(at),
        ),
      );
    }
  return events;
}
const account = (mode: "paper" | "stress" = "paper"): EvaluationAccount => ({
  scope: jevScope(jevIdentity(mode).bindings[0]!.binding, identity.instrument),
  manifest_hash: "a".repeat(64),
  started_at: iso(start),
  episodes: 60,
  denominator_ms: 90 * day,
  covered_ms: 90 * day,
  costs_complete: true,
  reconciled: true,
  irrecoverable_financial_gap: false,
  proven_risk_failure: false,
  conservative_usd6: "12500000",
  benchmark_usd6: "0",
});
function evaluate(
  a: EvaluationAccount[] = [account(), account("stress")],
  phase: "initial" | "preview30" | "rolling90" = "rolling90",
  extra = {},
) {
  return evaluateJevProfile({
    as_of: iso(start + 90 * day),
    window: { start_at: iso(start), end_at: iso(start + 90 * day) },
    phase,
    accounts: a,
    engine_qualified: true,
    previous_failed: false,
    ...extra,
  });
}
describe("JE09 episodes and duration coverage", () => {
  it("counts full closures, not four fills, and preserves 59/60 across UTC", () => {
    const window = { start_at: iso(start), end_at: iso(start + 1000000) };
    expect(
      jevEpisodes(identity, trajectory(59), scope, window).closed_count,
    ).toBe(59);
    expect(
      jevEpisodes(identity, trajectory(60, true), scope, window),
    ).toMatchObject({ closed_count: 59, open_count: 1 });
    const e = trajectory(60);
    expect(jevEpisodes(identity, e, scope, window).closed_count).toBe(60);
    const boundary = jevEpisodes(identity, e, scope, {
      ...window,
      start_at: iso(start + 235000),
    });
    expect(boundary.closed_count).toBe(2);
    expect(boundary.episodes[0]!.opened_at < boundary.window.start_at).toBe(
      true,
    );
  });
  it("measures exact duration at 99%, reveals internal gaps and ignores duplicate inference-like copies", () => {
    const window = { start_at: iso(start), end_at: iso(start + 100000) };
    const captures = Array.from({ length: 100 }, (_, n) =>
      capture(start + n * 1000, start + (n + 1) * 1000),
    );
    captures.splice(42, 1);
    const q = jevDurationCoverage(window, captures);
    expect(q).toMatchObject({
      denominator_ms: 100000,
      covered_ms: 99000,
      coverage_ppm: 990000,
      gaps: [[start + 42000, start + 43000]],
    });
    expect(jevDurationCoverage(window, [...captures, ...captures])).toEqual(q);
    captures.splice(70, 1);
    expect(jevDurationCoverage(window, captures).coverage_ppm).toBe(980000);
  });
  it("carries an earlier fresh source through continuous healthy captures without inventing freshness", () => {
    const records = Array.from({ length: 101 }, (_, n) =>
      capture(start + (n - 1) * 1000, start + n * 1000),
    );
    for (const r of records)
      for (const k of ["book", "context"] as const) {
        r.payload.health.channels[k]!.last_source_at = r.payload.at;
        r.payload.health.channels[k]!.last_received_at = r.payload.at;
      }
    const q = jevDurationCoverage(
      { start_at: iso(start), end_at: iso(start + 100000) },
      records,
    );
    expect(q.covered_ms).toBe(100000);
    records[50]!.payload.health.channels.context!.source_quality = "unknown";
    records[50]!.payload.health.channels.context!.status = "stale";
    expect(
      jevDurationCoverage(
        { start_at: iso(start), end_at: iso(start + 100000) },
        records,
      ).covered_ms,
    ).toBe(99000);
  });
  it("does not heal gaps with restart, stale source, receive time or healthy edges", () => {
    const window = { start_at: iso(start), end_at: iso(start + 60000) };
    const a = capture(start, start + 1000),
      b = capture(start + 59000, start + 60000);
    expect(jevDurationCoverage(window, [a, b]).covered_ms).toBe(2000);
    a.payload.health.channels.book!.last_source_at = start - 10000;
    expect(jevDurationCoverage(window, [a, b]).covered_ms).toBe(1000);
    b.payload.restarted = true;
    expect(jevDurationCoverage(window, [a, b]).covered_ms).toBe(0);
    const gap = capture(start, start + 1000);
    gap.payload.health.gaps = [
      {
        channel: "book",
        epoch: 1,
        reason: "disconnect",
        recovery: "current_state_only",
        detected_at: start + 500,
        after_source_at: start + 400,
        resumed_at: start + 600,
      },
    ];
    expect(
      jevDurationCoverage({ start_at: iso(start), end_at: iso(start + 1000) }, [
        gap,
      ]).covered_ms,
    ).toBe(800);
  });
});
describe("JE09 initial and rolling state contracts", () => {
  it("requires both alternatives; 59, missing cost, coverage below and unqualified motor cannot promote", () => {
    for (const patch of [
      { episodes: 59 },
      { covered_ms: 89 * day },
      { costs_complete: false },
      { reconciled: false },
      { irrecoverable_financial_gap: true },
      { conservative_usd6: null },
    ])
      expect(
        evaluate([account(), { ...account("stress"), ...patch }]).state,
      ).toBe("inconclusive");
    expect(
      evaluate(undefined, "rolling90", { engine_qualified: false }).state,
    ).toBe("validating");
    const exact = { ...account(), covered_ms: (90 * day * 99) / 100 };
    expect(
      evaluate([exact, { ...exact, scope: account("stress").scope }]).state,
    ).toBe("eligible");
  });
  it("initial results need no benchmark hurdle, exclude positive open PnL upstream, and remain informational", () => {
    const a = {
      ...account(),
      conservative_usd6: "1",
      benchmark_usd6: "500000000",
    };
    const r = evaluate(
      [a, { ...a, scope: account("stress").scope }],
      "initial",
    );
    expect(r.state).toBe("eligible");
    expect(r.operational_admission).toBe(false);
    expect(
      evaluate(
        [a, { ...a, scope: account("stress").scope, conservative_usd6: "0" }],
        "initial",
      ).state,
    ).toBe("failed");
  });
  it("requires the best cash/BTC reference plus $12.50, with exact integer boundaries", () => {
    expect(evaluate().state).toBe("eligible");
    expect(
      evaluate([
        account(),
        { ...account("stress"), conservative_usd6: "12499999" },
      ]).state,
    ).toBe("failed");
    expect(
      evaluate([account(), { ...account("stress"), benchmark_usd6: "1" }])
        .state,
    ).toBe("failed");
    expect(
      evaluate([account(), { ...account("stress"), benchmark_usd6: null }])
        .state,
    ).toBe("inconclusive");
    expect(
      evaluate([
        account(),
        { ...account("stress"), benchmark_usd6: "-9000000" },
      ]).state,
    ).toBe("eligible");
  });
  it("proven risk or either proven economic failure prevails over the other inconclusion and remains failed", () => {
    expect(
      evaluate([
        { ...account(), costs_complete: false },
        { ...account("stress"), proven_risk_failure: true },
      ]).state,
    ).toBe("failed");
    expect(
      evaluate([
        { ...account(), costs_complete: false },
        { ...account("stress"), conservative_usd6: "0" },
      ]).state,
    ).toBe("failed");
    expect(
      evaluate(undefined, "rolling90", { previous_failed: true }).state,
    ).toBe("failed");
  });
  it("does not inherit a different version, tune a preview or reset at the daily boundary", () => {
    expect(() =>
      evaluate([
        account(),
        { ...account("stress"), manifest_hash: "b".repeat(64) },
      ]),
    ).toThrow(/VERSION/);
    expect(evaluate(undefined, "preview30").state).toBe("validating");
    const w = jevEvaluationWindow(iso(start), iso(start + 100 * day + 12345))!;
    expect(w.phase).toBe("rolling90");
    expect(Date.parse(w.window.end_at) - Date.parse(w.window.start_at)).toBe(
      90 * day,
    );
    expect(
      evaluate(undefined, "rolling90", {
        as_of: iso(start + 89 * day),
        window: { start_at: iso(start), end_at: iso(start + 89 * day) },
        accounts: [
          { ...account(), denominator_ms: 89 * day, covered_ms: 89 * day },
          {
            ...account("stress"),
            denominator_ms: 89 * day,
            covered_ms: 89 * day,
          },
        ],
      }).state,
    ).toBe("validating");
    expect(jevEvaluationWindow(iso(start), iso(start + 29 * day))!.phase).toBe(
      "initial",
    );
  });
});

import {
  jevHistoricalMetrics,
  jevMetricsWindow,
} from "../../src/storage/jev-metrics.js";
import { jevCosts } from "../../src/storage/jev-costs.js";
import { market, pricedFill } from "./valuation-fixture.js";
import { funding } from "./ledger-fixture.js";
import {
  startJevBenchmark,
  advanceJevBenchmark,
  jevBenchmarkValuationAt,
} from "../../src/storage/jev-benchmark-engine.js";
import { metadata } from "./bars-fixture.js";
it("reconciles a delayed funding cashflow in the original event-time cut without changing originals or resetting positions", () => {
  const events = materializeJevBatch(jevGenesis(identity), "0", iso(start));
  for (const [n, payload, at] of [
    [0, pricedFill("in", "buy", "100000", "64000000000"), start + 1000],
    [1, pricedFill("out", "sell", "100000", "65000000000"), start + 5000],
    [2, funding("100000"), start + 2000],
  ] as const) {
    events.push(
      ...materializeJevBatch(
        {
          transaction_id: `historical:${n}`,
          events: [jevCommand(identity, `historical:${n}`, payload, at)],
        },
        String(events.length),
        iso(start + 6000),
      ),
    );
  }
  const original = structuredClone(events);
  const cut = (at: number) =>
    jevHistoricalMetrics(
      identity,
      events,
      market(at),
      jevCosts([], scope, { start_at: iso(start), end_at: iso(at) }),
      true,
      iso(start + 6000),
    );
  const a = cut(start + 1000),
    b = cut(start + 3000);
  expect(b).toMatchObject({
    ledger_sequence: "4",
    derived_projection_sequence: "3",
    trading: {
      realized_usd6: "0",
      funding_usd6: "100000",
      open_usd6: "1000000",
    },
  });
  expect(b.positions[0]!.quantity_btc_raw).toBe("100000");
  expect(events).toEqual(original);
  expect(jevMetricsWindow(a, b).conservative_result_usd6).toBe("-900000");
});
it("values the persisted BTC trajectory at a historical edge without a new fill or advance", () => {
  const initial = startJevBenchmark("paper", metadata, market(start + 10000));
  const observed = advanceJevBenchmark(
    initial,
    metadata,
    market(start + 12000),
    [
      {
        period_hour: iso(start),
        received_at: iso(start + 11000),
        row: { coin: "BTC", time: start, fundingRate: "0", premium: "0" },
        oracle: null,
      },
    ],
  );
  const original = structuredClone(observed.state);
  const before = jevBenchmarkValuationAt(
    observed.state,
    market(start + 10500),
    iso(start + 12000),
  );
  const after = jevBenchmarkValuationAt(
    observed.state,
    market(start + 12000),
    iso(start + 12000),
  );
  expect(before.quantity_btc8).toBe("0");
  expect(before.equity_usd6).toBe("250000000");
  expect(after.quantity_btc8).toBe(observed.state.initial_quantity_btc8);
  expect(after.equity_usd6).toBe(observed.observation.equity_usd6);
  expect(observed.state).toEqual(original);
});
