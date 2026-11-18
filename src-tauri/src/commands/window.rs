use crate::error::{CmdResult, PdfError};
use std::sync::atomic::{AtomicU32, Ordering};

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::{AppState, StartupArgs};

static NEXT_WINDOW: AtomicU32 = AtomicU32::new(1);

fn safe_file_name(name: &str) -> String {
    let cleaned: String =
        name.chars().map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c }).collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    if trimmed.is_empty() {
        "Pages.pdf".to_string()
    } else {
        trimmed.to_string()
    }
}

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
        tauri::async_runtime::spawn_blocking(move || super::pdf::extract_pdf_pages(input_path, out_str, pages))
    };
    extract.await.map_err(|e| e.to_string())??;

    crate::allow_viewing(&app, &out_str);
    let args = StartupArgs { file_path: Some(out_str), unsaved: true, ..Default::default() };
    open_window(&app, args, x.zip(y).map(|(x, y)| (x - 160.0, y - 16.0)))
}

#[tauri::command]
pub fn open_file_in_new_window(app: AppHandle, path: String) -> CmdResult<()> {
    crate::grants::check(&path)?;
    open_window(&app, StartupArgs { file_path: Some(path), ..Default::default() }, None)
}

pub(crate) fn open_window(app: &AppHandle, args: StartupArgs, position: Option<(f64, f64)>) -> CmdResult<()> {
    let n = NEXT_WINDOW.fetch_add(1, Ordering::Relaxed);
    let label = format!("doc-{n}");
    app.state::<AppState>().window_args.lock().unwrap().insert(label.clone(), args);

    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("EzReader")
        .inner_size(1100.0, 760.0)
        .min_inner_size(720.0, 480.0)
        .resizable(true);
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(crate::TRAFFIC_LIGHTS.0, crate::TRAFFIC_LIGHTS.1));
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.decorations(false);
    }
    if let Some((x, y)) = position {
        builder = builder.position(x, y);
    }
    if let Err(e) = builder.build() {
        app.state::<AppState>().window_args.lock().unwrap().remove(&label);
        return Err(PdfError::from(e.to_string()));
    }
    Ok(())
}

static TAB_HOVER: Mutex<Option<String>> = Mutex::new(None);

fn window_at(app: &AppHandle, own: &str, x: f64, y: f64) -> Option<String> {
    let mut hits: Vec<String> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, w)| {
            if label == own || !w.is_visible().unwrap_or(false) || w.is_minimized().unwrap_or(false) {
                return false;
            }
            let (Ok(sf), Ok(pos), Ok(size)) = (w.scale_factor(), w.outer_position(), w.outer_size()) else {
                return false;
            };
            let pos = pos.to_logical::<f64>(sf);
            let size = size.to_logical::<f64>(sf);
            contains((pos.x, pos.y, size.width, size.height), (x, y))
        })
        .map(|(label, _)| label)
        .collect();
    hits.sort_by_key(|l| !app.get_webview_window(l).and_then(|w| w.is_focused().ok()).unwrap_or(false));
    hits.into_iter().next()
}

fn contains((left, top, width, height): (f64, f64, f64, f64), (x, y): (f64, f64)) -> bool {
    x >= left && x < left + width && y >= top && y < top + height
}

fn set_hover(app: &AppHandle, target: Option<String>) {
    let mut hover = TAB_HOVER.lock().unwrap();
    if *hover == target {
        return;
    }
    if let Some(old) = hover.take() {
        let _ = app.emit_to(old.as_str(), "tab-drag-hover", false);
    }
    if let Some(new) = &target {
        let _ = app.emit_to(new.as_str(), "tab-drag-hover", true);
    }
    *hover = target;
}

#[tauri::command]
pub fn tab_drag_hover(app: AppHandle, window: WebviewWindow, x: f64, y: f64) -> bool {
    let target = window_at(&app, window.label(), x, y);
    let over = target.is_some();
    set_hover(&app, target);
    over
}

#[tauri::command]
pub fn tab_drag_end(app: AppHandle) {
    set_hover(&app, None);
}

#[tauri::command]
pub async fn move_tab(
    app: AppHandle,
    window: WebviewWindow,
    x: f64,
    y: f64,
    mut tab: StartupArgs,
    name: Option<String>,
    allow_new: bool,
) -> CmdResult<String> {
    let Some(file) = tab.file_path.clone() else { return Err(PdfError::from("No file".to_string())) };
    crate::grants::check(&file)?;
    if let Some(save) = &tab.save_path {
        crate::grants::check(save)?;
    }
    tab.should_print = false;
    let target = window_at(&app, window.label(), x, y);
    set_hover(&app, None);
    if target.is_none() && !allow_new {
        return Ok("stayed".into());
    }
    if let Some(name) = name {
        let n = NEXT_WINDOW.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("ezreader-window-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let out = dir.join(safe_file_name(&name));
        std::fs::copy(&file, &out).map_err(|e| e.to_string())?;
        let out = out.to_string_lossy().into_owned();
        crate::allow_viewing(&app, &out);
        tab.file_path = Some(out);
    }
    match target.and_then(|l| app.get_webview_window(&l)) {
        Some(w) => {
            w.emit_to(w.label(), "tab-received", &tab).map_err(|e| e.to_string())?;
            let _ = w.set_focus();
            Ok("merged".into())
        }
        None => {
            open_window(&app, tab, Some((x - 160.0, y - 16.0)))?;
            Ok("window".into())
        }
    }
}

fn new_document_dir() -> CmdResult<std::path::PathBuf> {
    let n = NEXT_WINDOW.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("ezreader-window-new-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

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
    use super::{contains, new_document_dir, safe_file_name};

    #[test]
    fn a_point_is_in_a_window_up_to_its_edge() {
        let w = (100.0, 50.0, 800.0, 600.0);
        assert!(contains(w, (100.0, 50.0)));
        assert!(contains(w, (899.0, 649.0)));
        assert!(!contains(w, (900.0, 300.0)));
        assert!(!contains(w, (99.0, 300.0)));
        assert!(!contains(w, (300.0, 650.0)));
    }

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
