from __future__ import annotations

import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "init_dev_secrets.py"


class InitDevSecretsTests(unittest.TestCase):
    def run_script(
        self, working_directory: Path, *, restrictive_umask: bool = False, check: bool = True
    ) -> subprocess.CompletedProcess[str]:
        def set_restrictive_umask() -> None:
            os.umask(0o077)

        return subprocess.run(
            [sys.executable, str(SCRIPT)],
            cwd=working_directory,
            check=check,
            capture_output=True,
            text=True,
            preexec_fn=set_restrictive_umask if restrictive_umask else None,
        )

    def test_creates_container_readable_secret_inside_private_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            result = self.run_script(root)

            secret_dir = root / "infra" / "secrets" / "local"
            secret = secret_dir / "postgres_password"
            self.assertEqual(stat.S_IMODE(secret_dir.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(secret.stat().st_mode), 0o644)
            self.assertGreater(len(secret.read_bytes()), 20)
            self.assertNotIn(secret.read_text(encoding="ascii"), result.stdout)

    def test_explicit_mode_overrides_restrictive_umask(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            self.run_script(root, restrictive_umask=True)

            secret = root / "infra" / "secrets" / "local" / "postgres_password"
            self.assertEqual(stat.S_IMODE(secret.stat().st_mode), 0o644)

    def test_existing_value_is_preserved_and_permissions_are_repaired(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            secret_dir = root / "infra" / "secrets" / "local"
            secret_dir.mkdir(parents=True)
            secret = secret_dir / "postgres_password"
            secret.write_text("existing-test-value", encoding="ascii")
            secret.chmod(0o600)

            self.run_script(root)

            self.assertEqual(secret.read_text(encoding="ascii"), "existing-test-value")
            self.assertEqual(stat.S_IMODE(secret_dir.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(secret.stat().st_mode), 0o644)

    def test_secret_symlink_is_rejected_without_changing_target(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            secret_dir = root / "infra" / "secrets" / "local"
            secret_dir.mkdir(parents=True)
            target = root / "outside-secret"
            target.write_text("outside-test-value", encoding="ascii")
            target.chmod(0o600)
            (secret_dir / "postgres_password").symlink_to(target)

            result = self.run_script(root, check=False)

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(target.read_text(encoding="ascii"), "outside-test-value")
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)

    def test_secret_directory_symlink_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            secret_parent = root / "infra" / "secrets"
            secret_parent.mkdir(parents=True)
            target = root / "outside-directory"
            target.mkdir()
            (secret_parent / "local").symlink_to(target, target_is_directory=True)

            result = self.run_script(root, check=False)

            self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
