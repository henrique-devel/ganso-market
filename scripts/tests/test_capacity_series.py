"""DATA-01 daily series contracts using temporary files and independent samples.

No Docker, SSH, PostgreSQL or production paths are accessed. Local subprocesses
exercise only the command deadline and output ceilings.
"""

from __future__ import annotations

import fcntl
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

REPO = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "capacity_series_subject", REPO / "deploy/capacity_series.py"
)
assert SPEC is not None and SPEC.loader is not None
SUBJECT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUBJECT)
NOW = 1_789_228_800.0
DAY = 86_400
SECRET = "fixture secret must never be persisted"
FILESYSTEM = "8:1:ext4:/dev/sda1"


def observation(now=NOW):
    """Independent small measurement, separating FS, SQL and WAL units."""
    return {
        "utc": SUBJECT.utc(now),
        "complete": True,
        "host_id": "host-a",
        "system_identifier": "7428550000000000001",
        "database": "ganso_market",
        "storage_identity": {
            "targets": {
                name: {"filesystem": FILESYSTEM, "container_realpath": path}
                for name, path in {
                    "pgdata": "/var/lib/postgresql/18/docker",
                    "wal": "/var/lib/postgresql/18/docker/pg_wal",
                    "pg_default": "/var/lib/postgresql/18/docker/base",
                    "pg_global": "/var/lib/postgresql/18/docker/global",
                }.items()
            },
            "filesystems": {
                FILESYSTEM: {
                    "device": "8:1",
                    "fstype": "ext4",
                    "source": "/dev/sda1",
                    "total_bytes": 320_000_000_000,
                }
            },
        },
        "filesystems": {
            FILESYSTEM: {
                "total_bytes": 320_000_000_000,
                "available_bytes": 200_000_000_000,
                "free_bytes": 201_000_000_000,
            }
        },
        "sql": {
            "database_bytes": 100_000_000_000,
            "wal": {"wal_bytes": "5000000000", "stats_reset": "2026-09-01T00:00:00+00:00"},
        },
        "wal_segments": {"count": 4, "bytes": 67_108_864, "allocated_bytes": 67_108_864},
    }


def sample(slot, now=NOW, status="ok"):
    return {"slot": slot, "status": status, "observation": observation(now)}


class DailySeriesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ganso-capacity-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.directory = self.root / "series"

    def start(self):
        return SUBJECT.start_series(self.directory, NOW)

    def path(self, slot):
        return self.directory / f"sample-{slot:02d}.json"

    def saved(self, slot):
        return json.loads(self.path(slot).read_text())

    def test_absent_series_is_disabled_without_creating_files_or_probing(self):
        collector = Mock(side_effect=AssertionError("unexpected probe"))
        self.assertEqual(SUBJECT.run_due(self.directory, NOW, collector), {"reason": "disabled"})
        self.assertFalse(self.directory.exists())
        collector.assert_not_called()

    def test_start_is_idempotent_and_does_not_extend_the_seven_day_series(self):
        first = self.start()
        raw = (self.directory / "series.json").read_bytes()
        again = SUBJECT.start_series(self.directory, NOW + 6 * DAY)
        self.assertEqual(again, first)
        self.assertEqual((self.directory / "series.json").read_bytes(), raw)
        self.assertEqual(first["slots"], 8)
        self.assertEqual(SUBJECT.stamp(first["last_slot_due_utc"]), NOW + 7 * DAY)
        self.assertEqual(SUBJECT.stamp(first["window_end_utc"]), NOW + 7 * DAY + 3600)
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.directory / "series.json").stat().st_mode), 0o600)
        self.assertLessEqual(len(raw), 4096)

    def test_baseline_and_seven_daily_intervals_are_eight_single_attempts(self):
        self.start()
        collector = Mock()
        for slot in range(8):
            with self.subTest(slot=slot):
                at = NOW + slot * DAY
                collector.return_value = observation(at)
                self.assertEqual(
                    SUBJECT.run_due(self.directory, at, collector),
                    {"reason": "captured", "slot": slot, "status": "ok"},
                )
                self.assertEqual(
                    SUBJECT.run_due(self.directory, at + 30, collector)["reason"], "not_due"
                )
                self.assertEqual(collector.call_count, slot + 1)
                saved = self.saved(slot)
                self.assertEqual(saved["delta"]["valid"], slot > 0)
                self.assertEqual(stat.S_IMODE(self.path(slot).stat().st_mode), 0o600)
                self.assertLessEqual(self.path(slot).stat().st_size, 16 * 1024)
        for at in (NOW + 7 * DAY + 3600, NOW + 90 * DAY):
            self.assertEqual(
                SUBJECT.run_due(self.directory, at, collector)["reason"], "window_closed"
            )
        self.assertEqual(collector.call_count, 8)
        self.assertEqual(len(list(self.directory.glob("sample-*.json"))), 8)

    def test_current_window_is_collected_without_backfilling_missed_days(self):
        self.start()
        collector = Mock(return_value=observation(NOW + 3 * DAY + 10))
        result = SUBJECT.run_due(self.directory, NOW + 3 * DAY + 10, collector)
        self.assertEqual(result, {"reason": "captured", "slot": 3, "status": "ok"})
        collector.assert_called_once_with()
        for slot in range(3):
            self.assertEqual(self.saved(slot)["status"], "missed")
            self.assertNotIn("observation", self.saved(slot))
        self.assertFalse(self.saved(3)["delta"]["valid"])

    def test_grace_is_exclusive_and_missed_window_does_not_retry(self):
        self.start()
        collector = Mock(side_effect=AssertionError("unexpected probe"))
        for at in (NOW + 3600, NOW + DAY - 1):
            self.assertEqual(SUBJECT.run_due(self.directory, at, collector)["reason"], "not_due")
        self.assertEqual(self.saved(0)["status"], "missed")
        collector.assert_not_called()

    def test_final_closed_window_marks_absences_without_any_probe(self):
        self.start()
        collector = Mock(side_effect=AssertionError("unexpected probe"))
        self.assertEqual(
            SUBJECT.run_due(self.directory, NOW + 7 * DAY + 3600, collector),
            {"reason": "window_closed"},
        )
        self.assertEqual([self.saved(n)["status"] for n in range(8)], ["missed"] * 8)
        collector.assert_not_called()

    def test_durable_reservation_precedes_probe_and_interrupt_consumes_slot(self):
        self.start()

        def interrupted():
            reserved = self.saved(0)
            self.assertEqual(reserved["status"], "reserved")
            self.assertEqual(stat.S_IMODE(self.path(0).stat().st_mode), 0o600)
            self.assertNotIn("observation", reserved)
            raise KeyboardInterrupt

        with self.assertRaises(KeyboardInterrupt):
            SUBJECT.run_due(self.directory, NOW, interrupted)
        collector = Mock(return_value=observation(NOW + DAY))
        self.assertEqual(SUBJECT.run_due(self.directory, NOW + 30, collector)["reason"], "not_due")
        collector.assert_not_called()
        self.assertEqual(self.saved(0)["status"], "reserved")
        self.assertEqual(SUBJECT.run_due(self.directory, NOW + DAY, collector)["status"], "ok")
        self.assertFalse(self.saved(1)["delta"]["valid"])

    def test_handled_failure_has_static_error_and_is_not_retried(self):
        self.start()
        collector = Mock(side_effect=RuntimeError(SECRET))
        self.assertEqual(SUBJECT.run_due(self.directory, NOW, collector)["status"], "error")
        self.assertEqual(self.saved(0)["reason"], "COLLECT_FAILED")
        self.assertNotIn(SECRET, self.path(0).read_text())
        self.assertEqual(SUBJECT.run_due(self.directory, NOW + 30, collector)["reason"], "not_due")
        collector.assert_called_once_with()

    def test_partial_sql_failure_keeps_filesystem_but_does_not_create_valid_delta(self):
        self.start()
        first = observation()
        first.update(complete=False, error="COMMAND_TIMEOUT")
        first.pop("sql")
        self.assertEqual(SUBJECT.run_due(self.directory, NOW, lambda: first)["status"], "partial")
        self.assertEqual(self.saved(0)["observation"]["filesystems"], first["filesystems"])
        SUBJECT.run_due(self.directory, NOW + DAY, lambda: observation(NOW + DAY))
        self.assertFalse(self.saved(1)["delta"]["valid"])

    def test_oversized_observation_becomes_small_error_and_consumes_attempt(self):
        self.start()
        huge = observation()
        huge["payload"] = SECRET * 1000
        collector = Mock(return_value=huge)
        self.assertEqual(SUBJECT.run_due(self.directory, NOW, collector)["status"], "error")
        self.assertEqual(self.saved(0)["reason"], "OUTPUT_LIMIT")
        self.assertLess(self.path(0).stat().st_size, 1024)
        self.assertNotIn(SECRET, self.path(0).read_text())
        SUBJECT.run_due(self.directory, NOW + 30, collector)
        collector.assert_called_once_with()

    def test_competing_flock_returns_without_reading_or_probing(self):
        self.start()
        lock = os.open(self.directory / "series.lock", os.O_CREAT | os.O_RDWR, 0o600)
        collector = Mock(side_effect=AssertionError("unexpected probe"))
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            began = time.monotonic()
            self.assertEqual(SUBJECT.run_due(self.directory, NOW, collector), {"reason": "locked"})
            self.assertLess(time.monotonic() - began, 1)
        finally:
            os.close(lock)
        self.assertFalse(self.path(0).exists())
        collector.assert_not_called()

    def test_clock_before_series_or_prior_attempt_cannot_trigger_a_probe(self):
        self.start()
        collector = Mock(return_value=observation(NOW + 30))
        with self.assertRaisesRegex(SUBJECT.Refused, "CLOCK_ROLLBACK"):
            SUBJECT.run_due(self.directory, NOW - 1, collector)
        collector.assert_not_called()
        SUBJECT.run_due(self.directory, NOW + 30, collector)
        with self.assertRaisesRegex(SUBJECT.Refused, "CLOCK_ROLLBACK"):
            SUBJECT.run_due(self.directory, NOW + 29, collector)
        collector.assert_called_once_with()

    def test_corrupt_or_oversized_series_refuses_without_restarting_it(self):
        self.start()
        path = self.directory / "series.json"
        collector = Mock(side_effect=AssertionError("unexpected probe"))
        for raw in ('{"version":', "x" * 4097, '{"version":1,"slots":9}'):
            with self.subTest(raw=raw[:30]):
                path.write_text(raw)
                before = path.read_bytes()
                with self.assertRaises(SUBJECT.Refused):
                    SUBJECT.run_due(self.directory, NOW, collector)
                with self.assertRaises(SUBJECT.Refused):
                    SUBJECT.start_series(self.directory, NOW + DAY)
                self.assertEqual(path.read_bytes(), before)
        collector.assert_not_called()

    def test_unsafe_directory_is_rejected_without_permission_repair(self):
        self.directory.mkdir(mode=0o755)
        self.directory.chmod(0o755)
        collector = Mock(side_effect=AssertionError("unexpected probe"))
        with self.assertRaises(SUBJECT.Refused):
            SUBJECT.run_due(self.directory, NOW, collector)
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o755)
        collector.assert_not_called()

    def test_state_sample_and_lock_links_preserve_external_target_and_never_probe(self):
        self.start()
        outside = self.root / "outside.json"
        outside.write_text('{"secret":"' + SECRET + '"}')
        outside.chmod(0o600)
        original = outside.read_bytes()
        series = self.directory / "series.json"
        original_series = series.read_bytes()
        collector = Mock(side_effect=AssertionError("unexpected probe"))
        for name in ("series.json", "sample-00.json", "series.lock"):
            for link_kind in ("symlink", "hardlink"):
                with self.subTest(name=name, kind=link_kind):
                    path = self.directory / name
                    path.unlink(missing_ok=True)
                    if link_kind == "symlink":
                        path.symlink_to(outside)
                    else:
                        os.link(outside, path)
                    with self.assertRaises((SUBJECT.Refused, OSError)):
                        SUBJECT.run_due(self.directory, NOW, collector)
                    self.assertEqual(outside.read_bytes(), original)
                    path.unlink()
                    if name == "series.json":
                        path.write_bytes(original_series)
                        path.chmod(0o600)
        collector.assert_not_called()

    def test_unsafe_sample_permissions_and_orphan_pending_refuse_before_probe(self):
        self.start()
        collector = Mock(side_effect=AssertionError("unexpected probe"))
        self.path(0).write_text('{"slot":0,"attempt_utc":"' + SUBJECT.utc(NOW) + '"}')
        self.path(0).chmod(0o644)
        with self.assertRaises(SUBJECT.Refused):
            SUBJECT.run_due(self.directory, NOW, collector)
        self.path(0).unlink()
        pending = self.directory / ".pending"
        pending.write_text(SECRET)
        pending.chmod(0o600)
        with self.assertRaisesRegex(SUBJECT.Refused, "PENDING_REQUIRES_REVIEW"):
            SUBJECT.run_due(self.directory, NOW, collector)
        self.assertEqual(pending.read_text(), SECRET)
        collector.assert_not_called()


