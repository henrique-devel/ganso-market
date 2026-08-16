//! Persistence contract for domain events and projections (RFC-004). The SQL is
//! versioned here; execution with tokio-postgres (microbatched, never a commit
//! per event) is wired when the receiver runs against a live feed. Row mapping
//! (including the exact-integer u64 -> BIGINT conversion) is unit-tested.

use super::envelope::DomainEventEnvelope;
use super::events::DecodeOutcome;
use super::projection::{BondingCurveState, PumpSwapPoolState};

pub const INSERT_DOMAIN_EVENT: &str = "\
INSERT INTO domain_events \
(schema_version, event_id, event_type, program_id, slot, commitment, signature, \
 instruction_index, inner_index, parser_version, mint, curve, pool, payload_hash, reason_code) \
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) \
ON CONFLICT (event_id) DO NOTHING";

pub const UPSERT_BONDING_CURVE: &str = "\
INSERT INTO bonding_curve_state \
(mint, bonding_curve, creator, virtual_sol_reserves, virtual_token_reserves, \
 real_sol_reserves, real_token_reserves, complete, migrated_pool, last_slot) \
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) \
ON CONFLICT (mint) DO UPDATE SET \
 bonding_curve = COALESCE(EXCLUDED.bonding_curve, bonding_curve_state.bonding_curve), \
 creator = COALESCE(EXCLUDED.creator, bonding_curve_state.creator), \
 virtual_sol_reserves = EXCLUDED.virtual_sol_reserves, \
 virtual_token_reserves = EXCLUDED.virtual_token_reserves, \
 real_sol_reserves = EXCLUDED.real_sol_reserves, \
 real_token_reserves = EXCLUDED.real_token_reserves, \
 complete = bonding_curve_state.complete OR EXCLUDED.complete, \
 migrated_pool = COALESCE(EXCLUDED.migrated_pool, bonding_curve_state.migrated_pool), \
 last_slot = EXCLUDED.last_slot, \
 updated_at = CURRENT_TIMESTAMP \
WHERE EXCLUDED.last_slot >= bonding_curve_state.last_slot";

pub const UPSERT_PUMPSWAP_POOL: &str = "\
INSERT INTO pumpswap_pool_state \
(pool, base_mint, quote_mint, creator, pool_base_reserves, pool_quote_reserves, last_slot) \
VALUES ($1,$2,$3,$4,$5,$6,$7) \
ON CONFLICT (pool) DO UPDATE SET \
 base_mint = COALESCE(EXCLUDED.base_mint, pumpswap_pool_state.base_mint), \
 quote_mint = COALESCE(EXCLUDED.quote_mint, pumpswap_pool_state.quote_mint), \
 creator = COALESCE(EXCLUDED.creator, pumpswap_pool_state.creator), \
 pool_base_reserves = EXCLUDED.pool_base_reserves, \
 pool_quote_reserves = EXCLUDED.pool_quote_reserves, \
 last_slot = EXCLUDED.last_slot, \
 updated_at = CURRENT_TIMESTAMP \
WHERE EXCLUDED.last_slot >= pumpswap_pool_state.last_slot";

pub const INSERT_QUARANTINE: &str = "\
INSERT INTO event_quarantine (program_id, discriminator, slot, signature, payload_hash, reason_code) \
VALUES ($1,$2,$3,$4,$5,$6)";

/// Exact-integer conversion for BIGINT columns. Values in these events fit i64;
/// the saturating guard documents that money is never truncated to a float.
fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CurveRow {
    pub mint: String,
    pub bonding_curve: Option<String>,
    pub creator: Option<String>,
    pub virtual_sol_reserves: i64,
    pub virtual_token_reserves: i64,
    pub real_sol_reserves: i64,
    pub real_token_reserves: i64,
    pub complete: bool,
    pub migrated_pool: Option<String>,
    pub last_slot: i64,
}

