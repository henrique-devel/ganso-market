import type { DatabasePool } from "../database.js";
import { withBtcRetentionTransaction } from "./btc-retention.js";
import { jevRiskClock, cancelJevEntriesTx } from "./jev-riskstore.js";
import { JevPanelCommandError } from "./jev-infrastructure.js";
import { jevHash } from "./jev-hash.js";
export function validateJevOperator(input: unknown, key: unknown) {
  const b = input as { action?: unknown; account_id?: unknown } | null;
  if (
    !b ||
    Array.isArray(b) ||
    Object.keys(b).sort().join() !== "account_id,action" ||
    !["pause", "emergency"].includes(String(b.action)) ||
    typeof b.account_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(b.account_id) ||
    typeof key !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(key)
  )
    throw new JevPanelCommandError(400, "JEV_PANEL_INVALID_COMMAND");
  return {
    action: b.action as "pause" | "emergency",
    account_id: b.account_id,
  };
}
/** Immediate admission latch under the same account lock as fills/JEV completion.
 * Cancellation/reduction is performed exclusively by the fenced protection worker.
 * No ACK, close or financial state is fabricated here. */
export async function commandJevOperator(
  pool: Pick<DatabasePool, "transaction">,
  owner: string,
  input: unknown,
  key: string,
) {
  const request = validateJevOperator(input, key);
  return withBtcRetentionTransaction(pool, async (tx) => {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,741060))",
      [owner],
    );
    const old = (
      await tx.query<{ request: unknown; account_ids: string[] }>(
        "SELECT request,account_ids FROM jev_operator_commands WHERE owner_id=$1 AND idempotency_key=$2",
        [owner, key],
      )
    ).rows[0];
    if (old) {
      if (jevHash(old.request) !== jevHash(request))
        throw new JevPanelCommandError(409, "JEV_PANEL_IDEMPOTENCY_COLLISION");
      return {
        status: "duplicate",
        action: request.action,
        account_ids: old.account_ids,
        execution: "pending_reconciliation",
      };
    }
    const rows = (
      await tx.query<{ account_id: string }>(
        `SELECT a.account_id FROM jev_accounts a JOIN jev_worker_controls c USING(account_id) WHERE a.owner_id=$1 AND a.mode IN('paper','stress') AND c.admitted AND ($2='all' OR a.account_id=$2) ORDER BY a.account_id LIMIT 7 FOR UPDATE OF a,c`,
        [owner, request.account_id],
      )
    ).rows;
    if (!rows.length || rows.length > 6)
      throw new JevPanelCommandError(409, "JEV_PANEL_ACCOUNT_NOT_ADMITTED");
    const ids = rows.map((r) => r.account_id);
    for (const id of ids) {
      await tx.query(
        "UPDATE jev_worker_controls SET entries_paused=true,operator_close_requested=operator_close_requested OR $2 WHERE account_id=$1",
        [id, request.action === "emergency"],
      );
      await cancelJevEntriesTx(tx, id);
    }
    await tx.query(
      "INSERT INTO jev_operator_commands(owner_id,idempotency_key,action,request,account_ids,recorded_at) VALUES($1,$2,$3,$4::jsonb,$5,$6)",
      [
        owner,
        key,
        request.action,
        JSON.stringify(request),
        ids,
        await jevRiskClock(tx),
      ],
    );
    return {
      status: "accepted",
      action: request.action,
      account_ids: ids,
      execution: "pending_reconciliation",
    };
  });
}
