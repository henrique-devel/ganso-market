// DATA-02 only: real SQL against a disposable database, private schema per case.
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { DatabasePool, SqlExecutor } from "../../src/database.js";
import {
  createRetentionDryRun,
  retentionHash,
  verifyRetentionManifest,
} from "../../src/polymarket/retention-manifest.js";

const DATABASE_URL = process.env["GANSO_TEST_DATABASE_URL"];
const migrationDirectory = new URL("../../../../migrations/", import.meta.url);
const fixed = {
  cutoffUtc: "2026-09-01T00:00:00Z",
  generatedAtUtc: "2026-09-12T10:00:00Z",
  gitSha: "a".repeat(40),
};

describe.skipIf(DATABASE_URL === undefined)(
  "DATA-02 bounded manifest PostgreSQL",
  () => {
    let client: pg.Client;
    let schema: string;
    let migrations: string[];
    let pool: Pick<DatabasePool, "transaction">;
    beforeAll(async () => {
      client = new pg.Client({ connectionString: DATABASE_URL });
      await client.connect();
      migrations = await Promise.all(
        (await readdir(migrationDirectory))
          .filter((name) => /^\d{4}_.*\.sql$/.test(name))
          .sort()
          .map(async (name) => {
            const sql = await readFile(
              new URL(name, migrationDirectory),
              "utf8",
            );
            return sql
              .replaceAll(
                ":'migration_version'",
                `'${Number(name.slice(0, 4))}'`,
              )
              .replaceAll(
                ":'migration_checksum'",
                `'${createHash("sha256").update(sql).digest("hex")}'`,
              );
          }),
      );
      const tx: SqlExecutor = {
        async query<R extends Record<string, unknown>>(
          text: string,
          params: readonly unknown[] = [],
        ) {
          const result = await client.query<R>(text, [...params]);
          return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        },
      };
      pool = {
        async transaction<T>(run: (executor: SqlExecutor) => Promise<T>) {
          await client.query("BEGIN");
          try {
            const result = await run(tx);
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        },
      };
    });
    beforeEach(async () => {
      schema = `data02_manifest_${randomUUID().replaceAll("-", "")}`;
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, pg_catalog`);
      for (const sql of migrations) {
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
    });
    afterEach(async () => {
      await client.query("ROLLBACK");
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
    });
    afterAll(async () => {
      await client?.end();
    });

    it("bounds the inspected primary-key slab before a sparse time filter and distinguishes exact count from estimate", async () => {
      await client.query(`INSERT INTO bonding_curve_state (mint, updated_at) VALUES
      ('a','2026-08-31T23:59:59.999999Z'), ('b','2026-09-02Z'),
      ('c','2026-08-20Z'), ('d','2026-09-01Z')`);
      const manifest = await createRetentionDryRun(pool, {
        ...fixed,
        tables: ["bonding_curve_state"],
        limit: 2,
      });
      const selection = manifest.selections[0]!;
      expect(selection.inspectedRows).toBe(2);
      expect(selection.watermark).toBe("d");
      expect(selection.candidates.map((row) => row.key)).toEqual(["a"]);
      expect(selection.candidates[0]?.timestampUtc).toBe(
        "2026-08-31T23:59:59.999999Z",
      );
      expect(selection.candidateCount).toEqual({
        value: 1,
        exact: true,
        scope: "bounded_primary_key_slice",
      });
      expect(selection.entireCutoffCount).toBeNull();
      expect(selection.hasMore).toBe(true);
      expect(selection.bytes.recoverablePhysical).toBeNull();
      expect(manifest.executionAllowed).toBe(false);
      const exact = await client.query(selection.predicate.sql, [
        ...selection.predicate.parameters,
      ]);
      expect(exact.rows.map((row) => row.key)).toEqual(["a"]);
      expect(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM bonding_curve_state",
          )
        ).rows[0]?.n,
      ).toBe(4);
    });

    it("keeps 64-bit keys as strings and cutoff timestamp ties deterministic", async () => {
      await client.query(`INSERT INTO event_quarantine
      (quarantine_id, program_id, discriminator, slot, payload_hash, received_at) OVERRIDING SYSTEM VALUE VALUES
      (9007199254740993,'legacy','0000000000000000',1,repeat('a',64),'2026-08-31Z'),
      (9007199254740994,'legacy','0000000000000000',2,repeat('b',64),'2026-08-31Z'),
      (9007199254740995,'legacy','0000000000000000',3,repeat('c',64),'2026-09-01Z')`);
      const request = { ...fixed, tables: ["event_quarantine"] };
      const one = await createRetentionDryRun(pool, request);
      const two = await createRetentionDryRun(pool, request);
      expect(one).toEqual(two);
      expect(one.selections[0]?.candidates.map((row) => row.key)).toEqual([
        "9007199254740993",
        "9007199254740994",
      ]);
      expect(one.selections[0]?.entireCutoffCount).toBe(2);
      expect(Object.isFrozen(one.selections[0]?.candidates)).toBe(true);
      verifyRetentionManifest(one, new Date("2026-09-12T10:01:00Z"));
    });

    it("holds ledger/orders/open-position closure and raw even without a dataset pin or aggregate", async () => {
      const manifest = await createRetentionDryRun(pool, {
        ...fixed,
        tables: [
          "paper_ledger_events",
          "paper_orders",
          "portfolio_decisions",
          "polymarket_book_deltas",
        ],
      });
      expect(manifest.selections).toHaveLength(4);
      for (const selection of manifest.selections) {
        expect(selection.disposition).toBe("held");
        expect(selection.predicate.sql).toBe("FALSE");
        expect(selection.inspectedRows).toBe(0);
        expect(selection.candidates).toEqual([]);
        expect(selection.quotaCanOverrideProtection).toBe(false);
      }
    });

    it("applies whole-table dataset pins to residual review and changes the manifest on pin drift", async () => {
      await client.query(
        "INSERT INTO bonding_curve_state (mint, updated_at) VALUES ('pinned', '2026-08-01Z')",
      );
      const request = { ...fixed, tables: ["bonding_curve_state"] };
      const before = await createRetentionDryRun(pool, request);
      await client.query(`INSERT INTO retention_evidence_pins (pin_id,dataset_id,table_name,reason,artifact_sha256)
      VALUES ('pin-1','replay-1','bonding_curve_state','historical evidence',repeat('a',64))`);
      const after = await createRetentionDryRun(pool, request);
      expect(before.selections[0]?.candidateCount.value).toBe(1);
      expect(after.selections[0]?.reason).toBe("DATASET_PIN");
      expect(after.selections[0]?.candidates).toEqual([]);
      expect(after.hash).not.toBe(before.hash);
    });

    it("detects disabled SQL protections instead of claiming migration alone proves application", async () => {
      await client.query(
        "ALTER TABLE paper_orders DISABLE TRIGGER retention_evidence_delete_guard_trg",
      );
      await expect(
        createRetentionDryRun(pool, {
          ...fixed,
          tables: ["bonding_curve_state"],
        }),
      ).rejects.toThrow("RETENTION_PROTECTION_NOT_APPLIED:paper_orders");
    });

    it("rejects a disabled pin writer lock", async () => {
      await client.query(
        "ALTER TABLE retention_evidence_pins DISABLE TRIGGER retention_evidence_pins_lock_trg",
      );
      await expect(
        createRetentionDryRun(pool, {
          ...fixed,
          tables: ["bonding_curve_state"],
        }),
      ).rejects.toThrow(
        "RETENTION_PROTECTION_NOT_APPLIED:retention_evidence_pins",
      );
    });

    it("hashes bigint payloads exactly and normalizes session timezone", async () => {
      await client.query(
        "INSERT INTO bonding_curve_state (mint,last_slot,updated_at) VALUES ('large',9007199254740992,'2026-08-31T23:00:00Z')",
      );
      const request = { ...fixed, tables: ["bonding_curve_state"] };
      await client.query("SET TIME ZONE 'America/Sao_Paulo'");
      const first = await createRetentionDryRun(pool, request);
      await client.query("SET TIME ZONE 'UTC'");
      expect((await createRetentionDryRun(pool, request)).hash).toBe(
        first.hash,
      );
      await client.query(
        "UPDATE bonding_curve_state SET last_slot = 9007199254740993 WHERE mint = 'large'",
      );
      const next = await createRetentionDryRun(pool, request);
      expect(next.selections[0]?.candidates[0]?.rowHash).not.toBe(
        first.selections[0]?.candidates[0]?.rowHash,
      );
    });

    it("binds content and schema into the hash and rejects edits/expiration", async () => {
      await client.query(
        "INSERT INTO bonding_curve_state (mint, updated_at) VALUES ('changed', '2026-08-01Z')",
      );
      const request = { ...fixed, tables: ["bonding_curve_state"] };
      const original = await createRetentionDryRun(pool, request);
      await client.query(
        "UPDATE bonding_curve_state SET last_slot = 4 WHERE mint = 'changed'",
      );
      const changed = await createRetentionDryRun(pool, request);
      expect(changed.selections[0]?.candidates[0]?.rowHash).not.toBe(
        original.selections[0]?.candidates[0]?.rowHash,
      );
      expect(changed.hash).not.toBe(original.hash);
      expect(() =>
        verifyRetentionManifest(original, new Date(original.expiresAtUtc)),
      ).toThrow("EXPIRED");
      expect(() =>
        verifyRetentionManifest(
          { ...original, cutoffUtc: "2026-09-02T00:00:00Z" },
          new Date(fixed.generatedAtUtc),
        ),
      ).toThrow("HASH_MISMATCH");
      await client.query(
        "ALTER TABLE bonding_curve_state ADD COLUMN provenance text",
      );
      expect((await createRetentionDryRun(pool, request)).schemaHash).not.toBe(
        original.schemaHash,
      );
      expect(retentionHash({ b: 2, a: 1 })).toBe(retentionHash({ a: 1, b: 2 }));
      const { id: _id, hash: _hash, ...body } = original;
      const invalid = { ...body, expiresAtUtc: "invalid" };
      const hash = retentionHash(invalid);
      expect(() =>
        verifyRetentionManifest(
          { ...invalid, hash, id: `sha256:${hash}` },
          new Date(fixed.generatedAtUtc),
        ),
      ).toThrow("RETENTION_");
    });

    it.each([
      { tables: ["*"] },
      { tables: ["paper_orders; DELETE FROM paper_orders"] },
      { tables: ["auth_sessions"] },
      { tables: ["paper_orders", "paper_orders"] },
      { tables: ["paper_orders"], limit: 1001 },
      { tables: ["paper_orders"], cutoffUtc: "2026-08-31T21:00:00-03:00" },
      { tables: ["paper_orders"], cutoffUtc: "2026-08-31T00:00:00.000123Z" },
      { tables: ["paper_orders"], cutoffUtc: "2026-09-31T00:00:00Z" },
    ])(
      "rejects ambiguous/unbounded request before selection: %j",
      async (invalid) => {
        await expect(
          createRetentionDryRun(pool, { ...fixed, ...invalid }),
        ).rejects.toThrow("RETENTION_");
      },
    );
  },
);