class CapacityDeltaTests(unittest.TestCase):
    def test_delta_separates_database_space_filesystem_space_and_generated_wal(self):
        before, after = sample(0), sample(1, NOW + DAY + 12)
        observed = after["observation"]
        observed["sql"]["database_bytes"] += 1024
        observed["filesystems"][FILESYSTEM]["available_bytes"] -= 8192
        observed["wal_segments"]["bytes"] -= 16_777_216
        observed["sql"]["wal"]["wal_bytes"] = "5000065536"
        result = SUBJECT.delta(before, after)
        self.assertTrue(result["valid"])
        self.assertEqual(result["elapsed_seconds"], DAY + 12)
        self.assertEqual(result["database_bytes_change"], 1024)
        self.assertEqual(result["filesystem_available_bytes_change"], {FILESYSTEM: -8192})
        self.assertEqual(result["wal_segments_bytes_change"], -16_777_216)
        self.assertEqual(result["wal_generated_bytes"], 65_536)
        self.assertEqual(result["wal_status"], "comparable")

    def test_gap_or_non_success_samples_cannot_support_growth_delta(self):
        for previous_status in ("partial", "error", "reserved", "missed"):
            with self.subTest(previous_status=previous_status):
                result = SUBJECT.delta(sample(0, status=previous_status), sample(1, NOW + DAY))
                self.assertFalse(result["valid"])
        for current_status in ("partial", "error", "reserved", "missed"):
            self.assertFalse(
                SUBJECT.delta(sample(0), sample(1, NOW + DAY, current_status))["valid"]
            )
        self.assertFalse(SUBJECT.delta(None, sample(0))["valid"])
        self.assertEqual(
            SUBJECT.delta(sample(0), sample(2, NOW + 2 * DAY)),
            {"valid": False, "reason": "WINDOW_GAP"},
        )

    def test_host_cluster_database_mount_identity_or_filesystem_resize_invalidates_delta(self):
        for field, value in (
            ("host_id", "host-b"),
            ("system_identifier", "9999999999999999999"),
            ("database", "another_database"),
        ):
            with self.subTest(field=field):
                after = sample(1, NOW + DAY)
                after["observation"][field] = value
                self.assertEqual(SUBJECT.delta(sample(0), after)["reason"], "IDENTITY_CHANGED")
        for changed in ("device", "total_bytes", "target"):
            with self.subTest(changed=changed):
                after = sample(1, NOW + DAY)
                identity = after["observation"]["storage_identity"]
                if changed == "target":
                    identity["targets"]["wal"]["container_realpath"] = "/other-wal"
                elif changed == "device":
                    identity["filesystems"][FILESYSTEM]["device"] = "8:2"
                else:
                    identity["filesystems"][FILESYSTEM]["total_bytes"] += 1
                self.assertEqual(SUBJECT.delta(sample(0), after)["reason"], "IDENTITY_CHANGED")

    def test_wal_reset_or_counter_rollback_invalidates_only_generated_wal_comparison(self):
        for field, value in (("stats_reset", "2026-09-12T10:00:00+00:00"), ("wal_bytes", "1")):
            with self.subTest(field=field):
                before, after = sample(0), sample(1, NOW + DAY)
                after["observation"]["sql"]["wal"][field] = value
                result = SUBJECT.delta(before, after)
                self.assertTrue(result["valid"])
                self.assertIsNone(result["wal_generated_bytes"])
                self.assertEqual(result["wal_status"], "reset_or_counter_rollback")

    def test_actual_measurement_clock_must_advance(self):
        for at in (NOW, NOW - 1):
            self.assertEqual(
                SUBJECT.delta(sample(0), sample(1, at)),
                {"valid": False, "reason": "CLOCK_ROLLBACK"},
            )


