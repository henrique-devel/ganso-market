//! Deterministic backpressure state machine (RFC-003 task 10). Escalating
//! saturation blocks new opportunities before it can threaten exits, and losing
//! a P0 event is always critical.

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum BackpressureState {
    Nominal,
    /// Pause enrichment work.
    PauseEnrichment,
    /// Stop admitting new candidates.
    NoNewCandidates,
    /// Emit no-new-risk: refuse new exposure entirely.
    NoNewRisk,
    /// Drop dispensable (P3) and raw P2 to protect the pipeline.
    DropDispensable,
    /// A P0 event was lost: trading must be halted.
    Critical,
}

impl BackpressureState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Nominal => "nominal",
            Self::PauseEnrichment => "pause_enrichment",
            Self::NoNewCandidates => "no_new_candidates",
            Self::NoNewRisk => "no_new_risk",
            Self::DropDispensable => "drop_dispensable",
            Self::Critical => "critical",
        }
    }

    /// Whether new exposure (candidates/positions) must be refused in this state.
    pub const fn blocks_new_risk(self) -> bool {
        matches!(
            self,
            Self::NoNewRisk | Self::DropDispensable | Self::Critical
        )
    }
}

// Thresholds are engineering hypotheses to be re-measured against a live feed.
const LAG_PAUSE_MS: u64 = 2_000;
const LAG_NO_CANDIDATES_MS: u64 = 5_000;
const LAG_NO_RISK_MS: u64 = 15_000;
const LAG_DROP_MS: u64 = 30_000;
const FILL_PAUSE: f64 = 0.50;
const FILL_NO_CANDIDATES: f64 = 0.60;
const FILL_NO_RISK: f64 = 0.80;
const DISK_DROP: f64 = 0.85;

/// Evaluate the current backpressure state from feed lag, queue fill ratio,
/// disk usage ratio, and whether a P0 event was dropped. Returns the most severe
/// triggered state.
pub fn evaluate(lag_ms: u64, fill_ratio: f64, disk_ratio: f64, p0_lost: bool) -> BackpressureState {
    if p0_lost {
        return BackpressureState::Critical;
    }
    if lag_ms > LAG_DROP_MS || disk_ratio > DISK_DROP {
        return BackpressureState::DropDispensable;
    }
    if lag_ms > LAG_NO_RISK_MS || fill_ratio > FILL_NO_RISK {
        return BackpressureState::NoNewRisk;
    }
    if lag_ms > LAG_NO_CANDIDATES_MS || fill_ratio > FILL_NO_CANDIDATES {
        return BackpressureState::NoNewCandidates;
    }
    if lag_ms > LAG_PAUSE_MS || fill_ratio > FILL_PAUSE {
        return BackpressureState::PauseEnrichment;
    }
    BackpressureState::Nominal
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nominal_when_healthy() {
        assert_eq!(evaluate(500, 0.10, 0.20, false), BackpressureState::Nominal);
    }

    #[test]
    fn lost_p0_is_always_critical() {
        assert_eq!(evaluate(0, 0.0, 0.0, true), BackpressureState::Critical);
    }

    #[test]
    fn escalates_with_lag() {
        assert_eq!(
            evaluate(2_500, 0.0, 0.0, false),
            BackpressureState::PauseEnrichment
        );
        assert_eq!(
            evaluate(6_000, 0.0, 0.0, false),
            BackpressureState::NoNewCandidates
        );
        assert_eq!(
            evaluate(16_000, 0.0, 0.0, false),
            BackpressureState::NoNewRisk
        );
        assert_eq!(
            evaluate(31_000, 0.0, 0.0, false),
            BackpressureState::DropDispensable
        );
    }

    #[test]
    fn escalates_with_fill_and_disk() {
        assert_eq!(
            evaluate(0, 0.55, 0.0, false),
            BackpressureState::PauseEnrichment
        );
        assert_eq!(evaluate(0, 0.85, 0.0, false), BackpressureState::NoNewRisk);
        assert_eq!(
            evaluate(0, 0.0, 0.90, false),
            BackpressureState::DropDispensable
        );
    }

    #[test]
    fn no_new_risk_states_block_exposure() {
        assert!(!BackpressureState::PauseEnrichment.blocks_new_risk());
        assert!(BackpressureState::NoNewRisk.blocks_new_risk());
        assert!(BackpressureState::Critical.blocks_new_risk());
    }
}
