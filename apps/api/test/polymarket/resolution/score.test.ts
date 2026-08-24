import { describe, expect, it } from "vitest";

import { DEFAULT_RESOLUTION_CONFIG } from "../../../src/polymarket/resolution/config.js";
import {
  DEFAULT_RESOLUTION_LEXICON,
  scoreRulePrecision,
} from "../../../src/polymarket/resolution/lexicon.js";
import {
  bufferBase,
  composeScore,
  disputePrior,
  estimateP5050,
  evaluateBufferAtPrice,
  lockupModel,
  type ScoreInputs,
} from "../../../src/polymarket/resolution/score.js";

const CONFIG = DEFAULT_RESOLUTION_CONFIG;

const OBJECTIVE_PRECISION = scoreRulePrecision(
  {
    question: "Will the price of Bitcoin be above $68,000 on August 25?",
    description:
      "Resolves YES if the price of Bitcoin is above $68,000 on August 25. The resolution source is the Chainlink TWAP price feed.",
    resolutionSource: "chainlink",
  },
  DEFAULT_RESOLUTION_LEXICON,
);

const SUBJECTIVE_PRECISION = scoreRulePrecision(
  {
    question: "Will the agreement be signed?",
    description:
      "Resolves YES per the consensus of credible reporting that the agreement was signed.",
    resolutionSource: null,
  },
  DEFAULT_RESOLUTION_LEXICON,
);

function inputs(overrides: Partial<ScoreInputs> = {}): ScoreInputs {
  return {
    conditionId: "0xmkt",
    category: "crypto",
    negRisk: false,
    precision: OBJECTIVE_PRECISION,
    materialClarificationAgeMs: null,
    umaBond: "750",
    customLivenessS: null,
    endDate: new Date("2026-08-25T00:00:00Z"),
    umaEndDate: new Date("2026-08-25T00:00:00Z"),
    top1Share: 0.1,
    disputeActive: false,
    proposalActive: false,
    adjudicationPremium: null,
    measuredPrior: null,
    suspectJump: false,
    ...overrides,
  };
}

describe("score composition (task 8)", () => {
  it("scores a clean objective market low, without flags", () => {
    const composed = composeScore(inputs(), CONFIG);
    expect(composed.action).toBe("NONE");
    expect(composed.hardFlags).toEqual([]);
    expect(composed.score).toBeLessThan(CONFIG.thresholds.rBuffer);
    expect(composed.scoreText).toMatch(/^[01]\.[0-9]{6}$/);
  });

  it("is monotonic: every riskier input raises or keeps R", () => {
    const base = composeScore(inputs(), CONFIG).score;
    const riskier: ReadonlyArray<Partial<ScoreInputs>> = [
      { precision: SUBJECTIVE_PRECISION },
      { category: "macro" },
      { materialClarificationAgeMs: 3 * 24 * 3_600_000 },
      { umaBond: "2000" },
      { customLivenessS: 3_600 },
      { umaEndDate: new Date("2026-08-27T00:00:00Z") },
      { top1Share: 0.9 },
      { proposalActive: true, adjudicationPremium: 0.04 },
    ];
    for (const override of riskier) {
      const score = composeScore(inputs(override), CONFIG).score;
      expect(score).toBeGreaterThanOrEqual(base);
    }
  });

  it("maps hard flags to VETO regardless of R", () => {
    const composed = composeScore(
      inputs({ precision: SUBJECTIVE_PRECISION }),
      CONFIG,
    );
    expect(composed.hardFlags).toContain("SUBJECTIVE_SOURCE");
    expect(composed.action).toBe("VETO");
  });

  it("maps a fresh material clarification to VETO via the 24h hard flag", () => {
    const composed = composeScore(
      inputs({ materialClarificationAgeMs: 3_600_000 }),
      CONFIG,
    );
    expect(composed.hardFlags).toContain("MATERIAL_CLARIFICATION_24H");
    expect(composed.action).toBe("VETO");
  });

  it("maps an active dispute to CIRCUIT_BREAKER above everything else", () => {
    const composed = composeScore(inputs({ disputeActive: true }), CONFIG);
    expect(composed.action).toBe("CIRCUIT_BREAKER");
    expect(composed.justification).toContain("disputa");
  });

  it("maps an unexplained jump to CIRCUIT_BREAKER in suspect mode", () => {
    const composed = composeScore(inputs({ suspectJump: true }), CONFIG);
    expect(composed.action).toBe("CIRCUIT_BREAKER");
    expect(composed.justification).toContain("suspeita");
  });

  it("reports which dispute prior is in use (task 4)", () => {
    const external = composeScore(inputs(), CONFIG);
    expect(external.priorKind).toBe("external");
    const measured = composeScore(
      inputs({ measuredPrior: { resolved: 250, disputed: 5, p5050: 1 } }),
      CONFIG,
    );
    expect(measured.priorKind).toBe("measured");
    expect(measured.disputeRateUsed).toBeCloseTo(5 / 250, 10);
  });
});

