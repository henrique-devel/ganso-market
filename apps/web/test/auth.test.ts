import { describe, expect, it, vi } from "vitest";

import {
  getSession,
  login,
  refreshSession,
  type AuthFetcher,
} from "../src/auth.js";

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

describe("web auth client", () => {
  it("maps a successful login to a session", async () => {
    const fetcher: AuthFetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        access_token: "acc",
        username: "owner",
        expires_at: "2026-08-15T12:15:00.000Z",
      }),
    );
    const outcome = await login("owner", "correct-horse-battery", fetcher);
    expect(outcome).toEqual({
      kind: "ok",
      session: {
        accessToken: "acc",
        username: "owner",
        expiresAt: "2026-08-15T12:15:00.000Z",
      },
    });
  });

  it("maps 401 to invalid and 429 to locked", async () => {
    const invalid = await login(
      "owner",
      "bad",
      vi.fn().mockResolvedValue(jsonResponse(401, {})),
    );
    const locked = await login(
      "owner",
      "bad",
      vi.fn().mockResolvedValue(jsonResponse(429, {})),
    );
    expect(invalid).toEqual({ kind: "invalid" });
    expect(locked).toEqual({ kind: "locked" });
  });

  it("treats a network error as a generic error", async () => {
    const outcome = await login(
      "owner",
      "x",
      vi.fn().mockRejectedValue(new Error("network")),
    );
    expect(outcome).toEqual({ kind: "error" });
  });

  it("skips silent refresh when no CSRF cookie is present", async () => {
    const fetcher = vi.fn();
    const outcome = await refreshSession(null, fetcher);
    expect(outcome).toEqual({ kind: "none" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns the session for a valid access token", async () => {
    const fetcher: AuthFetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        username: "owner",
        expires_at: "2026-08-15T12:15:00.000Z",
      }),
    );
    const session = await getSession("acc", fetcher);
    expect(session).toEqual({
      username: "owner",
      expiresAt: "2026-08-15T12:15:00.000Z",
    });
  });

  it("returns null when the session request is unauthorized", async () => {
    const session = await getSession(
      "acc",
      vi.fn().mockResolvedValue(jsonResponse(401, {})),
    );
    expect(session).toBeNull();
  });
});
