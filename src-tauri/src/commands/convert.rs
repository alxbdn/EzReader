use crate::convert::{convert, Format, TextDoc};
use crate::error::{CmdResult, ErrorCode, PdfError};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};

/// Writes the text of a document (extracted by the frontend) to `output` in
/// `format`: "docx", "xlsx", "rtf", "html", "txt" or "xml".
#[tauri::command]
pub async fn convert_text(doc: TextDoc, format: String, output: String) -> CmdResult<()> {
    let format = Format::parse(&format)
        .ok_or_else(|| PdfError::new(ErrorCode::Other, format!("unknown format: {format}")))?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = convert(&doc, format);
        crate::fsutil::write_atomic(&output, |tmp| std::fs::write(tmp, &bytes).map_err(|e| e.to_string()))
            .map_err(PdfError::from)
    })
    .await
    .map_err(|e| PdfError::from(e.to_string()))?
}

/// A Save As dialog for a converted file: `suggested` is the file name,
/// `format` sets the type filter. Returns the chosen path or null.
#[tauri::command]
pub fn save_as_dialog(app: AppHandle, suggested: String, format: String) -> CmdResult<Option<String>> {
    let format = Format::parse(&format)
        .ok_or_else(|| PdfError::new(ErrorCode::Other, format!("unknown format: {format}")))?;
    let label = match format {
        Format::Docx => "Word document",
        Format::Xlsx => "Excel workbook",
        Format::Rtf => "Rich text",
        Format::Html => "Web page",
        Format::Txt => "Text",
        Format::Xml => "XML",
    };
    let result = app
        .dialog()
        .file()
        .add_filter(label, &[format.extension()])
        .set_file_name(&suggested)
        .blocking_save_file();
    Ok(result.map(|p| match p {
        FilePath::Path(pb) => pb.to_string_lossy().into_owned(),
        FilePath::Url(u) => u.to_string(),
    }))
}
