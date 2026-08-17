//! Segmented write-ahead log with per-record checksums and a hard total-size cap
//! (RFC-003 task 7). Records are length-prefixed and checksummed so corruption is
//! detectable; the oldest segments are pruned to stay within the disk budget
//! rather than growing without bound.

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const HEADER_BYTES: usize = 8; // 4-byte length + 4-byte checksum

fn checksum(payload: &[u8]) -> [u8; 4] {
    let digest = Sha256::digest(payload);
    [digest[0], digest[1], digest[2], digest[3]]
}

fn segment_name(index: u64) -> String {
    format!("seg-{index:010}.wal")
}

struct Segment {
    path: PathBuf,
    bytes: u64,
}

pub struct SegmentedWal {
    dir: PathBuf,
    segment_max_bytes: u64,
    total_max_bytes: u64,
    next_index: u64,
    total_bytes: u64,
    segments: VecDeque<Segment>,
    current: File,
    current_bytes: u64,
}

impl SegmentedWal {
    /// Open a WAL in `dir`, starting a fresh segment. Any existing segments are
    /// retained and counted toward the total budget.
    pub fn open(dir: &Path, segment_max_bytes: u64, total_max_bytes: u64) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let mut segments = VecDeque::new();
        let mut total_bytes = 0u64;
        let mut highest_index = 0u64;

        let mut existing: Vec<(u64, PathBuf, u64)> = Vec::new();
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if let Some(index) = parse_segment_index(&name) {
                let bytes = entry.metadata()?.len();
                existing.push((index, path, bytes));
            }
        }
        existing.sort_by_key(|item| item.0);
        for (index, path, bytes) in existing {
            highest_index = highest_index.max(index);
            total_bytes += bytes;
            segments.push_back(Segment { path, bytes });
        }

        let next_index = highest_index + 1;
        let (current, current_path) = open_segment(dir, next_index)?;
        segments.push_back(Segment {
            path: current_path,
            bytes: 0,
        });

        let mut wal = Self {
            dir: dir.to_path_buf(),
            segment_max_bytes: segment_max_bytes.max(HEADER_BYTES as u64 + 1),
            total_max_bytes: total_max_bytes.max(segment_max_bytes.max(1)),
            next_index,
            total_bytes,
            segments,
            current,
            current_bytes: 0,
        };
        wal.prune()?;
        Ok(wal)
    }

    pub fn total_bytes(&self) -> u64 {
        self.total_bytes
    }

    pub fn segment_count(&self) -> usize {
        self.segments.len()
    }

    /// Append one record, rotating the segment when it would exceed the segment
    /// cap and pruning old segments to honor the total cap.
    pub fn append(&mut self, payload: &[u8]) -> io::Result<()> {
        let frame_len = HEADER_BYTES as u64 + payload.len() as u64;
        if self.current_bytes > 0 && self.current_bytes + frame_len > self.segment_max_bytes {
            self.rotate()?;
        }

        let length = u32::try_from(payload.len())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "record too large"))?;
        let mut frame = Vec::with_capacity(frame_len as usize);
        frame.extend_from_slice(&length.to_le_bytes());
        frame.extend_from_slice(&checksum(payload));
        frame.extend_from_slice(payload);
        self.current.write_all(&frame)?;
        self.current.flush()?;

        self.current_bytes += frame_len;
        self.total_bytes += frame_len;
        if let Some(last) = self.segments.back_mut() {
            last.bytes += frame_len;
        }
        self.prune()?;
        Ok(())
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.next_index += 1;
        let (file, path) = open_segment(&self.dir, self.next_index)?;
        self.current = file;
        self.current_bytes = 0;
        self.segments.push_back(Segment { path, bytes: 0 });
        Ok(())
    }

    fn prune(&mut self) -> io::Result<()> {
        while self.total_bytes > self.total_max_bytes && self.segments.len() > 1 {
            if let Some(oldest) = self.segments.pop_front() {
                self.total_bytes = self.total_bytes.saturating_sub(oldest.bytes);
                fs::remove_file(&oldest.path)?;
            }
        }
        Ok(())
    }
}

