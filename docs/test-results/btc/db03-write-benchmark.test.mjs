import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  validateTarget, extractWriterSql, rawValues, aggregateValues, assertServerIdentity, assertGuardRows,
  installDeadlineWatchdog,
} from "./db03-write-benchmark.mjs";
import { summary, compare, exitStatus } from "./db02-write-benchmark.mjs";

const source = await readFile(new URL("../../../apps/api/src/polymarket/rtds.ts", import.meta.url), "utf8");

test("hard deadline preserves partial samples and earlier failures, and identifies incomplete cleanup", () => {
  let elapsedMs = 25;
  let callback;
  let delay;
  let output;
  let status;
  const earlierError = {code: "57014", message: "statement timeout"};
  const report = {completed: true, promotionAllowed: false, error: earlierError,
    scenarios: [{rounds: [{baseline: {samples: [[123, null], [456, 78]]}}]}],
    cleanedSchemas: ["own_b"], cleanupErrors: [{operation: "rollback", code: "08006"}]};
  const created = ["own_b"];
  installDeadlineWatchdog({report, ownSchemas: ["own_b", "own_c"], createdSchemas: created,
    elapsedMs: () => elapsedMs, nowIso: () => "2026-09-12T16:10:00.000Z",
    schedule: (fn, ms) => { callback = fn; delay = ms; return 42; },
    cancel: () => assert.fail("deadline must stay active through stalled cleanup"),
    write: (text) => { output = text; }, terminate: (code) => { status = code; }});
  assert.equal(delay, 599975);
  created.push("own_c");
  elapsedMs = 600001;
  callback();
  assert.equal(status, 1);
  const partial = JSON.parse(output);
  assert.equal(partial.completed, false);
  assert.equal(partial.promotionAllowed, false);
  assert.equal(partial.finalBudgetExceeded, true);
  assert.equal(partial.wallMs, 600001);
  assert.equal(partial.finishedAt, "2026-09-12T16:10:00.000Z");
  assert.deepEqual(partial.error, earlierError);
  assert.equal(partial.deadlineError.code, "DB03_GLOBAL_BUDGET_EXCEEDED");
  assert.deepEqual(partial.scenarios, report.scenarios);
  assert.deepEqual(partial.cleanupErrors[0], {operation: "rollback", code: "08006"});
  assert.deepEqual(partial.cleanupErrors[1].createdSchemas, ["own_b", "own_c"]);
  assert.deepEqual(partial.cleanupErrors[1].possibleRemainingOwnSchemas, ["own_c"]);
  assert.equal(exitStatus(partial), 1);
});

test("normal cleanup clears the watchdog and prevents a stale callback from writing or exiting", () => {
  let callback;
  let cleared;
  const report = {completed: true, promotionAllowed: false, cleanupErrors: []};
  const stop = installDeadlineWatchdog({report, ownSchemas: [], createdSchemas: [], elapsedMs: () => 0,
    schedule: (fn, ms) => { callback = fn; assert.equal(ms, 600000); return 42; },
    cancel: (id) => { cleared = id; },
    write: () => assert.fail("normal completion must not write a timeout report"),
    terminate: () => assert.fail("normal completion must not force exit")});
  stop();
  assert.equal(cleared, 42);
  callback();
  assert.equal(report.completed, true);
  assert.equal(report.deadlineError, undefined);
});

test("deadline exits with failure even when its output sink fails", () => {
  let callback;
  let status;
  installDeadlineWatchdog({report: {}, ownSchemas: ["own_c"], createdSchemas: [], elapsedMs: () => 600000,
    schedule: (fn) => { callback = fn; return 42; }, cancel: () => {},
    write: () => { throw new Error("output unavailable"); }, terminate: (code) => { status = code; }});
  assert.throws(() => callback(), /output unavailable/);
  assert.equal(status, 1);
});

test("deadline flushes a complete partial JSON before terminating an otherwise stalled process", () => {
  const moduleUrl = new URL("./db03-write-benchmark.mjs", import.meta.url).href;
  const script = `import { installDeadlineWatchdog } from ${JSON.stringify(moduleUrl)};
    const report = {completed: false, promotionAllowed: false, cleanupErrors: [],
      scenarios: [{samples: Array.from({length: 10000}, (_, i) => [i, null])}]};
    installDeadlineWatchdog({report, ownSchemas: ['own_b'], createdSchemas: ['own_b'],
      elapsedMs: () => 600001});
    await new Promise(() => {});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script],
    {encoding: "utf8", timeout: 5000});
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  const report = JSON.parse(result.stdout);
  assert.equal(report.completed, false);
  assert.equal(report.promotionAllowed, false);
  assert.equal(report.error.code, "DB03_GLOBAL_BUDGET_EXCEEDED");
  assert.equal(report.scenarios[0].samples.length, 10000);
  assert.deepEqual(report.scenarios[0].samples.at(-1), [9999, null]);
  assert.deepEqual(report.cleanupErrors[0].possibleRemainingOwnSchemas, ["own_b"]);
});

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
