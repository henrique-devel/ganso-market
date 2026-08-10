from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "scan_secrets.py"
SPEC = importlib.util.spec_from_file_location("scan_secrets", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load secret scanner")
scan_secrets = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = scan_secrets
SPEC.loader.exec_module(scan_secrets)


class SecretScannerTests(unittest.TestCase):
    def test_clean_tree_passes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            secret_dir = root / "infra" / "secrets" / "local"
            secret_dir.mkdir(parents=True)
            (root / "safe.txt").write_text("paper only\n", encoding="utf-8")
            self.assertEqual(scan_secrets.scan(root, secret_dir), [])

    def test_secret_file_content_is_detected_without_returning_value(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            secret_dir = root / "infra" / "secrets" / "local"
            secret_dir.mkdir(parents=True)
            sentinel = "test-sentinel-value"
            (secret_dir / "database_password").write_text(sentinel, encoding="utf-8")
            (root / "leak.txt").write_text(sentinel, encoding="utf-8")

            findings = scan_secrets.scan(root, secret_dir)

            self.assertEqual(len(findings), 1)
            self.assertEqual(findings[0].reason, "local-secret-content-reused")
            self.assertNotIn(sentinel, repr(findings[0]))

    def test_private_key_marker_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            secret_dir = root / "infra" / "secrets" / "local"
            secret_dir.mkdir(parents=True)
            marker = "-----BEGIN " + "PRIVATE" + " KEY-----"
            (root / "bad.txt").write_text(marker, encoding="utf-8")

            findings = scan_secrets.scan(root, secret_dir)

            self.assertEqual(findings[0].reason, "private-key-marker")

    def test_base58_private_key_shape_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            secret_dir = root / "infra" / "secrets" / "local"
            secret_dir.mkdir(parents=True)
            (root / "bad.txt").write_text("1" * 88, encoding="utf-8")

            findings = scan_secrets.scan(root, secret_dir)

            self.assertEqual(findings[0].reason, "solana-private-key-base58-shape")

    def test_oversized_file_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            secret_dir = root / "infra" / "secrets" / "local"
            secret_dir.mkdir(parents=True)
            (root / "oversized.bin").write_bytes(b"\0" * (scan_secrets.MAX_SCAN_BYTES + 1))

            findings = scan_secrets.scan(root, secret_dir)

            self.assertEqual(findings[0].reason, "file-too-large-to-scan")


if __name__ == "__main__":
    unittest.main()
