#!/usr/bin/env python3
"""Validate isolation and aggregate memory limits from canonical Compose JSON."""

from __future__ import annotations

import json
import subprocess

FOUR_GIB = 4 * 1024 * 1024 * 1024


def main() -> None:
    result = subprocess.run(
        ["docker", "compose", "--profile", "model", "config", "--format", "json"],
        check=True,
        capture_output=True,
        text=True,
    )
    compose = json.loads(result.stdout)
    services = compose.get("services", {})
    networks = compose.get("networks", {})
    if networks.get("backend", {}).get("internal") is not True:
        raise SystemExit("compose policy: backend network must be internal")
    if networks.get("edge", {}).get("internal") is True:
        raise SystemExit("compose policy: edge network cannot publish loopback while internal")
    if "postgres" not in services:
        raise SystemExit("compose policy: postgres service is missing")
    if services["postgres"].get("ports"):
        raise SystemExit("compose policy: PostgreSQL must not publish a host port")

    total = 0
    for name, service in services.items():
        raw_limit = service.get("mem_limit")
        try:
            limit = int(raw_limit)
        except (TypeError, ValueError):
            raise SystemExit(f"compose policy: {name} has no effective memory limit") from None
        if limit <= 0:
            raise SystemExit(f"compose policy: {name} has no effective memory limit")
        total += limit
        for port in service.get("ports", []):
            if name != "nginx" or port.get("host_ip") != "127.0.0.1":
                raise SystemExit(f"compose policy: unsafe published port on {name}")

    if total >= FOUR_GIB:
        raise SystemExit(f"compose policy: aggregate limit is {total} bytes, must be < 4 GiB")
    print(f"compose policy passed; aggregate memory limit={total} bytes")


if __name__ == "__main__":
    main()
