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
  MAX_DECISION_TS_AGE_MS,
  MAX_RECEIVED_AGE_MS,
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
  /** Accepted EXIT rows, answered by the exit selector only. */
  readonly exits?: Row[];
  /** null means "no params recorded", which must stop the bridge. */
  readonly tickSize?: string | null;
  /** Book age in ms at `NOW`; the default is fresh. */
  readonly bookAgeMs?: number;
  readonly gateAllowed?: boolean;
  readonly gateReason?: string;
  /** The paper worker's own PAPER_BOOT instant, as the runner passes it. */
  readonly bootAt?: Date;
  /** Ledger fill events for the token, which is what sizes an exit. */
  readonly positionShares?: string | null;
  /** An exit order already resting for the token. */
  readonly openExitOrder?: boolean;
  /** Fails the ledger read, to prove an unreadable position cannot size a sale. */
  readonly positionReadError?: boolean;
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
    received_at: new Date(NOW.getTime() - 1_000),
    q_lo: "0.750000",
    q_hi: "0.850000",
    size_shares: "20.000000",
    ...overrides,
  };
}

function exitDecision(overrides: Row = {}): Row {
  // The shape `decisionrow.ts` actually writes for an exit: SELL on either leg,
  // no size, `binding_constraint` NOT_SIZED.
  return {
    ...decision({ order_side: "SELL", size_shares: null }),
    decision_id: 77,
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

      // The decision selectors are EVALUATED, not stubbed: the fake applies the
      // very bounds the store passed as parameters. A cutoff computed from the
      // wrong constant, or bound to the wrong placeholder, changes the rows this
      // fake returns — which is the only way a unit test can prove a WHERE
      // clause without a real server.
      const rows = text.includes("d.decision_kind = 'EXIT'")
        ? (options.exits ?? [])
        : (options.decisions ?? []);
      const stamp = (row: Row, column: string): number =>
        (row[column] as Date).getTime();
      const bound = (index: number): number =>
        (params[index] as Date).getTime();
      if (text.includes("JOIN portfolio_decisions d ON d.decision_id")) {
        return respond(options.openExitOrder === true ? [{ "1": 1 }] : []);
      }
      if (text.includes("FROM paper_ledger_events WHERE token_id = $1")) {
        if (options.positionReadError === true) {
          return Promise.reject(new Error("ledger unavailable"));
        }
        const shares = options.positionShares ?? null;
        return respond(
          shares === null
            ? []
            : [
                {
                  idempotency_key: "seed:fill",
                  event_type: "fill",
                  order_id: "seed",
                  token_id: TOKEN,
                  condition_id: CONDITION,
                  payload_json: {
                    side: "BUY",
                    price: "0.500000",
                    size: shares,
                    fee: "0",
                  },
                  event_ts: new Date(NOW.getTime() - 3_600_000),
                },
              ],
        );
      }
      if (text.includes("count(*) AS aged_out")) {
        const aged = rows.filter(
          (row) =>
            (stamp(row, "received_at") <= bound(0) ||
              stamp(row, "decision_ts") <= bound(1)) &&
            stamp(row, "received_at") > bound(2),
        );
        return respond([{ aged_out: aged.length }]);
      }
      if (text.includes("FROM portfolio_decisions d")) {
        const fresh = rows.filter(
          (row) =>
            stamp(row, "received_at") > bound(0) &&
            stamp(row, "decision_ts") > bound(1),
        );
        return respond(fresh.slice(0, params[2] as number));
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
    ...(options.bootAt === undefined ? {} : { bootAt: options.bootAt }),
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
  it("asks only for accepted entries with no order, inside both freshness windows", async () => {
    const { world: w } = await run();
    const pending = w.queries.find((query) =>
      query.text.includes("FROM portfolio_decisions d"),
    );
    expect(pending).toBeDefined();
    const text = pending?.text ?? "";
    expect(text).toContain("d.outcome = 'ACCEPTED'");
    expect(text).toContain("d.decision_kind = 'ENTRY'");
    // RFC-022 D1: the window that decides whether the bridge may act is the one
    // on when the bridge could first SEE the row, not on when the engine
    // decided. `decision_ts` stays as an absolute ceiling.
    expect(text).toContain("d.received_at > $1");
    expect(text).toContain("d.decision_ts > $2");
    // The authority against acting twice is the order table, not the stamp:
    // the stamp lands up to a minute later, on the portfolio's own cycle.
    expect(text).toContain("NOT EXISTS");
    expect(text).toContain(
      "FROM paper_orders o WHERE o.decision_id = d.decision_id",
    );
    expect(pending?.params[0]).toEqual(
      new Date(NOW.getTime() - MAX_RECEIVED_AGE_MS),
    );
    expect(pending?.params[1]).toEqual(
      new Date(NOW.getTime() - MAX_DECISION_TS_AGE_MS),
    );
  });

  it("considers a decision the engine took 45 s ago but the log received 5 s ago", async () => {
    // The measured production shape. The portfolio cycle writes market by
    // market, so `received_at - decision_ts` ran p50 17.1 s / p90 27.3 s / max
    // 42.4 s over the 94 accepted entries retained on 2026-09-07, and the two
    // clocks are phase-locked: under the old 30 s bound on `decision_ts` the
    // row was already too old at the only tick that could have seen it.
    const { outcome } = await run({
      decisions: [
        decision({
          decision_ts: new Date(NOW.getTime() - 45_000),
          received_at: new Date(NOW.getTime() - 5_000),
        }),
      ],
    });
    expect(outcome).toMatchObject({ considered: 1, agedOut: 0 });
  });

  it("still considers a decision seen 40 s ago, because a slow tick is SKIPPED", async () => {
    // `bridgeTickOnce` drops a tick whose predecessor is still running
    // (JOB_STILL_RUNNING). With a window equal to the 30 s period, one skipped
    // tick would lose the row for good, so the window is two ticks.
    const { outcome } = await run({
      decisions: [
        decision({
          decision_ts: new Date(NOW.getTime() - 50_000),
          received_at: new Date(NOW.getTime() - 40_000),
        }),
      ],
    });
    expect(outcome).toMatchObject({ considered: 1, agedOut: 0 });
  });

  it("refuses a decision past the absolute ceiling even if the log just saw it", async () => {
    // A wedged portfolio cycle must not dump hours-old decisions onto a live
    // book the moment it unwedges: fresh `received_at` is not enough.
    const { outcome } = await run({
      decisions: [
        decision({
          decision_ts: new Date(NOW.getTime() - 95_000),
          received_at: new Date(NOW.getTime() - 1_000),
        }),
      ],
    });
    expect(outcome).toMatchObject({ considered: 0, accepted: 0, agedOut: 1 });
  });

  it("counts decisions that aged out and warns, instead of executing them late", async () => {
    const { logs, outcome } = await run({
      decisions: [
        decision({
          decision_id: 1,
          received_at: new Date(NOW.getTime() - 61_000),
        }),
        decision({
          decision_id: 2,
          received_at: new Date(NOW.getTime() - 70_000),
        }),
        decision({
          decision_id: 3,
          received_at: new Date(NOW.getTime() - 99_000),
        }),
      ],
    });
    expect(outcome).toMatchObject({ considered: 0, accepted: 0, agedOut: 3 });
    const tick = logs.find((line) => line.reason_code === "BRIDGE_TICK");
    expect(tick).toMatchObject({ level: "warn", aged_out: 3 });
  });

  it("leaves pre-boot decisions out of aged_out, so the counter means 'lost now'", async () => {
    // Production on 2026-09-07: `aged_out: 86` on every tick, 30 s apart, for a
    // backlog whose newest row predated the running process by 30 hours. A
    // counter that can only grow says nothing about the tick that printed it.
    const bootAt = new Date(NOW.getTime() - 120_000);
    const { logs, outcome } = await run({
      bootAt,
      decisions: [
        decision({
          decision_id: 1,
          decision_ts: new Date(NOW.getTime() - 3_600_000),
          received_at: new Date(NOW.getTime() - 3_600_000),
        }),
        decision({
          decision_id: 2,
          decision_ts: new Date(NOW.getTime() - 100_000),
          received_at: new Date(NOW.getTime() - 100_000),
        }),
      ],
    });
    // Only the decision received after this process booted is counted.
    expect(outcome.agedOut).toBe(1);
    expect(
      logs.find((line) => line.reason_code === "BRIDGE_TICK"),
    ).toMatchObject({ aged_out: 1, boot_at: bootAt.toISOString() });
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

describe("exits become passive sales (RFC-022 D4-A)", () => {
  it("carries a held position all the way to the acceptance path", async () => {
    // Production accumulated 293 `EXIT ACCEPTED` decisions with
    // `paper_order_id` null in 293 of 293: the only reader of an EXIT row was
    // `exitstore.ts`'s signature check, so a position could only ever close by
    // resolution. `decisionrow.ts` writes `size_shares` null and
    // `binding_constraint` NOT_SIZED, so the size has to come from what is held.
    //
    // This suite's pool has no `transaction`, which is where the acceptance path
    // fails closed — so that refusal IS the assertion that every exit-specific
    // guard was passed and the draft reached the broker. The order that comes
    // out the other end is asserted against real PostgreSQL in `bridge.pg`.
    const { logs, outcome } = await run({
      exits: [exitDecision()],
      positionShares: "8.110000",
    });
    expect(outcome).toMatchObject({
      exitsConsidered: 1,
      // The entry counters stay their own numbers.
      considered: 0,
      accepted: 0,
    });
    expect(
      logs.find((line) => line.reason_code === "BRIDGE_DECISION_SKIPPED"),
    ).toMatchObject({
      decision_kind: "EXIT",
      decision_id: 77,
      reason: "PAPER_BROKER_TRANSACTION_UNAVAILABLE",
    });
  });

  it("skips an exit for a token with no position instead of selling short", async () => {
    const { logs, outcome } = await run({
      exits: [exitDecision()],
      positionShares: null,
    });
    expect(outcome).toMatchObject({ exitsAccepted: 0, exitsSkipped: 1 });
    expect(
      logs.find((line) => line.reason_code === "BRIDGE_DECISION_SKIPPED"),
    ).toMatchObject({ reason: "EXIT_NO_POSITION", decision_kind: "EXIT" });
  });

  it("skips a second exit while one is already resting for the token", async () => {
    // The exit verdict oscillates — 186 accepted exits on one BTC market in
    // 4 h, flipping about every 77 s. Reposting on every flip would destroy the
    // position's place in the queue, which is the whole value of a passive exit.
    const { logs, outcome } = await run({
      exits: [exitDecision()],
      positionShares: "8.110000",
      openExitOrder: true,
    });
    expect(outcome).toMatchObject({ exitsAccepted: 0, exitsSkipped: 1 });
    expect(
      logs.find((line) => line.reason_code === "BRIDGE_DECISION_SKIPPED"),
    ).toMatchObject({
      reason: "EXIT_ORDER_ALREADY_OPEN",
      decision_kind: "EXIT",
    });
  });

  it("skips rather than guesses when the position cannot be read", async () => {
    const { logs, outcome } = await run({
      exits: [exitDecision()],
      positionReadError: true,
    });
    expect(outcome).toMatchObject({ exitsAccepted: 0, exitsSkipped: 1 });
    expect(
      logs.find((line) => line.reason_code === "BRIDGE_DECISION_SKIPPED"),
    ).toMatchObject({ reason: "EXIT_POSITION_UNREADABLE" });
  });

  it("asks the exit selector for EXIT rows under the same freshness bounds", async () => {
    const { world: w } = await run();
    const exitQuery = w.queries.find(
      (query) =>
        query.text.includes("FROM portfolio_decisions d") &&
        query.text.includes("d.decision_kind = 'EXIT'") &&
        !query.text.includes("count(*)"),
    );
    expect(exitQuery).toBeDefined();
    const text = exitQuery?.text ?? "";
    expect(text).toContain("d.outcome = 'ACCEPTED'");
    expect(text).toContain("d.received_at > $1");
    expect(text).toContain("d.decision_ts > $2");
    expect(text).toContain("NOT EXISTS");
    expect(exitQuery?.params[0]).toEqual(
      new Date(NOW.getTime() - MAX_RECEIVED_AGE_MS),
    );
  });

  it("does not cancel a resting exit when the engine later says HOLD", async () => {
    // A HOLD is a REJECTED row, which no selector asks for: the hysteresis that
    // decides whether to leave belongs to the RFC-013 exit planner, and letting
    // a flip-flopping verdict pull the order would be worse than leaving it.
    const { logs, outcome } = await run({
      exits: [],
      positionShares: "8.110000",
      openExitOrder: true,
    });
    expect(outcome.exitsConsidered).toBe(0);
    expect(logs).toEqual([]);
  });

  it("keeps the exit counters apart from the entry counters in BRIDGE_TICK", async () => {
    // One number per kind. Folding exits into `considered` would make the
    // RFC-022 D1 acceptance criterion unreadable: "the bridge sees the accepted
    // entries" cannot be measured by a counter that also counts exits.
    const { logs } = await run({
      decisions: [decision()],
      exits: [exitDecision({ decision_id: 78 })],
      positionShares: "8.110000",
    });
    expect(
      logs.find((line) => line.reason_code === "BRIDGE_TICK"),
    ).toMatchObject({
      considered: 1,
      skipped: 1,
      exits_considered: 1,
      exits_skipped: 1,
      aged_out: 0,
      exits_aged_out: 0,
    });
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
