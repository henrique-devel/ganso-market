import type { DatabasePool } from "../database.js";
type Worker = Pick<DatabasePool, "transaction">;
const owners = new WeakMap<Worker, Map<string, Worker>>();
/** Commands and the in-process consumer share a fenced owner. Expired owners
 * are retired only on the explicit S9 FENCED result, never on ambiguous SQL. */
export async function withDeskWorker<T>(
  pool: Worker,
  account: string,
  run: (worker: Worker) => Promise<T>,
): Promise<T> {
  let accounts = owners.get(pool);
  if (!accounts) owners.set(pool, (accounts = new Map()));
  const worker = accounts.get(account) ?? pool;
  accounts.set(account, worker);
  try {
    return await run(worker);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "BTC_RECOVERY_FENCED")
      throw error;
    if (accounts.get(account) === worker)
      accounts.set(account, { transaction: pool.transaction.bind(pool) });
    return run(accounts.get(account)!);
  }
}
