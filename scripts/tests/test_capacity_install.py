"""DATA-01 installer contracts using a private tree; no Docker/systemd/SSH.

The production trust checks run within the temporary fixture, including its
root. Only ancestors outside that fixture are excluded, as in the watchdog
installer tests. CLI subprocess execution is mocked, never sent to a host.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
REVISION = "a" * 40
NOW = 1_800_000_000


def load_helper(name):
    path = REPO / "deploy" / (name + ".py")
    module = types.ModuleType(name)
    module.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), "exec"), module.__dict__)
    return module


class CapacityInstallerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.source = self.root / "source"
        self.target = self.root / "deploy"
        self.state = self.root / "state"
        for directory in (self.source, self.target, self.state):
            directory.mkdir(mode=0o700)
        self.helper = load_helper("install_capacity_series")
        trusted = self.helper.trusted

        def fixture_trusted(path, uid, directory=False):
            if path == self.root or self.root in path.parents:
                trusted(path, uid, directory)

        trust_patch = patch.object(self.helper, "trusted", side_effect=fixture_trusted)
        trust_patch.start()
        self.addCleanup(trust_patch.stop)
        self.old = b"# Previous reviewed watchdog\nVERSION = 1\n"
        self.data = {
            "capacity_series.py": b"# Reviewed collector\nVERSION = 1\n",
            "recorder_watchdog.py": b"# Reviewed hook\nVERSION = 2\n",
        }
        self.watchdog = self.target / "recorder_watchdog.py"
        self.watchdog.write_bytes(self.old)
        for name, data in self.data.items():
            (self.source / name).write_bytes(data)
        self.before_sha = hashlib.sha256(self.old).hexdigest()
        self.hashes = {name: hashlib.sha256(data).hexdigest() for name, data in self.data.items()}
        self.evidence = self.state / "capacity-series-install"
        self.backup = self.evidence / "before-recorder_watchdog.py"

    def install(self, **kwargs):
        return self.helper.install(
            self.source,
            self.target,
            self.state,
            REVISION,
            self.before_sha,
            self.hashes,
            **kwargs,
        )

    def snapshot(self):
        result = {}
        for path in (self.root, *sorted(self.root.rglob("*"))):
            info = path.lstat()
            if path.is_symlink():
                value = ("symlink", os.readlink(path))
            elif path.is_dir():
                value = ("directory",)
            else:
                value = ("file", info.st_nlink, path.read_bytes())
            result[str(path.relative_to(self.root))] = (info.st_mode, value)
        return result

    def assert_refused_without_mutation(self, reason, exception=ValueError):
        before = self.snapshot()
        with (
            patch.object(self.helper, "put", wraps=self.helper.put) as put,
            self.assertRaisesRegex(exception, reason),
        ):
            self.install()
        put.assert_not_called()
        self.assertEqual(self.snapshot(), before)

    def test_dry_run_returns_exact_hashes_without_any_writes_or_commands(self):
        before = self.snapshot()
        with (
            patch.object(self.helper, "put") as put,
            patch.object(self.helper.subprocess, "run") as command,
        ):
            record = self.install(dry_run=True)
        self.assertEqual(record["revision"], REVISION)
        self.assertEqual(record["before_watchdog_sha256"], self.before_sha)
        self.assertEqual(record["files"], self.hashes)
        put.assert_not_called()
        command.assert_not_called()
        self.assertEqual(self.snapshot(), before)

    def test_install_copies_exact_bytes_and_keeps_original_backup(self):
        result = self.install()
        for name, data in self.data.items():
            self.assertEqual((self.target / name).read_bytes(), data)
            self.assertEqual((self.target / name).stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.backup.read_bytes(), self.old)
        self.assertEqual(self.backup.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.evidence.stat().st_mode & 0o777, 0o700)
        self.assertEqual(json.loads((self.evidence / "installation.json").read_text()), result)

    def test_dependency_is_present_before_watchdog_hook_is_replaced(self):
        original_put = self.helper.put
        targets = []

        def record_put(path, data):
            targets.append(path)
            if path == self.watchdog:
                self.assertEqual(
                    (self.target / "capacity_series.py").read_bytes(),
                    self.data["capacity_series.py"],
                )
                self.assertEqual(self.backup.read_bytes(), self.old)
            return original_put(path, data)

        with patch.object(self.helper, "put", side_effect=record_put):
            self.install()
        self.assertLess(targets.index(self.backup), targets.index(self.watchdog))
        self.assertLess(
            targets.index(self.target / "capacity_series.py"), targets.index(self.watchdog)
        )

    def test_watchdog_drift_refuses_before_mutation(self):
        self.watchdog.write_bytes(b"# Unreviewed host edit\n")
        self.assert_refused_without_mutation("WATCHDOG_DRIFT")

    def test_symlink_watchdog_refuses_without_touching_its_target(self):
        elsewhere = self.root / "original"
        self.watchdog.rename(elsewhere)
        self.watchdog.symlink_to(elsewhere)
        self.assert_refused_without_mutation("UNTRUSTED_PATH")

    def test_hardlinked_watchdog_refuses_before_mutation(self):
        os.link(self.watchdog, self.root / "other-watchdog")
        self.assert_refused_without_mutation("UNTRUSTED_PATH")

    def test_source_hash_mismatch_refuses_before_mutation(self):
        (self.source / "capacity_series.py").write_bytes(b"VERSION = 9000\n")
        self.assert_refused_without_mutation("SOURCE_HASH_MISMATCH")

    def test_matching_hash_does_not_allow_malformed_python(self):
        data = b"def broken(:\n"
        (self.source / "capacity_series.py").write_bytes(data)
        self.hashes["capacity_series.py"] = hashlib.sha256(data).hexdigest()
        self.assert_refused_without_mutation("invalid syntax", SyntaxError)

    def test_oversized_source_refuses_before_mutation(self):
        data = b"#" + b"x" * self.helper.MAX_SOURCE_BYTES
        (self.source / "capacity_series.py").write_bytes(data)
        self.hashes["capacity_series.py"] = hashlib.sha256(data).hexdigest()
        self.assert_refused_without_mutation("SOURCE_LIMIT")

    def test_symlink_source_refuses_before_mutation(self):
        path = self.source / "capacity_series.py"
        elsewhere = self.root / "collector"
        path.rename(elsewhere)
        path.symlink_to(elsewhere)
        self.assert_refused_without_mutation("UNTRUSTED_PATH")

    def test_hardlinked_source_refuses_before_mutation(self):
        os.link(self.source / "capacity_series.py", self.root / "collector")
        self.assert_refused_without_mutation("UNTRUSTED_PATH")

    def test_writable_source_ancestor_refuses_before_mutation(self):
        self.source.chmod(0o777)
        self.assert_refused_without_mutation("UNTRUSTED_PATH")

    def test_backup_mismatch_refuses_before_mutation(self):
        self.evidence.mkdir(mode=0o700)
        self.backup.write_bytes(b"# A different original\n")
        self.assert_refused_without_mutation("BACKUP_DRIFT")

    def test_symlink_backup_refuses_before_mutation(self):
        self.evidence.mkdir(mode=0o700)
        self.backup.symlink_to(self.watchdog)
        self.assert_refused_without_mutation("UNTRUSTED_PATH")

    def test_hardlinked_backup_refuses_before_mutation(self):
        self.evidence.mkdir(mode=0o700)
        self.backup.write_bytes(self.old)
        os.link(self.backup, self.root / "another-backup")
        self.assert_refused_without_mutation("UNTRUSTED_PATH")

    def test_changed_collector_refuses_before_mutation(self):
        (self.target / "capacity_series.py").write_bytes(b"# Another collector\n")
        self.assert_refused_without_mutation("COLLECTOR_ALREADY_DIFFERENT")

    def test_already_updated_watchdog_requires_original_backup(self):
        self.watchdog.write_bytes(self.data["recorder_watchdog.py"])
        self.assert_refused_without_mutation("ORIGINAL_BACKUP_MISSING")

    def test_symlink_manifest_refuses_before_installing_any_file(self):
        self.evidence.mkdir(mode=0o700)
        (self.evidence / "installation.json").symlink_to(self.watchdog)
        self.assert_refused_without_mutation("UNTRUSTED_PATH")

    def test_reinstallation_preserves_backup_and_does_not_extend_series(self):
        collector = load_helper("capacity_series")
        self.install()
        first = collector.start_series(self.state / "capacity-series", NOW)
        series_path = self.state / "capacity-series" / "series.json"
        series_bytes = series_path.read_bytes()
        backup_stat = self.backup.stat()
        original_put = self.helper.put
        with patch.object(self.helper, "put", wraps=original_put) as put:
            self.install()
        self.assertEqual(
            [call.args[0] for call in put.call_args_list],
            [self.evidence / "installation.json"],
        )
        self.assertEqual(self.backup.read_bytes(), self.old)
        self.assertEqual(self.backup.stat().st_ino, backup_stat.st_ino)
        self.assertEqual(self.backup.stat().st_mtime_ns, backup_stat.st_mtime_ns)
        resumed = collector.start_series(self.state / "capacity-series", NOW + 2 * collector.DAY)
        self.assertEqual(resumed, first)
        self.assertEqual(series_path.read_bytes(), series_bytes)
        self.assertEqual(first["start_epoch"], NOW)
        self.assertEqual(first["last_slot_due_utc"], collector.utc(NOW + 7 * collector.DAY))

    def test_cli_calls_only_bounded_series_start_after_successful_install(self):
        argv = [
            "install_capacity_series.py",
            "--source-dir",
            str(self.source),
            "--revision",
            REVISION,
            "--before-watchdog-sha256",
            self.before_sha,
            "--collector-sha256",
            self.hashes["capacity_series.py"],
            "--watchdog-sha256",
            self.hashes["recorder_watchdog.py"],
        ]
        for dry_run in (False, True):
            with (
                self.subTest(dry_run=dry_run),
                patch("sys.argv", argv + (["--dry-run"] if dry_run else [])),
                patch.object(self.helper, "TARGET", self.target),
                patch.object(self.helper, "STATE", self.state),
                patch.object(self.helper.os, "geteuid", return_value=0),
                patch.object(self.helper, "install", return_value={}) as install,
                patch.object(self.helper.subprocess, "run") as command,
                contextlib.redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(self.helper.main(), 0)
                install.assert_called_once_with(
                    self.source,
                    self.target,
                    self.state,
                    REVISION,
                    self.before_sha,
                    self.hashes,
                    dry_run=dry_run,
                )
                if dry_run:
                    command.assert_not_called()
                else:
                    command.assert_called_once_with(
                        [
                            "/usr/bin/python3",
                            "-I",
                            str(self.target / "capacity_series.py"),
                            "--start",
                        ],
                        check=True,
                        timeout=3,
                    )


if __name__ == "__main__":
    unittest.main()
