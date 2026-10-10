import { afterEach, describe, expect, it, vi } from "vitest";
import { createJevControlClient } from "../src/jev-control.js";
describe("JE16 browser intent retry", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("blocks duplicate clicks and reuses an uncertain key after reload, without storing credentials", async () => {
    vi.stubGlobal("document", { cookie: "ganso_csrf=public-fixture" });
    const saved = new Map<string, string>(),
      storage = {
        getItem: (k: string) => saved.get(k) ?? null,
        setItem: (k: string, v: string) => {
          saved.set(k, v);
        },
      };
    let fail!: () => void;
    const lost = vi.fn(
      () =>
        new Promise<Response>((_resolve, reject) => {
          fail = () => reject(new Error("response lost"));
        }),
    );
    const command = { account_id: "live:h1", action: "emergency" as const },
      client = createJevControlClient("live:h1,paper:h1", storage, lost);
    const pending = client.command("fixture-session", command, () => {});
    expect(client.busy).toBe(true);
    expect(
      await client.command("fixture-session", command, () => {}),
    ).toBeNull();
    expect(lost).toHaveBeenCalledTimes(1);
    const key = (lost.mock.calls[0] as unknown as [string, RequestInit])[1]
      .headers as Record<string, string>;
    fail();
    await expect(pending).rejects.toThrow("Repetir preserva a mesma chave");
    expect([...saved.values()].join()).not.toContain("fixture-session");
    const recovered = vi.fn(
      async () =>
        new Response('{"status":"duplicate"}', {
          headers: { "content-type": "application/json" },
        }),
    );
    const reload = createJevControlClient(
      "live:h1,paper:h1",
      storage,
      recovered,
    );
    expect(
      await reload.command("new-session", command, () => {}),
    ).toMatchObject({ status: "duplicate" });
    expect(
      (recovered.mock.calls[0] as unknown as [string, RequestInit])[1],
    ).toMatchObject({
      body: JSON.stringify(command),
      cache: "no-store",
      headers: {
        "idempotency-key": key["idempotency-key"],
        "x-csrf-token": "public-fixture",
        authorization: "Bearer new-session",
      },
    });
    await reload.command(
      "new-session",
      { ...command, action: "pause" },
      () => {},
    );
    expect(
      (
        (recovered.mock.calls[1] as unknown as [string, RequestInit])[1]
          .headers as Record<string, string>
      )["idempotency-key"],
    ).not.toBe(key["idempotency-key"]);
  });
});
