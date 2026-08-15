#!/usr/bin/env python3
"""Redacted RFC-001A inventory and migration for Yellowstone/RPC secrets.

The helper intentionally supports only the historical Ganso-bot credential
sources and the three Ganso Market destination files named by RFC-001A.  It
never accepts secret values as command-line arguments.
"""

from __future__ import annotations

import argparse
import contextlib
import getpass
import json
import os
import re
import stat
import sys
import warnings
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

ENV_FIELDS = ("GEYSER_URL", "GEYSER_TOKEN", "RPC_ENDPOINTS")
JSON_FIELDS = (
    "rpcEndpoints",
    "geyserUrl",
    "geyserToken",
    "jitoBlockEngine",
    "dryRun",
    "savedAt",
)
DESTINATION_FILES = (
    "yellowstone_endpoint",
    "yellowstone_token",
    "solana_rpc_endpoints.json",
)
MAX_SOURCE_BYTES = 1024 * 1024
MAX_VALUE_CHARS = 64 * 1024

_ENV_ASSIGNMENT = re.compile(r"^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$")
_RPC_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_PLACEHOLDER = re.compile(
    r"(?:"
    r"\byour(?:[_-][a-z0-9]+)*\b|"
    r"\bplaceholder\b|"
    r"\bchange[-_ ]?me\b|"
    r"\breplace[-_ ]?me\b|"
    r"\bredacted\b|"
    r"\bdummy\b|"
    r"\bfake\b|"
    r"\btodo\b|"
    r"\btbd\b|"
    r"\bunset\b|"
    r"\bnot[-_ ]?set\b|"
    r"\$\{[^}\r\n]+\}|"
    r"<[^>\r\n]+>|"
    r"(?:^|[^a-z0-9])x{3,}(?:$|[^a-z0-9])"
    r")",
    re.IGNORECASE,
)


class SecretToolError(Exception):
    """Expected fail-closed error whose message is safe to display."""


class _DuplicateJsonKey(Exception):
    pass


class SafeArgumentParser(argparse.ArgumentParser):
    """Argparse variant that never echoes an unexpected argv value."""

    def error(self, message: str) -> None:  # noqa: ARG002 - argparse contract
        self.print_usage(sys.stderr)
        self.exit(2, "ERROR: invalid command arguments; values were not displayed\n")


@dataclass(frozen=True)
class SourceMetadata:
    name: str
    present: bool
    mode: int | None
    size: int | None
    device: int | None
    inode: int | None


@dataclass(frozen=True)
class DestinationPreflight:
    path: Path
    existed: bool
    parent_device: int
    parent_inode: int
    destination_device: int | None
    destination_inode: int | None


@dataclass(frozen=True)
class LoadedSources:
    env_values: dict[str, str] = field(repr=False)
    env_names: tuple[str, ...]
    json_values: dict[str, Any] = field(repr=False)
    metadata: tuple[SourceMetadata, ...]


@dataclass(frozen=True)
class EffectiveSecrets:
    yellowstone_endpoint: str = field(repr=False)
    yellowstone_token: str = field(repr=False)
    rpc_endpoints: list[dict[str, str]] = field(repr=False)


def _lstat(path: Path) -> os.stat_result | None:
    try:
        return path.lstat()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise SecretToolError("could not inspect a required path safely") from exc


def _validated_absolute_path(
    path: Path | str,
    label: str,
    *,
    allow_missing_leaf: bool,
) -> Path:
    candidate = Path(path)
    if not candidate.is_absolute():
        raise SecretToolError(f"{label} must be an absolute path")
    normalized = Path(os.path.normpath(os.fspath(candidate)))
    if candidate != normalized:
        raise SecretToolError(f"{label} must not contain dot path components")

    components = normalized.parts
    current = Path(normalized.anchor)
    for index, component in enumerate(components[1:], start=1):
        current /= component
        info = _lstat(current)
        if info is None:
            if allow_missing_leaf and index == len(components) - 1:
                break
            raise SecretToolError(f"{label} contains a missing path component")
        if stat.S_ISLNK(info.st_mode):
            raise SecretToolError(f"{label} must not contain a symlink component")

    try:
        canonical = Path(os.path.realpath(normalized))
    except OSError as exc:
        raise SecretToolError(f"{label} could not be canonicalized safely") from exc
    if canonical != normalized:
        raise SecretToolError(f"{label} must be canonical and symlink-free")
    return normalized


