use crate::error::CmdResult;
use std::path::Path;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};

fn filepath_to_string(p: FilePath) -> String {
    match p {
        FilePath::Path(pb) => pb.to_string_lossy().into_owned(),
        FilePath::Url(u) => u.to_string(),
    }
}

#[tauri::command(async)]
pub fn open_pages_dialog(app: AppHandle) -> CmdResult<Vec<String>> {
    let mut all = vec!["pdf"];
    all.extend(IMAGE_EXTENSIONS);
    let result = app
        .dialog()
        .file()
        .add_filter("PDF and pictures", &all)
        .add_filter("PDF Files", &["pdf"])
        .add_filter("Images", &IMAGE_EXTENSIONS)
        .blocking_pick_files();
    let picked: Vec<String> = result.unwrap_or_default().into_iter().map(filepath_to_string).collect();
    for path in &picked {
        if path.to_ascii_lowercase().ends_with(".pdf") {
            crate::allow_viewing(&app, path);
        } else {
            crate::grants::allow_file(path);
        }
    }
    Ok(picked)
}

#[tauri::command(async)]
pub fn open_document_dialog(app: AppHandle) -> CmdResult<Option<String>> {
    let mut all = vec!["pdf"];
    all.extend(IMAGE_EXTENSIONS);
    let result = app
        .dialog()
        .file()
        .add_filter("PDF and pictures", &all)
        .add_filter("PDF Files", &["pdf"])
        .add_filter("Images", &IMAGE_EXTENSIONS)
        .blocking_pick_file();

    let picked = result.map(filepath_to_string);
    if let Some(path) = &picked {
        crate::allow_viewing(&app, path);
    }
    Ok(picked)
}

pub const IMAGE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

#[tauri::command(async)]
pub fn open_image_dialog(app: AppHandle) -> CmdResult<Option<String>> {
    let result = app.dialog().file().add_filter("Images", &IMAGE_EXTENSIONS).blocking_pick_file();
    let picked = result.map(filepath_to_string);
    if let Some(path) = &picked {
        crate::grants::allow_file(path);
    }
    Ok(picked)
}

#[tauri::command(async)]
pub fn open_images_dialog(app: AppHandle) -> CmdResult<Vec<String>> {
    let result = app.dialog().file().add_filter("Images", &IMAGE_EXTENSIONS).blocking_pick_files();
    let picked: Vec<String> = result.unwrap_or_default().into_iter().map(filepath_to_string).collect();
    for path in &picked {
        crate::grants::allow_file(path);
    }
    Ok(picked)
}

#[tauri::command(async)]
pub fn save_pdf_dialog(app: AppHandle, current_path: String) -> CmdResult<Option<String>> {
    let default_name =
        Path::new(&current_path).file_name().and_then(|n| n.to_str()).unwrap_or("output.pdf").to_string();

    let result =
        app.dialog().file().add_filter("PDF Files", &["pdf"]).set_file_name(&default_name).blocking_save_file();

    let picked = result.map(filepath_to_string);
    if let Some(path) = &picked {
        crate::grants::allow_file(path);
    }
    Ok(picked)
}

#[tauri::command(async)]
pub fn pick_directory_dialog(app: AppHandle) -> CmdResult<Option<String>> {
    let result = app.dialog().file().blocking_pick_folder();
    let picked = result.map(filepath_to_string);
    if let Some(path) = &picked {
        crate::grants::allow_dir(path);
    }
    Ok(picked)
}
