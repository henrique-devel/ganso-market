import { describe, expect, it } from "vitest";
import { FeedQualityMachine, FEED_LIMITS } from "../../src/trading/feed.js";
import type { TradingMarketObservation } from "@ganso-market/contracts/trading";
import { normalizeHyperliquidFeed } from "../../src/venues/hyperliquid/feed-normalizer.js";

const start = Date.parse("2026-09-23T09:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
function book(ms = start, received = ms) {
  return normalizeHyperliquidFeed(
    "book",
    {
      coin: "BTC",
      time: ms,
      levels: [
        [{ px: "64000", sz: "0.01", n: 1 }],
        [{ px: "64001", sz: "0.01", n: 1 }],
      ],
    },
    iso(received),
    "test-v1",
    "test",
  )[0]!;
}
function trade(ms = start, tid = 987654, received = ms) {
  return normalizeHyperliquidFeed(
    "trades",
    [{ coin: "BTC", time: ms, tid, side: "B", px: "64000", sz: "0.01" }],
    iso(received),
    "test-v1",
    "test",
  )[0]!;
}
function context(ms = start) {
  return normalizeHyperliquidFeed(
    "context",
    {
      coin: "BTC",
      ctx: { markPx: "64000", oraclePx: "63999", funding: "-0.00000123456789" },
    },
    iso(ms),
    "test-v1",
    String(ms),
  )[0]!;
}
function machine() {
  const m = new FeedQualityMachine<TradingMarketObservation>();
  m.open(start);
  return m;
}

describe("public feed quality and bounded history", () => {
  it("distinguishes connectivity, channels and observed trading", () => {
    const m = machine();
    expect(m.status(start)).toMatchObject({
      socket: { alive: true },
      channels: { book: { status: "awaiting" } },
      instrument: { activity: "unknown", venue_trading_status: "unknown" },
    });
    m.accept(book());
    m.accept(context());
    m.accept(trade());
    expect(m.drain(start)).toMatchObject([
      {
        quality: "fresh",
        revalidation: "current_state_only",
        continuity: "unproven",
      },
      { quality: "unknown", source_timestamp: null },
      { revalidation: "delivery_resumed_only" },
    ]);
    expect(m.status(start).instrument.activity).toBe("recent_trade_observed");
  });
  it("keeps silent channels stale despite a live socket and never infers a halt", () => {
    const m = machine();
    m.accept(book());
    m.accept(context());
    m.accept(trade());
    m.drain(start);
    m.message(start + 31_000);
    const status = m.status(start + 31_000);
    expect(status.socket.alive).toBe(true);
    for (const state of Object.values(status.channels))
      expect(state.status).toBe("stale");
    expect(status.instrument).toMatchObject({
      activity: "unknown",
      venue_trading_status: "unknown",
    });
  });
  it("deduplicates trades by time/coin/tid without interpreting tid as a sequence", () => {
    const m = machine();
    m.accept(trade());
    m.accept(trade());
    m.accept(trade(start, 1));
    expect(m.drain(start)).toHaveLength(2);
    expect(m.status(start).counters).toMatchObject({
      duplicates: 1,
      out_of_order: 0,
    });
  });
  it("does not hide conflicting payloads under a repeated trade identity", () => {
    const m = machine();
    m.accept(trade());
    m.accept({ ...trade(), payload_hash: "conflict" });
    expect(m.status(start).channels.trades.status).toBe("invalid");
  });
  it("rejects out-of-order data without regressing state, then revalidates a snapshot", () => {
    const m = machine();
    m.accept(book(start + 100));
    m.drain(start + 100);
    m.accept(book(start, start + 200));
    expect(m.status(start + 200).channels.book).toMatchObject({
      status: "invalid",
      last_source_at: start + 100,
    });
    m.accept(book(start + 300));
    expect(m.drain(start + 300)[0]).toMatchObject({
      quality: "fresh",
      revalidation: "current_state_only",
    });
    expect(m.status(start + 300).gaps).toContainEqual(
      expect.objectContaining({
        reason: "out_of_order",
        recovery: "current_state_only",
      }),
    );
  });
  it("does not relabel replayed or duplicate snapshots as recovery after reconnect", () => {
    const m = machine();
    m.accept(book());
    m.accept(trade());
    m.drain(start);
    m.disconnect(start + 100);
    m.open(start + 200);
    m.accept({ ...book(), received_at: iso(start + 200) });
    m.accept({ ...trade(), received_at: iso(start + 200) });
    expect(m.status(start + 200).channels.book.needs_revalidation).toBe(true);
    m.accept(book(start + 300));
    m.accept(trade(start + 300));
    expect(m.drain(start + 300)).toMatchObject([
      { revalidation: "current_state_only" },
      { revalidation: "delivery_resumed_only" },
    ]);
    expect(
      m.status(start + 300).gaps.filter((g) => g.reason === "disconnect"),
    ).toHaveLength(2);
    expect(m.status(start + 300).continuity).toBe("unproven");
  });
  it("records silence on receipt even without a timer tick", () => {
    const m = machine();
    m.accept(book());
    m.drain(start);
    m.accept(book(start + 20_000));
    expect(m.drain(start + 20_000)[0]!.revalidation).toBe("current_state_only");
    expect(
      m
        .status(start + 20_000)
        .gaps.some((g) => g.channel === "book" && g.reason !== "startup"),
    ).toBe(true);
  });
  it("neither duplicates nor old/future source times refresh freshness", () => {
    const m = machine();
    m.accept(book());
    m.drain(start);
    m.accept(book(start, start + 11_000));
    m.accept(trade(start, 1, start + 11_000));
    m.accept(trade(start + 50_000, 2, start + 11_000));
    expect(m.drain(start + 11_000)).toHaveLength(0);
    expect(m.status(start + 11_000).channels.book.status).toBe("stale");
    expect(m.status(start + 11_000).instrument.activity).toBe("unknown");
    expect(m.status(start + 11_000).counters.stale).toBe(2);
  });
  it("ages source freshness independently of receipt time and at drain", () => {
    const m = machine();
    m.accept(book(start, start + 9000));
    expect(m.status(start + 10_001).channels.book.source_quality).toBe("stale");
    expect(m.drain(start + 10_001)[0]!.quality).toBe("stale");
  });
  it("does not deliver queued samples as fresh after a gap", () => {
    const m = machine();
    m.accept(book());
    m.disconnect(start + 1);
    expect(m.drain(start + 1)[0]!.quality).toBe("unknown");
  });
  it("caps queues, dedup and gap history with counters and explicit overflow", () => {
    const m = machine();
    for (let i = 0; i < 3000; i++) m.accept(trade(start + i, i));
    const status = m.status(start + 3000);
    expect(status.buffers).toMatchObject({
      queued: FEED_LIMITS.queue,
      dedup: FEED_LIMITS.dedup,
    });
    expect(status.counters.dropped).toBe(3000 - FEED_LIMITS.queue);
    expect(status.channels.trades.needs_revalidation).toBe(true);
    m.drain(start + 3000);
    m.accept(trade(start + 3001));
    expect(m.drain(start + 3001)[0]!.revalidation).toBe(
      "delivery_resumed_only",
    );
    for (let i = 0; i < 100; i++) {
      m.invalid("book", start + i);
      m.accept(book(start + i));
      m.drain(start + i);
    }
    expect(m.status(start + 3100).buffers.gaps).toBe(FEED_LIMITS.gaps);
    expect(m.status(start + 3100).counters.gaps).toBeGreaterThan(
      FEED_LIMITS.gaps,
    );
  });
});
