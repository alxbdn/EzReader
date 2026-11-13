//! Straighten: a page photographed or scanned at an angle is replaced by a
//! straightened picture of itself (warped by pdf.js on the frontend), and
//! keeps what made it more than a picture:
//!
//! - its text, laid back on top as an invisible layer (render mode 3) at
//!   the place the warp moved each run of text to, so it can still be
//!   searched, selected and copied;
//! - its links, form fields and other annotations, moved by the same warp;
//! - the document's structure tree and form.
//!
//! Only the page's original content goes, like a redaction of the whole page.

use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use serde::Deserialize;

use crate::pdf::redact::{self, RedactedPage};
use crate::pdf::writer;

/// A run of text, as placed after straightening, in PDF user space.
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TextRun {
    pub text: String,
    /// Start of the baseline.
    pub x0: f64,
    pub y0: f64,
    /// End of the baseline.
    pub x1: f64,
    pub y1: f64,
    /// Height of the text (font size).
    pub size: f64,
}

/// One straightened page.
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StraightenedPage {
    #[serde(flatten)]
    pub picture: RedactedPage,
    /// Where the warp moves a point of the page: a 3×3 matrix (row by row,
    /// on column vectors [x, y, 1]) from old to new PDF user space.
    pub map: [f64; 9],
    pub text: Vec<TextRun>,
}

/// Name of the invisible text font in a straightened page's resources.
const FONT_NAME: &str = "EzText";
/// Width of every glyph of that font, in thousandths of the font size.
const GLYPH_WIDTH: f64 = 500.0;

/// Page entries that describe the old content and no longer apply.
const STALE_PAGE_KEYS: [&[u8]; 7] = [b"Thumb", b"PieceInfo", b"CropBox", b"BleedBox", b"TrimBox", b"ArtBox", b"Metadata"];

pub fn straighten_pages(doc: &mut Document, pages: &[StraightenedPage]) -> Result<(), String> {
    if pages.is_empty() {
        return Ok(());
    }
    let page_ids = doc.get_pages();
    let meta = writer::load_meta(doc);
    let font = add_text_font(doc);

    for sp in pages {
        let rp = &sp.picture;
        let page_id = *page_ids
            .get(&rp.page)
            .ok_or_else(|| format!("page {} not found in document", rp.page))?;

        let (img_id, mut ops) = redact::add_picture(doc, rp)?;
        ops.push_str(&text_ops(&sp.text));
        let content_id = doc.add_object(Stream::new(dictionary! {}, ops.into_bytes()));
        let contents = redact::with_annotation_layer(doc, &meta, rp.page, content_id);

        for annot in annotation_ids(doc, page_id) {
            move_annotation(doc, annot, &sp.map);
        }

        let page = doc.get_object_mut(page_id).and_then(Object::as_dict_mut).map_err(|e| e.to_string())?;
        for key in STALE_PAGE_KEYS {
            page.remove(key);
        }
        page.set("Contents", Object::Array(contents));
        page.set(
            "Resources",
            dictionary! {
                "XObject" => dictionary! { redact::PICTURE_NAME => img_id },
                "Font" => dictionary! { FONT_NAME => font },
            },
        );
        let [x0, y0, x1, y1] = rp.view;
        page.set("MediaBox", vec![x0.into(), y0.into(), x1.into(), y1.into()]);
    }

    doc.prune_objects();
    Ok(())
}

/// The invisible text: one `Tj` per run, stretched (`Tz`) to the run's length.
fn text_ops(runs: &[TextRun]) -> String {
    let mut ops = String::new();
    for run in runs {
        let units: Vec<u16> = run
            .text
            .chars()
            .map(|c| u16::try_from(u32::from(c)).ok().filter(|u| !(0xD800..0xE000).contains(u)).unwrap_or(0xFFFD))
            .collect();
        let (dx, dy) = (run.x1 - run.x0, run.y1 - run.y0);
        let length = dx.hypot(dy);
        if units.is_empty() || run.size <= 0.0 || length <= 0.0 || run.text.trim().is_empty() {
            continue;
        }
        let (cos, sin) = (dx / length, dy / length);
        let s = run.size;
        let natural = units.len() as f64 * GLYPH_WIDTH / 1000.0 * s;
        let hex: String = units.iter().map(|u| format!("{u:04X}")).collect();
        let f = redact::fmt;
        ops.push_str(&format!(
            "BT 3 Tr /{FONT_NAME} 1 Tf {} {} {} {} {} {} Tm {} Tz <{hex}> Tj ET\n",
            f(cos * s), f(sin * s), f(-sin * s), f(cos * s), f(run.x0), f(run.y0),
            f(100.0 * length / natural),
        ));
    }
    ops
}

