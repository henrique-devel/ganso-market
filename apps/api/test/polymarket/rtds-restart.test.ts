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
} from "../../src/polymarket/rtds.js";

const epoch = Date.parse("2026-09-11T12:00:00Z");
const topics = {
  spot: "crypto_prices",
  twap30: "crypto_prices_twap_thirty",
  twap60: "crypto_prices_twap_sixty",
};
interface Gap {
  start: Date;
  end: Date | null;
  details: Record<string, unknown>;
}

class RestartDb implements DatabasePool {
  readonly gaps = new Map<string, Gap>();
  readonly writes: Gap[] = [];
  restoreCalls = 0;
  failRestore = false;
  restoreWait: Promise<void> | undefined;

  async query<R extends Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    if (sql.includes("SELECT gap_start, details_json")) {
      this.restoreCalls += 1;
      if (this.failRestore) throw new Error("restore unavailable");
      await this.restoreWait;
      const rows = [...this.gaps.values()]
        .filter((gap) => gap.end === null && gap.start <= (params[0] as Date))
        .slice(0, Number(params[1]))
        .map((gap) => ({
          gap_start: gap.start,
          details_json: structuredClone(gap.details),
        }));
      return { rows: rows as unknown as R[], rowCount: rows.length };
    }
    if (sql.includes("INSERT INTO polymarket_data_gaps")) {
      const details = JSON.parse(params[3] as string) as Record<
        string,
        unknown
      >;
      const id = details.episode_id as string;
      const prior = this.gaps.get(id);
      const gap = {
        start: params[0] as Date,
        end: prior?.end ?? (params[1] as Date | null),
        details,
      };
      this.gaps.set(id, gap);
      this.writes.push(structuredClone(gap));
    }
    return { rows: [], rowCount: 1 };
  }
  transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return run(this);
  }
  readOnly<T>(
    _timeout: number,
    run: (tx: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    return run(this);
  }
  async end(): Promise<void> {}
}

class Socket implements MarketSocket {
  readonly sent: string[] = [];
  opened: (() => void) | undefined;
  message: ((raw: string) => void) | undefined;
  closed: (() => void) | undefined;
  onOpen(handler: () => void): void {
    this.opened = handler;
  }
  onMessage(handler: (raw: string) => void): void {
    this.message = handler;
  }
  onClose(handler: () => void): void {
    this.closed = handler;
  }
  send(raw: string): void {
    this.sent.push(raw);
  }
  close(): void {
    this.closed?.();
  }
  price(feed: RtdsFeed = "spot"): void {
    this.message?.(
      JSON.stringify({
        topic: topics[feed],
        type: "update",
        payload: {
          symbol: feed === "spot" ? "btcusdt" : "btc/usd",
          price: "50000",
          timestamp: Date.now(),
        },
      }),
    );
  }
}

