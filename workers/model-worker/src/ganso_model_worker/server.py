"""Internal health, readiness, and metrics server; no model behavior."""

from __future__ import annotations

import json
import re
import signal
import threading
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .config import RuntimeConfig
from .logging import JsonLogger, utc_now

CORRELATION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
SERVICE_NAME = "model-worker"


def health_payload(status: str, correlation_id: str) -> dict[str, object]:
    return {
        "service": SERVICE_NAME,
        "status": status,
        "checked_at": utc_now(),
        "execution_mode": "paper",
        "correlation_id": correlation_id,
        "reason_codes": [],
        "checks": [],
    }


class HealthServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], logger: JsonLogger) -> None:
        super().__init__(address, HealthHandler)
        self.logger = logger


class HealthHandler(BaseHTTPRequestHandler):
    server: HealthServer
    protocol_version = "HTTP/1.1"

    def _correlation_id(self) -> str:
        supplied = self.headers.get("x-correlation-id", "")
        if CORRELATION_ID.fullmatch(supplied):
            return supplied
        generated = str(uuid.uuid4())
        if supplied:
            self.server.logger.log(
                "warn",
                "invalid_correlation_id_replaced",
                generated,
                ["CORRELATION_ID_REPLACED"],
            )
        return generated

    def _json(self, status: HTTPStatus, payload: dict[str, object], correlation_id: str) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.send_header("x-correlation-id", correlation_id)
        self.send_header("connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _metrics(self, correlation_id: str) -> None:
        body = (
            "# HELP ganso_service_live Whether the process is live.\n"
            "# TYPE ganso_service_live gauge\n"
            f'ganso_service_live{{service="{SERVICE_NAME}"}} 1\n'
            "# HELP ganso_service_ready Whether mandatory dependencies are ready.\n"
            "# TYPE ganso_service_ready gauge\n"
            f'ganso_service_ready{{service="{SERVICE_NAME}"}} 1\n'
        ).encode()
        self.send_response(HTTPStatus.OK)
        self.send_header("content-type", "text/plain; version=0.0.4; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("x-correlation-id", correlation_id)
        self.send_header("connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        correlation_id = self._correlation_id()
        response_status = HTTPStatus.OK
        if self.path == "/health/live":
            self._json(HTTPStatus.OK, health_payload("live", correlation_id), correlation_id)
        elif self.path == "/health/ready":
            self._json(HTTPStatus.OK, health_payload("ready", correlation_id), correlation_id)
        elif self.path == "/metrics":
            self._metrics(correlation_id)
        else:
            response_status = HTTPStatus.NOT_FOUND
            self._json(
                HTTPStatus.NOT_FOUND,
                {
                    "error": "not_found",
                    "reason_codes": ["ROUTE_NOT_FOUND"],
                    "correlation_id": correlation_id,
                },
                correlation_id,
            )
        self.server.logger.log(
            "info",
            "http_request_completed",
            correlation_id,
            [],
            method="GET",
            http_status=int(response_status),
        )

    def log_message(self, format: str, *args: object) -> None:
        return


def create_server(config: RuntimeConfig, logger: JsonLogger) -> HealthServer:
    return HealthServer((config.service.bind_address, config.service.port), logger)


def serve(config: RuntimeConfig, stop_event: threading.Event | None = None) -> None:
    logger = JsonLogger(SERVICE_NAME)
    server = create_server(config, logger)
    stopping = threading.Event() if stop_event is None else stop_event

    def request_stop(signum: int, _frame: object) -> None:
        logger.log(
            "info",
            "shutdown_requested",
            "system",
            ["PROCESS_SIGNAL_RECEIVED"],
            signal_number=signum,
        )
        stopping.set()

    if threading.current_thread() is threading.main_thread():
        signal.signal(signal.SIGINT, request_stop)
        signal.signal(signal.SIGTERM, request_stop)

    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1})
    thread.start()
    logger.log("info", "service_started", "system", [], execution_mode="paper")
    stopping.wait()
    server.shutdown()
    thread.join(timeout=5)
    server.server_close()
    if thread.is_alive():
        raise RuntimeError("health server did not stop within five seconds")
    logger.log("info", "service_stopped", "system", [])
