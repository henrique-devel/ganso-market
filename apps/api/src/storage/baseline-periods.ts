import type { DatabasePool, SqlExecutor } from "../database.js";
import {
  baselineEnvironment,
  baselineHash,
  baselineIso,
  baselineTime,
  type BaselineRegistration,
  type BaselinePeriod,
} from "./baseline-inputs.js";
import {
  baselineClock,
  baselineRegistrationTx,
  baselineEvidenceTx,
  baselineRecord,
  baselineEnvironmentTx,
} from "./baseline-store.js";
import { riskTransaction, applyRiskTx } from "./riskstore.js";
import { recoveryTransaction } from "./recoverystore.js";

type Pool = Pick<DatabasePool, "transaction" | "readOnly">;
export const BASELINE_PERIOD_MS = 30 * 86400000;
export function validateBaselinePeriod(
  p: BaselinePeriod,
  r: BaselineRegistration,
) {
  if (
    p.version !== "btc.baseline-period.v1" ||
    p.registration_hash !== baselineHash(r) ||
    !/^[a-zA-Z0-9:._-]{1,120}$/.test(p.operation_id) ||
    !/^[a-f0-9]{40}$/.test(p.code_sha) ||
    !p.previous_evidence_id ||
    !p.registered_by ||
    !p.reason?.trim() ||
    !["operational_pilot", "economic_evaluation"].includes(p.purpose) ||
    baselineTime(p.start_at) % 900000 !== 0 ||
    baselineTime(p.registered_at) >= baselineTime(p.start_at) ||
    baselineTime(p.start_at) < baselineTime(r.start_at) + BASELINE_PERIOD_MS ||
    baselineTime(p.end_at) !== baselineTime(p.start_at) + BASELINE_PERIOD_MS
  )
    throw new Error("BTC_BASELINE_PERIOD_INVALID");
}
export async function baselinePeriodTx(
  tx: SqlExecutor,
  r: BaselineRegistration,
  at: string,
) {
  const row = (
    await tx.query<{
      period: BaselinePeriod;
      evidence_id: string;
      payload: BaselinePeriod;
      recorded_at: Date;
      pinned: boolean;
    }>(
      `SELECT p.period,p.evidence_id,o.payload,o.recorded_at,
    EXISTS(SELECT 1 FROM btc_retention_pins pin WHERE pin.object_id=p.evidence_id AND pin.pin_id=p.evidence_id) AS pinned
    FROM btc_baseline_periods p JOIN btc_retention_objects o ON o.object_id=p.evidence_id
    WHERE p.account_id=$1 AND p.start_at <= $2 AND p.end_at > $2 ORDER BY p.start_at DESC LIMIT 1`,
      [r.scope.account_id, at],
    )
  ).rows[0];
  if (!row) return undefined;
  validateBaselinePeriod(row.period, r);
  if (
    !row.pinned ||
    baselineHash(row.payload) !== baselineHash(row.period) ||
    row.recorded_at.toISOString() !== row.period.registered_at
  )
    throw new Error("BTC_BASELINE_PERIOD_EVIDENCE");
  return baselineRecord(
    row.evidence_id,
    row.period,
    row.recorded_at.toISOString(),
  );
}
async function ownerTx(tx: SqlExecutor, username: string, locked = false) {
  const row = (
    await tx.query(
      `SELECT c.enabled FROM btc_desk_controls c JOIN auth_accounts a ON a.account_id=c.owner_account_id
     WHERE c.account_id='baseline' AND a.username=$1 ${locked ? "FOR SHARE OF c,a" : ""}`,
      [username],
    )
  ).rows[0];
  if (!row?.enabled) throw new Error("BTC_BASELINE_OWNER_REQUIRED");
  return baselineRegistrationTx(tx, "baseline");
}
export type BaselineOperation = { operation_id: string; reason: string } & (
  | { action: "rearm" }
  | {
      action: "register_period";
      start_at: string;
      purpose: BaselinePeriod["purpose"];
    }
);
/** Local operator command only. Never borrow a running consumer's lease. A new
 * process must reconcile through the same recovery contract and final fence. */
