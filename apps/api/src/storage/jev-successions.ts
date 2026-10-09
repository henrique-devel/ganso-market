import {
  requireJev,
  JEV_VERSION,
  type JevProfile,
} from "@ganso-market/contracts/trading";
import type { DatabasePool } from "../database.js";
import { withBtcRetentionTransaction } from "./btc-retention.js";
import {
  loadJevAccountTx,
  registerProfileTx,
  createAccountTx,
} from "./jev-store.js";
import { cancelJevEntriesTx } from "./jev-riskstore.js";
import { jevFundingEvidenceReadyTx } from "./jev-funding-status.js";
import { jevHash } from "./jev-hash.js";
import { readJevQueueTx, queueSnapshotTx } from "./jev-queue.js";
import { proposalEventTx, type JevProposal } from "./jev-proposals.js";
import { readJevDispatchCapacityTx } from "./jev-dispatch-capacity.js";
import { readSourceReadinessTx } from "./operational-readiness.js";
export interface JevPairSlot {
  slot: number;
  owner_id: string;
  profile_id: string;
  profile_version: string;
  paper_account_id: string;
  stress_account_id: string;
  paper_experiment_id: string;
  stress_experiment_id: string;
}
export async function retireFailedJevPairs(
  pool: Pick<DatabasePool, "transaction">,
  owner: string,
) {
  return withBtcRetentionTransaction(pool, async (tx) => {
    const rows = (
      await tx.query<JevPairSlot>(
        "SELECT q.* FROM jev_active_pairs q WHERE q.owner_id=$1 AND EXISTS(SELECT 1 FROM jev_evaluation_cuts e WHERE e.owner_id=q.owner_id AND e.profile_id=q.profile_id AND e.profile_version=q.profile_version AND e.state='failed' AND e.as_of<=clock_timestamp()) ORDER BY q.slot",
        [owner],
      )
    ).rows;
    const retired: number[] = [];
    for (const q of rows) {
      const original: unknown[] = [];
      let ready = true;
      const at = (
        await tx.query<{ at: Date }>("SELECT clock_timestamp() at")
      ).rows[0]!.at.toISOString();
      for (const id of [q.paper_account_id, q.stress_account_id].sort()) {
        const l = await loadJevAccountTx(tx, owner, id, true);
        await tx.query(
          "UPDATE jev_worker_controls SET entries_paused=true,operator_close_requested=true WHERE account_id=$1",
          [id],
        );
        await cancelJevEntriesTx(tx, id);
        const flat = (
          await tx.query<{ ready: boolean }>(
            "SELECT jev_account_reconciled_flat($1) AS ready",
            [id],
          )
        ).rows[0]!.ready;
        if (!flat || !(await jevFundingEvidenceReadyTx(tx, id, l.events, at)))
          ready = false;
        original.push({
          account_id: id,
          ledger: l.projection,
          last_sequence: l.projection.last_sequence,
        });
      }
      if (!ready) continue;
      await tx.query(
        "UPDATE jev_worker_controls SET admitted=false,entries_paused=true WHERE account_id=ANY($1::text[])",
        [[q.paper_account_id, q.stress_account_id]],
      );
      for (const id of [q.paper_experiment_id, q.stress_experiment_id])
        await tx.query(
          "INSERT INTO jev_evidence_closures(experiment_id,closed_at,reason) VALUES($1,$2,'profile_failed_reconciled') ON CONFLICT DO NOTHING",
          [id, at],
        );
      await tx.query(
        "INSERT INTO jev_pair_retirements(slot,owner_id,profile_id,profile_version,original) VALUES($1,$2,$3,$4,$5::jsonb)",
        [
          q.slot,
          owner,
          q.profile_id,
          q.profile_version,
          JSON.stringify(original),
        ],
      );
      retired.push(q.slot);
    }
    return {
      retired_slots: retired,
      waiting_reconciliation: rows.length - retired.length,
    };
  });
}
export async function admitJevSuccessor(
  pool: Pick<DatabasePool, "transaction">,
  owner: string,
  model: string,
) {
  return withBtcRetentionTransaction(pool, async (tx) => {
    const q = await readJevQueueTx(tx, owner);
    if (!q.proposal_ids.length) return { status: "waiting" };
    const slot = (
      await tx.query<JevPairSlot>(
        "SELECT q.* FROM jev_latest_pairs q JOIN jev_pair_retirements r USING(owner_id,profile_id,profile_version) WHERE q.owner_id=$1 ORDER BY q.slot LIMIT 1",
        [owner],
      )
    ).rows[0];
    if (!slot) return { status: "no_vacancy" };
    const p = (
      await tx.query<JevProposal & { fingerprint: string }>(
        "SELECT * FROM jev_proposals WHERE owner_id=$1 AND proposal_id=$2",
        [owner, q.proposal_ids[0]],
      )
    ).rows[0]!;
    const validation = (
      await tx.query(
        "SELECT 1 FROM jev_proposal_requests r JOIN jev_proposal_results s USING(origin,request_id) WHERE r.owner_id=$1 AND r.proposal_id=$2 AND r.origin='real' AND r.model=$3 AND s.reason='ok' AND s.rank>0 AND s.cost_usd6 IS NOT NULL",
        [owner, p.proposal_id, model],
      )
    ).rowCount;
    if (!validation) return { status: "validation_unavailable" };
    const now = (
      await tx.query<{ at: Date }>("SELECT clock_timestamp() at")
    ).rows[0]!.at.toISOString();
    const profile: JevProfile = {
      schema_version: JEV_VERSION,
      owner_id: owner,
      profile_id: p.profile_id,
      profile_version: p.profile_version,
      manifest_hash: p.fingerprint,
      horizon_minutes: p.manifest.horizon_minutes,
      created_at: now,
    };
    const priorControl = (
      await tx.query<{
        cost_evidence_id: string | null;
        funding_debit_rate9_raw: string | null;
      }>(
        "SELECT cost_evidence_id,funding_debit_rate9_raw::text FROM jev_worker_controls WHERE account_id=$1",
        [slot.paper_account_id],
      )
    ).rows[0];
    if (
      !priorControl?.cost_evidence_id ||
      priorControl.funding_debit_rate9_raw === null
    )
      return { status: "risk_contract_pending" };
    const old = await loadJevAccountTx(tx, owner, slot.paper_account_id, true);
    const ids = {
      paper: `paper:${p.fingerprint}`,
      stress: `stress:${p.fingerprint}`,
    };
    const pair: JevPairSlot = {
      slot: slot.slot,
      owner_id: owner,
      profile_id: profile.profile_id,
      profile_version: profile.profile_version,
      paper_account_id: ids.paper,
      stress_account_id: ids.stress,
      paper_experiment_id: `experiment:${ids.paper}`,
      stress_experiment_id: `experiment:${ids.stress}`,
    };
    const active = (
      await tx.query<JevPairSlot>(
        "SELECT * FROM jev_active_pairs ORDER BY slot",
      )
    ).rows;
    const prospectiveHash = jevHash(
      [...active, pair].sort((a, b) => a.slot - b.slot),
    );
    const control = (
      await tx.query<{
        enabled: boolean;
        admission_reference: string;
        successor_capacity_evidence_id: string | null;
      }>("SELECT * FROM jev_generator_controls WHERE owner_id=$1", [owner])
    ).rows[0];
    if (
      !control?.enabled ||
      !(await readJevDispatchCapacityTx(
        tx,
        control.successor_capacity_evidence_id,
        prospectiveHash,
        model,
        Date.parse(now),
      ))
    )
      return { status: "capacity_pending" };
    const sources = await readSourceReadinessTx(tx, new Date(now));
    const worker = (
      await tx.query(
        "SELECT 1 FROM jev_worker_observation o JOIN execution_worker_head h USING(singleton) WHERE o.generation=h.generation AND h.lease_until>clock_timestamp() AND o.observed_at BETWEEN clock_timestamp()-interval '5 seconds' AND clock_timestamp() AND o.payload->>'backend_ready'='true'",
      )
    ).rowCount;
    if (
      !worker ||
      sources.channels.length !== 2 ||
      sources.channels.some((c) => c.status !== "fresh") ||
      sources.capture?.channels?.trades?.status !== "healthy" ||
      sources.capture.channels.trades.needs_revalidation !== false ||
      sources.capture.history_truncated
    )
      return { status: "readiness_pending" };
    await registerProfileTx(tx, profile, p.manifest);
    for (const mode of ["paper", "stress"] as const) {
      const account = {
        ...old.identity.account,
        account_id: ids[mode],
        mode,
        started_at: now,
      };
      const binding = {
        schema_version: JEV_VERSION,
        owner_id: owner,
        account_id: ids[mode],
        mode,
        profile_id: profile.profile_id,
        profile_version: profile.profile_version,
        experiment_id: pair[`${mode}_experiment_id`],
        started_at: now,
      };
      await createAccountTx(tx, {
        account,
        instrument: old.identity.instrument,
        bindings: [{ profile, binding }],
      });
    }
    await tx.query(
      "INSERT INTO jev_pair_epochs(slot,owner_id,profile_id,profile_version,paper_account_id,stress_account_id,paper_experiment_id,stress_experiment_id,proposal_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        pair.slot,
        owner,
        pair.profile_id,
        pair.profile_version,
        pair.paper_account_id,
        pair.stress_account_id,
        pair.paper_experiment_id,
        pair.stress_experiment_id,
        p.proposal_id,
      ],
    );
    await queueSnapshotTx(
      tx,
      owner,
      `admit:${p.proposal_id}`,
      q.revision,
      "admission",
      { slot: pair.slot, proposal_id: p.proposal_id },
      q.proposal_ids.slice(1),
    );
    await proposalEventTx(
      tx,
      owner,
      p.proposal_id,
      `admitted:${p.proposal_id}`,
      "admitted",
      "Novo par paper/stress; histórico anterior preservado",
      { slot: pair.slot },
    );
    for (const id of [ids.paper, ids.stress])
      await tx.query(
        "INSERT INTO jev_worker_controls(account_id,admitted,entries_paused,admission_reference,capacity_evidence_id,cost_evidence_id,funding_debit_rate9_raw) SELECT $1,true,false,$2,$3,cost_evidence_id,funding_debit_rate9_raw FROM jev_worker_controls WHERE account_id=$4",
        [
          id,
          control.admission_reference,
          control.successor_capacity_evidence_id,
          slot.paper_account_id,
        ],
      );
    // This measured proof covers the entire prospective registry. Retain every
    // existing account's pause/admission choices while updating its capacity reference.
    await tx.query(
      "UPDATE jev_worker_controls SET capacity_evidence_id=$1 WHERE account_id IN(SELECT paper_account_id FROM jev_active_pairs UNION SELECT stress_account_id FROM jev_active_pairs)",
      [control.successor_capacity_evidence_id],
    );
    await tx.query(
      "UPDATE jev_generator_controls SET capacity_evidence_id=$1,successor_capacity_evidence_id=NULL WHERE owner_id=$2",
      [control.successor_capacity_evidence_id, owner],
    );
    requireJev(
      (
        await tx.query(
          "SELECT 1 FROM jev_worker_controls WHERE account_id=ANY($1::text[]) AND admitted",
          [[ids.paper, ids.stress]],
        )
      ).rowCount === 2,
      "SUCCESSOR_CONTROL",
    );
    return {
      status: "admitted",
      slot: pair.slot,
      profile_id: profile.profile_id,
    };
  });
}
