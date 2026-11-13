use std::collections::{HashMap, HashSet};

use lopdf::{Document, IncrementalDocument, Object, ObjectId};
use serde::{Deserialize, Serialize};

use crate::fsutil;
use crate::pdf::{models::Annotation, redact, writer, writer::FormFieldValue};

/// Returns the total number of pages in the given PDF file.
#[tauri::command]
pub fn get_page_count(file_path: String) -> Result<u32, String> {
    let doc = Document::load(&file_path).map_err(|e| e.to_string())?;
    Ok(doc.get_pages().len() as u32)
}

/// Burns `annotations` into the PDF content streams (visible in all viewers)
/// and also stores them as editable JSON metadata so they can be re-loaded.
///
/// On re-save, existing annotation streams are updated in-place rather than
/// appended, so repeated saves never accumulate stale burn layers.
#[tauri::command]
pub fn save_annotated_pdf(
    input_path: String,
    output_path: String,
    annotations: Vec<Annotation>,
    rotation_delta: i64,
    form_fields: Vec<FormFieldValue>,
) -> Result<(), String> {
    // Fast-path: nothing to apply → byte-perfect copy. Avoids any PDF rewrite.
    if annotations.is_empty() && rotation_delta == 0 && form_fields.is_empty() {
        let prev_meta_empty = Document::load(&input_path)
            .map(|d| {
                let m = writer::load_meta(&d);
                m.annotations.is_empty() && m.stream_ids.is_empty()
            })
            .unwrap_or(true);
        if prev_meta_empty {
            fsutil::copy_atomic(&input_path, &output_path)?;
            return Ok(());
        }
    }

    // We MUST go through `IncrementalDocument` rather than `Document::load +
    // Document::save`. The full-rewrite save in lopdf 0.39 drops streams and
    // loses indirect /Length objects on PDFs that use object streams (iLovePDF
    // / Acrobat output), producing files whose content streams render as
    // garbage. The incremental path preserves the input bytes verbatim and
    // only appends our modifications.
    let mut inc = IncrementalDocument::load(&input_path).map_err(|e| e.to_string())?;

    // Apply rotation to every page's Rotate entry before burning annotations.
    if rotation_delta != 0 {
        let page_ids: Vec<ObjectId> = inc
            .get_prev_documents()
            .get_pages()
            .values()
            .copied()
            .collect();
        for page_id in page_ids {
            inc.opt_clone_object_to_new_document(page_id)
                .map_err(|e| e.to_string())?;
            if let Ok(Object::Dictionary(dict)) = inc.new_document.get_object_mut(page_id) {
                let current = dict
                    .get(b"Rotate")
                    .ok()
                    .and_then(|o| o.as_i64().ok())
                    .unwrap_or(0);
                let new_rotate = (current + rotation_delta).rem_euclid(360);
                dict.set(b"Rotate", Object::Integer(new_rotate));
            }
        }
    }

    let mut meta = writer::load_meta(inc.get_prev_documents());

    // Group annotations by page
    let mut by_page: HashMap<u32, Vec<Annotation>> = HashMap::new();
    for ann in &annotations {
        by_page.entry(ann.page()).or_default().push(ann.clone());
    }

    let pages = inc.get_prev_documents().get_pages();
    let mut new_stream_ids: HashMap<u32, [u32; 2]> = HashMap::new();

    // Write (or update) annotation streams for each page that has annotations.
    // Page + existing stream must be cloned into new_document before the helper
    // mutates them, otherwise get_object_mut would miss them.
    for (&page_num, anns) in &by_page {
        let page_id = pages
            .get(&page_num)
            .copied()
            .ok_or_else(|| format!("page {page_num} not found in document"))?;

        let existing = meta.stream_ids.get(&page_num).map(|arr| (arr[0], arr[1] as u16));

        inc.opt_clone_object_to_new_document(page_id)
            .map_err(|e| e.to_string())?;
        inline_page_resources(&mut inc, page_id)?;
        if let Some(sid) = existing {
            inc.opt_clone_object_to_new_document(sid)
                .map_err(|e| e.to_string())?;
        }

        if let Some(sid) =
            writer::write_annotations_for_page(&mut inc.new_document, page_id, anns, existing)?
        {
            new_stream_ids.insert(page_num, [sid.0, sid.1 as u32]);
        }
    }

    // For pages that previously had annotations but now have none, empty their streams.
    for (&page_num, arr) in &meta.stream_ids {
        if !by_page.contains_key(&page_num) {
            let sid = (arr[0], arr[1] as u16);
            inc.opt_clone_object_to_new_document(sid)
                .map_err(|e| e.to_string())?;
            if let Ok(Object::Stream(s)) = inc.new_document.get_object_mut(sid) {
                writer::set_raw_content(s, vec![]);
            }
        }
    }

    meta.annotations = annotations;
    meta.stream_ids = new_stream_ids;

    // Catalog must live in new_document for save_meta (CCAnnot) and
    // write_form_fields (AcroForm) to mutate it.
    let cat_id = inc
        .get_prev_documents()
        .trailer
        .get(b"Root")
        .and_then(Object::as_reference)
        .map_err(|e| format!("No catalog: {e}"))?;
    inc.opt_clone_object_to_new_document(cat_id)
        .map_err(|e| e.to_string())?;
    writer::save_meta(&mut inc.new_document, &meta)?;

    if !form_fields.is_empty() {
        clone_acroform_tree(&mut inc, cat_id).map_err(|e| e.to_string())?;
        writer::write_form_fields(&mut inc.new_document, &form_fields)?;
    }

    fsutil::save_incremental(&mut inc, &output_path)?;
    Ok(())
}

