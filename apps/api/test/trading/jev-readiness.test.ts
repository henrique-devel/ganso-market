import { describe, it, expect } from "vitest";
import {
  engineTimeline,
  engineQualification,
  engineFingerprint,
  type EnginePulse,
} from "../../src/storage/jev-readiness.js";
import { jevResourcesReady } from "../../src/storage/jev-dispatch-capacity.js";
import { jevScope } from "../../src/storage/jev-ledger.js";
import { jevIdentity } from "./jev-v2-fixture.js";
const i = jevIdentity(),
  scope = jevScope(i.bindings[0]!.binding, i.instrument);
const sample = (at: number, ready = true): EnginePulse => ({
  at,
  ready,
  reasons: ready ? [] : ["financial_history_unproven"],
  scope,
  generation: "1",
  ledger: { paper: "1" },
  flat: true,
  exercised: {
    execution: true,
    costs: true,
    funding: true,
    risk: true,
    recovery: true,
  },
});
describe("JE11 actual sample timeline qualification gates", () => {
  it("detects internal missing samples even with healthy beginning/end", () => {
    expect(
      engineTimeline(
        [sample(0), sample(1000), sample(3000), sample(4000)],
        0,
        4000,
      ),
    ).toMatchObject({ covered_ms: 2000, valid: false });
    expect(
      engineTimeline([sample(0), sample(1000), sample(2000)], 0, 2000).valid,
    ).toBe(true);
    expect(
      engineTimeline([sample(0), sample(1000, false), sample(2000)], 0, 2000)
        .valid,
    ).toBe(false);
  });
  it("requires seven actual days, exercised paths and no financial gap; mock origin never qualifies", () => {
    const base = {
      origin: "observed_runtime",
      start_at: new Date(0).toISOString(),
      end_at: new Date(7 * 86400000).toISOString(),
      valid: true,
      exercised: sample(0).exercised,
      financial_gap: false,
    };
    expect(engineQualification(base)).toBe(true);
    for (const change of [
      { origin: "fixture" },
      { financial_gap: true },
      { valid: false },
      { end_at: new Date(7 * 86400000 - 1).toISOString() },
      { exercised: { ...base.exercised, funding: false } },
    ])
      expect(engineQualification({ ...base, ...change })).toBe(false);
    expect(engineFingerprint("a".repeat(40))).not.toBe(
      engineFingerprint("b".repeat(40)),
    );
  });
  it("blocks uncertain resource/cpu/write capacity rather than using container health", () => {
    const proof = {
      origin: "observed_runtime",
      observed_at: new Date(0).toISOString(),
      valid_until: new Date(2000).toISOString(),
      host_ram_used_bytes: "13000000000",
      host_cpu_busy_ppm: 750000,
      db_write_max_ms: 1000,
    };
    expect(jevResourcesReady(proof, 1000)).toBe(true);
    for (const change of [
      { host_cpu_busy_ppm: 750001 },
      { db_write_max_ms: 1001 },
      { host_ram_used_bytes: "13000000001" },
      { host_cpu_busy_ppm: undefined },
      { valid_until: new Date(1000).toISOString() },
    ])
      expect(jevResourcesReady({ ...proof, ...change }, 1000)).toBe(false);
  });
});
