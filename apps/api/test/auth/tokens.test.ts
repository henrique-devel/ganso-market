import { describe, expect, it } from "vitest";

import {
  generateOpaqueToken,
  hashToken,
  timingSafeEqualHex,
} from "../../src/auth/tokens.js";

describe("opaque tokens", () => {
  it("generates distinct high-entropy tokens", () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(a).not.toEqual(b);
    // 32 random bytes in base64url decode to a >= 43 character string.
    expect(a.length).toBeGreaterThanOrEqual(43);
  });

  it("hashes deterministically to lowercase 64-hex", () => {
    const hash = hashToken("some-token");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("some-token")).toBe(hash);
    expect(hashToken("other-token")).not.toBe(hash);
  });

  it("compares equal-length values in constant time", () => {
    expect(timingSafeEqualHex("abc123", "abc123")).toBe(true);
    expect(timingSafeEqualHex("abc123", "abc124")).toBe(false);
    expect(timingSafeEqualHex("abc", "abcd")).toBe(false);
    expect(timingSafeEqualHex("", "")).toBe(false);
  });
});