/// `write_annotations_for_page`'s `add_font_to_page` / `add_xobject_to_page`
/// helpers assume `/Resources` (and its `/Font`, `/XObject` sub-dicts) live
/// inline on the page. Real-world PDFs frequently use indirect references
/// instead (e.g. `/Resources 100 0 R`), causing them to bail with
/// "Resources is not an inline dict".
///
/// We materialise the referenced dictionaries onto the page in `new_document`
/// (page already cloned by the caller) by cloning their contents from
/// `prev_documents`. The originals stay untouched, so any other page that
/// shared them keeps working.
fn inline_page_resources(
    inc: &mut IncrementalDocument,
    page_id: ObjectId,
) -> Result<(), String> {
    // Step 1: inline /Resources itself if it's a reference.
    let resources_ref: Option<ObjectId> = {
        let dict = inc
            .new_document
            .get_object(page_id)
            .and_then(Object::as_dict)
            .map_err(|e| e.to_string())?;
        match dict.get(b"Resources") {
            Ok(Object::Reference(id)) => Some(*id),
            _ => None,
        }
    };
    if let Some(res_id) = resources_ref {
        let clone = inc
            .get_prev_documents()
            .get_object(res_id)
            .map_err(|e| e.to_string())?
            .clone();
        let page = inc
            .new_document
            .get_object_mut(page_id)
            .and_then(Object::as_dict_mut)
            .map_err(|e| e.to_string())?;
        page.set(b"Resources", clone);
    }

    // Step 2: inline /Resources/Font and /Resources/XObject if either is a reference.
    let (font_ref, xobj_ref): (Option<ObjectId>, Option<ObjectId>) = {
        let dict = inc
            .new_document
            .get_object(page_id)
            .and_then(Object::as_dict)
            .map_err(|e| e.to_string())?;
        let res = match dict.get(b"Resources") {
            Ok(Object::Dictionary(d)) => d,
            _ => return Ok(()),
        };
        let f = match res.get(b"Font") {
            Ok(Object::Reference(id)) => Some(*id),
            _ => None,
        };
        let x = match res.get(b"XObject") {
            Ok(Object::Reference(id)) => Some(*id),
            _ => None,
        };
        (f, x)
    };
    for (key, maybe_ref) in [(&b"Font"[..], font_ref), (&b"XObject"[..], xobj_ref)] {
        let Some(sub_id) = maybe_ref else { continue };
        let clone = inc
            .get_prev_documents()
            .get_object(sub_id)
            .map_err(|e| e.to_string())?
            .clone();
        let page = inc
            .new_document
            .get_object_mut(page_id)
            .and_then(Object::as_dict_mut)
            .map_err(|e| e.to_string())?;
        if let Ok(Object::Dictionary(res)) = page.get_mut(b"Resources") {
            res.set(key.to_vec(), clone);
        }
    }
    Ok(())
}

/// Pre-clone every `/AcroForm` field dict so `write_form_fields` can `get_object_mut`
/// freely on `inc.new_document` without crossing back into `prev_documents`.
fn clone_acroform_tree(inc: &mut IncrementalDocument, cat_id: ObjectId) -> lopdf::Result<()> {
    let acroform_id = {
        let dict = inc.get_prev_documents().get_object(cat_id).and_then(Object::as_dict)?;
        match dict.get(b"AcroForm") {
            Ok(Object::Reference(id)) => *id,
            // Inline AcroForm dict: write_form_fields will promote it itself once the
            // catalog is in new_document.
            _ => return Ok(()),
        }
    };
    inc.opt_clone_object_to_new_document(acroform_id)?;

    let field_refs: Vec<ObjectId> = {
        let dict = inc
            .get_prev_documents()
            .get_object(acroform_id)
            .and_then(Object::as_dict)?;
        match dict.get(b"Fields") {
            Ok(Object::Array(arr)) => arr.iter().filter_map(|o| o.as_reference().ok()).collect(),
            _ => return Ok(()),
        }
    };

    let mut stack: Vec<ObjectId> = field_refs;
    let mut seen: HashSet<ObjectId> = HashSet::new();
    while let Some(field_id) = stack.pop() {
        if !seen.insert(field_id) {
            continue;
        }
        inc.opt_clone_object_to_new_document(field_id)?;
        let kids_refs: Vec<ObjectId> = inc
            .get_prev_documents()
            .get_object(field_id)
            .and_then(Object::as_dict)
            .ok()
            .and_then(|d| d.get(b"Kids").ok())
            .and_then(|o| match o {
                Object::Array(arr) => Some(arr.iter().filter_map(|o| o.as_reference().ok()).collect()),
                _ => None,
            })
            .unwrap_or_default();
        for kid in kids_refs {
            stack.push(kid);
        }
    }
    Ok(())
}

/// Creates a copy of the PDF with annotation content streams emptied
/// (the CCAnnot metadata is preserved). Returns true if any streams were cleared.
/// Used to produce a "display" PDF that pdf.js can render without showing
/// burned annotation content — the overlay draws all annotations from memory.
#[tauri::command]
pub fn strip_annotation_streams(
    input_path: String,
    output_path: String,
) -> Result<bool, String> {
    let meta_empty = Document::load(&input_path)
        .map(|d| writer::load_meta(&d).stream_ids.is_empty())
        .unwrap_or(true);
    if meta_empty {
        // No burn streams to clear; just copy bytes verbatim and avoid lopdf's
        // corruption-prone full rewrite.
        fsutil::copy_atomic(&input_path, &output_path)?;
        return Ok(false);
    }

    let mut inc = IncrementalDocument::load(&input_path).map_err(|e| e.to_string())?;
    let meta = writer::load_meta(inc.get_prev_documents());
    for arr in meta.stream_ids.values() {
        let sid = (arr[0], arr[1] as u16);
        inc.opt_clone_object_to_new_document(sid)
            .map_err(|e| e.to_string())?;
        if let Ok(Object::Stream(s)) = inc.new_document.get_object_mut(sid) {
            writer::set_raw_content(s, vec![]);
        }
    }
    fsutil::save_incremental(&mut inc, &output_path)?;
    Ok(true)
}

/// Writes `input_path` to `output_path` with `pages` replaced by their
/// redacted images. Always a full rewrite: an incremental update would keep
/// the original page content in the file's earlier revision.
#[tauri::command]
pub fn redact_pages(
    input_path: String,
    output_path: String,
    pages: Vec<redact::RedactedPage>,
) -> Result<(), String> {
    let mut doc = Document::load(&input_path).map_err(|e| e.to_string())?;
    let page_count = doc.get_pages().len();
    redact::redact_pages(&mut doc, &pages)?;
    if doc.get_pages().len() != page_count {
        return Err("Redaction aborted: page count changed".into());
    }
    fsutil::save_document(&mut doc, &output_path)
}

/// Reads editable annotations from the PDF's `CCAnnot` catalog entry.
/// Returns an empty array if the file has no stored annotations.
#[tauri::command]
pub fn read_annotations(file_path: String) -> Result<Vec<Annotation>, String> {
    let doc = Document::load(&file_path).map_err(|e| e.to_string())?;
    Ok(writer::load_meta(&doc).annotations)
}

/// One page of the document produced by [`rearrange_pages`], in output order.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PageSlot {
    /// Page `page` (1-based) of the input file, turned by `rotation` degrees.
    Original { page: u32, rotation: i64 },
    /// A new empty page of `width` × `height` PDF points.
    Blank { width: f64, height: f64, rotation: i64 },
    /// Page `page` (1-based) of another PDF file at `path`.
    Imported { path: String, page: u32, rotation: i64 },
    /// A new page showing a picture (base64 PNG or JPEG), sized to it.
    Image { data: String, rotation: i64 },
}

