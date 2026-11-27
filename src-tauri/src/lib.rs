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
    let chrome = (outer.width.saturating_sub(inner.width), outer.height.saturating_sub(inner.height));
    let k = monitor.scale_factor();
    let frame = ((SIDE_WIDTH * k).round() as u32, (BARS_HEIGHT * k).round() as u32);
    let (w, h) = a4_window((area.size.width, area.size.height), frame, (MIN_WIDTH * k).round() as u32);
    window.set_size(tauri::PhysicalSize::new(w.saturating_sub(chrome.0), h.saturating_sub(chrome.1)))?;
    let x = area.position.x as i64 + (area.size.width as i64 - w as i64) / 2;
    let y = area.position.y as i64 + (area.size.height as i64 - h as i64) / 2;
    window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32))
}

const MIN_WIDTH: f64 = 720.0;
const SIDE_WIDTH: f64 = 232.0;
const BARS_HEIGHT: f64 = 118.0;

fn a4_window(area: (u32, u32), frame: (u32, u32), min_width: u32) -> (u32, u32) {
    let height = (area.1 as f64 * 0.9).round();
    let centre = (height - frame.1 as f64).max(0.0) / std::f64::consts::SQRT_2;
    let width = (centre + frame.0 as f64).round().max(min_width as f64).min(area.0 as f64 * 0.95);
    (width as u32, height as u32)
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
const WEBVIEW2_DEFAULT_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

pub(crate) fn with_webdriver_args<'a, R: tauri::Runtime, M: Manager<R>>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
) -> tauri::WebviewWindowBuilder<'a, R, M> {
    if !cfg!(all(windows, debug_assertions)) {
        return builder;
    }
    let mut builder = builder;
    if let Ok(extra) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        builder = builder.additional_browser_args(&format!("{WEBVIEW2_DEFAULT_ARGS} {extra}"));
    }
    if let Some(dir) = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") {
        builder = builder.data_directory(dir.into());
    }
    builder
}

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
            let handle = app.handle().clone();
            std::thread::spawn(move || commands::quick_look::resume_quick_look(handle));
            if let Some(path) = &startup_file {
                allow_viewing(app, path);
            }
            if let Some(config) = app.config().app.windows.first() {
                let main =
                    with_webdriver_args(tauri::WebviewWindowBuilder::from_config(app.handle(), config)?).build()?;
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
            startup_taken: std::sync::atomic::AtomicBool::new(false),
            window_args: Mutex::new(HashMap::new()),
        })
        .manage(commands::compress::CompressCancel::default())
        .manage(commands::update::PendingUpdate::default())
        .invoke_handler(tauri::generate_handler![
            commands::pdf::list_system_fonts,
            commands::pdf::list_pdf_fonts,
            commands::compress::compress_pdf,
            commands::compress::cancel_compression,
            commands::compress::estimate_compression,
            commands::security::encrypt_pdf,
            commands::security::decrypt_pdf,
            commands::dialog::open_pages_dialog,
            commands::dialog::open_document_dialog,
            commands::dialog::open_documents_dialog,
            commands::dialog::save_pdf_dialog,
            commands::dialog::pick_directory_dialog,
            commands::dialog::open_image_dialog,
            commands::dialog::open_stamp_dialog,
            commands::dialog::open_images_dialog,
            commands::files::rename_file,
            commands::files::load_picture,
            commands::files::load_svg,
            commands::files::inflate_raw,
            commands::book_pdf::can_print_html_to_pdf,
            commands::book_pdf::print_html_pages,
            commands::book_pdf::finish_book_pdf,
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
            commands::pdf::open_for_display,
            commands::pdf::rearrange_pages,
            commands::pdf::extract_pdf_pages,
            commands::pdf::export_flattened_pages,
            commands::pdf::straighten_pages,
            commands::pdf::split_pdf,
            commands::pdf::redact_pages,
            commands::pdf::watermark_pages,
            commands::pdf::adjust_pages,
            commands::print::list_printers,
            commands::print::print_pages,
            commands::shell::get_startup_args,
            commands::default_reader::check_pdf_association,
            commands::default_reader::is_default_pdf_reader,
            commands::default_reader::register_pdf_handler,
            commands::default_reader::unregister_pdf_handler,
            commands::default_reader::register_print_verb,
            commands::default_reader::open_default_apps_settings,
            commands::shell::open_url,
            commands::quick_look::quick_look_state,
            commands::quick_look::set_quick_look,
            commands::update::check_for_update,
            commands::update::install_update,
            commands::update::prepare_update,
            commands::window::open_pages_in_new_window,
            commands::window::extract_pages_to_temp,
            commands::window::open_file_in_new_window,
            commands::window::pictures_to_new_pdf,
            commands::window::tab_drag_hover,
            commands::window::tab_drag_end,
            commands::window::move_tab,
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
                commands::update::apply_on_exit(_app);
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
    use super::a4_window;

    #[test]
    fn the_central_area_opens_in_a4_portrait() {
        let (w, h) = a4_window((2560, 1400), (232, 118), 720);
        assert_eq!(h, 1260);
        assert_eq!(w, 1040);
        let ratio = (h - 118) as f64 / (w - 232) as f64;
        assert!((ratio - std::f64::consts::SQRT_2).abs() < 0.01);
    }

    #[test]
    fn a_short_screen_keeps_the_minimum_width() {
        assert_eq!(a4_window((1366, 600), (232, 118), 720), (720, 540));
    }

    #[test]
    fn a_narrow_screen_caps_the_width() {
        assert_eq!(a4_window((800, 1400), (232, 118), 720).0, 760);
    }
}
