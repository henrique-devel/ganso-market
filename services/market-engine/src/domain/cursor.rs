//! Minimal Borsh-style reader for decoding Anchor event payloads. Every read is
//! bounds-checked and returns `None` on underflow so a malformed payload is
//! quarantined rather than panicking.

pub struct Cursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    pub fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.offset)
    }

    fn take(&mut self, len: usize) -> Option<&'a [u8]> {
        let end = self.offset.checked_add(len)?;
        let slice = self.bytes.get(self.offset..end)?;
        self.offset = end;
        Some(slice)
    }

    pub fn read_u8(&mut self) -> Option<u8> {
        self.take(1).map(|slice| slice[0])
    }

    pub fn read_bool(&mut self) -> Option<bool> {
        self.read_u8().map(|value| value != 0)
    }

    pub fn read_u16_le(&mut self) -> Option<u16> {
        let slice = self.take(2)?;
        Some(u16::from_le_bytes([slice[0], slice[1]]))
    }

    pub fn read_u64_le(&mut self) -> Option<u64> {
        let slice = self.take(8)?;
        let mut buf = [0u8; 8];
        buf.copy_from_slice(slice);
        Some(u64::from_le_bytes(buf))
    }

    pub fn read_i64_le(&mut self) -> Option<i64> {
        self.read_u64_le().map(|value| value as i64)
    }

    /// A 32-byte public key, returned as a base58 string (canonical Solana form).
    pub fn read_pubkey(&mut self) -> Option<String> {
        let slice = self.take(32)?;
        Some(bs58::encode(slice).into_string())
    }

    /// Borsh string: u32 little-endian length prefix followed by UTF-8 bytes.
    pub fn read_string(&mut self) -> Option<String> {
        let slice = self.take(4)?;
        let len = u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]) as usize;
        let bytes = self.take(len)?;
        String::from_utf8(bytes.to_vec()).ok()
    }

    /// Skip `len` bytes; returns None if fewer remain.
    pub fn skip(&mut self, len: usize) -> Option<()> {
        self.take(len).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_scalars_in_order() {
        let mut bytes = Vec::new();
        bytes.push(1u8); // bool true
        bytes.extend_from_slice(&7u16.to_le_bytes());
        bytes.extend_from_slice(&42u64.to_le_bytes());
        bytes.extend_from_slice(&(-5i64).to_le_bytes());
        let mut cursor = Cursor::new(&bytes);
        assert_eq!(cursor.read_bool(), Some(true));
        assert_eq!(cursor.read_u16_le(), Some(7));
        assert_eq!(cursor.read_u64_le(), Some(42));
        assert_eq!(cursor.read_i64_le(), Some(-5));
        assert_eq!(cursor.read_u8(), None);
    }

    #[test]
    fn reads_pubkey_and_string() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&[7u8; 32]);
        bytes.extend_from_slice(&3u32.to_le_bytes());
        bytes.extend_from_slice(b"abc");
        let mut cursor = Cursor::new(&bytes);
        let key = cursor.read_pubkey().expect("pubkey");
        assert_eq!(key, bs58::encode([7u8; 32]).into_string());
        assert_eq!(cursor.read_string(), Some("abc".to_owned()));
    }

    #[test]
    fn underflow_returns_none() {
        let mut cursor = Cursor::new(&[0u8; 3]);
        assert_eq!(cursor.read_u64_le(), None);
    }
}
