import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TradingInstrumentMetadata } from "@ganso-market/contracts/trading";
import { RECOVERY_LIMITS } from "../../src/venues/hyperliquid/recovery.js";
import {
  HYPERLIQUID_FEED_LIMITS as limits,
  normalizeHyperliquidFeed,
} from "../../src/venues/hyperliquid/feed-normalizer.js";
const mocks = vi.hoisted(() => ({ sockets: [] as MockSocket[] }));
class MockSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 0;
  bufferedAmount = 0;
  sent: unknown[] = [];
  constructor(
    readonly url: string,
    readonly options: Record<string, unknown>,
  ) {
    super();
    mocks.sockets.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  terminate() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  frame(value: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(value)), false);
  }
  ack() {
    for (const type of ["l2Book", "trades", "activeAssetCtx"])
      this.frame({
        channel: "subscriptionResponse",
        data: { method: "subscribe", subscription: { type, coin: "BTC" } },
      });
  }
}
vi.mock("ws", () => ({ default: MockSocket }));
const { startHyperliquidBtcFeed } =
  await import("../../src/venues/hyperliquid/feed.js");
const at = "2026-09-23T09:00:00.000Z";
const time = Date.parse(at);
const metadata = {
  instrument: {
    instrument_id: "hyperliquid:mainnet:BTC",
    venue_symbol: "BTC",
    instrument_version: "v1",
  },
} as TradingInstrumentMetadata;
const book = () => ({
  coin: "BTC",
  time: Date.now(),
  levels: [
    [{ px: "64000", sz: "0.1", n: 1 }],
    [{ px: "64001", sz: "0.2", n: 2 }],
  ],
});
const ctx = {
  coin: "BTC",
  ctx: { markPx: "64000.1", oraclePx: "63999.2", funding: "-0.00000123456789" },
};
const trade = () => ({
  coin: "BTC",
  time,
  tid: 100,
  side: "B",
  px: "64000",
  sz: "0.01",
});
const parse = (channel: "book" | "trades" | "context", data: unknown) =>
  normalizeHyperliquidFeed(channel, data, at, "v1", "session:1");
let feeds: ReturnType<typeof startHyperliquidBtcFeed>[];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(time);
  vi.spyOn(Math, "random").mockReturnValue(1);
  mocks.sockets.length = 0;
  feeds = [];
});
afterEach(() => {
  for (const feed of feeds) feed.stop();
  vi.useRealTimers();
});
function startFeed() {
  const feed = startHyperliquidBtcFeed(metadata);
  feeds.push(feed);
  return feed;
}
function current() {
  return mocks.sockets.at(-1)!;
}
function snapshots() {
  current().frame({ channel: "l2Book", data: book() });
  current().frame({ channel: "activeAssetCtx", data: ctx });
}

