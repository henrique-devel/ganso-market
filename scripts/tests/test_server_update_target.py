from __future__ import annotations

import hashlib
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "deploy"))
import server_update as update  # noqa: E402
from deploy_paths import CODE_SERVICES, affected_services, changed_tree_files  # noqa: E402


class ServerUpdateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.compose = ["docker", "compose", "--env-file", "deploy/server.env"]
        self.services = {name: {"build": {"context": "."}} for name in CODE_SERVICES}
        self.services["nginx"] = {}
        self.services["btc-worker"]["scale"] = 0
        self.running = {"api", "web", "nginx", "market-engine", "postgres"}

    def test_worker_change_targets_worker_but_never_activates_it(self) -> None:
        candidates = affected_services(["apps/api/src/btc-worker.ts"])
        self.assertEqual(candidates, {"btc-worker"})
        self.assertEqual(update.select_running(candidates, self.services, self.running), set())
        self.assertEqual(update.commands(self.compose, set(), self.services), [])
        # Future completed worker: selection is correct once running and scaled.
        self.services["btc-worker"]["scale"] = 1
        self.running.add("btc-worker")
        self.assertEqual(update.select_running(candidates, self.services, self.running), candidates)
        commands = update.commands(self.compose, candidates, self.services)
        self.assertEqual(commands[0][-1], "btc-worker")
        self.assertEqual(commands[1][-1], "btc-worker")

    def test_zero_scale_never_selects_even_a_running_worker(self) -> None:
        self.running.add("btc-worker")
        self.assertEqual(update.select_running({"btc-worker"}, self.services, self.running), set())

    def test_shared_source_reaches_all_active_node_consumers(self) -> None:
        self.services["btc-worker"]["scale"] = 1
        self.running.add("btc-worker")
        candidates = affected_services(["apps/api/src/database.ts"])
        self.assertEqual(
            update.select_running(candidates, self.services, self.running), {"api", "btc-worker"}
        )

    def test_api_recreate_excludes_postgres_and_dependencies_and_reloads_gateway(self) -> None:
        commands = update.commands(self.compose, {"api", "postgres"}, self.services)
        recreating = [command for command in commands if "up" in command]
        self.assertEqual(len(recreating), 1)
        self.assertIn("--no-deps", recreating[0])
        self.assertEqual(recreating[0][-1], "api")
        self.assertNotIn("postgres", [arg for command in commands for arg in command])
        self.assertEqual(commands[-2][-1], "-t")
        self.assertEqual(commands[-1][-2:], ["-s", "reload"])

    def test_migration_is_one_off_without_pg_dependency_before_recreate(self) -> None:
        commands = update.commands(self.compose, {"api", "migrate"}, self.services)
        self.assertEqual(commands[1][-4:], ["run", "--rm", "--no-deps", "migrate"])
        self.assertIn("up", commands[2])

    def test_unknown_path_updates_only_running_code(self) -> None:
        selected = update.select_running(
            affected_services(["unknown.bin"]), self.services, self.running
        )
        self.assertEqual(selected, {"api", "web", "nginx", "market-engine", "migrate"})

    def test_text_and_operational_scripts_do_not_recreate_services(self) -> None:
        self.assertEqual(
            affected_services(["docs/test.md", "Makefile", "deploy/healthcheck.sh"]), set()
        )

    def test_compose_delta_normalizes_mounts_without_restarting_unchanged_core(self) -> None:
        before = {
            "api": {"volumes": [{"source": "/old/config/runtime.json"}]},
            "postgres": {"image": "pinned"},
        }
        after = {
            "api": {"volumes": [{"source": "/new/config/runtime.json"}]},
            "postgres": {"image": "pinned"},
            "btc-worker": {"scale": 0},
        }
        self.assertEqual(
            update.changed_compose_services(before, after, Path("/old"), Path("/new")),
            {"btc-worker"},
        )
        after["postgres"]["image"] = "other"
        self.assertIn(
            "postgres", update.changed_compose_services(before, after, Path("/old"), Path("/new"))
        )

    def test_missing_or_stale_migration_mount_is_detected_before_consumers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "0027_new.sql").write_text("SELECT 1;")
            checksum = hashlib.sha256((root / "0027_new.sql").read_bytes()).hexdigest()
            update.verify_migrations(root, "27|" + checksum)
            for rows in ("", "26|" + checksum, "27|stale"):
                with self.subTest(rows=rows), self.assertRaises(SystemExit):
                    update.verify_migrations(root, rows)

    def test_previous_snapshot_must_match_active_release(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = root / ".deploy/backups/20260923T000000Z.abcdef"
            (snapshot / "deploy").mkdir(parents=True)
            (root / ".deploy/current-sha").write_text("a" * 40)
            (snapshot / "deploy/release-sha").write_text("a" * 40)
            self.assertEqual(update.previous_release(root), snapshot)
            # Never search past the latest snapshot: a stale match is unsafe.
            newer = root / ".deploy/backups/20260923T010000Z.abcdef"
            (newer / "deploy").mkdir(parents=True)
            (newer / "deploy/release-sha").write_text("b" * 40)
            with self.assertRaises(ValueError):
                update.previous_release(root)

    def test_tree_comparison_includes_deleted_files_and_ignores_local_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            previous, release = Path(directory) / "before", Path(directory) / "after"
            for root in (previous, release):
                (root / "deploy").mkdir(parents=True)
                (root / "deploy/release-sha").write_text(str(root))
            (previous / "deploy/server.env").write_text("private")
            (previous / "deleted.ts").write_text("old")
            (release / "new.ts").write_text("new")
            self.assertEqual(changed_tree_files(previous, release), ["deleted.ts", "new.ts"])


if __name__ == "__main__":
    unittest.main()
