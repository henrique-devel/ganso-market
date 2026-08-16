//! Lifecycle projections (RFC-004). Trade events carry absolute post-event
//! reserves, so applying them is a set, not an increment: duplicates cannot
//! double-count and reserves cannot go negative. Out-of-order deliveries
//! converge because a newer slot always wins.

use super::events::DomainEvent;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct BondingCurveState {
    pub mint: String,
    pub bonding_curve: Option<String>,
    pub creator: Option<String>,
    pub virtual_sol_reserves: u64,
    pub virtual_token_reserves: u64,
    pub real_sol_reserves: u64,
    pub real_token_reserves: u64,
    pub complete: bool,
    pub migrated_pool: Option<String>,
    pub last_slot: u64,
}

impl BondingCurveState {
    pub fn new(mint: String) -> Self {
        Self {
            mint,
            ..Self::default()
        }
    }

    /// Apply an event at `slot`. Returns true if the state changed. Events for a
    /// different mint, or from an older slot, are ignored.
    pub fn apply(&mut self, event: &DomainEvent, slot: u64) -> bool {
        if event.mint() != Some(self.mint.as_str()) {
            return false;
        }
        if slot < self.last_slot {
            return false;
        }
        match event {
            DomainEvent::PumpTokenCreated {
                bonding_curve,
                creator,
                ..
            } => {
                self.bonding_curve = Some(bonding_curve.clone());
                self.creator.clone_from(creator);
            }
            DomainEvent::PumpTrade {
                virtual_sol_reserves,
                virtual_token_reserves,
                real_sol_reserves,
                real_token_reserves,
                ..
            } => {
                self.virtual_sol_reserves = *virtual_sol_reserves;
                self.virtual_token_reserves = *virtual_token_reserves;
                self.real_sol_reserves = *real_sol_reserves;
                self.real_token_reserves = *real_token_reserves;
            }
            DomainEvent::PumpCurveCompleted { bonding_curve, .. } => {
                self.bonding_curve = Some(bonding_curve.clone());
                self.complete = true;
            }
            DomainEvent::PumpMigrationCompleted {
                bonding_curve,
                pool,
                ..
            } => {
                self.bonding_curve = Some(bonding_curve.clone());
                self.complete = true;
                self.migrated_pool = Some(pool.clone());
            }
            _ => return false,
        }
        self.last_slot = slot;
        true
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PumpSwapPoolState {
    pub pool: String,
    pub base_mint: Option<String>,
    pub quote_mint: Option<String>,
    pub creator: Option<String>,
    pub pool_base_reserves: u64,
    pub pool_quote_reserves: u64,
    pub last_slot: u64,
}

impl PumpSwapPoolState {
    pub fn new(pool: String) -> Self {
        Self {
            pool,
            ..Self::default()
        }
    }

    pub fn apply(&mut self, event: &DomainEvent, slot: u64) -> bool {
        if event.pool() != Some(self.pool.as_str()) {
            return false;
        }
        if slot < self.last_slot {
            return false;
        }
        match event {
            DomainEvent::PumpSwapPoolCreated {
                creator,
                base_mint,
                quote_mint,
                pool_base_reserves,
                pool_quote_reserves,
                ..
            } => {
                self.creator = Some(creator.clone());
                self.base_mint = Some(base_mint.clone());
                self.quote_mint = Some(quote_mint.clone());
                self.pool_base_reserves = *pool_base_reserves;
                self.pool_quote_reserves = *pool_quote_reserves;
            }
            DomainEvent::PumpSwapTrade {
                pool_base_reserves,
                pool_quote_reserves,
                ..
            } => {
                self.pool_base_reserves = *pool_base_reserves;
                self.pool_quote_reserves = *pool_quote_reserves;
            }
            _ => return false,
        }
        self.last_slot = slot;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trade(mint: &str, real_sol: u64) -> DomainEvent {
        DomainEvent::PumpTrade {
            mint: mint.to_owned(),
            is_buy: true,
            sol_amount: 1,
            token_amount: 1,
            user: "user".to_owned(),
            virtual_sol_reserves: 30,
            virtual_token_reserves: 40,
            real_sol_reserves: real_sol,
            real_token_reserves: 60,
        }
    }

    #[test]
    fn trade_sets_absolute_reserves_idempotently() {
        let mut state = BondingCurveState::new("mint".to_owned());
        assert!(state.apply(&trade("mint", 50), 10));
        assert_eq!(state.real_sol_reserves, 50);
        // Re-applying the same event at the same slot yields the same reserves.
        state.apply(&trade("mint", 50), 10);
        assert_eq!(state.real_sol_reserves, 50);
    }

    #[test]
    fn out_of_order_older_slot_is_ignored() {
        let mut state = BondingCurveState::new("mint".to_owned());
        assert!(state.apply(&trade("mint", 90), 20));
        // An older-slot delivery must not regress the state.
        assert!(!state.apply(&trade("mint", 10), 15));
        assert_eq!(state.real_sol_reserves, 90);
        assert_eq!(state.last_slot, 20);
    }

    #[test]
    fn events_for_other_mints_are_ignored() {
        let mut state = BondingCurveState::new("mint".to_owned());
        assert!(!state.apply(&trade("other", 5), 10));
        assert_eq!(state.last_slot, 0);
    }

    #[test]
    fn completion_and_migration_are_terminal_flags() {
        let mut state = BondingCurveState::new("mint".to_owned());
        state.apply(
            &DomainEvent::PumpCurveCompleted {
                mint: "mint".to_owned(),
                bonding_curve: "curve".to_owned(),
                user: "user".to_owned(),
            },
            30,
        );
        assert!(state.complete);
        state.apply(
            &DomainEvent::PumpMigrationCompleted {
                mint: "mint".to_owned(),
                bonding_curve: "curve".to_owned(),
                pool: "pool".to_owned(),
                user: "user".to_owned(),
            },
            31,
        );
        assert_eq!(state.migrated_pool, Some("pool".to_owned()));
    }

    #[test]
    fn pool_projection_tracks_reserves() {
        let mut state = PumpSwapPoolState::new("pool".to_owned());
        assert!(state.apply(
            &DomainEvent::PumpSwapTrade {
                pool: "pool".to_owned(),
                is_buy: false,
                pool_base_reserves: 111,
                pool_quote_reserves: 222,
            },
            5,
        ));
        assert_eq!(state.pool_base_reserves, 111);
        assert_eq!(state.pool_quote_reserves, 222);
    }
}
