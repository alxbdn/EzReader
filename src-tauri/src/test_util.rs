//! Shared helpers for unit tests.

pub fn fixture(name: &str) -> String {
    format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))
}

pub fn tmp(name: &str) -> String {
    std::env::temp_dir()
        .join(format!("ezreader-{}-{name}", std::process::id()))
        .to_string_lossy()
        .into_owned()
}

/// Scans the raw file: for every stream with a direct `/Length N`, the
/// `endstream` keyword must follow exactly N bytes after `stream`. lopdf's
/// reader silently recovers from a wrong length, so this has to check the
/// bytes other readers (Acrobat, Chrome, qpdf) actually see.
pub fn assert_lengths_consistent(path: &str) {
    let bytes = std::fs::read(path).unwrap();
    let find = |hay: &[u8], needle: &[u8], from: usize| {
        hay[from..].windows(needle.len()).position(|w| w == needle).map(|p| p + from)
    };
    let mut pos = 0;
    let mut checked = 0;
    while let Some(at) = find(&bytes, b"stream", pos) {
        pos = at + 6;
        if at >= 3 && &bytes[at - 3..at] == b"end" {
            continue;
        }
        let mut data = at + 6;
        if bytes.get(data) == Some(&b'\r') { data += 1; }
        if bytes.get(data) != Some(&b'\n') { continue; }
        data += 1;
        // Nearest "/Length" before the keyword, inside the same object.
        let obj_start = bytes[..at].windows(3).rposition(|w| w == b"obj").unwrap_or(0);
        let Some(len_at) = bytes[obj_start..at].windows(7).rposition(|w| w == b"/Length") else { continue };
        let tail = &bytes[obj_start + len_at + 7..at];
        let txt = String::from_utf8_lossy(tail);
        let mut it = txt.split(|c: char| !c.is_ascii_digit()).filter(|t| !t.is_empty());
        let Some(n) = it.next().and_then(|t| t.parse::<usize>().ok()) else { continue };
        if txt.trim_start().trim_start_matches(char::is_numeric).trim_start().starts_with("0 R") {
            continue; // indirect length
        }
        let mut end = data + n;
        while matches!(bytes.get(end), Some(b'\r' | b'\n' | b' ')) { end += 1; }
        assert!(
            bytes[end..].starts_with(b"endstream"),
            "stream at byte {at} has a /Length {n} that does not match its data"
        );
        checked += 1;
    }
    assert!(checked > 0);
}