def _validate_owned_directory(
    path: Path,
    label: str,
    *,
    exact_mode: int | None = None,
) -> os.stat_result:
    info = _lstat(path)
    if info is None:
        raise SecretToolError(f"{label} does not exist")
    if stat.S_ISLNK(info.st_mode):
        raise SecretToolError(f"{label} must not be a symlink")
    if not stat.S_ISDIR(info.st_mode):
        raise SecretToolError(f"{label} must be a directory")
    if info.st_uid != os.geteuid():
        raise SecretToolError(f"{label} must be owned by the current user")

    mode = stat.S_IMODE(info.st_mode)
    if exact_mode is not None:
        if mode != exact_mode:
            raise SecretToolError(f"{label} permissions must be {exact_mode:04o}")
    elif mode & 0o022:
        raise SecretToolError(f"{label} must not be group/other writable")
    return info


def _inspect_source_file(path: Path, name: str) -> SourceMetadata:
    info = _lstat(path)
    if info is None:
        return SourceMetadata(
            name=name,
            present=False,
            mode=None,
            size=None,
            device=None,
            inode=None,
        )
    if stat.S_ISLNK(info.st_mode):
        raise SecretToolError(f"source {name} must not be a symlink")
    if not stat.S_ISREG(info.st_mode):
        raise SecretToolError(f"source {name} must be a regular file")
    if info.st_uid != os.geteuid():
        raise SecretToolError(f"source {name} must be owned by the current user")

    mode = stat.S_IMODE(info.st_mode)
    if mode not in (0o400, 0o600):
        raise SecretToolError(f"source {name} permissions must be 0400 or 0600")
    if info.st_size > MAX_SOURCE_BYTES:
        raise SecretToolError(f"source {name} exceeds the allowed size")
    return SourceMetadata(
        name=name,
        present=True,
        mode=mode,
        size=info.st_size,
        device=info.st_dev,
        inode=info.st_ino,
    )


def _read_secure_source(path: Path, name: str, metadata: SourceMetadata) -> bytes:
    if not metadata.present:
        raise SecretToolError(f"source {name} is absent")

    flags = os.O_RDONLY
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise SecretToolError(f"source {name} could not be opened safely") from exc

    try:
        current = os.fstat(descriptor)
        if not stat.S_ISREG(current.st_mode):
            raise SecretToolError(f"source {name} must remain a regular file")
        if current.st_uid != os.geteuid():
            raise SecretToolError(f"source {name} ownership changed during inspection")
        if stat.S_IMODE(current.st_mode) not in (0o400, 0o600):
            raise SecretToolError(f"source {name} permissions changed during inspection")
        if current.st_dev != metadata.device or current.st_ino != metadata.inode:
            raise SecretToolError(f"source {name} identity changed during inspection")
        if current.st_size != metadata.size or current.st_size > MAX_SOURCE_BYTES:
            raise SecretToolError(f"source {name} changed during inspection")

        chunks: list[bytes] = []
        remaining = MAX_SOURCE_BYTES + 1
        while remaining:
            chunk = os.read(descriptor, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        payload = b"".join(chunks)
        if len(payload) > MAX_SOURCE_BYTES:
            raise SecretToolError(f"source {name} exceeds the allowed size")
        return payload
    except OSError as exc:
        raise SecretToolError(f"source {name} could not be read safely") from exc
    finally:
        os.close(descriptor)


def _decode_utf8(payload: bytes, name: str) -> str:
    if b"\0" in payload:
        raise SecretToolError(f"source {name} contains a NUL byte")
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SecretToolError(f"source {name} is not valid UTF-8") from exc


def _parse_env(payload: bytes) -> tuple[dict[str, str], tuple[str, ...]]:
    text = _decode_utf8(payload, ".env")
    selected: dict[str, str] = {}
    names: set[str] = set()

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = _ENV_ASSIGNMENT.fullmatch(line)
        if match is None:
            raise SecretToolError("source .env contains an unsupported assignment")

        name, raw_value = match.groups()
        if name in names:
            raise SecretToolError("source .env contains a duplicate variable name")
        names.add(name)

        if raw_value.rstrip().endswith("\\"):
            raise SecretToolError("source .env contains an unsupported line continuation")
        value = raw_value.strip()
        if value.startswith(("'", '"')):
            quote = value[0]
            if len(value) < 2 or value[-1] != quote:
                raise SecretToolError("source .env contains an unsupported quoted value")
            value = value[1:-1]
            if quote == '"' and "\\" in value:
                raise SecretToolError("source .env contains an unsupported escape sequence")

        if name in ENV_FIELDS:
            selected[name] = value

    return selected, tuple(sorted(names))


def _reject_duplicate_json_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateJsonKey
        result[key] = value
    return result


def _load_json(text: str, source_name: str) -> Any:
    try:
        return json.loads(
            text,
            object_pairs_hook=_reject_duplicate_json_keys,
            parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()),
        )
    except (_DuplicateJsonKey, json.JSONDecodeError, ValueError) as exc:
        raise SecretToolError(f"source {source_name} is not valid strict JSON") from exc


