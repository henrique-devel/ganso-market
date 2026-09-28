"""BTC perimeter: exact reads/writes and retired routes closed."""

import re
import unittest
from pathlib import Path

CONF = Path(__file__).parents[2] / "infra/nginx/nginx.conf"


def locations() -> list[tuple[str, str]]:
    """Every ``location`` directive, as (modifier+path, body-until-next-location)."""
    text = CONF.read_text()
    matches = list(re.finditer(r"^\s*location\s+([^{]+?)\s*\{", text, re.MULTILINE))
    found: list[tuple[str, str]] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        found.append((match.group(1).strip(), text[match.end() : end]))
    return found


class NginxPerimeterTests(unittest.TestCase):
    def test_desk_reads_are_exact_and_get_only(self) -> None:
        expected = {
            f"/api/trading/{name}"
            for name in (
                "accounts",
                "account",
                "positions",
                "orders",
                "operation",
                "jev",
                "experiment-datasets",
                "experiments",
                "experiment-system",
            )
        }
        commands = {
            f"/api/trading/{name}" for name in ("preview", "submit", "cancel", "close", "pause")
        }
        published = {spec.split()[-1] for spec, _ in locations() if "/api/trading" in spec}
        self.assertEqual(published, expected | commands)
        for path in commands:
            body = next(body for spec, body in locations() if spec == f"= {path}")
            self.assertEqual(re.findall(r"\$request_method\s*!=\s*(\w+)", body), ["POST"])
            self.assertIn("return 404", body)
            self.assertIn("proxy_set_header Host $http_host", body)
        for path in expected:
            body = next(body for spec, body in locations() if spec == f"= {path}")
            if path == "/api/trading/experiments":
                self.assertIn("$request_method !~ ^(GET|POST)$", body)
                self.assertIn("client_max_body_size 32k", body)
            else:
                self.assertEqual(re.findall(r"\$request_method\s*!=\s*(\w+)", body), ["GET"])
            self.assertIn("return 404", body)

    def test_unknown_and_retired_api_routes_are_closed(self) -> None:
        all_locations = locations()
        self.assertFalse(any("polymarket" in spec for spec, _ in all_locations))
        catch_all = next(body for spec, body in all_locations if spec == "^~ /api/")
        self.assertIn("return 404", catch_all)
        self.assertNotIn("proxy_pass", catch_all.split("}", 1)[0])
