import { describe, expect, it, vi } from "vitest";
import { createSessionRenewal, type AuthFetcher } from "../src/auth.js";

type Reply = Awaited<ReturnType<AuthFetcher>>;
function deferredReply() {
  let resolve!: (reply: Reply) => void;
  const promise = new Promise<Reply>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function reply(accessToken: string): Reply {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      access_token: accessToken,
      expires_at: "2026-09-30T03:00:00.000Z",
    }),
  };
}

describe("session renewal coordination", () => {
  it("rotates once for simultaneous 401s, ignores late old 401s, and can renew the next token", async () => {
    const first = deferredReply();
    const fetcher = vi
      .fn<AuthFetcher>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(reply("access-3"));
    const renewal = createSessionRenewal(fetcher);
    renewal.replace("access-1");
    const requests = Array.from({ length: 12 }, () =>
      renewal.renew("access-1", "csrf-1"),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    first.resolve(reply("access-2"));
    expect(
      (await Promise.all(requests)).every((result) => result.kind === "ok"),
    ).toBe(true);
    expect(await renewal.renew("access-1", "csrf-1")).toEqual({
      kind: "superseded",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await renewal.renew("access-2", "csrf-2")).toMatchObject({
      kind: "ok",
      accessToken: "access-3",
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/auth/refresh",
      expect.objectContaining({
        headers: { "x-csrf-token": "csrf-2", accept: "application/json" },
      }),
    );
  });

  it.each([null, "new-login"])(
    "cannot replace logout or a newer login (%s) with an old completion",
    async (replacement) => {
      const old = deferredReply();
      const fetcher = vi
        .fn<AuthFetcher>()
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(reply("current"));
      const renewal = createSessionRenewal(fetcher);
      renewal.replace("old-login");
      const pending = renewal.renew("old-login", "old-csrf");
      renewal.replace(replacement);
      old.resolve(reply("stale-completion"));
      expect(await pending).toEqual({ kind: "superseded" });
      expect(await renewal.renew("old-login", "old-csrf")).toEqual({
        kind: "superseded",
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      if (replacement !== null) {
        expect(await renewal.renew(replacement, "new-csrf")).toMatchObject({
          accessToken: "current",
        });
      }
    },
  );

  it("does not let an older completion clear the current in-flight renewal", async () => {
    const old = deferredReply(),
      current = deferredReply();
    const fetcher = vi
      .fn<AuthFetcher>()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const renewal = createSessionRenewal(fetcher);
    renewal.replace("old");
    const oldRequest = renewal.renew("old", "old-csrf");
    renewal.replace("new");
    const currentRequest = renewal.renew("new", "new-csrf");
    old.resolve(reply("stale"));
    expect(await oldRequest).toEqual({ kind: "superseded" });
    const duplicate = renewal.renew("new", "new-csrf");
    expect(fetcher).toHaveBeenCalledTimes(2);
    current.resolve(reply("renewed"));
    expect(await currentRequest).toEqual(await duplicate);
  });

  it("shares a refusal without retrying a possibly consumed refresh token", async () => {
    const pending = deferredReply();
    const fetcher = vi.fn<AuthFetcher>().mockReturnValue(pending.promise);
    const renewal = createSessionRenewal(fetcher);
    renewal.replace("expired");
    const a = renewal.renew("expired", "csrf"),
      b = renewal.renew("expired", "csrf");
    pending.resolve({ ok: false, status: 401, json: async () => ({}) });
    expect(await a).toEqual({ kind: "none" });
    expect(await b).toEqual({ kind: "none" });
    expect(await renewal.renew("expired", "csrf")).toEqual({
      kind: "superseded",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("also coalesces initial session restoration", async () => {
    const pending = deferredReply();
    const fetcher = vi.fn<AuthFetcher>().mockReturnValue(pending.promise);
    const renewal = createSessionRenewal(fetcher);
    const a = renewal.renew(null, "csrf"),
      b = renewal.renew(null, "csrf");
    expect(fetcher).toHaveBeenCalledTimes(1);
    pending.resolve(reply("restored"));
    expect(await a).toEqual(await b);
  });
});
