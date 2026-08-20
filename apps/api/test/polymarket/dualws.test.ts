import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDualMarketSocket,
  type DualMarketSocket,
} from "../../src/polymarket/dualws.js";
import {
  subscribeMessage,
  type MarketSocket,
} from "../../src/polymarket/recorder.js";

const frames = JSON.parse(
  readFileSync(
    new URL("./fixtures/dualws-frames.json", import.meta.url),
    "utf8",
  ),
) as { book: string; priceChange: string; tickSizeChange: string };

class FakeSocket implements MarketSocket {
  public readonly sent: string[] = [];
  public closedByClient = false;
  #openHandler: (() => void) | null = null;
  #messageHandler: ((raw: string) => void) | null = null;
  #closeHandler: (() => void) | null = null;

  public onOpen(handler: () => void): void {
    this.#openHandler = handler;
  }

  public onMessage(handler: (raw: string) => void): void {
    this.#messageHandler = handler;
  }

  public onClose(handler: () => void): void {
    this.#closeHandler = handler;
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.closedByClient = true;
    this.#closeHandler?.();
  }

  public emitOpen(): void {
    this.#openHandler?.();
  }

  public emitMessage(raw: string): void {
    this.#messageHandler?.(raw);
  }

  public emitClose(): void {
    this.#closeHandler?.();
  }
}

interface Harness {
  readonly sockets: FakeSocket[];
  readonly received: string[];
  readonly bothDown: number[];
  readonly dual: DualMarketSocket;
  now: number;
}

