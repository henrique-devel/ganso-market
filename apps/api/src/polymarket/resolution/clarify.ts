// RFC-012 task 2: classify a rule_change diff as material or cosmetic.
// Polymarket has no official clarifications feed — the diff between rule
// versions (RFC-007's versioned registry) is the only detector. The
// classification is deterministic and reproducible: same two versions, same
// verdict, forever.

export interface RuleSnapshot {
  readonly description: string;
  readonly resolutionSource: string | null;
  readonly endDate: Date | null;
  readonly umaEndDate: Date | null;
  readonly umaBond: string | null;
  readonly customLiveness: string | null;
}

export interface ClarificationVerdict {
  readonly classification: "material" | "cosmetic";
  readonly changedFields: readonly string[];
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * Words whose appearance or disappearance flips what the rule MEANS, as
 * opposed to how it reads. Direction and negation flips are the classic
 * dispute fuel ("above" -> "below", adding an "unless").
 */
const MEANING_TOKENS: ReadonlySet<string> = new Set([
  "not",
  "no",
  "never",
  "unless",
  "except",
  "excluding",
  "above",
  "below",
  "over",
  "under",
  "least",
  "most",
  "before",
  "after",
  "by",
  "until",
  "reach",
  "reaches",
  "dip",
  "dips",
  "exceed",
  "exceeds",
  "yes",
  "cannot",
  "50/50",
]);

const MONTHS = new Set([
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
]);

/** Rewrites touching more than this many neutral tokens are material. */
const NEUTRAL_TOKEN_BUDGET = 5;

function normalizeTokens(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/(\d),(?=\d)/g, "$1")
      .replace(/[,;:!?"'()[\]]/g, " ")
      .split(/\s+/)
      // Sentence periods are presentation; interior dots (decimals) survive.
      .map((token) => token.replace(/\.+$/, ""))
      .filter((token) => token.length > 0)
  );
}

function isMeaningToken(token: string): boolean {
  if (MEANING_TOKENS.has(token) || MONTHS.has(token)) {
    return true;
  }
  // Numbers (prices, thresholds, years) always carry meaning.
  return /^\$?\d+(\.\d+)?[km]?$/.test(token);
}

function symmetricDifference(
  before: readonly string[],
  after: readonly string[],
): string[] {
  const counts = new Map<string, number>();
  for (const token of before) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  for (const token of after) {
    counts.set(token, (counts.get(token) ?? 0) - 1);
  }
  const diff: string[] = [];
  for (const [token, count] of counts) {
    if (count !== 0) {
      diff.push(token);
    }
  }
  return diff.sort();
}

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * Classify the change from `previous` to `next`. Material when a normative
 * field changed (source, dates, bond, liveness) or when the text diff touches
 * meaning-bearing tokens (numbers, dates, negations, directions) or rewrites
 * more than a token budget; cosmetic when only presentation moved.
 */
export function classifyRuleChange(
  previous: RuleSnapshot,
  next: RuleSnapshot,
): ClarificationVerdict {
  const changedFields: string[] = [];
  if (previous.resolutionSource !== next.resolutionSource) {
    changedFields.push("resolution_source");
  }
  if (isoOrNull(previous.endDate) !== isoOrNull(next.endDate)) {
    changedFields.push("end_date");
  }
  if (isoOrNull(previous.umaEndDate) !== isoOrNull(next.umaEndDate)) {
    changedFields.push("uma_end_date");
  }
  if (previous.umaBond !== next.umaBond) {
    changedFields.push("uma_bond");
  }
  if (previous.customLiveness !== next.customLiveness) {
    changedFields.push("custom_liveness");
  }

  const beforeTokens = normalizeTokens(previous.description);
  const afterTokens = normalizeTokens(next.description);
  const diff = symmetricDifference(beforeTokens, afterTokens);
  if (diff.length > 0) {
    changedFields.push("description");
  }
  const meaningDiff = diff.filter(isMeaningToken);
  const nonTextChanged = changedFields.some((f) => f !== "description");

  const material =
    nonTextChanged ||
    meaningDiff.length > 0 ||
    diff.length > NEUTRAL_TOKEN_BUDGET;

  return {
    classification: material ? "material" : "cosmetic",
    changedFields,
    detail: {
      token_diff: diff.slice(0, 50),
      meaning_tokens: meaningDiff.slice(0, 50),
      token_diff_size: diff.length,
    },
  };
}
