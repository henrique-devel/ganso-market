import { webcrypto } from "node:crypto";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  createTicketKey,
  decimalRaw,
  displayRaw,
  quantityFromNotional,
  deskPost,
  TicketError,
} from "../src/btc-ticket.js";
describe("manual ticket exact amounts and retries", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("creates independent valid intent keys when HTTP omits randomUUID", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    });
    expect(globalThis.crypto.randomUUID).toBeUndefined();
    const first = createTicketKey();
    const second = createTicketKey();
    // Same public grammar as the command API; 16 random bytes are kept in full.
    expect(first).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/);
    expect(first).toHaveLength(32);
    expect(second).not.toBe(first);
  });
  it.each([undefined, {}])(
    "refuses a key without browser cryptographic randomness (%s)",
    (crypto) => {
      vi.stubGlobal("crypto", crypto);
      expect(() => createTicketKey()).toThrow("geração segura");
    },
  );
  it("preserves fixed point and rounds notional down to venue quantum", () => {
    expect(decimalRaw("0,00123", 8)).toBe("123000");
    expect(decimalRaw("65000.1", 6)).toBe("65000100000");
    expect(quantityFromNotional("100000000", "65000000000", "1000")).toBe(
      "153000",
    );
    expect(displayRaw(null)).toBe("indisponível");
    expect(displayRaw("-1234567")).toBe("−1,234567");
    for (const input of ["NaN", "1e3", "1.000,2", "-1", "0.000000001"])
      expect(() => decimalRaw(input, 8)).toThrow();
  });
  it("keeps the caller's intention key for retries and sends CSRF/session", async () => {
    vi.stubGlobal("document", { cookie: "ganso_csrf=fixture-csrf" });
    const fetcher = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ status: "accepted" }))),
      );
    for (let n = 0; n < 2; n++)
      await deskPost(
        "fixture-token",
        "submit",
        { intent: "signed" },
        "same-key",
        fetcher,
      );
    for (const call of fetcher.mock.calls)
      expect(call[1]).toMatchObject({
        method: "POST",
        credentials: "include",
        headers: {
          "idempotency-key": "same-key",
          "x-csrf-token": "fixture-csrf",
          authorization: "Bearer fixture-token",
        },
      });
    vi.unstubAllGlobals();
  });
  it("distinguishes uncertain network/503 results from definitive refusals", async () => {
    for (const fetcher of [
      vi.fn().mockRejectedValue(new Error("lost")),
      vi.fn().mockResolvedValue(new Response("{}", { status: 503 })),
    ])
      await expect(
        deskPost("token", "submit", {}, "same", fetcher),
      ).rejects.toMatchObject({ ambiguous: true });
    await expect(
      deskPost(
        "token",
        "submit",
        {},
        "same",
        vi.fn().mockResolvedValue(
          new Response('{"reason_code":"BTC_RISK_REDUCE_ONLY"}', {
            status: 409,
          }),
        ),
      ),
    ).rejects.toEqual(new TicketError("BTC_RISK_REDUCE_ONLY", false));
  });
});