def _parse_credentials_json(payload: bytes) -> dict[str, Any]:
    parsed = _load_json(_decode_utf8(payload, "data/credentials.json"), "data/credentials.json")
    if not isinstance(parsed, dict):
        raise SecretToolError("source data/credentials.json must contain one JSON object")
    if set(parsed) - set(JSON_FIELDS):
        raise SecretToolError("source data/credentials.json contains an unknown schema field")

    for field_name in ("geyserUrl", "geyserToken", "jitoBlockEngine", "savedAt"):
        if (
            field_name in parsed
            and parsed[field_name] is not None
            and not isinstance(parsed[field_name], str)
        ):
            raise SecretToolError("source data/credentials.json has an invalid field type")
    if (
        "dryRun" in parsed
        and parsed["dryRun"] is not None
        and not isinstance(parsed["dryRun"], bool)
    ):
        raise SecretToolError("source data/credentials.json has an invalid field type")

    if "rpcEndpoints" in parsed:
        endpoints = parsed["rpcEndpoints"]
        if not isinstance(endpoints, list):
            raise SecretToolError("source data/credentials.json has an invalid RPC schema")
        for endpoint in endpoints:
            if not isinstance(endpoint, dict) or set(endpoint) != {"name", "url"}:
                raise SecretToolError("source data/credentials.json has an invalid RPC schema")
            if not isinstance(endpoint["name"], str) or not isinstance(endpoint["url"], str):
                raise SecretToolError("source data/credentials.json has an invalid RPC field type")
    return parsed


def _load_sources(source_directory: Path | str) -> LoadedSources:
    root = _validated_absolute_path(
        source_directory,
        "source directory",
        allow_missing_leaf=False,
    )
    _validate_owned_directory(root, "source directory")

    data_directory = root / "data"
    data_info = _lstat(data_directory)
    if data_info is not None:
        _validate_owned_directory(data_directory, "source data directory")

    env_path = root / ".env"
    json_path = data_directory / "credentials.json"
    env_metadata = _inspect_source_file(env_path, ".env")
    json_metadata = _inspect_source_file(json_path, "data/credentials.json")
    metadata = (env_metadata, json_metadata)
    if not env_metadata.present and not json_metadata.present:
        raise SecretToolError("no recognized credential source was found")

    env_values: dict[str, str] = {}
    env_names: tuple[str, ...] = ()
    if env_metadata.present:
        env_values, env_names = _parse_env(_read_secure_source(env_path, ".env", env_metadata))

    json_values: dict[str, Any] = {}
    if json_metadata.present:
        json_values = _parse_credentials_json(
            _read_secure_source(json_path, "data/credentials.json", json_metadata)
        )

    return LoadedSources(
        env_values=env_values,
        env_names=env_names,
        json_values=json_values,
        metadata=metadata,
    )


