from __future__ import annotations

import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Union
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "rfc001a_rpc_probe.py"
SPEC = importlib.util.spec_from_file_location("rfc001a_rpc_probe", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load RFC-001A RPC probe")
rpc_probe = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = rpc_probe
SPEC.loader.exec_module(rpc_probe)

EXPECTED_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
OTHER_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
URL_SENTINEL = "URL_SECRET_SENTINEL"
RAW_SENTINEL = "RAW_RESPONSE_SECRET_SENTINEL"

Response = tuple[int, Union[dict[str, Any], list[Any], bytes]]
Responder = Callable[[dict[str, Any]], Response]


class QuietThreadingHTTPServer(ThreadingHTTPServer):
    def handle_error(self, request: object, client_address: object) -> None:
        del request, client_address


@contextmanager
def local_rpc_server(responder: Responder) -> Iterator[tuple[str, list[dict[str, Any]]]]:
    requests: list[dict[str, Any]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            try:
                content_length = int(self.headers["Content-Length"])
                request = json.loads(self.rfile.read(content_length).decode("utf-8"))
                if type(request) is not dict:
                    raise ValueError("request is not an object")
                requests.append(request)
                status, response = responder(request)
                body = response if isinstance(response, bytes) else json.dumps(response).encode()
            except Exception:
                status = 500
                body = b"test-server-failure"

            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            del format, args

    server = QuietThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    try:
        yield f"http://{host}:{port}/rpc/{URL_SENTINEL}?api-key={URL_SENTINEL}", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@contextmanager
def rpc_test_environment(
    responder: Responder,
) -> Iterator[tuple[str, list[dict[str, Any]], str]]:
    with local_rpc_server(responder) as (url, requests):  # noqa: SIM117
        with tempfile.TemporaryDirectory() as directory:
            yield url, requests, directory


def successful_response(request: dict[str, Any]) -> Response:
    if request.get("method") == "getGenesisHash":
        result: Any = EXPECTED_GENESIS
    elif request.get("method") == "getSlot":
        result = 123_456_789
    else:
        return 200, {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "error": {"code": -32601, "message": "unknown method"},
        }
    return 200, {"jsonrpc": "2.0", "id": request.get("id"), "result": result}


def metadata_with_uid(metadata: os.stat_result, uid: int) -> types.SimpleNamespace:
    return types.SimpleNamespace(
        st_dev=metadata.st_dev,
        st_ino=metadata.st_ino,
        st_mode=metadata.st_mode,
        st_size=metadata.st_size,
        st_uid=uid,
    )


class RpcProbeTests(unittest.TestCase):
    def _write_config(
        self,
        directory: str,
        payload: Any,
        *,
        mode: int = 0o600,
        directory_mode: int = 0o700,
    ) -> Path:
        canonical_directory = Path(directory).resolve(strict=True)
        secrets_directory = canonical_directory / "secrets"
        secrets_directory.mkdir(mode=directory_mode)
        secrets_directory.chmod(directory_mode)
        path = secrets_directory / "solana_rpc_endpoints.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        path.chmod(mode)
        return path

    def _run(
        self,
        config: Path,
        *,
        expected_genesis: str = EXPECTED_GENESIS,
        timeout: str = "2",
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--secrets-file",
                str(config),
                "--expected-genesis-hash",
                expected_genesis,
                "--timeout-seconds",
                timeout,
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )

    def assert_redacted(self, result: subprocess.CompletedProcess[str], *values: str) -> None:
        combined = result.stdout + result.stderr
        for value in values:
            self.assertNotIn(value, combined)

    def test_all_endpoints_pass_with_official_requests(self) -> None:
        with rpc_test_environment(successful_response) as (url, requests, directory):
            config = self._write_config(
                directory,
                [
                    {"name": "primary", "url": url},
                    {"name": "fallback-1", "url": url},
                ],
            )
            result = self._run(config)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(
            result.stdout,
            "RPC endpoint=primary slot=123456789\n"
            "RPC endpoint=fallback-1 slot=123456789\n"
            "PASS-RPC\n",
        )
        self.assertEqual(
            requests,
            [
                {
                    "jsonrpc": "2.0",
                    "id": "rfc001a-genesis",
                    "method": "getGenesisHash",
                },
                {
                    "jsonrpc": "2.0",
                    "id": "rfc001a-slot-confirmed",
                    "method": "getSlot",
                    "params": [{"commitment": "confirmed"}],
                },
                {
                    "jsonrpc": "2.0",
                    "id": "rfc001a-genesis",
                    "method": "getGenesisHash",
                },
                {
                    "jsonrpc": "2.0",
                    "id": "rfc001a-slot-confirmed",
                    "method": "getSlot",
                    "params": [{"commitment": "confirmed"}],
                },
            ],
        )
        self.assert_redacted(result, url, URL_SENTINEL)

    def test_genesis_mismatch_fails_closed(self) -> None:
        def responder(request: dict[str, Any]) -> Response:
            return 200, {
                "jsonrpc": "2.0",
                "id": request.get("id"),
                "result": OTHER_GENESIS,
            }

        with rpc_test_environment(responder) as (url, _, directory):
            result = self._run(self._write_config(directory, [{"name": "primary", "url": url}]))

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertEqual(
            result.stderr,
            "FAIL-RPC reason=GENESIS_MISMATCH endpoint=primary\n",
        )
        self.assert_redacted(result, url, URL_SENTINEL, OTHER_GENESIS)

    def test_json_rpc_error_is_redacted(self) -> None:
        def responder(request: dict[str, Any]) -> Response:
            return 200, {
                "jsonrpc": "2.0",
                "id": request.get("id"),
                "error": {
                    "code": -32000,
                    "message": RAW_SENTINEL,
                    "data": {"provider": URL_SENTINEL},
                },
            }

        with rpc_test_environment(responder) as (url, _, directory):
            result = self._run(self._write_config(directory, [{"name": "primary", "url": url}]))

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "FAIL-RPC reason=RPC_ERROR endpoint=primary\n")
        self.assert_redacted(result, url, URL_SENTINEL, RAW_SENTINEL)

    def test_http_error_body_and_url_are_redacted(self) -> None:
        def responder(request: dict[str, Any]) -> Response:
            del request
            return 503, f"{RAW_SENTINEL}:{URL_SENTINEL}".encode()

        with rpc_test_environment(responder) as (url, _, directory):
            result = self._run(self._write_config(directory, [{"name": "primary", "url": url}]))

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "FAIL-RPC reason=HTTP_ERROR endpoint=primary\n")
        self.assert_redacted(result, url, URL_SENTINEL, RAW_SENTINEL)

    def test_group_or_other_permissions_are_rejected_without_network(self) -> None:
        secret_url = f"https://example.invalid/{URL_SENTINEL}"
        with tempfile.TemporaryDirectory() as directory:
            config = self._write_config(
                directory,
                [{"name": "primary", "url": secret_url}],
                mode=0o640,
            )
            result = self._run(config)

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "FAIL-RPC reason=CONFIG_PERMISSIONS\n")
        self.assert_redacted(result, secret_url, URL_SENTINEL)

    def test_file_mode_must_be_exactly_0600(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = self._write_config(
                directory,
                [{"name": "primary", "url": "https://example.invalid"}],
                mode=0o400,
            )
            result = self._run(config)

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "FAIL-RPC reason=CONFIG_PERMISSIONS\n")

    def test_symlink_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            secrets_directory = Path(directory).resolve(strict=True) / "secrets"
            secrets_directory.mkdir(mode=0o700)
            target = secrets_directory / "actual.json"
            target.write_text(
                json.dumps([{"name": "primary", "url": "https://example.invalid"}]),
                encoding="utf-8",
            )
            target.chmod(0o600)
            link = secrets_directory / "solana_rpc_endpoints.json"
            try:
                os.symlink(target, link)
            except (NotImplementedError, OSError) as error:
                self.skipTest(f"symlink unavailable: {type(error).__name__}")

            result = self._run(link)

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "FAIL-RPC reason=CONFIG_SYMLINK\n")

    def test_secrets_directory_mode_must_be_exactly_0700(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = self._write_config(
                directory,
                [{"name": "primary", "url": "https://example.invalid"}],
                directory_mode=0o750,
            )
            result = self._run(config)

        self.assertEqual(result.returncode, 1)
        self.assertEqual(
            result.stderr,
            "FAIL-RPC reason=CONFIG_DIRECTORY_PERMISSIONS\n",
        )

    def test_secrets_directory_symlink_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            canonical_directory = Path(directory).resolve(strict=True)
            real_directory = canonical_directory / "real-secrets"
            real_directory.mkdir(mode=0o700)
            config = real_directory / "solana_rpc_endpoints.json"
            config.write_text(
                json.dumps([{"name": "primary", "url": "https://example.invalid"}]),
                encoding="utf-8",
            )
            config.chmod(0o600)
            link = canonical_directory / "secrets"
            try:
                os.symlink(real_directory, link)
            except (NotImplementedError, OSError) as error:
                self.skipTest(f"symlink unavailable: {type(error).__name__}")

            result = self._run(link / "solana_rpc_endpoints.json")

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "FAIL-RPC reason=CONFIG_DIRECTORY_SYMLINK\n")

    def test_any_ancestor_directory_symlink_is_rejected_without_reading_secret(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            canonical_directory = Path(directory).resolve(strict=True)
            real_ancestor = canonical_directory / "real-config"
            secrets_directory = real_ancestor / "secrets"
            secrets_directory.mkdir(parents=True, mode=0o700)
            secrets_directory.chmod(0o700)
            config = secrets_directory / "solana_rpc_endpoints.json"
            config.write_text(
                json.dumps(
                    [
                        {
                            "name": "primary",
                            "url": f"https://example.invalid/{URL_SENTINEL}",
                        }
                    ]
                ),
                encoding="utf-8",
            )
            config.chmod(0o600)
            ancestor_link = canonical_directory / "linked-config"
            try:
                os.symlink(real_ancestor, ancestor_link)
            except (NotImplementedError, OSError) as error:
                self.skipTest(f"symlink unavailable: {type(error).__name__}")

            linked_config = ancestor_link / "secrets" / "solana_rpc_endpoints.json"
            result = self._run(linked_config)

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "FAIL-RPC reason=CONFIG_PATH_SYMLINK\n")
        self.assert_redacted(result, str(ancestor_link), URL_SENTINEL)

    def test_secrets_file_path_must_be_absolute(self) -> None:
        relative_path = Path("solana_rpc_endpoints.json")
        result = self._run(relative_path)

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "FAIL-RPC reason=CONFIG_PATH_NOT_ABSOLUTE\n")

    def test_secrets_directory_owner_must_match_effective_user(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = self._write_config(
                directory,
                [{"name": "primary", "url": "https://example.invalid"}],
            )
            real_fstat = os.fstat

            def foreign_directory_owner(descriptor: int) -> object:
                metadata = real_fstat(descriptor)
                if stat.S_ISDIR(metadata.st_mode):
                    return metadata_with_uid(metadata, os.geteuid() + 1)
                return metadata

            fstat_patch = mock.patch.object(
                rpc_probe.os,
                "fstat",
                side_effect=foreign_directory_owner,
            )
            with fstat_patch, self.assertRaises(rpc_probe.ProbeFailure) as raised:
                rpc_probe.load_endpoints(config)

        self.assertEqual(raised.exception.reason, "CONFIG_DIRECTORY_OWNER")

    def test_secret_file_owner_must_match_effective_user(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = self._write_config(
                directory,
                [{"name": "primary", "url": "https://example.invalid"}],
            )
            real_fstat = os.fstat

            def foreign_file_owner(descriptor: int) -> object:
                metadata = real_fstat(descriptor)
                if stat.S_ISREG(metadata.st_mode):
                    return metadata_with_uid(metadata, os.geteuid() + 1)
                return metadata

            fstat_patch = mock.patch.object(
                rpc_probe.os,
                "fstat",
                side_effect=foreign_file_owner,
            )
            with fstat_patch, self.assertRaises(rpc_probe.ProbeFailure) as raised:
                rpc_probe.load_endpoints(config)

        self.assertEqual(raised.exception.reason, "CONFIG_OWNER")

    def test_strict_config_schema_rejects_extra_field_without_echoing_url(self) -> None:
        secret_url = f"https://example.invalid/{URL_SENTINEL}"
        with tempfile.TemporaryDirectory() as directory:
            config = self._write_config(
                directory,
                [{"name": "primary", "url": secret_url, "token": RAW_SENTINEL}],
            )
            result = self._run(config)

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "FAIL-RPC reason=CONFIG_SCHEMA\n")
        self.assert_redacted(result, secret_url, URL_SENTINEL, RAW_SENTINEL)

    def test_more_than_eight_endpoints_are_rejected_without_network(self) -> None:
        endpoints = [
            {"name": f"rpc-{index}", "url": "https://example.invalid"} for index in range(9)
        ]
        with tempfile.TemporaryDirectory() as directory:
            result = self._run(self._write_config(directory, endpoints))

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "FAIL-RPC reason=CONFIG_ENDPOINT_COUNT\n")

    def test_plain_http_is_restricted_to_explicit_loopback_hosts(self) -> None:
        rejected_urls = [
            f"http://192.0.2.1/{URL_SENTINEL}",
            f"http://example.invalid/{URL_SENTINEL}",
            f"http://127.1/{URL_SENTINEL}",
        ]
        for rejected_url in rejected_urls:
            with self.subTest(url_kind=rejected_url.split(":", maxsplit=1)[0]):
                with tempfile.TemporaryDirectory() as directory:
                    result = self._run(
                        self._write_config(
                            directory,
                            [{"name": "primary", "url": rejected_url}],
                        )
                    )

                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stderr, "FAIL-RPC reason=CONFIG_URL_INVALID\n")
                self.assert_redacted(result, rejected_url, URL_SENTINEL)

    def test_url_userinfo_is_rejected_without_echoing_credentials(self) -> None:
        userinfo = f"user:{RAW_SENTINEL}"
        secret_url = f"https://{userinfo}@example.invalid/rpc"
        with tempfile.TemporaryDirectory() as directory:
            result = self._run(
                self._write_config(
                    directory,
                    [{"name": "primary", "url": secret_url}],
                )
            )

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "FAIL-RPC reason=CONFIG_URL_INVALID\n")
        self.assert_redacted(result, secret_url, userinfo, RAW_SENTINEL)

    def test_plain_http_loopback_spellings_pass_config_validation(self) -> None:
        urls = [
            "http://127.0.0.1:8899",
            "http://[::1]:8899",
            "http://localhost:8899",
        ]
        for index, url in enumerate(urls):
            with self.subTest(url=url):
                with tempfile.TemporaryDirectory() as directory:
                    config = self._write_config(
                        directory,
                        [{"name": f"loopback-{index}", "url": url}],
                    )
                    endpoints = rpc_probe.load_endpoints(config)

                self.assertEqual(endpoints[0].name, f"loopback-{index}")

    def test_https_is_accepted_for_non_loopback_endpoint(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = self._write_config(
                directory,
                [{"name": "primary", "url": "https://example.invalid/rpc"}],
            )
            endpoints = rpc_probe.load_endpoints(config)

        self.assertEqual(endpoints[0].name, "primary")

    def test_wrong_response_id_fails_without_echoing_response(self) -> None:
        def responder(request: dict[str, Any]) -> Response:
            del request
            return 200, {
                "jsonrpc": "2.0",
                "id": RAW_SENTINEL,
                "result": EXPECTED_GENESIS,
            }

        with rpc_test_environment(responder) as (url, _, directory):
            result = self._run(self._write_config(directory, [{"name": "primary", "url": url}]))

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "FAIL-RPC reason=RESPONSE_ID endpoint=primary\n")
        self.assert_redacted(result, url, URL_SENTINEL, RAW_SENTINEL)

    def test_invalid_json_response_is_redacted(self) -> None:
        def responder(request: dict[str, Any]) -> Response:
            del request
            return 200, f'{{"partial":"{RAW_SENTINEL}"'.encode()

        with rpc_test_environment(responder) as (url, _, directory):
            result = self._run(self._write_config(directory, [{"name": "primary", "url": url}]))

        self.assertEqual(result.returncode, 1)
        self.assertEqual(
            result.stderr,
            "FAIL-RPC reason=RESPONSE_JSON_INVALID endpoint=primary\n",
        )
        self.assert_redacted(result, url, URL_SENTINEL, RAW_SENTINEL)

    def test_invalid_slot_type_fails_closed(self) -> None:
        def responder(request: dict[str, Any]) -> Response:
            result: Any = EXPECTED_GENESIS
            if request.get("method") == "getSlot":
                result = True
            return 200, {
                "jsonrpc": "2.0",
                "id": request.get("id"),
                "result": result,
            }

        with rpc_test_environment(responder) as (url, _, directory):
            result = self._run(self._write_config(directory, [{"name": "primary", "url": url}]))

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "FAIL-RPC reason=SLOT_INVALID endpoint=primary\n")
        self.assert_redacted(result, url, URL_SENTINEL)

    def test_unsafe_endpoint_name_is_never_echoed(self) -> None:
        unsafe_name = f"primary\n{RAW_SENTINEL}"
        secret_url = f"https://example.invalid/{URL_SENTINEL}"
        with tempfile.TemporaryDirectory() as directory:
            config = self._write_config(
                directory,
                [{"name": unsafe_name, "url": secret_url}],
            )
            result = self._run(config)

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "FAIL-RPC reason=CONFIG_NAME_INVALID\n")
        self.assert_redacted(result, unsafe_name, secret_url, URL_SENTINEL, RAW_SENTINEL)

    def test_timeout_is_one_deadline_across_both_rpc_calls(self) -> None:
        def delayed_response(request: dict[str, Any]) -> Response:
            time.sleep(0.65)
            return successful_response(request)

        with rpc_test_environment(delayed_response) as (url, _, directory):
            result = self._run(
                self._write_config(directory, [{"name": "primary", "url": url}]),
                timeout="1",
            )

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "FAIL-RPC reason=TIMEOUT endpoint=primary\n")
        self.assert_redacted(result, url, URL_SENTINEL)

    def test_timeout_must_be_explicitly_within_bounds(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = self._write_config(
                directory,
                [{"name": "primary", "url": "https://example.invalid"}],
            )
            result = self._run(config, timeout="0.5")

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "FAIL-RPC reason=TIMEOUT_INVALID\n")


if __name__ == "__main__":
    unittest.main()
