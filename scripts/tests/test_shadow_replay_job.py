"""The RFC-029 shadow-replay job: what it writes, what it never writes.

The job is a shell script that redirects a read-only CLI's stdout into a file.
Almost nothing can go wrong with that -- except the three things that would go
wrong silently, at 03:30 UTC, with nobody watching:

1. A reader opening ``latest-B.json`` while it is being written and getting half
   a document. These tests hold a fake CLI open mid-output and check what the
   directory looks like at that exact moment.

2. Retention deleting the wrong thing. The RFC forbids ``rm dir/*.json`` and
   forbids touching the parent: every removal names one file. These tests put a
   symlink, a subdirectory, a ``latest-*.json`` and a stray temporary next to
   the dated runs and check that all of them survive.

3. A failed round overwriting the last good one, so the screen shows yesterday's
   numbers as today's. Failure is read off the EXIT STATUS, because
   ``message`` is fixed at ``shadow_replay_failed`` while ``reason_code``
   varies (``shadow-replay-cli.ts:809-815``).

The CLI is faked throughout. Nothing here reaches Docker, the server, or the
database -- and the script's only seam for the fake is which executable it
calls, so the paths, the renames, the retention and the error file are the same
code the server runs.
"""

from __future__ import annotations

import datetime
import importlib.util
import json
import os
import re
import subprocess
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
RUN_SCRIPT = REPO_ROOT / "deploy" / "shadow-replay-run.sh"
INSTALL_SCRIPT = REPO_ROOT / "deploy" / "install-shadow-replay-timer.sh"
HELPER = REPO_ROOT / "deploy" / "shadow_replay_job.py"
UNIT_DIR = REPO_ROOT / "deploy" / "systemd"
SERVICE = UNIT_DIR / "ganso-shadow-replay.service"
TIMER = UNIT_DIR / "ganso-shadow-replay.timer"
COMPOSE = REPO_ROOT / "docker-compose.yml"

MOUNT_PATH = "/var/lib/ganso/shadow-replay"


