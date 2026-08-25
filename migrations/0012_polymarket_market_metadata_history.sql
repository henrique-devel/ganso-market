-- Prospective history for mutable Gamma market metadata. Existing registry
-- rows become knowable only at this migration's transaction timestamp: their
-- current contents must never be projected into an earlier backtest instant.

ALTER TABLE polymarket_markets
    ADD COLUMN IF NOT EXISTS affirmative_token_id TEXT;

ALTER TABLE polymarket_markets
    DROP CONSTRAINT IF EXISTS polymarket_markets_affirmative_token_check;
ALTER TABLE polymarket_markets
    ADD CONSTRAINT polymarket_markets_affirmative_token_check CHECK (
        affirmative_token_id IS NULL
        OR (
            char_length(btrim(affirmative_token_id)) >= 1
            AND clob_token_ids @> jsonb_build_array(affirmative_token_id)
        )
    );

CREATE TABLE IF NOT EXISTS polymarket_market_metadata_versions (
    metadata_version_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    condition_id TEXT NOT NULL CHECK (char_length(condition_id) BETWEEN 1 AND 128),
    version INTEGER NOT NULL CHECK (version > 0),
    question TEXT NOT NULL,
    category TEXT,
    clob_token_ids JSONB NOT NULL CHECK (jsonb_typeof(clob_token_ids) = 'array'),
    affirmative_token_id TEXT,
    valid_from TIMESTAMPTZ NOT NULL,
    valid_to TIMESTAMPTZ,
    source_ts TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT polymarket_market_metadata_versions_window_check
        CHECK (valid_to IS NULL OR valid_to > valid_from),
    UNIQUE (condition_id, version)
);

ALTER TABLE polymarket_market_metadata_versions
    ADD COLUMN IF NOT EXISTS affirmative_token_id TEXT;

ALTER TABLE polymarket_market_metadata_versions
    DROP CONSTRAINT IF EXISTS polymarket_market_metadata_affirmative_token_check;
ALTER TABLE polymarket_market_metadata_versions
    ADD CONSTRAINT polymarket_market_metadata_affirmative_token_check CHECK (
        affirmative_token_id IS NULL
        OR (
            char_length(btrim(affirmative_token_id)) >= 1
            AND clob_token_ids @> jsonb_build_array(affirmative_token_id)
        )
    );

CREATE UNIQUE INDEX IF NOT EXISTS polymarket_market_metadata_versions_open_uidx
    ON polymarket_market_metadata_versions (condition_id)
    WHERE valid_to IS NULL;

CREATE INDEX IF NOT EXISTS polymarket_market_metadata_versions_asof_idx
    ON polymarket_market_metadata_versions (condition_id, valid_from, valid_to);

-- Versions are append-only except for the single NULL -> timestamp update
-- that closes the currently open [valid_from, valid_to) window.
CREATE OR REPLACE FUNCTION polymarket_market_metadata_versions_guard()
RETURNS TRIGGER AS $$
DECLARE
    predecessor_version INTEGER;
    predecessor_valid_to TIMESTAMPTZ;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.valid_to IS NOT NULL THEN
            RAISE EXCEPTION 'metadata versions must be inserted open';
        END IF;
        SELECT version, valid_to
          INTO predecessor_version, predecessor_valid_to
          FROM polymarket_market_metadata_versions
         WHERE condition_id = NEW.condition_id
         ORDER BY version DESC
         LIMIT 1;
        IF NOT FOUND THEN
            IF NEW.version <> 1 THEN
                RAISE EXCEPTION 'first metadata version must be version 1';
            END IF;
        ELSIF NEW.version <> predecessor_version + 1
           OR predecessor_valid_to IS NULL
           OR NEW.valid_from IS DISTINCT FROM predecessor_valid_to THEN
            RAISE EXCEPTION 'metadata versions must be contiguous and sequential';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'polymarket_market_metadata_versions rows are append-only';
    END IF;
    IF OLD.valid_to IS NOT NULL
       OR NEW.valid_to IS NULL
       OR NEW.valid_to <= OLD.valid_from
       OR NEW.metadata_version_id IS DISTINCT FROM OLD.metadata_version_id
       OR NEW.condition_id IS DISTINCT FROM OLD.condition_id
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.question IS DISTINCT FROM OLD.question
       OR NEW.category IS DISTINCT FROM OLD.category
       OR NEW.clob_token_ids IS DISTINCT FROM OLD.clob_token_ids
       OR NEW.affirmative_token_id IS DISTINCT FROM OLD.affirmative_token_id
       OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
       OR NEW.source_ts IS DISTINCT FROM OLD.source_ts
       OR NEW.received_at IS DISTINCT FROM OLD.received_at THEN
        RAISE EXCEPTION 'polymarket_market_metadata_versions rows are append-only';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS polymarket_market_metadata_versions_guard_trg
    ON polymarket_market_metadata_versions;
