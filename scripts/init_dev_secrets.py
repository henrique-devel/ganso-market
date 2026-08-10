#!/usr/bin/env python3
"""Create the local-only PostgreSQL test secret without printing its value."""

from __future__ import annotations

import os
import secrets
import stat
from pathlib import Path

SECRET_DIR = Path("infra/secrets/local")
SECRET_PATH = SECRET_DIR / "postgres_password"


def main() -> None:
    SECRET_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(SECRET_DIR, 0o700)

    if SECRET_PATH.exists():
        mode = stat.S_IMODE(SECRET_PATH.stat().st_mode)
        if not SECRET_PATH.is_file():
            raise SystemExit("local secret path exists but is not a regular file")
        if mode != 0o600:
            os.chmod(SECRET_PATH, 0o600)
        print("local test secret already exists; value was not read or printed")
        return

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(SECRET_PATH, flags, 0o600)
    try:
        value = secrets.token_urlsafe(32).encode("ascii")
        os.write(descriptor, value)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

    print("local test secret created with mode 0600; value was not printed")


if __name__ == "__main__":
    main()
