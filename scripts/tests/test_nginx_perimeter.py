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

RFC-015 (2026-09-01) published a second path under ``/paper`` — the read-only
performance report, which is where the panel's unrealised PnL and fees come
from. So "only the rearm may be named" became an allowlist of two. The
allowlist is the point: adding a third requires editing this file, which is a
diff a reviewer reads as "the perimeter changed" rather than as "one more
location".
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

CONF = Path(__file__).resolve().parents[2] / "infra" / "nginx" / "nginx.conf"

REARM = "/api/polymarket/paper/kill-switch/rearm"
PERFORMANCE = "/api/polymarket/paper/performance"
POSITIONS = "/api/polymarket/paper/positions"
ORDERS = "/api/polymarket/paper/orders"
SERIES = "/api/polymarket/series"

# Every path under /api/polymarket/paper the perimeter is allowed to name, and
# the ONE method each may carry. Anything else under that prefix — intents, the
# order cancel, the kill-switch engage — stays unreachable from outside.
#
# RFC-026 D8 (owner decision P1, 2026-09-05) took this list from two to four.
# The two additions are reads that were already written and already closed;
# what changed is that the Carteira screen can now reach them. They are GET and
# only GET: the same module answers POST /paper/intents, and that one stays
# unnamed here, which is the whole reason this is an allowlist and not a rule.
PAPER_ALLOWLIST = {
    REARM: "POST",
    PERFORMANCE: "GET",
    POSITIONS: "GET",
    ORDERS: "GET",
}


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
        # surface that creates orders. Only an exact match may name this module,
        # and only for a path on the allowlist.
        for spec, body in locations():
            path = spec.split()[-1]
            if not path.startswith("/api/polymarket/paper"):
                continue
            self.assertTrue(
                spec.startswith("= "),
                f"{spec!r} publishes the paper module by prefix; use `location =`",
            )
            self.assertIn(
                path,
                PAPER_ALLOWLIST,
                f"{spec!r} publishes a paper path that is not on the allowlist",
            )
            allowed = PAPER_ALLOWLIST[path]
            self.assertIn(
                f"$request_method != {allowed}",
                body,
                f"{spec!r} must be pinned to {allowed} and nothing else",
            )

    def test_the_rfc_015_read_surfaces_are_exact_and_get_only(self) -> None:
        specs = {spec.split()[-1]: spec for spec, _ in locations()}
        for path in (
            "/api/polymarket/overview",
            "/api/polymarket/events",
            "/api/polymarket/data-quality",
            PERFORMANCE,
            # RFC-026 D8. Published as reads, so they answer to the same rule
            # the RFC-015 surfaces do: exact path, GET, 404 for anything else.
            POSITIONS,
            ORDERS,
        ):
            self.assertIn(path, specs, f"{path} is not published")
            self.assertTrue(
                specs[path].startswith("= "),
                f"{path} must be an exact location, not a prefix",
            )
            body = next(b for s, b in locations() if s == specs[path])
            self.assertIn("$request_method != GET", body)
            self.assertIn("return 404", body)

    def test_the_order_creating_surfaces_stay_closed(self) -> None:
        # RFC-026 D8 moved `paper/orders` and `paper/positions` OUT of this
        # list and into PAPER_ALLOWLIST, because the panel now reads them. What
        # is left here is the part that must never be published at all: the
        # intent that creates an order, the kill-switch engage, and the two
        # portfolio state controls whose absence is the reason HALTED cannot be
        # left from a browser. Read this list as "no location may name these",
        # and the allowlist above as "these may be named, with this one method".
        published = {spec.split()[-1] for spec, _ in locations()}
        for closed in (
            "/api/polymarket/paper/intents",
            "/api/polymarket/paper/kill-switch",
            "/api/polymarket/portfolio/halt",
            "/api/polymarket/portfolio/resume",
        ):
            self.assertNotIn(closed, published)

    def test_the_published_paper_reads_never_carry_a_write_method(self) -> None:
        # The allowlist pins a method per path, and `test_no_prefix_location_
        # can_reach_the_paper_module` checks the guard is there. This checks the
        # other half: that the guard is the ONLY method the block lets through,
        # so a second `if ($request_method != POST)` added later — which would
        # make the block accept both — fails here instead of shipping.
        for path in (POSITIONS, ORDERS):
            body = next(body for spec, body in locations() if spec == f"= {path}")
            guards = re.findall(r"\$request_method\s*!=\s*(\w+)", body)
            self.assertEqual(
                guards,
                ["GET"],
                f"{path} must refuse every method but GET, and say so once",
            )

    def test_every_other_api_path_still_falls_through_to_404(self) -> None:
        specs = [spec for spec, _ in locations()]
        self.assertIn("^~ /api/", specs)
        catch_all = next(body for spec, body in locations() if spec == "^~ /api/")
        self.assertIn("return 404", catch_all)

    def test_the_series_prefix_is_published_and_get_only(self) -> None:
        # RFC-026 D10 (owner decision P2). Unlike the surfaces above this one is
        # a PREFIX, because the module answers both `/series` (the batch) and
        # `/series/:tokenId`. A prefix is the shape that needs watching: it also
        # publishes every path anyone adds under it later, so the guard has to
        # be there and has to be the only one.
        matches = [spec for spec, _ in locations() if spec.split()[-1] == SERIES]
        self.assertEqual(
            matches,
            [f"^~ {SERIES}"],
            "the series surface must be published as exactly one `^~` location",
        )
        body = next(body for spec, body in locations() if spec == f"^~ {SERIES}")
        guards = re.findall(r"\$request_method\s*!=\s*(\w+)", body)
        self.assertEqual(
            guards,
            ["GET"],
            "the series prefix must refuse every method but GET, and say so once",
        )
        self.assertIn("return 404", body)

    def test_the_series_prefix_cannot_reach_the_paper_module(self) -> None:
        # `^~ /api/polymarket/series` is only safe while it stays outside
        # `/paper`. This is the assertion that a later rename cannot slip past.
        self.assertFalse(SERIES.startswith("/api/polymarket/paper"))

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
