//! Entry points of the fuzz targets in `fuzz/` (feature `fuzzing`, never
//! in the app). Each one takes the bytes of a file as it could arrive from
//! disk and runs the code that opens it: errors are fine, a panic, a hang
//! or a runaway allocation is a bug.

use lopdf::{Document, IncrementalDocument};

use crate::commands::compress::{compress_to_bytes, Job};

/// Opening a PDF: what the viewer, Save and Compress do with it.
pub fn pdf(data: &[u8]) {
    if let Ok(doc) = Document::load_mem(data) {
        let _ = doc.get_pages();
        let _ = crate::pdf::writer::load_meta(&doc);
        let _ = compress_to_bytes(&doc, None, &Job::silent(), (0.0, 1.0));
    }
    let _ = IncrementalDocument::load_mem(data);
}

/// Placing a picture from disk on a page.
pub fn picture(data: &[u8]) {
    let _ = crate::commands::files::picture_from_bytes(data);
}

/// Reading a picture for text recognition.
pub fn ocr_image(data: &[u8]) {
    let _ = crate::ocr::prepare_rgba(data, 4096);
}
