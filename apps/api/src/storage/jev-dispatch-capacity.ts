import { BTC_STORAGE_STOP_BYTES } from "../trading/retention.js";
import { jevHash } from "./jev-hash.js";
import type { SqlExecutor } from "../database.js";
export const JEV_DISPATCH_CAPACITY_VERSION = "jev.dispatch-capacity.v1";
/** Measured admission evidence, provisioned only by the separately selected
 * operational gate. A corpus estimate cannot stand in for these attestations. */
export interface JevDispatchCapacity {
  schema_version: "jev.dispatch-capacity.v1";
  origin: "observed_runtime";
  registry_hash: string;
  model: string;
  observed_at: string;
  valid_until: string;
  sustained_resources_reference: string;
  reconciled_usage_reference: string;
  protected_evidence_reference: string;
  monthly_operation_usd6: string | null;
  monthly_generation_usd6: string | null;
  projected_90d_and_retention_bytes: string | null;
  disk_free_ppm: number | null;
  response_max_ms: number | null;
  protection_max_ms: number | null;
}
export async function jevDispatchRegistryHashTx(tx: SqlExecutor) {
  return jevHash(
    (
      await tx.query(
        "SELECT slot,owner_id,profile_id,profile_version,paper_account_id,stress_account_id,paper_experiment_id,stress_experiment_id FROM jev_pairs ORDER BY slot",
      )
    ).rows,
  );
}
export function jevDispatchCapacityReady(
  input: unknown,
  registryHash: string,
  model: string,
  now: number,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const e = input as JevDispatchCapacity;
  const amount = (v: unknown, ceiling: bigint, strict = false) =>
    typeof v === "string" &&
    /^(0|[1-9][0-9]*)$/.test(v) &&
    (strict ? BigInt(v) < ceiling : BigInt(v) <= ceiling);
  const measured = (v: unknown, ceiling: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= ceiling;
  const ref = (v: unknown) =>
    typeof v === "string" && /^[A-Za-z0-9._:/-]{1,512}$/.test(v);
  return (
    e.schema_version === JEV_DISPATCH_CAPACITY_VERSION &&
    e.origin === "observed_runtime" &&
    e.registry_hash === registryHash &&
    /^[a-f0-9]{64}$/.test(registryHash) &&
    e.model === model &&
    Number.isFinite(now) &&
    typeof e.observed_at === "string" &&
    typeof e.valid_until === "string" &&
    Date.parse(e.observed_at) <= now &&
    now < Date.parse(e.valid_until) &&
    [
      e.sustained_resources_reference,
      e.reconciled_usage_reference,
      e.protected_evidence_reference,
    ].every(ref) &&
    amount(e.monthly_operation_usd6, 8000000n) &&
    amount(e.monthly_generation_usd6, 2000000n) &&
    amount(e.projected_90d_and_retention_bytes, BTC_STORAGE_STOP_BYTES, true) &&
    BigInt(e.projected_90d_and_retention_bytes!) > 0n &&
    typeof e.disk_free_ppm === "number" &&
    Number.isSafeInteger(e.disk_free_ppm) &&
    e.disk_free_ppm >= 250000 &&
    e.disk_free_ppm <= 1000000 &&
    measured(e.response_max_ms, 1500) &&
    measured(e.protection_max_ms, 1000)
  );
}
export async function readJevDispatchCapacityTx(
  tx: SqlExecutor,
  evidenceId: string | null,
  registryHash: string,
  model: string,
  now: number,
) {
  if (!evidenceId) return false;
  const row = (
    await tx.query<{ payload: unknown; recorded_at: Date }>(
      "SELECT payload,recorded_at FROM btc_retention_objects WHERE object_id=$1 AND class='raw'",
      [evidenceId],
    )
  ).rows[0];
  if (
    !row ||
    row.recorded_at.getTime() > now ||
    !jevDispatchCapacityReady(row.payload, registryHash, model, now)
  )
    return false;
  const e = row.payload as JevDispatchCapacity;
  // Proof references must be real retained originals, with no future receipt.
  const refs = [
    ...new Set([
      e.sustained_resources_reference,
      e.reconciled_usage_reference,
      e.protected_evidence_reference,
    ]),
  ];
  return (
    (
      await tx.query(
        "SELECT object_id FROM btc_retention_objects WHERE object_id=ANY($1::text[]) AND recorded_at<=$2 AND object_id IN (SELECT dependency_id FROM btc_retention_dependencies WHERE object_id=$3)",
        [refs, new Date(now).toISOString(), evidenceId],
      )
    ).rowCount === refs.length
  );
}
