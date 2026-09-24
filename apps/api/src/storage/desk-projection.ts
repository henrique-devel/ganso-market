import type { LedgerEvent } from "./ledger-contract.js";
import type { LedgerProjection } from "../trading/ledger.js";
import { projectFinancials } from "../trading/valuation.js";
import { projectMarginBasis } from "../trading/margin.js";

/** Derived during a committed append or audited recovery, never by a GET. */
export function buildDeskProjection(
  ledger: LedgerProjection,
  events: readonly LedgerEvent[],
) {
  return {
    schema_version: "btc.desk-projection.v1" as const,
    finance: projectFinancials(ledger, events),
    margin_basis: projectMarginBasis(events),
    recorded_at: events.reduce(
      (at, e) => (e.recorded_at > at ? e.recorded_at : at),
      "",
    ),
    occurred_at: events.reduce(
      (at, e) => (e.occurred_at > at ? e.occurred_at : at),
      "",
    ),
  };
}
export type DeskProjection = ReturnType<typeof buildDeskProjection>;
