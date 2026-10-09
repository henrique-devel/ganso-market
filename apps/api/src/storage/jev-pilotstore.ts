import type { DatabasePool, SqlExecutor } from "../database.js";
import { assertEvidenceJson } from "../trading/retention.js";
import {
  jevRiskCheckpoint,
  jevRiskCheck,
  riskTime,
  riskRaw,
  type JevRiskCheckpoint,
} from "../trading/jev-risk.js";
import { loadJevAccountTx } from "./jev-store.js";
import { jevHash } from "./jev-hash.js";
type Store = Pick<DatabasePool, "transaction">;
/** Trusted reconciliation seam for the future venue adapter, not an HTTP input
 * or a deposit. Components exclude JEV/infra; balances include trading fees and
 * signed funding. The complete original reconciliation stays in this journal. */
export interface JevPilotObservation {
  version: "btc.jev-pilot-reconciliation.v1";
  source: "hyperliquid:mainnet:reconciliation";
  evidence_id: string;
  observed_at: string;
  received_at: string;
  funded_capital_usd_raw: "250000000";
  trading_balance_usd_raw: string;
  open_pnl_usd_raw: string;
  flat: boolean;
  reconciled: boolean;
  original: unknown;
  /** Actual UTC-boundary evidence. A later flat balance is not midnight equity. */
  utc_anchor: {
    at: string;
    equity_usd_raw: string;
    evidence_id: string;
    original: unknown;
  } | null;
}
export interface JevPilotCheckpoint {
  version: "btc.jev-pilot-risk.v1";
  capital_admitted_usd_raw: "250000000";
  executor_enabled: false;
  supervisor_authorized: boolean;
  active_experiment_id: string;
  global_blocked: boolean;
  risk: JevRiskCheckpoint;
  observation: JevPilotObservation;
}
export async function readJevPilotTx(tx: SqlExecutor, id: string) {
  return (
    (
      await tx.query<{ sequence: string; checkpoint: JevPilotCheckpoint }>(
        "SELECT sequence::text,checkpoint FROM jev_pilot_events WHERE account_id=$1 ORDER BY sequence DESC LIMIT 1",
        [id],
      )
    ).rows[0] ?? null
  );
}
export type JevPilotCommand = {
  operation_id: string;
  expected_sequence: string;
  action:
    | "observe"
    | "authorize_supervisor"
    | "rearm"
    | "select_profile"
    | "automatic_profile";
  /** Non-observe commands must originate at the authenticated operator seam.
   * No route or executor is installed by JE05. */
  operator_decision?: { actor_id: string; decision_id: string; reason: string };
  experiment_id?: string;
  observation: JevPilotObservation;
};
/** Lock order: financial account first, then its journal. Financial writers,
 * checkpoint/rearm and profile selection all use this same row and CAS fence. */
