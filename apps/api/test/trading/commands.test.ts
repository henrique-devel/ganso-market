import Fastify from "fastify";
import { describe, it, expect, vi } from "vitest";
import { registerTradingCommandRoutes } from "../../src/trading-commandapi.js";

const headers = {
  authorization: "Bearer valid",
  host: "localhost:8080",
  origin: "http://localhost:8080",
  cookie: "ganso_csrf=csrf",
  "x-csrf-token": "csrf",
  "idempotency-key": "one",
};
describe("paper desk command HTTP boundary", () => {
  it("requires auth, same origin and CSRF before every command/preview; no execution or live route", async () => {
    const pool = { readOnly: vi.fn(), transaction: vi.fn() },
      app = Fastify();
    registerTradingCommandRoutes(app, {
      pool,
      authService: {
        session: async (token) =>
          token === "valid"
            ? { status: "ok", username: "owner", expiresAt: new Date() }
            : { status: "unauthenticated" },
      },
    });
    try {
      for (const action of ["preview", "submit", "cancel", "close", "pause"]) {
        for (const [overrides, status, code] of [
          [{ authorization: "" }, 401, "AUTH_UNAUTHENTICATED"],
          [{ authorization: "Bearer expired" }, 401, "AUTH_UNAUTHENTICATED"],
          [{ origin: "" }, 403, "ORIGIN_HEADER_MISSING"],
          [{ origin: "http://evil.example" }, 403, "ORIGIN_HOST_MISMATCH"],
          [{ cookie: "" }, 403, "CSRF_INVALID"],
          [{ "x-csrf-token": "wrong" }, 403, "CSRF_INVALID"],
        ] as const) {
          const r = await app.inject({
            method: "POST",
            url: `/trading/${action}`,
            headers: { ...headers, ...overrides },
            payload: {},
          });
          expect(r.statusCode).toBe(status);
          expect(r.json().reason_code).toBe(code);
          expect(r.headers["cache-control"]).toBe("no-store");
        }
        expect(
          (await app.inject({ url: `/trading/${action}`, headers })).statusCode,
        ).toBe(404);
      }
      for (const path of [
        "execute",
        "advance",
        "live",
        "rearm",
        "submit/extra",
      ])
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/trading/${path}`,
              headers,
            })
          ).statusCode,
        ).toBe(404);
      expect(pool.readOnly).not.toHaveBeenCalled();
      expect(pool.transaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("rejects malformed contracts, caller policy and missing keys without SQL", async () => {
    const pool = { readOnly: vi.fn(), transaction: vi.fn() },
      app = Fastify();
    registerTradingCommandRoutes(app, {
      pool,
      authService: {
        session: async () => ({
          status: "ok",
          username: "owner",
          expiresAt: new Date(),
        }),
      },
    });
    try {
      for (const payload of [
        null,
        [],
        {},
        { account_id: "manual", action: "pause", mode: "live" },
        { account_id: "manual", action: "rearm" },
        { account_id: "manual", action: "cancel", order_id: "../?" },
        { account_id: "manual", action: "submit", quantity_btc_raw: 100 },
      ]) {
        const r = await app.inject({
          method: "POST",
          url: "/trading/preview",
          headers,
          payload: payload as object,
        });
        expect(r.statusCode).toBe(400);
      }
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/trading/preview",
            headers: { ...headers, "idempotency-key": "" },
            payload: { account_id: "manual", action: "pause" },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/trading/submit",
            headers,
            payload: { intent: "bad" },
          })
        ).statusCode,
      ).toBe(400);
      expect(pool.readOnly).not.toHaveBeenCalled();
      expect(pool.transaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
