/** Shared venue price-grid rounding. No strategy or network calls. */
export function venueGridPrice(
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
