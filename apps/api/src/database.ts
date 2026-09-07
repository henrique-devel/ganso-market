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
  end(): Promise<void>;
}

export interface ReadinessProbe {
  check(): Promise<void>;
}

export interface DatabasePoolOverrides {
  /** Pool size; the API default (4) is too small for burst writers. */
  readonly max?: number;
  /** Query/statement timeout; the API default (connect timeout) is 2s. */
  readonly queryTimeoutMs?: number;
  readonly applicationName?: string;
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
  const queryTimeoutMs =
    overrides.queryTimeoutMs ?? config.database.connectTimeoutMs;
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

  return {
    query,
    async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
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
