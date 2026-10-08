/** Shared fixed-point indicator arithmetic; no strategy signal or clock. */
export interface IndicatorCandle {
  open: string;
  high: string;
  low: string;
  close: string;
}
const abs = (n: bigint) => (n < 0n ? -n : n);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
export function atr14(bars: readonly IndicatorCandle[]): bigint {
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
