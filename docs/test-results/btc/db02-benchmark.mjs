// DB-02: run only against a disposable PostgreSQL database.
// GANSO_TEST_DATABASE_URL=postgres://... node docs/test-results/btc/db02-benchmark.mjs
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import pg from "pg";

const databaseUrl = process.env.GANSO_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("GANSO_TEST_DATABASE_URL must name a disposable database");
const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [foundation, retention, source, indexSql] = await Promise.all([
  read("migrations/0005_polymarket_data_foundation.sql"),
  read("migrations/0013_retention_time_indexes.sql"),
  read("apps/api/src/polymarket/trades.ts"),
  read("docs/ops/sql/db02-trades-last-recorded-index.sql"),
]);
const tradesStart = foundation.indexOf("CREATE TABLE IF NOT EXISTS polymarket_trades (");
const tradesEnd = foundation.indexOf("-- 1-minute aggregates", tradesStart);
const receivedIndex = retention.match(/CREATE INDEX IF NOT EXISTS polymarket_trades_received_at_idx[\s\S]*?;/)?.[0];
const cursorSql = source.match(/async function lastRecordedTs[\s\S]*?`(SELECT max\(trade_ts\)[\s\S]*?)`/)?.[1];
if (tradesStart < 0 || tradesEnd <= tradesStart || !receivedIndex || !cursorSql) {
  throw new Error("Expected production SQL/migration sections were not found");
}
const ddl = `${foundation.slice(tradesStart, tradesEnd)}\n${receivedIndex}`;
const indexName = "polymarket_trades_data_api_condition_ts_idx";
const prefix = `db02_${randomUUID().replaceAll("-", "")}`;
const schemas = { baseline: `${prefix}_baseline`, candidate: `${prefix}_candidate` };
const created = [];
const client = new pg.Client({
  connectionString: databaseUrl,
  application_name: "db02_disposable_benchmark",
  statement_timeout: 5_000,
});
const marketId = (id) => `0x${id.toString(16).padStart(64, "0")}`;
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
};
const summarize = (values) => ({
  n: values.length,
  min: Math.min(...values),
  median: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: Math.max(...values),
});
function withinBudget(started) {
  if (performance.now() - started > 120_000) throw new Error("Scenario exceeded its 120 second budget");
}
async function selectSchema(variant) {
  await client.query(`SET search_path = ${schemas[variant]}, pg_catalog`);
}
function walkPlan(plan) {
  return [plan, ...(plan.Plans ?? []).flatMap(walkPlan)];
}
function planMetrics(explained) {
  const rootPlan = explained.Plan;
  return {
    executionMs: explained["Execution Time"],
    rowsScanned: walkPlan(rootPlan)
      .filter((node) => /Scan$/.test(node["Node Type"]))
      .reduce((total, node) => total + (
        (node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0) +
        (node["Rows Removed by Index Recheck"] ?? 0)
      ) * (node["Actual Loops"] ?? 1), 0),
    sharedHits: rootPlan["Shared Hit Blocks"] ?? 0,
    sharedReads: rootPlan["Shared Read Blocks"] ?? 0,
    sharedBuffers: (rootPlan["Shared Hit Blocks"] ?? 0) + (rootPlan["Shared Read Blocks"] ?? 0),
    walBytes: rootPlan["WAL Bytes"] ?? 0,
    walRecords: rootPlan["WAL Records"] ?? 0,
    walFpi: rootPlan["WAL FPI"] ?? 0,
  };
}
// Matching inserts/conflicts preserve source/external_id and the WS dedupe key.
// All generated values are deterministic; distinct tokens share each market.
const insertSql = `INSERT INTO polymarket_trades
  (token_id,condition_id,price,size,side,fee_rate_bps,transaction_hash,
   provenance,external_id,trade_ts,received_at)
 SELECT lpad((market * 2 + g % 2)::text,77,'0'),
        '0x' || lpad(to_hex(market),64,'0'), '0.50','1.25',
        CASE WHEN g % 2 = 0 THEN 'BUY' ELSE 'SELL' END,NULL,
        'tx-' || g, CASE WHEN g % 4 = 0 THEN 'ws' ELSE 'data_api' END,
        'trade-' || g,
        CASE WHEN g % 101 = 0 THEN NULL
             WHEN g % 997 = 0 THEN TIMESTAMPTZ '2026-09-12 02:28:00Z' + (g % 19) * INTERVAL '1 minute'
             ELSE TIMESTAMPTZ '2026-09-12 02:28:00Z' - (g % 144000) * INTERVAL '1 minute' END,
        TIMESTAMPTZ '2026-09-12 02:29:00Z'
   FROM (SELECT g,
          CASE WHEN g <= 50000 THEN 0 ELSE 1 + ((g - 50001) % 999) END AS market
         FROM generate_series($1::integer,$2::integer) AS g) fixture
 ON CONFLICT DO NOTHING`;

