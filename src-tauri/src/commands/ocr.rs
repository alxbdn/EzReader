use crate::error::{CmdResult, ErrorCode, PdfError};
use crate::ocr::{OcrLanguage, OcrResult};

fn to_error(e: String) -> PdfError {
    if e == "no-ocr-language" {
        PdfError::new(ErrorCode::NoOcrLanguage, "no OCR language is installed in Windows for this")
    } else {
        PdfError::from(e)
    }
}

/// The languages Windows can recognize (its installed OCR packs).
#[tauri::command]
pub async fn ocr_languages() -> CmdResult<Vec<OcrLanguage>> {
    tauri::async_runtime::spawn_blocking(crate::ocr::languages)
        .await
        .map_err(|e| PdfError::from(e.to_string()))?
        .map_err(to_error)
}

/// Recognizes the text of a picture (`data`: base64 PNG / JPEG, or a data:
/// URL) in `language` (a BCP-47 tag; the user's languages when empty).
#[tauri::command]
pub async fn ocr_image(data: String, language: Option<String>) -> CmdResult<OcrResult> {
    use base64::Engine;
    let b64 = data.split_once(',').map_or(data.as_str(), |(_, d)| d);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| PdfError::new(ErrorCode::NotAnImage, e.to_string()))?;
    tauri::async_runtime::spawn_blocking(move || crate::ocr::recognize(&bytes, language.as_deref()))
        .await
        .map_err(|e| PdfError::from(e.to_string()))?
        .map_err(to_error)
}
