use std::path::{Path, PathBuf};

use lopdf::{Document, IncrementalDocument};

fn temp_path_for(target: &Path) -> PathBuf {
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "output.pdf".to_string());
    let nanos =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    target.with_file_name(format!(".{name}.{}-{nanos}.tmp", std::process::id()))
}

pub fn write_atomic<F>(target: impl AsRef<Path>, write: F) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let target = target.as_ref();
    let tmp = temp_path_for(target);
    let result = write(&tmp).and_then(|()| std::fs::rename(&tmp, target).map_err(|e| e.to_string()));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

pub fn load_incremental(path: impl AsRef<Path>) -> Result<IncrementalDocument, String> {
    let bytes = std::fs::read(path.as_ref()).map_err(|e| e.to_string())?;
    let doc = Document::load_mem(&bytes).map_err(|e| e.to_string())?;
    incremental_from(bytes, doc)
}

/// An incremental update on top of `doc`, parsed from `bytes`, so a caller that already parsed
/// the file does not parse it again. A file whose cross-reference data had to be repaired is
/// rewritten first, so the update does not point back at the broken table.
pub fn incremental_from(bytes: Vec<u8>, mut doc: Document) -> Result<IncrementalDocument, String> {
    if doc.xref_recovery.is_none() {
        return Ok(IncrementalDocument::create_from(bytes, doc));
    }
    let mut fresh = Vec::new();
    doc.save_to(&mut fresh).map_err(|e| e.to_string())?;
    let prev = Document::load_mem(&fresh).map_err(|e| e.to_string())?;
    Ok(IncrementalDocument::create_from(fresh, prev))
}

pub fn copy_atomic(src: impl AsRef<Path>, dst: impl AsRef<Path>) -> Result<(), String> {
    let src = src.as_ref();
    write_atomic(dst, |tmp| std::fs::copy(src, tmp).map(|_| ()).map_err(|e| e.to_string()))
}

pub fn save_document(doc: &mut Document, dst: impl AsRef<Path>) -> Result<(), String> {
    write_atomic(dst, |tmp| doc.save(tmp).map(|_| ()).map_err(|e| e.to_string()))
}

pub fn save_compacted(inc: &mut IncrementalDocument, dst: impl AsRef<Path>) -> Result<(), String> {
    let mut doc = compacted(inc)?;
    save_document(&mut doc, dst)
}

pub fn compacted(inc: &mut IncrementalDocument) -> Result<Document, String> {
    let mut merged = Vec::new();
    inc.save_to(&mut merged).map_err(|e| e.to_string())?;
    let mut doc = Document::load_mem(&merged).map_err(|e| e.to_string())?;
    doc.prune_objects();
    Ok(doc)
}

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

        write_atomic(&target, |tmp| std::fs::write(tmp, b"new").map_err(|e| e.to_string())).unwrap();

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