def sql_storage():
    result = observation()["sql"]
    result.update(
        data_directory="/var/lib/postgresql/18/docker",
        system_identifier="7428550000000000001",
        database="ganso_market",
        budgets={"read_only": "on", "statement_timeout": "1500ms", "lock_timeout": "250ms"},
        tablespaces=[
            {"oid": "1663", "spcname": "pg_default", "location": ""},
            {"oid": "1664", "spcname": "pg_global", "location": ""},
        ],
    )
    return result


class SqlStorageContractTests(unittest.TestCase):
    def test_postgres_oid_text_and_integer_encodings_validate_known_topology(self):
        for cast in (str, int):
            with self.subTest(oid_type=cast.__name__):
                result = sql_storage()
                for row in result["tablespaces"]:
                    row["oid"] = cast(row["oid"])
                self.assertTrue(SUBJECT.validate_sql_storage(result))

    def test_custom_tablespace_or_nonstandard_default_location_is_rejected(self):
        extra = sql_storage()
        extra["tablespaces"].append({"oid": "50000", "spcname": "custom", "location": "/other"})
        self.assertFalse(SUBJECT.validate_sql_storage(extra))
        changed = sql_storage()
        changed["tablespaces"][0]["location"] = "/other"
        self.assertFalse(SUBJECT.validate_sql_storage(changed))

    def test_unexpected_data_directory_is_rejected(self):
        result = sql_storage()
        result["data_directory"] = "/another/postgres/data"
        self.assertFalse(SUBJECT.validate_sql_storage(result))

    def test_read_write_session_is_rejected(self):
        result = sql_storage()
        result["budgets"]["read_only"] = "off"
        self.assertFalse(SUBJECT.validate_sql_storage(result))

    def test_oid_conversion_never_truncates_float_or_accepts_malformed_value(self):
        for oid in (1663.5, True, None, "1663.5", "not-an-oid"):
            with self.subTest(oid=oid):
                result = sql_storage()
                result["tablespaces"][0]["oid"] = oid
                try:
                    accepted = SUBJECT.validate_sql_storage(result)
                except (ValueError, TypeError):
                    continue
                self.assertFalse(accepted)


