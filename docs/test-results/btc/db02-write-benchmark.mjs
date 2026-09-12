// DB-02 write-only recheck. Protocol: DB-02-write-recheck.md. No production use.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const tick = () => process.hrtime.bigint();
const elapsed = (started) => Number(tick() - started);
const INDEX = "polymarket_trades_data_api_condition_ts_idx";
const BASE_MS = Date.parse("2026-09-12T14:00:00Z");
const ROWS = 2500;
const ROUND = 625;
const BLOCK = 125;

export function fixture(source, position, tag) {
  assert.ok(source === "data_api" || source === "ws");
  const market = position % 2 === 0 ? 0 : 1 + (Math.floor(position / 2) % 999);
  const token = String(market * 2 + (Math.floor(position / 2) % 2)).padStart(77, "0");
  const timestamp = position % 101 === 0 ? null : new Date(
    position % 997 === 0 ? BASE_MS + 60_000 : BASE_MS - Math.floor(position / 2) * 60_000,
  );
  const common = [token, `0x${market.toString(16).padStart(64, "0")}`,
    "0.510000", "1.230000", position % 3 === 0 ? "SELL" : "BUY"];
  const tx = `0x${hash(`${source}:${tag}:${position}`)}`;
  return source === "data_api"
    ? [...common, tx, `${tag}:${source}:${position}`, timestamp, new Date(BASE_MS)]
    : [...common, "100", tx, timestamp, new Date(BASE_MS)];
}

export function summary(samples) {
  assert.ok(samples.length > 0);
  const sorted = samples.map((sample) => sample[0]).sort((a, b) => a - b);
  const commits = samples.filter((sample) => sample[1] !== null)
    .map((sample) => sample[1]).sort((a, b) => a - b);
  const p = (list, percentile) => list.length ? list[Math.ceil(list.length * percentile) - 1] / 1e6 : null;
  const totalNs = sorted.reduce((sum, n) => sum + n, 0);
  return { n: samples.length, activeNs: totalNs,
    p95Ns: sorted[Math.ceil(sorted.length * .95) - 1],
    commitP95Ns: commits.length ? commits[Math.ceil(commits.length * .95) - 1] : null,
    activeMs: totalNs / 1e6,
    throughput: samples.length * 1e9 / totalNs,
    latencyMs: { p50: p(sorted, .5), p95: p(sorted, .95), p99: p(sorted, .99), max: p(sorted, 1) },
    commitMs: { p95: p(commits, .95), p99: p(commits, .99) } };
}

export function compare(baseline, candidate) {
  const regression = (before, after) => before === null || after === null ? null : 100 * (after / before - 1);
  const metrics = {
    activeTimeRegressionPercent: regression(baseline.activeMs, candidate.activeMs),
    throughputLossPercent: 100 * (1 - candidate.throughput / baseline.throughput),
    p95RegressionPercent: regression(baseline.latencyMs.p95, candidate.latencyMs.p95),
    commitP95RegressionPercent: regression(baseline.commitMs.p95, candidate.commitMs.p95),
  };
  // Integer nanoseconds retain the exact <=10% boundary without epsilon slack.
  const within = (before, after) => before === null && after === null ||
    before !== null && after !== null && after * 10 <= before * 11;
  return { ...metrics, thresholdPercent: 10,
    passed: within(baseline.activeNs, candidate.activeNs) &&
      candidate.n * baseline.activeNs * 10 >= baseline.n * candidate.activeNs * 9 &&
      within(baseline.p95Ns, candidate.p95Ns) && within(baseline.commitP95Ns, candidate.commitP95Ns) };
}

function extract(source, anchor) {
  const start = source.indexOf(anchor);
  assert.ok(start >= 0, `Missing production function ${anchor}`);
  const sql = source.slice(start).match(/`(INSERT INTO polymarket_trades[\s\S]*?ON CONFLICT DO NOTHING)`/)?.[1];
  assert.ok(sql, `Missing INSERT in ${anchor}`);
  return sql;
}

