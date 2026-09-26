import type { DatabasePool, SqlExecutor } from "../database.js";
import type { createJevAdapter } from "../models/jev.js";
import {
  JEV_VERSION,
  JEV_PROMPT_VERSION,
  JEV_PROMPT_HASH,
  JEV_QUESTION,
  jevHash,
  type JevRequest,
  type JevResult,
} from "../models/jev-contract.js";
import {
  consumeBaselineAccount,
  admitBaselineDecisionTx,
} from "./baseline-runtime.js";
import { baselineHash } from "./baseline-inputs.js";
import type { BaselineDecision } from "./baseline-policy.js";
import {
  baselineClock,
  baselineEvidenceTx,
  baselineRegistrationTx,
} from "./baseline-store.js";
import {
  storeRetentionObjectTx,
  pinRetentionObjectTx,
} from "./btc-retention.js";
import { riskTransaction } from "./riskstore.js";
import { withDeskWorker } from "./desk-worker.js";

type Pool = Pick<DatabasePool, "transaction" | "readOnly">;
type Adapter = ReturnType<typeof createJevAdapter>;
type Fence = { generation: string; worker_id: string };
type Job = {
  account_id: string;
  bar_end_at: Date;
  decision_id: string;
  evidence_id: string;
  request_id: string;
  origin: "real" | "mock";
  model: string;
  request: JevRequest;
  fence: Fence;
  state: "prepared" | "dispatching" | "final";
};
const fenceTx = async (tx: SqlExecutor, account: string) =>
  (
    await tx.query<Fence>(
      "SELECT generation::text,worker_id FROM btc_recovery_heads WHERE account_id=$1",
      [account],
    )
  ).rows[0]!;

/** Entry permission may be supplied by the S3 operational composition.
 * This consumer never registers/genesis-seeds or provisions credit. Each tick manages exits first and launches at
 * most one asynchronous model attempt; subsequent ticks never await that HTTP.
 * The adapter still owns the REAL durable mock/real cost pool and circuit. */
