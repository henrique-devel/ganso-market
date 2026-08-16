export interface AccountRecord {
  readonly accountId: string;
  readonly username: string;
  readonly passwordHash: string;
}

export interface ThrottleRecord {
  readonly failedCount: number;
  readonly windowStartedAt: Date;
  readonly lockedUntil: Date | null;
}

export interface OpenSessionInput {
  readonly sessionId: string;
  readonly accountId: string;
  readonly now: Date;
  readonly accessTokenHash: string;
  readonly accessExpiresAt: Date;
  readonly refreshId: string;
  readonly familyId: string;
  readonly refreshTokenHash: string;
  readonly refreshExpiresAt: Date;
}

export interface RotateRefreshInput {
  readonly presentedTokenHash: string;
  readonly now: Date;
  readonly newRefreshId: string;
  readonly newRefreshTokenHash: string;
  readonly refreshExpiresAt: Date;
  readonly newAccessTokenHash: string;
  readonly accessExpiresAt: Date;
}

export type RotateRefreshOutcome =
  | { readonly status: "rotated"; readonly sessionId: string }
  | { readonly status: "reuse_detected"; readonly sessionId: string }
  | { readonly status: "invalid" };

export interface AccessTokenRecord {
  readonly sessionId: string;
  readonly username: string;
  readonly expiresAt: Date;
}

export interface AuthStore {
  findAccountByUsername(username: string): Promise<AccountRecord | null>;
  readThrottle(username: string): Promise<ThrottleRecord | null>;
  writeThrottle(username: string, record: ThrottleRecord): Promise<void>;
  clearThrottle(username: string): Promise<void>;
  openSession(input: OpenSessionInput): Promise<void>;
  rotateRefresh(input: RotateRefreshInput): Promise<RotateRefreshOutcome>;
  readAccessToken(
    tokenHash: string,
    now: Date,
  ): Promise<AccessTokenRecord | null>;
  revokeSessionByAccessToken(
    tokenHash: string,
    reason: string,
    now: Date,
  ): Promise<boolean>;
}
