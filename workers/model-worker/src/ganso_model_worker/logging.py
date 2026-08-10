"""Small JSON logger with deterministic field-name redaction."""

from __future__ import annotations

import json
import sys
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, TextIO

REDACTED = "[REDACTED]"
SENSITIVE_PARTS = (
    "authorization",
    "cookie",
    "mnemonic",
    "password",
    "private_key",
    "secret",
    "seed",
    "token",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def redact(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): (
                REDACTED
                if any(part in str(key).lower() for part in SENSITIVE_PARTS)
                else redact(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    return value


class JsonLogger:
    def __init__(self, service: str, stream: TextIO = sys.stdout) -> None:
        self._service = service
        self._stream = stream

    def log(
        self,
        level: str,
        event: str,
        correlation_id: str,
        reason_codes: list[str],
        **fields: Any,
    ) -> None:
        record = {
            "timestamp": utc_now(),
            "level": level,
            "service": self._service,
            "event": event,
            "correlation_id": correlation_id,
            "reason_codes": reason_codes,
            **fields,
        }
        self._stream.write(json.dumps(redact(record), separators=(",", ":")) + "\n")
        self._stream.flush()
