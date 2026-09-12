-- RFC-021 D1 / OPS-05: retry RTDS gap opens/closes by stable episode identity.
-- Historical records without an episode_id and other sources stay unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS polymarket_rtds_gap_episode_idx
    ON polymarket_data_gaps ((details_json->>'episode_id'))
    WHERE source = 'rtds' AND details_json ? 'episode_id';

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
