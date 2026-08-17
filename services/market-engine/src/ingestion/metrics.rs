//! Ingestion metrics (RFC-003 task 11). Plain atomic counters rendered as
//! Prometheus text; no secret or endpoint material is ever recorded.

use std::sync::atomic::{AtomicU64, Ordering};

use super::priority::Priority;

pub struct IngestionMetrics {
    pub slots_seen: AtomicU64,
    pub last_slot: AtomicU64,
    pub lag_ms: AtomicU64,
    pub envelopes_total: AtomicU64,
    pub bytes_total: AtomicU64,
    pub duplicates_total: AtomicU64,
    pub drops_total: AtomicU64,
    pub reconnects_total: AtomicU64,
    pub wal_bytes: AtomicU64,
    queue_depth: [AtomicU64; 4],
}

impl IngestionMetrics {
    pub fn new() -> Self {
        Self {
            slots_seen: AtomicU64::new(0),
            last_slot: AtomicU64::new(0),
            lag_ms: AtomicU64::new(0),
            envelopes_total: AtomicU64::new(0),
            bytes_total: AtomicU64::new(0),
            duplicates_total: AtomicU64::new(0),
            drops_total: AtomicU64::new(0),
            reconnects_total: AtomicU64::new(0),
            wal_bytes: AtomicU64::new(0),
            queue_depth: [
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
            ],
        }
    }

    pub fn set_queue_depth(&self, priority: Priority, depth: u64) {
        self.queue_depth[priority as usize].store(depth, Ordering::Relaxed);
    }

    pub fn queue_depth(&self, priority: Priority) -> u64 {
        self.queue_depth[priority as usize].load(Ordering::Relaxed)
    }

    pub fn incr_envelopes(&self, bytes: u64) {
        self.envelopes_total.fetch_add(1, Ordering::Relaxed);
        self.bytes_total.fetch_add(bytes, Ordering::Relaxed);
    }

    pub fn render(&self) -> String {
        let mut out = String::new();
        let counters: [(&str, &str, u64); 9] = [
            (
                "ganso_ingestion_slots_seen_total",
                "counter",
                self.slots_seen.load(Ordering::Relaxed),
            ),
            (
                "ganso_ingestion_last_slot",
                "gauge",
                self.last_slot.load(Ordering::Relaxed),
            ),
            (
                "ganso_ingestion_lag_ms",
                "gauge",
                self.lag_ms.load(Ordering::Relaxed),
            ),
            (
                "ganso_ingestion_envelopes_total",
                "counter",
                self.envelopes_total.load(Ordering::Relaxed),
            ),
            (
                "ganso_ingestion_bytes_total",
                "counter",
                self.bytes_total.load(Ordering::Relaxed),
            ),
            (
                "ganso_ingestion_duplicates_total",
                "counter",
                self.duplicates_total.load(Ordering::Relaxed),
            ),
            (
                "ganso_ingestion_drops_total",
                "counter",
                self.drops_total.load(Ordering::Relaxed),
            ),
            (
                "ganso_ingestion_reconnects_total",
                "counter",
                self.reconnects_total.load(Ordering::Relaxed),
            ),
            (
                "ganso_ingestion_wal_bytes",
                "gauge",
                self.wal_bytes.load(Ordering::Relaxed),
            ),
        ];
        for (name, kind, value) in counters {
            out.push_str(&format!("# TYPE {name} {kind}\n{name} {value}\n"));
        }
        out.push_str("# TYPE ganso_ingestion_queue_depth gauge\n");
        for priority in Priority::ALL {
            out.push_str(&format!(
                "ganso_ingestion_queue_depth{{priority=\"{}\"}} {}\n",
                priority.as_str(),
                self.queue_depth(priority),
            ));
        }
        out
    }
}

impl Default for IngestionMetrics {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_includes_all_series() {
        let metrics = IngestionMetrics::new();
        metrics.incr_envelopes(128);
        metrics.slots_seen.store(3, Ordering::Relaxed);
        metrics.set_queue_depth(Priority::P0, 2);
        let text = metrics.render();
        assert!(text.contains("ganso_ingestion_envelopes_total 1"));
        assert!(text.contains("ganso_ingestion_bytes_total 128"));
        assert!(text.contains("ganso_ingestion_slots_seen_total 3"));
        assert!(text.contains("ganso_ingestion_queue_depth{priority=\"p0\"} 2"));
    }
}
