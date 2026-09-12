// DATA-03 only. Every case owns fresh databases; no production fixtures.
import { execFileSync } from "node:child_process";
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
  vi,
} from "vitest";
import type { DatabasePool, SqlExecutor } from "../../src/database.js";
import {
  exportRetentionArchive,
  preflightRestore,
  restoreRetentionArchive,
  validateArchiveEndpoint,
  verifyRestoreCertificate,
  type ArchiveBudget,
  type ArchiveProfile,
  type PreservationPlan,
  type RetentionArchive,
} from "../../src/polymarket/retention-archive.js";
import {
  createRetentionDryRun,
  retentionHash,
} from "../../src/polymarket/retention-manifest.js";

const DATABASE_URL = process.env["GANSO_TEST_DATABASE_URL"];
const CONTAINER = process.env["GANSO_DATA03_TEST_CONTAINER"];
const MAX_BYTES = 16 * 1024 * 1024;
const KEYS: Record<string, string> = {
  polymarket_book_snapshots_full: "snapshot_id",
  polymarket_book_deltas: "delta_id",
  paper_orders: "order_id",
  paper_ledger_events: "event_id",
  paper_positions: "token_id",
  bonding_curve_state: "mint",
};
const RAW_TABLES = ["polymarket_book_deltas", "polymarket_book_snapshots_full"];
const PAPER_TABLES = ["paper_ledger_events", "paper_orders", "paper_positions"];
const RAW_SQL = `INSERT INTO polymarket_book_snapshots_full
  (snapshot_id,token_id,reason,bids_json,asks_json,source_ts,received_at) OVERRIDING SYSTEM VALUE VALUES
  (9007199254740993,'archive-token','anchor','[{"price":"0.4","size":"3"}]',
   '[{"price":"0.6","size":"4"}]','2026-01-01T00:00:00.123455Z','2026-01-01T00:00:00.123456Z');
  INSERT INTO polymarket_book_deltas
  (delta_id,token_id,side,price,size,source_ts,received_at) OVERRIDING SYSTEM VALUE VALUES
  (9007199254740994,'archive-token','BUY','0.4','5','2026-01-01T00:00:00.123456Z','2026-01-01T00:00:00.123457Z'),
  (9007199254740995,'archive-token','SELL','0.6','0','2026-01-01T00:00:00.123457Z','2026-01-01T00:00:00.123458Z');`;
const PAPER_SQL = `INSERT INTO paper_orders
  (order_id,token_id,source,side,order_type,status,limit_price,size,filled_size,
   decided_at,accepted_at,closed_at) VALUES
  ('archive-order','archive-token','manual','BUY','GTC','filled','0.5','2','2',
   '2026-01-01T00:00:00.123456Z','2026-01-01T00:00:00.123456Z','2026-01-01T00:00:00.123458Z');
  INSERT INTO paper_ledger_events
  (event_id,idempotency_key,order_id,token_id,event_type,event_ts,payload_json)
  OVERRIDING SYSTEM VALUE VALUES
  (9007199254740993,'archive-order:accepted','archive-order','archive-token','order_accepted',
   '2026-01-01T00:00:00.123456Z',
   '{"source":"manual","side":"BUY","order_type":"GTC","limit_price":"0.5","size":"2"}'),
  (9007199254740994,'archive-order:fill','archive-order','archive-token','fill',
   '2026-01-01T00:00:00.123457Z',
   '{"side":"BUY","price":"0.4","size":"2","fee":"0.01","book_slice":[{"price":"0.4","size":"2"}]}');
  INSERT INTO paper_positions
  (token_id,shares,cost_usd,fees_paid_usd,realized_pnl_usd,opened_at) VALUES
  ('archive-token','2','0.8','0.01','-0.01','2026-01-01T00:00:00.123457Z');`;

