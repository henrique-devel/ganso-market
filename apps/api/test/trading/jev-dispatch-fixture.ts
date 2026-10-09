import type { JevDispatchCapacity } from "../../src/storage/jev-dispatch-capacity.js";
import { jevDispatchRegistryHashTx } from "../../src/storage/jev-dispatch-capacity.js";
import type { SqlExecutor } from "../../src/database.js";
import { storeRetentionObjectTx } from "../../src/storage/btc-retention.js";
import { scope } from "./risk-fixture.js";
export function dispatchCapacity(
  registry_hash = "a".repeat(64),
  now = Date.now(),
): JevDispatchCapacity {
  return {
    schema_version: "jev.dispatch-capacity.v1",
    origin: "observed_runtime",
    registry_hash,
    model: "jev-1.13.0",
    observed_at: new Date(now).toISOString(),
    valid_until: new Date(now + 3600000).toISOString(),
    sustained_resources_reference: "fixture:capacity:resources",
    reconciled_usage_reference: "fixture:capacity:usage",
    protected_evidence_reference: "fixture:capacity:pins",
    monthly_operation_usd6: "8000000",
    monthly_generation_usd6: "2000000",
    projected_90d_and_retention_bytes: "100000000000",
    disk_free_ppm: 250000,
    response_max_ms: 1500,
    protection_max_ms: 1000,
  };
}
export async function seedDispatchCapacityTx(tx: SqlExecutor, at: number) {
  const proof = dispatchCapacity(await jevDispatchRegistryHashTx(tx), at);
  const refs = [
    proof.sustained_resources_reference,
    proof.reconciled_usage_reference,
    proof.protected_evidence_reference,
  ];
  for (const id of refs)
    await storeRetentionObjectTx(tx, {
      id,
      class: "raw",
      identity: scope,
      recordedAt: new Date(at),
      payload: { fixture_only: true },
      dependencies: [],
    });
  await storeRetentionObjectTx(tx, {
    id: "fixture:capacity",
    class: "raw",
    identity: scope,
    recordedAt: new Date(at),
    payload: proof,
    dependencies: refs,
  });
  return "fixture:capacity";
}
