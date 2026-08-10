from __future__ import annotations

import io
import json
import sys
import threading
import unittest
import urllib.request
import uuid
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SOURCE))

from ganso_model_worker.config import RuntimeConfig, ServiceConfig  # noqa: E402
from ganso_model_worker.logging import JsonLogger  # noqa: E402
from ganso_model_worker.server import create_server  # noqa: E402


class ServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.log_stream = io.StringIO()
        logger = JsonLogger("model-worker", self.log_stream)
        config = RuntimeConfig(1, "paper", ServiceConfig("127.0.0.1", 0), "info")
        self.server = create_server(config, logger)
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            kwargs={"poll_interval": 0.05},
        )
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.thread.join(timeout=2)
        self.server.server_close()
        self.assertFalse(self.thread.is_alive())

    def _get(
        self, path: str, correlation_id: str = "test-correlation"
    ) -> urllib.request.addinfourl:
        port = self.server.server_address[1]
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}{path}",
            headers={"x-correlation-id": correlation_id},
        )
        return urllib.request.urlopen(request, timeout=2)

    def test_health_and_metrics_respond_with_real_state(self) -> None:
        with self._get("/health/live") as response:
            live = json.load(response)
            self.assertEqual(response.status, 200)
            self.assertEqual(live["status"], "live")
            self.assertEqual(live["execution_mode"], "paper")
            self.assertEqual(response.headers["x-correlation-id"], "test-correlation")
        with self._get("/health/ready") as response:
            ready = json.load(response)
            self.assertEqual(ready["status"], "ready")
        with self._get("/metrics") as response:
            self.assertIn("ganso_service_ready", response.read().decode("utf-8"))

    def test_sensitive_fields_are_redacted(self) -> None:
        sentinel = "must-not-appear"
        logger = JsonLogger("model-worker", self.log_stream)
        logger.log("info", "redaction_test", "test", [], database_password=sentinel)
        output = self.log_stream.getvalue()
        self.assertNotIn(sentinel, output)
        self.assertIn("[REDACTED]", output)

    def test_invalid_correlation_id_replacement_is_observable(self) -> None:
        supplied = ".invalid-correlation"
        with self._get("/health/live", supplied) as response:
            generated = response.headers["x-correlation-id"]
            uuid.UUID(generated)
            self.assertNotEqual(generated, supplied)

        output = self.log_stream.getvalue()
        self.assertIn("CORRELATION_ID_REPLACED", output)
        self.assertNotIn(supplied, output)


if __name__ == "__main__":
    unittest.main()
