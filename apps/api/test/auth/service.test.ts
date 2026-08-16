import { describe, expect, it } from "vitest";

import {
  createAuthService,
  LOCK_THRESHOLD,
  type AuthServiceDeps,
} from "../../src/auth/service.js";
import { FakeAuthStore } from "./fake-store.js";

const FIXED_TIME = new Date("2026-08-15T12:00:00.000Z");
const VALID_PASSWORD = "correct-horse-battery-staple";

function deterministicGenerators(): {
  generateToken: () => string;
  generateId: () => string;
} {
  let tokenCounter = 0;
  let idCounter = 0;
  return {
    generateToken: (): string => `token-${String((tokenCounter += 1))}`,
    generateId: (): string => `id-${String((idCounter += 1))}`,
  };
}

function buildService(
  store: FakeAuthStore,
  overrides: Partial<AuthServiceDeps> = {},
): ReturnType<typeof createAuthService> {
  const generators = deterministicGenerators();
  return createAuthService({
    store,
    clock: (): Date => FIXED_TIME,
    sleep: (): Promise<void> => Promise.resolve(),
    generateToken: generators.generateToken,
    generateId: generators.generateId,
    verifyPassword: (password: string): Promise<boolean> =>
      Promise.resolve(password === VALID_PASSWORD),
    ...overrides,
  });
}

function storeWithAccount(): FakeAuthStore {
  const store = new FakeAuthStore();
  store.seedAccount({
    accountId: "account-1",
    username: "owner",
    passwordHash: "$argon2id$stored",
  });
  return store;
}

describe("auth service", () => {
  it("issues tokens on valid credentials and authenticates the session", async () => {
    const store = storeWithAccount();
    const service = buildService(store);

    const result = await service.login("owner", VALID_PASSWORD);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    expect(result.tokens.username).toBe("owner");
    expect(result.tokens.accessToken).not.toEqual(result.tokens.refreshToken);
    expect(result.tokens.accessExpiresAt.getTime()).toBe(
      FIXED_TIME.getTime() + 15 * 60 * 1_000,
    );

    const session = await service.session(result.tokens.accessToken);
    expect(session).toEqual({
      status: "ok",
      username: "owner",
      expiresAt: result.tokens.accessExpiresAt,
    });
  });

  it("rejects an unknown username exactly like a wrong password", async () => {
    const store = storeWithAccount();
    const service = buildService(store);

    const unknown = await service.login("ghost", VALID_PASSWORD);
    const wrong = await service.login("owner", "wrong-password-1234567");

    expect(unknown).toEqual({ status: "invalid_credentials" });
    expect(wrong).toEqual({ status: "invalid_credentials" });
  });

  it("locks the account after the failure threshold and reports retry", async () => {
    const store = storeWithAccount();
    const service = buildService(store);

    for (let attempt = 0; attempt < LOCK_THRESHOLD; attempt += 1) {
      const result = await service.login("owner", "bad-password-000000");
      expect(result.status).toBe("invalid_credentials");
    }

    const locked = await service.login("owner", VALID_PASSWORD);
    expect(locked.status).toBe("locked");
    if (locked.status === "locked") {
      expect(locked.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it("rotates refresh tokens and invalidates the previous one", async () => {
    const store = storeWithAccount();
    const service = buildService(store);
    const login = await service.login("owner", VALID_PASSWORD);
    if (login.status !== "ok") {
      throw new Error("login failed");
    }

    const rotated = await service.refresh(login.tokens.refreshToken);
    expect(rotated.status).toBe("ok");

    // The consumed original token can no longer rotate.
    const replayOriginal = await service.refresh(login.tokens.refreshToken);
    expect(replayOriginal.status).toBe("reuse_detected");
  });

  it("revokes the whole family when a consumed refresh token is replayed", async () => {
    const store = storeWithAccount();
    const service = buildService(store);
    const login = await service.login("owner", VALID_PASSWORD);
    if (login.status !== "ok") {
      throw new Error("login failed");
    }
    const rotated = await service.refresh(login.tokens.refreshToken);
    if (rotated.status !== "ok") {
      throw new Error("rotation failed");
    }

    // Replaying the original (already consumed) token triggers reuse detection.
    const replay = await service.refresh(login.tokens.refreshToken);
    expect(replay.status).toBe("reuse_detected");

    // The legitimately rotated token was revoked with the family, so presenting
    // it now also trips reuse detection rather than rotating.
    const afterRevoke = await service.refresh(rotated.tokens.refreshToken);
    expect(afterRevoke.status).toBe("reuse_detected");
  });

  it("rejects an unknown refresh token", async () => {
    const store = storeWithAccount();
    const service = buildService(store);
    const result = await service.refresh("not-a-real-token");
    expect(result).toEqual({ status: "invalid" });
  });

  it("logout revokes the session so the access token stops working", async () => {
    const store = storeWithAccount();
    const service = buildService(store);
    const login = await service.login("owner", VALID_PASSWORD);
    if (login.status !== "ok") {
      throw new Error("login failed");
    }

    await service.logout(login.tokens.accessToken);

    const session = await service.session(login.tokens.accessToken);
    expect(session).toEqual({ status: "unauthenticated" });
  });
});
