//! The annotation record EzReader keeps inside a PDF, and the drawn layer it points at.

use std::collections::HashMap;

use lopdf::{dictionary, Document, IncrementalDocument, Object, ObjectId, Stream};
use serde::{Deserialize, Serialize};

use super::models::Annotation;

/// EzReader's record of a document's annotations, kept in the PDF next to their drawn layer.
///
/// The annotations are stored as data, so they come back editable, and each page that shows
/// some also gets one content stream with them drawn in (its "layer"), so other readers see
/// them. The record says which stream is which page's layer.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct AnnotationMeta {
    pub annotations: Vec<Annotation>,
    /// Page number to the object number and generation of its layer, as stored in the file.
    stream_ids: HashMap<u32, [u32; 2]>,
}

impl AnnotationMeta {
    #[cfg(test)]
    pub fn new(annotations: Vec<Annotation>, layers: impl IntoIterator<Item = (u32, ObjectId)>) -> Self {
        let mut meta = Self { annotations, stream_ids: HashMap::new() };
        meta.set_layers(layers);
        meta
    }

    /// Nothing recorded: no annotations and no layer.
    pub fn is_empty(&self) -> bool {
        self.annotations.is_empty() && self.stream_ids.is_empty()
    }

    pub fn has_layers(&self) -> bool {
        !self.stream_ids.is_empty()
    }

    /// The layer drawn on `page`, if it has one.
    pub fn layer(&self, page: u32) -> Option<ObjectId> {
        self.stream_ids.get(&page).map(|&[num, gen]| (num, gen as u16))
    }

    /// Every page's layer, by page number.
    pub fn layers(&self) -> impl Iterator<Item = (u32, ObjectId)> + '_ {
        self.stream_ids.iter().map(|(&page, &[num, gen])| (page, (num, gen as u16)))
    }

    /// Replaces the layers with `layers`, by page number.
    pub fn set_layers(&mut self, layers: impl IntoIterator<Item = (u32, ObjectId)>) {
        self.stream_ids = layers.into_iter().map(|(page, (num, gen))| (page, [num, gen as u32])).collect();
    }

    /// Follows pages that moved: `renumber` maps an old page number to its new one. Annotations
    /// and layers of pages that are not in it (deleted pages) are dropped.
    pub fn renumber(&mut self, renumber: &HashMap<u32, u32>) {
        self.annotations.retain(|ann| renumber.contains_key(&ann.page()));
        for ann in &mut self.annotations {
            ann.set_page(renumber[&ann.page()]);
        }
        self.stream_ids = std::mem::take(&mut self.stream_ids)
            .into_iter()
            .filter_map(|(page, ids)| renumber.get(&page).map(|&p| (p, ids)))
            .collect();
    }
}

/// Empties layer streams in the update `inc` writes, so the pages no longer draw those
/// annotations while the record keeps them.
pub fn blank_layers(inc: &mut IncrementalDocument, layers: impl IntoIterator<Item = ObjectId>) -> Result<(), String> {
    for sid in layers {
        inc.opt_clone_object_to_new_document(sid).map_err(|e| e.to_string())?;
        if let Ok(Object::Stream(s)) = inc.new_document.get_object_mut(sid) {
            super::writer::set_raw_content(s, vec![]);
        }
    }
    Ok(())
}

pub(crate) fn catalog_id(doc: &Document) -> Result<ObjectId, String> {
    doc.trailer
        .get(b"Root")
        .map_err(|_| "No Root in trailer".to_string())?
        .as_reference()
        .map_err(|_| "Root is not a reference".to_string())
}

/// The catalog entry that points at EzReader's annotation record.
const META_KEY: &[u8] = b"CCAnnot";

/// Whether a file's bytes can hold an EzReader annotation record, found without parsing them.
///
/// EzReader writes the catalog as a plain object, never inside an object stream, and an
/// incremental update keeps every earlier revision byte for byte, so a file EzReader annotated
/// always contains the entry's name. A file without it needs no parse to know it has no record.
pub fn may_hold_meta(bytes: &[u8]) -> bool {
    memchr::memmem::find(bytes, b"/CCAnnot").is_some()
}

pub fn load_meta(doc: &Document) -> AnnotationMeta {
    let Ok(cat_id) = catalog_id(doc) else { return AnnotationMeta::default() };
    let Ok(cat) = doc.get_object(cat_id) else { return AnnotationMeta::default() };
    let Ok(dict) = cat.as_dict() else { return AnnotationMeta::default() };

    let Ok(Object::Reference(meta_ref)) = dict.get(META_KEY) else {
        return AnnotationMeta::default();
    };
    let Ok(obj) = doc.get_object(*meta_ref) else { return AnnotationMeta::default() };
    let Object::Stream(stream) = obj else { return AnnotationMeta::default() };
    let Ok(json) = String::from_utf8(stream.content.clone()) else {
        return AnnotationMeta::default();
    };
    serde_json::from_str(&json).unwrap_or_default()
}

pub fn save_meta(doc: &mut Document, meta: &AnnotationMeta) -> Result<(), String> {
    let json = serde_json::to_string(meta).map_err(|e| e.to_string())?;
    let stream = Stream::new(dictionary! {}, json.into_bytes());
    let stream_id = doc.add_object(Object::Stream(stream));

    let cat_id = catalog_id(doc)?;
    let catalog = doc.get_object_mut(cat_id).map_err(|e| e.to_string())?;
    if let Object::Dictionary(d) = catalog {
        d.set(META_KEY, Object::Reference(stream_id));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf::models::{RectAnnotation, RgbColor};

    fn rect(page: u32) -> Annotation {
        Annotation::Rect(RectAnnotation {
            page,
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
            color: RgbColor { r: 0, g: 0, b: 0 },
            stroke_width: 1.0,
            fill_color: None,
            opacity: None,
        })
    }

    #[test]
    fn layers_keep_the_stored_layout() {
        let meta = AnnotationMeta::new(vec![], [(2, (17, 0))]);
        assert_eq!(meta.layer(2), Some((17, 0)));
        assert_eq!(meta.layer(1), None);
        let json = serde_json::to_value(&meta).unwrap();
        assert_eq!(json["stream_ids"]["2"], serde_json::json!([17, 0]), "files written before stay readable");
    }

    #[test]
    fn renumbering_follows_moved_pages_and_drops_deleted_ones() {
        let mut meta = AnnotationMeta::new(vec![rect(1), rect(2), rect(3)], [(1, (10, 0)), (3, (30, 0))]);
        meta.renumber(&HashMap::from([(1, 2), (3, 1)]));
        let pages: Vec<u32> = meta.annotations.iter().map(Annotation::page).collect();
        assert_eq!(pages, vec![2, 1]);
        assert_eq!(meta.layer(2), Some((10, 0)));
        assert_eq!(meta.layer(1), Some((30, 0)));
        assert_eq!(meta.layers().count(), 2);
    }

    #[test]
    fn empty_means_no_annotation_and_no_layer() {
        assert!(AnnotationMeta::default().is_empty());
        assert!(!AnnotationMeta::new(vec![], [(1, (5, 0))]).is_empty());
        assert!(!AnnotationMeta::new(vec![rect(1)], []).is_empty());
    }
}
