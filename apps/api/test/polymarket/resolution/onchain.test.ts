// RFC-012 phase C: the onchain UMA adapter collector. Pure payout mapping,
// one full polling pass against a fake JSON-RPC endpoint (dispatching on the
// JSON-RPC method) plus a fake pool, RPC URL failover, and the fold of raw
// adapter events into the request timeline (request_index semantics and the
// negRisk 50/50 impossibility).

import { describe, expect, it } from "vitest";

import type { QueryResult } from "../../../src/database.js";
import {
  ADAPTER_EVENT_SIGNATURES,
  type AdapterEventName,
} from "../../../src/polymarket/resolution/abi.js";
import type { OnchainConfig } from "../../../src/polymarket/resolution/config.js";
import { keccak256Utf8Hex } from "../../../src/polymarket/resolution/keccak.js";
import {
  applyOnchainTimeline,
  pollOnchainOnce,
  resultFromPayouts,
  type OnchainDeps,
} from "../../../src/polymarket/resolution/onchain.js";
import type { ResolutionPool } from "../../../src/polymarket/resolution/types.js";

type Row = Record<string, unknown>;
type FetchFn = NonNullable<OnchainDeps["fetchFn"]>;

// --- log word builders, same approach as abi.test.ts ---

function word(value: bigint | number): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

function addressWord(address: string): string {
  return address.slice(2).toLowerCase().padStart(64, "0");
}

/** Dynamic bytes tail: length word + payload padded to a 32-byte boundary. */
function dynamicBytes(payload: Uint8Array): string {
  let hex = word(payload.length);
  for (const byte of payload) {
    hex += byte.toString(16).padStart(2, "0");
  }
  const remainder = payload.length % 32;
  if (remainder !== 0) {
    hex += "00".repeat(32 - remainder);
  }
  return hex;
}

function topicFor(name: AdapterEventName): string {
  const entry = ADAPTER_EVENT_SIGNATURES.find((e) => e.name === name);
  if (entry === undefined) {
    throw new Error(`no signature listed for ${name}`);
  }
  return `0x${keccak256Utf8Hex(entry.signature)}`;
}

const QUESTION_ID = `0x${"11".repeat(32)}`;
const TX_HASH = `0x${"ab".repeat(32)}`;
const CREATOR = "0x91430cad2d3975766499717fa0d66a78d814e5c5";
const USDC = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const ADAPTER_A = "0x6a9d222616c90fca5754cd1333cfd9b7fb6a4f74";
const ADAPTER_B = "0x157ce2d672854c848c9b79c49a8cc6cc89176a49";

// head 10_000_000, confirmations 60 -> target 9_999_940; first boot with
// lookback 5_000 -> cursor 9_994_940, so the first chunk is
// [9_994_941, 9_996_940] and the second [9_996_941, 9_998_940].
const HEAD = 10_000_000n;
const LOG_BLOCK = 9_995_000n;
const BLOCK_TS = 1_724_500_000;

const INITIALIZED_LOG = {
  address: ADAPTER_A,
  topics: [
    topicFor("QuestionInitialized"),
    QUESTION_ID,
    `0x${word(BLOCK_TS)}`, // requestTimestamp 1724500000
    `0x${addressWord(CREATOR)}`,
  ],
  // Head: [0] offset to ancillaryData (4 words), [1] rewardToken,
  // [2] reward 5e6, [3] proposalBond 750e6; tail: the bytes payload.
  data:
    "0x" +
    word(128) +
    addressWord(USDC) +
    word(5_000_000) +
    word(750_000_000) +
    dynamicBytes(new TextEncoder().encode("q: test?")),
  blockNumber: `0x${LOG_BLOCK.toString(16)}`,
  transactionHash: TX_HASH,
  logIndex: "0x0",
};

interface RpcCall {
  readonly url: string;
  readonly method: string;
  readonly params: readonly unknown[];
}

