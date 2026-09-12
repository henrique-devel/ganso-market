// DB-03 preparation; DB-04 executes this fixed disposable write protocol once.
// GANSO_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:<port>/ganso_db03_write_disposable
// node docs/test-results/btc/db03-write-benchmark.mjs --execute > result.json
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { summary, compare, exitStatus } from "./db02-write-benchmark.mjs";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const tick = () => process.hrtime.bigint();
const elapsed = (started) => Number(tick() - started);
const INDEX = "polymarket_rtds_prices_asof_idx";
const BASE_MS = Date.parse("2026-09-12T02:30:00Z");
const TABLES = ["polymarket_rtds_prices", "polymarket_rtds_1m"];
const VARIANTS = ["baseline", "candidate"];

// Keep the deadline alive through cleanup, including a stalled client.end().
// The synchronous report precedes exit: no pg internals or extra SQL are needed.
export function installDeadlineWatchdog({report, ownSchemas, createdSchemas, elapsedMs,
  schedule = setTimeout, cancel = clearTimeout, nowIso = () => new Date().toISOString(),
  write = (text) => writeSync(1, text), terminate = (code) => process.exit(code)}) {
  let active = true;
  const timer = schedule(() => {
    if (!active) return;
    active = false;
    report.completed = false;
    report.promotionAllowed = false;
    report.finalBudgetExceeded = true;
    report.finishedAt = nowIso();
    report.wallMs = elapsedMs();
    report.deadlineError = {name: "Error", code: "DB03_GLOBAL_BUDGET_EXCEEDED",
      message: "Hard global deadline 600s reached including cleanup"};
    // Retain an earlier SQL/integrity error as well as the deadline failure.
    report.error ??= report.deadlineError;
    report.cleanedSchemas ??= [];
    report.cleanupErrors ??= [];
    report.cleanupErrors.push({operation: "hard deadline cleanup incomplete",
      code: report.deadlineError.code, createdSchemas: [...createdSchemas],
      possibleRemainingOwnSchemas: ownSchemas.filter((schema) => !report.cleanedSchemas.includes(schema)),
      message: "Rollback, own-schema cleanup and connection closure were not all verified; inspect/remove the verified disposable container"});
    try { write(JSON.stringify(report) + "\n"); }
    finally { terminate(1); }
  }, Math.max(0, 600000 - elapsedMs()));
  return () => { active = false; cancel(timer); };
}

export function validateTarget(rawUrl) {
  assert.ok(typeof rawUrl === "string", "Disposable database URL required");
  let url;
  try { url = new URL(rawUrl); }
  catch { throw new Error("Invalid disposable connection URL"); }
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol), "PostgreSQL protocol required");
  assert.ok(url.hostname === "127.0.0.1", "Disposable 127.0.0.1 only");
  assert.ok(url.username === "postgres", "Disposable postgres user required");
  assert.ok(url.pathname === "/ganso_db03_write_disposable", "Exact disposable database required");
  assert.ok(/^\d+$/.test(url.port) && Number(url.port) >= 1024 && Number(url.port) <= 65535,
    "Explicit unprivileged disposable port required");
  assert.ok(url.search === "", "Connection override parameters are forbidden");
  assert.ok(url.hash === "", "Connection URL fragments are forbidden");
  return url;
}

export function assertServerIdentity(row) {
  assert.equal(row.current_database, "ganso_db03_write_disposable");
  assert.equal(row.version_num, "180004", "Protocol requires PostgreSQL 18.4");
  for (const key of ["fsync", "full_page_writes", "synchronous_commit"]) assert.equal(row[key], "on", key);
}

export function assertGuardRows(rows) {
  assert.deepEqual(rows.map((row) => row.tgname),
    ["retention_evidence_delete_guard_trg", "retention_evidence_write_lock_trg"]);
  assert.ok(rows.every((row) => row.tgenabled === "O"), "HOLD/write guards must stay enabled");
  assert.match(rows[0].definition, /BEFORE DELETE OR TRUNCATE/);
  assert.match(rows[0].definition, /retention_evidence_delete_guard\(\)/);
  assert.match(rows[1].definition, /BEFORE INSERT OR UPDATE/);
  assert.match(rows[1].definition, /retention_evidence_writer_lock\(\)/);
}

