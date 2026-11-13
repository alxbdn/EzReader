use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use lopdf::Document;
use serde::Serialize;
use tauri::Emitter;

use crate::fsutil;
use crate::pdf::compress::{self, ImageSettings, BALANCED, LADDER, MAXIMUM};

/// Returned to the frontend after a successful compression.
#[derive(Debug, Serialize)]
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

/// Error text when the user cancelled.
pub const CANCELLED: &str = "cancelled";

/// What a running compression reports to, and is stopped by.
pub struct Job<'a> {
    /// Set by the user's Cancel.
    pub cancel: &'a AtomicBool,
    /// Called with the share of the work done, from 0 to 1.
    pub progress: &'a dyn Fn(f64),
}

static NEVER_CANCELLED: AtomicBool = AtomicBool::new(false);

impl Job<'static> {
    /// A job nobody watches or cancels (estimates, tests).
    pub fn silent() -> Self {
        Job { cancel: &NEVER_CANCELLED, progress: &|_| {} }
    }
}

impl Job<'_> {
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

/// The document compressed in memory: streams recompressed and unused
/// objects dropped; with `images`, pictures re-encoded. Form fields and
/// annotations are kept as they are. Reports progress within `span`.
fn compress_to_bytes(doc: &Document, images: Option<ImageSettings>, job: &Job, span: (f64, f64)) -> Result<Vec<u8>, String> {
    if job.cancelled() {
        return Err(CANCELLED.into());
    }
    let mut doc = doc.clone();
    let page_count = doc.get_pages().len();
    let (from, to) = span;
    if let Some(settings) = images {
        // Pictures are the slow part: they take 90 % of the span.
        let mut on_image = |done: usize, total: usize| {
            (job.progress)(from + (to - from) * 0.9 * done as f64 / total.max(1) as f64);
            !job.cancelled()
        };
        compress::compress_images(&mut doc, settings, &mut on_image).map_err(|_| CANCELLED.to_string())?;
    }
    if job.cancelled() {
        return Err(CANCELLED.into());
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
    (job.progress)(to);
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
///
/// Nothing is written when `job` is cancelled: the error is [`CANCELLED`].
pub fn compress_file(
    input_path: &str,
    output_path: &str,
    level: &str,
    target_bytes: Option<u64>,
    job: &Job,
) -> Result<CompressResult, String> {
    let original_bytes = std::fs::metadata(input_path).map_err(|e| e.to_string())?.len();
    let doc = Document::load(input_path).map_err(|e| e.to_string())?;
    (job.progress)(0.0);

    let (bytes, reached_target) = match level {
        "lossless" => (compress_to_bytes(&doc, None, job, (0.0, 1.0))?, true),
        "balanced" => (compress_to_bytes(&doc, Some(BALANCED), job, (0.0, 1.0))?, true),
        "maximum" => (compress_to_bytes(&doc, Some(MAXIMUM), job, (0.0, 1.0))?, true),
        "target" => {
            let target = target_bytes.ok_or("No target size given")?;
            // Worst case: lossless, then every step of the ladder.
            let steps = (LADDER.len() + 1) as f64;
            let span = |i: usize| (i as f64 / steps, (i + 1) as f64 / steps);
            let mut smallest = compress_to_bytes(&doc, None, job, span(0))?;
            let mut found = smallest.len() as u64 <= target;
            if !found {
                for (i, settings) in LADDER.into_iter().enumerate() {
                    let bytes = compress_to_bytes(&doc, Some(settings), job, span(i + 1))?;
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
    if job.cancelled() {
        return Err(CANCELLED.into());
    }
    (job.progress)(1.0);

    fsutil::write_atomic(output_path, |tmp| std::fs::write(tmp, &bytes).map_err(|e| e.to_string()))?;
    Ok(CompressResult { original_bytes, compressed_bytes: bytes.len() as u64, reached_target })
}

/// Sizes of the three levels, computed in memory.
pub fn estimate_file(input_path: &str) -> Result<CompressEstimate, String> {
    let original_bytes = std::fs::metadata(input_path).map_err(|e| e.to_string())?.len();
    let doc = Document::load(input_path).map_err(|e| e.to_string())?;
    let job = Job::silent();
    let all = (0.0, 1.0);
    Ok(CompressEstimate {
        original_bytes,
        lossless_bytes: compress_to_bytes(&doc, None, &job, all)?.len() as u64,
        balanced_bytes: compress_to_bytes(&doc, Some(BALANCED), &job, all)?.len() as u64,
        maximum_bytes: compress_to_bytes(&doc, Some(MAXIMUM), &job, all)?.len() as u64,
    })
}

/// The Cancel flag of the compression in progress (one at a time per app).
#[derive(Default)]
pub struct CompressCancel(pub Arc<AtomicBool>);

/// Event carrying the share of the compression done (0 to 1).
pub const PROGRESS_EVENT: &str = "compress-progress";

/// See [`compress_file`]. Runs off the main thread: big files take a while.
/// Reports progress as [`PROGRESS_EVENT`] events; [`cancel_compression`]
/// stops it.
#[tauri::command]
pub async fn compress_pdf(
    app: tauri::AppHandle,
    cancel: tauri::State<'_, CompressCancel>,
    input_path: String,
    output_path: String,
    level: String,
    target_bytes: Option<u64>,
) -> Result<CompressResult, String> {
    let flag = cancel.0.clone();
    flag.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        // Whole percents only: no need to flood the frontend.
        let last = std::sync::Mutex::new(-1i64);
        let progress = |share: f64| {
            let pct = (share.clamp(0.0, 1.0) * 100.0).floor() as i64;
            let mut last = last.lock().unwrap_or_else(|e| e.into_inner());
            if pct != *last {
                *last = pct;
                let _ = app.emit(PROGRESS_EVENT, share);
            }
        };
        let job = Job { cancel: &flag, progress: &progress };
        compress_file(&input_path, &output_path, &level, target_bytes, &job)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stops the compression in progress; it ends with the [`CANCELLED`] error.
#[tauri::command]
pub fn cancel_compression(cancel: tauri::State<'_, CompressCancel>) {
    cancel.0.store(true, Ordering::Relaxed);
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
            compress_file(&fixture("objstm-indirect-length.pdf"), &out, level, None, &Job::silent()).unwrap();
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
        compress_file(&input, &out, "maximum", None, &Job::silent()).unwrap();
        let small = Document::load(&out).unwrap();
        let pic = small.objects.values().find_map(|o| match o {
            Object::Stream(s) if s.dict.get(b"Subtype").ok().and_then(|n| n.as_name().ok()) == Some(b"Image".as_slice()) => Some(s.clone()),
            _ => None,
        }).unwrap();
        // 96 dpi over an 11.7 in page: at most 1123 px.
        assert_eq!(pic.dict.get(b"Height").unwrap().as_i64().unwrap(), 1123);
        assert_eq!(pic.dict.get(b"Filter").unwrap().as_name().unwrap(), b"DCTDecode");

        let target = tmp("big-picture-target.pdf");
        let r = compress_file(&input, &target, "target", Some(est.balanced_bytes + 1), &Job::silent()).unwrap();
        assert!(r.reached_target && r.compressed_bytes <= est.balanced_bytes + 1);

        // Progress climbs to 1; a cancelled run writes nothing.
        let seen = std::sync::Mutex::new(Vec::new());
        let record = |p: f64| seen.lock().unwrap().push(p);
        let flag = AtomicBool::new(false);
        let watched = tmp("big-picture-watched.pdf");
        compress_file(&input, &watched, "balanced", None, &Job { cancel: &flag, progress: &record }).unwrap();
        let seen = seen.into_inner().unwrap();
        assert!(seen.windows(2).all(|w| w[0] <= w[1]), "progress goes up: {seen:?}");
        assert_eq!(seen.last(), Some(&1.0));

        flag.store(true, Ordering::Relaxed);
        let stopped = tmp("big-picture-cancelled.pdf");
        let err = compress_file(&input, &stopped, "target", Some(1), &Job { cancel: &flag, progress: &|_| {} }).unwrap_err();
        assert_eq!(err, CANCELLED);
        assert!(!std::path::Path::new(&stopped).exists());

        for p in [input, out, target, watched] {
            std::fs::remove_file(p).ok();
        }
    }

    /// FR-006 of the compress spec: form fields survive every level.
    #[test]
    fn form_fields_survive_every_level() {
        use lopdf::{dictionary, Object, Stream};
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let page_id = doc.new_object_id();
        let ap = doc.add_object(Stream::new(dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 100.into(), 20.into()] }, b"0 0 100 20 re S".to_vec()));
        let field = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Widget", "FT" => "Tx", "T" => Object::string_literal("name"),
            "Rect" => vec![50.into(), 700.into(), 150.into(), 720.into()], "P" => page_id,
            "AP" => dictionary! { "N" => ap },
        });
        let content = doc.add_object(Stream::new(dictionary! {}, b"BT /F1 12 Tf 50 750 Td (Name) Tj ET".to_vec()));
        doc.objects.insert(page_id, Object::Dictionary(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            "Contents" => content, "Annots" => vec![field.into()],
        }));
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1 }));
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id, "AcroForm" => dictionary! { "Fields" => vec![field.into()] } });
        doc.trailer.set("Root", catalog);
        let input = tmp("form.pdf");
        doc.save(&input).unwrap();

        for level in ["lossless", "balanced", "maximum"] {
            let out = tmp(&format!("form-{level}.pdf"));
            compress_file(&input, &out, level, None, &Job::silent()).unwrap();
            let doc = Document::load(&out).unwrap();
            let catalog = doc.catalog().unwrap();
            let fields = catalog.get(b"AcroForm").and_then(|a| doc.dereference(a)).unwrap().1.as_dict().unwrap().get(b"Fields").unwrap().as_array().unwrap();
            assert_eq!(fields.len(), 1, "{level}: the field is still listed");
            let page = doc.get_dictionary(doc.get_pages()[&1]).unwrap();
            assert_eq!(page.get(b"Annots").unwrap().as_array().unwrap().len(), 1, "{level}: the widget is still on the page");
            std::fs::remove_file(out).ok();
        }
        std::fs::remove_file(input).ok();
    }
}
