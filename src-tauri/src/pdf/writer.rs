use std::collections::HashMap;

use base64::Engine;
use image::ImageReader;
use lopdf::{dictionary, Document, Object, ObjectId, Stream, StringFormat};

use super::models::{
    Annotation, CircleAnnotation, FontFamily, HighlightAnnotation, InkAnnotation, NoteAnnotation,
    RectAnnotation, RgbColor, SignatureAnnotation, TextAlignment, TextAnnotation,
};

// ── Annotation metadata (JSON + stream-ID tracking) ──────────────────────────

use serde::{Deserialize, Serialize};

/// Stored in the PDF catalog under `CCAnnot`.
/// Holds the editable annotation data AND the object IDs of the burned content
/// streams so they can be updated in-place on re-save (preventing accumulation).
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct AnnotationMeta {
    pub annotations: Vec<Annotation>,
    /// Per-page annotation stream object IDs: page_num → [object_id, generation].
    pub stream_ids: HashMap<u32, [u32; 2]>,
}

/// Decode a PDF text string (bytes from a /T, /V, etc. entry) into a Rust String.
/// Handles UTF-16BE (BOM 0xFE 0xFF prefix) and PDFDocEncoding (Latin-1-like fallback).
fn pdf_text_to_string(bytes: &[u8]) -> Option<String> {
    if bytes.starts_with(&[0xFE, 0xFF]) {
        // UTF-16BE with BOM
        let u16s: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16(&u16s).ok()
    } else {
        // Try UTF-8 first; fall back to PDFDocEncoding (≈ Latin-1 for 0x80..0xFF)
        String::from_utf8(bytes.to_vec()).ok().or_else(|| {
            Some(bytes.iter().map(|&b| b as char).collect())
        })
    }
}

fn catalog_id(doc: &Document) -> Result<ObjectId, String> {
    doc.trailer
        .get(b"Root")
        .map_err(|_| "No Root in trailer".to_string())?
        .as_reference()
        .map_err(|_| "Root is not a reference".to_string())
}

/// Read annotation metadata from the `CCAnnot` catalog entry.
/// Returns a default (empty) meta if the entry is absent or unreadable.
pub fn load_meta(doc: &Document) -> AnnotationMeta {
    let Ok(cat_id) = catalog_id(doc) else { return AnnotationMeta::default() };
    let Ok(cat)    = doc.get_object(cat_id) else { return AnnotationMeta::default() };
    let Ok(dict)   = cat.as_dict() else { return AnnotationMeta::default() };

    let Ok(Object::Reference(meta_ref)) = dict.get(b"CCAnnot") else {
        return AnnotationMeta::default();
    };
    let Ok(obj) = doc.get_object(*meta_ref) else { return AnnotationMeta::default() };
    let Object::Stream(stream) = obj else { return AnnotationMeta::default() };
    let Ok(json) = String::from_utf8(stream.content.clone()) else {
        return AnnotationMeta::default();
    };
    serde_json::from_str(&json).unwrap_or_default()
}

/// Serialize `meta` and store it in the PDF catalog under `CCAnnot`.
pub fn save_meta(doc: &mut Document, meta: &AnnotationMeta) -> Result<(), String> {
    let json      = serde_json::to_string(meta).map_err(|e| e.to_string())?;
    let stream    = Stream::new(dictionary! {}, json.into_bytes());
    let stream_id = doc.add_object(Object::Stream(stream));

    let cat_id  = catalog_id(doc)?;
    let catalog = doc.get_object_mut(cat_id).map_err(|e| e.to_string())?;
    if let Object::Dictionary(d) = catalog {
        d.set("CCAnnot", Object::Reference(stream_id));
    }
    Ok(())
}

// ── PDF operator builders ─────────────────────────────────────────────────────

/// Transparency an annotation needs: an ExtGState resource on its page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Alpha {
    /// Opacity in percent (0–100).
    pct: u32,
    /// Multiply blending, so highlighted text stays readable.
    multiply: bool,
}

impl Alpha {
    pub fn name(&self) -> String {
        format!("EzA{}{}", self.pct, if self.multiply { "M" } else { "" })
    }
}

/// `None` when the drawing is opaque and plainly painted.
fn alpha(opacity: Option<f64>, multiply: bool) -> Option<Alpha> {
    let o = opacity.unwrap_or(1.0);
    let o = if o.is_finite() { o.clamp(0.0, 1.0) } else { 1.0 };
    let pct = (o * 100.0).round() as u32;
    if pct >= 100 && !multiply { None } else { Some(Alpha { pct, multiply }) }
}

fn gs_op(a: Option<Alpha>) -> String {
    a.map(|a| format!("/{} gs\n", a.name())).unwrap_or_default()
}

fn rgb_fill(c: &RgbColor) -> String {
    format!("{:.4} {:.4} {:.4} rg\n", c.r_f(), c.g_f(), c.b_f())
}

fn rgb_stroke(c: &RgbColor) -> String {
    format!("{:.4} {:.4} {:.4} RG\n", c.r_f(), c.g_f(), c.b_f())
}

/// Fill colour operator and the path-painting operator for a shape:
/// `B` fill + outline, `f` fill only, `S` outline only, `n` nothing.
fn shape_paint(fill: Option<&RgbColor>, stroke_width: f64) -> (String, &'static str) {
    let fill_op = fill
        .map(|c| format!("{:.4} {:.4} {:.4} rg\n", c.r_f(), c.g_f(), c.b_f()))
        .unwrap_or_default();
    let paint = match (fill.is_some(), stroke_width > 0.0) {
        (true, true) => "B",
        (true, false) => "f",
        (false, true) => "S",
        (false, false) => "n",
    };
    (fill_op, paint)
}

/// Append rect operators (outline and optional fill) to `buf`.
/// Returns the transparency to register, if any.
pub fn write_rect(buf: &mut Vec<u8>, ann: &RectAnnotation) -> Option<Alpha> {
    let (fill_op, paint) = shape_paint(ann.fill_color.as_ref(), ann.stroke_width);
    let a = alpha(ann.opacity, false);
    let ops = format!(
        "q\n{}{}{:.4} {:.4} {:.4} RG\n{:.4} w\n{:.4} {:.4} {:.4} {:.4} re\n{}\nQ\n",
        gs_op(a),
        fill_op,
        ann.color.r_f(),
        ann.color.g_f(),
        ann.color.b_f(),
        ann.stroke_width,
        ann.x,
        ann.y,
        ann.width,
        ann.height,
        paint,
    );
    buf.extend_from_slice(ops.as_bytes());
    a
}

/// Append ellipse operators (4-arc Bézier, outline and optional fill) to `buf`.
/// Returns the transparency to register, if any.
pub fn write_circle(buf: &mut Vec<u8>, ann: &CircleAnnotation) -> Option<Alpha> {
    let (fill_op, paint) = shape_paint(ann.fill_color.as_ref(), ann.stroke_width);
    let a = alpha(ann.opacity, false);
    // Bézier approximation constant κ ≈ 0.5523
    const K: f64 = 0.5523;
    let cx = ann.x + ann.width / 2.0;
    let cy = ann.y + ann.height / 2.0;
    let rx = ann.width / 2.0;
    let ry = ann.height / 2.0;

    let ops = format!(
        concat!(
            "q\n",
            "{}{}",
            "{:.4} {:.4} {:.4} RG\n",
            "{:.4} w\n",
            // Move to top centre
            "{:.4} {:.4} m\n",
            // Arc 1: top → right
            "{:.4} {:.4} {:.4} {:.4} {:.4} {:.4} c\n",
            // Arc 2: right → bottom
            "{:.4} {:.4} {:.4} {:.4} {:.4} {:.4} c\n",
            // Arc 3: bottom → left
            "{:.4} {:.4} {:.4} {:.4} {:.4} {:.4} c\n",
            // Arc 4: left → top
            "{:.4} {:.4} {:.4} {:.4} {:.4} {:.4} c\n",
            "{}\nQ\n"
        ),
        gs_op(a),
        fill_op,
        ann.color.r_f(), ann.color.g_f(), ann.color.b_f(),
        ann.stroke_width,
        // Move to top
        cx, cy + ry,
        // Arc 1
        cx + K * rx, cy + ry,   cx + rx, cy + K * ry,   cx + rx, cy,
        // Arc 2
        cx + rx, cy - K * ry,   cx + K * rx, cy - ry,   cx, cy - ry,
        // Arc 3
        cx - K * rx, cy - ry,   cx - rx, cy - K * ry,   cx - rx, cy,
        // Arc 4
        cx - rx, cy + K * ry,   cx - K * rx, cy + ry,   cx, cy + ry,
        paint,
    );
    buf.extend_from_slice(ops.as_bytes());
    a
}

