#!/usr/bin/env python3
"""Measure current container memory without treating configured limits as RSS."""

from __future__ import annotations

import json
import re
import subprocess

FOUR_GIB = 4 * 1024**3
UNITS = {
    "B": 1,
    "KB": 1000,
    "KIB": 1024,
    "MB": 1000**2,
    "MIB": 1024**2,
    "GB": 1000**3,
    "GIB": 1024**3,
}


def bytes_from_display(value: str) -> int:
    match = re.fullmatch(r"\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]+)\s*", value)
    if match is None:
        raise ValueError(f"unrecognized memory value: {value!r}")
    multiplier = UNITS.get(match.group(2).upper())
    if multiplier is None:
        raise ValueError(f"unrecognized memory unit: {match.group(2)!r}")
    return int(float(match.group(1)) * multiplier)


def main() -> None:
    ids_result = subprocess.run(
        ["docker", "compose", "--profile", "model", "ps", "--quiet"],
        check=True,
        capture_output=True,
        text=True,
    )
    container_ids = [line for line in ids_result.stdout.splitlines() if line]
    if not container_ids:
        raise SystemExit("runtime memory check: no running containers")
    stats = subprocess.run(
        [
            "docker",
            "stats",
            "--no-stream",
            "--format",
            '{"name":"{{.Name}}","memory":"{{.MemUsage}}"}',
            *container_ids,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    total = 0
    measured: list[tuple[str, int]] = []
    for line in stats.stdout.splitlines():
        record = json.loads(line)
        used = record["memory"].split("/", 1)[0].strip()
        count = bytes_from_display(used)
        total += count
        measured.append((record["name"], count))
    if total >= FOUR_GIB:
        raise SystemExit(f"runtime memory check failed: aggregate RSS-like usage={total} bytes")
    print(f"runtime memory check passed: {len(measured)} containers, aggregate={total} bytes")


if __name__ == "__main__":
    main()