/// Longest side of a page made from a picture (A4), in PDF points.
const IMAGE_PAGE_LONG: f64 = 842.0;
const IMAGE_PAGE_SHORT: f64 = 595.0;

/// Size of the page that shows a `w` × `h` px picture: the picture fitted
/// into A4 in its own orientation, with no margin.
fn image_page_size(w: u32, h: u32) -> (f64, f64) {
    let (w, h) = (f64::from(w.max(1)), f64::from(h.max(1)));
    let (box_w, box_h) = if w > h { (IMAGE_PAGE_LONG, IMAGE_PAGE_SHORT) } else { (IMAGE_PAGE_SHORT, IMAGE_PAGE_LONG) };
    let k = (box_w / w).min(box_h / h);
    ((w * k * 100.0).round() / 100.0, (h * k * 100.0).round() / 100.0)
}

/// Adds a page showing the base64 picture `data` to `doc` and returns its id.
fn image_page(doc: &mut Document, data: &str) -> Result<ObjectId, String> {
    use base64::Engine;
    let b64 = data.split_once(',').map_or(data, |(_, d)| d);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("invalid image data: {e}"))?;
    let (w, h) = image::ImageReader::new(std::io::Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .into_dimensions()
        .map_err(|e| format!("invalid image: {e}"))?;
    let (img_id, _) = writer::embed_image(doc, &bytes)?;
    let (pw, ph) = image_page_size(w, h);
    let ops = format!("q\n{pw:.2} 0 0 {ph:.2} 0 0 cm\n/Im0 Do\nQ\n");
    let contents = doc.add_object(lopdf::Stream::new(lopdf::Dictionary::new(), ops.into_bytes()));
    let mut xobjects = lopdf::Dictionary::new();
    xobjects.set("Im0", Object::Reference(img_id));
    let mut resources = lopdf::Dictionary::new();
    resources.set("XObject", Object::Dictionary(xobjects));
    let mut dict = lopdf::Dictionary::new();
    dict.set("Type", Object::Name(b"Page".to_vec()));
    dict.set(
        "MediaBox",
        Object::Array(vec![0.into(), 0.into(), Object::Real(pw as f32), Object::Real(ph as f32)]),
    );
    dict.set("Resources", Object::Dictionary(resources));
    dict.set("Contents", Object::Reference(contents));
    Ok(doc.add_object(dict))
}

/// Attributes a page may inherit from its ancestors in the page tree
/// (PDF 32000-1, 7.7.3.4).
const INHERITABLE: [&[u8]; 4] = [b"Resources", b"MediaBox", b"CropBox", b"Rotate"];

/// Builds a new page list from `slots`: input pages may be reordered, rotated
/// or left out (deleted), and blank pages or pages of other PDFs inserted.
///
/// Implementation notes
/// --------------------
/// We **MUST NOT** round-trip the document through `Document::load` + `save`.
/// lopdf's full-save path corrupts content streams on PDFs that use object
/// streams (`/ObjStm`) or indirect-reference `/Length` entries (typical of
/// iLovePDF/Acrobat output). Instead, we use `IncrementalDocument`, which
/// preserves the input bytes verbatim and only appends an incremental update.
///
/// The update flattens the page tree: the root `/Pages` node gets the new
/// page list as its `/Kids`, and every kept page is cloned into the update
/// with `/Parent` pointing at the root and the attributes it used to inherit
/// from intermediate nodes copied onto it. Pages left out, and intermediate
/// nodes, stay in the original bytes but become unreferenced, so viewers
/// ignore them. Imported pages are deep-copied, with every object they
/// reference, as new objects of the update.
#[tauri::command]
pub fn rearrange_pages(
    input_path: String,
    output_path: String,
    slots: Vec<PageSlot>,
) -> Result<(), String> {
    if slots.is_empty() {
        return Err("A document needs at least one page".to_string());
    }
    let mut inc = IncrementalDocument::load(&input_path).map_err(|e| e.to_string())?;
    let prev_pages = inc.get_prev_documents().get_pages();

    let cat_id = inc
        .get_prev_documents()
        .trailer
        .get(b"Root")
        .and_then(Object::as_reference)
        .map_err(|e| format!("No catalog: {e}"))?;
    let root_pages = inc
        .get_prev_documents()
        .get_object(cat_id)
        .and_then(Object::as_dict)
        .and_then(|d| d.get(b"Pages"))
        .and_then(Object::as_reference)
        .map_err(|e| format!("No page tree: {e}"))?;

    // Old page number → new page number, for the annotation metadata.
    let mut renumber: HashMap<u32, u32> = HashMap::new();
    let mut kids: Vec<Object> = Vec::with_capacity(slots.len());

    // Pages imported from the same file share one importer, so resources they
    // have in common are copied once.
    let mut importers: HashMap<String, Importer> = HashMap::new();
    for slot in &slots {
        if let PageSlot::Imported { path, .. } = slot {
            if !importers.contains_key(path) {
                importers.insert(path.clone(), Importer::load(path)?);
            }
        }
    }
    // Allocate an id for every imported page before copying anything, so
    // links between imported pages (annotation /P, ...) stay connected.
    let mut imported_ids: Vec<Option<ObjectId>> = Vec::with_capacity(slots.len());
    for slot in &slots {
        imported_ids.push(match slot {
            PageSlot::Imported { path, page, .. } => {
                let importer = importers.get_mut(path).expect("loaded above");
                Some(importer.reserve_page(*page, &mut inc.new_document)?)
            }
            _ => None,
        });
    }

    for (index, slot) in slots.iter().enumerate() {
        let new_num = index as u32 + 1;
        let (page_id, rotation) = match slot {
            PageSlot::Original { page, rotation } => {
                let &page_id = prev_pages
                    .get(page)
                    .ok_or_else(|| format!("Page {page} does not exist"))?;
                if renumber.insert(*page, new_num).is_some() {
                    return Err(format!("Page {page} is listed twice"));
                }
                let inherited = inherited_attributes(inc.get_prev_documents(), page_id);
                inc.opt_clone_object_to_new_document(page_id)
                    .map_err(|e| e.to_string())?;
                let dict = inc
                    .new_document
                    .get_object_mut(page_id)
                    .and_then(Object::as_dict_mut)
                    .map_err(|e| format!("page {page}: {e}"))?;
                for (key, value) in inherited {
                    dict.set(key, value);
                }
                (page_id, *rotation)
            }
            PageSlot::Blank { width, height, rotation } => {
                let contents = inc
                    .new_document
                    .add_object(lopdf::Stream::new(lopdf::Dictionary::new(), Vec::new()));
                let mut dict = lopdf::Dictionary::new();
                dict.set("Type", Object::Name(b"Page".to_vec()));
                dict.set(
                    "MediaBox",
                    Object::Array(vec![0.into(), 0.into(), Object::Real(*width as f32), Object::Real(*height as f32)]),
                );
                dict.set("Resources", Object::Dictionary(lopdf::Dictionary::new()));
                dict.set("Contents", Object::Reference(contents));
                (inc.new_document.add_object(dict), *rotation)
            }
            PageSlot::Image { data, rotation } => (image_page(&mut inc.new_document, data)?, *rotation),
            PageSlot::Imported { path, rotation, .. } => {
                let page_id = imported_ids[index].expect("reserved above");
                importers
                    .get_mut(path)
                    .expect("loaded above")
                    .copy_page(page_id, &mut inc.new_document)?;
                (page_id, *rotation)
            }
        };

        let dict = inc
            .new_document
            .get_object_mut(page_id)
            .and_then(Object::as_dict_mut)
            .map_err(|e| e.to_string())?;
        dict.set("Parent", Object::Reference(root_pages));
        if rotation != 0 {
            let current = dict.get(b"Rotate").and_then(Object::as_i64).unwrap_or(0);
            dict.set("Rotate", Object::Integer((current + rotation).rem_euclid(360)));
        }
        kids.push(Object::Reference(page_id));
    }

    // Every kept page now carries its inherited attributes itself; drop them
    // from the root so they don't leak onto blank or imported pages.
    inc.opt_clone_object_to_new_document(root_pages)
        .map_err(|e| e.to_string())?;
    let root = inc
        .new_document
        .get_object_mut(root_pages)
        .and_then(Object::as_dict_mut)
        .map_err(|e| e.to_string())?;
    for key in INHERITABLE {
        root.remove(key);
    }
    root.set("Count", Object::Integer(kids.len() as i64));
    root.set("Kids", Object::Array(kids));
    root.remove(b"Parent");

    // Editable annotations follow their page; those of removed pages go.
    let mut meta = writer::load_meta(inc.get_prev_documents());
    meta.annotations.retain(|ann| renumber.contains_key(&ann.page()));
    for ann in &mut meta.annotations {
        ann.set_page(renumber[&ann.page()]);
    }
    meta.stream_ids = std::mem::take(&mut meta.stream_ids)
        .into_iter()
        .filter_map(|(page, ids)| renumber.get(&page).map(|&p| (p, ids)))
        .collect();

    // save_meta needs the catalog in new_document so it can set /CCAnnot on it.
    inc.opt_clone_object_to_new_document(cat_id)
        .map_err(|e| e.to_string())?;
    writer::save_meta(&mut inc.new_document, &meta)?;

    fsutil::save_incremental(&mut inc, &output_path)?;
    Ok(())
}

