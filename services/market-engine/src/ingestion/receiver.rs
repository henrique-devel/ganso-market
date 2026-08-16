//! Yellowstone receiver: connects with TLS + x-token, subscribes to the filtered
//! discovery stream, maps updates into `RawEnvelope`s, and feeds the priority
//! queue and metrics. Reconnect uses exponential backoff with jitter. The live
//! loop is not exercised by unit tests (it needs a real endpoint, an external
//! blocker); the pure mapping and backoff logic below are.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::{SinkExt, StreamExt};
use yellowstone_grpc_client::{ClientTlsConfig, GeyserGrpcClient};
use yellowstone_grpc_proto::geyser::{SubscribeRequestPing, subscribe_update::UpdateOneof};

use super::envelope::{
    Commitment, ENVELOPE_SCHEMA_VERSION, EnvelopeIdentity, EnvelopeKind, RawEnvelope,
    compute_payload_hash,
};
use super::metrics::IngestionMetrics;
use super::priority::{EventClass, Priority, classify};
use super::queue::{Admission, PriorityQueue};
use super::subscription::discovery_request;

const BACKOFF_BASE_MS: u64 = 200;
const BACKOFF_CAP_MS: u64 = 30_000;
const SOURCE: &str = "yellowstone";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReceiverError {
    Connect,
    Subscribe,
    Stream,
    Closed,
}

impl ReceiverError {
    pub const fn reason_code(self) -> &'static str {
        match self {
            Self::Connect => "YELLOWSTONE_CONNECT_FAILED",
            Self::Subscribe => "YELLOWSTONE_SUBSCRIBE_FAILED",
            Self::Stream => "YELLOWSTONE_STREAM_FAILED",
            Self::Closed => "YELLOWSTONE_STREAM_CLOSED",
        }
    }
}

pub struct ReceiverConfig {
    pub endpoint: String,
    pub x_token: String,
    pub connect_timeout: Duration,
}

