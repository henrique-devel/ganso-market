import { describe, expect, it } from "vitest";

import {
  classifyRuleChange,
  type RuleSnapshot,
} from "../../../src/polymarket/resolution/clarify.js";

function snapshot(overrides: Partial<RuleSnapshot> = {}): RuleSnapshot {
  return {
    description:
      "Resolves YES if the price of Bitcoin is above $68,000 on August 25 per the Chainlink TWAP feed.",
    resolutionSource: "chainlink",
    endDate: new Date("2026-08-25T00:00:00Z"),
    umaEndDate: new Date("2026-08-26T00:00:00Z"),
    umaBond: "750",
    customLiveness: null,
    ...overrides,
  };
}

describe("clarification classifier", () => {
  it("classifies punctuation/case/whitespace edits as cosmetic", () => {
    const before = snapshot();
    const after = snapshot({
      description:
        "resolves yes, if the price of Bitcoin is  above $68000 on August 25 per the chainlink TWAP feed",
    });
    const verdict = classifyRuleChange(before, after);
    expect(verdict.classification).toBe("cosmetic");
    expect(verdict.changedFields).toEqual([]);
  });

  it("classifies a threshold change as material", () => {
    const verdict = classifyRuleChange(
      snapshot(),
      snapshot({
        description:
          "Resolves YES if the price of Bitcoin is above $70,000 on August 25 per the Chainlink TWAP feed.",
      }),
    );
    expect(verdict.classification).toBe("material");
    expect(verdict.changedFields).toContain("description");
  });

  it("classifies a direction flip as material", () => {
    const verdict = classifyRuleChange(
      snapshot(),
      snapshot({
        description:
          "Resolves YES if the price of Bitcoin is below $68,000 on August 25 per the Chainlink TWAP feed.",
      }),
    );
    expect(verdict.classification).toBe("material");
  });

  it("classifies an added exception as material", () => {
    const verdict = classifyRuleChange(
      snapshot(),
      snapshot({
        description:
          "Resolves YES if the price of Bitcoin is above $68,000 on August 25 per the Chainlink TWAP feed unless trading is halted.",
      }),
    );
    expect(verdict.classification).toBe("material");
  });

  it("classifies normative field changes as material even with identical text", () => {
    const verdict = classifyRuleChange(
      snapshot(),
      snapshot({ umaBond: "1500" }),
    );
    expect(verdict.classification).toBe("material");
    expect(verdict.changedFields).toEqual(["uma_bond"]);

    const dates = classifyRuleChange(
      snapshot(),
      snapshot({ umaEndDate: new Date("2026-08-27T00:00:00Z") }),
    );
    expect(dates.classification).toBe("material");
    expect(dates.changedFields).toEqual(["uma_end_date"]);
  });

  it("classifies a large neutral rewrite as material", () => {
    const verdict = classifyRuleChange(
      snapshot({ description: "one two three four five six seven eight" }),
      snapshot({
        description: "alpha beta gamma delta epsilon zeta eta theta",
      }),
    );
    expect(verdict.classification).toBe("material");
  });

  it("is symmetric on replay: same versions, same verdict", () => {
    const before = snapshot();
    const after = snapshot({ umaBond: "1500" });
    expect(classifyRuleChange(before, after)).toEqual(
      classifyRuleChange(before, after),
    );
  });
});
