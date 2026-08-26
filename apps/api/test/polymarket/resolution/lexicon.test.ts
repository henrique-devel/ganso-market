import { describe, expect, it } from "vitest";

import {
  DEFAULT_RESOLUTION_LEXICON,
  RESOLUTION_LEXICON_FILE_ENV,
  ResolutionLexiconError,
  lexiconHash,
  loadResolutionLexicon,
  parseResolutionLexicon,
  scoreRulePrecision,
  type ResolutionLexicon,
  type RulePrecisionResult,
} from "../../../src/polymarket/resolution/lexicon.js";

// Anonymized versions of the documented dispute-research cases.
const CRYPTO_OBJECTIVE = {
  question: "Will the price of Bitcoin be above $68,000 on August 25?",
  description:
    "Resolution source is the Chainlink TWAP price feed. The market resolves YES if the feed value exceeds $68,000 at the close on August 25.",
  resolutionSource: null,
};

const MEDIA_CONSENSUS = {
  question: "Will the leader wear a suit before July?",
  description:
    "Resolves YES if a consensus of credible reporting confirms that the outfit qualifies as a suit.",
  resolutionSource: null,
};

const DISCLOSURE_DEPENDENT = {
  question: "Will the company acquire more Bitcoin in June?",
  description:
    "Resolves YES only if the purchase is disclosed in an 8-K or press release published in June.",
  resolutionSource: null,
};

function score(input: {
  question: string;
  description: string;
  resolutionSource: string | null;
}): RulePrecisionResult {
  return scoreRulePrecision(input, DEFAULT_RESOLUTION_LEXICON);
}

describe("scoreRulePrecision corpus fixtures", () => {
  it("scores an objective single-source crypto rule as fully precise", () => {
    const result = score(CRYPTO_OBJECTIVE);
    expect(result.precision).toBe("1.000000");
    expect(result.hardFlags).toEqual([]);
    expect(result.riskComponents).toEqual({
      source: 0,
      conditions: 0,
      disclosure: 0,
      by_date: 0,
      title_mismatch: 0,
      fallback: 0,
    });
    expect(result.byDateForm).toBe(false);
    expect(result.occurrenceVsDisclosure).toBe(false);
    expect(result.fallbackClause).toBe(false);
  });

  it("flags a media-consensus rule and ranks it below the objective one", () => {
    const objective = score(CRYPTO_OBJECTIVE);
    const consensus = score(MEDIA_CONSENSUS);
    expect(consensus.hardFlags).toContain("SUBJECTIVE_SOURCE");
    expect(consensus.riskComponents["source"]).toBe(1);
    expect(Number(consensus.precision)).toBeLessThan(
      Number(objective.precision),
    );
  });

  it("marks a disclosure-gated rule and ranks it below the objective one", () => {
    const objective = score(CRYPTO_OBJECTIVE);
    const disclosure = score(DISCLOSURE_DEPENDENT);
    expect(disclosure.occurrenceVsDisclosure).toBe(true);
    expect(disclosure.riskComponents["disclosure"]).toBe(1);
    expect(Number(disclosure.precision)).toBeLessThan(
      Number(objective.precision),
    );
  });
});

describe("cosmetic stability", () => {
  // Case, whitespace runs, trailing punctuation and thousands commas are
  // exactly what the normalizer must erase: the precision string is identical.
  const mutate = (text: string): string =>
    `${text.toUpperCase().replace(/ /g, "  ")}!!`;

  it.each([
    ["CRYPTO_OBJECTIVE", CRYPTO_OBJECTIVE],
    ["MEDIA_CONSENSUS", MEDIA_CONSENSUS],
    ["DISCLOSURE_DEPENDENT", DISCLOSURE_DEPENDENT],
  ])("is stable for %s", (_name, fixture) => {
    const baseline = score(fixture);
    const mutated = score({
      question: mutate(fixture.question),
      description: mutate(fixture.description),
      resolutionSource: fixture.resolutionSource,
    });
    expect(mutated.precision).toBe(baseline.precision);
    expect(mutated.hardFlags).toEqual(baseline.hardFlags);
  });

  it("is stable when thousands commas are dropped", () => {
    const baseline = score(CRYPTO_OBJECTIVE);
    const uncomma = score({
      question: CRYPTO_OBJECTIVE.question.replace("$68,000", "$68000"),
      description: CRYPTO_OBJECTIVE.description.replace("$68,000", "$68000"),
      resolutionSource: null,
    });
    expect(uncomma.precision).toBe(baseline.precision);
  });
});

