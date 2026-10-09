import { requireJev } from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import { withBtcRetentionTransaction } from "./btc-retention.js";
import { jevHash } from "./jev-hash.js";
import { validateJevSuccessor, type JevManifest } from "./jev-manifest.js";
export interface JevProposal {
  owner_id: string;
  proposal_id: string;
  parent_profile_id: string;
  parent_profile_version: string;
  profile_id: string;
  profile_version: string;
  manifest: JevManifest;
  reason: string;
}
export type ProposalKind =
  "withdrawn" | "rejected" | "approved" | "vetoed" | "unavailable" | "admitted";
export const proposalId = (id: unknown) =>
  typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/.test(id);
export async function storeJevProposalTx(tx: SqlExecutor, p: JevProposal) {
  requireJev(
    [
      p.owner_id,
      p.proposal_id,
      p.parent_profile_id,
      p.parent_profile_version,
      p.profile_id,
      p.profile_version,
    ].every(proposalId) &&
      typeof p.reason === "string" &&
      p.reason.length > 0 &&
      p.reason.length <= 512,
    "PROPOSAL_INPUT",
  );
  const parent = (
    await tx.query<{ manifest: JevManifest }>(
      "SELECT manifest FROM jev_profiles WHERE owner_id=$1 AND profile_id=$2 AND profile_version=$3",
      [p.owner_id, p.parent_profile_id, p.parent_profile_version],
    )
  ).rows[0];
  requireJev(parent, "PROPOSAL_PARENT");
  const fingerprint = validateJevSuccessor(parent.manifest, p.manifest);
  const old = (
    await tx.query(
      "SELECT * FROM jev_proposals WHERE owner_id=$1 AND proposal_id=$2",
      [p.owner_id, p.proposal_id],
    )
  ).rows[0];
  if (old) {
    requireJev(
      old.fingerprint === fingerprint &&
        old.reason === p.reason &&
        old.profile_id === p.profile_id &&
        old.profile_version === p.profile_version &&
        old.parent_profile_id === p.parent_profile_id &&
        old.parent_profile_version === p.parent_profile_version,
      "PROPOSAL_IDEMPOTENCY_COLLISION",
    );
    return { status: "duplicate" as const, fingerprint };
  }
  await tx.query(
    "INSERT INTO jev_proposals(owner_id,proposal_id,fingerprint,parent_profile_id,parent_profile_version,profile_id,profile_version,manifest,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)",
    [
      p.owner_id,
      p.proposal_id,
      fingerprint,
      p.parent_profile_id,
      p.parent_profile_version,
      p.profile_id,
      p.profile_version,
      JSON.stringify(p.manifest),
      p.reason,
    ],
  );
  return { status: "stored" as const, fingerprint };
}
export async function storeJevProposal(
  pool: Pick<DatabasePool, "transaction">,
  input: JevProposal,
) {
  const p = structuredClone(input);
  jevHash(p);
  return withBtcRetentionTransaction(pool, (tx) => storeJevProposalTx(tx, p));
}
export async function proposalEventTx(
  tx: SqlExecutor,
  owner: string,
  proposal: string,
  eventId: string,
  kind: ProposalKind,
  reason: string,
  original: unknown = {},
) {
  requireJev(
    proposalId(eventId) &&
      typeof reason === "string" &&
      reason.length > 0 &&
      reason.length <= 512,
    "PROPOSAL_EVENT",
  );
  jevHash(original);
  const old = (
    await tx.query(
      "SELECT * FROM jev_proposal_events WHERE owner_id=$1 AND event_id=$2",
      [owner, eventId],
    )
  ).rows[0];
  if (old) {
    requireJev(
      old.proposal_id === proposal &&
        old.kind === kind &&
        old.reason === reason &&
        jevHash(old.original) === jevHash(original),
      "PROPOSAL_EVENT_COLLISION",
    );
    return;
  }
  await tx.query(
    "INSERT INTO jev_proposal_events(owner_id,proposal_id,event_id,kind,reason,original) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
    [owner, proposal, eventId, kind, reason, JSON.stringify(original)],
  );
}
