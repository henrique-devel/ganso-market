import { buildDeskProjection } from "./desk-projection.js";
import { createHash, randomUUID } from "node:crypto";
import type { TradingScope } from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import { canonicalFingerprint } from "../trading/replay.js";
import { lockableLedgerAccountTx, readLedgerAccountTx } from "./ledgerstore.js";
import { withBtcRetentionTransaction } from "./btc-retention.js";
import { auditRecoveryTx, recoverySnapshotTx } from "./recovery-audit.js";
import { release, type Reservation } from "../trading/reservations.js";

export const RECOVERY_VERSION = "btc.recovery.v1";
// One opaque identity per actual pool/worker lifetime. Memory is only identity,
// never readiness or balances. Every admission/fence uses the database again.
type Store = Pick<DatabasePool, "transaction">;
const workers = new WeakMap<Store, string>();
function workerId(pool: Store) {
  let id = workers.get(pool);
  if (!id) workers.set(pool, (id = randomUUID()));
  return id;
}
type Head = {
  generation: string;
  worker_id: string;
  status: "ready" | "blocked";
  alive: boolean;
};
function refuse(code: string): never {
  throw new Error(`BTC_RECOVERY_${code}`);
}
async function checkpoint(tx: SqlExecutor, id: string, generation: string) {
  const snapshot = await recoverySnapshotTx(tx, id);
  await tx.query(
    `INSERT INTO btc_recovery_checkpoints(account_id,sequence,generation,version,digest,cursors)
     SELECT $1,COALESCE(MAX(sequence),0)+1,$2,$3,$4,$5::jsonb FROM btc_recovery_checkpoints WHERE account_id=$1
     HAVING NOT EXISTS (SELECT 1 FROM btc_recovery_checkpoints WHERE account_id=$1
       AND sequence=(SELECT MAX(sequence) FROM btc_recovery_checkpoints WHERE account_id=$1) AND digest=$4 AND generation=$2)`,
    [
      id,
      generation,
      RECOVERY_VERSION,
      snapshot.digest,
      JSON.stringify(snapshot.cursors),
    ],
  );
}
async function settleRestartOrders(
  tx: SqlExecutor,
  id: string,
  generation: string,
) {
  // Expiry releases by a durable transition, never a clock-only projection.
  // Observed passive queue priority cannot survive a worker outage. Keep every
  // historical queue/trade receipt and original pin; valid IOC holds remain.
  const now = (
    await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
  ).rows[0]!.now.toISOString();
  const rows = (
    await tx.query<{ reservation: Reservation; passive: boolean }>(
      `SELECT DISTINCT ON (r.order_id) r.reservation,
       EXISTS (SELECT 1 FROM btc_passive_events p WHERE p.account_id=r.account_id AND p.order_id=r.order_id) AS passive
       FROM btc_reservation_events r WHERE r.account_id=$1
       ORDER BY r.order_id,r.sequence DESC`,
      [id],
    )
  ).rows;
  for (const { reservation, passive } of rows) {
    if (reservation.status !== "active") continue;
    const reason =
      reservation.order.valid_until <= now
        ? "expired"
        : passive
          ? "cancelled"
          : null;
    if (!reason) continue;
    const operation = `recovery:${createHash("sha256")
      .update(canonicalFingerprint([generation, reservation.order.order_id]))
      .digest("hex")}`;
    const request = {
      action: "release",
      operation_id: operation,
      order_id: reservation.order.order_id,
      reason,
    };
    await tx.query(
      `INSERT INTO btc_reservation_events(account_id,sequence,operation_id,order_id,action,request,reservation,recorded_at)
       SELECT $1,COALESCE(MAX(sequence),0)+1,$2,$3,'release',$4::jsonb,$5::jsonb,clock_timestamp() FROM btc_reservation_events WHERE account_id=$1`,
      [
        id,
        operation,
        reservation.order.order_id,
        JSON.stringify(request),
        JSON.stringify(release(reservation, reason)),
      ],
    );
  }
}
/** Effective boundary shared by ledger/reservations/risk/IOC/passive/funding/
 * liquidation. No caller flag can bypass boot. Lock order: retention (when
 * needed), account, recovery head. An expired worker is retired permanently;
 * a new pool lifetime must reconcile and obtain a higher generation.
 * Row locking excludes takeover during a transaction; the final DB-clock fence
 * aborts the ENTIRE transaction if its lease expired while work was in flight.
 */
