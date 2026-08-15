from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "rfc001a_secrets.py"
SPEC = importlib.util.spec_from_file_location("rfc001a_secrets", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load RFC-001A secret helper")
rfc001a_secrets = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = rfc001a_secrets
SPEC.loader.exec_module(rfc001a_secrets)


ENV_ENDPOINT = "https://yellowstone-env.test:10000"
ENV_TOKEN = "synthetic-env-token-7Qp9"
ENV_RPC_URL = "https://rpc-env.test/?api-key=synthetic-env-rpc-4Lm"
JSON_ENDPOINT = "https://yellowstone-json.test:10000"
JSON_TOKEN = "synthetic-json-token-2Wk8"
JSON_RPC_URL = "https://rpc-json.test/?api-key=synthetic-json-rpc-6Nz"


def _safe_environment() -> dict[str, str]:
    environment = dict(os.environ)
    for name in rfc001a_secrets.ENV_FIELDS:
        environment.pop(name, None)
    return environment


def _write_secure(path: Path, payload: str | bytes) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if isinstance(payload, bytes):
        path.write_bytes(payload)
    else:
        path.write_text(payload, encoding="utf-8")
    path.chmod(0o600)


def _env_payload(
    *,
    endpoint: str = ENV_ENDPOINT,
    token: str = ENV_TOKEN,
    rpc_url: str = ENV_RPC_URL,
) -> str:
    return (
        "DRY_RUN=true\n"
        "DATABASE_URL=postgresql://synthetic-database-value\n"
        f"GEYSER_URL={endpoint}\n"
        f"GEYSER_TOKEN={token}\n"
        f"RPC_ENDPOINTS=env-primary={rpc_url}\n"
    )


def _json_payload(
    *,
    endpoint: str | None = JSON_ENDPOINT,
    token: str | None = JSON_TOKEN,
    endpoints: list[dict[str, str]] | None = None,
) -> dict[str, object]:
    result: dict[str, object] = {
        "rpcEndpoints": endpoints
        if endpoints is not None
        else [{"name": "json-primary", "url": JSON_RPC_URL}],
        "jitoBlockEngine": "https://jito-json.test",
        "dryRun": True,
        "savedAt": "2026-08-10T12:00:00Z",
    }
    if endpoint is not None:
        result["geyserUrl"] = endpoint
    if token is not None:
        result["geyserToken"] = token
    return result


def _run(
    *arguments: str,
    environment: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *arguments],
        check=False,
        capture_output=True,
        text=True,
        env=environment or _safe_environment(),
    )


