import type { MarketRegistryEntry } from "./types.js";

// Categories the recorder tracks (crypto up/down, scheduled macro, weather).
// Elections and live sports are excluded (regulatory/oracle risk and anti-sniping
// frictions) per the RFC-007 amendment.
const ALLOWED_CATEGORIES = new Set(["crypto", "macro", "weather"]);
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
  ["weather", "weather"],
  ["climate", "weather"],
  ["temperature", "weather"],
]);
const CATEGORY_PRIORITY = ["crypto", "macro", "weather"] as const;

// Keyword fallback, used only when a market carries no tags. Election and sports
// keywords force exclusion.
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
];
const KEYWORD_CATEGORY: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    "weather",
    ["temperature", "weather", "hurricane", "warmest", "coldest", "°"],
  ],
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

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asBool(value: unknown): boolean {
  return value === true;
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
    return value.filter((item): item is string => typeof item === "string");
  }
  // Gamma encodes clobTokenIds as a stringified JSON array.
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is string => typeof item === "string",
        );
      }
    } catch {
      return null;
    }
  }
  return null;
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

/**
 * Whether a market belongs to the recorder's universe: an allowed category
 * (crypto/macro/weather, never elections), an active order-book market with
 * non-empty rules and two outcome tokens.
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
