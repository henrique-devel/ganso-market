import { money, utc, requireMetric } from "../trading/metrics.js";

/** Separate from the historical conserving CostAllocation contract. USD6. */
export const JEV_COST_POLICY = Object.freeze({
  version: "jev.evaluation-costs.v1",
  operation: "whole_request_per_participating_account_do_not_sum",
  generation:
    "whole_request_per_linked_profile_version_per_alternative_account",
  unresolved: "unlinked_generation_blocks_owner_economic_result",
  infrastructure: "manual_platform_card_excluded_from_strategy_and_risk",
});
export interface JevCostRequest {
  request_id: string;
  purpose: "operation" | "generation_validation";
  started_at: string;
  cost_usd6: string | null;
  proposal_id: string | null;
  participants: {
    owner_id: string;
    account_id: string;
    profile_id: string;
    profile_version: string;
  }[];
}
export interface JevCostScope {
  owner_id: string;
  account_id: string;
  profile_id: string;
  profile_version: string;
}
/** Source must be the complete selected journal, including unfinished/failed
 * requests. A reservation is a bound, never an actual bill. Mock and real
 * journals are selected independently by the adapter. */
export function jevCosts(
  requests: readonly JevCostRequest[],
  scope: JevCostScope,
  window: { start_at: string; end_at: string },
  infrastructure_usd6: string | null = null,
) {
  requireMetric(utc(window.start_at) <= utc(window.end_at), "JEV_COST_WINDOW");
  if (infrastructure_usd6 !== null)
    requireMetric(money(infrastructure_usd6) >= 0n, "JEV_INFRA");
  const seen = new Set<string>();
  let global = 0n,
    attributed = 0n,
    unknown = 0,
    accountUnknown = 0,
    unresolved = 0;
  const ids: string[] = [];
  for (const r of requests) {
    requireMetric(
      !seen.has(r.request_id) &&
        r.request_id.length > 0 &&
        ["operation", "generation_validation"].includes(r.purpose),
      "JEV_COST_REQUEST",
    );
    seen.add(r.request_id);
    utc(r.started_at);
    requireMetric(
      r.participants.length > 0 &&
        r.participants.length <= 3 &&
        new Set(r.participants.map((p) => p.account_id)).size ===
          r.participants.length &&
        r.participants.every((p) => p.owner_id === scope.owner_id),
      "JEV_COST_OWNER",
    );
    if (r.cost_usd6 !== null)
      requireMetric(money(r.cost_usd6) >= 0n, "JEV_COST_AMOUNT");
    if (r.started_at < window.start_at || r.started_at >= window.end_at)
      continue;
    if (r.cost_usd6 === null) unknown++;
    else global += money(r.cost_usd6);
    const linked =
      r.purpose === "operation"
        ? r.participants.some((p) => p.account_id === scope.account_id)
        : r.proposal_id !== null &&
          r.participants.some(
            (p) =>
              p.profile_id === scope.profile_id &&
              p.profile_version === scope.profile_version,
          );
    if (r.purpose === "generation_validation" && r.proposal_id === null)
      unresolved++;
    if (linked) {
      ids.push(r.request_id);
      if (r.cost_usd6 === null) accountUnknown++;
      else attributed += money(r.cost_usd6);
    }
  }
  return {
    schema_version: JEV_COST_POLICY.version,
    scope: { ...scope },
    window,
    convention: JEV_COST_POLICY,
    platform: {
      known_jev_usd6: global.toString(),
      unknown_requests: unknown,
      jev_usd6: unknown ? null : global.toString(),
      infrastructure_usd6,
      total_usd6:
        unknown || infrastructure_usd6 === null
          ? null
          : (global + money(infrastructure_usd6)).toString(),
    },
    evaluation: {
      known_jev_usd6: attributed.toString(),
      unknown_requests: accountUnknown,
      unresolved_generation_requests: unresolved,
      jev_usd6: accountUnknown || unresolved ? null : attributed.toString(),
      request_ids: ids.sort(),
      summable_as_platform_bill: false,
    },
  };
}
