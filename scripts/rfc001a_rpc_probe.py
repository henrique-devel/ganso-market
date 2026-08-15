#!/usr/bin/env python3
"""Fail-closed, redacted Solana RPC probe for RFC-001A."""

from __future__ import annotations

import argparse
import errno
import http.client
import json
import math
import os
import re
import socket
import ssl
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

CONFIG_BASENAME = "solana_rpc_endpoints.json"
MAX_CONFIG_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 64 * 1024
MAX_ENDPOINTS = 8
MAX_U64 = (1 << 64) - 1
SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
BASE58 = re.compile(r"[1-9A-HJ-NP-Za-km-z]{16,128}\Z")


class ProbeFailure(Exception):
    """An intentionally detail-free failure safe to report to the operator."""

    def __init__(self, reason: str, endpoint: str | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.endpoint = endpoint


class _RejectedJSON(ValueError):
    pass


class _SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        del message
        raise ProbeFailure("ARGUMENTS_INVALID")


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        request: urllib.request.Request,
        file_pointer: Any,
        code: int,
        message: str,
        headers: Any,
        new_url: str,
    ) -> None:
        del request, file_pointer, code, message, headers, new_url
        return None


@dataclass(frozen=True)
class Endpoint:
    name: str
    url: str = field(repr=False)


@dataclass(frozen=True)
class ProbeResult:
    name: str
    slot: int


def _object_without_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _RejectedJSON("duplicate key")
        result[key] = value
    return result


def _reject_non_standard_number(value: str) -> None:
    del value
    raise _RejectedJSON("non-standard number")


def _decode_json(raw: bytes, reason: str, endpoint: str | None = None) -> Any:
    try:
        text = raw.decode("utf-8")
        return json.loads(
            text,
            object_pairs_hook=_object_without_duplicate_keys,
            parse_constant=_reject_non_standard_number,
        )
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise ProbeFailure(reason, endpoint) from None


def _directory_flags() -> int:
    flags = os.O_RDONLY
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    return flags


def _component_reason(immediate: bool, suffix: str) -> str:
    prefix = "CONFIG_DIRECTORY" if immediate else "CONFIG_PATH"
    return f"{prefix}_{suffix}"


def _open_directory_component(
    parent_descriptor: int,
    component: str,
    *,
    immediate: bool,
) -> int:
    try:
        before = os.stat(
            component,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
    except OSError:
        raise ProbeFailure(_component_reason(immediate, "IO")) from None

    if stat.S_ISLNK(before.st_mode):
        raise ProbeFailure(_component_reason(immediate, "SYMLINK"))
    if not stat.S_ISDIR(before.st_mode):
        raise ProbeFailure(_component_reason(immediate, "NOT_DIRECTORY"))

    try:
        descriptor = os.open(
            component,
            _directory_flags(),
            dir_fd=parent_descriptor,
        )
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise ProbeFailure(_component_reason(immediate, "SYMLINK")) from None
        raise ProbeFailure(_component_reason(immediate, "IO")) from None

    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISDIR(opened.st_mode):
            raise ProbeFailure(_component_reason(immediate, "NOT_DIRECTORY"))
        if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
            raise ProbeFailure(_component_reason(immediate, "CHANGED"))
    except ProbeFailure:
        os.close(descriptor)
        raise
    except OSError:
        os.close(descriptor)
        raise ProbeFailure(_component_reason(immediate, "IO")) from None
    return descriptor


def _open_secure_directory(path: Path) -> int:
    components = path.parts[1:]
    if any(component in {"", ".", ".."} for component in components):
        raise ProbeFailure("CONFIG_PATH_COMPONENT_INVALID")

    try:
        root_before = os.lstat("/")
        descriptor = os.open("/", _directory_flags())
    except OSError:
        raise ProbeFailure("CONFIG_PATH_IO") from None

    try:
        root_opened = os.fstat(descriptor)
        if not stat.S_ISDIR(root_opened.st_mode):
            raise ProbeFailure("CONFIG_PATH_NOT_DIRECTORY")
        if (root_before.st_dev, root_before.st_ino) != (
            root_opened.st_dev,
            root_opened.st_ino,
        ):
            raise ProbeFailure("CONFIG_PATH_CHANGED")

        for index, component in enumerate(components):
            next_descriptor = _open_directory_component(
                descriptor,
                component,
                immediate=index == len(components) - 1,
            )
            previous_descriptor = descriptor
            descriptor = next_descriptor
            os.close(previous_descriptor)

        immediate_directory = os.fstat(descriptor)
        if immediate_directory.st_uid != os.geteuid():
            raise ProbeFailure("CONFIG_DIRECTORY_OWNER")
        if stat.S_IMODE(immediate_directory.st_mode) != 0o700:
            raise ProbeFailure("CONFIG_DIRECTORY_PERMISSIONS")
    except ProbeFailure:
        os.close(descriptor)
        raise
    except OSError:
        os.close(descriptor)
        raise ProbeFailure("CONFIG_DIRECTORY_IO") from None
    return descriptor


def _read_secure_config(path: Path) -> bytes:
    if not path.is_absolute() or path.anchor != "/":
        raise ProbeFailure("CONFIG_PATH_NOT_ABSOLUTE")
    if path.name != CONFIG_BASENAME:
        raise ProbeFailure("CONFIG_BASENAME_INVALID")

    directory_descriptor = _open_secure_directory(path.parent)
    try:
        try:
            before = os.stat(
                path.name,
                dir_fd=directory_descriptor,
                follow_symlinks=False,
            )
        except OSError:
            raise ProbeFailure("CONFIG_IO") from None

        if stat.S_ISLNK(before.st_mode):
            raise ProbeFailure("CONFIG_SYMLINK")
        if not stat.S_ISREG(before.st_mode):
            raise ProbeFailure("CONFIG_NOT_REGULAR")

        flags = os.O_RDONLY
        if hasattr(os, "O_CLOEXEC"):
            flags |= os.O_CLOEXEC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW

        try:
            descriptor = os.open(path.name, flags, dir_fd=directory_descriptor)
        except OSError as error:
            if error.errno == errno.ELOOP:
                raise ProbeFailure("CONFIG_SYMLINK") from None
            raise ProbeFailure("CONFIG_IO") from None

        try:
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode):
                raise ProbeFailure("CONFIG_NOT_REGULAR")
            if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
                raise ProbeFailure("CONFIG_CHANGED")
            if opened.st_uid != os.geteuid():
                raise ProbeFailure("CONFIG_OWNER")
            if stat.S_IMODE(opened.st_mode) != 0o600:
                raise ProbeFailure("CONFIG_PERMISSIONS")
            if opened.st_size > MAX_CONFIG_BYTES:
                raise ProbeFailure("CONFIG_TOO_LARGE")

            chunks: list[bytes] = []
            remaining = MAX_CONFIG_BYTES + 1
            while remaining:
                chunk = os.read(descriptor, min(remaining, 8192))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            raw = b"".join(chunks)
        except ProbeFailure:
            raise
        except OSError:
            raise ProbeFailure("CONFIG_IO") from None
        finally:
            os.close(descriptor)
    finally:
        os.close(directory_descriptor)

    if len(raw) > MAX_CONFIG_BYTES:
        raise ProbeFailure("CONFIG_TOO_LARGE")
    return raw


