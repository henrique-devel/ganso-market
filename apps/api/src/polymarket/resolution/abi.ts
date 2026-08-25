/**
 * Minimal ABI decoding of exactly the UMA CTF Adapter lifecycle events, for
 * logs read from a public Polygon RPC via eth_getLogs (RFC-012). Signatures
 * verified against Polymarket/uma-ctf-adapter, src/interfaces/
 * IUmaCtfAdapter.sol at tag v2.0.0 and on v3/main. No dependency, no
 * network access: this module only turns raw log hex into JSON-safe values.
 * Malformed input decodes to null — decodeAdapterLog never throws.
 */

import { keccak256Utf8Hex } from "./keccak.js";

/** Raw log entry as returned by eth_getLogs on a JSON-RPC endpoint. */
export interface RpcLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string; // 0x-hex
  readonly blockNumber: string; // 0x-hex quantity
  readonly transactionHash: string;
  readonly logIndex: string; // 0x-hex quantity
}

export type AdapterEventName =
  | "QuestionInitialized"
  | "QuestionPaused"
  | "QuestionUnpaused"
  | "QuestionFlagged"
  | "QuestionUnflagged"
  | "QuestionReset"
  | "QuestionResolved"
  | "QuestionEmergencyResolved"
  | "QuestionManuallyResolved";

export interface DecodedAdapterEvent {
  readonly eventName: AdapterEventName;
  readonly questionId: string; // "0x" + 64 lowercase hex
  readonly args: Readonly<Record<string, unknown>>; // JSON-safe values only
  readonly blockNumber: bigint;
  readonly txHash: string; // lowercase
  readonly logIndex: number;
}

/**
 * Single source of truth for the adapter's event signatures. Every event has
 * questionID (bytes32) indexed in topics[1]. QuestionEmergencyResolved exists
 * only on the V2 adapter and QuestionManuallyResolved only on V3; both
 * deployments are watched, so both are listed.
 */
export const ADAPTER_EVENT_SIGNATURES: ReadonlyArray<{
  readonly name: AdapterEventName;
  readonly signature: string;
}> = [
  {
    name: "QuestionInitialized",
    signature:
      "QuestionInitialized(bytes32,uint256,address,bytes,address,uint256,uint256)",
  },
  { name: "QuestionPaused", signature: "QuestionPaused(bytes32)" },
  { name: "QuestionUnpaused", signature: "QuestionUnpaused(bytes32)" },
  { name: "QuestionFlagged", signature: "QuestionFlagged(bytes32)" },
  { name: "QuestionUnflagged", signature: "QuestionUnflagged(bytes32)" },
  { name: "QuestionReset", signature: "QuestionReset(bytes32)" },
  {
    name: "QuestionResolved",
    signature: "QuestionResolved(bytes32,int256,uint256[])",
  },
  {
    name: "QuestionEmergencyResolved",
    signature: "QuestionEmergencyResolved(bytes32,uint256[])",
  },
  {
    name: "QuestionManuallyResolved",
    signature: "QuestionManuallyResolved(bytes32,uint256[])",
  },
];

const WORD_HEX = 64; // one 32-byte word as hex chars
const MAX_ARRAY_ITEMS = 64; // defensive cap; adapter payouts arrays hold 2
const MAX_ANCILLARY_BYTES = 8192; // ancillary data kept per event, see decodeBytes
const TWO_POW_255 = 1n << 255n;
const TWO_POW_256 = 1n << 256n;
// type(int256).min — the adapter's "too early to resolve" sentinel price.
const INT256_MIN = -TWO_POW_255;

let cachedTopicMap: ReadonlyMap<string, AdapterEventName> | null = null;

/** topic0 ("0x" + keccak256Hex of the signature) -> event name; cached. */
export function adapterTopicMap(): ReadonlyMap<string, AdapterEventName> {
  if (cachedTopicMap === null) {
    const map = new Map<string, AdapterEventName>();
    for (const entry of ADAPTER_EVENT_SIGNATURES) {
      map.set(`0x${keccak256Utf8Hex(entry.signature)}`, entry.name);
    }
    cachedTopicMap = map;
  }
  return cachedTopicMap;
}

