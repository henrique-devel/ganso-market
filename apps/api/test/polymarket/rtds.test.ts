import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { DatabasePool, QueryResult } from "../../src/database.js";
import type { MarketSocket } from "../../src/polymarket/recorder.js";
import {
  buildRtdsSubscribeFrame,
  createRtdsRecorder,
  parseRtdsFrame,
  RtdsMinuteAggregator,
  RTDS_TOPICS,
  type RtdsGapInfo,
  type RtdsMinuteBucket,
} from "../../src/polymarket/rtds.js";

const fixtureFrames = JSON.parse(
  readFileSync(new URL("./fixtures/rtds-frames.json", import.meta.url), "utf8"),
) as unknown[];

class FakeRtdsDb implements DatabasePool {
  public readonly priceInserts: unknown[][] = [];
  public readonly bucketUpserts: unknown[][] = [];
  public readonly gapInserts: unknown[][] = [];
  public failPriceInsert = false;

  public query<R extends Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    const values = [...(params ?? [])];
    if (text.includes("INSERT INTO polymarket_rtds_prices")) {
      if (this.failPriceInsert) {
        return Promise.reject(new Error("insert failed"));
      }
      this.priceInserts.push(values);
    } else if (text.includes("INSERT INTO polymarket_rtds_1m")) {
      this.bucketUpserts.push(values);
    } else if (text.includes("INSERT INTO polymarket_data_gaps")) {
      this.gapInserts.push(values);
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  }

  public transaction<T>(): Promise<T> {
    return Promise.reject(new Error("unused"));
  }

