import { randomUUID } from "node:crypto";
import { requireJev, type JevScope } from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import { type JevTariff, quote } from "../models/jev-contract.js";
import {
  JEV_DECISION_VERSION,
  validateJevBatch,
  refusedDecisions,
  type JevBatch,
  type JevBatchResult,
  type JevFailure,
  type JevPurpose,
} from "../models/jev-decision-contract.js";
import {
  deriveJevResult,
  replayJevDecision,
} from "../models/jev-decision-replay.js";
import { withBtcRetentionTransaction } from "./btc-retention.js";
import { jevHash } from "./jev-hash.js";
type Pool = Pick<DatabasePool, "transaction">;
type Origin = "real" | "mock";
export interface JevDecisionReservation {
  token: string;
  result: JevBatchResult;
}
export interface JevDecisionStore {
  reserve(
    batch: JevBatch,
    origin: Origin,
    tariff: JevTariff | null,
    refusal?: JevFailure,
  ): Promise<JevDecisionReservation | JevBatchResult>;
  finish(
    reservation: JevDecisionReservation,
    result: JevBatchResult,
  ): Promise<JevBatchResult>;
}
/** Explicit external provisioning attestation; never called by API boot/migrations. */
export async function provisionJevCostPool(
  pool: Pool,
  input: {
    origin: Origin;
    purpose: JevPurpose;
    month: string;
    tariff: JevTariff;
    provision_reference: string;
    billing_bound_reference: string;
    enabled: boolean;
  },
) {
  const i = structuredClone(input);
  requireJev(
    /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(i.month) &&
      quote(i.tariff, i.tariff.model, new Date().toISOString()) &&
      [i.provision_reference, i.billing_bound_reference].every((v) =>
        /^[A-Za-z0-9._:/-]{1,200}$/.test(v),
      ),
    "POOL_ATTESTATION",
  );
  return withBtcRetentionTransaction(pool, async (tx) => {
    await tx.query(
      `INSERT INTO jev_cost_pools(origin,purpose,month,limit_usd6,tariff_hash,enabled,provision_reference,billing_bound_reference)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [
        i.origin,
        i.purpose,
        i.month,
        i.purpose === "operation" ? "8000000" : "2000000",
        jevHash(i.tariff),
        i.enabled,
        i.provision_reference,
        i.billing_bound_reference,
      ],
    );
    const row = (
      await tx.query(
        "SELECT * FROM jev_cost_pools WHERE origin=$1 AND purpose=$2 AND month=$3",
        [i.origin, i.purpose, i.month],
      )
    ).rows[0]!;
    requireJev(
      row.tariff_hash === jevHash(i.tariff) &&
        row.provision_reference === i.provision_reference &&
        row.billing_bound_reference === i.billing_bound_reference &&
        row.enabled === i.enabled,
      "POOL_PROVISION_COLLISION",
    );
  });
}
function base(
  batch: JevBatch,
  origin: Origin,
  now: string,
  tariff: JevTariff | null,
  amount: string,
): JevBatchResult {
  return {
    schema_version: JEV_DECISION_VERSION,
    origin,
    batch,
    batch_hash: jevHash(batch),
    reason: "recovered_uncertain",
    attempted: amount !== "0",
    started_at: now,
    finished_at: now,
    response_received_at: null,
    http_status: null,
    original_response: null,
    response_hash: null,
    tariff,
    reserved_usd6: amount,
    cost_usd6: amount === "0" ? "0" : null,
    usage: null,
    decisions: refusedDecisions(
      batch,
      "recovered_uncertain",
      amount === "0" ? "0" : null,
    ),
  };
}
async function insertResult(tx: SqlExecutor, result: JevBatchResult) {
  await tx.query(
    "INSERT INTO jev_decision_results(origin,request_id,finished_at,cost_usd6,result) VALUES($1,$2,$3,$4,$5::jsonb)",
    [
      result.origin,
      result.batch.request_id,
      result.finished_at,
      result.cost_usd6,
      JSON.stringify(result),
    ],
  );
}
export function createJevDecisionStore(pool: Pool): JevDecisionStore {
  return {
    async reserve(input, origin, inputTariff, refusal) {
      const batch = structuredClone(input),
        tariff = inputTariff ? structuredClone(inputTariff) : null;
      validateJevBatch(batch);
      const fingerprint = jevHash({ batch, origin, tariff });
      return withBtcRetentionTransaction(pool, async (tx) => {
        // Global retention lock precedes pool/row locks, including explicit refusal journals.
        const prior = (
          await tx.query<{
            fingerprint: string;
            result: JevBatchResult | null;
          }>(
            "SELECT r.fingerprint,s.result FROM jev_decision_requests r LEFT JOIN jev_decision_results s USING(origin,request_id) WHERE r.origin=$1 AND r.request_id=$2",
            [origin, batch.request_id],
          )
        ).rows[0];
        const now = (
          await tx.query<{ now: Date }>("SELECT clock_timestamp() now")
        ).rows[0]!.now.toISOString();
        const month = now.slice(0, 7);
        const budget = (
          await tx.query<{
            enabled: boolean;
            circuit_open: boolean;
            tariff_hash: string;
            limit_usd6: string;
          }>(
            "SELECT * FROM jev_cost_pools WHERE origin=$1 AND purpose=$2 AND month=$3 FOR UPDATE",
            [origin, batch.purpose, month],
          )
        ).rows[0];
        // Recover crashed attempts, preserving the entire unknown charge. Never resend.
        const pending = (
          await tx.query<{
            batch: JevBatch;
            tariff: JevTariff;
            reserved_usd6: string;
            started_at: Date;
          }>(
            `SELECT r.batch,r.tariff,r.reserved_usd6::text,r.started_at FROM jev_decision_requests r LEFT JOIN jev_decision_results s USING(origin,request_id)
          WHERE r.origin=$1 AND r.purpose=$2 AND r.reserved_usd6>0 AND s.request_id IS NULL AND r.deadline_at<=clock_timestamp()`,
            [origin, batch.purpose],
          )
        ).rows;
        for (const old of pending) {
          const r = base(
            old.batch,
            origin,
            old.started_at.toISOString(),
            old.tariff,
            old.reserved_usd6,
          );
          r.finished_at = now;
          await insertResult(tx, r);
        }
        if (pending.length)
          await tx.query(
            "UPDATE jev_cost_pools SET circuit_open=true WHERE origin=$1 AND purpose=$2",
            [origin, batch.purpose],
          );
        if (prior) {
          const r = base(batch, origin, now, tariff, "0");
          r.reason =
            prior.fingerprint === fingerprint
              ? "duplicate"
              : "idempotency_conflict";
          r.decisions = refusedDecisions(batch, r.reason, "0");
          return r;
        }
        const profile = batch.participants[0]!.context.scope;
        const pinned = (
          await tx.query<{ model: string; questions_version: string }>(
            "SELECT model,questions_version FROM jev_decision_profile_contracts WHERE origin=$1 AND owner_id=$2 AND profile_id=$3 AND profile_version=$4",
            [
              origin,
              profile.owner_id,
              profile.profile_id,
              profile.profile_version,
            ],
          )
        ).rows[0];
        let reason = refusal;
        if (
          !reason &&
          pinned &&
          (pinned.model !== batch.model ||
            pinned.questions_version !== batch.questions_version)
        )
          reason = "binding_error";
        let reserved = tariff
          ? quote(tariff, batch.model, batch.deadline_at)
          : null;
        if (
          !reason &&
          (Date.parse(now) >= Date.parse(batch.deadline_at) ||
            month !== batch.deadline_at.slice(0, 7))
        )
          reason = "timeout";
        if (!reason && (!reserved || !tariff)) reason = "cost_unknown";
        if (!reason && (!budget || !budget.enabled))
          reason = "budget_unavailable";
        if (!reason && (budget!.circuit_open || pending.length))
          reason = "circuit_open";
        const inflight = (
          await tx.query<{ n: number }>(
            `SELECT count(*)::int n FROM jev_decision_requests r LEFT JOIN jev_decision_results s USING(origin,request_id) WHERE r.origin=$1 AND r.reserved_usd6>0 AND s.request_id IS NULL`,
            [origin],
          )
        ).rows[0]!.n;
        if (!reason && inflight >= 3) reason = "concurrency_limit";
        if (!reason && budget!.tariff_hash !== jevHash(tariff))
          reason = "cost_unknown";
        const used = (
          await tx.query<{ used: string }>(
            `SELECT COALESCE(sum(COALESCE(s.cost_usd6,r.reserved_usd6)),0)::text used FROM jev_decision_requests r LEFT JOIN jev_decision_results s USING(origin,request_id) WHERE r.origin=$1 AND r.purpose=$2 AND r.pool_month=$3`,
            [origin, batch.purpose, month],
          )
        ).rows[0]!.used;
        if (
          !reason &&
          BigInt(used) + BigInt(reserved!) > BigInt(budget!.limit_usd6)
        )
          reason = "budget_exhausted";
        if (!reason && !pinned)
          await tx.query(
            "INSERT INTO jev_decision_profile_contracts(origin,owner_id,profile_id,profile_version,model,questions_version) VALUES($1,$2,$3,$4,$5,$6)",
            [
              origin,
              profile.owner_id,
              profile.profile_id,
              profile.profile_version,
              batch.model,
              batch.questions_version,
            ],
          );
        if (reason) reserved = "0";
        const result = base(batch, origin, now, tariff, reserved!);
        const token = randomUUID();
        await tx.query(
          `INSERT INTO jev_decision_requests(origin,request_id,purpose,pool_month,token,fingerprint,batch_hash,batch,tariff,reserved_usd6,started_at,deadline_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)`,
          [
            origin,
            batch.request_id,
            batch.purpose,
            reason ? null : month,
            token,
            fingerprint,
            result.batch_hash,
            JSON.stringify(batch),
            JSON.stringify(tariff),
            reserved,
            now,
            batch.deadline_at,
          ],
        );
        for (const p of batch.participants) {
          const s = p.context.scope;
          await tx.query(
            `INSERT INTO jev_decision_participants(origin,request_id,account_id,owner_id,mode,profile_id,profile_version,experiment_id,context_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              origin,
              batch.request_id,
              s.account_id,
              s.owner_id,
              s.mode,
              s.profile_id,
              s.profile_version,
              s.experiment_id,
              p.context_id,
            ],
          );
        }
        if (reason) {
          result.reason = reason;
          result.decisions = refusedDecisions(batch, reason, "0");
          await insertResult(tx, result);
          return result;
        }
        return { token, result };
      });
    },
    async finish(reservation, input) {
      const proposed = structuredClone(input),
        original = reservation.result;
      requireJev(
        jevHash(proposed.batch) === original.batch_hash &&
          proposed.origin === original.origin &&
          jevHash(proposed.tariff) === jevHash(original.tariff) &&
          proposed.reserved_usd6 === original.reserved_usd6,
        "RESULT_OWNER",
      );
      return withBtcRetentionTransaction(pool, async (tx) => {
        const row = (
          await tx.query<{ batch_hash: string; started_at: Date }>(
            "SELECT batch_hash,started_at FROM jev_decision_requests WHERE origin=$1 AND request_id=$2 AND token=$3 FOR UPDATE",
            [original.origin, original.batch.request_id, reservation.token],
          )
        ).rows[0];
        requireJev(
          row && row.batch_hash === original.batch_hash,
          "RESULT_FENCE",
        );
        const old = (
          await tx.query<{ result: JevBatchResult }>(
            "SELECT result FROM jev_decision_results WHERE origin=$1 AND request_id=$2",
            [original.origin, original.batch.request_id],
          )
        ).rows[0];
        if (old) return replayJevDecision(old.result);
        proposed.started_at = row.started_at.toISOString();
        proposed.finished_at = (
          await tx.query<{ now: Date }>("SELECT clock_timestamp() now")
        ).rows[0]!.now.toISOString();
        if (
          Date.parse(proposed.finished_at) >=
          Date.parse(original.batch.deadline_at)
        )
          proposed.reason = "timeout";
        const result = deriveJevResult(proposed);
        requireJev(
          result.cost_usd6 === null ||
            BigInt(result.cost_usd6) <= BigInt(original.reserved_usd6),
          "COST_BOUND",
        );
        await insertResult(tx, result);
        const failures = (
          await tx.query<{ n: number }>(
            `SELECT count(*)::int n FROM jev_decision_results s JOIN jev_decision_requests r USING(origin,request_id)
          WHERE r.origin=$1 AND r.purpose=$2 AND r.pool_month=$3 AND r.reserved_usd6>0
            AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.result->'decisions') d WHERE d->>'reason'='ok')`,
            [
              original.origin,
              original.batch.purpose,
              original.started_at.slice(0, 7),
            ],
          )
        ).rows[0]!.n;
        if (result.cost_usd6 === null || failures >= 3)
          await tx.query(
            "UPDATE jev_cost_pools SET circuit_open=true WHERE origin=$1 AND purpose=$2",
            [original.origin, original.batch.purpose],
          );
        return result;
      });
    },
  };
}
export async function readJevDecision(
  pool: Pool,
  owner: string,
  origin: Origin,
  requestId: string,
) {
  return pool.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const row = (
      await tx.query<{
        batch: JevBatch;
        tariff: JevTariff | null;
        reserved_usd6: string;
        started_at: Date;
        result: JevBatchResult | null;
      }>(
        `SELECT r.batch,r.tariff,r.reserved_usd6::text,r.started_at,s.result FROM jev_decision_requests r LEFT JOIN jev_decision_results s USING(origin,request_id)
      WHERE r.origin=$1 AND r.request_id=$2 AND EXISTS(SELECT 1 FROM jev_decision_participants p WHERE p.origin=r.origin AND p.request_id=r.request_id AND p.owner_id=$3)`,
        [origin, requestId, owner],
      )
    ).rows[0];
    requireJev(row, "DECISION_NOT_FOUND");
    return row.result
      ? replayJevDecision(row.result)
      : base(
          row.batch,
          origin,
          row.started_at.toISOString(),
          row.tariff,
          row.reserved_usd6,
        );
  });
}
export async function readJevCosts(
  pool: Pool,
  origin: Origin,
  month: string,
  scope?: JevScope,
) {
  requireJev(/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month), "COST_MONTH");
  return pool.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await tx.query("SET LOCAL statement_timeout='5s'");
    const rows = (
      await tx.query<{
        purpose: JevPurpose;
        requests: number;
        known: string;
        unknown: number;
        committed: string;
        account_known: string;
        account_unknown: number;
      }>(
        `
      SELECT r.purpose,count(*)::int requests,COALESCE(sum(s.cost_usd6),0)::text known,
      count(*) FILTER(WHERE s.cost_usd6 IS NULL)::int unknown,
      sum(COALESCE(s.cost_usd6,r.reserved_usd6))::text committed,
      COALESCE(sum(s.cost_usd6) FILTER(WHERE r.purpose='operation' AND p.account_id IS NOT NULL),0)::text account_known,
      count(*) FILTER(WHERE r.purpose='operation' AND p.account_id IS NOT NULL AND s.cost_usd6 IS NULL)::int account_unknown
      FROM jev_decision_requests r LEFT JOIN jev_decision_results s USING(origin,request_id)
      LEFT JOIN jev_decision_participants p ON p.origin=r.origin AND p.request_id=r.request_id AND p.owner_id=$3 AND p.account_id=$4 AND p.experiment_id=$5
      WHERE r.origin=$1 AND r.started_at>=($2::date AT TIME ZONE 'UTC') AND r.started_at<(($2::date+interval '1 month') AT TIME ZONE 'UTC') GROUP BY r.purpose`,
        [
          origin,
          `${month}-01`,
          scope?.owner_id ?? null,
          scope?.account_id ?? null,
          scope?.experiment_id ?? null,
        ],
      )
    ).rows;
    const sum = (key: "known" | "committed" | "account_known") =>
      rows.reduce((n, r) => n + BigInt(r[key]), 0n).toString();
    const unknown = rows.reduce((n, r) => n + r.unknown, 0),
      accountUnknown = rows.reduce((n, r) => n + r.account_unknown, 0);
    return {
      origin,
      month,
      requests: rows.reduce((n, r) => n + r.requests, 0),
      known_cost_usd6: sum("known"),
      unknown_requests: unknown,
      cost_usd6: unknown ? null : sum("known"),
      committed_usd6: sum("committed"),
      account_attributed_known_usd6: scope ? sum("account_known") : null,
      account_unknown_requests: scope ? accountUnknown : null,
      account_attributed_cost_usd6:
        scope && !accountUnknown ? sum("account_known") : null,
      convention: "whole_request_per_participating_account_do_not_sum",
      generation_attribution: "economic_gate_pending",
      pools: rows,
    };
  });
}
