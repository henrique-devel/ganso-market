/** G2-02.4. New BTC paper storage only; no legacy table names or live path. */
export const BTC_RETENTION_POLICY = Object.freeze({
  version: "btc-retention-v1",
  datasetId: "btc-paper-v1",
  rawDays: 7,
  rawQuotaBytes: 10n * 1024n ** 3n,
  barMonths: 12,
  logDays: 14,
  totalQuotaBytes: 12n * 1024n ** 3n,
  maxBatch: 500,
});
export type RetentionClass =
  "raw" | "bar" | "log" | "decision" | "financial" | "experiment";
/** Instrument/version match trading.v1. Public feed data does not need an owner.
 * Decisions/financial records must include the account and experiment owner.
 * Feed adapters retain their full TradingDataIdentity inside payload. */
export interface StorageIdentity {
  readonly mode: "paper";
  readonly instrument_id: string;
  readonly instrument_version: string;
  readonly account_id?: string;
  readonly experiment_id?: string;
}
export interface RetentionObject {
  readonly id: string;
  readonly class: RetentionClass;
  readonly identity: StorageIdentity;
  readonly recordedAt: Date;
  readonly payload: unknown;
  /** Complete evidence closure edges, including anchors, gaps and metadata. */
  readonly dependencies: readonly string[];
}
export function validateRetentionObject(object: RetentionObject): void {
  if (
    !object.id ||
    object.id.length > 512 ||
    !["raw", "bar", "log", "decision", "financial", "experiment"].includes(
      object.class,
    ) ||
    object.identity.mode !== "paper" ||
    !object.identity.instrument_id ||
    !object.identity.instrument_version ||
    !Number.isFinite(object.recordedAt.getTime()) ||
    object.payload === undefined ||
    new Set(object.dependencies).size !== object.dependencies.length ||
    object.dependencies.some(
      (id) => !id || id === object.id || id.length > 512,
    ) ||
    (["financial", "decision"].includes(object.class) &&
      (!object.identity.account_id || !object.identity.experiment_id)) ||
    (object.class === "experiment" && !object.identity.experiment_id)
  )
    throw new TypeError("BTC_RETENTION_INVALID_ENVELOPE");
}

/** Fail before persistence if JSON serialization would silently lose evidence. */
export function assertEvidenceJson(
  value: unknown,
  ancestors = new Set<object>(),
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (
    typeof value !== "object" ||
    ancestors.has(value) ||
    (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
  ) {
    throw new TypeError("BTC_RETENTION_INVALID_JSON");
  }
  ancestors.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value))
    assertEvidenceJson(item, ancestors);
  ancestors.delete(value);
}
