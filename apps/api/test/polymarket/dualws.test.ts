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
  public closeMode: "callback" | "silent" | "throw" = "callback";
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
    if (this.closeMode === "throw") {
      throw new Error("transport close failed");
    }
    if (this.closeMode === "callback") {
      this.#closeHandler?.();
    }
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
  readonly observations: { raw: string; firstCopy: boolean }[];
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
  const observations: { raw: string; firstCopy: boolean }[] = [];
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
    onObservation: (raw, firstCopy) => {
      observations.push({ raw, firstCopy });
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
    observations,
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

describe("OPS-02 — silent feed recovery", () => {
  it("observes duplicates on open sockets without forwarding or counting keepalives", () => {
    const h = makeHarness();
    h.sockets[0]?.emitMessage(frames.book); // Still connecting: not an observation.
    h.sockets[0]?.emitOpen();
    h.sockets[1]?.emitOpen();
    h.sockets[0]?.emitMessage("PING");
    h.sockets[1]?.emitMessage("PONG");
    h.sockets[0]?.emitMessage(frames.book);
    h.sockets[1]?.emitMessage(frames.book);
    expect(h.observations).toEqual([
      { raw: frames.book, firstCopy: true },
      { raw: frames.book, firstCopy: false },
    ]);
    expect(h.received).toEqual([frames.book]);
    expect(h.dual.stats().duplicatesDropped).toBe(1);
    h.dual.close();
    h.sockets[0]?.emitMessage(frames.priceChange);
    expect(h.observations).toHaveLength(2);
  });

  it("retires both silent sockets and reconnects once per slot after backoff", () => {
    const h = makeHarness();
    h.sockets[0]?.emitOpen();
    h.sockets[1]?.emitOpen();
    h.now = 42_000;

    h.dual.reconnectSilent();
    h.dual.reconnectSilent();

    expect(h.sockets.slice(0, 2).every((socket) => socket.closedByClient)).toBe(
      true,
    );
    expect(h.dual.stats().openConnections).toBe(0);
    expect(h.bothDown).toEqual([42_000]);
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(999);
    expect(h.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(h.sockets).toHaveLength(4);
    for (const socket of h.sockets.slice(2)) {
      socket.emitOpen();
      expect(socket.sent).toEqual([subscribeMessage(["token-a", "token-b"])]);
    }
    expect(h.dual.stats().reconnects).toEqual([1, 1]);
    expect(h.dual.stats().rollingResubscribes).toBe(0);
    h.dual.close();
  });

  it.each(["silent", "throw"] as const)(
    "recovers when close is %s and ignores every retired-socket callback",
    (closeMode) => {
      const h = makeHarness();
      const [first, second] = h.sockets as [FakeSocket, FakeSocket];
      first.emitOpen();
      second.emitOpen();
      first.closeMode = closeMode;
      second.closeMode = closeMode;

      expect(() => h.dual.reconnectSilent()).not.toThrow();
      first.emitMessage(frames.book);
      first.emitOpen();
      first.emitClose();
      expect(h.received).toEqual([]);
      expect(h.observations).toEqual([]);
      expect(vi.getTimerCount()).toBe(2);
      vi.advanceTimersByTime(1_000);
      const replacement = h.sockets[2] as FakeSocket;
      replacement.emitOpen();
      first.emitClose();
      first.emitMessage(frames.priceChange);
      first.emitOpen();
      replacement.emitMessage(frames.book);
      expect(h.received).toEqual([frames.book]);
      expect(h.observations).toEqual([{ raw: frames.book, firstCopy: true }]);
      expect(h.dual.stats().openConnections).toBe(1);
      expect(h.bothDown).toHaveLength(1);
      h.dual.close();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("preserves pending timers and increases backoff when handshakes stay silent", () => {
    const h = makeHarness();
    h.sockets[0]?.emitOpen();
    h.sockets[1]?.emitOpen();
    h.sockets[0]?.emitClose();
    vi.advanceTimersByTime(500);
    h.dual.reconnectSilent();
    vi.advanceTimersByTime(500);
    // Slot 0 keeps its original deadline; recovery never postpones it.
    expect(h.sockets).toHaveLength(3);
    vi.advanceTimersByTime(500);
    expect(h.sockets).toHaveLength(4);
    h.dual.reconnectSilent();
    h.dual.reconnectSilent();
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(1_999);
    expect(h.sockets).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(h.sockets).toHaveLength(6);
    expect(h.bothDown).toHaveLength(1);
    h.dual.close();
  });

  it("cancels recovery during shutdown and never creates another socket", () => {
    const h = makeHarness();
    h.sockets[0]?.emitOpen();
    h.sockets[1]?.emitOpen();
    h.dual.reconnectSilent();
    h.dual.close();
    h.dual.reconnectSilent();
    h.sockets[0]?.emitOpen();
    h.sockets[0]?.emitClose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(h.sockets).toHaveLength(2);
    expect(h.dual.stats().openConnections).toBe(0);
  });

  it("does not duplicate heartbeat timers if open is delivered twice", () => {
    const h = makeHarness();
    h.sockets[0]?.emitOpen();
    h.sockets[0]?.emitOpen();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(h.sockets[0]?.sent.filter((frame) => frame === "PING")).toHaveLength(
      1,
    );
    h.dual.close();
  });
});

// ---------------------------------------------------------------------------
// RFC-024 D3 — reconexão rolante em `resubscribe`
// ---------------------------------------------------------------------------

/**
 * The branch this file predicted in 2026-08: "If the venue ever requires a
 * fresh socket per subscription, close/reopen here instead". It does.
 *
 * Measured 2026-09-08 on the wire (`wire-probe-cli`, 02:42:28Z): an extra
 * `subscribe` frame on a LIVE connection with a token not in the first frame
 * gave `NEVER_ON_A` — no book in 120 s — while a connection opened at the
 * same instant with only that token got its book in **21 ms**. And in
 * production (02:51:45Z): all six tokens added by a `resubscribe` opened a
 * `subscribe_book_missing` gap, while 162 tokens subscribed on FRESH
 * connections at boot opened none.
 *
 * These tests pin the shape the RFC's P4 approved: rolling, one slot at a
 * time, only on entry, never `onBothDown`.
 */
describe("RFC-024 D3 — resubscribe reconecta um slot por vez", () => {
  /** Bring both slots up and clear their opening frames. */
  function bothUp(harness: Harness): [FakeSocket, FakeSocket] {
    const [first, second] = harness.sockets as [FakeSocket, FakeSocket];
    first.emitOpen();
    second.emitOpen();
    return [first, second];
  }

  it("token novo reconecta UM slot, e o gêmeo segue de pé", () => {
    const harness = makeHarness({ tokenIds: ["a", "b"] });
    const [first, second] = bothUp(harness);

    harness.dual.resubscribe(["a", "b", "novo"]);

    // Exactly one slot was closed by us.
    expect(first.closedByClient).toBe(true);
    expect(second.closedByClient).toBe(false);
    // And the twin never went down, so no gap was ever signalled.
    expect(harness.bothDown).toEqual([]);
    expect(harness.dual.stats().rollingResubscribes).toBe(1);
    expect(harness.dual.stats().openConnections).toBe(1);
  });

  it("o slot reconectado assina a lista NOVA no frame de abertura", () => {
    const harness = makeHarness({ tokenIds: ["a", "b"] });
    bothUp(harness);
    harness.dual.resubscribe(["a", "b", "novo"]);

    // The close triggers the backoff reconnect.
    vi.advanceTimersByTime(1_000);
    const replacement = harness.sockets[2] as FakeSocket;
    expect(replacement).toBeDefined();
    replacement.emitOpen();

    // The opening frame is what the venue honours, and it carries the new
    // token — which is the entire point of reconnecting instead of sending.
    expect(replacement.sent[0]).toBe(subscribeMessage(["a", "b", "novo"]));
    expect(harness.dual.stats().openConnections).toBe(2);
  });

  it("só saída (nenhum token novo) NÃO reconecta", () => {
    const harness = makeHarness({ tokenIds: ["a", "b", "c"] });
    const [first, second] = bothUp(harness);

    harness.dual.resubscribe(["a", "b"]);

    expect(first.closedByClient).toBe(false);
    expect(second.closedByClient).toBe(false);
    expect(harness.dual.stats().rollingResubscribes).toBe(0);
    expect(harness.dual.stats().resubscribesWithoutEntry).toBe(1);
    // The shrunken list still reaches the live sockets.
    expect(first.sent[1]).toBe(subscribeMessage(["a", "b"]));
  });

  it("lista idêntica não reconecta", () => {
    const harness = makeHarness({ tokenIds: ["a", "b"] });
    const [first] = bothUp(harness);
    harness.dual.resubscribe(["a", "b"]);
    expect(first.closedByClient).toBe(false);
    expect(harness.dual.stats().rollingResubscribes).toBe(0);
  });

  it("um segundo resubscribe com o rolo em voo NÃO derruba o gêmeo", () => {
    const harness = makeHarness({ tokenIds: ["a"] });
    const [first, second] = bothUp(harness);

    harness.dual.resubscribe(["a", "n1"]);
    expect(first.closedByClient).toBe(true);
    // The rolled slot has not come back yet, and another cycle brings a
    // second new token. Rolling again here would blind the recorder.
    harness.dual.resubscribe(["a", "n1", "n2"]);
    expect(second.closedByClient).toBe(false);
    expect(harness.dual.stats().rollingResubscribes).toBe(1);
    expect(harness.bothDown).toEqual([]);

    // When the first slot returns it subscribes with the list AS IT STANDS,
    // which already contains both new tokens — so the skipped roll cost
    // nothing.
    vi.advanceTimersByTime(1_000);
    const replacement = harness.sockets[2] as FakeSocket;
    replacement.emitOpen();
    expect(replacement.sent[0]).toBe(subscribeMessage(["a", "n1", "n2"]));
    // And the guard is released, so the next entry can roll again.
    harness.dual.resubscribe(["a", "n1", "n2", "n3"]);
    expect(harness.dual.stats().rollingResubscribes).toBe(2);
  });

  it("com só uma conexão de pé, NÃO reconecta — e diz por quê", () => {
    const harness = makeHarness({ tokenIds: ["a"] });
    const [first, second] = bothUp(harness);
    // One connection drops on its own; the twin is the only feed left.
    first.emitClose();
    expect(harness.dual.stats().openConnections).toBe(1);

    harness.dual.resubscribe(["a", "novo"]);

    // Rolling the survivor would blind the recorder. The tokens stay
    // bookless, and the `subscribe_book_missing` gap records exactly that —
    // which is strictly better than a feed outage.
    expect(second.closedByClient).toBe(false);
    expect(harness.bothDown).toEqual([]);
    expect(harness.dual.stats().openConnections).toBe(1);
  });

  it("slot em handshake NÃO é fechado: ele já vai assinar a lista nova", () => {
    const harness = makeHarness({ tokenIds: ["a"] });
    const [first, second] = bothUp(harness);
    // Slot 0 dropped and its reconnect already created a socket that has not
    // opened yet.
    first.emitClose();
    vi.advanceTimersByTime(1_000);
    const reconnecting = harness.sockets[2] as FakeSocket;
    expect(reconnecting).toBeDefined();

    harness.dual.resubscribe(["a", "novo"]);

    // Nothing is closed. The open twin is left alone, AND the connecting
    // socket is left alone: `connect`'s `onOpen` reads the CURRENT list, so it
    // subscribes with the new token by itself. Closing it would buy a wasted
    // handshake — and reporting "deferred" would tell the soak reader the
    // tokens are stuck when they are not.
    expect(second.closedByClient).toBe(false);
    expect(reconnecting.closedByClient).toBe(false);
    expect(harness.dual.stats().rollingResubscribes).toBe(1);

    reconnecting.emitOpen();
    expect(reconnecting.sent[0]).toBe(subscribeMessage(["a", "novo"]));
    expect(harness.dual.stats().openConnections).toBe(2);
  });

  it("slot esperando o backoff também não é rolado", () => {
    const harness = makeHarness({ tokenIds: ["a"] });
    const [first, second] = bothUp(harness);
    // Slot 0 is down with `socket === null`, waiting on its backoff timer.
    first.emitClose();

    harness.dual.resubscribe(["a", "novo"]);

    expect(second.closedByClient).toBe(false);
    expect(harness.dual.stats().rollingResubscribes).toBe(1);

    // Its reconnect carries the new list when it lands.
    vi.advanceTimersByTime(1_000);
    const replacement = harness.sockets[2] as FakeSocket;
    replacement.emitOpen();
    expect(replacement.sent[0]).toBe(subscribeMessage(["a", "novo"]));
  });

  it("o rolo NUNCA dispara onBothDown, nem com os dois slots ciclados em sequência", () => {
    const harness = makeHarness({ tokenIds: ["a"] });
    bothUp(harness);

    for (let round = 0; round < 5; round += 1) {
      harness.dual.resubscribe([
        "a",
        ...Array.from({ length: round + 1 }, (_, i) => `n${String(i)}`),
      ]);
      vi.advanceTimersByTime(1_000);
      const latest = harness.sockets[harness.sockets.length - 1] as FakeSocket;
      latest.emitOpen();
    }
    expect(harness.bothDown).toEqual([]);
    expect(harness.dual.stats().openConnections).toBe(2);
    expect(harness.dual.stats().rollingResubscribes).toBe(5);
  });

  it("o rolo zera o backoff: um close deliberado não herda castigo", () => {
    const harness = makeHarness({ tokenIds: ["a"] });
    const [first, second] = bothUp(harness);
    // Two failures push slot 0's backoff to 4 s.
    first.emitClose();
    vi.advanceTimersByTime(1_000);
    (harness.sockets[2] as FakeSocket).emitClose();
    vi.advanceTimersByTime(2_000);
    const third = harness.sockets[3] as FakeSocket;
    third.emitOpen();
    expect(harness.dual.stats().openConnections).toBe(2);

    harness.dual.resubscribe(["a", "novo"]);
    // A deliberate close must reconnect at the BASE delay, not at whatever
    // penalty an earlier outage left behind.
    vi.advanceTimersByTime(1_000);
    const afterRoll = harness.sockets[harness.sockets.length - 1] as FakeSocket;
    expect(afterRoll).toBeDefined();
    afterRoll.emitOpen();
    expect(afterRoll.sent[0]).toBe(subscribeMessage(["a", "novo"]));
    expect(second.closedByClient).toBe(false);
  });

  it("os frames seguem chegando pelo gêmeo durante o rolo", () => {
    const harness = makeHarness({ tokenIds: ["a"] });
    const [, second] = bothUp(harness);
    harness.dual.resubscribe(["a", "novo"]);
    // The rolled slot is down; the twin is still delivering, which is the
    // whole reason the reconnect is rolling and not simultaneous.
    second.emitMessage(frames.book);
    expect(harness.received).toContain(frames.book);
  });
});