export function extractWriterSql(source, batchRows = 2) {
  assert.ok(Number.isSafeInteger(batchRows) && batchRows > 0 && batchRows <= 5000);
  const start = source.indexOf("async function doFlush()");
  const end = source.indexOf("function flushNow()", start);
  assert.ok(start >= 0 && end > start, "RTDS flush writer not found");
  const writer = source.slice(start, end);
  const raw = writer.match(/`(INSERT INTO polymarket_rtds_prices[\s\S]*?)`/)?.[1];
  const aggregate = writer.match(/`(INSERT INTO polymarket_rtds_1m[\s\S]*?)`/)?.[1];
  assert.ok(raw && aggregate, "Both RTDS production statements required");
  assert.equal(raw.replace(/\s+/g, " ").trim(),
    'INSERT INTO polymarket_rtds_prices (feed, symbol, price, source_ts, received_at, ingest_lag_ms) VALUES ${tuples.join(",")}');
  assert.equal(aggregate.replace(/\s+/g, " ").trim(),
    "INSERT INTO polymarket_rtds_1m (feed, symbol, bucket_start, open, high, low, close, samples) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (feed, symbol, bucket_start) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close, samples = EXCLUDED.samples, received_at = CURRENT_TIMESTAMP");
  const tuples = Array.from({length: batchRows}, (_, row) =>
    `(${Array.from({length: 6}, (_, col) => `$${row * 6 + col + 1}`).join(",")})`);
  return { raw: raw.replace('${tuples.join(",")}', tuples.join(",")), aggregate };
}

// Zero-based row position. Seed occupies 0..119999; measured inserts 120000..129999.
export function rawValues(position, count = 2) {
  assert.ok(Number.isSafeInteger(position) && position >= 0 && position + count <= 140000);
  assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 5000);
  return Array.from({length: count}, (_, offset) => {
    const g = position + offset + 1;
    const ordinal = Math.floor((g - 1) / 4) + 1;
    const btc = (g - 1) % 4 < 2;
    const sourceMs = g % 101 === 0 ? null : g % 997 === 0 ? BASE_MS + 60000
      : BASE_MS + (Math.floor((ordinal - 1) / 5) * 5 + 1 - 30000) * 1000;
    const receivedMs = g % 251 === 0 ? BASE_MS + 120000
      : BASE_MS + (ordinal - 30000) * 1000 + (g % 3) * 100;
    return [g % 2 === 1 ? "twap30" : "twap60", btc ? "btc/usd" : "eth/usd",
      `${btc ? "64000" : "2400"}.${String(g).padStart(6, "0")}`,
      sourceMs === null ? null : new Date(sourceMs), new Date(receivedMs),
      sourceMs === null ? null : Math.round(receivedMs - sourceMs)];
  }).flat();
}

export function aggregateValues(position) {
  assert.ok(Number.isSafeInteger(position) && position >= 0 && position < 1000);
  const g = position + 1;
  return [g % 2 === 1 ? "twap30" : "twap60", (g - 1) % 4 < 2 ? "btc/usd" : "eth/usd",
    new Date(BASE_MS - (Math.floor((g - 1) / 4) + 1) * 60000),
    "64000.000001", "64000.000009", "63999.999999", "64000.000008", 120];
}

// Historical read-fixture distribution, used only for setup; no as-of query runs here.
const seedSql = `INSERT INTO polymarket_rtds_prices
 (feed,symbol,price,source_ts,received_at,ingest_lag_ms)
 SELECT CASE WHEN g%2=1 THEN 'twap30' ELSE 'twap60' END,
 CASE WHEN (g-1)%4<2 THEN 'btc/usd' ELSE 'eth/usd' END,
 CASE WHEN (g-1)%4<2 THEN '64000.' ELSE '2400.' END || lpad(g::text,6,'0'),
 CASE WHEN g%101=0 THEN NULL WHEN g%997=0 THEN TIMESTAMPTZ '2026-09-12 02:31Z'
 ELSE TIMESTAMPTZ '2026-09-12 02:30Z'+(((ordinal-1)/5)*5+1-30000)*INTERVAL '1 second' END,
 CASE WHEN g%251=0 THEN TIMESTAMPTZ '2026-09-12 02:32Z'
 ELSE TIMESTAMPTZ '2026-09-12 02:30Z'+(ordinal-30000)*INTERVAL '1 second'+(g%3)*INTERVAL '100 milliseconds' END,
 CASE WHEN g%101=0 THEN NULL ELSE g%31 END
 FROM (SELECT g,((g-1)/4)+1 AS ordinal FROM generate_series($1::integer,$2::integer) g) fixture ORDER BY g`;
