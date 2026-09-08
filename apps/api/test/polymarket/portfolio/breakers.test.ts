// RFC-013 task 4, items (i) to (v): the portfolio circuit breakers.
//
// The RFC's mandatory test list asks for the breakers to be shown firing in
// injected scenarios, and G3 will not pass until every kind has actually fired.
// So each kind gets its own fixture, and a guard test fails the build if a kind
// is added to the type without one — the same shape the sizing and exit suites
// already use.

import { describe, expect, it } from "vitest";

import { parseScaled } from "../../../src/polymarket/fundamental/fixed.js";
import {
  detectBreakers,
  reconcileBreakers,
  BREAKER_EVENT_WINDOW_MS,
  type BreakerObservation,
  type BreakerSignal,
} from "../../../src/polymarket/portfolio/breakers.js";
import { BREAKER_KINDS } from "../../../src/polymarket/portfolio/types.js";

const NOW = new Date("2026-08-26T12:00:00Z");

function s(value: string): bigint {
  const parsed = parseScaled(value);
  if (parsed === null) {
    throw new Error(`unparseable fixture value: ${value}`);
  }
  return parsed;
}

const CONFIG = {
  jumpThresholdScaled: s("0.15"),
  jumpWindowMs: 300_000,
  bookMaxAgeMs: 30_000,
  // The production band (`config/portfolio.json:16-18`), which is also what the
  // entry gate enforces at `engine.ts:496-499`.
  bandMinBuyScaled: s("0.10"),
  bandMaxBuyScaled: s("0.95"),
};

/** A quiet market with an open position and nothing wrong with it. */
const QUIET: BreakerObservation = {
  conditionId: "0xa",
  tokenId: "t1",
  holdsPosition: true,
  disputeActive: false,
  proposalActive: false,
  resolutionAction: "NONE",
  midNowScaled: s("0.50"),
  midBeforeScaled: s("0.49"),
  knownCatalystInWindow: false,
  clarifiedAt: null,
  paramChangedAt: null,
  paramChangedFields: [],
  paramChangedVersion: null,
  paramChangedFrom: null,
  paramChangedTo: null,
  bookAgeMs: 2_000,
};

/** A real tick change, the shape RFC-025 D1 says is the only one left. */
const TICK_CHANGE = {
  paramChangedFields: ["tick_size"],
  paramChangedVersion: 2,
  paramChangedFrom: { tick_size: "0.01" },
  paramChangedTo: { tick_size: "0.001" },
};

function signals(overrides: Partial<BreakerObservation>): BreakerSignal[] {
  return detectBreakers({
    observation: { ...QUIET, ...overrides },
    config: CONFIG,
    now: NOW,
  });
}

function detect(overrides: Partial<BreakerObservation>): string[] {
  return detectBreakers({
    observation: { ...QUIET, ...overrides },
    config: CONFIG,
    now: NOW,
  }).map((signal) => signal.kind);
}