/** JSON-RPC fake: dispatches on the method in the request body. */
function makeFetch(
  record: RpcCall[],
  failingUrls: readonly string[] = [],
): FetchFn {
  return (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as {
      method?: string;
      params?: unknown[];
    };
    const method = body.method ?? "";
    const params = body.params ?? [];
    record.push({ url, method, params });
    if (failingUrls.includes(url)) {
      return Promise.reject(new Error(`unreachable ${url}`));
    }
    const respond = (result: unknown): ReturnType<FetchFn> =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result }),
      });
    if (method === "eth_blockNumber") {
      return respond(`0x${HEAD.toString(16)}`);
    }
    if (method === "eth_getLogs") {
      const filter = params[0] as {
        address?: string;
        fromBlock?: string;
        toBlock?: string;
        topics?: unknown[];
      };
      const from = BigInt(filter.fromBlock ?? "0x0");
      const to = BigInt(filter.toBlock ?? "0x0");
      // Exactly one QuestionInitialized log, on the FIRST adapter only.
      if (
        filter.address === ADAPTER_A &&
        from <= LOG_BLOCK &&
        LOG_BLOCK <= to
      ) {
        return respond([INITIALIZED_LOG]);
      }
      return respond([]);
    }
    if (method === "eth_getBlockByNumber") {
      return respond({ timestamp: `0x${BLOCK_TS.toString(16)}` });
    }
    return respond(null);
  };
}

function configOf(overrides: Partial<OnchainConfig> = {}): OnchainConfig {
  return {
    enabled: true,
    rpcUrls: ["https://rpc.test"],
    adapters: [ADAPTER_A, ADAPTER_B],
    confirmations: 60,
    chunkBlocks: 2_000,
    maxChunksPerPoll: 2,
    lookbackBlocks: 5_000,
    requestTimeoutMs: 5_000,
    ...overrides,
  };
}

interface Recorded {
  readonly text: string;
  readonly params: readonly unknown[];
}

interface PollRecord {
  events: Recorded[];
  cursors: Recorded[];
  timeline: Recorded[];
}

