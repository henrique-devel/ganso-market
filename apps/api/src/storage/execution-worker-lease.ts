import { randomUUID } from "node:crypto";
import type { DatabasePool, SqlExecutor } from "../database.js";
export const EXECUTION_LEASE_MS = 10000;
type Pool = Pick<DatabasePool, "transaction" | "readOnly">;
export interface ExecutionLease {
  worker_id: string;
  generation: string;
}
const fail = (): never => {
  throw new Error("EXECUTION_WORKER_FENCED");
};
/** One process generation. A retired identity can never reacquire after expiry.
 * The final DB-clock fence rolls back all effects, including ambiguous commit retries. */
export async function claimExecutionWorker(
  pool: Pick<Pool, "transaction">,
  codeSha: string,
  worker: string = randomUUID(),
): Promise<ExecutionLease> {
  if (!/^[a-f0-9]{40}$/.test(codeSha))
    throw new Error("EXECUTION_WORKER_CODE_SHA");
  return pool.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(5607)");
    const head = (
      await tx.query<{ generation: string; worker_id: string; alive: boolean }>(
        "SELECT generation::text,worker_id,lease_until>clock_timestamp() AS alive FROM execution_worker_head FOR UPDATE",
      )
    ).rows[0];
    const old = (
      await tx.query(
        "SELECT 1 FROM execution_worker_owners WHERE worker_id=$1",
        [worker],
      )
    ).rowCount;
    if (old && (!head?.alive || head.worker_id !== worker)) fail();
    if (head?.alive && head.worker_id !== worker)
      throw new Error("EXECUTION_WORKER_OWNED");
    if (head?.worker_id === worker && head.alive)
      return { worker_id: worker, generation: head.generation };
    const generation = (BigInt(head?.generation ?? "0") + 1n).toString();
    await tx.query(
      "INSERT INTO execution_worker_owners(generation,worker_id,code_sha) VALUES($1,$2,$3)",
      [generation, worker, codeSha],
    );
    await tx.query(
      "INSERT INTO execution_worker_head(singleton,generation,worker_id,lease_until) VALUES(true,$1,$2,clock_timestamp()+interval '10 seconds') ON CONFLICT(singleton) DO UPDATE SET generation=EXCLUDED.generation,worker_id=EXCLUDED.worker_id,lease_until=EXCLUDED.lease_until",
      [generation, worker],
    );
    return { worker_id: worker, generation };
  });
}
export async function assertExecutionLeaseTx(
  tx: SqlExecutor,
  lease: ExecutionLease,
) {
  if (
    !(
      await tx.query(
        "SELECT 1 FROM execution_worker_head WHERE singleton AND generation=$1 AND worker_id=$2 AND lease_until>clock_timestamp() FOR UPDATE",
        [lease.generation, lease.worker_id],
      )
    ).rowCount
  )
    fail();
}
export function executionFencedPool(pool: Pool, lease: ExecutionLease): Pool {
  // Same-process writers already share one DB fence. Wait before BEGIN instead
  // of spending another connection's SQL budget on that same lock. Call sites
  // are bounded (one scheduler lane, consumer/funding/sample and command drain).
  let pending = Promise.resolve();
  return {
    readOnly: pool.readOnly.bind(pool),
    async transaction(run) {
      const prior = pending;
      let release!: () => void;
      pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prior;
      try {
        return await pool.transaction(async (tx) => {
          // All process mutations share this short fence. Never hold it over HTTP.
          // Isolation/budget preambles must precede the first data query. Their
          // whitelist cannot contain a second statement or any financial mutation.
          let locked = false;
          const lock = async () => {
            if (!locked) {
              await assertExecutionLeaseTx(tx, lease);
              locked = true;
            }
          };
          const guarded: SqlExecutor = {
            async query(sql, params) {
              if (
                !/^\s*SET\s+(?:TRANSACTION\s+ISOLATION\s+LEVEL\s+(?:READ\s+COMMITTED|REPEATABLE\s+READ|SERIALIZABLE)(?:\s+READ\s+ONLY)?|LOCAL\s+(?:statement_timeout|lock_timeout)\s*=\s*(?:'[0-9]+(?:ms|s)?'|[0-9]+)|LOCAL\s+TIME\s+ZONE\s+'UTC')\s*;?\s*$/i.test(
                  sql,
                )
              )
                await lock();
              return tx.query(sql, params);
            },
          };
          const value = await run(guarded);
          await lock();
          if (
            !(
              await tx.query(
                "UPDATE execution_worker_head SET lease_until=clock_timestamp()+interval '10 seconds' WHERE singleton AND generation=$1 AND worker_id=$2 AND lease_until>clock_timestamp()",
                [lease.generation, lease.worker_id],
              )
            ).rowCount
          )
            fail();
          return value;
        });
      } finally {
        release();
      }
    },
  };
}
export async function releaseExecutionWorker(
  pool: Pick<Pool, "transaction">,
  lease: ExecutionLease,
) {
  await pool.transaction((tx) =>
    tx.query(
      "UPDATE execution_worker_head SET lease_until=clock_timestamp() WHERE generation=$1 AND worker_id=$2",
      [lease.generation, lease.worker_id],
    ),
  );
}
