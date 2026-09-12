// DATA-02: real PostgreSQL, only in an explicitly configured disposable test
// database. All migrations/fixtures live in a unique schema removed at the end.
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  RETENTION_OBJECTS,
  RETENTION_POLICY_VERSION,
} from "../../src/polymarket/retention-policy.js";

const DATABASE_URL = process.env.GANSO_TEST_DATABASE_URL;
const SCHEMA = `data02_${randomUUID().replaceAll("-", "")}`;
const SHA = "d".repeat(64);
const INSERT_PIN = `INSERT INTO retention_evidence_pins
  (pin_id, dataset_id, table_name, reason, artifact_sha256)
  VALUES ($1, 'replay-dataset-v1', $2, 'Retain raw and prior L2 anchor', $3)`;
const INSERT_ORDER = `INSERT INTO paper_orders
  (order_id, token_id, side, order_type, limit_price, size, status, decided_at)
  VALUES ($1, 'data02-token', 'BUY', 'GTC', '0.400000', '2.000000', 'open',
          '2026-09-01T12:00:00Z')`;

describe.skipIf(DATABASE_URL === undefined)(
  "DATA-02 evidence protection (disposable PostgreSQL)",
  () => {
    let admin: pg.Pool | undefined;
    let raw: pg.Pool;
    let schemaCreated = false;
    let existingGuards: Record<string, unknown>[];

    const guards = async (client: pg.Pool | pg.PoolClient) =>
      (
        await client.query(
          `SELECT c.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS definition
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND NOT t.tgisinternal
             AND t.tgname NOT LIKE 'retention_%'
           ORDER BY c.relname, t.tgname`,
          [SCHEMA],
        )
      ).rows;

    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
      const identity = await admin.query<{ database: string }>(
        "SELECT current_database() AS database",
      );
      if (!identity.rows[0]?.database.includes("test")) {
        throw new Error(
          "DATA-02 SQL tests require a disposable *test* database",
        );
      }
      await admin.query(`CREATE SCHEMA ${SCHEMA}`);
      schemaCreated = true;
      raw = new pg.Pool({
        connectionString: DATABASE_URL,
        max: 4,
        options: `-c search_path=${SCHEMA} -c statement_timeout=5000 -c lock_timeout=3000`,
        application_name: SCHEMA,
      });
      const directory = new URL("../../../../migrations/", import.meta.url);
      const names = (await readdir(directory))
        .filter((name) => /^\d{4}_.+\.sql$/.test(name))
        .filter((name) => Number(name.slice(0, 4)) <= 23)
        .sort();
      expect(names).toHaveLength(23);
      const client = await raw.connect();
      try {
        for (const name of names) {
          if (name.startsWith("0023_")) existingGuards = await guards(client);
          const source = await readFile(new URL(name, directory), "utf8");
          const sql = source
            .replaceAll(":'migration_version'", `'${name.slice(0, 4)}'`)
            .replaceAll(
              ":'migration_checksum'",
              `'${createHash("sha256").update(source).digest("hex")}'`,
            );
          await client.query("BEGIN");
          await client.query(sql);
          await client.query("COMMIT");
        }
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }, 30_000);

    afterAll(async () => {
      await raw?.end();
      if (schemaCreated) await admin?.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
      await admin?.end();
    });

    it("installs the explicit 73-table policy without changing existing guards or auth", async () => {
      const metadata = await raw.query<{ version: string; tables: string[] }>(
        `SELECT retention_evidence_policy_version() AS version,
                retention_evidence_tables() AS tables`,
      );
      expect(metadata.rows).toEqual([
        { version: RETENTION_POLICY_VERSION, tables: RETENTION_OBJECTS },
      ]);
      expect(metadata.rows[0]?.tables).toHaveLength(73);
      expect(await guards(raw)).toEqual(existingGuards);
      const triggers = await raw.query<{
        relname: string;
        tgname: string;
        tgtype: number;
        tgenabled: string;
      }>(
        `SELECT c.relname, t.tgname, t.tgtype, t.tgenabled
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND t.tgname IN
           ('retention_evidence_write_lock_trg', 'retention_evidence_delete_guard_trg')`,
        [SCHEMA],
      );
      expect(triggers.rows).toHaveLength(146);
      for (const table of RETENTION_OBJECTS) {
        expect(triggers.rows).toContainEqual({
          relname: table,
          tgname: "retention_evidence_write_lock_trg",
          tgtype: 22, // BEFORE, INSERT/UPDATE, STATEMENT.
          tgenabled: "O",
        });
        expect(triggers.rows).toContainEqual({
          relname: table,
          tgname: "retention_evidence_delete_guard_trg",
          tgtype: 42, // BEFORE, DELETE/TRUNCATE, STATEMENT.
          tgenabled: "O",
        });
      }
      await expect(
        raw.query("DELETE FROM auth_login_throttle WHERE false"),
      ).resolves.toHaveProperty("rowCount", 0);
      await expect(
        raw.query("TRUNCATE auth_login_throttle"),
      ).resolves.toBeDefined();
    });

    it("refuses legacy DELETE and TRUNCATE on every held table, including zero rows", async () => {
      for (const table of RETENTION_OBJECTS) {
        await expect(
          raw.query(`DELETE FROM ${table} WHERE false`),
        ).rejects.toMatchObject({
          code: "55000",
        });
        // CASCADE handles FK prerequisites; every affected evidence table has
        // its own guard and the entire statement must roll back.
        await expect(
          raw.query(`TRUNCATE ${table} CASCADE`),
        ).rejects.toMatchObject({
          code: "55000",
        });
      }
    });

    it("preserves ledger/strategy immutability and keeps normal order/position updates working", async () => {
      await raw.query(INSERT_ORDER, ["data02-open-order"]);
      await raw.query(`INSERT INTO paper_positions (token_id, shares, cost_usd)
        VALUES ('data02-token', '2.000000', '0.800000')`);
      await raw.query(`INSERT INTO paper_ledger_events
        (idempotency_key, event_type, order_id, token_id, event_ts)
        VALUES ('data02-ledger', 'order_accepted', 'data02-open-order',
                'data02-token', '2026-09-01T12:00:00Z')`);
      await raw.query(
        `INSERT INTO strategy_decisions
        (strategy_id, arm, decision_ts, condition_id, config_version, config_hash,
         policy_version, mode, verdict, reason, assumed_taker_fee_rate)
        VALUES ('fast-data02', 'A', '2026-09-01T12:00:00Z', 'data02-condition',
                '1.0.0', $1, 'v1', 'shadow', 'skip', 'FAST_NO_SIGNAL', '0')`,
        [SHA],
      );

      await expect(
        raw.query(`UPDATE paper_ledger_events SET payload_json = '{}'
        WHERE idempotency_key = 'data02-ledger'`),
      ).rejects.toThrow("append-only ledger");
      await expect(
        raw.query(`UPDATE strategy_decisions SET reason = 'FAST_OTHER'
        WHERE strategy_id = 'fast-data02'`),
      ).rejects.toThrow("append-only");
      await expect(
        raw.query(`DELETE FROM paper_orders
        WHERE order_id = 'data02-open-order'`),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        raw.query(`DELETE FROM paper_positions
        WHERE token_id = 'data02-token'`),
      ).rejects.toMatchObject({ code: "55000" });
      await raw.query(`UPDATE paper_orders SET status = 'filled', filled_size = '2.000000'
        WHERE order_id = 'data02-open-order'`);
      await raw.query(`UPDATE paper_positions SET mark_value_usd = '0.900000'
        WHERE token_id = 'data02-token'`);
      expect(
        (
          await raw.query(`SELECT status, filled_size FROM paper_orders
        WHERE order_id = 'data02-open-order'`)
        ).rows,
      ).toEqual([{ status: "filled", filled_size: "2.000000" }]);
      expect(
        (
          await raw.query(`SELECT mark_value_usd FROM paper_positions
        WHERE token_id = 'data02-token'`)
        ).rows,
      ).toEqual([{ mark_value_usd: "0.900000" }]);
    });

    it("validates table-wide pins and atomically audits insert/removal while holding all evidence", async () => {
      for (const table of [
        "auth_accounts",
        "unknown_dataset_table",
        "paper_%",
      ]) {
        await expect(
          raw.query(INSERT_PIN, ["invalid-pin", table, SHA]),
        ).rejects.toMatchObject({ code: "23514" });
      }
      await raw.query(INSERT_PIN, ["audit-pin", "polymarket_book_deltas", SHA]);
      const pin = (
        await raw.query(`SELECT to_jsonb(p) AS pin
        FROM retention_evidence_pins p WHERE pin_id = 'audit-pin'`)
      ).rows[0]?.pin;
      await expect(
        raw.query(`UPDATE retention_evidence_pins SET reason = 'rewrite'
        WHERE false`),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        raw.query("TRUNCATE retention_evidence_pins"),
      ).rejects.toMatchObject({ code: "55000" });
      await raw.query(
        "DELETE FROM retention_evidence_pins WHERE pin_id = 'audit-pin'",
      );
      expect(
        (
          await raw.query(`SELECT operation, pin FROM retention_pin_events
        WHERE pin->>'pin_id' = 'audit-pin' ORDER BY event_id`)
        ).rows,
      ).toEqual([
        { operation: "INSERT", pin },
        { operation: "DELETE", pin },
      ]);
      for (const sql of [
        "UPDATE retention_pin_events SET operation = 'DELETE' WHERE false",
        "DELETE FROM retention_pin_events WHERE false",
        "TRUNCATE retention_pin_events",
        "DELETE FROM polymarket_book_deltas WHERE false",
      ])
        await expect(raw.query(sql)).rejects.toMatchObject({ code: "55000" });

      const client = await raw.connect();
      try {
        await client.query("BEGIN");
        await client.query(INSERT_PIN, [
          "rolled-back-pin",
          "paper_orders",
          SHA,
        ]);
        expect(
          (
            await client.query(`SELECT operation FROM retention_pin_events
          WHERE pin->>'pin_id' = 'rolled-back-pin'`)
          ).rows,
        ).toHaveLength(1);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      expect(
        (
          await raw.query(`SELECT pin_id FROM retention_evidence_pins
        WHERE pin_id = 'rolled-back-pin'`)
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await raw.query(`SELECT operation FROM retention_pin_events
        WHERE pin->>'pin_id' = 'rolled-back-pin'`)
        ).rows,
      ).toHaveLength(0);
    });

    it("lets independent reference writers coexist and rejects pin/selector acquisition until commit", async () => {
      const writer = await raw.connect();
      const secondWriter = await raw.connect();
      try {
        await writer.query("BEGIN");
        await writer.query(INSERT_ORDER, ["concurrent-order-one"]);
        await secondWriter.query("BEGIN");
        await secondWriter.query(INSERT_ORDER, ["concurrent-order-two"]);
        await expect(
          raw.query("SELECT retention_evidence_lock()"),
        ).rejects.toMatchObject({ code: "55P03" });
        await expect(
          raw.query(INSERT_PIN, ["writer-race-pin", "paper_orders", SHA]),
        ).rejects.toMatchObject({ code: "55P03" });
        await writer.query("COMMIT");
        await expect(
          raw.query("SELECT retention_evidence_lock()"),
        ).rejects.toMatchObject({ code: "55P03" });
        await secondWriter.query("COMMIT");
        await raw.query(INSERT_PIN, ["writer-race-pin", "paper_orders", SHA]);
        await raw.query("SELECT retention_evidence_lock()");
      } finally {
        await writer.query("ROLLBACK");
        await secondWriter.query("ROLLBACK");
        writer.release();
        secondWriter.release();
      }
    });

    for (const exclusiveOwner of ["pin", "selector"]) {
      it(`preserves a concurrent writer while the short ${exclusiveOwner} transaction holds its snapshot`, async () => {
        const exclusive = await raw.connect();
        const writer = await raw.connect();
        let pending: Promise<pg.QueryResult> | undefined;
        try {
          await exclusive.query("BEGIN ISOLATION LEVEL READ COMMITTED");
          if (exclusiveOwner === "selector") {
            await exclusive.query("SET TRANSACTION READ ONLY");
            await exclusive.query("SELECT retention_evidence_lock()");
          } else {
            await exclusive.query(INSERT_PIN, [
              "pin-first",
              "paper_orders",
              SHA,
            ]);
          }
          const pid = (
            await writer.query<{ pid: number }>(
              "SELECT pg_backend_pid() AS pid",
            )
          ).rows[0]?.pid;
          const startedAt = Date.now();
          pending = writer.query(INSERT_ORDER, [
            `${exclusiveOwner}-held-order`,
          ]);
          void pending.catch(() => undefined);
          let waiting = false;
          while (Date.now() - startedAt < 1000 && !waiting) {
            const locks = await raw.query(
              `SELECT 1 FROM pg_locks
              WHERE pid = $1 AND locktype = 'advisory' AND NOT granted`,
              [pid],
            );
            waiting = locks.rows.length > 0;
            if (!waiting)
              await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(waiting).toBe(true);
          expect(
            (
              await exclusive.query(
                "SELECT order_id FROM paper_orders WHERE order_id = $1",
                [`${exclusiveOwner}-held-order`],
              )
            ).rows,
          ).toHaveLength(0);
          await exclusive.query("COMMIT");
          await expect(pending).resolves.toHaveProperty("rowCount", 1);
          expect(Date.now() - startedAt).toBeLessThan(2000);
          expect(
            (
              await raw.query(
                "SELECT order_id FROM paper_orders WHERE order_id = $1",
                [`${exclusiveOwner}-held-order`],
              )
            ).rows,
          ).toHaveLength(1);
        } finally {
          await exclusive.query("ROLLBACK");
          await pending?.catch(() => undefined);
          exclusive.release();
          writer.release();
        }
      });
    }
  },
);
