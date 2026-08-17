import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// 32 random bytes = 256 bits of entropy, encoded url-safe so the value is a
// clean opaque string in headers and cookies (AUTH-04/AUTH-05).
const TOKEN_BYTES = 32;

export function generateOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// Constant-time comparison of two hex-encoded values of the same length; used
// for CSRF double-submit checks so equality does not leak via timing.
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}
