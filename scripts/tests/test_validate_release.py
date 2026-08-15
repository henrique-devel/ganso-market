from __future__ import annotations

import importlib.util
import io
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).parents[2] / "deploy" / "validate_release.py"
SPEC = importlib.util.spec_from_file_location("validate_release", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load release validator")
validate_release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validate_release)


class ReleaseValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _archive(self, entries: list[tuple[str, bytes, int, bytes | None]]) -> Path:
        archive = self.root / "release.tar.gz"
        with tarfile.open(archive, "w:gz") as bundle:
            for name, content, mode, member_type in entries:
                member = tarfile.TarInfo(name)
                member.mode = mode
                member.type = member_type or tarfile.REGTYPE
                if member_type == tarfile.SYMTYPE:
                    member.linkname = content.decode()
                    member.size = 0
                    bundle.addfile(member)
                elif member_type == tarfile.DIRTYPE:
                    member.size = 0
                    bundle.addfile(member)
                else:
                    member.size = len(content)
                    bundle.addfile(member, io.BytesIO(content))
        return archive

    def _valid_entries(self) -> list[tuple[str, bytes, int, bytes | None]]:
        return [
            ("Makefile", b"server-update:\n\t@true\n", 0o644, None),
            ("docker-compose.yml", b"name: ganso-market\n", 0o644, None),
            ("deploy/healthcheck.sh", b"#!/bin/sh\n", 0o755, None),
            ("scripts/scan_secrets.py", b"print('ok')\n", 0o644, None),
            (".env.example", b"EXAMPLE=1\n", 0o644, None),
            ("infra/secrets/local/", b"", 0o755, tarfile.DIRTYPE),
            ("infra/secrets/local/.gitkeep", b"", 0o644, None),
        ]

    def _validate(self, entries: list[tuple[str, bytes, int, bytes | None]]) -> Path:
        archive = self._archive(entries)
        destination = self.root / "release"
        validate_release.validate_and_extract(archive, destination)
        return destination

    def test_extracts_a_valid_release_with_safe_modes(self) -> None:
        destination = self._validate(self._valid_entries())

        self.assertEqual((destination / "docker-compose.yml").read_text(), "name: ganso-market\n")
        self.assertEqual((destination / "deploy/healthcheck.sh").stat().st_mode & 0o777, 0o755)
        self.assertEqual((destination / ".env.example").stat().st_mode & 0o777, 0o644)

    def test_rejects_parent_traversal(self) -> None:
        entries = self._valid_entries() + [("../escape", b"bad", 0o644, None)]
        with self.assertRaisesRegex(validate_release.ReleaseValidationError, "non-canonical"):
            self._validate(entries)

    def test_rejects_absolute_paths(self) -> None:
        entries = self._valid_entries() + [("/tmp/escape", b"bad", 0o644, None)]
        with self.assertRaisesRegex(validate_release.ReleaseValidationError, "unsafe path"):
            self._validate(entries)

    def test_rejects_symlinks(self) -> None:
        entries = self._valid_entries() + [("link", b"/etc/passwd", 0o777, tarfile.SYMTYPE)]
        with self.assertRaisesRegex(validate_release.ReleaseValidationError, "special file"):
            self._validate(entries)

    def test_rejects_server_environment(self) -> None:
        entries = self._valid_entries() + [("deploy/server.env", b"SECRET=bad", 0o644, None)]
        with self.assertRaisesRegex(validate_release.ReleaseValidationError, "server-local"):
            self._validate(entries)

    def test_rejects_nested_git_metadata(self) -> None:
        entries = self._valid_entries() + [("vendor/.git/config", b"bad", 0o644, None)]
        with self.assertRaisesRegex(validate_release.ReleaseValidationError, "protected path"):
            self._validate(entries)

    def test_rejects_non_example_environment_files(self) -> None:
        entries = self._valid_entries() + [("apps/api/.env.local", b"bad", 0o644, None)]
        with self.assertRaisesRegex(validate_release.ReleaseValidationError, "environment file"):
            self._validate(entries)

    def test_rejects_secret_material_path(self) -> None:
        entries = self._valid_entries() + [
            ("infra/secrets/local/postgres_password", b"bad", 0o644, None)
        ]
        with self.assertRaisesRegex(validate_release.ReleaseValidationError, "secret material"):
            self._validate(entries)

    def test_rejects_duplicate_members(self) -> None:
        entries = self._valid_entries() + [("Makefile", b"replacement", 0o644, None)]
        with self.assertRaisesRegex(validate_release.ReleaseValidationError, "duplicate"):
            self._validate(entries)

    def test_rejects_missing_runtime_files(self) -> None:
        entries = [entry for entry in self._valid_entries() if entry[0] != "Makefile"]
        with self.assertRaisesRegex(validate_release.ReleaseValidationError, "missing required"):
            self._validate(entries)

    def test_rejects_non_executable_healthcheck(self) -> None:
        entries = [
            (name, content, 0o644 if name == "deploy/healthcheck.sh" else mode, member_type)
            for name, content, mode, member_type in self._valid_entries()
        ]
        with self.assertRaisesRegex(validate_release.ReleaseValidationError, "not executable"):
            self._validate(entries)

    def test_rejects_release_that_expands_beyond_limit(self) -> None:
        entries = self._valid_entries() + [("large.bin", b"12345", 0o644, None)]
        valid_size = sum(
            len(content) for _, content, _, member_type in self._valid_entries() if not member_type
        )
        with (
            mock.patch.object(validate_release, "MAX_UNPACKED_BYTES", valid_size + 4),
            self.assertRaisesRegex(validate_release.ReleaseValidationError, "size limit"),
        ):
            self._validate(entries)

    def test_rejects_existing_destination(self) -> None:
        archive = self._archive(self._valid_entries())
        destination = self.root / "release"
        destination.mkdir()

        with self.assertRaisesRegex(validate_release.ReleaseValidationError, "already exists"):
            validate_release.validate_and_extract(archive, destination)


if __name__ == "__main__":
    unittest.main()
