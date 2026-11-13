//! Flattening: what annotations and form fields show becomes part of the
//! page, and nothing stays interactive or editable.
//!
//! Each annotation with an appearance is painted into its page's content as
//! a form XObject, placed the way PDF 32000-1 §12.5.5 places appearances:
//! the appearance's bounding box, through its `/Matrix`, is fitted to the
//! annotation's `/Rect`. The annotation is then removed. Links stay (they
//! are navigation, not content). The AcroForm and EzReader's own editable
//! annotation data (`CCAnnot`) go too, so reopening the file gives nothing
//! back to edit: EzReader's annotations are already drawn in the page's
//! content by the time a document is exported.

use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};

/// Annotation flags (PDF 32000-1 §12.5.3).
const FLAG_HIDDEN: i64 = 1 << 1;
const FLAG_NO_VIEW: i64 = 1 << 5;

/// Annotations kept as they are.
const KEPT: [&[u8]; 1] = [b"Link"];

pub fn flatten(doc: &mut Document) -> Result<(), String> {
    let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
    for page_id in pages {
        flatten_page(doc, page_id)?;
    }
    let catalog_id = doc
        .trailer
        .get(b"Root")
        .and_then(Object::as_reference)
        .map_err(|e| format!("No catalog: {e}"))?;
    let catalog = doc.get_object_mut(catalog_id).and_then(Object::as_dict_mut).map_err(|e| e.to_string())?;
    catalog.remove(b"AcroForm");
    catalog.remove(b"CCAnnot");
    doc.prune_objects();
    Ok(())
}

fn flatten_page(doc: &mut Document, page_id: ObjectId) -> Result<(), String> {
    let annots = annotation_list(doc, page_id);
    if annots.is_empty() {
        return Ok(());
    }

    let mut kept: Vec<Object> = Vec::new();
    let mut ops = String::new();
    let mut forms: Vec<(String, ObjectId)> = Vec::new();
    for entry in annots {
        let Some(annot) = deref_dict(doc, &entry) else { continue };
        let subtype = annot.get(b"Subtype").and_then(Object::as_name).unwrap_or(b"");
        if KEPT.contains(&subtype) {
            kept.push(entry);
            continue;
        }
        if subtype == b"Popup" {
            continue; // goes with its parent
        }
        let flags = annot.get(b"F").and_then(Object::as_i64).unwrap_or(0);
        if flags & (FLAG_HIDDEN | FLAG_NO_VIEW) != 0 {
            continue;
        }
        let (Some(rect), Some(form_id)) = (rect_of(doc, annot), appearance(doc, annot)) else { continue };
        let Some(matrix) = placement(doc, form_id, rect) else { continue };
        let name = format!("EzFlat{}", forms.len());
        ops.push_str(&format!(
            "q {} cm /{name} Do Q\n",
            matrix.iter().map(|v| num(*v)).collect::<Vec<_>>().join(" ")
        ));
        forms.push((name, form_id));
    }

    if !forms.is_empty() {
        for (_, id) in &forms {
            if let Ok(Object::Stream(s)) = doc.get_object_mut(*id) {
                s.dict.set("Type", "XObject");
                s.dict.set("Subtype", "Form");
            }
        }
        let mut resources = page_resources(doc, page_id);
        let mut xobjects = match resources.get(b"XObject") {
            Ok(o) => deref_dict(doc, o).cloned().unwrap_or_default(),
            Err(_) => Dictionary::new(),
        };
        for (name, id) in &forms {
            xobjects.set(name.as_bytes(), Object::Reference(*id));
        }
        resources.set("XObject", Object::Dictionary(xobjects));

        // The original content is wrapped in q … Q so whatever state it
        // leaves behind does not move the annotations.
        let before = doc.add_object(Stream::new(dictionary! {}, b"q\n".to_vec()));
        let after = doc.add_object(Stream::new(dictionary! {}, format!("Q\n{ops}").into_bytes()));
        let mut contents = vec![Object::Reference(before)];
        contents.extend(content_entries(doc, page_id));
        contents.push(Object::Reference(after));

        let page = doc.get_object_mut(page_id).and_then(Object::as_dict_mut).map_err(|e| e.to_string())?;
        page.set("Resources", Object::Dictionary(resources));
        page.set("Contents", Object::Array(contents));
    }

    let page = doc.get_object_mut(page_id).and_then(Object::as_dict_mut).map_err(|e| e.to_string())?;
    if kept.is_empty() {
        page.remove(b"Annots");
    } else {
        page.set("Annots", Object::Array(kept));
    }
    Ok(())
}

