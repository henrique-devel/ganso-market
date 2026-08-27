"""Static assertions about what the Nginx perimeter publishes.

The perimeter is the difference between "authenticated endpoint" and "endpoint
reachable from the internet". Until 2026-08-27 it published GET and nothing else
under ``/api/polymarket/*``; the owner then asked for the paper kill-switch rearm
so the switch could be rearmed from the panel instead of from inside the server.

That is one POST hole in a wall that had none, and the danger is not the hole —
it is the hole widening by accident. ``location ^~ /api/polymarket/paper`` would
publish ``POST /api/polymarket/paper/intents``, which CREATES simulated orders,
and the diff that did it would look like a one-character change. These tests fail
if that happens.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

CONF = Path(__file__).resolve().parents[2] / "infra" / "nginx" / "nginx.conf"

REARM = "/api/polymarket/paper/kill-switch/rearm"


def conf_text() -> str:
    return CONF.read_text(encoding="utf-8")


def locations() -> list[tuple[str, str]]:
    """Every ``location`` directive, as (modifier+path, body-until-next-location)."""
    text = conf_text()
    matches = list(re.finditer(r"^\s*location\s+([^{]+?)\s*\{", text, re.MULTILINE))
    found: list[tuple[str, str]] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        found.append((match.group(1).strip(), text[match.end() : end]))
    return found


class NginxPerimeterTests(unittest.TestCase):
    def test_rearm_is_published_as_an_exact_path(self) -> None:
        exact = [spec for spec, _ in locations() if spec == f"= {REARM}"]
        self.assertEqual(
            exact,
            [f"= {REARM}"],
            "the rearm must be published as exactly one `location =` entry",
        )

    def test_rearm_refuses_every_method_but_post(self) -> None:
        body = next(body for spec, body in locations() if spec == f"= {REARM}")
        self.assertIn("$request_method != POST", body)
        self.assertIn("return 404", body)

    def test_rearm_is_rate_limited(self) -> None:
        body = next(body for spec, body in locations() if spec == f"= {REARM}")
        self.assertRegex(body, r"limit_req\s+zone=\w+")

    def test_no_prefix_location_can_reach_the_paper_module(self) -> None:
        # `^~ /api/polymarket/paper` would also publish POST .../intents, the
        # surface that creates orders. Only an exact match may name this module.
        for spec, _ in locations():
            path = spec.split()[-1]
            if not path.startswith("/api/polymarket/paper"):
                continue
            self.assertTrue(
                spec.startswith("= "),
                f"{spec!r} publishes the paper module by prefix; use `location =`",
            )
            self.assertEqual(path, REARM, f"{spec!r} publishes more than the rearm")

    def test_the_order_creating_surfaces_stay_closed(self) -> None:
        published = {spec.split()[-1] for spec, _ in locations()}
        for closed in (
            "/api/polymarket/paper/intents",
            "/api/polymarket/paper/orders",
            "/api/polymarket/paper/kill-switch",
            "/api/polymarket/portfolio/halt",
            "/api/polymarket/portfolio/resume",
        ):
            self.assertNotIn(closed, published)

    def test_every_other_api_path_still_falls_through_to_404(self) -> None:
        specs = [spec for spec, _ in locations()]
        self.assertIn("^~ /api/", specs)
        catch_all = next(body for spec, body in locations() if spec == "^~ /api/")
        self.assertIn("return 404", catch_all)

    def test_read_surfaces_remain_get_only(self) -> None:
        for spec, body in locations():
            path = spec.split()[-1]
            if not path.startswith("/api/polymarket/"):
                continue
            if path == REARM:
                continue
            self.assertIn(
                "$request_method != GET",
                body,
                f"{spec!r} publishes a polymarket path without pinning it to GET",
            )


if __name__ == "__main__":
    unittest.main()