/// Append a pencil stroke, straight line or arrow to `buf`.
/// Returns the transparency to register, if any.
pub fn write_ink(buf: &mut Vec<u8>, ann: &InkAnnotation) -> Option<Alpha> {
    let mut pts: Vec<(f64, f64)> = ann
        .points
        .iter()
        .filter(|p| p[0].is_finite() && p[1].is_finite())
        .map(|p| (ann.x + p[0] * ann.width, ann.y + p[1] * ann.height))
        .collect();
    if pts.len() < 2 {
        return None;
    }
    let a = alpha(ann.opacity, false);
    let mut ops = format!(
        "q\n{}{}{:.4} w\n1 J\n1 j\n",
        gs_op(a),
        rgb_stroke(&ann.color),
        ann.stroke_width,
    );

    // Arrowhead at the last point; the shaft stops at its base.
    let mut head = String::new();
    if ann.arrow {
        let (tx, ty) = pts[pts.len() - 1];
        let (px, py) = pts[pts.len() - 2];
        let (dx, dy) = (tx - px, ty - py);
        let len = (dx * dx + dy * dy).sqrt();
        if len > 0.0 {
            let (ux, uy) = (dx / len, dy / len);
            let l = (ann.stroke_width * 3.5).max(6.0).min(len);
            let hw = l * 0.55;
            let (bx, by) = (tx - ux * l, ty - uy * l);
            head = format!(
                "{}{:.4} {:.4} m\n{:.4} {:.4} l\n{:.4} {:.4} l\nh\nf\n",
                rgb_fill(&ann.color),
                tx, ty,
                bx - uy * hw, by + ux * hw,
                bx + uy * hw, by - ux * hw,
            );
            let last = pts.len() - 1;
            pts[last] = (tx - ux * l * 0.8, ty - uy * l * 0.8);
        }
    }

    let fill = if ann.arrow { None } else { ann.fill_color.as_ref() };
    if let Some(f) = fill {
        ops.push_str(&rgb_fill(f));
    }
    ops.push_str(&format!("{:.4} {:.4} m\n", pts[0].0, pts[0].1));
    for (x, y) in &pts[1..] {
        ops.push_str(&format!("{:.4} {:.4} l\n", x, y));
    }
    ops.push_str(match (fill.is_some(), ann.stroke_width > 0.0) {
        (true, true) => "h\nB\n",
        (true, false) => "h\nf\n",
        (false, true) => "S\n",
        (false, false) => "n\n",
    });
    ops.push_str(&head);
    ops.push_str("Q\n");
    buf.extend_from_slice(ops.as_bytes());
    a
}

/// Append highlighted-text rectangles (multiplied, so the text shows through).
pub fn write_highlight(buf: &mut Vec<u8>, ann: &HighlightAnnotation) -> Option<Alpha> {
    if ann.rects.is_empty() {
        return None;
    }
    let a = alpha(Some(ann.opacity), true);
    let mut ops = format!("q\n{}{}", gs_op(a), rgb_fill(&ann.color));
    for r in &ann.rects {
        ops.push_str(&format!("{:.4} {:.4} {:.4} {:.4} re\n", r.x, r.y, r.width, r.height));
    }
    ops.push_str("f\nQ\n");
    buf.extend_from_slice(ops.as_bytes());
    a
}

/// Font size of sticky-note text, in points.
const NOTE_FONT_SIZE: f64 = 10.0;
const NOTE_PADDING: f64 = 6.0;

/// Append a sticky note: a coloured square with its text, clipped to the square.
/// Returns the font to register.
pub fn write_note(buf: &mut Vec<u8>, ann: &NoteAnnotation) -> (&'static str, &'static str) {
    let border = RgbColor {
        r: (ann.color.r as f64 * 0.8) as u8,
        g: (ann.color.g as f64 * 0.8) as u8,
        b: (ann.color.b as f64 * 0.8) as u8,
    };
    let ops = format!(
        "q\n{}{}0.75 w\n{:.4} {:.4} {:.4} {:.4} re\nB\n{:.4} {:.4} {:.4} {:.4} re\nW\nn\n",
        rgb_fill(&ann.color),
        rgb_stroke(&border),
        ann.x, ann.y, ann.width, ann.height,
        ann.x, ann.y, ann.width, ann.height,
    );
    buf.extend_from_slice(ops.as_bytes());
    let text = TextAnnotation {
        page: ann.page,
        x: ann.x + NOTE_PADDING,
        y: ann.y + ann.height - NOTE_PADDING - NOTE_FONT_SIZE,
        width: (ann.width - 2.0 * NOTE_PADDING).max(1.0),
        content: ann.content.clone(),
        color: RgbColor { r: 38, g: 38, b: 38 },
        font_size: NOTE_FONT_SIZE,
        bold: false,
        italic: false,
        underline: false,
        alignment: TextAlignment::Left,
        font_family: FontFamily::Helvetica,
        background_color: None,
    };
    let font = write_text(buf, &text);
    buf.extend_from_slice(b"Q\n");
    font
}

/// Select the PDF standard Type1 font name for the given style flags.
fn font_name(family: FontFamily, bold: bool, italic: bool) -> &'static str {
    match (family, bold, italic) {
        (FontFamily::Helvetica, true, true) => "Helvetica-BoldOblique",
        (FontFamily::Helvetica, true, false) => "Helvetica-Bold",
        (FontFamily::Helvetica, false, true) => "Helvetica-Oblique",
        (FontFamily::Helvetica, false, false) => "Helvetica",
        (FontFamily::Times, true, true) => "Times-BoldItalic",
        (FontFamily::Times, true, false) => "Times-Bold",
        (FontFamily::Times, false, true) => "Times-Italic",
        (FontFamily::Times, false, false) => "Times-Roman",
        (FontFamily::Courier, true, true) => "Courier-BoldOblique",
        (FontFamily::Courier, true, false) => "Courier-Bold",
        (FontFamily::Courier, false, true) => "Courier-Oblique",
        (FontFamily::Courier, false, false) => "Courier",
    }
}

/// Short resource key for a font name (no hyphens, fits in name dict).
fn font_key(family: FontFamily, bold: bool, italic: bool) -> &'static str {
    match (family, bold, italic) {
        (FontFamily::Helvetica, true, true) => "HelvBO",
        (FontFamily::Helvetica, true, false) => "HelvB",
        (FontFamily::Helvetica, false, true) => "HelvO",
        (FontFamily::Helvetica, false, false) => "Helv",
        (FontFamily::Times, true, true) => "TimesBI",
        (FontFamily::Times, true, false) => "TimesB",
        (FontFamily::Times, false, true) => "TimesI",
        (FontFamily::Times, false, false) => "TimesR",
        (FontFamily::Courier, true, true) => "CourBO",
        (FontFamily::Courier, true, false) => "CourB",
        (FontFamily::Courier, false, true) => "CourO",
        (FontFamily::Courier, false, false) => "Cour",
    }
}

/// Average glyph width as a fraction of the font size, for wrapping and alignment.
fn avg_char_width(family: FontFamily) -> f64 {
    match family {
        FontFamily::Helvetica => 0.5,
        FontFamily::Times => 0.45,
        FontFamily::Courier => 0.6,
    }
}

/// Escape a string for use inside PDF literal string parentheses.
fn pdf_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '(' => out.push_str("\\("),
            ')' => out.push_str("\\)"),
            '\\' => out.push_str("\\\\"),
            c => out.push(c),
        }
    }
    out
}

