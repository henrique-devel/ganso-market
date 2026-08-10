import pg, { type PoolConfig } from "pg";

import type { ApiConfig } from "./config.js";

const { Pool } = pg;

export interface DatabasePool {
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
}

export interface ReadinessProbe {
  check(): Promise<void>;
}

export function createDatabasePool(config: ApiConfig): DatabasePool {
  return config.database.password.use((password) => {
    const poolConfig: PoolConfig = {
      host: config.database.host,
      port: config.database.port,
      database: config.database.name,
      user: config.database.user,
      password,
      connectionTimeoutMillis: config.database.connectTimeoutMs,
      query_timeout: config.database.connectTimeoutMs,
      statement_timeout: config.database.connectTimeoutMs,
      idleTimeoutMillis: 30_000,
      max: 4,
      application_name: "ganso-market-api",
    };
    if (config.database.ssl) {
      poolConfig.ssl = { rejectUnauthorized: true };
    }
    return new Pool(poolConfig);
  });
}

export function createPostgresReadinessProbe(
  pool: DatabasePool,
): ReadinessProbe {
  return {
    async check(): Promise<void> {
      await pool.query("SELECT 1");
    },
  };
}
