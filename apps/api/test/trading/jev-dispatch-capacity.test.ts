import { it, expect } from "vitest";
import { jevDispatchCapacityReady } from "../../src/storage/jev-dispatch-capacity.js";
import { dispatchCapacity } from "./jev-dispatch-fixture.js";
it("requires measured cost, resources, fresh cohort and pinned model without changing limits", () => {
  const now = Date.now(),
    e = dispatchCapacity("a".repeat(64), now);
  const ready = (v: unknown) =>
    jevDispatchCapacityReady(v, e.registry_hash, e.model, now);
  expect(ready(e)).toBe(true);
  for (const v of [
    null,
    {},
    { ...e, origin: "disposable_postgres_fixture" },
    { ...e, registry_hash: "b".repeat(64) },
    { ...e, model: "jev-moving" },
    { ...e, observed_at: new Date(now + 1).toISOString() },
    { ...e, valid_until: new Date(now).toISOString() },
    { ...e, monthly_operation_usd6: null },
    { ...e, monthly_operation_usd6: "8000001" },
    { ...e, monthly_generation_usd6: "2000001" },
    { ...e, projected_90d_and_retention_bytes: "160000000000" },
    { ...e, disk_free_ppm: 249999 },
    { ...e, response_max_ms: 1501 },
    { ...e, protection_max_ms: 1001 },
    { ...e, protection_max_ms: null },
    { ...e, sustained_resources_reference: "" },
  ])
    expect(ready(v)).toBe(false);
});