describe("title-rule mismatch", () => {
  it("flags disjoint dollar thresholds between title and rules", () => {
    const result = score({
      question: "Will Bitcoin close above $82,500?",
      description:
        "Resolves YES if the closing price on Coinbase is above $85,000.",
      resolutionSource: null,
    });
    expect(result.hardFlags).toContain("TITLE_RULE_MISMATCH");
    expect(result.riskComponents["title_mismatch"]).toBe(1);
  });

  it("does not flag matching thresholds", () => {
    const result = score({
      question: "Will Bitcoin close above $82,500?",
      description:
        "Resolves YES if the closing price on Coinbase is above $82,500.",
      resolutionSource: null,
    });
    expect(result.hardFlags).not.toContain("TITLE_RULE_MISMATCH");
    expect(result.riskComponents["title_mismatch"]).toBe(0);
  });

  it("does not flag a rule that DEFERS to the title instead of repeating it", () => {
    // Polymarket's standard crypto template, verbatim from production. The
    // rule never repeats the strike or the date — it points back at the title.
    // Comparing extracted numbers then measures only the rule's own machinery
    // ("1 minute candle", "12:00"), which is how this check vetoed 130 of the
    // 195 live markets on 2026-08-26.
    const result = score({
      question: "Will the price of XRP be above $1.90 on August 28?",
      description:
        'This market will resolve to "Yes" if the Binance 1 minute candle for ' +
        "XRP/USDT 12:00 in the ET timezone (noon) on the date specified in the " +
        'title has a final "Close" price higher than the price specified in ' +
        'the title. Otherwise, this market will resolve to "No".',
      resolutionSource: null,
    });
    expect(result.hardFlags).not.toContain("TITLE_RULE_MISMATCH");
    expect(result.riskComponents["title_mismatch"]).toBe(0);
  });

  it("still flags a genuine mismatch when the rule states its own values", () => {
    // The guard must be narrow: only an explicit deferral suppresses the
    // check. A rule that names a DIFFERENT strike is still a real mismatch.
    const result = score({
      question: "Will the price of XRP be above $1.90 on August 28?",
      description:
        'This market will resolve to "Yes" if the Binance 1 minute candle for ' +
        'XRP/USDT on August 30 has a final "Close" price above $2.50.',
      resolutionSource: null,
    });
    expect(result.hardFlags).toContain("TITLE_RULE_MISMATCH");
  });

  it("expands k/m suffixes before comparing (100k equals 100,000)", () => {
    const result = score({
      question: "Will Bitcoin trade above $100k?",
      description: "Resolves YES if the price exceeds 100,000 at any time.",
      resolutionSource: null,
    });
    expect(result.hardFlags).not.toContain("TITLE_RULE_MISMATCH");
  });
});

describe("component detection", () => {
  it("counts conditions and saturates the risk at the cap", () => {
    const result = score({
      question: "Will the event happen?",
      description:
        "Resolves YES unless canceled; except when delayed; however, provided that the venue confirms, and subject to final review.",
      resolutionSource: null,
    });
    expect(result.conditionsCount).toBe(5);
    expect(result.riskComponents["conditions"]).toBe(1);
  });

  it("detects a fallback clause and lowers precision", () => {
    const base = {
      question: "Will the event happen?",
      description: "Resolves YES if the event occurs before the deadline.",
      resolutionSource: null,
    };
    const withFallback = {
      ...base,
      description: `${base.description} If the outcome cannot be determined, the market will resolve to no.`,
    };
    const baseResult = score(base);
    const fallbackResult = score(withFallback);
    expect(baseResult.fallbackClause).toBe(false);
    expect(fallbackResult.fallbackClause).toBe(true);
    expect(Number(fallbackResult.precision)).toBeLessThan(
      Number(baseResult.precision),
    );
  });

  it("recognizes the by-date form as early-resolution eligible", () => {
    const result = score({
      question: "Will Solana reach $300 by March?",
      description:
        "Resolves YES if the Coinbase price reaches $300 before the end of March.",
      resolutionSource: null,
    });
    expect(result.byDateForm).toBe(true);
    expect(result.riskComponents["by_date"]).toBe(0.5);
  });

  it("is monotone: adding a subjective term never raises precision", () => {
    const base = {
      question: "Will Bitcoin close above $50,000?",
      description:
        "Resolves YES if the closing price on Coinbase is above $50,000.",
      resolutionSource: null,
    };
    const subjective = {
      ...base,
      description: `${base.description} The outcome is whatever a consensus of credible reporting says.`,
    };
    const baseResult = score(base);
    const subjectiveResult = score(subjective);
    expect(subjectiveResult.hardFlags).toContain("SUBJECTIVE_SOURCE");
    expect(Number(subjectiveResult.precision)).toBeLessThanOrEqual(
      Number(baseResult.precision),
    );
  });
});