function pool(raw: pg.Pool): Pick<DatabasePool, "transaction"> {
  return {
    async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const client = await raw.connect();
      const tx: SqlExecutor = {
        async query<R extends Record<string, unknown>>(
          sql: string,
          values: readonly unknown[] = [],
        ) {
          const result = await client.query<R>(sql, [...values]);
          return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        },
      };
      try {
        await client.query("BEGIN");
        const result = await run(tx);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function anchors(archive: RetentionArchive) {
  return {
    archiveHash: archive.hash,
    planHash: archive.planHash,
    gitSha: archive.manifest.gitSha,
  };
}

function rehash<T extends { hash: string }>(value: T): T {
  const { hash: _hash, ...body } = value;
  return { ...body, hash: retentionHash(body) } as T;
}

describe.skipIf(!DATABASE_URL || !CONTAINER)(
  "DATA-03 archive and isolated restore (real PostgreSQL)",
  () => {
    let admin: pg.Pool;
    let source: pg.Pool;
    let target: pg.Pool;
    let sourceName: string;
    let targetName: string;
    let templateName: string;
    let containerSystem: string;
    const created: string[] = [];

    function url(database: string): string {
      const parsed = new URL(DATABASE_URL!);
      parsed.pathname = `/${database}`;
      return parsed.toString();
    }
    async function budget(): Promise<ArchiveBudget> {
      // Actual target volume measurement, freshly taken before each transfer.
      const line = execFileSync(
        "docker",
        ["exec", CONTAINER!, "df", "-B1", "/var/lib/postgresql"],
        { encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .at(-1)!;
      const columns = line.trim().split(/\s+/);
      const identity = (
        await target.query<{ database: string; system_identifier: string }>(
          "SELECT current_database() AS database, system_identifier::text FROM pg_control_system()",
        )
      ).rows[0]!;
      expect(identity.system_identifier).toBe(containerSystem);
      return {
        maxBytes: MAX_BYTES,
        capacity: {
          database: identity.database,
          systemIdentifier: identity.system_identifier,
          totalBytes: Number(columns[1]),
          freeBytes: Number(columns[3]),
          measuredAtUtc: new Date().toISOString(),
          method: "disposable-postgres-volume-df",
        },
      };
    }
    async function snapshot(
      raw: pg.Pool,
      tables: string[],
    ): Promise<Record<string, { key: string; value: string }[]>> {
      const rows: Record<string, { key: string; value: string }[]> = {};
      await raw.query("SET TIME ZONE 'UTC'");
      for (const table of tables)
        rows[table] = (
          await raw.query<{ key: string; value: string }>(
            `SELECT "${KEYS[table]}"::text AS key,to_jsonb(r)::text AS value FROM public."${table}" r ORDER BY "${KEYS[table]}"`,
          )
        ).rows;
      return rows;
    }
    async function prepare(profile: ArchiveProfile = "raw-l2") {
      const tables = profile === "raw-l2" ? RAW_TABLES : PAPER_TABLES;
      await source.query(profile === "raw-l2" ? RAW_SQL : PAPER_SQL);
      const before = await snapshot(source, tables);
      const manifest = await createRetentionDryRun(pool(source), {
        tables,
        cutoffUtc: "2026-02-01T00:00:00Z",
        generatedAtUtc: new Date().toISOString(),
        gitSha: "3".repeat(40),
        limit: 10,
      });
      const plan: PreservationPlan = {
        formatVersion: "data-03-fixture-plan-v1",
        fixtureOnly: true,
        datasetId: "data03-independent-fixture",
        manifestHash: manifest.hash,
        profile,
        historicalCompleteness: "unknown",
        rows: Object.fromEntries(
          Object.entries(before).map(([table, rows]) => [
            table,
            rows.map((row) => ({
              key: row.key,
              rowHash: retentionHash(row.value),
            })),
          ]),
        ),
      };
      return { manifest, plan, before, tables, budget: await budget() };
    }
    async function archive(profile: ArchiveProfile = "raw-l2") {
      const prepared = await prepare(profile);
      return {
        ...prepared,
        archive: await exportRetentionArchive(
          pool(source),
          pool(target),
          prepared.manifest,
          prepared.plan,
          prepared.budget,
        ),
      };
    }
    async function emptyTarget(tables = RAW_TABLES): Promise<void> {
      for (const table of tables)
        expect(
          (
            await target.query(
              `SELECT count(*)::int AS n FROM public."${table}"`,
            )
          ).rows[0]?.n,
        ).toBe(0);
    }

    beforeAll(async () => {
      validateArchiveEndpoint(DATABASE_URL!, "source");
      if (!/^ganso-data03-[a-z0-9-]+$/.test(CONTAINER!))
        throw new Error("Exclusive DATA-03 disposable container required");
      containerSystem = execFileSync(
        "docker",
        [
          "exec",
          CONTAINER!,
          "psql",
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-At",
          "-c",
          "SELECT system_identifier::text FROM pg_control_system()",
        ],
        { encoding: "utf8" },
      ).trim();
      admin = new pg.Pool({ connectionString: url("postgres"), max: 1 });
      templateName = `ganso_data03_source_template_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`CREATE DATABASE ${templateName}`);
      created.push(templateName);
      const template = new pg.Client({ connectionString: url(templateName) });
      await template.connect();
      try {
        const directory = new URL("../../../../migrations/", import.meta.url);
        const names = (await readdir(directory))
          .filter(
            (name) =>
              /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 23,
          )
          .sort();
        expect(names).toHaveLength(23);
        for (const name of names) {
          const original = await readFile(new URL(name, directory), "utf8");
          const checksum = createHash("sha256").update(original).digest("hex");
          await template.query("BEGIN");
          await template.query(
            original
              .replaceAll(":'migration_version'", `'${name.slice(0, 4)}'`)
              .replaceAll(":'migration_checksum'", `'${checksum}'`),
          );
          await template.query("COMMIT");
          expect(
            (
              await template.query(
                "SELECT checksum_sha256 FROM schema_versions WHERE version=$1",
                [Number(name.slice(0, 4))],
              )
            ).rows[0]?.checksum_sha256,
          ).toBe(checksum);
        }
        expect(
          (
            await template.query(
              "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('retention_evidence_write_lock_trg','retention_evidence_delete_guard_trg') AND tgenabled='O'",
            )
          ).rows[0]?.n,
        ).toBe(146);
      } finally {
        await template.end();
      }
    }, 30_000);

    beforeEach(async () => {
      const suffix = randomUUID().replaceAll("-", "");
      sourceName = `ganso_data03_source_${suffix}`;
      targetName = `ganso_data03_restore_${suffix}`;
      for (const name of [sourceName, targetName]) {
        await admin.query(`CREATE DATABASE ${name} TEMPLATE ${templateName}`);
        created.push(name);
      }
      source = new pg.Pool({ connectionString: url(sourceName), max: 1 });
      target = new pg.Pool({ connectionString: url(targetName), max: 1 });
    }, 15_000);
    afterEach(async () => {
      vi.useRealTimers();
      await source?.end();
      await target?.end();
      // Exact database names created by this suite; templates/previous tests remain.
      for (const name of [sourceName, targetName])
        if (created.includes(name)) {
          await admin.query(`DROP DATABASE ${name}`);
          created.splice(created.indexOf(name), 1);
        }
    });
    afterAll(async () => {
      for (const name of [...created].reverse())
        await admin?.query(`DROP DATABASE ${name}`);
      await admin?.end();
    });

    it("restores raw L2 exactly, preserving bigint/microseconds and the unchanged source under HOLD", async () => {
      const data = await archive();
      expect(
        data.manifest.selections.every(
          (row) => row.disposition === "held" && row.candidates.length === 0,
        ),
      ).toBe(true);
      const certificate = await restoreRetentionArchive(
        pool(target),
        data.archive,
        await budget(),
        anchors(data.archive),
      );
      verifyRestoreCertificate(certificate, data.archive);
      expect(await snapshot(target, data.tables)).toEqual(data.before);
      expect(await snapshot(source, data.tables)).toEqual(data.before);
      expect(certificate).toMatchObject({
        executionAllowed: false,
        deletionEligibility: false,
        counts: {
          polymarket_book_snapshots_full: 1,
          polymarket_book_deltas: 2,
        },
        result: {
          anchorId: "9007199254740993",
          lastDeltaId: "9007199254740995",
          anchorReceivedAt: "2026-01-01T00:00:00.123456+00:00",
          lastReceivedAt: "2026-01-01T00:00:00.123458+00:00",
          bids: [{ price: "0.4", size: "5" }],
          asks: [],
        },
      });
      expect(certificate.targetIdentity.database).not.toBe(
        data.archive.sourceIdentity.database,
      );
      expect(
        (
          await source.query(
            "SELECT count(*)::int AS n FROM retention_evidence_pins",
          )
        ).rows[0]?.n,
      ).toBe(0);
      await expect(
        source.query("DELETE FROM polymarket_book_deltas WHERE false"),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        target.query("TRUNCATE polymarket_book_deltas"),
      ).rejects.toMatchObject({ code: "55000" });
    });

    it("restores ledger/orders/position and independently reconciles exact money, identities and provenance", async () => {
      const data = await archive("paper-ledger");
      const certificate = await restoreRetentionArchive(
        pool(target),
        data.archive,
        await budget(),
        anchors(data.archive),
      );
      verifyRestoreCertificate(certificate, data.archive);
      expect(await snapshot(target, data.tables)).toEqual(data.before);
      expect(await snapshot(source, data.tables)).toEqual(data.before);
      expect(certificate.result).toMatchObject({
        eventIds: ["9007199254740993", "9007199254740994"],
        eventCount: 2,
        shares: "2.000000000",
        costUsd: "0.800000000",
        feesPaidUsd: "0.010000000",
        realizedPnlUsd: "-0.010000000",
        openedAt: "2026-01-01T00:00:00.123457+00:00",
      });
      await expect(
        target.query(
          "UPDATE paper_ledger_events SET payload_json='{}' WHERE event_id=9007199254740993",
        ),
      ).rejects.toThrow(/immutable/);
    });

    it("restores the exact nonempty residual selector set without granting deletion eligibility", async () => {
      await source.query(
        "INSERT INTO bonding_curve_state(mint,updated_at) VALUES ('data03-residual','2026-01-01T00:00:00.123456Z')",
      );
      const tables = ["bonding_curve_state"];
      const before = await snapshot(source, tables);
      const manifest = await createRetentionDryRun(pool(source), {
        tables,
        cutoffUtc: "2026-02-01T00:00:00Z",
        generatedAtUtc: new Date().toISOString(),
        gitSha: "3".repeat(40),
        limit: 10,
      });
      expect(manifest.selections[0]).toMatchObject({
        disposition: "review_only",
        candidateCount: { value: 1, exact: true },
      });
      const plan: PreservationPlan = {
        formatVersion: "data-03-fixture-plan-v1",
        fixtureOnly: true,
        datasetId: "data03-residual-fixture",
        manifestHash: manifest.hash,
        profile: "residual",
        historicalCompleteness: "unknown",
        rows: {
          bonding_curve_state: before["bonding_curve_state"]!.map((row) => ({
            key: row.key,
            rowHash: retentionHash(row.value),
          })),
        },
      };
      expect(plan.rows["bonding_curve_state"]).toEqual(
        manifest.selections[0]!.candidates.map((row) => ({
          key: row.key,
          rowHash: row.rowHash,
        })),
      );
      const exported = await exportRetentionArchive(
        pool(source),
        pool(target),
        manifest,
        plan,
        await budget(),
      );
      const certificate = await restoreRetentionArchive(
        pool(target),
        exported,
        await budget(),
        anchors(exported),
      );
      verifyRestoreCertificate(certificate, exported);
      expect(await snapshot(target, tables)).toEqual(before);
      expect(await snapshot(source, tables)).toEqual(before);
      expect(certificate).toMatchObject({
        executionAllowed: false,
        deletionEligibility: false,
        counts: { bonding_curve_state: 1 },
        result: { reconciliation: "exact_residual_rows" },
      });
    });

    it("rejects corrupted archive bytes before any restore insert", async () => {
      const data = await archive();
      const changed = structuredClone(data.archive);
      changed.rows["polymarket_book_deltas"]![0] += " ";
      await expect(
        restoreRetentionArchive(
          pool(target),
          changed,
          await budget(),
          anchors(data.archive),
        ),
      ).rejects.toThrow("DATA03_ARCHIVE_CORRUPT_OR_OVERSIZE");
      await emptyTarget();
    });

    it("rejects a rehashed partial row export even if counts and row checksums were adjusted", async () => {
      const data = await archive();
      const changed = structuredClone(data.archive);
      changed.rows["polymarket_book_deltas"]!.pop();
      changed.counts["polymarket_book_deltas"] = 1;
      changed.rowChecksums["polymarket_book_deltas"] =
        changed.rows["polymarket_book_deltas"]!.map(retentionHash);
      await expect(
        restoreRetentionArchive(
          pool(target),
          rehash(changed),
          await budget(),
          anchors(data.archive),
        ),
      ).rejects.toThrow("DATA03_INDEPENDENT_HASH_ANCHOR_MISMATCH");
      await emptyTarget();
    });

    it("rejects an entirely missing anchor table from a rehashed export", async () => {
      const data = await archive();
      const changed = structuredClone(data.archive);
      delete changed.rows["polymarket_book_snapshots_full"];
      await expect(
        restoreRetentionArchive(
          pool(target),
          rehash(changed),
          await budget(),
          anchors(data.archive),
        ),
      ).rejects.toThrow("DATA03_INDEPENDENT_HASH_ANCHOR_MISMATCH");
      await emptyTarget();
    });

    it("detects source row drift after the explicit independently hashed inventory", async () => {
      const data = await prepare();
      await source.query(
        "UPDATE polymarket_book_deltas SET size='6' WHERE delta_id=9007199254740994",
      );
      await expect(
        exportRetentionArchive(
          pool(source),
          pool(target),
          data.manifest,
          data.plan,
          await budget(),
        ),
      ).rejects.toThrow("DATA03_ROW_DRIFT");
      await emptyTarget();
    });

    it("detects source pins inserted after the manifest without lifting HOLD", async () => {
      const data = await prepare();
      await source.query(
        "INSERT INTO retention_evidence_pins(pin_id,dataset_id,table_name,reason,artifact_sha256) VALUES ('new-pin','fixture','polymarket_book_deltas','retained fixture',repeat('a',64))",
      );
      await expect(
        exportRetentionArchive(
          pool(source),
          pool(target),
          data.manifest,
          data.plan,
          await budget(),
        ),
      ).rejects.toThrow("DATA03_MANIFEST_SET_DRIFT");
      expect(
        (
          await source.query(
            "SELECT count(*)::int AS n FROM retention_pin_events",
          )
        ).rows[0]?.n,
      ).toBe(1);
      await emptyTarget();
    });

    it("detects source schema drift before transferring rows", async () => {
      const data = await prepare();
      await source.query(
        "ALTER TABLE polymarket_book_deltas ADD COLUMN data03_test_drift boolean",
      );
      await expect(
        exportRetentionArchive(
          pool(source),
          pool(target),
          data.manifest,
          data.plan,
          await budget(),
        ),
      ).rejects.toThrow("DATA03_SCHEMA_DRIFT");
      await emptyTarget();
    });

    it("detects restore schema drift before inserting rows", async () => {
      const data = await archive();
      await target.query(
        "ALTER TABLE polymarket_book_deltas ADD COLUMN data03_test_drift boolean",
      );
      await expect(
        restoreRetentionArchive(
          pool(target),
          data.archive,
          await budget(),
          anchors(data.archive),
        ),
      ).rejects.toThrow("DATA03_SCHEMA_DRIFT");
      await emptyTarget();
    });

    it("rolls back earlier inserts when a later destination table is nonempty, preserving its fixture", async () => {
      const data = await archive();
      await target.query(
        RAW_SQL.split("  INSERT INTO polymarket_book_deltas")[0]!,
      );
      const before = await snapshot(target, RAW_TABLES);
      await expect(
        restoreRetentionArchive(
          pool(target),
          data.archive,
          await budget(),
          anchors(data.archive),
        ),
      ).rejects.toThrow("DATA03_TARGET_NOT_EMPTY");
      expect(await snapshot(target, RAW_TABLES)).toEqual(before);
    });

    it("rejects altered rehashed monetary rows against independent publication anchors", async () => {
      const data = await archive("paper-ledger");
      const changed = structuredClone(data.archive);
      changed.rows["paper_positions"]![0] = changed.rows[
        "paper_positions"
      ]![0]!.replace('"cost_usd": "0.8"', '"cost_usd": "0.9"');
      changed.rowChecksums["paper_positions"] =
        changed.rows["paper_positions"]!.map(retentionHash);
      await expect(
        restoreRetentionArchive(
          pool(target),
          rehash(changed),
          await budget(),
          anchors(data.archive),
        ),
      ).rejects.toThrow("DATA03_INDEPENDENT_HASH_ANCHOR_MISMATCH");
      await emptyTarget(PAPER_TABLES);
      expect(await snapshot(source, PAPER_TABLES)).toEqual(data.before);
    });

    it("refuses an expired DATA-02 manifest before transfer", async () => {
      const data = await prepare();
      const expired = await createRetentionDryRun(pool(source), {
        tables: RAW_TABLES,
        cutoffUtc: "2026-02-01T00:00:00Z",
        generatedAtUtc: new Date(Date.now() - 901_000).toISOString(),
        gitSha: "3".repeat(40),
        limit: 10,
      });
      await expect(
        exportRetentionArchive(
          pool(source),
          pool(target),
          expired,
          { ...data.plan, manifestHash: expired.hash },
          await budget(),
        ),
      ).rejects.toThrow(/EXPIRED/);
      await emptyTarget();
    });

    it("rejects corrupted certificates and certificates after manifest expiry", async () => {
      const data = await archive();
      const certificate = await restoreRetentionArchive(
        pool(target),
        data.archive,
        await budget(),
        anchors(data.archive),
      );
      const changed = structuredClone(certificate) as typeof certificate & {
        datasetId: string;
      };
      changed.datasetId = "other-fixture";
      expect(() =>
        verifyRestoreCertificate(rehash(changed), data.archive),
      ).toThrow("DATA03_CERTIFICATE_MISMATCH");
      // Only the pure verifier's clock advances; PostgreSQL was used for the restore.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.parse(data.archive.expiresAtUtc) + 1));
      expect(() => verifyRestoreCertificate(certificate, data.archive)).toThrow(
        /EXPIRED/,
      );
    });

    it("rejects the same source connection used as a restore destination", async () => {
      const data = await prepare();
      await expect(
        exportRetentionArchive(
          pool(source),
          pool(source),
          data.manifest,
          data.plan,
          await budget(),
        ),
      ).rejects.toThrow("DATA03_DISPOSABLE_DATABASE_IDENTITY");
      expect(await snapshot(source, RAW_TABLES)).toEqual(data.before);
    });

    it("fails closed when the measured capacity is insufficient", async () => {
      const data = await prepare();
      const measured = await budget();
      // Explicitly perturb the real measurement to exercise the failure path.
      measured.capacity.freeBytes = 0;
      await expect(
        exportRetentionArchive(
          pool(source),
          pool(target),
          data.manifest,
          data.plan,
          measured,
        ),
      ).rejects.toThrow("DATA03_STORAGE_CAPACITY_INSUFFICIENT");
      await emptyTarget();
    });

    it("rejects stale or mismatched capacity receipts before source reads", async () => {
      const measured = await budget();
      await expect(
        preflightRestore(pool(target), {
          ...measured,
          capacity: {
            ...measured.capacity,
            measuredAtUtc: new Date(Date.now() - 61_000).toISOString(),
          },
        }),
      ).rejects.toThrow("DATA03_CAPACITY_RECEIPT_INVALID_OR_STALE");
      await expect(
        preflightRestore(pool(target), {
          ...measured,
          capacity: { ...measured.capacity, systemIdentifier: "0" },
        }),
      ).rejects.toThrow("DATA03_CAPACITY_RECEIPT_INVALID_OR_STALE");
    });

    it("never executes arbitrary SQL embedded in an otherwise rehashed manifest", async () => {
      const data = await prepare();
      const changed = structuredClone(data.manifest);
      Object.assign(changed.selections[0]!.predicate, {
        sql: "SELECT data03_untrusted_sql_must_never_run()",
      });
      const { id: _id, hash: _hash, ...body } = changed;
      const hash = retentionHash(body);
      const manifest = { ...body, hash, id: `sha256:${hash}` };
      await expect(
        exportRetentionArchive(
          pool(source),
          pool(target),
          manifest,
          { ...data.plan, manifestHash: manifest.hash },
          await budget(),
        ),
      ).rejects.toThrow("DATA03_MANIFEST_SET_DRIFT");
      await emptyTarget();
      expect(await snapshot(source, RAW_TABLES)).toEqual(data.before);
    });

    it("fails fast behind an active source reference writer", async () => {
      const data = await prepare();
      const blocker = new pg.Client({ connectionString: url(sourceName) });
      await blocker.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          "UPDATE polymarket_book_deltas SET size=size WHERE delta_id=9007199254740994",
        );
        await expect(
          exportRetentionArchive(
            pool(source),
            pool(target),
            data.manifest,
            data.plan,
            await budget(),
          ),
        ).rejects.toThrow("DATA02_EVIDENCE_LOCK_BUSY");
      } finally {
        await blocker.query("ROLLBACK");
        await blocker.end();
      }
      expect(await snapshot(source, RAW_TABLES)).toEqual(data.before);
      await emptyTarget();
    });

    it("binds a restored archive to its exact planned target identity", async () => {
      const data = await archive();
      const changed = structuredClone(data.archive) as RetentionArchive;
      changed.targetIdentity.database = "ganso_data03_restore_other";
      await expect(
        restoreRetentionArchive(
          pool(target),
          rehash(changed),
          await budget(),
          anchors(data.archive),
        ),
      ).rejects.toThrow("DATA03_INDEPENDENT_HASH_ANCHOR_MISMATCH");
      await emptyTarget();
    });
  },
);
