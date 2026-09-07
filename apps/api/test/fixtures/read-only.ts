import type { DatabasePool, SqlExecutor } from "../../src/database.js";

/**
 * RFC-023 D1. Gives a test double the `readOnly` half of `DatabasePool`.
 *
 * It runs the body against the same executor and does NOT push
 * `SET TRANSACTION READ ONLY` / `SET LOCAL statement_timeout` through the
 * double's own `query`: the fakes in this suite capture every statement they
 * see, and injecting two per read would rewrite assertions that are about the
 * queries under test, not about the guard.
 *
 * The guard itself is therefore never proved here. It is proved against the
 * real pool in `test/database.test.ts` (the two statements, in order, inside
 * the transaction and never outside it) and per route in
 * `test/route-budgets.test.ts`, which uses a double built for the purpose.
 */
export function withReadOnly<P extends Pick<DatabasePool, "query">>(
  pool: P,
): P & Pick<DatabasePool, "readOnly"> {
  return Object.assign(pool, {
    readOnly<T>(
      _statementTimeoutMs: number,
      run: (tx: SqlExecutor) => Promise<T>,
    ): Promise<T> {
      return run(pool);
    },
  });
}
