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
