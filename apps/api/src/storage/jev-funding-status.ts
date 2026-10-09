import type { SqlExecutor } from "../database.js";
import type { JevLedgerEvent } from "@ganso-market/contracts/trading";
import { fundingCoverage, type FundingReceipt } from "../trading/funding.js";
/** Preserve explicit pre-JE10 reconciliations. Once this journal exists, a
 * missing later hour, pending observation or permanent conflict cannot be
 * hidden by a flat projection or an older reconciliation attestation. */
export async function jevFundingEvidenceReadyTx(
  tx: SqlExecutor,
  id: string,
  events: readonly JevLedgerEvent[],
  at: string,
) {
  const receipts = (
    await tx.query<{ receipt: FundingReceipt }>(
      "SELECT receipt FROM jev_funding_receipts WHERE account_id=$1 AND recorded_at<=$2 ORDER BY sequence",
      [id, at],
    )
  ).rows.map((r) => r.receipt);
  if (!receipts.length) return true;
  const fills = events.flatMap((e) =>
    e.payload.event_type === "fill"
      ? [{ occurred_at: e.occurred_at, payload: e.payload }]
      : [],
  );
  return fundingCoverage(fills, receipts, at).usable_for_risk;
}