  public end(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeSocket implements MarketSocket {
  public readonly sent: string[] = [];
  #open: (() => void) | undefined;
  #message: ((raw: string) => void) | undefined;
  #close: (() => void) | undefined;

  public onOpen(handler: () => void): void {
    this.#open = handler;
  }

  public onMessage(handler: (raw: string) => void): void {
    this.#message = handler;
  }

  public onClose(handler: () => void): void {
    this.#close = handler;
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.#close?.();
  }

  public emitOpen(): void {
    this.#open?.();
  }

  public emitMessage(raw: string): void {
    this.#message?.(raw);
  }

  public emitClose(): void {
    this.#close?.();
  }
}

function tick(ms = 1): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("rtds frame parsing", () => {
  it("never throws on garbage or unknown frames and marks them unrecognized", () => {
    expect(parseRtdsFrame("not-json{", 0).recognized).toBe(false);
    expect(parseRtdsFrame("42", 0).recognized).toBe(false);
    expect(
      parseRtdsFrame(
        JSON.stringify({ topic: "some_new_topic", payload: { x: 1 } }),
        0,
      ).recognized,
    ).toBe(false);
    // Known topic but malformed payload item: no samples, unrecognized.
    const malformed = parseRtdsFrame(
      JSON.stringify({ topic: "crypto_prices", payload: { nope: true } }),
      0,
    );
    expect(malformed.samples).toHaveLength(0);
    expect(malformed.recognized).toBe(false);
  });

  it("parses spot and twap frames, converting timestamps and prices", () => {
    const raw = JSON.stringify(fixtureFrames[0]);
    const result = parseRtdsFrame(raw, 1_787_097_600_450);
    expect(result.recognized).toBe(true);
    expect(result.samples).toHaveLength(1);
    const sample = result.samples[0];
    expect(sample?.feed).toBe("spot");
    expect(sample?.symbol).toBe("btc/usd");
    expect(sample?.price).toBe("50000.5");
    expect(sample?.sourceTs?.getTime()).toBe(1_787_097_600_000);
  });

  it("builds the official subscribe frame (CSV for Binance, one compact JSON symbol per TWAP subscription)", () => {
    const frame = JSON.parse(
      buildRtdsSubscribeFrame([...RTDS_TOPICS], ["btc/usd", "eth/usd"]),
    ) as {
      action: string;
      subscriptions: { topic: string; type: string; filters: string }[];
    };
    expect(frame.action).toBe("subscribe");
    const spot = frame.subscriptions.filter((e) => e.topic === "crypto_prices");
    expect(spot).toHaveLength(1);
    expect(spot[0]?.type).toBe("update");
    expect(spot[0]?.filters).toBe("btcusdt,ethusdt");
    const twap30 = frame.subscriptions.filter(
      (e) => e.topic === "crypto_prices_twap_thirty",
    );
    const twap60 = frame.subscriptions.filter(
      (e) => e.topic === "crypto_prices_twap_sixty",
    );
    expect(twap30.map((e) => e.filters)).toEqual([
      '{"symbol":"btc/usd"}',
      '{"symbol":"eth/usd"}',
    ]);
    expect(twap60).toHaveLength(2);
    expect(twap30[0]?.type).toBe("*");
  });

  it("prefers the exact E18 full_accuracy_value over the display value", () => {
    const { samples } = parseRtdsFrame(
      JSON.stringify({
        topic: "crypto_prices_twap_thirty",
        type: "update",
        timestamp: 1782753357257,
        payload: {
          symbol: "eth/usd",
          timestamp: 1782753357213,
          value: 3420.15,
          full_accuracy_value: "3420150000000000000000",
        },
      }),
      0,
    );
    expect(samples).toHaveLength(1);
    expect(samples[0]?.price).toBe("3420.15");
    expect(samples[0]?.feed).toBe("twap30");
  });
});

describe("rtds 1-minute aggregation", () => {
  it("aggregates the synthetic fixture into correct OHLC buckets per feed", () => {
    const aggregator = new RtdsMinuteAggregator();
    const closed: RtdsMinuteBucket[] = [];
    for (const frame of fixtureFrames) {
      const { samples } = parseRtdsFrame(JSON.stringify(frame), 0);
      for (const sample of samples) {
        const bucket = aggregator.add(sample);
        if (bucket !== null) {
          closed.push(bucket);
        }
      }
    }
    // The 4th fixture frame (t = +61s) rolls the spot bucket.
    expect(closed).toHaveLength(1);
    const spot = closed[0];
    expect(spot?.feed).toBe("spot");
    expect(spot?.symbol).toBe("btc/usd");
    expect(spot?.bucketStart.getTime()).toBe(1_787_097_600_000);
    expect(spot?.open).toBe("50000.5");
    expect(spot?.high).toBe("50110.25");
    expect(spot?.low).toBe("50000.5");
    expect(spot?.close).toBe("50110.25");
    expect(spot?.samples).toBe(2);

    // Drain closes the new spot bucket and the still-open twap60 bucket.
    const drained = aggregator.drain();
    expect(drained).toHaveLength(2);
    const twap = drained.find((bucket) => bucket.feed === "twap60");
    expect(twap?.open).toBe("50050.1");
    expect(twap?.close).toBe("50050.1");
    expect(twap?.samples).toBe(1);
    expect(aggregator.drain()).toHaveLength(0);
  });
});

describe("rtds recorder", () => {
  function makeRecorder(
    db: FakeRtdsDb,
    gaps: RtdsGapInfo[],
    now: () => number,
  ) {
    const sockets: FakeSocket[] = [];
    const recorder = createRtdsRecorder({
      pool: db,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      symbols: ["BTC/USD"],
      clock: now,
      onGap: (gap) => {
        gaps.push(gap);
      },
      reconnectBaseMs: 0,
      flushIntervalMs: 60_000,
      pingIntervalMs: 60_000,
    });
    return { recorder, sockets };
  }

  it("persists batched raw prices with source_ts, received_at and ingest lag", async () => {
    const db = new FakeRtdsDb();
    let nowMs = 1_787_097_600_450;
    const { recorder, sockets } = makeRecorder(db, [], () => nowMs);
    recorder.start();
    sockets[0]?.emitOpen();
    expect(sockets[0]?.sent[0]).toContain("subscribe");
    expect(sockets[0]?.sent[0]).toContain("btc/usd");

    sockets[0]?.emitMessage(JSON.stringify(fixtureFrames[0]));
    nowMs = 1_787_097_630_100;
    sockets[0]?.emitMessage(JSON.stringify(fixtureFrames[1]));
    await recorder.flushNow();

    expect(db.priceInserts).toHaveLength(1);
    const params = db.priceInserts[0] ?? [];
    // Two samples, 6 params each, in one batched INSERT.
    expect(params).toHaveLength(12);
    expect(params[0]).toBe("spot");
    expect(params[1]).toBe("btc/usd");
    expect(params[2]).toBe("50000.5");
    expect(params[3]).toBeInstanceOf(Date);
    expect((params[3] as Date).getTime()).toBe(1_787_097_600_000);
    expect(params[4]).toBeInstanceOf(Date);
    expect(params[5]).toBe(450);
    expect(params[8]).toBe("50110.25");
    expect(params[11]).toBe(100);

    await recorder.stop();
    // Stop drains the open 1-min bucket and upserts it.
    expect(db.bucketUpserts).toHaveLength(1);
    expect(db.bucketUpserts[0]?.[0]).toBe("spot");
    expect(db.bucketUpserts[0]?.[3]).toBe("50000.5");
    expect(db.bucketUpserts[0]?.[6]).toBe("50110.25");
  });

  it("records a gap with the disconnect window on reconnect", async () => {
    const db = new FakeRtdsDb();
    const gaps: RtdsGapInfo[] = [];
    let nowMs = 0;
    const { recorder, sockets } = makeRecorder(db, gaps, () => nowMs);
    recorder.start();
    sockets[0]?.emitOpen();

    nowMs = 1_000;
    sockets[0]?.emitClose();
    await tick(5);
    expect(sockets).toHaveLength(2);

    nowMs = 5_000;
    sockets[1]?.emitOpen();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.start.getTime()).toBe(1_000);
    expect(gaps[0]?.end.getTime()).toBe(5_000);
    expect(db.gapInserts).toHaveLength(1);
    expect((db.gapInserts[0]?.[0] as Date).getTime()).toBe(1_000);
    expect((db.gapInserts[0]?.[1] as Date).getTime()).toBe(5_000);
    expect(db.gapInserts[0]?.[2]).toBe("ws_disconnect");
    // The new socket re-subscribed.
    expect(sockets[1]?.sent[0]).toContain("subscribe");

    await recorder.stop();
    expect(sockets).toHaveLength(2);
  });

  it("survives a persist failure: logs, records a gap and keeps running", async () => {
    const db = new FakeRtdsDb();
    let nowMs = 1_787_097_600_000;
    const { recorder, sockets } = makeRecorder(db, [], () => nowMs);
    recorder.start();
    sockets[0]?.emitOpen();
    sockets[0]?.emitMessage(JSON.stringify(fixtureFrames[0]));

    db.failPriceInsert = true;
    await expect(recorder.flushNow()).resolves.toBeUndefined();
    expect(db.gapInserts).toHaveLength(1);
    expect(db.gapInserts[0]?.[2]).toBe("persist_failed");

    // Recovery: the next batch persists normally.
    db.failPriceInsert = false;
    nowMs += 1_000;
    sockets[0]?.emitMessage(JSON.stringify(fixtureFrames[1]));
    await recorder.flushNow();
    expect(db.priceInserts).toHaveLength(1);
    await recorder.stop();
  });

  it("counts unknown frames without throwing and resubscribes on setSymbols", async () => {
    const db = new FakeRtdsDb();
    const { recorder, sockets } = makeRecorder(db, [], () => 0);
    recorder.start();
    sockets[0]?.emitOpen();

    sockets[0]?.emitMessage("total garbage");
    sockets[0]?.emitMessage(JSON.stringify({ topic: "who_knows", payload: 1 }));
    expect(recorder.unknownFrames()).toBe(2);

    recorder.setSymbols(["ETH/USD"]);
    const sent = sockets[0]?.sent ?? [];
    expect(sent[sent.length - 1]).toContain("eth/usd");
    await recorder.stop();
  });
});
