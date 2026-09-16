import { setTimeout } from "node:timers/promises";
import { randomUUID } from "node:crypto";

import pg from "pg";

/** Clone a pristine migrated test database; preserve every production trigger.
 * Call dispose after closing any extra clients. Only this helper's random
 * database is dropped, never the supplied template or its rows.
 */
export async function createPgFixture(connectionString: string | undefined) {
  if (!connectionString) throw new Error("Disposable test database required");
  const url = new URL(connectionString);
  const template = decodeURIComponent(url.pathname.slice(1));
  if (!template.includes("test"))
    throw new Error("Fixture template must be a disposable *test* database");
  const name = `qa01_case_test_${randomUUID().replaceAll("-", "")}`;
  const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Client({
    connectionString: adminUrl.href,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  });
  try {
    await admin.connect();
    await admin.query(
      `CREATE DATABASE ${identifier(name)} TEMPLATE ${identifier(template)}`,
    );
  } catch (error) {
    await admin.end();
    throw error;
  }
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.href, max: 4 });
  return {
    pool,
    async dispose() {
      try {
        await pool.end();
        // pg.Pool.end() may resolve before the server sees every socket close.
        // Wait for those sessions to disappear instead of forcibly terminating
        // a closing client and producing an unhandled FATAL in Vitest.
        for (let attempt = 0; ; attempt += 1) {
          const sessions = await admin.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1",
            [name],
          );
          if (sessions.rows[0]?.n === 0) break;
          if (attempt === 100)
            throw new Error("Fixture sessions did not close");
          await setTimeout(25);
        }
        await admin.query(`DROP DATABASE ${identifier(name)}`);
      } finally {
        await admin.end();
      }
    },
  };
}
