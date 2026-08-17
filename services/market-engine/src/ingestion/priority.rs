//! Priority classification for ingested events (RFC-003 task 8). Exit and
//! position-critical events outrank discovery so saturation never starves them.

/// Lower value = higher priority. P0 is served before all others.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum Priority {
    P0,
    P1,
    P2,
    P3,
}

impl Priority {
    pub const ALL: [Priority; 4] = [Priority::P0, Priority::P1, Priority::P2, Priority::P3];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::P0 => "p0",
            Self::P1 => "p1",
            Self::P2 => "p2",
            Self::P3 => "p3",
        }
    }
}

/// Semantic class of an event, independent of transport.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EventClass {
    /// Open position, exit, authority/liquidity change, or migration.
    PositionOrExit,
    AuthorityOrLiquidity,
    Migration,
    /// An active candidate token/pool.
    Candidate,
    /// Discovery of new tokens/pools.
    Discovery,
    /// Raw or telemetry that may be dropped under pressure.
    Dispensable,
}

pub const fn classify(class: EventClass) -> Priority {
    match class {
        EventClass::PositionOrExit | EventClass::AuthorityOrLiquidity | EventClass::Migration => {
            Priority::P0
        }
        EventClass::Candidate => Priority::P1,
        EventClass::Discovery => Priority::P2,
        EventClass::Dispensable => Priority::P3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn position_and_exit_events_are_p0() {
        assert_eq!(classify(EventClass::PositionOrExit), Priority::P0);
        assert_eq!(classify(EventClass::AuthorityOrLiquidity), Priority::P0);
        assert_eq!(classify(EventClass::Migration), Priority::P0);
    }

    #[test]
    fn discovery_ranks_below_candidates() {
        assert!(classify(EventClass::Candidate) < classify(EventClass::Discovery));
        assert!(classify(EventClass::Discovery) < classify(EventClass::Dispensable));
    }
}
