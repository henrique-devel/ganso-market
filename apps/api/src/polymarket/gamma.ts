import type { MarketRegistryEntry } from "./types.js";

// Categories the recorder tracks (crypto up/down, scheduled macro, weather).
// Elections and live sports are excluded (regulatory/oracle risk and anti-sniping
// frictions) per the RFC-007 amendment.
const ALLOWED_CATEGORIES = new Set(["crypto", "macro", "economics", "weather"]);
const ELECTION_KEYWORDS = ["election", "eleic", "electoral"];
const MIN_RULES_LENGTH = 10;

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
  return {
    conditionId,
    question,
    slug: asString(record.slug),
    category: asString(record.category),
    negRisk: asBool(record.negRisk),
    clobTokenIds,
    rules: asString(record.description),
    tickSize: asDecimalString(record.orderPriceMinTickSize),
    minOrderSize: asDecimalString(record.orderMinSize),
    rewardsMinSize: asDecimalString(record.rewardsMinSize),
    rewardsMaxSpread: asDecimalString(record.rewardsMaxSpread),
    feeType: asString(record.feeType),
    endDateIso: asString(record.endDateIso),
    active: asBool(record.active),
    closed: asBool(record.closed),
  };
}

function mentionsElection(entry: MarketRegistryEntry): boolean {
  const haystack =
    `${entry.category ?? ""} ${entry.slug ?? ""} ${entry.question}`.toLowerCase();
  return ELECTION_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

/**
 * Whether a market belongs to the recorder's universe: an allowed category, an
 * active two-outcome market with non-empty rules, and never an election market.
 */
export function isInUniverse(entry: MarketRegistryEntry): boolean {
  if (!entry.active || entry.closed) {
    return false;
  }
  if (entry.clobTokenIds.length < 2) {
    return false;
  }
  if (entry.rules === null || entry.rules.length < MIN_RULES_LENGTH) {
    return false;
  }
  if (mentionsElection(entry)) {
    return false;
  }
  if (entry.category === null) {
    return false;
  }
  return ALLOWED_CATEGORIES.has(entry.category.toLowerCase());
}