def load_helper():
    spec = importlib.util.spec_from_file_location("shadow_replay_job", HELPER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


helper = load_helper()


def write_fake_cli(directory: Path, body: str) -> Path:
    """A stand-in for `docker compose exec -T api node shadow-replay-cli.js`.

    It receives the same argv the real CLI would, so a test can assert on the
    mode, the window and the sweep values as well as on the files.
    """
    path = directory / "fake-cli.py"
    path.write_text(
        textwrap.dedent(
            """\
            #!/usr/bin/env python3
            import json, os, pathlib, sys, time
            argv = sys.argv[1:]
            record = pathlib.Path(os.environ["FAKE_CLI_ARGV"])
            with record.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(argv) + "\\n")
            """
        )
        + textwrap.dedent(body),
        encoding="utf-8",
    )
    path.chmod(0o755)
    return path


def run_job(
    data_dir: Path,
    cli: Path,
    argv_record: Path,
    *,
    args: tuple[str, ...] = (),
    keep: str | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    environment = dict(os.environ)
    environment["GANSO_SHADOW_REPLAY_DIR"] = str(data_dir)
    environment["GANSO_SHADOW_REPLAY_CLI"] = str(cli)
    environment["FAKE_CLI_ARGV"] = str(argv_record)
    if keep is not None:
        environment["GANSO_SHADOW_REPLAY_KEEP"] = keep
    return subprocess.run(
        ["sh", str(RUN_SCRIPT), *args],
        check=check,
        capture_output=True,
        text=True,
        env=environment,
        cwd=REPO_ROOT,
    )


def dated_files(directory: Path, mode: str) -> list[str]:
    pattern = re.compile(rf"^\d{{4}}-\d{{2}}-\d{{2}}-{mode}\.json$")
    return sorted(entry.name for entry in directory.iterdir() if pattern.match(entry.name))


SUCCESS_BODY = """
payload = {"status": "ok", "command": argv[0], "argv": argv}
sys.stdout.write(json.dumps(payload) + "\\n")
"""

# The shape the real CLI's `run().catch` writes: a single JSON line on stderr,
# `message` fixed and `reason_code` varying, and exit status 1.
FAILURE_BODY = """
sys.stderr.write(json.dumps({
    "level": "error",
    "service": "shadow-replay-cli",
    "reason_code": "SWEEP_KEY_REFUSED",
    "detail": 'chave "costs.edgeLiqMin" recusada: aspas " e chaves {} no texto',
    "message": "shadow_replay_failed",
}) + "\\n")
sys.exit(1)
"""


class DryRunTests(unittest.TestCase):
    def test_dry_run_prints_the_commands_and_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            data_dir = root / "nao-existe"
            cli = write_fake_cli(root, SUCCESS_BODY)
            record = root / "argv.jsonl"

            result = run_job(data_dir, cli, record, args=("--dry-run",))

            self.assertIn("source-replay", result.stdout)
            self.assertIn("sweep costs.edgeLiqMin", result.stdout)
            self.assertIn("--values 0.01,0.015,0.02,0.03", result.stdout)
            self.assertFalse(
                data_dir.exists(),
                "--dry-run must not even create the data directory",
            )
            self.assertFalse(record.exists(), "--dry-run must not execute the CLI at all")

    def test_installer_dry_run_changes_nothing_and_names_every_step(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            unit_dir = root / "systemd"
            environment = dict(os.environ)
            environment["GANSO_SYSTEMD_UNIT_DIR"] = str(unit_dir)
            environment["GANSO_SHADOW_REPLAY_DIR"] = str(root / "dados")

            result = subprocess.run(
                ["sh", str(INSTALL_SCRIPT), "--dry-run"],
                check=True,
                capture_output=True,
                text=True,
                env=environment,
                cwd=REPO_ROOT,
            )

            self.assertIn("systemctl daemon-reload", result.stdout)
            self.assertIn("systemctl enable --now", result.stdout)
            self.assertIn("ganso-shadow-replay.service", result.stdout)
            self.assertIn("ganso-shadow-replay.timer", result.stdout)
            self.assertFalse(unit_dir.exists())
            self.assertFalse((root / "dados").exists())

    def test_the_installer_rejects_an_unknown_flag(self) -> None:
        result = subprocess.run(
            ["sh", str(INSTALL_SCRIPT), "--force"],
            check=False,
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
        )
        self.assertEqual(result.returncode, 2)


class SuccessfulRoundTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.data_dir = self.root / "shadow-replay"
        self.cli = write_fake_cli(self.root, SUCCESS_BODY)
        self.record = self.root / "argv.jsonl"

    def test_it_writes_both_modes_and_both_latest_pointers(self) -> None:
        run_job(self.data_dir, self.cli, self.record)

        for mode in ("A", "B"):
            dated = dated_files(self.data_dir, mode)
            self.assertEqual(len(dated), 1, f"one dated file for mode {mode}")
            latest = self.data_dir / f"latest-{mode}.json"
            self.assertTrue(latest.is_file())
            self.assertEqual(
                latest.read_bytes(),
                (self.data_dir / dated[0]).read_bytes(),
                "latest must be byte-identical to the dated run it points at",
            )
            json.loads(latest.read_text(encoding="utf-8"))

    def test_no_temporary_file_survives_a_good_round(self) -> None:
        run_job(self.data_dir, self.cli, self.record)
        leftovers = [
            entry.name for entry in self.data_dir.iterdir() if entry.name.startswith(".tmp")
        ]
        self.assertEqual(leftovers, [])

    def test_mode_b_asks_for_a_seventy_two_hour_window_in_json(self) -> None:
        before = datetime.datetime.now(datetime.timezone.utc)
        run_job(self.data_dir, self.cli, self.record)
        after = datetime.datetime.now(datetime.timezone.utc)

        calls = [json.loads(line) for line in self.record.read_text(encoding="utf-8").splitlines()]
        self.assertEqual([call[0] for call in calls], ["source-replay", "sweep"])

        replay = calls[0]
        self.assertIn("--format", replay)
        self.assertEqual(replay[replay.index("--format") + 1], "json")
        opened = datetime.datetime.strptime(
            replay[replay.index("--from") + 1], "%Y-%m-%dT%H:%M:%SZ"
        ).replace(tzinfo=datetime.timezone.utc)
        # P4 as proposed: 72 h. Bounded on both sides by the wall clock around
        # the run, so a unit change (72 minutes, 72 days) fails here.
        # The instant is printed to whole seconds, so it can land up to a second
        # ahead of a microsecond-precision reading of the same clock.
        self.assertLessEqual(before - datetime.timedelta(hours=72, seconds=1), opened)
        self.assertGreaterEqual(after - datetime.timedelta(hours=72), opened)
        # No --to: the window ends now, which is what "as of the run" means.
        self.assertNotIn("--to", replay)

        sweep = calls[1]
        self.assertEqual(sweep[1], "costs.edgeLiqMin")
        self.assertEqual(sweep[sweep.index("--values") + 1], "0.01,0.015,0.02,0.03")

    def test_a_good_round_clears_the_previous_failure_marker(self) -> None:
        self.data_dir.mkdir(parents=True)
        stale = self.data_dir / "latest-B.error.json"
        stale.write_text('{"status":"error"}', encoding="utf-8")

        run_job(self.data_dir, self.cli, self.record)

        self.assertFalse(stale.exists())


class AtomicityTests(unittest.TestCase):
    """`latest-B.json` is complete or absent -- never a prefix of itself."""

    def test_the_reader_never_sees_a_partial_latest(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            data_dir = root / "shadow-replay"
            data_dir.mkdir(parents=True)
            good = b'{"status": "ok", "rodada": "ontem"}\n'
            (data_dir / "latest-B.json").write_bytes(good)

            halfway = root / "halfway"
            go = root / "go"
            cli = write_fake_cli(
                root,
                f"""
                if argv[0] == "source-replay":
                    sys.stdout.write('{{"status": "ok", "parte": 1, "enchimento": "')
                    sys.stdout.write("x" * 50000)
                    sys.stdout.flush()
                    pathlib.Path({str(halfway)!r}).write_text("agora")
                    while not pathlib.Path({str(go)!r}).exists():
                        time.sleep(0.01)
                    sys.stdout.write('"}}\\n')
                else:
                    sys.stdout.write(json.dumps({{"status": "ok"}}) + "\\n")
                """,
            )

            environment = dict(os.environ)
            environment["GANSO_SHADOW_REPLAY_DIR"] = str(data_dir)
            environment["GANSO_SHADOW_REPLAY_CLI"] = str(cli)
            environment["FAKE_CLI_ARGV"] = str(root / "argv.jsonl")
            job = subprocess.Popen(
                ["sh", str(RUN_SCRIPT)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=environment,
                cwd=REPO_ROOT,
            )
            self.addCleanup(job.kill)
            self.addCleanup(lambda: (job.stdout.close(), job.stderr.close()))

            deadline = time.monotonic() + 30
            while not halfway.exists() and time.monotonic() < deadline:
                self.assertIsNone(job.poll(), "the job exited before writing anything")
                time.sleep(0.01)
            self.assertTrue(halfway.exists(), "the fake CLI never reached halfway")

            # The moment of truth: 50 kB of the new document have been written
            # and the round is not finished.
            self.assertEqual(
                (data_dir / "latest-B.json").read_bytes(),
                good,
                "latest-B.json changed before the round finished",
            )
            self.assertEqual(
                dated_files(data_dir, "B"),
                [],
                "the dated file appeared before the round finished",
            )
            partial = [
                entry
                for entry in data_dir.iterdir()
                if entry.name.startswith(".tmp-B-") and entry.name.endswith(".json")
            ]
            self.assertTrue(
                partial,
                "the partial output must exist under a temporary name, in this "
                "directory, so the rename that publishes it is atomic",
            )
            self.assertGreater(partial[0].stat().st_size, 1000)

            go.write_text("vai")
            job.wait(timeout=60)
            self.assertEqual(job.returncode, 0)

            published = (data_dir / "latest-B.json").read_bytes()
            self.assertNotEqual(published, good)
            self.assertEqual(json.loads(published)["parte"], 1)


class RetentionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.data_dir = self.root / "shadow-replay"
        self.data_dir.mkdir(parents=True)
        self.cli = write_fake_cli(self.root, SUCCESS_BODY)
        self.record = self.root / "argv.jsonl"

    def test_only_the_oldest_over_the_limit_goes_and_bystanders_stay(self) -> None:
        for day in range(1, 6):
            for mode in ("A", "B"):
                (self.data_dir / f"2026-01-0{day}-{mode}.json").write_text("{}", encoding="utf-8")
        keeper = self.data_dir / "latest-B.json"
        keeper.write_text('{"velho": true}', encoding="utf-8")
        bystanders = {
            "notas.txt": "nada a ver",
            ".tmp-B-999.json": "restos de uma queda",
            "2026-01-06-C.json": "modo que nao existe",
        }
        for name, body in bystanders.items():
            (self.data_dir / name).write_text(body, encoding="utf-8")
        (self.data_dir / "subdir").mkdir()
        (self.data_dir / "atalho-B.json").symlink_to(self.data_dir / "2026-01-01-B.json")

        run_job(self.data_dir, self.cli, self.record, keep="3")

        # Five seeded plus today's, minus the three oldest by NAME.
        remaining = dated_files(self.data_dir, "B")
        self.assertEqual(len(remaining), 3)
        self.assertNotIn("2026-01-01-B.json", remaining)
        self.assertNotIn("2026-01-02-B.json", remaining)
        self.assertNotIn("2026-01-03-B.json", remaining)
        self.assertIn("2026-01-04-B.json", remaining)
        self.assertIn("2026-01-05-B.json", remaining)

        for name, body in bystanders.items():
            path = self.data_dir / name
            if name == ".tmp-B-999.json":
                # The job clears its OWN temporaries by exact name on the way in.
                continue
            self.assertTrue(path.is_file(), f"{name} was deleted")
            self.assertEqual(path.read_text(encoding="utf-8"), body)
        self.assertTrue((self.data_dir / "subdir").is_dir())
        self.assertTrue((self.data_dir / "atalho-B.json").is_symlink())
        self.assertTrue(self.data_dir.is_dir())

    def test_thirty_one_files_lose_exactly_the_oldest_one(self) -> None:
        # The RFC's own wording: keep 30, so the 31st oldest is the only one
        # that goes. Written as a direct call because building 31 real rounds
        # through the shell would prove the same thing more slowly.
        for day in range(1, 32):
            (self.data_dir / f"2026-01-{day:02d}-B.json").write_text("{}", encoding="utf-8")

        plan = helper.retention_plan(self.data_dir, "B", 30)

        self.assertEqual(plan, ["2026-01-01-B.json"])

    def test_thirty_files_lose_nothing(self) -> None:
        for day in range(1, 31):
            (self.data_dir / f"2026-01-{day:02d}-B.json").write_text("{}", encoding="utf-8")
        self.assertEqual(helper.retention_plan(self.data_dir, "B", 30), [])

    def test_the_plan_never_names_anything_but_a_dated_run(self) -> None:
        (self.data_dir / "latest-B.json").write_text("{}", encoding="utf-8")
        (self.data_dir / "latest-B.error.json").write_text("{}", encoding="utf-8")
        (self.data_dir / "2026-01-01-A.json").write_text("{}", encoding="utf-8")
        (self.data_dir / "2026-01-01-B.json.bak").write_text("{}", encoding="utf-8")
        (self.data_dir / "..").resolve()
        (self.data_dir / "sub").mkdir()
        (self.data_dir / "2026-01-02-B.json").symlink_to(self.data_dir / "sub")
        (self.data_dir / "2026-01-03-B.json").write_text("{}", encoding="utf-8")

        plan = helper.retention_plan(self.data_dir, "B", 0 + 1)

        # Only one candidate was ever eligible, so nothing is deleted -- and in
        # particular the symlink named like a dated run is not.
        self.assertEqual(plan, [])
        for name in plan:
            self.assertRegex(name, r"^\d{4}-\d{2}-\d{2}-B\.json$")


class FailureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.data_dir = self.root / "shadow-replay"
        self.data_dir.mkdir(parents=True)
        self.record = self.root / "argv.jsonl"
        self.good = b'{"status": "ok", "rodada": "ontem"}\n'
        (self.data_dir / "latest-B.json").write_bytes(self.good)

    def test_a_failed_round_writes_an_error_file_and_keeps_the_good_one(self) -> None:
        cli = write_fake_cli(self.root, FAILURE_BODY)

        result = run_job(self.data_dir, cli, self.record, check=False)

        self.assertNotEqual(result.returncode, 0, "the unit must record a failure")
        self.assertIn("shadow_replay_failed", result.stdout + result.stderr)

        self.assertEqual(
            (self.data_dir / "latest-B.json").read_bytes(),
            self.good,
            "a failed round must not touch the last good round",
        )
        self.assertEqual(dated_files(self.data_dir, "B"), [])

        failure = json.loads((self.data_dir / "latest-B.error.json").read_text(encoding="utf-8"))
        self.assertEqual(failure["status"], "error")
        self.assertEqual(failure["mode"], "B")
        self.assertEqual(failure["exit_status"], 1)
        self.assertEqual(failure["message"], "shadow_replay_failed")
        # The varying half, lifted out of the CLI's own line rather than guessed.
        self.assertEqual(failure["reason_code"], "SWEEP_KEY_REFUSED")
        # Captured verbatim, escaping and all: the round trip is the proof that
        # a `detail` full of quotes and braces cannot break the document the
        # screen has to parse on the worst morning.
        captured = json.loads(failure["stderr"])
        self.assertEqual(
            captured["detail"],
            'chave "costs.edgeLiqMin" recusada: aspas " e chaves {} no texto',
        )

        # Both modes are attempted: mode B failing must not cancel mode A.
        self.assertTrue((self.data_dir / "latest-A.error.json").is_file())
        self.assertEqual(len(self.record.read_text(encoding="utf-8").splitlines()), 2)

    def test_a_crash_with_no_structured_line_still_names_a_reason(self) -> None:
        cli = write_fake_cli(
            self.root,
            """
            sys.stderr.write("Segmentation fault\\n")
            sys.exit(139)
            """,
        )

        run_job(self.data_dir, cli, self.record, check=False)

        failure = json.loads((self.data_dir / "latest-B.error.json").read_text(encoding="utf-8"))
        self.assertEqual(failure["reason_code"], "SHADOW_REPLAY_FAILED")
        self.assertEqual(failure["exit_status"], 139)
        self.assertEqual(failure["stderr"], "Segmentation fault\n")

    def test_a_second_failure_replaces_the_first_and_still_spares_the_good(self) -> None:
        cli = write_fake_cli(self.root, FAILURE_BODY)
        run_job(self.data_dir, cli, self.record, check=False)
        run_job(self.data_dir, cli, self.record, check=False)

        self.assertEqual((self.data_dir / "latest-B.json").read_bytes(), self.good)
        json.loads((self.data_dir / "latest-B.error.json").read_text(encoding="utf-8"))


class ErrorDocumentTests(unittest.TestCase):
    def test_the_last_structured_line_wins(self) -> None:
        stderr = "\n".join(
            [
                "aviso solto",
                json.dumps({"reason_code": "PRIMEIRO"}),
                "ruído",
                json.dumps({"reason_code": "ULTIMO", "message": "shadow_replay_failed"}),
            ]
        )
        self.assertEqual(helper.reason_code(stderr), "ULTIMO")

    def test_a_broken_line_does_not_take_the_document_down(self) -> None:
        self.assertEqual(helper.reason_code('{"reason_code": '), "SHADOW_REPLAY_FAILED")
        self.assertEqual(helper.reason_code(""), "SHADOW_REPLAY_FAILED")
        self.assertEqual(helper.reason_code("[1,2,3]"), "SHADOW_REPLAY_FAILED")

    def test_a_huge_stderr_is_truncated_and_says_so(self) -> None:
        document = helper.error_document(
            mode="B",
            run_date="2026-09-09",
            status=1,
            generated_at="2026-09-09T03:40:00Z",
            stderr_text="x" * (helper.MAX_STDERR_BYTES + 10),
        )
        self.assertTrue(document["stderr_truncated"])
        self.assertEqual(len(document["stderr"]), helper.MAX_STDERR_BYTES)
        json.dumps(document)


class UnitFileTests(unittest.TestCase):
    def test_the_service_runs_the_versioned_script_from_the_checkout(self) -> None:
        text = SERVICE.read_text(encoding="utf-8")
        self.assertIn("ExecStart=/opt/ganso-market/deploy/shadow-replay-run.sh", text)
        self.assertIn("WorkingDirectory=/opt/ganso-market", text)
        self.assertIn("Type=oneshot", text)

    def test_the_service_outlives_the_measured_seven_hundred_and_ten_seconds(
        self,
    ) -> None:
        text = SERVICE.read_text(encoding="utf-8")
        match = re.search(r"^TimeoutStartSec=(\d+)$", text, re.MULTILINE)
        self.assertIsNotNone(match)
        assert match is not None
        self.assertGreater(int(match.group(1)), 900)

    def test_the_timer_fires_at_the_approved_hour_and_does_not_catch_up(self) -> None:
        text = TIMER.read_text(encoding="utf-8")
        self.assertIn("OnCalendar=*-*-* 03:30:00 UTC", text)
        # A catch-up run would fire at whatever hour the machine rebooted, which
        # is precisely the load window P4 chose 03:30Z to avoid.
        self.assertIn("Persistent=false", text)
        self.assertIn("WantedBy=timers.target", text)

    def test_the_units_never_name_a_write_path_outside_the_data_directory(
        self,
    ) -> None:
        text = SERVICE.read_text(encoding="utf-8")
        writable = re.findall(r"^ReadWritePaths=(.+)$", text, re.MULTILINE)
        self.assertEqual(writable, [MOUNT_PATH])


class ComposeTests(unittest.TestCase):
    """The API's half of D1: it can read the directory and cannot write it."""

    def setUp(self) -> None:
        self.text = COMPOSE.read_text(encoding="utf-8")
        start = self.text.index("\n  api:\n")
        end = self.text.index("\n  web:\n", start)
        self.api = self.text[start:end]

    def test_the_api_mounts_the_replay_directory_read_only(self) -> None:
        mounts = [
            line.strip()
            for line in self.api.splitlines()
            if MOUNT_PATH in line and line.strip().startswith("- ")
        ]
        self.assertEqual(len(mounts), 1, f"expected one mount, got {mounts}")
        self.assertTrue(
            mounts[0].endswith(f":{MOUNT_PATH}:ro"),
            f"the replay volume must be read-only: {mounts[0]}",
        )

    def test_the_api_is_told_where_the_directory_is(self) -> None:
        self.assertIn(f"GANSO_SHADOW_REPLAY_DIR: {MOUNT_PATH}", self.api)

    def test_no_other_service_can_write_the_replay_directory(self) -> None:
        for line in self.text.splitlines():
            stripped = line.strip()
            if not stripped.startswith("- ") or MOUNT_PATH not in stripped:
                continue
            self.assertTrue(
                stripped.endswith(":ro"),
                f"a container may only read the replay directory: {stripped}",
            )


if __name__ == "__main__":
    unittest.main()