def _validate_url(url: str) -> bool:
    if not 1 <= len(url) <= 8192:
        return False
    if any(ord(character) < 0x21 or ord(character) > 0x7E for character in url):
        return False
    if "\\" in url:
        return False
    try:
        parsed = urllib.parse.urlsplit(url)
        hostname = parsed.hostname
        _ = parsed.port
        username = parsed.username
        password = parsed.password
    except (UnicodeError, ValueError):
        return False
    if not parsed.netloc or not hostname or parsed.fragment:
        return False
    if username is not None or password is not None:
        return False
    if parsed.scheme == "https":
        return True
    return parsed.scheme == "http" and hostname in {"127.0.0.1", "::1", "localhost"}


def load_endpoints(path: Path) -> list[Endpoint]:
    payload = _decode_json(_read_secure_config(path), "CONFIG_JSON_INVALID")
    if type(payload) is not list:
        raise ProbeFailure("CONFIG_SCHEMA")
    if not 1 <= len(payload) <= MAX_ENDPOINTS:
        raise ProbeFailure("CONFIG_ENDPOINT_COUNT")

    endpoints: list[Endpoint] = []
    names: set[str] = set()
    for item in payload:
        if type(item) is not dict or set(item) != {"name", "url"}:
            raise ProbeFailure("CONFIG_SCHEMA")
        name = item["name"]
        url = item["url"]
        if type(name) is not str or SAFE_NAME.fullmatch(name) is None:
            raise ProbeFailure("CONFIG_NAME_INVALID")
        if name in names:
            raise ProbeFailure("CONFIG_NAME_DUPLICATE")
        if type(url) is not str or not _validate_url(url):
            raise ProbeFailure("CONFIG_URL_INVALID")
        names.add(name)
        endpoints.append(Endpoint(name=name, url=url))
    return endpoints


def _valid_genesis_hash(value: Any) -> bool:
    return type(value) is str and BASE58.fullmatch(value) is not None


def _network_failure(error: urllib.error.URLError, endpoint: str) -> ProbeFailure:
    reason = error.reason
    if isinstance(reason, ssl.SSLError):
        return ProbeFailure("TLS_ERROR", endpoint)
    if isinstance(reason, (socket.timeout, TimeoutError)):
        return ProbeFailure("TIMEOUT", endpoint)
    return ProbeFailure("NETWORK_ERROR", endpoint)


def _remaining_seconds(deadline: float, endpoint: str) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ProbeFailure("TIMEOUT", endpoint)
    return remaining


