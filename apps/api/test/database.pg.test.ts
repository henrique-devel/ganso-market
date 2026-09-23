import { randomUUID } from "node:crypto";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { SecretValue, type ApiConfig } from "../src/config.js";
import { createDatabasePool, type DatabasePool } from "../src/database.js";
import { createPgFixture } from "./pg-fixture.js";

const DATABASE_URL = process.env.GANSO_TEST_DATABASE_URL;

describe.skipIf(!DATABASE_URL)(
  "shared transaction resource lifecycle (PostgreSQL)",
  () => {
    let fixture: Awaited<ReturnType<typeof createPgFixture>>;
    let pool: DatabasePool;
    let config: ApiConfig;
    let applicationName: string;

    beforeAll(async () => {
      fixture = await createPgFixture(DATABASE_URL);
      const url = new URL(DATABASE_URL!);
      const database = await fixture.pool.query<{ name: string }>(
        "SELECT current_database() AS name",
      );
      config = {
        database: {
          host: url.hostname,
          port: Number(url.port || 5432),
          name: database.rows[0]!.name,
          user: decodeURIComponent(url.username),
          password: new SecretValue(decodeURIComponent(url.password)),
          ssl: false,
          connectTimeoutMs: 2_000,
        },
      } as ApiConfig;
      await fixture.pool.query(
        "CREATE TABLE transaction_release_probe (id integer PRIMARY KEY, value integer NOT NULL)",
      );
    });

    beforeEach(async () => {
      await fixture.pool.query("TRUNCATE transaction_release_probe");
      await fixture.pool.query(
        "INSERT INTO transaction_release_probe VALUES (1, 0)",
      );
      applicationName = `transaction-test-${randomUUID()}`;
      pool = createDatabasePool(config, {
        applicationName,
        queryTimeoutMs: 3_000,
        max: 1,
      });
    });

    afterEach(async () => {
      await pool.end();
    });

    afterAll(async () => {
      await fixture?.dispose();
    });

    async function backendPid(): Promise<number> {
      const result = await pool.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      return result.rows[0]!.pid;
    }

    async function assertRolledBackAndReusable(pid: number): Promise<void> {
      expect(await backendPid()).toBe(pid);
      const activity = await fixture.pool.query(
        "SELECT state, xact_start FROM pg_stat_activity WHERE pid = $1",
        [pid],
      );
      expect(activity.rows).toEqual([{ state: "idle", xact_start: null }]);
      // A second connection must see the rollback and acquire the row lock.
      const observer = await fixture.pool.connect();
      try {
        await observer.query("BEGIN");
        await observer.query("SET LOCAL lock_timeout = '500ms'");
        const row = await observer.query(
          "SELECT value FROM transaction_release_probe WHERE id = 1 FOR UPDATE",
        );
        expect(row.rows).toEqual([{ value: 0 }]);
      } finally {
        await observer.query("ROLLBACK");
        observer.release();
      }
    }

    it("commits normally and releases the only connection for a read-only transaction", async () => {
      const pid = await backendPid();
      const value = await pool.transaction(async (tx) => {
        await tx.query(
          "UPDATE transaction_release_probe SET value = 1 WHERE id = 1",
        );
        return "committed";
      });
      expect(value).toBe("committed");
      const result = await pool.readOnly(500, (tx) =>
        tx.query(
          "SELECT value, current_setting('transaction_read_only') AS read_only FROM transaction_release_probe",
        ),
      );
      expect(result.rows).toEqual([{ value: 1, read_only: "on" }]);
      expect(await backendPid()).toBe(pid);
    });

    it("rolls back a callback error after a write and releases its row lock", async () => {
      const pid = await backendPid();
      const failure = new Error("consumer failed after write");
      await expect(
        pool.transaction(async (tx) => {
          await tx.query(
            "UPDATE transaction_release_probe SET value = 1 WHERE id = 1",
          );
          throw failure;
        }),
      ).rejects.toBe(failure);
      await assertRolledBackAndReusable(pid);
    });

    it("rolls back a SQL error in the middle of a transaction", async () => {
      const pid = await backendPid();
      await expect(
        pool.transaction(async (tx) => {
          await tx.query(
            "UPDATE transaction_release_probe SET value = 1 WHERE id = 1",
          );
          await tx.query("SELECT 1 / 0");
        }),
      ).rejects.toMatchObject({ code: "22012" });
      await assertRolledBackAndReusable(pid);
    });

    it("rolls back a query cancelled by PostgreSQL and frees the pool slot", async () => {
      const pid = await backendPid();
      const pending = pool.transaction(async (tx) => {
        await tx.query(
          "UPDATE transaction_release_probe SET value = 1 WHERE id = 1",
        );
        await tx.query("SELECT pg_sleep(10)");
      });
      // Attach the rejection handler before sending the cancellation.
      const outcome = pending.catch((error: unknown) => error);
      await expect
        .poll(async () => {
          const result = await fixture.pool.query(
            "SELECT wait_event FROM pg_stat_activity WHERE pid = $1",
            [pid],
          );
          return result.rows[0]?.wait_event;
        })
        .toBe("PgSleep");
      const cancelled = await fixture.pool.query(
        "SELECT pg_cancel_backend($1) AS cancelled",
        [pid],
      );
      expect(cancelled.rows[0]?.cancelled).toBe(true);
      expect(await outcome).toMatchObject({ code: "57014" });
      await assertRolledBackAndReusable(pid);
    });

    it("releases a cancelled read-only transaction without leaking its local settings", async () => {
      const pid = await backendPid();
      await expect(
        pool.readOnly(50, (tx) => tx.query("SELECT pg_sleep(10)")),
      ).rejects.toMatchObject({ code: "57014" });
      await assertRolledBackAndReusable(pid);
      const settings = await pool.query(
        "SELECT current_setting('statement_timeout') AS timeout, current_setting('transaction_read_only') AS read_only",
      );
      expect(settings.rows).toEqual([{ timeout: "3s", read_only: "off" }]);
    });

    it("destroys the connection if a client timeout also prevents rollback", async () => {
      await pool.end();
      pool = createDatabasePool(config, {
        applicationName,
        queryTimeoutMs: 200,
        max: 1,
      });
      const pid = await backendPid();
      await expect(
        pool.transaction(async (tx) => {
          await tx.query(
            "UPDATE transaction_release_probe SET value = 1 WHERE id = 1",
          );
          // Test-only: keep the server busy beyond BOTH client timeouts. pg drops
          // the queued ROLLBACK when it times out; release() alone would pool an
          // open transaction that still owns the row lock after pg_sleep ends.
          await tx.query("SET LOCAL statement_timeout = 0");
          await tx.query("SELECT pg_sleep(1.5)");
        }),
      ).rejects.toThrow("Query read timeout");
      await expect
        .poll(
          async () => {
            const result = await fixture.pool.query(
              "SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE pid = $1",
              [pid],
            );
            return result.rows[0]?.sessions;
          },
          { timeout: 2_500 },
        )
        .toBe(0);
      const replacement = await backendPid();
      expect(replacement).not.toBe(pid);
      await assertRolledBackAndReusable(replacement);
    });
  },
);
