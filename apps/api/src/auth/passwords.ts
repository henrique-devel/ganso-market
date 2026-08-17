import { randomBytes } from "node:crypto";

import { argon2id, argon2Verify } from "hash-wasm";

// OWASP Argon2id baseline, tuned to land near 250-500 ms on the CPX42 vCPUs.
// The parameters are embedded in the encoded hash, so future re-tuning stays
// backward compatible with previously stored hashes.
const MEMORY_KIB = 19_456;
const ITERATIONS = 2;
const PARALLELISM = 1;
const HASH_LENGTH = 32;
const SALT_BYTES = 16;

export const MIN_PASSWORD_LENGTH = 16;
export const MAX_PASSWORD_LENGTH = 1_024;

export class PasswordPolicyError extends Error {
  public readonly reasonCode = "PASSWORD_POLICY_VIOLATION";

  public constructor(message: string) {
    super(message);
    this.name = "PasswordPolicyError";
  }
}

export function assertPasswordPolicy(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(
      `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(
      `password must be at most ${MAX_PASSWORD_LENGTH} characters`,
    );
  }
}

export async function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(SALT_BYTES),
    parallelism: PARALLELISM,
    iterations: ITERATIONS,
    memorySize: MEMORY_KIB,
    hashLength: HASH_LENGTH,
    outputType: "encoded",
  });
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash: encodedHash });
  } catch {
    // A malformed stored hash must read as a failed verification, never throw.
    return false;
  }
}
