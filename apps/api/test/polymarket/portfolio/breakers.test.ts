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
  bookAgeMs: 2_000,
};

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
      detect({ paramChangedAt: new Date(NOW.getTime() - 60_000) }),
    ).toContain("PARAM_CHANGE");
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
      ...detect({ paramChangedAt: new Date(NOW.getTime() - 1_000) }),
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
