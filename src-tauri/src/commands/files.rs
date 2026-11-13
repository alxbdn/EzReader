use std::path::Path;

use tauri::AppHandle;

/// Moves `from` to `to` unless `to` already exists, so a rename never
/// overwrites another file. Both paths must be in the same folder.
pub(crate) fn rename_no_clobber(from: &Path, to: &Path) -> Result<(), String> {
    if from.parent() != to.parent() {
        return Err("invalid".into());
    }
    match to.file_name().and_then(|n| n.to_str()) {
        Some(name) if !name.trim().is_empty() && !name.contains(['/', '\\']) => {}
        _ => return Err("invalid".into()),
    }
    if from == to {
        return Ok(());
    }
    // A case-only change ("a.pdf" -> "A.pdf") is the same file on Windows.
    let same_file = from
        .to_string_lossy()
        .eq_ignore_ascii_case(&to.to_string_lossy());
    if to.exists() && !same_file {
        return Err("exists".into());
    }
    std::fs::rename(from, to).map_err(|e| e.to_string())
}

/// Renames the open document on disk (the title bar rename, applied on save).
/// Fails with "exists" when another file already has that name.
#[tauri::command]
pub fn rename_file(app: AppHandle, from: String, to: String) -> Result<(), String> {
    rename_no_clobber(Path::new(&from), Path::new(&to))?;
    crate::allow_viewing(&app, &to);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "ezreader-rename-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn renames_a_file() {
        let d = dir();
        let a = d.join("a.pdf");
        let b = d.join("b.pdf");
        std::fs::write(&a, b"x").unwrap();
        rename_no_clobber(&a, &b).unwrap();
        assert!(!a.exists());
        assert_eq!(std::fs::read(&b).unwrap(), b"x");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn refuses_to_overwrite() {
        let d = dir();
        let a = d.join("a.pdf");
        let b = d.join("b.pdf");
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&b, b"b").unwrap();
        assert_eq!(rename_no_clobber(&a, &b), Err("exists".to_string()));
        assert_eq!(std::fs::read(&b).unwrap(), b"b");
        assert!(a.exists());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn refuses_other_folders_and_empty_names() {
        let d = dir();
        let a = d.join("a.pdf");
        std::fs::write(&a, b"a").unwrap();
        let elsewhere = d.join("sub").join("b.pdf");
        assert_eq!(rename_no_clobber(&a, &elsewhere), Err("invalid".to_string()));
        assert_eq!(rename_no_clobber(&a, &d.join(" ")), Err("invalid".to_string()));
        assert!(a.exists());
        let _ = std::fs::remove_dir_all(d);
    }
}

/// Largest picture accepted from disk.
const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;

/// Reads a picture (by its extension) and returns its bytes as base64.
#[tauri::command]
pub fn read_image_file(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = read_image_bytes(&path)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// The bytes of a picture file, checked by extension and size.
pub fn read_image_bytes(path: &str) -> Result<Vec<u8>, String> {
    let p = std::path::Path::new(path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !crate::commands::dialog::IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err("not an image".into());
    }
    let len = std::fs::metadata(p).map_err(|e| e.to_string())?.len();
    if len > MAX_IMAGE_BYTES {
        return Err("too large".into());
    }
    std::fs::read(p).map_err(|e| e.to_string())
}

/// Which of `paths` already exist (export asks before replacing them).
#[tauri::command]
pub fn existing_files(paths: Vec<String>) -> Vec<String> {
    paths.into_iter().filter(|p| std::path::Path::new(p).exists()).collect()
}

/// Writes base64 `data` (a page picture of an export) to `path`, atomically.
/// Only PNG and JPEG files can be written this way.
#[tauri::command]
pub fn write_image_file(path: String, data: String) -> Result<(), String> {
    use base64::Engine;
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg") {
        return Err("only PNG and JPEG pictures can be written".into());
    }
    let b64 = data.split_once(',').map_or(data.as_str(), |(_, d)| d);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("invalid image data: {e}"))?;
    crate::fsutil::write_atomic(&path, |tmp| std::fs::write(tmp, &bytes).map_err(|e| e.to_string()))
}