describe("circuit breaker detection", () => {
  it("opens nothing on a quiet market", () => {
    expect(detect({})).toEqual([]);
  });

  it("UMA_PROPOSED_OR_DISPUTED: dispute on a market we hold", () => {
    expect(detect({ disputeActive: true })).toContain(
      "UMA_PROPOSED_OR_DISPUTED",
    );
  });

  it("UMA_PROPOSED_OR_DISPUTED: a live PROPOSAL on a market we hold", () => {
    // RFC-018 item 3. The condition used to read `disputeActive` alone, and
    // `dispute_active` has been false in 781 of 781 production market states
    // while 482 markets went through `proposed` — a breaker named for both
    // halves that could only ever see one. The proposal is also the half worth
    // acting on: by the time it is a dispute the bond is posted.
    expect(detect({ proposalActive: true })).toContain(
      "UMA_PROPOSED_OR_DISPUTED",
    );
  });

  it("UMA_PROPOSED_OR_DISPUTED: a proposal on a market we do NOT hold is silent", () => {
    expect(
      detect({ proposalActive: true, holdsPosition: false }),
    ).not.toContain("UMA_PROPOSED_OR_DISPUTED");
  });

  it("UMA_PROPOSED_OR_DISPUTED: not for a market we do NOT hold", () => {
    // For an entry the engine already refuses on the RFC-012 action, with a
    // rejection code that says so. This breaker exists to protect a position.
    expect(detect({ disputeActive: true, holdsPosition: false })).not.toContain(
      "UMA_PROPOSED_OR_DISPUTED",
    );
  });

  it("PRICE_JUMP_NO_CATALYST: a jump past the threshold with nothing to explain it", () => {
    // The documented patterns are 17% -> 95% and 9% -> 100%.
    expect(
      detect({ midBeforeScaled: s("0.17"), midNowScaled: s("0.95") }),
    ).toContain("PRICE_JUMP_NO_CATALYST");
  });

  it("PRICE_JUMP_NO_CATALYST: silent when a catalyst explains the move", () => {
    // A jump WITH a catalyst is information arriving. Freezing on it would
    // freeze the engine out of exactly the moments it exists for.
    expect(
      detect({
        midBeforeScaled: s("0.17"),
        midNowScaled: s("0.95"),
        knownCatalystInWindow: true,
      }),
    ).not.toContain("PRICE_JUMP_NO_CATALYST");
  });

  it("PRICE_JUMP_NO_CATALYST: fires for a market we do not hold either", () => {
    // An unexplained jump is a reason not to ENTER, so it is not conditional on
    // holding anything.
    expect(
      detect({
        holdsPosition: false,
        midBeforeScaled: s("0.20"),
        midNowScaled: s("0.90"),
      }),
    ).toContain("PRICE_JUMP_NO_CATALYST");
  });

  it("PRICE_JUMP_NO_CATALYST: 0.02 -> 0.023 is silent, but on the THRESHOLD not on D3", () => {
    // The RFC names this pair, and it is worth pinning for what it actually is:
    // 0.003/0.02 is exactly 0.15, and the comparison is strictly `>`, so this
    // move never opened the breaker under any version of this code. Keeping it
    // green proves the boundary did not move; the D3 cases below use a move that
    // genuinely clears the threshold.
    expect(
      detect({
        holdsPosition: false,
        midBeforeScaled: s("0.02"),
        midNowScaled: s("0.023"),
      }),
    ).not.toContain("PRICE_JUMP_NO_CATALYST");
  });

  it("PRICE_JUMP_NO_CATALYST: both ends outside the band and no position is silent", () => {
    // RFC-025 D3, and this is the case that exercises it: 0.02 -> 0.024 is a 20%
    // move, well past the threshold, and it used to open. The threshold is
    // RELATIVE and the median `mid_before` of the 9 570 historical firings was
    // $0.019 — at that price 20% is 0.4 of a cent, well under one tick of the
    // 0.01 grid. 80% of the firings were outside the band. With nothing held,
    // `PRICE_OUT_OF_BAND` refuses the entry on the current price in the same
    // cycle (`engine.ts:496-499`): the verdict is identical, only the label
    // changes.
    expect(
      detect({
        holdsPosition: false,
        midBeforeScaled: s("0.02"),
        midNowScaled: s("0.024"),
      }),
    ).not.toContain("PRICE_JUMP_NO_CATALYST");
  });

  it("PRICE_JUMP_NO_CATALYST: the same move WITH a position still opens", () => {
    // Nothing about a held position changes at any price: the breaker is what
    // forces the exit re-evaluation on a position we own.
    expect(
      detect({
        holdsPosition: true,
        midBeforeScaled: s("0.02"),
        midNowScaled: s("0.024"),
      }),
    ).toContain("PRICE_JUMP_NO_CATALYST");
  });

  it("PRICE_JUMP_NO_CATALYST: inside the band and no position still opens", () => {
    expect(
      detect({
        holdsPosition: false,
        midBeforeScaled: s("0.50"),
        midNowScaled: s("0.70"),
      }),
    ).toContain("PRICE_JUMP_NO_CATALYST");
  });

  it("PRICE_JUMP_NO_CATALYST: 0.96 -> 0.80 with no position MUST still open", () => {
    // The anti-loosening case, and the reason D3 requires BOTH ends outside.
    // This is the RFC-013 4(ii) pattern: `mid_before` outside the band,
    // `mid_now` INSIDE it. Looking at `mid_before` alone would omit the breaker
    // and let an entry at 0.80 sail past `PRICE_OUT_OF_BAND` — which tests the
    // CURRENT price (`engine.ts:496-499`) — and reach the arithmetic. That is a
    // gate getting weaker, which this RFC forbids outright.
    expect(
      detect({
        holdsPosition: false,
        midBeforeScaled: s("0.96"),
        midNowScaled: s("0.80"),
      }),
    ).toContain("PRICE_JUMP_NO_CATALYST");
  });

  it("PRICE_JUMP_NO_CATALYST: 0.02 -> 0.30 with no position opens too", () => {
    // The mirror of the case above: `mid_before` outside, `mid_now` inside. A
    // token that ran from under the floor up into the band is tradeable at the
    // new price, so the breaker is exactly what should stop the entry.
    expect(
      detect({
        holdsPosition: false,
        midBeforeScaled: s("0.02"),
        midNowScaled: s("0.30"),
      }),
    ).toContain("PRICE_JUMP_NO_CATALYST");
  });

  it("RULE_CLARIFICATION: a material clarification inside the window", () => {
    expect(
      detect({ clarifiedAt: new Date(NOW.getTime() - 3_600_000) }),
    ).toContain("RULE_CLARIFICATION");
  });

  it("RULE_CLARIFICATION: lifts once the clarification is old", () => {
    // Without a window a single historical clarification would freeze a market
    // forever; the append-only row keeps the history either way.
    expect(
      detect({
        clarifiedAt: new Date(NOW.getTime() - BREAKER_EVENT_WINDOW_MS - 1_000),
      }),
    ).not.toContain("RULE_CLARIFICATION");
  });

  it("PARAM_CHANGE: a fee schedule or tick change inside the window", () => {
    // Every cost in the EV was computed under the old parameters.
    expect(
      detect({
        paramChangedAt: new Date(NOW.getTime() - 60_000),
        ...TICK_CHANGE,
      }),
    ).toContain("PARAM_CHANGE");
  });

  it("PARAM_CHANGE: the detail names the field, the version and both values", () => {
    // RFC-025 D1 and acceptance 1: a breaker whose detail cannot say which
    // parameter moved is not auditable, and 92.4% of the ones ever opened here
    // could not. `openBreaker` serializes the whole detail, so this is what
    // lands in `detail_json`.
    const signal = signals({
      paramChangedAt: new Date(NOW.getTime() - 60_000),
      ...TICK_CHANGE,
    }).find((candidate) => candidate.kind === "PARAM_CHANGE");
    expect(signal?.detail).toMatchObject({
      param_changed_at: new Date(NOW.getTime() - 60_000).toISOString(),
      window_ms: BREAKER_EVENT_WINDOW_MS,
      changed_fields: ["tick_size"],
      version: 2,
      from: { tick_size: "0.01" },
      to: { tick_size: "0.001" },
    });
  });

  it("PARAM_CHANGE: an instant with no changed field does NOT open", () => {
    // Fails closed on the pair. The store is what decides a change is real, and
    // if it ever hands over an instant without a field the breaker refuses to
    // open rather than freeze a market for a reason it cannot state.
    expect(
      detect({
        paramChangedAt: new Date(NOW.getTime() - 60_000),
        paramChangedFields: [],
      }),
    ).not.toContain("PARAM_CHANGE");
  });

  it("PARAM_CHANGE: the window is still 24 h, and still lifts", () => {
    // P2 = D2-A: the constant is untouched by this RFC. What changed is what
    // counts as the event, not how long the freeze lasts.
    expect(
      detect({
        paramChangedAt: new Date(
          NOW.getTime() - BREAKER_EVENT_WINDOW_MS - 1_000,
        ),
        ...TICK_CHANGE,
      }),
    ).not.toContain("PARAM_CHANGE");
  });

  it("DATA_STALENESS: a book past the TTL on a market we hold", () => {
    expect(detect({ bookAgeMs: 45_000 })).toContain("DATA_STALENESS");
    expect(detect({ bookAgeMs: null })).toContain("DATA_STALENESS");
  });

  it("opens every applicable breaker at once, not just the first", () => {
    // A market frozen for two reasons has to record both: showing one would
    // hide the other from whoever reviews the freeze.
    const kinds = detect({
      disputeActive: true,
      bookAgeMs: 60_000,
      paramChangedAt: new Date(NOW.getTime() - 1_000),
      ...TICK_CHANGE,
    });
    expect(kinds).toContain("UMA_PROPOSED_OR_DISPUTED");
    expect(kinds).toContain("DATA_STALENESS");
    expect(kinds).toContain("PARAM_CHANGE");
  });

  it("has a fixture for EVERY breaker kind the type declares", () => {
    // The guard: adding a kind without proving it can fire would let G3 pass on
    // a control nobody ever exercised.
    const fired = new Set<string>([
      ...detect({ disputeActive: true }),
      ...detect({ midBeforeScaled: s("0.17"), midNowScaled: s("0.95") }),
      ...detect({ clarifiedAt: new Date(NOW.getTime() - 1_000) }),
      ...detect({
        paramChangedAt: new Date(NOW.getTime() - 1_000),
        ...TICK_CHANGE,
      }),
      ...detect({ bookAgeMs: 60_000 }),
    ]);
    for (const kind of BREAKER_KINDS) {
      expect(fired.has(kind), `no fixture fires ${kind}`).toBe(true);
    }
  });
});

