//! `RawEnvelope`: the versioned, idempotent unit produced by the receiver before
//! any domain decoding (RFC-003). It never contains secret material and carries
//! enough identity to deduplicate without collapsing distinct commitments
//! (SOL-05/DATA-02).

use sha2::{Digest, Sha256};

pub const ENVELOPE_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Commitment {
    Processed,
    Confirmed,
    Finalized,
}

impl Commitment {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Processed => "processed",
            Self::Confirmed => "confirmed",
            Self::Finalized => "finalized",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnvelopeKind {
    Transaction,
    Account,
    Slot,
}

impl EnvelopeKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Transaction => "transaction",
            Self::Account => "account",
            Self::Slot => "slot",
        }
    }
}

/// Identity distinguishes the two dedupable shapes. Transaction identity uses the
/// signature and instruction indices; account identity uses pubkey + write
/// version. The commitment is combined in at the envelope level.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EnvelopeIdentity {
    Transaction {
        signature: String,
        instruction_index: u32,
        inner_index: Option<u32>,
    },
    Account {
        pubkey: String,
        write_version: u64,
    },
    Slot,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RawEnvelope {
    pub schema_version: u32,
    pub source: String,
    pub slot: u64,
    pub commitment: Commitment,
    pub received_at_ms: i64,
    pub kind: EnvelopeKind,
    pub identity: EnvelopeIdentity,
    pub payload_hash: String,
    pub payload_bytes: u64,
}

impl RawEnvelope {
    /// Deterministic idempotency key. Distinct commitments never collapse; a
    /// duplicate delivery of the same event at the same commitment maps to the
    /// same key.
    pub fn idempotency_key(&self) -> String {
        match &self.identity {
            EnvelopeIdentity::Transaction {
                signature,
                instruction_index,
                inner_index,
            } => format!(
                "tx:{}:{}:{}:{}:{}:{}",
                self.commitment.as_str(),
                self.slot,
                signature,
                instruction_index,
                inner_index.map_or_else(|| "-".to_owned(), |value| value.to_string()),
                self.kind.as_str(),
            ),
            EnvelopeIdentity::Account {
                pubkey,
                write_version,
            } => format!(
                "acct:{}:{}:{}:{}",
                self.commitment.as_str(),
                self.slot,
                pubkey,
                write_version,
            ),
            EnvelopeIdentity::Slot => {
                format!("slot:{}:{}", self.commitment.as_str(), self.slot)
            }
        }
    }
}

/// SHA-256 of the raw payload, hex-encoded. Used as `payload_hash` so identical
/// payloads are detectable and the raw bytes need not be retained past their TTL.
pub fn compute_payload_hash(payload: &[u8]) -> String {
    let digest = Sha256::digest(payload);
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tx_envelope(commitment: Commitment, inner: Option<u32>) -> RawEnvelope {
        RawEnvelope {
            schema_version: ENVELOPE_SCHEMA_VERSION,
            source: "yellowstone".to_owned(),
            slot: 42,
            commitment,
            received_at_ms: 1_000,
            kind: EnvelopeKind::Transaction,
            identity: EnvelopeIdentity::Transaction {
                signature: "sig".to_owned(),
                instruction_index: 3,
                inner_index: inner,
            },
            payload_hash: compute_payload_hash(b"payload"),
            payload_bytes: 7,
        }
    }

    #[test]
    fn payload_hash_is_stable_hex() {
        let hash = compute_payload_hash(b"payload");
        assert_eq!(hash.len(), 64);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(hash, compute_payload_hash(b"payload"));
        assert_ne!(hash, compute_payload_hash(b"other"));
    }

    #[test]
    fn identical_events_share_a_key() {
        assert_eq!(
            tx_envelope(Commitment::Processed, Some(1)).idempotency_key(),
            tx_envelope(Commitment::Processed, Some(1)).idempotency_key(),
        );
    }

    #[test]
    fn distinct_commitments_do_not_collapse() {
        assert_ne!(
            tx_envelope(Commitment::Processed, None).idempotency_key(),
            tx_envelope(Commitment::Confirmed, None).idempotency_key(),
        );
    }

    #[test]
    fn account_identity_uses_pubkey_and_write_version() {
        let base = RawEnvelope {
            schema_version: ENVELOPE_SCHEMA_VERSION,
            source: "yellowstone".to_owned(),
            slot: 10,
            commitment: Commitment::Confirmed,
            received_at_ms: 5,
            kind: EnvelopeKind::Account,
            identity: EnvelopeIdentity::Account {
                pubkey: "mint".to_owned(),
                write_version: 100,
            },
            payload_hash: compute_payload_hash(b"a"),
            payload_bytes: 1,
        };
        let mut newer = base.clone();
        newer.identity = EnvelopeIdentity::Account {
            pubkey: "mint".to_owned(),
            write_version: 101,
        };
        assert_ne!(base.idempotency_key(), newer.idempotency_key());
    }
}
