use lopdf::{Document, IncrementalDocument};

use crate::commands::compress::{compress_to_bytes, Job};

pub fn pdf(data: &[u8]) {
    if let Ok(doc) = Document::load_mem(data) {
        let _ = doc.get_pages();
        let _ = crate::pdf::writer::load_meta(&doc);
        let _ = compress_to_bytes(&doc, None, &Job::silent(), (0.0, 1.0));
    }
    let _ = IncrementalDocument::load_mem(data);
}

pub fn picture(data: &[u8]) {
    let _ = crate::commands::files::picture_from_bytes(data);
}

pub fn ocr_image(data: &[u8]) {
    let _ = crate::ocr::prepare_rgba(data, 4096);
}
