mod commands;
mod convert;
mod error;
mod fsutil;
mod ocr;
mod pdf;
#[cfg(test)]
mod test_util;

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{DragDropEvent, Manager, WindowEvent};

#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupArgs {
    pub file_path: Option<String>,
    pub should_print: bool,
    /// The file is a temp copy that was never saved (pages dragged out to a
    /// new window): Save asks where to write it.
    pub unsaved: bool,
}

/**
 * Puts the window in the middle of the screen it opens on, shrunk (keeping
 * its shape) when it would not fit in the screen's work area: a small or
 * scaled screen must not hide its bottom behind the taskbar.
 */
fn fit_to_screen(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = window.current_monitor()? else { return Ok(()) };
    let area = monitor.work_area();
    let outer = window.outer_size()?;
    let inner = window.inner_size()?;
    let k = fit_scale((outer.width, outer.height), (area.size.width, area.size.height));
    let (w, h) = if k < 1.0 {
        let size = tauri::PhysicalSize::new((inner.width as f64 * k).round() as u32, (inner.height as f64 * k).round() as u32);
        window.set_size(size)?;
        ((outer.width as f64 * k).round() as i64, (outer.height as f64 * k).round() as i64)
    } else {
        (outer.width as i64, outer.height as i64)
    };
    let x = area.position.x as i64 + (area.size.width as i64 - w) / 2;
    let y = area.position.y as i64 + (area.size.height as i64 - h) / 2;
    window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32))
}

/// How much a `size` window must shrink to fit in 95 % of `area` (1: it fits).
fn fit_scale(size: (u32, u32), area: (u32, u32)) -> f64 {
    let room = |a: u32, s: u32| if s == 0 { 1.0 } else { a as f64 * 0.95 / s as f64 };
    room(area.0, size.0).min(room(area.1, size.1)).min(1.0)
}

pub struct AppState {
    pub startup_args: Mutex<StartupArgs>,
    /// What each extra window opens, by window label.
    pub window_args: Mutex<HashMap<String, StartupArgs>>,
}

/// Lets the webview read `path` through the asset protocol (pdf.js loads the
/// document that way). The static scope in tauri.conf.json only covers the
/// app's own temp files; documents are allowed one by one when the user picks
/// them (open dialog, drag and drop, command line), so a compromised page
/// cannot read arbitrary files from disk.
pub(crate) fn allow_viewing<R: tauri::Runtime, M: Manager<R>>(app: &M, path: &str) {
    let _ = app.asset_protocol_scope().allow_file(path);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut args = std::env::args().skip(1); // skip the executable name
    let mut startup = StartupArgs::default();

    while let Some(arg) = args.next() {
        if arg == "--print" {
            startup.should_print = true;
            if let Some(path) = args.next() {
                startup.file_path = Some(path);
            }
        } else if !arg.starts_with("--") {
            startup.file_path = Some(arg);
        }
    }

    let startup_file = startup.file_path.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            if let Some(path) = &startup_file {
                allow_viewing(app, path);
            }
            if let Some(main) = app.get_webview_window("main") {
                // Best effort: a window that cannot be measured stays as it is.
                let _ = fit_to_screen(&main);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                for p in paths {
                    allow_viewing(window, &p.to_string_lossy());
                }
            }
        })
        .manage(AppState {
            startup_args: Mutex::new(startup),
            window_args: Mutex::new(HashMap::new()),
        })
        .manage(commands::compress::CompressCancel::default())
        .invoke_handler(tauri::generate_handler![
            commands::compress::compress_pdf,
            commands::compress::cancel_compression,
            commands::compress::estimate_compression,
            commands::security::encrypt_pdf,
            commands::security::decrypt_pdf,
            commands::dialog::open_pdf_dialog,
            commands::dialog::save_pdf_dialog,
            commands::dialog::pick_directory_dialog,
            commands::dialog::open_image_dialog,
            commands::dialog::open_images_dialog,
            commands::files::rename_file,
            commands::files::load_picture,
            commands::files::existing_files,
            commands::files::write_image_file,
            commands::convert::convert_text,
            commands::convert::save_as_dialog,
            commands::ocr::ocr_languages,
            commands::ocr::ocr_image,
            commands::pdf::get_page_count,
            commands::pdf::save_annotated_pdf,
            commands::pdf::strip_annotation_streams,
            commands::pdf::read_annotations,
            commands::pdf::rearrange_pages,
            commands::pdf::extract_pdf_pages,
            commands::pdf::export_flattened_pages,
            commands::pdf::straighten_pages,
            commands::pdf::split_pdf,
            commands::pdf::redact_pages,
            commands::pdf::adjust_pages,
            commands::pdf::images_to_pdf,
            commands::shell::list_printers,
            commands::shell::print_pages,
            commands::shell::get_startup_args,
            commands::shell::check_pdf_association,
            commands::shell::register_pdf_handler,
            commands::shell::unregister_pdf_handler,
            commands::shell::register_print_verb,
            commands::shell::open_default_apps_settings,
            commands::shell::open_url,
            commands::window::open_pages_in_new_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}

#[cfg(test)]
mod icon_tests {
    /// Tauri makes the window (and so the taskbar) icon from the first image
    /// of icon.ico: it must be the biggest one, or Windows blows up a 16 px
    /// picture and the icon looks blurry.
    #[test]
    fn the_window_icon_is_the_biggest_image_of_icon_ico() {
        let d = include_bytes!("../icons/icon.ico");
        let count = u16::from_le_bytes([d[4], d[5]]) as usize;
        let side = |i: usize| match d[6 + 16 * i] { 0 => 256, w => u32::from(w) };
        assert!(count > 1);
        assert_eq!(side(0), (0..count).map(side).max().unwrap());
    }
}

#[cfg(test)]
mod fit_tests {
    use super::fit_scale;

    #[test]
    fn a_window_that_fits_keeps_its_size() {
        assert_eq!(fit_scale((1100, 840), (1920, 1040)), 1.0);
    }

    #[test]
    fn a_window_too_tall_shrinks_keeping_its_shape() {
        let k = fit_scale((1100, 840), (1366, 728));
        assert!((k - 728.0 * 0.95 / 840.0).abs() < 1e-9);
        assert!(k < 1.0);
    }
}
