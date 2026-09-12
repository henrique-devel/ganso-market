import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResultRow } from "pg";

import type { DatabasePool, SqlExecutor } from "../../src/database.js";
import {
  createOrchestrator,
  type Orchestrator,
} from "../../src/polymarket/orchestrator.js";
import type { MarketSocket } from "../../src/polymarket/recorder.js";

const pipeline = vi.hoisted(() => ({
  handleMessage: vi.fn(async () => {}),
  seedBook: vi.fn(async () => {}),
  getCachedBook: vi.fn(() => null),
  requestResync: vi.fn(),
  cancelSubscribeWatch: vi.fn(),
  armSubscribeWatch: vi.fn(),
  flushMinute: vi.fn(async () => {}),
  runAnchorPass: vi.fn(async () => {}),
  flushDeltas: vi.fn(async () => {}),
  stats: vi.fn(() => ({})),
}));
const rtdsHealth = vi.hoisted(() => ({
  status: "silent",
  silence_ms: 120_000,
  series: [
    { feed: "chainlink", symbol: "btc/usd", status: "silent" },
    { feed: "binance", symbol: "btcusdt", status: "healthy" },
  ],
}));
const createRtdsRecorderMock = vi.hoisted(() =>
  vi.fn((_deps: unknown) => ({
    start() {},
    async stop() {},
    unknownFrames: () => 0,
    health: () => rtdsHealth,
  })),
);

vi.mock("../../src/polymarket/bookpipe.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/polymarket/bookpipe.js")
  >()),
  createBookPipeline: () => pipeline,
}));
vi.mock("../../src/polymarket/registry.js", () => ({
  runGammaCycle: async () => ({
    universe: [
      { conditionId: "market-a", tokenIds: ["token-a"], category: "crypto" },
    ],
    entered: ["market-a"],
    exited: [],
    fetchFailed: false,
    series: {
      fetchFailed: false,
      candidates: 0,
      newToUniverse: 0,
      entered: 0,
      leadMinutes: [],
    },
  }),
  refreshParams: async () => {},
}));
vi.mock("../../src/polymarket/rtds.js", () => ({
  createRtdsRecorder: createRtdsRecorderMock,
}));
vi.mock("../../src/polymarket/macro.js", () => ({
  createCalendarSync: () => ({ async runOnce() {} }),
  createReleaseCollector: () => ({ async pollOnce() {} }),
}));
vi.mock("../../src/polymarket/retention.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/polymarket/retention.js")
  >()),
  createRetentionJob: () => ({ runOnce: async () => ({ failedSteps: 0 }) }),
}));
vi.mock("../../src/polymarket/samplers.js", () => ({
  createOiHoldersSampler: () => ({ async sampleOnce() {} }),
  createUmaStatusPoller: () => ({
    async pollOnce() {},
    async pollPendingOnce() {},
  }),
}));
vi.mock("../../src/polymarket/trades.js", () => ({
  handleLastTrade: async () => {},
  createTradesBackfill: () => ({ async pollOnce() {} }),
}));
vi.mock("../../src/polymarket/versioning.js", () => ({
  applyTickSizeChange: async () => {},
}));
vi.mock("../../src/polymarket/quality.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/polymarket/quality.js")>()),
  createReconciler: () => ({ async reconcileOnce() {} }),
}));

class FakeSocket implements MarketSocket {
  readonly sent: string[] = [];
  #onOpen: (() => void) | undefined;
  #onClose: (() => void) | undefined;
  #onMessage: ((raw: string) => void) | undefined;
  onOpen(handler: () => void): void {
    this.#onOpen = handler;
  }
  onClose(handler: () => void): void {
    this.#onClose = handler;
  }
  onMessage(handler: (raw: string) => void): void {
    this.#onMessage = handler;
  }
  send(raw: string): void {
    this.sent.push(raw);
  }
  close(): void {
    this.#onClose?.();
  }
  open(): void {
    this.#onOpen?.();
  }
  emit(raw: string): void {
    this.#onMessage?.(raw);
  }
}

interface SqlCall {
  text: string;
  params: readonly unknown[];
}
interface Harness {
  orchestrator: Orchestrator;
  sockets: FakeSocket[];
  queries: SqlCall[];
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
}
const live: Orchestrator[] = [];
const book = {
  event_type: "book",
  market: "market-a",
  asset_id: "token-a",
  timestamp: "1789088400000",
  hash: "book-a",
  bids: [{ price: "0.4", size: "10" }],
  asks: [{ price: "0.6", size: "12" }],
};
const restBook = { asset_id: "token-a", bids: book.bids, asks: book.asks };

