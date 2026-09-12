"""OPS-06 installer subprocess contracts; no host Docker/systemd is called.

The copied installer uses private fixture paths, the current UID in place of
root, and a trusted ancestor boundary at the temporary fixture. Its validation,
mutation ordering, target invocation and uninstall are otherwise unchanged.
Command fixtures record argv and model only install/systemctl effects.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
INSTALLER = REPO_ROOT / "deploy/install-recorder-watchdog-timer.sh"
UNITS = REPO_ROOT / "deploy/systemd"
SERVICE = "ganso-recorder-watchdog.service"
TIMER = "ganso-recorder-watchdog.timer"


class InstallerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.project = self.root / "checkout"
        self.source = self.project / "deploy"
        self.units = self.root / "systemd"
        self.state = self.root / "state"
        self.binaries = self.root / "bin"
        self.record = self.root / "commands.jsonl"
        for directory in (self.source / "systemd", self.units, self.binaries):
            directory.mkdir(parents=True, mode=0o700)
        self.environment = dict(os.environ, FAKE_COMMANDS=str(self.record))

        source = INSTALLER.read_text(encoding="utf-8")
        for production, fixture in (
            ("/opt/ganso-market", self.project),
            ("/etc/systemd/system", self.units),
            ("/var/lib/ganso/recorder-watchdog", self.state),
        ):
            source = source.replace(production, str(fixture))
        source = source.replace(
            "PATH=/usr/local/sbin:", f"PATH={self.binaries}:/usr/local/sbin:"
        ).replace("/usr/bin/python3", sys.executable)
        source = source.replace("required_owner = 0", "required_owner = os.getuid()")
        source = source.replace(
            "enumerate((path, *path.parents))",
            f"enumerate(part for part in (path, *path.parents) "
            f"if part == Path({str(self.root)!r}) or Path({str(self.root)!r}) in part.parents)",
        )
        self.installer = self.source / INSTALLER.name
        self.installer.write_text(source, encoding="utf-8")
        for unit in (SERVICE, TIMER):
            shutil.copyfile(UNITS / unit, self.source / "systemd" / unit)

        self.helper = self.source / "recorder_watchdog.py"
        self.helper.write_text(
            textwrap.dedent(
                """\
                import json, os, pathlib, sys
                with pathlib.Path(os.environ['FAKE_COMMANDS']).open('a') as output:
                    output.write(json.dumps(['check-target', *sys.argv[1:]]) + '\\n')
                sys.exit(int(os.environ.get('FAKE_TARGET_EXIT', '0')))
                """
            ),
            encoding="utf-8",
        )
        harness = self.binaries / "command-fixture"
        harness.write_text(
            f"#!{sys.executable}\n"
            + textwrap.dedent(
                """\
                import json, os, pathlib, shutil, sys
                command = pathlib.Path(sys.argv[0]).name
                args = sys.argv[1:]
                if command == 'id':
                    print(0)
                    sys.exit(0)
                with pathlib.Path(os.environ['FAKE_COMMANDS']).open('a') as output:
                    output.write(json.dumps([command, *args]) + '\\n')
                if command == 'systemctl':
                    if args[0] == 'show':
                        print(os.environ.get('FAKE_LOAD_STATE', 'loaded'))
                    elif args[0] == os.environ.get('FAKE_FAIL_COMMAND'):
                        sys.exit(1)
                elif command == 'install':
                    target = pathlib.Path(args[-1])
                    mode = int(args[args.index('-m') + 1], 8)
                    if '-d' in args:
                        target.mkdir(parents=True, exist_ok=True)
                    else:
                        shutil.copyfile(args[-2], target)
                    target.chmod(mode)
                """
            ),
            encoding="utf-8",
        )
        harness.chmod(0o755)
        for name in ("id", "systemctl", "install", "docker"):
            (self.binaries / name).symlink_to(harness)

    def run_installer(self, *args: str, check: bool = True):
        return subprocess.run(
            ["sh", str(self.installer), *args],
            capture_output=True,
            text=True,
            check=check,
            timeout=10,
            env=self.environment,
            cwd=self.project,
        )

    def commands(self) -> list[list[str]]:
        if not self.record.exists():
            return []
        return [json.loads(line) for line in self.record.read_text().splitlines()]

    def test_dry_run_lists_validation_before_activation_and_writes_nothing(self):
        before = set(self.root.rglob("*"))
        result = self.run_installer("--dry-run")
        self.assertEqual(before, set(self.root.rglob("*")))
        self.assertEqual(self.commands(), [])
        self.assertIn("--check-target", result.stdout)
        self.assertLess(result.stdout.index("--check-target"), result.stdout.index("install -d"))
        self.assertLess(result.stdout.index("install -d"), result.stdout.index("enable --now"))
        self.assertIn("0700", result.stdout)
        self.assertFalse(self.state.exists())

    def test_install_checks_exact_project_before_writes_and_enables_only_timer(self):
        self.run_installer()
        commands = self.commands()
        self.assertEqual(
            commands[0],
            [
                "check-target",
                "--project-dir",
                str(self.project),
                "--state-dir",
                str(self.state),
                "--check-target",
            ],
        )
        self.assertEqual(
            commands[-2:],
            [
                ["systemctl", "daemon-reload"],
                ["systemctl", "enable", "--now", TIMER],
            ],
        )
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.units / SERVICE).read_bytes(), (UNITS / SERVICE).read_bytes())
        self.assertEqual((self.units / TIMER).read_bytes(), (UNITS / TIMER).read_bytes())
        self.assertFalse(any(SERVICE in call and "enable" in call for call in commands))

    def test_refused_or_ambiguous_target_never_creates_state_or_units(self):
        self.environment["FAKE_TARGET_EXIT"] = "1"
        result = self.run_installer(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.commands()), 1)
        self.assertEqual(self.commands()[0][0], "check-target")
        self.assertFalse(self.state.exists())
        self.assertEqual(list(self.units.iterdir()), [])

    def test_missing_or_unsafe_source_fails_before_target_probe(self):
        self.helper.chmod(0o666)
        result = self.run_installer(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("root", result.stderr)
        self.assertEqual(self.commands(), [])
        self.helper.unlink()
        result = self.run_installer("--dry-run", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("arquivo obrigatório ausente", result.stderr)

    def test_symlink_state_is_rejected_without_modifying_its_target(self):
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir(mode=0o700)
        self.state.symlink_to(elsewhere, target_is_directory=True)
        result = self.run_installer(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("symlink recusado", result.stderr)
        self.assertEqual(self.commands(), [])
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_uninstall_stops_both_units_before_removal_and_preserves_evidence(self):
        self.run_installer()
        evidence = self.state / "incident.json"
        maintenance = self.state / "maintenance"
        evidence.write_text('{"reason":"fixture"}')
        maintenance.touch()
        unrelated = self.units / "other.service"
        unrelated.write_text("unrelated")
        self.record.unlink()
        self.helper.unlink()  # Removal remains possible after a broken deploy.
        self.run_installer("--uninstall")
        self.assertEqual(
            self.commands(),
            [
                ["systemctl", "disable", "--now", TIMER],
                ["systemctl", "stop", SERVICE],
                ["systemctl", "daemon-reload"],
            ],
        )
        self.assertEqual(list(self.units.iterdir()), [unrelated])
        self.assertEqual(evidence.read_text(), '{"reason":"fixture"}')
        self.assertTrue(maintenance.exists())

    def test_failed_shutdown_keeps_units_and_reports_failure(self):
        self.run_installer()
        self.environment["FAKE_FAIL_COMMAND"] = "stop"
        result = self.run_installer("--uninstall", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.units / SERVICE).exists())
        self.assertTrue((self.units / TIMER).exists())
        self.assertEqual(
            self.commands()[-1],
            [
                "systemctl",
                "show",
                "--property=LoadState",
                "--value",
                SERVICE,
            ],
        )

    def test_uninstall_dry_run_names_shutdown_order_and_preserves_units(self):
        self.run_installer()
        before = {path: path.read_bytes() for path in self.units.iterdir()}
        self.record.unlink()
        result = self.run_installer("--uninstall", "--dry-run")
        self.assertLess(result.stdout.index("disable --now"), result.stdout.index("systemctl stop"))
        self.assertLess(result.stdout.index("systemctl stop"), result.stdout.index("rm -f"))
        self.assertEqual(self.commands(), [])
        self.assertEqual(before, {path: path.read_bytes() for path in self.units.iterdir()})

    def test_unknown_argument_fails_without_effects(self):
        result = self.run_installer("--force", check=False)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.commands(), [])


class SystemdContractTests(unittest.TestCase):
    def test_service_bounds_children_and_skips_explicit_maintenance(self):
        service = (UNITS / SERVICE).read_text()
        for setting in (
            "Type=oneshot",
            "User=root",
            "Group=root",
            "UMask=0077",
            "TimeoutStartSec=70s",
            "TimeoutStopSec=5s",
            "KillMode=control-group",
            "SendSIGKILL=yes",
            "Restart=no",
            "MemoryMax=128M",
            "CPUQuota=10%",
            "TasksMax=32",
            "ProtectSystem=strict",
            "NoNewPrivileges=true",
            "ReadWritePaths=/var/lib/ganso/recorder-watchdog",
            "ConditionPathExists=!/var/lib/ganso/recorder-watchdog/maintenance",
            "StandardOutput=journal",
            "LogRateLimitBurst=5",
        ):
            self.assertIn(setting + "\n", service)
        self.assertIn(
            "ExecStart=/usr/bin/python3 -I /opt/ganso-market/deploy/recorder_watchdog.py ", service
        )
        self.assertNotIn("ExecStop=", service)
        self.assertNotIn("EnvironmentFile=", service)
        self.assertNotIn("--check-target", service)

    def test_timer_activates_only_the_recorder_watchdog(self):
        timer = (UNITS / TIMER).read_text()
        self.assertIn("OnUnitInactiveSec=30s\n", timer)
        self.assertIn("OnBootSec=2min\n", timer)
        self.assertIn("Persistent=false\n", timer)
        self.assertIn("Unit=" + SERVICE + "\n", timer)
        self.assertIn("WantedBy=timers.target\n", timer)


if __name__ == "__main__":
    unittest.main()
