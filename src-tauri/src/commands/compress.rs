use lopdf::Document;
use serde::Serialize;

use crate::fsutil;
use crate::pdf::compress::{self, CompressionLevel};

/// Returned to the frontend after a successful compression.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressResult {
    pub original_bytes: u64,
    pub compressed_bytes: u64,
}

/// Loads `input_path`, re-encodes compressible images at the chosen quality
/// level, saves the result to `output_path`, and returns both file sizes.
///
/// The source file is never modified. Compression needs a full rewrite (the
/// whole point is to drop the original bytes), so this relies on lopdf ≥ 0.47:
/// 0.39 could not load PDFs that combine object streams with indirect
/// `/Length` entries and silently produced empty or garbled output.
#[tauri::command]
pub fn compress_pdf(
    input_path: String,
    output_path: String,
    level: String,
) -> Result<CompressResult, String> {
    let compression_level = CompressionLevel::from_str(&level)
        .ok_or_else(|| format!("Unknown compression level: {level}"))?;

    let original_bytes = std::fs::metadata(&input_path)
        .map_err(|e| e.to_string())?
        .len();

    let mut doc = Document::load(&input_path).map_err(|e| e.to_string())?;
    let page_count = doc.get_pages().len();

    compress::flatten_forms(&mut doc);
    compress::compress_images(&mut doc, compression_level);
    compress::compress_streams(&mut doc);
    compress::strip_metadata(&mut doc);
    compress::prune_dead_objects(&mut doc);

    // Refuse to write a result that lost pages rather than hand the user a
    // broken file.
    let pages_after = doc.get_pages().len();
    if page_count == 0 || pages_after != page_count {
        return Err(format!(
            "Compression aborted: page count changed ({page_count} → {pages_after})"
        ));
    }
    fsutil::save_document(&mut doc, &output_path)?;

    let compressed_bytes = std::fs::metadata(&output_path)
        .map_err(|e| e.to_string())?
        .len();

    Ok(CompressResult {
        original_bytes,
        compressed_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::test_util::{assert_lengths_consistent, fixture, tmp};

    /// Object streams + indirect /Length (what qpdf, iLovePDF and Acrobat
    /// produce). lopdf 0.39 loaded this file with zero pages.
    #[test]
    fn compress_keeps_pages_and_stream_lengths_on_object_stream_pdf() {
        let out = tmp("compressed.pdf");

        compress_pdf(fixture("objstm-indirect-length.pdf"), out.clone(), "ebook".into()).unwrap();
        assert_lengths_consistent(&out);

        let doc = Document::load(&out).unwrap();
        assert_eq!(doc.get_pages().len(), 2);
        // The page text must still be decodable.
        let text = doc.extract_text(&[1]).unwrap();
        assert!(text.contains("Page 1"), "got {text:?}");
        std::fs::remove_file(&out).ok();
    }
}