async function explain(sql, params, analyze = false, wal = false) {
  const options = analyze
    ? `ANALYZE, BUFFERS, ${wal ? "WAL, " : ""}FORMAT JSON`
    : "FORMAT JSON";
  return (await client.query(`EXPLAIN (${options}) ${sql}`, params)).rows[0]["QUERY PLAN"][0];
}
async function sizes() {
  return (await client.query(`SELECT
    pg_relation_size('polymarket_trades')::bigint AS heap_bytes,
    pg_indexes_size('polymarket_trades')::bigint AS all_index_bytes,
    COALESCE(pg_relation_size(to_regclass($1)),0)::bigint AS candidate_index_bytes`,
  [indexName])).rows[0];
}
async function readScenario(variant, conditionId) {
  const started = performance.now();
  await selectSchema(variant);
  const estimatedPlan = await explain(cursorSql, [conditionId]);
  const analyzedPlan = await explain(cursorSql, [conditionId], true);
  let result;
  for (let i = 0; i < 3; i += 1) {
    result = (await client.query(cursorSql, [conditionId])).rows[0].max_ts;
    withinBudget(started);
  }
  const samplesMs = [];
  for (let i = 0; i < 20; i += 1) {
    const before = performance.now();
    const current = (await client.query(cursorSql, [conditionId])).rows[0].max_ts;
    samplesMs.push(performance.now() - before);
    if (JSON.stringify(current) !== JSON.stringify(result)) throw new Error("Cursor changed in a fixed fixture");
    withinBudget(started);
  }
  return { result, samplesMs, latencyMs: summarize(samplesMs),
    metrics: planMetrics(analyzedPlan), estimatedPlan, analyzedPlan,
    scenarioWallMs: performance.now() - started };
}

