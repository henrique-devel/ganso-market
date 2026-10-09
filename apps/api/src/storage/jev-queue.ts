import type { JevQueueProposal } from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import { withBtcRetentionTransaction } from "./btc-retention.js";
import { proposalEventTx, proposalId } from "./jev-proposals.js";
import { jevHash } from "./jev-hash.js";
import { JevPanelCommandError } from "./jev-infrastructure.js";
export async function readJevQueueTx(tx: SqlExecutor, owner: string) {
  const latest = (
    await tx.query<{ revision: string; proposal_ids: string[] }>(
      "SELECT revision::text,proposal_ids FROM jev_queue_snapshots WHERE owner_id=$1 ORDER BY revision DESC LIMIT 1",
      [owner],
    )
  ).rows[0] ?? { revision: "0", proposal_ids: [] };
  const proposals = (
    await tx.query<JevQueueProposal>(
      "SELECT p.proposal_id,p.fingerprint,p.profile_id,p.profile_version,p.reason,p.manifest->'horizon_minutes' AS horizon_minutes,s.rank,s.cost_usd6::text,r.origin FROM jev_proposals p JOIN jev_proposal_requests r USING(owner_id,proposal_id) JOIN jev_proposal_results s USING(origin,request_id) WHERE p.owner_id=$1 AND p.proposal_id=ANY($2::text[]) ORDER BY array_position($2::text[],p.proposal_id)",
      [owner, latest.proposal_ids],
    )
  ).rows;
  return { ...latest, proposals };
}
export async function queueSnapshotTx(
  tx: SqlExecutor,
  owner: string,
  key: string,
  base: string,
  action: string,
  request: unknown,
  ids: string[],
) {
  await tx.query(
    "INSERT INTO jev_queue_snapshots(owner_id,idempotency_key,base_revision,action,request,proposal_ids) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
    [owner, key, base, action, JSON.stringify(request), ids],
  );
}
export function validateQueueCommand(input: unknown, key: unknown) {
  const b = input as {
    action?: unknown;
    proposal_id?: unknown;
    proposal_ids?: unknown;
    revision?: unknown;
  } | null;
  const fail = () => {
    throw new JevPanelCommandError(400, "JEV_QUEUE_INVALID_COMMAND");
  };
  if (
    !b ||
    Array.isArray(b) ||
    !proposalId(key) ||
    typeof b.revision !== "string" ||
    !/^(0|[1-9][0-9]{0,17})$/.test(b.revision)
  )
    return fail();
  if (
    b.action === "remove" &&
    Object.keys(b).sort().join() === "action,proposal_id,revision" &&
    proposalId(b.proposal_id)
  )
    return {
      action: "remove" as const,
      revision: b.revision,
      proposal_id: b.proposal_id as string,
    };
  if (
    b.action === "reorder" &&
    Object.keys(b).sort().join() === "action,proposal_ids,revision" &&
    Array.isArray(b.proposal_ids) &&
    b.proposal_ids.length <= 3 &&
    b.proposal_ids.every(proposalId) &&
    new Set(b.proposal_ids).size === b.proposal_ids.length
  )
    return {
      action: "reorder" as const,
      revision: b.revision,
      proposal_ids: b.proposal_ids as string[],
    };
  return fail();
}
export async function commandJevQueue(
  pool: Pick<DatabasePool, "transaction">,
  owner: string,
  input: unknown,
  key: string,
) {
  const b = validateQueueCommand(input, key);
  return withBtcRetentionTransaction(pool, async (tx) => {
    const old = (
      await tx.query<{ request: unknown }>(
        "SELECT request FROM jev_queue_snapshots WHERE owner_id=$1 AND idempotency_key=$2",
        [owner, key],
      )
    ).rows[0];
    if (old) {
      if (jevHash(old.request) !== jevHash(b))
        throw new JevPanelCommandError(409, "JEV_QUEUE_IDEMPOTENCY_COLLISION");
      return { status: "duplicate", queue: await readJevQueueTx(tx, owner) };
    }
    const q = await readJevQueueTx(tx, owner);
    if (q.revision !== b.revision)
      throw new JevPanelCommandError(409, "JEV_QUEUE_CHANGED");
    let ids: string[];
    if (b.action === "remove") {
      if (!q.proposal_ids.includes(b.proposal_id))
        throw new JevPanelCommandError(409, "JEV_QUEUE_CHANGED");
      ids = q.proposal_ids.filter((id) => id !== b.proposal_id);
      await proposalEventTx(
        tx,
        owner,
        b.proposal_id,
        `withdraw:${jevHash([owner, key])}`,
        "withdrawn",
        "Retirada pelo operador",
        { idempotency_key: key },
      );
    } else {
      ids = b.proposal_ids;
      if (
        ids.length !== q.proposal_ids.length ||
        ids.some((id) => !q.proposal_ids.includes(id))
      )
        throw new JevPanelCommandError(409, "JEV_QUEUE_CHANGED");
    }
    await queueSnapshotTx(tx, owner, key, q.revision, b.action, b, ids);
    return { status: "accepted", queue: await readJevQueueTx(tx, owner) };
  });
}
