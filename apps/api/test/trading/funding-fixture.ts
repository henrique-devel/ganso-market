import type { FundingCommand } from "../../src/storage/fundingstore.js";
import { FUNDING_SOURCE } from "../../src/venues/hyperliquid/funding.js";
import { iso, start } from "./ledger-fixture.js";
export const hour = Math.ceil((start + 3600000) / 3600000) * 3600000;
// Deliberately non-aligned: preserve fundingHistory.time, not a guessed hour.
export const cut = hour + 76;
export function observation(
  rate = "0.0001",
  at = cut,
): NonNullable<FundingCommand["observation"]> {
  return {
    source: FUNDING_SOURCE,
    received_at: iso(at + 9000),
    row: { coin: "BTC", time: at, fundingRate: rate, premium: "0.0002" },
  };
}
export function request(id = "fund", rate = "0.0001"): FundingCommand {
  return {
    operation_id: id,
    period_hour: iso(hour),
    observation: observation(rate),
    oracle_object_id: "funding-oracle",
  };
}
