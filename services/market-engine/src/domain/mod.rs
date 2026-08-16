//! Domain decoding and projections (RFC-004): verified Pump/PumpSwap event
//! decoders, deterministic domain envelopes with commitment lifecycle,
//! idempotent lifecycle projections, and the persistence/quarantine contract.
//!
//! Live persistence (microbatched writes, TTL pruning, Parquet compaction) is
//! wired when the ingestion receiver runs against a real feed; every decoder and
//! projection here is unit-tested offline with synthetic Borsh payloads.

pub mod cursor;
pub mod discriminators;
pub mod envelope;
pub mod events;
pub mod projection;
pub mod store;
