import type { MarketRegistryEntry } from "./types.js";

// Categories the recorder tracks per RFC-007 "Universo": crypto price markets
// and scheduled macro releases only. Elections, live sports, mentions and
// geopolitics are hard-excluded (regulatory/oracle risk, subjective wording).
const ALLOWED_CATEGORIES = new Set(["crypto", "macro"]);
const MIN_RULES_LENGTH = 10;

// Primary classification is by Gamma tag slug (request with include_tag=true).
// Inclusion wins over the generic "politics" tag that macro/Fed markets also
// carry, so Fed markets classify as macro rather than being excluded.
const TAG_CATEGORY = new Map<string, string>([
  ["crypto", "crypto"],
  ["crypto-prices", "crypto"],
  ["bitcoin", "crypto"],
  ["ethereum", "crypto"],
  ["solana", "crypto"],
  ["xrp", "crypto"],
  ["ripple", "crypto"],
  ["dogecoin", "crypto"],
  ["memecoins", "crypto"],
  ["economy", "macro"],
  ["economic-policy", "macro"],
  ["fed", "macro"],
  ["fed-rates", "macro"],
  ["jerome-powell", "macro"],
  ["interest-rates", "macro"],
  ["inflation", "macro"],
  ["cpi", "macro"],
  ["gdp", "macro"],
  ["recession", "macro"],
  ["macro", "macro"],
  ["us-economy", "macro"],
]);
const CATEGORY_PRIORITY = ["crypto", "macro"] as const;

// Keyword fallback, used only when a market carries no tags. Election, sports,
// mentions and geopolitics keywords force exclusion.
const EXCLUDE_KEYWORDS = [
  "election",
  "eleic",
  "electoral",
  " vs ",
  " vs.",
  "esports",
  "valorant",
  "nba",
  "nfl",
  "mlb",
  "ufc",
  "premier league",
  "mention",
  "ceasefire",
  "invasion",
  "invade",
  "airstrike",
  "military strike",
];
const KEYWORD_CATEGORY: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    "macro",
    [
      "fed ",
      "fomc",
      "cpi",
      "inflation",
      "interest rate",
      "rate cut",
      "gdp",
      "recession",
    ],
  ],
  [
    "crypto",
    [
      "bitcoin",
      "btc",
      "ethereum",
      "solana",
      "crypto",
      "dogecoin",
      "xrp",
      "up or down",
    ],
  ],
];

// Augmented negRisk events pad their outcome list with placeholder entries;
// only named outcomes are recorded (RFC-007 "Universo" hard exclusion).
const PLACEHOLDER_OUTCOME = /^(?:person|candidate|team|other)\s*[a-z]?\d*$/i;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function asBoolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

// Tick sizes and reward parameters arrive as numbers or strings; keep them as
// canonical decimal strings, never floats used in math.
function asDecimalString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function parseStringArray(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value.every((item): item is string => typeof item === "string")
      ? value
      : null;
  }
  // Gamma encodes clobTokenIds/outcomes as a stringified JSON array.
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.every((item): item is string => typeof item === "string")
          ? parsed
          : null;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function affirmativeTokenId(
  tokenIds: readonly string[],
  rawOutcomes: unknown,
): string | null {
  const outcomes = parseStringArray(rawOutcomes);
  if (
    tokenIds.length !== 2 ||
    outcomes === null ||
    outcomes.length !== tokenIds.length
  ) {
    return null;
  }
  const affirmativeIndexes = outcomes.flatMap((outcome, index) =>
    /^(?:yes|up)$/i.test(outcome.trim()) ? [index] : [],
  );
  if (affirmativeIndexes.length !== 1) {
    return null;
  }
  const tokenId = tokenIds[affirmativeIndexes[0] ?? -1];
  return typeof tokenId === "string" && tokenId.trim().length > 0
    ? tokenId
    : null;
}

function parseTagSlugs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const slugs: string[] = [];
  for (const item of value) {
    if (typeof item === "object" && item !== null) {
      const slug = (item as Record<string, unknown>).slug;
      if (typeof slug === "string" && slug.length > 0) {
        slugs.push(slug.toLowerCase());
      }
    }
  }
  return slugs;
}

function classifyByKeyword(
  question: string,
  slug: string | null,
  rules: string | null,
): string | null {
  const haystack = `${question} ${slug ?? ""} ${rules ?? ""}`.toLowerCase();
  if (EXCLUDE_KEYWORDS.some((keyword) => haystack.includes(keyword))) {
    return null;
  }
  for (const [category, keywords] of KEYWORD_CATEGORY) {
    if (keywords.some((keyword) => haystack.includes(keyword))) {
      return category;
    }
  }
  return null;
}

// Classify a market: tags first (inclusion wins over politics), then explicit
// category, then keyword fallback when no tags are present.
function classifyCategory(
  tagSlugs: readonly string[],
  explicit: string | null,
  question: string,
  slug: string | null,
  rules: string | null,
): string | null {
  if (tagSlugs.length > 0) {
    const matched = new Set<string>();
    for (const tag of tagSlugs) {
      const category = TAG_CATEGORY.get(tag);
      if (category !== undefined) {
        matched.add(category);
      }
    }
    for (const category of CATEGORY_PRIORITY) {
      if (matched.has(category)) {
        return category;
      }
    }
    return null;
  }
  if (explicit !== null && ALLOWED_CATEGORIES.has(explicit.toLowerCase())) {
    return explicit.toLowerCase();
  }
  return classifyByKeyword(question, slug, rules);
}

