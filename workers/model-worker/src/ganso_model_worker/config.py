"""Strict, non-secret runtime configuration for the health-only worker."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class ConfigError(ValueError):
    """Raised when configuration is missing, unknown, or unsafe."""


@dataclass(frozen=True)
class ServiceConfig:
    bind_address: str
    port: int


@dataclass(frozen=True)
class RuntimeConfig:
    schema_version: int
    execution_mode: str
    service: ServiceConfig
    log_level: str


DEFAULT_CONFIG = RuntimeConfig(
    schema_version=1,
    execution_mode="paper",
    service=ServiceConfig(bind_address="127.0.0.1", port=8090),
    log_level="info",
)


def _expect_object(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise ConfigError(f"{location} must be an object")
    return value


def _reject_unknown(value: Mapping[str, Any], allowed: set[str], location: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ConfigError(f"{location} contains unknown keys: {', '.join(unknown)}")


def _port(value: Any, location: str) -> int:
    if type(value) is not int or not 1 <= value <= 65535:
        raise ConfigError(f"{location} must be an integer from 1 to 65535")
    return value


def _service(services: Mapping[str, Any], name: str, default: ServiceConfig) -> ServiceConfig:
    raw = services.get(name)
    if raw is None:
        return default
    section = _expect_object(raw, f"services.{name}")
    _reject_unknown(section, {"bind_address", "port"}, f"services.{name}")
    bind_address = section.get("bind_address", default.bind_address)
    if not isinstance(bind_address, str) or not bind_address.strip():
        raise ConfigError(f"services.{name}.bind_address must be a non-empty string")
    return ServiceConfig(
        bind_address=bind_address,
        port=_port(section.get("port", default.port), f"services.{name}.port"),
    )


def _validate_ignored_sections(document: Mapping[str, Any]) -> None:
    database = document.get("database")
    if database is not None:
        section = _expect_object(database, "database")
        _reject_unknown(
            section,
            {"host", "port", "name", "user", "connect_timeout_ms"},
            "database",
        )
        for key in ("host", "name", "user"):
            value = section.get(key)
            if value is not None and (not isinstance(value, str) or not value.strip()):
                raise ConfigError(f"database.{key} must be a non-empty string")
        if "port" in section:
            _port(section["port"], "database.port")
        timeout = section.get("connect_timeout_ms")
        if timeout is not None and (type(timeout) is not int or not 100 <= timeout <= 30_000):
            raise ConfigError("database.connect_timeout_ms must be an integer from 100 to 30000")

    services = document.get("services")
    if services is not None:
        section = _expect_object(services, "services")
        _reject_unknown(section, {"api", "market_engine", "model_worker"}, "services")
        for service_name in ("api", "market_engine"):
            _service(section, service_name, ServiceConfig("127.0.0.1", 1))


def parse_config(document: Mapping[str, Any]) -> RuntimeConfig:
    _reject_unknown(
        document,
        {"schema_version", "execution_mode", "database", "services", "logging"},
        "root",
    )
    schema_version = document.get("schema_version", DEFAULT_CONFIG.schema_version)
    if type(schema_version) is not int or schema_version != 1:
        raise ConfigError("schema_version must be integer 1")

    execution_mode = document.get("execution_mode", DEFAULT_CONFIG.execution_mode)
    if execution_mode != "paper":
        raise ConfigError("execution_mode must be paper in RFC-001")

    _validate_ignored_sections(document)
    services = _expect_object(document.get("services", {}), "services")
    service = _service(services, "model_worker", DEFAULT_CONFIG.service)

    logging = _expect_object(document.get("logging", {}), "logging")
    _reject_unknown(logging, {"level"}, "logging")
    log_level = logging.get("level", DEFAULT_CONFIG.log_level)
    if log_level not in {"debug", "info", "warn", "error"}:
        raise ConfigError("logging.level must be debug, info, warn, or error")

    return RuntimeConfig(
        schema_version=schema_version,
        execution_mode=execution_mode,
        service=service,
        log_level=log_level,
    )


def load_config(
    path: Path | None = None,
    environment: Mapping[str, str] | None = None,
) -> RuntimeConfig:
    env = os.environ if environment is None else environment
    configured_path = path
    if configured_path is None and "GANSO_CONFIG_FILE" in env:
        configured_value = env["GANSO_CONFIG_FILE"]
        if not configured_value or configured_value.strip() != configured_value:
            raise ConfigError("GANSO_CONFIG_FILE must be a non-empty exact path")
        configured_path = Path(configured_value)
    if configured_path is None:
        return DEFAULT_CONFIG
    try:
        document = json.loads(configured_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ConfigError("configuration file is missing or invalid JSON") from error
    return parse_config(_expect_object(document, "root"))
