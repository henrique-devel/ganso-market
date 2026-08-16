import { randomUUID } from "node:crypto";

import { verifyPassword as realVerifyPassword } from "./passwords.js";
import { generateOpaqueToken, hashToken } from "./tokens.js";
import type { AuthStore, ThrottleRecord } from "./types.js";

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;
export const LOCK_THRESHOLD = 5;
export const LOCK_DURATION_SECONDS = 15 * 60;
export const THROTTLE_WINDOW_SECONDS = 15 * 60;
const PROGRESSIVE_DELAY_BASE_MS = 150;
const PROGRESSIVE_DELAY_CAP_MS = 2_000;

// A syntactically valid Argon2id hash of a random value, verified against when
// the username is unknown so the response timing does not reveal account
// existence (AUTH: no user enumeration).
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$QI0FVy61UyzkMQQqza+xuA$ZzyOVH0OMXq+uW43swdED4kxp3xtT6G5bSKYJ+0k+g8";

export interface TokenBundle {
  readonly accessToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
  readonly csrfToken: string;
  readonly username: string;
}

export type LoginResult =
  | { readonly status: "ok"; readonly tokens: TokenBundle }
  | { readonly status: "invalid_credentials" }
  | { readonly status: "locked"; readonly retryAfterSeconds: number };

export type RefreshResult =
  | { readonly status: "ok"; readonly tokens: TokenBundle }
  | { readonly status: "invalid" }
  | { readonly status: "reuse_detected" };

export type SessionResult =
  | {
      readonly status: "ok";
      readonly username: string;
      readonly expiresAt: Date;
    }
  | { readonly status: "unauthenticated" };

export interface AuthService {
  login(username: string, password: string): Promise<LoginResult>;
  refresh(refreshToken: string): Promise<RefreshResult>;
  logout(accessToken: string): Promise<void>;
  session(accessToken: string): Promise<SessionResult>;
}

export interface AuthServiceDeps {
  readonly store: AuthStore;
  readonly clock?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly generateToken?: () => string;
  readonly generateId?: () => string;
  readonly verifyPassword?: (
    password: string,
    hash: string,
  ) => Promise<boolean>;
}

function addSeconds(from: Date, seconds: number): Date {
  return new Date(from.getTime() + seconds * 1_000);
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const clock = deps.clock ?? ((): Date => new Date());
  const sleep =
    deps.sleep ??
    ((ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms)));
  const generateToken = deps.generateToken ?? generateOpaqueToken;
  const generateId = deps.generateId ?? randomUUID;
  const verifyPassword = deps.verifyPassword ?? realVerifyPassword;
  const { store } = deps;

  function issueTokens(username: string, now: Date): TokenBundle {
    return {
      accessToken: generateToken(),
      accessExpiresAt: addSeconds(now, ACCESS_TTL_SECONDS),
      refreshToken: generateToken(),
      refreshExpiresAt: addSeconds(now, REFRESH_TTL_SECONDS),
      csrfToken: generateToken(),
      username,
    };
  }

  async function registerFailure(
    username: string,
    existing: ThrottleRecord | null,
    now: Date,
  ): Promise<void> {
    const withinWindow =
      existing !== null &&
      now.getTime() - existing.windowStartedAt.getTime() <
        THROTTLE_WINDOW_SECONDS * 1_000;
    const failedCount = (withinWindow ? existing.failedCount : 0) + 1;
    const windowStartedAt = withinWindow ? existing.windowStartedAt : now;
    const lockedUntil =
      failedCount >= LOCK_THRESHOLD
        ? addSeconds(now, LOCK_DURATION_SECONDS)
        : null;
    await store.writeThrottle(username, {
      failedCount,
      windowStartedAt,
      lockedUntil,
    });
  }

  async function applyProgressiveDelay(failedCount: number): Promise<void> {
    if (failedCount <= 0) {
      return;
    }
    const delay = Math.min(
      PROGRESSIVE_DELAY_BASE_MS * 2 ** (failedCount - 1),
      PROGRESSIVE_DELAY_CAP_MS,
    );
    await sleep(delay);
  }

  return {
    async login(username: string, password: string): Promise<LoginResult> {
      const now = clock();
      const throttle = await store.readThrottle(username);
      if (
        throttle?.lockedUntil != null &&
        throttle.lockedUntil.getTime() > now.getTime()
      ) {
        return {
          status: "locked",
          retryAfterSeconds: Math.ceil(
            (throttle.lockedUntil.getTime() - now.getTime()) / 1_000,
          ),
        };
      }

      const account = await store.findAccountByUsername(username);
      const passwordOk = await verifyPassword(
        password,
        account?.passwordHash ?? DUMMY_PASSWORD_HASH,
      );

      if (account === null || !passwordOk) {
        await registerFailure(username, throttle, now);
        await applyProgressiveDelay((throttle?.failedCount ?? 0) + 1);
        return { status: "invalid_credentials" };
      }

      await store.clearThrottle(username);
      const tokens = issueTokens(account.username, now);
      await store.openSession({
        sessionId: generateId(),
        accountId: account.accountId,
        now,
        accessTokenHash: hashToken(tokens.accessToken),
        accessExpiresAt: tokens.accessExpiresAt,
        refreshId: generateId(),
        familyId: generateId(),
        refreshTokenHash: hashToken(tokens.refreshToken),
        refreshExpiresAt: tokens.refreshExpiresAt,
      });
      return { status: "ok", tokens };
    },

    async refresh(refreshToken: string): Promise<RefreshResult> {
      const now = clock();
      const nextAccess = generateToken();
      const nextRefresh = generateToken();
      const csrfToken = generateToken();
      const outcome = await store.rotateRefresh({
        presentedTokenHash: hashToken(refreshToken),
        now,
        newRefreshId: generateId(),
        newRefreshTokenHash: hashToken(nextRefresh),
        refreshExpiresAt: addSeconds(now, REFRESH_TTL_SECONDS),
        newAccessTokenHash: hashToken(nextAccess),
        accessExpiresAt: addSeconds(now, ACCESS_TTL_SECONDS),
      });
      if (outcome.status === "reuse_detected") {
        return { status: "reuse_detected" };
      }
      if (outcome.status === "invalid") {
        return { status: "invalid" };
      }
      return {
        status: "ok",
        tokens: {
          accessToken: nextAccess,
          accessExpiresAt: addSeconds(now, ACCESS_TTL_SECONDS),
          refreshToken: nextRefresh,
          refreshExpiresAt: addSeconds(now, REFRESH_TTL_SECONDS),
          csrfToken,
          username: "",
        },
      };
    },

    async logout(accessToken: string): Promise<void> {
      const now = clock();
      await store.revokeSessionByAccessToken(
        hashToken(accessToken),
        "LOGOUT",
        now,
      );
    },

    async session(accessToken: string): Promise<SessionResult> {
      const now = clock();
      const record = await store.readAccessToken(hashToken(accessToken), now);
      if (record === null) {
        return { status: "unauthenticated" };
      }
      return {
        status: "ok",
        username: record.username,
        expiresAt: record.expiresAt,
      };
    },
  };
}