fn deref_dict<'a>(doc: &'a Document, o: &'a Object) -> Option<&'a Dictionary> {
    match o {
        Object::Reference(id) => doc.get_object(*id).ok()?.as_dict().ok(),
        Object::Dictionary(d) => Some(d),
        _ => None,
    }
}

fn annotation_list(doc: &Document, page_id: ObjectId) -> Vec<Object> {
    let Ok(page) = doc.get_dictionary(page_id) else { return Vec::new() };
    match page.get(b"Annots") {
        Ok(Object::Array(a)) => a.clone(),
        Ok(Object::Reference(id)) => doc.get_object(*id).and_then(Object::as_array).cloned().unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn numbers(doc: &Document, o: &Object) -> Option<Vec<f64>> {
    let arr = match o {
        Object::Reference(id) => doc.get_object(*id).ok()?.as_array().ok()?,
        Object::Array(a) => a,
        _ => return None,
    };
    arr.iter().map(|v| v.as_float().ok().map(f64::from)).collect()
}

/// The annotation's `/Rect`, normalised to [x0, y0, x1, y1] with x0 < x1, y0 < y1.
fn rect_of(doc: &Document, annot: &Dictionary) -> Option<[f64; 4]> {
    let r = numbers(doc, annot.get(b"Rect").ok()?)?;
    if r.len() != 4 {
        return None;
    }
    Some([r[0].min(r[2]), r[1].min(r[3]), r[0].max(r[2]), r[1].max(r[3])])
}

/// The normal appearance stream; for a state dictionary (check boxes, radio
/// buttons) the one `/AS` names.
fn appearance(doc: &Document, annot: &Dictionary) -> Option<ObjectId> {
    let ap = deref_dict(doc, annot.get(b"AP").ok()?)?;
    match ap.get(b"N").ok()? {
        Object::Reference(id) => match doc.get_object(*id).ok()? {
            Object::Stream(_) => Some(*id),
            Object::Dictionary(states) => state_stream(states, annot),
            _ => None,
        },
        Object::Dictionary(states) => state_stream(states, annot),
        _ => None,
    }
}

fn state_stream(states: &Dictionary, annot: &Dictionary) -> Option<ObjectId> {
    let state = annot.get(b"AS").and_then(Object::as_name).ok()?;
    states.get(state).and_then(Object::as_reference).ok()
}

/// The matrix that fits the appearance's transformed bounding box to `rect`
/// (PDF 32000-1 §12.5.5, algorithm 8.1, step 2).
fn placement(doc: &Document, form_id: ObjectId, rect: [f64; 4]) -> Option<[f64; 6]> {
    let form = doc.get_object(form_id).ok()?.as_stream().ok()?;
    let bbox = numbers(doc, form.dict.get(b"BBox").ok()?)?;
    if bbox.len() != 4 {
        return None;
    }
    let m = form
        .dict
        .get(b"Matrix")
        .ok()
        .and_then(|o| numbers(doc, o))
        .filter(|m| m.len() == 6)
        .unwrap_or_else(|| vec![1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    let corners = [(bbox[0], bbox[1]), (bbox[2], bbox[1]), (bbox[2], bbox[3]), (bbox[0], bbox[3])]
        .map(|(x, y)| (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]));
    let (bx0, bx1) = corners.iter().fold((f64::MAX, f64::MIN), |(lo, hi), c| (lo.min(c.0), hi.max(c.0)));
    let (by0, by1) = corners.iter().fold((f64::MAX, f64::MIN), |(lo, hi), c| (lo.min(c.1), hi.max(c.1)));
    let (bw, bh) = (bx1 - bx0, by1 - by0);
    if bw.abs() < 1e-9 || bh.abs() < 1e-9 {
        return None;
    }
    let sx = (rect[2] - rect[0]) / bw;
    let sy = (rect[3] - rect[1]) / bh;
    Some([sx, 0.0, 0.0, sy, rect[0] - sx * bx0, rect[1] - sy * by0])
}

/// The page's resources as a direct dictionary, inherited ones included.
fn page_resources(doc: &Document, page_id: ObjectId) -> Dictionary {
    let mut cursor = Some(page_id);
    let mut depth = 0;
    while let Some(id) = cursor {
        let Ok(node) = doc.get_dictionary(id) else { break };
        if let Ok(res) = node.get(b"Resources") {
            return deref_dict(doc, res).cloned().unwrap_or_default();
        }
        cursor = node.get(b"Parent").and_then(Object::as_reference).ok();
        depth += 1;
        if depth > 64 {
            break;
        }
    }
    Dictionary::new()
}

fn content_entries(doc: &Document, page_id: ObjectId) -> Vec<Object> {
    let Ok(page) = doc.get_dictionary(page_id) else { return Vec::new() };
    match page.get(b"Contents") {
        Ok(Object::Reference(id)) => match doc.get_object(*id) {
            Ok(Object::Array(a)) => a.clone(),
            _ => vec![Object::Reference(*id)],
        },
        Ok(Object::Array(a)) => a.clone(),
        _ => Vec::new(),
    }
}

fn num(v: f64) -> String {
    let s = format!("{v:.4}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" { "0".into() } else { s.into() }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A page with a filled text field, a highlight, a link and a hidden
    /// note, plus EzReader's own annotation data in the catalog.
    fn annotated() -> Document {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let page_id = doc.new_object_id();
        let form = |doc: &mut Document, ops: &str| {
            doc.add_object(Stream::new(
                dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 100.into(), 20.into()] },
                ops.as_bytes().to_vec(),
            ))
        };
        let field_ap = form(&mut doc, "BT /Helv 12 Tf 2 5 Td (Alice) Tj ET");
        let highlight_ap = form(&mut doc, "1 1 0 rg 0 0 100 20 re f");
        let field = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Widget", "FT" => "Tx", "T" => Object::string_literal("name"),
            "V" => Object::string_literal("Alice"),
            "Rect" => vec![50.into(), 700.into(), 250.into(), 740.into()], "AP" => dictionary! { "N" => field_ap },
        });
        let highlight = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Highlight",
            "Rect" => vec![50.into(), 600.into(), 150.into(), 620.into()], "AP" => dictionary! { "N" => highlight_ap },
        });
        let link = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Link", "Rect" => vec![0.into(), 0.into(), 10.into(), 10.into()],
        });
        let hidden = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Square", "F" => 2,
            "Rect" => vec![0.into(), 0.into(), 10.into(), 10.into()], "AP" => dictionary! { "N" => highlight_ap },
        });
        let content = doc.add_object(Stream::new(dictionary! {}, b"BT /F1 12 Tf 50 750 Td (Name) Tj ET".to_vec()));
        doc.objects.insert(page_id, Object::Dictionary(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            "Contents" => content, "Annots" => vec![field.into(), highlight.into(), link.into(), hidden.into()],
        }));
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" } } },
        }));
        let meta = doc.add_object(Stream::new(dictionary! {}, b"{}".to_vec()));
        let catalog = doc.add_object(dictionary! {
            "Type" => "Catalog", "Pages" => pages_id, "CCAnnot" => meta,
            "AcroForm" => dictionary! { "Fields" => vec![field.into()] },
        });
        doc.trailer.set("Root", catalog);
        doc
    }

    #[test]
    fn appearances_become_page_content_and_nothing_stays_editable() {
        let mut doc = annotated();
        flatten(&mut doc).unwrap();
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        let doc = Document::load_mem(&bytes).unwrap();

        let catalog = doc.catalog().unwrap();
        assert!(!catalog.has(b"AcroForm"), "no form left");
        assert!(!catalog.has(b"CCAnnot"), "no editable EzReader annotations left");

        let page_id = doc.get_pages()[&1];
        let page = doc.get_dictionary(page_id).unwrap();
        let annots = page.get(b"Annots").unwrap().as_array().unwrap();
        assert_eq!(annots.len(), 1, "only the link stays");

        // The field's value and the highlight are now drawn by the page,
        // placed on their /Rect; the hidden note is not drawn.
        let content = String::from_utf8(doc.get_page_content(page_id)).unwrap();
        assert!(content.contains("q 2 0 0 2 50 700 cm /EzFlat0 Do Q"), "{content}");
        assert!(content.contains("q 1 0 0 1 50 600 cm /EzFlat1 Do Q"), "{content}");
        assert!(!content.contains("EzFlat2"));
        assert!(content.contains("(Name) Tj"), "the original content stays");
        let res = page.get(b"Resources").unwrap().as_dict().unwrap();
        assert!(res.get(b"Font").is_ok(), "inherited resources are kept");
        assert_eq!(res.get(b"XObject").unwrap().as_dict().unwrap().len(), 2);
    }

    #[test]
    fn a_page_without_annotations_is_left_alone() {
        let mut doc = annotated();
        let page_id = doc.get_pages()[&1];
        doc.get_object_mut(page_id).unwrap().as_dict_mut().unwrap().remove(b"Annots");
        let before = doc.get_dictionary(page_id).unwrap().clone();
        flatten(&mut doc).unwrap();
        assert_eq!(doc.get_dictionary(page_id).unwrap(), &before);
    }
}