describe("dispute prior switchover (task 4)", () => {
  it("keeps the external prior below the sample threshold", () => {
    const prior = disputePrior(
      "crypto",
      { resolved: 199, disputed: 10, p5050: 0 },
      CONFIG,
    );
    expect(prior.kind).toBe("external");
    expect(prior.rate).toBe(CONFIG.priors.crypto.disputeRate);
  });

  it("switches automatically at the threshold", () => {
    const prior = disputePrior(
      "crypto",
      { resolved: 200, disputed: 10, p5050: 0 },
      CONFIG,
    );
    expect(prior.kind).toBe("measured");
    expect(prior.rate).toBeCloseTo(0.05, 10);
  });

  it("falls back to the default prior for unknown categories", () => {
    const prior = disputePrior(null, null, CONFIG);
    expect(prior.rate).toBe(CONFIG.priors.default.disputeRate);
  });
});

describe("P(50/50) (task 6)", () => {
  it("is structurally zero in negRisk groups", () => {
    const p = estimateP5050(
      { negRisk: true, precision: SUBJECTIVE_PRECISION, measuredPrior: null },
      CONFIG,
    );
    expect(p.value).toBe(0);
  });

  it("rises as the rule precision falls", () => {
    const precise = estimateP5050(
      { negRisk: false, precision: OBJECTIVE_PRECISION, measuredPrior: null },
      CONFIG,
    );
    const vague = estimateP5050(
      { negRisk: false, precision: SUBJECTIVE_PRECISION, measuredPrior: null },
      CONFIG,
    );
    expect(vague.value).toBeGreaterThan(precise.value);
    expect(vague.value).toBeLessThanOrEqual(CONFIG.p5050.cap);
  });

  it("uses the measured frequency once the sample is large enough", () => {
    const p = estimateP5050(
      {
        negRisk: false,
        precision: OBJECTIVE_PRECISION,
        measuredPrior: { resolved: 300, disputed: 10, p5050: 6 },
      },
      CONFIG,
    );
    expect(p.kind).toBe("measured");
    expect(p.value).toBeCloseTo(0.02, 10);
  });
});

describe("lockup model (task 5)", () => {
  it("is bimodal: the dispute tail dominates once a dispute is live", () => {
    const clean = lockupModel("crypto", 0.006, false, CONFIG);
    const disputed = lockupModel("crypto", 0.006, true, CONFIG);
    expect(disputed.expectedS).toBeGreaterThan(clean.expectedS);
    expect(disputed.p95S).toBe(CONFIG.lockup.disputeP95Minutes * 60);
    expect(clean.p95S).toBe(CONFIG.lockup.p95BaseMinutes.crypto * 60);
  });

  it("weights the tail by the dispute probability before a dispute", () => {
    const low = lockupModel("crypto", 0.006, false, CONFIG);
    const high = lockupModel("crypto", 0.048, false, CONFIG);
    expect(high.expectedS).toBeGreaterThan(low.expectedS);
  });
});

describe("resolution buffer (tasks 9 and RFC-013 EV coupling)", () => {
  it("makes net EV decrease monotonically as R grows", () => {
    // EV = q - ask - costs - buffer: with everything else fixed, a larger R
    // must never shrink the buffer.
    let previous = -1;
    for (let r = 0; r <= 1.0001; r += 0.05) {
      const buffer = bufferBase(Math.min(r, 1), 3_600, CONFIG);
      expect(buffer).toBeGreaterThanOrEqual(previous);
      previous = buffer;
    }
  });

  it("is zero below the buffer band (plus only the capital hurdle)", () => {
    const buffer = bufferBase(0.1, 0, CONFIG);
    expect(buffer).toBe(0);
  });

  it("charges the 50/50 tail on expensive entries (YES at 80¢ pays 50¢)", () => {
    const base = 0.01;
    const p5050 = 0.05;
    const cheap = evaluateBufferAtPrice(base, p5050, 0.4);
    const expensive = evaluateBufferAtPrice(base, p5050, 0.8);
    expect(cheap).toBe(base);
    expect(expensive).toBeCloseTo(base + 0.05 * 0.3, 10);
    expect(expensive).toBeGreaterThan(cheap);
  });

  it("takes no credit for a favorable 50/50 (no probable-refund credit)", () => {
    expect(evaluateBufferAtPrice(0.01, 0.05, 0.2)).toBe(0.01);
  });
});