export async function commandJevPilot(
  pool: Store,
  owner: string,
  id: string,
  input: JevPilotCommand,
) {
  return pool.transaction((tx) => commandJevPilotTx(tx, owner, id, input));
}
export async function commandJevPilotTx(
  tx: SqlExecutor,
  owner: string,
  id: string,
  input: JevPilotCommand,
) {
  assertEvidenceJson(input);
  const request = structuredClone(input);
  const ledger = await loadJevAccountTx(tx, owner, id, true);
  jevRiskCheck(ledger.identity.account.mode === "live", "PILOT_LIVE_ONLY");
  const duplicate = (
    await tx.query<{
      request: JevPilotCommand;
      checkpoint: JevPilotCheckpoint;
      sequence: string;
    }>(
      "SELECT request,checkpoint,sequence::text FROM jev_pilot_events WHERE account_id=$1 AND operation_id=$2",
      [id, request.operation_id],
    )
  ).rows[0];
  if (duplicate) {
    jevRiskCheck(
      jevHash(duplicate.request) === jevHash(request),
      "IDEMPOTENCY_COLLISION",
    );
    const current = await readJevPilotTx(tx, id);
    return {
      ...duplicate,
      sequence: current!.sequence,
      checkpoint: current!.checkpoint,
      duplicate: true,
    };
  }
  const old = await readJevPilotTx(tx, id),
    seq = old?.sequence ?? "0",
    p = old?.checkpoint;
  jevRiskCheck(seq === request.expected_sequence, "FENCE");
  const now = (
      await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
    ).rows[0]!.now.toISOString(),
    o = request.observation;
  jevRiskCheck(
    o.version === "btc.jev-pilot-reconciliation.v1" &&
      o.source === "hyperliquid:mainnet:reconciliation" &&
      o.evidence_id.length > 0 &&
      o.evidence_id.length <= 512 &&
      o.funded_capital_usd_raw === "250000000" &&
      typeof o.flat === "boolean" &&
      typeof o.reconciled === "boolean" &&
      o.original !== null,
    "PILOT_EVIDENCE",
  );
  const at = riskTime(o.observed_at),
    received = riskTime(o.received_at),
    clock = riskTime(now);
  jevRiskCheck(
    at <= received &&
      received <= clock &&
      (!p || at >= riskTime(p.observation.observed_at)),
    "PILOT_CLOCK",
  );
  const fresh = clock - at <= 2000 && clock - received <= 2000,
    equity = riskRaw(o.trading_balance_usd_raw) + riskRaw(o.open_pnl_usd_raw);
  jevRiskCheck(!o.flat || riskRaw(o.open_pnl_usd_raw) === 0n, "PILOT_FLAT_PNL");
  const initialBinding = ledger.identity.bindings[0]!.binding.experiment_id;
  const active =
    request.experiment_id ?? p?.active_experiment_id ?? initialBinding;
  jevRiskCheck(
    ledger.identity.bindings.some((b) => b.binding.experiment_id === active),
    "PILOT_BINDING",
  );
  if (request.action === "automatic_profile") {
    jevRiskCheck(
      !!(
        await tx.query(
          "SELECT 1 FROM jev_live_promotions WHERE account_id=$1 AND experiment_id=$2 AND state='active' AND sequence=(SELECT MAX(sequence) FROM jev_live_promotions WHERE account_id=$1)",
          [id, active],
        )
      ).rowCount,
      "PROMOTION_REQUIRED",
    );
  }
  if (request.action !== "observe" && request.action !== "automatic_profile")
    jevRiskCheck(
      request.operator_decision?.actor_id === owner &&
        !!request.operator_decision.decision_id &&
        !!request.operator_decision.reason,
      "OPERATOR_DECISION_REQUIRED",
    );
  jevRiskCheck(
    request.action === "select_profile" ||
      request.action === "automatic_profile" ||
      !p ||
      active === p.active_experiment_id,
    "PROFILE_COMMAND_REQUIRED",
  );
  let previous = p?.risk ?? null;
  if (request.action === "rearm") {
    jevRiskCheck(
      p?.global_blocked &&
        fresh &&
        o.flat &&
        o.reconciled &&
        equity > riskRaw(p.risk.high_water_usd_raw) - 12500000n,
      "REARM_UNSAFE",
    );
    previous = { ...p.risk, drawdown_blocked: false };
  }
  const boundary = now.slice(0, 10) + "T00:00:00.000Z";
  if (o.utc_anchor)
    jevRiskCheck(
      o.utc_anchor.at === boundary &&
        riskRaw(o.utc_anchor.equity_usd_raw) > 0n &&
        !!o.utc_anchor.evidence_id &&
        o.utc_anchor.original !== null,
      "PILOT_UTC_ANCHOR",
    );
  const risk = jevRiskCheckpoint({
    previous,
    now_at: now,
    ledger_sequence: seq,
    equity_usd_raw: fresh && o.reconciled ? equity.toString() : null,
    daily_anchor_usd_raw:
      p?.risk.day === now.slice(0, 10)
        ? p.risk.daily_anchor_usd_raw
        : (o.utc_anchor?.equity_usd_raw ?? null),
    initial_equity_usd_raw: "250000000",
    history_complete: true,
    fresh,
    reconciled: o.reconciled,
    flat: o.flat,
    global_blocked:
      request.action === "rearm" ? false : (p?.global_blocked ?? false),
  });
  const blocked =
    (request.action === "rearm" ? false : (p?.global_blocked ?? false)) ||
    risk.drawdown_blocked;
  if (
    request.action === "authorize_supervisor" ||
    request.action === "select_profile" ||
    request.action === "automatic_profile"
  )
    jevRiskCheck(
      !blocked && !risk.entries_paused && o.flat && fresh && o.reconciled,
      "GLOBAL_BLOCK_OR_NOT_READY",
    );
  if (
    request.action === "select_profile" ||
    request.action === "automatic_profile"
  )
    jevRiskCheck(p?.supervisor_authorized, "SUPERVISOR_NOT_AUTHORIZED");
  const checkpoint: JevPilotCheckpoint = {
    version: "btc.jev-pilot-risk.v1",
    capital_admitted_usd_raw: "250000000",
    executor_enabled: false,
    supervisor_authorized:
      p?.supervisor_authorized || request.action === "authorize_supervisor",
    active_experiment_id: active,
    global_blocked: blocked,
    risk: {
      ...risk,
      entries_paused: risk.entries_paused || blocked,
      cancel_entries: risk.cancel_entries || blocked,
      request_close: risk.request_close || (blocked && !o.flat),
      reasons: blocked
        ? [...new Set([...risk.reasons, "GLOBAL_BLOCK"])]
        : risk.reasons,
    },
    observation: o,
  };
  const next = (BigInt(seq) + 1n).toString();
  await tx.query(
    "INSERT INTO jev_pilot_events(account_id,owner_id,sequence,operation_id,request,checkpoint,active_experiment_id) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)",
    [
      id,
      owner,
      next,
      request.operation_id,
      JSON.stringify(request),
      JSON.stringify(checkpoint),
      active,
    ],
  );
  return { sequence: next, checkpoint, request };
}
export async function readJevPilot(pool: Store, owner: string, id: string) {
  return pool.transaction(async (tx) => {
    await loadJevAccountTx(tx, owner, id);
    return readJevPilotTx(tx, id);
  });
}
