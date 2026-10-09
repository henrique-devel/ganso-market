import type { DatabasePool, SqlExecutor } from "../database.js";
import type { JevScope, JevBinding } from "@ganso-market/contracts/trading";
import { JevPanelCommandError } from "./jev-infrastructure.js";
import { withBtcRetentionTransaction } from "./btc-retention.js";
import { assessJevProfileTx } from "./jev-evaluationstore.js";
import { readJevReadinessTx } from "./jev-readiness.js";
import { readJevPilotTx, commandJevPilotTx } from "./jev-pilotstore.js";
import { readJevEntriesTx, cancelJevEntriesTx } from "./jev-riskstore.js";
import { jevHash } from "./jev-hash.js";
import { jevScope } from "./jev-ledger.js";
import { loadJevAccountTx } from "./jev-store.js";
import { makeJevEvidence, storeJevEvidenceTx } from "./jev-evidence.js";
import type { LiveSnapshot } from "../venues/hyperliquid/live-reconcile.js";
import type { LiveIdentity } from "../venues/hyperliquid/live-contract.js";
import type { LiveBalanceProof } from "./jev-live-store.js";

export const JEV_LIVE_LIMITS = Object.freeze({
  capital_usd6: "250000000",
  entry_risk_bps: 100,
  exposure_bps: 5000,
  daily_loss_bps: 200,
  drawdown_usd6: "12500000",
  leverage: 1,
  margin: "isolated",
});
type Pool = Pick<DatabasePool, "transaction">;
type Promotion = {
  sequence: string;
  state: "active" | "draining" | "waiting";
  profile_id: string;
  profile_version: string;
  experiment_id: string;
};
type Candidate = { profile_id: string; profile_version: string; slot: number };
export async function readJevPromotionTx(tx: SqlExecutor, account: string) {
  return (
    (
      await tx.query<Promotion>(
        "SELECT sequence::text,state,profile_id,profile_version,experiment_id FROM jev_live_promotions WHERE account_id=$1 ORDER BY sequence DESC LIMIT 1",
        [account],
      )
    ).rows[0] ?? null
  );
}
async function nowTx(tx: SqlExecutor) {
  return (
    await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
  ).rows[0]!.now.toISOString();
}
async function identityTx(tx: SqlExecutor, owner: string) {
  return (
    (
      await tx.query<{
        identity_hash: string;
        account_id: string;
        identity: LiveIdentity;
      }>(
        "SELECT i.identity_hash,i.account_id,i.identity FROM jev_live_identities i JOIN jev_accounts a USING(account_id) WHERE i.owner_id=$1 AND a.owner_id=$1 AND a.mode='live' AND i.environment='mainnet' LIMIT 1",
        [owner],
      )
    ).rows[0] ?? null
  );
}
async function lockTx(tx: SqlExecutor, owner: string) {
  // Same retention lock/order as paper handoff and risk/evidence writers.
  await tx.query(
    "SELECT account_id FROM jev_accounts WHERE owner_id=$1 ORDER BY account_id FOR UPDATE",
    [owner],
  );
  await tx.query(
    "SELECT account_id FROM jev_worker_controls WHERE account_id IN(SELECT account_id FROM jev_accounts WHERE owner_id=$1) ORDER BY account_id FOR UPDATE",
    [owner],
  );
}
async function candidatesTx(tx: SqlExecutor, owner: string) {
  // First eligible, without waiting for the other pairs. Persisted proposal
  // order breaks succession ties; it never replaces a healthy live profile.
  return (
    await tx.query<Candidate>(
      `SELECT p.profile_id,p.profile_version,p.slot FROM jev_active_pairs p LEFT JOIN jev_pair_epochs e USING(owner_id,profile_id,profile_version)
  LEFT JOIN LATERAL (SELECT array_position(q.proposal_ids,e.proposal_id) priority FROM jev_queue_snapshots q WHERE q.owner_id=p.owner_id AND e.proposal_id=ANY(q.proposal_ids) ORDER BY revision DESC LIMIT 1) q ON true
  WHERE p.owner_id=$1 ORDER BY q.priority NULLS LAST,(SELECT MIN(as_of) FROM jev_evaluation_cuts c WHERE c.owner_id=p.owner_id AND c.profile_id=p.profile_id AND c.profile_version=p.profile_version AND c.state='eligible'),p.slot LIMIT 3`,
      [owner],
    )
  ).rows;
}
export async function jevPromotionGateTx(
  tx: SqlExecutor,
  owner: string,
  profile?: Candidate,
  settlementOnly = false,
) {
  const at = await nowTx(tx),
    i = await identityTx(tx, owner),
    reasons: string[] = [];
  const readiness = settlementOnly
    ? null
    : await readJevReadinessTx(tx, owner, at);
  if (!readiness?.qualification.qualified) reasons.push("engine_not_qualified");
  if (!i) reasons.push("live_identity_missing");
  const pilot = i ? await readJevPilotTx(tx, i.account_id) : null;
  if (!pilot?.checkpoint.supervisor_authorized)
    reasons.push("pilot_supervisor_not_ready");
  if (pilot?.checkpoint.global_blocked) reasons.push("global_drawdown_blocked");
  if (!pilot || pilot.checkpoint.risk.entries_paused)
    reasons.push("daily_or_global_risk_paused");
  const venue = i
    ? (
        await tx.query<{ evidence_id: string; verified: boolean }>(
          "SELECT evidence_id,verified FROM jev_live_venue_validations WHERE identity_hash=$1 ORDER BY recorded_at DESC,evidence_id DESC LIMIT 1",
          [i.identity_hash],
        )
      ).rows[0]
    : null;
  if (!venue?.verified) reasons.push("venue_not_verified");
  const rows = i
    ? (
        await tx.query<{
          kind: string;
          payload: LiveSnapshot;
          recorded_at: Date;
        }>(
          "SELECT DISTINCT ON(kind) kind,payload,recorded_at FROM jev_live_events WHERE identity_hash=$1 AND kind IN('snapshot','gap') ORDER BY kind,recorded_at DESC,event_key DESC",
          [i.identity_hash],
        )
      ).rows
    : [];
  const s = rows.find((r) => r.kind === "snapshot"),
    gap = rows.find((r) => r.kind === "gap"),
    snapshot = s?.payload ?? null;
  const balance =
    i && snapshot
      ? (
          await tx.query<{ payload: LiveBalanceProof }>(
            "SELECT payload FROM jev_live_events WHERE identity_hash=$1 AND kind='balance' AND payload->>'snapshot_id'=$2 ORDER BY recorded_at DESC LIMIT 1",
            [i.identity_hash, snapshot.snapshot_id],
          )
        ).rows[0]?.payload
      : null;
  const clock = Date.parse(at);
  const fresh =
    !!snapshot &&
    snapshot.started_at <= snapshot.venue_at &&
    snapshot.venue_at <= snapshot.received_at &&
    snapshot.received_at <= clock &&
    clock - snapshot.started_at <= 2000;
  const reconciled =
    fresh &&
    snapshot?.consistent &&
    snapshot.history_complete &&
    snapshot.isolated_1x &&
    balance?.reconciled &&
    balance.identity_hash === i?.identity_hash &&
    (!gap || (!!s && gap.recorded_at < s.recorded_at));
  if (!reconciled) reasons.push("live_reconciliation_pending");
  if (
    !pilot ||
    !snapshot ||
    pilot.checkpoint.observation.evidence_id !== snapshot.snapshot_id ||
    pilot.checkpoint.observation.reconciled !== true
  )
    reasons.push("pilot_observation_pending");
  const flat =
    !!reconciled &&
    snapshot?.flat === true &&
    snapshot.position_raw === "0" &&
    snapshot.open_pnl_raw === "0" &&
    snapshot.orders.length === 0;
  const entries = i ? await readJevEntriesTx(tx, i.account_id) : [];
  const uncertain = i
    ? !!(
        await tx.query(
          `SELECT 1 FROM jev_live_requests r WHERE r.identity_hash=$1 AND r.reservation->>'kind' IN('entry','close','cancel') AND (COALESCE((SELECT e.payload->>'state' FROM jev_live_events e WHERE e.identity_hash=r.identity_hash AND e.kind='receipt' AND e.payload->>'operation_id'=r.operation_id ORDER BY recorded_at DESC,event_key DESC LIMIT 1),'uncertain') NOT IN('filled','cancelled','rejected') OR COALESCE((SELECT (e.payload->>'observed_at')::bigint FROM jev_live_events e WHERE e.identity_hash=r.identity_hash AND e.kind='receipt' AND e.payload->>'operation_id'=r.operation_id ORDER BY recorded_at DESC,event_key DESC LIMIT 1),0)>$2) LIMIT 1`,
          [i.identity_hash, snapshot?.venue_at ?? 0],
        )
      ).rowCount
    : false;
  const settled =
    flat && !uncertain && entries.every((e) => e.status === "released");
  let selected = profile ?? null,
    assessment: Awaited<ReturnType<typeof assessJevProfileTx>> | null = null;
  for (const p of !i || settlementOnly
    ? []
    : profile
      ? [profile]
      : await candidatesTx(tx, owner)) {
    const current = await assessJevProfileTx(
      tx,
      owner,
      p.profile_id,
      p.profile_version,
      at,
    );
    if (profile || current.result.state === "eligible") {
      selected = p;
      assessment = current;
      break;
    }
  }
  if (assessment?.result.state !== "eligible")
    reasons.push("profile_not_currently_eligible");
  const activated = i
    ? ((
        await tx.query<{ idempotency_key: string }>(
          "SELECT idempotency_key FROM jev_live_activations WHERE account_id=$1 AND owner_id=$2 AND identity_hash=$3",
          [i.account_id, owner, i.identity_hash],
        )
      ).rows[0] ?? null)
    : null;
  return {
    at,
    i,
    pilot,
    readiness,
    venue,
    snapshot,
    reconciled: !!reconciled,
    settled,
    selected,
    assessment,
    activated,
    reasons,
    ready: reasons.length === 0,
  };
}
async function appendPromotionTx(
  tx: SqlExecutor,
  owner: string,
  gate: Pick<
    Awaited<ReturnType<typeof jevPromotionGateTx>>,
    | "at"
    | "i"
    | "pilot"
    | "readiness"
    | "venue"
    | "snapshot"
    | "selected"
    | "assessment"
    | "ready"
  >,
  state: Promotion["state"],
  previous: Promotion | null,
) {
  const i = gate.i!,
    p = gate.selected!,
    next = (BigInt(previous?.sequence ?? "0") + 1n).toString();
  let experiment_id =
    previous?.experiment_id ??
    `live:${jevHash([i.account_id, p.profile_id, p.profile_version])}`;
  if (state === "active") {
    const old = (
      await tx.query<{ experiment_id: string }>(
        "SELECT experiment_id FROM jev_bindings WHERE account_id=$1 AND profile_id=$2 AND profile_version=$3 AND mode='live'",
        [i.account_id, p.profile_id, p.profile_version],
      )
    ).rows[0];
    experiment_id =
      old?.experiment_id ??
      `live:${jevHash([i.account_id, p.profile_id, p.profile_version])}`;
    const binding: JevBinding = {
      schema_version: "trading.jev.v2",
      owner_id: owner,
      account_id: i.account_id,
      mode: "live",
      profile_id: p.profile_id,
      profile_version: p.profile_version,
      experiment_id,
      started_at: gate.at,
    };
    if (!old)
      await tx.query(
        "INSERT INTO jev_bindings(experiment_id,owner_id,account_id,mode,profile_id,profile_version,binding) VALUES($1,$2,$3,'live',$4,$5,$6::jsonb)",
        [
          experiment_id,
          owner,
          i.account_id,
          p.profile_id,
          p.profile_version,
          JSON.stringify(binding),
        ],
      );
  }
  const ledger = await loadJevAccountTx(tx, owner, i.account_id);
  const binding = ledger.identity.bindings.find(
    (b) => b.binding.experiment_id === experiment_id,
  )!;
  const proof = {
    ready: gate.ready,
    limits: JEV_LIVE_LIMITS,
    pilot_sequence: gate.pilot!.sequence,
    qualification: gate.readiness?.qualification.evidence_id ?? null,
    venue_validation: gate.venue?.evidence_id ?? null,
    assessment: gate.assessment?.result ?? null,
    snapshot: gate.snapshot,
  };
  const evidence_id = `jev-live-promotion:${i.account_id}:${next}`;
  await storeJevEvidenceTx(
    tx,
    makeJevEvidence({
      object_id: evidence_id,
      scope: jevScope(binding.binding, ledger.identity.instrument),
      kind: "result",
      recorded_at: gate.at,
      payload: { artifact_id: evidence_id, original: proof },
      dependencies: [
        ...new Set([
          ...(gate.assessment?.dependencies ?? []),
          ...(gate.venue ? [gate.venue.evidence_id] : []),
          ...(gate.readiness?.qualification.evidence_id
            ? [gate.readiness.qualification.evidence_id]
            : []),
        ]),
      ],
      sources: [...new Set(gate.assessment?.sources ?? [])],
    }),
  );
  await tx.query(
    "INSERT INTO jev_live_promotions(account_id,owner_id,sequence,state,profile_id,profile_version,experiment_id,proof) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
    [
      i.account_id,
      owner,
      next,
      state,
      p.profile_id,
      p.profile_version,
      experiment_id,
      JSON.stringify(proof),
    ],
  );
  if (state === "active") {
    await commandJevPilotTx(tx, owner, i.account_id, {
      operation_id: `promote:${next}`,
      expected_sequence: gate.pilot!.sequence,
      action: "automatic_profile",
      experiment_id,
      observation: gate.pilot!.checkpoint.observation,
    });
    if (previous)
      await tx.query(
        "INSERT INTO jev_evidence_closures(experiment_id,closed_at,reason) VALUES($1,$2,'live_failed_reconciled') ON CONFLICT DO NOTHING",
        [previous.experiment_id, gate.at],
      );
  }
  return {
    sequence: next,
    state,
    profile_id: p.profile_id,
    profile_version: p.profile_version,
    experiment_id,
  };
}
export async function advanceJevPromotion(pool: Pool, owner: string) {
  return withBtcRetentionTransaction(pool, async (tx) => {
    await lockTx(tx, owner);
    const i = await identityTx(tx, owner);
    if (!i) return { status: "not_admitted" as const };
    let previous = await readJevPromotionTx(tx, i.account_id);
    if (previous) {
      const failed = !!(
        await tx.query(
          "SELECT 1 FROM jev_evaluation_cuts WHERE owner_id=$1 AND profile_id=$2 AND profile_version=$3 AND state='failed' AND as_of<=clock_timestamp() LIMIT 1",
          [owner, previous.profile_id, previous.profile_version],
        )
      ).rowCount;
      if (!failed) return { status: "healthy" as const, promotion: previous };
      // A persisted reproval requests exits even while an eligibility/engine gate is closed.
      await cancelJevEntriesTx(tx, i.account_id);
      if (previous.state === "active") {
        // Exits must remain possible when financial evaluation/qualification is
        // unavailable. The immutable failed cut alone starts the drain.
        const draining = await appendPromotionTx(
          tx,
          owner,
          {
            at: await nowTx(tx),
            i,
            pilot: await readJevPilotTx(tx, i.account_id),
            readiness: null,
            venue: null,
            snapshot: null,
            selected: { ...previous, slot: 0 },
            assessment: null,
            ready: false,
          },
          "draining",
          previous,
        );
        return { status: "draining" as const, promotion: draining };
      }
      const settlement = await jevPromotionGateTx(tx, owner, undefined, true);
      if (!settlement.settled)
        return { status: "draining" as const, promotion: previous };
      if (previous.state === "draining") {
        await tx.query(
          "INSERT INTO jev_evidence_closures(experiment_id,closed_at,reason) VALUES($1,$2,'live_failed_reconciled') ON CONFLICT DO NOTHING",
          [previous.experiment_id, settlement.at],
        );
        previous = await appendPromotionTx(
          tx,
          owner,
          { ...settlement, selected: { ...previous, slot: 0 } },
          "waiting",
          previous,
        );
      }
    }
    const gate = await jevPromotionGateTx(tx, owner);
    if (!gate.activated || !gate.ready || !gate.settled)
      return {
        status: "waiting" as const,
        reasons: [
          ...gate.reasons,
          ...(!gate.activated ? ["operator_activation_required"] : []),
          ...(!gate.settled ? ["flat_reconciliation_required"] : []),
        ],
        ...(previous ? { promotion: previous } : {}),
      };
    if (
      previous &&
      gate.selected?.profile_id === previous.profile_id &&
      gate.selected.profile_version === previous.profile_version
    )
      return { status: "waiting" as const };
    const promotion = await appendPromotionTx(
      tx,
      owner,
      gate,
      "active",
      previous,
    );
    return { status: "promoted" as const, promotion };
  });
}
export async function activateJevLive(
  pool: Pool,
  owner: string,
  input: unknown,
  key: string,
) {
  const b = input as Record<string, unknown> | null;
  if (
    !b ||
    Object.keys(b).sort().join() !==
      "confirmed_capital_usd6,expected_pilot_sequence,identity_hash,version" ||
    b.version !== "jev.live-activation.v1" ||
    b.confirmed_capital_usd6 !== "250000000" ||
    typeof b.expected_pilot_sequence !== "string" ||
    !/^\d{1,18}$/.test(b.expected_pilot_sequence) ||
    typeof b.identity_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(b.identity_hash) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(key)
  )
    throw new JevPanelCommandError(400, "JEV_LIVE_INVALID_COMMAND");
  return withBtcRetentionTransaction(pool, async (tx) => {
    await lockTx(tx, owner);
    const old = (
      await tx.query<{ request: unknown }>(
        "SELECT request FROM jev_live_activations WHERE owner_id=$1 AND idempotency_key=$2",
        [owner, key],
      )
    ).rows[0];
    if (old) {
      if (jevHash(old.request) !== jevHash(b))
        throw new JevPanelCommandError(409, "JEV_LIVE_IDEMPOTENCY_COLLISION");
      return {
        status: "duplicate",
        capital_usd6: JEV_LIVE_LIMITS.capital_usd6,
      };
    }
    const gate = await jevPromotionGateTx(tx, owner);
    if (
      !gate.ready ||
      !gate.settled ||
      gate.activated ||
      gate.pilot?.sequence !== b.expected_pilot_sequence ||
      gate.i?.identity_hash !== b.identity_hash ||
      gate.snapshot?.trading_balance_raw !== "250000000" ||
      gate.snapshot.equity_raw !== "250000000"
    )
      throw new JevPanelCommandError(409, "JEV_LIVE_GATE_CLOSED");
    await tx.query(
      "INSERT INTO jev_live_activations(account_id,owner_id,idempotency_key,actor_id,identity_hash,request,proof) VALUES($1,$2,$3,$2,$4,$5::jsonb,$6::jsonb)",
      [
        gate.i!.account_id,
        owner,
        key,
        gate.i!.identity_hash,
        JSON.stringify(b),
        JSON.stringify({
          ready: true,
          limits: JEV_LIVE_LIMITS,
          assessment: gate.assessment?.result,
          qualification: gate.readiness?.qualification.evidence_id ?? null,
          venue_validation: gate.venue?.evidence_id ?? null,
          pilot_sequence: gate.pilot!.sequence,
        }),
      ],
    );
    const promotion = await appendPromotionTx(tx, owner, gate, "active", null);
    return {
      status: "activated",
      promotion,
      capital_usd6: JEV_LIVE_LIMITS.capital_usd6,
    };
  });
}
export async function readJevLivePanelTx(tx: SqlExecutor, owner: string) {
  const gate = await jevPromotionGateTx(tx, owner);
  return {
    version: "jev.live-panel.v1",
    limits: JEV_LIVE_LIMITS,
    identity_hash: gate.i?.identity_hash ?? null,
    pilot_sequence: gate.pilot?.sequence ?? "0",
    activated: !!gate.activated,
    can_rearm: canRearm(gate),
    can_activate:
      gate.ready &&
      gate.settled &&
      !gate.activated &&
      gate.snapshot?.equity_raw === "250000000" &&
      gate.snapshot.trading_balance_raw === "250000000",
    reasons: [
      ...gate.reasons,
      ...(!gate.settled ? ["flat_reconciliation_required"] : []),
      ...(!gate.activated &&
      gate.snapshot &&
      gate.snapshot.equity_raw !== "250000000"
        ? ["initial_capital_mismatch"]
        : []),
    ],
    equity_usd6: gate.snapshot?.equity_raw ?? null,
    high_water_usd6: gate.pilot?.checkpoint.risk.high_water_usd_raw ?? null,
    global_blocked: gate.pilot?.checkpoint.global_blocked ?? false,
    promotion: gate.i ? await readJevPromotionTx(tx, gate.i.account_id) : null,
  };
}
function canRearm(gate: Awaited<ReturnType<typeof jevPromotionGateTx>>) {
  return (
    !!gate.activated &&
    !!gate.pilot?.checkpoint.global_blocked &&
    gate.settled &&
    gate.reasons.every((r) =>
      ["global_drawdown_blocked", "daily_or_global_risk_paused"].includes(r),
    ) &&
    !!gate.snapshot &&
    BigInt(gate.snapshot.equity_raw) >
      BigInt(gate.pilot.checkpoint.risk.high_water_usd_raw) - 12500000n
  );
}
/** A new human decision clears only the global latch; existing HWM, daily
 * limits, capital, bindings and activation remain unchanged. */
