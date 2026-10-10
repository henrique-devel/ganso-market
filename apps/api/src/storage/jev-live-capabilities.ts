/** Code capabilities, never operator flags. Later deliveries must implement and
 * verify their contracts before changing these values. Protection is independent. */
export const JEV_LIVE_CAPABILITIES = Object.freeze({
  runtime: true,
  interventions: false,
  financial_panel: false,
});
export function jevLiveIntegrationReady() {
  return Object.values(JEV_LIVE_CAPABILITIES).every(Boolean);
}
import type { SqlExecutor } from "../database.js";
export async function jevLiveRuntimeEntriesTx(
  tx: SqlExecutor,
  identity: string,
  account: string,
) {
  const runtime = (
    await tx.query(
      `SELECT 1 FROM jev_live_runtime r JOIN execution_worker_head h USING(generation)
    WHERE r.identity_hash=$1 AND h.lease_until>clock_timestamp() AND r.observed_at<=clock_timestamp()
    AND r.observed_at>clock_timestamp()-interval '1500 milliseconds' AND r.state->>'entries_ready'='true'
    AND r.state->>'connected'='true'`,
      [identity],
    )
  ).rowCount;
  const control = (
    await tx.query(
      "SELECT 1 FROM jev_worker_controls WHERE account_id=$1 AND admitted AND NOT entries_paused",
      [account],
    )
  ).rowCount;
  return !!runtime && !!control;
}
