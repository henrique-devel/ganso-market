import { describe, expect, it, vi } from "vitest";

import {
  createClobSilenceMonitor,
  readClobRestBook,
  SILENCE_MAX_PENDING_GAPS,
  SILENCE_SHUTDOWN_GRACE_MS,
  streamSilenceMs,
  type ClobControlResult,
} from "../../src/polymarket/clobsilence.js";
import type { GapWriter } from "../../src/polymarket/quality.js";
import type { MarketMessage } from "../../src/polymarket/types.js";

const epoch = Date.parse("2026-09-10T12:00:00Z");
const book = (id = "a"): MarketMessage => ({
  event_type: "book",
  asset_id: id,
  market: "market",
  timestamp: String(epoch),
  hash: "book",
  bids: [{ price: "0.4", size: "5" }],
  asks: [],
});
const delta = (id: string, count = 1): MarketMessage => ({
  event_type: "price_change",
  market: "market",
  timestamp: String(epoch),
  price_changes: Array.from({ length: count }, () => ({
    asset_id: id,
    side: "BUY" as const,
    price: "0.4",
    size: "5",
  })),
});
type Saved = Parameters<GapWriter["saveSilenceGap"]>[0];

function harness(
  ids: string[] | null = ["a"],
  silenceMs = 120_000,
  prior: Saved[] = [],
) {
  let now = epoch;
  let connections = 2;
  const saved: Saved[] = [];
  const save = vi.fn(async (input: Saved): Promise<void> => {
    saved.push(structuredClone(input));
  });
  const control = vi.fn(async (): Promise<ClobControlResult> => ({
    status: "ok",
    fingerprint: "same",
  }));
  const resubscribe = vi.fn();
  const reconnect = vi.fn();
  const log = vi.fn();
  const load = vi.fn(async (): Promise<Saved[]> => structuredClone(prior));
  const monitor = createClobSilenceMonitor({
    gaps: { saveSilenceGap: save, loadOpenSilenceGaps: load },
    openConnections: () => connections,
    control,
    resubscribe,
    reconnect,
    log,
    clock: () => now,
    silenceMs,
  });
  if (ids !== null) monitor.setUniverse(ids);
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  const tick = async (elapsed: number): Promise<void> => {
    now = epoch + elapsed;
    await monitor.restore();
    monitor.tick();
    await drain();
  };
  return {
    monitor,
    saved,
    save,
    load,
    control,
    resubscribe,
    reconnect,
    log,
    tick,
    drain,
    time: (elapsed: number) => {
      now = epoch + elapsed;
    },
    connections: (count: number) => {
      connections = count;
    },
  };
}