class Rfc001ASecretsTests(unittest.TestCase):
    def test_json_overrides_env_per_field_and_output_schema_is_strict(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / "old"
            source.mkdir(mode=0o700)
            _write_secure(source / ".env", _env_payload())
            _write_secure(
                source / "data" / "credentials.json",
                json.dumps(_json_payload()),
            )
            destination = root / "secrets"

            result = _run(
                "migrate",
                "--source-dir",
                str(source),
                "--destination-dir",
                str(destination),
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                (destination / "yellowstone_endpoint").read_text(encoding="utf-8").strip(),
                JSON_ENDPOINT,
            )
            self.assertEqual(
                (destination / "yellowstone_token").read_text(encoding="utf-8").strip(),
                JSON_TOKEN,
            )
            rpc = json.loads(
                (destination / "solana_rpc_endpoints.json").read_text(encoding="utf-8")
            )
            self.assertEqual(rpc, [{"name": "json-primary", "url": JSON_RPC_URL}])
            self.assertEqual(set(rpc[0]), {"name", "url"})
            self.assertEqual(
                {path.name for path in destination.iterdir()},
                set(rfc001a_secrets.DESTINATION_FILES),
            )

    def test_missing_json_fields_and_empty_rpc_array_fall_back_per_field(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / "old"
            source.mkdir(mode=0o700)
            _write_secure(source / ".env", _env_payload())
            override = _json_payload(token=None, endpoints=[])
            _write_secure(
                source / "data" / "credentials.json",
                json.dumps(override),
            )
            destination = root / "secrets"

            result = _run(
                "migrate",
                "--source-dir",
                str(source),
                "--destination-dir",
                str(destination),
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                (destination / "yellowstone_endpoint").read_text(encoding="utf-8").strip(),
                JSON_ENDPOINT,
            )
            self.assertEqual(
                (destination / "yellowstone_token").read_text(encoding="utf-8").strip(),
                ENV_TOKEN,
            )
            self.assertEqual(
                json.loads((destination / "solana_rpc_endpoints.json").read_text(encoding="utf-8")),
                [{"name": "env-primary", "url": ENV_RPC_URL}],
            )

    def test_inventory_prints_only_redacted_metadata_and_names(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory).resolve() / "old"
            source.mkdir(mode=0o700)
            database_value = "synthetic-database-sentinel-3Vc"
            env_payload = _env_payload().replace(
                "postgresql://synthetic-database-value", database_value
            )
            _write_secure(source / ".env", env_payload)
            _write_secure(
                source / "data" / "credentials.json",
                json.dumps(_json_payload()),
            )

            result = _run("inventory", "--source-dir", str(source))
            combined = result.stdout + result.stderr

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("source name=.env presence=yes mode=0600 size=", result.stdout)
            self.assertIn("env name=GEYSER_TOKEN presence=yes", result.stdout)
            self.assertIn("env name=DATABASE_URL presence=yes", result.stdout)
            self.assertIn("json name=rpcEndpoints presence=yes", result.stdout)
            for secret_value in (
                ENV_ENDPOINT,
                ENV_TOKEN,
                ENV_RPC_URL,
                JSON_ENDPOINT,
                JSON_TOKEN,
                JSON_RPC_URL,
                database_value,
            ):
                self.assertNotIn(secret_value, combined)

    def test_placeholder_is_rejected_without_value_disclosure_or_writes(self) -> None:
        placeholder = "YOUR_GEYSER_TOKEN-private-sentinel"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / "old"
            source.mkdir(mode=0o700)
            _write_secure(source / ".env", _env_payload())
            _write_secure(
                source / "data" / "credentials.json",
                json.dumps(_json_payload(token=placeholder)),
            )
            destination = root / "secrets"

            result = _run(
                "migrate",
                "--source-dir",
                str(source),
                "--destination-dir",
                str(destination),
            )
            combined = result.stdout + result.stderr

            self.assertEqual(result.returncode, 2)
            self.assertIn("placeholder", result.stderr)
            self.assertIn("source name=.env presence=yes mode=0600 size=", result.stdout)
            self.assertIn("env name=GEYSER_TOKEN presence=yes", result.stdout)
            self.assertIn("json name=geyserToken presence=yes", result.stdout)
            self.assertNotIn(placeholder, combined)
            self.assertFalse(destination.exists())

    def test_existing_destination_file_is_not_overwritten(self) -> None:
        existing_value = "preexisting-destination-sentinel-5Hs"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / "old"
            source.mkdir(mode=0o700)
            _write_secure(source / ".env", _env_payload())
            destination = root / "secrets"
            destination.mkdir(mode=0o700)
            existing = destination / "yellowstone_token"
            _write_secure(existing, existing_value)

            result = _run(
                "migrate",
                "--source-dir",
                str(source),
                "--destination-dir",
                str(destination),
            )

            self.assertEqual(result.returncode, 2)
            self.assertEqual(existing.read_text(encoding="utf-8"), existing_value)
            self.assertFalse((destination / "yellowstone_endpoint").exists())
            self.assertFalse((destination / "solana_rpc_endpoints.json").exists())
            self.assertNotIn(existing_value, result.stdout + result.stderr)

    def test_destination_directory_and_files_have_exact_modes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / "old"
            source.mkdir(mode=0o700)
            _write_secure(source / ".env", _env_payload())
            destination = root / "secrets"

            result = _run(
                "migrate",
                "--source-dir",
                str(source),
                "--destination-dir",
                str(destination),
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o700)
            for name in rfc001a_secrets.DESTINATION_FILES:
                self.assertEqual(stat.S_IMODE((destination / name).stat().st_mode), 0o600)

    def test_insecure_source_and_destination_permissions_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / "old"
            source.mkdir(mode=0o700)
            env_path = source / ".env"
            _write_secure(env_path, _env_payload())
            env_path.chmod(0o644)
            destination = root / "secrets"

            source_result = _run(
                "migrate",
                "--source-dir",
                str(source),
                "--destination-dir",
                str(destination),
            )
            self.assertEqual(source_result.returncode, 2)
            self.assertFalse(destination.exists())

            env_path.chmod(0o600)
            destination.mkdir(mode=0o755)
            destination_result = _run(
                "migrate",
                "--source-dir",
                str(source),
                "--destination-dir",
                str(destination),
            )
            self.assertEqual(destination_result.returncode, 2)
            self.assertIn("0700", destination_result.stderr)

            destination.chmod(0o700)
            insecure_parent = root / "insecure-parent"
            insecure_parent.mkdir(mode=0o755)
            parent_result = _run(
                "migrate",
                "--source-dir",
                str(source),
                "--destination-dir",
                str(insecure_parent / "secrets"),
            )
            self.assertEqual(parent_result.returncode, 2)
            self.assertIn("parent", parent_result.stderr)
            self.assertIn("0700", parent_result.stderr)

    def test_source_and_destination_symlinks_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / "old"
            source.mkdir(mode=0o700)
            real_env = root / "real-env"
            _write_secure(real_env, _env_payload())
            (source / ".env").symlink_to(real_env)

            source_result = _run(
                "migrate",
                "--source-dir",
                str(source),
                "--destination-dir",
                str(root / "secrets"),
            )
            self.assertEqual(source_result.returncode, 2)
            self.assertIn("symlink", source_result.stderr)

            (source / ".env").unlink()
            _write_secure(source / ".env", _env_payload())
            real_destination = root / "real-destination"
            real_destination.mkdir(mode=0o700)
            linked_destination = root / "linked-destination"
            linked_destination.symlink_to(real_destination, target_is_directory=True)
            destination_result = _run(
                "migrate",
                "--source-dir",
                str(source),
                "--destination-dir",
                str(linked_destination),
            )
            self.assertEqual(destination_result.returncode, 2)
            self.assertIn("symlink", destination_result.stderr)

    def test_ancestor_symlink_components_and_relative_paths_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            real_parent = root / "real-parent"
            real_parent.mkdir(mode=0o700)
            source = real_parent / "old"
            source.mkdir(mode=0o700)
            _write_secure(source / ".env", _env_payload())
            linked_parent = root / "linked-parent"
            linked_parent.symlink_to(real_parent, target_is_directory=True)

            source_result = _run(
                "migrate",
                "--source-dir",
                str(linked_parent / "old"),
                "--destination-dir",
                str(root / "secrets"),
            )
            destination_result = _run(
                "migrate",
                "--source-dir",
                str(source),
                "--destination-dir",
                str(linked_parent / "new-secrets"),
            )
            relative_result = _run("inventory", "--source-dir", "relative/source")

            self.assertEqual(source_result.returncode, 2)
            self.assertIn("symlink component", source_result.stderr)
            self.assertEqual(destination_result.returncode, 2)
            self.assertIn("symlink component", destination_result.stderr)
            self.assertEqual(relative_result.returncode, 2)
            self.assertIn("absolute path", relative_result.stderr)
            self.assertFalse((root / "secrets").exists())
            self.assertFalse((real_parent / "new-secrets").exists())

    def test_destination_cannot_be_inside_historical_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / "old"
            source.mkdir(mode=0o700)
            _write_secure(source / ".env", _env_payload())
            destination = source / "new-secrets"

            result = _run(
                "migrate",
                "--source-dir",
                str(source),
                "--destination-dir",
                str(destination),
            )

            self.assertEqual(result.returncode, 2)
            self.assertIn("outside", result.stderr)
            self.assertFalse(destination.exists())

    def test_unknown_json_schema_is_rejected_without_echoing_unknown_content(self) -> None:
        unknown_value = "unknown-schema-private-sentinel-8Jd"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / "old"
            source.mkdir(mode=0o700)
            _write_secure(source / ".env", _env_payload())
            payload = _json_payload()
            payload["unexpectedSecretField"] = unknown_value
            _write_secure(source / "data" / "credentials.json", json.dumps(payload))

            result = _run(
                "migrate",
                "--source-dir",
                str(source),
                "--destination-dir",
                str(root / "secrets"),
            )

            self.assertEqual(result.returncode, 2)
            self.assertIn("unknown schema", result.stderr)
            self.assertNotIn(unknown_value, result.stdout + result.stderr)

    def test_nul_and_multiline_values_are_rejected_without_disclosure(self) -> None:
        nul_value = b"synthetic-token-before\0synthetic-token-after"
        multiline_value = "synthetic-token-line-one\nsynthetic-token-line-two"
        for payload, sentinel in (
            (
                b'{"rpcEndpoints":[],"geyserUrl":"https://yellowstone.test","geyserToken":"'
                + nul_value
                + b'"}',
                "synthetic-token-before",
            ),
            (json.dumps(_json_payload(token=multiline_value)).encode("utf-8"), multiline_value),
        ):
            with self.subTest(sentinel=sentinel), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                source = root / "old"
                source.mkdir(mode=0o700)
                _write_secure(source / ".env", _env_payload())
                _write_secure(source / "data" / "credentials.json", payload)

                result = _run(
                    "migrate",
                    "--source-dir",
                    str(source),
                    "--destination-dir",
                    str(root / "secrets"),
                )

                self.assertEqual(result.returncode, 2)
                self.assertNotIn(sentinel, result.stdout + result.stderr)
                self.assertFalse((root / "secrets").exists())

    def test_manual_refuses_secret_environment_and_unknown_argv_without_echoing(self) -> None:
        environment_value = "manual-environment-private-sentinel-9Tx"
        argv_value = "manual-argv-private-sentinel-1Kb"
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory).resolve() / "secrets"
            environment = _safe_environment()
            environment["GEYSER_TOKEN"] = environment_value

            environment_result = _run(
                "manual",
                "--destination-dir",
                str(destination),
                environment=environment,
            )
            argv_result = _run(
                "manual",
                "--destination-dir",
                str(destination),
                argv_value,
            )

            self.assertEqual(environment_result.returncode, 2)
            self.assertIn("GEYSER_TOKEN", environment_result.stderr)
            self.assertNotIn(
                environment_value, environment_result.stdout + environment_result.stderr
            )
            self.assertEqual(argv_result.returncode, 2)
            self.assertNotIn(argv_value, argv_result.stdout + argv_result.stderr)
            self.assertFalse(destination.exists())

    def test_manual_uses_getpass_and_writes_only_after_all_values_validate(self) -> None:
        manual_rpc = json.dumps([{"name": "manual-primary", "url": JSON_RPC_URL}])
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory).resolve() / "secrets"
            fake_stdin = mock.Mock()
            fake_stdin.isatty.return_value = True
            output = io.StringIO()
            clean_environment = {
                key: value
                for key, value in os.environ.items()
                if key not in rfc001a_secrets.ENV_FIELDS
            }

            with (
                mock.patch.dict(os.environ, clean_environment, clear=True),
                mock.patch.object(rfc001a_secrets.sys, "stdin", fake_stdin),
                mock.patch.object(
                    rfc001a_secrets.getpass,
                    "getpass",
                    side_effect=[JSON_ENDPOINT, JSON_TOKEN, manual_rpc],
                ) as hidden_input,
                contextlib.redirect_stdout(output),
            ):
                rfc001a_secrets.run_manual(destination)

            self.assertEqual(hidden_input.call_count, 3)
            combined = output.getvalue()
            self.assertNotIn(JSON_ENDPOINT, combined)
            self.assertNotIn(JSON_TOKEN, combined)
            self.assertNotIn(JSON_RPC_URL, combined)
            self.assertEqual(
                (destination / "yellowstone_token").read_text(encoding="utf-8").strip(),
                JSON_TOKEN,
            )

    def test_partial_creation_is_rolled_back_on_write_failure(self) -> None:
        secrets = rfc001a_secrets.EffectiveSecrets(
            yellowstone_endpoint=JSON_ENDPOINT,
            yellowstone_token=JSON_TOKEN,
            rpc_endpoints=[{"name": "json-primary", "url": JSON_RPC_URL}],
        )
        real_write = os.write
        calls = 0

        def fail_second_write(descriptor: int, payload: bytes) -> int:
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("synthetic write failure")
            return real_write(descriptor, payload)

        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory).resolve() / "secrets"
            with (
                mock.patch.object(rfc001a_secrets.os, "write", side_effect=fail_second_write),
                self.assertRaises(rfc001a_secrets.SecretToolError),
            ):
                rfc001a_secrets._write_secrets(destination, secrets)

            self.assertFalse(destination.exists())

    def test_rpc_contract_limits_names_count_and_url_shape(self) -> None:
        valid_loopback = [{"name": "rpc_1.primary", "url": "http://127.0.0.1:8899"}]
        self.assertEqual(
            rfc001a_secrets._validate_rpc_endpoints(valid_loopback, "test RPC"),
            valid_loopback,
        )

        invalid_sets = (
            [{"name": "contains space", "url": JSON_RPC_URL}],
            [{"name": f"rpc-{index}", "url": JSON_RPC_URL} for index in range(9)],
            [
                {"name": "same", "url": JSON_RPC_URL},
                {"name": "same", "url": "https://rpc-secondary.test"},
            ],
            [{"name": "rpc", "url": "http://rpc-external.test"}],
            [{"name": "rpc", "url": "https://user@rpc-json.test"}],
            [{"name": "rpc", "url": "https://rpc-json.test/#fragment"}],
        )
        for endpoints in invalid_sets:
            with (
                self.subTest(endpoints=endpoints),
                self.assertRaises(rfc001a_secrets.SecretToolError),
            ):
                rfc001a_secrets._validate_rpc_endpoints(endpoints, "test RPC")

    def test_yellowstone_url_rejects_query_but_rpc_url_allows_it(self) -> None:
        with self.assertRaises(rfc001a_secrets.SecretToolError):
            rfc001a_secrets._validate_url(
                "https://yellowstone-query.test/?x-token=synthetic",
                "Yellowstone",
                yellowstone=True,
            )
        self.assertEqual(
            rfc001a_secrets._validate_url(JSON_RPC_URL, "RPC"),
            JSON_RPC_URL,
        )


if __name__ == "__main__":
    unittest.main()
