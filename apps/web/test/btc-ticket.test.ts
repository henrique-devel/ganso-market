import { describe, it, expect, vi } from "vitest";
import {
  decimalRaw,
  displayRaw,
  quantityFromNotional,
  deskPost,
  TicketError,
} from "../src/btc-ticket.js";
describe("manual ticket exact amounts and retries", () => {
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
