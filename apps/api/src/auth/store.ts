import type { DatabasePool, SqlExecutor } from "../database.js";
import type {
  AccessTokenRecord,
  AccountRecord,
  AuthStore,
  OpenSessionInput,
  RotateRefreshInput,
  RotateRefreshOutcome,
  ThrottleRecord,
} from "./types.js";

interface AccountRow {
  readonly account_id: string;
  readonly username: string;
  readonly password_hash: string;
}

interface ThrottleRow {
  readonly failed_count: number;
  readonly window_started_at: Date;
  readonly locked_until: Date | null;
}

interface RefreshRow {
  readonly refresh_id: string;
  readonly session_id: string;
  readonly family_id: string;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
  readonly revoked_at: Date | null;
  readonly session_revoked_at: Date | null;
}

interface AccessRow {
  readonly session_id: string;
  readonly username: string;
  readonly expires_at: Date;
}

export function createPostgresAuthStore(pool: DatabasePool): AuthStore {
  return {
    async findAccountByUsername(
      username: string,
    ): Promise<AccountRecord | null> {
      const result = await pool.query<AccountRow>(
        "SELECT account_id, username, password_hash FROM auth_accounts WHERE username = $1",
        [username],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        accountId: row.account_id,
        username: row.username,
        passwordHash: row.password_hash,
      };
    },

    async readThrottle(username: string): Promise<ThrottleRecord | null> {
      const result = await pool.query<ThrottleRow>(
        "SELECT failed_count, window_started_at, locked_until FROM auth_login_throttle WHERE username = $1",
        [username],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        failedCount: row.failed_count,
        windowStartedAt: row.window_started_at,
        lockedUntil: row.locked_until,
      };
    },

    async writeThrottle(
      username: string,
      record: ThrottleRecord,
    ): Promise<void> {
      await pool.query(
        `INSERT INTO auth_login_throttle (username, failed_count, window_started_at, locked_until)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (username) DO UPDATE
           SET failed_count = EXCLUDED.failed_count,
               window_started_at = EXCLUDED.window_started_at,
               locked_until = EXCLUDED.locked_until`,
        [
          username,
          record.failedCount,
          record.windowStartedAt,
          record.lockedUntil,
        ],
      );
    },

    async clearThrottle(username: string): Promise<void> {
      await pool.query("DELETE FROM auth_login_throttle WHERE username = $1", [
        username,
      ]);
    },

    async openSession(input: OpenSessionInput): Promise<void> {
      await pool.transaction(async (tx: SqlExecutor) => {
        await tx.query(
          "INSERT INTO auth_sessions (session_id, account_id, created_at, last_active_at) VALUES ($1, $2, $3, $3)",
          [input.sessionId, input.accountId, input.now],
        );
        await tx.query(
          `INSERT INTO auth_refresh_tokens
             (refresh_id, session_id, family_id, token_hash, issued_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            input.refreshId,
            input.sessionId,
            input.familyId,
            input.refreshTokenHash,
            input.now,
            input.refreshExpiresAt,
          ],
        );
        await tx.query(
          `INSERT INTO auth_access_tokens (token_hash, session_id, issued_at, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [
            input.accessTokenHash,
            input.sessionId,
            input.now,
            input.accessExpiresAt,
          ],
        );
      });
    },

    async rotateRefresh(
      input: RotateRefreshInput,
    ): Promise<RotateRefreshOutcome> {
      return pool.transaction(async (tx: SqlExecutor) => {
        const found = await tx.query<RefreshRow>(
          `SELECT r.refresh_id, r.session_id, r.family_id, r.expires_at,
                  r.consumed_at, r.revoked_at, s.revoked_at AS session_revoked_at
             FROM auth_refresh_tokens r
             JOIN auth_sessions s ON s.session_id = r.session_id
            WHERE r.token_hash = $1
            FOR UPDATE OF r`,
          [input.presentedTokenHash],
        );
        const row = found.rows[0];
        if (row === undefined) {
          return { status: "invalid" };
        }
        // Reuse of a consumed or revoked token, or use after the session was
        // revoked, revokes the entire family and session (AUTH-08).
        if (
          row.consumed_at !== null ||
          row.revoked_at !== null ||
          row.session_revoked_at !== null
        ) {
          await tx.query(
            "UPDATE auth_refresh_tokens SET revoked_at = $2 WHERE family_id = $1 AND revoked_at IS NULL",
            [row.family_id, input.now],
          );
          await tx.query(
            "UPDATE auth_access_tokens SET revoked_at = $2 WHERE session_id = $1 AND revoked_at IS NULL",
            [row.session_id, input.now],
          );
          await tx.query(
            "UPDATE auth_sessions SET revoked_at = $2, revoked_reason = 'REFRESH_REUSE_DETECTED' WHERE session_id = $1 AND revoked_at IS NULL",
            [row.session_id, input.now],
          );
          return { status: "reuse_detected", sessionId: row.session_id };
        }
        if (row.expires_at.getTime() <= input.now.getTime()) {
          return { status: "invalid" };
        }

        await tx.query(
          "UPDATE auth_refresh_tokens SET consumed_at = $2 WHERE refresh_id = $1",
          [row.refresh_id, input.now],
        );
        await tx.query(
          `INSERT INTO auth_refresh_tokens
             (refresh_id, session_id, family_id, token_hash, issued_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            input.newRefreshId,
            row.session_id,
            row.family_id,
            input.newRefreshTokenHash,
            input.now,
            input.refreshExpiresAt,
          ],
        );
        await tx.query(
          `INSERT INTO auth_access_tokens (token_hash, session_id, issued_at, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [
            input.newAccessTokenHash,
            row.session_id,
            input.now,
            input.accessExpiresAt,
          ],
        );
        await tx.query(
          "UPDATE auth_sessions SET last_active_at = $2 WHERE session_id = $1",
          [row.session_id, input.now],
        );
        return { status: "rotated", sessionId: row.session_id };
      });
    },

    async readAccessToken(
      tokenHash: string,
      now: Date,
    ): Promise<AccessTokenRecord | null> {
      const result = await pool.query<AccessRow>(
        `SELECT a.session_id, acc.username, a.expires_at
           FROM auth_access_tokens a
           JOIN auth_sessions s ON s.session_id = a.session_id
           JOIN auth_accounts acc ON acc.account_id = s.account_id
          WHERE a.token_hash = $1
            AND a.revoked_at IS NULL
            AND s.revoked_at IS NULL
            AND a.expires_at > $2`,
        [tokenHash, now],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        sessionId: row.session_id,
        username: row.username,
        expiresAt: row.expires_at,
      };
    },

    async revokeSessionByAccessToken(
      tokenHash: string,
      reason: string,
      now: Date,
    ): Promise<boolean> {
      return pool.transaction(async (tx: SqlExecutor) => {
        const found = await tx.query<{ session_id: string }>(
          "SELECT session_id FROM auth_access_tokens WHERE token_hash = $1",
          [tokenHash],
        );
        const row = found.rows[0];
        if (row === undefined) {
          return false;
        }
        await tx.query(
          "UPDATE auth_sessions SET revoked_at = $2, revoked_reason = $3 WHERE session_id = $1 AND revoked_at IS NULL",
          [row.session_id, now, reason],
        );
        await tx.query(
          "UPDATE auth_refresh_tokens SET revoked_at = $2 WHERE session_id = $1 AND revoked_at IS NULL",
          [row.session_id, now],
        );
        await tx.query(
          "UPDATE auth_access_tokens SET revoked_at = $2 WHERE session_id = $1 AND revoked_at IS NULL",
          [row.session_id, now],
        );
        return true;
      });
    },
  };
}
