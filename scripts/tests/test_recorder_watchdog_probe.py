"""Run the actual OPS-06 JavaScript probe in separate Node processes.

The suite builds the current API sources once (npm dependencies required). Real pg exercises
refused and silent local TCP connections. A narrow pg fixture exercises successful
read-only SQL and a wedged client; config/secret loading and the probe remain real.
Nothing invokes Docker or reaches any database/server outside loopback.
"""

from __future__ import annotations

import importlib.util
import json
import os
import selectors
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CONFIG = REPO / "apps/api/dist/config.js"
RECORDER = REPO / "apps/api/dist/polymarket-recorder.js"
SPEC = importlib.util.spec_from_file_location(
    "recorder_watchdog_probe_subject", REPO / "deploy/recorder_watchdog.py"
)
assert SPEC is not None and SPEC.loader is not None
WATCHDOG = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WATCHDOG)
SECRET = "FIXTURE_PASSWORD_MUST_NEVER_APPEAR_IN_OUTPUT"
SHA = "a" * 40

PG_FIXTURE = r"""
import assert from 'node:assert/strict';
import fs from 'node:fs';
const mode = process.env.PROBE_TEST_MODE;
const queries = [];
class Client {
  constructor(options) {
    assert.equal(options.host, '127.0.0.1');
    assert.equal(options.database, 'watchdog_test');
    assert.equal(options.user, 'watchdog_test');
    assert.equal(options.password, process.env.PROBE_TEST_SECRET);
    assert.equal(options.connectionTimeoutMillis, 1000);
    assert.equal(options.query_timeout, 1500);
    assert.equal(options.statement_timeout, 1000);
    assert.equal(options.application_name, 'ganso-recorder-watchdog');
    assert.equal(options.options,
      '-c default_transaction_read_only=on -c lock_timeout=500 ' +
      '-c idle_in_transaction_session_timeout=2000');
  }
  on(event, listener) {
    assert.equal(event, 'error');
    assert.equal(typeof listener, 'function');
  }
  async connect() {
    if (mode === 'hang') await new Promise(() => {});
  }
  async query(sql) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    queries.push(normalized);
    fs.writeFileSync(process.env.PROBE_TEST_QUERIES, JSON.stringify(queries));
    if (queries.length === 1) {
      assert.equal(normalized, 'SELECT 1');
      return { rows: [{ '?column?': 1 }] };
    }
    assert.equal(queries.length, 2);
    assert.equal(normalized,
      'SELECT (SELECT received_at FROM polymarket_book_snapshots_full ' +
      'ORDER BY received_at DESC LIMIT 1) AS clob, ' +
      '(SELECT received_at FROM polymarket_rtds_prices ' +
      'ORDER BY received_at DESC LIMIT 1) AS rtds');
    if (mode === 'read_failure') throw new Error(process.env.PROBE_TEST_SECRET);
    return { rows: [{
      clob: new Date('2026-09-11T12:00:00Z'),
      rtds: new Date('2026-09-11T12:00:01Z'),
    }] };
  }
  async end() {}
}
export default { Client };
"""


class RecorderWatchdogProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node = shutil.which("node")
        npm = shutil.which("npm")
        if cls.node is None or npm is None:
            raise RuntimeError("Node/npm and installed API dependencies are required")
        # make verify runs tests before build; never depend on stale/untracked dist.
        built = subprocess.run(
            [npm, "run", "build", "--workspace", "@ganso-market/api"],
            cwd=REPO,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if built.returncode or not CONFIG.is_file() or not RECORDER.is_file():
            raise RuntimeError("API test build failed: " + built.stdout + built.stderr)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ganso-probe-test-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.heartbeat = self.directory / "heartbeat.json"
        self.release = self.directory / "release-sha"
        self.config = self.directory / "runtime.json"
        self.password = self.directory / "password"
        self.queries = self.directory / "queries.json"
        self.release.write_text(SHA + "\n")
        self.password.write_text(SECRET + "\n")
        self.password.chmod(0o600)
        self.heartbeat.write_text(
            json.dumps(
                {
                    "version": 1,
                    "pid": os.getpid(),
                    "seq": 11,
                    "timestamp": "2026-09-11T12:00:00.000Z",
                    "uptime_ms": 1000,
                    "phase": "running",
                }
            )
        )

    def configure(self, port):
        self.config.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "execution_mode": "paper",
                    "database": {
                        "host": "127.0.0.1",
                        "port": port,
                        "name": "watchdog_test",
                        "user": "watchdog_test",
                        "connect_timeout_ms": 1000,
                    },
                }
            )
        )

    def source(self, fixture=False):
        source = (
            WATCHDOG.PROBE_JS.replace(
                "'/workspace/apps/api/dist/config.js'", json.dumps(CONFIG.as_uri())
            )
            .replace("'/tmp/ganso-recorder-heartbeat.json'", json.dumps(str(self.heartbeat)))
            .replace("'/etc/ganso/release-sha'", json.dumps(str(self.release)))
        )
        if fixture:
            module = self.directory / "pg-fixture.mjs"
            module.write_text(PG_FIXTURE)
            source = source.replace("from 'pg'", "from " + json.dumps(module.as_uri()))
        return source

    def probe(self, mode=None):
        environment = {
            "PATH": os.environ.get("PATH", os.defpath),
            "GANSO_CONFIG_FILE": str(self.config),
            "GANSO_POSTGRES_PASSWORD_FILE": str(self.password),
            "PROBE_TEST_MODE": mode or "",
            "PROBE_TEST_SECRET": SECRET,
            "PROBE_TEST_QUERIES": str(self.queries),
        }
        started = time.monotonic()
        result = subprocess.run(
            [
                self.node,
                "--max-old-space-size=32",
                "--input-type=module",
                "-e",
                self.source(fixture=mode is not None),
            ],
            cwd=REPO,
            env=environment,
            capture_output=True,
            text=True,
            timeout=8,
        )
        elapsed = time.monotonic() - started
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        self.assertNotIn(str(self.password), result.stdout + result.stderr)
        self.assertEqual(len(result.stdout.splitlines()), 1)
        self.assertLess(len(result.stdout), 2048)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["version"], 1)
        self.assertEqual(payload["sha"], SHA)
        self.assertEqual(payload["heartbeat"], json.loads(self.heartbeat.read_text()))
        return payload, elapsed

    def unavailable_port(self):
        # Keep the bound port reserved but never listen: deterministic refusal.
        reserved = socket.socket()
        self.addCleanup(reserved.close)
        reserved.bind(("127.0.0.1", 0))
        self.configure(reserved.getsockname()[1])

    def test_real_pg_reports_refused_connection_without_leaking_secrets(self):
        self.unavailable_port()
        payload, elapsed = self.probe()
        self.assertEqual(payload["db"], "unavailable")
        self.assertLess(elapsed, 8)

    def test_real_pg_times_out_when_tcp_accepts_but_never_answers(self):
        server = socket.socket()
        self.addCleanup(server.close)
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        server.settimeout(3)
        self.configure(server.getsockname()[1])
        received_startup = threading.Event()
        stop = threading.Event()

        def accept_silently():
            try:
                connection, _ = server.accept()
                with connection:
                    connection.settimeout(3)
                    if connection.recv(4096):
                        received_startup.set()
                    stop.wait(8)
            except OSError:
                pass

        thread = threading.Thread(target=accept_silently, daemon=True)
        thread.start()
        try:
            payload, elapsed = self.probe()
            self.assertTrue(received_startup.is_set(), "pg must reach the silent TCP peer")
            self.assertEqual(payload["db"], "unavailable")
            self.assertLess(elapsed, 8)
        finally:
            stop.set()
            thread.join(timeout=4)

    def test_busy_recorder_loop_cannot_block_the_separate_probe(self):
        self.unavailable_port()
        source = (
            "import { createRecorderHeartbeat } from " + json.dumps(RECORDER.as_uri()) + ";\n"
            # Accelerate only this child's timer; the real publisher is used.
            "const schedule = globalThis.setInterval;\n"
            "globalThis.setInterval = (callback) => schedule(callback, 25);\n"
            "const heartbeat = createRecorderHeartbeat(" + json.dumps(str(self.heartbeat)) + ");\n"
            "heartbeat.markRunning();\n"
            "process.stdout.write('ready\\n');\n"
            "while (true) {}\n"
        )
        emitter = subprocess.Popen(
            [self.node, "--input-type=module", "-e", source],
            cwd=REPO,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(emitter.stdout, selectors.EVENT_READ)
                self.assertTrue(selector.select(3), "heartbeat child did not become ready")
            self.assertEqual(emitter.stdout.readline(), b"ready\n")
            before = json.loads(self.heartbeat.read_text())
            self.assertEqual(before["pid"], emitter.pid)
            self.assertEqual(before["phase"], "running")
            time.sleep(0.15)  # Six accelerated heartbeat opportunities are blocked.
            payload, elapsed = self.probe()
            self.assertIsNone(emitter.poll(), "busy recorder must remain Up")
            self.assertEqual(payload["heartbeat"], before)
            self.assertEqual(payload["db"], "unavailable")
            self.assertLess(elapsed, 8)
        finally:
            emitter.kill()
            _, stderr = emitter.communicate(timeout=3)
            self.assertEqual(stderr, b"")

    def test_successful_probe_uses_bounded_read_only_queries(self):
        self.configure(5432)  # Fixture never opens a connection.
        payload, _ = self.probe(mode="happy")
        self.assertEqual(payload["db"], "ok")
        self.assertEqual(
            payload["persistence"],
            {
                "clob": "2026-09-11T12:00:00.000Z",
                "rtds": "2026-09-11T12:00:01.000Z",
            },
        )
        queries = json.loads(self.queries.read_text())
        self.assertEqual(queries[0], "SELECT 1")
        self.assertEqual(len(queries), 2)
        self.assertEqual(queries[1].count("LIMIT 1"), 2)
        self.assertNotIn("COUNT(", queries[1])

    def test_persistence_failure_is_distinct_and_never_logs_raw_error(self):
        self.configure(5432)
        payload, _ = self.probe(mode="read_failure")
        self.assertEqual(payload["db"], "ok")
        self.assertIsNone(payload["persistence"])
        self.assertEqual(len(json.loads(self.queries.read_text())), 2)

    def test_internal_deadline_finishes_even_if_client_connect_never_settles(self):
        self.configure(5432)
        payload, elapsed = self.probe(mode="hang")
        self.assertEqual(payload["db"], "unavailable")
        self.assertGreaterEqual(elapsed, 6)
        self.assertLess(elapsed, 8)


if __name__ == "__main__":
    unittest.main()