const seedSql = `INSERT INTO polymarket_trades
 (token_id, condition_id, price, size, side, fee_rate_bps, transaction_hash,
  provenance, external_id, trade_ts, received_at)
 SELECT lpad((market*2+g%2)::text,77,'0'), '0x'||lpad(to_hex(market),64,'0'),
 '0.510000','1.230000',CASE WHEN g%2=0 THEN 'BUY' ELSE 'SELL' END,
 CASE WHEN g%4=0 THEN '100' ELSE NULL END, 'seed-tx-'||g,
 CASE WHEN g%4=0 THEN 'ws' ELSE 'data_api' END,
 CASE WHEN g%4=0 THEN NULL ELSE 'seed-external-'||g END,
 CASE WHEN g%101=0 THEN NULL WHEN g%997=0 THEN TIMESTAMPTZ '2026-09-12 14:01Z'
 ELSE TIMESTAMPTZ '2026-09-12 14:00Z' - (g/2)*INTERVAL '1 minute' END,
 TIMESTAMPTZ '2026-09-12 14:00Z'
 FROM (SELECT g, CASE WHEN g<=50000 THEN 0 ELSE 1+(g-50001)%999 END market
 FROM generate_series($1::integer,$2::integer) g) fixture`;

async function run() {
  const databaseUrl = new URL(process.env.GANSO_TEST_DATABASE_URL ?? "file:///missing");
  assert.ok(["postgres:", "postgresql:"].includes(databaseUrl.protocol));
  assert.ok(["127.0.0.1", "localhost"].includes(databaseUrl.hostname), "Disposable localhost only");
  assert.equal(databaseUrl.pathname, "/ganso_db02_write_disposable");
  const source = await read("apps/api/src/polymarket/trades.ts");
  const indexSql = await read("docs/ops/sql/db02-trades-last-recorded-index.sql");
  const protocol = await read("docs/test-results/btc/DB-02-write-recheck.md");
  const sql = { data_api: extract(source, "async function insertTrade"),
    ws: extract(source, "export async function handleLastTrade") };
  assert.match(sql.ws, /'ws',NULL/);
  const migrationNames = (await readdir(new URL("migrations/", root)))
    .filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  assert.equal(migrationNames.length, 23, "Schema changed: review workload contract before running");
  const migrations = await Promise.all(migrationNames.map(async (name) => {
    const text = await read(`migrations/${name}`);
    return { name, version: Number(name.slice(0, 4)), checksum: hash(text), text };
  }));
  const client = new pg.Client({ connectionString: databaseUrl.href,
    application_name: "db02_write_disposable", statement_timeout: 5000, connectionTimeoutMillis: 5000,
    options: "-c lock_timeout=500 -c idle_in_transaction_session_timeout=5000" });
  const prefix = `db02w_${randomUUID().replaceAll("-", "")}`;
  const schemas = { baseline: `${prefix}_b`, candidate: `${prefix}_c` };
  const created = [];
  const start = tick();
  let connected = false;
  const report = { block: "DB-02", protocol: "write-recheck-v1", startedAt: new Date().toISOString(),
    protocolSha256: hash(protocol), sourceSha256: hash(source), indexSha256: hash(indexSql),
    migrations: migrations.map(({text: _text, ...meta}) => meta),
    method: { connectionCount: 1, statementTimeoutMs: 5000, lockTimeoutMs: 500,
      scenarioBudgetSeconds: 120, globalBudgetSeconds: 600, rounds: 4, samplesPerRound: ROUND,
      blockSize: BLOCK, warmups: 3, seedRowsPerVariant: 100000, markets: 1000,
      measuredInsertsPerVariant: 10000, measuredConflictsPerVariant: 10000,
      samples: "[full transaction/statement nanoseconds, explicit COMMIT nanoseconds or null]",
      wal: "pg_stat_get_backend_wal(pg_backend_pid()), stats force-flushed between blocks; includes commits",
      gate: "Each metric <=10%, aggregate AND every round, for each source/mode/operation separately",
      productionPromotion: false }, sql, seedSql, setup: {}, scenarios: [], completed: false };
  function budget(scenarioStart = start) {
    assert.ok(elapsed(start) <= 600e9, "Global budget 600s exceeded");
    assert.ok(elapsed(scenarioStart) <= 120e9, "Scenario budget 120s exceeded");
  }
  async function select(variant) {
    await client.query(`SET search_path TO ${schemas[variant]}, pg_catalog`);
  }
  async function wal() {
    await client.query("SELECT pg_catalog.pg_stat_force_next_flush()");
    const row = (await client.query("SELECT * FROM pg_catalog.pg_stat_get_backend_wal(pg_backend_pid())")).rows[0];
    assert.ok(row && row.wal_bytes !== null, "Backend WAL unavailable");
    return Object.fromEntries(["wal_bytes", "wal_records", "wal_fpi"].map((key) => [key, Number(row[key])]));
  }
  async function guardCheck() {
    const result = await client.query(`SELECT tgname,tgenabled,pg_get_triggerdef(oid) AS definition
      FROM pg_trigger WHERE tgrelid='polymarket_trades'::regclass AND NOT tgisinternal ORDER BY tgname`);
    assert.equal(result.rows.length, 2);
    assert.ok(result.rows.every((row) => row.tgenabled === "O"));
    assert.match(result.rows[1].definition, /BEFORE INSERT OR UPDATE/);
    return result.rows;
  }
  async function sizes() {
    return (await client.query(`SELECT pg_relation_size('polymarket_trades')::text AS heap_bytes,
      pg_indexes_size('polymarket_trades')::text AS index_bytes,
      COALESCE(pg_relation_size(to_regclass($1)),0)::text AS candidate_bytes`, [INDEX])).rows[0];
  }
  async function operation(sourceName, params, mode, expected) {
    const begun = tick();
    if (mode === "explicit") await client.query("BEGIN");
    const row = await client.query(sql[sourceName], params);
    let commitNs = null;
    if (mode === "explicit") {
      const commit = tick();
      await client.query("COMMIT");
      commitNs = elapsed(commit);
    }
    const fullNs = elapsed(begun);
    assert.equal(row.rowCount, expected, "Unexpected insert/conflict outcome");
    return [fullNs, commitNs];
  }
  try {
    await client.connect();
    connected = true;
    report.server = (await client.query(`SELECT version(), current_database(), pg_backend_pid() AS pid,
      current_setting('server_version_num') AS version_num,
      current_setting('fsync') AS fsync, current_setting('full_page_writes') AS full_page_writes,
      current_setting('synchronous_commit') AS synchronous_commit,
      current_setting('shared_buffers') AS shared_buffers,current_setting('work_mem') AS work_mem,
      current_setting('statement_timeout') AS statement_timeout`)).rows[0];
    assert.equal(report.server.version_num, "180004");
    for (const key of ["fsync", "full_page_writes", "synchronous_commit"]) assert.equal(report.server[key], "on");
    assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()")).rows[0].n, 0);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0);
    for (const variant of ["baseline", "candidate"]) {
      const setupStart = tick();
      await client.query(`CREATE SCHEMA ${schemas[variant]}`);
      created.push(schemas[variant]);
      await select(variant);
      for (const migration of migrations) {
        await client.query("BEGIN");
        await client.query(migration.text.replaceAll(":'migration_version'", `'${migration.version}'`)
          .replaceAll(":'migration_checksum'", `'${migration.checksum}'`));
        await client.query("COMMIT");
        budget(setupStart);
      }
      const versions = (await client.query("SELECT version,checksum_sha256 FROM schema_versions ORDER BY version")).rows;
      assert.deepEqual(versions, migrations.map((m) => ({version: m.version, checksum_sha256: m.checksum})));
      for (let first = 1; first <= 100000; first += 5000) {
        await client.query(seedSql, [first, first + 4999]);
        budget(setupStart);
      }
      await client.query("ANALYZE polymarket_trades");
      if (variant === "candidate") await client.query(indexSql);
      const indexes = (await client.query(`SELECT c.relname,i.indisvalid,i.indisready,pg_get_indexdef(c.oid) AS definition
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
        WHERE i.indrelid='polymarket_trades'::regclass ORDER BY c.relname`)).rows;
      assert.equal(indexes.length, variant === "baseline" ? 6 : 7);
      assert.ok(indexes.every((index) => index.indisvalid && index.indisready));
      report.setup[variant] = { versions, indexes, guards: await guardCheck(), sizes: await sizes() };
    }
    for (const mode of ["autocommit", "explicit"]) {
      for (const kind of ["inserts", "conflicts"]) {
        for (const sourceName of ["data_api", "ws"]) {
          const scenarioStart = tick();
          const scenario = { mode, kind, source: sourceName, rounds: [], complete: false };
          report.scenarios.push(scenario);
          // Existing seed identities: fixed warmups never add measured rows.
          const seed = sourceName === "data_api" ? 1 : 4;
          for (const variant of ["baseline", "candidate"]) {
            await select(variant);
            const seedRow = (await client.query(`SELECT * FROM polymarket_trades WHERE transaction_hash=$1`, [`seed-tx-${seed}`])).rows[0];
            const common = [seedRow.token_id,seedRow.condition_id,seedRow.price,seedRow.size,seedRow.side];
            const params = sourceName === "data_api"
              ? [...common,seedRow.transaction_hash,seedRow.external_id,seedRow.trade_ts,seedRow.received_at]
              : [...common,seedRow.fee_rate_bps,seedRow.transaction_hash,seedRow.trade_ts,seedRow.received_at];
            // Seed lookup stays outside the timed production VALUES statement.
            for (let i = 0; i < 3; i++) await operation(sourceName, params, mode, 0);
          }
          for (let round = 0; round < 4; round++) {
            const result = { baseline: { samples: [], wal: {wal_bytes: 0, wal_records: 0, wal_fpi: 0} },
              candidate: { samples: [], wal: {wal_bytes: 0, wal_records: 0, wal_fpi: 0} } };
            scenario.rounds.push(result);
            for (let offset = 0; offset < ROUND; offset += BLOCK) {
              const order = (round + offset / BLOCK) % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
              for (const variant of order) {
                await select(variant);
                const before = await wal();
                for (let i = 0; i < BLOCK; i++) {
                  budget(scenarioStart);
                  const position = round * ROUND + offset + i;
                  result[variant].samples.push(await operation(sourceName,
                    fixture(sourceName, position, mode), mode, kind === "inserts" ? 1 : 0));
                }
                const after = await wal();
                for (const key of Object.keys(before)) {
                  assert.ok(after[key] >= before[key], "Backend WAL counters went backwards");
                  result[variant].wal[key] += after[key] - before[key];
                }
              }
            }
            for (const variant of ["baseline", "candidate"]) result[variant].summary = summary(result[variant].samples);
            result.comparison = compare(result.baseline.summary, result.candidate.summary);
          }
          scenario.aggregate = {};
          for (const variant of ["baseline", "candidate"]) {
            const samples = scenario.rounds.flatMap((round) => round[variant].samples);
            assert.equal(samples.length, ROWS);
            scenario.aggregate[variant] = { ...summary(samples),
              wal: Object.fromEntries(["wal_bytes", "wal_records", "wal_fpi"].map((key) => [key,
                scenario.rounds.reduce((total, round) => total + round[variant].wal[key], 0)])) };
          }
          scenario.comparison = compare(scenario.aggregate.baseline, scenario.aggregate.candidate);
          scenario.passed = scenario.comparison.passed && scenario.rounds.every((round) => round.comparison.passed);
          scenario.wallMs = elapsed(scenarioStart) / 1e6;
          budget(scenarioStart);
          scenario.complete = true;
          process.stderr.write(`${mode}/${kind}/${sourceName}: complete; gate=${scenario.passed}\n`);
        }
      }
    }
    report.after = {};
    for (const variant of ["baseline", "candidate"]) {
      await select(variant);
      const counts = (await client.query(`SELECT count(*)::int AS rows,count(DISTINCT condition_id)::int AS markets,
        count(*) FILTER (WHERE condition_id=$1)::int AS hot,
        count(*) FILTER (WHERE provenance='ws' AND external_id IS NOT NULL)::int AS wrong_ws
        FROM polymarket_trades`, [`0x${"0".repeat(64)}`])).rows[0];
      assert.deepEqual(counts, {rows: 110000,markets: 1000,hot: 55000,wrong_ws: 0});
      report.after[variant] = { counts, guards: await guardCheck(), sizes: await sizes() };
    }
    const equality = (await client.query(`SELECT NOT EXISTS(
      SELECT 1 FROM ${schemas.baseline}.polymarket_trades b
      FULL JOIN ${schemas.candidate}.polymarket_trades c USING (provenance,transaction_hash)
      WHERE b.trade_id IS NULL OR c.trade_id IS NULL OR
        (to_jsonb(b)-'trade_id') IS DISTINCT FROM (to_jsonb(c)-'trade_id')) AS equal`)).rows[0].equal;
    assert.equal(equality, true);
    report.persistedRowsEqual = equality;
    report.allGatesPassed = report.scenarios.every((scenario) => scenario.passed);
    report.completed = true;
  } catch (error) {
    report.error = { name: error.name, code: error.code ?? null, message: error.message };
    process.exitCode = 1;
  } finally {
    report.cleanedSchemas = [];
    report.cleanupErrors = [];
    try {
      if (connected) {
        try { await client.query("ROLLBACK"); }
        catch (error) { report.cleanupErrors.push({operation: "rollback", code: error.code ?? error.name}); }
        for (const schema of created) {
          try {
            await client.query(`DROP SCHEMA ${schema} CASCADE`);
            report.cleanedSchemas.push(schema);
          } catch (error) {
            report.cleanupErrors.push({operation: "drop own schema", schema, code: error.code ?? error.name});
          }
        }
      }
    } finally {
      try { await client.end(); }
      catch (error) { report.cleanupErrors.push({operation: "close", code: error.code ?? error.name}); }
      if (report.cleanupErrors.length) process.exitCode = 1;
      report.finishedAt = new Date().toISOString();
      report.wallMs = elapsed(start) / 1e6;
      process.stdout.write(JSON.stringify(report) + "\n");
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