export async function operateBaseline(
  pool: Pool,
  username: string,
  codeSha: string,
  input: BaselineOperation,
) {
  if (
    !input ||
    typeof input !== "object" ||
    !/^[a-f0-9]{40}$/.test(codeSha) ||
    !/^[a-zA-Z0-9:._-]{1,120}$/.test(input.operation_id) ||
    typeof input.reason !== "string" ||
    !input.reason.trim() ||
    input.reason.length > 300 ||
    !["rearm", "register_period"].includes(input.action) ||
    Object.keys(input).sort().join() !==
      (input.action === "rearm"
        ? "action,operation_id,reason"
        : "action,operation_id,purpose,reason,start_at")
  )
    throw new Error("BTC_BASELINE_OPERATION_INVALID");
  const request = structuredClone(input);
  const original = await pool.readOnly(1500, (tx) => ownerTx(tx, username));
  const scope = original.registration.scope;
  const execute = async (tx: SqlExecutor) => {
    const r = await ownerTx(tx, username, true);
    if (baselineHash(r.registration) !== baselineHash(original.registration))
      throw new Error("BTC_BASELINE_REGISTRATION_CHANGED");
    if (request.action === "rearm") {
      const command = {
        action: "rearm" as const,
        operation_id: `baseline-rearm:${request.operation_id}`,
        reason: JSON.stringify({
          version: "btc.baseline-rearm.v1",
          owner: username,
          reason: request.reason,
        }),
      };
      // A retry returns the old receipt even after another pause. Never rearm twice.
      const prior = await tx.query(
        "SELECT 1 FROM btc_risk_events WHERE account_id=$1 AND operation_id=$2",
        [scope.account_id, command.operation_id],
      );
      if (!prior.rowCount) {
        const env = await baselineEnvironmentTx(tx, r);
        if (baselineEnvironment(env.env, baselineTime(env.at)).causes.length)
          throw new Error("BTC_BASELINE_REARM_DATA");
        const end =
          env.env.period?.payload.end_at ??
          baselineIso(
            baselineTime(r.registration.start_at) + BASELINE_PERIOD_MS,
          );
        if (env.at < r.registration.start_at || env.at >= end)
          throw new Error("BTC_BASELINE_REARM_PERIOD");
      }
      return {
        action: request.action,
        checkpoint: await applyRiskTx(tx, scope, command),
      };
    }
    const prior = (
      await tx.query<{ request: BaselineOperation; period: BaselinePeriod }>(
        "SELECT request,period FROM btc_baseline_periods WHERE account_id=$1 AND operation_id=$2",
        [scope.account_id, request.operation_id],
      )
    ).rows[0];
    if (prior) {
      if (baselineHash(prior.request) !== baselineHash(request))
        throw new Error("BTC_BASELINE_IDEMPOTENCY_COLLISION");
      return { action: request.action, period: prior.period };
    }
    const previous = (
      await tx.query<{ end_at: Date; evidence_id: string }>(
        "SELECT end_at,evidence_id FROM btc_baseline_periods WHERE account_id=$1 ORDER BY start_at DESC LIMIT 1",
        [scope.account_id],
      )
    ).rows[0];
    const period: BaselinePeriod = {
      version: "btc.baseline-period.v1",
      operation_id: request.operation_id,
      registration_hash: baselineHash(r.registration),
      code_sha: codeSha,
      previous_evidence_id: previous?.evidence_id ?? r.evidence_id,
      registered_by: username,
      reason: request.reason,
      registered_at: await baselineClock(tx),
      start_at: request.start_at,
      end_at: baselineIso(baselineTime(request.start_at) + BASELINE_PERIOD_MS),
      purpose: request.purpose,
    };
    validateBaselinePeriod(period, r.registration);
    if (previous && period.start_at < previous.end_at.toISOString())
      throw new Error("BTC_BASELINE_PERIOD_OVERLAP");
    const evidence = await baselineEvidenceTx(
      tx,
      r,
      `baseline-period:${baselineHash(period)}`,
      period,
      period.registered_at,
      [r.evidence_id, period.previous_evidence_id],
    );
    await tx.query(
      "INSERT INTO btc_baseline_periods(account_id,operation_id,start_at,end_at,period,request,evidence_id) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)",
      [
        scope.account_id,
        request.operation_id,
        period.start_at,
        period.end_at,
        JSON.stringify(period),
        JSON.stringify(request),
        evidence.object_id,
      ],
    );
    return { action: request.action, period };
  };
  return request.action === "rearm"
    ? riskTransaction(pool, scope, execute, true)
    : recoveryTransaction(pool, scope, execute, true);
}
