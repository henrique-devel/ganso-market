/** Sorted object keys and ordered arrays; callers choose the fingerprint fields.
 * Accepts ledger JSON values, not a hash or a domain event/idempotency policy. */
export function canonicalFingerprint(
  value: unknown,
  invalid: () => never = () => {
    throw new TypeError("Invalid fingerprint payload");
  },
): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return invalid();
    return serialized;
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalFingerprint(item, invalid)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalFingerprint(record[key], invalid)}`,
    )
    .join(",")}}`;
}

/** Economic time then stable key. Ingestion order/IDs do not break ties;
 * adapters retain any further owner tie-break or causal validation. */
export function compareReplayOrder(
  a: { readonly eventTs: Date; readonly idempotencyKey: string },
  b: { readonly eventTs: Date; readonly idempotencyKey: string },
): number {
  return (
    a.eventTs.getTime() - b.eventTs.getTime() ||
    (a.idempotencyKey < b.idempotencyKey
      ? -1
      : a.idempotencyKey > b.idempotencyKey
        ? 1
        : 0)
  );
}

/** UTC calendar bucket; weeks start on Monday. Input dates are validated by callers. */
export function utcBucketStart(at: Date, weekly: boolean): string {
  const start = new Date(at);
  start.setUTCHours(0, 0, 0, 0);
  if (weekly)
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return start.toISOString().slice(0, 10);
}
