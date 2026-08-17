//! Versioned allowlist of Solana programs the ingestion layer may subscribe to.
//!
//! Program IDs are configuration, not secrets, and are verified against the
//! official Pump/PumpSwap documentation. Only these programs may be subscribed;
//! global Token/Token-2022/Jupiter or full-block subscriptions are never allowed
//! (SOL-01/SOL-03).

/// Bump when the set of allowed programs changes; recorded with ingested data so
/// a change is auditable.
pub const ALLOWLIST_VERSION: u32 = 1;

/// Pump.fun bonding-curve program.
pub const PUMP_PROGRAM_ID: &str = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

/// PumpSwap AMM program (post-graduation venue).
pub const PUMPSWAP_PROGRAM_ID: &str = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

/// The complete allowlist for the MVP.
pub const ALLOWED_PROGRAM_IDS: [&str; 2] = [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID];

/// Returns true only for programs explicitly on the allowlist.
pub fn is_allowed(program_id: &str) -> bool {
    ALLOWED_PROGRAM_IDS.contains(&program_id)
}

/// The allowlist as an owned vector, for filter construction.
pub fn allowed_program_ids() -> Vec<String> {
    ALLOWED_PROGRAM_IDS
        .iter()
        .map(|id| (*id).to_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admits_only_pump_and_pumpswap() {
        assert!(is_allowed(PUMP_PROGRAM_ID));
        assert!(is_allowed(PUMPSWAP_PROGRAM_ID));
    }

    #[test]
    fn rejects_unlisted_programs() {
        // Token program and a made-up id must never be admitted.
        assert!(!is_allowed("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
        assert!(!is_allowed(""));
        assert!(!is_allowed("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"));
    }

    #[test]
    fn owned_ids_match_the_constant() {
        assert_eq!(
            allowed_program_ids(),
            vec![PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID]
        );
    }
}