async function writeBatch(variant, first, last) {
  await selectSchema(variant);
  const started = performance.now();
  await client.query("BEGIN");
  try {
    const analyzed = await explain(insertSql, [first, last], true, true);
    const commitStarted = performance.now();
    await client.query("COMMIT");
    return { activeMs: performance.now() - started,
      commitMs: performance.now() - commitStarted,
      tuplesInserted: analyzed.Plan["Tuples Inserted"] ?? 0,
      conflicts: analyzed.Plan["Conflicting Tuples"] ?? 0,
      metrics: planMetrics(analyzed) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
function writeSummary(batches) {
  const activeMs = batches.reduce((sum, batch) => sum + batch.activeMs, 0);
  return {
    attemptedRows: 10_000, batchRows: 500, transactions: batches.length, activeMs,
    attemptedRowsPerSecond: 10_000 / (activeMs / 1000),
    tuplesInserted: batches.reduce((sum, batch) => sum + batch.tuplesInserted, 0),
    conflicts: batches.reduce((sum, batch) => sum + batch.conflicts, 0),
    batchLatencyMs: summarize(batches.map((batch) => batch.activeMs)),
    commitLatencyMs: summarize(batches.map((batch) => batch.commitMs)),
    statementWalBytes: batches.reduce((sum, batch) => sum + batch.metrics.walBytes, 0),
    statementWalRecords: batches.reduce((sum, batch) => sum + batch.metrics.walRecords, 0),
    statementWalFpi: batches.reduce((sum, batch) => sum + batch.metrics.walFpi, 0),
    batches,
  };
}
function reduction(before, after) { return before > 0 ? 100 * (before - after) / before : null; }

const report = {
  block: "DB-02", observedAtUtc: new Date().toISOString(),
  fixture: { rowsPerVariant: 100_000, markets: 1000, hotMarketRows: 50_000,
    remainingRows: 50_000, sourceRatio: "75% data_api / 25% ws",
    age: "minutes across ~69 days, NULL every 101st row, future every 997th non-NULL row",
    marketIdFormat: "0x + 64 hex digits", tokenIdLength: 77,
    writeRowsPerVariant: 10_000, conflictAttemptsPerVariant: 10_000 },
  method: { connections: 1, statementTimeoutMs: 5000, scenarioBudgetMs: 120_000,
    warmups: 3, samplesPerReadScenario: 20,
    writes: "20 transactions of 500 rows per phase; baseline/candidate order alternates each batch",
    wal: "EXPLAIN ANALYZE WAL at INSERT plan root, statement-local; excludes COMMIT, index build and cleanup",
    latency: "client elapsed includes round trip; write active time excludes interleaved other-variant work",
    rowsScanned: "scan-node actual rows plus filtered/rechecked rows, multiplied by loops",
    limitations: "synthetic batched INSERT, not the recorder's individual-row workload; warm cache; p95 with n=20 is screening, not p99/soak" },
  cursorSql, indexSql, setup: {}, reads: {}, writes: {},
};
let connected = false;
try {
  await client.connect();
  connected = true;
  report.server = (await client.query(`SELECT version(),
    current_setting('server_version_num') AS server_version_num,
    current_setting('statement_timeout') AS statement_timeout,
    current_setting('shared_buffers') AS shared_buffers,
    current_setting('work_mem') AS work_mem,
    current_setting('synchronous_commit') AS synchronous_commit,
    current_setting('max_parallel_workers_per_gather') AS max_parallel_workers_per_gather`)).rows[0];
  for (const variant of ["baseline", "candidate"]) {
    await client.query(`CREATE SCHEMA ${schemas[variant]}`);
    created.push(schemas[variant]);
    await selectSchema(variant);
    await client.query(ddl);
    const seedStarted = performance.now();
    for (let first = 1; first <= 100_000; first += 5000) {
      await client.query(insertSql, [first, first + 4999]);
      withinBudget(seedStarted);
    }
    await client.query("ANALYZE polymarket_trades");
    if (variant === "candidate") {
      const started = performance.now();
      // Outside any transaction: exercise the operational SQL verbatim.
      await client.query(indexSql);
      report.setup.concurrentIndexBuildMs = performance.now() - started;
      report.setup.indexCatalog = (await client.query(`SELECT indisvalid,indisready,
        pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indexrelid=to_regclass($1)`,
      [indexName])).rows[0];
      if (!report.setup.indexCatalog?.indisvalid || !report.setup.indexCatalog?.indisready) {
        throw new Error("Concurrent index is not valid and ready");
      }
    }
    report.setup[variant] = await sizes();
  }
  for (const [scenario, id] of [["hot", 0], ["cold", 999], ["missing", 1000]]) {
    const conditionId = marketId(id);
    const baseline = await readScenario("baseline", conditionId);
    const candidate = await readScenario("candidate", conditionId);
    if (JSON.stringify(baseline.result) !== JSON.stringify(candidate.result)) throw new Error("Cursor equivalence failed");
    report.reads[scenario] = { conditionId, baseline, candidate, equal: true,
      reductionPercent: { rowsScanned: reduction(baseline.metrics.rowsScanned, candidate.metrics.rowsScanned),
        sharedBuffers: reduction(baseline.metrics.sharedBuffers, candidate.metrics.sharedBuffers),
        p95: reduction(baseline.latencyMs.p95, candidate.latencyMs.p95) },
      screening: { candidateP95AtMost100Ms: candidate.latencyMs.p95 <= 100,
        rowsReductionAtLeast90Percent: reduction(baseline.metrics.rowsScanned, candidate.metrics.rowsScanned) >= 90,
        buffersReductionAtLeast90Percent: reduction(baseline.metrics.sharedBuffers, candidate.metrics.sharedBuffers) >= 90 } };
  }
  for (const phase of ["inserts", "conflicts"]) {
    const started = performance.now();
    const batches = { baseline: [], candidate: [] };
    for (let i = 0; i < 20; i += 1) {
      for (const variant of i % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
        batches[variant].push(await writeBatch(variant, 100_001 + i * 500, 100_500 + i * 500));
        withinBudget(started);
      }
    }
    const baseline = writeSummary(batches.baseline);
    const candidate = writeSummary(batches.candidate);
    const expectedInserts = phase === "inserts" ? 10_000 : 0;
    for (const result of [baseline, candidate]) {
      if (result.tuplesInserted !== expectedInserts || result.conflicts !== 10_000 - expectedInserts) {
        throw new Error(`Unexpected insert/conflict result in ${phase}`);
      }
    }
    report.writes[phase] = { baseline, candidate, scenarioWallMs: performance.now() - started,
      activeTimeRegressionPercent: 100 * (candidate.activeMs / baseline.activeMs - 1),
      throughputRegressionPercent: reduction(baseline.attemptedRowsPerSecond, candidate.attemptedRowsPerSecond),
      commitP95RegressionPercent: 100 * (candidate.commitLatencyMs.p95 / baseline.commitLatencyMs.p95 - 1),
      statementWalAdditionalBytes: candidate.statementWalBytes - baseline.statementWalBytes };
    const measured = report.writes[phase];
    measured.screening = {
      thresholdPercent: 10,
      activeTimeWithinThreshold: measured.activeTimeRegressionPercent <= 10,
      throughputWithinThreshold: measured.throughputRegressionPercent <= 10,
      commitP95WithinThreshold: measured.commitP95RegressionPercent <= 10,
      allWithinThreshold: measured.activeTimeRegressionPercent <= 10 &&
        measured.throughputRegressionPercent <= 10 && measured.commitP95RegressionPercent <= 10,
    };
  }
  report.afterWrites = {};
  for (const variant of ["baseline", "candidate"]) {
    await selectSchema(variant);
    const counts = (await client.query(`SELECT count(*)::integer AS rows,
      count(DISTINCT condition_id)::integer AS markets FROM polymarket_trades`)).rows[0];
    if (counts.rows !== 110_000 || counts.markets !== 1000) throw new Error("Fixture count changed unexpectedly");
    report.afterWrites[variant] = { ...counts, ...(await sizes()) };
  }
  // Match all persisted economic/identity/time fields, excluding generated row ID.
  const identityCheck = await client.query(`SELECT NOT EXISTS (
    SELECT 1 FROM ${schemas.baseline}.polymarket_trades b
    FULL JOIN ${schemas.candidate}.polymarket_trades c USING (provenance,external_id)
    WHERE b.trade_id IS NULL OR c.trade_id IS NULL OR
      (to_jsonb(b) - 'trade_id') IS DISTINCT FROM (to_jsonb(c) - 'trade_id')
  ) AS equal`);
  report.persistedRowsEqual = identityCheck.rows[0].equal;
  if (!report.persistedRowsEqual) throw new Error("Persisted identities/values differ between variants");
} finally {
  if (connected) {
    for (const schema of created) await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  }
}
report.cleanedUp = true;
console.log(JSON.stringify(report, null, 2));
