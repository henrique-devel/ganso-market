//! Bounded, priority-ordered in-memory buffer with an idempotency window
//! (RFC-003 tasks 5-6). Under saturation it evicts dispensable (lower-priority)
//! items rather than dropping exit-critical ones.

use std::collections::{HashSet, VecDeque};

use super::envelope::RawEnvelope;
use super::priority::Priority;

/// FIFO idempotency window: bounded so memory stays flat; the oldest key is
/// evicted when full.
pub struct DedupWindow {
    seen: HashSet<String>,
    order: VecDeque<String>,
    capacity: usize,
}

impl DedupWindow {
    pub fn new(capacity: usize) -> Self {
        Self {
            seen: HashSet::new(),
            order: VecDeque::new(),
            capacity: capacity.max(1),
        }
    }

    /// Returns true if the key was not seen within the window (i.e. admit it).
    pub fn admit(&mut self, key: &str) -> bool {
        if self.seen.contains(key) {
            return false;
        }
        if self.order.len() >= self.capacity
            && let Some(oldest) = self.order.pop_front()
        {
            self.seen.remove(&oldest);
        }
        self.seen.insert(key.to_owned());
        self.order.push_back(key.to_owned());
        true
    }

    pub fn len(&self) -> usize {
        self.order.len()
    }

    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Admission {
    Admitted,
    Duplicate,
    /// Dropped because the buffer was full and nothing lower-priority could be
    /// evicted.
    DroppedFull,
    /// Admitted, but a lower-priority item was evicted to make room.
    AdmittedEvicted,
}

pub struct PriorityQueue {
    buffers: [VecDeque<RawEnvelope>; 4],
    bytes: u64,
    byte_cap: u64,
    count_cap: usize,
    dedup: DedupWindow,
}

impl PriorityQueue {
    pub fn new(byte_cap: u64, count_cap: usize, dedup_capacity: usize) -> Self {
        Self {
            buffers: [
                VecDeque::new(),
                VecDeque::new(),
                VecDeque::new(),
                VecDeque::new(),
            ],
            bytes: 0,
            byte_cap: byte_cap.max(1),
            count_cap: count_cap.max(1),
            dedup: DedupWindow::new(dedup_capacity),
        }
    }

    pub fn len(&self) -> usize {
        self.buffers.iter().map(VecDeque::len).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    pub fn depth(&self, priority: Priority) -> usize {
        self.buffers[priority as usize].len()
    }

    /// Fraction of capacity used, by count or bytes, whichever is higher.
    pub fn fill_ratio(&self) -> f64 {
        let by_count = self.len() as f64 / self.count_cap as f64;
        let by_bytes = self.bytes as f64 / self.byte_cap as f64;
        by_count.max(by_bytes)
    }

    fn would_overflow(&self, extra_bytes: u64) -> bool {
        self.len() + 1 > self.count_cap || self.bytes + extra_bytes > self.byte_cap
    }

    /// Evict one item from the lowest-priority non-empty buffer strictly below
    /// `incoming`. Returns true if something was evicted.
    fn evict_lower_than(&mut self, incoming: Priority) -> bool {
        for priority in Priority::ALL.iter().rev() {
            if *priority <= incoming {
                break;
            }
            let index = *priority as usize;
            if let Some(evicted) = self.buffers[index].pop_front() {
                self.bytes = self.bytes.saturating_sub(evicted.payload_bytes);
                return true;
            }
        }
        false
    }

    pub fn push(&mut self, priority: Priority, envelope: RawEnvelope) -> Admission {
        if !self.dedup.admit(&envelope.idempotency_key()) {
            return Admission::Duplicate;
        }
        let extra = envelope.payload_bytes;
        let mut evicted = false;
        while self.would_overflow(extra) {
            if self.evict_lower_than(priority) {
                evicted = true;
            } else {
                return Admission::DroppedFull;
            }
        }
        self.bytes += extra;
        self.buffers[priority as usize].push_back(envelope);
        if evicted {
            Admission::AdmittedEvicted
        } else {
            Admission::Admitted
        }
    }

    /// Pop the highest-priority (P0 first) envelope available.
    pub fn pop(&mut self) -> Option<(Priority, RawEnvelope)> {
        for priority in Priority::ALL {
            if let Some(envelope) = self.buffers[priority as usize].pop_front() {
                self.bytes = self.bytes.saturating_sub(envelope.payload_bytes);
                return Some((priority, envelope));
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::super::envelope::{Commitment, EnvelopeIdentity, EnvelopeKind, RawEnvelope};
    use super::*;

    fn envelope(tag: &str, bytes: u64) -> RawEnvelope {
        RawEnvelope {
            schema_version: 1,
            source: "yellowstone".to_owned(),
            slot: 1,
            commitment: Commitment::Processed,
            received_at_ms: 0,
            kind: EnvelopeKind::Transaction,
            identity: EnvelopeIdentity::Transaction {
                signature: tag.to_owned(),
                instruction_index: 0,
                inner_index: None,
            },
            payload_hash: "0".repeat(64),
            payload_bytes: bytes,
        }
    }

    #[test]
    fn dedup_window_rejects_repeats_and_evicts_oldest() {
        let mut window = DedupWindow::new(2);
        assert!(window.admit("a"));
        assert!(!window.admit("a"));
        assert!(window.admit("b"));
        assert!(window.admit("c")); // evicts "a"
        assert!(window.admit("a")); // "a" is admittable again
        assert_eq!(window.len(), 2);
    }

    #[test]
    fn pop_returns_p0_before_lower_priorities() {
        let mut queue = PriorityQueue::new(1_000, 10, 100);
        assert_eq!(
            queue.push(Priority::P2, envelope("d", 1)),
            Admission::Admitted
        );
        assert_eq!(
            queue.push(Priority::P0, envelope("x", 1)),
            Admission::Admitted
        );
        let (priority, _) = queue.pop().expect("item");
        assert_eq!(priority, Priority::P0);
    }

    #[test]
    fn duplicates_are_not_enqueued() {
        let mut queue = PriorityQueue::new(1_000, 10, 100);
        assert_eq!(
            queue.push(Priority::P1, envelope("same", 1)),
            Admission::Admitted
        );
        assert_eq!(
            queue.push(Priority::P1, envelope("same", 1)),
            Admission::Duplicate
        );
        assert_eq!(queue.len(), 1);
    }

    #[test]
    fn full_buffer_evicts_dispensable_for_p0() {
        let mut queue = PriorityQueue::new(1_000, 2, 100);
        assert_eq!(
            queue.push(Priority::P3, envelope("junk1", 1)),
            Admission::Admitted
        );
        assert_eq!(
            queue.push(Priority::P3, envelope("junk2", 1)),
            Admission::Admitted
        );
        // Buffer is at count cap; a P0 event evicts a P3 rather than being lost.
        assert_eq!(
            queue.push(Priority::P0, envelope("exit", 1)),
            Admission::AdmittedEvicted
        );
        let (priority, _) = queue.pop().expect("item");
        assert_eq!(priority, Priority::P0);
    }

    #[test]
    fn full_buffer_drops_incoming_when_nothing_lower_exists() {
        let mut queue = PriorityQueue::new(1_000, 1, 100);
        assert_eq!(
            queue.push(Priority::P0, envelope("keep", 1)),
            Admission::Admitted
        );
        // Another P0 cannot evict an equal-or-higher priority item.
        assert_eq!(
            queue.push(Priority::P0, envelope("drop", 1)),
            Admission::DroppedFull
        );
        assert_eq!(queue.len(), 1);
    }
}
