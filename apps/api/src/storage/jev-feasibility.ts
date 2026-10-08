import { requireJev } from "@ganso-market/contracts/trading";
import { initialJevManifest } from "./jev-manifest.js";
import {
  BTC_STORAGE_LIMIT_BYTES,
  BTC_STORAGE_STOP_BYTES,
} from "../trading/retention.js";
export const JEV_PLANNING = Object.freeze({
  version: "jev-feasibility-v1",
  profiles: 3,
  accountsPerBatch: 2,
  operationUsdRaw: "8000000",
  generationUsdRaw: "2000000",
  planningCeilingUsdRaw: "80000000",
  model: "jev-1.13.0",
  tariffUrl: "https://docs.typesafe.ai/models",
  tariffConsultedAt: "2026-10-07",
  inputUsdRawPerMillion: "42000",
  outputUsdRawPerMillion: "0",
});
export interface JevCorpusSample {
  schema_version: "jev.corpus-sample.v1";
  origin: "disposable_postgres_fixture";
  calls: number;
  logical_bytes: string;
  allocated_growth_bytes: string;
  request_utf8_bytes: number;
}
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
/** No transport or credential access. Bytes/token proxies are planning assumptions, never billable usage. */
export function estimateJevFeasibility(
  sample: JevCorpusSample,
  baselineLogicalBytes: string,
  baselineAllocatedBytes: string,
) {
  requireJev(
    sample.schema_version === "jev.corpus-sample.v1" &&
      sample.origin === "disposable_postgres_fixture" &&
      Number.isSafeInteger(sample.calls) &&
      sample.calls > 0 &&
      Number.isSafeInteger(sample.request_utf8_bytes) &&
      sample.request_utf8_bytes > 0,
    "FEASIBILITY_SAMPLE",
  );
  for (const b of [
    sample.logical_bytes,
    sample.allocated_growth_bytes,
    baselineLogicalBytes,
    baselineAllocatedBytes,
  ])
    requireJev(/^(0|[1-9][0-9]*)$/.test(b), "FEASIBILITY_BYTES");
  requireJev(
    BigInt(sample.logical_bytes) > 0n &&
      BigInt(sample.allocated_growth_bytes) > 0n,
    "FEASIBILITY_EMPTY_CORPUS",
  );
  const m = initialJevManifest(1),
    seconds = 30n * 86400n,
    profiles = 3n;
  const normal = ((seconds * 1000n) / BigInt(m.cadence.standard_ms)) * profiles;
  const fast = ((seconds * 1000n) / BigInt(m.cadence.fast_ms)) * profiles;
  // Max 30s fast followed by 60s cooldown. Boundary rounding can add calls;
  // this planning duty envelope still requires measured request counts before admission.
  const policyCalls = ceil(
    normal * BigInt(m.cadence.cooldown_ms) +
      fast * BigInt(m.cadence.fast_maximum_ms),
    BigInt(m.cadence.cooldown_ms + m.cadence.fast_maximum_ms),
  );
  const tokens = ceil(BigInt(sample.request_utf8_bytes), 4n),
    sensitivity = BigInt(sample.request_utf8_bytes);
  const price = BigInt(JEV_PLANNING.inputUsdRawPerMillion),
    budget = BigInt(JEV_PLANNING.operationUsdRaw);
  const logical = ceil(BigInt(sample.logical_bytes), BigInt(sample.calls)),
    physical = ceil(
      BigInt(sample.allocated_growth_bytes),
      BigInt(sample.calls),
    );
  const cost = (calls: bigint, t = tokens) => ceil(calls * t * price, 1000000n);
  const scenarios = (
    [
      ["standard_60s", normal],
      ["policy_fast_duty_1_in_3", policyCalls],
      ["continuous_2s_stress_only", fast],
    ] as const
  ).map(([name, calls]) => {
    const calls90 = calls * 3n,
      calls270 = calls * 9n;
    const logical90 = logical * calls90,
      allocated90 = physical * calls90;
    const logical270 = logical * calls270,
      allocated270 = physical * calls270;
    const fits90 =
      BigInt(baselineLogicalBytes) + logical90 < BTC_STORAGE_STOP_BYTES &&
      BigInt(baselineAllocatedBytes) + allocated90 < BTC_STORAGE_STOP_BYTES;
    const fits =
      BigInt(baselineLogicalBytes) + logical270 < BTC_STORAGE_STOP_BYTES &&
      BigInt(baselineAllocatedBytes) + allocated270 < BTC_STORAGE_STOP_BYTES;
    return {
      name,
      monthly_calls: calls.toString(),
      monthly_operation_usd_raw: cost(calls).toString(),
      one_byte_per_token_sensitivity_usd_raw: cost(
        calls,
        sensitivity,
      ).toString(),
      operation_pool_estimate_fits: cost(calls) <= budget,
      cohort_90d_bytes: {
        logical: logical90.toString(),
        allocated: allocated90.toString(),
      },
      cohort_storage_estimate_fits_existing_stop: fits90,
      cohort_with_180d_post_close:
        "same_90d_corpus_kept_until_day_270_without_new_calls",
      sustained_successor_270d_bytes: {
        logical: logical270.toString(),
        allocated: allocated270.toString(),
      },
      storage_estimate_fits_existing_stop: fits,
    };
  });
  const affordableCalls = (budget * 1000000n) / (tokens * price);
  const maxFastFractionPpm =
    affordableCalls <= normal
      ? 0n
      : ((affordableCalls - normal) * 1000000n) / (fast - normal);
  return {
    schema_version: "jev.feasibility.v1",
    planning: JEV_PLANNING,
    sample,
    baseline_logical_bytes: baselineLogicalBytes,
    baseline_allocated_bytes: baselineAllocatedBytes,
    tokens: {
      estimate: tokens.toString(),
      method:
        "ceil_utf8_bytes_divided_by_4_assumption_not_provider_tokenization",
      sensitivity: sensitivity.toString(),
      actual_billable_tokens: null,
    },
    bytes_per_profile_batch: {
      logical: logical.toString(),
      allocated: physical.toString(),
    },
    scenarios,
    max_fast_time_fraction_ppm_at_estimated_tokens: (maxFastFractionPpm >
    1000000n
      ? 1000000n
      : maxFastFractionPpm
    ).toString(),
    max_monthly_calls_by_operation_pool_at_estimated_tokens:
      affordableCalls.toString(),
    max_generation_calls_at_4000_assumed_tokens: (
      (BigInt(JEV_PLANNING.generationUsdRaw) * 1000000n) /
      (4000n * price)
    ).toString(),
    limits: {
      storage_limit_bytes: BTC_STORAGE_LIMIT_BYTES.toString(),
      storage_stop_bytes: BTC_STORAGE_STOP_BYTES.toString(),
      infrastructure_in_strategy_result: false,
    },
    admitted: false,
    paid_calls: 0,
    required_runtime_gates: [
      "collector_recovered_and_fresh_with_no_unmeasured_gaps",
      "credential_model_tariff_and_real_usage_reconciled",
      "three_pairs_plus_holds_fills_funding_queue_and_failures_measured",
      "real_deadline_1500ms_and_ttl_2000ms",
      "sustained_cpu_ram_connections_wal_and_headroom_measured",
      "protected_sources_pins_permanent_results_and_successors_counted",
      "generation_cost_attribution_contract_before_economic_acceptance",
      "GJ12.2_owner_selected_admission",
    ],
  };
}
