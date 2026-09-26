import type { DatabasePool } from "../database.js";
type Worker = Pick<DatabasePool, "transaction">;
const owners = new WeakMap<Worker, Map<string, Worker>>();
/** Commands and the in-process consumer share a fenced owner. Expired owners
 * are retired only on the explicit S9 FENCED result, never on ambiguous SQL.
 * An in-flight old call can see OWNED after a sibling already replaced it;
 * retry that known local successor without stealing another process's lease. */
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
    if (
      !(error instanceof Error) ||
      !(
        error.message === "BTC_RECOVERY_FENCED" ||
        (error.message === "BTC_RECOVERY_OWNED" &&
          accounts.get(account) !== worker)
      )
    )
      throw error;
    if (accounts.get(account) === worker)
      accounts.set(account, { transaction: pool.transaction.bind(pool) });
    return run(accounts.get(account)!);
  }
}
