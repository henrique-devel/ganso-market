import type { DeskOperation } from "@ganso-market/contracts/trading";
import type { SqlExecutor } from "../database.js";

export class HistoryCursorError extends Error {}

/** All queries run in the caller's bounded REPEATABLE READ, READ ONLY transaction.
 * Indexed owner/order lookups; no replay, repairs, activation or financial writes. */
export async function readOperationTx(
  tx: SqlExecutor,
  account: string,
  order: string,
  view: "events" | "receipts",
  after: string,
  limit: number,
) {
  const head = (
    await tx.query<{
      request: DeskOperation["order"];
      accepted_at: Date;
      execution_input: DeskOperation["execution_input"];
      broker: DeskOperation["broker"];
      evidence_id: string | null;
      reason: string | null;
      triggered_at: Date | null;
    }>(
      `SELECT a.request,a.accepted_at,
    COALESCE(i.intent,p.state->'intent') AS execution_input,
    CASE WHEN i.order_id IS NOT NULL THEN 'ioc' WHEN p.state IS NOT NULL THEN 'passive' END AS broker,
    COALESCE(i.evidence_id,p.evidence_id) AS evidence_id,x.reason,x.triggered_at
    FROM btc_order_acceptances a
    LEFT JOIN btc_ioc_intents i USING(account_id,order_id)
    LEFT JOIN LATERAL(SELECT state,evidence_id FROM btc_passive_events
      WHERE account_id=a.account_id AND order_id=a.order_id ORDER BY sequence LIMIT 1) p ON true
    LEFT JOIN btc_desk_exits x ON x.account_id=a.account_id AND x.position_id=a.request->>'position_id'
    WHERE a.account_id=$1 AND a.order_id=$2`,
      [account, order],
    )
  ).rows[0];
  if (!head) return null;
  if (head.broker === "passive" && after && !/^[1-9][0-9]{0,17}$/.test(after))
    throw new HistoryCursorError();
  const events =
    view === "events"
      ? (
          await tx.query<DeskOperation["events"][number]>(
            `SELECT e.sequence::text,e.operation_id,e.action,e.request->>'reason' AS reason,
    to_char(e.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at,
    e.reservation->>'status' AS status,e.reservation->>'remaining_btc_raw' AS remaining_btc_raw,
    COALESCE((SELECT jsonb_agg(l.event ORDER BY l.sequence) FROM btc_ledger_events l
      WHERE l.account_id=e.account_id AND l.transaction_id=e.ledger_transaction_id),'[]'::jsonb) AS ledger
    FROM btc_reservation_events e WHERE e.account_id=$1 AND e.order_id=$2 AND e.sequence > $3::bigint
    ORDER BY e.sequence LIMIT $4`,
            [account, order, after || "0", limit + 1],
          )
        ).rows
      : [];
  const receipts =
    view !== "receipts" || !head.broker
      ? []
      : head.broker === "ioc"
        ? (
            await tx.query<DeskOperation["receipts"][number]>(
              `SELECT r.operation_id AS cursor,r.operation_id,
      r.result->>'reason' AS reason,r.evidence_id,
      to_char(o.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at,
      r.result->>'book_key' AS book_key FROM btc_ioc_results r JOIN btc_retention_objects o ON o.object_id=r.evidence_id
      WHERE r.account_id=$1 AND r.order_id=$2 AND r.operation_id > $3 ORDER BY r.operation_id LIMIT $4`,
              [account, order, after, limit + 1],
            )
          ).rows
        : (
            await tx.query<DeskOperation["receipts"][number]>(
              `SELECT e.sequence::text AS cursor,e.operation_id,
      r.result->>'reason' AS reason,e.evidence_id,
      to_char(o.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at,NULL::text AS book_key
      FROM btc_passive_events e JOIN btc_passive_results r USING(account_id,operation_id)
      JOIN btc_retention_objects o ON o.object_id=e.evidence_id
      WHERE e.account_id=$1 AND e.order_id=$2 AND e.sequence > $3::bigint ORDER BY e.sequence LIMIT $4`,
              [account, order, after || "0", limit + 1],
            )
          ).rows;
  return {
    order: head.request,
    accepted_at: head.accepted_at.toISOString(),
    broker: head.broker,
    execution_input: head.execution_input,
    decision_evidence_id: head.evidence_id,
    protective_exit:
      head.reason && head.triggered_at
        ? { reason: head.reason, triggered_at: head.triggered_at.toISOString() }
        : null,
    events: events.slice(0, limit),
    receipts: receipts.slice(0, limit),
    after:
      events.length > limit
        ? events[limit - 1]!.sequence
        : receipts.length > limit
          ? receipts[limit - 1]!.cursor
          : null,
  };
}
