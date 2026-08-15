#!/usr/bin/env python3
"""Create the local-only PostgreSQL test secret without printing its value."""

from __future__ import annotations

import os
import secrets
import stat
from pathlib import Path

SECRET_DIR = Path("infra/secrets/local")
SECRET_PATH = SECRET_DIR / "postgres_password"
SECRET_MODE = 0o644


def main() -> None:
    SECRET_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory_status = SECRET_DIR.lstat()
    if not stat.S_ISDIR(directory_status.st_mode) or stat.S_ISLNK(directory_status.st_mode):
        raise SystemExit("local secret directory is not a regular directory")
    os.chmod(SECRET_DIR, 0o700)

    try:
        path_status = SECRET_PATH.lstat()
    except FileNotFoundError:
        pass
    else:
        if not stat.S_ISREG(path_status.st_mode) or stat.S_ISLNK(path_status.st_mode):
            raise SystemExit("local secret path exists but is not a regular file")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(SECRET_PATH, flags)
        except OSError:
            raise SystemExit("local secret path could not be opened safely") from None
        try:
            status = os.fstat(descriptor)
            if not stat.S_ISREG(status.st_mode):
                raise SystemExit("local secret path exists but is not a regular file")
            os.fchmod(descriptor, SECRET_MODE)
        finally:
            os.close(descriptor)
        print("local test secret already exists; value was not read or printed")
        return

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(SECRET_PATH, flags, SECRET_MODE)
    try:
        value = secrets.token_urlsafe(32).encode("ascii")
        os.write(descriptor, value)
        os.fsync(descriptor)
        os.fchmod(descriptor, SECRET_MODE)
    finally:
        os.close(descriptor)

    print("local test secret created; value was not printed")


if __name__ == "__main__":
    main()