/// The inheritable attributes `page_id` lacks itself, taken from its nearest
/// ancestor that has them.
fn inherited_attributes(doc: &Document, page_id: ObjectId) -> Vec<(&'static [u8], Object)> {
    let Ok(page) = doc.get_object(page_id).and_then(Object::as_dict) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    let mut missing: Vec<&'static [u8]> =
        INHERITABLE.iter().copied().filter(|k| !page.has(k)).collect();
    let mut cursor = page.get(b"Parent").and_then(Object::as_reference).ok();
    let mut depth = 0;
    while let Some(id) = cursor {
        depth += 1;
        if missing.is_empty() || depth > 64 {
            break;
        }
        let Ok(node) = doc.get_object(id).and_then(Object::as_dict) else { break };
        missing.retain(|key| match node.get(key) {
            Ok(value) => {
                found.push((*key, value.clone()));
                false
            }
            Err(_) => true,
        });
        cursor = node.get(b"Parent").and_then(Object::as_reference).ok();
    }
    found
}

/// Copies pages of another PDF, and every object they reference, into the
/// incremental update of the document being edited.
struct Importer {
    src: Document,
    pages: std::collections::BTreeMap<u32, ObjectId>,
    /// Source object id → id in the edited document.
    map: HashMap<ObjectId, ObjectId>,
    /// Id of each reserved page in the edited document → its source id.
    reserved: HashMap<ObjectId, ObjectId>,
}

impl Importer {
    fn load(path: &str) -> Result<Self, String> {
        let src = Document::load(path).map_err(|e| format!("{path}: {e}"))?;
        if src.is_encrypted() {
            return Err(format!("{path}: encrypted PDFs cannot be inserted"));
        }
        let pages = src.get_pages();
        Ok(Self { src, pages, map: HashMap::new(), reserved: HashMap::new() })
    }

    /// Picks the id page `page` will have in `dst`. Importing the same page
    /// twice yields two independent copies.
    fn reserve_page(&mut self, page: u32, dst: &mut Document) -> Result<ObjectId, String> {
        let &src_id = self
            .pages
            .get(&page)
            .ok_or_else(|| format!("Page {page} does not exist in the inserted file"))?;
        let new_id = dst.new_object_id();
        // Links to a page imported twice point at its first copy.
        self.map.entry(src_id).or_insert(new_id);
        self.reserved.insert(new_id, src_id);
        Ok(new_id)
    }

    /// Writes the page reserved as `new_id` into `dst`.
    fn copy_page(&mut self, new_id: ObjectId, dst: &mut Document) -> Result<(), String> {
        let src_id = *self
            .reserved
            .get(&new_id)
            .ok_or_else(|| "internal error: page was not reserved".to_string())?;
        let mut dict = self
            .src
            .get_object(src_id)
            .and_then(Object::as_dict)
            .map_err(|e| e.to_string())?
            .clone();
        for (key, value) in inherited_attributes(&self.src, src_id) {
            dict.set(key, value);
        }
        // The structure tree and article threads are not carried over.
        for key in [&b"Parent"[..], b"StructParents", b"B", b"Tabs"] {
            dict.remove(key);
        }
        let copied = self.copy_dict(&dict, dst);
        dst.objects.insert(new_id, Object::Dictionary(copied));
        Ok(())
    }

    fn copy_dict(&mut self, dict: &lopdf::Dictionary, dst: &mut Document) -> lopdf::Dictionary {
        let mut out = lopdf::Dictionary::new();
        for (key, value) in dict.iter() {
            out.set(key.clone(), self.copy_value(value, dst));
        }
        out
    }

    fn copy_value(&mut self, value: &Object, dst: &mut Document) -> Object {
        match value {
            Object::Reference(id) => self.copy_ref(*id, dst),
            Object::Array(items) => {
                Object::Array(items.iter().map(|o| self.copy_value(o, dst)).collect())
            }
            Object::Dictionary(d) => Object::Dictionary(self.copy_dict(d, dst)),
            Object::Stream(s) => {
                let mut dict = self.copy_dict(&s.dict, dst);
                dict.set("Length", Object::Integer(s.content.len() as i64));
                let mut stream = s.clone();
                stream.dict = dict;
                Object::Stream(stream)
            }
            other => other.clone(),
        }
    }

