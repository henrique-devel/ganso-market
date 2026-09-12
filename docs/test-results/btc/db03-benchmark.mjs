// DB-03: run only against a disposable PostgreSQL 18 database.
// GANSO_TEST_DATABASE_URL=postgres://... node docs/test-results/btc/db03-benchmark.mjs --reads-only
// --with-writes additionally runs the separately reviewable write/WAL/delete experiment.
// Run against the unchanged production baseline before promoting the rewrite.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import pg from "pg";

const args = process.argv.slice(2);
if (args.length !== 1 || !["--reads-only", "--with-writes"].includes(args[0])) {
  throw new Error("Choose exactly one explicit mode: --reads-only or --with-writes; no database action is the default");
}
const readsOnly = args[0] === "--reads-only";
const databaseUrl = process.env.GANSO_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("GANSO_TEST_DATABASE_URL must name a disposable database");
const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [foundation, retention, source, candidateSql, indexSql] = await Promise.all([
  read("migrations/0005_polymarket_data_foundation.sql"),
  read("migrations/0013_retention_time_indexes.sql"),
  read("apps/api/src/polymarket/fundamental/features.ts"),
  read("docs/ops/sql/db03-rtds-asof-query.sql"),
  read("docs/ops/sql/db03-rtds-asof-index.sql"),
]);
const baselineSql = source.match(/export async function loadFeedSamples\([\s\S]*?`(SELECT DISTINCT ON \(symbol, feed\)[\s\S]*?)`/)?.[1];
const ddlStart = foundation.indexOf("CREATE TABLE IF NOT EXISTS polymarket_rtds_prices (");
const ddlEnd = foundation.indexOf("-- Macro calendar", ddlStart);
const retentionIndexes = ["polymarket_rtds_prices_received_at_idx", "polymarket_rtds_1m_bucket_start_idx"]
  .map((name) => retention.match(new RegExp(`CREATE INDEX IF NOT EXISTS ${name}[\\s\\S]*?;`))?.[0]);
if (!baselineSql || ddlStart < 0 || ddlEnd <= ddlStart || retentionIndexes.some((sql) => !sql)) {
  throw new Error("Unchanged production loadFeedSamples SQL or migration sections not found; do not benchmark candidate against itself");
}
const ddl = `${foundation.slice(ddlStart, ddlEnd)}\n${retentionIndexes.join("\n")}`;
const prefix = `db03_${randomUUID().replaceAll("-", "")}`;
const schemas = { baseline: `${prefix}_baseline`, candidate: `${prefix}_candidate` };
const indexName = "polymarket_rtds_prices_asof_idx";
const created = [];
const client = new pg.Client({ connectionString: databaseUrl,
  application_name: "db03_disposable_benchmark", statement_timeout: 5_000 });
const decisionTs = "2026-09-12T02:30:00.000Z";
const decisionMs = Date.parse(decisionTs);
const feeds = ["twap30", "twap60"];
const variants = ["baseline", "rewrite", "candidate"];
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
};
const summarize = (values) => ({ n: values.length, min: Math.min(...values),
  median: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values) });
