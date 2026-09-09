import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DISK_ONLY_ROUTES } from "./fixtures/disk-only-routes.js";

const REPO = new URL("../../../", import.meta.url).pathname;
const NGINX = join(REPO, "infra/nginx/nginx.conf");
const RUNTIME = join(REPO, "config/runtime.json");
const SRC = join(REPO, "apps/api/src");

interface PublishedLocation {
  /** The upstream path the edge proxies to, e.g. `/polymarket/overview`. */
  readonly upstream: string;
  /** `^~` publishes every route under the path; `=` publishes only that path. */
  readonly prefix: boolean;
  /** The method the location allows through (everything else gets a 404). */
  readonly method: "GET" | "POST";
}

/**
 * RFC-023 D1. The perimeter, read from the perimeter's own file.
 *
 * The list of published endpoints is not duplicated here on purpose: this test
 * exists precisely to catch the case where somebody adds a location to
 * nginx.conf and nothing else notices. Reading a hand-kept copy of the list
 * would make it notice nothing.
 */
function publishedLocations(): PublishedLocation[] {
  const conf = readFileSync(NGINX, "utf8");
  const blocks = conf.split(/\blocation\s+/).slice(1);
  const found: PublishedLocation[] = [];
  for (const block of blocks) {
    const header = /^(\^~|=)\s*(\S+)\s*\{/.exec(block);
    if (header === null) {
      continue;
    }
    const body = block.slice(0, block.indexOf("\n        }"));
    const pass = /proxy_pass\s+http:\/\/api:3000(\/polymarket\S*?);/.exec(body);
    if (pass === null) {
      continue;
    }
    const guard = /\$request_method\s*!=\s*(GET|POST)/.exec(body);
    found.push({
      upstream: pass[1] as string,
      prefix: header[1] === "^~",
      method: (guard?.[1] as "GET" | "POST" | undefined) ?? "GET",
    });
  }
  return found;
}

/** Every `app.get`/`app.post` path literal registered under apps/api/src. */
function declaredRoutes(): {
  method: "GET" | "POST";
  url: string;
  file: string;
}[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts")) {
        files.push(full);
      }
    }
  };
  walk(SRC);

  const routes: { method: "GET" | "POST"; url: string; file: string }[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const pattern = /app\.(get|post)\(\s*"(\/[^"]*)"/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      routes.push({
        method: match[1] === "get" ? "GET" : "POST",
        url: match[2] as string,
        file: file.slice(REPO.length),
      });
    }
  }
  return routes;
}

function declaredBudgets(): Record<string, number> {
  const shipped = JSON.parse(readFileSync(RUNTIME, "utf8")) as {
    services: {
      api: { statement_timeout_ms?: { routes?: Record<string, number> } };
    };
  };
  return shipped.services.api.statement_timeout_ms?.routes ?? {};
}

function isPublished(
  route: { method: string; url: string },
  locations: readonly PublishedLocation[],
): boolean {
  return locations.some((location) => {
    if (location.method !== route.method) {
      return false;
    }
    return location.prefix
      ? route.url === location.upstream ||
          route.url.startsWith(`${location.upstream}/`)
      : route.url === location.upstream;
  });
}

describe("RFC-023 D1 — every published route declares a budget", () => {
  const locations = publishedLocations();
  const routes = declaredRoutes();
  const budgets = declaredBudgets();

  it("finds the perimeter it is supposed to be checking", () => {
    // A parser that silently matches nothing would make every assertion below
    // vacuously true, which is the failure mode this test cannot afford.
    expect(locations.length).toBeGreaterThanOrEqual(11);
    expect(routes.length).toBeGreaterThanOrEqual(20);
  });

  it("gives every GET route under a published location its own budget", () => {
    const published = routes.filter(
      (route) => route.method === "GET" && isPublished(route, locations),
    );
    expect(published.length).toBeGreaterThan(0);
    const undeclared = published
      // RFC-029 D3: the two shadow-replay reads open no database connection, so
      // there is no statement for a statement budget to bound. They are excused
      // here and held to that reason in route-budgets.runtime.test.ts, which
      // fails if either of them ever runs a query.
      .filter((route) => !DISK_ONLY_ROUTES.includes(route.url))
      .filter((route) => budgets[route.url] === undefined)
      .map((route) => `${route.url} (${route.file})`);
    // Publishing a route without declaring what it may cost is the thing this
    // RFC makes impossible. Adding the Nginx location is not enough; the route
    // has to appear in services.api.statement_timeout_ms.routes as well.
    expect(undeclared).toEqual([]);
  });

  it("does not hand a read budget to a published write", () => {
    // The kill-switch rearm is the only POST the perimeter publishes. A budget
    // for it would mean it had been routed through the READ ONLY executor.
    const publishedWrites = routes.filter(
      (route) => route.method === "POST" && isPublished(route, locations),
    );
    expect(publishedWrites.map((route) => route.url)).toEqual([
      "/polymarket/paper/kill-switch/rearm",
    ]);
    for (const write of publishedWrites) {
      expect(budgets[write.url], write.url).toBeUndefined();
    }
  });

  it("keeps the disk-only exemption honest: they are published and registered", () => {
    // The exemption is only safe while the list names routes that EXIST and are
    // actually published. A stale entry here would silently excuse nothing —
    // or, worse, excuse a route somebody later pointed at the database.
    for (const url of DISK_ONLY_ROUTES) {
      const route = routes.find(
        (candidate) => candidate.method === "GET" && candidate.url === url,
      );
      expect(route, `${url} is not a registered GET`).toBeDefined();
      expect(
        isPublished({ method: "GET", url }, locations),
        `${url} is not published by the perimeter`,
      ).toBe(true);
      expect(budgets[url], `${url} must not declare a budget`).toBeUndefined();
    }
  });

  it("declares no budget for a route that does not exist", () => {
    // A stale entry is a budget nobody enforces and a reader misled.
    const urls = new Set(routes.map((route) => route.url));
    const orphans = Object.keys(budgets).filter((url) => !urls.has(url));
    expect(orphans).toEqual([]);
  });
});
