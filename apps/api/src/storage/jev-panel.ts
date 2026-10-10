import { readJevLivePanelTx } from "./jev-promotion.js";
import { readJevQueueTx } from "./jev-queue.js";
import type { JevExecutionFill } from "./jev-execution-contract.js";
import { readJevReadinessTx } from "./jev-readiness.js";
import { readJevExecutionTx } from "./jev-executionstore.js";
import type { JevBatchResult } from "../models/jev-decision-contract.js";
import type {
  JevPanelSnapshot,
  JevPanelAccount,
} from "@ganso-market/contracts/trading";
import type { DatabasePool } from "../database.js";
import { currentBudgetMs } from "../budgets.js";
import { readJevMetricsTx } from "./jev-metrics.js";
import { readJevRiskTx } from "./jev-riskstore.js";
/** Bounded owner-scoped snapshot; GET never creates accounts, pins or qualification. */
export async function readJevPanel(
  pool: Pick<DatabasePool, "readOnly">,
  owner: string,
): Promise<JevPanelSnapshot> {
  return pool.readOnly(currentBudgetMs() ?? 4000, async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const at = (
      await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
    ).rows[0]!.now.toISOString();
    const rows = (
      await tx.query<JevPanelAccount>(
        `SELECT a.account_id,a.mode,b.profile_id,b.profile_version,p.manifest_hash,
      (p.profile->>'horizon_minutes')::int AS horizon_minutes,COALESCE(c.admitted,false) AS admitted,
      COALESCE(c.entries_paused,true) AS entries_paused,
      (COALESCE(c.admitted,false) AND (a.mode<>'live' OR EXISTS(SELECT 1 FROM jev_live_activations x WHERE x.account_id=a.account_id AND x.owner_id=a.owner_id))) AS control_available FROM jev_accounts a
      JOIN LATERAL (SELECT * FROM jev_bindings WHERE account_id=a.account_id ORDER BY binding->>'started_at' DESC,experiment_id DESC LIMIT 1) b ON true
      JOIN jev_profiles p ON p.owner_id=b.owner_id AND p.profile_id=b.profile_id AND p.profile_version=b.profile_version LEFT JOIN jev_worker_controls c ON c.account_id=a.account_id
      WHERE a.owner_id=$1 AND (a.mode='live' OR a.account_id IN(SELECT paper_account_id FROM jev_active_pairs UNION SELECT stress_account_id FROM jev_active_pairs)) ORDER BY b.profile_id,a.mode,a.account_id LIMIT 8`,
        [owner],
      )
    ).rows;
    if (rows.length > 7) throw new Error("JEV_PANEL_LIMIT");
    const accounts: JevPanelAccount[] = [];
    for (const row of rows) {
      let metrics: JevPanelAccount["metrics"] = null;
      if (row.mode !== "live") {
        const m = await readJevMetricsTx(tx, owner, row.account_id, "real", at);
        metrics = {
          as_of: m.as_of,
          capital_usd6: m.capital_usd6,
          risk_equity_usd6: m.risk_equity_usd6,
          trading: m.trading,
          attributed_jev_usd6: m.costs.evaluation.jev_usd6,
          strategy_after_jev_usd6: m.strategy_after_jev_usd6,
          conservative_result_usd6: m.conservative_result_usd6,
          quality: m.valuation.quality,
          positions: m.positions.map((p) => ({
            position_id: p.position_id,
            quantity_btc_raw: p.quantity_btc_raw,
          })),
        };
      }
      const e = (
        await tx.query<{ state: string; as_of: Date; evidence_id: string }>(
          `SELECT state,as_of,evidence_id FROM jev_evaluation_cuts
        WHERE owner_id=$1 AND profile_id=$2 AND profile_version=$3 ORDER BY as_of DESC,phase LIMIT 1`,
          [owner, row.profile_id, row.profile_version],
        )
      ).rows[0];
      const execution = await readJevExecutionTx(tx, row.account_id);
      const fills = (
        await tx.query<{ fills: JevExecutionFill[] }>(
          "SELECT result->'fills' AS fills FROM jev_execution_events WHERE account_id=$1 AND jsonb_array_length(result->'fills')>0 ORDER BY sequence DESC LIMIT 10",
          [row.account_id],
        )
      ).rows
        .flatMap((r) => [...r.fills].reverse())
        .slice(0, 20)
        .map(
          ({
            execution_id,
            order_id,
            position_id,
            side,
            occurred_at,
            kind,
            quantity_btc_raw,
            price_usd_raw,
            fee_usd_raw,
          }) => ({
            execution_id,
            order_id,
            position_id,
            side,
            occurred_at,
            kind,
            quantity_btc_raw,
            price_usd_raw,
            fee_usd_raw,
          }),
        );
      const decisions = (
        await tx.query<{
          request_id: string;
          started_at: Date;
          finished_at: Date | null;
          context_id: string;
          model: string;
          questions_version: string;
          result: JevBatchResult | null;
        }>(
          `SELECT r.request_id,r.started_at,s.finished_at,p.context_id,r.batch->>'model' AS model,r.batch->>'questions_version' AS questions_version,s.result FROM jev_decision_participants p JOIN jev_decision_requests r USING(origin,request_id) LEFT JOIN jev_decision_results s USING(origin,request_id) WHERE p.account_id=$1 AND p.owner_id=$2 AND p.origin='real' ORDER BY r.started_at DESC,r.request_id DESC LIMIT 10`,
          [row.account_id, owner],
        )
      ).rows.map((d) => {
        const value = d.result?.decisions.find(
          (v) => v.scope.account_id === row.account_id,
        );
        return {
          request_id: d.request_id,
          started_at: d.started_at.toISOString(),
          finished_at: d.finished_at?.toISOString() ?? null,
          context_id: d.context_id,
          model: d.model,
          questions_version: d.questions_version,
          reason: value?.reason ?? d.result?.reason ?? "pending",
          latency_ms: d.finished_at
            ? d.finished_at.getTime() - d.started_at.getTime()
            : null,
          direction: value?.direction ?? null,
          intent: value?.intent ?? null,
          attributed_cost_usd6: value?.attributed_cost_usd6 ?? null,
        };
      });
      const intervention = (
        await tx.query<{
          action: string;
          recorded_at: Date;
          idempotency_key: string;
        }>(
          `SELECT action,recorded_at,idempotency_key FROM jev_operator_commands WHERE owner_id=$1 AND $2=ANY(account_ids) ORDER BY recorded_at DESC,idempotency_key DESC LIMIT 1`,
          [owner, row.account_id],
        )
      ).rows[0];
      const flat =
        intervention &&
        (
          await tx.query<{ flat: boolean }>(
            "SELECT ((result->>'reconciled_flat')::boolean AND (state->>'observed_at')::timestamptz >= $2) AS flat FROM jev_execution_events WHERE account_id=$1 ORDER BY sequence DESC LIMIT 1",
            [row.account_id, intervention.recorded_at],
          )
        ).rows[0]?.flat === true;
      let liveIntervention: Pick<
        NonNullable<JevPanelAccount["intervention"]>,
        "status" | "observed_at" | "position_btc_raw" | "reasons"
      > | null = null;
      if (intervention && row.mode === "live") {
        const progress = (
          await tx.query<{
            payload: {
              status: NonNullable<JevPanelAccount["intervention"]>["status"];
              observed_at: number;
              position_raw: string;
              reasons: string[];
            };
            current: boolean;
          }>(
            `SELECT e.payload,
          (r.observed_at>clock_timestamp()-interval '3 seconds' AND r.state->>'connected'='true' AND (r.state->'reasons' ? 'JEV_LIVE_RECOVERY_UNAVAILABLE') IS NOT TRUE AND h.lease_until>clock_timestamp()) AS current
          FROM jev_live_identities i LEFT JOIN jev_live_runtime r USING(identity_hash) LEFT JOIN execution_worker_head h ON h.generation=r.generation
          LEFT JOIN LATERAL (SELECT payload FROM jev_live_events WHERE identity_hash=i.identity_hash AND kind='intervention' AND payload->>'command_key'=$3 ORDER BY recorded_at DESC,event_key DESC LIMIT 1) e ON true
          WHERE i.owner_id=$1 AND i.account_id=$2`,
            [owner, row.account_id, intervention.idempotency_key],
          )
        ).rows[0];
        liveIntervention = {
          status: progress?.current
            ? (progress.payload?.status ?? "pending_reconciliation")
            : "unavailable",
          ...(progress?.payload
            ? {
                observed_at: new Date(
                  progress.payload.observed_at,
                ).toISOString(),
                position_btc_raw: progress.payload.position_raw,
                reasons: progress.payload.reasons,
              }
            : {}),
        };
      }
      accounts.push({
        ...(intervention
          ? {
              intervention: {
                action: intervention.action,
                recorded_at: intervention.recorded_at.toISOString(),
                status: flat
                  ? ("reconciled_flat" as const)
                  : ("pending_reconciliation" as const),
                ...(liveIntervention ?? {}),
              },
            }
          : {}),
        decisions,
        fills,
        execution: execution
          ? {
              observed_at: execution.observed_at,
              reason: execution.reason,
              maker: execution.maker
                ? {
                    status: execution.maker.status,
                    order_id: execution.maker.plan.input.order_id,
                    filled_btc_raw: execution.maker.filled_btc_raw,
                    planned_btc_raw: execution.maker.plan.quantity_btc_raw,
                    ack_at: execution.maker.ack_at,
                    cancel_at: execution.maker.cancel_at,
                  }
                : null,
              protection: execution.protection
                ? {
                    direction: execution.protection.direction,
                    quantity_btc_raw: execution.protection.quantity_btc_raw,
                    stop_price_raw: execution.protection.stop_price_raw,
                    maximum_exit_at: execution.protection.maximum_exit_at,
                  }
                : null,
              close: execution.close
                ? {
                    pending: execution.close.pending,
                    requested_at: execution.close.requested_at,
                  }
                : null,
            }
          : null,
        ...row,
        metrics,
        risk: await readJevRiskTx(tx, row.account_id),
        evaluation: e
          ? {
              ...e,
              state:
                intervention && e.state !== "failed" ? "inconclusive" : e.state,
              as_of: e.as_of.toISOString(),
            }
          : null,
      });
    }
    const month = at.slice(0, 7);
    const bill = (
      await tx.query<{
        captured_requests: number;
        unknown_requests: number;
        known: string;
      }>(
        `SELECT COUNT(*)::int AS captured_requests,COUNT(*) FILTER(WHERE cost_usd6 IS NULL)::int AS unknown_requests,COALESCE(SUM(cost_usd6),0)::text AS known FROM (
 SELECT s.cost_usd6 FROM jev_decision_requests r LEFT JOIN jev_decision_results s USING(origin,request_id) WHERE r.origin='real' AND r.started_at>=($2||'-01')::timestamptz AND r.started_at<$3 AND EXISTS(SELECT 1 FROM jev_decision_participants p WHERE p.origin=r.origin AND p.request_id=r.request_id AND p.owner_id=$1)
 UNION ALL SELECT s.cost_usd6 FROM jev_proposal_requests r LEFT JOIN jev_proposal_results s USING(origin,request_id) WHERE r.origin='real' AND r.owner_id=$1 AND r.started_at>=($2||'-01')::timestamptz AND r.started_at<$3) costs`,
        [owner, month, at],
      )
    ).rows[0]!;
    const infrastructure =
      (
        await tx.query<{ usd6: string }>(
          "SELECT usd6::text FROM jev_infrastructure_events WHERE owner_id=$1 AND month=$2 ORDER BY sequence DESC LIMIT 1",
          [owner, month],
        )
      ).rows[0]?.usd6 ?? null;
    const live = await readJevLivePanelTx(tx, owner);
    return {
      live,
      queue: await readJevQueueTx(tx, owner),
      platform: {
        month,
        scope: "captured_principal_requests_only",
        invoice_complete: false,
        captured_requests: bill.captured_requests,
        unknown_requests: bill.unknown_requests,
        known_jev_usd6: bill.known,
        captured_jev_usd6: bill.unknown_requests ? null : bill.known,
        infrastructure_usd6: infrastructure,
        captured_total_usd6:
          bill.unknown_requests || infrastructure === null
            ? null
            : (BigInt(bill.known) + BigInt(infrastructure)).toString(),
      },
      readiness: await readJevReadinessTx(tx, owner, at),
      schema_version: "jev.panel.v1",
      as_of: at,
      accounts,
      live_activation_available: live.can_activate,
      alternative_banks_summable: false,
    };
  });
}
