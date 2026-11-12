//! Permanent redaction.
//!
//! A redacted page is replaced by a picture of itself with the redacted areas
//! already blacked out (rendered by pdf.js on the frontend). Its original
//! content streams, resources, links and form widgets are dropped and the
//! file is fully rewritten, so neither the hidden text nor an earlier
//! incremental revision survives in the bytes. The cost is that the text of a
//! redacted page is no longer selectable.

use std::collections::HashSet;
use std::io::Cursor;

use base64::Engine;
use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use serde::Deserialize;

use crate::pdf::writer;

/// One page as rendered by the frontend.
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RedactedPage {
    /// 1-based page number.
    pub page: u32,
    /// Base64 JPEG of the page's visible area, unrotated, redactions filled.
    pub jpeg_base64: String,
    pub width_px: u32,
    pub height_px: u32,
    /// Area the image covers, in PDF user space: [x0, y0, x1, y1].
    pub view: [f64; 4],
}

/// Name of the image XObject drawn on each redacted page.
const IMAGE_NAME: &str = "EzRedacted";

/// Page entries that can carry or point at the original content.
const DROPPED_PAGE_KEYS: [&[u8]; 9] = [
    b"Annots", b"Thumb", b"PieceInfo", b"StructParents", b"CropBox",
    b"BleedBox", b"TrimBox", b"ArtBox", b"Metadata",
];

pub fn redact_pages(doc: &mut Document, pages: &[RedactedPage]) -> Result<(), String> {
    if pages.is_empty() {
        return Ok(());
    }
    let page_ids = doc.get_pages();
    let meta = writer::load_meta(doc);
    let mut dead_widgets: HashSet<ObjectId> = HashSet::new();

    for rp in pages {
        let page_id = *page_ids
            .get(&rp.page)
            .ok_or_else(|| format!("page {} not found in document", rp.page))?;

        let jpeg = base64::engine::general_purpose::STANDARD
            .decode(&rp.jpeg_base64)
            .map_err(|e| format!("page {}: invalid image data: {e}", rp.page))?;
        let (w, h) = image::ImageReader::with_format(Cursor::new(&jpeg), image::ImageFormat::Jpeg)
            .into_dimensions()
            .map_err(|e| format!("page {}: invalid JPEG: {e}", rp.page))?;
        if w != rp.width_px || h != rp.height_px {
            return Err(format!("page {}: image size mismatch", rp.page));
        }

        let mut img = Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => i64::from(w),
                "Height" => i64::from(h),
                "ColorSpace" => "DeviceRGB",
                "BitsPerComponent" => 8,
                "Filter" => "DCTDecode",
            },
            jpeg,
        );
        img.allows_compression = false;
        let img_id = doc.add_object(img);

        let [x0, y0, x1, y1] = rp.view;
        let ops = format!(
            "q {} 0 0 {} {} {} cm /{IMAGE_NAME} Do Q\n",
            fmt(x1 - x0), fmt(y1 - y0), fmt(x0), fmt(y0)
        );
        let content_id = doc.add_object(Stream::new(dictionary! {}, ops.into_bytes()));

        // Our own annotation layer (emptied in the display copy, refilled on
        // save) stays so its metadata keeps pointing at a live stream.
        let mut contents = vec![Object::Reference(content_id)];
        if let Some(arr) = meta.stream_ids.get(&rp.page) {
            let sid = (arr[0], arr[1] as u16);
            if doc.get_object(sid).is_ok() {
                contents.push(Object::Reference(sid));
            }
        }

        let annots = doc
            .get_dictionary(page_id)
            .ok()
            .and_then(|d| d.get(b"Annots").ok().cloned());
        if let Some(annots) = annots {
            collect_widgets(doc, &annots, &mut dead_widgets);
        }

        let page = doc
            .get_object_mut(page_id)
            .and_then(Object::as_dict_mut)
            .map_err(|e| e.to_string())?;
        for key in DROPPED_PAGE_KEYS {
            page.remove(key);
        }
        page.set("Contents", Object::Array(contents));
        page.set(
            "Resources",
            dictionary! { "XObject" => dictionary! { IMAGE_NAME => img_id } },
        );
        page.set(
            "MediaBox",
            vec![x0.into(), y0.into(), x1.into(), y1.into()],
        );
    }

    remove_form_fields(doc, dead_widgets);
    drop_structure_tree(doc);
    doc.prune_objects();
    Ok(())
}

