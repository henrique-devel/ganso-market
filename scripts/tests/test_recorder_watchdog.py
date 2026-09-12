"""OPS-06 host supervisor, exercised in separate processes without Docker/DB.

An executable fixture speaks the limited Docker CLI protocol. All decisions,
flock, subprocess deadlines, pre-restart evidence and durable rate limits are
the production helper. Only headroom is supplied by the isolated driver so
these tests also run on macOS; low headroom has its own refusal test.
"""

from __future__ import annotations

import datetime as dt
import json
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HELPER = REPO / "deploy/recorder_watchdog.py"
NOW = 1_800_000_000
CONTAINER = "a" * 64
OTHER_CONTAINER = "b" * 64
SHA = "c" * 40
SECRET = "super-secret-postgres-password-DO-NOT-ARCHIVE"


def utc(value: float) -> str:
    return dt.datetime.fromtimestamp(value, dt.timezone.utc).isoformat().replace("+00:00", "Z")


DRIVER = r"""
import importlib.util, json, pathlib, sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('watchdog', sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
root = pathlib.Path(sys.argv[2])
docker = helper.Docker(root / 'checkout')
docker.executable = str(root / 'docker-fixture')
try:
    with patch.object(helper, 'headroom', return_value=sys.argv[4] != 'low'):
        if sys.argv[4] == 'check':
            with patch.object(helper, 'Docker', return_value=docker):
                sys.argv = ['watchdog', '--check-target']
                raise SystemExit(helper.main())
        result = helper.supervise(docker, root / 'state', now=float(sys.argv[3]))
    print(json.dumps(result, sort_keys=True))
except helper.Refused as exc:
    print(json.dumps({'reason': str(exc), 'action': 'inhibited'}))
    raise SystemExit(1)
except Exception:
    print(json.dumps({'reason': 'WATCHDOG_FAILED', 'action': 'inhibited'}))
    raise SystemExit(1)
"""


FAKE_DOCKER = r"""
import json, os, pathlib, signal, sys, time
root = pathlib.Path(__file__).resolve().parent
scenario = json.loads((root / 'scenario.json').read_text())
argv = sys.argv[1:]
assert argv[:2] == ['--host', 'unix:///var/run/docker.sock'], argv
argv = argv[2:]
with (root / 'calls.jsonl').open('a') as stream:
    stream.write(json.dumps(argv) + '\n')
verb = argv[0]
if verb == 'ps':
    print('\n'.join(scenario.get('ids', [scenario['target']['id']])))
elif verb == 'inspect':
    assert '--format' in argv and 'Config.Env' not in argv[2]
    count_path = root / 'inspect-count'
    count = int(count_path.read_text()) + 1 if count_path.exists() else 1
    count_path.write_text(str(count))
    target = scenario['target']
    if count > scenario.get('change_after_inspect', 10**9):
        target = dict(target, **scenario.get('changed_target', {}))
    print(json.dumps(target))
elif verb == 'exec':
    assert argv[1:3] == ['--user', 'node']
    assert argv[4:8] == ['node', '--max-old-space-size=32', '--input-type=module', '-e']
    if scenario.get('hold_probe'):
        (root / 'probe-ready').write_text('ready')
        deadline = time.monotonic() + 15
        while not (root / 'probe-release').exists() and time.monotonic() < deadline:
            time.sleep(0.01)
    if scenario.get('probe_error'):
        sys.stderr.write(scenario['probe_error'])
        raise SystemExit(1)
    probe = scenario['probe']
    count_path = root / 'exec-count'
    count = int(count_path.read_text()) + 1 if count_path.exists() else 1
    count_path.write_text(str(count))
    if count > scenario.get('change_after_exec', 10**9):
        probe = dict(probe, **scenario.get('changed_probe', {}))
    if scenario.get('heartbeat_file'):
        probe['heartbeat'] = json.loads(pathlib.Path(scenario['heartbeat_file']).read_text())
        os.kill(probe['heartbeat']['pid'], 0)
    print(json.dumps(probe))
elif verb == 'stats':
    assert '--no-stream' in argv and '--format' in argv
    print(json.dumps(scenario.get('memory_usage', '200MiB / 832MiB')))
elif verb == 'logs':
    assert '--since' in argv and '--until' in argv and '--tail' in argv
    if scenario.get('maintenance_on_logs'):
        (root / 'state' / 'maintenance').touch()
    stream = sys.stderr if scenario.get('logs_stderr') else sys.stdout
    stream.write(scenario.get('logs', ''))
elif verb == 'restart':
    assert argv == ['restart', '--timeout', '10', scenario['target']['id']], argv
    state = root / 'state'
    witness = {'state': json.loads((state / 'state.json').read_text()),
               'events': [json.loads(p.read_text()) for p in state.glob('event-*.json')]}
    with (root / 'restart-witness.jsonl').open('a') as stream:
        stream.write(json.dumps(witness) + '\n')
    if scenario.get('crash_supervisor_on_restart'):
        os.kill(os.getppid(), signal.SIGKILL)
    if scenario.get('restart_failure'):
        sys.stderr.write('postgres://' + scenario['restart_failure'])
        raise SystemExit(1)
    print(scenario['target']['id'])
else:
    raise SystemExit('unexpected Docker verb')
"""


class WatchdogTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="recorder-watchdog-")
        self.addCleanup(temporary.cleanup)
        # macOS /var is a symlink; production deliberately rejects such paths.
        self.root = Path(temporary.name).resolve()
        self.state = self.root / "state"
        self.driver = self.root / "driver.py"
        self.driver.write_text(DRIVER)
        executable = self.root / "docker-fixture"
        executable.write_text(f"#!{sys.executable}\n" + FAKE_DOCKER)
        executable.chmod(0o700)
        self.scenario = {
            "target": {
                "id": CONTAINER,
                "image": "sha256:" + "d" * 64,
                "state": "running",
                "started": utc(NOW - 600),
                "restarts": 0,
                "cmd": ["node", "apps/api/dist/polymarket-recorder.js"],
                "project": "ganso-market",
                "service": "polymarket-recorder",
                "directory": str(self.root / "checkout"),
            },
            "probe": {
                "version": 1,
                "db": "ok",
                "sha": SHA,
                "heartbeat": {
                    "version": 1,
                    "pid": 42,
                    "seq": 1,
                    "phase": "running",
                    "timestamp": utc(NOW),
                    "uptime_ms": 600_000,
                },
                "persistence": {"clob": utc(NOW - 2), "rtds": utc(NOW - 1)},
            },
            "logs": json.dumps(
                {"reason_code": "STATUS", "level": "info", "ts": utc(NOW), "universe_tokens": 4}
            )
            + "\n",
        }
        self.save()

    def save(self) -> None:
        (self.root / "scenario.json").write_text(json.dumps(self.scenario))

    def argv(self, now: float = NOW, mode: str = "normal") -> list[str]:
        return [sys.executable, str(self.driver), str(HELPER), str(self.root), str(now), mode]

    def run_watchdog(self, now: float = NOW, mode: str = "normal", *, success: bool = True) -> dict:
        self.save()
        result = subprocess.run(self.argv(now, mode), capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0 if success else 1, result.stdout + result.stderr)
        self.assertEqual(result.stderr, "")
        return json.loads(result.stdout)

    def stalled(self) -> None:
        self.scenario["probe"]["heartbeat"]["timestamp"] = utc(NOW - 120)

    def calls(self, verb: str | None = None) -> list[list[str]]:
        path = self.root / "calls.jsonl"
        rows = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        return [row for row in rows if verb is None or row[0] == verb]

    def events(self) -> list[dict]:
        return [json.loads(path.read_text()) for path in sorted(self.state.glob("event-*.json"))]

    def state_json(self) -> dict:
        return json.loads((self.state / "state.json").read_text())

    def wait_file(self, path: Path, child: subprocess.Popen, seconds: float = 5) -> None:
        deadline = time.monotonic() + seconds
        while not path.exists() and time.monotonic() < deadline and child.poll() is None:
            time.sleep(0.01)
        self.assertTrue(path.exists(), f"child did not reach {path.name}; exit={child.poll()}")

    def test_healthy_recorder_is_probed_by_a_new_process_without_restart(self) -> None:
        self.assertEqual(self.run_watchdog(), {"reason": "healthy", "action": "observe"})
        self.assertEqual(self.events(), [])
        self.assertEqual(self.calls("restart"), [])
        probe = self.calls("exec")[0]
        self.assertEqual(
            probe[1:8],
            [
                "--user",
                "node",
                CONTAINER,
                "node",
                "--max-old-space-size=32",
                "--input-type=module",
                "-e",
            ],
        )
        self.assertEqual(json.loads((self.state / "status.json").read_text())["sha"], SHA)

    def test_stall_requires_two_observations_at_least_thirty_seconds_apart(self) -> None:
        self.stalled()
        self.assertEqual(self.run_watchdog()["action"], "observe")
        self.assertEqual(self.run_watchdog(NOW + 29)["action"], "observe")
        self.assertEqual(self.calls("restart"), [])
        self.assertEqual(
            self.run_watchdog(NOW + 30),
            {"reason": "heartbeat_stalled", "action": "restart_requested"},
        )
        self.assertEqual(self.calls("restart"), [["restart", "--timeout", "10", CONTAINER]])

    def test_live_node_with_blocked_event_loop_cannot_block_external_observer(self) -> None:
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node is required for the real blocked-event-loop fixture")
        heartbeat = self.root / "heartbeat.json"
        worker = self.root / "blocked-recorder.cjs"
        worker.write_text(
            textwrap.dedent(f"""
            const fs = require('node:fs');
            fs.writeFileSync({json.dumps(str(heartbeat))}, JSON.stringify({{
              version: 1, pid: process.pid, seq: 1, phase: 'running',
              timestamp: {json.dumps(utc(NOW - 120))}, uptime_ms: 600000
            }}));
            // A heartbeat scheduled here cannot execute after this loop starts.
            setInterval(() => {{ throw new Error('event loop unexpectedly free'); }}, 10);
            while (true) {{}}
        """)
        )
        child = subprocess.Popen(
            [node, str(worker)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        try:
            self.wait_file(heartbeat, child)
            self.scenario["heartbeat_file"] = str(heartbeat)
            started = time.monotonic()
            self.assertEqual(self.run_watchdog()["reason"], "heartbeat_stalled")
            self.assertEqual(self.run_watchdog(NOW + 30)["action"], "restart_requested")
            self.assertLess(time.monotonic() - started, 5)
            self.assertIsNone(child.poll(), "the observed recorder must remain Up during detection")
        finally:
            child.kill()
            child.wait(timeout=5)

    def test_shared_db_outage_never_restarts_even_when_heartbeat_is_stalled(self) -> None:
        self.stalled()
        self.scenario["probe"]["db"] = "unavailable"
        for offset in (0, 30, 330, 930, 3630):
            self.assertEqual(
                self.run_watchdog(NOW + offset), {"reason": "db_unavailable", "action": "observe"}
            )
        self.assertEqual(self.calls("restart"), [])
        self.assertEqual(self.state_json()["attempts"], [])

    def test_persistence_stale_or_unavailable_alone_never_restarts(self) -> None:
        for persistence, reason in (
            ({"clob": utc(NOW - 600), "rtds": None}, "persistence_stale"),
            (None, "persistence_unavailable"),
        ):
            with self.subTest(reason=reason):
                self.scenario["probe"]["persistence"] = persistence
                self.assertEqual(self.run_watchdog(), {"reason": reason, "action": "observe"})
                self.assertEqual(self.run_watchdog(NOW + 30)["action"], "observe")
                # Keep the next subcase's clock monotonic, and reset progress.
                if reason == "persistence_stale":
                    shutil.rmtree(self.state)
        self.assertEqual(self.calls("restart"), [])

    def test_stalled_heartbeat_with_failed_persistence_query_does_not_restart(self) -> None:
        self.stalled()
        self.scenario["probe"]["persistence"] = None
        self.assertEqual(self.run_watchdog()["reason"], "persistence_unavailable")
        self.assertEqual(self.run_watchdog(NOW + 30)["action"], "observe")
        self.assertEqual(self.calls("restart"), [])

    def test_start_grace_stopping_and_nonrunning_are_observational(self) -> None:
        for change, reason in (
            ("starting", "starting"),
            ("stopping", "stopping"),
            ("exited", "recorder_not_running"),
        ):
            with self.subTest(change=change):
                self.scenario["target"]["started"] = utc(
                    NOW - 20 if change == "starting" else NOW - 600
                )
                self.scenario["target"]["state"] = "exited" if change == "exited" else "running"
                self.scenario["probe"]["heartbeat"]["phase"] = (
                    "stopping" if change == "stopping" else "running"
                )
                self.assertEqual(self.run_watchdog()["reason"], reason)
                self.assertEqual(self.calls("restart"), [])

    def test_startup_that_never_finishes_is_recoverable_after_grace(self) -> None:
        self.scenario["probe"]["heartbeat"]["phase"] = "starting"
        self.assertEqual(self.run_watchdog()["reason"], "startup_stalled")
        self.assertEqual(self.run_watchdog(NOW + 30)["action"], "restart_requested")

    def test_frozen_sequence_is_detected_even_if_wall_timestamp_keeps_refreshing(self) -> None:
        self.assertEqual(self.run_watchdog()["reason"], "healthy")
        for offset, action in ((91, "observe"), (121, "restart_requested")):
            self.scenario["probe"]["heartbeat"]["timestamp"] = utc(NOW + offset)
            self.assertEqual(
                self.run_watchdog(NOW + offset), {"reason": "heartbeat_stalled", "action": action}
            )

    def test_recreated_container_requires_its_own_confirmation(self) -> None:
        self.stalled()
        self.run_watchdog()
        self.scenario["target"]["id"] = OTHER_CONTAINER
        self.assertEqual(self.run_watchdog(NOW + 30)["action"], "observe")
        self.assertEqual(self.run_watchdog(NOW + 60)["action"], "restart_requested")
        self.assertEqual(self.calls("restart")[0][-1], OTHER_CONTAINER)

    def test_durable_cooldown_exponential_backoff_and_three_per_hour_across_recreates(self) -> None:
        self.stalled()
        self.run_watchdog()
        for offset, action in (
            (30, "restart_requested"),
            (329, "backoff"),
            (330, "restart_requested"),
            (929, "backoff"),
            (930, "restart_requested"),
            (2130, "window_exhausted"),
        ):
            self.assertEqual(self.run_watchdog(NOW + offset)["action"], action)
        self.assertEqual(self.state_json()["attempts"], [NOW + 30, NOW + 330, NOW + 930])
        self.assertEqual(self.state_json()["next_allowed"], NOW + 2130)
        old_evidence = set(self.state.glob("event-*.json"))
        self.scenario["target"]["id"] = OTHER_CONTAINER
        self.assertEqual(self.run_watchdog(NOW + 2160)["action"], "observe")
        self.assertEqual(self.run_watchdog(NOW + 2190)["action"], "window_exhausted")
        self.assertTrue(old_evidence.issubset(set(self.state.glob("event-*.json"))))
        self.assertEqual(self.run_watchdog(NOW + 3630)["action"], "restart_requested")
        self.assertEqual(self.state_json()["next_allowed"], NOW + 5430)
        self.assertEqual(len(self.calls("restart")), 4)

    def test_restart_receives_durable_evidence_and_reserved_attempt_before_mutation(self) -> None:
        self.stalled()
        self.run_watchdog()
        self.run_watchdog(NOW + 30)
        witness = json.loads((self.root / "restart-witness.jsonl").read_text())
        self.assertEqual(witness["state"]["attempts"], [NOW + 30])
        self.assertEqual(witness["state"]["next_allowed"], NOW + 330)
        before = [event for event in witness["events"] if event["action"] == "restart_reserved"]
        self.assertEqual(len(before), 1)
        self.assertEqual(
            (before[0]["utc"], before[0]["sha"], before[0]["reason"]),
            (utc(NOW + 30), SHA, "heartbeat_stalled"),
        )
        self.assertTrue(before[0]["logs"]["rows"])
        verbs = [call[0] for call in self.calls()]
        self.assertLess(
            max(i for i, verb in enumerate(verbs) if verb == "logs"), verbs.index("restart")
        )

    def test_sigkill_during_restart_keeps_reservation_and_lock_is_released(self) -> None:
        self.stalled()
        self.run_watchdog()
        self.scenario["crash_supervisor_on_restart"] = True
        self.save()
        crashed = subprocess.run(self.argv(NOW + 30), capture_output=True, text=True, timeout=10)
        self.assertEqual(crashed.returncode, -signal.SIGKILL)
        self.assertEqual(self.state_json()["attempts"], [NOW + 30])
        self.assertTrue(any(event["action"] == "restart_reserved" for event in self.events()))
        self.scenario["crash_supervisor_on_restart"] = False
        self.assertEqual(self.run_watchdog(NOW + 60)["action"], "backoff")
        self.assertEqual(len(self.calls("restart")), 1)

    def test_ambiguous_restart_failure_consumes_attempt_and_never_archives_stderr(self) -> None:
        self.stalled()
        self.scenario["restart_failure"] = SECRET
        self.run_watchdog()
        self.assertEqual(self.run_watchdog(NOW + 30)["action"], "restart_unconfirmed")
        self.assertEqual(self.run_watchdog(NOW + 60)["action"], "backoff")
        self.assertEqual(self.state_json()["attempts"], [NOW + 30])
        self.assertNotIn(SECRET, "".join(path.read_text() for path in self.state.glob("*.json")))

    def test_competing_real_process_exits_without_probing_or_restarting(self) -> None:
        self.scenario["hold_probe"] = True
        self.save()
        first = subprocess.Popen(
            self.argv(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        try:
            self.wait_file(self.root / "probe-ready", first)
            started = time.monotonic()
            self.assertEqual(self.run_watchdog(), {"reason": "instance_locked"})
            self.assertLess(time.monotonic() - started, 2)
            self.assertEqual(len(self.calls("exec")), 1)
            (self.root / "probe-release").touch()
            stdout, stderr = first.communicate(timeout=5)
            self.assertEqual(first.returncode, 0, stdout + stderr)
        finally:
            if first.poll() is None:
                first.kill()
            first.communicate(timeout=5)

    def test_maintenance_inhibits_all_docker_calls_including_dangling_marker(self) -> None:
        self.state.mkdir(mode=0o700)
        marker = self.state / "maintenance"
        marker.symlink_to(self.root / "missing")
        self.assertEqual(self.run_watchdog(), {"reason": "maintenance"})
        self.assertEqual(self.calls(), [])
        self.assertTrue(marker.is_symlink())

    def test_maintenance_arriving_after_evidence_prevents_restart(self) -> None:
        self.stalled()
        self.run_watchdog()
        self.scenario["maintenance_on_logs"] = True
        self.assertEqual(self.run_watchdog(NOW + 30)["action"], "target_changed_or_maintenance")
        self.assertEqual(self.calls("restart"), [])
        self.assertEqual(self.state_json()["attempts"], [])

    def test_target_generation_change_after_evidence_prevents_restart(self) -> None:
        self.stalled()
        self.run_watchdog()
        self.scenario["change_after_inspect"] = 2
        self.scenario["changed_target"] = {"started": utc(NOW - 1)}
        self.assertEqual(self.run_watchdog(NOW + 30)["action"], "target_changed_or_maintenance")
        self.assertEqual(self.calls("restart"), [])

    def test_recorder_progress_resuming_during_evidence_capture_cancels_restart(self) -> None:
        self.stalled()
        self.run_watchdog()
        self.scenario["change_after_exec"] = 2
        self.scenario["changed_probe"] = {
            "heartbeat": dict(self.scenario["probe"]["heartbeat"], seq=2, timestamp=utc(NOW + 30))
        }
        self.assertEqual(self.run_watchdog(NOW + 30)["action"], "recovery_changed")
        self.assertEqual(len(self.calls("exec")), 3)
        self.assertEqual(self.calls("restart"), [])
        self.assertEqual(self.state_json()["attempts"], [])
        self.assertEqual(self.state_json()["streak"], 0)
        evidence = self.events()[-1]
        self.assertEqual(evidence["probe"]["heartbeat"]["timestamp"], utc(NOW - 120))
        self.assertEqual(evidence["confirmation"]["reason"], "healthy")
        self.assertEqual(evidence["confirmation"]["probe"]["heartbeat"]["seq"], 2)

    def test_db_failing_during_evidence_capture_cancels_restart_without_spending_attempt(
        self,
    ) -> None:
        self.stalled()
        self.run_watchdog()
        self.scenario["change_after_exec"] = 2
        self.scenario["changed_probe"] = {"db": "unavailable"}
        self.assertEqual(self.run_watchdog(NOW + 30)["action"], "recovery_changed")
        self.assertEqual(len(self.calls("exec")), 3)
        self.assertEqual(self.calls("restart"), [])
        self.assertEqual(self.state_json()["attempts"], [])
        self.assertEqual(self.state_json()["next_allowed"], 0)
        evidence = self.events()[-1]
        self.assertEqual(evidence["probe"]["db"], "ok")
        self.assertEqual(evidence["confirmation"]["reason"], "db_unavailable")
        self.assertEqual(evidence["confirmation"]["probe"]["db"], "unavailable")

    def test_unknown_sha_blocks_recovery_without_hiding_stall(self) -> None:
        self.stalled()
        self.scenario["probe"]["sha"] = "not-a-release-sha"
        self.run_watchdog()
        self.assertEqual(self.run_watchdog(NOW + 30)["action"], "provenance_unknown")
        self.assertEqual(self.calls("restart"), [])

    def test_wrong_or_ambiguous_target_is_refused_before_exec(self) -> None:
        for field, value, reason in (
            ("ids", [CONTAINER, OTHER_CONTAINER], "TARGET_NOT_UNIQUE"),
            ("service", "postgres", "TARGET_MISMATCH"),
            ("directory", "/another-checkout", "TARGET_MISMATCH"),
        ):
            with self.subTest(field=field):
                old = self.scenario.get(field) if field == "ids" else self.scenario["target"][field]
                if field == "ids":
                    self.scenario[field] = value
                else:
                    self.scenario["target"][field] = value
                self.assertEqual(self.run_watchdog(success=False)["reason"], reason)
                if field == "ids":
                    self.scenario.pop(field)
                else:
                    self.scenario["target"][field] = old
        self.assertEqual(self.calls("exec"), [])
        self.assertEqual(self.calls("restart"), [])

    def test_check_target_requires_running_recorder_heartbeat_and_release_sha(self) -> None:
        self.assertEqual(self.run_watchdog(mode="check")["reason"], "target_verified")
        self.scenario["probe"]["heartbeat"] = None
        self.assertEqual(
            self.run_watchdog(mode="check", success=False)["reason"], "TARGET_CONTRACT_MISSING"
        )
        self.scenario["target"]["state"] = "exited"
        self.assertEqual(
            self.run_watchdog(mode="check", success=False)["reason"], "TARGET_NOT_RUNNING"
        )
        self.assertFalse(self.state.exists())
        self.assertEqual(self.calls("restart"), [])

    def test_cli_refuses_alternate_lock_location(self) -> None:
        result = subprocess.run(
            [sys.executable, str(HELPER), "--state-dir", str(self.state)],
            capture_output=True,
            text=True,
            timeout=5,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["reason"], "STATE_PATH_NOT_CANONICAL")
        self.assertFalse(self.state.exists())

    def test_long_observer_absence_does_not_erase_exponential_backoff(self) -> None:
        self.stalled()
        self.run_watchdog()
        self.run_watchdog(NOW + 30)
        for offset in (60, 3660):
            self.scenario["probe"]["heartbeat"]["seq"] += 1
            self.scenario["probe"]["heartbeat"]["timestamp"] = utc(NOW + offset)
            self.scenario["probe"]["persistence"] = {
                "clob": utc(NOW + offset),
                "rtds": utc(NOW + offset),
            }
            self.assertEqual(self.run_watchdog(NOW + offset)["reason"], "healthy")
        self.assertEqual(self.state_json()["streak"], 1)
        self.scenario["probe"]["heartbeat"]["timestamp"] = utc(NOW + 3400)
        self.run_watchdog(NOW + 3690)
        self.assertEqual(self.run_watchdog(NOW + 3720)["action"], "restart_requested")
        self.assertEqual(self.state_json()["next_allowed"], NOW + 4320)

    def test_low_headroom_and_clock_rollback_refuse_before_docker(self) -> None:
        self.assertEqual(self.run_watchdog(mode="low", success=False)["reason"], "HEADROOM_LOW")
        self.assertEqual(self.calls(), [])
        self.run_watchdog()
        before = len(self.calls())
        self.assertEqual(self.run_watchdog(NOW - 1, success=False)["reason"], "CLOCK_ROLLBACK")
        self.assertEqual(len(self.calls()), before)

    def test_low_container_headroom_does_not_launch_probe_or_restart(self) -> None:
        self.scenario["memory_usage"] = "780MiB / 832MiB"
        self.assertEqual(self.run_watchdog(success=False)["reason"], "CONTAINER_HEADROOM_LOW")
        self.assertEqual(self.calls("exec"), [])
        self.assertEqual(self.calls("restart"), [])

    def test_evidence_redacts_unknown_text_env_and_credentials_in_both_log_streams(self) -> None:
        self.stalled()
        self.scenario["probe"]["credentials"] = SECRET
        self.scenario["target"]["env"] = {"POSTGRES_PASSWORD": SECRET}
        self.scenario["logs"] = "\n".join(
            [
                SECRET,
                json.dumps(
                    {
                        "reason_code": "RECORDER_FAILED",
                        "level": "error",
                        "timestamp": utc(NOW),
                        "message": SECRET,
                        "error": {"password": SECRET},
                        "dropped": 2,
                    }
                ),
                json.dumps({"reason_code": SECRET, "level": "error"}),
                json.dumps({"reason_code": "STATUS", "level": SECRET, "universe_tokens": SECRET}),
            ]
        )
        for stderr in (False, True):
            self.scenario["logs_stderr"] = stderr
            self.run_watchdog()
            evidence = self.events()[-1]
            self.assertNotIn(SECRET, json.dumps(evidence))
            self.assertTrue(
                any(
                    row.get("reason_code") == "RECORDER_FAILED" and row.get("dropped") == 2
                    for row in evidence["logs"]["rows"]
                )
            )

    def test_output_flood_is_bounded_and_error_does_not_hide_stall(self) -> None:
        self.stalled()
        self.scenario["logs"] = SECRET * 20_000
        self.assertEqual(self.run_watchdog()["reason"], "heartbeat_stalled")
        logs = self.events()[-1]["logs"]
        self.assertEqual(logs, {"status": "COMMAND_OUTPUT_LIMIT", "rows": []})
        self.assertLess(sum(p.stat().st_size for p in self.state.iterdir()), 8192)

    def test_evidence_rotation_is_bounded_and_preserves_unrelated_files_and_symlinks(self) -> None:
        self.state.mkdir(mode=0o700)
        unrelated = self.state / "operator-note.json"
        unrelated.write_text("keep")
        outside = self.root / "outside.json"
        outside.write_text("untouched")
        link = self.state / ("event-" + "0" * 20 + "-" + "a" * 32 + ".json")
        link.symlink_to(outside)
        directory = self.state / ("event-" + "0" * 20 + "-" + "b" * 32 + ".json")
        directory.mkdir()
        # Seed old valid artifacts at the promised per-event ceiling; one real
        # observation must free one slot before writing the next one.
        for i in range(32):
            path = self.state / f"event-{i + 1:020d}-{'c' * 32}.json"
            path.write_bytes(b" " * (64 * 1024))
            path.chmod(0o600)
        self.stalled()
        self.scenario["logs"] *= 200
        self.run_watchdog()
        regular = [p for p in self.state.glob("event-*.json") if p.is_file() and not p.is_symlink()]
        self.assertEqual(len(regular), 32)
        self.assertLessEqual(sum(p.stat().st_size for p in regular), 32 * 64 * 1024)
        generated = max(regular, key=lambda p: p.name)
        self.assertLessEqual(len(json.loads(generated.read_text())["logs"]["rows"]), 100)
        self.assertTrue(link.is_symlink())
        self.assertTrue(directory.is_dir())
        self.assertEqual(outside.read_text(), "untouched")
        self.assertEqual(unrelated.read_text(), "keep")

    def test_permissions_and_pending_symlink_are_safe(self) -> None:
        self.state.mkdir(mode=0o700)
        outside = self.root / "outside"
        outside.write_text(SECRET)
        (self.state / ".pending").symlink_to(outside)
        self.stalled()
        self.run_watchdog()
        self.assertEqual(outside.read_text(), SECRET)
        self.assertFalse((self.state / ".pending").exists())
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o700)
        for path in self.state.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600, path.name)

    def test_unsafe_directory_or_state_symlink_fails_closed_without_touching_target(self) -> None:
        self.state.mkdir(mode=0o755)
        self.state.chmod(0o755)
        self.assertEqual(self.run_watchdog(success=False)["reason"], "STATE_PERMISSIONS_UNSAFE")
        self.state.chmod(0o700)
        outside = self.root / "outside"
        outside.write_text(SECRET)
        (self.state / "state.json").symlink_to(outside)
        self.assertEqual(self.run_watchdog(success=False)["reason"], "STATE_INVALID")
        self.assertEqual(self.calls(), [])
        self.assertEqual(outside.read_text(), SECRET)

    def test_corrupt_state_cannot_reset_restart_budget(self) -> None:
        self.state.mkdir(mode=0o700)
        state = self.state / "state.json"
        state.write_text('{"version":1,"attempts":[')
        state.chmod(0o600)
        self.assertEqual(self.run_watchdog(success=False)["reason"], "STATE_INVALID")
        self.assertEqual(self.calls(), [])


class CommandDeadlineTests(unittest.TestCase):
    def test_process_that_closes_stdout_but_never_exits_still_has_a_deadline(self) -> None:
        driver = textwrap.dedent(f"""
            import importlib.util, json, sys
            spec = importlib.util.spec_from_file_location('watchdog', {str(HELPER)!r})
            helper = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(helper)
            try:
                program = 'import os,time; os.close(1); time.sleep(30)'
                helper.command([sys.executable, '-c', program], timeout=0.2)
            except helper.Refused as exc:
                print(json.dumps({{'reason': str(exc)}}))
        """)
        started = time.monotonic()
        result = subprocess.run(
            [sys.executable, "-c", driver], capture_output=True, text=True, timeout=5
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"reason": "COMMAND_TIMEOUT"})
        self.assertLess(time.monotonic() - started, 3)

    def test_timeout_kills_child_and_grandchild_holding_stdout_open(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw).resolve()
            tick = root / "grandchild-tick"
            grandchild = root / "grandchild.py"
            grandchild.write_text(
                textwrap.dedent(f"""
                import pathlib, time
                path = pathlib.Path({str(tick)!r})
                while True:
                    path.write_text(str(time.monotonic_ns()))
                    time.sleep(0.02)
            """)
            )
            child = root / "child.py"
            child.write_text(
                textwrap.dedent(f"""
                import subprocess, sys
                subprocess.Popen([sys.executable, {str(grandchild)!r}])
                # Exit immediately; the grandchild retains the stdout pipe.
            """)
            )
            driver = root / "deadline.py"
            driver.write_text(
                textwrap.dedent(f"""
                import importlib.util, json, sys
                spec = importlib.util.spec_from_file_location('watchdog', {str(HELPER)!r})
                helper = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(helper)
                try:
                    helper.command([sys.executable, {str(child)!r}], timeout=0.5)
                except helper.Refused as exc:
                    print(json.dumps({{'reason': str(exc)}}))
            """)
            )
            started = time.monotonic()
            result = subprocess.run(
                [sys.executable, str(driver)], capture_output=True, text=True, timeout=5
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {"reason": "COMMAND_TIMEOUT"})
            self.assertLess(time.monotonic() - started, 3)
            self.assertTrue(tick.exists(), "the grandchild must actually have run")
            last_tick = tick.read_text()
            time.sleep(0.1)
            self.assertEqual(
                tick.read_text(), last_tick, "grandchild survived the observer deadline"
            )


class CapacityHookTests(unittest.TestCase):
    def setUp(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location("watchdog_capacity_test", HELPER)
        self.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.helper)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name).resolve()
        (self.project / "deploy").mkdir()
        self.observer = self.project / "deploy/capacity_series.py"
        self.observer.write_text("# fixture\n")
        self.observer.chmod(0o600)

    def test_hook_is_bounded_and_adds_no_watchdog_probe(self):
        from unittest.mock import patch

        with (
            patch.object(self.helper, "command", return_value=(0, b'{"reason":"not_due"}')) as run,
            patch.object(self.helper.time, "monotonic", return_value=100),
        ):
            self.assertEqual(self.helper.capacity_tick(self.project, 100), "not_due")
        args, kwargs = run.call_args
        self.assertEqual(args[0], [sys.executable, "-I", str(self.observer), "--due"])
        self.assertEqual(args[1], 12)
        self.assertEqual(kwargs, {"limit": 4096})

    def test_long_supervision_reserves_without_probe_in_one_second(self):
        from unittest.mock import patch

        with (
            patch.object(self.helper, "command", return_value=(0, b'{"reason":"captured"}')) as run,
            patch.object(self.helper.time, "monotonic", return_value=146),
        ):
            self.assertEqual(self.helper.capacity_tick(self.project, 100), "captured")
        self.assertEqual(run.call_args.args[0][-1], "--skip-probe")
        self.assertEqual(run.call_args.args[1], 1)

    def test_observer_failure_never_escapes_into_recovery(self):
        from unittest.mock import patch

        with patch.object(self.helper, "command", side_effect=RuntimeError(SECRET)):
            self.assertEqual(
                self.helper.capacity_tick(self.project, time.monotonic()), "observer_failed"
            )

    def test_unsafe_helper_not_executed(self):
        from unittest.mock import patch

        self.observer.chmod(0o666)
        with patch.object(self.helper, "command") as run:
            self.assertEqual(
                self.helper.capacity_tick(self.project, time.monotonic()), "helper_unsafe"
            )
            run.assert_not_called()

    def test_supervisor_refusal_records_inhibited_attempt_without_changing_exit(self):
        from unittest.mock import Mock, patch

        with (
            patch.object(self.helper, "Docker", return_value=Mock()),
            patch.object(self.helper, "supervise", side_effect=self.helper.Refused("HEADROOM_LOW")),
            patch.object(self.helper, "capacity_tick", return_value="captured") as tick,
            patch.object(sys, "argv", ["watchdog"]),
            patch("builtins.print") as printed,
        ):
            self.assertEqual(self.helper.main(), 1)
            self.assertTrue(tick.call_args.kwargs["inhibited"])
            self.assertEqual(json.loads(printed.call_args.args[0])["reason"], "HEADROOM_LOW")

    def test_check_target_does_not_collect_or_write_capacity(self):
        from unittest.mock import Mock, patch

        docker = Mock()
        docker.target.return_value = {"state": "running", "id": CONTAINER}
        docker.probe.return_value = {"heartbeat": {}, "sha": SHA}
        with (
            patch.object(self.helper, "Docker", return_value=docker),
            patch.object(self.helper, "capacity_tick") as tick,
            patch.object(sys, "argv", ["watchdog", "--check-target"]),
            patch("builtins.print"),
        ):
            self.assertEqual(self.helper.main(), 0)
            tick.assert_not_called()

    def test_noncanonical_project_never_executes_optional_helper(self):
        from unittest.mock import Mock, patch

        with (
            patch.object(self.helper, "Docker", return_value=Mock()),
            patch.object(
                self.helper, "supervise", side_effect=self.helper.Refused("TARGET_REFUSED")
            ),
            patch.object(self.helper, "capacity_tick") as tick,
            patch.object(sys, "argv", ["watchdog", "--project-dir", "/untrusted"]),
            patch("builtins.print"),
        ):
            self.assertEqual(self.helper.main(), 1)
            tick.assert_not_called()


if __name__ == "__main__":
    unittest.main()