/// A font with no glyph shapes whose codes are the text's UTF-16 units: an
/// invisible layer drawn with it can be searched, selected and copied
/// (the same trick OCR tools use).
fn add_text_font(doc: &mut Document) -> ObjectId {
    let mut cmap = String::from(
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n\
         /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n\
         /CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n\
         1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
    );
    // A bfrange may not cross a first-byte boundary: one per high byte.
    for chunk in (0u16..=0xFF).collect::<Vec<_>>().chunks(100) {
        cmap.push_str(&format!("{} beginbfrange\n", chunk.len()));
        for hi in chunk {
            cmap.push_str(&format!("<{hi:02X}00> <{hi:02X}FF> <{hi:02X}00>\n"));
        }
        cmap.push_str("endbfrange\n");
    }
    cmap.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    let to_unicode = doc.add_object(Stream::new(dictionary! {}, cmap.into_bytes()));

    let descriptor = doc.add_object(dictionary! {
        "Type" => "FontDescriptor",
        "FontName" => "GlyphLessFont",
        "Flags" => 5,
        "FontBBox" => vec![0.into(), 0.into(), (GLYPH_WIDTH as i64).into(), 1000.into()],
        "ItalicAngle" => 0,
        "Ascent" => 1000,
        "Descent" => 0,
        "CapHeight" => 1000,
        "StemV" => 80,
    });
    let cid_font = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "CIDFontType2",
        "BaseFont" => "GlyphLessFont",
        "CIDSystemInfo" => dictionary! {
            "Registry" => Object::string_literal("Adobe"),
            "Ordering" => Object::string_literal("Identity"),
            "Supplement" => 0,
        },
        "FontDescriptor" => descriptor,
        "DW" => GLYPH_WIDTH as i64,
        "CIDToGIDMap" => "Identity",
    });
    doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type0",
        "BaseFont" => "GlyphLessFont",
        "Encoding" => "Identity-H",
        "DescendantFonts" => vec![cid_font.into()],
        "ToUnicode" => to_unicode,
    })
}

fn annotation_ids(doc: &Document, page_id: ObjectId) -> Vec<ObjectId> {
    let Ok(page) = doc.get_dictionary(page_id) else { return Vec::new() };
    let list = match page.get(b"Annots") {
        Ok(Object::Array(a)) => a.clone(),
        Ok(Object::Reference(id)) => doc.get_object(*id).and_then(Object::as_array).cloned().unwrap_or_default(),
        _ => Vec::new(),
    };
    list.iter().filter_map(|o| o.as_reference().ok()).collect()
}