/// Split `text` on explicit `\n` then word-wrap each paragraph to `max_width`,
/// using `char_w` as the average character width estimate.
fn wrap_text(text: &str, max_width: f64, char_w: f64) -> Vec<String> {
    let mut result = Vec::new();
    for para in text.split('\n') {
        if para.is_empty() {
            result.push(String::new());
            continue;
        }
        let mut line = String::new();
        let mut line_w = 0.0_f64;
        for word in para.split(' ') {
            let word_w = word.len() as f64 * char_w;
            // Width if we append this word (with a leading space if line is non-empty)
            let candidate_w = if line.is_empty() { word_w } else { line_w + char_w + word_w };
            if !line.is_empty() && candidate_w > max_width {
                result.push(line.clone());
                line = word.to_string();
                line_w = word_w;
            } else {
                if !line.is_empty() { line.push(' '); line_w += char_w; }
                line.push_str(word);
                line_w += word_w;
            }
        }
        result.push(line);
    }
    result
}

/// Append text operators to `buf`.
/// Returns the resource key and base font name so the caller can register it.
pub fn write_text(buf: &mut Vec<u8>, ann: &TextAnnotation) -> (&'static str, &'static str) {
    let fkey  = font_key(ann.font_family, ann.bold, ann.italic);
    let fname = font_name(ann.font_family, ann.bold, ann.italic);
    let char_w  = ann.font_size * avg_char_width(ann.font_family);
    let line_h  = ann.font_size * 1.2;
    let lines   = wrap_text(&ann.content, ann.width, char_w);

    let mut ops = String::from("q\n");
    if let Some(bg) = &ann.background_color {
        // Box behind all lines, from the first line's ascent to the last one's descent.
        let n = lines.len().max(1) as f64;
        let bottom = ann.y - (n - 1.0) * line_h - ann.font_size * 0.3 - 2.0;
        let height = (n - 1.0) * line_h + ann.font_size * 1.25 + 4.0;
        ops.push_str(&format!(
            "{}{:.4} {:.4} {:.4} {:.4} re\nf\n",
            rgb_fill(bg),
            ann.x - 3.0, bottom, ann.width + 6.0, height,
        ));
    }
    ops.push_str(&format!(
        "{:.4} {:.4} {:.4} rg\nBT\n/{} {:.4} Tf\n",
        ann.color.r_f(), ann.color.g_f(), ann.color.b_f(),
        fkey, ann.font_size,
    ));

    // Collect underline segments to draw after ET (outside text object)
    let mut underlines: Vec<(f64, f64, f64)> = Vec::new();

    for (i, line) in lines.iter().enumerate() {
        let line_w = line.len() as f64 * char_w;
        let x_off = match ann.alignment {
            TextAlignment::Left   => 0.0,
            TextAlignment::Center => ((ann.width - line_w) / 2.0).max(0.0),
            TextAlignment::Right  => (ann.width - line_w).max(0.0),
        };
        let x = ann.x + x_off;
        let y = ann.y - i as f64 * line_h;

        // 1 0 0 1 x y Tm = absolute text position
        ops.push_str(&format!("1 0 0 1 {:.4} {:.4} Tm\n({}) Tj\n", x, y, pdf_escape(line)));

        if ann.underline {
            underlines.push((x, y - ann.font_size * 0.12, line_w.min(ann.width)));
        }
    }

    ops.push_str("ET\n");

    if !underlines.is_empty() {
        ops.push_str(&format!(
            "{:.4} {:.4} {:.4} RG\n{:.4} w\n",
            ann.color.r_f(), ann.color.g_f(), ann.color.b_f(),
            ann.font_size * 0.05,
        ));
        for (x, ul_y, ul_len) in underlines {
            ops.push_str(&format!("{:.4} {:.4} m\n{:.4} {:.4} l\nS\n", x, ul_y, x + ul_len, ul_y));
        }
    }

    ops.push_str("Q\n");
    buf.extend_from_slice(ops.as_bytes());
    (fkey, fname)
}