const reduction = (before, after) => before > 0 ? 100 * (before - after) / before : null;
const regression = (before, after) => before > 0 ? 100 * (after / before - 1) : null;
function withinBudget(started) {
  if (performance.now() - started > 120_000) throw new Error("Scenario exceeded its 120 second budget");
}
async function selectSchema(variant) {
  await client.query(`SET search_path = ${schemas[variant === "rewrite" ? "baseline" : variant]}, pg_catalog`);
}
const walkPlan = (plan) => [plan, ...(plan.Plans ?? []).flatMap(walkPlan)];
function planMetrics(explained, walMeasured = false) {
  const nodes = walkPlan(explained.Plan);
  const scanNodes = nodes.filter((node) => /Scan$/.test(node["Node Type"]) && node["Relation Name"]);
  const rootPlan = explained.Plan;
  return {
    executionMs: explained["Execution Time"],
    rowsScanned: scanNodes.reduce((sum, node) => sum + ((node["Actual Rows"] ?? 0) +
      (node["Rows Removed by Filter"] ?? 0) + (node["Rows Removed by Index Recheck"] ?? 0)) * (node["Actual Loops"] ?? 1), 0),
    rowsRemovedByFilter: nodes.reduce((sum, node) => sum + (node["Rows Removed by Filter"] ?? 0) * (node["Actual Loops"] ?? 1), 0),
    rowsRemovedByIndexRecheck: nodes.reduce((sum, node) => sum + (node["Rows Removed by Index Recheck"] ?? 0) * (node["Actual Loops"] ?? 1), 0),
    rowsEnteringSort: nodes.filter((node) => /Sort$/.test(node["Node Type"]))
      .reduce((sum, node) => sum + (node.Plans?.[0]?.["Actual Rows"] ?? 0) * (node["Actual Loops"] ?? 1), 0),
    sharedHits: rootPlan["Shared Hit Blocks"] ?? 0,
    sharedReads: rootPlan["Shared Read Blocks"] ?? 0,
    sharedBuffers: (rootPlan["Shared Hit Blocks"] ?? 0) + (rootPlan["Shared Read Blocks"] ?? 0),
    tempReadBlocks: rootPlan["Temp Read Blocks"] ?? 0,
    tempWrittenBlocks: rootPlan["Temp Written Blocks"] ?? 0,
    walMeasured,
    walBytes: walMeasured ? rootPlan["WAL Bytes"] ?? 0 : null,
    walRecords: walMeasured ? rootPlan["WAL Records"] ?? 0 : null,
    walFpi: walMeasured ? rootPlan["WAL FPI"] ?? 0 : null,
    scanIndexes: [...new Set(nodes.map((node) => node["Index Name"]).filter(Boolean))],
  };
}
async function explain(sql, params, analyze = false, wal = false) {
  return (await client.query(`EXPLAIN (${analyze ? `ANALYZE, BUFFERS, ${wal ? "WAL, " : ""}` : ""}FORMAT JSON) ${sql}`, params))
    .rows[0]["QUERY PLAN"][0];
}
async function sizes() {
  return (await client.query(`SELECT
    pg_relation_size('polymarket_rtds_prices')::bigint AS raw_heap_bytes,
    pg_indexes_size('polymarket_rtds_prices')::bigint AS raw_all_index_bytes,
    COALESCE(pg_relation_size(to_regclass($1)),0)::bigint AS candidate_index_bytes,
    pg_relation_size('polymarket_rtds_1m')::bigint AS aggregate_heap_bytes,
    pg_indexes_size('polymarket_rtds_1m')::bigint AS aggregate_all_index_bytes`, [indexName])).rows[0];
}

// Four interleaved pairs with exactly 30,000 rows each. Prices are text/fixed-point.
// Five timestamps tie; the identity primary key is the deterministic last tie-break.
const insertSql = `INSERT INTO polymarket_rtds_prices
  (feed,symbol,price,source_ts,received_at,ingest_lag_ms)
 SELECT CASE WHEN g % 2 = 1 THEN 'twap30' ELSE 'twap60' END,
        CASE WHEN (g - 1) % 4 < 2 THEN 'btc/usd' ELSE 'eth/usd' END,
        CASE WHEN (g - 1) % 4 < 2 THEN '64000.' ELSE '2400.' END || lpad(g::text,6,'0'),
        CASE WHEN g % 101 = 0 THEN NULL
             WHEN g % 997 = 0 THEN TIMESTAMPTZ '2026-09-12 02:30:00Z' + INTERVAL '60 seconds'
             ELSE TIMESTAMPTZ '2026-09-12 02:30:00Z' + (((ordinal - 1) / 5) * 5 + 1 - 30000) * INTERVAL '1 second' END,
        CASE WHEN g % 251 = 0 THEN TIMESTAMPTZ '2026-09-12 02:30:00Z' + INTERVAL '120 seconds'
             ELSE TIMESTAMPTZ '2026-09-12 02:30:00Z' + (ordinal - 30000) * INTERVAL '1 second' + (g % 3) * INTERVAL '100 milliseconds' END,
        CASE WHEN g % 101 = 0 THEN NULL ELSE g % 31 END
   FROM (SELECT g, ((g - 1) / 4) + 1 AS ordinal
           FROM generate_series($1::integer,$2::integer) AS g) fixture ORDER BY g`;
