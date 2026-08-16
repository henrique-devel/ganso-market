//! Filtered Yellowstone ingestion (RFC-003): allowlist, versioned raw envelopes
//! with idempotency, priority classification, bounded queue with backpressure,
//! a checksummed segmented WAL, metrics, and the resilient receiver.
//!
//! The live receiver requires an external Yellowstone credential (a documented
//! blocker); every deterministic component here is unit-tested offline.

pub mod allowlist;
pub mod backpressure;
pub mod envelope;
pub mod metrics;
pub mod priority;
pub mod queue;
pub mod receiver;
pub mod subscription;
pub mod wal;