def _validate_text(value: str, field: str, *, reject_whitespace: bool) -> str:
    if not value or value != value.strip():
        raise SecretToolError(f"effective {field} is empty or has surrounding whitespace")
    if len(value) > MAX_VALUE_CHARS:
        raise SecretToolError(f"effective {field} exceeds the allowed size")
    if "\0" in value or "\r" in value or "\n" in value:
        raise SecretToolError(f"effective {field} contains NUL or multiple lines")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise SecretToolError(f"effective {field} contains a control character")
    if reject_whitespace and any(character.isspace() for character in value):
        raise SecretToolError(f"effective {field} contains whitespace")
    if _PLACEHOLDER.search(value):
        raise SecretToolError(f"effective {field} contains a placeholder")
    return value


def _validate_url(value: str, field: str, *, yellowstone: bool = False) -> str:
    value = _validate_text(value, field, reject_whitespace=True)
    if len(value) > 8192 or any(
        ord(character) < 0x21 or ord(character) > 0x7E for character in value
    ):
        raise SecretToolError(f"effective {field} must contain only printable ASCII")
    if "\\" in value:
        raise SecretToolError(f"effective {field} must not contain a backslash")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise SecretToolError(f"effective {field} is not a valid URL") from exc
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc or not parsed.hostname:
        raise SecretToolError(f"effective {field} must be an absolute HTTP(S) URL")
    hostname = parsed.hostname.lower()
    if parsed.scheme.lower() != "https" and not (
        parsed.scheme.lower() == "http" and hostname in {"127.0.0.1", "::1", "localhost"}
    ):
        raise SecretToolError(f"effective {field} must use HTTPS except for literal loopback")
    if parsed.username is not None or parsed.password is not None:
        raise SecretToolError(f"effective {field} must not contain URL userinfo")
    if parsed.fragment:
        raise SecretToolError(f"effective {field} must not contain a URL fragment")
    if yellowstone and parsed.query:
        raise SecretToolError(f"effective {field} must not contain a URL query")
    if port is not None and not 1 <= port <= 65535:
        raise SecretToolError(f"effective {field} has an invalid port")
    return value


def _validate_rpc_endpoints(value: Any, field: str) -> list[dict[str, str]]:
    if not isinstance(value, list) or not 1 <= len(value) <= 8:
        raise SecretToolError(f"effective {field} must contain between one and eight RPC endpoints")

    validated: list[dict[str, str]] = []
    names: set[str] = set()
    for endpoint in value:
        if not isinstance(endpoint, dict) or set(endpoint) != {"name", "url"}:
            raise SecretToolError(f"effective {field} has an invalid RPC object")
        name = endpoint.get("name")
        url = endpoint.get("url")
        if not isinstance(name, str) or not isinstance(url, str):
            raise SecretToolError(f"effective {field} has an invalid RPC field type")
        name = _validate_text(name, f"{field} name", reject_whitespace=False)
        if _RPC_NAME.fullmatch(name) is None:
            raise SecretToolError(f"effective {field} has an invalid RPC name")
        url = _validate_url(url, f"{field} URL")
        if name in names:
            raise SecretToolError(f"effective {field} contains a duplicate RPC name")
        names.add(name)
        validated.append({"name": name, "url": url})
    return validated


def _parse_env_rpc_endpoints(raw: str) -> list[dict[str, str]]:
    raw = _validate_text(raw, "RPC_ENDPOINTS", reject_whitespace=False)
    parts = raw.split(",")
    if not parts or any(not part.strip() for part in parts):
        raise SecretToolError("effective RPC_ENDPOINTS contains an empty RPC entry")

    endpoints: list[dict[str, str]] = []
    for index, part in enumerate(parts):
        item = part.strip()
        if item.startswith(("http://", "https://")):
            name, url = f"rpc{index}", item
        elif "=" in item:
            name, url = item.split("=", 1)
            name, url = name.strip(), url.strip()
        else:
            raise SecretToolError("effective RPC_ENDPOINTS has an unsupported entry")
        endpoints.append({"name": name, "url": url})
    return _validate_rpc_endpoints(endpoints, "RPC_ENDPOINTS")