export function createChallengerConsumer(
  pool: Pool,
  options: {
    account: string;
    sourceAccount: string;
    adapter: Adapter;
    enabled?: boolean;
    isEnabled?: () => boolean;
    admissionAllowedTx?: (tx: SqlExecutor) => Promise<boolean>;
    onError?: (reason: string) => void;
  },
) {
  const { account, sourceAccount, adapter, enabled = false } = options;
  const entriesEnabled = () => enabled && (options.isEnabled?.() ?? true);
  let running: Promise<void> | null = null;
  let stopped = false;
  const cancellation = new AbortController();

  async function finish(job: Job, result: JevResult | null) {
    const registration = await pool.readOnly(1500, (tx) =>
      baselineRegistrationTx(tx, account, "challenger"),
    );
    await withDeskWorker(pool, account, (worker) =>
      riskTransaction(
        worker,
        registration.registration.scope,
        async (tx) => {
          const current = await baselineRegistrationTx(
            tx,
            account,
            "challenger",
          );
          const locked = (
            await tx.query<Job>(
              "SELECT * FROM btc_jev_challenger_requests WHERE account_id=$1 AND bar_end_at=$2 FOR UPDATE",
              [account, job.bar_end_at],
            )
          ).rows[0]!;
          if (locked.state === "final") return;
          const at = await baselineClock(tx);
          const stored = (
            await tx.query<{ result: JevResult; finished_at: Date | null }>(
              "SELECT result,finished_at FROM btc_jev_calls WHERE origin=$1 AND request_id=$2",
              [job.origin, job.request_id],
            )
          ).rows[0];
          const d = (
            await tx.query<{ decision: BaselineDecision }>(
              "SELECT decision FROM btc_baseline_decisions WHERE decision_id=$1",
              [job.decision_id],
            )
          ).rows[0]!.decision;
          const reasons: string[] = [];
          if (
            !enabled ||
            stopped ||
            (!options.admissionAllowedTx && !entriesEnabled())
          )
            reasons.push("disabled");
          if (
            baselineHash(await fenceTx(tx, account)) !== baselineHash(job.fence)
          )
            reasons.push("fence_changed");
          if (
            baselineHash(d.registration) !== baselineHash(current.registration)
          )
            reasons.push("registration_changed");
          if (Date.parse(at) >= Date.parse(job.request.deadline_at))
            reasons.push("intent_expired");
          if (!result) reasons.push("recovered_uncertain");
          else {
            if (result.reason !== "ok" || result.decision !== "allow")
              reasons.push(
                `jev_${result.reason === "ok" ? result.decision : result.reason}`,
              );
            if (
              !stored?.finished_at ||
              jevHash(stored.result) !== jevHash(result) ||
              result.origin !== job.origin ||
              result.model !== job.model ||
              result.request_id !== job.request_id ||
              result.deadline_at !== job.request.deadline_at ||
              result.input_hash !== jevHash(job.request.input) ||
              baselineHash(result.input) !== baselineHash(job.request.input) ||
              result.version !== JEV_VERSION ||
              result.prompt_version !== JEV_PROMPT_VERSION ||
              result.prompt_hash !== JEV_PROMPT_HASH ||
              !result.original_response ||
              result.response_hash !== jevHash(result.original_response) ||
              !result.response_received_at ||
              result.response_received_at < result.started_at ||
              result.response_received_at >= job.request.deadline_at ||
              result.started_at < d.decision_at ||
              stored.finished_at.toISOString() >= job.request.deadline_at ||
              result.cost_usd6 === null
            )
              reasons.push("receipt_unusable");
          }
          if (
            options.admissionAllowedTx &&
            !(await options.admissionAllowedTx(tx))
          )
            reasons.push("activation_revoked");
          const receipt = { object_id: `challenger-receipt:${job.request_id}` };
          await storeRetentionObjectTx(tx, {
            id: receipt.object_id,
            class: "decision",
            identity: current.registration.scope,
            recordedAt: new Date(at),
            dependencies: [job.evidence_id],
            payload: {
              schema_version: "btc.jev-challenger.v1",
              request: job.request,
              question: JEV_QUESTION,
              origin: job.origin,
              model: job.model,
              // Preserve the stored original even when the adapter returned a timeout
              // or lost COMMIT acknowledgement. Neither becomes an eligible allow.
              result,
              stored_result: stored?.result ?? null,
              reasons,
            },
          });
          await pinRetentionObjectTx(
            tx,
            receipt.object_id,
            receipt.object_id,
            "Jev challenger original response and admission replay",
          );
          const admission = !reasons.length
            ? await admitBaselineDecisionTx(tx, current, d, job.evidence_id, [
                receipt.object_id,
              ])
            : null;
          const outcome = {
            reasons,
            admission,
            result,
            evidence_id: receipt.object_id,
            finalized_at: at,
          };
          await tx.query(
            "UPDATE btc_jev_challenger_requests SET state='final',outcome=$3::jsonb WHERE account_id=$1 AND bar_end_at=$2",
            [account, job.bar_end_at, JSON.stringify(outcome)],
          );
        },
        true,
      ),
    );
  }

  async function dispatch() {
    // Claim is committed BEFORE entering the adapter. Even a lost claim COMMIT
    // cannot cause a send: restart abandons dispatching jobs, never resends.
    const job = await pool.transaction(async (tx) => {
      const row = (
        await tx.query<Job>(
          "SELECT * FROM btc_jev_challenger_requests WHERE account_id=$1 AND state<>'final' ORDER BY bar_end_at DESC LIMIT 1 FOR UPDATE",
          [account],
        )
      ).rows[0];
      if (!row) return null;
      if (row.state === "dispatching") {
        if (
          Date.parse(await baselineClock(tx)) <
          Date.parse(row.request.deadline_at)
        )
          return null;
        return { job: row, abandoned: true };
      }
      await tx.query(
        "UPDATE btc_jev_challenger_requests SET state='dispatching' WHERE account_id=$1 AND bar_end_at=$2",
        [account, row.bar_end_at],
      );
      return { job: row, abandoned: false };
    });
    if (!job) return;
    if (
      job.abandoned ||
      !entriesEnabled() ||
      stopped ||
      adapter.identity.origin !== job.job.origin ||
      adapter.identity.model !== job.job.model
    ) {
      await finish(job.job, null);
      return;
    }
    const result = await adapter.evaluate(job.job.request, cancellation.signal);
    await finish(job.job, result);
  }

  return {
    async tick() {
      if (stopped) return;
      await consumeBaselineAccount(pool, account, {
        source_account: sourceAccount,
        enabled: entriesEnabled(),
        async stage(tx, r, decision, evidenceId, sourceEvidenceId) {
          // Independent account eligibility is already durably recorded even if
          // baseline is positioned, paused or has different cash. Freeze size
          // and exits BEFORE Jev; never resize from its answer or confidence.
          if (!entriesEnabled() || !decision.command || !decision.signal)
            return;
          const s = decision.signal;
          const input = {
            candidate_hash: s.hash,
            direction: s.direction,
            close_usd6: s.close_usd6,
            fast_mean_usd6: s.fast_mean_usd6,
            slow_mean_usd6: s.slow_mean_usd6,
            atr_usd6: s.atr_usd6,
          };
          const request_id = `challenger:${baselineHash([account, s.hash, JEV_VERSION, JEV_PROMPT_HASH, adapter.identity])}`;
          const request: JevRequest = {
            request_id,
            input,
            deadline_at: decision.command.order.valid_until,
          };
          const evidence = await baselineEvidenceTx(
            tx,
            r,
            `challenger-request:${request_id}`,
            {
              schema_version: "btc.jev-challenger.v1",
              source_decision_id: decision.source_decision_id,
              request,
              question: JEV_QUESTION,
              prompt_version: JEV_PROMPT_VERSION,
              prompt_hash: JEV_PROMPT_HASH,
              input_hash: jevHash(input),
              ...adapter.identity,
            },
            decision.decision_at,
            [evidenceId, sourceEvidenceId],
          );
          await tx.query(
            `INSERT INTO btc_jev_challenger_requests(account_id,bar_end_at,decision_id,evidence_id,request_id,origin,model,request,fence)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
            [
              account,
              decision.bar_end_at,
              decision.decision_id,
              evidence.object_id,
              request_id,
              adapter.identity.origin,
              adapter.identity.model,
              JSON.stringify(request),
              JSON.stringify(await fenceTx(tx, account)),
            ],
          );
        },
      });
      if (!running)
        running = dispatch()
          .catch(() => options.onError?.("BTC_CHALLENGER_UNAVAILABLE"))
          .finally(() => {
            running = null;
          });
    },
    /** Graceful shutdown/tests only; never await this from the desk heartbeat. */
    async drain() {
      await running;
    },
    async stop() {
      stopped = true;
      cancellation.abort();
      await running;
    },
  };
}

/** Original observations and receipts only: no adapter, clock substitution or
 * order side effect. A pending/uncertain attempt remains explicitly visible. */
export async function readChallengerReplay(
  pool: Pool,
  account: string,
  bar: string,
) {
  return pool.readOnly(
    1500,
    async (tx) =>
      (
        await tx.query(
          `SELECT d.decision,j.request,j.origin,j.model,j.state,j.outcome,
      c.result AS adapter_receipt,c.finished_at,source.decision AS source_decision
     FROM btc_baseline_decisions d
     JOIN btc_ledger_accounts a ON a.account_id=d.account_id
     LEFT JOIN btc_jev_challenger_requests j ON j.decision_id=d.decision_id
     LEFT JOIN btc_jev_calls c ON c.origin=j.origin AND c.request_id=j.request_id
     LEFT JOIN btc_baseline_decisions source ON source.decision_id=d.decision->>'source_decision_id'
     WHERE d.account_id=$1 AND d.bar_end_at=$2 AND a.identity->'account'->>'purpose'='challenger'`,
          [account, bar],
        )
      ).rows[0] ?? null,
  );
}
