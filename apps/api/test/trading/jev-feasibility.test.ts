import { describe, expect, it } from "vitest";
import {
  estimateJevFeasibility,
  JEV_PLANNING,
  type JevCorpusSample,
} from "../../src/storage/jev-feasibility.js";
const sample: JevCorpusSample = {
  schema_version: "jev.corpus-sample.v1",
  origin: "disposable_postgres_fixture",
  calls: 100,
  logical_bytes: "1000000",
  allocated_growth_bytes: "2000000",
  request_utf8_bytes: 4000,
};
describe("reproducible JEV planning without paid calls", () => {
  it("reproduces independent fixed-point 60s/2s cost and 90d/270d storage", () => {
    const r = estimateJevFeasibility(sample, "0", "0");
    expect(r.scenarios[0]!.monthly_calls).toBe("129600");
    expect(r.scenarios[0]!.monthly_operation_usd_raw).toBe("5443200");
    expect(r.scenarios[2]!.monthly_calls).toBe("3888000");
    expect(r.scenarios[2]!.monthly_operation_usd_raw).toBe("163296000");
    expect(r.scenarios[0]!.cohort_90d_bytes.logical).toBe("3888000000");
    expect(r.scenarios[0]!.sustained_successor_270d_bytes.logical).toBe(
      "11664000000",
    );
    expect(r.scenarios[1]!.monthly_calls).toBe("1382400");
    expect(r.max_fast_time_fraction_ppm_at_estimated_tokens).toBe("16197");
    expect(r.admitted).toBe(false);
    expect(r.paid_calls).toBe(0);
  });
  it("keeps generation separate and never treats unknown cost as zero", () => {
    const r = estimateJevFeasibility(
      { ...sample, request_utf8_bytes: 16000 },
      "150000000000",
      "150000000000",
    );
    expect(r.scenarios[0]!.operation_pool_estimate_fits).toBe(false);
    expect(r.max_fast_time_fraction_ppm_at_estimated_tokens).toBe("0");
    expect(r.scenarios[0]!.storage_estimate_fits_existing_stop).toBe(false);
    expect(r.tokens.actual_billable_tokens).toBeNull();
    expect(JEV_PLANNING.operationUsdRaw).toBe("8000000");
    expect(JEV_PLANNING.generationUsdRaw).toBe("2000000");
    expect(r.limits.infrastructure_in_strategy_result).toBe(false);
  });
  it("rejects missing samples, negative bytes, fractional calls and empty corpus", () => {
    for (const s of [
      { ...sample, calls: 0 },
      { ...sample, calls: 1.5 },
      { ...sample, logical_bytes: "-1" },
      { ...sample, allocated_growth_bytes: "0" },
    ])
      expect(() => estimateJevFeasibility(s, "0", "0")).toThrow("FEASIBILITY");
  });
});
