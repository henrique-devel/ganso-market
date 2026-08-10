from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "infra" / "migrations" / "apply.sh"


class MigrationScriptTests(unittest.TestCase):
    def test_multiline_secret_is_rejected_without_echoing_content(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            secret = Path(directory) / "postgres_password"
            first_line = "synthetic-line-one"
            second_line = "synthetic-line-two"
            secret.write_text(f"{first_line}\n{second_line}\n", encoding="utf-8")
            environment = {
                **os.environ,
                "GANSO_POSTGRES_PASSWORD_FILE": str(secret),
            }

            result = subprocess.run(
                ["sh", str(SCRIPT)],
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )

        self.assertEqual(result.returncode, 2)
        self.assertIn("exactly one line", result.stderr)
        self.assertNotIn(first_line, result.stderr)
        self.assertNotIn(second_line, result.stderr)

    def test_nul_secret_is_rejected_without_echoing_content(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            secret = Path(directory) / "postgres_password"
            secret.write_bytes(b"synthetic\0value")
            environment = {
                **os.environ,
                "GANSO_POSTGRES_PASSWORD_FILE": str(secret),
            }

            result = subprocess.run(
                ["sh", str(SCRIPT)],
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )

        self.assertEqual(result.returncode, 2)
        self.assertIn("contains a NUL byte", result.stderr)
        self.assertNotIn("synthetic", result.stderr)


if __name__ == "__main__":
    unittest.main()
