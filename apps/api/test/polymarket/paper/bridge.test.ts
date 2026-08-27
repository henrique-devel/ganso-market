// RFC-013 bridge: what the job decides BEFORE it touches the broker.
//
// The acceptance path itself is brokerstore's, tested there and against real
// PostgreSQL. What is tested here is everything the bridge owns and could get
// silently wrong:
//
//   * which decisions it picks up — accepted entries only, still fresh, and not
//     already turned into an order;
//   * that a decision which aged out is DROPPED and counted, never resurrected
//     against a book that has moved on;
//   * that the conservative bound flips with the leg (q_lo to buy, q_hi to
//     sell), because the portfolio engine models the NO leg as selling the
//     affirmative token and passing q_lo there would be the optimistic bound
//     wearing the conservative one's name;
//   * that the order id is derived from the decision, which is what makes a
//     crash between accepting and stamping unable to duplicate an order;
//   * that a resolution refusal stops the bridge, with the refusal's own reason.
//
// The pool is a fake that answers by SQL shape, so a test cannot pass by
// stubbing the store: the queries themselves are part of what is asserted.

import { describe, expect, it } from "vitest";

import {
  MAX_DECISION_AGE_MS,
  bridgeOrderId,
  bridgeTick,
  conservativeBound,
} from "../../../src/polymarket/paper/bridge.js";
import type { PaperPool } from "../../../src/polymarket/paper/brokerstore.js";

type Row = Record<string, unknown>;

const NOW = new Date("2026-08-27T12:00:00.000Z");
const CONDITION = "0xa";
const TOKEN = "tok-1";

interface WorldOptions {
  readonly decisions?: Row[];
  readonly agedOut?: number;
  /** null means "no params recorded", which must stop the bridge. */
  readonly tickSize?: string | null;
  /** Book age in ms at `NOW`; the default is fresh. */
  readonly bookAgeMs?: number;
  readonly gateAllowed?: boolean;
  readonly gateReason?: string;
}

interface World {
  readonly pool: PaperPool;
  readonly queries: { text: string; params: readonly unknown[] }[];
}

function decision(overrides: Row = {}): Row {
  return {
    decision_id: 42,
    condition_id: CONDITION,
    token_id: TOKEN,
    market_side: "YES",
    order_side: "BUY",
    decision_ts: new Date(NOW.getTime() - 5_000),
    q_lo: "0.750000",
    q_hi: "0.850000",
    size_shares: "20.000000",
    ...overrides,
  };
}

function world(options: WorldOptions = {}): World {
  const queries: { text: string; params: readonly unknown[] }[] = [];
  const bookAgeMs = options.bookAgeMs ?? 2_000;

  const pool: PaperPool = {
    query<R extends Row>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<{ rows: R[]; rowCount: number }> {
      queries.push({ text, params });
      const respond = (rows: Row[]): Promise<{ rows: R[]; rowCount: number }> =>
        Promise.resolve({ rows: rows as R[], rowCount: rows.length });

      if (text.includes("count(*) AS aged_out")) {
        return respond([{ aged_out: options.agedOut ?? 0 }]);
      }
      if (text.includes("FROM portfolio_decisions d")) {
        return respond(options.decisions ?? []);
      }
      if (text.includes("FROM polymarket_param_versions")) {
        return options.tickSize === null
          ? respond([])
          : respond([
              {
                param_version_id: 1,
                tick_size: options.tickSize ?? "0.01",
                min_order_size: "5",
                taker_fee_bps: "700",
                neg_risk: false,
              },
            ]);
      }
      if (text.includes("FROM polymarket_book_snapshots")) {
        return respond([
          {
            bids_json: [{ price: "0.61", size: "500" }],
            asks_json: [{ price: "0.62", size: "500" }],
            source_ts: new Date(NOW.getTime() - bookAgeMs),
            received_at: new Date(NOW.getTime() - bookAgeMs),
          },
        ]);
      }
      if (text.includes("FROM paper_feature_windows")) {
        return respond([{ mins_to_catalyst: 600 }]);
      }
      // Anything else (the acceptance path) must not be reached by these tests.
      return respond([]);
    },
  };

  return { pool, queries };
}

async function run(options: WorldOptions = {}): Promise<{
  world: World;
  logs: Row[];
  outcome: Awaited<ReturnType<typeof bridgeTick>>;
}> {
  const w = world(options);
  const logs: Row[] = [];
  const outcome = await bridgeTick(w.pool, {
    clock: () => NOW,
    logSink: (line) => {
      logs.push(JSON.parse(line) as Row);
    },
    resolutionGateFn: () =>
      Promise.resolve({
        allowed: options.gateAllowed ?? true,
        reason:
          options.gateAllowed === false ? (options.gateReason ?? "X") : null,
        action: "NONE",
        score: null,
        scoreVersion: null,
        justification: null,
        resolutionBuffer: null,
        p5050: null,
        sanityVetoActive: false,
        overrideApplied: false,
      }),
  });
  return { world: w, logs, outcome };
}

