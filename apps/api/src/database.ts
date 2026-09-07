import pg, { type PoolConfig, type QueryResultRow } from "pg";

import type { ApiConfig } from "./config.js";

const { Pool } = pg;

export interface QueryResult<R extends QueryResultRow> {
  readonly rows: R[];
  readonly rowCount: number;
}

export interface SqlExecutor {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export interface DatabasePool extends SqlExecutor {
  transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  /**
   * RFC-023 D1. One budgeted read: its own transaction, `SET TRANSACTION READ
   * ONLY` and `SET LOCAL statement_timeout` before anything else runs.
   *
   * Per-statement rather than per-session, for the reason spelled out in
   * `polymarket/portfolio/sweepstore.ts:15`: `pool.query` checks out whichever
   * client is free, so a session-level `SET` would guard one connection of the
   * pool and silently not the next. A transaction is bound to one client for
   * its whole life, so the budget travels with the statement it guards.
   */
  readOnly<T>(
    statementTimeoutMs: number,
    run: (tx: SqlExecutor) => Promise<T>,
  ): Promise<T>;
  end(): Promise<void>;
}

export interface ReadinessProbe {
  check(): Promise<void>;
}

export interface DatabasePoolOverrides {
  /** Pool size; the API default (4) is too small for burst writers. */
  readonly max?: number;
  /**
   * RFC-023 D1. Query/statement timeout, in milliseconds. REQUIRED: there is
   * no default, and omitting it throws QUERY_TIMEOUT_UNDECLARED at boot.
   *
   * Until 2026-09-07 this fell back to `config.database.connectTimeoutMs`, so
   * every API query inherited the 1 s connection budget that
   * `config/runtime.json` had set for something else entirely. Nobody chose
   * it, nobody knew it, and two of the panel's own subqueries were already at
   * 700 and 800 ms cold when it was measured. A budget nobody declared is a
   * budget nobody can defend.
   */
  readonly queryTimeoutMs?: number;
  readonly applicationName?: string;
}

/** Boot-time refusal; carries a reason code like ConfigError does. */
export class DatabaseConfigError extends Error {
  public readonly reasonCode: string;

  public constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "DatabaseConfigError";
    this.reasonCode = reasonCode;
  }
}

/**
 * RFC-020 D3. `pg` emits 'error' on the Pool when an IDLE client dies — the
 * database restarting, a network drop, an administrator terminating the
 * backend. Node treats an unhandled 'error' on an EventEmitter as fatal, so
 * until this handler existed every such event killed the process. Measured in
 * production on 2026-09-06: each of the five profile workers logged exactly one
 *
 *   throw er; // Unhandled 'error' event
 *   error: terminating connection due to administrator command
 *
 * per deploy, and Docker restarted them (RestartCount 13/17/46/4/8).
 *
 * The handler logs and stops there. `pg` already removes the failed client from
 * the pool, and the next query() opens a fresh connection: what was missing is
 * the handler, not reconnection logic. Boot failures stay fatal — the
 * entrypoints' `run().catch` sets process.exitCode = 1 — so fail-closed is
 * unchanged.
 */
function logPoolClientError(applicationName: string, error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      service: applicationName,
      timestamp: new Date().toISOString(),
      reason_code: "DB_POOL_CLIENT_ERROR",
      message: "database_pool_client_error",
      error_name: error instanceof Error ? error.name : "UnknownError",
      // The reason code alone was a mute alarm once already (OVERVIEW_API_FAILED,
      // 2026-09-04): for the `pg` driver error.name is the string "error".
      detail: error instanceof Error ? error.message : String(error),
      application_name: applicationName,
    })}\n`,
  );
}

export function createDatabasePool(
  config: ApiConfig,
  overrides: DatabasePoolOverrides = {},
): DatabasePool {
  const queryTimeoutMs = overrides.queryTimeoutMs;
  if (queryTimeoutMs === undefined) {
    throw new DatabaseConfigError(
      "QUERY_TIMEOUT_UNDECLARED",
      "createDatabasePool requires an explicit queryTimeoutMs",
    );
  }
  const applicationName = overrides.applicationName ?? "ganso-market-api";
  const pool = config.database.password.use((password) => {
    const poolConfig: PoolConfig = {
      host: config.database.host,
      port: config.database.port,
      database: config.database.name,
      user: config.database.user,
      password,
      connectionTimeoutMillis: config.database.connectTimeoutMs,
      query_timeout: queryTimeoutMs,
      statement_timeout: queryTimeoutMs,
      idleTimeoutMillis: 30_000,
      max: overrides.max ?? 4,
      application_name: applicationName,
    };
    if (config.database.ssl) {
      poolConfig.ssl = { rejectUnauthorized: true };
    }
    return new Pool(poolConfig);
  });
  pool.on("error", (error: unknown) => {
    logPoolClientError(applicationName, error);
  });

  async function query<R extends QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    const result = await pool.query<R>(
      text,
      params === undefined ? undefined : [...params],
    );
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  async function transaction<T>(
    run: (tx: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    const tx: SqlExecutor = {
      async query<R extends QueryResultRow>(
        text: string,
        params?: readonly unknown[],
      ): Promise<QueryResult<R>> {
        const result = await client.query<R>(
          text,
          params === undefined ? undefined : [...params],
        );
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      },
    };
    try {
      await client.query("BEGIN");
      const value = await run(tx);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // A failed rollback must not mask the original error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    query,
    transaction,
    async readOnly<T>(
      statementTimeoutMs: number,
      run: (tx: SqlExecutor) => Promise<T>,
    ): Promise<T> {
      // `SET LOCAL statement_timeout` takes no bind parameter, so the value is
      // interpolated — and therefore has to be proved to be an integer here
      // rather than trusted from the caller.
      if (
        !Number.isSafeInteger(statementTimeoutMs) ||
        statementTimeoutMs <= 0
      ) {
        throw new DatabaseConfigError(
          "QUERY_TIMEOUT_INVALID",
          "readOnly requires a positive integer statementTimeoutMs",
        );
      }
      return transaction(async (tx) => {
        // Order matters: `SET TRANSACTION` is only legal before the first
        // query of the transaction, so it goes first and the budget second.
        await tx.query("SET TRANSACTION READ ONLY");
        await tx.query(
          `SET LOCAL statement_timeout = ${String(statementTimeoutMs)}`,
        );
        return run(tx);
      });
    },
    async end(): Promise<void> {
      await pool.end();
    },
  };
}

export function createPostgresReadinessProbe(
  pool: Pick<DatabasePool, "query">,
): ReadinessProbe {
  return {
    async check(): Promise<void> {
      await pool.query("SELECT 1");
    },
  };
}
