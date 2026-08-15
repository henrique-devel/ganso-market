#!/usr/bin/env python3
"""Validate and safely extract a release archive received by the deploy key."""

from __future__ import annotations

import argparse
import os
import shutil
import tarfile
from pathlib import Path, PurePosixPath

MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
MAX_MEMBERS = 5_000
MAX_UNPACKED_BYTES = 250 * 1024 * 1024
REQUIRED_FILES = {
    "Makefile",
    "deploy/healthcheck.sh",
    "docker-compose.yml",
    "scripts/scan_secrets.py",
}
REQUIRED_EXECUTABLES = {"deploy/healthcheck.sh"}


class ReleaseValidationError(ValueError):
    """Raised when an incoming release archive violates the deploy contract."""


def _logical_name(member: tarfile.TarInfo) -> str:
    name = member.name
    if not name or name.startswith("/") or name.startswith("./") or "\\" in name:
        raise ReleaseValidationError("archive contains an unsafe path")
    if any(ord(character) < 32 or ord(character) == 127 for character in name):
        raise ReleaseValidationError("archive path contains a control character")

    logical_name = name[:-1] if name.endswith("/") else name
    parts = logical_name.split("/")
    if not logical_name or any(part in {"", ".", ".."} for part in parts):
        raise ReleaseValidationError("archive contains a non-canonical path")

    path = PurePosixPath(logical_name)
    if path.is_absolute() or any(part in {".deploy", ".git"} for part in path.parts):
        raise ReleaseValidationError("archive targets a protected path")
    if logical_name == "deploy/server.env":
        raise ReleaseValidationError("archive contains the server-local environment")
    if path.parts[:3] == ("infra", "secrets", "local"):
        allowed_secret_path = logical_name == "infra/secrets/local/.gitkeep" or (
            logical_name == "infra/secrets/local" and member.isdir()
        )
        if not allowed_secret_path:
            raise ReleaseValidationError("archive contains server-local secret material")
    if any(
        part == ".env" or (part.startswith(".env.") and part != ".env.example")
        for part in path.parts
    ):
        raise ReleaseValidationError("archive contains a local environment file")
    return logical_name


def _validated_members(bundle: tarfile.TarFile) -> list[tuple[tarfile.TarInfo, str]]:
    validated: list[tuple[tarfile.TarInfo, str]] = []
    names: set[str] = set()
    unpacked_bytes = 0

    for member in bundle:
        if len(validated) >= MAX_MEMBERS:
            raise ReleaseValidationError("archive contains too many entries")
        if not (member.isfile() or member.isdir()):
            raise ReleaseValidationError("archive contains a link or special file")

        logical_name = _logical_name(member)
        if logical_name in names:
            raise ReleaseValidationError("archive contains a duplicate path")
        names.add(logical_name)

        if member.isfile():
            unpacked_bytes += member.size
            if unpacked_bytes > MAX_UNPACKED_BYTES:
                raise ReleaseValidationError("archive expands beyond the size limit")
        validated.append((member, logical_name))

    missing = REQUIRED_FILES - names
    if missing:
        raise ReleaseValidationError("archive is missing required runtime files")

    by_name = {logical_name: member for member, logical_name in validated}
    if any(not by_name[name].isfile() for name in REQUIRED_FILES):
        raise ReleaseValidationError("a required runtime path is not a regular file")
    if any(by_name[name].mode & 0o111 == 0 for name in REQUIRED_EXECUTABLES):
        raise ReleaseValidationError("a required runtime script is not executable")
    return validated


def validate_and_extract(archive: Path, destination: Path) -> None:
    """Validate ``archive`` and extract regular files beneath a new destination."""

    if not archive.is_file() or archive.is_symlink():
        raise ReleaseValidationError("release archive is not a regular file")
    if archive.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ReleaseValidationError("release archive exceeds the compressed size limit")
    if destination.exists() or destination.is_symlink():
        raise ReleaseValidationError("release destination already exists")
    if not destination.parent.is_dir() or destination.parent.is_symlink():
        raise ReleaseValidationError("release destination parent is unsafe")

    try:
        with tarfile.open(archive, mode="r:gz") as bundle:
            members = _validated_members(bundle)
            destination.mkdir(mode=0o700)
            for member, logical_name in members:
                target = destination.joinpath(*PurePosixPath(logical_name).parts)
                if member.isdir():
                    target.mkdir(mode=0o755, parents=True, exist_ok=True)
                    continue

                target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                source = bundle.extractfile(member)
                if source is None:
                    raise ReleaseValidationError("archive member could not be read")
                with source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
    except (OSError, tarfile.TarError) as error:
        raise ReleaseValidationError("release archive could not be extracted") from error


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("destination", type=Path)
    arguments = parser.parse_args()

    try:
        validate_and_extract(arguments.archive, arguments.destination)
    except ReleaseValidationError as error:
        print(f"release validation failed: {error}", file=os.sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