fn parse_segment_index(name: &str) -> Option<u64> {
    let stem = name.strip_prefix("seg-")?.strip_suffix(".wal")?;
    stem.parse().ok()
}

fn open_segment(dir: &Path, index: u64) -> io::Result<(File, PathBuf)> {
    let path = dir.join(segment_name(index));
    let file = OpenOptions::new().create(true).append(true).open(&path)?;
    Ok((file, path))
}

/// Read every segment in order, verifying checksums. Returns the decoded record
/// payloads. Used by tests and recovery.
pub fn read_segments(dir: &Path) -> io::Result<Vec<Vec<u8>>> {
    let mut files: Vec<(u64, PathBuf)> = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        if let Some(index) = parse_segment_index(&name.to_string_lossy()) {
            files.push((index, entry.path()));
        }
    }
    files.sort_by_key(|item| item.0);

    let mut records = Vec::new();
    for (_, path) in files {
        let mut bytes = Vec::new();
        File::open(&path)?.read_to_end(&mut bytes)?;
        let mut offset = 0usize;
        while offset + HEADER_BYTES <= bytes.len() {
            let length = u32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ]) as usize;
            let stored = [
                bytes[offset + 4],
                bytes[offset + 5],
                bytes[offset + 6],
                bytes[offset + 7],
            ];
            let start = offset + HEADER_BYTES;
            let end = start + length;
            if end > bytes.len() {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "truncated WAL record",
                ));
            }
            let payload = &bytes[start..end];
            if checksum(payload) != stored {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "WAL checksum mismatch",
                ));
            }
            records.push(payload.to_vec());
            offset = end;
        }
    }
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_round_trip_with_checksums() {
        let dir = tempfile::tempdir().expect("tempdir");
        {
            let mut wal = SegmentedWal::open(dir.path(), 4_096, 1_000_000).expect("open");
            wal.append(b"first").expect("append");
            wal.append(b"second").expect("append");
            wal.append(b"third").expect("append");
        }
        let records = read_segments(dir.path()).expect("read");
        assert_eq!(
            records,
            vec![b"first".to_vec(), b"second".to_vec(), b"third".to_vec()]
        );
    }

    #[test]
    fn rotates_segments_at_the_segment_cap() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut wal = SegmentedWal::open(dir.path(), 24, 1_000_000).expect("open");
        for _ in 0..5 {
            wal.append(b"0123456789").expect("append");
        }
        // Each record frames to 18 bytes; a 24-byte cap forces one per segment.
        assert!(wal.segment_count() >= 5);
        let records = read_segments(dir.path()).expect("read");
        assert_eq!(records.len(), 5);
    }

    #[test]
    fn prunes_oldest_segments_past_the_total_cap() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut wal = SegmentedWal::open(dir.path(), 24, 60).expect("open");
        for _ in 0..10 {
            wal.append(b"0123456789").expect("append");
        }
        assert!(wal.total_bytes() <= 60);
        // Older records were pruned; only the most recent survive.
        let records = read_segments(dir.path()).expect("read");
        assert!(records.len() < 10);
        assert!(!records.is_empty());
    }

    #[test]
    fn detects_corruption() {
        let dir = tempfile::tempdir().expect("tempdir");
        {
            let mut wal = SegmentedWal::open(dir.path(), 4_096, 1_000_000).expect("open");
            wal.append(b"payload").expect("append");
        }
        // Corrupt the single segment's payload byte.
        let segment = dir.path().join(segment_name(1));
        let mut bytes = fs::read(&segment).expect("read");
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        fs::write(&segment, &bytes).expect("write");
        assert!(read_segments(dir.path()).is_err());
    }
}
