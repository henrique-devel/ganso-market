import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerTradingReadRoutes } from "../../src/trading-readapi.js";

describe("desk HTTP boundary", () => {
  it("authenticates every GET before querying and registers no commands", async () => {
    const readOnly = vi.fn();
    const app = Fastify();
    registerTradingReadRoutes(app, {
      pool: { readOnly },
      authService: { session: async () => ({ status: "unauthenticated" }) },
      clock: () => new Date(),
    });
    try {
      for (const route of [
        "accounts",
        "account",
        "positions",
        "orders",
        "operation",
      ]) {
        for (const headers of [{}, { authorization: "Bearer expired" }]) {
          const r = await app.inject({ url: `/trading/${route}`, headers });
          expect(r.statusCode).toBe(401);
          expect(r.json().reason_code).toBe("AUTH_UNAUTHENTICATED");
          expect(r.headers["cache-control"]).toBe("no-store");
        }
        expect(
          (await app.inject({ method: "POST", url: `/trading/${route}` }))
            .statusCode,
        ).toBe(404);
      }
      expect(readOnly).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("refuses malformed, duplicate, unscoped or excessive pagination inputs without SQL", async () => {
    const readOnly = vi.fn();
    const app = Fastify();
    registerTradingReadRoutes(app, {
      pool: { readOnly },
      authService: { session: async () => ({ status: "ok" }) },
      clock: () => new Date(),
    });
    try {
      for (const url of [
        "/trading/orders",
        "/trading/operation?account_id=manual",
        "/trading/operation?account_id=manual&order_id=a&order_id=b",
        "/trading/operation?account_id=manual&order_id=a&view=all",
        "/trading/orders?account_id=manual&position_id=",
        "/trading/operation?account_id=manual&order_id=a&limit=101",
        "/trading/account?account_id=",
        "/trading/account?account_id=a&account_id=b",
        "/trading/accounts?limit=0",
        "/trading/accounts?limit=101",
        "/trading/accounts?limit=2.5",
        "/trading/accounts?limit=1&limit=2",
        "/trading/accounts?cursor=garbage",
        "/trading/accounts?mode=live",
        "/trading/account?account_id=manual&cursor=a",
        "/trading/orders?account_id=manual&status=invalid",
      ]) {
        const r = await app.inject({
          url,
          headers: { authorization: "Bearer valid" },
        });
        expect(r.statusCode, url).toBe(400);
        expect(r.json().reason_code).toBe("TRADING_INVALID_QUERY");
      }
      expect(readOnly).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("reports a failed database as unavailable, without fake balances or raw errors", async () => {
    const app = Fastify();
    registerTradingReadRoutes(app, {
      pool: {
        readOnly: async () => {
          throw new Error("private SQL details");
        },
      },
      authService: { session: async () => ({ status: "ok" }) },
      clock: () => new Date(),
    });
    try {
      const r = await app.inject({
        url: "/trading/accounts",
        headers: { authorization: "Bearer valid" },
      });
      expect(r.statusCode).toBe(503);
      expect(r.json().reason_code).toBe("TRADING_READ_UNAVAILABLE");
      expect(r.body).not.toContain("private");
    } finally {
      await app.close();
    }
  });
});
