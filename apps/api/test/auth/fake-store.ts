import type {
  AccessTokenRecord,
  AccountRecord,
  AuthStore,
  OpenSessionInput,
  RotateRefreshInput,
  RotateRefreshOutcome,
  ThrottleRecord,
} from "../../src/auth/types.js";

interface SessionState {
  accountId: string;
  revokedAt: Date | null;
}

interface RefreshState {
  sessionId: string;
  familyId: string;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
}

interface AccessState {
  sessionId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

// In-memory AuthStore that encodes the same contract as the PostgreSQL store:
// rotating refresh families with reuse detection, revocation, and throttling.
export class FakeAuthStore implements AuthStore {
  readonly #accountsByUsername = new Map<string, AccountRecord>();
  readonly #accountsById = new Map<string, AccountRecord>();
  readonly #throttle = new Map<string, ThrottleRecord>();
  readonly #sessions = new Map<string, SessionState>();
  readonly #refresh = new Map<string, RefreshState>();
  readonly #access = new Map<string, AccessState>();

  public seedAccount(account: AccountRecord): void {
    this.#accountsByUsername.set(account.username, account);
    this.#accountsById.set(account.accountId, account);
  }

  public findAccountByUsername(
    username: string,
  ): Promise<AccountRecord | null> {
    return Promise.resolve(this.#accountsByUsername.get(username) ?? null);
  }

  public readThrottle(username: string): Promise<ThrottleRecord | null> {
    return Promise.resolve(this.#throttle.get(username) ?? null);
  }

  public writeThrottle(
    username: string,
    record: ThrottleRecord,
  ): Promise<void> {
    this.#throttle.set(username, record);
    return Promise.resolve();
  }

  public clearThrottle(username: string): Promise<void> {
    this.#throttle.delete(username);
    return Promise.resolve();
  }

  public openSession(input: OpenSessionInput): Promise<void> {
    this.#sessions.set(input.sessionId, {
      accountId: input.accountId,
      revokedAt: null,
    });
    this.#refresh.set(input.refreshTokenHash, {
      sessionId: input.sessionId,
      familyId: input.familyId,
      expiresAt: input.refreshExpiresAt,
      consumedAt: null,
      revokedAt: null,
    });
    this.#access.set(input.accessTokenHash, {
      sessionId: input.sessionId,
      expiresAt: input.accessExpiresAt,
      revokedAt: null,
    });
    return Promise.resolve();
  }

  public rotateRefresh(
    input: RotateRefreshInput,
  ): Promise<RotateRefreshOutcome> {
    const current = this.#refresh.get(input.presentedTokenHash);
    if (current === undefined) {
      return Promise.resolve({ status: "invalid" });
    }
    const session = this.#sessions.get(current.sessionId);
    const sessionRevoked = session?.revokedAt != null;
    if (
      current.consumedAt !== null ||
      current.revokedAt !== null ||
      sessionRevoked
    ) {
      for (const refresh of this.#refresh.values()) {
        if (
          refresh.familyId === current.familyId &&
          refresh.revokedAt === null
        ) {
          refresh.revokedAt = input.now;
        }
      }
      for (const access of this.#access.values()) {
        if (
          access.sessionId === current.sessionId &&
          access.revokedAt === null
        ) {
          access.revokedAt = input.now;
        }
      }
      if (session !== undefined && session.revokedAt === null) {
        session.revokedAt = input.now;
      }
      return Promise.resolve({
        status: "reuse_detected",
        sessionId: current.sessionId,
      });
    }
    if (current.expiresAt.getTime() <= input.now.getTime()) {
      return Promise.resolve({ status: "invalid" });
    }

    current.consumedAt = input.now;
    this.#refresh.set(input.newRefreshTokenHash, {
      sessionId: current.sessionId,
      familyId: current.familyId,
      expiresAt: input.refreshExpiresAt,
      consumedAt: null,
      revokedAt: null,
    });
    this.#access.set(input.newAccessTokenHash, {
      sessionId: current.sessionId,
      expiresAt: input.accessExpiresAt,
      revokedAt: null,
    });
    return Promise.resolve({
      status: "rotated",
      sessionId: current.sessionId,
    });
  }

  public readAccessToken(
    tokenHash: string,
    now: Date,
  ): Promise<AccessTokenRecord | null> {
    const access = this.#access.get(tokenHash);
    if (access === undefined || access.revokedAt !== null) {
      return Promise.resolve(null);
    }
    if (access.expiresAt.getTime() <= now.getTime()) {
      return Promise.resolve(null);
    }
    const session = this.#sessions.get(access.sessionId);
    if (session === undefined || session.revokedAt !== null) {
      return Promise.resolve(null);
    }
    const account = this.#accountsById.get(session.accountId);
    if (account === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      sessionId: access.sessionId,
      username: account.username,
      expiresAt: access.expiresAt,
    });
  }

  public revokeSessionByAccessToken(
    tokenHash: string,
    _reason: string,
    now: Date,
  ): Promise<boolean> {
    const access = this.#access.get(tokenHash);
    if (access === undefined) {
      return Promise.resolve(false);
    }
    const sessionId = access.sessionId;
    const session = this.#sessions.get(sessionId);
    if (session !== undefined && session.revokedAt === null) {
      session.revokedAt = now;
    }
    for (const refresh of this.#refresh.values()) {
      if (refresh.sessionId === sessionId && refresh.revokedAt === null) {
        refresh.revokedAt = now;
      }
    }
    for (const entry of this.#access.values()) {
      if (entry.sessionId === sessionId && entry.revokedAt === null) {
        entry.revokedAt = now;
      }
    }
    return Promise.resolve(true);
  }
}