const aggregateSql = `INSERT INTO polymarket_rtds_1m
  (feed,symbol,bucket_start,open,high,low,close,samples,received_at)
 SELECT CASE WHEN g % 2 = 1 THEN 'twap30' ELSE 'twap60' END,
        CASE WHEN (g - 1) % 4 < 2 THEN 'btc/usd' ELSE 'eth/usd' END,
        TIMESTAMPTZ '2026-09-12 02:30:00Z' - (((g - 1) / 4) + 1) * INTERVAL '1 minute',
        '64000.000001','64000.000009','63999.999999',
        CASE WHEN $3::boolean THEN '64000.000008' ELSE '64000.000002' END,
        CASE WHEN $3::boolean THEN 120 ELSE 60 END,
        CASE WHEN $3::boolean THEN TIMESTAMPTZ '2026-09-12 02:32:00Z' ELSE TIMESTAMPTZ '2026-09-12 02:31:00Z' END
   FROM generate_series($1::integer,$2::integer) AS g
 ON CONFLICT (feed,symbol,bucket_start) DO UPDATE SET
   open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,
   samples=EXCLUDED.samples,received_at=EXCLUDED.received_at`;
const deleteSql = `DELETE FROM polymarket_rtds_prices WHERE rtds_price_id IN (
  SELECT rtds_price_id FROM polymarket_rtds_prices
   WHERE received_at < TIMESTAMPTZ '2026-09-12 00:00:00Z'
   ORDER BY received_at,rtds_price_id LIMIT $1)`;

// Independent JS oracle: no SQL, no candidate ordering helpers, no Number price conversion.
function expectedRows(symbols, selectedFeeds, timestamp, lateCluster = false) {
  const latest = new Map();
  for (let g = 1; g <= 120_000; g += 1) {
    const ordinal = Math.floor((g - 1) / 4) + 1;
    const symbol = (g - 1) % 4 < 2 ? "btc/usd" : "eth/usd";
    const feed = g % 2 === 1 ? "twap30" : "twap60";
    if (!symbols.includes(symbol) || !selectedFeeds.includes(feed)) continue;
    const sourceMs = g % 101 === 0 ? null : g % 997 === 0 ? decisionMs + 60_000
      : decisionMs + (Math.floor((ordinal - 1) / 5) * 5 + 1 - 30000) * 1000;
    const receivedMs = lateCluster && g > 110_000 ? decisionMs + 300_000
      : g % 251 === 0 ? decisionMs + 120_000 : decisionMs + (ordinal - 30000) * 1000 + (g % 3) * 100;
    const effectiveMs = sourceMs ?? receivedMs;
    if (receivedMs > Date.parse(timestamp) || effectiveMs > Date.parse(timestamp)) continue;
    const key = `${symbol}|${feed}`;
    const previous = latest.get(key);
    if (!previous || effectiveMs > previous.effectiveMs || (effectiveMs === previous.effectiveMs && g > previous.id)) {
      latest.set(key, { id: g, effectiveMs, row: { symbol, feed,
        price: `${symbol === "btc/usd" ? "64000" : "2400"}.${String(g).padStart(6, "0")}`,
        source_ts: sourceMs === null ? null : new Date(sourceMs).toISOString(),
        received_at: new Date(receivedMs).toISOString() } });
    }
  }
  return [...latest.values()].map((entry) => entry.row)
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.feed.localeCompare(b.feed));
}
const normalizedRows = (rows) => rows.map((row) => ({ ...row,
  source_ts: row.source_ts === null ? null : row.source_ts.toISOString(),
  received_at: row.received_at.toISOString() }));