impl CurveRow {
    pub fn from_state(state: &BondingCurveState) -> Self {
        Self {
            mint: state.mint.clone(),
            bonding_curve: state.bonding_curve.clone(),
            creator: state.creator.clone(),
            virtual_sol_reserves: to_i64(state.virtual_sol_reserves),
            virtual_token_reserves: to_i64(state.virtual_token_reserves),
            real_sol_reserves: to_i64(state.real_sol_reserves),
            real_token_reserves: to_i64(state.real_token_reserves),
            complete: state.complete,
            migrated_pool: state.migrated_pool.clone(),
            last_slot: to_i64(state.last_slot),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolRow {
    pub pool: String,
    pub base_mint: Option<String>,
    pub quote_mint: Option<String>,
    pub creator: Option<String>,
    pub pool_base_reserves: i64,
    pub pool_quote_reserves: i64,
    pub last_slot: i64,
}

impl PoolRow {
    pub fn from_state(state: &PumpSwapPoolState) -> Self {
        Self {
            pool: state.pool.clone(),
            base_mint: state.base_mint.clone(),
            quote_mint: state.quote_mint.clone(),
            creator: state.creator.clone(),
            pool_base_reserves: to_i64(state.pool_base_reserves),
            pool_quote_reserves: to_i64(state.pool_quote_reserves),
            last_slot: to_i64(state.last_slot),
        }
    }
}

/// The quarantine reason for a non-decoded outcome, or None when the payload was
/// a valid event or simply not an event at all.
pub fn quarantine_reason(outcome: &DecodeOutcome) -> Option<&'static str> {
    match outcome {
        DecodeOutcome::Unknown { .. } => Some("UNKNOWN_DISCRIMINATOR"),
        DecodeOutcome::Malformed { .. } => Some("MALFORMED_EVENT"),
        DecodeOutcome::Decoded(_) | DecodeOutcome::NotAnEvent => None,
    }
}

/// Convenience: the mint/pool/reason a domain event contributes to the event log
/// row.
pub fn event_row_targets(envelope: &DomainEventEnvelope) -> (Option<&str>, Option<&str>) {
    (envelope.mint.as_deref(), envelope.pool.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_uses_conflict_upserts_and_correct_tables() {
        assert!(INSERT_DOMAIN_EVENT.contains("INTO domain_events"));
        assert!(INSERT_DOMAIN_EVENT.contains("ON CONFLICT (event_id) DO NOTHING"));
        assert!(UPSERT_BONDING_CURVE.contains("ON CONFLICT (mint)"));
        assert!(
            UPSERT_BONDING_CURVE.contains("EXCLUDED.last_slot >= bonding_curve_state.last_slot")
        );
        assert!(UPSERT_PUMPSWAP_POOL.contains("ON CONFLICT (pool)"));
        assert!(INSERT_QUARANTINE.contains("INTO event_quarantine"));
    }

    #[test]
    fn curve_row_converts_reserves_to_bigint() {
        let mut state = BondingCurveState::new("mint".to_owned());
        state.real_sol_reserves = 85_000_000_000;
        state.virtual_token_reserves = 1_073_000_000_000_000;
        state.last_slot = 42;
        let row = CurveRow::from_state(&state);
        assert_eq!(row.real_sol_reserves, 85_000_000_000);
        assert_eq!(row.virtual_token_reserves, 1_073_000_000_000_000);
        assert_eq!(row.last_slot, 42);
    }

    #[test]
    fn u64_overflow_saturates_instead_of_wrapping() {
        assert_eq!(to_i64(u64::MAX), i64::MAX);
    }

    #[test]
    fn quarantine_reason_only_for_undecoded() {
        assert_eq!(
            quarantine_reason(&DecodeOutcome::Unknown {
                discriminator: [0; 8]
            }),
            Some("UNKNOWN_DISCRIMINATOR")
        );
        assert_eq!(
            quarantine_reason(&DecodeOutcome::Malformed {
                discriminator: [0; 8]
            }),
            Some("MALFORMED_EVENT")
        );
        assert_eq!(quarantine_reason(&DecodeOutcome::NotAnEvent), None);
    }
}