def _resolve_effective(sources: LoadedSources) -> EffectiveSecrets:
    json_values = sources.json_values
    env_values = sources.env_values

    if "geyserUrl" in json_values and json_values["geyserUrl"] is not None:
        endpoint_raw = json_values["geyserUrl"]
        endpoint_field = "geyserUrl"
    elif "GEYSER_URL" in env_values:
        endpoint_raw = env_values["GEYSER_URL"]
        endpoint_field = "GEYSER_URL"
    else:
        raise SecretToolError("no effective Yellowstone endpoint was found")

    if "geyserToken" in json_values and json_values["geyserToken"] is not None:
        token_raw = json_values["geyserToken"]
        token_field = "geyserToken"
    elif "GEYSER_TOKEN" in env_values:
        token_raw = env_values["GEYSER_TOKEN"]
        token_field = "GEYSER_TOKEN"
    else:
        raise SecretToolError("no effective Yellowstone token was found")

    json_rpc = json_values.get("rpcEndpoints")
    if isinstance(json_rpc, list) and json_rpc:
        rpc_endpoints = _validate_rpc_endpoints(json_rpc, "rpcEndpoints")
    elif "RPC_ENDPOINTS" in env_values:
        rpc_endpoints = _parse_env_rpc_endpoints(env_values["RPC_ENDPOINTS"])
    else:
        raise SecretToolError("no effective Solana RPC endpoint was found")

    if not isinstance(endpoint_raw, str) or not isinstance(token_raw, str):
        raise SecretToolError("effective Yellowstone source has an invalid field type")

    return EffectiveSecrets(
        yellowstone_endpoint=_validate_url(endpoint_raw, endpoint_field, yellowstone=True),
        yellowstone_token=_validate_text(token_raw, token_field, reject_whitespace=True),
        rpc_endpoints=rpc_endpoints,
    )


def _is_within(path: Path, possible_parent: Path) -> bool:
    try:
        return os.path.commonpath((os.fspath(path), os.fspath(possible_parent))) == os.fspath(
            possible_parent
        )
    except ValueError:
        return False


def _preflight_destination(destination_directory: Path | str) -> DestinationPreflight:
    destination = _validated_absolute_path(
        destination_directory,
        "destination directory",
        allow_missing_leaf=True,
    )
    parent_info = _validate_owned_directory(
        destination.parent, "destination parent directory", exact_mode=0o700
    )
    info = _lstat(destination)
    if info is None:
        exists = False
        destination_device = None
        destination_inode = None
    else:
        info = _validate_owned_directory(destination, "destination directory", exact_mode=0o700)
        exists = True
        destination_device = info.st_dev
        destination_inode = info.st_ino

    for name in DESTINATION_FILES:
        if _lstat(destination / name) is not None:
            raise SecretToolError(f"destination {name} already exists")
    return DestinationPreflight(
        path=destination,
        existed=exists,
        parent_device=parent_info.st_dev,
        parent_inode=parent_info.st_ino,
        destination_device=destination_device,
        destination_inode=destination_inode,
    )


