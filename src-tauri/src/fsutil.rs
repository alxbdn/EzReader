//! Crash-safe file output.
//!
//! Every command that writes a PDF goes through [`write_atomic`]: the bytes
//! are written to a temporary file next to the target, then renamed over it.
//! A crash or error mid-write leaves the original file untouched instead of
//! half-written — which matters because "Save" overwrites the file the user
//! opened.

use std::path::{Path, PathBuf};

use lopdf::{Document, IncrementalDocument};

fn temp_path_for(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "output.pdf".to_string());
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    target.with_file_name(format!(".{name}.{}-{nanos}.tmp", std::process::id()))
}

/// Calls `write` with a temporary path in the target's directory, then
/// renames the result over `target`. The temporary file is removed on error.
pub fn write_atomic<F>(target: impl AsRef<Path>, write: F) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let target = target.as_ref();
    let tmp = temp_path_for(target);
    let result = write(&tmp).and_then(|()| {
        // std::fs::rename replaces an existing destination on both Windows
        // (MoveFileExW + MOVEFILE_REPLACE_EXISTING) and Unix.
        std::fs::rename(&tmp, target).map_err(|e| e.to_string())
    });
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Byte-for-byte copy of `src` to `dst`, atomically.
pub fn copy_atomic(src: impl AsRef<Path>, dst: impl AsRef<Path>) -> Result<(), String> {
    let src = src.as_ref();
    write_atomic(dst, |tmp| {
        std::fs::copy(src, tmp).map(|_| ()).map_err(|e| e.to_string())
    })
}

/// Saves a full document rewrite to `dst`, atomically.
pub fn save_document(doc: &mut Document, dst: impl AsRef<Path>) -> Result<(), String> {
    write_atomic(dst, |tmp| doc.save(tmp).map(|_| ()).map_err(|e| e.to_string()))
}

/// Saves `inc` to `dst` as one self-contained file: the update is merged
/// into the original, every object nothing points at any more is dropped,
/// and the result is written as a full rewrite.
///
/// Use this whenever the update leaves content out (deleted or unselected
/// pages): an incremental save keeps the left-out objects in the original
/// bytes, where anyone with a text editor can still read them.
pub fn save_compacted(inc: &mut IncrementalDocument, dst: impl AsRef<Path>) -> Result<(), String> {
    let mut merged = Vec::new();
    inc.save_to(&mut merged).map_err(|e| e.to_string())?;
    let mut doc = Document::load_mem(&merged).map_err(|e| e.to_string())?;
    doc.prune_objects();
    save_document(&mut doc, dst)
}

/// Saves an incremental update to `dst`, atomically.
pub fn save_incremental(inc: &mut IncrementalDocument, dst: impl AsRef<Path>) -> Result<(), String> {
    write_atomic(dst, |tmp| inc.save(tmp).map(|_| ()).map_err(|e| e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_existing_file_and_leaves_no_temp() {
        let dir = std::env::temp_dir().join(format!("ezreader-fsutil-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("doc.pdf");
        std::fs::write(&target, b"old").unwrap();

        write_atomic(&target, |tmp| std::fs::write(tmp, b"new").map_err(|e| e.to_string()))
            .unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"new");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn failed_write_keeps_original() {
        let dir = std::env::temp_dir().join(format!("ezreader-fsutil-fail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("doc.pdf");
        std::fs::write(&target, b"original").unwrap();

        let err = write_atomic(&target, |tmp| {
            std::fs::write(tmp, b"partial").unwrap();
            Err("boom".to_string())
        });

        assert!(err.is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }
}