describe("Hyperliquid feed parsing", () => {
  it("invalidates only HTTP context, keeps its gap through silence and revalidates with a new snapshot", () => {
    const feed = startHyperliquidBtcFeed(metadata, "http_snapshot");
    feeds.push(feed);
    current().open();
    current().frame({
      channel: "subscriptionResponse",
      data: {
        method: "subscribe",
        subscription: { type: "trades", coin: "BTC" },
      },
    });
    const observe = (channel: "book" | "context", id: string) => {
      const event = {
        ...normalizeHyperliquidFeed(
          channel,
          channel === "book" ? book() : ctx,
          new Date(Date.now()).toISOString(),
          "v1",
          id,
        )[0]!,
        source_id: "hyperliquid:mainnet:info" as const,
      };
      feed.observeSnapshot(event);
      return event;
    };
    const previous = observe("context", "first");
    observe("book", "initial-book");
    feed.drain();
    feed.contextUnavailable();
    const epoch = feed.status().channels.context.gap_epoch;
    expect(feed.status().channels.context).toMatchObject({
      status: "invalid",
      needs_revalidation: true,
    });
    expect(feed.status().channels.book.status).toBe("healthy");
    feed.observeSnapshot(previous); // Identical old evidence cannot close the gap.
    expect(feed.drain()).toEqual([]);
    for (let i = 0; i < 17; i++) {
      current().frame({ channel: "pong" });
      observe("book", `book-${i}`);
      feed.drain();
      vi.advanceTimersByTime(1000);
    }
    expect(feed.status()).toMatchObject({
      retries: 0,
      socket: { connected: true },
      channels: {
        context: {
          status: "stale",
          needs_revalidation: true,
          gap_epoch: epoch,
        },
      },
    });
    observe("context", "recovered");
    expect(feed.drain()).toMatchObject([
      {
        channel: "context",
        source_timestamp: null,
        quality: "unknown",
        gap_epoch: epoch,
        revalidation: "current_state_only",
        continuity: "unproven",
      },
    ]);
    expect(feed.status().gaps.find((g) => g.epoch === epoch)).toMatchObject({
      reason: "invalid",
      resumed_at: Date.now(),
      recovery: "current_state_only",
    });
    feed.stop();
    observe("context", "late-after-stop");
    expect(feed.drain()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves fixed-point amounts, timestamps, current funding precision and unknown source time", () => {
    expect(parse("book", book())[0]).toMatchObject({
      source_timestamp: at,
      received_at: at,
      payload: {
        semantics: "full_snapshot_top_20",
        bids: [
          { price: { raw: "64000000000" }, quantity: { raw: "10000000" } },
        ],
      },
    });
    expect(parse("context", ctx)[0]).toMatchObject({
      source_timestamp: null,
      key: "observation:session:1",
      payload: {
        funding_rate: { raw: "-123456789", decimals: 14 },
        settlement_timestamp: null,
        funding_semantics: "current_context_not_settled_payment",
      },
    });
    expect(parse("trades", [trade()])[0]!.key).toBe(`${time}:BTC:100`);
  });
  it.each([
    ["book", { ...book(), coin: "ETH" }],
    ["book", { ...book(), time: -1 }],
    [
      "book",
      {
        ...book(),
        levels: [
          [{ px: "64002", sz: "1", n: 1 }],
          [{ px: "64001", sz: "1", n: 1 }],
        ],
      },
    ],
    [
      "book",
      { ...book(), levels: [[{ px: "64000.0000001", sz: "1", n: 1 }], []] },
    ],
    [
      "book",
      {
        ...book(),
        levels: [Array(21).fill({ px: "64000", sz: "1", n: 1 }), []],
      },
    ],
    ["book", { ...book(), levels: [[{ px: "64000", sz: "0", n: 1 }], []] }],
    ["trades", [{ ...trade(), side: "X" }]],
    ["trades", [{ ...trade(), tid: 1.1 }]],
    ["trades", [{ ...trade(), sz: "0.000000001" }]],
    ["trades", Array(513).fill(trade())],
    [
      "context",
      { ...ctx, ctx: { ...ctx.ctx, funding: "0.1234567890123456789" } },
    ],
    ["context", { ...ctx, ctx: { ...ctx.ctx, funding: null } }],
    ["context", { ...ctx, ctx: { ...ctx.ctx, markPx: 64000 } }],
  ] as const)("rejects incompatible/bounded %s data", (channel, data) => {
    expect(() => parse(channel, data)).toThrow();
  });
  it("accepts empty books and batches without inventing trading", () => {
    expect(parse("book", { ...book(), levels: [[], []] })).toHaveLength(1);
    expect(parse("trades", [])).toEqual([]);
  });
});

describe("bounded opt-in public transport", () => {
  it("is inert on import and sends exactly the three public BTC subscriptions", () => {
    expect(mocks.sockets).toHaveLength(0);
    const feed = startFeed();
    current().open();
    current().ack();
    snapshots();
    expect(current().url).toBe("wss://api.hyperliquid.xyz/ws");
    expect(current().options).toMatchObject({
      maxPayload: limits.maxPayloadBytes,
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: limits.handshakeMs,
    });
    expect(current().sent).toEqual(
      ["l2Book", "trades", "activeAssetCtx"].map((type) => ({
        method: "subscribe",
        subscription: { type, coin: "BTC" },
      })),
    );
    expect(feed.status().subscriptions_confirmed).toBe(3);
    expect(feed.drain()).toMatchObject([
      { quality: "fresh" },
      { quality: "unknown" },
    ]);
    feed.stop();
    feed.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("marks a live socket with pongs and no data as unhealthy and revalidates on recovery", () => {
    const feed = startFeed();
    current().open();
    current().ack();
    snapshots();
    feed.drain();
    vi.advanceTimersByTime(5000);
    current().frame({ channel: "pong" });
    expect(feed.status().socket.alive).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(feed.status().channels.book.needs_revalidation).toBe(true);
    vi.advanceTimersByTime(1000);
    current().open();
    current().ack();
    expect(feed.status().channels.book.status).toBe("awaiting");
    snapshots();
    expect(feed.drain()[0]!.revalidation).toBe("current_state_only");
    expect(feed.status().gaps.some((g) => g.reason === "silence")).toBe(true);
  });
  it("does not refresh the trade channel for empty arrays or infer trading from snapshots", () => {
    const feed = startFeed();
    current().open();
    current().ack();
    snapshots();
    current().frame({ channel: "trades", data: [] });
    expect(feed.status().channels.trades.status).toBe("awaiting");
    expect(feed.status().instrument.activity).toBe("unknown");
  });
  it("bounds operator and transport reconnects and cleans up every timer", () => {
    const feed = startFeed();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000]) {
      current().open();
      current().ack();
      feed.reconnect();
      vi.advanceTimersByTime(delay);
    }
    current().open();
    current().terminate();
    expect(mocks.sockets).toHaveLength(7);
    expect(feed.status()).toMatchObject({
      retries: 6,
      stopped: true,
      terminal_reason: "retries_exhausted",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("makes invalid identity terminal and ignores late events without a retry", () => {
    const feed = startFeed();
    current().open();
    current().ack();
    snapshots();
    feed.drain();
    const old = current();
    old.frame({ channel: "l2Book", data: { ...book(), coin: "ETH" } });
    expect(feed.status().counters.invalid).toBe(1);
    vi.advanceTimersByTime(1000);
    old.frame({ channel: "l2Book", data: book() });
    expect(feed.drain()).toHaveLength(0);
    expect(feed.status()).toMatchObject({
      stopped: true,
      terminal_reason: "invalid_frame",
      retries: 0,
    });
    expect(mocks.sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("recovers twelve spaced disconnects, retaining gaps and revalidating each channel separately", () => {
    const feed = startFeed();
    current().open();
    current().ack();
    snapshots();
    feed.drain();
    for (let i = 0; i < 12; i++) {
      vi.setSystemTime(Date.now() + RECOVERY_LIMITS.windowMs);
      const old = current();
      feed.reconnect();
      old.frame({ channel: "l2Book", data: book() });
      expect(feed.drain()).toEqual([]);
      vi.advanceTimersByTime(30_000);
      current().open();
      current().ack();
      current().frame({ channel: "l2Book", data: book() });
      expect(feed.status().channels.context.needs_revalidation).toBe(true);
      expect(feed.status().channels.trades.needs_revalidation).toBe(true);
      expect(feed.status().recovery.consecutive_failures).toBeGreaterThan(0);
      current().frame({ channel: "activeAssetCtx", data: ctx });
      current().frame({
        channel: "trades",
        data: [{ ...trade(), time: Date.now(), tid: i }],
      });
      expect(feed.status().recovery.consecutive_failures).toBe(0);
      expect(feed.drain().map((e) => e.revalidation)).toEqual([
        "current_state_only",
        "current_state_only",
        "delivery_resumed_only",
      ]);
    }
    expect(feed.status()).toMatchObject({
      retries: 12,
      stopped: false,
      continuity: "unproven",
    });
    expect(feed.status().counters.gaps).toBeGreaterThan(12);
  });
  it("stops on contradictory duplicate evidence and inbound queue overflow", () => {
    const feed = startFeed();
    current().open();
    current().ack();
    current().frame({ channel: "trades", data: [trade()] });
    current().frame({ channel: "trades", data: [{ ...trade(), sz: "0.02" }] });
    expect(feed.status().terminal_reason).toBe("inconsistent_evidence");
    const overflow = startFeed();
    current().open();
    current().ack();
    current().frame({
      channel: "trades",
      data: Array.from({ length: 512 }, (_, tid) => ({ ...trade(), tid })),
    });
    current().frame({ channel: "trades", data: [{ ...trade(), tid: 1000 }] });
    expect(overflow.status()).toMatchObject({
      stopped: true,
      terminal_reason: "buffer_overflow",
      retries: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([1002, 1008, 1009])(
    "does not reconnect protocol/policy close %s",
    (code) => {
      const feed = startFeed();
      current().open();
      current().emit("close", code);
      expect(feed.status()).toMatchObject({ stopped: true, retries: 0 });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("respects handshake Retry-After and rejects invalid upgrade/TLS instead of looping", () => {
    const feed = startFeed();
    current().emit(
      "unexpected-response",
      { destroy: vi.fn() },
      { statusCode: 429, headers: { "retry-after": "90" }, destroy: vi.fn() },
    );
    vi.advanceTimersByTime(89_999);
    expect(mocks.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(mocks.sockets).toHaveLength(2);
    current().emit("error", new Error("Invalid Sec-WebSocket-Accept header"));
    expect(feed.status()).toMatchObject({
      stopped: true,
      terminal_reason: "transport_protocol_or_identity",
    });
    const tls = startFeed();
    current().emit(
      "error",
      Object.assign(new Error("private"), {
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
      }),
    );
    expect(tls.status()).toMatchObject({ stopped: true, retries: 0 });
  });
  it("stop cancels a pending reconnect and old callbacks cannot revive it", () => {
    const feed = startFeed();
    const old = current();
    old.open();
    feed.reconnect();
    feed.stop();
    vi.advanceTimersByTime(300_000);
    old.open();
    old.frame({ channel: "l2Book", data: book() });
    expect(mocks.sockets).toHaveLength(1);
    expect(feed.drain()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not recycle the trade socket for an unavailable HTTP book", () => {
    const feed = startHyperliquidBtcFeed(metadata, "http_snapshot");
    feeds.push(feed);
    current().open();
    current().frame({
      channel: "subscriptionResponse",
      data: {
        method: "subscribe",
        subscription: { type: "trades", coin: "BTC" },
      },
    });
    feed.contextUnavailable("book");
    for (let i = 0; i < 20; i++) {
      current().frame({ channel: "pong" });
      vi.advanceTimersByTime(1000);
    }
    expect(feed.status()).toMatchObject({
      retries: 0,
      socket: { connected: true },
      channels: { book: { needs_revalidation: true } },
    });
  });
  it("times out missing acknowledgements even with incoming channel data", () => {
    const feed = startFeed();
    current().open();
    snapshots();
    vi.advanceTimersByTime(8000);
    expect(feed.status().socket.connected).toBe(false);
  });
  it("times out missing pongs even when snapshots keep arriving", () => {
    const feed = startFeed();
    current().open();
    current().ack();
    snapshots();
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(5000);
      snapshots();
      feed.drain();
    }
    expect(feed.status().socket.connected).toBe(false);
  });
  it("does not keep an outbound buffer or a pending retry alive after stop", () => {
    const feed = startFeed();
    current().open();
    current().ack();
    snapshots();
    current().bufferedAmount = limits.outboundBytes + 1;
    vi.advanceTimersByTime(5000);
    expect(feed.status().socket.connected).toBe(false);
    feed.stop();
    vi.advanceTimersByTime(60_000);
    expect(mocks.sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects oversized payloads before normalizing (ws also caps wire allocation)", () => {
    const feed = startFeed();
    current().open();
    current().frame({
      channel: "l2Book",
      padding: "x".repeat(limits.maxPayloadBytes),
    });
    expect(feed.status().counters.invalid).toBe(3);
    expect(feed.status().socket.connected).toBe(false);
  });
});
