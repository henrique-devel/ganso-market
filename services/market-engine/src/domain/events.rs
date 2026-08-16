//! Deterministic decoders for Pump/PumpSwap Anchor events, using verified
//! discriminators and field layouts. Events carry absolute post-event reserves,
//! so downstream projection is a set (idempotent, never negative). Unknown or
//! malformed payloads are reported for quarantine, never applied.

use super::cursor::Cursor;
use super::discriminators::{
    ANCHOR_EVENT_CPI_TAG, PUMP_COMPLETE_EVENT, PUMP_CREATE_EVENT, PUMP_MIGRATION_EVENT,
    PUMP_TRADE_EVENT, PUMPSWAP_BUY_EVENT, PUMPSWAP_CREATE_POOL_EVENT, PUMPSWAP_SELL_EVENT,
};
use crate::ingestion::allowlist::{PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID};

pub const PARSER_VERSION: &str = "pump-idl-2026-08-15";

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DomainEvent {
    PumpTokenCreated {
        mint: String,
        bonding_curve: String,
        user: String,
        creator: Option<String>,
    },
    PumpTrade {
        mint: String,
        is_buy: bool,
        sol_amount: u64,
        token_amount: u64,
        user: String,
        virtual_sol_reserves: u64,
        virtual_token_reserves: u64,
        real_sol_reserves: u64,
        real_token_reserves: u64,
    },
    PumpCurveCompleted {
        mint: String,
        bonding_curve: String,
        user: String,
    },
    PumpMigrationCompleted {
        mint: String,
        bonding_curve: String,
        pool: String,
        user: String,
    },
    PumpSwapPoolCreated {
        pool: String,
        creator: String,
        base_mint: String,
        quote_mint: String,
        pool_base_reserves: u64,
        pool_quote_reserves: u64,
    },
    PumpSwapTrade {
        pool: String,
        is_buy: bool,
        pool_base_reserves: u64,
        pool_quote_reserves: u64,
    },
}

