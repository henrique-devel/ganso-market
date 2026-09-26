from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "deploy"))
import server_update as update  # noqa: E402
from deploy_paths import (  # noqa: E402
    CODE_SERVICES,
    affected_services,
    changed_runtime_services,
    changed_tree_files,
)


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
        self.assertEqual(selected, {"api", "web", "nginx", "migrate"})

    def test_text_and_operational_scripts_do_not_recreate_services(self) -> None:
        self.assertEqual(
            affected_services(["docs/test.md", "Makefile", "deploy/healthcheck.sh"]), set()
        )

    def test_removed_artifacts_have_no_image_consumer(self) -> None:
        candidates = affected_services(
            [
                "services/market-engine/src/main.rs",
                "workers/model-worker/Dockerfile",
                "Cargo.toml",
                "Cargo.lock",
                "rust-toolchain.toml",
                "config/runtime.json",
            ]
        )
        self.assertEqual(update.select_running(candidates, self.services, self.running), {"api"})

    def test_retirement_scopes_identity_stops_once_and_keeps_data(self) -> None:
        state = {
            "Id": "a" * 64,
            "Config": {
                "Labels": {
                    "com.docker.compose.project": "fixture",
                    "com.docker.compose.service": "market-engine",
                }
            },
            "HostConfig": {"RestartPolicy": {"Name": "unless-stopped"}},
            "State": {"Running": True},
        }
        calls = []

        def docker(args):
            calls.append(args)
            if args[1] == "ps":
                self.assertIn("label=com.docker.compose.project=fixture", args)
                return state["Id"] if args[-1].endswith("=market-engine") else ""
            self.assertEqual(args[-1], state["Id"])
            if args[1] == "inspect":
                return json.dumps([state])
            if args[1] == "update":
                state["HostConfig"]["RestartPolicy"]["Name"] = "no"
            elif args[1] == "stop":
                state["State"]["Running"] = False
            else:
                self.fail(f"unexpected mutation {args}")
            return ""

        with patch.object(update, "run", side_effect=docker):
            update.retire_stubs("fixture")
            update.retire_stubs("fixture")
        self.assertEqual(sum(c[1] == "stop" for c in calls), 1)
        self.assertEqual(sum(c[1] == "update" for c in calls), 1)

    def test_retirement_rejects_foreign_identity_before_mutation(self) -> None:
        for labels in ({}, {"com.docker.compose.project": "other"}):
            state = {"Id": "a" * 64, "Config": {"Labels": labels}}
            with patch.object(update, "run", side_effect=[state["Id"], json.dumps([state])]) as run:
                with self.assertRaises(SystemExit):
                    update.retire_stubs("fixture")
                self.assertEqual(
                    [call.args[0][1] for call in run.call_args_list], ["ps", "inspect"]
                )
        with self.assertRaises(ValueError):
            update.retire_stubs("")

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

    def test_baseline_runtime_targets_api_web_and_additive_migration_only(self) -> None:
        self.assertEqual(
            affected_services(
                [
                    "apps/api/src/baseline-activate-cli.ts",
                    "apps/api/src/storage/baseline-runtime.ts",
                    "apps/api/src/storage/baseline-store.ts",
                    "apps/api/test/trading/baseline-runtime.pg.test.ts",
                    "apps/web/src/BtcDesk.tsx",
                    "packages/contracts/src/trading/desk.ts",
                    "migrations/0043_btc_baseline_runtime.sql",
                ]
            ),
            {"api", "web", "migrate"},
        )

    def test_operation_reads_preserve_running_collector(self) -> None:
        self.assertEqual(
            affected_services(
                [
                    "apps/api/src/storage/desk-history.ts",
                    "apps/api/test/trading/desk.test.ts",
                    "apps/api/test/route-budgets.runtime.test.ts",
                    "apps/api/test/trading/desk.pg.test.ts",
                    "packages/contracts/src/trading/history.ts",
                    "migrations/0042_btc_operation_reads.sql",
                    "infra/nginx/nginx.conf",
                ]
            ),
            {"api", "web", "migrate", "nginx"},
        )

    def test_runtime_route_budgets_only_target_api_and_unknown_changes_remain_conservative(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            before, after = Path(directory) / "before", Path(directory) / "after"
            config = {
                "services": {"api": {"statement_timeout_ms": {"routes": {"/a": 500}}}},
                "logging": {"level": "info"},
            }
            for root in (before, after):
                (root / "config").mkdir(parents=True)
                (root / "config/runtime.json").write_text(json.dumps(config))
            config["services"]["api"]["statement_timeout_ms"]["routes"]["/b"] = 1500
            (after / "config/runtime.json").write_text(json.dumps(config))
            self.assertEqual(changed_runtime_services(before, after), {"api"})
            config["logging"]["level"] = "debug"
            (after / "config/runtime.json").write_text(json.dumps(config))
            self.assertIn("btc-worker", changed_runtime_services(before, after))
            (after / "config/runtime.json").write_text("invalid")
            self.assertIn("btc-worker", changed_runtime_services(before, after))

    def test_type_barrel_change_preserves_runtime_but_runtime_export_does_not(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            before, after = Path(directory) / "before", Path(directory) / "after"
            path = "packages/contracts/src/trading/index.ts"
            runtime = 'export { parseTradingAmount } from "./amount.js";\n'
            for root in (before, after):
                (root / path).parent.mkdir(parents=True)
                (root / path).write_text(runtime)
            (after / path).write_text(
                runtime + 'export type { DeskOperation } from "./history.js";\n'
            )
            self.assertEqual(changed_tree_files(before, after), [])
            (after / path).write_text(runtime + 'export { danger } from "./history.js";\n')
            self.assertEqual(changed_tree_files(before, after), [path])
            self.assertIn("btc-worker", affected_services(changed_tree_files(before, after)))

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
