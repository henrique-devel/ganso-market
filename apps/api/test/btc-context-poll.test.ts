import { describe, expect, it, vi } from "vitest";
import type { TradingMarketObservation } from "@ganso-market/contracts/trading";
import {
  createContextPoll,
  CONTEXT_POLL_LIMITS,
} from "../src/btc/context-poll.js";
const timeout = () => new DOMException("private transport", "TimeoutError");
function fixture() {
  let now = 1_000_000;
  const controller = new AbortController();
  const event = {
    received_at: new Date(now).toISOString(),
    source_timestamp: null,
  } as TradingMarketObservation;
  const fetch = vi.fn(async () => event);
  const unavailable = vi.fn();
  const poll = createContextPoll({
    now: () => now,
    signal: controller.signal,
    fetch,
    unavailable,
  });
  return {
    poll,
    fetch,
    event,
    unavailable,
    controller,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe("bounded context timeout recovery", () => {
  it("opens unavailability, respects completion-based cadence and returns only new evidence", async () => {
    const f = fixture();
    expect(await f.poll.poll()).toBe(f.event);
    f.advance(1999);
    expect(await f.poll.poll()).toBeNull();
    f.advance(1);
    f.fetch.mockRejectedValueOnce(timeout());
    expect(await f.poll.poll()).toBeNull();
    expect(f.unavailable).toHaveBeenCalledOnce();
    expect(f.poll.status()).toMatchObject({
      timeouts: 1,
      consecutive_timeouts: 1,
      last_timeout: { error_type: "TimeoutError" },
    });
    expect(JSON.stringify(f.poll.status())).not.toContain("private");
    f.advance(1999);
    expect(await f.poll.poll()).toBeNull();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    f.advance(1);
    const next = { ...f.event, received_at: "new observation" };
    f.fetch.mockResolvedValueOnce(next);
    expect(await f.poll.poll()).toBe(next);
    expect(f.event.received_at).toBe(new Date(1_000_000).toISOString());
    expect(f.poll.status()).toMatchObject({
      timeouts: 1,
      consecutive_timeouts: 0,
    });
  });
  it("backs off 2/4/4 seconds and terminates at the fourth timeout without replenishing its session budget", async () => {
    const f = fixture();
    f.fetch.mockRejectedValue(timeout());
    for (const backoff of [2000, 4000, 4000]) {
      expect(await f.poll.poll()).toBeNull();
      f.advance(backoff - 1);
      const calls = f.fetch.mock.calls.length;
      expect(await f.poll.poll()).toBeNull();
      expect(f.fetch).toHaveBeenCalledTimes(calls);
      f.advance(1);
    }
    await expect(f.poll.poll()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(f.poll.status()).toMatchObject({
      exhausted: true,
      timeouts: 4,
      in_flight: false,
    });
    f.advance(60_000);
    await expect(f.poll.poll()).rejects.toThrow("EXHAUSTED");
    expect(f.fetch).toHaveBeenCalledTimes(4);
    expect(CONTEXT_POLL_LIMITS).toEqual({
      intervalMs: 2000,
      maxTimeouts: 3,
      maxBackoffMs: 4000,
    });
  });
  it("does not turn intermittent success into an unlimited retry allowance", async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) {
      f.fetch.mockRejectedValueOnce(timeout());
      await f.poll.poll();
      f.advance(2000);
      expect(await f.poll.poll()).toBe(f.event);
      f.advance(2000);
    }
    f.fetch.mockRejectedValueOnce(timeout());
    await expect(f.poll.poll()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(f.poll.status().consecutive_timeouts).toBe(1);
  });
  it.each([
    new DOMException("operator", "AbortError"),
    new Error("BTC_CONTEXT_RESPONSE_REFUSED"),
    new Error("BTC_CONTEXT_TIME_UNPROVEN"),
    new Error("BTC_COLLECTOR_METADATA_CHANGED"),
    new SyntaxError("bad payload"),
    Object.assign(new Error("lock"), { code: "55P03" }),
    new TypeError("network"),
  ])("retains fatal semantics for $name/$message", async (error) => {
    const f = fixture();
    f.fetch.mockRejectedValueOnce(error);
    await expect(f.poll.poll()).rejects.toBe(error);
    expect(f.unavailable).not.toHaveBeenCalled();
    expect(f.poll.status().timeouts).toBe(0);
  });
  it("allows only one in-flight request, discards late completion after stop and never starts another", async () => {
    const f = fixture();
    let resolve!: (event: TradingMarketObservation) => void;
    f.fetch.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const running = f.poll.poll();
    f.advance(60_000);
    expect(await f.poll.poll()).toBeNull();
    expect(f.fetch).toHaveBeenCalledOnce();
    f.controller.abort();
    resolve(f.event);
    expect(await running).toBeNull();
    expect(await f.poll.poll()).toBeNull();
    expect(f.poll.status()).toMatchObject({ timeouts: 0, in_flight: false });
  });
});
