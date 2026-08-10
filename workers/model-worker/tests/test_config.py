from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SOURCE))

from ganso_model_worker.config import ConfigError, load_config  # noqa: E402


class ConfigTests(unittest.TestCase):
    def test_safe_defaults_are_local_and_paper(self) -> None:
        config = load_config(environment={})
        self.assertEqual(config.execution_mode, "paper")
        self.assertEqual(config.service.bind_address, "127.0.0.1")

    def test_file_overrides_defaults(self) -> None:
        document = {
            "schema_version": 1,
            "execution_mode": "paper",
            "services": {"model_worker": {"bind_address": "0.0.0.0", "port": 8090}},
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.json"
            path.write_text(json.dumps(document), encoding="utf-8")
            config = load_config(path=path, environment={})
        self.assertEqual(config.service.bind_address, "0.0.0.0")
        self.assertEqual(config.service.port, 8090)

    def test_live_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.json"
            path.write_text('{"execution_mode":"live"}', encoding="utf-8")
            with self.assertRaisesRegex(ConfigError, "paper"):
                load_config(path=path, environment={})

    def test_unknown_key_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.json"
            path.write_text('{"future_feature":true}', encoding="utf-8")
            with self.assertRaisesRegex(ConfigError, "unknown"):
                load_config(path=path, environment={})

    def test_missing_configured_file_is_rejected(self) -> None:
        with self.assertRaisesRegex(ConfigError, "missing"):
            load_config(environment={"GANSO_CONFIG_FILE": "/does/not/exist"})

    def test_empty_config_locator_is_rejected(self) -> None:
        with self.assertRaisesRegex(ConfigError, "non-empty exact path"):
            load_config(environment={"GANSO_CONFIG_FILE": ""})


if __name__ == "__main__":
    unittest.main()
