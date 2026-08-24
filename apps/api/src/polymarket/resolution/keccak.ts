/**
 * Keccak-256 with the ORIGINAL Keccak padding byte (0x01), not the NIST SHA-3
 * variant (0x06) that node:crypto exposes as "sha3-256". Ethereum event
 * topics use original Keccak, and the repo takes no new npm dependency for it
 * (RFC-012), hence the from-scratch implementation.
 *
 * Keccak-f[1600]: 25 lanes of 64 bits, kept here as hi/lo 32-bit pairs so
 * every operation stays on JS 32-bit integers. Rate 1088 bits (136-byte
 * blocks), capacity 512 bits, 24 rounds. The test suite checks this against
 * a structurally independent BigInt implementation with derived constants.
 */

const RATE_BYTES = 136;
const RATE_LANES = RATE_BYTES / 8;
const ROUNDS = 24;

// Round constants of Keccak-f[1600], split into 32-bit halves.
const RC_HI: readonly number[] = [
  0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000,
  0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x00000000, 0x00000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000,
];
const RC_LO: readonly number[] = [
  0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b, 0x80000001,
  0x80008081, 0x00008009, 0x0000008a, 0x00000088, 0x80008009, 0x8000000a,
  0x8000808b, 0x0000008b, 0x00008089, 0x00008003, 0x00008002, 0x00000080,
  0x0000800a, 0x8000000a, 0x80008081, 0x00008080, 0x80000001, 0x80008008,
];

// Rho rotation offsets, flat-indexed as lane[x + 5y].
const RHO: readonly number[] = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18,
  2, 61, 56, 14,
];

// Pi destination for source lane i = x + 5y: y + 5*((2x + 3y) mod 5).
const PI: readonly number[] = [
  0, 10, 20, 5, 15, 16, 1, 11, 21, 6, 7, 17, 2, 12, 22, 23, 8, 18, 3, 13, 14,
  24, 9, 19, 4,
];

function keccakF(hi: Int32Array, lo: Int32Array): void {
  const cHi = new Int32Array(5);
  const cLo = new Int32Array(5);
  const bHi = new Int32Array(25);
  const bLo = new Int32Array(25);
  for (let round = 0; round < ROUNDS; round++) {
    // Theta: column parities, then D[x] = C[x-1] ^ rotl64(C[x+1], 1).
    for (let x = 0; x < 5; x++) {
      cHi[x] = hi[x]! ^ hi[x + 5]! ^ hi[x + 10]! ^ hi[x + 15]! ^ hi[x + 20]!;
      cLo[x] = lo[x]! ^ lo[x + 5]! ^ lo[x + 10]! ^ lo[x + 15]! ^ lo[x + 20]!;
    }
    for (let x = 0; x < 5; x++) {
      const p = (x + 4) % 5;
      const n = (x + 1) % 5;
      const dHi = cHi[p]! ^ ((cHi[n]! << 1) | (cLo[n]! >>> 31));
      const dLo = cLo[p]! ^ ((cLo[n]! << 1) | (cHi[n]! >>> 31));
      for (let y = 0; y < 25; y += 5) {
        hi[x + y] = hi[x + y]! ^ dHi;
        lo[x + y] = lo[x + y]! ^ dLo;
      }
    }
    // Rho + Pi. Shift counts stay in 1..31 per half because JS shifts are
    // modulo 32; the n === 0 and n === 32 cases are handled explicitly.
    for (let i = 0; i < 25; i++) {
      const n = RHO[i]!;
      const d = PI[i]!;
      const h = hi[i]!;
      const l = lo[i]!;
      if (n === 0) {
        bHi[d] = h;
        bLo[d] = l;
      } else if (n < 32) {
        bHi[d] = (h << n) | (l >>> (32 - n));
        bLo[d] = (l << n) | (h >>> (32 - n));
      } else if (n === 32) {
        bHi[d] = l;
        bLo[d] = h;
      } else {
        const m = n - 32;
        bHi[d] = (l << m) | (h >>> (32 - m));
        bLo[d] = (h << m) | (l >>> (32 - m));
      }
    }
    // Chi.
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        const n1 = y + ((x + 1) % 5);
        const n2 = y + ((x + 2) % 5);
        hi[y + x] = bHi[y + x]! ^ (~bHi[n1]! & bHi[n2]!);
        lo[y + x] = bLo[y + x]! ^ (~bLo[n1]! & bLo[n2]!);
      }
    }
    // Iota.
    hi[0] = hi[0]! ^ RC_HI[round]!;
    lo[0] = lo[0]! ^ RC_LO[round]!;
  }
}

/** XOR one 136-byte block (little-endian lanes) into the state, then permute. */
function absorbBlock(
  hi: Int32Array,
  lo: Int32Array,
  block: Uint8Array,
  offset: number,
): void {
  for (let lane = 0; lane < RATE_LANES; lane++) {
    const base = offset + lane * 8;
    lo[lane] =
      lo[lane]! ^
      (block[base]! |
        (block[base + 1]! << 8) |
        (block[base + 2]! << 16) |
        (block[base + 3]! << 24));
    hi[lane] =
      hi[lane]! ^
      (block[base + 4]! |
        (block[base + 5]! << 8) |
        (block[base + 6]! << 16) |
        (block[base + 7]! << 24));
  }
  keccakF(hi, lo);
}

/** Keccak-256 digest (32 bytes) of `data`. */
export function keccak256(data: Uint8Array): Uint8Array {
  const hi = new Int32Array(25);
  const lo = new Int32Array(25);
  const fullBlocks = Math.floor(data.length / RATE_BYTES);
  for (let block = 0; block < fullBlocks; block++) {
    absorbBlock(hi, lo, data, block * RATE_BYTES);
  }
  // Final block: leftover bytes plus pad10*1 — 0x01 after the message and
  // 0x80 on the block's last byte (a single 0x81 when they coincide).
  const last = new Uint8Array(RATE_BYTES);
  const consumed = fullBlocks * RATE_BYTES;
  last.set(data.subarray(consumed));
  last[data.length - consumed] = 0x01;
  last[RATE_BYTES - 1] = last[RATE_BYTES - 1]! | 0x80;
  absorbBlock(hi, lo, last, 0);
  // Squeeze: 32 bytes fit in one rate, lanes 0..3 little-endian.
  const out = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane++) {
    const l = lo[lane]!;
    const h = hi[lane]!;
    const base = lane * 8;
    out[base] = l & 0xff;
    out[base + 1] = (l >>> 8) & 0xff;
    out[base + 2] = (l >>> 16) & 0xff;
    out[base + 3] = (l >>> 24) & 0xff;
    out[base + 4] = h & 0xff;
    out[base + 5] = (h >>> 8) & 0xff;
    out[base + 6] = (h >>> 16) & 0xff;
    out[base + 7] = (h >>> 24) & 0xff;
  }
  return out;
}

/** Keccak-256 digest as 64 lowercase hex chars, no 0x prefix. */
export function keccak256Hex(data: Uint8Array): string {
  const digest = keccak256(data);
  let out = "";
  for (const byte of digest) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** keccak256Hex of the UTF-8 bytes of `text` (event topic0 computation). */
export function keccak256Utf8Hex(text: string): string {
  return keccak256Hex(new TextEncoder().encode(text));
}
