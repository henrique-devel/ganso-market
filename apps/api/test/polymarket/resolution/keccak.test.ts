import { describe, expect, it } from "vitest";

import {
  keccak256,
  keccak256Hex,
  keccak256Utf8Hex,
} from "../../../src/polymarket/resolution/keccak.js";

// Trusted anchors: well-known Keccak-256 vectors (the last two are the
// canonical ERC-20 event topics). Both implementations must reproduce them.
const TRUSTED_VECTORS: ReadonlyArray<readonly [string, string]> = [
  // keccak256("") is Ethereum's empty-hash constant (EXTCODEHASH of an
  // empty account), cross-checked against hash-wasm's keccak(_, 256).
  ["", "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
  ["abc", "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"],
  [
    "The quick brown fox jumps over the lazy dog",
    "4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15",
  ],
  [
    "Transfer(address,address,uint256)",
    "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  ],
  [
    "Approval(address,address,uint256)",
    "8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
  ],
];

// ---------------------------------------------------------------------------
// Structurally independent reference implementation. The production code uses
// hi/lo 32-bit lane pairs and constant tables; this one uses BigInt lanes and
// DERIVES the round constants (degree-8 LFSR) and rotation offsets (triangular
// number recurrence) from the Keccak spec, so a copied table typo cannot hide.
// ---------------------------------------------------------------------------

const MASK64 = (1n << 64n) - 1n;
const RATE = 136;

function rotl64(value: bigint, count: number): bigint {
  const n = BigInt(count % 64);
  return ((value << n) | (value >> (64n - n))) & MASK64;
}

function deriveRoundConstants(): bigint[] {
  const constants: bigint[] = [];
  let lfsr = 1;
  for (let round = 0; round < 24; round++) {
    let rc = 0n;
    for (let j = 0; j < 7; j++) {
      if ((lfsr & 1) === 1) {
        rc |= 1n << BigInt((1 << j) - 1);
      }
      lfsr = (lfsr & 0x80) !== 0 ? ((lfsr << 1) ^ 0x71) & 0xff : lfsr << 1;
    }
    constants.push(rc);
  }
  return constants;
}

function deriveRotationOffsets(): number[] {
  const offsets = new Array<number>(25).fill(0);
  let x = 1;
  let y = 0;
  for (let t = 0; t < 24; t++) {
    offsets[x + 5 * y] = (((t + 1) * (t + 2)) / 2) % 64;
    const next = (2 * x + 3 * y) % 5;
    x = y;
    y = next;
  }
  return offsets;
}

const REF_RC = deriveRoundConstants();
const REF_RHO = deriveRotationOffsets();

function refKeccakF(state: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    const c: bigint[] = [];
    for (let x = 0; x < 5; x++) {
      c.push(
        state[x]! ^
          state[x + 5]! ^
          state[x + 10]! ^
          state[x + 15]! ^
          state[x + 20]!,
      );
    }
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl64(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 25; y += 5) {
        state[x + y] = state[x + y]! ^ d;
      }
    }
    const b = new Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(
          state[x + 5 * y]!,
          REF_RHO[x + 5 * y]!,
        );
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        // ~a on a BigInt behaves as infinite two's complement; AND with the
        // in-range b[...] keeps the result inside 64 bits.
        state[i] =
          b[i]! ^ (~b[((x + 1) % 5) + 5 * y]! & b[((x + 2) % 5) + 5 * y]!);
      }
    }
    state[0] = state[0]! ^ REF_RC[round]!;
  }
}

function refKeccak256Hex(data: Uint8Array): string {
  // Original Keccak pad10*1 with 0x01 (not NIST 0x06): always at least one
  // padding byte, so an exact-rate message gets a full extra block.
  const padded = new Uint8Array((Math.floor(data.length / RATE) + 1) * RATE);
  padded.set(data);
  padded[data.length] = 0x01;
  padded[padded.length - 1] = padded[padded.length - 1]! | 0x80;
  const state = new Array<bigint>(25).fill(0n);
  for (let block = 0; block < padded.length; block += RATE) {
    for (let lane = 0; lane < RATE / 8; lane++) {
      let value = 0n;
      for (let byte = 7; byte >= 0; byte--) {
        value = (value << 8n) | BigInt(padded[block + lane * 8 + byte]!);
      }
      state[lane] = state[lane]! ^ value;
    }
    refKeccakF(state);
  }
  let out = "";
  for (let lane = 0; lane < 4; lane++) {
    let value = state[lane]!;
    for (let byte = 0; byte < 8; byte++) {
      out += Number(value & 0xffn)
        .toString(16)
        .padStart(2, "0");
      value >>= 8n;
    }
  }
  return out;
}

/** Deterministic pseudo-random bytes (numerical-recipes LCG, fixed seed). */
function lcgBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state >>> 16) & 0xff;
  }
  return out;
}

describe("keccak256 trusted vectors", () => {
  it("production implementation reproduces the five anchors", () => {
    for (const [message, digest] of TRUSTED_VECTORS) {
      expect(keccak256Utf8Hex(message)).toBe(digest);
    }
  });

  it("independent reference implementation reproduces the five anchors", () => {
    // Guards against a shared misunderstanding: the reference is only a valid
    // cross-check if it independently matches the known digests.
    for (const [message, digest] of TRUSTED_VECTORS) {
      expect(refKeccak256Hex(new TextEncoder().encode(message))).toBe(digest);
    }
  });

  it("keccak256 returns 32 bytes and the hex/utf8 helpers agree with it", () => {
    const data = new TextEncoder().encode("abc");
    const digest = keccak256(data);
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest.length).toBe(32);
    const hex = Array.from(digest, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    expect(keccak256Hex(data)).toBe(hex);
    expect(keccak256Utf8Hex("abc")).toBe(hex);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("keccak256 cross-implementation agreement", () => {
  it("agrees with the reference on every length 0..300", () => {
    for (let length = 0; length <= 300; length++) {
      const data = lcgBytes(length, 0x5eed0001 + length);
      expect(keccak256Hex(data), `length ${length}`).toBe(
        refKeccak256Hex(data),
      );
    }
  });

  it("agrees at the rate boundaries (135/136/137 and 271/272/273)", () => {
    for (const length of [135, 136, 137, 271, 272, 273]) {
      const data = lcgBytes(length, 0xc0ffee ^ length);
      expect(keccak256Hex(data), `length ${length}`).toBe(
        refKeccak256Hex(data),
      );
    }
  });
});
