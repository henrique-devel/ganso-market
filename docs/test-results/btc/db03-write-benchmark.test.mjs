import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  validateTarget, extractWriterSql, rawValues, aggregateValues, assertServerIdentity, assertGuardRows,
} from "./db03-write-benchmark.mjs";
import { summary, compare, exitStatus } from "./db02-write-benchmark.mjs";

const source = await readFile(new URL("../../../apps/api/src/polymarket/rtds.ts", import.meta.url), "utf8");

test("destination rejects remote, implicit, redirected and wrong database identities", () => {
  const accepted = "postgres://postgres@127.0.0.1:54607/ganso_db03_write_disposable";
  assert.equal(validateTarget(accepted).hostname, "127.0.0.1");
  for (const url of [undefined, "", "https://127.0.0.1:54607/ganso_db03_write_disposable",
    accepted.replace("127.0.0.1", "178.105.65.251"), accepted.replace("127.0.0.1", "localhost"),
    accepted.replace(":54607", ""), accepted.replace(":54607", ":80"),
    accepted.replace("ganso_db03_write_disposable", "ganso_market"),
    accepted.replace("postgres@", "ganso_market@"),
    `${accepted}?host=178.105.65.251`, `${accepted}?options=-c%20synchronous_commit=off`,
    `${accepted}#unexpected`]) assert.throws(() => validateTarget(url));
});

test("server identity refuses missing or weaker durability and version/database drift", () => {
  const row = {version_num: "180004", current_database: "ganso_db03_write_disposable",
    fsync: "on", full_page_writes: "on", synchronous_commit: "on"};
  assert.doesNotThrow(() => assertServerIdentity(row));
  for (const [key, value] of Object.entries({version_num: "180003", current_database: "ganso_market",
    fsync: "off", full_page_writes: "off", synchronous_commit: "local"})) {
    assert.throws(() => assertServerIdentity({...row, [key]: value}));
    const missing = {...row}; delete missing[key];
    assert.throws(() => assertServerIdentity(missing));
  }
});

test("SQL uses real VALUES flush and eight-bind upsert, without measured EXPLAIN", () => {
  const sql = extractWriterSql(source, 2);
  assert.match(sql.raw, /VALUES\s+\(\$1,\$2,\$3,\$4,\$5,\$6\),\(\$7,\$8,\$9,\$10,\$11,\$12\)/);
  assert.doesNotMatch(sql.raw, /generate_series|EXPLAIN|ON CONFLICT/i);
  assert.match(sql.aggregate, /VALUES\s+\(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8\)/);
  assert.match(sql.aggregate, /received_at = CURRENT_TIMESTAMP/);
  assert.doesNotMatch(sql.aggregate, /\$9|EXPLAIN|generate_series/);
  assert.throws(() => extractWriterSql("writer absent", 2));
});

test("raw fixture preserves monetary strings, source/receive timestamps and actual lag", () => {
  for (const position of [0, 99, 995, 120000, 129998]) {
    const values = rawValues(position, 2);
    assert.equal(values.length, 12);
    assert.deepEqual(rawValues(position, 2), values);
    for (let i = 0; i < values.length; i += 6) {
      assert.ok(["twap30", "twap60"].includes(values[i]));
      assert.ok(["btc/usd", "eth/usd"].includes(values[i+1]));
      assert.equal(typeof values[i+2], "string");
      assert.match(values[i+2], /^\d+\.\d+$/);
      assert.ok(values[i+4] instanceof Date);
      assert.equal(values[i+5], values[i+3] === null ? null : Math.round(values[i+4] - values[i+3]));
    }
  }
  assert.equal(rawValues(100, 1)[3], null);
});