/** Fake pool for a first-boot poll: no cursors, every insert lands. */
function pollPool(record: PollRecord): ResolutionPool {
  return {
    query<R extends Row>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      const respond = (
        rows: Row[],
        rowCount = rows.length,
      ): Promise<QueryResult<R>> =>
        Promise.resolve({ rows: rows as R[], rowCount });
      if (text.includes("INSERT INTO resolution_onchain_events")) {
        record.events.push({ text, params });
        return respond([], 1);
      }
      if (text.includes("INSERT INTO resolution_onchain_cursor")) {
        record.cursors.push({ text, params });
        return respond([], 1);
      }
      if (text.includes("FROM resolution_onchain_cursor")) {
        return respond([]); // first boot: no cursor rows yet
      }
      if (text.includes("SELECT question_id FROM polymarket_markets")) {
        // Budget guard input: the collected question is a known market.
        return respond([{ question_id: QUESTION_ID }]);
      }
      if (text.includes("INSERT INTO resolution_uma_timeline")) {
        record.timeline.push({ text, params });
        return respond([], 1);
      }
      if (text.includes("FROM resolution_onchain_events e")) {
        // Registry mapping: the collected question belongs to market 0xmkt.
        return respond([
          {
            onchain_event_id: 1,
            event_name: "QuestionInitialized",
            question_id: QUESTION_ID,
            args_json: {
              requestTimestamp: "1724500000",
              proposalBond: "750000000",
            },
            block_ts: new Date(BLOCK_TS * 1_000),
            received_at: new Date(BLOCK_TS * 1_000),
            tx_hash: TX_HASH,
            log_index: 0,
            condition_id: "0xmkt",
            neg_risk: false,
          },
        ]);
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

describe("resultFromPayouts", () => {
  it("maps the adapter payout vectors to P1/P2/P3", () => {
    expect(resultFromPayouts(["1", "0"], false)).toBe("P2");
    expect(resultFromPayouts(["0", "1"], false)).toBe("P1");
    expect(resultFromPayouts(["1", "1"], false)).toBe("P3");
  });

  it("maps too-early to P4", () => {
    expect(resultFromPayouts(null, true)).toBe("P4");
  });

  it("gives tooEarly precedence over the payout vector", () => {
    expect(resultFromPayouts(["1", "0"], true)).toBe("P4");
  });

  it("refuses vectors it cannot classify", () => {
    expect(resultFromPayouts(["2", "1"], false)).toBeNull();
    expect(resultFromPayouts(null, false)).toBeNull();
  });
});

describe("pollOnchainOnce", () => {
  it("scans bounded chunks behind the head, persists the log and folds it", async () => {
    const record: PollRecord = { events: [], cursors: [], timeline: [] };
    const rpcCalls: RpcCall[] = [];
    const summary = await pollOnchainOnce({
      pool: pollPool(record),
      config: configOf(),
      fetchFn: makeFetch(rpcCalls),
    });

    expect(summary).not.toBeNull();
    expect(summary?.inserted).toBe(1);
    expect(summary?.adapters).toBe(2);
    expect(summary?.decodedUnknown).toBe(0);
    expect(summary?.toBlock).toBe(9_998_940n);

    // The event insert carries adapter, event name, questionId and the
    // block_ts derived from eth_getBlockByNumber.
    expect(record.events).toHaveLength(1);
    const eventParams = record.events[0]?.params ?? [];
    expect(eventParams[0]).toBe(ADAPTER_A);
    expect(eventParams[1]).toBe("QuestionInitialized");
    expect(eventParams[2]).toBe(QUESTION_ID);
    expect(eventParams[4]).toBe(LOG_BLOCK.toString(10));
    expect(eventParams[5]).toBeInstanceOf(Date);
    expect((eventParams[5] as Date).getTime()).toBe(BLOCK_TS * 1_000);
    const args = JSON.parse(String(eventParams[3])) as Row;
    expect(args.reward).toBe("5000000");
    expect(args.proposalBond).toBe("750000000");
    expect(args.ancillaryDataUtf8).toBe("q: test?");

    // The cursor advances chunk by chunk, per adapter.
    expect(record.cursors.map((c) => [c.params[0], c.params[1]])).toEqual([
      [ADAPTER_A, "9996940"],
      [ADAPTER_A, "9998940"],
      [ADAPTER_B, "9996940"],
      [ADAPTER_B, "9998940"],
    ]);

    // fromBlock = head - confirmations - lookback + 1, toBlock chunk-capped.
    const getLogs = rpcCalls.filter((c) => c.method === "eth_getLogs");
    expect(getLogs).toHaveLength(4);
    const first = getLogs[0]?.params[0] as {
      address?: string;
      fromBlock?: string;
      toBlock?: string;
      topics?: unknown[];
    };
    expect(first.address).toBe(ADAPTER_A);
    expect(first.fromBlock).toBe(`0x${(9_994_941).toString(16)}`);
    expect(first.toBlock).toBe(`0x${(9_996_940).toString(16)}`);
    expect((first.topics?.[0] as string[]).length).toBe(9);
    const second = getLogs[1]?.params[0] as {
      fromBlock?: string;
      toBlock?: string;
    };
    expect(second.fromBlock).toBe(`0x${(9_996_941).toString(16)}`);
    expect(second.toBlock).toBe(`0x${(9_998_940).toString(16)}`);

    // block_ts came from exactly one eth_getBlockByNumber on the log's block.
    const blockCalls = rpcCalls.filter(
      (c) => c.method === "eth_getBlockByNumber",
    );
    expect(blockCalls).toHaveLength(1);
    expect(blockCalls[0]?.params[0]).toBe(`0x${LOG_BLOCK.toString(16)}`);

    // inserted > 0 triggered the timeline fold: proposed, request 1, onchain.
    expect(record.timeline).toHaveLength(1);
    const timeline = record.timeline[0];
    expect(timeline?.text).toContain("'onchain'");
    expect(timeline?.params[2]).toBe(1);
    expect(timeline?.params[3]).toBe("proposed");
    expect(timeline?.params[6]).toBe("750000000");
  });

  it("skips events whose questionID names no recorded market (budget guard)", async () => {
    const record: PollRecord = { events: [], cursors: [], timeline: [] };
    const basePool = pollPool(record);
    // Same world, but the registry knows no question ids: nothing is stored.
    const pool: ResolutionPool = {
      query: (text, params) =>
        text.includes("SELECT question_id FROM polymarket_markets")
          ? Promise.resolve({ rows: [], rowCount: 0 })
          : basePool.query(text, params),
    };
    const summary = await pollOnchainOnce({
      pool,
      config: configOf(),
      fetchFn: makeFetch([]),
    });
    expect(summary?.inserted).toBe(0);
    expect(summary?.skippedUnmapped).toBe(1);
    expect(record.events).toHaveLength(0);
    // The cursor still advances: the scan happened, the data was filtered.
    expect(record.cursors.length).toBeGreaterThan(0);
  });

  it("returns null without touching the network when disabled", async () => {
    let fetchCalled = false;
    const untouchablePool: ResolutionPool = {
      query: () => {
        throw new Error("pool must not be touched");
      },
    };
    const summary = await pollOnchainOnce({
      pool: untouchablePool,
      config: configOf({ enabled: false }),
      fetchFn: () => {
        fetchCalled = true;
        return Promise.reject(new Error("fetch must not be called"));
      },
    });
    expect(summary).toBeNull();
    expect(fetchCalled).toBe(false);
  });

  it("fails over to the second RPC URL when the first is unreachable", async () => {
    const record: PollRecord = { events: [], cursors: [], timeline: [] };
    const rpcCalls: RpcCall[] = [];
    const summary = await pollOnchainOnce({
      pool: pollPool(record),
      config: configOf({
        rpcUrls: ["https://down.rpc.test", "https://rpc.test"],
        requestTimeoutMs: 50,
      }),
      fetchFn: makeFetch(rpcCalls, ["https://down.rpc.test"]),
    });
    expect(summary?.inserted).toBe(1);
    expect(rpcCalls.some((c) => c.url === "https://down.rpc.test")).toBe(true);
    expect(
      rpcCalls.filter(
        (c) => c.method === "eth_blockNumber" && c.url === "https://rpc.test",
      ),
    ).toHaveLength(1);
  });
});

// --- applyOnchainTimeline state semantics over a crafted event sequence ---

function eventRow(overrides: Row): Row {
  return {
    onchain_event_id: 1,
    event_name: "QuestionInitialized",
    question_id: QUESTION_ID,
    args_json: {},
    block_ts: new Date("2026-08-01T00:00:00.000Z"),
    received_at: new Date("2026-08-01T00:00:00.000Z"),
    tx_hash: TX_HASH,
    log_index: 0,
    condition_id: "0xmkt",
    neg_risk: false,
    ...overrides,
  };
}

function timelinePool(rows: Row[], record: Recorded[]): ResolutionPool {
  return {
    query<R extends Row>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      if (text.includes("INSERT INTO resolution_uma_timeline")) {
        record.push({ text, params });
        return Promise.resolve({ rows: [] as R[], rowCount: 1 });
      }
      if (text.includes("FROM resolution_onchain_events e")) {
        return Promise.resolve({ rows: rows as R[], rowCount: rows.length });
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

describe("applyOnchainTimeline", () => {
  it("restarts the request after a reset and settles request 2 as P1", async () => {
    const record: Recorded[] = [];
    const written = await applyOnchainTimeline(
      timelinePool(
        [
          eventRow({
            event_name: "QuestionInitialized",
            args_json: { proposalBond: "750000000" },
            log_index: 0,
          }),
          eventRow({ event_name: "QuestionReset", log_index: 1 }),
          eventRow({
            event_name: "QuestionInitialized",
            args_json: { proposalBond: "1500000000" },
            log_index: 2,
          }),
          eventRow({
            event_name: "QuestionResolved",
            args_json: { payouts: ["0", "1"], tooEarly: false },
            log_index: 3,
          }),
        ],
        record,
      ),
    );
    expect(written).toBe(4);
    // [state, request_index, result] per insert, in event order.
    expect(record.map((r) => [r.params[3], r.params[2], r.params[4]])).toEqual([
      ["proposed", 1, null],
      ["reset", 1, null],
      ["proposed", 2, null],
      ["settled", 2, "P1"],
    ]);
    expect(record[3]?.params[5]).toBe(JSON.stringify(["0", "1"]));
    // The second request carries the escalated bond.
    expect(record[2]?.params[6]).toBe("1500000000");
  });

  it("records a negRisk 50/50 as settled with a null result (impossible)", async () => {
    const record: Recorded[] = [];
    const written = await applyOnchainTimeline(
      timelinePool(
        [
          eventRow({
            event_name: "QuestionResolved",
            args_json: { payouts: ["1", "1"], tooEarly: false },
            neg_risk: true,
          }),
        ],
        record,
      ),
    );
    expect(written).toBe(1);
    expect(record).toHaveLength(1);
    expect(record[0]?.params[3]).toBe("settled");
    expect(record[0]?.params[4]).toBeNull();
    expect(record[0]?.params[5]).toBe(JSON.stringify(["1", "1"]));
  });
});