class CollectorFixtureTests(unittest.TestCase):
    def invoke(self, sql_error=None, *, filesystem_floor=False, changed_container=False):
        """Execute the collector with every host read and Docker call replaced."""
        container_id = "a" * 64
        target = {
            "id": container_id,
            "pid": 12345,
            "image": "sha256:" + "b" * 64,
            "started": "2026-09-12T00:00:00+00:00",
            "running": True,
            "project": "ganso-market",
            "service": "postgres",
            "directory": "/opt/ganso-market",
            "mounts": [],
        }
        filesystem = observation()["filesystems"][FILESYSTEM]
        filesystem.update(device="8:1", root="/", mountpoint="/", fstype="ext4", source="/dev/sda1")
        if filesystem_floor:
            filesystem["available_bytes"] = filesystem["total_bytes"] // 4 - 1
        mapped = {
            "targets": {"wal": {"host_realpath": "/fixture/wal", "filesystem": FILESYSTEM}},
            "filesystems": {FILESYSTEM: filesystem},
        }
        inspections = 0

        def docker(*args, **kwargs):
            nonlocal inspections
            if args[0] == "ps":
                return container_id
            if args[0] == "inspect":
                inspections += 1
                if inspections == 2 and changed_container:
                    return json.dumps(dict(target, started="2026-09-12T00:01:00+00:00"))
                return json.dumps(target)
            if "readlink" in args:
                return "\n".join(SUBJECT.PATHS.values())
            if "psql" in args:
                if sql_error:
                    raise sql_error
                return json.dumps(sql_storage())
            raise AssertionError("unexpected command fixture")

        budget = Mock()
        budget.docker.side_effect = docker
        with (
            patch.object(SUBJECT, "Budget", return_value=budget),
            patch.object(SUBJECT.Path, "read_bytes", return_value=b"fixture identity and code"),
            patch.object(SUBJECT.Path, "read_text", return_value=""),
            patch.object(SUBJECT.socket, "gethostname", return_value="fixture-host"),
            patch.object(SUBJECT, "storage", return_value=mapped),
            patch.object(SUBJECT, "wal_segments", return_value=observation()["wal_segments"]),
        ):
            result = SUBJECT.collect()
        sql_calls = [call for call in budget.docker.call_args_list if "psql" in call.args]
        return result, sql_calls, inspections, mapped

    def test_sql_failure_keeps_filesystem_and_consumes_exactly_one_sql_attempt(self):
        for error, code in (
            (SUBJECT.Refused("COMMAND_TIMEOUT"), "COMMAND_TIMEOUT"),
            (RuntimeError(SECRET), "SQL_OR_STORAGE_FAILED"),
        ):
            with self.subTest(code=code):
                result, sql_calls, inspections, mapped = self.invoke(error)
                self.assertFalse(result["complete"])
                self.assertEqual(result["error"], code)
                self.assertEqual(result["filesystems"], mapped["filesystems"])
                self.assertEqual(result["targets"], mapped["targets"])
                self.assertEqual(len(sql_calls), 1)
                self.assertEqual(inspections, 1)
                self.assertNotIn(SECRET, json.dumps(result))
                self.assertNotIn("sql", result)

    def test_valid_oid_text_result_is_complete_only_after_container_revalidation(self):
        result, sql_calls, inspections, _ = self.invoke()
        self.assertTrue(result["complete"])
        self.assertEqual(result["system_identifier"], "7428550000000000001")
        self.assertEqual(len(sql_calls), 1)
        self.assertEqual(inspections, 2)
        changed, sql_calls, inspections, mapped = self.invoke(changed_container=True)
        self.assertFalse(changed["complete"])
        self.assertEqual(changed["error"], "CONTAINER_CHANGED")
        self.assertEqual(changed["filesystems"], mapped["filesystems"])
        self.assertEqual(len(sql_calls), 1)
        self.assertEqual(inspections, 2)

    def test_filesystem_floor_preserves_sample_and_prevents_any_sql(self):
        result, sql_calls, inspections, mapped = self.invoke(filesystem_floor=True)
        self.assertFalse(result["complete"])
        self.assertEqual(result["error"], "FILESYSTEM_FLOOR")
        self.assertEqual(result["filesystems"], mapped["filesystems"])
        self.assertEqual(sql_calls, [])
        self.assertEqual(inspections, 1)


