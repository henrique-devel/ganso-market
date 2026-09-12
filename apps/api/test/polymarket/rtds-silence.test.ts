import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DatabasePool,
  QueryResult,
  SqlExecutor,
} from "../../src/database.js";
import type { MarketSocket } from "../../src/polymarket/recorder.js";
import {
  createRtdsRecorder,
  type RtdsFeed,
  type RtdsRecorder,
  type RtdsRecorderDeps,
} from "../../src/polymarket/rtds.js";

const epoch = Date.parse("2026-09-10T12:00:00Z");
const silenceMs = 30_000;
const topics: Record<RtdsFeed, string> = {
  spot: "crypto_prices",
  twap30: "crypto_prices_twap_thirty",
  twap60: "crypto_prices_twap_sixty",
};

function priceFrame(
  feed: RtdsFeed = "spot",
  timestamp = Date.now(),
  price = "50000.5",
  symbol = feed === "spot" ? "btcusdt" : "btc/usd",
): string {
  return JSON.stringify({
    topic: topics[feed],
    type: "update",
    payload: { symbol, price, timestamp },
  });
}

interface GapRow {
  start: Date;
  end: Date | null;
  cause: string;
  details: {
    episode_id?: string;
    scope?: "global" | "series";
    feed?: RtdsFeed;
    symbol?: string;
    attempts?: unknown[];
    last_price_frame_ms?: number | null;
  };
}

class SilenceDb implements DatabasePool {
  readonly priceInserts: unknown[][] = [];
  readonly bucketUpserts: unknown[][] = [];
  readonly gapWrites: GapRow[] = [];
  readonly gaps = new Map<string, GapRow>();
  failPrices = false;
  failGaps = false;
  failBuckets = false;
  gapAttempts = 0;

  async query<R extends Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    const values = [...(params ?? [])];
    if (sql.includes("INSERT INTO polymarket_rtds_prices")) {
      if (this.failPrices) throw new Error("raw price storage unavailable");
      this.priceInserts.push(values);
    } else if (sql.includes("INSERT INTO polymarket_rtds_1m")) {
      if (this.failBuckets) throw new Error("minute storage unavailable");
      this.bucketUpserts.push(values);
    } else if (sql.includes("INSERT INTO polymarket_data_gaps")) {
      this.gapAttempts += 1;
      if (this.failGaps) throw new Error("gap storage unavailable");
      const row: GapRow = {
        start: values[0] as Date,
        end: values[1] as Date | null,
        cause: values[2] as string,
        details: JSON.parse(values[3] as string) as GapRow["details"],
      };
      this.gapWrites.push(row);
      this.gaps.set(
        row.details.episode_id ?? `legacy-${this.gapWrites.length}`,
        row,
      );
    }
    return { rows: [], rowCount: 1 };
  }

  transaction<T>(): Promise<T> {
    return Promise.reject(new Error("unused"));
  }

  readOnly<T>(
    _statementTimeoutMs: number,
    run: (tx: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    return run(this);
  }

  async end(): Promise<void> {}
}

class SilenceSocket implements MarketSocket {
  readonly sent: string[] = [];
  closes = 0;
  throwOnClose = false;
  #open: (() => void) | undefined;
  #message: ((raw: string) => void) | undefined;
  #close: (() => void) | undefined;

  onOpen(handler: () => void): void {
    this.#open = handler;
  }
  onMessage(handler: (raw: string) => void): void {
    this.#message = handler;
  }
  onClose(handler: () => void): void {
    this.#close = handler;
  }
  send(raw: string): void {
    this.sent.push(raw);
  }
  close(): void {
    this.closes += 1;
    if (this.throwOnClose) throw new Error("close failed");
    this.#close?.();
  }
  emitOpen(): void {
    this.#open?.();
  }
  emitMessage(raw: string): void {
    this.#message?.(raw);
  }
  emitClose(): void {
    this.#close?.();
  }
  subscriptions(): string[] {
    return this.sent.filter(
      (raw) =>
        raw.startsWith("{") &&
        (JSON.parse(raw) as { action?: string }).action === "subscribe",
    );
  }
}

const activeRecorders: RtdsRecorder[] = [];

