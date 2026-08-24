// RFC-012 task 11: LADDER edge inference from market titles. Deterministic
// extraction of (asset, direction, threshold) from the question text; the
// temporal key comes from the versioned rule's end_date, never from parsing
// prose dates. Every inferred edge carries confidence < 1 and is revisable —
// a parse that is not certain refuses to produce an edge (fail closed).

export type LadderDirection = "up" | "down";

export interface LadderKey {
  /** Canonical asset symbol (BTC, ETH, SOL, XRP, DOGE). */
  readonly asset: string;
  readonly direction: LadderDirection;
  /** Threshold in USD, as a number (exact enough for ordering). */
  readonly threshold: number;
  /**
   * Barrier form ("reach/hit/dip to/by DATE"): pays on first passage, so the
   * date ladder is monotone. Terminal form ("above ON date") is NOT monotone
   * in the date and never joins a date ladder.
   */
  readonly barrier: boolean;
}

const ASSETS: ReadonlyArray<{ pattern: RegExp; symbol: string }> = [
  { pattern: /\bbitcoin\b|\bbtc\b/i, symbol: "BTC" },
  { pattern: /\bethereum\b|\beth\b/i, symbol: "ETH" },
  { pattern: /\bsolana\b|\bsol\b/i, symbol: "SOL" },
  { pattern: /\bxrp\b|\bripple\b/i, symbol: "XRP" },
  { pattern: /\bdogecoin\b|\bdoge\b/i, symbol: "DOGE" },
];

const UP_TERMS =
  /\b(reach(es)?|hit(s)?|exceed(s)?|above|over|at\s+or\s+above|higher\s+than|close(s)?\s+above)\b/i;
const DOWN_TERMS =
  /\b(dip(s)?\s+to|drop(s)?\s+to|fall(s)?\s+to|below|under|at\s+or\s+below|lower\s+than|close(s)?\s+below)\b/i;
const BARRIER_TERMS =
  /\b(reach(es)?|hit(s)?|dip(s)?\s+to|drop(s)?\s+to|fall(s)?\s+to|at\s+any\s+point|by\s+(january|february|march|april|may|june|july|august|september|october|november|december|\d{4}))\b/i;

/** "$82,500", "$1.25", "100k", "1.5m" -> USD number. */
function parseThreshold(text: string): number | null {
  const match = /\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)\s*([km])?\b/i.exec(text);
  if (match === null) {
    const bare = /\b([0-9]{2,}(?:,[0-9]{3})*(?:\.[0-9]+)?)\s*([km])\b/i.exec(
      text,
    );
    if (bare === null) {
      return null;
    }
    return expand(bare[1] ?? "", bare[2]);
  }
  return expand(match[1] ?? "", match[2]);
}

function expand(digits: string, suffix: string | undefined): number | null {
  const base = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(base)) {
    return null;
  }
  const factor =
    suffix === undefined ? 1 : suffix.toLowerCase() === "k" ? 1_000 : 1_000_000;
  return base * factor;
}

/**
 * Extract a ladder key from a question title. Null whenever any component is
 * ambiguous: no asset, no direction, both directions, or no threshold.
 */
export function extractLadderKey(question: string): LadderKey | null {
  let asset: string | null = null;
  for (const candidate of ASSETS) {
    if (candidate.pattern.test(question)) {
      if (asset !== null) {
        return null;
      }
      asset = candidate.symbol;
    }
  }
  if (asset === null) {
    return null;
  }
  const up = UP_TERMS.test(question);
  const down = DOWN_TERMS.test(question);
  if (up === down) {
    return null;
  }
  const threshold = parseThreshold(question);
  if (threshold === null || threshold <= 0) {
    return null;
  }
  return {
    asset,
    direction: up ? "up" : "down",
    threshold,
    barrier: BARRIER_TERMS.test(question),
  };
}

export interface LadderMarket {
  readonly conditionId: string;
  readonly question: string;
  /** Temporal key: the versioned rule's end_date at build time. */
  readonly endDate: Date | null;
}

export interface InferredImplication {
  readonly fromConditionId: string;
  readonly toConditionId: string;
  readonly kind: "LADDER";
  readonly confidence: string;
  readonly params: Readonly<Record<string, unknown>>;
}

const SAME_DATE_TOLERANCE_MS = 3_600_000;

/**
 * Infer LADDER implications over a set of markets:
 *  - threshold ladder (same asset+direction+date): for "up" the higher
 *    threshold implies the lower one; for "down" the lower target implies the
 *    higher floor;
 *  - date ladder (same asset+direction+threshold, BARRIER form only):
 *    reaching it by the earlier date implies reaching it by the later date.
 */
export function inferLadders(
  markets: readonly LadderMarket[],
): InferredImplication[] {
  const parsed = markets
    .map((market) => ({ market, key: extractLadderKey(market.question) }))
    .filter(
      (entry): entry is { market: LadderMarket; key: LadderKey } =>
        entry.key !== null,
    );
  const edges: InferredImplication[] = [];

  for (let i = 0; i < parsed.length; i += 1) {
    for (let j = i + 1; j < parsed.length; j += 1) {
      const a = parsed[i];
      const b = parsed[j];
      if (a === undefined || b === undefined) {
        continue;
      }
      if (a.key.asset !== b.key.asset || a.key.direction !== b.key.direction) {
        continue;
      }
      const sameDate =
        a.market.endDate !== null &&
        b.market.endDate !== null &&
        Math.abs(a.market.endDate.getTime() - b.market.endDate.getTime()) <=
          SAME_DATE_TOLERANCE_MS;
      const sameThreshold = a.key.threshold === b.key.threshold;

      if (sameDate && !sameThreshold) {
        // Threshold ladder. "up": P(>= high) <= P(>= low); "down": P(<= low)
        // <= P(<= high). The implying side is the strictly harder event.
        const [harder, easier] =
          a.key.direction === "up"
            ? a.key.threshold > b.key.threshold
              ? [a, b]
              : [b, a]
            : a.key.threshold < b.key.threshold
              ? [a, b]
              : [b, a];
        edges.push({
          fromConditionId: harder.market.conditionId,
          toConditionId: easier.market.conditionId,
          kind: "LADDER",
          confidence: "0.800000",
          params: {
            family: "threshold",
            asset: a.key.asset,
            direction: a.key.direction,
            from_threshold: harder.key.threshold,
            to_threshold: easier.key.threshold,
          },
        });
      } else if (
        !sameDate &&
        sameThreshold &&
        a.key.barrier &&
        b.key.barrier &&
        a.market.endDate !== null &&
        b.market.endDate !== null
      ) {
        // Date ladder, barrier payoffs only: first passage by March implies
        // first passage by June. Terminal "on DATE" markets never join.
        const aTime = a.market.endDate.getTime();
        const bTime = b.market.endDate.getTime();
        const [earlier, later] = aTime < bTime ? [a, b] : [b, a];
        edges.push({
          fromConditionId: earlier.market.conditionId,
          toConditionId: later.market.conditionId,
          kind: "LADDER",
          confidence: "0.700000",
          params: {
            family: "date",
            asset: a.key.asset,
            direction: a.key.direction,
            threshold: a.key.threshold,
            from_end_date: new Date(Math.min(aTime, bTime)).toISOString(),
            to_end_date: new Date(Math.max(aTime, bTime)).toISOString(),
          },
        });
      }
    }
  }
  return edges;
}
