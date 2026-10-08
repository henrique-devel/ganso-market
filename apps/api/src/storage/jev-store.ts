import { validateJevManifest, type JevManifest } from "./jev-manifest.js";
export { jevHash } from "./jev-hash.js";
import {
  parseJevContract,
  requireJev,
  type JevBinding,
  type JevProfile,
} from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import { assertEvidenceJson } from "../trading/retention.js";
import { canonicalFingerprint } from "../trading/replay.js";
import {
  jevGenesis,
  materializeJevBatch,
  replayJevLedger,
  validateJevLedgerIdentity,
  type JevLedgerBatch,
  type JevLedgerIdentity,
} from "./jev-ledger.js";
import type { JevLedgerEvent } from "@ganso-market/contracts/trading";
import { observeJevRiskTx } from "./jev-riskstore.js";
type Store = Pick<DatabasePool, "transaction">;
const same = (a: unknown, b: unknown) =>
  requireJev(
    canonicalFingerprint(a) === canonicalFingerprint(b),
    "IDEMPOTENCY_COLLISION",
  );
async function registerProfileTx(
  tx: SqlExecutor,
  p: JevProfile,
  manifest: unknown,
) {
  parseJevContract("profile", p);
  requireJev(
    validateJevManifest(manifest as JevManifest) === p.manifest_hash &&
      (manifest as JevManifest).horizon_minutes === p.horizon_minutes,
    "MANIFEST_HASH",
  );
  await tx.query(
    "INSERT INTO jev_profiles(owner_id,profile_id,profile_version,manifest_hash,profile,manifest) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT DO NOTHING",
    [
      p.owner_id,
      p.profile_id,
      p.profile_version,
      p.manifest_hash,
      JSON.stringify(p),
      JSON.stringify(manifest),
    ],
  );
  const row = (
    await tx.query(
      "SELECT profile,manifest FROM jev_profiles WHERE owner_id=$1 AND profile_id=$2 AND profile_version=$3",
      [p.owner_id, p.profile_id, p.profile_version],
    )
  ).rows[0];
  requireJev(row, "PROFILE_FINGERPRINT_COLLISION");
  same(row.profile, p);
  same(row.manifest, manifest);
}
export async function loadJevAccountTx(
  tx: SqlExecutor,
  owner: string,
  id: string,
  lock = false,
  eventLimit?: number,
) {
  requireJev(
    eventLimit === undefined ||
      (Number.isSafeInteger(eventLimit) && eventLimit > 0),
    "METRICS_EVENT_LIMIT",
  );
  const row = (
    await tx.query(
      "SELECT identity FROM jev_accounts WHERE account_id=$1 AND owner_id=$2" +
        (lock ? " FOR UPDATE" : ""),
      [id, owner],
    )
  ).rows[0];
  requireJev(row, "ACCOUNT_NOT_FOUND");
  const base = row.identity as Pick<
    JevLedgerIdentity,
    "account" | "instrument"
  >;
  const bindings = (
    await tx.query(
      "SELECT b.binding,p.profile FROM jev_bindings b JOIN jev_profiles p USING(owner_id,profile_id,profile_version) WHERE b.account_id=$1 ORDER BY b.binding->>'started_at',b.experiment_id",
      [id],
    )
  ).rows.map((r) => ({
    binding: r.binding as JevBinding,
    profile: r.profile as JevProfile,
  }));
  const identity = { ...base, bindings };
  validateJevLedgerIdentity(identity);
  const events = (
    await tx.query(
      "SELECT event FROM jev_ledger_events WHERE account_id=$1 ORDER BY sequence" +
        (eventLimit === undefined ? "" : " LIMIT " + (eventLimit + 1)),
      [id],
    )
  ).rows.map((r) => r.event as JevLedgerEvent);
  requireJev(
    eventLimit === undefined || events.length <= eventLimit,
    "METRICS_EVENT_LIMIT",
  );
  return { identity, events, projection: replayJevLedger(identity, events) };
}
export async function appendJevLedgerTx(
  tx: SqlExecutor,
  identity: JevLedgerIdentity,
  history: JevLedgerEvent[],
  batch: JevLedgerBatch,
) {
  const at = (
      await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
    ).rows[0]!.now.toISOString(),
    id = identity.account.account_id;
  materializeJevBatch(batch, "0", at);
  const old = (
    await tx.query(
      "SELECT request FROM jev_ledger_transactions WHERE account_id=$1 AND transaction_id=$2",
      [id, batch.transaction_id],
    )
  ).rows[0];
  if (old) {
    same(old.request, batch);
    return {
      status: "duplicate" as const,
      events: history.filter((e) => e.transaction_id === batch.transaction_id),
    };
  }
  const next = materializeJevBatch(batch, String(history.length), at);
  replayJevLedger(identity, [...history, ...next]);
  await tx.query(
    "INSERT INTO jev_ledger_transactions(account_id,transaction_id,request) VALUES($1,$2,$3::jsonb)",
    [id, batch.transaction_id, JSON.stringify(batch)],
  );
  for (const e of next)
    await tx.query(
      "INSERT INTO jev_ledger_events(account_id,sequence,event_id,idempotency_key,owner_id,mode,profile_id,profile_version,experiment_id,instrument_id,instrument_version,transaction_id,event) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)",
      [
        id,
        e.sequence,
        e.event_id,
        e.idempotency_key,
        e.owner_id,
        e.mode,
        e.profile_id,
        e.profile_version,
        e.experiment_id,
        e.instrument_id,
        e.instrument_version,
        e.transaction_id,
        JSON.stringify(e),
      ],
    );
  return { status: "appended" as const, events: next };
}
async function createAccountTx(tx: SqlExecutor, input: JevLedgerIdentity) {
  validateJevLedgerIdentity(input);
  requireJev(input.bindings.length === 1, "REGISTRATION_BINDING");
  const { account: a, instrument: i } = input;
  await tx.query(
    "INSERT INTO jev_accounts(account_id,owner_id,mode,instrument_id,instrument_version,identity) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(account_id) DO NOTHING",
    [
      a.account_id,
      a.owner_id,
      a.mode,
      i.instrument_id,
      i.instrument_version,
      JSON.stringify({ account: a, instrument: i }),
    ],
  );
  const stored = (
    await tx.query(
      "SELECT identity FROM jev_accounts WHERE account_id=$1 FOR UPDATE",
      [a.account_id],
    )
  ).rows[0]!;
  same(stored.identity, { account: a, instrument: i });
  const b = input.bindings[0]!.binding;
  await tx.query(
    "INSERT INTO jev_bindings(experiment_id,owner_id,account_id,mode,profile_id,profile_version,binding) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(experiment_id) DO NOTHING",
    [
      b.experiment_id,
      b.owner_id,
      b.account_id,
      b.mode,
      b.profile_id,
      b.profile_version,
      JSON.stringify(b),
    ],
  );
  same(
    (
      await tx.query(
        "SELECT binding FROM jev_bindings WHERE experiment_id=$1",
        [b.experiment_id],
      )
    ).rows[0]!.binding,
    b,
  );
  const history = (
    await tx.query(
      "SELECT event FROM jev_ledger_events WHERE account_id=$1 ORDER BY sequence",
      [a.account_id],
    )
  ).rows.map((r) => r.event as JevLedgerEvent);
  if (a.mode === "live") return { status: "unfunded" as const, events: [] };
  requireJev(b.started_at === a.started_at, "GENESIS_START");
  return appendJevLedgerTx(tx, input, history, jevGenesis(input));
}
/** Library seams only. No route, boot hook, worker or migration calls these. */
export async function registerJevPair(
  pool: Store,
  slot: number,
  paperInput: JevLedgerIdentity,
  stressInput: JevLedgerIdentity,
  manifest: unknown,
) {
  assertEvidenceJson({ paperInput, stressInput, manifest });
  const paper = structuredClone(paperInput),
    stress = structuredClone(stressInput),
    m = structuredClone(manifest);
  requireJev(
    paper.account.mode === "paper" &&
      stress.account.mode === "stress" &&
      paper.account.started_at === stress.account.started_at &&
      Number.isInteger(slot) &&
      slot >= 1 &&
      slot <= 3,
    "PAIR",
  );
  same(paper.bindings[0]!.profile, stress.bindings[0]!.profile);
  return pool.transaction(async (tx) => {
    const p = paper.bindings[0]!.profile;
    await registerProfileTx(tx, p, m);
    const primary = await createAccountTx(tx, paper),
      adverse = await createAccountTx(tx, stress);
    const values = [
      slot,
      p.owner_id,
      p.profile_id,
      p.profile_version,
      paper.account.account_id,
      stress.account.account_id,
      paper.bindings[0]!.binding.experiment_id,
      stress.bindings[0]!.binding.experiment_id,
    ];
    await tx.query(
      "INSERT INTO jev_pairs(slot,owner_id,profile_id,profile_version,paper_account_id,stress_account_id,paper_experiment_id,stress_experiment_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(slot) DO NOTHING",
      values,
    );
    const row = (
      await tx.query(
        "SELECT slot,owner_id,profile_id,profile_version,paper_account_id,stress_account_id,paper_experiment_id,stress_experiment_id FROM jev_pairs WHERE slot=$1",
        [slot],
      )
    ).rows[0]!;
    same(Object.values(row), values);
    return { paper: primary, stress: adverse };
  });
}
export async function registerJevLiveIdentity(
  pool: Store,
  input: JevLedgerIdentity,
  manifest: unknown,
) {
  assertEvidenceJson({ input, manifest });
  const i = structuredClone(input),
    m = structuredClone(manifest);
  requireJev(i.account.mode === "live", "LIVE_IDENTITY");
  return pool.transaction(async (tx) => {
    await registerProfileTx(tx, i.bindings[0]!.profile, m);
    return createAccountTx(tx, i);
  });
}
export async function appendJevLedgerBatch(
  pool: Store,
  owner: string,
  id: string,
  input: JevLedgerBatch,
) {
  assertEvidenceJson(input);
  const batch = structuredClone(input);
  return pool.transaction(async (tx) => {
    const current = await loadJevAccountTx(tx, owner, id, true);
    // Sample before and after the financial boundary under the same account
    // lock. Funding/fill/fee races cannot skip a loss or reset an observed peak.
    await observeJevRiskTx(tx, owner, id);
    const result = await appendJevLedgerTx(
      tx,
      current.identity,
      current.events,
      batch,
    );
    await observeJevRiskTx(tx, owner, id);
    return result;
  });
}
export async function readJevAccount(pool: Store, owner: string, id: string) {
  return pool.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return loadJevAccountTx(tx, owner, id);
  });
}
