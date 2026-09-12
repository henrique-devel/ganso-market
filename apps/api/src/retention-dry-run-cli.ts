// DATA-02, read-only command: fixed cutoff, explicit objects, immutable file.
import { writeFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import { resolveGitSha } from "./polymarket/fundamental/provenance.js";
import { createRetentionDryRun } from "./polymarket/retention-manifest.js";

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !flag ||
      !value ||
      flags.has(flag) ||
      !["--tables", "--cutoff", "--output", "--limit"].includes(flag)
    ) {
      throw new Error("RETENTION_CLI_ARGUMENTS_INVALID");
    }
    flags.set(flag, value);
  }
  const tables = flags.get("--tables");
  const cutoffUtc = flags.get("--cutoff");
  const output = flags.get("--output");
  if (!tables || !cutoffUtc || !output) {
    throw new Error(
      "usage: retention-dry-run-cli --tables <1-4 exact names,comma-separated> --cutoff <UTC> --output <new file> [--limit 100]",
    );
  }
  const gitSha = await resolveGitSha();
  if (!gitSha) throw new Error("RETENTION_SHA_REQUIRED");
  const pool = createDatabasePool(await loadConfig(), {
    max: 1,
    queryTimeoutMs: 1000,
    applicationName: "ganso-retention-dry-run",
  });
  try {
    const manifest = await createRetentionDryRun(pool, {
      tables: tables.split(","),
      cutoffUtc,
      generatedAtUtc: new Date().toISOString(),
      gitSha,
      limit: Number(flags.get("--limit") ?? 100),
    });
    // No overwrite, append, database write or automatic execution of a manifest.
    await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    process.stdout.write(`${manifest.id}\n`);
  } finally {
    await pool.end();
  }
}

run().catch(() => {
  // Never print configuration, connection errors or a potentially sensitive path.
  process.stderr.write(
    "RETENTION_DRY_RUN_FAILED: verify arguments, migration, lock availability and output path; no deletion attempted\n",
  );
  process.exitCode = 1;
});