function makeHarness(options?: {
  tokenIds?: readonly string[];
  dedupeMaxEntries?: number;
  dedupeWindowMs?: number;
}): Harness {
  const sockets: FakeSocket[] = [];
  const received: string[] = [];
  const bothDown: number[] = [];
  const state = { now: 0 };
  const dual = createDualMarketSocket({
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    tokenIds: options?.tokenIds ?? ["token-a", "token-b"],
    onMessage: (raw) => {
      received.push(raw);
    },
    onBothDown: (info) => {
      bothDown.push(info.downSince);
    },
    clock: () => state.now,
    ...(options?.dedupeMaxEntries !== undefined
      ? { dedupeMaxEntries: options.dedupeMaxEntries }
      : {}),
    ...(options?.dedupeWindowMs !== undefined
      ? { dedupeWindowMs: options.dedupeWindowMs }
      : {}),
  });
  return {
    sockets,
    received,
    bothDown,
    dual,
    get now(): number {
      return state.now;
    },
    set now(value: number) {
      state.now = value;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dual market socket: subscription and heartbeat", () => {
  it("opens two connections and subscribes each on open", () => {
    const h = makeHarness();
    expect(h.sockets).toHaveLength(2);
    h.sockets[0]?.emitOpen();
    h.sockets[1]?.emitOpen();
    const expected = subscribeMessage(["token-a", "token-b"]);
    expect(h.sockets[0]?.sent[0]).toBe(expected);
    expect(h.sockets[1]?.sent[0]).toBe(expected);
    expect(h.dual.stats().openConnections).toBe(2);
    h.dual.close();
  });

  it("sends PING heartbeats every 10s and filters PONG replies", () => {
    const h = makeHarness();
    h.sockets[0]?.emitOpen();
    vi.advanceTimersByTime(10_000);
    expect(h.sockets[0]?.sent).toContain("PING");
    h.sockets[0]?.emitMessage("PONG");
    expect(h.received).toHaveLength(0);
    h.dual.close();
  });

  it("resubscribes live connections with the new universe", () => {
    const h = makeHarness();
    h.sockets[0]?.emitOpen();
    h.sockets[1]?.emitOpen();
    h.dual.resubscribe(["token-c"]);
    const expected = subscribeMessage(["token-c"]);
    expect(h.sockets[0]?.sent).toContain(expected);
    expect(h.sockets[1]?.sent).toContain(expected);
    h.dual.close();
  });
});

describe("dual market socket: content dedupe", () => {
  it("forwards the first copy and silently drops the twin's duplicate", () => {
    const h = makeHarness();
    h.sockets[0]?.emitOpen();
    h.sockets[1]?.emitOpen();

    h.sockets[0]?.emitMessage(frames.book);
    h.sockets[1]?.emitMessage(frames.book);
    expect(h.received).toEqual([frames.book]);
    expect(h.dual.stats().duplicatesDropped).toBe(1);

    // Distinct frames pass on either connection.
    h.sockets[1]?.emitMessage(frames.priceChange);
    h.sockets[0]?.emitMessage(frames.tickSizeChange);
    expect(h.received).toEqual([
      frames.book,
      frames.priceChange,
      frames.tickSizeChange,
    ]);
    h.dual.close();
  });

  it("does not create a gap when one connection misses a frame", () => {
    const h = makeHarness();
    h.sockets[0]?.emitOpen();
    h.sockets[1]?.emitOpen();

    // The frame is lost on connection 0 and only delivered on connection 1.
    h.sockets[1]?.emitMessage(frames.priceChange);
    expect(h.received).toEqual([frames.priceChange]);
    expect(h.bothDown).toHaveLength(0);
    expect(h.dual.stats().messagesForwarded).toBe(1);
    h.dual.close();
  });

  it("lets a frame through again after the dedupe window expires", () => {
    const h = makeHarness({ dedupeWindowMs: 100 });
    h.sockets[0]?.emitOpen();
    h.sockets[1]?.emitOpen();
    h.sockets[0]?.emitMessage(frames.book);
    h.now = 200;
    h.sockets[1]?.emitMessage(frames.book);
    expect(h.received).toEqual([frames.book, frames.book]);
    h.dual.close();
  });

  it("evicts the oldest digest when the LRU cap is exceeded", () => {
    const h = makeHarness({ dedupeMaxEntries: 1 });
    h.sockets[0]?.emitOpen();
    h.sockets[1]?.emitOpen();
    h.sockets[0]?.emitMessage(frames.book);
    h.sockets[0]?.emitMessage(frames.priceChange); // evicts the book digest
    h.sockets[1]?.emitMessage(frames.book); // no longer deduped
    expect(h.received).toEqual([frames.book, frames.priceChange, frames.book]);
    h.dual.close();
  });
});

describe("dual market socket: reconnection and gap signalling", () => {
  it("treats a single dropped connection as redundancy loss, not a gap", () => {
    const h = makeHarness();
    h.sockets[0]?.emitOpen();
    h.sockets[1]?.emitOpen();

    h.sockets[0]?.emitClose();
    expect(h.bothDown).toHaveLength(0);
    expect(h.dual.stats().singleConnectionDrops).toBe(1);
    expect(h.dual.stats().openConnections).toBe(1);

    // Reconnects after the base backoff and resubscribes.
    vi.advanceTimersByTime(1_000);
    expect(h.sockets).toHaveLength(3);
    h.sockets[2]?.emitOpen();
    expect(h.sockets[2]?.sent[0]).toBe(
      subscribeMessage(["token-a", "token-b"]),
    );
    expect(h.dual.stats().openConnections).toBe(2);
    h.dual.close();
  });

  it("fires onBothDown exactly once when both connections are down", () => {
    const h = makeHarness();
    h.sockets[0]?.emitOpen();
    h.sockets[1]?.emitOpen();

    h.now = 42_000;
    h.sockets[0]?.emitClose();
    h.sockets[1]?.emitClose();
    expect(h.bothDown).toEqual([42_000]);
    expect(h.dual.stats().bothDownEvents).toBe(1);
    h.dual.close();
  });

  it("backs off exponentially between reconnect attempts", () => {
    const h = makeHarness();
    h.sockets[0]?.emitOpen();
    h.sockets[1]?.emitOpen();

    h.sockets[0]?.emitClose();
    vi.advanceTimersByTime(1_000);
    expect(h.sockets).toHaveLength(3);

    // The replacement dies before opening: next attempt waits 2s, not 1s.
    h.sockets[2]?.emitClose();
    vi.advanceTimersByTime(1_999);
    expect(h.sockets).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(h.sockets).toHaveLength(4);

    // A successful open resets the backoff to the base delay.
    h.sockets[3]?.emitOpen();
    h.sockets[3]?.emitClose();
    vi.advanceTimersByTime(1_000);
    expect(h.sockets).toHaveLength(5);
    h.dual.close();
  });

  it("stops reconnecting after close()", () => {
    const h = makeHarness();
    h.sockets[0]?.emitOpen();
    h.sockets[1]?.emitOpen();
    h.dual.close();
    vi.advanceTimersByTime(120_000);
    expect(h.sockets).toHaveLength(2);
    expect(h.dual.stats().openConnections).toBe(0);
  });
});