    fn copy_ref(&mut self, id: ObjectId, dst: &mut Document) -> Object {
        if let Some(&new_id) = self.map.get(&id) {
            return Object::Reference(new_id);
        }
        let Ok(obj) = self.src.get_object(id) else { return Object::Null };
        // A link to a page that is not imported (an outline or link target)
        // would drag the whole source page tree along: cut it.
        let is_page_node = match obj {
            Object::Dictionary(d) => d
                .get(b"Type")
                .and_then(Object::as_name)
                .is_ok_and(|t| t == b"Page" || t == b"Pages"),
            _ => false,
        };
        if is_page_node {
            return Object::Null;
        }
        let obj = obj.clone();
        let new_id = dst.new_object_id();
        self.map.insert(id, new_id);
        let copied = self.copy_value(&obj, dst);
        dst.objects.insert(new_id, copied);
        Object::Reference(new_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_pages_fit_a4_in_their_orientation() {
        assert_eq!(image_page_size(1000, 2000), (421.0, 842.0));
        assert_eq!(image_page_size(3000, 2000), (842.0, 561.33));
        assert_eq!(image_page_size(100, 100), (595.0, 595.0));
    }
    use lopdf::{dictionary, ObjectId};

    use crate::test_util::{fixture, tmp};

    /// The page manager's former rotate/delete-only request.
    struct PageOperation {
        page: u32,
        rotation: i64,
        delete: bool,
    }

    fn modify_pages(input: String, output: String, ops: Vec<PageOperation>) -> Result<(), String> {
        let total = Document::load(&input).unwrap().get_pages().len() as u32;
        let slots = (1..=total)
            .filter_map(|page| {
                let op = ops.iter().find(|op| op.page == page);
                match op {
                    Some(op) if op.delete => None,
                    _ => Some(PageSlot::Original { page, rotation: op.map_or(0, |op| op.rotation) }),
                }
            })
            .collect();
        rearrange_pages(input, output, slots)
    }

    fn rect(page: u32, w: f64) -> Annotation {
        serde_json::from_value(serde_json::json!({
            "kind": "rect", "page": page, "x": 10.0, "y": 10.0, "width": w,
            "height": 40.0, "color": {"r": 255, "g": 0, "b": 0}, "strokeWidth": 2.0
        }))
        .unwrap()
    }

    /// Save, re-save with a changed annotation, strip, then delete a page, on a
    /// PDF with object streams + indirect /Length (iLovePDF / Acrobat style).
    #[test]
    fn annotate_resave_strip_and_delete_on_object_stream_pdf() {
        let first = tmp("first.pdf");
        let second = tmp("second.pdf");
        let stripped = tmp("stripped.pdf");
        let one_page = tmp("one.pdf");

        save_annotated_pdf(fixture("objstm-indirect-length.pdf"), first.clone(), vec![rect(1, 200.0)], 0, vec![]).unwrap();
        assert_eq!(read_annotations(first.clone()).unwrap().len(), 1);

        // Re-saving rewrites the existing burn stream in place; its /Length
        // used to stay at the old size.
        save_annotated_pdf(first.clone(), second.clone(), vec![rect(1, 20.0), rect(1, 30.0)], 0, vec![]).unwrap();
        crate::test_util::assert_lengths_consistent(&second);
        assert_eq!(read_annotations(second.clone()).unwrap().len(), 2);

        assert!(strip_annotation_streams(second.clone(), stripped.clone()).unwrap());
        crate::test_util::assert_lengths_consistent(&stripped);

        modify_pages(second.clone(), one_page.clone(), vec![PageOperation { page: 2, rotation: 0, delete: true }]).unwrap();
        let doc = Document::load(&one_page).unwrap();
        assert_eq!(doc.get_pages().len(), 1);
        assert!(doc.extract_text(&[1]).unwrap().contains("Page 1"));

        for p in [first, second, stripped, one_page] {
            std::fs::remove_file(p).ok();
        }
    }

    /// Build a PDF whose page tree mirrors iLovePDF/Acrobat output: a root
    /// /Pages node with several intermediate /Pages nodes, each holding several
    /// leaf /Page entries. This is the structure lopdf 0.39's delete_pages
    /// corrupts.
    fn build_nested_pdf(pages_per_group: usize, groups: usize) -> (Document, Vec<ObjectId>) {
        let mut doc = Document::new();
        doc.version = "1.7".to_string();

        // Allocate the root /Pages first so leaves can reference its (eventual) id
        // via /Parent. We'll fill in its /Kids after building intermediates.
        let root_id = doc.add_object(dictionary! {
            b"Type" => Object::Name(b"Pages".to_vec()),
            b"Kids" => Object::Array(vec![]),
            b"Count" => Object::Integer(0),
        });

        let mut intermediate_ids = Vec::new();
        let mut leaf_ids = Vec::new();

        for _ in 0..groups {
            let mid_id = doc.add_object(dictionary! {
                b"Type" => Object::Name(b"Pages".to_vec()),
                b"Parent" => Object::Reference(root_id),
                b"Kids" => Object::Array(vec![]),
                b"Count" => Object::Integer(0),
            });
            let mut kids_for_mid = Vec::new();
            for _ in 0..pages_per_group {
                let leaf_id = doc.add_object(dictionary! {
                    b"Type" => Object::Name(b"Page".to_vec()),
                    b"Parent" => Object::Reference(mid_id),
                    b"MediaBox" => Object::Array(vec![
                        Object::Integer(0), Object::Integer(0),
                        Object::Integer(612), Object::Integer(792),
                    ]),
                    b"Resources" => Object::Dictionary(lopdf::Dictionary::new()),
                });
                kids_for_mid.push(Object::Reference(leaf_id));
                leaf_ids.push(leaf_id);
            }
            if let Ok(Object::Dictionary(d)) = doc.get_object_mut(mid_id) {
                d.set(b"Kids".to_vec(), Object::Array(kids_for_mid));
                d.set(b"Count".to_vec(), Object::Integer(pages_per_group as i64));
            }
            intermediate_ids.push(mid_id);
        }

        let root_kids: Vec<Object> = intermediate_ids
            .iter()
            .copied()
            .map(Object::Reference)
            .collect();
        let total = (pages_per_group * groups) as i64;
        if let Ok(Object::Dictionary(d)) = doc.get_object_mut(root_id) {
            d.set(b"Kids".to_vec(), Object::Array(root_kids));
            d.set(b"Count".to_vec(), Object::Integer(total));
        }

        let cat_id = doc.add_object(dictionary! {
            b"Type" => Object::Name(b"Catalog".to_vec()),
            b"Pages" => Object::Reference(root_id),
        });
        doc.trailer.set(b"Root", Object::Reference(cat_id));

        (doc, leaf_ids)
    }

    /// Regression: deleting page 1 from a multi-level page tree (iLovePDF
    /// layout: root → 4 intermediates of 20 pages) used to corrupt the tree
    /// because lopdf's `delete_pages` doesn't scrub the deleted ref from every
    /// intermediate /Kids. The saved file would end up with the deleted page
    /// still referenced and other intermediates with empty Kids/Count=0.
    #[test]
    fn delete_first_page_of_multi_level_tree() {
        let (mut doc, _leaves) = build_nested_pdf(20, 4);
        assert_eq!(doc.get_pages().len(), 80);

        let input = std::env::temp_dir().join("ezreader-test-multilevel-in.pdf");
        let output = std::env::temp_dir().join("ezreader-test-multilevel-out.pdf");
        doc.save(&input).unwrap();

        modify_pages(
            input.to_string_lossy().into_owned(),
            output.to_string_lossy().into_owned(),
            vec![PageOperation { page: 1, rotation: 0, delete: true }],
        )
        .unwrap();

        let saved = Document::load(&output).unwrap();
        assert_eq!(
            saved.get_pages().len(),
            79,
            "saved file should have 79 pages after deleting page 1"
        );

        // No /Pages node should still reference 80 entries, and the catalog's
        // root /Pages must report Count=79.
        let cat_id = saved
            .trailer
            .get(b"Root")
            .and_then(|o| o.as_reference())
            .unwrap();
        let root_pages_id = saved
            .get_object(cat_id)
            .and_then(Object::as_dict)
            .and_then(|d| d.get(b"Pages"))
            .and_then(Object::as_reference)
            .unwrap();
        let root = saved
            .get_object(root_pages_id)
            .and_then(Object::as_dict)
            .unwrap();
        let root_count = root.get(b"Count").and_then(Object::as_i64).unwrap();
        assert_eq!(root_count, 79, "root /Pages Count must be 79");

        let _ = std::fs::remove_file(&input);
        let _ = std::fs::remove_file(&output);
    }

    fn page_order(path: &str) -> Vec<String> {
        let doc = Document::load(path).unwrap();
        doc.get_pages()
            .keys()
            .map(|&n| doc.extract_text(&[n]).unwrap_or_default().trim().to_string())
            .collect()
    }

    /// Reordering a multi-level tree (and the iLovePDF-style fixture) keeps
    /// every page readable in the new order; annotations follow their page.
    #[test]
    fn rearrange_reorders_pages_and_annotations() {
        let annotated = tmp("rearrange-annotated.pdf");
        let out = tmp("rearrange-out.pdf");
        save_annotated_pdf(fixture("objstm-indirect-length.pdf"), annotated.clone(), vec![rect(1, 50.0)], 0, vec![]).unwrap();
        let before = page_order(&annotated);
        assert!(before.len() >= 2);

        rearrange_pages(
            annotated.clone(),
            out.clone(),
            vec![
                PageSlot::Original { page: 2, rotation: 90 },
                PageSlot::Original { page: 1, rotation: 0 },
            ],
        )
        .unwrap();
        crate::test_util::assert_lengths_consistent(&out);
        let after = page_order(&out);
        assert_eq!(after, vec![before[1].clone(), before[0].clone()]);

        let anns = read_annotations(out.clone()).unwrap();
        assert_eq!(anns.len(), 1);
        assert_eq!(anns[0].page(), 2, "the annotation moves with page 1");

        let doc = Document::load(&out).unwrap();
        let first = doc.get_pages()[&1];
        let rotate = doc.get_object(first).unwrap().as_dict().unwrap().get(b"Rotate").unwrap().as_i64().unwrap();
        assert_eq!(rotate, 90);

        for p in [annotated, out] {
            std::fs::remove_file(p).ok();
        }
    }

    /// Pages under intermediate nodes inherit /MediaBox; flattening must copy
    /// it down, and blank pages must not inherit anything from the root.
    #[test]
    fn rearrange_inserts_blank_pages_and_keeps_inherited_boxes() {
        let (mut doc, leaves) = build_nested_pdf(2, 2);
        // Move MediaBox of the first group up to its intermediate node.
        let mid = doc.get_object(leaves[0]).unwrap().as_dict().unwrap().get(b"Parent").unwrap().as_reference().unwrap();
        for &leaf in &leaves[..2] {
            doc.get_object_mut(leaf).unwrap().as_dict_mut().unwrap().remove(b"MediaBox");
        }
        doc.get_object_mut(mid).unwrap().as_dict_mut().unwrap().set(
            "MediaBox",
            Object::Array(vec![0.into(), 0.into(), 300.into(), 400.into()]),
        );
        let input = tmp("rearrange-blank-in.pdf");
        let out = tmp("rearrange-blank-out.pdf");
        doc.save(&input).unwrap();

        rearrange_pages(
            input.clone(),
            out.clone(),
            vec![
                PageSlot::Original { page: 4, rotation: 0 },
                PageSlot::Blank { width: 200.0, height: 100.0, rotation: 0 },
                PageSlot::Original { page: 1, rotation: 0 },
            ],
        )
        .unwrap();

        let saved = Document::load(&out).unwrap();
        let pages = saved.get_pages();
        assert_eq!(pages.len(), 3);
        let media = |n: u32| -> Vec<f32> {
            let dict = saved.get_object(pages[&n]).unwrap().as_dict().unwrap();
            dict.get(b"MediaBox").unwrap().as_array().unwrap().iter().map(|o| o.as_float().unwrap()).collect()
        };
        assert_eq!(media(1), vec![0.0, 0.0, 612.0, 792.0]);
        assert_eq!(media(2), vec![0.0, 0.0, 200.0, 100.0]);
        assert_eq!(media(3), vec![0.0, 0.0, 300.0, 400.0], "page 1 keeps the box it inherited");

        for p in [input, out] {
            std::fs::remove_file(p).ok();
        }
    }

    /// Pages of another PDF are copied in with their content and resources.
    #[test]
    fn rearrange_imports_pages_from_another_pdf() {
        let (mut doc, _) = build_nested_pdf(1, 1);
        let input = tmp("rearrange-import-in.pdf");
        let out = tmp("rearrange-import-out.pdf");
        doc.save(&input).unwrap();
        let other = fixture("objstm-indirect-length.pdf");
        let other_text = page_order(&other);

        rearrange_pages(
            input.clone(),
            out.clone(),
            vec![
                PageSlot::Imported { path: other.clone(), page: 2, rotation: 0 },
                PageSlot::Original { page: 1, rotation: 0 },
                PageSlot::Imported { path: other.clone(), page: 1, rotation: 180 },
            ],
        )
        .unwrap();
        crate::test_util::assert_lengths_consistent(&out);

        let after = page_order(&out);
        assert_eq!(after.len(), 3);
        assert_eq!(after[0], other_text[1]);
        assert_eq!(after[2], other_text[0]);

        // A second edit on top of the first still works.
        let again = tmp("rearrange-import-again.pdf");
        rearrange_pages(out.clone(), again.clone(), vec![PageSlot::Original { page: 3, rotation: 0 }]).unwrap();
        assert_eq!(page_order(&again), vec![other_text[0].clone()]);

        for p in [input, out, again] {
            std::fs::remove_file(p).ok();
        }
    }

    #[test]
    fn rearrange_rejects_empty_and_duplicate_lists() {
        let (mut doc, _) = build_nested_pdf(2, 1);
        let input = tmp("rearrange-bad-in.pdf");
        let out = tmp("rearrange-bad-out.pdf");
        doc.save(&input).unwrap();
        assert!(rearrange_pages(input.clone(), out.clone(), vec![]).is_err());
        let dup = vec![
            PageSlot::Original { page: 1, rotation: 0 },
            PageSlot::Original { page: 1, rotation: 0 },
        ];
        assert!(rearrange_pages(input.clone(), out.clone(), dup).unwrap_err().contains("twice"));
        std::fs::remove_file(input).ok();
    }

    /// split_pdf produces one PDF per range with the expected page count
    /// and reuses existing filenames safely via `-2` suffixes.
    #[test]
    fn split_pdf_produces_one_file_per_range() {
        let (mut doc, _) = build_nested_pdf(5, 2); // 10 pages
        let dir = std::env::temp_dir().join(format!(
            "ezreader-split-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("in.pdf");
        doc.save(&input).unwrap();

        let ranges = vec![
            SplitRange { start: 1, end: 3 },
            SplitRange { start: 4, end: 4 },
            SplitRange { start: 5, end: 10 },
        ];
        let created = split_pdf(
            input.to_string_lossy().into_owned(),
            dir.to_string_lossy().into_owned(),
            "doc".to_string(),
            ranges,
        )
        .unwrap();

        assert_eq!(created.len(), 3);
        assert!(created[0].ends_with("doc-pages-1-3.pdf"));
        assert!(created[1].ends_with("doc-page-4.pdf"));
        assert!(created[2].ends_with("doc-pages-5-10.pdf"));

        let counts: Vec<usize> = created
            .iter()
            .map(|p| Document::load(p).unwrap().get_pages().len())
            .collect();
        assert_eq!(counts, vec![3, 1, 6]);

        // Re-running the same split should append `-2` suffixes to avoid collision.
        let created2 = split_pdf(
            input.to_string_lossy().into_owned(),
            dir.to_string_lossy().into_owned(),
            "doc".to_string(),
            vec![SplitRange { start: 1, end: 3 }],
        )
        .unwrap();
        assert!(created2[0].ends_with("doc-pages-1-3-2.pdf"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn split_pdf_rejects_out_of_range() {
        let (mut doc, _) = build_nested_pdf(3, 1); // 3 pages
        let dir = std::env::temp_dir().join(format!(
            "ezreader-split-oob-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("in.pdf");
        doc.save(&input).unwrap();

        let err = split_pdf(
            input.to_string_lossy().into_owned(),
            dir.to_string_lossy().into_owned(),
            "doc".to_string(),
            vec![SplitRange { start: 1, end: 99 }],
        )
        .unwrap_err();
        assert!(err.contains("Invalid range"), "got: {err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Deleting a contiguous slice from the middle: 3 pages out of 20 across
    /// two intermediates must shift annotation pages correctly and leave the
    /// remaining 17 pages readable.
    #[test]
    fn delete_pages_across_intermediates() {
        let (mut doc, _) = build_nested_pdf(5, 4);
        assert_eq!(doc.get_pages().len(), 20);

        let input = std::env::temp_dir().join("ezreader-test-cross-in.pdf");
        let output = std::env::temp_dir().join("ezreader-test-cross-out.pdf");
        doc.save(&input).unwrap();

        let ops: Vec<PageOperation> = (1..=20)
            .map(|p| PageOperation {
                page: p,
                rotation: 0,
                delete: matches!(p, 5..=7),
            })
            .collect();

        modify_pages(
            input.to_string_lossy().into_owned(),
            output.to_string_lossy().into_owned(),
            ops,
        )
        .unwrap();

        let saved = Document::load(&output).unwrap();
        assert_eq!(saved.get_pages().len(), 17);

        let _ = std::fs::remove_file(&input);
        let _ = std::fs::remove_file(&output);
    }
}

/// Extracts selected pages from a PDF into a new file, preserving vector text.
///
/// Implementation note: we MUST NOT round-trip through `Document::save`. lopdf
/// 0.39's full-rewrite path corrupts content streams on PDFs that use object
/// streams (`/ObjStm`) or indirect-reference `/Length` entries (typical of
/// Acrobat / iLovePDF / Word output) — text comes out garbled. We use
/// `IncrementalDocument` instead, which preserves the input bytes verbatim and
/// drops unwanted pages by mutating only the page-tree metadata in an
/// incremental update. The dropped page objects remain in the bytes but become
/// unreferenced, so viewers ignore them.
#[tauri::command]
pub fn extract_pdf_pages(
    input_path: String,
    output_path: String,
    pages: Vec<u32>,
) -> Result<(), String> {
    let keep: HashSet<u32> = pages.into_iter().collect();
    extract_pages_via_incremental(&input_path, &output_path, &keep)
}

/// Keeps only the pages in `keep` (1-based). Uses `IncrementalDocument` so
/// content streams stay byte-perfect. The file size is dominated by the
/// original bytes — unreferenced page objects stay in the file as orphans.
fn extract_pages_via_incremental(
    input_path: &str,
    output_path: &str,
    keep: &HashSet<u32>,
) -> Result<(), String> {
    let mut inc = IncrementalDocument::load(input_path).map_err(|e| e.to_string())?;
    let total = inc.get_prev_documents().get_pages().len() as u32;

    let keeping_all = total > 0
        && keep.len() as u32 >= total
        && (1..=total).all(|p| keep.contains(&p));
    if keeping_all {
        // Byte-perfect copy — no incremental update needed.
        fsutil::copy_atomic(input_path, output_path)?;
        return Ok(());
    }

    let delete_set: HashSet<u32> = (1..=total).filter(|p| !keep.contains(p)).collect();
    apply_page_deletions(&mut inc, &delete_set)?;
    fsutil::save_incremental(&mut inc, output_path)?;
    Ok(())
}

/// Drops `delete_set` pages from `inc` by walking each page up to its parent,
/// removing it from /Kids, and decrementing /Count along the chain. Also
/// updates the `CCAnnot` catalog entry so editable annotations follow the page
/// renumber.
///
/// This is the same algorithm `modify_pages` uses for deletions, factored out
/// so split / extract can reuse it.
fn apply_page_deletions(
    inc: &mut IncrementalDocument,
    delete_set: &HashSet<u32>,
) -> Result<(), String> {
    if delete_set.is_empty() {
        return Ok(());
    }

    let pages = inc.get_prev_documents().get_pages();

    for &page_num in delete_set {
        let Some(&page_id) = pages.get(&page_num) else { continue };

        let direct_parent = inc
            .get_prev_documents()
            .get_object(page_id)
            .and_then(Object::as_dict)
            .and_then(|d| d.get(b"Parent"))
            .and_then(Object::as_reference)
            .map_err(|e| format!("page {page_num} has no /Parent: {e}"))?;

        inc.opt_clone_object_to_new_document(direct_parent)
            .map_err(|e| e.to_string())?;
        if let Ok(Object::Dictionary(dict)) = inc.new_document.get_object_mut(direct_parent) {
            if let Ok(Object::Array(kids)) = dict.get_mut(b"Kids") {
                kids.retain(|k| k.as_reference().ok() != Some(page_id));
            }
            let count = dict.get(b"Count").and_then(Object::as_i64).unwrap_or(0);
            dict.set(b"Count", Object::Integer(count - 1));
        }

        // Walk up the parent chain decrementing /Count.
        let mut cursor = direct_parent;
        let mut depth = 0;
        loop {
            depth += 1;
            if depth > 64 {
                break;
            }
            let next = inc
                .get_prev_documents()
                .get_object(cursor)
                .and_then(Object::as_dict)
                .and_then(|d| d.get(b"Parent"))
                .and_then(Object::as_reference);
            let Ok(next_id) = next else { break };
            if next_id == cursor {
                break;
            }
            inc.opt_clone_object_to_new_document(next_id)
                .map_err(|e| e.to_string())?;
            if let Ok(Object::Dictionary(dict)) = inc.new_document.get_object_mut(next_id) {
                let count = dict.get(b"Count").and_then(Object::as_i64).unwrap_or(0);
                dict.set(b"Count", Object::Integer(count - 1));
            }
            cursor = next_id;
        }
    }

    // Update CCAnnot metadata so editable annotations follow the page renumber.
    let mut meta = writer::load_meta(inc.get_prev_documents());
    let sorted_deleted: Vec<u32> = {
        let mut v: Vec<u32> = delete_set.iter().copied().collect();
        v.sort();
        v
    };

    meta.annotations.retain(|ann| !delete_set.contains(&ann.page()));
    for ann in &mut meta.annotations {
        let old_page = ann.page();
        let shift = sorted_deleted.iter().filter(|&&d| d < old_page).count() as u32;
        ann.set_page(old_page - shift);
    }

    let old_ids = std::mem::take(&mut meta.stream_ids);
    for (page_num, ids) in old_ids {
        if delete_set.contains(&page_num) {
            continue;
        }
        let shift = sorted_deleted.iter().filter(|&&d| d < page_num).count() as u32;
        meta.stream_ids.insert(page_num - shift, ids);
    }

    let cat_id = inc
        .get_prev_documents()
        .trailer
        .get(b"Root")
        .and_then(Object::as_reference)
        .map_err(|e| format!("No catalog: {e}"))?;
    inc.opt_clone_object_to_new_document(cat_id)
        .map_err(|e| e.to_string())?;
    writer::save_meta(&mut inc.new_document, &meta)?;

    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct SplitRange {
    /// 1-based inclusive
    pub start: u32,
    /// 1-based inclusive
    pub end: u32,
}

/// Splits a PDF into multiple files, one per range. Each output file contains
/// the pages [start, end] (inclusive, 1-based) from `input_path`.
///
/// Output filenames: `{base_name}-pages-{start}-{end}.pdf` (or
/// `{base_name}-page-{n}.pdf` when start == end). If a file already exists,
/// `-N` is appended before the extension. Returns the list of created paths.
#[tauri::command]
pub fn split_pdf(
    input_path: String,
    output_dir: String,
    base_name: String,
    ranges: Vec<SplitRange>,
) -> Result<Vec<String>, String> {
    if ranges.is_empty() {
        return Err("No ranges to split".to_string());
    }

    let total = Document::load(&input_path)
        .map_err(|e| e.to_string())?
        .get_pages()
        .len() as u32;

    let out_dir = std::path::PathBuf::from(&output_dir);
    if !out_dir.is_dir() {
        return Err(format!("Output directory not found: {output_dir}"));
    }

    let safe_base = sanitize_filename(&base_name);
    let mut created: Vec<String> = Vec::with_capacity(ranges.len());

    for range in &ranges {
        if range.start == 0 || range.end < range.start || range.end > total {
            return Err(format!(
                "Invalid range {}-{} (document has {total} page{})",
                range.start,
                range.end,
                if total == 1 { "" } else { "s" },
            ));
        }

        let stem = if range.start == range.end {
            format!("{safe_base}-page-{}", range.start)
        } else {
            format!("{safe_base}-pages-{}-{}", range.start, range.end)
        };
        let target = unique_path(&out_dir, &stem, "pdf");

        let keep: HashSet<u32> = (range.start..=range.end).collect();
        extract_pages_via_incremental(
            &input_path,
            target.to_string_lossy().as_ref(),
            &keep,
        )?;
        created.push(target.to_string_lossy().into_owned());
    }

    Ok(created)
}

/// Strips characters that are illegal in filenames on Windows/macOS/Linux.
fn sanitize_filename(name: &str) -> String {
    let trimmed = name.trim().trim_end_matches('.');
    let cleaned: String = trimmed
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    if cleaned.is_empty() {
        "document".to_string()
    } else {
        cleaned
    }
}

/// Returns `{dir}/{stem}.{ext}`, appending `-N` to the stem until a free path is found.
fn unique_path(dir: &std::path::Path, stem: &str, ext: &str) -> std::path::PathBuf {
    let candidate = dir.join(format!("{stem}.{ext}"));
    if !candidate.exists() {
        return candidate;
    }
    for n in 2u32..=9999 {
        let p = dir.join(format!("{stem}-{n}.{ext}"));
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{stem}-conflict.{ext}"))
}