export async function recoveryTransaction<T>(
  pool: Store,
  scope: TradingScope,
  run: (tx: SqlExecutor) => Promise<T>,
  retention = false,
): Promise<T> {
  const worker = workerId(pool);
  const execute = async (tx: SqlExecutor) => {
    const identity = await lockableLedgerAccountTx(tx, scope, true);
    const id = scope.account_id;
    let head = (
      await tx.query<Head>(
        `SELECT generation::text,worker_id,status,lease_until > clock_timestamp() AS alive
       FROM btc_recovery_heads WHERE account_id=$1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
    const boot = !head || head.worker_id !== worker;
    if (head?.status === "blocked") refuse("BLOCKED");
    if (head && head.worker_id === worker) {
      if (!head.alive) refuse("FENCED");
    } else {
      if (head?.alive) refuse("OWNED");
      const retired = await tx.query(
        "SELECT 1 FROM btc_recovery_owners WHERE account_id=$1 AND worker_id=$2",
        [id, worker],
      );
      if (retired.rowCount) refuse("FENCED");
      const generation = (BigInt(head?.generation ?? "0") + 1n).toString();
      await tx.query(
        "INSERT INTO btc_recovery_owners(account_id,generation,worker_id) VALUES($1,$2,$3)",
        [id, generation, worker],
      );
      await tx.query(
        `INSERT INTO btc_recovery_heads(account_id,generation,worker_id,lease_until,status)
         VALUES($1,$2,$3,clock_timestamp()+interval '30 seconds','ready')
         ON CONFLICT(account_id) DO UPDATE SET generation=EXCLUDED.generation,worker_id=EXCLUDED.worker_id,lease_until=EXCLUDED.lease_until,status='ready',reason=NULL`,
        [id, generation, worker],
      );
      head = { generation, worker_id: worker, status: "ready", alive: true };
    }
    await tx.query("SAVEPOINT recovery_boot");
    try {
      const snapshot = await recoverySnapshotTx(tx, id);
      const prior = (
        await tx.query<{ digest: string }>(
          "SELECT digest FROM btc_recovery_checkpoints WHERE account_id=$1 ORDER BY sequence DESC LIMIT 1",
          [id],
        )
      ).rows[0];
      if (prior && prior.digest !== snapshot.digest)
        refuse("AUTHORITATIVE_DIVERGENCE");
      if (boot) {
        const projection = await auditRecoveryTx(tx, identity);
        const stored = (
          await tx.query(
            "SELECT projection FROM btc_ledger_projections WHERE account_id=$1",
            [id],
          )
        ).rows[0];
        if (
          canonicalFingerprint(stored?.projection ?? null) !==
          canonicalFingerprint(projection)
        ) {
          await tx.query(
            `INSERT INTO btc_ledger_projections(account_id,projection) VALUES($1,$2::jsonb)
             ON CONFLICT(account_id) DO UPDATE SET projection=EXCLUDED.projection`,
            [id, JSON.stringify(projection)],
          );
        }
        const ledger = await readLedgerAccountTx(tx, scope);
        await tx.query(
          "UPDATE btc_ledger_projections SET desk_projection=$2::jsonb WHERE account_id=$1",
          [
            id,
            JSON.stringify(
              buildDeskProjection(ledger.projection, ledger.events),
            ),
          ],
        );
        await settleRestartOrders(tx, id, head.generation);
        await checkpoint(tx, id, head.generation);
      }
    } catch (error) {
      // Persist closure without mutating authoritative history, risk anchors,
      // pins or ownership. SQL errors also roll back the boot savepoint.
      await tx.query("ROLLBACK TO SAVEPOINT recovery_boot");
      const reason =
        error instanceof Error && /^BTC_[A-Z_]+$/.test(error.message)
          ? error.message
          : "BTC_RECOVERY_INVALID_HISTORY";
      await tx.query(
        "UPDATE btc_recovery_heads SET status='blocked',reason=$2 WHERE account_id=$1",
        [id, reason],
      );
      return { error: new Error(reason) };
    }
    const value = await run(tx);
    await checkpoint(tx, id, head.generation);
    const fenced = await tx.query(
      `UPDATE btc_recovery_heads SET lease_until=clock_timestamp()+interval '30 seconds'
       WHERE account_id=$1 AND worker_id=$2 AND generation=$3 AND status='ready' AND lease_until > clock_timestamp()`,
      [id, worker, head.generation],
    );
    if (fenced.rowCount !== 1) refuse("FENCED");
    return { value };
  };
  const committed = {
    transaction: <U>(runTx: (tx: SqlExecutor) => Promise<U>) =>
      pool.transaction(async (tx) => {
        await tx.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
        return runTx(tx);
      }),
  };
  const result = retention
    ? await withBtcRetentionTransaction(committed, execute)
    : await committed.transaction(execute);
  if (result.error) throw result.error;
  return result.value as T;
}
/** Explicit boot hook for future S10 execution consumers. Collector intentionally
 * does not call this: it neither owns accounts nor starts execution strategies. */
export async function recoverAccount(pool: Store, scope: TradingScope) {
  return recoveryTransaction(pool, scope, async (tx) => {
    await readLedgerAccountTx(tx, scope);
    const row = (
      await tx.query(
        "SELECT generation::text,status FROM btc_recovery_heads WHERE account_id=$1",
        [scope.account_id],
      )
    ).rows[0]!;
    return { version: RECOVERY_VERSION, ...row };
  });
}

export const withRecovery =
  (pool: Store, scope: TradingScope, retention = false) =>
  <T>(run: (tx: SqlExecutor) => Promise<T>) =>
    recoveryTransaction(pool, scope, run, retention);
