#!/usr/bin/env python3
"""Install only DATA-01 host observation files after CI; no Docker or unit changes.

Source files must be extracted from the reviewed revision. Preserve the old
watchdog, compare its expected hash, install atomically, then start the finite
series. A rollback restores the saved watchdog; evidence files are retained.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import stat
import subprocess
from pathlib import Path

TARGET = Path("/opt/ganso-market/deploy")
STATE = Path("/var/lib/ganso/recorder-watchdog")
FILES = ("capacity_series.py", "recorder_watchdog.py")
MAX_SOURCE_BYTES = 64 * 1024


def trusted(path, uid, directory=False):
    info = path.lstat()
    if (
        path.resolve() != path
        or info.st_uid != uid
        or info.st_mode & 0o022
        or (
            not stat.S_ISDIR(info.st_mode)
            if directory
            else not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
        )
    ):
        raise ValueError("UNTRUSTED_PATH")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def put(path, data):
    temp = path.with_name(path.name + ".capacity-pending")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def install(source, target, state, revision, before_sha, expected_hashes, *, dry_run=False):
    uid = os.geteuid()
    if not re.fullmatch("[0-9a-f]{40}", revision) or not re.fullmatch("[0-9a-f]{64}", before_sha):
        raise ValueError("IDENTITY_INVALID")
    for directory in (source, target, state):
        for part in (directory, *directory.parents):
            trusted(part, uid, directory=True)
    data = {}
    for name in FILES:
        path = source / name
        trusted(path, uid)
        if path.stat().st_size > MAX_SOURCE_BYTES:
            raise ValueError("SOURCE_LIMIT")
        data[name] = path.read_bytes()
        if digest(data[name]) != expected_hashes.get(name):
            raise ValueError("SOURCE_HASH_MISMATCH")
        ast.parse(data[name])
    original = target / "recorder_watchdog.py"
    trusted(original, uid)
    old = original.read_bytes()
    evidence = state / "capacity-series-install"
    if evidence.exists() or evidence.is_symlink():
        trusted(evidence, uid, directory=True)
    backup = evidence / "before-recorder_watchdog.py"
    manifest = evidence / "installation.json"
    if manifest.exists() or manifest.is_symlink():
        trusted(manifest, uid)
    if digest(old) not in (before_sha, expected_hashes["recorder_watchdog.py"]):
        raise ValueError("WATCHDOG_DRIFT")
    if backup.exists() or backup.is_symlink():
        trusted(backup, uid)
        if digest(backup.read_bytes()) != before_sha:
            raise ValueError("BACKUP_DRIFT")
    elif digest(old) != before_sha:
        raise ValueError("ORIGINAL_BACKUP_MISSING")
    for name in FILES:
        path = target / name
        if path.exists() or path.is_symlink():
            trusted(path, uid)
            if name == "capacity_series.py" and digest(path.read_bytes()) != expected_hashes[name]:
                raise ValueError("COLLECTOR_ALREADY_DIFFERENT")
    record = {
        "revision": revision,
        "files": expected_hashes,
        "before_watchdog_sha256": before_sha,
        "scope": "two host files; no Docker, systemd, backup pruning or application deployment",
    }
    if dry_run:
        return record
    evidence.mkdir(mode=0o700, exist_ok=True)
    if not backup.exists():
        put(backup, old)
    # Install the optional dependency first. The running watchdog is untouched
    # until its entire replacement file is ready; next normal timer invocation
    # picks it up. No forced watchdog invocation/restart occurs here.
    for name in FILES:
        if (
            not (target / name).exists()
            or digest((target / name).read_bytes()) != expected_hashes[name]
        ):
            put(target / name, data[name])
    put(manifest, (json.dumps(record, sort_keys=True) + "\n").encode())
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--before-watchdog-sha256", required=True)
    parser.add_argument("--collector-sha256", required=True)
    parser.add_argument("--watchdog-sha256", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        if os.geteuid() != 0:
            raise ValueError("ROOT_REQUIRED")
        hashes = dict(zip(FILES, (args.collector_sha256, args.watchdog_sha256)))
        if not all(re.fullmatch("[0-9a-f]{64}", v) for v in hashes.values()):
            raise ValueError("HASH_INVALID")
        record = install(
            args.source_dir,
            TARGET,
            STATE,
            args.revision,
            args.before_watchdog_sha256,
            hashes,
            dry_run=args.dry_run,
        )
        if not args.dry_run:
            subprocess.run(
                ["/usr/bin/python3", "-I", str(TARGET / "capacity_series.py"), "--start"],
                check=True,
                timeout=3,
            )
        print(json.dumps(record, sort_keys=True))
        return 0
    except Exception as exc:
        # Exceptions have static codes; never print paths/subprocess traceback.
        print(json.dumps({"reason": str(exc) if type(exc) is ValueError else "INSTALL_FAILED"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