def _payloads(secrets: EffectiveSecrets) -> tuple[tuple[str, bytes], ...]:
    rpc_json = json.dumps(
        secrets.rpc_endpoints,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    if len(rpc_json) + 1 > 64 * 1024:
        raise SecretToolError("effective RPC configuration exceeds the probe size limit")
    payloads = (
        ("yellowstone_endpoint", secrets.yellowstone_endpoint.encode("utf-8") + b"\n"),
        ("yellowstone_token", secrets.yellowstone_token.encode("utf-8") + b"\n"),
        ("solana_rpc_endpoints.json", rpc_json + b"\n"),
    )
    if any(len(payload) > 64 * 1024 for _name, payload in payloads):
        raise SecretToolError("effective secret file exceeds the probe size limit")
    return payloads


def _rollback(
    created_names: list[str],
    destination: Path,
    created_directory: bool,
    destination_descriptor: int | None,
) -> bool:
    complete = True
    for name in reversed(created_names):
        try:
            if destination_descriptor is None:
                (destination / name).unlink()
            else:
                os.unlink(name, dir_fd=destination_descriptor)
        except FileNotFoundError:
            pass
        except OSError:
            complete = False
    if destination_descriptor is not None:
        try:
            os.fsync(destination_descriptor)
        except OSError:
            complete = False
    if created_directory:
        try:
            destination.rmdir()
        except FileNotFoundError:
            pass
        except OSError:
            complete = False
    return complete


def _write_secrets(destination_directory: Path | str, secrets: EffectiveSecrets) -> Path:
    preflight = _preflight_destination(destination_directory)
    destination = preflight.path
    created_directory = False
    created_names: list[str] = []
    destination_descriptor: int | None = None

    try:
        parent_info = _validate_owned_directory(
            destination.parent, "destination parent directory", exact_mode=0o700
        )
        if (
            parent_info.st_dev != preflight.parent_device
            or parent_info.st_ino != preflight.parent_inode
        ):
            raise SecretToolError("destination parent identity changed during preflight")

        if not preflight.existed:
            os.mkdir(destination, 0o700)
            created_directory = True
        destination_info = _validate_owned_directory(
            destination, "destination directory", exact_mode=0o700
        )
        if preflight.existed and (
            destination_info.st_dev != preflight.destination_device
            or destination_info.st_ino != preflight.destination_inode
        ):
            raise SecretToolError("destination directory identity changed during preflight")

        directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        directory_flags |= getattr(os, "O_CLOEXEC", 0)
        directory_flags |= getattr(os, "O_NOFOLLOW", 0)
        destination_descriptor = os.open(destination, directory_flags)
        opened_destination = os.fstat(destination_descriptor)
        if (
            opened_destination.st_dev != destination_info.st_dev
            or opened_destination.st_ino != destination_info.st_ino
        ):
            raise SecretToolError("destination directory identity changed while opening")

        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        flags |= getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)

        for name, payload in _payloads(secrets):
            try:
                descriptor = os.open(name, flags, 0o600, dir_fd=destination_descriptor)
            except OSError as exc:
                raise SecretToolError(
                    f"destination {name} could not be created exclusively"
                ) from exc
            created_names.append(name)
            try:
                os.fchmod(descriptor, 0o600)
                offset = 0
                while offset < len(payload):
                    written = os.write(descriptor, payload[offset:])
                    if written <= 0:
                        raise OSError("short write")
                    offset += written
                os.fsync(descriptor)
            finally:
                os.close(descriptor)

            current = os.stat(name, dir_fd=destination_descriptor, follow_symlinks=False)
            if not stat.S_ISREG(current.st_mode) or stat.S_IMODE(current.st_mode) != 0o600:
                raise SecretToolError(f"destination {name} failed its mode check")
            if current.st_uid != os.geteuid():
                raise SecretToolError(f"destination {name} failed its ownership check")

        os.fsync(destination_descriptor)
        final_destination = _validate_owned_directory(
            destination, "destination directory", exact_mode=0o700
        )
        if (
            final_destination.st_dev != destination_info.st_dev
            or final_destination.st_ino != destination_info.st_ino
        ):
            raise SecretToolError("destination directory identity changed during commit")
        return destination
    except BaseException as exc:
        if not _rollback(
            created_names,
            destination,
            created_directory,
            destination_descriptor,
        ):
            raise SecretToolError(
                "write failed and rollback could not remove every created path"
            ) from exc
        if isinstance(exc, SecretToolError):
            raise
        raise SecretToolError(
            "secret files could not be committed; created paths were rolled back"
        ) from exc
    finally:
        if destination_descriptor is not None:
            with contextlib.suppress(OSError):
                os.close(destination_descriptor)


def _print_created_metadata(destination: Path) -> None:
    directory_info = destination.lstat()
    print(
        f"created name=secrets presence=yes mode={stat.S_IMODE(directory_info.st_mode):04o} "
        f"size={directory_info.st_size}"
    )
    for name in DESTINATION_FILES:
        info = (destination / name).lstat()
        print(
            f"created name={name} presence=yes mode={stat.S_IMODE(info.st_mode):04o} "
            f"size={info.st_size}"
        )


