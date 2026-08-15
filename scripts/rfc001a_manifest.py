#!/usr/bin/env python3
"""Fail-closed validation for the redacted RFC-001A destruction manifest.

This module is deliberately read-only.  It validates inventory evidence but
does not build, print, or execute removal commands.  Diagnostics are fixed
reason codes so values from the manifest cannot reach stdout or stderr.

Schema version 1 shape excerpt (angle-bracket values are documentation
placeholders; exact required sets are defined by constants below)::

    {
      "schema_version": 1,
      "identity": {
        "user": "ganso",
        "ipv4": "178.105.65.251",
        "hostname": "<literal>",
        "server_id": "<literal>",
        "client_key_md5": "MD5:7b:a8:61:f5:b2:27:08:69:d2:ea:25:3d:33:ae:17:d1",
        "host_key_sha256": "SHA256:<unpadded-base64>"
      },
      "target": {
        "path": "/home/ganso/ganso-bot",
        "owner": "<literal>",
        "shared": false,
        "symlink_detected": false,
        "mount_detected": false
      },
      "preserve_paths": ["/home/ganso/ganso-market"],
      "resources": {
        "containers": [
          {
            "id": "<literal>",
            "name": "<literal>",
            "image_id": "<literal>",
            "compose_project": "ganso",
            "status": "exited",
            "restart_policy": "no",
            "owner": "<literal>",
            "shared": false
          }
        ],
        "images": [
          {
            "id": "<literal>",
            "names": ["<literal>"],
            "untagged": false,
            "owner": "<literal>",
            "shared": false
          }
        ],
        "networks": [
          {
            "id": "<64-lowercase-hex>",
            "name": "ganso_default",
            "compose_project": "ganso",
            "attached_containers": 0,
            "owner": "<literal>",
            "shared": false
          }
        ],
        "volumes": [
          {
            "name": "ganso_pgdata",
            "owner": "<literal>",
            "shared": false,
            "compose_project": "ganso",
            "driver": "local",
            "scope": "local",
            "inventory_consumers": []
          },
          {
            "name": "d92737f70a4518d54a5d62dfecc8c51ca4477f8c7d6b0988c9caf004b130fbb4",
            "owner": "docker-daemon",
            "shared": false,
            "compose_project": null,
            "driver": "local",
            "scope": "local",
            "size_bytes": 0,
            "inventory_consumers": [
              {
                "container_id": "4a96a1147ffb165e8c29f11702734204c026276c5269e62f64f2da42909df053",
                "container_name": "ganso-redis-1",
                "compose_project": "ganso",
                "status": "exited",
                "restart_policy": "no",
                "mount_type": "volume",
                "mount_path": "/data",
                "rw": true
              }
            ]
          }
        ],
        "units": [{"id": "<literal>", "owner": "<literal>", "shared": false}],
        "timers": [],
        "crons": [],
        "docker_configs": [
          {
            "id": "<literal>",
            "name": "<literal>",
            "owner": "<literal>",
            "shared": false
          }
        ],
        "docker_secrets": []
      },
      "gates": {"<required gate>": true},
      "approval": {"approved": true}
    }

``approval`` is optional during inventory validation and mandatory only with
``--require-approval``.  Its boolean records an explicit owner decision made
outside this program; it is not proof of identity or a substitute for review.
Volume ``size_bytes`` is inventory metadata, never proof of exclusivity.  Each
``owner`` is an operator classification of the removal target, not Docker owner
metadata.  ``inventory_consumers`` records current pre-destruction references;
the later zero-consumer pre-removal check is deliberately outside this manifest.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import posixpath
import re
import sys
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path, PurePosixPath
from typing import Any

SCHEMA_VERSION = 1
EXPECTED_USER = "ganso"
EXPECTED_IPV4 = "178.105.65.251"
EXPECTED_CLIENT_KEY_MD5 = "MD5:7b:a8:61:f5:b2:27:08:69:d2:ea:25:3d:33:ae:17:d1"
DESTRUCTION_PATH = "/home/ganso/ganso-bot"
PRESERVED_PROJECT_PATH = "/home/ganso/ganso-market"
EXPECTED_COMPOSE_VOLUMES = frozenset({"ganso_pgdata", "ganso_caddydata", "ganso_caddyconfig"})
AUTHORIZED_UNLABELED_VOLUME = "d92737f70a4518d54a5d62dfecc8c51ca4477f8c7d6b0988c9caf004b130fbb4"
AUTHORIZED_VOLUME_CONSUMER_ID = "4a96a1147ffb165e8c29f11702734204c026276c5269e62f64f2da42909df053"
AUTHORIZED_VOLUME_CONSUMER_NAME = "ganso-redis-1"
EXPECTED_VOLUMES = EXPECTED_COMPOSE_VOLUMES | {AUTHORIZED_UNLABELED_VOLUME}
EXPECTED_COMPOSE_PROJECT = "ganso"
EXPECTED_NETWORK_NAME = "ganso_default"

RESOURCE_KINDS = (
    "containers",
    "images",
    "networks",
    "volumes",
    "units",
    "timers",
    "crons",
    "docker_configs",
    "docker_secrets",
)
REQUIRED_GATES = frozenset(
    {
        "identity_inventory",
        "bot_stopped",
        "wallet_recovery",
        "yellowstone_portal",
        "yellowstone_probe",
        "rpc_probe",
        "zero_pending_activity",
        "legacy_deploy_disabled",
        "new_project_isolated",
    }
)

MAX_MANIFEST_BYTES = 1024 * 1024
MAX_JSON_DEPTH = 64
_LITERAL_ID = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}\Z", re.ASCII)
_LITERAL_NAME = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_.:@+/-]{0,254}\Z", re.ASCII)
_DOCKER_OBJECT_ID = re.compile(r"\A[0-9a-f]{64}\Z", re.ASCII)
_DOCKER_IMAGE_ID = re.compile(r"\Asha256:[0-9a-f]{64}\Z", re.ASCII)
_HOSTNAME = re.compile(
    r"\A(?=.{1,253}\Z)"
    r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\Z",
    re.ASCII,
)
_HOST_KEY_SHA256 = re.compile(r"\ASHA256:[A-Za-z0-9+/]{43}\Z", re.ASCII)
_NON_LITERAL_PATH_CHARACTERS = frozenset("*?[]{}$")
_PLACEHOLDER_IDS = frozenset(
    {
        "id",
        "change-me",
        "changeme",
        "example",
        "example-host",
        "host",
        "hostname",
        "none",
        "null",
        "placeholder",
        "replace-me",
        "replace_me",
        "server-id",
        "server_id",
        "tbd",
        "todo",
        "unknown",
    }
)


class ManifestValidationError(ValueError):
    """A validation failure whose message never contains manifest values."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class ManifestReadError(ValueError):
    """A read/parse failure whose message never contains file contents."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class _DuplicateJsonKey(ValueError):
    pass


def _reject_duplicate_keys(pairs: Iterable[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateJsonKey
        result[key] = value
    return result


def _reject_json_constant(_value: str) -> None:
    raise ManifestReadError("manifest-invalid-json-constant")


def _reject_excessive_json_depth(value: Any) -> None:
    """Enforce a parser-independent nesting limit without recursive traversal."""

    stack = [(value, 1)]
    while stack:
        current, depth = stack.pop()
        if type(current) is dict:
            if depth > MAX_JSON_DEPTH:
                raise ManifestReadError("manifest-invalid-json")
            stack.extend((child, depth + 1) for child in current.values())
        elif type(current) is list:
            if depth > MAX_JSON_DEPTH:
                raise ManifestReadError("manifest-invalid-json")
            stack.extend((child, depth + 1) for child in current)


def load_manifest(path: Path | str) -> Any:
    """Load a bounded UTF-8 JSON document without exposing parse input."""

    try:
        with Path(path).open("rb") as manifest_file:
            raw = manifest_file.read(MAX_MANIFEST_BYTES + 1)
    except (OSError, TypeError, ValueError):
        raise ManifestReadError("manifest-unreadable") from None

    if len(raw) > MAX_MANIFEST_BYTES:
        raise ManifestReadError("manifest-too-large")

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise ManifestReadError("manifest-not-utf8") from None

    try:
        manifest = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_json_constant,
        )
    except _DuplicateJsonKey:
        raise ManifestReadError("manifest-duplicate-key") from None
    except (json.JSONDecodeError, RecursionError):
        raise ManifestReadError("manifest-invalid-json") from None

    _reject_excessive_json_depth(manifest)
    return manifest


def _fail(code: str) -> None:
    raise ManifestValidationError(code)


def _require_object(value: Any, code: str) -> Mapping[str, Any]:
    if type(value) is not dict:
        _fail(code)
    return value


def _require_exact_keys(
    value: Mapping[str, Any],
    required: set[str] | frozenset[str],
    *,
    optional: set[str] | frozenset[str] = frozenset(),
    code: str,
) -> None:
    keys = set(value)
    if not required.issubset(keys) or not keys.issubset(required | optional):
        _fail(code)


def _validate_literal_id(value: Any, code: str = "resource-id-not-literal") -> str:
    if type(value) is not str:
        _fail(code)
    if _LITERAL_ID.fullmatch(value) is None:
        _fail(code)
    if value.casefold() in _PLACEHOLDER_IDS:
        _fail(code)
    return value


def _validate_literal_name(value: Any) -> str:
    if type(value) is not str or _LITERAL_NAME.fullmatch(value) is None:
        _fail("resource-name-not-literal")
    if value.casefold() in _PLACEHOLDER_IDS:
        _fail("resource-name-not-literal")
    if any(part in {"", ".", ".."} for part in value.split("/")):
        _fail("resource-name-not-literal")
    return value


def _validate_docker_id(value: Any, *, image: bool, code: str) -> str:
    pattern = _DOCKER_IMAGE_ID if image else _DOCKER_OBJECT_ID
    if type(value) is not str or pattern.fullmatch(value) is None:
        _fail(code)
    return value


def _validate_hostname(value: Any) -> None:
    if type(value) is not str or _HOSTNAME.fullmatch(value) is None:
        _fail("identity-hostname-not-literal")
    if value.casefold() in _PLACEHOLDER_IDS:
        _fail("identity-hostname-not-literal")


def _validate_host_key_sha256(value: Any) -> None:
    if type(value) is not str or _HOST_KEY_SHA256.fullmatch(value) is None:
        _fail("identity-host-key-sha256-invalid")
    digest = value.removeprefix("SHA256:")
    try:
        decoded = base64.b64decode(digest + "=", validate=True)
    except binascii.Error:
        _fail("identity-host-key-sha256-invalid")
    canonical = base64.b64encode(decoded).decode("ascii").rstrip("=")
    if len(decoded) != 32 or canonical != digest:
        _fail("identity-host-key-sha256-invalid")


def _validate_literal_path(value: Any, code: str) -> str:
    if type(value) is not str or not value.startswith("/"):
        _fail(code)
    if any(character in value for character in _NON_LITERAL_PATH_CHARACTERS):
        _fail(code)
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        _fail(code)
    if posixpath.normpath(value) != value:
        _fail(code)
    if any(part in {".", ".."} for part in PurePosixPath(value).parts):
        _fail(code)
    return value


def _paths_overlap(first: str, second: str) -> bool:
    first_path = PurePosixPath(first)
    second_path = PurePosixPath(second)
    return (
        first_path == second_path
        or first_path in second_path.parents
        or second_path in first_path.parents
    )


def _validate_identity(manifest: Mapping[str, Any]) -> None:
    identity = _require_object(manifest["identity"], "identity-not-object")
    _require_exact_keys(
        identity,
        {
            "user",
            "ipv4",
            "hostname",
            "server_id",
            "client_key_md5",
            "host_key_sha256",
        },
        code="identity-fields-invalid",
    )
    if identity["user"] != EXPECTED_USER:
        _fail("identity-user-mismatch")
    if identity["ipv4"] != EXPECTED_IPV4:
        _fail("identity-ipv4-mismatch")
    _validate_hostname(identity["hostname"])
    _validate_literal_id(identity["server_id"], "identity-server-id-not-literal")
    if identity["client_key_md5"] != EXPECTED_CLIENT_KEY_MD5:
        _fail("identity-client-key-md5-mismatch")
    _validate_host_key_sha256(identity["host_key_sha256"])


def _validate_paths(manifest: Mapping[str, Any]) -> None:
    target = _require_object(manifest["target"], "target-not-object")
    _require_exact_keys(
        target,
        {"path", "owner", "shared", "symlink_detected", "mount_detected"},
        code="target-fields-invalid",
    )

    preserve_paths = manifest["preserve_paths"]
    if type(preserve_paths) is not list or len(preserve_paths) != 1:
        _fail("preserve-paths-invalid")

    target_path = _validate_literal_path(target["path"], "target-path-not-literal")
    preserved_path = _validate_literal_path(preserve_paths[0], "preserved-path-not-literal")

    if _paths_overlap(target_path, preserved_path):
        _fail("target-overlaps-preserved-path")
    if target_path != DESTRUCTION_PATH:
        _fail("target-path-mismatch")
    if preserved_path != PRESERVED_PROJECT_PATH:
        _fail("preserved-path-mismatch")

    _validate_literal_id(target["owner"], "owner-not-literal")
    if type(target["shared"]) is not bool:
        _fail("target-shared-state-invalid")
    if target["shared"]:
        _fail("target-is-shared")

    if type(target["symlink_detected"]) is not bool:
        _fail("target-symlink-state-invalid")
    if target["symlink_detected"]:
        _fail("target-symlink-detected")
    if type(target["mount_detected"]) is not bool:
        _fail("target-mount-state-invalid")
    if target["mount_detected"]:
        _fail("target-mount-detected")


def _validate_unshared(resource: Mapping[str, Any]) -> None:
    if type(resource["shared"]) is not bool:
        _fail("resource-shared-state-invalid")
    if resource["shared"]:
        _fail("resource-is-shared")


def _validate_owner(resource: Mapping[str, Any]) -> None:
    _validate_literal_id(resource["owner"], "owner-not-literal")


def _validate_attached_containers(resource: Mapping[str, Any]) -> None:
    if type(resource["attached_containers"]) is not int:
        _fail("attached-containers-state-invalid")
    if resource["attached_containers"] != 0:
        _fail("resource-has-attached-containers")


def _validate_container(entry: Any) -> tuple[str, str]:
    resource = _require_object(entry, "resource-not-object")
    _require_exact_keys(
        resource,
        {
            "id",
            "name",
            "image_id",
            "compose_project",
            "status",
            "restart_policy",
            "owner",
            "shared",
        },
        code="resource-fields-invalid",
    )
    resource_id = _validate_docker_id(resource["id"], image=False, code="resource-id-not-literal")
    name = _validate_literal_id(resource["name"], "resource-name-not-literal")
    _validate_docker_id(resource["image_id"], image=True, code="container-image-id-not-literal")
    _validate_owner(resource)
    _validate_unshared(resource)
    if resource["compose_project"] != EXPECTED_COMPOSE_PROJECT:
        _fail("container-compose-project-mismatch")
    if resource["status"] != "exited":
        _fail("container-not-exited")
    if resource["restart_policy"] != "no":
        _fail("container-restart-policy-enabled")
    if resource_id == name:
        _fail("container-name-id-not-distinct")
    return resource_id, name


def _validate_image(entry: Any) -> tuple[str, list[str]]:
    resource = _require_object(entry, "resource-not-object")
    _require_exact_keys(
        resource,
        {"id", "names", "untagged", "owner", "shared"},
        code="resource-fields-invalid",
    )
    resource_id = _validate_docker_id(resource["id"], image=True, code="resource-id-not-literal")
    _validate_owner(resource)
    _validate_unshared(resource)
    names = resource["names"]
    if type(names) is not list:
        _fail("image-names-invalid")
    if type(resource["untagged"]) is not bool:
        _fail("image-untagged-state-invalid")
    if not names:
        if resource["untagged"] is not True:
            _fail("image-untagged-state-mismatch")
        return resource_id, []
    if resource["untagged"] is not False:
        _fail("image-untagged-state-mismatch")
    literal_names = [_validate_literal_name(name) for name in names]
    if len(literal_names) != len(set(literal_names)):
        _fail("image-name-duplicate")
    if resource_id in literal_names:
        _fail("image-name-id-not-distinct")
    return resource_id, literal_names


def _validate_network(entry: Any) -> tuple[str, str]:
    resource = _require_object(entry, "resource-not-object")
    _require_exact_keys(
        resource,
        {"id", "name", "compose_project", "attached_containers", "owner", "shared"},
        code="resource-fields-invalid",
    )
    resource_id = _validate_docker_id(resource["id"], image=False, code="resource-id-not-literal")
    name = _validate_literal_id(resource["name"], "resource-name-not-literal")
    _validate_owner(resource)
    _validate_unshared(resource)
    _validate_attached_containers(resource)
    if name != EXPECTED_NETWORK_NAME:
        _fail("network-name-mismatch")
    if resource["compose_project"] != EXPECTED_COMPOSE_PROJECT:
        _fail("network-compose-project-mismatch")
    if resource_id == name:
        _fail("network-name-id-not-distinct")
    return resource_id, name


def _validate_volume_driver_and_scope(resource: Mapping[str, Any]) -> None:
    if resource["driver"] != "local":
        _fail("volume-driver-mismatch")
    if resource["scope"] != "local":
        _fail("volume-scope-mismatch")


def _validate_inventory_consumer(entry: Any) -> tuple[str, str, str]:
    consumer = _require_object(entry, "inventory-consumer-not-object")
    _require_exact_keys(
        consumer,
        {
            "container_id",
            "container_name",
            "compose_project",
            "status",
            "restart_policy",
            "mount_type",
            "mount_path",
            "rw",
        },
        code="inventory-consumer-fields-invalid",
    )
    container_id = _validate_docker_id(
        consumer["container_id"],
        image=False,
        code="inventory-consumer-id-not-literal",
    )
    container_name = _validate_literal_id(
        consumer["container_name"],
        "inventory-consumer-name-not-literal",
    )
    mount_path = _validate_literal_path(
        consumer["mount_path"],
        "inventory-consumer-mount-path-not-literal",
    )
    if container_id == container_name:
        _fail("inventory-consumer-name-id-not-distinct")
    if consumer["compose_project"] != EXPECTED_COMPOSE_PROJECT:
        _fail("inventory-consumer-compose-project-mismatch")
    if consumer["status"] != "exited":
        _fail("inventory-consumer-not-exited")
    if consumer["restart_policy"] != "no":
        _fail("inventory-consumer-restart-policy-enabled")
    if consumer["mount_type"] != "volume":
        _fail("inventory-consumer-mount-type-mismatch")
    if type(consumer["rw"]) is not bool:
        _fail("inventory-consumer-rw-state-invalid")
    return container_id, container_name, mount_path


def _validate_inventory_consumers(resource: Mapping[str, Any]) -> list[tuple[str, str, str]]:
    consumers = resource["inventory_consumers"]
    if type(consumers) is not list:
        _fail("inventory-consumers-invalid")
    results = [_validate_inventory_consumer(entry) for entry in consumers]
    if len(results) != len(set(results)):
        _fail("inventory-consumer-duplicate")
    return results


def _validate_unlabeled_volume(resource: Mapping[str, Any]) -> list[tuple[str, str, str]]:
    _require_exact_keys(
        resource,
        {
            "name",
            "compose_project",
            "driver",
            "scope",
            "size_bytes",
            "inventory_consumers",
            "owner",
            "shared",
        },
        code="unlabeled-volume-fields-invalid",
    )
    _validate_owner(resource)
    _validate_unshared(resource)
    _validate_volume_driver_and_scope(resource)

    if resource["owner"] != "docker-daemon":
        _fail("unlabeled-volume-owner-mismatch")
    if resource["compose_project"] is not None:
        _fail("unlabeled-volume-compose-label-present")
    if type(resource["size_bytes"]) is not int or resource["size_bytes"] != 0:
        _fail("unlabeled-volume-size-mismatch")

    consumers = resource["inventory_consumers"]
    if type(consumers) is not list or len(consumers) != 1:
        _fail("unlabeled-volume-consumers-invalid")
    results = _validate_inventory_consumers(resource)
    consumer = consumers[0]
    if (
        consumer["container_id"] != AUTHORIZED_VOLUME_CONSUMER_ID
        or consumer["container_name"] != AUTHORIZED_VOLUME_CONSUMER_NAME
        or consumer["compose_project"] != EXPECTED_COMPOSE_PROJECT
        or consumer["status"] != "exited"
        or consumer["restart_policy"] != "no"
        or consumer["mount_type"] != "volume"
        or consumer["mount_path"] != "/data"
        or consumer["rw"] is not True
    ):
        _fail("unlabeled-volume-consumer-mismatch")
    return results


def _validate_volume(entry: Any) -> tuple[str, list[tuple[str, str, str]]]:
    resource = _require_object(entry, "resource-not-object")
    name = _validate_literal_id(resource.get("name"), "resource-name-not-literal")
    if name == AUTHORIZED_UNLABELED_VOLUME:
        return name, _validate_unlabeled_volume(resource)

    _require_exact_keys(
        resource,
        {
            "name",
            "compose_project",
            "driver",
            "scope",
            "inventory_consumers",
            "owner",
            "shared",
        },
        code="resource-fields-invalid",
    )
    _validate_owner(resource)
    _validate_unshared(resource)
    _validate_volume_driver_and_scope(resource)
    if resource["compose_project"] != EXPECTED_COMPOSE_PROJECT:
        _fail("volume-compose-project-mismatch")
    return name, _validate_inventory_consumers(resource)


def _validate_simple_resource(entry: Any) -> str:
    resource = _require_object(entry, "resource-not-object")
    _require_exact_keys(resource, {"id", "owner", "shared"}, code="resource-fields-invalid")
    resource_id = _validate_literal_id(resource["id"])
    _validate_owner(resource)
    _validate_unshared(resource)
    return resource_id


def _validate_named_resource(entry: Any) -> tuple[str, str]:
    resource = _require_object(entry, "resource-not-object")
    _require_exact_keys(
        resource,
        {"id", "name", "owner", "shared"},
        code="resource-fields-invalid",
    )
    resource_id = _validate_literal_id(resource["id"])
    name = _validate_literal_id(resource["name"], "resource-name-not-literal")
    _validate_owner(resource)
    _validate_unshared(resource)
    if resource_id == name:
        _fail("resource-name-id-not-distinct")
    return resource_id, name


def _require_resource_list(resources: Mapping[str, Any], kind: str) -> list[Any]:
    entries = resources[kind]
    if type(entries) is not list:
        _fail("resource-list-invalid")
    return entries


def _require_unique(values: Sequence[str], code: str) -> None:
    if len(values) != len(set(values)):
        _fail(code)


def _validate_resources(manifest: Mapping[str, Any]) -> None:
    resources = _require_object(manifest["resources"], "resources-not-object")
    _require_exact_keys(
        resources,
        set(RESOURCE_KINDS),
        code="resource-kinds-invalid",
    )

    container_pairs = [
        _validate_container(entry) for entry in _require_resource_list(resources, "containers")
    ]
    container_ids = [resource_id for resource_id, _name in container_pairs]
    container_names = [name for _resource_id, name in container_pairs]
    _require_unique(container_ids, "resource-id-duplicate")
    _require_unique(container_names, "resource-name-duplicate")
    if set(container_ids) & set(container_names):
        _fail("container-name-id-not-distinct")

    image_results = [
        _validate_image(entry) for entry in _require_resource_list(resources, "images")
    ]
    image_ids = [resource_id for resource_id, _names in image_results]
    image_names = [name for _resource_id, names in image_results for name in names]
    _require_unique(image_ids, "resource-id-duplicate")
    _require_unique(image_names, "image-name-duplicate")

    network_entries = _require_resource_list(resources, "networks")
    if len(network_entries) > 1:
        _fail("network-set-invalid")
    network_pairs = [_validate_network(entry) for entry in network_entries]
    network_ids = [resource_id for resource_id, _name in network_pairs]
    network_names = [name for _resource_id, name in network_pairs]
    _require_unique(network_ids, "resource-id-duplicate")
    _require_unique(network_names, "resource-name-duplicate")
    if set(network_ids) & set(network_names):
        _fail("network-name-id-not-distinct")

    volume_results = [
        _validate_volume(entry) for entry in _require_resource_list(resources, "volumes")
    ]
    volume_names = [name for name, _consumers in volume_results]
    _require_unique(volume_names, "resource-name-duplicate")
    if set(volume_names) != EXPECTED_VOLUMES:
        _fail("expected-volume-set-mismatch")
    claimed_consumer_mounts: set[tuple[str, str, str]] = set()
    for _volume_name, consumers in volume_results:
        for container_id, container_name, mount_path in consumers:
            consumer_mount = (container_id, container_name, mount_path)
            if consumer_mount in claimed_consumer_mounts:
                _fail("volume-consumer-mount-duplicate")
            claimed_consumer_mounts.add(consumer_mount)
            if (container_id, container_name) not in container_pairs:
                _fail("volume-consumer-not-in-container-inventory")

    simple_kinds = ("units", "timers", "crons")
    for kind in simple_kinds:
        resource_ids = [
            _validate_simple_resource(entry) for entry in _require_resource_list(resources, kind)
        ]
        _require_unique(resource_ids, "resource-id-duplicate")

    for kind in ("docker_configs", "docker_secrets"):
        resource_pairs = [
            _validate_named_resource(entry) for entry in _require_resource_list(resources, kind)
        ]
        resource_ids = [resource_id for resource_id, _name in resource_pairs]
        resource_names = [name for _resource_id, name in resource_pairs]
        _require_unique(resource_ids, "resource-id-duplicate")
        _require_unique(resource_names, "resource-name-duplicate")
        if set(resource_ids) & set(resource_names):
            _fail("resource-name-id-not-distinct")


def _validate_gates(manifest: Mapping[str, Any]) -> None:
    gates = _require_object(manifest["gates"], "gates-not-object")
    if set(gates) != REQUIRED_GATES:
        _fail("gates-incomplete")
    for result in gates.values():
        if type(result) is not bool or result is not True:
            _fail("gate-not-passed")


def _validate_approval(manifest: Mapping[str, Any], require_approval: bool) -> None:
    if "approval" not in manifest:
        if require_approval:
            _fail("approval-required")
        return

    approval = _require_object(manifest["approval"], "approval-not-object")
    _require_exact_keys(approval, {"approved"}, code="approval-fields-invalid")
    if type(approval["approved"]) is not bool:
        _fail("approval-state-invalid")
    if require_approval and approval["approved"] is not True:
        _fail("approval-required")


def validate_manifest(manifest: Any, *, require_approval: bool = False) -> None:
    """Validate one schema-v1 manifest, raising a safe reason code on failure."""

    document = _require_object(manifest, "manifest-not-object")
    _require_exact_keys(
        document,
        {"schema_version", "identity", "target", "preserve_paths", "resources", "gates"},
        optional={"approval"},
        code="manifest-fields-invalid",
    )
    if type(document["schema_version"]) is not int:
        _fail("schema-version-invalid")
    if document["schema_version"] != SCHEMA_VERSION:
        _fail("schema-version-unsupported")
    if type(require_approval) is not bool:
        _fail("require-approval-state-invalid")

    _validate_identity(document)
    _validate_paths(document)
    _validate_resources(document)
    _validate_gates(document)
    _validate_approval(document, require_approval)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate a redacted RFC-001A manifest without executing actions."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("--manifest", required=True)
    validate_parser.add_argument("--require-approval", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        manifest = load_manifest(args.manifest)
        validate_manifest(manifest, require_approval=args.require_approval)
    except (ManifestReadError, ManifestValidationError) as error:
        print(f"FAIL RFC001A_MANIFEST reason={error.code}", file=sys.stderr)
        return 1

    print("PASS RFC001A_MANIFEST")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