impl DomainEvent {
    pub const fn event_type(&self) -> &'static str {
        match self {
            Self::PumpTokenCreated { .. } => "PumpTokenCreated",
            Self::PumpTrade { .. } => "PumpTrade",
            Self::PumpCurveCompleted { .. } => "PumpCurveCompleted",
            Self::PumpMigrationCompleted { .. } => "PumpMigrationCompleted",
            Self::PumpSwapPoolCreated { .. } => "PumpSwapPoolCreated",
            Self::PumpSwapTrade { .. } => "PumpSwapTrade",
        }
    }

    pub fn mint(&self) -> Option<&str> {
        match self {
            Self::PumpTokenCreated { mint, .. }
            | Self::PumpTrade { mint, .. }
            | Self::PumpCurveCompleted { mint, .. }
            | Self::PumpMigrationCompleted { mint, .. } => Some(mint),
            _ => None,
        }
    }

    pub fn pool(&self) -> Option<&str> {
        match self {
            Self::PumpMigrationCompleted { pool, .. }
            | Self::PumpSwapPoolCreated { pool, .. }
            | Self::PumpSwapTrade { pool, .. } => Some(pool),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DecodeOutcome {
    Decoded(DomainEvent),
    /// A recognized program but an unknown event discriminator.
    Unknown {
        discriminator: [u8; 8],
    },
    /// A known discriminator whose payload did not match the expected layout.
    Malformed {
        discriminator: [u8; 8],
    },
    /// Not an Anchor event-CPI payload at all.
    NotAnEvent,
}

fn split_event(data: &[u8]) -> Option<([u8; 8], &[u8])> {
    if data.len() < 16 || data[0..8] != ANCHOR_EVENT_CPI_TAG {
        return None;
    }
    let mut discriminator = [0u8; 8];
    discriminator.copy_from_slice(&data[8..16]);
    Some((discriminator, &data[16..]))
}

/// Decode one inner-instruction event payload for a program on the allowlist.
pub fn decode(program_id: &str, data: &[u8]) -> DecodeOutcome {
    let Some((discriminator, payload)) = split_event(data) else {
        return DecodeOutcome::NotAnEvent;
    };
    let decoded = match program_id {
        PUMP_PROGRAM_ID => decode_pump(&discriminator, payload),
        PUMPSWAP_PROGRAM_ID => decode_pumpswap(&discriminator, payload),
        _ => return DecodeOutcome::Unknown { discriminator },
    };
    match decoded {
        Some(Some(event)) => DecodeOutcome::Decoded(event),
        Some(None) => DecodeOutcome::Malformed { discriminator },
        None => DecodeOutcome::Unknown { discriminator },
    }
}

/// Returns `None` for an unknown discriminator, `Some(None)` for a malformed
/// payload, `Some(Some(event))` on success.
fn decode_pump(discriminator: &[u8; 8], payload: &[u8]) -> Option<Option<DomainEvent>> {
    match *discriminator {
        PUMP_CREATE_EVENT => Some(decode_pump_create(payload)),
        PUMP_TRADE_EVENT => Some(decode_pump_trade(payload)),
        PUMP_COMPLETE_EVENT => Some(decode_pump_complete(payload)),
        PUMP_MIGRATION_EVENT => Some(decode_pump_migration(payload)),
        _ => None,
    }
}

fn decode_pumpswap(discriminator: &[u8; 8], payload: &[u8]) -> Option<Option<DomainEvent>> {
    match *discriminator {
        PUMPSWAP_CREATE_POOL_EVENT => Some(decode_pumpswap_pool_created(payload)),
        PUMPSWAP_BUY_EVENT => Some(decode_pumpswap_trade(payload, true)),
        PUMPSWAP_SELL_EVENT => Some(decode_pumpswap_trade(payload, false)),
        _ => None,
    }
}

fn decode_pump_create(payload: &[u8]) -> Option<DomainEvent> {
    let mut cursor = Cursor::new(payload);
    let _name = cursor.read_string()?;
    let _symbol = cursor.read_string()?;
    let _uri = cursor.read_string()?;
    let mint = cursor.read_pubkey()?;
    let bonding_curve = cursor.read_pubkey()?;
    let user = cursor.read_pubkey()?;
    // `creator` was appended later; decode it best-effort when present.
    let creator = if cursor.remaining() >= 32 {
        cursor.read_pubkey()
    } else {
        None
    };
    Some(DomainEvent::PumpTokenCreated {
        mint,
        bonding_curve,
        user,
        creator,
    })
}

fn decode_pump_trade(payload: &[u8]) -> Option<DomainEvent> {
    let mut cursor = Cursor::new(payload);
    let mint = cursor.read_pubkey()?;
    let sol_amount = cursor.read_u64_le()?;
    let token_amount = cursor.read_u64_le()?;
    let is_buy = cursor.read_bool()?;
    let user = cursor.read_pubkey()?;
    let _timestamp = cursor.read_i64_le()?;
    let virtual_sol_reserves = cursor.read_u64_le()?;
    let virtual_token_reserves = cursor.read_u64_le()?;
    let real_sol_reserves = cursor.read_u64_le()?;
    let real_token_reserves = cursor.read_u64_le()?;
    Some(DomainEvent::PumpTrade {
        mint,
        is_buy,
        sol_amount,
        token_amount,
        user,
        virtual_sol_reserves,
        virtual_token_reserves,
        real_sol_reserves,
        real_token_reserves,
    })
}

fn decode_pump_complete(payload: &[u8]) -> Option<DomainEvent> {
    let mut cursor = Cursor::new(payload);
    let user = cursor.read_pubkey()?;
    let mint = cursor.read_pubkey()?;
    let bonding_curve = cursor.read_pubkey()?;
    let _timestamp = cursor.read_i64_le()?;
    Some(DomainEvent::PumpCurveCompleted {
        mint,
        bonding_curve,
        user,
    })
}

fn decode_pump_migration(payload: &[u8]) -> Option<DomainEvent> {
    let mut cursor = Cursor::new(payload);
    let user = cursor.read_pubkey()?;
    let mint = cursor.read_pubkey()?;
    let _mint_amount = cursor.read_u64_le()?;
    let _sol_amount = cursor.read_u64_le()?;
    let _pool_migration_fee = cursor.read_u64_le()?;
    let bonding_curve = cursor.read_pubkey()?;
    let _timestamp = cursor.read_i64_le()?;
    let pool = cursor.read_pubkey()?;
    Some(DomainEvent::PumpMigrationCompleted {
        mint,
        bonding_curve,
        pool,
        user,
    })
}

fn decode_pumpswap_pool_created(payload: &[u8]) -> Option<DomainEvent> {
    let mut cursor = Cursor::new(payload);
    let _timestamp = cursor.read_i64_le()?;
    let _index = cursor.read_u16_le()?;
    let creator = cursor.read_pubkey()?;
    let base_mint = cursor.read_pubkey()?;
    let quote_mint = cursor.read_pubkey()?;
    let _base_decimals = cursor.read_u8()?;
    let _quote_decimals = cursor.read_u8()?;
    let _base_amount_in = cursor.read_u64_le()?;
    let _quote_amount_in = cursor.read_u64_le()?;
    let pool_base_reserves = cursor.read_u64_le()?;
    let pool_quote_reserves = cursor.read_u64_le()?;
    let _minimum_liquidity = cursor.read_u64_le()?;
    let _initial_liquidity = cursor.read_u64_le()?;
    let _lp_token_amount_out = cursor.read_u64_le()?;
    let _pool_bump = cursor.read_u8()?;
    let pool = cursor.read_pubkey()?;
    Some(DomainEvent::PumpSwapPoolCreated {
        pool,
        creator,
        base_mint,
        quote_mint,
        pool_base_reserves,
        pool_quote_reserves,
    })
}

fn decode_pumpswap_trade(payload: &[u8], is_buy: bool) -> Option<DomainEvent> {
    let mut cursor = Cursor::new(payload);
    // BuyEvent and SellEvent share an identical 14-field fixed prefix (i64 + 13
    // u64) followed by the pool pubkey.
    let _timestamp = cursor.read_i64_le()?;
    let _amount = cursor.read_u64_le()?;
    let _limit = cursor.read_u64_le()?;
    let _user_base_reserves = cursor.read_u64_le()?;
    let _user_quote_reserves = cursor.read_u64_le()?;
    let pool_base_reserves = cursor.read_u64_le()?;
    let pool_quote_reserves = cursor.read_u64_le()?;
    let _quote_amount = cursor.read_u64_le()?;
    let _lp_fee_bps = cursor.read_u64_le()?;
    let _lp_fee = cursor.read_u64_le()?;
    let _protocol_fee_bps = cursor.read_u64_le()?;
    let _protocol_fee = cursor.read_u64_le()?;
    let _quote_with_lp_fee = cursor.read_u64_le()?;
    let _user_quote_amount = cursor.read_u64_le()?;
    let pool = cursor.read_pubkey()?;
    Some(DomainEvent::PumpSwapTrade {
        pool,
        is_buy,
        pool_base_reserves,
        pool_quote_reserves,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn framed(discriminator: &[u8; 8], payload: &[u8]) -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&ANCHOR_EVENT_CPI_TAG);
        data.extend_from_slice(discriminator);
        data.extend_from_slice(payload);
        data
    }

    fn pubkey_bytes(seed: u8) -> [u8; 32] {
        [seed; 32]
    }

    fn key(seed: u8) -> String {
        bs58::encode(pubkey_bytes(seed)).into_string()
    }

    #[test]
    fn decodes_pump_trade_with_absolute_reserves() {
        let mut payload = Vec::new();
        payload.extend_from_slice(&pubkey_bytes(1)); // mint
        payload.extend_from_slice(&10u64.to_le_bytes()); // sol_amount
        payload.extend_from_slice(&20u64.to_le_bytes()); // token_amount
        payload.push(1); // is_buy
        payload.extend_from_slice(&pubkey_bytes(2)); // user
        payload.extend_from_slice(&123i64.to_le_bytes()); // timestamp
        payload.extend_from_slice(&30u64.to_le_bytes()); // virtual_sol
        payload.extend_from_slice(&40u64.to_le_bytes()); // virtual_token
        payload.extend_from_slice(&50u64.to_le_bytes()); // real_sol
        payload.extend_from_slice(&60u64.to_le_bytes()); // real_token
        let data = framed(&PUMP_TRADE_EVENT, &payload);

        let outcome = decode(PUMP_PROGRAM_ID, &data);
        assert_eq!(
            outcome,
            DecodeOutcome::Decoded(DomainEvent::PumpTrade {
                mint: key(1),
                is_buy: true,
                sol_amount: 10,
                token_amount: 20,
                user: key(2),
                virtual_sol_reserves: 30,
                virtual_token_reserves: 40,
                real_sol_reserves: 50,
                real_token_reserves: 60,
            })
        );
    }

    #[test]
    fn decodes_pump_create_with_optional_creator() {
        let mut payload = Vec::new();
        for text in ["Name", "SYM", "https://uri"] {
            payload.extend_from_slice(&(text.len() as u32).to_le_bytes());
            payload.extend_from_slice(text.as_bytes());
        }
        payload.extend_from_slice(&pubkey_bytes(1)); // mint
        payload.extend_from_slice(&pubkey_bytes(2)); // bonding_curve
        payload.extend_from_slice(&pubkey_bytes(3)); // user
        payload.extend_from_slice(&pubkey_bytes(4)); // creator (appended)
        let data = framed(&PUMP_CREATE_EVENT, &payload);

        match decode(PUMP_PROGRAM_ID, &data) {
            DecodeOutcome::Decoded(DomainEvent::PumpTokenCreated {
                mint,
                bonding_curve,
                user,
                creator,
            }) => {
                assert_eq!(mint, key(1));
                assert_eq!(bonding_curve, key(2));
                assert_eq!(user, key(3));
                assert_eq!(creator, Some(key(4)));
            }
            other => panic!("unexpected outcome: {other:?}"),
        }
    }

    #[test]
    fn decodes_pumpswap_trade_pool_reserves() {
        let mut payload = Vec::new();
        payload.extend_from_slice(&1i64.to_le_bytes()); // timestamp
        for value in [2u64, 3, 4, 5] {
            payload.extend_from_slice(&value.to_le_bytes());
        }
        payload.extend_from_slice(&111u64.to_le_bytes()); // pool_base_reserves
        payload.extend_from_slice(&222u64.to_le_bytes()); // pool_quote_reserves
        for value in [6u64, 7, 8, 9, 10, 11, 12] {
            payload.extend_from_slice(&value.to_le_bytes());
        }
        payload.extend_from_slice(&pubkey_bytes(9)); // pool
        let data = framed(&PUMPSWAP_BUY_EVENT, &payload);

        assert_eq!(
            decode(PUMPSWAP_PROGRAM_ID, &data),
            DecodeOutcome::Decoded(DomainEvent::PumpSwapTrade {
                pool: key(9),
                is_buy: true,
                pool_base_reserves: 111,
                pool_quote_reserves: 222,
            })
        );
    }

    #[test]
    fn same_input_decodes_identically() {
        let data = framed(&PUMP_COMPLETE_EVENT, &{
            let mut payload = Vec::new();
            payload.extend_from_slice(&pubkey_bytes(2)); // user
            payload.extend_from_slice(&pubkey_bytes(1)); // mint
            payload.extend_from_slice(&pubkey_bytes(3)); // bonding_curve
            payload.extend_from_slice(&5i64.to_le_bytes()); // timestamp
            payload
        });
        assert_eq!(
            decode(PUMP_PROGRAM_ID, &data),
            decode(PUMP_PROGRAM_ID, &data)
        );
    }

    #[test]
    fn unknown_discriminator_is_reported() {
        let data = framed(&[0xaa; 8], &[0u8; 8]);
        assert_eq!(
            decode(PUMP_PROGRAM_ID, &data),
            DecodeOutcome::Unknown {
                discriminator: [0xaa; 8]
            }
        );
    }

    #[test]
    fn malformed_known_event_is_reported() {
        // PUMP_TRADE_EVENT with a truncated payload.
        let data = framed(&PUMP_TRADE_EVENT, &[0u8; 4]);
        assert_eq!(
            decode(PUMP_PROGRAM_ID, &data),
            DecodeOutcome::Malformed {
                discriminator: PUMP_TRADE_EVENT
            }
        );
    }

    #[test]
    fn non_event_payload_is_ignored() {
        assert_eq!(
            decode(PUMP_PROGRAM_ID, &[0u8; 4]),
            DecodeOutcome::NotAnEvent
        );
        assert_eq!(
            decode(PUMP_PROGRAM_ID, &[0u8; 32]),
            DecodeOutcome::NotAnEvent
        );
    }
}