class LocalBudgetTests(unittest.TestCase):
    def test_closed_stdout_does_not_remove_process_deadline(self):
        budget = SUBJECT.Budget()
        began = time.monotonic()
        with self.assertRaises((SUBJECT.Refused, subprocess.TimeoutExpired)):
            budget.run([sys.executable, "-c", "import os,time; os.close(1); time.sleep(30)"], 0.2)
        self.assertLess(time.monotonic() - began, 3)

    def test_deadline_kills_grandchild_that_keeps_stdout_open(self):
        with tempfile.TemporaryDirectory(prefix="ganso-capacity-deadline-") as raw:
            root = Path(raw).resolve()
            tick = root / "tick"
            grandchild = root / "grandchild.py"
            grandchild.write_text(
                "import pathlib,time\n"
                f"target=pathlib.Path({str(tick)!r})\n"
                "while True:\n"
                "    target.write_text(str(time.monotonic_ns()))\n"
                "    time.sleep(0.02)\n"
            )
            child = root / "child.py"
            child.write_text(
                f"import subprocess,sys\nsubprocess.Popen([sys.executable,{str(grandchild)!r}])\n"
            )
            began = time.monotonic()
            with self.assertRaisesRegex(SUBJECT.Refused, "COMMAND_TIMEOUT"):
                SUBJECT.Budget().run([sys.executable, str(child)], 0.5)
            self.assertLess(time.monotonic() - began, 3)
            self.assertTrue(tick.exists(), "grandchild must actually start")
            last_tick = tick.read_bytes()
            time.sleep(0.1)
            self.assertEqual(tick.read_bytes(), last_tick, "grandchild survived the budget")

    def test_output_flood_is_bounded(self):
        with self.assertRaisesRegex(SUBJECT.Refused, "COMMAND_OUTPUT_LIMIT"):
            SUBJECT.Budget().run([sys.executable, "-c", "print('x'*100000)"], 2)

    def test_spent_overall_budget_does_not_launch_a_command(self):
        budget = SUBJECT.Budget()
        budget.deadline = time.monotonic() - 1
        with self.assertRaisesRegex(SUBJECT.Refused, "PROBE_DEADLINE"):
            budget.run(["/this/executable/must/not/be/launched"])


class LocalStorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ganso-capacity-storage-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()

    def test_four_postgres_paths_on_one_device_produce_one_filesystem(self):
        volume = self.root / "docker-volume"
        for suffix in ("18/docker/pg_wal", "18/docker/base", "18/docker/global"):
            (volume / suffix).mkdir(parents=True)
        device = self.root.stat().st_dev
        device_name = f"{os.major(device)}:{os.minor(device)}"
        pg = {
            "mounts": [
                {
                    "Type": "volume",
                    "Name": "ganso-market_postgres_data",
                    "Source": str(volume),
                    "Destination": "/var/lib/postgresql",
                }
            ]
        }
        host_mounts = [
            {
                "device": device_name,
                "root": "/",
                "mountpoint": "/",
                "fstype": "fixturefs",
                "source": "/dev/fixture",
            }
        ]
        namespace_mounts = [
            {
                "device": device_name,
                "root": str(volume),
                "mountpoint": "/var/lib/postgresql",
                "fstype": "fixturefs",
                "source": "/dev/fixture",
            }
        ]
        result = SUBJECT.storage(pg, list(SUBJECT.PATHS.values()), host_mounts, namespace_mounts)
        self.assertEqual(len(result["targets"]), 4)
        self.assertEqual(len(result["filesystems"]), 1)
        keys = {target["filesystem"] for target in result["targets"].values()}
        self.assertEqual(keys, set(result["filesystems"]))
        local = os.statvfs(volume)
        measured = next(iter(result["filesystems"].values()))
        self.assertEqual(measured["total_bytes"], local.f_blocks * local.f_frsize)
        pg["mounts"][0]["Name"] = "another-volume"
        with self.assertRaisesRegex(SUBJECT.Refused, "STORAGE_DRIFT"):
            SUBJECT.storage(pg, list(SUBJECT.PATHS.values()), host_mounts, namespace_mounts)

    def test_wal_counts_only_regular_segment_files_without_recursive_scan(self):
        wal = self.root / "wal"
        wal.mkdir()
        (wal / "000000010000000000000001").write_bytes(b"a" * 10)
        (wal / "000000010000000000000002.partial").write_bytes(b"b" * 20)
        (wal / "unrelated").write_bytes(b"c" * 100)
        archived = wal / "archive_status"
        archived.mkdir()
        (archived / "000000010000000000000003").write_bytes(b"d" * 200)
        result = SUBJECT.wal_segments(wal)
        self.assertEqual((result["count"], result["bytes"], result["entries_seen"]), (2, 30, 4))
        outside = self.root / "outside"
        outside.write_text(SECRET)
        (wal / "000000010000000000000004").symlink_to(outside)
        with self.assertRaisesRegex(SUBJECT.Refused, "WAL_ENTRY_UNSAFE"):
            SUBJECT.wal_segments(wal)
        self.assertEqual(outside.read_text(), SECRET)

    def test_wal_enumeration_has_a_fixed_entry_ceiling(self):
        for number in range(257):
            (self.root / f"unrelated-{number:03d}").touch()
        with self.assertRaisesRegex(SUBJECT.Refused, "WAL_DIRECTORY_LIMIT"):
            SUBJECT.wal_segments(self.root)


if __name__ == "__main__":
    unittest.main()
