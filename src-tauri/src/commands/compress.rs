use lopdf::Document;
use serde::Serialize;

use crate::fsutil;
use crate::pdf::compress::{self, ImageSettings, BALANCED, LADDER, MAXIMUM};

/// Returned to the frontend after a successful compression.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressResult {
    pub original_bytes: u64,
    pub compressed_bytes: u64,
    /// False when a target size could not be reached (the smallest result is written).
    pub reached_target: bool,
}

/// Size each level would give, for the Compress dialog.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressEstimate {
    pub original_bytes: u64,
    pub lossless_bytes: u64,
    pub balanced_bytes: u64,
    pub maximum_bytes: u64,
}

/// The document compressed in memory: streams recompressed and unused
/// objects dropped; with `images`, pictures re-encoded and forms flattened.
fn compress_to_bytes(doc: &Document, images: Option<ImageSettings>) -> Result<Vec<u8>, String> {
    let mut doc = doc.clone();
    let page_count = doc.get_pages().len();
    if let Some(settings) = images {
        compress::flatten_forms(&mut doc);
        compress::compress_images(&mut doc, settings);
    }
    compress::compress_streams(&mut doc);
    compress::strip_metadata(&mut doc);
    compress::prune_dead_objects(&mut doc);

    // Refuse to write a result that lost pages rather than hand the user a
    // broken file.
    let pages_after = doc.get_pages().len();
    if page_count == 0 || pages_after != page_count {
        return Err(format!("Compression aborted: page count changed ({page_count} → {pages_after})"));
    }
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

/// Compresses `input_path` into `output_path` (the source is never modified).
///
/// `level` is "lossless", "balanced", "maximum", or "target": then the best
/// quality whose result fits in `target_bytes` is kept.
///
/// Compression needs a full rewrite (the whole point is to drop the original
/// bytes), so this relies on lopdf ≥ 0.47: 0.39 could not load PDFs that
/// combine object streams with indirect `/Length` entries.
pub fn compress_file(
    input_path: &str,
    output_path: &str,
    level: &str,
    target_bytes: Option<u64>,
) -> Result<CompressResult, String> {
    let original_bytes = std::fs::metadata(input_path).map_err(|e| e.to_string())?.len();
    let doc = Document::load(input_path).map_err(|e| e.to_string())?;

    let (bytes, reached_target) = match level {
        "lossless" => (compress_to_bytes(&doc, None)?, true),
        "balanced" => (compress_to_bytes(&doc, Some(BALANCED))?, true),
        "maximum" => (compress_to_bytes(&doc, Some(MAXIMUM))?, true),
        "target" => {
            let target = target_bytes.ok_or("No target size given")?;
            let mut smallest = compress_to_bytes(&doc, None)?;
            let mut found = smallest.len() as u64 <= target;
            if !found {
                for settings in LADDER {
                    let bytes = compress_to_bytes(&doc, Some(settings))?;
                    let fits = bytes.len() as u64 <= target;
                    if fits || bytes.len() < smallest.len() {
                        smallest = bytes;
                    }
                    if fits {
                        found = true;
                        break;
                    }
                }
            }
            (smallest, found)
        }
        other => return Err(format!("Unknown compression level: {other}")),
    };

    fsutil::write_atomic(output_path, |tmp| std::fs::write(tmp, &bytes).map_err(|e| e.to_string()))?;
    Ok(CompressResult { original_bytes, compressed_bytes: bytes.len() as u64, reached_target })
}

/// Sizes of the three levels, computed in memory.
pub fn estimate_file(input_path: &str) -> Result<CompressEstimate, String> {
    let original_bytes = std::fs::metadata(input_path).map_err(|e| e.to_string())?.len();
    let doc = Document::load(input_path).map_err(|e| e.to_string())?;
    Ok(CompressEstimate {
        original_bytes,
        lossless_bytes: compress_to_bytes(&doc, None)?.len() as u64,
        balanced_bytes: compress_to_bytes(&doc, Some(BALANCED))?.len() as u64,
        maximum_bytes: compress_to_bytes(&doc, Some(MAXIMUM))?.len() as u64,
    })
}

/// See [`compress_file`]. Runs off the main thread: big files take a while.
#[tauri::command]
pub async fn compress_pdf(
    input_path: String,
    output_path: String,
    level: String,
    target_bytes: Option<u64>,
) -> Result<CompressResult, String> {
    tauri::async_runtime::spawn_blocking(move || compress_file(&input_path, &output_path, &level, target_bytes))
        .await
        .map_err(|e| e.to_string())?
}

/// See [`estimate_file`].
#[tauri::command]
pub async fn estimate_compression(input_path: String) -> Result<CompressEstimate, String> {
    tauri::async_runtime::spawn_blocking(move || estimate_file(&input_path))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::test_util::{assert_lengths_consistent, fixture, tmp};

    /// Object streams + indirect /Length (what qpdf, iLovePDF and Acrobat
    /// produce). lopdf 0.39 loaded this file with zero pages.
    #[test]
    fn compress_keeps_pages_and_stream_lengths_on_object_stream_pdf() {
        for level in ["lossless", "balanced", "maximum"] {
            let out = tmp(&format!("compressed-{level}.pdf"));
            compress_file(&fixture("objstm-indirect-length.pdf"), &out, level, None).unwrap();
            assert_lengths_consistent(&out);

            let doc = Document::load(&out).unwrap();
            assert_eq!(doc.get_pages().len(), 2);
            // The page text must still be decodable.
            let text = doc.extract_text(&[1]).unwrap();
            assert!(text.contains("Page 1"), "got {text:?}");
            std::fs::remove_file(&out).ok();
        }
    }

    /// A page with a big plain RGB picture: it is scaled down and turned
    /// into a JPEG, and a target size picks a level that fits.
    #[test]
    fn pictures_are_scaled_down_and_target_size_is_met() {
        use lopdf::{dictionary, Object, Stream};
        let mut doc = Document::with_version("1.7");
        let (w, h) = (1200u32, 1650u32);
        let mut px = Vec::with_capacity((w * h * 3) as usize);
        for y in 0..h {
            for x in 0..w {
                px.extend_from_slice(&[(x % 256) as u8, (y % 256) as u8, ((x * y) % 251) as u8]);
            }
        }
        let mut img = Stream::new(dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => w as i64, "Height" => h as i64,
            "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
        }, px);
        img.compress().unwrap();
        let img_id = doc.add_object(img);
        let content = doc.add_object(Stream::new(dictionary! {}, b"q 595 0 0 842 0 0 cm /Im0 Do Q".to_vec()));
        let pages_id = doc.new_object_id();
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            "Contents" => content, "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => img_id } },
        });
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }));
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);
        let input = tmp("big-picture.pdf");
        doc.save(&input).unwrap();

        let est = estimate_file(&input).unwrap();
        assert!(est.maximum_bytes < est.balanced_bytes && est.balanced_bytes < est.lossless_bytes, "{} {} {}", est.lossless_bytes, est.balanced_bytes, est.maximum_bytes);

        let out = tmp("big-picture-max.pdf");
        compress_file(&input, &out, "maximum", None).unwrap();
        let small = Document::load(&out).unwrap();
        let pic = small.objects.values().find_map(|o| match o {
            Object::Stream(s) if s.dict.get(b"Subtype").ok().and_then(|n| n.as_name().ok()) == Some(b"Image".as_slice()) => Some(s.clone()),
            _ => None,
        }).unwrap();
        // 96 dpi over an 11.7 in page: at most 1123 px.
        assert_eq!(pic.dict.get(b"Height").unwrap().as_i64().unwrap(), 1123);
        assert_eq!(pic.dict.get(b"Filter").unwrap().as_name().unwrap(), b"DCTDecode");

        let target = tmp("big-picture-target.pdf");
        let r = compress_file(&input, &target, "target", Some(est.balanced_bytes + 1)).unwrap();
        assert!(r.reached_target && r.compressed_bytes <= est.balanced_bytes + 1);

        for p in [input, out, target] {
            std::fs::remove_file(p).ok();
        }
    }
}