CREATE TRIGGER polymarket_market_metadata_versions_guard_trg
    BEFORE INSERT OR UPDATE OR DELETE ON polymarket_market_metadata_versions
    FOR EACH ROW EXECUTE FUNCTION polymarket_market_metadata_versions_guard();

-- Install the journal trigger before either the prospective registry backfill
-- or the upgrade backfill. On a fresh install, the new metadata table is not
-- externally visible before commit; on reapply, CREATE TRIGGER locks it against
-- concurrent writers until both backfills complete.
DROP TRIGGER IF EXISTS market_metadata_input_change_trg
    ON polymarket_market_metadata_versions;
CREATE TRIGGER market_metadata_input_change_trg
    AFTER INSERT ON polymarket_market_metadata_versions
    FOR EACH ROW EXECUTE FUNCTION capture_resolution_input_change(
        'market_metadata', 'metadata_version_id', 'received_at'
    );

-- A pre-0012 UPDATE cannot name affirmative_token_id. If it replaces the
-- token set and thereby invalidates a previously known affirmative token,
-- clear the value rather than infer an outcome from array position. Explicit
-- invalid values from current writers still fail the table CHECK.
CREATE OR REPLACE FUNCTION normalize_polymarket_market_affirmative_token()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.clob_token_ids IS DISTINCT FROM OLD.clob_token_ids
       AND NEW.affirmative_token_id IS NOT DISTINCT FROM OLD.affirmative_token_id
       AND NEW.affirmative_token_id IS NOT NULL
       AND NOT (
           NEW.clob_token_ids @>
               jsonb_build_array(NEW.affirmative_token_id)
       ) THEN
        NEW.affirmative_token_id := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_metadata_affirmative_normalize_trg
    ON polymarket_markets;
CREATE TRIGGER market_metadata_affirmative_normalize_trg
    BEFORE UPDATE OF clob_token_ids, affirmative_token_id
    ON polymarket_markets
    FOR EACH ROW EXECUTE FUNCTION normalize_polymarket_market_affirmative_token();

-- Keep old binaries safe during a rolling deployment. CREATE TRIGGER takes a
-- ShareRowExclusiveLock on the mutable registry table: writers already in
-- flight finish before the backfill reads, while later writers wait until this
-- trigger is visible. The source-row lock is therefore always acquired before
-- the per-condition advisory lock and metadata-row lock.
CREATE OR REPLACE FUNCTION capture_polymarket_market_metadata_version()
RETURNS TRIGGER AS $$
DECLARE
    open_version INTEGER;
    open_question TEXT;
    open_category TEXT;
    open_token_ids JSONB;
    open_affirmative_token_id TEXT;
    open_valid_from TIMESTAMPTZ;
    captured_at TIMESTAMPTZ;