def _print_source_inventory(sources: LoadedSources) -> None:
    for metadata in sources.metadata:
        mode = "-" if metadata.mode is None else f"{metadata.mode:04o}"
        size = "-" if metadata.size is None else str(metadata.size)
        presence = "yes" if metadata.present else "no"
        print(f"source name={metadata.name} presence={presence} mode={mode} size={size}")

    env_names = set(sources.env_names)
    for name in sorted(env_names | set(ENV_FIELDS)):
        presence = "yes" if name in env_names else "no"
        print(f"env name={name} presence={presence}")
    for name in JSON_FIELDS:
        presence = "yes" if name in sources.json_values else "no"
        print(f"json name={name} presence={presence}")


def run_inventory(source_directory: Path | str) -> None:
    sources = _load_sources(source_directory)
    _print_source_inventory(sources)
    _resolve_effective(sources)


def run_migrate(source_directory: Path | str, destination_directory: Path | str) -> None:
    source = _validated_absolute_path(
        source_directory,
        "source directory",
        allow_missing_leaf=False,
    )
    destination = _preflight_destination(destination_directory).path
    if _is_within(destination, source):
        raise SecretToolError(
            "destination directory must be outside the historical source directory"
        )
    sources = _load_sources(source)
    _print_source_inventory(sources)
    secrets = _resolve_effective(sources)
    written_destination = _write_secrets(destination, secrets)
    _print_created_metadata(written_destination)


def _parse_manual_rpc(raw: str) -> list[dict[str, str]]:
    if "\0" in raw or "\r" in raw or "\n" in raw:
        raise SecretToolError("manual RPC input contains NUL or multiple lines")
    parsed = _load_json(raw, "manual RPC input")
    return _validate_rpc_endpoints(parsed, "manual RPC input")


def run_manual(destination_directory: Path | str) -> None:
    forbidden_environment = sorted(name for name in ENV_FIELDS if name in os.environ)
    if forbidden_environment:
        names = ", ".join(forbidden_environment)
        raise SecretToolError(f"manual mode refuses secret environment variables: {names}")
    if not sys.stdin.isatty():
        raise SecretToolError("manual mode requires an interactive TTY")

    _preflight_destination(destination_directory)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            endpoint = getpass.getpass("Yellowstone endpoint (hidden): ")
            token = getpass.getpass("Yellowstone token (hidden): ")
            rpc_raw = getpass.getpass('RPC JSON array [{"name":"...","url":"..."}] (hidden): ')
    except (EOFError, getpass.GetPassWarning) as exc:
        raise SecretToolError("manual input could not be read without echo") from exc

    secrets = EffectiveSecrets(
        yellowstone_endpoint=_validate_url(
            endpoint, "manual Yellowstone endpoint", yellowstone=True
        ),
        yellowstone_token=_validate_text(token, "manual Yellowstone token", reject_whitespace=True),
        rpc_endpoints=_parse_manual_rpc(rpc_raw),
    )
    written_destination = _write_secrets(destination_directory, secrets)
    _print_created_metadata(written_destination)


def _parser() -> SafeArgumentParser:
    parser = SafeArgumentParser(
        description="RFC-001A redacted Yellowstone/RPC secret inventory and migration"
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

    inventory = subcommands.add_parser(
        "inventory", help="show source names/presence/mode/size without values"
    )
    inventory.add_argument("--source-dir", required=True, type=Path, metavar="PATH")

    migrate = subcommands.add_parser("migrate", help="migrate only the three RFC-001A secret files")
    migrate.add_argument("--source-dir", required=True, type=Path, metavar="PATH")
    migrate.add_argument("--destination-dir", required=True, type=Path, metavar="PATH")

    manual = subcommands.add_parser(
        "manual", help="read the three secret values from a no-echo interactive TTY"
    )
    manual.add_argument("--destination-dir", required=True, type=Path, metavar="PATH")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "inventory":
            run_inventory(args.source_dir)
        elif args.command == "migrate":
            run_migrate(args.source_dir, args.destination_dir)
        elif args.command == "manual":
            run_manual(args.destination_dir)
        else:  # pragma: no cover - argparse enforces the closed command set.
            raise SecretToolError("unknown command")
    except SecretToolError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("ERROR: operation cancelled; secret values were not displayed", file=sys.stderr)
        return 2
    except OSError:
        print("ERROR: operating-system failure; secret values were not displayed", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
