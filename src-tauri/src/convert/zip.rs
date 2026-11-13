//! A minimal ZIP writer (deflate, no encryption, no ZIP64): enough for the
//! .docx and .xlsx packages, which are ZIP files of XML parts.

use flate2::{write::DeflateEncoder, Compression};
use std::io::Write;

/// DOS date of 1 January 1980, the earliest a ZIP entry can carry.
const DOS_DATE: u16 = (1 << 5) | 1;

/// Packs `(name, contents)` entries, in order, into a ZIP archive.
pub fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in entries {
        let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
        enc.write_all(data).expect("writing to memory");
        let packed = enc.finish().expect("writing to memory");
        let crc = crc32fast::hash(data);
        let offset = out.len() as u32;
        let name = name.as_bytes();

        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&8u16.to_le_bytes()); // deflate
        out.extend_from_slice(&0u16.to_le_bytes()); // time
        out.extend_from_slice(&DOS_DATE.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(packed.len() as u32).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra
        out.extend_from_slice(name);
        out.extend_from_slice(&packed);

        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // made by
        central.extend_from_slice(&20u16.to_le_bytes()); // needed
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&8u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&DOS_DATE.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&(packed.len() as u32).to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&[0; 12]); // extra, comment, disk, internal & external attributes
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name);
    }
    let central_offset = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]); // disk numbers
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // comment
    out
}

/// Reads back an archive written by [`zip`] (for tests).
#[cfg(test)]
pub fn unzip(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    use std::io::Read;
    let u16_at = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]) as usize;
    let u32_at = |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]) as usize;
    let end = bytes.len() - 22;
    assert_eq!(u32_at(end), 0x0605_4b50);
    let count = u16_at(end + 10);
    let mut at = u32_at(end + 16);
    let mut out = Vec::new();
    for _ in 0..count {
        assert_eq!(u32_at(at), 0x0201_4b50);
        let crc = u32_at(at + 16) as u32;
        let packed = u32_at(at + 20);
        let size = u32_at(at + 24);
        let name_len = u16_at(at + 28);
        let local = u32_at(at + 42);
        let name = String::from_utf8(bytes[at + 46..at + 46 + name_len].to_vec()).unwrap();
        assert_eq!(u32_at(local), 0x0403_4b50);
        let start = local + 30 + u16_at(local + 26) + u16_at(local + 28);
        let mut data = Vec::new();
        flate2::read::DeflateDecoder::new(&bytes[start..start + packed]).read_to_end(&mut data).unwrap();
        assert_eq!(data.len(), size);
        assert_eq!(crc32fast::hash(&data), crc);
        out.push((name, data));
        at += 46 + name_len;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let big = "hello ".repeat(1000);
        let z = zip(&[("a.xml", b"<a/>"), ("dir/b.txt", big.as_bytes()), ("empty", b"")]);
        let back = unzip(&z);
        assert_eq!(back.len(), 3);
        assert_eq!(back[0], ("a.xml".to_string(), b"<a/>".to_vec()));
        assert_eq!(back[1].0, "dir/b.txt");
        assert_eq!(back[1].1, big.as_bytes());
        assert_eq!(back[2].1, b"");
        assert!(z.len() < big.len());
    }
}