describe("CLOB silence state machine", () => {
  it("waits for a successful universe after boot failure before closing an absent restored token", async () => {
    const h = harness(null, 120_000, [
      {
        episodeId: "prior-b",
        tokenId: "b",
        start: new Date(epoch - 120_000),
        end: null,
        details: { control: "blind" },
      },
    ]);
    await h.tick(0);
    expect(h.monitor.stats().openGaps).toBe(1);
    expect(h.saved.at(-1)?.end).toBeNull();
    await h.tick(120_000);
    expect(h.saved.every((row) => row.end === null)).toBe(true);
    h.time(121_000);
    h.monitor.setUniverse(["a"]);
    await h.tick(121_000);
    expect(h.saved.at(-1)).toMatchObject({
      episodeId: "prior-b",
      end: new Date(epoch + 121_000),
      details: { closed_by: "universe_exit", control: "blind" },
    });
    expect(h.monitor.stats()).toMatchObject({
      openGaps: 0,
      lastBookFrameMs: null,
    });
  });

  it("closes the original persisted episode after a recorder restart", async () => {
    const old = harness();
    old.monitor.observe(book(), true);
    await old.tick(120_000);
    await old.monitor.stop();
    const persisted = old.saved.at(-1)!;
    expect(persisted.end).toBeNull();
    const restarted = harness(["a"], 120_000, [persisted]);
    await restarted.tick(121_000);
    expect(restarted.monitor.stats().openGaps).toBe(1);
    restarted.time(122_000);
    restarted.monitor.observe(book(), true);
    await restarted.tick(122_000);
    expect(restarted.saved.at(-1)).toMatchObject({
      episodeId: persisted.episodeId,
      start: persisted.start,
      end: new Date(epoch + 122_000),
      details: { closed_by: "ws_book_frame" },
    });
    expect(restarted.monitor.stats().openGaps).toBe(0);
    expect(restarted.resubscribe).not.toHaveBeenCalled();
  });

  it("restores each token scope and keeps other silent tokens open", async () => {
    const prior: Saved[] = [undefined, "a", "b"].map((tokenId, index) => ({
      episodeId: `prior-${index}`,
      ...(tokenId === undefined ? {} : { tokenId }),
      start: new Date(epoch - 120_000),
      end: null,
      details: {
        control: "blind",
        attempts: [{ action: "resubscribe", at: epoch - 1_000 }],
      },
    }));
    const h = harness(["a", "b"], 120_000, prior);
    await h.tick(0);
    h.time(100);
    h.monitor.observe(book("a"), true);
    await h.tick(1_000);
    await h.tick(2_000);
    await h.tick(3_000);
    expect(
      h.saved
        .filter((row) => row.end !== null)
        .map((row) => row.episodeId)
        .sort(),
    ).toEqual(["prior-0", "prior-1"]);
    expect(h.monitor.stats().openGaps).toBe(1);
    expect(
      h.saved.findLast((row) => row.episodeId === "prior-2")?.end,
    ).toBeNull();
    h.monitor.setUniverse(["a"]);
    await h.tick(4_000);
    expect(h.saved.at(-1)).toMatchObject({
      episodeId: "prior-2",
      details: { closed_by: "universe_exit" },
    });
  });

  it("retries restore failure and uses the first valid frame received during the delayed read", async () => {
    const h = harness(["a"], 120_000, [
      {
        episodeId: "prior",
        tokenId: "a",
        start: new Date(epoch - 120_000),
        end: null,
        details: { control: "pending" },
      },
    ]);
    h.load.mockRejectedValueOnce(new Error("DB unavailable"));
    await h.tick(0);
    expect(h.monitor.stats()).toMatchObject({
      restorePending: true,
      restoreFailures: 1,
    });
    h.time(100);
    expect(h.monitor.observe(book("other"), true)).toBe(false);
    h.time(200);
    h.monitor.observe(book(), true);
    h.time(500);
    h.monitor.observe(book(), false);
    await h.tick(1_000);
    expect(h.saved.at(-1)).toMatchObject({
      episodeId: "prior",
      end: new Date(epoch + 200),
      details: { control: "unavailable", control_reason: "recorder_restart" },
    });
    expect(h.monitor.stats()).toMatchObject({
      restorePending: false,
      openGaps: 0,
    });
  });

  it("preserves an exhausted reconnect budget across restart", async () => {
    const attempts = ["resubscribe", "reconnect", "reconnect", "reconnect"].map(
      (action, index) => ({ action, at: epoch - 4_000 + index * 1_000 }),
    );
    const h = harness(["a"], 120_000, [
      {
        episodeId: "prior",
        start: new Date(epoch - 120_000),
        end: null,
        details: { control: "blind", attempts },
      },
    ]);
    await h.tick(0);
    await h.tick(3_600_000);
    expect(h.resubscribe).not.toHaveBeenCalled();
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.monitor.stats().openGaps).toBe(1);
    expect(h.saved.at(-1)?.details.attempts).toEqual(attempts);
  });

  it("cannot reset an old recovery budget by detecting silence before DB restore succeeds", async () => {
    const attempts = ["resubscribe", "reconnect", "reconnect", "reconnect"].map(
      (action, index) => ({ action, at: epoch - 4_000 + index * 1_000 }),
    );
    const h = harness(["a"], 120_000, [
      {
        episodeId: "prior",
        start: new Date(epoch - 120_000),
        end: null,
        details: { control: "blind", attempts },
      },
    ]);
    h.load.mockRejectedValueOnce(new Error("DB unavailable"));
    await h.tick(120_000);
    expect(h.monitor.stats().openGaps).toBe(1);
    await h.tick(121_000);
    await h.tick(3_600_000);
    expect(h.resubscribe).not.toHaveBeenCalled();
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.monitor.stats().openGaps).toBe(2);
  });

  it("bounds restoration and ignores a query completed after shutdown", async () => {
    const prior = Array.from(
      { length: SILENCE_MAX_PENDING_GAPS + 1 },
      (_, index): Saved => ({
        episodeId: `prior-${index}`,
        start: new Date(epoch - 120_000),
        end: null,
        details: { control: "blind" },
      }),
    );
    const h = harness(["a"], 120_000, prior);
    await h.tick(0);
    expect(h.load).toHaveBeenCalledWith(
      new Date(epoch),
      SILENCE_MAX_PENDING_GAPS + 1,
    );
    expect(h.monitor.stats()).toMatchObject({
      openGaps: SILENCE_MAX_PENDING_GAPS,
      restoreOverflow: 1,
    });
    expect(h.log).toHaveBeenCalledWith("error", "WS_SILENCE_RESTORE_OVERFLOW", {
      omitted_at_least: 1,
    });
    h.time(1_000);
    h.monitor.observe(book(), true);
    await h.monitor.stop();
    const closed = new Set(
      h.saved.filter((row) => row.end !== null).map((row) => row.episodeId),
    );
    expect(closed.size).toBe(SILENCE_MAX_PENDING_GAPS);
    expect(closed.has(`prior-${SILENCE_MAX_PENDING_GAPS}`)).toBe(false);
    const stopped = harness();
    let complete!: (rows: Saved[]) => void;
    stopped.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const reading = stopped.monitor.restore();
    await stopped.monitor.stop();
    complete(prior);
    await reading;
    expect(stopped.monitor.stats().openGaps).toBe(0);
    expect(stopped.save).not.toHaveBeenCalled();
  });

  it("closes a restored token absent from the authoritative universe without inventing a WS recovery", async () => {
    const h = harness(["a"], 120_000, [
      {
        episodeId: "departed",
        tokenId: "b",
        start: new Date(epoch - 120_000),
        end: null,
        details: { control: "blind" },
      },
    ]);
    await h.tick(0);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({
      episodeId: "departed",
      end: new Date(epoch),
      details: { closed_by: "universe_exit", control: "blind" },
    });
    expect(h.monitor.stats().lastBookFrameMs).toBeNull();
  });
  it("uses 120s by default, validates the override, and never drops below 30s", () => {
    expect(streamSilenceMs()).toBe(120_000);
    expect(streamSilenceMs("invalid")).toBe(120_000);
    expect(streamSilenceMs("-100")).toBe(120_000);
    expect(streamSilenceMs("1")).toBe(30_000);
    expect(streamSilenceMs("240000")).toBe(240_000);
  });

  it("records one global episode from the last valid frame and closes once", async () => {
    const h = harness();
    h.monitor.observe(book(), true);
    await h.tick(119_999);
    expect(h.saved).toHaveLength(0);
    await h.tick(120_000);
    expect(h.saved[0]?.start).toEqual(new Date(epoch));
    expect(h.saved[0]?.tokenId).toBeUndefined();
    expect(h.resubscribe).toHaveBeenCalledTimes(1);
    // No deltas still obtains a real REST control through a deterministic tie.
    expect(h.control).toHaveBeenCalledTimes(1);
    h.time(121_000);
    h.monitor.observe(book(), true);
    h.monitor.observe(book(), false);
    await h.tick(121_000);
    await h.tick(122_000);
    expect(h.saved.filter((row) => row.end !== null)).toHaveLength(1);
    expect(new Set(h.saved.map((row) => row.episodeId)).size).toBe(1);
    expect(h.saved.at(-1)?.end).toEqual(new Date(epoch + 121_000));
  });

  it("requires an open connection and nonempty universe, preserving both-down", async () => {
    const h = harness([]);
    await h.tick(600_000);
    h.monitor.setUniverse(["a"]);
    h.connections(0);
    await h.tick(800_000);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.resubscribe).not.toHaveBeenCalled();
  });

  it("only monitors the top five active tokens, excluding book-only and rank six", async () => {
    const ids = ["a", "b", "c", "d", "e", "sixth", "illiquid"];
    const h = harness(ids);
    for (const [index, id] of ids.entries()) {
      h.monitor.observe(book(id), true);
      if (id !== "illiquid") h.monitor.observe(delta(id, 10 - index), true);
    }
    // Rank a must stay fixed while other tokens produce live frames.
    h.time(120_000);
    for (const id of ["b", "c", "d", "e"]) h.monitor.observe(book(id), true);
    await h.tick(120_000);
    expect(h.saved[0]?.tokenId).toBe("a");
    expect(h.saved[0]?.details.reference_token).toBe("a");
    expect(h.saved[0]?.details.active_tokens).toHaveLength(5);
    expect(h.monitor.stats().openGaps).toBe(1);
    expect(h.resubscribe).toHaveBeenCalledTimes(1);
    await h.tick(121_000);
    expect(
      h.saved.every(
        (item) => item.tokenId !== "sixth" && item.tokenId !== "illiquid",
      ),
    ).toBe(true);
  });

  it("does not inflate activity with duplicate deltas or turn old illiquid tokens into top five", async () => {
    const h = harness(["a", "b", "c", "d", "e", "sixth"]);
    for (const id of ["a", "b", "c", "d", "e"])
      h.monitor.observe(delta(id, 5), true);
    h.monitor.observe(delta("sixth"), true);
    h.monitor.observe(delta("sixth", 100), false);
    h.time(120_000);
    for (const id of ["a", "b", "c", "d", "e"])
      h.monitor.observe(book(id), true);
    await h.tick(120_000);
    expect(h.monitor.stats().openGaps).toBe(0);
    h.time(2_000_000);
    h.monitor.observe(delta("a", 20), true); // evict peers' old history
    await h.tick(2_000_000);
    expect(h.saved.some((item) => item.tokenId === "sixth")).toBe(false);
  });

  it("freezes the global top-five selection across a long outage and partial recovery", async () => {
    const h = harness(["a", "b", "c"]);
    h.monitor.observe(delta("a", 10), true);
    h.monitor.observe(delta("b", 5), true);
    h.monitor.observe(book("c"), true);
    await h.tick(120_000);
    h.time(2_000_000);
    h.monitor.observe(delta("a", 100), true);
    await h.tick(2_000_000);
    await h.tick(2_001_000);
    expect(h.saved.some((item) => item.tokenId === "b")).toBe(true);
    expect(h.saved.some((item) => item.tokenId === "c")).toBe(false);
  });

  it("allows a delayed detector tick without losing the pre-silence activity window", async () => {
    const h = harness(["a", "b"]);
    h.monitor.observe(delta("a", 10), true);
    h.monitor.observe(delta("b", 5), true);
    h.time(135_000);
    h.monitor.observe(delta("b", 20), true);
    await h.tick(135_000);
    expect(h.saved[0]?.tokenId).toBe("a");
    expect(h.saved[0]?.details.active_tokens).toEqual([
      { token: "a", deltas: 10 },
      { token: "b", deltas: 5 },
    ]);
  });

  it("retains bounded historical counters for overrides larger than 15 minutes", async () => {
    const h = harness(["a", "b"], 3_600_000);
    h.monitor.observe(delta("a", 10), true);
    h.monitor.observe(delta("b", 5), true);
    h.time(3_600_000);
    h.monitor.observe(delta("b", 100), true);
    await h.tick(3_600_000);
    expect(h.saved[0]?.tokenId).toBe("a");
    expect(h.saved[0]?.details.active_tokens).toEqual([
      { token: "a", deltas: 10 },
      { token: "b", deltas: 5 },
    ]);
    expect(h.saved[0]?.details.activity_bucket_ms).toBe(3_000);
  });

  it("closes exited subscriptions with their own reason, without asserting recovery", async () => {
    const h = harness(["a", "b"]);
    h.monitor.observe(delta("a", 10), true);
    h.monitor.observe(delta("b", 5), true);
    h.time(120_000);
    h.monitor.observe(book("b"), true);
    await h.tick(120_000);
    h.monitor.setUniverse(["b"]);
    await h.monitor.stop();
    expect(h.saved.at(-1)?.details.closed_by).toBe("universe_exit");
    expect(h.saved.at(-1)?.end).toEqual(new Date(epoch + 120_000));
  });

  it("reconnects at 2N, then backs off and stops after three silent reconnects", async () => {
    const h = harness();
    h.monitor.observe(book(), true);
    await h.tick(120_000);
    await h.tick(239_999);
    expect(h.reconnect).not.toHaveBeenCalled();
    await h.tick(240_000);
    await h.tick(479_999);
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    await h.tick(480_000);
    await h.tick(960_000);
    await h.tick(3_600_000);
    expect(h.reconnect).toHaveBeenCalledTimes(3);
    expect(h.saved.at(-1)?.details.recovery_exhausted).toBe(true);
    expect(h.saved.at(-1)?.details.attempts).toHaveLength(4);
    expect(h.monitor.stats().openGaps).toBe(1);
  });

  it("defers throttled REST and requires two independent actual observations", async () => {
    const h = harness();
    h.control
      .mockResolvedValueOnce({
        status: "throttled",
        retryAtMs: epoch + 140_000,
      })
      .mockResolvedValueOnce({ status: "ok", fingerprint: "first" })
      .mockResolvedValueOnce({ status: "ok", fingerprint: "second" });
    h.monitor.observe(delta("a"), true);
    await h.tick(120_000);
    await h.tick(139_999);
    expect(h.control).toHaveBeenCalledTimes(1);
    await h.tick(140_000);
    await h.tick(169_999);
    expect(h.control).toHaveBeenCalledTimes(2);
    await h.tick(170_000);
    await h.tick(171_000);
    expect(h.saved.at(-1)?.details.control).toBe("blind");
    const samples = h.saved.at(-1)?.details.control_samples as {
      requestedAt: number;
    }[];
    expect(samples[1]!.requestedAt - samples[0]!.requestedAt).toBe(30_000);
  });

  it("preserves an early recovery while the opening write is still pending", async () => {
    const h = harness();
    let resolve!: () => void;
    h.save.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    h.monitor.observe(book(), true);
    await h.tick(120_000);
    h.time(120_100);
    h.monitor.observe(book(), true);
    await h.tick(121_000);
    expect(h.save).toHaveBeenCalledTimes(1);
    resolve();
    await h.drain();
    await h.tick(122_000);
    expect(h.save).toHaveBeenCalledTimes(2);
    expect(h.saved.at(-1)?.end).toEqual(new Date(epoch + 120_100));
    expect(h.save.mock.calls[0]?.[0].episodeId).toBe(h.saved.at(-1)?.episodeId);
  });

  it("probes DB recovery after eight failures without waiting for the WS to recover", async () => {
    const h = harness();
    h.save.mockRejectedValue(new Error("DB down"));
    h.monitor.observe(book(), true);
    for (const at of [
      120_000, 121_000, 123_000, 127_000, 135_000, 151_000, 183_000, 243_000,
    ])
      await h.tick(at);
    expect(h.save).toHaveBeenCalledTimes(8);
    await h.tick(542_999);
    expect(h.save).toHaveBeenCalledTimes(8);
    h.save.mockImplementation(async (input) => {
      h.saved.push(structuredClone(input));
    });
    await h.tick(543_000);
    expect(h.save).toHaveBeenCalledTimes(9);
    expect(h.saved[0]?.start).toEqual(new Date(epoch));
    expect(h.saved[0]?.end).toBeNull();
    expect(new Set(h.save.mock.calls.map(([row]) => row.episodeId)).size).toBe(
      1,
    );
  });

  it("caps the persistence journal under a stuck DB and cancels work at shutdown", async () => {
    const h = harness();
    h.save.mockImplementation(() => new Promise<void>(() => {}));
    for (let i = 0; i < SILENCE_MAX_PENDING_GAPS + 10; i++) {
      h.time(i * 121_000);
      h.monitor.observe(book(), true);
      await h.tick(i * 121_000 + 120_000);
    }
    expect(h.monitor.stats().pendingWrites).toBe(SILENCE_MAX_PENDING_GAPS);
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(
      h.log.mock.calls.some((call) => call[1] === "WS_SILENCE_JOURNAL_FULL"),
    ).toBe(true);
    vi.useFakeTimers();
    const stopping = h.monitor.stop();
    const calls = h.control.mock.calls.length;
    await h.tick(20_000_000);
    expect(h.control).toHaveBeenCalledTimes(calls);
    expect(h.save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SILENCE_SHUTDOWN_GRACE_MS);
    await stopping;
    expect(
      h.log.mock.calls.some(
        (call) => call[1] === "WS_SILENCE_SHUTDOWN_UNFLUSHED",
      ),
    ).toBe(true);
    vi.useRealTimers();
  });

  it("retains an unsaved close after the quick retry budget is exhausted", async () => {
    const h = harness();
    h.save.mockRejectedValue(new Error("DB down"));
    h.monitor.observe(book(), true);
    await h.tick(120_000);
    h.time(120_010);
    h.monitor.observe(book(), true);
    h.monitor.setUniverse([]);
    for (const at of [
      121_000, 122_000, 124_000, 128_000, 136_000, 152_000, 184_000, 244_000,
    ])
      await h.tick(at);
    expect(h.monitor.stats().pendingWrites).toBe(1);
    const attempts = h.save.mock.calls.length;
    await h.tick(543_999);
    expect(h.save).toHaveBeenCalledTimes(attempts);
    h.save.mockImplementation(async (input) => {
      h.saved.push(structuredClone(input));
    });
    await h.tick(544_000);
    expect(h.saved[0]?.end).toEqual(new Date(epoch + 120_010));
    expect(h.monitor.stats().pendingWrites).toBe(0);
  });

  it("flushes a received recovery on shutdown before the next journal tick", async () => {
    const h = harness();
    h.monitor.observe(book(), true);
    await h.tick(120_000);
    h.time(120_050);
    h.monitor.observe(book(), true);
    await h.monitor.stop();
    expect(h.saved.at(-1)?.end).toEqual(new Date(epoch + 120_050));
    expect(h.saved.filter((entry) => entry.end !== null)).toHaveLength(1);
  });

  it("drains the final close after an opening INSERT pending during shutdown", async () => {
    const h = harness();
    let resolve!: () => void;
    h.save.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    h.monitor.observe(book(), true);
    await h.tick(120_000);
    h.time(120_050);
    h.monitor.observe(book(), true);
    const stopping = h.monitor.stop();
    expect(h.save).toHaveBeenCalledTimes(1);
    resolve();
    await stopping;
    expect(h.saved.at(-1)?.end).toEqual(new Date(epoch + 120_050));
    expect(h.saved.filter((entry) => entry.end !== null)).toHaveLength(1);
  });
});