/** "0x"-prefixed even-length hex -> lowercase body without the prefix. */
function hexBody(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("0x")) {
    return null;
  }
  const body = value.slice(2).toLowerCase();
  if (body.length % 2 !== 0 || !/^[0-9a-f]*$/.test(body)) {
    return null;
  }
  return body;
}

/** Strict 32-byte word ("0x" + 64 hex, e.g. a topic) -> lowercase body. */
function topicWord(value: unknown): string | null {
  const body = hexBody(value);
  return body !== null && body.length === WORD_HEX ? body : null;
}

/** JSON-RPC quantity ("0x" + >= 1 hex digit; odd digit counts are legal). */
function quantity(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    return null;
  }
  return BigInt(value);
}

/** Word `index` of a data body, or null when the body is too short. */
function wordAt(data: string, index: number): string | null {
  const start = index * WORD_HEX;
  const end = start + WORD_HEX;
  return end <= data.length ? data.slice(start, end) : null;
}

function wordToUint(word: string): bigint {
  return BigInt(`0x${word}`);
}

/** int256 two's complement. */
function wordToInt(word: string): bigint {
  const value = wordToUint(word);
  return value >= TWO_POW_255 ? value - TWO_POW_256 : value;
}

/** Address = low 20 bytes of a word. Real logs zero-pad the high 12. */
function wordToAddress(word: string): string {
  return `0x${word.slice(24)}`;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Dynamic uint256[] whose offset lives in head word `headIndex`. Offsets are
 * byte offsets into data (2 hex chars per byte). Every read is bounds-checked
 * and the item count is capped: over MAX_ARRAY_ITEMS decodes to null.
 */
function decodeUintArray(data: string, headIndex: number): string[] | null {
  const head = wordAt(data, headIndex);
  if (head === null) {
    return null;
  }
  const offset = wordToUint(head);
  if (offset % 32n !== 0n || offset * 2n + BigInt(WORD_HEX) > data.length) {
    return null;
  }
  const lengthPos = Number(offset) * 2;
  const length = wordToUint(data.slice(lengthPos, lengthPos + WORD_HEX));
  if (length > BigInt(MAX_ARRAY_ITEMS)) {
    return null;
  }
  const count = Number(length);
  if (lengthPos + WORD_HEX + count * WORD_HEX > data.length) {
    return null;
  }
  const items: string[] = [];
  for (let i = 0; i < count; i++) {
    const start = lengthPos + WORD_HEX + i * WORD_HEX;
    items.push(wordToUint(data.slice(start, start + WORD_HEX)).toString(10));
  }
  return items;
}

interface DecodedBytes {
  readonly hex: string; // "0x" + payload hex, capped
  readonly utf8: string; // best-effort decode of the SAME capped payload
  readonly truncated: boolean;
}

/**
 * Dynamic bytes whose offset lives in head word `headIndex`. The declared
 * payload must fit inside data; only the first MAX_ANCILLARY_BYTES are kept
 * (ancillary data is question-author-controlled free text).
 */
function decodeBytes(data: string, headIndex: number): DecodedBytes | null {
  const head = wordAt(data, headIndex);
  if (head === null) {
    return null;
  }
  const offset = wordToUint(head);
  if (offset % 32n !== 0n || offset * 2n + BigInt(WORD_HEX) > data.length) {
    return null;
  }
  const lengthPos = Number(offset) * 2;
  const byteLength = wordToUint(data.slice(lengthPos, lengthPos + WORD_HEX));
  const payloadStart = lengthPos + WORD_HEX;
  if (BigInt(payloadStart) + byteLength * 2n > BigInt(data.length)) {
    return null;
  }
  const truncated = byteLength > BigInt(MAX_ANCILLARY_BYTES);
  const kept = truncated ? MAX_ANCILLARY_BYTES : Number(byteLength);
  const hex = data.slice(payloadStart, payloadStart + kept * 2);
  return {
    hex: `0x${hex}`,
    utf8: new TextDecoder("utf-8").decode(hexToBytes(hex)),
    truncated,
  };
}

/**
 * Decode one eth_getLogs entry into an adapter event. Returns null on
 * unknown topic0, malformed hex, short data or any bounds violation —
 * never throws.
 */
export function decodeAdapterLog(log: RpcLog): DecodedAdapterEvent | null {
  try {
    return decodeChecked(log);
  } catch {
    // The checks above should make this unreachable; the null contract
    // holds even for inputs those checks did not anticipate.
    return null;
  }
}

function decodeChecked(log: RpcLog): DecodedAdapterEvent | null {
  const topics = log.topics;
  if (!Array.isArray(topics)) {
    return null;
  }
  const topic0 = topicWord(topics[0]);
  if (topic0 === null) {
    return null;
  }
  const eventName = adapterTopicMap().get(`0x${topic0}`);
  if (eventName === undefined) {
    return null;
  }
  const question = topicWord(topics[1]);
  if (question === null) {
    return null;
  }
  const blockNumber = quantity(log.blockNumber);
  const logIndexBig = quantity(log.logIndex);
  const txBody = hexBody(log.transactionHash);
  if (
    blockNumber === null ||
    logIndexBig === null ||
    logIndexBig > BigInt(Number.MAX_SAFE_INTEGER) ||
    txBody === null ||
    txBody.length !== WORD_HEX
  ) {
    return null;
  }
  const data = hexBody(log.data);
  if (data === null) {
    return null;
  }

  let args: Readonly<Record<string, unknown>>;
  switch (eventName) {
    case "QuestionInitialized": {
      const requestTimestamp = topicWord(topics[2]);
      const creator = topicWord(topics[3]);
      // Head: [0] offset to ancillaryData, [1] rewardToken, [2] reward,
      // [3] proposalBond; the bytes tail sits at the offset.
      const rewardToken = wordAt(data, 1);
      const reward = wordAt(data, 2);
      const proposalBond = wordAt(data, 3);
      if (
        requestTimestamp === null ||
        creator === null ||
        rewardToken === null ||
        reward === null ||
        proposalBond === null
      ) {
        return null;
      }
      const ancillary = decodeBytes(data, 0);
      if (ancillary === null) {
        return null;
      }
      args = {
        requestTimestamp: wordToUint(requestTimestamp).toString(10),
        creator: wordToAddress(creator),
        rewardToken: wordToAddress(rewardToken),
        reward: wordToUint(reward).toString(10),
        proposalBond: wordToUint(proposalBond).toString(10),
        ancillaryDataHex: ancillary.hex,
        ancillaryDataUtf8: ancillary.utf8,
        truncated: ancillary.truncated,
      };
      break;
    }
    case "QuestionResolved": {
      const priceWord = topicWord(topics[2]);
      if (priceWord === null) {
        return null;
      }
      const settledPrice = wordToInt(priceWord);
      const payouts = decodeUintArray(data, 0);
      if (payouts === null) {
        return null;
      }
      args = {
        settledPrice: settledPrice.toString(10),
        tooEarly: settledPrice === INT256_MIN,
        payouts,
      };
      break;
    }
    case "QuestionEmergencyResolved":
    case "QuestionManuallyResolved": {
      const payouts = decodeUintArray(data, 0);
      if (payouts === null) {
        return null;
      }
      args = { payouts };
      break;
    }
    case "QuestionPaused":
    case "QuestionUnpaused":
    case "QuestionFlagged":
    case "QuestionUnflagged":
    case "QuestionReset":
      args = {};
      break;
  }

  return {
    eventName,
    questionId: `0x${question}`,
    args,
    blockNumber,
    txHash: `0x${txBody}`,
    logIndex: Number(logIndexBig),
  };
}
