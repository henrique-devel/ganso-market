import { loadJevAccountTx } from "./jev-store.js";
import { jevScope } from "./jev-ledger.js";
import { jevEpisodes } from "./jev-evaluation.js";
import { randomUUID } from "node:crypto";
import type { DatabasePool, SqlExecutor } from "../database.js";
import { withBtcRetentionTransaction } from "./btc-retention.js";
import { jevHash } from "./jev-hash.js";
import { validateJevSuccessor, type JevManifest } from "./jev-manifest.js";
import { storeJevProposalTx, proposalEventTx } from "./jev-proposals.js";
import { readJevQueueTx, queueSnapshotTx } from "./jev-queue.js";
import { quote, type JevTariff } from "../models/jev-contract.js";
import {
  deriveProposalResult,
  JEV_PROPOSAL_POLICY,
  JEV_PROPOSAL_QUESTION,
  type ProposalTransport,
} from "../models/jev-proposal.js";
import {
  readJevDispatchCapacityTx,
  jevDispatchRegistryHashTx,
} from "./jev-dispatch-capacity.js";
export function successorCandidates(m: JevManifest) {
  const candidates: JevManifest[] = [];
  for (const h of m.generator.horizon_minutes)
    if (h !== m.horizon_minutes) candidates.push({ ...m, horizon_minutes: h });
  for (const w of m.generator.trade_window_seconds)
    if (w !== m.context.trade_window_seconds)
      candidates.push({
        ...m,
        context: { ...m.context, trade_window_seconds: w },
      });
  for (const set of m.generator.information_sets)
    if (jevHash(set) !== jevHash(m.context.information_set))
      candidates.push({
        ...m,
        context: { ...m.context, information_set: set },
      });
  candidates.forEach((next) => validateJevSuccessor(m, next));
  return candidates;
}
export async function closedGenerationSourceTx(
  tx: SqlExecutor,
  owner: string,
  seen?: ReadonlySet<string>,
) {
  const sources = (
    await tx.query<{
      profile_id: string;
      profile_version: string;
      manifest: JevManifest;
      evidence_id: string;
      original: unknown;
    }>(
      `SELECT p.profile_id,p.profile_version,p.manifest,e.evidence_id,o.envelope->'payload'->'original' AS original FROM jev_profiles p JOIN LATERAL(SELECT * FROM jev_evaluation_cuts WHERE owner_id=p.owner_id AND profile_id=p.profile_id AND profile_version=p.profile_version AND state='failed' ORDER BY as_of DESC LIMIT 1)e ON true JOIN jev_evidence_objects o ON o.object_id=e.evidence_id WHERE p.owner_id=$1 AND e.as_of<=clock_timestamp() AND (SELECT count(*) FROM jev_bindings b JOIN jev_evidence_closures c USING(experiment_id) WHERE b.owner_id=p.owner_id AND b.profile_id=p.profile_id AND b.profile_version=p.profile_version AND b.mode IN('paper','stress') AND c.closed_at<=clock_timestamp())=2 AND jsonb_array_length(o.envelope#>'{payload,original,accounts}')=2 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(o.envelope#>'{payload,original,accounts}') a WHERE COALESCE((a->>'episodes')::int,0)<$2) ORDER BY e.as_of,p.profile_id`,
      [owner, JEV_PROPOSAL_POLICY.minimum_closed_episodes_per_account],
    )
  ).rows;
  for (const source of sources) {
    if (
      seen &&
      !successorCandidates(source.manifest).some((m) => !seen.has(jevHash(m)))
    )
      continue;
    const ids = (
      await tx.query<{ account_id: string }>(
        "SELECT account_id FROM jev_bindings WHERE owner_id=$1 AND profile_id=$2 AND profile_version=$3 AND mode IN('paper','stress') ORDER BY account_id",
        [owner, source.profile_id, source.profile_version],
      )
    ).rows;
    const at = (
      await tx.query<{ at: Date }>("SELECT clock_timestamp() at")
    ).rows[0]!.at.toISOString();
    let ready = ids.length === 2;
    for (const { account_id } of ids) {
      const l = await loadJevAccountTx(tx, owner, account_id, true);
      const b = l.identity.bindings[0]!.binding;
      const episodes = jevEpisodes(
        l.identity,
        l.events,
        jevScope(b, l.identity.instrument),
        { start_at: b.started_at, end_at: at },
      );
      if (
        episodes.closed_count <
          JEV_PROPOSAL_POLICY.minimum_closed_episodes_per_account ||
        episodes.open_count > 0 ||
        !(
          await tx.query<{ ready: boolean }>(
            "SELECT jev_account_reconciled_flat($1) ready",
            [account_id],
          )
        ).rows[0]!.ready
      )
        ready = false;
    }
    if (ready) return source;
  }
  return null;
}
export async function generationEnabledTx(
  tx: SqlExecutor,
  owner: string,
  model: string,
) {
  const control = (
    await tx.query<{ enabled: boolean; capacity_evidence_id: string }>(
      "SELECT enabled,capacity_evidence_id FROM jev_generator_controls WHERE owner_id=$1 FOR UPDATE",
      [owner],
    )
  ).rows[0];
  return (
    !!control?.enabled &&
    (await readJevDispatchCapacityTx(
      tx,
      control.capacity_evidence_id,
      await jevDispatchRegistryHashTx(tx),
      model,
      Date.now(),
    ))
  );
}
/** Dormant single persistent attempt; caller must supply separately admitted controls. */
export async function generateJevProposal(
  pool: Pick<DatabasePool, "transaction">,
  owner: string,
  tariff: JevTariff,
  transport: ProposalTransport,
  options: { enabled: boolean; signal?: AbortSignal },
) {
  if (!options.enabled) return { status: "disabled" };
  if (options.signal?.aborted) return { status: "cancelled" };
  const reservation = await withBtcRetentionTransaction(pool, async (tx) => {
    const expired = (
      await tx.query<{
        origin: string;
        request_id: string;
        proposal_id: string;
      }>(
        "SELECT r.origin,r.request_id,r.proposal_id FROM jev_proposal_requests r LEFT JOIN jev_proposal_results s USING(origin,request_id) WHERE r.owner_id=$1 AND s.request_id IS NULL AND r.deadline_at<=clock_timestamp() LIMIT 4",
        [owner],
      )
    ).rows;
    for (const r of expired) {
      await tx.query(
        "INSERT INTO jev_proposal_results(origin,request_id,reason) VALUES($1,$2,'recovered_uncertain')",
        [r.origin, r.request_id],
      );
      await proposalEventTx(
        tx,
        owner,
        r.proposal_id,
        `uncertain:${r.request_id}`,
        "unavailable",
        "Consumo incerto após reinício",
        r,
      );
    }
    if (!(await generationEnabledTx(tx, owner, tariff.model))) return null;
    const q = await readJevQueueTx(tx, owner),
      pending = (
        await tx.query<{ n: number }>(
          "SELECT count(*)::int n FROM jev_proposal_requests r LEFT JOIN jev_proposal_results s USING(origin,request_id) WHERE r.owner_id=$1 AND s.request_id IS NULL",
          [owner],
        )
      ).rows[0]!.n;
    if (q.proposal_ids.length + pending >= 3) return null;
    const hashes = new Set(
      (
        await tx.query<{ fingerprint: string }>(
          "SELECT fingerprint FROM jev_proposals WHERE owner_id=$1 UNION SELECT manifest_hash FROM jev_profiles WHERE owner_id=$1",
          [owner],
        )
      ).rows.map((r) => r.fingerprint),
    );
    // An accepted result that lost its vacancy can be appended later, without another paid request.
    const waiting = (
      await tx.query<{ proposal_id: string; request_id: string }>(
        "SELECT r.proposal_id,r.request_id FROM jev_proposal_requests r JOIN jev_proposal_results s USING(origin,request_id) WHERE r.owner_id=$1 AND r.model=$2 AND s.reason='ok' AND s.rank>0 AND s.cost_usd6 IS NOT NULL AND NOT(r.proposal_id=ANY($3::text[])) AND EXISTS(SELECT 1 FROM jev_proposal_events e WHERE e.owner_id=r.owner_id AND e.proposal_id=r.proposal_id AND e.kind='approved') AND NOT EXISTS(SELECT 1 FROM jev_proposal_events e WHERE e.owner_id=r.owner_id AND e.proposal_id=r.proposal_id AND e.kind IN('withdrawn','rejected','vetoed','admitted')) ORDER BY s.rank DESC,r.started_at,r.request_id LIMIT 1",
        [owner, tariff.model, q.proposal_ids],
      )
    ).rows[0];
    if (waiting && (await closedGenerationSourceTx(tx, owner))) {
      await queueSnapshotTx(
        tx,
        owner,
        `enqueue:${waiting.request_id}`,
        q.revision,
        "enqueue",
        { proposal_id: waiting.proposal_id },
        [...q.proposal_ids, waiting.proposal_id],
      );
      return null;
    }
    const source = await closedGenerationSourceTx(tx, owner, hashes);
    if (!source) return null;
    const now = (
        await tx.query<{ at: Date }>("SELECT clock_timestamp() at")
      ).rows[0]!.at.toISOString(),
      deadline = new Date(Date.parse(now) + 1500).toISOString(),
      reserved = quote(tariff, transport.model, deadline);
    if (!reserved) return null;
    const budget = (
      await tx.query<{
        enabled: boolean;
        circuit_open: boolean;
        tariff_hash: string;
        used: string;
        limit_usd6: string;
      }>(
        "SELECT enabled,circuit_open,tariff_hash,jev_generation_consumed(origin,month)::text used,limit_usd6::text FROM jev_cost_pools WHERE origin=$1 AND purpose='generation_validation' AND month=$2 FOR UPDATE",
        [transport.origin, now.slice(0, 7)],
      )
    ).rows[0];
    if (
      !budget?.enabled ||
      budget.circuit_open ||
      budget.tariff_hash !== jevHash(tariff) ||
      BigInt(budget.used) + BigInt(reserved) > BigInt(budget.limit_usd6)
    )
      return null;
    const next = successorCandidates(source.manifest).find(
      (m) => !hashes.has(jevHash(m)),
    );
    if (!next) return null;
    const id = `proposal:${jevHash(next)}`,
      requestId = `validation:${jevHash([owner, id])}`,
      token = randomUUID();
    await storeJevProposalTx(tx, {
      owner_id: owner,
      proposal_id: id,
      parent_profile_id: source.profile_id,
      parent_profile_version: source.profile_version,
      profile_id: id,
      profile_version: JEV_PROPOSAL_POLICY.version,
      manifest: next,
      reason: "Uma mudança no template após reprovação encerrada",
    });
    const payload = {
      model: transport.model,
      state: {
        parent: source.manifest,
        proposal: next,
        closed_history: source.original,
        history_reference: source.evidence_id,
        policy: JEV_PROPOSAL_POLICY,
      },
      questions: { aptitude: JEV_PROPOSAL_QUESTION },
    };
    await tx.query(
      "INSERT INTO jev_proposal_requests(origin,request_id,owner_id,proposal_id,pool_month,token,model,tariff,payload,reserved_usd6,deadline_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)",
      [
        transport.origin,
        requestId,
        owner,
        id,
        now.slice(0, 7),
        token,
        transport.model,
        JSON.stringify(tariff),
        JSON.stringify(payload),
        reserved,
        deadline,
      ],
    );
    return { id, requestId, deadline, payload, token };
  });
  if (!reservation) return { status: "waiting" };
  let wire: null | Awaited<ReturnType<ProposalTransport["evaluate"]>> = null,
    failure = "provider_error";
  const signal = AbortSignal.any([
    AbortSignal.timeout(
      Math.max(1, Date.parse(reservation.deadline) - Date.now()),
    ),
    ...(options.signal ? [options.signal] : []),
  ]);
  try {
    signal.throwIfAborted();
    wire = await transport.evaluate(reservation.payload, signal);
  } catch {
    failure = signal.aborted ? "timeout" : "provider_error";
  }
  const result = deriveProposalResult(
    wire,
    tariff,
    reservation.deadline,
    failure,
  );
  return withBtcRetentionTransaction(pool, async (tx) => {
    const old = (
      await tx.query(
        "SELECT reason FROM jev_proposal_results WHERE origin=$1 AND request_id=$2",
        [transport.origin, reservation.requestId],
      )
    ).rows[0];
    if (old) return { status: "recovered_uncertain" };
    await tx.query(
      "INSERT INTO jev_proposal_results(origin,request_id,cost_usd6,reason,rank,original_response,response_hash,usage,judgment) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)",
      [
        transport.origin,
        reservation.requestId,
        result.cost_usd6,
        result.reason,
        result.rank,
        result.original_response,
        result.response_hash,
        JSON.stringify(result.usage),
        JSON.stringify(result.judgment),
      ],
    );
    const terminal = (
      await tx.query(
        "SELECT 1 FROM jev_proposal_events WHERE owner_id=$1 AND proposal_id=$2 AND kind IN('withdrawn','rejected','vetoed','admitted')",
        [owner, reservation.id],
      )
    ).rowCount;
    if (terminal) return { status: "withdrawn", result };
    const kind =
      result.reason !== "ok"
        ? "unavailable"
        : result.rank! > 0
          ? "approved"
          : "vetoed";
    await proposalEventTx(
      tx,
      owner,
      reservation.id,
      `result:${reservation.requestId}`,
      kind,
      kind === "approved"
        ? "Aptidão técnica JEV; sem aprovação econômica"
        : result.reason,
      { request_id: reservation.requestId, origin: transport.origin },
    );
    const q = await readJevQueueTx(tx, owner);
    if (
      kind === "approved" &&
      q.proposal_ids.length < 3 &&
      (await generationEnabledTx(tx, owner, tariff.model)) &&
      (await closedGenerationSourceTx(tx, owner))
    )
      await queueSnapshotTx(
        tx,
        owner,
        `enqueue:${reservation.requestId}`,
        q.revision,
        "enqueue",
        { proposal_id: reservation.id },
        [...q.proposal_ids, reservation.id],
      );
    return { status: kind, result };
  });
}
