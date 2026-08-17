//! Verified 8-byte discriminators from the official Pump/PumpSwap IDLs
//! (github.com/pump-fun/pump-public-docs). These are read from the IDL, not
//! computed, and must never be invented (RFC-004 stop condition).

/// Anchor event-CPI marker (`sha256("anchor:event")[..8]`), on the wire in
/// little-endian. Every emitted event's inner-instruction data starts with this.
pub const ANCHOR_EVENT_CPI_TAG: [u8; 8] = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];

// Pump program events.
pub const PUMP_CREATE_EVENT: [u8; 8] = [0x1b, 0x72, 0xa9, 0x4d, 0xde, 0xeb, 0x63, 0x76];
pub const PUMP_TRADE_EVENT: [u8; 8] = [0xbd, 0xdb, 0x7f, 0xd3, 0x4e, 0xe6, 0x61, 0xee];
pub const PUMP_COMPLETE_EVENT: [u8; 8] = [0x5f, 0x72, 0x61, 0x9c, 0xd4, 0x2e, 0x98, 0x08];
pub const PUMP_MIGRATION_EVENT: [u8; 8] = [0xbd, 0xe9, 0x5d, 0xb9, 0x5c, 0x94, 0xea, 0x94];

// PumpSwap (pump_amm) program events.
pub const PUMPSWAP_CREATE_POOL_EVENT: [u8; 8] = [0xb1, 0x31, 0x0c, 0xd2, 0xa0, 0x76, 0xa7, 0x74];
pub const PUMPSWAP_BUY_EVENT: [u8; 8] = [0x67, 0xf4, 0x52, 0x1f, 0x2c, 0xf5, 0x77, 0x77];
pub const PUMPSWAP_SELL_EVENT: [u8; 8] = [0x3e, 0x2f, 0x37, 0x0a, 0xa5, 0x03, 0xdc, 0x2a];

/// Hex-encode an 8-byte discriminator for quarantine records/logs.
pub fn to_hex(discriminator: &[u8; 8]) -> String {
    let mut hex = String::with_capacity(16);
    for byte in discriminator {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_matches_known_trade_event() {
        assert_eq!(to_hex(&PUMP_TRADE_EVENT), "bddb7fd34ee661ee");
        assert_eq!(to_hex(&ANCHOR_EVENT_CPI_TAG), "e445a52e51cb9a1d");
    }
}
