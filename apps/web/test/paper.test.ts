// The one write this dashboard makes: rearming the paper kill switch.
//
// What is worth testing here is exactly what a browser would hide: that the
// request is a POST to the published path with the bearer attached, that a
// refusal is distinguishable from a failure (the operator has to be told WHY),
// and that a malformed body never reads as "the broker is running".

import { describe, expect, it, vi } from "vitest";

import { parseRearmOutcome, rearmKillSwitch } from "../src/paper.js";

function jsonResponse(
  status: number,
  body: unknown,
): Pick<Response, "ok" | "status" | "json"> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

const OK = { simulation: "SIMULAÇÃO — SEM EXECUÇÃO REAL", engaged: false };

describe("rearmKillSwitch", () => {
  it("POSTs to the published path with the session bearer", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, OK));
    const result = await rearmKillSwitch("tok-123", fetcher);

    expect(result).toEqual({ kind: "ok", value: { engaged: false } });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/polymarket/paper/kill-switch/rearm",
    );
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer tok-123",
    );
    // A cached rearm would be a lie about a state that changes.
    expect(init.cache).toBe("no-store");
  });

  it("reports a 409 as a refusal carrying the server's reason", async () => {
    // Not an error: the switch may have re-engaged between the read and the
    // click, and the reason is what belongs on screen.
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(409, { reason_code: "RESOLUTION_CIRCUIT_BREAKER" }),
      );
    const result = await rearmKillSwitch("tok", fetcher);
    expect(result).toEqual({
      kind: "refused",
      reason: "RESOLUTION_CIRCUIT_BREAKER",
    });
  });

  it("still reports a refusal when the 409 body is unreadable", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.reject(new Error("not json")),
    });
    expect(await rearmKillSwitch("tok", fetcher)).toEqual({
      kind: "refused",
      reason: null,
    });
  });

  it("separates an expired session from a failure", async () => {
    const unauthorized = vi.fn().mockResolvedValue(jsonResponse(401, {}));
    expect(await rearmKillSwitch("tok", unauthorized)).toEqual({
      kind: "unauthorized",
    });

    const broken = vi.fn().mockResolvedValue(jsonResponse(500, {}));
    expect(await rearmKillSwitch("tok", broken)).toEqual({ kind: "error" });

    const offline = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await rearmKillSwitch("tok", offline)).toEqual({ kind: "error" });
  });
});

describe("parseRearmOutcome", () => {
  it("accepts only an explicit boolean for engaged", () => {
    // The permissive reading of a malformed payload would be "engaged: false" —
    // the broker is running — which is exactly the reading that makes an
    // operator stop looking while the broker is in fact still halted.
    expect(parseRearmOutcome({ engaged: false })).toEqual({ engaged: false });
    expect(parseRearmOutcome({ engaged: true })).toEqual({ engaged: true });
    expect(parseRearmOutcome({ engaged: "false" })).toBeNull();
    expect(parseRearmOutcome({ engaged: 0 })).toBeNull();
    expect(parseRearmOutcome({})).toBeNull();
    expect(parseRearmOutcome(null)).toBeNull();
    expect(parseRearmOutcome([{ engaged: false }])).toBeNull();
  });
});