function compareRead(before, after) {
  const rowReduction = reduction(before.metrics.rowsScanned, after.metrics.rowsScanned);
  const bufferReduction = reduction(before.metrics.sharedBuffers, after.metrics.sharedBuffers);
  return { reductionPercent: { rowsScanned: rowReduction, sharedBuffers: bufferReduction,
    rowsEnteringSort: reduction(before.metrics.rowsEnteringSort, after.metrics.rowsEnteringSort),
    p95: reduction(before.latencyMs.p95, after.latencyMs.p95) },
    screening: { p95AtMost500Ms: after.latencyMs.p95 <= 500,
      rowsReductionAtLeast50Percent: rowReduction === null ? null : rowReduction >= 50,
      buffersReductionAtLeast50Percent: bufferReduction === null ? null : bufferReduction >= 50,
      p95RegressionAtMost10Percent: regression(before.latencyMs.p95, after.latencyMs.p95) <= 10 } };
}
async function readScenario(variant, params, expected, started) {
  await selectSchema(variant);
  const sql = variant === "baseline" ? baselineSql : candidateSql;
  const estimatedPlan = await explain(sql, params);
  const analyzedPlan = await explain(sql, params, true);
  let result;
  for (let i = 0; i < 3; i += 1) {
    result = normalizedRows((await client.query(sql, params)).rows);
    assert.deepEqual(result, expected, `${variant}: independent oracle mismatch`);
    withinBudget(started);
  }
  const samplesMs = [];
  for (let i = 0; i < 20; i += 1) {
    const before = performance.now();
    const current = normalizedRows((await client.query(sql, params)).rows);
    samplesMs.push(performance.now() - before);
    assert.deepEqual(current, result, "Selected full rows changed in fixed fixture");
    withinBudget(started);
  }
  return { result, samplesMs, latencyMs: summarize(samplesMs), metrics: planMetrics(analyzedPlan), estimatedPlan, analyzedPlan };
}
async function runReadScenario(name, symbols, selectedFeeds, timestamp, lateCluster = false) {
  const started = performance.now();
  const params = [symbols, selectedFeeds, timestamp];
  const expected = expectedRows(symbols, selectedFeeds, timestamp, lateCluster);
  const result = { params, expected, oracleEqual: true, fullSelectedRowsEqual: true };
  // Every variant has its own three warmups; alternate ordering across scenarios.
  const order = Object.keys(report.reads).length % 2 ? [...variants].reverse() : variants;
  for (const variant of order) result[variant] = await readScenario(variant, params, expected, started);
  assert.deepEqual(result.baseline.result, result.rewrite.result);
  assert.deepEqual(result.baseline.result, result.candidate.result);
  result.rewriteVsBaseline = compareRead(result.baseline, result.rewrite);
  result.candidateVsBaseline = compareRead(result.baseline, result.candidate);
  result.scenarioWallMs = performance.now() - started;
  report.reads[name] = result;
}
async function rowCounts() {
  return (await client.query(`SELECT
    (SELECT count(*)::integer FROM polymarket_rtds_prices) AS raw_rows,
    (SELECT count(*)::integer FROM polymarket_rtds_1m) AS aggregate_rows`)).rows[0];
}
async function persistedEquality() {
  const result = {};
  for (const [table, key] of [["polymarket_rtds_prices", "rtds_price_id"],
    ["polymarket_rtds_1m", "feed,symbol,bucket_start"]]) {
    // Canonical JSON includes EVERY persisted field including identities, monetary text,
    // source/received timestamps and ingest lag; compare UTF-8 bytes rather than collation.
    result[table] = (await client.query(`SELECT count(*)::integer AS mismatches
      FROM ${schemas.baseline}.${table} b FULL JOIN ${schemas.candidate}.${table} c USING (${key})
      WHERE convert_to(to_jsonb(b)::text,'UTF8') IS DISTINCT FROM convert_to(to_jsonb(c)::text,'UTF8')`)).rows[0].mismatches;
    assert.equal(result[table], 0, `${table}: persisted byte equality failed`);
  }
  return { equal: true, mismatchesByTable: result };
}
async function writeBatch(variant, sql, params, includePlans) {
  await selectSchema(variant);
  const estimatedPlan = includePlans ? await explain(sql, params) : undefined;
  const started = performance.now();
  await client.query("BEGIN");
  try {
    const analyzedPlan = await explain(sql, params, true, true);
    const commitStarted = performance.now();
    await client.query("COMMIT");
    const completed = performance.now();
    return { activeMs: completed - started, commitMs: completed - commitStarted,
      tuplesInserted: analyzedPlan.Plan["Tuples Inserted"] ?? null,
      conflicts: analyzedPlan.Plan["Conflicting Tuples"] ?? 0,
      metrics: planMetrics(analyzedPlan, true), ...(includePlans ? { estimatedPlan, analyzedPlan } : {}) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
function writeSummary(batches, rows, batchRows) {
  const activeMs = batches.reduce((sum, batch) => sum + batch.activeMs, 0);
  return { attemptedRows: rows, batchRows, transactions: batches.length, activeMs,
    attemptedRowsPerSecond: rows / (activeMs / 1000),
    tuplesInserted: batches.some((batch) => batch.tuplesInserted === null) ? null
      : batches.reduce((sum, batch) => sum + batch.tuplesInserted, 0),
    conflicts: batches.reduce((sum, batch) => sum + batch.conflicts, 0),
    batchLatencyMs: summarize(batches.map((batch) => batch.activeMs)),
    commitLatencyMs: summarize(batches.map((batch) => batch.commitMs)),
    statementWalBytes: batches.reduce((sum, batch) => sum + batch.metrics.walBytes, 0),
    statementWalRecords: batches.reduce((sum, batch) => sum + batch.metrics.walRecords, 0),
    statementWalFpi: batches.reduce((sum, batch) => sum + batch.metrics.walFpi, 0), batches };
}
async function runWriteScenario(name, sql, rows, batchRows, paramsForBatch, expectedCounts) {
  const started = performance.now();
  const batches = { baseline: [], candidate: [] };
  for (let i = 0; i < 20; i += 1) {
    for (const variant of i % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
      batches[variant].push(await writeBatch(variant, sql, paramsForBatch(i), i === 0));
      withinBudget(started);
    }
  }
  const baseline = writeSummary(batches.baseline, rows, batchRows);
  const candidate = writeSummary(batches.candidate, rows, batchRows);
  const measured = { sql, baseline, candidate,
    activeTimeRegressionPercent: regression(baseline.activeMs, candidate.activeMs),
    throughputRegressionPercent: reduction(baseline.attemptedRowsPerSecond, candidate.attemptedRowsPerSecond),
    commitP95RegressionPercent: regression(baseline.commitLatencyMs.p95, candidate.commitLatencyMs.p95),
    statementWalAdditionalBytes: candidate.statementWalBytes - baseline.statementWalBytes,
    after: {} };
  for (const variant of ["baseline", "candidate"]) {
    await selectSchema(variant);
    const counts = await rowCounts();
    assert.deepEqual(counts, expectedCounts, `${name}: unexpected persisted counts`);
    measured.after[variant] = { ...counts, ...(await sizes()) };
  }
  measured.affectedRowsVerifiedPerVariant = rows; // Validated by phase counts and full persisted equality.
  if (name === "aggregateUpserts") {
    for (const variant of [baseline, candidate]) {
      assert.equal(variant.tuplesInserted, 0);
      assert.equal(variant.conflicts, rows);
    }
    for (const variant of ["baseline", "candidate"]) {
      await selectSchema(variant);
      const changed = (await client.query("SELECT count(*)::integer AS n FROM polymarket_rtds_1m WHERE samples=120 AND close='64000.000008'")).rows[0].n;
      assert.equal(changed, rows, "Upserts must update every seeded aggregate");
    }
  }
  measured.persistedRows = await persistedEquality();
  measured.scenarioWallMs = performance.now() - started;
  withinBudget(started);
  measured.screening = { thresholdPercent: 10,
    activeTimeWithinThreshold: measured.activeTimeRegressionPercent <= 10,
    throughputWithinThreshold: measured.throughputRegressionPercent <= 10,
    commitP95WithinThreshold: measured.commitP95RegressionPercent <= 10,
    allWithinThreshold: measured.activeTimeRegressionPercent <= 10 &&
      measured.throughputRegressionPercent <= 10 && measured.commitP95RegressionPercent <= 10 };
  report.writes[name] = measured;
}

const report = { block: "DB-03", mode: readsOnly ? "reads-only" : "with-writes",
  observedAtUtc: new Date().toISOString(),
  fixture: { rawRowsPerVariant: 120_000, symbols: ["btc/usd", "eth/usd"], feeds,
    rowsPerSymbolFeed: 30_000, price: "exact six-decimal text, unique per row",
    age: "30,000 seconds at one row per pair per second; five-second source timestamp ties",
    sourceNull: "every 101st row", sourceFuture: "every 997th non-NULL row, decision +60s",
    receivedFuture: "every 251st row, decision +120s", receivedJitterMs: [0, 100, 200],
    adversarialLateCluster: { status: readsOnly ? "not_run" : "scheduled",
      description: "with-writes only: replace received_at for latest 2,500 rows per pair (10,000 total) with decision +300s, then restore before writes" },
    aggregateRowsPerVariant: readsOnly ? 0 : 1000,
    plannedWritesPerVariant: { rawInserts: 10_000, aggregateUpserts: 1000, rawDeletes: 1000 } },
  method: { connections: 1, statementTimeoutMs: 5000, scenarioBudgetMs: 120_000,
    warmups: 3, samplesPerReadScenario: 20,
    selectedScope: readsOnly
      ? "Creates/seeds only these UUID disposable fixture schemas and their indexes, then runs ten SELECT scenarios. No measured writes, WAL experiment, UPDATE, VACUUM or DELETE. Cleanup drops only schemas created by this invocation."
      : "Full experiment including disposable adversarial updates, VACUUM, measured inserts/upserts/deletes and statement-local WAL; requires separate review.",
    variants: {
      baseline: "production DISTINCT ON query, original indexes", rewrite: "LATERAL query, original indexes",
      candidate: "LATERAL query plus candidate expression index" },
    baselineSourceRef: "a6c5303 (DB-02 merge; loadFeedSamples SQL remains unchanged in DB-03)",
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    explain: "estimated plan precedes EXPLAIN ANALYZE for each read; with-writes additionally captures the first batch of each write variant; full JSON saved",
    writes: "with-writes only: 20 transactions per phase: 500 raw inserts or 50 aggregate upserts/raw deletes; baseline/candidate order alternates each batch",
    wal: readsOnly ? "not_run: no EXPLAIN ANALYZE WAL statements in reads-only mode"
      : "EXPLAIN ANALYZE WAL at modification plan root; statement-local, excludes COMMIT, index build and cleanup",
    equality: "read rows match independent JS oracle; all persisted columns match canonical JSON UTF-8 bytes between fixture schemas after setup and, with-writes only, after each write phase",
    latency: "client elapsed includes round trip; write active time excludes estimated EXPLAIN and interleaved other-variant work",
    rowsScanned: "table-scan actual rows plus filtered/rechecked rows, multiplied by loops; excludes Function/Subquery scans; nested loops can round averages",
    limitations: "synthetic warm-cache fixture; aggregate upserts batch 50 rows and use a fixed received_at for exact equality (runtime uses CURRENT_TIMESTAMP); deletes batch 50 old raw rows only in these disposable schemas; p95 n=20 is screening, not p99/soak; no production operation" },
  baselineSql, candidateSql, indexSql, setup: {}, reads: {},
  writes: readsOnly ? { status: "not_run", approval: "pending_approval", executedPhases: [],
    plannedPhases: ["rawInserts", "aggregateUpserts", "rawDeletes"],
    skippedReason: "Reads-only mode excludes write/WAL measurement, adversarial UPDATE, VACUUM and retention DELETE; the separate full experiment remains pending review." } : {} };
let connected = false;
try {
  await client.connect();
  connected = true;
  await client.query("SET TIME ZONE 'UTC'");
  report.server = (await client.query(`SELECT version(),
    current_setting('server_version_num') AS server_version_num,
    current_setting('statement_timeout') AS statement_timeout,
    current_setting('shared_buffers') AS shared_buffers,
    current_setting('work_mem') AS work_mem,
    current_setting('synchronous_commit') AS synchronous_commit,
    current_setting('max_parallel_workers_per_gather') AS max_parallel_workers_per_gather`)).rows[0];
  assert.equal(Math.floor(Number(report.server.server_version_num) / 10_000), 18, "Benchmark requires PostgreSQL 18");
  for (const variant of ["baseline", "candidate"]) {
    const started = performance.now();
    await client.query(`CREATE SCHEMA ${schemas[variant]}`);
    created.push(schemas[variant]);
    await selectSchema(variant);
    await client.query(ddl);
    for (let first = 1; first <= 120_000; first += 5000) {
      await client.query(insertSql, [first, first + 4999]);
      withinBudget(started);
    }
    if (!readsOnly) await client.query(aggregateSql, [1, 1000, false]);
    await client.query("ANALYZE polymarket_rtds_prices");
    await client.query("ANALYZE polymarket_rtds_1m");
    if (variant === "candidate") {
      const buildStarted = performance.now();
      await client.query(indexSql); // Verbatim concurrent SQL, outside any transaction.
      report.setup.concurrentIndexBuildMs = performance.now() - buildStarted;
      report.setup.indexCatalog = (await client.query(`SELECT indisvalid,indisready,
        pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indexrelid=to_regclass($1)`, [indexName])).rows[0];
      assert.equal(report.setup.indexCatalog?.indisvalid, true);
      assert.equal(report.setup.indexCatalog?.indisready, true);
    }
    assert.deepEqual(await rowCounts(), { raw_rows: 120_000, aggregate_rows: readsOnly ? 0 : 1000 });
    report.setup[variant] = { ...(await sizes()), wallMs: performance.now() - started };
    withinBudget(started);
  }
  report.setup.persistedRows = await persistedEquality();
  for (const [name, symbols, timestamp] of [
    ["currentOneSymbol", ["btc/usd"], decisionTs],
    ["currentTwoSymbols", ["btc/usd", "eth/usd"], decisionTs],
    ["historicalOneSymbol", ["btc/usd"], "2026-09-11T22:20:00.000Z"],
    ["historicalTwoSymbols", ["btc/usd", "eth/usd"], "2026-09-11T22:20:00.000Z"],
    ["missingSymbol", ["missing/usd"], decisionTs],
    ["beforeFirstSample", ["btc/usd", "eth/usd"], "2026-09-11T10:00:00.000Z"],
    ["emptySymbols", [], decisionTs],
    ["duplicateSymbols", ["btc/usd", "btc/usd"], decisionTs],
  ]) await runReadScenario(name, symbols, feeds, timestamp);
  await runReadScenario("emptyFeeds", ["btc/usd"], [], decisionTs);
  await runReadScenario("duplicateFeeds", ["btc/usd"], ["twap30", "twap30", "twap60"], decisionTs);
  if (!readsOnly) {
    for (const variant of ["baseline", "candidate"]) {
      await selectSchema(variant);
      const changed = await client.query("UPDATE polymarket_rtds_prices SET received_at=TIMESTAMPTZ '2026-09-12 02:35:00Z' WHERE rtds_price_id > 110000");
      assert.equal(changed.rowCount, 10_000);
      await client.query("ANALYZE polymarket_rtds_prices");
    }
    await runReadScenario("adversarialLateCluster", ["btc/usd", "eth/usd"], feeds, decisionTs, true);
    report.fixture.adversarialLateCluster.status = "executed";
    for (const variant of ["baseline", "candidate"]) {
      await selectSchema(variant);
      await client.query(`UPDATE polymarket_rtds_prices SET received_at=
        CASE WHEN rtds_price_id % 251=0 THEN TIMESTAMPTZ '2026-09-12 02:30:00Z' + INTERVAL '120 seconds'
        ELSE TIMESTAMPTZ '2026-09-12 02:30:00Z' + (((rtds_price_id - 1) / 4) + 1 - 30000) * INTERVAL '1 second'
          + (rtds_price_id % 3) * INTERVAL '100 milliseconds' END WHERE rtds_price_id > 110000`);
      // Equal maintenance before writes removes the deliberate adversarial UPDATE's dead tuples.
      await client.query("VACUUM (ANALYZE) polymarket_rtds_prices");
    }
    report.afterAdversarialRestore = await persistedEquality();
    await runWriteScenario("rawInserts", insertSql, 10_000, 500,
      (i) => [120_001 + i * 500, 120_500 + i * 500], { raw_rows: 130_000, aggregate_rows: 1000 });
    await runWriteScenario("aggregateUpserts", aggregateSql, 1000, 50,
      (i) => [1 + i * 50, 50 + i * 50, true], { raw_rows: 130_000, aggregate_rows: 1000 });
    await runWriteScenario("rawDeletes", deleteSql, 1000, 50,
      () => [50], { raw_rows: 129_000, aggregate_rows: 1000 });
  }
  report.screening = {
    thresholdPercent: 10,
    rewriteWithoutIndexAllReadP95Within10Percent: Object.values(report.reads)
      .every((scenario) => scenario.rewriteVsBaseline.screening.p95RegressionAtMost10Percent),
    candidateAllWritePhasesWithin10Percent: readsOnly ? null : Object.values(report.writes)
      .every((scenario) => scenario.screening.allWithinThreshold),
    meaning: "measured flags only; no assertion converts timing noise into correctness failure or waives DB-04 operational gates",
  };
} finally {
  if (connected) {
    try {
      for (const schema of created) await client.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally { await client.end(); }
  }
}
report.cleanedUp = true;
console.log(JSON.stringify(report, null, 2));