const aggregateSeedSql = `INSERT INTO polymarket_rtds_1m
 (feed,symbol,bucket_start,open,high,low,close,samples,received_at)
 SELECT CASE WHEN g%2=1 THEN 'twap30' ELSE 'twap60' END,
 CASE WHEN (g-1)%4<2 THEN 'btc/usd' ELSE 'eth/usd' END,
 TIMESTAMPTZ '2026-09-12 02:30Z'-(((g-1)/4)+1)*INTERVAL '1 minute',
 '64000.000001','64000.000009','63999.999999','64000.000002',60,TIMESTAMPTZ '2026-09-12 02:31Z'
 FROM generate_series(1,1000) g`;
const deleteControlSql = `DELETE FROM polymarket_rtds_prices WHERE rtds_price_id IN
 (SELECT rtds_price_id FROM polymarket_rtds_prices WHERE received_at < TIMESTAMPTZ '2026-09-12 00:00Z'
 ORDER BY received_at,rtds_price_id LIMIT 1000)`;

async function run() {
  const started = tick();
  const prefix = `db03w_${randomUUID().replaceAll("-", "")}`;
  const schemas = {baseline: `${prefix}_b`, candidate: `${prefix}_c`};
  const created = [];
  let client;
  let connected = false;
  const report = {block: "DB-03", executorBlock: "DB-04", protocol: "write-preparation-v1",
    startedAt: new Date().toISOString(), completed: false, promotionAllowed: false,
    method: {connections: 1, statementTimeoutMs: 5000, lockTimeoutMs: 500,
      connectionTimeoutMs: 5000, idleTransactionTimeoutMs: 5000, scenarioBudgetSeconds: 120,
      globalBudgetSeconds: 600, rounds: 4, rawBatchRows: 2, rawOperationsPerRound: 625, rawBlock: 125,
      aggregateOperationsPerRound: 125, aggregateBlock: 25, warmups: 3,
      seedRawRowsPerVariant: 120000, seedAggregatesPerVariant: 1000,
      measuredRawRowsPerVariant: 10000, measuredAggregateUpsertsPerVariant: 1000,
      rawBatches: "5000 rows/autocommit + 5000 rows/explicit COMMIT diagnostic; two VALUES rows per operation",
      batchRationale: "Fixed batch of two from DB-01 approximate 1.9 rows/s and 1s flush; not a measured production batch distribution",
      aggregates: "500 individual autocommit + 500 individual explicit diagnostic; exact runtime SQL and CURRENT_TIMESTAMP",
      seedIngestLag: "Historical g%31 seed retained; measured binds derive received-source as the current writer does",
      warmup: "Three fixed BEGIN/production VALUES or upsert/ROLLBACK operations per variant/scenario, outside timing and WAL windows; identities may advance equally",
      samples: "[full operation nanoseconds, explicit COMMIT nanoseconds or null]",
      wal: "Own PostgreSQL 18 backend counters; forced statistics flush outside timed statements; includes COMMIT, sequence and write guard",
      gate: "Every metric <=10%, aggregate AND every round; no epsilon, outlier removal or completed-run retry",
      deletion: "One bounded DELETE control per variant must fail 55000/DATA02_EVIDENCE_HOLD; zero deleted rows; deletion throughput remains unmeasured",
      vacuum: "Only after all write measurements, own two fixture schemas, outside measurement/WAL windows",
      resourceLimits: "DB-04 must capture dedicated Docker 1 CPU/1 GiB/max_connections 10 identity and cgroup before/after; runner does not infer host exclusivity",
      limitations: "Synthetic fixture, single connection, no as-of read measurement, production query, collector cadence, concurrency, retention throughput, capacity or soak evidence"},
    setup: {}, scenarios: [], after: {}, cleanupErrors: []};
  const stopDeadlineWatchdog = installDeadlineWatchdog({report,
    ownSchemas: Object.values(schemas), createdSchemas: created,
    elapsedMs: () => elapsed(started) / 1e6});
  function budget(scenarioStart = started) {
    assert.ok(elapsed(started) <= 600e9, "Global budget 600s exceeded");
    assert.ok(elapsed(scenarioStart) <= 120e9, "Scenario budget 120s exceeded");
  }
  const select = (variant) => client.query(`SET search_path TO ${schemas[variant]}, pg_catalog`);
  async function wal() {
    await client.query("SELECT pg_catalog.pg_stat_force_next_flush()");
    const row = (await client.query("SELECT * FROM pg_catalog.pg_stat_get_backend_wal(pg_backend_pid())")).rows[0];
    assert.ok(row && row.wal_bytes !== null, "Backend WAL unavailable");
    return Object.fromEntries(["wal_bytes", "wal_records", "wal_fpi"].map((key) => {
      const value = Number(row[key]);
      assert.ok(Number.isSafeInteger(value) && value >= 0, "Backend WAL counter is not a safe integer");
      return [key, value];
    }));
  }
  async function guardCheck() {
    assert.equal((await client.query("SELECT retention_evidence_policy_version() AS policy")).rows[0].policy, "data-02-v1");
    const guards = {};
    for (const table of TABLES) {
      const rows = (await client.query(`SELECT tgname,tgenabled,pg_get_triggerdef(oid) AS definition
        FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal ORDER BY tgname`, [table])).rows;
      assertGuardRows(rows);
      guards[table] = rows;
    }
    return guards;
  }
  async function sizes() {
    return (await client.query(`SELECT pg_relation_size('polymarket_rtds_prices')::text AS raw_heap_bytes,
      pg_indexes_size('polymarket_rtds_prices')::text AS raw_index_bytes,
      COALESCE(pg_relation_size(to_regclass($1)),0)::text AS candidate_bytes,
      pg_relation_size('polymarket_rtds_1m')::text AS aggregate_heap_bytes,
      pg_indexes_size('polymarket_rtds_1m')::text AS aggregate_index_bytes`, [INDEX])).rows[0];
  }
  async function counts() {
    return (await client.query(`SELECT (SELECT count(*)::int FROM polymarket_rtds_prices) raw_rows,
      (SELECT count(*)::int FROM polymarket_rtds_1m) aggregate_rows`)).rows[0];
  }
  async function operation(sql, params, mode, expected) {
    const begun = tick();
    if (mode === "explicit") await client.query("BEGIN");
    const result = await client.query(sql, params);
    let commitNs = null;
    if (mode === "explicit") {
      const commit = tick();
      await client.query("COMMIT");
      commitNs = elapsed(commit);
    }
    const fullNs = elapsed(begun);
    assert.equal(result.rowCount, expected, "Unexpected persisted operation count");
    return [fullNs, commitNs];
  }
  try {
    assert.deepEqual(process.argv.slice(2), ["--execute"], "Choose explicit --execute; importing performs no database action");
    const url = validateTarget(process.env.GANSO_TEST_DATABASE_URL);
    report.target = {host: url.hostname, port: Number(url.port), database: url.pathname.slice(1), user: url.username};
    const [source, indexSql, protocol, methodology] = await Promise.all([
      read("apps/api/src/polymarket/rtds.ts"), read("docs/ops/sql/db03-rtds-asof-index.sql"),
      read("docs/test-results/btc/DB-03-write-preparation.md"), read("docs/test-results/btc/db02-write-benchmark.mjs")]);
    const sql = extractWriterSql(source);
    report.hashes = {source: hash(source), index: hash(indexSql), protocol: hash(protocol),
      methodology: hash(methodology), harness: hash(await readFile(new URL(import.meta.url), "utf8"))};
    report.sql = {...sql, seedSql, aggregateSeedSql, deleteControlSql, indexSql};
    const names = (await readdir(new URL("migrations/", root))).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
    assert.deepEqual(names.map((name) => Number(name.slice(0, 4))), Array.from({length: 23}, (_, i) => i + 1),
      "Schema changed: review this write protocol before running");
    const migrations = await Promise.all(names.map(async (name) => {
      const text = await read(`migrations/${name}`);
      return {name, version: Number(name.slice(0, 4)), checksum: hash(text), text};
    }));
    report.migrations = migrations.map(({text: _text, ...meta}) => meta);
    client = new pg.Client({connectionString: url.href, application_name: "db03_write_disposable",
      statement_timeout: 5000, connectionTimeoutMillis: 5000,
      options: "-c lock_timeout=500 -c idle_in_transaction_session_timeout=5000"});
    await client.connect();
    connected = true;
    await client.query("SET TIME ZONE 'UTC'");
    report.server = (await client.query(`SELECT version(), current_database(), pg_backend_pid() pid,
      inet_server_addr() server_address, inet_server_port() server_port,
      current_setting('server_version_num') version_num, current_setting('fsync') fsync,
      current_setting('full_page_writes') full_page_writes, current_setting('synchronous_commit') synchronous_commit,
      current_setting('shared_buffers') shared_buffers, current_setting('work_mem') work_mem,
      current_setting('max_connections') max_connections, current_setting('statement_timeout') statement_timeout,
      current_setting('lock_timeout') lock_timeout, current_setting('idle_in_transaction_session_timeout') idle_transaction_timeout`)).rows[0];
    assertServerIdentity(report.server);
    assert.equal(report.server.max_connections, "10");
    assert.equal(report.server.statement_timeout, "5s");
    assert.equal(report.server.lock_timeout, "500ms");
    assert.equal(report.server.idle_transaction_timeout, "5s");
    assert.equal((await client.query("SELECT count(*)::int n FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()")).rows[0].n, 0);
    report.server.preexistingUserTables = (await client.query(`SELECT count(*)::int n FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog','information_schema')`)).rows[0].n;
    assert.equal(report.server.preexistingUserTables, 0, "Fresh disposable database must contain no user tables in any schema");
    for (const variant of VARIANTS) {
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
      for (let first = 1; first <= 120000; first += 5000) {
        await client.query(seedSql, [first, first + 4999]);
        budget(setupStart);
      }
      await client.query(aggregateSeedSql);
      for (const table of TABLES) await client.query(`ANALYZE ${table}`);
      if (variant === "candidate") await client.query(indexSql); // Disposable fixture only, outside a transaction.
      const indexes = (await client.query(`SELECT c.relname,am.amname,i.indisvalid,i.indisready,i.indislive,
        i.indisunique,pg_get_indexdef(c.oid) definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
        JOIN pg_am am ON am.oid=c.relam WHERE i.indrelid='polymarket_rtds_prices'::regclass ORDER BY c.relname`)).rows;
      assert.equal(indexes.length, variant === "baseline" ? 3 : 4);
      assert.ok(indexes.every((index) => index.indisvalid && index.indisready && index.indislive));
      const candidate = indexes.find((index) => index.relname === INDEX);
      if (variant === "candidate") {
        assert.equal(candidate?.amname, "btree");
        assert.equal(candidate?.indisunique, false);
        assert.match(candidate.definition,
          /USING btree \(feed, symbol, COALESCE\(source_ts, received_at\) DESC, rtds_price_id DESC\)$/);
      } else assert.equal(candidate, undefined);
      assert.deepEqual(await counts(), {raw_rows: 120000, aggregate_rows: 1000});
      report.setup[variant] = {schema: schemas[variant], versions, indexes, guards: await guardCheck(), sizes: await sizes()};
      budget(setupStart);
    }
    const aggregateWindows = {baseline: [], candidate: []};
    for (const kind of ["rawInserts", "aggregateUpserts"]) {
      for (const [modeIndex, mode] of ["autocommit", "explicit"].entries()) {
        const scenarioStart = tick();
        const isRaw = kind === "rawInserts";
        const roundSize = isRaw ? 625 : 125;
        const blockSize = isRaw ? 125 : 25;
        const statement = isRaw ? sql.raw : sql.aggregate;
        const scenario = {kind, mode, rounds: [], complete: false, serverWindows: {}};
        report.scenarios.push(scenario);
        for (const variant of VARIANTS) {
          await select(variant);
          for (let warmup = 0; warmup < 3; warmup++) {
            await client.query("BEGIN");
            const result = await client.query(statement, isRaw ? rawValues(130000, 2) : aggregateValues(999));
            assert.equal(result.rowCount, isRaw ? 2 : 1);
            await client.query("ROLLBACK");
            budget(scenarioStart);
          }
          if (!isRaw) scenario.serverWindows[variant] = {
            start: (await client.query("SELECT clock_timestamp()::text now")).rows[0].now};
        }
        for (let round = 0; round < 4; round++) {
          const result = Object.fromEntries(VARIANTS.map((variant) => [variant,
            {samples: [], wal: {wal_bytes: 0, wal_records: 0, wal_fpi: 0}}]));
          scenario.rounds.push(result);
          for (let offset = 0; offset < roundSize; offset += blockSize) {
            const order = (round + offset / blockSize) % 2 === 0 ? VARIANTS : [...VARIANTS].reverse();
            for (const variant of order) {
              await select(variant);
              const before = await wal();
              for (let i = 0; i < blockSize; i++) {
                budget(scenarioStart);
                const position = round * roundSize + offset + i;
                const params = isRaw ? rawValues(120000 + modeIndex * 5000 + position * 2, 2)
                  : aggregateValues(modeIndex * 500 + position);
                result[variant].samples.push(await operation(statement, params, mode, isRaw ? 2 : 1));
              }
              const after = await wal();
              for (const key of Object.keys(before)) {
                assert.ok(after[key] >= before[key], "Backend WAL counters went backwards");
                result[variant].wal[key] += after[key] - before[key];
              }
            }
          }
          for (const variant of VARIANTS) result[variant].summary = summary(result[variant].samples);
          result.comparison = compare(result.baseline.summary, result.candidate.summary);
        }
        scenario.aggregate = {};
        for (const variant of VARIANTS) {
          const samples = scenario.rounds.flatMap((round) => round[variant].samples);
          assert.equal(samples.length, roundSize * 4);
          scenario.aggregate[variant] = {...summary(samples), rows: samples.length * (isRaw ? 2 : 1),
            wal: Object.fromEntries(["wal_bytes", "wal_records", "wal_fpi"].map((key) => [key,
              scenario.rounds.reduce((total, round) => total + round[variant].wal[key], 0)]))};
          if (!isRaw) {
            scenario.serverWindows[variant].end = (await client.query("SELECT clock_timestamp()::text now")).rows[0].now;
            aggregateWindows[variant].push(scenario.serverWindows[variant]);
          }
        }
        scenario.comparison = compare(scenario.aggregate.baseline, scenario.aggregate.candidate);
        scenario.walAdditionalBytes = scenario.aggregate.candidate.wal.wal_bytes - scenario.aggregate.baseline.wal.wal_bytes;
        scenario.passed = scenario.comparison.passed && scenario.rounds.every((round) => round.comparison.passed);
        scenario.wallMs = elapsed(scenarioStart) / 1e6;
        budget(scenarioStart);
        scenario.complete = true;
        process.stderr.write(`${kind}/${mode}: complete; gate=${scenario.passed}\n`);
      }
    }
    for (const variant of VARIANTS) {
      await select(variant);
      assert.deepEqual(await counts(), {raw_rows: 130000, aggregate_rows: 1000});
      const windows = aggregateWindows[variant];
      const receivedWindow = {start: windows[0].start, end: windows.at(-1).end};
      const aggregates = (await client.query(`SELECT count(*)::int n,
        count(*) FILTER (WHERE samples=120 AND close='64000.000008')::int updated,
        count(*) FILTER (WHERE received_at >= $1::timestamptz AND received_at <= $2::timestamptz)::int received_in_window
        FROM polymarket_rtds_1m`, [receivedWindow.start, receivedWindow.end])).rows[0];
      assert.deepEqual(aggregates, {n: 1000, updated: 1000, received_in_window: 1000});
      report.after[variant] = {counts: await counts(), sizes: await sizes(), guards: await guardCheck(), aggregates, receivedWindow};
    }
    const rawEqual = (await client.query(`SELECT NOT EXISTS(SELECT 1
      FROM ${schemas.baseline}.polymarket_rtds_prices b FULL JOIN ${schemas.candidate}.polymarket_rtds_prices c USING (rtds_price_id)
      WHERE convert_to(to_jsonb(b)::text,'UTF8') IS DISTINCT FROM convert_to(to_jsonb(c)::text,'UTF8')) equal`)).rows[0].equal;
    const aggregateEqual = (await client.query(`SELECT NOT EXISTS(SELECT 1
      FROM ${schemas.baseline}.polymarket_rtds_1m b FULL JOIN ${schemas.candidate}.polymarket_rtds_1m c USING (feed,symbol,bucket_start)
      WHERE convert_to((to_jsonb(b)-'received_at')::text,'UTF8') IS DISTINCT FROM
            convert_to((to_jsonb(c)-'received_at')::text,'UTF8')) equal`)).rows[0].equal;
    assert.equal(rawEqual, true);
    assert.equal(aggregateEqual, true);
    report.persistedEquality = {rawAllColumns: rawEqual, aggregatesExceptServerReceivedAt: aggregateEqual,
      receivedAt: "Each schema verified against its measured server clock window; runtime CURRENT_TIMESTAMP retained"};
    report.deleteControl = {};
    for (const variant of VARIANTS) {
      await select(variant);
      const before = await counts();
      const control = {sql: deleteControlSql, before, maximumTargetRows: 1000};
      report.deleteControl[variant] = control;
      let refusal;
      try { control.unexpectedSuccessRowCount = (await client.query(deleteControlSql)).rowCount; }
      catch (error) {
        control.observedError = {code: error.code ?? null, message: error.message};
        assert.equal(error.code, "55000", "Unexpected DELETE control error");
        assert.match(error.message, /^DATA02_EVIDENCE_HOLD: polymarket_rtds_prices DELETE$/);
        refusal = {code: error.code, message: error.message};
      }
      const after = await counts();
      Object.assign(control, {refusal, after, deletedRows: before.raw_rows - after.raw_rows});
      assert.ok(refusal, "HOLD failed to refuse bounded DELETE");
      assert.deepEqual(after, before, "DELETE control lost rows");
    }
    report.deletionThroughputGate = null;
    report.vacuum = {};
    for (const variant of VARIANTS) {
      await select(variant);
      const vacuumStart = tick();
      await client.query("VACUUM (ANALYZE) polymarket_rtds_prices");
      await client.query("VACUUM (ANALYZE) polymarket_rtds_1m");
      report.vacuum[variant] = {wallMs: elapsed(vacuumStart) / 1e6, sizes: await sizes(), guards: await guardCheck()};
      budget(vacuumStart);
    }
    report.measuredWritesGate = report.scenarios.every((scenario) => scenario.passed);
    report.allGatesPassed = report.measuredWritesGate; // Exit success concerns this measurement, never promotion.
    assert.ok(elapsed(started) <= 600e9, "Global budget 600s exceeded after integrity verification");
    report.completed = true;
  } catch (error) {
    report.error = {name: error.name, code: error.code ?? null, message: error.message};
  } finally {
    report.cleanedSchemas = [];
    if (connected) {
      try { await client.query("ROLLBACK"); }
      catch (error) { report.cleanupErrors.push({operation: "rollback", code: error.code ?? error.name}); }
      for (const schema of created) {
        try {
          await client.query(`DROP SCHEMA ${schema} CASCADE`);
          report.cleanedSchemas.push(schema);
        } catch (error) { report.cleanupErrors.push({operation: "drop own schema", schema, code: error.code ?? error.name}); }
      }
    }
    if (client) {
      try { await client.end(); }
      catch (error) { report.cleanupErrors.push({operation: "close", code: error.code ?? error.name}); }
    }
    report.finishedAt = new Date().toISOString();
    report.wallMs = elapsed(started) / 1e6;
    if (report.wallMs > 600000) {
      report.finalBudgetExceeded = true;
      report.error ??= {name: "Error", code: "DB03_GLOBAL_BUDGET_EXCEEDED",
        message: "Global budget 600s exceeded including cleanup"};
      report.completed = false;
    }
    stopDeadlineWatchdog();
    process.exitCode = exitStatus(report);
    process.stdout.write(JSON.stringify(report) + "\n");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