/// Exponential backoff with a cap; `jitter_frac` in [0,1) scales an additional
/// portion of the base delay to avoid reconnect storms.
pub fn backoff_delay(attempt: u32, jitter_frac: f64) -> Duration {
    let shift = attempt.min(7);
    let base = BACKOFF_BASE_MS.saturating_mul(1u64 << shift);
    let capped = base.min(BACKOFF_CAP_MS);
    let jitter = (BACKOFF_BASE_MS as f64 * jitter_frac.clamp(0.0, 1.0)) as u64;
    Duration::from_millis(capped.saturating_add(jitter))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn to_hex(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// Map a transaction update into a discovery-priority envelope. Semantic
/// re-classification (candidate, position, migration) happens after decoding in
/// RFC-004; here everything from the discovery stream is P2.
pub fn map_transaction_envelope(
    slot: u64,
    signature: &[u8],
    commitment: Commitment,
) -> RawEnvelope {
    RawEnvelope {
        schema_version: ENVELOPE_SCHEMA_VERSION,
        source: SOURCE.to_owned(),
        slot,
        commitment,
        received_at_ms: now_ms(),
        kind: EnvelopeKind::Transaction,
        identity: EnvelopeIdentity::Transaction {
            signature: to_hex(signature),
            instruction_index: 0,
            inner_index: None,
        },
        payload_hash: compute_payload_hash(signature),
        payload_bytes: signature.len() as u64,
    }
}

pub fn map_slot_envelope(slot: u64, commitment: Commitment) -> RawEnvelope {
    RawEnvelope {
        schema_version: ENVELOPE_SCHEMA_VERSION,
        source: SOURCE.to_owned(),
        slot,
        commitment,
        received_at_ms: now_ms(),
        kind: EnvelopeKind::Slot,
        identity: EnvelopeIdentity::Slot,
        payload_hash: compute_payload_hash(&slot.to_le_bytes()),
        payload_bytes: 8,
    }
}

fn enqueue(
    queue: &Mutex<PriorityQueue>,
    metrics: &IngestionMetrics,
    priority: Priority,
    envelope: RawEnvelope,
) {
    let bytes = envelope.payload_bytes;
    let Ok(mut guard) = queue.lock() else {
        return;
    };
    match guard.push(priority, envelope) {
        Admission::Admitted | Admission::AdmittedEvicted => metrics.incr_envelopes(bytes),
        Admission::Duplicate => {
            metrics
                .duplicates_total
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        Admission::DroppedFull => {
            metrics
                .drops_total
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
    for level in Priority::ALL {
        metrics.set_queue_depth(level, guard.depth(level) as u64);
    }
}

/// Run one connection lifecycle: connect, subscribe, and process the discovery
/// stream until it errors or closes, returning the reason. The caller wraps this
/// with reconnect/backoff.
pub async fn run_stream(
    config: &ReceiverConfig,
    queue: &Mutex<PriorityQueue>,
    metrics: &IngestionMetrics,
) -> ReceiverError {
    let builder = match GeyserGrpcClient::build_from_shared(config.endpoint.clone()) {
        Ok(builder) => builder,
        Err(_) => return ReceiverError::Connect,
    };
    let builder = match builder.x_token(Some(config.x_token.clone())) {
        Ok(builder) => builder,
        Err(_) => return ReceiverError::Connect,
    };
    let builder = match builder.tls_config(ClientTlsConfig::new().with_native_roots()) {
        Ok(builder) => builder,
        Err(_) => return ReceiverError::Connect,
    };
    let builder = builder
        .connect_timeout(config.connect_timeout)
        .timeout(config.connect_timeout)
        .max_decoding_message_size(64 * 1024 * 1024);

    let mut client = match builder.connect().await {
        Ok(client) => client,
        Err(_) => return ReceiverError::Connect,
    };

    let request = discovery_request();
    let (mut sink, mut stream) = match client.subscribe_with_request(Some(request.clone())).await {
        Ok(pair) => pair,
        Err(_) => return ReceiverError::Subscribe,
    };

    loop {
        let update = match stream.next().await {
            Some(Ok(update)) => update,
            Some(Err(_)) => return ReceiverError::Stream,
            None => return ReceiverError::Closed,
        };
        match update.update_oneof {
            Some(UpdateOneof::Slot(slot)) => {
                metrics
                    .slots_seen
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                metrics
                    .last_slot
                    .store(slot.slot, std::sync::atomic::Ordering::Relaxed);
                enqueue(
                    queue,
                    metrics,
                    classify(EventClass::Dispensable),
                    map_slot_envelope(slot.slot, Commitment::Processed),
                );
            }
            Some(UpdateOneof::Transaction(transaction)) => {
                if let Some(info) = transaction.transaction {
                    enqueue(
                        queue,
                        metrics,
                        classify(EventClass::Discovery),
                        map_transaction_envelope(
                            transaction.slot,
                            &info.signature,
                            Commitment::Processed,
                        ),
                    );
                }
            }
            Some(UpdateOneof::Ping(_)) => {
                let pong = SubscribeRequestPing { id: 1 };
                let request = yellowstone_grpc_proto::geyser::SubscribeRequest {
                    ping: Some(pong),
                    ..request.clone()
                };
                if sink.send(request).await.is_err() {
                    return ReceiverError::Stream;
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_then_caps() {
        let first = backoff_delay(0, 0.0);
        let later = backoff_delay(20, 0.0);
        assert!(first < later);
        assert!(later <= Duration::from_millis(BACKOFF_CAP_MS + BACKOFF_BASE_MS));
        assert_eq!(
            backoff_delay(0, 0.0),
            Duration::from_millis(BACKOFF_BASE_MS)
        );
    }

    #[test]
    fn hex_encoding_is_lowercase_and_padded() {
        assert_eq!(to_hex(&[0x00, 0x0f, 0xff]), "000fff");
    }

    #[test]
    fn transaction_envelope_carries_signature_identity() {
        let envelope = map_transaction_envelope(99, &[1, 2, 3], Commitment::Confirmed);
        assert_eq!(envelope.slot, 99);
        assert_eq!(envelope.kind, EnvelopeKind::Transaction);
        match envelope.identity {
            EnvelopeIdentity::Transaction { signature, .. } => assert_eq!(signature, "010203"),
            _ => panic!("expected transaction identity"),
        }
    }

    #[test]
    fn enqueue_updates_metrics_and_depth() {
        let queue = Mutex::new(PriorityQueue::new(10_000, 100, 1_000));
        let metrics = IngestionMetrics::new();
        enqueue(
            &queue,
            &metrics,
            Priority::P2,
            map_transaction_envelope(1, &[9, 9], Commitment::Processed),
        );
        assert_eq!(
            metrics
                .envelopes_total
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
        assert_eq!(metrics.queue_depth(Priority::P2), 1);
    }
}
