mod commands;
mod convert;
#[cfg(test)]
mod corpus_tests;
mod error;
mod fsutil;
#[cfg(feature = "fuzzing")]
pub mod fuzzing;
mod grants;
#[cfg(test)]
mod hostile_input_tests;
#[cfg(target_os = "macos")]
mod macos;
mod ocr;
mod pdf;
#[cfg(not(any(windows, target_os = "macos")))]
mod rapid_ocr;
mod ratio_lock;
mod resize_border;
mod tempfiles;
#[cfg(test)]
mod test_util;

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{DragDropEvent, Manager, WindowEvent};

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupArgs {
    pub file_path: Option<String>,
    pub should_print: bool,
    pub unsaved: bool,
    #[serde(default)]
    pub save_path: Option<String>,
    #[serde(default)]
    pub dirty: bool,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub page: u32,
}

fn fit_to_screen(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = window.current_monitor()? else { return Ok(()) };
    let area = monitor.work_area();
    let outer = window.outer_size()?;
    let inner = window.inner_size()?;
    let k = fit_scale((outer.width, outer.height), (area.size.width, area.size.height));
    let (w, h) = if k < 1.0 {
        let size =
            tauri::PhysicalSize::new((inner.width as f64 * k).round() as u32, (inner.height as f64 * k).round() as u32);
        window.set_size(size)?;
        ((outer.width as f64 * k).round() as i64, (outer.height as f64 * k).round() as i64)
    } else {
        (outer.width as i64, outer.height as i64)
    };
    let x = area.position.x as i64 + (area.size.width as i64 - w) / 2;
    let y = area.position.y as i64 + (area.size.height as i64 - h) / 2;
    window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32))
}

fn fit_scale(size: (u32, u32), area: (u32, u32)) -> f64 {
    let room = |a: u32, s: u32| if s == 0 { 1.0 } else { a as f64 * 0.95 / s as f64 };
    room(area.0, size.0).min(room(area.1, size.1)).min(1.0)
}

pub struct AppState {
    pub startup_args: Mutex<StartupArgs>,
    pub startup_taken: std::sync::atomic::AtomicBool,
    pub window_args: Mutex<HashMap<String, StartupArgs>>,
}

pub(crate) fn allow_viewing<R: tauri::Runtime, M: Manager<R>>(app: &M, path: &str) {
    grants::allow_file(path);
    let _ = app.asset_protocol_scope().allow_file(path);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut args = std::env::args().skip(1);
    let mut startup = StartupArgs::default();

    while let Some(arg) = args.next() {
        if arg == "--print" {
            startup.should_print = true;
            if let Some(path) = args.next() {
                startup.file_path = Some(grants::absolute(&path).to_string_lossy().into_owned());
            }
        } else if !arg.starts_with("--") {
            startup.file_path = Some(grants::absolute(&arg).to_string_lossy().into_owned());
        }
    }

    let startup_file = startup.file_path.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            std::thread::spawn(tempfiles::sweep_leftovers);
            std::thread::spawn(commands::update::remove_leftover);
            if let Some(path) = &startup_file {
                allow_viewing(app, path);
            }
            if let Some(main) = app.get_webview_window("main") {
                let _ = fit_to_screen(&main);
                ratio_lock::set_ratio_lock(&main, startup_file.is_none());
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
            startup_taken: std::sync::atomic::AtomicBool::new(false),
            window_args: Mutex::new(HashMap::new()),
        })
        .manage(commands::compress::CompressCancel::default())
        .invoke_handler(tauri::generate_handler![
            commands::pdf::list_system_fonts,
            commands::compress::compress_pdf,
            commands::compress::cancel_compression,
            commands::compress::estimate_compression,
            commands::security::encrypt_pdf,
            commands::security::decrypt_pdf,
            commands::dialog::open_pdf_dialog,
            commands::dialog::open_document_dialog,
            commands::dialog::save_pdf_dialog,
            commands::dialog::pick_directory_dialog,
            commands::dialog::open_image_dialog,
            commands::dialog::open_images_dialog,
            commands::files::rename_file,
            commands::files::load_picture,
            commands::files::existing_files,
            commands::files::write_image_file,
            commands::files::temp_tag,
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
            commands::shell::is_default_pdf_reader,
            commands::shell::register_pdf_handler,
            commands::shell::unregister_pdf_handler,
            commands::shell::register_print_verb,
            commands::shell::open_default_apps_settings,
            commands::shell::open_url,
            commands::shell::quick_look_state,
            commands::shell::set_quick_look,
            commands::update::check_for_update,
            commands::update::install_update,
            commands::window::open_pages_in_new_window,
            commands::window::extract_pages_to_temp,
            commands::window::open_file_in_new_window,
            commands::window::pictures_to_new_pdf,
            commands::window::tab_drag_hover,
            commands::window::tab_drag_end,
            commands::window::move_tab,
            ratio_lock::set_launcher_ratio_lock,
            resize_border::set_resize_border,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                open_from_finder(_app, urls);
            }
            if let tauri::RunEvent::Exit = event {
                tempfiles::remove_own();
            }
        })
}

#[cfg(target_os = "macos")]
pub(crate) const TRAFFIC_LIGHTS: (f64, f64) = (14.0, 18.0);

#[cfg(target_os = "macos")]
fn open_from_finder(app: &tauri::AppHandle, urls: &[url::Url]) {
    use tauri::Emitter;

    let paths: Vec<String> =
        urls.iter().filter_map(|u| u.to_file_path().ok()).map(|p| p.to_string_lossy().into_owned()).collect();
    let Some((first, rest)) = paths.split_first() else { return };
    for p in &paths {
        allow_viewing(app, p);
    }
    let state = app.state::<AppState>();
    let mut to_page = paths.clone();
    {
        let mut startup = state.startup_args.lock().unwrap();
        if !state.startup_taken.load(std::sync::atomic::Ordering::SeqCst) && startup.file_path.is_none() {
            startup.file_path = Some(first.clone());
            to_page = rest.to_vec();
            if let Some(main) = app.get_webview_window("main") {
                ratio_lock::set_ratio_lock(&main, false);
            }
        }
    }
    if to_page.is_empty() {
        return;
    }
    if app.get_webview_window("main").is_some() && state.startup_taken.load(std::sync::atomic::Ordering::SeqCst) {
        let _ = app.emit_to("main", "open-files", to_page);
    } else {
        for p in to_page {
            let args = StartupArgs { file_path: Some(p), ..Default::default() };
            let _ = commands::window::open_window(app, args, None);
        }
    }
}

#[cfg(test)]
mod icon_tests {
    #[test]
    fn the_window_icon_is_the_biggest_image_of_icon_ico() {
        let d = include_bytes!("../icons/icon.ico");
        let count = u16::from_le_bytes([d[4], d[5]]) as usize;
        let side = |i: usize| match d[6 + 16 * i] {
            0 => 256,
            w => u32::from(w),
        };
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
