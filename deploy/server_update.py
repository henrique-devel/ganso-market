#!/usr/bin/env python3
"""Update affected running services; never activate a profile or recreate PostgreSQL."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

from deploy_paths import CODE_SERVICES, affected_services, changed_tree_files

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from check_compose_policy import validate  # noqa: E402


def run(args: list[str]) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def commands(compose: list[str], selected: set[str], services: dict) -> list[list[str]]:
    """An empty selection emits no bare build/up, and PG is never a release target."""
    result: list[list[str]] = []
    code = sorted(selected & CODE_SERVICES)
    builds = [name for name in code if services[name].get("build")]
    if builds:
        result.append([*compose, "build", *builds])
    if "migrate" in selected:
        # A fresh one-off reads current bind mounts; the old migrate container
        # may still point at a directory inode replaced by a prior rsync.
        result.append([*compose, "run", "--rm", "--no-deps", "migrate"])
    if code:
        result.append(
            [
                *compose,
                "up",
                "--detach",
                "--no-deps",
                "--no-build",
                "--force-recreate",
                "--wait",
                "--wait-timeout",
                "180",
                *code,
            ]
        )
    if {"api", "web", "nginx"} & selected:
        result.append([*compose, "exec", "-T", "nginx", "nginx", "-t"])
        result.append([*compose, "exec", "-T", "nginx", "nginx", "-s", "reload"])
    return result


def select_running(candidates: set[str], services: dict, running: set[str]) -> set[str]:
    selected = {
        name
        for name in candidates & running
        if name in CODE_SERVICES and services[name].get("scale", 1) != 0
    }
    if "migrate" in candidates:
        selected.add("migrate")
    return selected


def changed_compose_services(before: dict, after: dict, previous: Path, current: Path) -> set[str]:
    # Compose expands build contexts, bind mounts and env files to absolute
    # paths. Normalize only the two release roots before comparing services.
    def normalized(service: dict, root: Path) -> str:
        return json.dumps(service, sort_keys=True).replace(str(root), "<release>")

    return {
        name
        for name in before.keys() | after.keys()
        if normalized(before.get(name, {}), previous) != normalized(after.get(name, {}), current)
    }


def verify_migrations(directory: Path, rows: str) -> None:
    applied = dict(line.split("|", 1) for line in rows.splitlines() if line)
    files = sorted(directory.glob("[0-9][0-9][0-9][0-9]_*.sql"))
    if not files:
        raise SystemExit("server-update: no release migrations found")
    for file in files:
        version = str(int(file.name.split("_", 1)[0]))
        if applied.get(version) != hashlib.sha256(file.read_bytes()).hexdigest():
            raise SystemExit(f"server-update: unapplied or mismatched migration {file.name}")


def main() -> None:
    compose = ["docker", "compose", "--env-file", os.environ.get("SERVER_ENV", "deploy/server.env")]
    model = json.loads(run([*compose, "--profile", "*", "config", "--format", "json"]))
    # An explicit runtime inventory includes services whose profile is disabled.
    running = set(
        run([*compose, "--profile", "*", "ps", "--status", "running", "--services"]).splitlines()
    )
    services = model["services"]
    if not {"postgres", "api", "web", "nginx"} <= running:
        raise SystemExit(
            "server-update requires the existing healthy core; use server-up for bootstrap"
        )
    if "btc-worker" in running or any(name.startswith("polymarket-") for name in running):
        raise SystemExit("server-update: unexpected business worker active during G2-03.3")
    effective = {
        **model,
        "services": {
            name: service
            for name, service in services.items()
            if name in running or name == "migrate"
        },
    }
    bind = next(iter(services["nginx"]["ports"]))["host_ip"]
    budget = validate(effective, allowed_bind=bind)
    host = json.loads(run(["docker", "info", "--format", "{{json .}}"]))
    if host["MemTotal"] < budget["memory"] + 512 * 1024**2 or host["NCPU"] < budget["cpus"] + 1:
        raise SystemExit("server-update: insufficient existing host reserve (512 MiB / 1 CPU)")
    pg_id = run([*compose, "ps", "--quiet", "postgres"]).strip()
    pg_before = run(
        ["docker", "inspect", "--format", "{{.Id}} {{.State.StartedAt}}", pg_id]
    ).strip()
    pg = run(
        [
            *compose,
            "exec",
            "-T",
            "postgres",
            "psql",
            "-U",
            "ganso_market",
            "-d",
            "ganso_market",
            "-At",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            "SELECT current_setting('max_connections')::int, count(*) "
            "FROM pg_stat_activity WHERE backend_type='client backend'",
        ]
    ).strip()
    maximum, used = map(int, pg.split("|"))
    if max(used, budget["connections"]) + 8 > maximum:
        raise SystemExit("server-update: PostgreSQL lacks eight reserved connections")
    previous = os.environ.get("SERVER_DEPLOY_PREVIOUS")
    try:
        if not previous:
            raise ValueError("no previous tree supplied")
        paths = changed_tree_files(Path(previous), Path.cwd())
        other_paths = [path for path in paths if path != "docker-compose.yml"]
        candidates = affected_services(other_paths) if other_paths else set()
        if "docker-compose.yml" in paths:
            old = json.loads(
                run(
                    [
                        *compose,
                        "-f",
                        str(Path(previous) / "docker-compose.yml"),
                        "--profile",
                        "*",
                        "config",
                        "--format",
                        "json",
                    ]
                )
            )
            delta = changed_compose_services(old["services"], services, Path(previous), Path.cwd())
            if "postgres" in delta:
                raise SystemExit(
                    "server-update: database configuration change needs a separate migration plan"
                )
            candidates.update(delta & (CODE_SERVICES | {"migrate"}))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"classification unavailable ({error}); selecting running code services", flush=True)
        candidates = CODE_SERVICES | {"migrate"}
    selected = select_running(candidates, services, running)
    print(
        json.dumps(
            {
                "candidates": sorted(candidates),
                "selected": sorted(selected),
                "budget": budget,
                "pg_connections": used,
                "pg_max_connections": maximum,
            }
        ),
        flush=True,
    )
    for command in commands(compose, selected, services):
        print(" ".join(command), flush=True)
        subprocess.run(command, check=True)
        if command[-4:] == ["run", "--rm", "--no-deps", "migrate"]:
            rows = run(
                [
                    *compose,
                    "exec",
                    "-T",
                    "postgres",
                    "psql",
                    "-U",
                    "ganso_market",
                    "-d",
                    "ganso_market",
                    "-At",
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-c",
                    "SELECT version, checksum_sha256 FROM schema_versions "
                    "WHERE component='foundation'",
                ]
            )
            verify_migrations(Path("migrations"), rows)
    after = run([*compose, "ps", "--quiet", "postgres"]).strip()
    if (
        run(["docker", "inspect", "--format", "{{.Id}} {{.State.StartedAt}}", after]).strip()
        != pg_before
    ):
        raise SystemExit("server-update: PostgreSQL identity/start changed")


if __name__ == "__main__":
    main()