describe("CLOB REST book comparison", () => {
  it("normalizes full-depth order, decimal scales and envelope changes", () => {
    const first = readClobRestBook(
      {
        asset_id: "a",
        hash: "one",
        timestamp: "1",
        bids: [
          { price: "0.40", size: "05.00" },
          { price: "0.2", size: "3" },
        ],
        asks: [],
      },
      "a",
    );
    const same = readClobRestBook(
      {
        asset_id: "a",
        hash: "two",
        timestamp: "2",
        bids: [
          { price: "0.20", size: "3.00" },
          { price: "0.4", size: "5" },
        ],
        asks: [],
      },
      "a",
    );
    expect(first).not.toBeNull();
    expect(first?.fingerprint).toBe(same?.fingerprint);
  });
  it("rejects ambiguous, malformed, negative and out-of-contract books", () => {
    for (const body of [
      null,
      {},
      { asset_id: "other", bids: [], asks: [] },
      { asset_id: "a", bids: [{ price: "1.1", size: "3" }], asks: [] },
      { asset_id: "a", bids: [{ price: "0.5", size: "-1" }], asks: [] },
      {
        asset_id: "a",
        bids: [
          { price: "0.5", size: "1" },
          { price: "0.50", size: "2" },
        ],
        asks: [],
      },
    ])
      expect(readClobRestBook(body, "a")).toBeNull();
  });
});