/// Decode base64 PNG, embed as an image XObject with SMask for transparency,
/// append `Do` operators to `buf`.
/// Returns `(xobj_name, xobj_id, smask_id)` so the caller can add page resources.
pub fn write_image(
    buf: &mut Vec<u8>,
    ann: &SignatureAnnotation,
    doc: &mut Document,
) -> Result<(String, ObjectId, Option<ObjectId>), String> {
    // Decode base64 (strip data URI prefix if present)
    let b64 = ann
        .image_data
        .splitn(2, ',')
        .last()
        .unwrap_or(&ann.image_data);
    let png_bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 decode error: {e}"))?;

    // Decode image → RGBA
    let img = ImageReader::new(std::io::Cursor::new(&png_bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?
        .to_rgba8();

    let (w, h) = img.dimensions();
    let mut rgb_data: Vec<u8> = Vec::with_capacity((w * h * 3) as usize);
    let mut alpha_data: Vec<u8> = Vec::with_capacity((w * h) as usize);

    for pixel in img.pixels() {
        rgb_data.push(pixel[0]);
        rgb_data.push(pixel[1]);
        rgb_data.push(pixel[2]);
        alpha_data.push(pixel[3]);
    }

    // Create SMask (alpha channel XObject)
    let smask_stream = Stream::new(
        dictionary! {
            "Type" => Object::Name(b"XObject".to_vec()),
            "Subtype" => Object::Name(b"Image".to_vec()),
            "Width" => Object::Integer(w as i64),
            "Height" => Object::Integer(h as i64),
            "ColorSpace" => Object::Name(b"DeviceGray".to_vec()),
            "BitsPerComponent" => Object::Integer(8),
        },
        alpha_data,
    );
    let smask_id = doc.add_object(Object::Stream(smask_stream));

    // Create main Image XObject
    let img_stream = Stream::new(
        dictionary! {
            "Type" => Object::Name(b"XObject".to_vec()),
            "Subtype" => Object::Name(b"Image".to_vec()),
            "Width" => Object::Integer(w as i64),
            "Height" => Object::Integer(h as i64),
            "ColorSpace" => Object::Name(b"DeviceRGB".to_vec()),
            "BitsPerComponent" => Object::Integer(8),
            "SMask" => Object::Reference(smask_id),
        },
        rgb_data,
    );
    let img_id = doc.add_object(Object::Stream(img_stream));

    // A unique resource name for this image
    static IMG_COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = IMG_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let xobj_name = format!("Sig{n}");

    // Build transformation matrix: scale to (width, height), translate to (x, y)
    let ops = format!(
        "q\n{:.4} 0 0 {:.4} {:.4} {:.4} cm\n/{} Do\nQ\n",
        ann.width, ann.height, ann.x, ann.y, xobj_name,
    );
    buf.extend_from_slice(ops.as_bytes());

    Ok((xobj_name, img_id, Some(smask_id)))
}

// ── Resource helpers ──────────────────────────────────────────────────────────

/// Add a standard Type1 font resource to a page (or its Resources dict).
/// `fkey` is the resource alias (e.g. "Helv"), `base_font` is the PDF font name.
fn add_font_to_page(
    doc: &mut Document,
    page_id: ObjectId,
    fkey: &str,
    base_font: &str,
) -> Result<(), String> {
    // Build a minimal font dict object
    let font_obj = dictionary! {
        "Type" => Object::Name(b"Font".to_vec()),
        "Subtype" => Object::Name(b"Type1".to_vec()),
        "BaseFont" => Object::Name(base_font.as_bytes().to_vec()),
    };
    let font_id = doc.add_object(Object::Dictionary(font_obj));

    // Mutably access the page dict
    let page = doc
        .get_object_mut(page_id)
        .map_err(|e| e.to_string())?;
    let page_dict = match page {
        Object::Dictionary(d) => d,
        _ => return Err("page is not a dictionary".into()),
    };

    // Ensure Resources entry exists as an inline dict
    if !page_dict.has(b"Resources") {
        page_dict.set("Resources", Object::Dictionary(lopdf::Dictionary::new()));
    }

    // Navigate into Resources.Font
    let resources = page_dict
        .get_mut(b"Resources")
        .map_err(|e| e.to_string())?;
    let res_dict = match resources {
        Object::Dictionary(d) => d,
        _ => return Err("Resources is not an inline dict (inherited); cannot modify".into()),
    };

    if !res_dict.has(b"Font") {
        res_dict.set("Font", Object::Dictionary(lopdf::Dictionary::new()));
    }

    let font_dict = res_dict
        .get_mut(b"Font")
        .map_err(|e| e.to_string())?;
    if let Object::Dictionary(d) = font_dict {
        d.set(fkey.as_bytes().to_vec(), Object::Reference(font_id));
    }

    Ok(())
}

/// Add an image XObject reference to the page's Resources.XObject dict.
fn add_xobject_to_page(
    doc: &mut Document,
    page_id: ObjectId,
    name: &str,
    xobj_id: ObjectId,
) -> Result<(), String> {
    let page = doc
        .get_object_mut(page_id)
        .map_err(|e| e.to_string())?;
    let page_dict = match page {
        Object::Dictionary(d) => d,
        _ => return Err("page is not a dictionary".into()),
    };

    if !page_dict.has(b"Resources") {
        page_dict.set("Resources", Object::Dictionary(lopdf::Dictionary::new()));
    }

    let resources = page_dict
        .get_mut(b"Resources")
        .map_err(|e| e.to_string())?;
    let res_dict = match resources {
        Object::Dictionary(d) => d,
        _ => return Err("Resources is not an inline dict".into()),
    };

    if !res_dict.has(b"XObject") {
        res_dict.set("XObject", Object::Dictionary(lopdf::Dictionary::new()));
    }

    let xobj_dict = res_dict
        .get_mut(b"XObject")
        .map_err(|e| e.to_string())?;
    if let Object::Dictionary(d) = xobj_dict {
        d.set(name.as_bytes().to_vec(), Object::Reference(xobj_id));
    }

    Ok(())
}

/// Add a transparency graphics state to the page's Resources.ExtGState dict.
fn add_extgstate_to_page(doc: &mut Document, page_id: ObjectId, a: Alpha) -> Result<(), String> {
    let o = a.pct as f32 / 100.0;
    let mut gs = dictionary! {
        "Type" => Object::Name(b"ExtGState".to_vec()),
        "CA" => Object::Real(o),
        "ca" => Object::Real(o),
    };
    if a.multiply {
        gs.set("BM", Object::Name(b"Multiply".to_vec()));
    }
    let gs_id = doc.add_object(Object::Dictionary(gs));

    let page = doc.get_object_mut(page_id).map_err(|e| e.to_string())?;
    let page_dict = match page {
        Object::Dictionary(d) => d,
        _ => return Err("page is not a dictionary".into()),
    };
    if !page_dict.has(b"Resources") {
        page_dict.set("Resources", Object::Dictionary(lopdf::Dictionary::new()));
    }
    let res_dict = match page_dict.get_mut(b"Resources").map_err(|e| e.to_string())? {
        Object::Dictionary(d) => d,
        _ => return Err("Resources is not an inline dict".into()),
    };
    if !res_dict.has(b"ExtGState") {
        res_dict.set("ExtGState", Object::Dictionary(lopdf::Dictionary::new()));
    }
    if let Object::Dictionary(d) = res_dict.get_mut(b"ExtGState").map_err(|e| e.to_string())? {
        d.set(a.name().into_bytes(), Object::Reference(gs_id));
    }
    Ok(())
}

/// Append `new_ops` as an additional content stream to the page.
/// Returns the `ObjectId` of the newly created stream.
fn append_content_stream(
    doc: &mut Document,
    page_id: ObjectId,
    new_ops: Vec<u8>,
) -> Result<ObjectId, String> {
    let new_stream = Stream::new(dictionary! {}, new_ops);
    let new_id = doc.add_object(Object::Stream(new_stream));

    // Read the current Contents value (clone to avoid borrow conflict)
    let existing: Vec<Object> = {
        let page = doc.get_object(page_id).map_err(|e| e.to_string())?;
        let dict = page.as_dict().map_err(|e| e.to_string())?;
        match dict.get(b"Contents") {
            Ok(Object::Reference(id)) => vec![Object::Reference(*id)],
            Ok(Object::Array(arr)) => arr.clone(),
            _ => vec![],
        }
    };

    let mut refs = existing;
    refs.push(Object::Reference(new_id));

    let page = doc
        .get_object_mut(page_id)
        .map_err(|e| e.to_string())?;
    if let Object::Dictionary(d) = page {
        d.set("Contents", Object::Array(refs));
    }

    Ok(new_id)
}

// ── Public entry point ────────────────────────────────────────────────────────

/// Write all annotations for a single page into the document.
///
/// If `existing_stream_id` is `Some`, the operators are written into that
/// existing stream object in-place (prevents cumulative burn layers on re-save).
/// Otherwise a new content stream is appended.
///
/// Returns the `ObjectId` of the stream that was written, or `None` if there
/// were no annotations and no existing stream to clear.
pub fn write_annotations_for_page(
    doc: &mut Document,
    page_id: ObjectId,
    annotations: &[Annotation],
    existing_stream_id: Option<ObjectId>,
) -> Result<Option<ObjectId>, String> {
    let mut ops: Vec<u8> = Vec::new();
    let mut fonts_needed: HashMap<&'static str, &'static str> = HashMap::new();
    let mut xobjects: Vec<(String, ObjectId)> = Vec::new();
    let mut alphas: Vec<Alpha> = Vec::new();

    for ann in annotations {
        let a = match ann {
            Annotation::Rect(r) => write_rect(&mut ops, r),
            Annotation::Circle(c) => write_circle(&mut ops, c),
            Annotation::Ink(i) => write_ink(&mut ops, i),
            Annotation::Highlight(h) => write_highlight(&mut ops, h),
            Annotation::Note(n) => {
                let (fkey, fname) = write_note(&mut ops, n);
                fonts_needed.insert(fkey, fname);
                None
            }
            Annotation::Text(t) => {
                let (fkey, fname) = write_text(&mut ops, t);
                fonts_needed.insert(fkey, fname);
                None
            }
            Annotation::Signature(s) => {
                let (name, img_id, _smask_id) = write_image(&mut ops, s, doc)?;
                xobjects.push((name, img_id));
                None
            }
        };
        if let Some(a) = a {
            if !alphas.contains(&a) {
                alphas.push(a);
            }
        }
    }

    if ops.is_empty() {
        // If we had a previous stream, empty it so stale operators are gone
        if let Some(sid) = existing_stream_id {
            let obj = doc.get_object_mut(sid).map_err(|e| e.to_string())?;
            if let Object::Stream(s) = obj { set_raw_content(s, vec![]); }
            return Ok(Some(sid));
        }
        return Ok(None);
    }

    // Register font resources
    for (fkey, fname) in &fonts_needed {
        add_font_to_page(doc, page_id, fkey, fname)?;
    }

    // Register image XObject resources
    for (name, xobj_id) in xobjects {
        add_xobject_to_page(doc, page_id, &name, xobj_id)?;
    }

    // Register transparency
    for a in alphas {
        add_extgstate_to_page(doc, page_id, a)?;
    }

    // Update existing stream in-place, or append a new one
    if let Some(sid) = existing_stream_id {
        let obj = doc.get_object_mut(sid).map_err(|e| e.to_string())?;
        if let Object::Stream(s) = obj {
            set_raw_content(s, ops);
            return Ok(Some(sid));
        }
    }
    let new_id = append_content_stream(doc, page_id, ops)?;
    Ok(Some(new_id))
}

// ── AcroForm field writing ────────────────────────────────────────────────────

/// A form field name/value pair sent from the frontend.
#[derive(serde::Deserialize, Clone)]
pub struct FormFieldValue {
    pub name: String,
    /// Plain text for Tx/Ch, "true"/"false" for checkboxes, export value for radios.
    pub value: String,
}

/// Write user-supplied form field values into the document's AcroForm structure.
/// Sets `/NeedAppearances true` so viewers regenerate visual appearances.
/// Silently succeeds if the document has no AcroForm or `fields` is empty.
pub fn write_form_fields(doc: &mut Document, fields: &[FormFieldValue]) -> Result<(), String> {
    if fields.is_empty() {
        return Ok(());
    }

    let values_map: HashMap<String, String> = fields
        .iter()
        .map(|f| (f.name.clone(), f.value.clone()))
        .collect();

    let cat_id = catalog_id(doc)?;

    // Locate the AcroForm — handle both referenced and inline dict cases
    let acroform_id = {
        let cat  = doc.get_object(cat_id).map_err(|e| e.to_string())?;
        let dict = cat.as_dict().map_err(|e| e.to_string())?;
        match dict.get(b"AcroForm") {
            Ok(Object::Reference(id)) => *id,
            Ok(Object::Dictionary(_)) => {
                let inline = dict.get(b"AcroForm").unwrap().clone();
                let new_id = doc.add_object(inline);
                let cat_obj = doc.get_object_mut(cat_id).map_err(|e| e.to_string())?;
                if let Object::Dictionary(cat_dict) = cat_obj {
                    cat_dict.set(b"AcroForm", Object::Reference(new_id));
                }
                new_id
            }
            _ => return Ok(()),
        }
    };

    // Set NeedAppearances = true so viewers regenerate field appearances
    {
        let acroform = doc.get_object_mut(acroform_id).map_err(|e| e.to_string())?;
        if let Object::Dictionary(d) = acroform {
            d.set(b"NeedAppearances", Object::Boolean(true));
        }
    }

    // Collect the top-level Fields array (cloned to release the borrow)
    let field_refs: Vec<Object> = {
        let acroform = doc.get_object(acroform_id).map_err(|e| e.to_string())?;
        let dict     = acroform.as_dict().map_err(|e| e.to_string())?;
        match dict.get(b"Fields") {
            Ok(Object::Array(arr)) => arr.clone(),
            _ => return Ok(()),
        }
    };

    // First pass (immutable): collect what needs to be updated
    let updates = collect_field_updates(doc, &field_refs, "", "", &values_map)?;

    // Second pass (mutable): apply the updates
    for (id, ft, value, on_state, set_as) in updates {
        let obj = doc.get_object_mut(id).map_err(|e| e.to_string())?;
        if let Object::Dictionary(d) = obj {
            match ft.as_str() {
                "Tx" | "Ch" => {
                    d.set(b"V", Object::String(value.into_bytes(), StringFormat::Literal));
                }
                "Btn" => {
                    let (v_bytes, as_bytes) = match value.as_str() {
                        "true"  => (on_state.clone(), on_state),
                        "false" | "" => (b"Off".to_vec(), b"Off".to_vec()),
                        export_val => {
                            let b = export_val.as_bytes().to_vec();
                            (b.clone(), b)
                        }
                    };
                    d.set(b"V", Object::Name(v_bytes));
                    if set_as {
                        d.set(b"AS", Object::Name(as_bytes));
                    }
                }
                _ => {
                    d.set(b"V", Object::String(value.into_bytes(), StringFormat::Literal));
                }
            }
        }
    }

    Ok(())
}

/// Recursively traverse the AcroForm field tree, collecting updates.
/// Returns `Vec<(ObjectId, field_type, new_value, on_state_name, set_as_flag)>`.
#[allow(clippy::type_complexity)]
fn collect_field_updates(
    doc: &Document,
    refs: &[Object],
    parent_name: &str,
    inherited_ft: &str,
    values: &HashMap<String, String>,
) -> Result<Vec<(ObjectId, String, String, Vec<u8>, bool)>, String> {
    let mut result = Vec::new();

    for obj_ref in refs {
        let id = match obj_ref {
            Object::Reference(id) => *id,
            _ => continue,
        };

        let obj  = match doc.get_object(id) { Ok(o) => o, Err(_) => continue };
        let dict = match obj.as_dict()       { Ok(d) => d, Err(_) => continue };

        // Partial field name (/T)
        let partial: String = dict.get(b"T")
            .ok()
            .and_then(|o| match o {
                Object::String(s, _) => pdf_text_to_string(s),
                _ => None,
            })
            .unwrap_or_default();

        let full_name = if parent_name.is_empty() {
            partial.clone()
        } else if partial.is_empty() {
            parent_name.to_string()
        } else {
            format!("{}.{}", parent_name, partial)
        };

        // Field type — inherit from parent if not set on this node
        let ft: String = dict.get(b"FT")
            .ok()
            .and_then(|o| if let Object::Name(n) = o { String::from_utf8(n.clone()).ok() } else { None })
            .unwrap_or_else(|| inherited_ft.to_string());

        let has_kids = dict.has(b"Kids");

        // If this node has a /T and we have a value for it, schedule an update
        if !partial.is_empty() {
            let maybe_val = values.get(&full_name)
                .or_else(|| values.get(&partial))
                .cloned();
            if let Some(val) = maybe_val {
                let on_state = field_on_state_name(dict);
                // Only set /AS on terminal widget nodes (checkbox merged with field)
                let set_as = !has_kids && ft == "Btn";
                result.push((id, ft.clone(), val, on_state, set_as));
            }
        }

        // Recurse into Kids
        if has_kids {
            let kids: Vec<Object> = match dict.get(b"Kids") {
                Ok(Object::Array(arr)) => arr.clone(),
                _ => continue,
            };
            let child_results = collect_field_updates(doc, &kids, &full_name, &ft, values)?;
            result.extend(child_results);
        }
    }

    Ok(result)
}

/// Determine the on-state name for a checkbox/radio from its appearance dict.
/// Falls back to `b"Yes"` if no appearance dictionary is present.
fn field_on_state_name(dict: &lopdf::Dictionary) -> Vec<u8> {
    if let Ok(Object::Dictionary(ap)) = dict.get(b"AP") {
        if let Ok(Object::Dictionary(n_dict)) = ap.get(b"N") {
            for (key, _) in n_dict.iter() {
                if key.as_slice() != b"Off" {
                    return key.clone();
                }
            }
        }
    }
    b"Yes".to_vec()
}

/// Clear the content streams referenced by `meta.stream_ids` directly on a
/// loaded `Document`. Production code uses `IncrementalDocument` paths (see
/// `commands::pdf::strip_annotation_streams`) — this helper remains only as a
/// building block for the round-trip tests below.
/// Replaces a stream's bytes with uncompressed `content`, keeping `/Length` in
/// sync and dropping any `/Filter` left over from a previous encoding (for
/// example after the compress command flate-encoded every stream). Assigning
/// `stream.content` directly leaves a stale `/Length`, which corrupts the file.
pub(crate) fn set_raw_content(s: &mut lopdf::Stream, content: Vec<u8>) {
    s.dict.remove(b"Filter");
    s.dict.remove(b"DecodeParms");
    s.set_content(content);
}

#[cfg(test)]
fn clear_annotation_streams(doc: &mut Document, meta: &AnnotationMeta) -> Result<(), String> {
    for arr in meta.stream_ids.values() {
        let sid = (arr[0], arr[1] as u16);
        if let Ok(Object::Stream(s)) = doc.get_object_mut(sid) {
            set_raw_content(s, vec![]);
        }
    }
    Ok(())
}

// ── Tests (TDD — must fail before implementation) ────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf::models::PdfRect;
    use crate::pdf::models::{RgbColor, TextAlignment};

    fn red() -> RgbColor { RgbColor { r: 255, g: 0, b: 0 } }
    fn black() -> RgbColor { RgbColor { r: 0, g: 0, b: 0 } }

    #[test]
    fn test_write_rect_contains_operators() {
        let ann = RectAnnotation {
            page: 1,
            x: 100.0, y: 200.0,
            width: 50.0, height: 30.0,
            color: red(),
            stroke_width: 1.5,
            fill_color: None,
            opacity: None,
        };
        let mut buf = Vec::new();
        write_rect(&mut buf, &ann);
        let s = String::from_utf8(buf).unwrap();

        assert!(s.contains("q"), "missing save state");
        assert!(s.contains("Q"), "missing restore state");
        assert!(s.contains("re"), "missing rect operator");
        assert!(s.contains("\nS\n"), "missing stroke operator");
        assert!(s.contains("RG"), "missing stroke colour");
        // Red component should be 1.0000
        assert!(s.contains("1.0000"), "red channel not 1.0");
    }

    #[test]
    fn filled_shapes_fill_and_stroke_or_only_fill() {
        let mut ann = RectAnnotation {
            page: 1, x: 0.0, y: 0.0, width: 10.0, height: 10.0,
            color: red(), stroke_width: 2.0, fill_color: Some(black()),
            opacity: None,
        };
        let mut buf = Vec::new();
        write_rect(&mut buf, &ann);
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("0.0000 0.0000 0.0000 rg"), "missing fill colour: {s}");
        assert!(s.contains("re\nB\n"), "should fill and stroke: {s}");

        ann.stroke_width = 0.0;
        let mut buf = Vec::new();
        write_rect(&mut buf, &ann);
        assert!(String::from_utf8(buf).unwrap().contains("re\nf\n"));

        let circle = CircleAnnotation {
            page: 1, x: 0.0, y: 0.0, width: 10.0, height: 10.0,
            color: red(), stroke_width: 1.0, fill_color: Some(red()),
            opacity: None,
        };
        let mut buf = Vec::new();
        write_circle(&mut buf, &circle);
        assert!(String::from_utf8(buf).unwrap().contains("\nB\nQ"));
    }

    #[test]
    fn translucent_shapes_use_a_graphics_state() {
        let ann = RectAnnotation {
            page: 1, x: 0.0, y: 0.0, width: 10.0, height: 10.0,
            color: red(), stroke_width: 1.0, fill_color: None, opacity: Some(0.5),
        };
        let mut buf = Vec::new();
        let a = write_rect(&mut buf, &ann).expect("needs transparency");
        assert!(String::from_utf8(buf).unwrap().contains(&format!("/{} gs", a.name())));
        let opaque = RectAnnotation { opacity: Some(1.0), ..ann };
        assert!(write_rect(&mut Vec::new(), &opaque).is_none());
    }

    #[test]
    fn ink_draws_a_path_through_its_points() {
        let ann = InkAnnotation {
            page: 1, x: 100.0, y: 100.0, width: 50.0, height: 20.0,
            points: vec![[0.0, 0.0], [0.5, 1.0], [1.0, 0.0]],
            color: black(), stroke_width: 2.0, fill_color: None, opacity: None, arrow: false,
        };
        let mut buf = Vec::new();
        assert!(write_ink(&mut buf, &ann).is_none());
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("100.0000 100.0000 m"), "{s}");
        assert!(s.contains("125.0000 120.0000 l"), "{s}");
        assert!(s.contains("150.0000 100.0000 l\nS"), "{s}");
    }

    #[test]
    fn arrow_ends_with_a_filled_head() {
        let ann = InkAnnotation {
            page: 1, x: 0.0, y: 0.0, width: 100.0, height: 1.0,
            points: vec![[0.0, 0.5], [1.0, 0.5]],
            color: red(), stroke_width: 2.0, fill_color: None, opacity: None, arrow: true,
        };
        let mut buf = Vec::new();
        write_ink(&mut buf, &ann);
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("100.0000 0.5000 m"), "head starts at the tip: {s}");
        assert!(s.contains("h\nf\n"), "{s}");
    }

    #[test]
    fn highlight_multiplies_its_rectangles() {
        let ann = HighlightAnnotation {
            page: 1, x: 0.0, y: 0.0, width: 10.0, height: 10.0,
            rects: vec![PdfRect { x: 1.0, y: 2.0, width: 3.0, height: 4.0 }],
            color: red(), opacity: 0.45,
        };
        let mut buf = Vec::new();
        let a = write_highlight(&mut buf, &ann).unwrap();
        assert!(a.name().ends_with('M'));
        assert!(String::from_utf8(buf).unwrap().contains("1.0000 2.0000 3.0000 4.0000 re"));
    }

    #[test]
    fn note_fills_its_square_and_writes_its_text() {
        let ann = NoteAnnotation {
            page: 1, x: 10.0, y: 10.0, width: 120.0, height: 80.0,
            content: "Call back".into(), color: red(),
        };
        let mut buf = Vec::new();
        let (fkey, _) = write_note(&mut buf, &ann);
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("10.0000 10.0000 120.0000 80.0000 re\nB"), "{s}");
        assert!(s.contains("(Call back) Tj"), "{s}");
        assert!(s.contains(&format!("/{fkey} ")));
    }

    #[test]
    fn text_background_is_painted_behind_the_text() {
        let ann = TextAnnotation {
            page: 1, x: 50.0, y: 300.0, width: 100.0, content: "Hi".into(),
            color: black(), font_size: 12.0, bold: false, italic: false, underline: false,
            alignment: TextAlignment::Left, font_family: FontFamily::Helvetica,
            background_color: Some(red()),
        };
        let mut buf = Vec::new();
        write_text(&mut buf, &ann);
        let s = String::from_utf8(buf).unwrap();
        let fill = s.find("re\nf").expect("background");
        assert!(fill < s.find("BT").unwrap());
    }

    #[test]
    fn test_write_circle_contains_bezier() {
        let ann = CircleAnnotation {
            page: 1,
            x: 100.0, y: 100.0,
            width: 60.0, height: 60.0,
            color: black(),
            stroke_width: 1.0,
            fill_color: None,
            opacity: None,
        };
        let mut buf = Vec::new();
        write_circle(&mut buf, &ann);
        let s = String::from_utf8(buf).unwrap();

        assert!(s.contains(" c\n"), "missing bezier curve operator");
        assert!(s.contains(" m\n"), "missing moveto operator");
        assert!(s.contains("\nS\n"), "missing stroke operator");
        assert!(s.contains("RG"), "missing stroke colour");
    }

    #[test]
    fn test_write_text_contains_text_operators() {
        let ann = TextAnnotation {
            page: 1,
            x: 50.0, y: 300.0,
            width: 200.0,
            content: "Hello".to_string(),
            color: black(),
            font_size: 12.0,
            bold: false,
            italic: false,
            underline: false,
            alignment: TextAlignment::Left,
            font_family: FontFamily::Helvetica,
            background_color: None,
        };
        let mut buf = Vec::new();
        let (fkey, fname) = write_text(&mut buf, &ann);
        let s = String::from_utf8(buf).unwrap();

        assert!(s.contains("BT"), "missing begin text");
        assert!(s.contains("ET"), "missing end text");
        assert!(s.contains("Tf"), "missing font operator");
        assert!(s.contains("Tj"), "missing text draw operator");
        assert!(s.contains("Hello"), "text content missing");
        assert_eq!(fkey, "Helv");
        assert_eq!(fname, "Helvetica");
    }

    #[test]
    fn test_write_text_bold_italic_selects_correct_font() {
        let ann = TextAnnotation {
            page: 1,
            x: 0.0, y: 0.0,
            width: 100.0,
            content: "Bold".to_string(),
            color: black(),
            font_size: 10.0,
            bold: true,
            italic: true,
            underline: false,
            alignment: TextAlignment::Center,
            font_family: FontFamily::Helvetica,
            background_color: None,
        };
        let mut buf = Vec::new();
        let (fkey, fname) = write_text(&mut buf, &ann);
        assert_eq!(fkey, "HelvBO");
        assert_eq!(fname, "Helvetica-BoldOblique");
    }

    #[test]
    fn test_write_text_uses_chosen_font_family() {
        let ann = TextAnnotation {
            page: 1,
            x: 0.0, y: 0.0,
            width: 100.0,
            content: "Serif".to_string(),
            color: black(),
            font_size: 10.0,
            bold: false,
            italic: true,
            underline: false,
            alignment: TextAlignment::Left,
            font_family: FontFamily::Times,
            background_color: None,
        };
        let mut buf = Vec::new();
        let (fkey, fname) = write_text(&mut buf, &ann);
        assert_eq!(fkey, "TimesI");
        assert_eq!(fname, "Times-Italic");
    }

    #[test]
    fn text_annotation_without_font_family_defaults_to_helvetica() {
        let json = r#"{"kind":"text","page":1,"x":0,"y":0,"width":10,"content":"a","color":{"r":0,"g":0,"b":0},"fontSize":12,"bold":false,"italic":false,"underline":false,"alignment":"left"}"#;
        let ann: Annotation = serde_json::from_str(json).unwrap();
        let Annotation::Text(t) = ann else { panic!("not text") };
        assert_eq!(t.font_family, FontFamily::Helvetica);
    }

    #[test]
    fn test_write_image_embeds_xobject() {
        // Create a 2×2 solid red PNG in memory
        use image::{DynamicImage, ImageBuffer, Rgba};
        let mut img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::new(2, 2);
        for p in img.pixels_mut() {
            *p = Rgba([255, 0, 0, 255]);
        }
        let mut png_buf: Vec<u8> = Vec::new();
        DynamicImage::ImageRgba8(img)
            .write_to(
                &mut std::io::Cursor::new(&mut png_buf),
                image::ImageFormat::Png,
            )
            .unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png_buf);

        let ann = SignatureAnnotation {
            page: 1,
            x: 10.0, y: 10.0,
            width: 50.0, height: 20.0,
            image_data: b64,
        };

        let mut doc = Document::new();
        let mut ops_buf: Vec<u8> = Vec::new();
        let (name, _img_id, _smask) = write_image(&mut ops_buf, &ann, &mut doc).unwrap();

        let s = String::from_utf8(ops_buf).unwrap();
        assert!(s.contains("Do"), "missing XObject Do operator");
        assert!(s.contains(" cm\n"), "missing transformation matrix");
        assert!(s.contains(&name), "resource name not in content stream");
    }

    /// Helper: create a minimal valid PDF document with a catalog that has a Root
    /// entry in the trailer.
    fn make_doc_with_catalog() -> (Document, ObjectId) {
        use lopdf::dictionary;
        let mut doc = Document::new();
        let pages_id = doc.add_object(dictionary! {
            b"Type" => Object::Name(b"Pages".to_vec()),
            b"Kids" => Object::Array(vec![]),
            b"Count" => Object::Integer(0),
        });
        let cat_id = doc.add_object(dictionary! {
            b"Type" => Object::Name(b"Catalog".to_vec()),
            b"Pages" => Object::Reference(pages_id),
        });
        doc.trailer.set(b"Root", Object::Reference(cat_id));
        (doc, cat_id)
    }

    /// Build a minimal PDF with an AcroForm containing one text field and one checkbox,
    /// then verify that write_form_fields persists the values through save/load.
    #[test]
    fn test_write_form_fields_persists_values() {
        use lopdf::dictionary;

        let (mut doc, cat_id) = make_doc_with_catalog();

        let text_field_id = doc.add_object(dictionary! {
            b"T" => Object::String(b"Name1".to_vec(), StringFormat::Literal),
            b"FT" => Object::Name(b"Tx".to_vec()),
        });

        let cb_field_id = doc.add_object(dictionary! {
            b"T" => Object::String(b"Check1".to_vec(), StringFormat::Literal),
            b"FT" => Object::Name(b"Btn".to_vec()),
            b"V" => Object::Name(b"Off".to_vec()),
            b"AS" => Object::Name(b"Off".to_vec()),
            b"AP" => dictionary! {
                b"N" => dictionary! {
                    b"Yes" => Object::Null,
                    b"Off" => Object::Null,
                },
            },
        });

        let acroform_id = doc.add_object(dictionary! {
            b"Fields" => vec![
                Object::Reference(text_field_id),
                Object::Reference(cb_field_id),
            ],
        });

        if let Ok(Object::Dictionary(cat)) = doc.get_object_mut(cat_id) {
            cat.set(b"AcroForm", Object::Reference(acroform_id));
        }

        let fields = vec![
            FormFieldValue { name: "Name1".into(), value: "Alice".into() },
            FormFieldValue { name: "Check1".into(), value: "true".into() },
        ];
        write_form_fields(&mut doc, &fields).unwrap();

        let tf = doc.get_object(text_field_id).unwrap().as_dict().unwrap();
        match tf.get(b"V").unwrap() {
            Object::String(s, _) => assert_eq!(s, b"Alice"),
            other => panic!("expected String for text /V, got {:?}", other),
        }

        let cb = doc.get_object(cb_field_id).unwrap().as_dict().unwrap();
        match cb.get(b"V").unwrap() {
            Object::Name(n) => assert_eq!(n, b"Yes"),
            other => panic!("expected Name for checkbox /V, got {:?}", other),
        }
        match cb.get(b"AS").unwrap() {
            Object::Name(n) => assert_eq!(n, b"Yes"),
            other => panic!("expected Name for checkbox /AS, got {:?}", other),
        }
    }

    /// Same as above but with AcroForm as an inline dictionary (not a reference).
    #[test]
    fn test_write_form_fields_inline_acroform() {
        use lopdf::dictionary;

        let (mut doc, cat_id) = make_doc_with_catalog();

        let text_field_id = doc.add_object(dictionary! {
            b"T" => Object::String(b"Field1".to_vec(), StringFormat::Literal),
            b"FT" => Object::Name(b"Tx".to_vec()),
        });

        if let Ok(Object::Dictionary(cat)) = doc.get_object_mut(cat_id) {
            cat.set(b"AcroForm", dictionary! {
                b"Fields" => vec![Object::Reference(text_field_id)],
            });
        }

        let fields = vec![
            FormFieldValue { name: "Field1".into(), value: "Bob".into() },
        ];
        write_form_fields(&mut doc, &fields).unwrap();

        let tf = doc.get_object(text_field_id).unwrap().as_dict().unwrap();
        match tf.get(b"V").unwrap() {
            Object::String(s, _) => assert_eq!(s, b"Bob"),
            other => panic!("expected String for text /V, got {:?}", other),
        }
    }

    /// Verify that values survive a save-to-bytes/reload round-trip.
    #[test]
    fn test_write_form_fields_roundtrip() {
        use lopdf::dictionary;

        let (mut doc, cat_id) = make_doc_with_catalog();

        let text_field_id = doc.add_object(dictionary! {
            b"T" => Object::String(b"Name1".to_vec(), StringFormat::Literal),
            b"FT" => Object::Name(b"Tx".to_vec()),
        });

        let acroform_id = doc.add_object(dictionary! {
            b"Fields" => vec![Object::Reference(text_field_id)],
        });

        if let Ok(Object::Dictionary(cat)) = doc.get_object_mut(cat_id) {
            cat.set(b"AcroForm", Object::Reference(acroform_id));
        }

        let fields = vec![
            FormFieldValue { name: "Name1".into(), value: "Hello World".into() },
        ];
        write_form_fields(&mut doc, &fields).unwrap();

        // Save to a byte buffer and reload
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        let doc2 = Document::load_mem(&buf).unwrap();

        // Find the text field in the reloaded document and check /V
        let cat2 = doc2.get_object(catalog_id(&doc2).unwrap()).unwrap().as_dict().unwrap();
        let af_id = cat2.get(b"AcroForm").unwrap().as_reference().unwrap();
        let af = doc2.get_object(af_id).unwrap().as_dict().unwrap();
        let field_refs = af.get(b"Fields").unwrap().as_array().unwrap();
        let fid = field_refs[0].as_reference().unwrap();
        let field = doc2.get_object(fid).unwrap().as_dict().unwrap();

        match field.get(b"V").unwrap() {
            Object::String(s, _) => assert_eq!(String::from_utf8(s.clone()).unwrap(), "Hello World"),
            other => panic!("expected String for text /V after roundtrip, got {:?}", other),
        }
    }

    /// Verify that field names stored as PDFDocEncoding (Latin-1) are matched correctly.
    #[test]
    fn test_write_form_fields_pdfdocencoding_name() {
        use lopdf::dictionary;

        let (mut doc, cat_id) = make_doc_with_catalog();

        // "État" in Latin-1: É=0xC9, t=0x74, a=0x61, t=0x74
        let latin1_name: Vec<u8> = vec![0xC9, b't', b'a', b't'];
        let text_field_id = doc.add_object(dictionary! {
            b"T" => Object::String(latin1_name, StringFormat::Literal),
            b"FT" => Object::Name(b"Tx".to_vec()),
        });

        let acroform_id = doc.add_object(dictionary! {
            b"Fields" => vec![Object::Reference(text_field_id)],
        });

        if let Ok(Object::Dictionary(cat)) = doc.get_object_mut(cat_id) {
            cat.set(b"AcroForm", Object::Reference(acroform_id));
        }

        // Frontend sends the name as proper Unicode "État"
        let fields = vec![
            FormFieldValue { name: "\u{00C9}tat".into(), value: "test".into() },
        ];
        write_form_fields(&mut doc, &fields).unwrap();

        let tf = doc.get_object(text_field_id).unwrap().as_dict().unwrap();
        match tf.get(b"V").unwrap() {
            Object::String(s, _) => assert_eq!(s, b"test"),
            other => panic!("expected String for text /V, got {:?}", other),
        }
    }

    /// Verify that UTF-16BE field names are matched correctly.
    #[test]
    fn test_write_form_fields_utf16be_name() {
        use lopdf::dictionary;

        let (mut doc, cat_id) = make_doc_with_catalog();

        // "État" as UTF-16BE with BOM: FE FF 00C9 0074 0061 0074
        let utf16_name: Vec<u8> = vec![0xFE, 0xFF, 0x00, 0xC9, 0x00, 0x74, 0x00, 0x61, 0x00, 0x74];
        let text_field_id = doc.add_object(dictionary! {
            b"T" => Object::String(utf16_name, StringFormat::Literal),
            b"FT" => Object::Name(b"Tx".to_vec()),
        });

        let acroform_id = doc.add_object(dictionary! {
            b"Fields" => vec![Object::Reference(text_field_id)],
        });

        if let Ok(Object::Dictionary(cat)) = doc.get_object_mut(cat_id) {
            cat.set(b"AcroForm", Object::Reference(acroform_id));
        }

        let fields = vec![
            FormFieldValue { name: "\u{00C9}tat".into(), value: "test16".into() },
        ];
        write_form_fields(&mut doc, &fields).unwrap();

        let tf = doc.get_object(text_field_id).unwrap().as_dict().unwrap();
        match tf.get(b"V").unwrap() {
            Object::String(s, _) => assert_eq!(s, b"test16"),
            other => panic!("expected String for text /V, got {:?}", other),
        }
    }

    /// Full save → load → strip cycle: annotation must be readable from meta
    /// and its burned content stream must be clearable by stream_id.
    #[test]
    fn test_save_strip_roundtrip() {
        use lopdf::dictionary;

        // 1. Build a one-page PDF
        let (mut doc, _cat_id) = make_doc_with_catalog();
        let content_stream = Stream::new(dictionary! {}, b"q Q".to_vec());
        let cs_id = doc.add_object(Object::Stream(content_stream));
        let page_id = doc.add_object(dictionary! {
            b"Type" => Object::Name(b"Page".to_vec()),
            b"Contents" => Object::Reference(cs_id),
            b"Resources" => Object::Dictionary(lopdf::Dictionary::new()),
        });

        // Register the page in the Pages tree
        let pages_id = {
            let cat = doc.get_object(catalog_id(&doc).unwrap()).unwrap().as_dict().unwrap();
            cat.get(b"Pages").unwrap().as_reference().unwrap()
        };
        if let Ok(Object::Dictionary(ref mut d)) = doc.get_object_mut(pages_id) {
            d.set("Kids", Object::Array(vec![Object::Reference(page_id)]));
            d.set("Count", Object::Integer(1));
        }

        // 2. Burn a text annotation
        let ann = Annotation::Text(TextAnnotation {
            page: 1,
            x: 50.0, y: 300.0,
            width: 200.0,
            content: "Hello".to_string(),
            color: black(),
            font_size: 12.0,
            bold: false, italic: false, underline: false,
            alignment: TextAlignment::Left,
            font_family: FontFamily::Helvetica,
            background_color: None,
        });

        let mut meta = load_meta(&doc);
        let existing = meta.stream_ids.get(&1).map(|arr| (arr[0], arr[1] as u16));
        let sid = write_annotations_for_page(&mut doc, page_id, std::slice::from_ref(&ann), existing)
            .unwrap()
            .expect("should return a stream id");

        meta.annotations = vec![ann];
        meta.stream_ids.insert(1, [sid.0, sid.1 as u32]);
        save_meta(&mut doc, &meta).unwrap();

        // 3. Save to a temp file, reload
        let tmp = std::env::temp_dir().join("test_roundtrip.pdf");
        doc.save(&tmp).unwrap();
        let doc2 = Document::load(&tmp).unwrap();

        // 4. Verify meta is readable
        let meta2 = load_meta(&doc2);
        assert_eq!(meta2.annotations.len(), 1, "should read back 1 annotation");
        assert!(meta2.stream_ids.contains_key(&1), "should have stream id for page 1");

        // 5. Verify the annotation stream has content
        let sid2 = meta2.stream_ids.get(&1).unwrap();
        let stream_obj = doc2.get_object((sid2[0], sid2[1] as u16)).unwrap();
        let stream = stream_obj.as_stream().unwrap();
        assert!(!stream.content.is_empty(), "annotation stream should have content before strip");

        // 6. Strip and verify stream is empty
        let mut doc3 = Document::load(&tmp).unwrap();
        let meta3 = load_meta(&doc3);
        clear_annotation_streams(&mut doc3, &meta3).unwrap();
        let stream_obj3 = doc3.get_object((sid2[0], sid2[1] as u16)).unwrap();
        let stream3 = stream_obj3.as_stream().unwrap();
        assert!(stream3.content.is_empty(), "annotation stream should be empty after strip");

        let _ = std::fs::remove_file(&tmp);
    }

    /// Simulate: save with annotation → save again from same file (no strip).
    /// The annotation stream should be updated in-place, not duplicated.
    #[test]
    fn test_double_save_no_duplicate_streams() {
        use lopdf::dictionary;

        // 1. Build a one-page PDF
        let (mut doc, _cat_id) = make_doc_with_catalog();
        let content_stream = Stream::new(dictionary! {}, b"q Q".to_vec());
        let cs_id = doc.add_object(Object::Stream(content_stream));
        let page_id = doc.add_object(dictionary! {
            b"Type" => Object::Name(b"Page".to_vec()),
            b"Contents" => Object::Reference(cs_id),
            b"Resources" => Object::Dictionary(lopdf::Dictionary::new()),
        });
        let pages_id = {
            let cat = doc.get_object(catalog_id(&doc).unwrap()).unwrap().as_dict().unwrap();
            cat.get(b"Pages").unwrap().as_reference().unwrap()
        };
        if let Ok(Object::Dictionary(ref mut d)) = doc.get_object_mut(pages_id) {
            d.set("Kids", Object::Array(vec![Object::Reference(page_id)]));
            d.set("Count", Object::Integer(1));
        }

        let ann = Annotation::Text(TextAnnotation {
            page: 1, x: 50.0, y: 300.0, width: 200.0,
            content: "Hello".to_string(), color: black(), font_size: 12.0,
            bold: false, italic: false, underline: false, alignment: TextAlignment::Left,
            font_family: FontFamily::Helvetica,
            background_color: None,
        });

        // 2. First save (no existing meta)
        let mut meta = load_meta(&doc);
        let existing = meta.stream_ids.get(&1).map(|arr| (arr[0], arr[1] as u16));
        let sid = write_annotations_for_page(&mut doc, page_id, std::slice::from_ref(&ann), existing)
            .unwrap().unwrap();
        meta.annotations = vec![ann.clone()];
        meta.stream_ids.insert(1, [sid.0, sid.1 as u32]);
        save_meta(&mut doc, &meta).unwrap();

        let tmp = std::env::temp_dir().join("test_double_save.pdf");
        doc.save(&tmp).unwrap();

        // 3. Second save from the same file (simulates Ctrl+S without reopen)
        let mut doc2 = Document::load(&tmp).unwrap();
        let meta2 = load_meta(&doc2);
        let pages2 = doc2.get_pages();
        let page_id2 = *pages2.get(&1).unwrap();
        let existing2 = meta2.stream_ids.get(&1).map(|arr| (arr[0], arr[1] as u16));
        let sid2 = write_annotations_for_page(&mut doc2, page_id2, std::slice::from_ref(&ann), existing2)
            .unwrap().unwrap();
        let new_meta = AnnotationMeta {
            annotations: vec![ann],
            stream_ids: HashMap::from([(1, [sid2.0, sid2.1 as u32])]),
        };
        save_meta(&mut doc2, &new_meta).unwrap();
        doc2.save(&tmp).unwrap();

        // 4. Verify: Contents should have exactly 2 entries (original + annotation)
        let doc3 = Document::load(&tmp).unwrap();
        let pages3 = doc3.get_pages();
        let page_id3 = *pages3.get(&1).unwrap();
        let page_dict = doc3.get_object(page_id3).unwrap().as_dict().unwrap();
        let contents = page_dict.get(b"Contents").unwrap();
        match contents {
            Object::Array(arr) => {
                assert_eq!(arr.len(), 2,
                    "Contents should have exactly 2 entries (original + annotation), got {}",
                    arr.len());
            }
            _ => panic!("Contents should be an array after append"),
        }

        // 5. Strip and verify annotation stream is empty
        let mut doc4 = Document::load(&tmp).unwrap();
        let meta4 = load_meta(&doc4);
        assert_eq!(meta4.annotations.len(), 1);
        clear_annotation_streams(&mut doc4, &meta4).unwrap();
        let sid4 = meta4.stream_ids.get(&1).unwrap();
        let s = doc4.get_object((sid4[0], sid4[1] as u16)).unwrap().as_stream().unwrap();
        assert!(s.content.is_empty(), "annotation stream should be empty after strip");

        let _ = std::fs::remove_file(&tmp);
    }
}
