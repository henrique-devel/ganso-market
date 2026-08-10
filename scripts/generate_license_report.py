#!/usr/bin/env python3
"""Generate a deterministic registry dependency/license inventory."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from typing import Any


def npm_dependencies(lock_path: Path) -> list[dict[str, str]]:
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    dependencies: list[dict[str, str]] = []
    for location, package in lock.get("packages", {}).items():
        if "node_modules/" not in location or package.get("link") is True:
            continue
        name = package.get("name") or location.rsplit("node_modules/", 1)[-1]
        version = package.get("version")
        license_name = package.get("license")
        if not isinstance(version, str) or not isinstance(license_name, str):
            raise SystemExit(f"npm dependency lacks version/license metadata: {name}")
        dependencies.append(
            {
                "ecosystem": "npm",
                "name": name,
                "version": version,
                "license": license_name,
            }
        )
    return dependencies


def cargo_dependencies() -> list[dict[str, str]]:
    result = subprocess.run(
        ["cargo", "metadata", "--locked", "--format-version", "1"],
        check=True,
        capture_output=True,
        text=True,
    )
    metadata: dict[str, Any] = json.loads(result.stdout)
    dependencies: list[dict[str, str]] = []
    for package in metadata["packages"]:
        if package.get("source") is None:
            continue
        license_name = package.get("license")
        if not isinstance(license_name, str):
            raise SystemExit(f"cargo dependency lacks license metadata: {package['name']}")
        dependencies.append(
            {
                "ecosystem": "cargo",
                "name": package["name"],
                "version": package["version"],
                "license": license_name,
            }
        )
    return dependencies


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()

    dependencies = npm_dependencies(Path("package-lock.json")) + cargo_dependencies()
    dependencies.sort(key=lambda item: (item["ecosystem"], item["name"], item["version"]))
    report = {
        "schema_version": 1,
        "generated_from": ["package-lock.json", "Cargo.lock"],
        "dependencies": dependencies,
    }
    arguments.output.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"license report generated with {len(dependencies)} registry packages")


if __name__ == "__main__":
    main()