const recorders: RtdsRecorder[] = [];
function harness(db = new RestartDb(), silenceMs = 30_000) {
  const sockets: Socket[] = [];
  const recorder = createRtdsRecorder({
    pool: db,
    symbols: ["btc/usd"],
    silenceMs,
    socketFactory: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
    clock: Date.now,
  });
  recorders.push(recorder);
  recorder.start();
  const socket = sockets[0]!;
  socket.opened?.();
  return { db, recorder, socket, sockets };
}
async function drain(): Promise<void> {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
}
function seed(
  db: RestartDb,
  id: string,
  details: Record<string, unknown>,
): void {
  db.gaps.set(id, {
    start: new Date(epoch - 60_000),
    end: null,
    details: { episode_id: id, attempts: [], ...details },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(async () => {
  for (const recorder of recorders.splice(0)) await recorder.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("RTDS persisted silence across process restart", () => {
  it("preserves an exhausted reconnect budget across process restart", async () => {
    const db = new RestartDb();
    const attempts = [
      { action: "resubscribe", at: new Date(epoch - 60_000).toISOString() },
      ...[1, 2, 3].map((ordinal) => ({
        action: "reconnect",
        ordinal,
        at: new Date(epoch - 50_000 + ordinal * 1_000).toISOString(),
      })),
    ];
    seed(db, "exhausted", { scope: "global", attempts });
    const h = harness(db);
    await drain();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.recorder.health().recovery).toEqual({
      resubscribes: 1,
      reconnects: 3,
      exhausted: true,
    });
    expect(h.sockets).toHaveLength(1);
    expect(db.gaps.get("exhausted")?.details.attempts).toEqual(attempts);
    for (const feed of ["spot", "twap30", "twap60"] as const)
      h.socket.price(feed);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.recorder.health().openGaps).toBe(0);
    expect(db.gaps.get("exhausted")?.end).not.toBeNull();
  });

  it("does not shorten a one-hour silence threshold to a five-minute reconnect interval", async () => {
    const db = new RestartDb();
    seed(db, "old-global", { scope: "global" });
    const h = harness(db, 3_600_000);
    await drain();
    await vi.advanceTimersByTimeAsync(1_000);
    vi.setSystemTime(epoch + 3_600_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]?.opened?.();
    const actions = db.gaps.get("old-global")?.details.attempts as Record<
      string,
      unknown
    >[];
    expect(actions.at(-1)).toMatchObject({
      action: "reconnect",
      ordinal: 1,
      next_attempt_at: new Date(epoch + 7_201_000).toISOString(),
    });
    vi.setSystemTime(epoch + 3_901_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sockets).toHaveLength(2);
    vi.setSystemTime(epoch + 7_200_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sockets).toHaveLength(3);
  });

  it("restores existing identities and closes each scope only on its first new valid price", async () => {
    const first = harness();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(first.db.gaps.size).toBe(4);
    const ids = [...first.db.gaps.keys()];
    await first.recorder.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    const next = harness(first.db);
    await drain();
    expect(next.recorder.health()).toMatchObject({
      restorePending: false,
      openGaps: 4,
    });
    expect(next.recorder.health().recovery.resubscribes).toBe(1);
    next.socket.message?.("PONG");
    next.socket.message?.(
      JSON.stringify({
        topic: topics.twap30,
        type: "heartbeat",
        payload: {
          symbol: "btc/usd",
          price: "50000",
        },
      }),
    );
    await drain();
    expect([...next.db.gaps.values()].every((gap) => gap.end === null)).toBe(
      true,
    );
    next.socket.price();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(next.recorder.health().openGaps).toBe(2);
    const spotClosures = next.db.writes.filter(
      (gap) => gap.end !== null,
    ).length;
    next.socket.price();
    await drain();
    expect(next.db.writes.filter((gap) => gap.end !== null)).toHaveLength(
      spotClosures,
    );
    next.socket.price("twap30");
    next.socket.price("twap60");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(next.recorder.health().openGaps).toBe(0);
    expect([...next.db.gaps.keys()]).toEqual(ids);
    expect([...next.db.gaps.values()].every((gap) => gap.end !== null)).toBe(
      true,
    );
    expect(
      [...next.db.gaps.values()].every(
        (gap) => (gap.details.attempts as unknown[]).length === 1,
      ),
    ).toBe(true);
  });

  it("retries a failed restore without blocking observation and uses the first receipt before hydration", async () => {
    const db = new RestartDb();
    seed(db, "global-old", { scope: "global" });
    seed(db, "twap-old", {
      scope: "series",
      feed: "twap30",
      symbol: "btc/usd",
    });
    db.failRestore = true;
    const h = harness(db);
    await drain();
    expect(h.recorder.health()).toMatchObject({
      restorePending: true,
      restoreFailures: 1,
    });
    await vi.advanceTimersByTimeAsync(500);
    h.socket.price();
    await vi.advanceTimersByTimeAsync(100);
    h.socket.price("twap30");
    let finish!: () => void;
    db.restoreWait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    db.failRestore = false;
    await vi.advanceTimersByTimeAsync(1_400);
    expect(db.restoreCalls).toBe(2);
    h.socket.price();
    h.socket.price("twap30");
    finish();
    await drain();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.recorder.health()).toMatchObject({
      restorePending: false,
      restoreFailures: 1,
      openGaps: 0,
    });
    expect(db.gaps.get("global-old")?.end?.getTime()).toBe(epoch + 500);
    expect(db.gaps.get("twap-old")?.end?.getTime()).toBe(epoch + 600);
  });

  it("keeps a removed subscription visible without attempting recovery or healing it from another symbol", async () => {
    const db = new RestartDb();
    seed(db, "eth-old", { scope: "series", feed: "spot", symbol: "eth/usd" });
    const h = harness(db);
    await drain();
    await vi.advanceTimersByTimeAsync(29_000);
    for (const feed of ["spot", "twap30", "twap60"] as const)
      h.socket.price(feed);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.recorder.health()).toMatchObject({
      openGaps: 1,
      recovery: { resubscribes: 0, reconnects: 0 },
    });
    expect(db.gaps.get("eth-old")?.end).toBeNull();
    expect(h.sockets).toHaveLength(1);
    expect(
      h.socket.sent.filter((raw) => raw.includes('"action":"subscribe"')),
    ).toHaveLength(1);
  });

  it("ignores a restore read that completes after stop", async () => {
    const db = new RestartDb();
    seed(db, "old", { scope: "global" });
    let finish!: () => void;
    db.restoreWait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const h = harness(db);
    await h.recorder.stop();
    finish();
    await drain();
    expect(h.recorder.health().openGaps).toBe(0);
    expect(db.writes).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