describe("which decisions the bridge picks up", () => {
  it("asks only for accepted entries with no order, inside the freshness window", async () => {
    const { world: w } = await run();
    const pending = w.queries.find((query) =>
      query.text.includes("FROM portfolio_decisions d"),
    );
    expect(pending).toBeDefined();
    const text = pending?.text ?? "";
    expect(text).toContain("d.outcome = 'ACCEPTED'");
    expect(text).toContain("d.decision_kind = 'ENTRY'");
    expect(text).toContain("d.decision_ts > $1");
    // The authority against acting twice is the order table, not the stamp:
    // the stamp lands up to a minute later, on the portfolio's own cycle.
    expect(text).toContain("NOT EXISTS");
    expect(text).toContain(
      "FROM paper_orders o WHERE o.decision_id = d.decision_id",
    );
    expect(pending?.params[0]).toEqual(
      new Date(NOW.getTime() - MAX_DECISION_AGE_MS),
    );
  });

  it("counts decisions that aged out and warns, instead of executing them late", async () => {
    const { logs, outcome } = await run({ agedOut: 3 });
    expect(outcome).toMatchObject({ considered: 0, accepted: 0, agedOut: 3 });
    const tick = logs.find((line) => line.reason_code === "BRIDGE_TICK");
    expect(tick).toMatchObject({ level: "warn", aged_out: 3 });
  });

  it("says nothing at all when there is no work and nothing aged out", async () => {
    const { logs, outcome } = await run();
    expect(outcome.considered).toBe(0);
    expect(logs).toEqual([]);
  });
});

describe("what stops a decision from becoming an order", () => {
  it("stops on a resolution refusal, carrying the refusal's own reason", async () => {
    const { logs, outcome } = await run({
      decisions: [decision()],
      gateAllowed: false,
      gateReason: "RESOLUTION_CIRCUIT_BREAKER",
    });
    expect(outcome).toMatchObject({ considered: 1, accepted: 0, skipped: 1 });
    expect(
      logs.find((line) => line.reason_code === "BRIDGE_DECISION_SKIPPED"),
    ).toMatchObject({ reason: "RESOLUTION_CIRCUIT_BREAKER", decision_id: 42 });
  });

  it("stops when the market has no recorded parameters", async () => {
    const { logs } = await run({ decisions: [decision()], tickSize: null });
    expect(
      logs.find((line) => line.reason_code === "BRIDGE_DECISION_SKIPPED"),
    ).toMatchObject({ reason: "UNKNOWN_MARKET_PARAMS" });
  });

  it("stops when the newest recorded book is stale", async () => {
    const { logs } = await run({
      decisions: [decision()],
      bookAgeMs: 45_000,
    });
    expect(
      logs.find((line) => line.reason_code === "BRIDGE_DECISION_SKIPPED"),
    ).toMatchObject({ reason: "NO_FRESH_BOOK" });
  });

  it("stops on a decision that carries no size or no bound", async () => {
    const { logs } = await run({
      decisions: [decision({ size_shares: null })],
    });
    expect(
      logs.find((line) => line.reason_code === "BRIDGE_DECISION_SKIPPED"),
    ).toMatchObject({ reason: "DECISION_INCOMPLETE" });
  });

  it("refuses an unreadable row instead of guessing its side", async () => {
    const { logs, outcome } = await run({
      decisions: [decision({ order_side: "MAYBE" })],
    });
    expect(outcome.skipped).toBe(1);
    expect(
      logs.find((line) => line.reason_code === "BRIDGE_DECISION_UNREADABLE"),
    ).toBeDefined();
  });
});

describe("the conservative bound flips with the leg", () => {
  it("quotes a BUY against q_lo and a SELL against q_hi", () => {
    expect(conservativeBound("BUY", "0.750000", "0.850000")).toBe("0.750000");
    // Selling the affirmative token IS the NO leg: the pessimistic case is the
    // probability being as HIGH as q_hi, so q_lo here would be the optimistic
    // bound under the conservative one's name.
    expect(conservativeBound("SELL", "0.750000", "0.850000")).toBe("0.850000");
  });

  it("has no bound to quote against when the interval is missing", () => {
    expect(conservativeBound("BUY", null, "0.850000")).toBeNull();
    expect(conservativeBound("SELL", "0.750000", null)).toBeNull();
  });
});

describe("idempotency", () => {
  it("derives the order id from the decision, so a retry cannot duplicate", () => {
    expect(bridgeOrderId(42)).toBe("portfolio:42");
    expect(bridgeOrderId(42)).toBe(bridgeOrderId(42));
    expect(bridgeOrderId(43)).not.toBe(bridgeOrderId(42));
  });
});
