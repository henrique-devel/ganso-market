/** Frozen indicators and price arithmetic. BTC8 / USD_PER_BTC6, newest first.
 * Validation, financial policy and persistence belong to the composing adapter.
 * No clock, I/O, scheduler or execution. */
export const BASELINE_POLICY = "btc.baseline.trend.v1" as const;
export const BASELINE_RESULT = "btc.baseline-decision.v1" as const;
export type BaselineDirection = "long" | "short";
export interface BaselineCandle {
  open: string;
  high: string;
  low: string;
  close: string;
}
const abs = (n: bigint) => (n < 0n ? -n : n);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

export function baselineTrend(
  closes: readonly string[],
): BaselineDirection | null {
  if (closes.length !== 12) throw new Error("BTC_BASELINE_CONTEXT_LENGTH");
  const values = closes.map(BigInt);
  const fast = values.slice(0, 4).reduce((a, b) => a + b, 0n);
  const slow = values.reduce((a, b) => a + b, 0n);
  if (values[0]! * 4n > fast && fast * 12n > slow * 4n) return "long";
  if (values[0]! * 4n < fast && fast * 12n < slow * 4n) return "short";
  return null;
}

export function baselineBreakout(
  trend: BaselineDirection | null,
  current: BaselineCandle,
  previous: BaselineCandle,
): BaselineDirection | null {
  const c = BigInt(current.close),
    o = BigInt(current.open);
  if (trend === "long" && c > BigInt(previous.high) && c > o) return trend;
  if (trend === "short" && c < BigInt(previous.low) && c < o) return trend;
  return null;
}

export function baselineAtr(bars: readonly BaselineCandle[]): bigint {
  if (bars.length !== 15) throw new Error("BTC_BASELINE_ATR_LENGTH");
  let sum = 0n;
  for (let i = 0; i < 14; i++) {
    const h = BigInt(bars[i]!.high),
      l = BigInt(bars[i]!.low);
    const previous = BigInt(bars[i + 1]!.close);
    sum += max(h - l, max(abs(h - previous), abs(l - previous)));
  }
  return (sum + 13n) / 14n;
}

/** Nearest valid price in a direction, including integer-price exemptions.
 * Enumerate decimal grids, not prices: significant digits can change at a
 * power-of-ten boundary. Intersect each grid with the instrument quantum. */
export function baselinePrice(
  numerator: bigint,
  denominator: bigint,
  direction: "up" | "down",
  metadata: {
    instrument: { tick_size: { raw: string } };
    price_rules: {
      max_decimals: number;
      max_significant_digits: number;
      integer_prices_exempt: boolean;
    };
  },
): bigint | null {
  const rules = metadata.price_rules,
    tick = BigInt(metadata.instrument.tick_size.raw);
  if (
    numerator <= 0n ||
    denominator <= 0n ||
    tick <= 0n ||
    !Number.isInteger(rules.max_decimals) ||
    rules.max_decimals < 0 ||
    rules.max_decimals > 6 ||
    !Number.isInteger(rules.max_significant_digits) ||
    rules.max_significant_digits < 1 ||
    rules.max_significant_digits > 38
  )
    return null;
  const gcd = (a: bigint, b: bigint): bigint => {
    while (b) {
      const next = a % b;
      a = b;
      b = next;
    }
    return a;
  };
  let best: bigint | null = null;
  for (let zeros = 6 - rules.max_decimals; zeros <= 38; zeros++) {
    const decimal = 10n ** BigInt(zeros),
      grid = (tick / gcd(tick, decimal)) * decimal;
    const d = denominator * grid;
    const p =
      (direction === "up" ? (numerator + d - 1n) / d : numerator / d) * grid;
    if (p <= 0n || p.toString().length > 38) continue;
    if (
      !(rules.integer_prices_exempt && p % 1000000n === 0n) &&
      p.toString().replace(/0+$/, "").length > rules.max_significant_digits
    )
      continue;
    if (best === null || (direction === "up" ? p < best : p > best)) best = p;
  }
  return best;
}