async function harness(
  implementation: typeof fetch = async () => Response.json(restBook),
): Promise<Harness> {
  const queries: SqlCall[] = [];
  let nextGapId = 0;
  const pool: DatabasePool = {
    async query<R extends QueryResultRow>(
      text: string,
      params: readonly unknown[] = [],
    ) {
      queries.push({ text, params });
      const rows = /INSERT INTO polymarket_data_gaps/.test(text)
        ? [{ gap_id: ++nextGapId }]
        : [];
      return { rows: rows as unknown as R[], rowCount: rows.length };
    },
    async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return run(pool);
    },
    async readOnly<T>(
      _timeout: number,
      run: (tx: SqlExecutor) => Promise<T>,
    ): Promise<T> {
      return run(pool);
    },
    async end() {},
  };
  const sockets: FakeSocket[] = [];
  const fetcher = vi.fn<typeof fetch>(implementation);
  const orchestrator = createOrchestrator({
    pool,
    fetcher,
    intervals: { statusMs: 1_000 },
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  live.push(orchestrator);
  await orchestrator.start();
  expect(sockets).toHaveLength(2);
  for (const socket of sockets) socket.open();
  sockets[0]?.emit(JSON.stringify(book));
  sockets[0]?.emit(
    JSON.stringify({
      event_type: "price_change",
      market: "market-a",
      timestamp: book.timestamp,
      price_changes: [
        { asset_id: "token-a", price: "0.4", size: "11", side: "BUY" },
      ],
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  return { orchestrator, sockets, queries, fetcher };
}

function silentInserts(h: Harness): SqlCall[] {
  const seen = new Set<string>();
  return h.queries.filter((call) => {
    if (
      !/INSERT INTO polymarket_data_gaps/.test(call.text) ||
      !call.text.includes("'stream_silent'")
    )
      return false;
    const details = JSON.parse(String(call.params[3])) as {
      episode_id: string;
    };
    if (seen.has(details.episode_id)) return false;
    seen.add(details.episode_id);
    return true;
  });
}
function closes(h: Harness): SqlCall[] {
  return h.queries.filter(
    (call) =>
      call.text.includes("'stream_silent'") &&
      /INSERT INTO polymarket_data_gaps/.test(call.text) &&
      call.params[2] !== null,
  );
}
function persistedClassification(h: Harness, classification: string): boolean {
  return h.queries.some((call) =>
    call.params.some(
      (param) =>
        typeof param === "string" && param.includes(`"${classification}"`),
    ),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T21:00:00Z"));
  vi.stubEnv("GANSO_CLOB_SILENCE_MS", "120000");
  vi.stubEnv("GANSO_RTDS_SILENCE_MS", undefined);
  vi.stubEnv("GANSO_RTDS_MAX_RECONNECTS", undefined);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.clearAllMocks();
});

describe("OPS-05 — orchestrator RTDS silence integration", () => {
  it("passes explicit silence and reconnect configuration to the recorder", async () => {
    vi.stubEnv("GANSO_RTDS_SILENCE_MS", "45000");
    vi.stubEnv("GANSO_RTDS_MAX_RECONNECTS", "0");
    await harness();
    expect(createRtdsRecorderMock).toHaveBeenCalledOnce();
    expect(createRtdsRecorderMock).toHaveBeenCalledWith(
      expect.objectContaining({ silenceMs: 45_000, recoveryMaxReconnects: 0 }),
    );
  });

  it("leaves the validated recorder defaults in effect when configuration is absent", async () => {
    await harness();
    const options = createRtdsRecorderMock.mock.calls[0]?.[0];
    expect(options).toBeDefined();
    expect(options).not.toHaveProperty("silenceMs");
    expect(options).not.toHaveProperty("recoveryMaxReconnects");
  });

  it("reports the exact RTDS health snapshot separately from CLOB health", async () => {
    await harness();
    await vi.advanceTimersByTimeAsync(1_000);
    const status = vi
      .mocked(process.stderr.write)
      .mock.calls.map(
        ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
      )
      .find((line) => line.reason_code === "STATUS");
    expect(status).toMatchObject({
      rtds: rtdsHealth,
      rtds_unknown_frames: 0,
      clob_silence: expect.any(Object),
      feeds: expect.any(Object),
    });
    expect(status?.rtds).toEqual(rtdsHealth);
    expect(status?.clob_silence).not.toEqual(rtdsHealth);
  });
});

afterEach(async () => {
  for (const orchestrator of live.splice(0)) await orchestrator.stop();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("OPS-02 — orchestrator CLOB silence integration", () => {
  it("persists one open gap for a silent open socket and closes it once only on valid book activity", async () => {
    const h = await harness();
    expect(pipeline.handleMessage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(silentInserts(h)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(silentInserts(h)).toHaveLength(1);
    const noise = [
      "PING",
      "PONG",
      "not-json",
      "{}",
      JSON.stringify({
        event_type: "last_trade_price",
        market: "market-a",
        asset_id: "token-a",
        timestamp: "1",
        price: "0.5",
        side: "BUY",
      }),
      JSON.stringify({
        event_type: "tick_size_change",
        market: "market-a",
        asset_id: "token-a",
        timestamp: "1",
        old_tick_size: "0.01",
        new_tick_size: "0.001",
      }),
      JSON.stringify({ ...book, asset_id: "outside-universe" }),
      JSON.stringify({ ...book, bids: [{ price: "1.1", size: "2" }] }),
      JSON.stringify({ ...book, asks: [{ price: "0.5", size: "-1" }] }),
    ];
    for (const raw of noise) h.sockets[0]?.emit(raw);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(silentInserts(h)).toHaveLength(1);
    expect(closes(h)).toHaveLength(0);
    h.sockets[0]?.emit(
      JSON.stringify({
        ...book,
        hash: "recovered",
        timestamp: "1789088550000",
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    h.sockets[1]?.emit(
      JSON.stringify({
        ...book,
        hash: "recovered",
        timestamp: "1789088550000",
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(closes(h)).toHaveLength(1);
    expect(pipeline.seedBook).not.toHaveBeenCalled();
  });

  it("renews observation on a duplicate valid book even when the minimum threshold equals the dedupe window", async () => {
    vi.stubEnv("GANSO_CLOB_SILENCE_MS", "30000");
    const h = await harness();
    await vi.advanceTimersByTimeAsync(20_000);
    h.sockets[1]?.emit(JSON.stringify(book));
    expect(pipeline.handleMessage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(silentInserts(h)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(silentInserts(h)).toHaveLength(1);
  });

  it.each(["blind", "venue_quiet", "unavailable"] as const)(
    "persists %s from REST controls without refreshing the book cache",
    async (classification) => {
      let calls = 0;
      const h = await harness(async () => {
        calls += 1;
        if (classification === "unavailable")
          return new Response("unavailable", { status: 503 });
        return Response.json(
          classification === "blind" && calls === 2
            ? { ...restBook, bids: [{ price: "0.45", size: "10" }] }
            : restBook,
        );
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(h.fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.fetcher).toHaveBeenCalledTimes(
        classification === "unavailable" ? 1 : 2,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      for (const [url] of h.fetcher.mock.calls)
        expect(String(url)).toContain("/book?token_id=token-a");
      expect(persistedClassification(h, classification)).toBe(true);
      expect(pipeline.seedBook).not.toHaveBeenCalled();
      expect(closes(h)).toHaveLength(0);
    },
  );

  it.each([
    { bids: book.bids, asks: book.asks },
    { ...restBook, asset_id: "wrong-token" },
    { ...restBook, bids: "not-an-array" },
    { ...restBook, bids: [{ price: "1.01", size: "10" }] },
    { ...restBook, asks: [{ price: "0.6", size: "-1" }] },
  ])("classifies invalid REST payload as unavailable: %j", async (payload) => {
    const h = await harness(async () => Response.json(payload));
    await vi.advanceTimersByTimeAsync(151_000);
    expect(persistedClassification(h, "unavailable")).toBe(true);
    expect(pipeline.seedBook).not.toHaveBeenCalled();
    expect(closes(h)).toHaveLength(0);
  });

  it("aborts an in-flight REST control at shutdown and leaves no timers or reconnects", async () => {
    let signal: AbortSignal | null | undefined;
    const h = await harness(async (_url, init) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    await h.orchestrator.stop();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const socketCount = h.sockets.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.sockets).toHaveLength(socketCount);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it("times out a stalled REST control after 10 seconds without overlapping requests", async () => {
    let signal: AbortSignal | null | undefined;
    const h = await harness(async (_url, init) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });
    await vi.advanceTimersByTimeAsync(129_999);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(persistedClassification(h, "unavailable")).toBe(true);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(pipeline.seedBook).not.toHaveBeenCalled();
  });
});