describe("reconciliation against what is already open", () => {
  const signal: BreakerSignal = {
    kind: "DATA_STALENESS",
    scope: "token",
    conditionId: "0xa",
    tokenId: "t1",
    detail: {},
  };

  it("opens a newly detected breaker", () => {
    const { toOpen, toClose } = reconcileBreakers({
      detected: [signal],
      open: [],
    });
    expect(toOpen).toHaveLength(1);
    expect(toClose).toHaveLength(0);
  });

  it("leaves a still-true breaker alone", () => {
    // Re-opening it would fragment its window and lose the fact that the
    // condition never lifted.
    const { toOpen, toClose } = reconcileBreakers({
      detected: [signal],
      open: [
        {
          breakerId: 1,
          kind: "DATA_STALENESS",
          scope: "token",
          conditionId: "0xa",
          tokenId: "t1",
        },
      ],
    });
    expect(toOpen).toHaveLength(0);
    expect(toClose).toHaveLength(0);
  });

  it("closes one whose condition cleared", () => {
    const { toOpen, toClose } = reconcileBreakers({
      detected: [],
      open: [
        {
          breakerId: 1,
          kind: "DATA_STALENESS",
          scope: "token",
          conditionId: "0xa",
          tokenId: "t1",
        },
      ],
    });
    expect(toOpen).toHaveLength(0);
    expect(toClose.map((row) => row.breakerId)).toEqual([1]);
  });

  it("treats the same kind on different markets as different breakers", () => {
    const { toOpen, toClose } = reconcileBreakers({
      detected: [{ ...signal, conditionId: "0xb", tokenId: "t2" }],
      open: [
        {
          breakerId: 1,
          kind: "DATA_STALENESS",
          scope: "token",
          conditionId: "0xa",
          tokenId: "t1",
        },
      ],
    });
    expect(toOpen).toHaveLength(1);
    expect(toClose).toHaveLength(1);
  });
});
