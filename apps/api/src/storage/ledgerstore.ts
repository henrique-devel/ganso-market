import { observeRiskTx, readRiskTx } from "./riskstore.js";
import { requireRisk } from "../trading/risk.js";
import type { TradingScope } from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import { canonicalFingerprint } from "../trading/replay.js";
import {
  genesisBatch,
  materializeLedgerBatch,
  validateLedgerIdentity,
  type LedgerBatch,
  type LedgerIdentity,
  type LedgerEvent,
  parseLedgerEvent,
} from "./ledger-contract.js";
import {
  ledgerScope,
  replayLedger,
  type LedgerProjection,
} from "../trading/ledger.js";
type Store = Pick<DatabasePool, "transaction">;
function same(a: unknown, b: unknown, code: string) {
  if (canonicalFingerprint(a) !== canonicalFingerprint(b))
    throw new Error(`BTC_LEDGER_${code}`);
}
export async function lockableLedgerAccountTx(
  tx: SqlExecutor,
  scope: TradingScope,
  lock = false,
): Promise<LedgerIdentity> {
  const row = (
    await tx.query(
      "SELECT identity FROM btc_ledger_accounts WHERE account_id=$1" +
        (lock ? " FOR UPDATE" : ""),
      [scope.account_id],
    )
  ).rows[0];
  if (!row) throw new Error("BTC_LEDGER_ACCOUNT_NOT_FOUND");
  const identity = row.identity as LedgerIdentity;
  validateLedgerIdentity(identity);
  same(ledgerScope(identity), scope, "OWNERSHIP");
  return identity;
}
async function events(tx: SqlExecutor, id: string): Promise<LedgerEvent[]> {
  return (
    await tx.query(
      "SELECT event FROM btc_ledger_events WHERE account_id=$1 ORDER BY sequence",
      [id],
    )
  ).rows.map((row) => parseLedgerEvent(row.event));
}
/** Internal adapter seam: caller must hold the account row lock first. */
export async function appendLedgerBatchTx(
  tx: SqlExecutor,
  identity: LedgerIdentity,
  batch: LedgerBatch,
  recordedAt: string,
  reservedFill = false,
  observedFunding = false,
) {
  const id = identity.account.account_id;
  // Validate even on retry; snapshot JSON is owned by this call, never mutable caller data.
  materializeLedgerBatch(batch, "0", recordedAt);
  const existing = (
    await tx.query(
      "SELECT request FROM btc_ledger_transactions WHERE account_id=$1 AND transaction_id=$2",
      [id, batch.transaction_id],
    )
  ).rows[0];
  if (existing) {
    same(existing.request, batch, "IDEMPOTENCY_COLLISION");
    const committed = (
      await tx.query(
        "SELECT event FROM btc_ledger_events WHERE account_id=$1 AND transaction_id=$2 ORDER BY sequence",
        [id, batch.transaction_id],
      )
    ).rows.map((row) => parseLedgerEvent(row.event));
    return { status: "duplicate" as const, events: committed };
  }
  if (
    !observedFunding &&
    batch.events.some((e) => e.payload.event_type === "funding")
  )
    throw new Error("BTC_LEDGER_OBSERVED_FUNDING_REQUIRED");
  const fills = batch.events.filter((e) => e.payload.event_type === "fill");
  if (fills.length) {
    const cutoff = (
      await tx.query<{ cutoff: Date | null }>(
        "SELECT MAX(cutoff) AS cutoff FROM btc_funding_results WHERE account_id=$1 AND status='settled'",
        [id],
      )
    ).rows[0]!.cutoff;
    if (cutoff && fills.some((e) => e.occurred_at <= cutoff.toISOString()))
      throw new Error("BTC_LEDGER_SETTLED_FUNDING_CUTOFF");
  }
  // Once S3 accepts an order, fills must consume its reservation atomically.
  // Duplicate S1 batches above remain retryable; S6 owns new funding writes.
  if (
    !reservedFill &&
    batch.events.some((e) => e.payload.event_type === "fill")
  ) {
    const managed = await tx.query(
      "SELECT 1 FROM btc_order_acceptances WHERE account_id=$1 LIMIT 1",
      [id],
    );
    if (managed.rowCount || (await readRiskTx(tx, id)))
      throw new Error("BTC_LEDGER_RESERVATION_REQUIRED");
  }
  const risk = await readRiskTx(tx, id);
  const external =
    risk && batch.events.some((e) => e.payload.event_type === "cash");
  if (external) {
    requireRisk(
      batch.events.every(
        (e) =>
          e.payload.event_type === "cash" &&
          Date.parse(recordedAt) - Date.parse(e.occurred_at) >= 0 &&
          Date.parse(recordedAt) - Date.parse(e.occurred_at) <= 5000,
      ),
      "EXTERNAL_FLOW_TIME",
    );
    const before = await observeRiskTx(tx, ledgerScope(identity));
    requireRisk(
      before.finance.positions.every((p) => p.quantity_btc_raw === "0") ||
        before.markFresh,
      "EXTERNAL_FLOW_UNVALUED",
    );
  }
  const history = await events(tx, id);
  const replay = history.length ? replayLedger(identity, history) : null;
  if (replay) {
    const stored = (
      await tx.query(
        "SELECT projection FROM btc_ledger_projections WHERE account_id=$1",
        [id],
      )
    ).rows[0];
    same(stored?.projection ?? null, replay, "PROJECTION_MISMATCH");
  }
  const previous = replay?.last_sequence ?? "0";
  const next = materializeLedgerBatch(batch, previous, recordedAt);
  const projection = replayLedger(identity, [...history, ...next]);
  await tx.query(
    "INSERT INTO btc_ledger_transactions(account_id,transaction_id,request) VALUES($1,$2,$3::jsonb)",
    [id, batch.transaction_id, JSON.stringify(batch)],
  );
  for (const event of next) {
    await tx.query(
      `INSERT INTO btc_ledger_events(account_id,experiment_id,instrument_id,instrument_version,sequence,event_id,idempotency_key,transaction_id,event_type,event)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [
        id,
        event.experiment_id,
        event.instrument_id,
        event.instrument_version,
        event.sequence,
        event.event_id,
        event.idempotency_key,
        event.transaction_id,
        event.payload.event_type,
        JSON.stringify(event),
      ],
    );
  }
  await tx.query(
    `INSERT INTO btc_ledger_projections(account_id,projection) VALUES($1,$2::jsonb)
    ON CONFLICT(account_id) DO UPDATE SET projection=EXCLUDED.projection`,
    [id, JSON.stringify(projection)],
  );
  if (external) await observeRiskTx(tx, ledgerScope(identity));
  return { status: "appended" as const, events: next };
}
/** Library only: no route/worker calls this in S1. No migration seeds accounts.
 * One immutable account per experiment. A restart requires both fresh identities. */
export async function createLedgerAccount(pool: Store, input: LedgerIdentity) {
  validateLedgerIdentity(input);
  const identity: LedgerIdentity = JSON.parse(JSON.stringify(input));
  return pool.transaction(async (tx) => {
    const scope = ledgerScope(identity);
    await tx.query(
      `INSERT INTO btc_ledger_accounts(account_id,experiment_id,instrument_id,instrument_version,identity)
      VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
      [
        scope.account_id,
        scope.experiment_id,
        scope.instrument_id,
        scope.instrument_version,
        JSON.stringify(identity),
      ],
    );
    const stored = await lockableLedgerAccountTx(tx, scope, true);
    same(stored, identity, "IDENTITY_COLLISION");
    return appendLedgerBatchTx(
      tx,
      stored,
      genesisBatch(stored),
      new Date().toISOString(),
    );
  });
}
/** Entire batch, sequence assignment and projection commit on one connection.
 * The immutable account row serializes concurrent writers, including identical retries. */