test("fixed raw schedule is exactly 10,000 new rows and keeps all four series", () => {
  const all = [];
  for (let mode = 0; mode < 2; mode++) for (let round = 0; round < 4; round++) {
    for (let offset = 0; offset < 625; offset++) {
      const rows = rawValues(120000 + mode * 5000 + (round * 625 + offset) * 2, 2);
      for (let i = 0; i < rows.length; i += 6) all.push(rows.slice(i, i + 6));
    }
  }
  assert.equal(all.length, 10000);
  assert.equal(new Set(all.map((row) => row[2])).size, 10000);
  assert.deepEqual([...new Set(all.map((row) => `${row[0]}|${row[1]}`))].sort(),
    ["twap30|btc/usd", "twap30|eth/usd", "twap60|btc/usd", "twap60|eth/usd"]);
});

test("aggregate schedule names exactly 1,000 keys, using eight runtime binds", () => {
  const keys = new Set();
  for (let position = 0; position < 1000; position++) {
    const row = aggregateValues(position);
    assert.equal(row.length, 8);
    for (let i = 3; i <= 6; i++) assert.equal(typeof row[i], "string");
    assert.ok(Number.isInteger(row[7]));
    assert.ok(row[2] instanceof Date);
    keys.add(`${row[0]}|${row[1]}|${row[2].toISOString()}`);
  }
  assert.equal(keys.size, 1000);
});

test("shared metric gate rejects p95/COMMIT regression and keeps the exact 10% boundary", () => {
  const before = summary(Array.from({length: 100}, () => [10000, 1000]));
  assert.equal(compare(before, summary(Array.from({length: 100}, () => [9000, 1100]))).passed, true);
  assert.equal(compare(before, summary(Array.from({length: 100}, () => [9000, 1101]))).passed, false);
  const varied = Array.from({length: 100}, (_, i) => [i < 6 ? 11001 : 8000, 900]);
  assert.equal(compare(before, summary(varied)).passed, false);
  assert.throws(() => summary([]));
  assert.equal(exitStatus({completed: true, allGatesPassed: false, cleanupErrors: []}), 2);
  assert.equal(exitStatus({completed: true, allGatesPassed: true, cleanupErrors: ["failure"]}), 1);
});

test("HOLD and writer guards must both exist, be enabled and protect the right operations", () => {
  const rows = [
    {tgname: "retention_evidence_delete_guard_trg", tgenabled: "O",
      definition: "CREATE TRIGGER x BEFORE DELETE OR TRUNCATE ON fixture EXECUTE FUNCTION retention_evidence_delete_guard()"},
    {tgname: "retention_evidence_write_lock_trg", tgenabled: "O",
      definition: "CREATE TRIGGER y BEFORE INSERT OR UPDATE ON fixture EXECUTE FUNCTION retention_evidence_writer_lock()"},
  ];
  assert.doesNotThrow(() => assertGuardRows(rows));
  assert.throws(() => assertGuardRows([]));
  assert.throws(() => assertGuardRows(rows.slice(1)));
  for (const index of [0, 1]) {
    assert.throws(() => assertGuardRows(rows.map((row, i) => i === index ? {...row, tgenabled: "D"} : row)));
    assert.throws(() => assertGuardRows(rows.map((row, i) => i === index ? {...row, definition: "unrelated trigger"} : row)));
  }
});

test("rejected URL fields never echo submitted credentials or override values", () => {
  const marker = "sensitive-marker";
  const base = "postgres://postgres@127.0.0.1:54607/ganso_db03_write_disposable";
  for (const url of [`${base}?password=${marker}`, base.replace("postgres@", `${marker}@`)]) {
    assert.throws(() => validateTarget(url), (error) => !error.message.includes(marker));
  }
});

test("CLI without explicit execution returns an incomplete report before any connection", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./db03-write-benchmark.mjs", import.meta.url))],
    {encoding: "utf8", env: {...process.env, GANSO_TEST_DATABASE_URL: ""}});
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.completed, false);
  assert.equal(report.promotionAllowed, false);
  assert.equal(report.server, undefined);
  assert.deepEqual(report.scenarios, []);
  assert.deepEqual(report.cleanedSchemas, []);
  assert.match(report.error.message, /explicit --execute/);
});
