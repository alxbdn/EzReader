mod commands;
mod fsutil;
mod pdf;
#[cfg(test)]
mod test_util;

use std::sync::Mutex;

use tauri::{DragDropEvent, Manager, WindowEvent};

#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupArgs {
    pub file_path: Option<String>,
    pub should_print: bool,
}

pub struct AppState {
    pub startup_args: Mutex<StartupArgs>,
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
        })
        .invoke_handler(tauri::generate_handler![
            commands::compress::compress_pdf,
            commands::dialog::open_pdf_dialog,
            commands::dialog::save_pdf_dialog,
            commands::dialog::pick_directory_dialog,
            commands::pdf::get_page_count,
            commands::pdf::save_annotated_pdf,
            commands::pdf::strip_annotation_streams,
            commands::pdf::read_annotations,
            commands::pdf::modify_pages,
            commands::pdf::extract_pdf_pages,
            commands::pdf::split_pdf,
            commands::shell::list_printers,
            commands::shell::print_pages,
            commands::shell::get_startup_args,
            commands::shell::check_pdf_association,
            commands::shell::register_pdf_handler,
            commands::shell::unregister_pdf_handler,
            commands::shell::register_print_verb,
            commands::shell::open_default_apps_settings,
            commands::shell::open_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
