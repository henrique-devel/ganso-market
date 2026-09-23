/** Collision-free encoding only; callers validate and supply every identity
 * dimension. trading.v1 scope/idempotency validation remains in contracts. */
export function compositeKey(parts: readonly string[]): string {
  return JSON.stringify(parts);
}