fn fmt(v: f64) -> String {
    let s = format!("{v:.4}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn collect_widgets(doc: &Document, annots: &Object, out: &mut HashSet<ObjectId>) {
    let arr = match annots {
        Object::Array(a) => a.clone(),
        Object::Reference(id) => match doc.get_object(*id) {
            Ok(Object::Array(a)) => a.clone(),
            _ => return,
        },
        _ => return,
    };
    for item in arr {
        let Ok(id) = item.as_reference() else { continue };
        let is_widget = doc
            .get_dictionary(id)
            .ok()
            .and_then(|d| d.get(b"Subtype").ok())
            .and_then(|s| s.as_name().ok())
            == Some(b"Widget".as_slice());
        if is_widget {
            out.insert(id);
        }
    }
}

/// Removes the form fields whose widgets sat on redacted pages: a field's
/// value (/V) lives in the field dictionary, so dropping only the widget
/// from the page would leave the text in the file.
fn remove_form_fields(doc: &mut Document, mut dead: HashSet<ObjectId>) {
    if dead.is_empty() {
        return;
    }
    // Strip dead refs from every /Kids array; a field left without kids is
    // dead too. Page-tree /Kids never reference widgets, so they are untouched.
    loop {
        let mut newly_dead = Vec::new();
        for (&id, obj) in doc.objects.iter_mut() {
            let Ok(dict) = obj.as_dict_mut() else { continue };
            let Ok(Object::Array(kids)) = dict.get_mut(b"Kids") else { continue };
            let before = kids.len();
            kids.retain(|k| k.as_reference().map_or(true, |r| !dead.contains(&r)));
            if kids.len() != before && kids.is_empty() && !dead.contains(&id) {
                newly_dead.push(id);
            }
        }
        if newly_dead.is_empty() {
            break;
        }
        dead.extend(newly_dead);
    }

    let Some(acroform) = acroform_id_or_catalog(doc) else { return };
    let fields_holder = match acroform {
        AcroForm::Indirect(id) => doc.get_object_mut(id).and_then(Object::as_dict_mut).ok(),
        AcroForm::InCatalog(cat) => doc
            .get_object_mut(cat)
            .and_then(Object::as_dict_mut)
            .ok()
            .and_then(|c| c.get_mut(b"AcroForm").ok())
            .and_then(|a| a.as_dict_mut().ok()),
    };
    if let Some(form) = fields_holder {
        if let Ok(Object::Array(fields)) = form.get_mut(b"Fields") {
            fields.retain(|f| f.as_reference().map_or(true, |r| !dead.contains(&r)));
        }
    }
}

enum AcroForm {
    Indirect(ObjectId),
    InCatalog(ObjectId),
}

fn catalog_id(doc: &Document) -> Option<ObjectId> {
    doc.trailer.get(b"Root").and_then(Object::as_reference).ok()
}

fn acroform_id_or_catalog(doc: &Document) -> Option<AcroForm> {
    let cat = catalog_id(doc)?;
    match doc.get_dictionary(cat).ok()?.get(b"AcroForm").ok()? {
        Object::Reference(id) => Some(AcroForm::Indirect(*id)),
        Object::Dictionary(_) => Some(AcroForm::InCatalog(cat)),
        _ => None,
    }
}

/// Tagged PDFs repeat page text in the structure tree (ActualText, Alt).
/// It cannot be kept consistent with rasterised pages, so it goes.
fn drop_structure_tree(doc: &mut Document) {
    let Some(cat) = catalog_id(doc) else { return };
    if let Ok(dict) = doc.get_object_mut(cat).and_then(Object::as_dict_mut) {
        dict.remove(b"StructTreeRoot");
        dict.remove(b"MarkInfo");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{fixture, tmp};

    fn tiny_jpeg(w: u32, h: u32) -> String {
        let img = image::RgbImage::from_pixel(w, h, image::Rgb([0, 0, 0]));
        let mut buf = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Jpeg)
            .unwrap();
        base64::engine::general_purpose::STANDARD.encode(buf)
    }

    fn page(n: u32) -> RedactedPage {
        RedactedPage {
            page: n,
            jpeg_base64: tiny_jpeg(8, 10),
            width_px: 8,
            height_px: 10,
            view: [0.0, 0.0, 612.0, 792.0],
        }
    }

    /// One page with "TOP SECRET" in its content and in a filled form field.
    fn secret_pdf() -> Document {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
        });
        let content_id = doc.add_object(Stream::new(
            dictionary! {},
            b"BT /F1 24 Tf 72 700 Td (TOP SECRET) Tj ET".to_vec(),
        ));
        let field_id = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Widget", "FT" => "Tx",
            "T" => Object::string_literal("name"),
            "V" => Object::string_literal("CLASSIFIED VALUE"),
            "Rect" => vec![72.into(), 600.into(), 300.into(), 620.into()],
        });
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Contents" => content_id,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font_id } },
            "Annots" => vec![field_id.into()],
        });
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1,
        }));
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog", "Pages" => pages_id,
            "AcroForm" => dictionary! { "Fields" => vec![field_id.into()] },
        });
        doc.trailer.set("Root", catalog_id);
        doc
    }

    #[test]
    fn removes_text_and_form_values_from_the_saved_bytes() {
        let mut doc = secret_pdf();
        redact_pages(&mut doc, &[page(1)]).unwrap();
        let out = tmp("redacted.pdf");
        doc.save(&out).unwrap();

        let bytes = std::fs::read(&out).unwrap();
        let has = |needle: &[u8]| bytes.windows(needle.len()).any(|w| w == needle);
        assert!(!has(b"SECRET"), "page text survived");
        assert!(!has(b"CLASSIFIED"), "form value survived");

        let reloaded = Document::load(&out).unwrap();
        assert_eq!(reloaded.get_pages().len(), 1);
        let pid = reloaded.get_pages()[&1];
        let res = reloaded.get_dictionary(pid).unwrap().get(b"Resources").unwrap();
        assert!(res.as_dict().unwrap().get(b"XObject").unwrap().as_dict().unwrap().has(IMAGE_NAME.as_bytes()));
        std::fs::remove_file(&out).ok();
    }

    #[test]
    fn leaves_other_pages_alone_on_object_stream_pdf() {
        let mut doc = Document::load(fixture("objstm-indirect-length.pdf")).unwrap();
        redact_pages(&mut doc, &[page(1)]).unwrap();
        let out = tmp("redacted-objstm.pdf");
        crate::fsutil::save_document(&mut doc, &out).unwrap();
        crate::test_util::assert_lengths_consistent(&out);

        let reloaded = Document::load(&out).unwrap();
        assert_eq!(reloaded.get_pages().len(), 2);
        assert!(!reloaded.extract_text(&[1]).unwrap_or_default().contains("Page 1"));
        assert!(reloaded.extract_text(&[2]).unwrap().contains("Page 2"));
        std::fs::remove_file(&out).ok();
    }

    #[test]
    fn rejects_unknown_page_and_bad_image() {
        let mut doc = secret_pdf();
        assert!(redact_pages(&mut doc, &[page(5)]).is_err());
        let mut bad = page(1);
        bad.width_px = 99;
        assert!(redact_pages(&mut doc, &[bad]).is_err());
    }
}
