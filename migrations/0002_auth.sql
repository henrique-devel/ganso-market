-- RFC-002 authentication schema: single owner account, opaque token families,
-- and login throttling. Only hashes of tokens are stored; no plaintext secret
-- material ever reaches these tables.

CREATE TABLE IF NOT EXISTS auth_accounts (
    account_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username TEXT NOT NULL UNIQUE CHECK (username ~ '^[a-z][a-z0-9_.-]{0,63}$'),
    password_hash TEXT NOT NULL CHECK (char_length(password_hash) BETWEEN 1 AND 512),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    password_changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Enforce the single-user invariant at the database level: the constant
-- expression allows exactly one row regardless of username.
CREATE UNIQUE INDEX IF NOT EXISTS auth_accounts_singleton_idx
    ON auth_accounts ((TRUE));

CREATE TABLE IF NOT EXISTS auth_sessions (
    session_id UUID PRIMARY KEY,
    account_id BIGINT NOT NULL REFERENCES auth_accounts (account_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMPTZ,
    revoked_reason TEXT
        CHECK (revoked_reason IS NULL OR revoked_reason ~ '^[A-Z][A-Z0-9_]{0,63}$')
);

CREATE INDEX IF NOT EXISTS auth_sessions_account_idx
    ON auth_sessions (account_id);

-- Refresh tokens form a rotating family. Reuse of a consumed or revoked token
-- revokes the whole family (detected via family_id).
CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
    refresh_id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES auth_sessions (session_id) ON DELETE CASCADE,
    family_id UUID NOT NULL,
    token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT auth_refresh_tokens_expiry_after_issue CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS auth_refresh_tokens_family_idx
    ON auth_refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS auth_refresh_tokens_session_idx
    ON auth_refresh_tokens (session_id);

-- Access tokens are opaque and short-lived; only their hash is stored so they
-- remain revocable (AUTH-04/AUTH-06).
CREATE TABLE IF NOT EXISTS auth_access_tokens (
    token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    session_id UUID NOT NULL REFERENCES auth_sessions (session_id) ON DELETE CASCADE,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT auth_access_tokens_expiry_after_issue CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS auth_access_tokens_session_idx
    ON auth_access_tokens (session_id);
CREATE INDEX IF NOT EXISTS auth_access_tokens_expires_idx
    ON auth_access_tokens (expires_at);

-- Login throttle keyed by the submitted username so unknown and known users are
-- indistinguishable to the caller (AUTH-10 + no user enumeration).
CREATE TABLE IF NOT EXISTS auth_login_throttle (
    username TEXT PRIMARY KEY CHECK (char_length(username) BETWEEN 1 AND 64),
    failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    window_started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_until TIMESTAMPTZ
);

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