BEGIN
    IF TG_OP = 'UPDATE'
       AND NEW.question IS NOT DISTINCT FROM OLD.question
       AND NEW.category IS NOT DISTINCT FROM OLD.category
       AND NEW.clob_token_ids IS NOT DISTINCT FROM OLD.clob_token_ids
       AND NEW.affirmative_token_id IS NOT DISTINCT FROM
           OLD.affirmative_token_id THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.condition_id, 0));
    SELECT version, question, category, clob_token_ids,
           affirmative_token_id, valid_from
      INTO open_version, open_question, open_category, open_token_ids,
           open_affirmative_token_id, open_valid_from
      FROM polymarket_market_metadata_versions
     WHERE condition_id = NEW.condition_id
       AND valid_to IS NULL
     ORDER BY version DESC
     LIMIT 1
     FOR UPDATE;

    IF FOUND
       AND open_question IS NOT DISTINCT FROM NEW.question
       AND open_category IS NOT DISTINCT FROM NEW.category
       AND open_token_ids IS NOT DISTINCT FROM NEW.clob_token_ids
       AND open_affirmative_token_id IS NOT DISTINCT FROM
           NEW.affirmative_token_id THEN
        RETURN NEW;
    END IF;

    captured_at := COALESCE(NEW.updated_at, CURRENT_TIMESTAMP);
    IF open_version IS NOT NULL THEN
        IF captured_at <= open_valid_from THEN
            RAISE EXCEPTION
                'MARKET_METADATA_OBSERVATION_TIME_NOT_MONOTONIC for %',
                NEW.condition_id;
        END IF;
        UPDATE polymarket_market_metadata_versions
           SET valid_to = captured_at
         WHERE condition_id = NEW.condition_id
           AND valid_to IS NULL;
        open_version := open_version + 1;
    ELSE
        IF EXISTS (
            SELECT 1
              FROM polymarket_market_metadata_versions
             WHERE condition_id = NEW.condition_id
        ) THEN
            RAISE EXCEPTION 'metadata history has no open version for %',
                NEW.condition_id;
        END IF;
        open_version := 1;
    END IF;

    INSERT INTO polymarket_market_metadata_versions
        (condition_id, version, question, category, clob_token_ids,
         affirmative_token_id, valid_from, source_ts, received_at)
    VALUES (
        NEW.condition_id, open_version, NEW.question, NEW.category,
        NEW.clob_token_ids, NEW.affirmative_token_id, captured_at,
        NEW.source_ts, captured_at
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_metadata_version_capture_trg
    ON polymarket_markets;
CREATE TRIGGER market_metadata_version_capture_trg
    AFTER INSERT OR UPDATE OF question, category, clob_token_ids,
        affirmative_token_id
    ON polymarket_markets
    FOR EACH ROW EXECUTE FUNCTION capture_polymarket_market_metadata_version();

-- Conservative prospective backfill. CURRENT_TIMESTAMP is fixed for the whole
-- migration transaction; neither source_ts nor mutable updated_at is projected
-- backward. NOT EXISTS is required for idempotence because BEFORE INSERT
-- triggers run before ON CONFLICT arbitration on a reapplication.
INSERT INTO polymarket_market_metadata_versions
    (condition_id, version, question, category, clob_token_ids,
     affirmative_token_id, valid_from, source_ts, received_at)
SELECT m.condition_id, 1, m.question, m.category, m.clob_token_ids,
       m.affirmative_token_id, CURRENT_TIMESTAMP, m.source_ts,
       CURRENT_TIMESTAMP
  FROM polymarket_markets m
 WHERE NOT EXISTS (
       SELECT 1
         FROM polymarket_market_metadata_versions h
        WHERE h.condition_id = m.condition_id
 );

-- Backfill any pre-existing history defensively. Rows inserted by the
-- prospective backfill already exist in the journal via the trigger, and ON
-- CONFLICT makes this second pass and every reapply inert.
INSERT INTO polymarket_resolution_input_changes
    (source, source_key, condition_id, observed_at)
SELECT 'market_metadata', metadata_version_id::text, condition_id, received_at
  FROM polymarket_market_metadata_versions
ON CONFLICT (source, source_key) DO NOTHING;

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
