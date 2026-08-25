import { describe, expect, it } from "vitest";

import {
  ADAPTER_EVENT_SIGNATURES,
  adapterTopicMap,
  decodeAdapterLog,
  type AdapterEventName,
  type DecodedAdapterEvent,
  type RpcLog,
} from "../../../src/polymarket/resolution/abi.js";
import { keccak256Utf8Hex } from "../../../src/polymarket/resolution/keccak.js";

// --- tiny hex builders: the logs are constructed word by word IN the test ---

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
const INT256_MIN_DECIMAL =
  "-57896044618658097711785492504343953926634992332820282019728792003956564819968";

function makeLog(overrides: Partial<RpcLog>): RpcLog {
  return {
    address: "0x157ce2d672aeb38845bdd5cdc92dfc4f0e2e13cc",
    topics: [],
    data: "0x",
    blockNumber: "0x1b4",
    transactionHash: TX_HASH,
    logIndex: "0x0",
    ...overrides,
  };
}

function mustDecode(log: RpcLog): DecodedAdapterEvent {
  const decoded = decodeAdapterLog(log);
  if (decoded === null) {
    throw new Error("expected the log to decode");
  }
  return decoded;
}

describe("adapterTopicMap", () => {
  it("has exactly 9 entries with 0x + 64 lowercase hex keys", () => {
    const map = adapterTopicMap();
    expect(map.size).toBe(9);
    for (const key of map.keys()) {
      expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it("maps the QuestionReset(bytes32) topic0 to QuestionReset", () => {
    expect(adapterTopicMap().get(topicFor("QuestionReset"))).toBe(
      "QuestionReset",
    );
  });

  it("derives 1:1 from keccak over ADAPTER_EVENT_SIGNATURES", () => {
    const map = adapterTopicMap();
    expect(ADAPTER_EVENT_SIGNATURES.length).toBe(map.size);
    for (const entry of ADAPTER_EVENT_SIGNATURES) {
      expect(map.get(`0x${keccak256Utf8Hex(entry.signature)}`)).toBe(
        entry.name,
      );
    }
  });
});

describe("decodeAdapterLog QuestionInitialized", () => {
  const ancillaryText = "q: will it rain?";
  const ancillaryBytes = new TextEncoder().encode(ancillaryText);
  const log = makeLog({
    topics: [
      topicFor("QuestionInitialized"),
      QUESTION_ID,
      `0x${word(1734000000)}`,
      `0x${addressWord(CREATOR)}`,
    ],
    // Head: [0] offset to ancillaryData (4 words = 128 bytes), [1] token,
    // [2] reward, [3] proposalBond; tail: length word + padded payload.
    data:
      "0x" +
      word(128) +
      addressWord(USDC) +
      word(750000000) +
      word(750000000) +
      dynamicBytes(ancillaryBytes),
  });

  it("decodes every field", () => {
    const decoded = mustDecode(log);
    expect(decoded.eventName).toBe("QuestionInitialized");
    expect(decoded.questionId).toBe(QUESTION_ID);
    expect(decoded.blockNumber).toBe(436n);
    expect(decoded.txHash).toBe(TX_HASH);
    expect(decoded.logIndex).toBe(0);
    expect(decoded.args["requestTimestamp"]).toBe("1734000000");
    expect(decoded.args["creator"]).toBe(CREATOR);
    expect(decoded.args["rewardToken"]).toBe(USDC);
    expect(decoded.args["reward"]).toBe("750000000");
    expect(decoded.args["proposalBond"]).toBe("750000000");
    expect(decoded.args["truncated"]).toBe(false);
    const expectedHex =
      "0x" +
      Array.from(ancillaryBytes, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    expect(decoded.args["ancillaryDataHex"]).toBe(expectedHex);
    expect(String(decoded.args["ancillaryDataUtf8"])).toContain("will it rain");
    expect(decoded.args["ancillaryDataUtf8"]).toBe(ancillaryText);
  });
});

describe("decodeAdapterLog QuestionResolved", () => {
  const payoutsData = `0x${word(32)}${word(2)}${word(1)}${word(0)}`;

  it("decodes a positive settled price", () => {
    // +1e18 as an indexed int256 topic word.
    const priceTopic = `0x${"0".repeat(48)}0de0b6b3a7640000`;
    expect(priceTopic).toBe(`0x${word(10n ** 18n)}`);
    const decoded = mustDecode(
      makeLog({
        topics: [topicFor("QuestionResolved"), QUESTION_ID, priceTopic],
        data: payoutsData,
        logIndex: "0x2a",
      }),
    );
    expect(decoded.eventName).toBe("QuestionResolved");
    expect(decoded.args["settledPrice"]).toBe("1000000000000000000");
    expect(decoded.args["tooEarly"]).toBe(false);
    expect(decoded.args["payouts"]).toEqual(["1", "0"]);
    expect(decoded.logIndex).toBe(42);
  });

  it("decodes type(int256).min as the too-early sentinel", () => {
    expect(INT256_MIN_DECIMAL).toBe((-(2n ** 255n)).toString(10));
    const decoded = mustDecode(
      makeLog({
        topics: [
          topicFor("QuestionResolved"),
          QUESTION_ID,
          `0x8${"0".repeat(63)}`,
        ],
        data: `0x${word(32)}${word(2)}${word(1)}${word(1)}`,
      }),
    );
    expect(decoded.args["settledPrice"]).toBe(INT256_MIN_DECIMAL);
    expect(decoded.args["tooEarly"]).toBe(true);
  });
});

describe("decodeAdapterLog payout-only and empty-args events", () => {
  it("decodes QuestionEmergencyResolved with the [1, 1] payout vector", () => {
    const decoded = mustDecode(
      makeLog({
        topics: [topicFor("QuestionEmergencyResolved"), QUESTION_ID],
        data: `0x${word(32)}${word(2)}${word(1)}${word(1)}`,
      }),
    );
    expect(decoded.eventName).toBe("QuestionEmergencyResolved");
    expect(decoded.args["payouts"]).toEqual(["1", "1"]);
  });

  it("decodes QuestionManuallyResolved payouts", () => {
    const decoded = mustDecode(
      makeLog({
        topics: [topicFor("QuestionManuallyResolved"), QUESTION_ID],
        data: `0x${word(32)}${word(2)}${word(0)}${word(1)}`,
      }),
    );
    expect(decoded.args["payouts"]).toEqual(["0", "1"]);
  });

  it("decodes the five lifecycle flags with empty args", () => {
    const names: readonly AdapterEventName[] = [
      "QuestionPaused",
      "QuestionUnpaused",
      "QuestionFlagged",
      "QuestionUnflagged",
      "QuestionReset",
    ];
    for (const name of names) {
      const decoded = mustDecode(
        makeLog({ topics: [topicFor(name), QUESTION_ID] }),
      );
      expect(decoded.eventName).toBe(name);
      expect(decoded.questionId).toBe(QUESTION_ID);
      expect(decoded.args).toEqual({});
    }
  });
});

describe("decodeAdapterLog quantities", () => {
  it('parses blockNumber "0x1b4" as 436n and logIndex "0x0" as 0', () => {
    const decoded = mustDecode(
      makeLog({
        topics: [topicFor("QuestionPaused"), QUESTION_ID],
        blockNumber: "0x1b4",
        logIndex: "0x0",
      }),
    );
    expect(decoded.blockNumber).toBe(436n);
    expect(decoded.logIndex).toBe(0);
  });
});

describe("decodeAdapterLog malformed inputs return null, never throw", () => {
  const resolvedTopics = [
    topicFor("QuestionResolved"),
    QUESTION_ID,
    `0x${word(10n ** 18n)}`,
  ];

  it("unknown topic0", () => {
    expect(
      decodeAdapterLog(
        makeLog({ topics: [`0x${"ff".repeat(32)}`, QUESTION_ID] }),
      ),
    ).toBeNull();
  });

  it("data shorter than the head", () => {
    expect(
      decodeAdapterLog(
        makeLog({
          topics: [
            topicFor("QuestionInitialized"),
            QUESTION_ID,
            `0x${word(1734000000)}`,
            `0x${addressWord(CREATOR)}`,
          ],
          data: `0x${word(128)}`,
        }),
      ),
    ).toBeNull();
  });

  it("dynamic offset beyond the data", () => {
    expect(
      decodeAdapterLog(
        makeLog({ topics: resolvedTopics, data: `0x${word(4096)}` }),
      ),
    ).toBeNull();
  });

  it("array length over the 64-item cap", () => {
    const items = Array.from({ length: 65 }, () => word(1)).join("");
    expect(
      decodeAdapterLog(
        makeLog({
          topics: resolvedTopics,
          data: `0x${word(32)}${word(65)}${items}`,
        }),
      ),
    ).toBeNull();
  });

  it("array longer than the data claims", () => {
    expect(
      decodeAdapterLog(
        makeLog({
          topics: resolvedTopics,
          data: `0x${word(32)}${word(2)}${word(1)}`,
        }),
      ),
    ).toBeNull();
  });

  it("odd-length hex data", () => {
    expect(
      decodeAdapterLog(makeLog({ topics: resolvedTopics, data: "0x123" })),
    ).toBeNull();
  });

  it("data missing the 0x prefix", () => {
    const body = `${word(32)}${word(2)}${word(1)}${word(0)}`;
    expect(
      decodeAdapterLog(makeLog({ topics: resolvedTopics, data: body })),
    ).toBeNull();
  });

  it("questionId topic missing the 0x prefix", () => {
    expect(
      decodeAdapterLog(
        makeLog({ topics: [topicFor("QuestionPaused"), "11".repeat(32)] }),
      ),
    ).toBeNull();
  });

  it("missing indexed topics", () => {
    expect(
      decodeAdapterLog(
        makeLog({
          topics: [topicFor("QuestionResolved"), QUESTION_ID],
          data: `0x${word(32)}${word(2)}${word(1)}${word(0)}`,
        }),
      ),
    ).toBeNull();
    expect(
      decodeAdapterLog(makeLog({ topics: [topicFor("QuestionPaused")] })),
    ).toBeNull();
  });

  it("malformed quantities", () => {
    const topics = [topicFor("QuestionPaused"), QUESTION_ID];
    expect(decodeAdapterLog(makeLog({ topics, blockNumber: "0x" }))).toBeNull();
    expect(decodeAdapterLog(makeLog({ topics, logIndex: "12" }))).toBeNull();
  });
});
