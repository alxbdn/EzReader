use crate::convert::{convert, Format, TextDoc};
use crate::error::{CmdResult, ErrorCode, PdfError};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};

#[tauri::command]
pub async fn convert_text(doc: TextDoc, format: String, output: String) -> CmdResult<()> {
    let format =
        Format::parse(&format).ok_or_else(|| PdfError::new(ErrorCode::Other, format!("unknown format: {format}")))?;
    crate::grants::check(&output)?;
    let ext = std::path::Path::new(&output).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    if ext.as_deref() != Some(format.extension()) {
        return Err(PdfError::new(
            ErrorCode::InvalidName,
            format!("a {} file must end in .{}", format.extension(), format.extension()),
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = convert(&doc, format);
        crate::fsutil::write_atomic(&output, |tmp| std::fs::write(tmp, &bytes).map_err(|e| e.to_string()))
            .map_err(PdfError::from)
    })
    .await
    .map_err(|e| PdfError::from(e.to_string()))?
}

#[tauri::command(async)]
pub fn save_as_dialog(app: AppHandle, suggested: String, format: String) -> CmdResult<Option<String>> {
    let format =
        Format::parse(&format).ok_or_else(|| PdfError::new(ErrorCode::Other, format!("unknown format: {format}")))?;
    let label = match format {
        Format::Docx => "Word document",
        Format::Xlsx => "Excel workbook",
        Format::Rtf => "Rich text",
        Format::Html => "Web page",
        Format::Txt => "Text",
        Format::Xml => "XML",
    };
    let result =
        app.dialog().file().add_filter(label, &[format.extension()]).set_file_name(&suggested).blocking_save_file();
    let picked = result.map(|p| match p {
        FilePath::Path(pb) => pb.to_string_lossy().into_owned(),
        FilePath::Url(u) => u.to_string(),
    });
    if let Some(path) = &picked {
        crate::grants::allow_file(path);
    }
    Ok(picked)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(name: &str) -> String {
        std::env::temp_dir()
            .join(format!("ezreader-convert-{}-{name}", std::process::id()))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn writes_each_format_to_a_matching_file() {
        for (format, name) in [("txt", "a.txt"), ("html", "a.html"), ("docx", "a.docx"), ("xlsx", "a.xlsx")] {
            let path = out(name);
            tauri::async_runtime::block_on(convert_text(crate::convert::tests::sample(), format.into(), path.clone()))
                .unwrap();
            assert!(std::fs::metadata(&path).unwrap().len() > 0, "{format}");
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn refuses_an_unknown_format_or_a_wrong_extension() {
        let bad =
            tauri::async_runtime::block_on(convert_text(crate::convert::tests::sample(), "pdf".into(), out("a.pdf")));
        assert_eq!(bad.unwrap_err().code, ErrorCode::Other);
        let path = out("a.doc");
        let wrong =
            tauri::async_runtime::block_on(convert_text(crate::convert::tests::sample(), "docx".into(), path.clone()));
        assert_eq!(wrong.unwrap_err().code, ErrorCode::InvalidName);
        assert!(!std::path::Path::new(&path).exists());
    }
}
