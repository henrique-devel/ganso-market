// Mandatory PG gate. The URL must name a migrated, disposable database whose
// role may create databases. Each file gets a fresh clone (global fixtures,
// TRUNCATE and immutable ledgers cannot safely share a database).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "ganso-pg-results-"));
const resultsDir = process.env.GANSO_PG_RESULTS_DIR || scratch;
const rows = [];
let admin;
let secret = "";
const redact = (text) => {
  const safe = String(text).replace(
    /postgres(?:ql)?:\/\/[^\s"'<>]+/g,
    "[REDACTED_DATABASE_URL]",
  );
  return secret ? safe.replaceAll(secret, "[REDACTED]") : safe;
};
const identifier = (name) => `"${name.replaceAll('"', '""')}"`;

try {
  const connection = process.env.GANSO_TEST_DATABASE_URL;
  if (!connection?.trim())
    throw new Error(
      "GANSO_TEST_DATABASE_URL is required; PostgreSQL tests cannot be skipped",
    );
  const url = new URL(connection);
  secret = decodeURIComponent(url.password);
  const template = decodeURIComponent(url.pathname.slice(1));
  if (!template) throw new Error("A disposable migrated database is required");

  // Inventory includes mixed unit/PG files and future *.pg.test.ts files.
  const files = readdirSync(join(root, "apps/api/test"), { recursive: true })
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => join("apps/api/test", file))
    .filter(
      (file) =>
        file.endsWith(".pg.test.ts") ||
        readFileSync(join(root, file), "utf8").includes(
          "GANSO_TEST_DATABASE_URL",
        ),
    )
    .sort();
  if (!files.length) throw new Error("No PostgreSQL files discovered");
  console.log(
    `PostgreSQL inventory: ${files.length} files\n${files.join("\n")}`,
  );

  const probe = new pg.Client({
    connectionString: connection,
    connectionTimeoutMillis: 5000,
  });
  try {
    await probe.connect();
    const version = await probe.query(
      "SELECT version(), count(*)::int AS migrations FROM schema_versions WHERE component = 'foundation'",
    );
    console.log(
      `Database ready: ${version.rows[0].version}; migrations: ${version.rows[0].migrations}`,
    );
  } finally {
    await probe.end();
  }
  const adminUrl = new URL(connection);
  adminUrl.pathname = "/postgres";
  admin = new pg.Client({
    connectionString: adminUrl.href,
    connectionTimeoutMillis: 5000,
  });
  await admin.connect();
  mkdirSync(resultsDir, { recursive: true });
  for (const [index, file] of files.entries()) {
    const db = `ganso_data03_source_test_${randomBytes(12).toString("hex")}`;
    await admin.query(
      `CREATE DATABASE ${identifier(db)} TEMPLATE ${identifier(template)}`,
    );
    try {
      const testUrl = new URL(connection);
      testUrl.pathname = `/${db}`;
      const reportPath = join(scratch, `${index}.json`);
      const run = spawnSync(
        process.execPath,
        [
          join(root, "node_modules/vitest/vitest.mjs"),
          "run",
          relative(join(root, "apps/api"), join(root, file)),
          "--no-file-parallelism",
          "--maxWorkers=1",
          "--reporter=default",
          "--reporter=json",
          `--outputFile.json=${reportPath}`,
        ],
        {
          cwd: join(root, "apps/api"),
          env: { ...process.env, GANSO_TEST_DATABASE_URL: testUrl.href },
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      let report;
      try {
        report = JSON.parse(readFileSync(reportPath, "utf8"));
      } catch {
        /* rejected below */
      }
      const assertions =
        report?.testResults?.flatMap((suite) => suite.assertionResults) ?? [];
      const passed = assertions.filter(
        (test) => test.status === "passed",
      ).length;
      const failed = assertions.filter(
        (test) => test.status === "failed",
      ).length;
      const unexecuted = assertions.length - passed - failed;
      const ok =
        run.status === 0 &&
        report?.success === true &&
        assertions.length > 0 &&
        passed === assertions.length &&
        report.numTotalTests === passed &&
        report.testResults.every(
          (suite) =>
            suite.status === "passed" && suite.assertionResults.length > 0,
        );
      rows.push({ file, passed, failed, unexecuted, ok });
      if (report)
        writeFileSync(
          join(resultsDir, `${index}.json`),
          redact(JSON.stringify(report, null, 2)),
        );
      console.log(
        `${file}: passed=${passed}, failed=${failed}, unexecuted=${unexecuted}, gate=${ok ? "PASS" : "FAIL"}`,
      );
      if (!ok) {
        console.error(
          redact(
            `${run.stdout ?? ""}\n${run.stderr ?? ""}\n${report ? "" : "Missing test report"}`,
          ),
        );
        process.exitCode = 1;
      }
    } finally {
      await admin.query(`DROP DATABASE ${identifier(db)} WITH (FORCE)`);
    }
  }
} catch (error) {
  console.error(`PostgreSQL gate failed: ${redact(error.message)}`);
  process.exitCode = 1;
} finally {
  await admin?.end();
  const summary = {
    files: rows,
    passed: rows.reduce((n, row) => n + row.passed, 0),
    failed: rows.reduce((n, row) => n + row.failed, 0),
    unexecuted: rows.reduce((n, row) => n + row.unexecuted, 0),
    success: process.exitCode !== 1 && rows.length > 0,
  };
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(
    join(resultsDir, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  const markdown =
    `PostgreSQL gate: ${summary.success ? "PASS" : "FAIL"}\n\n` +
    rows
      .map(
        (row) =>
          `- ${row.file}: ${row.passed} passed; ${row.failed} failed; ${row.unexecuted} unexecuted`,
      )
      .join("\n") +
    `\n\nTotal: ${rows.length} files; ${summary.passed} passed; ${summary.failed} failed; ${summary.unexecuted} unexecuted.\n`;
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  rmSync(scratch, { recursive: true, force: true });
}
