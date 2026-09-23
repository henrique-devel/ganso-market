#!/usr/bin/env python3
"""Validate the combined effective Compose budget, including dormant BTC capacity."""

from __future__ import annotations

import json
import subprocess

FOUR_GIB = 4 * 1024**3
# Existing pool maxima (database.ts and the five legacy entrypoints), plus
# an allowance for migration. Eight slots stay unallocated.
CONNECTIONS = {
    "api": 4,
    "migrate": 1,
    "btc-worker": 2,
    "polymarket-recorder": 10,
    "polymarket-estimator": 4,
    "polymarket-resolution": 4,
    "polymarket-paper": 2,
    "polymarket-portfolio": 4,
}


def validate(compose: dict, *, allowed_bind: str = "127.0.0.1") -> dict:
    services = compose.get("services", {})
    networks = compose.get("networks", {})
    if networks.get("backend", {}).get("internal") is not True:
        raise ValueError("backend network must be internal")
    if networks.get("edge", {}).get("internal") is True:
        raise ValueError("edge network cannot be internal")
    if "postgres" not in services or services["postgres"].get("ports"):
        raise ValueError("PostgreSQL must exist without a host port")
    total, cpus, connections = 0, 0.0, 0
    for name, service in services.items():
        limit = int(service.get("mem_limit", 0))
        cpu = float(service.get("cpus", 0))
        replicas = int(service.get("scale", 1))
        if limit <= 0 or cpu <= 0 or replicas < 0:
            raise ValueError(f"{name} has no effective memory/CPU limit or invalid scale")
        total += limit * replicas
        cpus += cpu * replicas
        connections += CONNECTIONS.get(name, 0) * replicas
        for port in service.get("ports", []):
            if name != "nginx" or port.get("host_ip") != allowed_bind:
                raise ValueError(f"unsafe published port on {name}")
    if total >= FOUR_GIB or cpus > 7 or connections + 8 > 40:
        raise ValueError(
            f"combined budget exceeded: memory={total}, cpus={cpus}, connections={connections}+8"
        )
    return {"memory": total, "cpus": cpus, "connections": connections, "connection_reserve": 8}


def main() -> None:
    result = subprocess.run(
        ["docker", "compose", "--profile", "*", "config", "--format", "json"],
        check=True,
        capture_output=True,
        text=True,
    )
    compose = json.loads(result.stdout)
    for name, service in compose["services"].items():
        if (name == "btc-worker" or name.startswith("polymarket-")) and (
            service.get("scale") != 0
            or service.get("restart") != "no"
            or not service.get("profiles")
        ):
            raise SystemExit(f"compose policy: {name} must remain inactive and isolated")
    budget = validate(compose)
    # Reserve for the future worker is checked without enabling it. The cap
    # remains <4 GiB; retired workers cannot consume this headroom silently.
    future = json.loads(json.dumps(compose))
    future["services"]["btc-worker"]["scale"] = 1
    prepared = validate(future)
    print(f"compose policy passed; effective={budget}; prepared BTC={prepared}")


if __name__ == "__main__":
    main()
