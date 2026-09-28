import {
  baselineHash,
  baselineTime,
  type BaselinePeriod,
  type BaselineRegistration,
} from "./baseline-inputs.js";
import {
  BASELINE_PERIOD_MS,
  validateBaselinePeriod,
} from "./baseline-periods.js";

export interface ComparisonWindowRequest {
  start_at: string;
  end_at: string;
  purpose: "operational_pilot" | "economic_evaluation";
}
export interface ComparisonWindow extends ComparisonWindowRequest {
  version: "btc.comparison-window.v1";
  registered_at: string;
  source_evidence_id: string;
  source_period: BaselinePeriod | null;
  source_period_evidence_id: string;
  source_registration_hash: string;
  source_code_sha: string;
  challenger_code_sha: string;
  source_manifest: string;
  challenger_manifest: string;
  source_policy: string;
  challenger_policy: string;
}
/** A full evaluation needs thirty days of source entry eligibility. A shorter
 * remainder is explicitly a pilot. Neither changes either financial genesis. */
export function validateComparisonWindow(
  w: ComparisonWindow,
  r: BaselineRegistration,
) {
  const start = baselineTime(w.start_at),
    end = baselineTime(w.end_at);
  if (w.source_period) validateBaselinePeriod(w.source_period, r);
  const sourceStart = w.source_period?.start_at ?? r.start_at;
  const sourceEnd =
    w.source_period?.end_at ??
    new Date(baselineTime(r.start_at) + BASELINE_PERIOD_MS).toISOString();
  if (
    w.version !== "btc.comparison-window.v1" ||
    !["operational_pilot", "economic_evaluation"].includes(w.purpose) ||
    start % 900000 !== 0 ||
    end % 900000 !== 0 ||
    baselineTime(w.registered_at) >= start ||
    end <= start ||
    end - start > BASELINE_PERIOD_MS ||
    w.start_at < sourceStart ||
    w.end_at > sourceEnd ||
    (w.purpose === "economic_evaluation" &&
      (end - start !== BASELINE_PERIOD_MS ||
        (w.source_period &&
          w.source_period.purpose !== "economic_evaluation"))) ||
    (w.source_period && w.source_period.registered_at > w.registered_at) ||
    w.source_registration_hash !== baselineHash(r) ||
    w.source_code_sha !== r.code_sha ||
    w.source_manifest !== r.manifest_fingerprint ||
    w.source_policy !== r.policy_version ||
    !/^[a-f0-9]{40}$/.test(w.challenger_code_sha) ||
    !w.source_evidence_id ||
    !w.source_period_evidence_id
  )
    throw new Error("BTC_METRICS_COMPARISON_PROSPECTIVE_WINDOW");
}
