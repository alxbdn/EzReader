use crate::error::{CmdResult, PdfError};
use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::{AppState, StartupArgs};

static NEXT_WINDOW: AtomicU32 = AtomicU32::new(1);

/// Characters Windows does not accept in a file name.
fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    if trimmed.is_empty() { "Pages.pdf".to_string() } else { trimmed.to_string() }
}

/// Copies `pages` of `input_path` into a new temp file named `name` and opens
/// it in a new EzReader window near the screen point (`x`, `y`). The new
/// document has never been saved: its first Save asks where to put it.
#[tauri::command]
pub async fn open_pages_in_new_window(
    app: AppHandle,
    input_path: String,
    pages: Vec<u32>,
    name: String,
    x: Option<f64>,
    y: Option<f64>,
) -> CmdResult<()> {
    crate::grants::check(&input_path)?;
    let n = NEXT_WINDOW.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("ezreader-window-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(safe_file_name(&name));
    let out_str = out.to_string_lossy().to_string();
    let extract = {
        let out_str = out_str.clone();
        tauri::async_runtime::spawn_blocking(move || {
            super::pdf::extract_pdf_pages(input_path, out_str, pages)
        })
    };
    extract.await.map_err(|e| e.to_string())??;

    crate::allow_viewing(&app, &out_str);
    let label = format!("doc-{n}");
    app.state::<AppState>().window_args.lock().unwrap().insert(
        label.clone(),
        StartupArgs { file_path: Some(out_str), should_print: false, unsaved: true },
    );

    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("EzReader")
        .inner_size(1100.0, 760.0)
        .min_inner_size(720.0, 480.0)
        .decorations(false)
        .resizable(true);
    if let (Some(x), Some(y)) = (x, y) {
        // The pointer lands on the title bar, a little in from the left.
        builder = builder.position(x - 160.0, y - 16.0);
    }
    if let Err(e) = builder.build() {
        app.state::<AppState>().window_args.lock().unwrap().remove(&label);
        return Err(PdfError::from(e.to_string()));
    }
    Ok(())
}

/// A fresh temp folder for a new, never-saved document, which the commands
/// may use (see `grants`): `%TEMP%\ezreader-window-new-…`.
fn new_document_dir() -> CmdResult<std::path::PathBuf> {
    let n = NEXT_WINDOW.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("ezreader-window-new-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Writes `image_paths` (one page each) to a new temp PDF named `name` and
/// returns its path, ready to open in this window. The document has never
/// been saved: its first Save asks where to put it.
#[tauri::command]
pub async fn pictures_to_new_pdf(app: AppHandle, image_paths: Vec<String>, name: String) -> CmdResult<String> {
    crate::grants::check_all(image_paths.iter())?;
    let out = new_document_dir()?.join(safe_file_name(&name));
    let out_str = out.to_string_lossy().to_string();
    let target = out_str.clone();
    tauri::async_runtime::spawn_blocking(move || super::pdf::images_to_pdf(image_paths, target))
        .await
        .map_err(|e| e.to_string())??;
    crate::allow_viewing(&app, &out_str);
    Ok(out_str)
}

#[cfg(test)]
mod tests {
    use super::{new_document_dir, safe_file_name};

    #[test]
    fn new_documents_get_their_own_temp_folder() {
        let a = new_document_dir().unwrap();
        let b = new_document_dir().unwrap();
        assert_ne!(a, b);
        assert!(a.file_name().unwrap().to_string_lossy().starts_with("ezreader-window-"));
        assert_eq!(a.parent().unwrap(), std::env::temp_dir().as_path());
        std::fs::remove_dir_all(&a).ok();
        std::fs::remove_dir_all(&b).ok();
    }

    #[test]
    fn file_names_are_made_safe() {
        assert_eq!(safe_file_name("report (pages 2-3).pdf"), "report (pages 2-3).pdf");
        assert_eq!(safe_file_name("a/b:c?.pdf"), "a_b_c_.pdf");
        assert_eq!(safe_file_name("  ...  "), "Pages.pdf");
    }
}
