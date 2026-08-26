// RFC-013 runtime: the two flows this phase added, driven through the runner.
//
// The critical paths, and only those:
//
//   * the exit cycle evaluates open positions and writes an EXIT decision when
//     the verdict CHANGES — which is what makes the shadow measurement usable
//     instead of a heartbeat with twenty thousand identical rows in it;
//   * the gate cycle writes one immutable measurement per gate, starts the
//     per-category G2 clock, and audits the replay of what it just wrote.
//
// The pool is a fake that answers by SQL shape. It is deliberately literal about
// the queries: a test that stubbed the store functions would pass even if the
// runner asked the wrong question.

import { describe, expect, it } from "vitest";

import { DEFAULT_PORTFOLIO_CONFIG } from "../../../src/polymarket/portfolio/config.js";
import { DEFAULT_FACTOR_MAP } from "../../../src/polymarket/portfolio/factors.js";
import { createPortfolioRunner } from "../../../src/polymarket/portfolio/runner.js";
import type { PortfolioPool } from "../../../src/polymarket/portfolio/types.js";

type Row = Record<string, unknown>;

const NOW = new Date("2026-08-26T12:00:00Z");
const CONFIG = DEFAULT_PORTFOLIO_CONFIG;

interface WorldOptions {
  /** Exit signature already on record for the position, or null for none. */
  readonly lastExitSignature?: string | null;
  /** Bids of the position's book; the default leaves plenty of residual edge. */
  readonly bids?: { price: string; size: string }[];
}

interface World {
  readonly pool: PortfolioPool;
  readonly inserts: { table: string; params: readonly unknown[] }[];
  readonly queries: string[];
}

