import assert from "node:assert/strict";
import test from "node:test";
import { fixture, summary, compare } from "./db02-write-benchmark.mjs";

test("new rows include the hot market and both token identities", () => {
  const rows = Array.from({length: 2500}, (_, i) => fixture("data_api", i, "autocommit"));
  const hot = rows.filter((row) => row[1] === `0x${"0".repeat(64)}`);
  assert.equal(hot.length, 1250);
  assert.equal(new Set(hot.map((row) => row[0])).size, 2);
  assert.equal(new Set(rows.map((row) => row[1])).size, 1000);
  assert.equal(new Set(rows.map((row) => row[6])).size, 2500);
});

test("retry fixture keeps identity, money strings and timestamps unchanged", () => {
  for (const source of ["data_api", "ws"]) {
    const row = fixture(source, 42, "explicit");
    assert.deepEqual(fixture(source, 42, "explicit"), row);
    assert.equal(row.length, 9);
    assert.equal(row[2], "0.510000");
    assert.equal(row[3], "1.230000");
  }
  assert.equal(fixture("ws", 42, "explicit")[5], "100");
  assert.match(fixture("ws", 42, "explicit")[6], /^0x[0-9a-f]{64}$/);
});

test("fixture retains NULL, future and tied source timestamps", () => {
  assert.equal(fixture("data_api", 101, "test")[7], null);
  assert.equal(fixture("data_api", 997, "test")[7].toISOString(), "2026-09-12T14:01:00.000Z");
  assert.deepEqual(fixture("data_api", 2, "test")[7], fixture("data_api", 3, "test")[7]);
});

test("percentiles retain all outliers and keep explicit COMMIT separate", () => {
  const rows = Array.from({length: 20}, (_, i) => [(i + 1) * 1e6, (i + 1) * 1e5]);
  rows[19][0] = 1000e6;
  const result = summary(rows);
  assert.equal(result.n, 20);
  assert.equal(result.latencyMs.p95, 19);
  assert.equal(result.latencyMs.p99, 1000);
  assert.equal(result.commitMs.p95, 1.9);
  assert.equal(summary([[100, null]]).commitMs.p95, null);
});

test("a COMMIT regression fails even when total throughput improves", () => {
  const before = summary(Array.from({length: 100}, () => [10000000, 1000000]));
  const after = summary(Array.from({length: 100}, () => [9000000, 1200000]));
  const result = compare(before, after);
  assert.ok(result.throughputLossPercent < 0);
  assert.ok(result.commitP95RegressionPercent > 10);
  assert.equal(result.passed, false);
});

test("autocommit retains the 10 percent threshold without an absolute slack", () => {
  const before = summary([[1000, null]]);
  assert.equal(compare(before, summary([[1090, null]])).passed, true);
  assert.equal(compare(before, summary([[1100, null]])).passed, true);
  assert.equal(compare(before, summary([[1110, null]])).passed, false);
});

test("invalid source or empty metrics cannot silently pass", () => {
  assert.throws(() => fixture("unknown", 1, "test"));
  assert.throws(() => summary([]));
});