describe("parseResolutionLexicon", () => {
  it("fails closed on an unknown key", () => {
    expect(() => parseResolutionLexicon({ unexpected: 1 })).toThrow(
      ResolutionLexiconError,
    );
    expect(() =>
      parseResolutionLexicon({ component_weights: { unexpected: 1 } }),
    ).toThrow(ResolutionLexiconError);
  });

  it("rejects weights that do not sum to one", () => {
    expect(() =>
      parseResolutionLexicon({ component_weights: { source: 0.5 } }),
    ).toThrow(ResolutionLexiconError);
    const rebalanced = parseResolutionLexicon({
      component_weights: { source: 0.3, fallback: 0.15 },
    });
    expect(rebalanced.componentWeights.source).toBe(0.3);
    expect(rebalanced.componentWeights.fallback).toBe(0.15);
  });

  it("rejects an invalid by-date regex", () => {
    expect(() => parseResolutionLexicon({ by_date_patterns: ["("] })).toThrow(
      ResolutionLexiconError,
    );
  });

  it("rejects wrong types and an unsupported schema", () => {
    expect(() => parseResolutionLexicon({ subjective_terms: [1] })).toThrow(
      ResolutionLexiconError,
    );
    expect(() => parseResolutionLexicon({ conditions_cap: 0 })).toThrow(
      ResolutionLexiconError,
    );
    expect(() => parseResolutionLexicon({ schema_version: 2 })).toThrow(
      ResolutionLexiconError,
    );
  });
});

describe("loadResolutionLexicon", () => {
  it("uses the built-in defaults when no file is configured", async () => {
    const lexicon = await loadResolutionLexicon({ env: {} });
    expect(lexicon).toBe(DEFAULT_RESOLUTION_LEXICON);
  });

  it("fails closed on an unreadable or invalid file", async () => {
    await expect(
      loadResolutionLexicon({
        env: { [RESOLUTION_LEXICON_FILE_ENV]: "/nope.json" },
        readTextFile: () => Promise.reject(new Error("ENOENT")),
      }),
    ).rejects.toThrow(ResolutionLexiconError);

    await expect(
      loadResolutionLexicon({
        env: { [RESOLUTION_LEXICON_FILE_ENV]: "/bad.json" },
        readTextFile: () => Promise.resolve("{"),
      }),
    ).rejects.toThrow(ResolutionLexiconError);
  });

  it("parses the file shipped in the repository", async () => {
    const { readFile } = await import("node:fs/promises");
    const shipped = new URL(
      "../../../../../config/resolution-lexicon.json",
      import.meta.url,
    ).pathname;
    const lexicon = await loadResolutionLexicon({
      env: { [RESOLUTION_LEXICON_FILE_ENV]: shipped },
      readTextFile: (path) => readFile(path, "utf8"),
    });
    // The shipped file must stay in sync with the defaults documented in code.
    expect(lexicon).toEqual(DEFAULT_RESOLUTION_LEXICON);
    expect(lexiconHash(lexicon)).toBe(lexiconHash(DEFAULT_RESOLUTION_LEXICON));
  });
});

describe("lexiconHash", () => {
  it("is stable under key reordering", () => {
    const a = parseResolutionLexicon(
      JSON.parse('{"conditions_cap": 4, "schema_version": 1}') as unknown,
    );
    const b = parseResolutionLexicon(
      JSON.parse('{"schema_version": 1, "conditions_cap": 4}') as unknown,
    );
    expect(lexiconHash(a)).toBe(lexiconHash(b));

    const reordered = Object.fromEntries(
      Object.entries(DEFAULT_RESOLUTION_LEXICON).reverse(),
    ) as unknown as ResolutionLexicon;
    expect(lexiconHash(reordered)).toBe(
      lexiconHash(DEFAULT_RESOLUTION_LEXICON),
    );
  });

  it("changes when a term is added", () => {
    const extended: ResolutionLexicon = {
      ...DEFAULT_RESOLUTION_LEXICON,
      subjectiveTerms: [
        ...DEFAULT_RESOLUTION_LEXICON.subjectiveTerms,
        "as decided by the team",
      ],
    };
    expect(lexiconHash(extended)).not.toBe(
      lexiconHash(DEFAULT_RESOLUTION_LEXICON),
    );
  });
});
