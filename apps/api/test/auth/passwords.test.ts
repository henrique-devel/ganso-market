import { describe, expect, it } from "vitest";

import {
  assertPasswordPolicy,
  hashPassword,
  PasswordPolicyError,
  verifyPassword,
} from "../../src/auth/passwords.js";

describe("password hashing", () => {
  it("produces an Argon2id encoded hash that verifies the original password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword("correct-horse-battery-staple", hash)).toBe(
      true,
    );
  });

  it("rejects a wrong password and never throws on malformed input", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(await verifyPassword("not-the-password-000", hash)).toBe(false);
    expect(await verifyPassword("anything", "not-a-valid-hash")).toBe(false);
  });

  it("enforces the minimum password length", () => {
    expect(() => {
      assertPasswordPolicy("short");
    }).toThrow(PasswordPolicyError);
    expect(() => {
      assertPasswordPolicy("sixteen-chars-ok!");
    }).not.toThrow();
  });
});
