import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TradingInstrumentMetadata } from "@ganso-market/contracts/trading";
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
  it("bounds retries across successful reconnects and cleans up every timer", () => {
    const feed = startFeed();
    for (const delay of [1000, 2000, 4000]) {
      current().open();
      current().ack();
      current().terminate();
      vi.advanceTimersByTime(delay);
    }
    current().open();
    current().terminate();
    expect(mocks.sockets).toHaveLength(4);
    expect(feed.status()).toMatchObject({
      retries: 3,
      stopped: true,
      terminal_reason: "retries_exhausted",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects incompatible frames, records loss and ignores late events on old sockets", () => {
    const feed = startFeed();
    current().open();
    current().ack();
    snapshots();
    feed.drain();
    const old = current();
    old.frame({ channel: "l2Book", data: { ...book(), coin: "ETH" } });
    expect(feed.status().counters.invalid).toBe(1);
    vi.advanceTimersByTime(1000);
    current().open();
    current().ack();
    old.frame({ channel: "l2Book", data: book() });
    expect(feed.drain()).toHaveLength(0);
    snapshots();
    expect(feed.drain()).toHaveLength(2);
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