export async function appendLedgerBatch(
  pool: Store,
  scopeInput: TradingScope,
  input: LedgerBatch,
) {
  const recordedAt = new Date().toISOString();
  materializeLedgerBatch(input, "0", recordedAt);
  const batch: LedgerBatch = JSON.parse(JSON.stringify(input));
  const scope = { ...scopeInput };
  return pool.transaction(async (tx) => {
    const identity = await lockableLedgerAccountTx(tx, scope, true);
    return appendLedgerBatchTx(tx, identity, batch, recordedAt);
  });
}
/** One consistent snapshot; reads do not rebuild or mutate the stored projection. */
export async function readLedgerAccount(pool: Store, scope: TradingScope) {
  return pool.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return readLedgerAccountTx(tx, scope);
  });
}
/** Reuse an already read-only, repeatable snapshot for S2 market/ledger reads. */
export async function readLedgerAccountTx(
  tx: SqlExecutor,
  scope: TradingScope,
) {
  const identity = await lockableLedgerAccountTx(tx, scope);
  const history = await events(tx, scope.account_id);
  const row = (
    await tx.query(
      "SELECT projection FROM btc_ledger_projections WHERE account_id=$1",
      [scope.account_id],
    )
  ).rows[0];
  const projection = row?.projection as LedgerProjection | undefined;
  const replay = replayLedger(identity, history);
  same(projection ?? null, replay, "PROJECTION_MISMATCH");
  return { identity, events: history, projection: replay };
}
