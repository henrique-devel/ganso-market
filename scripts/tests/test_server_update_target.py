from __future__ import annotations

import shlex
import subprocess
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# RFC-020 D1: the deploy target must stop recreating PostgreSQL. Every merge to
# main runs `make server-update` through deploy/remote-deploy.sh, and a
# `--force-recreate` without a service list drags the database down with the
# code: measured 2026-09-06, `docker inspect ganso-market-postgres-1` reported
# Created=19:50:21.9Z, two seconds after the deploy backup, and the five profile
# workers each logged one "Unhandled 'error' event" (terminating connection due
# to administrator command) per deploy. The shape below is what makes that
# impossible; `make -n` proves it without touching a container.
DEFAULT_CODE_SERVICES = ("api", "web", "nginx", "market-engine")


def server_update_commands() -> list[str]:
    result = subprocess.run(
        ["make", "-n", "server-update"],
        check=False,
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"`make -n server-update` failed ({result.returncode}): {result.stderr}"
        )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def compose_commands(lines: list[str]) -> list[str]:
    return [line for line in lines if "docker compose" in line]


class ServerUpdateTargetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.lines = server_update_commands()
        self.compose = compose_commands(self.lines)

    def test_force_recreate_appears_exactly_once(self) -> None:
        recreating = [line for line in self.compose if "--force-recreate" in line]

        self.assertEqual(
            len(recreating),
            1,
            f"exactly one --force-recreate expected, got: {recreating}",
        )

    def test_force_recreate_names_services_and_never_postgres(self) -> None:
        # The regression assert. On the pre-RFC-020 Makefile this line is
        # `up --detach --force-recreate --remove-orphans --wait ...` with no
        # service list at all, so Compose recreates every default service —
        # postgres included.
        recreating = [line for line in self.compose if "--force-recreate" in line]
        self.assertEqual(len(recreating), 1)
        arguments = shlex.split(recreating[0])
        services = [
            argument
            for argument in arguments[arguments.index("up") + 1 :]
            if not argument.startswith("--")
            and arguments[arguments.index(argument) - 1] != "--wait-timeout"
        ]

        self.assertTrue(
            services,
            "--force-recreate must carry an explicit service list, "
            f"otherwise it recreates every default service: {recreating[0]}",
        )
        self.assertNotIn(
            "postgres",
            services,
            f"postgres must never be force-recreated: {recreating[0]}",
        )
        self.assertEqual(sorted(services), sorted(DEFAULT_CODE_SERVICES))

    def test_force_recreate_does_not_drag_dependencies(self) -> None:
        # api, market-engine and the profile workers declare
        # `depends_on: migrate: service_completed_successfully`
        # (docker-compose.yml:104-106), so --force-recreate with a service list
        # would pull migrate — and through it postgres — back in.
        recreating = [line for line in self.compose if "--force-recreate" in line][0]

        self.assertIn("--no-deps", recreating)

    def test_postgres_is_brought_up_without_recreating_it(self) -> None:
        postgres_ups = [
            line
            for line in self.compose
            if " up " in f" {line} " and shlex.split(line)[-1] == "postgres"
        ]

        self.assertEqual(
            len(postgres_ups),
            1,
            f"postgres must be brought up exactly once, got: {postgres_ups}",
        )
        self.assertNotIn("--force-recreate", postgres_ups[0])
        self.assertIn("--wait", postgres_ups[0])

    def test_migrate_runs_literally_and_before_any_code_service(self) -> None:
        # `run --rm migrate`, not `up`: migrate has restart: "no" and exits
        # (docker-compose.yml:57), and `run` propagates the exit code so make
        # stops on a failed migration.
        migrate_lines = [
            index for index, line in enumerate(self.compose) if "run --rm migrate" in line
        ]

        self.assertEqual(
            len(migrate_lines),
            1,
            f"expected exactly one literal `run --rm migrate`, got: {self.compose}",
        )

        postgres_index = next(
            index
            for index, line in enumerate(self.compose)
            if " up " in f" {line} " and shlex.split(line)[-1] == "postgres"
        )
        recreate_index = next(
            index for index, line in enumerate(self.compose) if "--force-recreate" in line
        )

        self.assertLess(postgres_index, migrate_lines[0])
        self.assertLess(migrate_lines[0], recreate_index)

    def test_healthcheck_still_closes_the_target(self) -> None:
        self.assertTrue(
            any("deploy/healthcheck.sh" in line for line in self.lines),
            "server-update must still end on deploy/healthcheck.sh",
        )


if __name__ == "__main__":
    unittest.main()