function world(options: WorldOptions = {}): World {
  const inserts: { table: string; params: readonly unknown[] }[] = [];
  const queries: string[] = [];
  const bids = options.bids ?? [
    { price: "0.61", size: "500" },
    { price: "0.60", size: "500" },
  ];

  const pool: PortfolioPool = {
    query<R extends Row>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<{ rows: R[]; rowCount: number }> {
      queries.push(text);
      const respond = (rows: Row[]): Promise<{ rows: R[]; rowCount: number }> =>
        Promise.resolve({ rows: rows as R[], rowCount: rows.length });

      // ---- writes -------------------------------------------------------
      // The digit in portfolio_g2_clock matters: [a-z_]+ would capture
      // "portfolio_g" and make the clock indistinguishable from its events.
      const insert = /INSERT INTO ([a-z0-9_]+)/.exec(text);
      if (insert !== null) {
        const table = insert[1] ?? "";
        inserts.push({ table, params });
        if (table === "portfolio_decisions") {
          return respond([{ decision_id: 101 }]);
        }
        return respond([]);
      }
      if (text.startsWith("UPDATE ") || text.includes("UPDATE portfolio")) {
        inserts.push({ table: "update", params });
        return respond([]);
      }

      // ---- reads, most specific first ------------------------------------
      if (text.includes("FROM portfolio_config_versions WHERE version")) {
        return respond([{ config_hash: "" }]);
      }
      if (text.includes("FROM portfolio_factor_map_versions WHERE version")) {
        return respond([{ content_hash: "" }]);
      }
      if (text.includes("FROM portfolio_state WHERE portfolio_id = 1")) {
        return respond([
          {
            state: "NORMAL",
            reason: null,
            bankroll_usd: "1000.000000",
            high_water_mark_usd: "1000.000000",
            equity_usd: "1000.000000",
            drawdown: "0.000000",
            realized_pnl_day_usd: "0.000000",
            realized_pnl_week_usd: "0.000000",
            day_bucket: "2026-08-26",
            week_start: "2026-08-24",
            reduce_only_until: null,
            halted_at: null,
            manual_halt: false,
          },
        ]);
      }
      if (text.includes("FROM portfolio_circuit_breakers")) {
        return respond([]);
      }
      if (text.includes("FROM unnest($1::text[]) AS m(condition_id)")) {
        return respond([
          {
            condition_id: "0xa",
            clarified_at: null,
            param_changed_at: null,
            rule_precision_risk: "0.1",
          },
        ]);
      }
      if (text.includes("WHERE p.resolved_at IS NOT NULL")) {
        return respond([]);
      }
      if (text.includes("FROM paper_positions") && text.includes("shares")) {
        return respond([
          {
            token_id: "t1",
            condition_id: "0xa",
            shares: "100",
            cost_usd: "50",
            opened_at: new Date("2026-08-25T12:00:00Z"),
            resolved_at: null,
            category: "crypto",
            question: "Will BTC be above $88,000?",
            affirmative_token_id: "t1",
            neg_risk: false,
            param_version: 2,
            event_id: "e1",
            resolution_source: "UMA:0xadapter",
            end_date: new Date("2026-08-28T12:00:00Z"),
            rule_version: 3,
          },
        ]);
      }
      if (text.includes("FROM polymarket_book_snapshots")) {
        return respond([
          {
            token_id: "t1",
            bids_json: bids,
            asks_json: [{ price: "0.62", size: "300" }],
            received_at: new Date("2026-08-26T11:59:58Z"),
          },
        ]);
      }
      if (text.includes("FROM fundamental_estimates")) {
        return respond([
          {
            q: "0.700000",
            q_lo: "0.660000",
            q_hi: "0.740000",
            source: "MODEL",
            decision_ts: new Date("2026-08-26T11:59:00Z"),
          },
        ]);
      }
      if (text.includes("FROM resolution_market_state")) {
        return respond([
          {
            effective_action: "NONE",
            score: "0.200000",
            score_version: "1.1.1",
            resolution_buffer: "0.001000",
            p_5050: "0.010000",
            expected_lockup_s: 3_600,
            dispute_active: false,
            justification: null,
            computed_at: new Date("2026-08-26T11:30:00Z"),
          },
        ]);
      }
      if (text.includes("decision_kind = 'ENTRY'")) {
        return respond([
          {
            decision_id: 41,
            decision_ts: new Date("2026-08-25T12:00:00Z"),
            market_side: "YES",
            q_lo: "0.650000",
            q_hi: "0.750000",
            rule_version: 3,
            resolution_source: "UMA:0xadapter",
            invalidation_prob_lower_below: "0.520000",
            rule_precision_multiplier: "0.9",
          },
        ]);
      }
      if (text.includes("{exit,signature}")) {
        const signature = options.lastExitSignature;
        return respond(
          signature === undefined || signature === null ? [] : [{ signature }],
        );
      }
      if (text.includes("FROM portfolio_g2_clock")) {
        return respond([]);
      }
      if (text.includes("FROM polymarket_param_versions p")) {
        return respond([
          {
            category: "crypto",
            fee_base_bps: "700",
            maker_fee_bps: "0",
            taker_fee_bps: "700",
            tick_size: "0.01",
            min_order_size: "5",
            neg_risk: false,
          },
        ]);
      }
      if (text.includes("FROM fundamental_labels")) {
        return respond([]);
      }
      if (text.includes("FROM portfolio_exposures e")) {
        return respond([{ breaches: 0 }]);
      }
      if (text.includes("AS max_drawdown")) {
        return respond([{ max_drawdown: "0" }]);
      }
      if (text.includes("DISTINCT kind FROM portfolio_circuit_breakers")) {
        return respond([]);
      }
      if (text.includes("to_state = 'REDUCE_ONLY'")) {
        return respond([{ exercised: false }]);
      }
      if (text.includes("min(received_at) AS oldest")) {
        return respond([{ oldest: new Date("2026-08-20T00:00:00Z") }]);
      }
      if (text.includes("kill_switch_engaged")) {
        return respond([{ exercised: false }]);
      }
      if (text.includes("FROM portfolio_gate_reports")) {
        return respond([]);
      }
      if (text.includes("FROM paper_ledger_events")) {
        return respond([]);
      }
      if (text.includes("ORDER BY decision_id DESC")) {
        return respond([]);
      }
      if (text.includes("FROM polymarket_universe_log")) {
        return respond([]);
      }
      return respond([]);
    },
  };
  return { pool, inserts, queries };
}

function runner(pool: PortfolioPool) {
  return createPortfolioRunner({
    pool,
    config: CONFIG,
    factorMap: DEFAULT_FACTOR_MAP,
    executionMode: "paper",
    clock: () => NOW,
  });
}

