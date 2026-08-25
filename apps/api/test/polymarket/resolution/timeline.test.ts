import { describe, expect, it } from "vitest";

import {
  deriveGammaTimeline,
  outcomeFromPayload,
  type GammaTimelineEvent,
} from "../../../src/polymarket/resolution/timeline.js";

const T0 = new Date("2026-08-20T10:00:00Z");

function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000);
}

function event(
  eventType: string,
  minutes: number,
  payload: unknown = {},
): GammaTimelineEvent {
  return { eventType, receivedAt: at(minutes), payload };
}

const RESOLVED_YES = {
  raw: { outcomePrices: ["1", "0"], outcomes: ["Yes", "No"] },
};
const RESOLVED_NO = {
  raw: { outcomePrices: ["0", "1"], outcomes: ["Yes", "No"] },
};
const RESOLVED_5050 = {
  raw: { outcomePrices: ["0.5", "0.5"], outcomes: ["Yes", "No"] },
};

describe("UMA request timeline (task 1)", () => {
  it("follows the clean path: proposed -> settled", () => {
    const entries = deriveGammaTimeline("0xmkt", [
      event("proposed", 0),
      event("resolved", 120, RESOLVED_YES),
    ]);
    expect(entries.map((entry) => [entry.requestIndex, entry.state])).toEqual([
      [1, "proposed"],
      [1, "settled"],
    ]);
    expect(entries[1]?.result).toBe("P2");
  });

  it("resets on the first dispute and escalates to the DVM on the second", () => {
    const entries = deriveGammaTimeline("0xmkt", [
      event("proposed", 0),
      event("disputed", 30),
      event("proposed", 60),
      event("disputed", 90),
      event("resolved", 600, RESOLVED_NO),
    ]);
    expect(entries.map((entry) => [entry.requestIndex, entry.state])).toEqual([
      [1, "proposed"],
      [1, "disputed"],
      [1, "reset"],
      [2, "proposed"],
      [2, "disputed"],
      [2, "dvm"],
      [2, "settled"],
    ]);
    expect(entries.at(-1)?.result).toBe("P1");
  });

  it("never exceeds two requests: the machine cannot skip nor invent states", () => {
    const entries = deriveGammaTimeline("0xmkt", [
      event("proposed", 0),
      event("disputed", 10),
      event("disputed", 20),
      event("resolved", 30, RESOLVED_5050),
    ]);
    const requests = new Set(entries.map((entry) => entry.requestIndex));
    expect([...requests].every((index) => index === 1 || index === 2)).toBe(
      true,
    );
    // Second dispute goes to the DVM — there is no second reset.
    expect(entries.filter((entry) => entry.state === "reset")).toHaveLength(1);
    expect(entries.filter((entry) => entry.state === "dvm")).toHaveLength(1);
    expect(entries.at(-1)?.state).toBe("settled");
    expect(entries.at(-1)?.result).toBe("P3");
  });

  it("derives identically on replay (same input, same entries)", () => {
    const events = [
      event("proposed", 0),
      event("disputed", 30),
      event("resolved", 90, RESOLVED_YES),
    ];
    expect(deriveGammaTimeline("0xmkt", events)).toEqual(
      deriveGammaTimeline("0xmkt", events),
    );
  });

  it("stops at the first settlement; later noise never duplicates it", () => {
    const entries = deriveGammaTimeline("0xmkt", [
      event("proposed", 0),
      event("resolved", 60, RESOLVED_YES),
      event("proposed", 120),
      event("resolved", 180, RESOLVED_NO),
    ]);
    expect(entries.filter((entry) => entry.state === "settled")).toHaveLength(
      1,
    );
    expect(entries.at(-1)?.result).toBe("P2");
  });

  it("ignores closed and rule_change events in the lifecycle", () => {
    const entries = deriveGammaTimeline("0xmkt", [
      event("proposed", 0),
      event("closed", 5),
      event("rule_change", 6),
      event("resolved", 60, RESOLVED_YES),
    ]);
    expect(entries.map((entry) => entry.state)).toEqual([
      "proposed",
      "settled",
    ]);
  });
});

describe("outcome mapping (P1/P2/P3)", () => {
  it("maps by the named Yes outcome, tolerating order changes", () => {
    expect(
      outcomeFromPayload({
        raw: { outcomePrices: ["0", "1"], outcomes: ["No", "Yes"] },
      }).result,
    ).toBe("P2");
    expect(
      outcomeFromPayload({
        raw: { outcomePrices: ["1", "0"], outcomes: ["No", "Yes"] },
      }).result,
    ).toBe("P1");
  });

  it("maps the 50/50 report to P3", () => {
    expect(outcomeFromPayload(RESOLVED_5050).result).toBe("P3");
  });

  it("accepts top-level payload shapes (market_resolved rows)", () => {
    expect(
      outcomeFromPayload({
        outcomePrices: '["1","0"]',
        outcomes: '["Yes","No"]',
      }).result,
    ).toBe("P2");
  });

  it("returns null when the outcome is unknowable, never a default", () => {
    expect(outcomeFromPayload({}).result).toBeNull();
    expect(outcomeFromPayload(null).result).toBeNull();
    expect(
      outcomeFromPayload({ raw: { outcomePrices: ["x", "y"] } }).result,
    ).toBeNull();
  });
});
