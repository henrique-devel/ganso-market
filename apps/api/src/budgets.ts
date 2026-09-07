import { AsyncLocalStorage } from "node:async_hooks";

import type { StatementBudgets } from "./config.js";
import type { DatabasePool, QueryResult, SqlExecutor } from "./database.js";
import type { QueryResultRow } from "pg";

/**
 * RFC-023 D1. The per-request statement budget, carried from the Fastify
 * `onRequest` hook down to whatever eventually runs a query.
 *
 * It is carried in an AsyncLocalStorage rather than threaded through every
 * handler signature because the queries are not all in the handlers: the
 * `/overview` aggregate calls `measureTableSizes`, `/paper/performance` calls
 * `buildPerformanceReport`, and both of those take a pool and run their own
 * SQL. A budget that only covered the call sites a reviewer remembered to
 * change would be the same kind of promise the 1 s inherited timeout was.
 *
 * `undefined` is meaningful: it says "not inside a budgeted GET", and the
 * wrapper below then leaves the query alone instead of forcing it READ ONLY.
 * That is what keeps the POST handlers — the kill-switch rearm, the halt and
 * resume, the curated edge — writable.
 */
const budgetStore = new AsyncLocalStorage<number>();

export function runWithBudget(
  statementTimeoutMs: number,
  next: () => void,
): void {
  budgetStore.run(statementTimeoutMs, next);
}

export function currentBudgetMs(): number | undefined {
  return budgetStore.getStore();
}

/**
 * The budget a route runs on: its own entry in `statement_timeout_ms.routes`,
 * or `default`. Fastify's route url is the declared pattern
 * (`/polymarket/decisions/:decisionId`), not the request path, so the map is
 * keyed by pattern and one entry covers every id.
 */
export function budgetForRoute(
  budgets: StatementBudgets,
  routeUrl: string | undefined,
): number {
  if (routeUrl === undefined) {
    return budgets.defaultMs;
  }
  return budgets.routes[routeUrl] ?? budgets.defaultMs;
}

/**
 * Wraps the pool the read modules are handed so that every `query` they make
 * during a budgeted GET becomes its own `readOnly` transaction.
 *
 * Per query, not per request, and that is the deliberate part. The `/overview`
 * handler fires its eight subqueries through `Promise.all`
 * (`polymarket/overview.ts`); one shared transaction would pin them to a single
 * client, serialise them, and make them share one budget — turning eight
 * independent 50-300 ms reads into one 800 ms read that fails as a unit. Each
 * gets its own transaction and the same per-route budget.
 *
 * `transaction` is passed through untouched: it is how the POST handlers write,
 * and wrapping it would break them.
 */
export function budgetedPool(pool: DatabasePool): DatabasePool {
  return {
    query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      const ms = currentBudgetMs();
      if (ms === undefined) {
        return pool.query<R>(text, params);
      }
      return pool.readOnly(ms, (tx: SqlExecutor) => tx.query<R>(text, params));
    },
    transaction: pool.transaction.bind(pool),
    readOnly: pool.readOnly.bind(pool),
    end: pool.end.bind(pool),
  };
}