describe("exit cycle", () => {
  it("writes an EXIT decision for a position it has never evaluated", async () => {
    const scene = world();
    await runner(scene.pool).tickOnce("exits");
    const decisions = scene.inserts.filter(
      (row) => row.table === "portfolio_decisions",
    );
    expect(decisions).toHaveLength(1);
    // decision_kind, condition_id, token_id, market_side, order_side
    expect(decisions[0]?.params[0]).toBe("EXIT");
    expect(decisions[0]?.params[3]).toBe("YES");
    expect(decisions[0]?.params[4]).toBe("SELL");
  });

  it("records a HOLD as a decision, not as silence", async () => {
    // "We looked and decided to stay" is evidence, and its absence would be
    // indistinguishable from never having looked.
    const scene = world();
    await runner(scene.pool).tickOnce("exits");
    const decision = scene.inserts.find(
      (row) => row.table === "portfolio_decisions",
    );
    // outcome, reason_code
    expect(decision?.params[37]).toBe("REJECTED");
    expect(decision?.params[38]).toBe("HOLD_NO_EXIT_SIGNAL");
  });

  it("does NOT rewrite the same verdict on the next cycle", async () => {
    const scene = world({ lastExitSignature: "hold" });
    await runner(scene.pool).tickOnce("exits");
    expect(
      scene.inserts.filter((row) => row.table === "portfolio_decisions"),
    ).toHaveLength(0);
  });

  it("writes again when the verdict changes", async () => {
    // The bid has risen to where it captures the advantage: the verdict moves
    // from `hold` to EDGE_CAPTURED_AT_BID, and that is worth a row.
    const scene = world({
      lastExitSignature: "hold",
      bids: [
        { price: "0.659", size: "500" },
        { price: "0.658", size: "500" },
      ],
    });
    await runner(scene.pool).tickOnce("exits");
    const decisions = scene.inserts.filter(
      (row) => row.table === "portfolio_decisions",
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.params[37]).toBe("ACCEPTED");
    expect(decisions[0]?.params[38]).toBeNull();
  });

  it("persists the replay block and the book excerpt with the decision", async () => {
    // Without both, the mandatory replay could not re-derive the exit once the
    // raw book snapshot is pruned.
    const scene = world();
    await runner(scene.pool).tickOnce("exits");
    const decision = scene.inserts.find(
      (row) => row.table === "portfolio_decisions",
    );
    const book = JSON.parse(String(decision?.params[35])) as {
      bids: unknown[];
    };
    const inputs = JSON.parse(String(decision?.params[36])) as {
      exit: { signature: string };
      replay: { engine: string; shares: string };
    };
    expect(book.bids.length).toBeGreaterThan(0);
    expect(inputs.replay.engine).toBe("planExit");
    expect(inputs.replay.shares).toBe("100.000000000");
    expect(inputs.exit.signature).toBe("hold");
  });
});

describe("gate cycle", () => {
  it("writes one measurement per gate", async () => {
    const scene = world();
    await runner(scene.pool).tickOnce("gates");
    const measurements = scene.inserts.filter(
      (row) => row.table === "portfolio_gate_measurements",
    );
    expect(measurements.map((row) => row.params[0])).toEqual([
      "G1",
      "G2",
      "G3",
      "G4",
      "G5",
      "G6",
    ]);
  });

  it("starts the per-category G2 clock and records why", async () => {
    const scene = world();
    await runner(scene.pool).tickOnce("gates");
    const clock = scene.inserts.find(
      (row) => row.table === "portfolio_g2_clock",
    );
    const event = scene.inserts.find(
      (row) => row.table === "portfolio_g2_clock_events",
    );
    expect(clock?.params[0]).toBe("crypto");
    expect(clock?.params[3]).toBe("clock_started");
    // The append-only event is what makes a passing G2 traceable to the regime
    // it was measured under.
    expect(event?.params[5]).toBe("clock_started");
  });

  it("records every non-PASS gate with a reason code", async () => {
    const scene = world();
    await runner(scene.pool).tickOnce("gates");
    for (const row of scene.inserts.filter(
      (entry) => entry.table === "portfolio_gate_measurements",
    )) {
      if (row.params[1] !== "PASS") {
        expect(row.params[2], String(row.params[0])).not.toBeNull();
      }
    }
  });

  it("audits the replay of the decision log in the same cycle", async () => {
    const scene = world();
    await runner(scene.pool).tickOnce("gates");
    expect(
      scene.queries.some((text) => text.includes("ORDER BY decision_id DESC")),
    ).toBe(true);
  });
});

describe("scope", () => {
  it("refuses to run in any mode other than paper", () => {
    expect(() =>
      createPortfolioRunner({
        pool: world().pool,
        config: CONFIG,
        factorMap: DEFAULT_FACTOR_MAP,
        executionMode: "shadow",
      }),
    ).toThrowError(/paper/);
  });

  it("rejects an unknown job name instead of doing nothing", async () => {
    await expect(runner(world().pool).tickOnce("whatever")).rejects.toThrow(
      /unknown job/,
    );
  });
});
