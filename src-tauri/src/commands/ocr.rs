use crate::error::{CmdResult, ErrorCode, PdfError};
use crate::ocr::{OcrLanguage, OcrResult};

fn to_error(e: String) -> PdfError {
    if e == "no-ocr-language" {
        PdfError::new(ErrorCode::NoOcrLanguage, "no OCR language is installed for this")
    } else {
        PdfError::from(e)
    }
}

#[tauri::command]
pub async fn ocr_languages() -> CmdResult<Vec<OcrLanguage>> {
    tauri::async_runtime::spawn_blocking(crate::ocr::languages)
        .await
        .map_err(|e| PdfError::from(e.to_string()))?
        .map_err(to_error)
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_language_has_its_own_code() {
        assert_eq!(to_error("no-ocr-language".into()).code, ErrorCode::NoOcrLanguage);
        assert_ne!(to_error("other".into()).code, ErrorCode::NoOcrLanguage);
    }

    #[test]
    fn refuses_data_that_is_not_base64() {
        let err = tauri::async_runtime::block_on(ocr_image("data:image/png;base64,***".into(), None)).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAnImage);
    }

    #[test]
    fn lists_languages_or_explains_why_not() {
        let _ = tauri::async_runtime::block_on(ocr_languages());
    }
}
