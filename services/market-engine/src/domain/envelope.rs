//! `DomainEventEnvelope`: a decoded event with deterministic identity and the
//! commitment lifecycle (RFC-004). Commitment promotion is validated so a
//! processed projection is only ever advanced, never silently regressed.

use super::events::{DomainEvent, PARSER_VERSION};
use crate::ingestion::envelope::Commitment;

pub const DOMAIN_EVENT_SCHEMA_VERSION: u32 = 1;
pub const REASON_PROMOTED: &str = "COMMITMENT_PROMOTED";
pub const REASON_ORPHANED: &str = "EVENT_ORPHANED";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DomainEventEnvelope {
    pub schema_version: u32,
    pub event_id: String,
    pub event_type: &'static str,
    pub program_id: String,
    pub slot: u64,
    pub commitment: Commitment,
    pub signature: Option<String>,
    pub instruction_index: Option<u32>,
    pub inner_index: Option<u32>,
    pub parser_version: &'static str,
    pub mint: Option<String>,
    pub pool: Option<String>,
    pub payload_hash: String,
    pub reason_code: Option<String>,
    pub event: DomainEvent,
}

pub struct DomainEventLocation {
    pub program_id: String,
    pub slot: u64,
    pub commitment: Commitment,
    pub signature: Option<String>,
    pub instruction_index: Option<u32>,
    pub inner_index: Option<u32>,
    pub payload_hash: String,
}

impl DomainEventEnvelope {
    pub fn from_decoded(location: DomainEventLocation, event: DomainEvent) -> Self {
        let event_type = event.event_type();
        let event_id = format!(
            "{}:{}:{}:{}:{}",
            location.signature.as_deref().unwrap_or("-"),
            location
                .instruction_index
                .map_or_else(|| "-".to_owned(), |value| value.to_string()),
            location
                .inner_index
                .map_or_else(|| "-".to_owned(), |value| value.to_string()),
            event_type,
            location.commitment.as_str(),
        );
        Self {
            schema_version: DOMAIN_EVENT_SCHEMA_VERSION,
            event_id,
            event_type,
            program_id: location.program_id,
            slot: location.slot,
            commitment: location.commitment,
            signature: location.signature,
            instruction_index: location.instruction_index,
            inner_index: location.inner_index,
            parser_version: PARSER_VERSION,
            mint: event.mint().map(str::to_owned),
            pool: event.pool().map(str::to_owned),
            payload_hash: location.payload_hash,
            reason_code: None,
            event,
        }
    }
}

/// Rank commitments so promotion can be validated (processed < confirmed <
/// finalized).
const fn rank(commitment: Commitment) -> u8 {
    match commitment {
        Commitment::Processed => 0,
        Commitment::Confirmed => 1,
        Commitment::Finalized => 2,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommitmentTransition {
    /// Same identity reached a stronger commitment.
    Promoted,
    /// Same or weaker commitment: nothing to do.
    Redundant,
}

/// Decide whether moving `previous` to `next` is a promotion. Distinct
/// commitments of the same event never collapse; this only governs which one is
/// authoritative for the projection.
pub fn evaluate_transition(previous: Commitment, next: Commitment) -> CommitmentTransition {
    if rank(next) > rank(previous) {
        CommitmentTransition::Promoted
    } else {
        CommitmentTransition::Redundant
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_event() -> DomainEvent {
        DomainEvent::PumpCurveCompleted {
            mint: "mint".to_owned(),
            bonding_curve: "curve".to_owned(),
            user: "user".to_owned(),
        }
    }

    fn location(commitment: Commitment) -> DomainEventLocation {
        DomainEventLocation {
            program_id: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P".to_owned(),
            slot: 100,
            commitment,
            signature: Some("sig".to_owned()),
            instruction_index: Some(2),
            inner_index: Some(0),
            payload_hash: "0".repeat(64),
        }
    }

    #[test]
    fn event_id_is_deterministic_and_commitment_scoped() {
        let a = DomainEventEnvelope::from_decoded(location(Commitment::Processed), sample_event());
        let b = DomainEventEnvelope::from_decoded(location(Commitment::Processed), sample_event());
        let confirmed =
            DomainEventEnvelope::from_decoded(location(Commitment::Confirmed), sample_event());
        assert_eq!(a.event_id, b.event_id);
        assert_ne!(a.event_id, confirmed.event_id);
        assert_eq!(a.mint, Some("mint".to_owned()));
        assert_eq!(a.event_type, "PumpCurveCompleted");
    }

    #[test]
    fn promotion_only_moves_forward() {
        assert_eq!(
            evaluate_transition(Commitment::Processed, Commitment::Confirmed),
            CommitmentTransition::Promoted
        );
        assert_eq!(
            evaluate_transition(Commitment::Confirmed, Commitment::Finalized),
            CommitmentTransition::Promoted
        );
        assert_eq!(
            evaluate_transition(Commitment::Finalized, Commitment::Processed),
            CommitmentTransition::Redundant
        );
        assert_eq!(
            evaluate_transition(Commitment::Confirmed, Commitment::Confirmed),
            CommitmentTransition::Redundant
        );
    }
}