function harness(overrides: Partial<RtdsRecorderDeps> = {}) {
  const db = new SilenceDb();
  const sockets: SilenceSocket[] = [];
  const recorder = createRtdsRecorder({
    pool: db,
    socketFactory: () => {
      const socket = new SilenceSocket();
      sockets.push(socket);
      return socket;
    },
    symbols: ["BTC/USD"],
    clock: Date.now,
    silenceMs,
    reconnectBaseMs: 1_000,
    flushIntervalMs: 3_600_000,
    pingIntervalMs: 5_000,
    ...overrides,
  });
  activeRecorders.push(recorder);
  const current = (): SilenceSocket => {
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error("recorder has no socket");
    return socket;
  };
  const allPrices = (): void => {
    for (const feed of ["spot", "twap30", "twap60"] as const) {
      current().emitMessage(priceFrame(feed));
    }
  };
  return { db, sockets, recorder, current, allPrices };
}

async function drain(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(async () => {
  for (const recorder of activeRecorders.splice(0)) await recorder.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RTDS silence with an open transport", () => {
  it("validates the explicit threshold and recovery budget", () => {
    const recorder = createRtdsRecorder({
      pool: new SilenceDb(),
      socketFactory: () => new SilenceSocket(),
      symbols: ["BTC/USD"],
    });
    activeRecorders.push(recorder);
    expect(recorder.health().thresholdMs).toBe(120_000);
    for (const value of [0, -1, 29_999, 3_600_001, Number.NaN, Infinity]) {
      expect(() => harness({ silenceMs: value })).toThrow();
    }
    for (const value of [-1, 11, 1.5, Number.NaN, Infinity]) {
      expect(() => harness({ recoveryMaxReconnects: value })).toThrow();
    }
    expect(() => harness({ recoveryMaxReconnects: 0 })).not.toThrow();
  });

  it("persists global and per-series gaps and bounds reconnects across socket opens", async () => {
    const h = harness({ recoveryMaxReconnects: 2 });
    h.recorder.start();
    h.current().emitOpen();
    await vi.advanceTimersByTimeAsync(silenceMs - 1);
    expect(h.db.gaps.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.recorder.health().socketOpen).toBe(true);
    expect(h.recorder.health().openGaps).toBe(4);
    expect(h.db.gaps.size).toBe(4);
    for (const row of h.db.gaps.values()) {
      expect(row.cause).toBe("stream_silent");
      expect(row.start.getTime()).toBe(epoch);
      expect(row.end).toBeNull();
      expect(row.details.episode_id).toEqual(expect.any(String));
    }
    expect(
      [...h.db.gaps.values()].filter((row) => row.details.scope === "global"),
    ).toHaveLength(1);
    expect(h.recorder.health().recovery.resubscribes).toBe(1);
    expect(h.current().subscriptions()).toHaveLength(2);
    const resubscription = h
      .current()
      .sent.filter((raw) => raw.startsWith("{"));
    expect(JSON.parse(resubscription[1] ?? "{}").action).toBe("unsubscribe");

    await vi.advanceTimersByTimeAsync(silenceMs);
    expect(h.sockets).toHaveLength(2);
    h.current().emitOpen();
    expect(h.current().subscriptions()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(silenceMs * 2);
    expect(h.sockets).toHaveLength(3);
    h.current().emitOpen();
    await vi.advanceTimersByTimeAsync(silenceMs * 20);
    expect(h.sockets).toHaveLength(3);
    expect(h.recorder.health().recovery).toMatchObject({
      resubscribes: 1,
      reconnects: 2,
      exhausted: true,
    });
    expect(
      [...h.db.gaps.values()].filter((row) => row.cause === "stream_silent"),
    ).toHaveLength(4);
    expect(h.db.priceInserts).toHaveLength(0);
    expect(h.db.bucketUpserts).toHaveLength(0);
    expect(
      [...h.db.gaps.values()].some(
        (row) => (row.details.attempts?.length ?? 0) > 0,
      ),
    ).toBe(true);
  });

  it("keeps gaps open for PONG, ACK, malformed and unrequested prices, then closes once", async () => {
    const h = harness();
    h.recorder.start();
    h.current().emitOpen();
    await vi.advanceTimersByTimeAsync(silenceMs);
    for (const frame of [
      "PONG",
      "PING",
      "not json",
      JSON.stringify({ topic: topics.spot }),
      JSON.stringify({
        topic: topics.spot,
        payload: { symbol: "btcusdt", price: "bad" },
      }),
      priceFrame("spot", Date.now(), "50000", "ethusdt"),
      priceFrame("spot", Date.now(), "0"),
      priceFrame("spot", Date.now(), "-1"),
      JSON.stringify({
        topic: topics.spot,
        type: "ack",
        payload: { symbol: "btcusdt", price: "50000" },
      }),
    ])
      h.current().emitMessage(frame);
    await drain();
    expect(h.recorder.health().lastPriceFrameMs).toBeNull();
    expect(h.recorder.health().openGaps).toBe(4);
    expect(h.db.gapWrites.filter((row) => row.end !== null)).toHaveLength(0);

    h.current().emitMessage(priceFrame());
    await drain();
    expect(h.recorder.health().openGaps).toBe(2);
    expect(h.db.gapWrites.filter((row) => row.end !== null)).toHaveLength(2);
    h.current().emitMessage(priceFrame());
    await drain();
    expect(h.db.gapWrites.filter((row) => row.end !== null)).toHaveLength(2);
    h.current().emitMessage(priceFrame("twap30"));
    h.current().emitMessage(priceFrame("twap60"));
    // A close queued behind an in-flight write is saved by the next watchdog tick.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.recorder.health().openGaps).toBe(0);
    expect(h.db.gapWrites.filter((row) => row.end !== null)).toHaveLength(4);
    expect(
      [...h.db.gaps.values()].every(
        (row) => row.end?.getTime() === epoch + silenceMs,
      ),
    ).toBe(true);
  });

  it("detects silent TWAP series while the subscribed spot feed keeps arriving", async () => {
    const h = harness();
    h.recorder.start();
    h.current().emitOpen();
    await vi.advanceTimersByTimeAsync(silenceMs - 1_000);
    h.current().emitMessage(priceFrame());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.recorder.health().lastPriceFrameMs).toBe(
      epoch + silenceMs - 1_000,
    );
    expect(h.recorder.health().openGaps).toBe(2);
    expect(
      [...h.db.gaps.values()].map((row) => row.details.feed).sort(),
    ).toEqual(["twap30", "twap60"]);
    expect(
      [...h.db.gaps.values()].every(
        (row) => row.details.last_price_frame_ms === null,
      ),
    ).toBe(true);
    expect(
      h.recorder.health().series.find((series) => series.feed === "spot"),
    ).toMatchObject({
      symbol: "btc/usd",
      silent: false,
    });
    expect(h.db.priceInserts).toHaveLength(0);
    await h.recorder.flushNow();
    expect(h.db.priceInserts[0]?.[1]).toBe("btcusdt");
  });

  it("tracks each subscribed symbol independently within the same feed", async () => {
    const h = harness({ symbols: ["BTC/USD", "ETH/USD"] });
    h.recorder.start();
    h.current().emitOpen();
    for (const feed of ["spot", "twap30", "twap60"] as const) {
      h.current().emitMessage(priceFrame(feed));
      h.current().emitMessage(
        priceFrame(
          feed,
          epoch,
          "3000",
          feed === "spot" ? "ethusdt" : "eth/usd",
        ),
      );
    }
    await vi.advanceTimersByTimeAsync(silenceMs - 1_000);
    h.allPrices();
    for (const feed of ["twap30", "twap60"] as const) {
      h.current().emitMessage(priceFrame(feed, Date.now(), "3000", "eth/usd"));
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.recorder.health().openGaps).toBe(1);
    expect([...h.db.gaps.values()][0]?.details).toMatchObject({
      scope: "series",
      feed: "spot",
      symbol: "eth/usd",
      last_price_frame_ms: epoch,
    });
    h.current().emitMessage(priceFrame("spot", Date.now(), "3000", "ethusdt"));
    await drain();
    expect(h.recorder.health().openGaps).toBe(0);
  });

  it("retains failed persistence evidence through reconnect and retries gap writes", async () => {
    const h = harness();
    h.recorder.start();
    h.current().emitOpen();
    h.allPrices();
    h.db.failPrices = true;
    h.db.failGaps = true;
    await h.recorder.flushNow();
    expect(h.recorder.health().pricePersistFailures).toBe(1);
    expect(h.recorder.health().gapPersistFailures).toBeGreaterThan(0);
    expect(h.recorder.health().pendingGapWrites).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(silenceMs * 2);
    expect(h.sockets).toHaveLength(2);
    h.current().emitOpen();
    await drain();
    expect(h.recorder.health().pricePersistFailures).toBe(1);
    expect(h.recorder.health().lastPricePersistMs).toBeNull();
    const gapFailures = h.recorder.health().gapPersistFailures;
    h.db.failGaps = false;
    h.db.failPrices = false;
    h.allPrices();
    await h.recorder.flushNow();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.recorder.health().pendingGapWrites).toBe(0);
    expect(h.recorder.health().gapPersistFailures).toBe(gapFailures);
    expect(h.recorder.health().pricePersistFailures).toBe(1);
    expect(h.recorder.health().lastPricePersistMs).not.toBeNull();
    expect(
      [...h.db.gaps.values()].some((row) => row.cause === "persist_failed"),
    ).toBe(true);
    expect(
      [...h.db.gaps.values()].filter((row) => row.cause === "stream_silent"),
    ).toHaveLength(4);
    expect(h.db.priceInserts).toHaveLength(1);
    expect(h.db.priceInserts[0]).toHaveLength(18);
  });

  it("reports arrival, source advancement, value changes and commits separately", async () => {
    const h = harness();
    h.recorder.start();
    h.current().emitOpen();
    h.allPrices();
    await vi.advanceTimersByTimeAsync(10_000);
    h.current().emitMessage(priceFrame("spot", epoch));
    const spot = h.recorder
      .health()
      .series.find((series) => series.feed === "spot");
    expect(spot).toMatchObject({
      lastPriceFrameMs: epoch + 10_000,
      lastSourceTsMs: epoch,
      lastSourceAdvanceMs: epoch,
      lastValueChangeMs: epoch,
      lastPersistedReceivedMs: null,
    });
    await h.recorder.flushNow();
    expect(
      h.recorder.health().series.find((series) => series.feed === "spot")
        ?.lastPersistedReceivedMs,
    ).toBe(epoch + 10_000);
    expect(h.db.priceInserts[0]).toHaveLength(24);
    expect(h.db.priceInserts[0]?.[20]).toBe("50000.5");
    expect((h.db.priceInserts[0]?.[21] as Date).getTime()).toBe(epoch);
  });

  it("keeps minute-bucket persistence failures visible after reconnect", async () => {
    const h = harness({ silenceMs: 120_000 });
    h.recorder.start();
    h.current().emitOpen();
    h.allPrices();
    await vi.advanceTimersByTimeAsync(60_000);
    h.allPrices();
    h.db.failBuckets = true;
    await h.recorder.flushNow();
    expect(h.recorder.health().bucketPersistFailures).toBe(3);
    expect(h.recorder.health().pricePersistFailures).toBe(0);
    expect(h.db.bucketUpserts).toHaveLength(0);
    expect(h.db.priceInserts[0]).toHaveLength(36);

    h.current().emitClose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sockets).toHaveLength(2);
    h.current().emitOpen();
    h.db.failBuckets = false;
    h.allPrices();
    await h.recorder.flushNow();
    expect(h.recorder.health().bucketPersistFailures).toBe(3);
    expect(h.recorder.health().pricePersistFailures).toBe(0);
  });

  it("unsubscribes an empty symbol set without an unfiltered subscription or phantom gaps", async () => {
    const h = harness();
    h.recorder.start();
    h.current().emitOpen();
    h.recorder.setSymbols([]);
    const subscriptionFrames = h
      .current()
      .sent.filter((raw) => raw.startsWith("{"))
      .map(
        (raw) =>
          JSON.parse(raw) as { action: string; subscriptions: unknown[] },
      );
    expect(subscriptionFrames.map((frame) => frame.action)).toEqual([
      "subscribe",
      "unsubscribe",
    ]);
    expect(subscriptionFrames[1]?.subscriptions).toEqual(
      subscriptionFrames[0]?.subscriptions,
    );
    expect(h.recorder.health().series).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(silenceMs * 10);
    expect(h.current().subscriptions()).toHaveLength(1);
    expect(h.sockets).toHaveLength(1);
    expect(h.recorder.health().openGaps).toBe(0);
    expect(h.db.gaps.size).toBe(0);
    expect(h.db.priceInserts).toHaveLength(0);
  });

  it("restores recovery budget only after all scoped gaps heal for a later silence episode", async () => {
    const h = harness({ recoveryMaxReconnects: 1 });
    h.recorder.start();
    h.current().emitOpen();
    await vi.advanceTimersByTimeAsync(silenceMs * 2);
    expect(h.sockets).toHaveLength(2);
    h.current().emitOpen();
    expect(h.recorder.health().recovery).toMatchObject({
      reconnects: 1,
      exhausted: true,
    });

    h.current().emitMessage(priceFrame());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.recorder.health().openGaps).toBe(2);
    expect(h.recorder.health().recovery).toMatchObject({
      reconnects: 1,
      exhausted: true,
    });
    h.allPrices();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.recorder.health().openGaps).toBe(0);
    expect(h.recorder.health().recovery).toEqual({
      resubscribes: 0,
      reconnects: 0,
      exhausted: false,
    });

    await vi.advanceTimersByTimeAsync(silenceMs - 1_000);
    expect(h.recorder.health().openGaps).toBe(4);
    expect(h.recorder.health().recovery).toEqual({
      resubscribes: 1,
      reconnects: 0,
      exhausted: false,
    });
    await vi.advanceTimersByTimeAsync(silenceMs);
    expect(h.sockets).toHaveLength(3);
    expect(h.recorder.health().recovery).toMatchObject({
      reconnects: 1,
      exhausted: true,
    });
    const silenceRows = [...h.db.gaps.values()].filter(
      (row) => row.cause === "stream_silent",
    );
    expect(silenceRows).toHaveLength(8);
    expect(silenceRows.filter((row) => row.end !== null)).toHaveLength(4);
  });

  it("ignores duplicate and obsolete socket callbacks without duplicate subscriptions or buckets", async () => {
    const h = harness();
    h.recorder.start();
    const first = h.current();
    first.emitOpen();
    first.emitOpen();
    expect(first.subscriptions()).toHaveLength(1);
    first.emitMessage(priceFrame());
    first.emitClose();
    first.emitClose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sockets).toHaveLength(2);
    h.current().emitOpen();
    h.current().emitOpen();
    first.emitOpen();
    first.emitClose();
    first.emitMessage(priceFrame("spot", Date.now(), "99999"));
    // The reconnect snapshot may replay the prior source observation.
    h.current().emitMessage(priceFrame("spot", epoch));
    h.current().emitMessage(priceFrame("spot", Date.now(), "50001"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sockets).toHaveLength(2);
    expect(h.current().subscriptions()).toHaveLength(1);
    await h.recorder.stop();
    expect(h.db.priceInserts[0]).toHaveLength(12);
    expect(h.db.bucketUpserts).toHaveLength(1);
    expect(h.db.bucketUpserts[0]?.[4]).toBe("50001");
    expect(h.db.bucketUpserts[0]?.[7]).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop cancels silence, gap retry and recovery timers even when socket close throws", async () => {
    const h = harness();
    h.recorder.start();
    h.current().emitOpen();
    h.db.failGaps = true;
    await vi.advanceTimersByTimeAsync(silenceMs);
    expect(h.recorder.health().pendingGapWrites).toBeGreaterThan(0);
    h.current().throwOnClose = true;
    await h.recorder.stop();
    const attempts = h.db.gapAttempts;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(silenceMs * 20);
    h.current().emitMessage(priceFrame());
    expect(h.sockets).toHaveLength(1);
    expect(h.db.gapAttempts).toBe(attempts);
    expect(h.db.priceInserts).toHaveLength(0);
  });
});