export async function rearmJevLive(
  pool: Pool,
  owner: string,
  input: unknown,
  key: string,
) {
  const b = input as Record<string, unknown> | null;
  if (
    !b ||
    Object.keys(b).sort().join() !==
      "confirmed_high_water_usd6,expected_pilot_sequence,identity_hash,version" ||
    b.version !== "jev.live-rearm.v1" ||
    typeof b.confirmed_high_water_usd6 !== "string" ||
    !/^[0-9]{1,18}$/.test(b.confirmed_high_water_usd6) ||
    typeof b.expected_pilot_sequence !== "string" ||
    !/^[0-9]{1,18}$/.test(b.expected_pilot_sequence) ||
    typeof b.identity_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(b.identity_hash) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(key)
  )
    throw new JevPanelCommandError(400, "JEV_LIVE_INVALID_COMMAND");
  return withBtcRetentionTransaction(pool, async (tx) => {
    await lockTx(tx, owner);
    const i = await identityTx(tx, owner),
      operation_id = `rearm:${key}`,
      decision_id = jevHash(b);
    if (i) {
      const old = (
        await tx.query<{
          request: { operator_decision?: { decision_id: string } };
        }>(
          "SELECT request FROM jev_pilot_events WHERE account_id=$1 AND owner_id=$2 AND operation_id=$3",
          [i.account_id, owner, operation_id],
        )
      ).rows[0];
      if (old) {
        if (old.request.operator_decision?.decision_id !== decision_id)
          throw new JevPanelCommandError(409, "JEV_LIVE_IDEMPOTENCY_COLLISION");
        return { status: "duplicate" };
      }
    }
    const gate = await jevPromotionGateTx(tx, owner);
    if (
      !canRearm(gate) ||
      gate.i?.identity_hash !== b.identity_hash ||
      gate.pilot?.sequence !== b.expected_pilot_sequence ||
      gate.pilot?.checkpoint.risk.high_water_usd_raw !==
        b.confirmed_high_water_usd6
    )
      throw new JevPanelCommandError(409, "JEV_LIVE_GATE_CLOSED");
    await commandJevPilotTx(tx, owner, gate.i!.account_id, {
      operation_id,
      expected_sequence: gate.pilot!.sequence,
      action: "rearm",
      observation: gate.pilot!.checkpoint.observation,
      operator_decision: {
        actor_id: owner,
        decision_id,
        reason:
          "Rearm global autenticado; patrimônio reconciliado acima do piso fixo, HWM preservado.",
      },
    });
    return { status: "rearmed" };
  });
}
/** Entry authorization is refreshed at signing; protective exits retain the
 * authenticated lifetime authority even when profile/engine gates close. */
export async function jevLiveAuthorityTx(
  tx: SqlExecutor,
  owner: string,
  scope: JevScope,
  checkEntries = true,
) {
  const i = await identityTx(tx, owner);
  if (!i || i.account_id !== scope.account_id)
    return { activation_id: null, entries_allowed: false };
  const activation = (
    await tx.query<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM jev_live_activations WHERE account_id=$1 AND owner_id=$2 AND identity_hash=$3",
      [i.account_id, owner, i.identity_hash],
    )
  ).rows[0];
  if (!checkEntries)
    return {
      activation_id: activation?.idempotency_key ?? null,
      entries_allowed: false,
    };
  const promotion = await readJevPromotionTx(tx, i.account_id);
  if (
    !activation ||
    !promotion ||
    promotion.state !== "active" ||
    promotion.experiment_id !== scope.experiment_id
  )
    return {
      activation_id: activation?.idempotency_key ?? null,
      entries_allowed: false,
    };
  const gate = await jevPromotionGateTx(tx, owner, { ...promotion, slot: 0 });
  return {
    activation_id: activation.idempotency_key,
    entries_allowed: gate.ready && gate.reconciled,
  };
}
