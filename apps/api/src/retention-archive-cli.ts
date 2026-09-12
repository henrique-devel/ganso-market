// Explicit localhost disposable endpoints only. Never load runtime secrets/config.
import pg from "pg";
import type { DatabasePool, SqlExecutor } from "./database.js";
import { resolveGitSha } from "./polymarket/fundamental/provenance.js";
import type { RetentionManifest } from "./polymarket/retention-manifest.js";
import {
  exportRetentionArchive,
  restoreRetentionArchive,
  validateArchiveEndpoint,
  verifyRestoreCertificate,
  type PreservationPlan,
  type RetentionArchive,
  type RestoreCapacity,
} from "./polymarket/retention-archive.js";
import {
  readArchiveFile,
  withArchiveDestination,
} from "./polymarket/retention-archive-storage.js";

function pool(url: string, role: "source" | "restore") {
  validateArchiveEndpoint(url, role);
  const raw = new pg.Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 1000,
    query_timeout: 2000,
    statement_timeout: 500,
    application_name: `ganso-data03-${role}`,
  });
  raw.on("error", () => {
    /* A failed connection cannot publish a certificate. */
  });
  const adapter: Pick<DatabasePool, "transaction"> = {
    async transaction<T>(run: (tx: SqlExecutor) => Promise<T>) {
      const client = await raw.connect();
      try {
        await client.query("BEGIN");
        const value = await run({
          async query<R extends Record<string, unknown>>(
            sql: string,
            params: readonly unknown[] = [],
          ) {
            const r = await client.query<R>(sql, [...params]);
            return { rows: r.rows, rowCount: r.rowCount ?? 0 };
          },
        });
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
  return { adapter, close: () => raw.end() };
}
async function run() {
  const flags = new Map<string, string>();
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (
      !key ||
      !value ||
      flags.has(key) ||
      ![
        "--manifest",
        "--plan",
        "--capacity",
        "--directory",
        "--max-bytes",
        "--archive",
        "--expected-archive-hash",
        "--expected-plan-hash",
      ].includes(key)
    )
      throw new Error("DATA03_ARGUMENTS");
    flags.set(key, value);
  }
  const directory = flags.get("--directory");
  const capacityPath = flags.get("--capacity");
  const restoreUrl = process.env["GANSO_RESTORE_DATABASE_URL"];
  const archivePath = flags.get("--archive");
  if (
    !directory ||
    !capacityPath ||
    !restoreUrl ||
    (archivePath
      ? flags.has("--manifest") ||
        flags.has("--plan") ||
        !flags.has("--expected-archive-hash") ||
        !flags.has("--expected-plan-hash")
      : !flags.has("--manifest") ||
        !flags.has("--plan") ||
        flags.has("--expected-archive-hash") ||
        flags.has("--expected-plan-hash"))
  )
    throw new Error("DATA03_ARGUMENTS");
  const maxBytes = Number(flags.get("--max-bytes") ?? 1024 * 1024);
  const budget = {
    maxBytes,
    capacity: (await readArchiveFile(capacityPath, 8192)) as RestoreCapacity,
  };
  const target = pool(restoreUrl, "restore");
  let source: ReturnType<typeof pool> | undefined;
  try {
    await withArchiveDestination(directory, maxBytes, async (destination) => {
      let archive: RetentionArchive;
      if (archivePath) {
        archive = (await readArchiveFile(
          archivePath,
          maxBytes,
        )) as RetentionArchive;
      } else {
        const sourceUrl = process.env["GANSO_TEST_DATABASE_URL"];
        if (!sourceUrl) throw new Error("DATA03_EXPLICIT_SOURCE_REQUIRED");
        source = pool(sourceUrl, "source");
        const manifest = (await readArchiveFile(
          flags.get("--manifest")!,
        )) as RetentionManifest;
        if (manifest.gitSha !== (await resolveGitSha()))
          throw new Error("DATA03_CODE_SHA_MISMATCH");
        const plan = (await readArchiveFile(
          flags.get("--plan")!,
        )) as PreservationPlan;
        archive = await exportRetentionArchive(
          source.adapter,
          target.adapter,
          manifest,
          plan,
          budget,
        );
      }
      const gitSha = await resolveGitSha();
      if (!gitSha || gitSha !== archive.manifest.gitSha)
        throw new Error("DATA03_CODE_SHA_MISMATCH");
      const expected = {
        archiveHash: archivePath
          ? flags.get("--expected-archive-hash")!
          : archive.hash,
        planHash: archivePath
          ? flags.get("--expected-plan-hash")!
          : archive.planHash,
        gitSha,
      };
      if (
        expected.archiveHash !== archive.hash ||
        expected.planHash !== archive.planHash
      )
        throw new Error("DATA03_INDEPENDENT_HASH_ANCHOR_MISMATCH");
      await destination.write("archive.json", archive);
      const certificate = await restoreRetentionArchive(
        target.adapter,
        archive,
        budget,
        expected,
      );
      verifyRestoreCertificate(certificate, archive);
      await destination.write("certificate.json", certificate);
      process.stdout.write(`sha256:${certificate.hash}\n`);
    });
  } finally {
    await source?.close();
    await target.close();
  }
}
run().catch(() => {
  // No URLs, credentials, SQL errors, row payloads or paths in stderr.
  process.stderr.write(
    "DATA03_FAILED: verify explicit disposable endpoints, fresh manifest/plan/capacity, schema, rows and empty private destination; no deletion attempted\n",
  );
  process.exitCode = 1;
});
