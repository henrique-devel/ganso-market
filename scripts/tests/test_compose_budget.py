from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from check_compose_policy import FOUR_GIB, validate  # noqa: E402


class BudgetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.model = {
            "networks": {"backend": {"internal": True}, "edge": {}},
            "services": {
                "postgres": {"mem_limit": 1024**3, "cpus": 1},
                "api": {"mem_limit": 384 * 1024**2, "cpus": 0.75},
                "btc-worker": {"mem_limit": 256 * 1024**2, "cpus": 0.5, "scale": 0},
            },
        }

    def test_combines_replicas_and_leaves_connection_reserve(self) -> None:
        now = validate(self.model)
        self.model["services"]["btc-worker"]["scale"] = 2
        later = validate(self.model)
        self.assertEqual(later["memory"] - now["memory"], 512 * 1024**2)
        self.assertEqual(later["connections"] - now["connections"], 4)
        self.assertEqual(later["connection_reserve"], 8)

    def test_refuses_memory_cpu_and_connection_overcommit(self) -> None:
        for field, value in [("mem_limit", FOUR_GIB), ("cpus", 8), ("scale", 9)]:
            with self.subTest(field=field):
                old = self.model["services"]["api"].get(field)
                self.model["services"]["api"][field] = value
                with self.assertRaises(ValueError):
                    validate(self.model)
                if old is None:
                    del self.model["services"]["api"][field]
                else:
                    self.model["services"]["api"][field] = old

    def test_refuses_missing_limits_or_published_database(self) -> None:
        del self.model["services"]["api"]["cpus"]
        with self.assertRaises(ValueError):
            validate(self.model)
        self.model["services"]["api"]["cpus"] = 1
        self.model["services"]["postgres"]["ports"] = [{"host_ip": "127.0.0.1"}]
        with self.assertRaises(ValueError):
            validate(self.model)