fn apply(m: &[f64; 9], x: f64, y: f64) -> (f64, f64) {
    let w = m[6] * x + m[7] * y + m[8];
    ((m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w)
}

/// Moves an annotation with the warp: its `/Rect` becomes the box around its
/// moved corners, and `/QuadPoints` (highlights, links) move point by point.
fn move_annotation(doc: &mut Document, id: ObjectId, map: &[f64; 9]) {
    let Ok(annot) = doc.get_object_mut(id).and_then(Object::as_dict_mut) else { return };
    let nums = |o: &Object| -> Option<Vec<f64>> {
        o.as_array().ok()?.iter().map(|v| v.as_float().ok().map(f64::from)).collect()
    };
    if let Some(r) = annot.get(b"Rect").ok().and_then(nums).filter(|r| r.len() == 4) {
        let pts = [(r[0], r[1]), (r[2], r[1]), (r[2], r[3]), (r[0], r[3])].map(|(x, y)| apply(map, x, y));
        let xs = pts.map(|p| p.0);
        let ys = pts.map(|p| p.1);
        let lo = |v: [f64; 4]| v.into_iter().fold(f64::MAX, f64::min);
        let hi = |v: [f64; 4]| v.into_iter().fold(f64::MIN, f64::max);
        annot.set("Rect", vec![real(lo(xs)), real(lo(ys)), real(hi(xs)), real(hi(ys))]);
    }
    if let Some(q) = annot.get(b"QuadPoints").ok().and_then(nums).filter(|q| q.len() % 2 == 0) {
        let moved: Vec<Object> = q
            .chunks(2)
            .flat_map(|p| {
                let (x, y) = apply(map, p[0], p[1]);
                [real(x), real(y)]
            })
            .collect();
        annot.set("QuadPoints", moved);
    }
}

fn real(v: f64) -> Object {
    Object::Real(v as f32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    /// A page with text, a link and a form field, in a document with a
    /// structure tree.
    fn page_with_extras() -> Document {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let page_id = doc.new_object_id();
        let link = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Link",
            "Rect" => vec![100.into(), 100.into(), 200.into(), 120.into()],
            "QuadPoints" => vec![100.into(), 120.into(), 200.into(), 120.into(), 100.into(), 100.into(), 200.into(), 100.into()],
        });
        let field = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Widget", "FT" => "Tx", "T" => Object::string_literal("name"),
            "Rect" => vec![50.into(), 50.into(), 150.into(), 70.into()],
        });
        let content = doc.add_object(Stream::new(dictionary! {}, b"BT /F1 12 Tf 72 720 Td (Secret original) Tj ET".to_vec()));
        doc.objects.insert(page_id, Object::Dictionary(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 300.into(), 400.into()],
            "Contents" => content, "Annots" => vec![link.into(), field.into()], "StructParents" => 0,
        }));
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1 }));
        let tree = doc.add_object(dictionary! { "Type" => "StructTreeRoot" });
        let catalog = doc.add_object(dictionary! {
            "Type" => "Catalog", "Pages" => pages_id, "StructTreeRoot" => tree,
            "AcroForm" => dictionary! { "Fields" => vec![field.into()] },
        });
        doc.trailer.set("Root", catalog);
        doc
    }

    fn picture(page: u32, view: [f64; 4]) -> RedactedPage {
        let img = image::RgbImage::from_pixel(30, 40, image::Rgb([250, 250, 250]));
        let mut jpeg = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut jpeg), image::ImageFormat::Jpeg)
            .unwrap();
        RedactedPage {
            page,
            jpeg_base64: base64::engine::general_purpose::STANDARD.encode(jpeg),
            width_px: 30,
            height_px: 40,
            view,
        }
    }

    #[test]
    fn text_stays_findable_and_annotations_move_with_the_page() {
        let mut doc = page_with_extras();
        // The warp here doubles x and y.
        let map = [2.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 1.0];
        let text = vec![TextRun { text: "Hello world".into(), x0: 72.0, y0: 700.0, x1: 160.0, y1: 700.0, size: 12.0 }];
        straighten_pages(&mut doc, &[StraightenedPage { picture: picture(1, [0.0, 0.0, 300.0, 400.0]), map, text }]).unwrap();
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        let doc = Document::load_mem(&bytes).unwrap();

        assert_eq!(doc.extract_text(&[1]).unwrap().trim(), "Hello world", "the text layer reads back");
        let raw = String::from_utf8_lossy(&bytes);
        assert!(!raw.contains("Secret original"), "the original content is gone");

        let page = doc.get_dictionary(doc.get_pages()[&1]).unwrap();
        let annots = page.get(b"Annots").unwrap().as_array().unwrap();
        assert_eq!(annots.len(), 2, "link and field stay");
        let link = doc.get_dictionary(annots[0].as_reference().unwrap()).unwrap();
        let rect: Vec<f32> = link.get(b"Rect").unwrap().as_array().unwrap().iter().map(|o| o.as_float().unwrap()).collect();
        assert_eq!(rect, vec![200.0, 200.0, 400.0, 240.0]);
        let quads: Vec<f32> = link.get(b"QuadPoints").unwrap().as_array().unwrap().iter().map(|o| o.as_float().unwrap()).collect();
        assert_eq!(quads[..2], [200.0, 240.0]);

        let catalog = doc.catalog().unwrap();
        assert!(catalog.has(b"StructTreeRoot"), "the structure tree stays");
        assert!(catalog.has(b"AcroForm"), "the form stays");
        assert!(page.has(b"StructParents"));
    }

    #[test]
    fn text_runs_are_rotated_and_stretched_to_fit() {
        let ops = text_ops(&[TextRun { text: "ab".into(), x0: 10.0, y0: 20.0, x1: 10.0, y1: 32.0, size: 6.0 }]);
        // Going up: rotated 90°; 2 glyphs of 0.5 em at 6 pt = 6 pt natural, 12 pt wanted.
        assert_eq!(ops, "BT 3 Tr /EzText 1 Tf 0 6 -6 0 10 20 Tm 200 Tz <00610062> Tj ET\n");
        assert_eq!(text_ops(&[TextRun { text: "  ".into(), x0: 0.0, y0: 0.0, x1: 5.0, y1: 0.0, size: 6.0 }]), "");
    }
}
