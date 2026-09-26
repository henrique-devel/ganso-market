import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database.js";
import type { JevResult, JevReason } from "../models/jev-contract.js";

export interface JevReservation {
  token: string;
  result: JevResult;
}
export interface JevStore {
  reserve(
    result: JevResult,
    fingerprint: string,
    tariffHash: string,
  ): Promise<JevReservation | JevReason>;
  finish(
    reservation: JevReservation,
    result: JevResult,
    billingUnknown: boolean,
  ): Promise<JevResult>;
}
/** Fixed provider-wide pools shared by all processes/accounts/models. No trading
 * ledger, retention lock or recovery fence is changed by this independent cost
 * owner. Network I/O is never accepted as a transaction callback. */
export function createJevStore(
  pool: Pick<DatabasePool, "transaction">,
): JevStore {
  return {
    reserve: (draft, fingerprint, tariffHash) =>
      pool.transaction(async (tx) => {
        const b = (
          await tx.query<{
            enabled: boolean;
            month: string;
            limit_usd6: string;
            committed_usd6: string;
            tariff_hash: string;
            circuit_open: boolean;
          }>("SELECT * FROM btc_jev_budgets WHERE origin=$1 FOR UPDATE", [
            draft.origin,
          ])
        ).rows[0];
        if (!b || !b.enabled) return "budget_unavailable";
        const now = (
          await tx.query<{ now: Date }>("SELECT clock_timestamp() now")
        ).rows[0]!.now;
        const at = now.getTime(),
          deadline = Date.parse(draft.deadline_at);
        // Crash/restart cannot free an uncertain charge or retransmit an attempt.
        const expired = await tx.query(
          `UPDATE btc_jev_calls SET result=jsonb_set(jsonb_set(result,'{reason}','"recovered_uncertain"'),'{duration_ms}',to_jsonb(GREATEST(0,extract(epoch FROM (clock_timestamp()-started_at))*1000))),
        finished_at=clock_timestamp() WHERE origin=$1 AND finished_at IS NULL AND deadline_at<=clock_timestamp()`,
          [draft.origin],
        );
        if (expired.rowCount > 0) {
          await tx.query(
            "UPDATE btc_jev_budgets SET circuit_open=true WHERE origin=$1",
            [draft.origin],
          );
          return "circuit_open";
        }
        // No reservation straddles a UTC billing month; no implicit monthly top-up.
        if (
          b.month !== now.toISOString().slice(0, 7) ||
          draft.deadline_at.slice(0, 7) !== b.month ||
          deadline <= at ||
          deadline > at + 30_000
        )
          return "timeout";
        const prior = (
          await tx.query<{ fingerprint: string }>(
            "SELECT fingerprint FROM btc_jev_calls WHERE origin=$1 AND request_id=$2",
            [draft.origin, draft.request_id],
          )
        ).rows[0];
        if (prior)
          return prior.fingerprint === fingerprint
            ? "duplicate"
            : "idempotency_conflict";
        if (b.circuit_open) return "circuit_open";
        if (b.tariff_hash !== tariffHash) return "cost_unknown";
        const amount = BigInt(draft.reserved_usd6);
        if (
          amount <= 0n ||
          BigInt(b.committed_usd6) + amount > BigInt(b.limit_usd6)
        )
          return "budget_exhausted";
        const token = randomUUID();
        const result = {
          ...draft,
          attempted: true,
          started_at: now.toISOString(),
          reason: "recovered_uncertain" as const,
        };
        await tx.query(
          "UPDATE btc_jev_budgets SET committed_usd6=committed_usd6+$2 WHERE origin=$1",
          [draft.origin, amount.toString()],
        );
        await tx.query(
          `INSERT INTO btc_jev_calls(origin,request_id,fingerprint,token,month,started_at,deadline_at,reserved_usd6,result)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [
            draft.origin,
            draft.request_id,
            fingerprint,
            token,
            b.month,
            now,
            draft.deadline_at,
            amount.toString(),
            JSON.stringify(result),
          ],
        );
        return { token, result };
      }),
    finish: (reservation, proposed, billingUnknown) =>
      pool.transaction(async (tx) => {
        const original = reservation.result;
        await tx.query(
          "SELECT origin FROM btc_jev_budgets WHERE origin=$1 FOR UPDATE",
          [original.origin],
        );
        const row = (
          await tx.query<{
            result: JevResult;
            finished_at: Date | null;
            now: Date;
          }>(
            "SELECT result,finished_at,clock_timestamp() now FROM btc_jev_calls WHERE origin=$1 AND request_id=$2 AND token=$3 FOR UPDATE",
            [original.origin, original.request_id, reservation.token],
          )
        ).rows[0];
        if (!row) throw new Error("JEV_FENCE_LOST");
        if (row.finished_at) return row.result;
        const late = row.now.getTime() >= Date.parse(original.deadline_at);
        const result: JevResult = late
          ? {
              ...proposed,
              decision: "abstain",
              reason: "timeout",
              answer: null,
              usage: null,
              cost_usd6: null,
            }
          : proposed;
        const cost =
          result.cost_usd6 === null
            ? BigInt(original.reserved_usd6)
            : BigInt(result.cost_usd6);
        if (cost < 0n || cost > BigInt(original.reserved_usd6))
          throw new Error("JEV_COST_BOUND");
        // The original month must still own this charge: rollover with pending
        // attempts is prohibited by the database guard as well.
        const updated = await tx.query(
          `UPDATE btc_jev_budgets SET
        committed_usd6=committed_usd6-($2::numeric-$3::numeric),
        failures=failures+$4, circuit_open=circuit_open OR $5 OR failures+$4>=3
        WHERE origin=$1 AND month=$6`,
          [
            original.origin,
            original.reserved_usd6,
            cost.toString(),
            result.reason === "ok" ? 0 : 1,
            billingUnknown,
            original.started_at.slice(0, 7),
          ],
        );
        if (updated.rowCount !== 1) throw new Error("JEV_BUDGET_OWNER_LOST");
        await tx.query(
          "UPDATE btc_jev_calls SET result=$4::jsonb,finished_at=clock_timestamp() WHERE origin=$1 AND request_id=$2 AND token=$3",
          [
            original.origin,
            original.request_id,
            reservation.token,
            JSON.stringify(result),
          ],
        );
        return result;
      }),
  };
}
