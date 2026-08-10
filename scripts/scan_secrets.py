#!/usr/bin/env python3
"""Fail closed on likely secret material without echoing matched content."""

from __future__ import annotations

import argparse
import os
import re
from dataclasses import dataclass
from pathlib import Path

SKIP_DIRS = {
    ".git",
    ".venv",
    ".ruff_cache",
    "__pycache__",
    "coverage",
    "dist",
    "node_modules",
    "target",
}
SECRET_SUFFIXES = {".key", ".pem", ".p12", ".pfx"}
MAX_SCAN_BYTES = 5 * 1024 * 1024


@dataclass(frozen=True)
class Finding:
    path: Path
    reason: str


def _patterns() -> tuple[tuple[str, re.Pattern[str]], ...]:
    private_marker = "PRIVATE" + " KEY"
    return (
        (
            "private-key-marker",
            re.compile(r"-----BEGIN(?: [A-Z0-9]+)? " + private_marker + r"-----"),
        ),
        (
            "assigned-secret-material",
            re.compile(
                r"(?i)(?:private[_-]?key|seed[_-]?phrase|mnemonic)\s*[:=]\s*[\"']"
                r"(?!\$|<|example|redacted)[^\"']{16,}[\"']"
            ),
        ),
        (
            "solana-keypair-array",
            re.compile(r"\[(?:\s*(?:[0-9]{1,3})\s*,){63}\s*(?:[0-9]{1,3})\s*\]"),
        ),
        (
            "solana-private-key-base58-shape",
            re.compile(
                r"(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{80,100}"
                r"(?![1-9A-HJ-NP-Za-km-z])"
            ),
        ),
    )


def _candidate_files(root: Path, secret_dir: Path) -> list[Path]:
    candidates: list[Path] = []
    for current, directories, filenames in os.walk(root):
        directories[:] = [name for name in directories if name not in SKIP_DIRS]
        current_path = Path(current)
        if current_path == secret_dir or secret_dir in current_path.parents:
            directories[:] = []
            continue
        for filename in filenames:
            path = current_path / filename
            if path.is_file():
                candidates.append(path)
    return candidates


def scan(root: Path, secret_dir: Path) -> list[Finding]:
    root = root.resolve()
    secret_dir = secret_dir.resolve()
    findings: list[Finding] = []
    secrets_to_find = [
        path.read_bytes()
        for path in secret_dir.glob("*")
        if path.is_file() and path.stat().st_size >= 8
    ]

    for path in _candidate_files(root, secret_dir):
        relative = path.relative_to(root)
        if path.stat().st_size > MAX_SCAN_BYTES:
            findings.append(Finding(relative, "file-too-large-to-scan"))
            continue
        if path.suffix.lower() in SECRET_SUFFIXES:
            findings.append(Finding(relative, "prohibited-secret-file-extension"))
            continue

        data = path.read_bytes()
        for secret_value in secrets_to_find:
            if secret_value in data:
                findings.append(Finding(relative, "local-secret-content-reused"))
                break

        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            continue
        for reason, pattern in _patterns():
            if reason == "solana-private-key-base58-shape" and relative.name in {
                "Cargo.lock",
                "package-lock.json",
            }:
                continue
            if pattern.search(text):
                findings.append(Finding(relative, reason))

    return sorted(set(findings), key=lambda finding: (str(finding.path), finding.reason))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument(
        "--secret-dir",
        type=Path,
        default=Path("infra/secrets/local"),
    )
    arguments = parser.parse_args()
    secret_dir = arguments.secret_dir
    if not secret_dir.is_absolute():
        secret_dir = arguments.root / secret_dir

    findings = scan(arguments.root, secret_dir)
    if findings:
        for finding in findings:
            print(f"secret scan failed: {finding.path} ({finding.reason})")
        raise SystemExit(1)
    print("secret scan passed; no matched content was printed")


if __name__ == "__main__":
    main()
