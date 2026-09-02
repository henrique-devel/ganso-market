-- RFC-018 item 3: the "proposed" half of UMA_PROPOSED_OR_DISPUTED reaches the
-- portfolio engine.
--
-- RFC-013 item 4(i) requires a circuit breaker on "`umaResolutionStatus` =
-- proposed/disputed em qualquer posição", and breakers.ts documents itself the
-- same way ("A UMA request proposed or disputed on a market we hold"). What it
-- can actually see is only `dispute_active` and `effective_action`, because
-- those are the only two things resolution_market_state carries about UMA —
-- recompute.ts computes `proposalActive` and then drops it on the floor.
--
-- Measured in production on 2026-09-02:
--
--   * resolution_uma_timeline holds 482 markets in state `proposed` and 340 in
--     `settled`; `dispute_active` is FALSE in 781 of 781 market states, and no
--     market has ever had effective_action = 'CIRCUIT_BREAKER'. The proposed
--     half of the breaker's own name is unreachable in this population, so the
--     control could not fire — it did not fail, it could not run.
--
--   * It had a real chance and missed it. Paper position 0x71b5721c… was opened
--     2026-09-01 11:59:06Z; a UMA request was proposed on that market at
--     16:04:52Z (bond 250, liveness 600 s) and settled P1 at 16:14:48Z. That is
--     ~10 panel cycles holding a position under a live proposal, and zero
--     breakers.
--
--   * Latency is not the obstacle: a `status_change` recompute lands within one
--     second of the proposal (median 0 s over all 483 recorded proposals), so
--     the state row is fresh — it just has nowhere to put the fact.
--
-- Default FALSE and not NULL: "we have not recomputed this market yet" must
-- read as "no live proposal", the same direction the column it sits next to
-- already takes. The next recompute of each market (status_change, rule_change
-- or the sweep) fills it in with the observed truth, so no backfill is written
-- here — a backfill would have to re-derive UMA status as of now and would be a
-- second, divergent implementation of what recompute.ts already does.
--
-- Nothing else changes. 0017 and everything before it are not touched.

ALTER TABLE resolution_market_state
    ADD COLUMN IF NOT EXISTS proposal_active BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
