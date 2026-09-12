-- RFC-021 D1 / OPS-02: one persisted row per silence episode, even when the
-- INSERT succeeds but its acknowledgement is lost and the journal retries.
-- Historical gaps without an episode_id and other causes are unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS polymarket_silence_gap_episode_idx
    ON polymarket_data_gaps ((details_json->>'episode_id'))
    WHERE source = 'clob_ws' AND cause = 'stream_silent'
        AND details_json ? 'episode_id';

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