export function parseMarket(raw: unknown): MarketRegistryEntry | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const conditionId = asString(record.conditionId);
  const question = asString(record.question);
  const clobTokenIds = parseStringArray(record.clobTokenIds);
  if (conditionId === null || question === null || clobTokenIds === null) {
    return null;
  }
  const slug = asString(record.slug);
  const rules = asString(record.description);
  const category = classifyCategory(
    parseTagSlugs(record.tags),
    asString(record.category),
    question,
    slug,
    rules,
  );
  return {
    conditionId,
    question,
    slug,
    category,
    negRisk: asBool(record.negRisk),
    clobTokenIds,
    affirmativeTokenId: affirmativeTokenId(clobTokenIds, record.outcomes),
    rules,
    tickSize: asDecimalString(record.orderPriceMinTickSize),
    minOrderSize: asDecimalString(record.orderMinSize),
    rewardsMinSize: asDecimalString(record.rewardsMinSize),
    rewardsMaxSpread: asDecimalString(record.rewardsMaxSpread),
    feeType: asString(record.feeType),
    endDateIso: asString(record.endDateIso),
    active: asBool(record.active),
    closed: asBool(record.closed),
    enableOrderBook: asBool(record.enableOrderBook),
  };
}

/** Gamma event reference embedded in a market payload (negRisk group parent). */
export interface GammaEventRef {
  readonly eventId: string;
  readonly slug: string | null;
  readonly title: string | null;
  readonly negRisk: boolean;
}

/**
 * RFC-007 extended registry record: everything the versioned-rule and
 * versioned-param tables need, on top of the base MarketRegistryEntry.
 * All fields are tolerant: absent/unexpected data becomes null/empty.
 */
export interface ExtendedMarketRecord extends MarketRegistryEntry {
  readonly tagSlugs: readonly string[];
  readonly negRiskOther: boolean;
  /** Named outcomes only; augmented-negRisk placeholders are dropped. */
  readonly outcomes: readonly string[];
  readonly events: readonly GammaEventRef[];
  readonly resolutionSource: string | null;
  readonly resolvedBy: string | null;
  readonly endDate: string | null;
  readonly umaEndDate: string | null;
  readonly umaBond: string | null;
  readonly umaReward: string | null;
  readonly customLiveness: string | null;
  readonly automaticallyResolved: boolean | null;
  readonly updatedAt: string | null;
  /**
   * UMA question identifier (bytes32). RFC-012's onchain collector keys the
   * adapter's lifecycle events by it; without this capture those events could
   * never be mapped back to a condition_id.
   */
  readonly questionId: string | null;
}

function parseEventRefs(value: unknown): GammaEventRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const refs: GammaEventRef[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const eventId =
      asString(record.id) ??
      (typeof record.id === "number" && Number.isFinite(record.id)
        ? String(record.id)
        : null);
    if (eventId === null) {
      continue;
    }
    refs.push({
      eventId,
      slug: asString(record.slug),
      title: asString(record.title),
      negRisk: asBool(record.negRisk),
    });
  }
  return refs;
}

/** bytes32 hex id, normalized to lowercase; anything else degrades to null. */
function parseQuestionId(value: unknown): string | null {
  const raw = asString(value);
  if (raw === null) {
    return null;
  }
  const normalized = raw.toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function parseNamedOutcomes(value: unknown): string[] {
  const outcomes = parseStringArray(value) ?? [];
  return outcomes.filter(
    (name) => name.trim().length > 0 && !PLACEHOLDER_OUTCOME.test(name.trim()),
  );
}

/**
 * Parse the RFC-007 extended registry record. Never throws on unexpected
 * payloads: a row missing its essential identifiers returns null; every
 * optional field degrades to null/empty.
 */
export function parseExtendedMarket(raw: unknown): ExtendedMarketRecord | null {
  try {
    const base = parseMarket(raw);
    if (base === null) {
      return null;
    }
    const record = raw as Record<string, unknown>;
    return {
      ...base,
      tagSlugs: parseTagSlugs(record.tags),
      negRiskOther: asBool(record.negRiskOther),
      outcomes: parseNamedOutcomes(record.outcomes),
      events: parseEventRefs(record.events),
      resolutionSource: asString(record.resolutionSource),
      resolvedBy: asString(record.resolvedBy),
      endDate: asString(record.endDate) ?? asString(record.endDateIso),
      umaEndDate: asString(record.umaEndDate),
      umaBond: asDecimalString(record.umaBond),
      umaReward: asDecimalString(record.umaReward),
      customLiveness: asDecimalString(record.customLiveness),
      automaticallyResolved: asBoolOrNull(record.automaticallyResolved),
      updatedAt: asString(record.updatedAt),
      questionId: parseQuestionId(record.questionID ?? record.questionId),
    };
  } catch {
    return null;
  }
}

/**
 * Whether a market belongs to the recorder's universe: an allowed category
 * (crypto/macro, never elections/sports/mentions/geopolitics), an active
 * order-book market with non-empty rules and two outcome tokens.
 */
export function isInUniverse(entry: MarketRegistryEntry): boolean {
  if (!entry.active || entry.closed || !entry.enableOrderBook) {
    return false;
  }
  if (entry.clobTokenIds.length < 2) {
    return false;
  }
  if (entry.rules === null || entry.rules.length < MIN_RULES_LENGTH) {
    return false;
  }
  if (entry.category === null) {
    return false;
  }
  return ALLOWED_CATEGORIES.has(entry.category);
}