def _open_request(request: urllib.request.Request, deadline: float, endpoint: str) -> bytes:
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        _RejectRedirects(),
    )
    try:
        with opener.open(
            request,
            timeout=_remaining_seconds(deadline, endpoint),
        ) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError:
        raise ProbeFailure("HTTP_ERROR", endpoint) from None
    except urllib.error.URLError as error:
        raise _network_failure(error, endpoint) from None
    except ssl.SSLError:
        raise ProbeFailure("TLS_ERROR", endpoint) from None
    except (socket.timeout, TimeoutError):
        raise ProbeFailure("TIMEOUT", endpoint) from None
    except (http.client.HTTPException, OSError):
        raise ProbeFailure("NETWORK_ERROR", endpoint) from None
    except (UnicodeError, ValueError):
        raise ProbeFailure("CONFIG_URL_INVALID", endpoint) from None

    _remaining_seconds(deadline, endpoint)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ProbeFailure("RESPONSE_TOO_LARGE", endpoint)
    return raw


def _rpc_call(
    endpoint: Endpoint,
    method: str,
    request_id: str,
    deadline: float,
    params: list[dict[str, str]] | None = None,
) -> Any:
    payload: dict[str, Any] = {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
    }
    if params is not None:
        payload["params"] = params
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    request = urllib.request.Request(
        endpoint.url,
        data=body,
        headers={"Accept": "application/json", "Content-Type": "application/json"},
        method="POST",
    )
    response = _decode_json(
        _open_request(request, deadline, endpoint.name),
        "RESPONSE_JSON_INVALID",
        endpoint.name,
    )

    if type(response) is not dict:
        raise ProbeFailure("RESPONSE_SCHEMA", endpoint.name)
    if not set(response).issubset({"jsonrpc", "id", "result", "error"}):
        raise ProbeFailure("RESPONSE_SCHEMA", endpoint.name)
    if response.get("jsonrpc") != "2.0":
        raise ProbeFailure("RESPONSE_SCHEMA", endpoint.name)
    if type(response.get("id")) is not str or response["id"] != request_id:
        raise ProbeFailure("RESPONSE_ID", endpoint.name)
    has_result = "result" in response
    has_error = "error" in response
    if has_result == has_error:
        raise ProbeFailure("RESPONSE_SCHEMA", endpoint.name)
    if has_error:
        raise ProbeFailure("RPC_ERROR", endpoint.name)
    _remaining_seconds(deadline, endpoint.name)
    return response["result"]


def probe_all(
    endpoints: Sequence[Endpoint], expected_genesis_hash: str, timeout: float
) -> list[ProbeResult]:
    if not _valid_genesis_hash(expected_genesis_hash):
        raise ProbeFailure("EXPECTED_GENESIS_INVALID")
    if not math.isfinite(timeout) or not 1 <= timeout <= 300:
        raise ProbeFailure("TIMEOUT_INVALID")

    deadline = time.monotonic() + timeout
    results: list[ProbeResult] = []
    for endpoint in endpoints:
        genesis_hash = _rpc_call(
            endpoint,
            method="getGenesisHash",
            request_id="rfc001a-genesis",
            deadline=deadline,
        )
        if not _valid_genesis_hash(genesis_hash):
            raise ProbeFailure("GENESIS_INVALID", endpoint.name)
        if genesis_hash != expected_genesis_hash:
            raise ProbeFailure("GENESIS_MISMATCH", endpoint.name)

        slot = _rpc_call(
            endpoint,
            method="getSlot",
            request_id="rfc001a-slot-confirmed",
            deadline=deadline,
            params=[{"commitment": "confirmed"}],
        )
        if type(slot) is not int or not 0 <= slot <= MAX_U64:
            raise ProbeFailure("SLOT_INVALID", endpoint.name)
        results.append(ProbeResult(name=endpoint.name, slot=slot))
    return results


def _parse_arguments(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = _SafeArgumentParser(description="Run the redacted RFC-001A Solana RPC probe.")
    parser.add_argument("--secrets-file", required=True, type=Path)
    parser.add_argument("--expected-genesis-hash", required=True)
    parser.add_argument("--timeout-seconds", required=True, type=float)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        arguments = _parse_arguments(argv)
        results = probe_all(
            load_endpoints(arguments.secrets_file),
            arguments.expected_genesis_hash,
            arguments.timeout_seconds,
        )
    except ProbeFailure as failure:
        fields = ["FAIL-RPC", f"reason={failure.reason}"]
        if failure.endpoint is not None:
            fields.append(f"endpoint={failure.endpoint}")
        print(" ".join(fields), file=sys.stderr)
        return 1
    except Exception:
        print("FAIL-RPC reason=INTERNAL_ERROR", file=sys.stderr)
        return 1

    for result in results:
        print(f"RPC endpoint={result.name} slot={result.slot}")
    print("PASS-RPC")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
