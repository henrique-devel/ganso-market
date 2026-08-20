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

export function createDatabasePool(
  config: ApiConfig,
  overrides: DatabasePoolOverrides = {},
): DatabasePool {
  const queryTimeoutMs =
    overrides.queryTimeoutMs ?? config.database.connectTimeoutMs;
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
      application_name: overrides.applicationName ?? "ganso-market-api",
    };
    if (config.database.ssl) {
      poolConfig.ssl = { rejectUnauthorized: true };
    }
    return new Pool(poolConfig);
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
