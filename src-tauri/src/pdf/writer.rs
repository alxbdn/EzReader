use std::collections::HashMap;

use base64::Engine;
use image::ImageReader;
use lopdf::{dictionary, Document, Object, ObjectId, Stream};

use super::models::{
    Annotation, CircleAnnotation, FontFamily, HighlightAnnotation, InkAnnotation, InkVector, NoteAnnotation,
    RectAnnotation, RgbColor, SignatureAnnotation, StampAnnotation, StampMark, TextAlignment, TextAnnotation,
};

use super::sysfont;

#[cfg(test)]
use super::annotation_layer::catalog_id;
pub use super::annotation_layer::{load_meta, may_hold_meta, save_meta, AnnotationMeta};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Alpha {
    pct: u32,
    multiply: bool,
}

impl Alpha {
    pub fn name(&self) -> String {
        format!("EzA{}{}", self.pct, if self.multiply { "M" } else { "" })
    }
}

fn alpha(opacity: Option<f64>, multiply: bool) -> Option<Alpha> {
    let o = opacity.unwrap_or(1.0);
    let o = if o.is_finite() { o.clamp(0.0, 1.0) } else { 1.0 };
    let pct = (o * 100.0).round() as u32;
    if pct >= 100 && !multiply {
        None
    } else {
        Some(Alpha { pct, multiply })
    }
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

fn shape_paint(fill: Option<&RgbColor>, stroke_width: f64) -> (String, &'static str) {
    let fill_op = fill.map(|c| format!("{:.4} {:.4} {:.4} rg\n", c.r_f(), c.g_f(), c.b_f())).unwrap_or_default();
    let paint = match (fill.is_some(), stroke_width > 0.0) {
        (true, true) => "B",
        (true, false) => "f",
        (false, true) => "S",
        (false, false) => "n",
    };
    (fill_op, paint)
}

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

pub fn write_circle(buf: &mut Vec<u8>, ann: &CircleAnnotation) -> Option<Alpha> {
    let (fill_op, paint) = shape_paint(ann.fill_color.as_ref(), ann.stroke_width);
    let a = alpha(ann.opacity, false);
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
            "{:.4} {:.4} m\n",
            "{:.4} {:.4} {:.4} {:.4} {:.4} {:.4} c\n",
            "{:.4} {:.4} {:.4} {:.4} {:.4} {:.4} c\n",
            "{:.4} {:.4} {:.4} {:.4} {:.4} {:.4} c\n",
            "{:.4} {:.4} {:.4} {:.4} {:.4} {:.4} c\n",
            "{}\nQ\n"
        ),
        gs_op(a),
        fill_op,
        ann.color.r_f(),
        ann.color.g_f(),
        ann.color.b_f(),
        ann.stroke_width,
        cx,
        cy + ry,
        cx + K * rx,
        cy + ry,
        cx + rx,
        cy + K * ry,
        cx + rx,
        cy,
        cx + rx,
        cy - K * ry,
        cx + K * rx,
        cy - ry,
        cx,
        cy - ry,
        cx - K * rx,
        cy - ry,
        cx - rx,
        cy - K * ry,
        cx - rx,
        cy,
        cx - rx,
        cy + K * ry,
        cx - K * rx,
        cy + ry,
        cx,
        cy + ry,
        paint,
    );
    buf.extend_from_slice(ops.as_bytes());
    a
}

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
    let mut ops = format!("q\n{}{}{:.4} w\n1 J\n1 j\n", gs_op(a), rgb_stroke(&ann.color), ann.stroke_width,);

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
                tx,
                ty,
                bx - uy * hw,
                by + ux * hw,
                bx + uy * hw,
                by - ux * hw,
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

const NOTE_FONT_SIZE: f64 = 10.0;
const NOTE_PADDING: f64 = 6.0;

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
        ann.x,
        ann.y,
        ann.width,
        ann.height,
        ann.x,
        ann.y,
        ann.width,
        ann.height,
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
        font_name: None,
        background_color: None,
        cover: None,
    };
    let font = write_text(buf, &text);
    buf.extend_from_slice(b"Q\n");
    font
}

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

fn avg_char_width(family: FontFamily) -> f64 {
    match family {
        FontFamily::Helvetica => 0.5,
        FontFamily::Times => 0.45,
        FontFamily::Courier => 0.6,
    }
}

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

fn wrap_text_by(text: &str, max_width: f64, width: &dyn Fn(&str) -> f64) -> Vec<String> {
    let space_w = width(" ");
    let mut result = Vec::new();
    for para in text.split('\n') {
        if para.is_empty() {
            result.push(String::new());
            continue;
        }
        let mut line = String::new();
        let mut line_w = 0.0_f64;
        for word in para.split(' ') {
            let word_w = width(word);
            let candidate_w = if line.is_empty() { word_w } else { line_w + space_w + word_w };
            if !line.is_empty() && candidate_w > max_width {
                result.push(line.clone());
                line = word.to_string();
                line_w = word_w;
            } else {
                if !line.is_empty() {
                    line.push(' ');
                    line_w += space_w;
                }
                line.push_str(word);
                line_w += word_w;
            }
        }
        result.push(line);
    }
    result
}

pub fn write_text(buf: &mut Vec<u8>, ann: &TextAnnotation) -> (&'static str, &'static str) {
    let fkey = font_key(ann.font_family, ann.bold, ann.italic);
    let fname = font_name(ann.font_family, ann.bold, ann.italic);
    write_text_in(buf, ann, fkey, &TextFace::Standard(ann.font_family));
    (fkey, fname)
}

pub enum TextFace<'a> {
    Standard(FontFamily),
    Embedded(&'a sysfont::EmbeddedFont),
}

impl TextFace<'_> {
    fn width(&self, s: &str, size: f64) -> f64 {
        match self {
            TextFace::Standard(f) => s.len() as f64 * size * avg_char_width(*f),
            TextFace::Embedded(e) => e.width(s, size),
        }
    }

    fn show(&self, s: &str) -> String {
        match self {
            TextFace::Standard(_) => format!("({})", pdf_escape(s)),
            TextFace::Embedded(e) => e.show(s),
        }
    }
}

pub fn write_text_in(buf: &mut Vec<u8>, ann: &TextAnnotation, fkey: &str, face: &TextFace) {
    let line_h = ann.font_size * 1.2;
    let measure = |s: &str| face.width(s, ann.font_size);
    let lines = wrap_text_by(&ann.content, ann.width, &measure);

    let mut ops = String::from("q\n");
    if let Some(c) = &ann.cover {
        ops.push_str(&format!("{}{:.4} {:.4} {:.4} {:.4} re\nf\n", rgb_fill(&c.color), c.x, c.y, c.width, c.height,));
    }
    if let Some(bg) = &ann.background_color {
        let n = lines.len().max(1) as f64;
        let bottom = ann.y - (n - 1.0) * line_h - ann.font_size * 0.3 - 2.0;
        let height = (n - 1.0) * line_h + ann.font_size * 1.25 + 4.0;
        ops.push_str(&format!(
            "{}{:.4} {:.4} {:.4} {:.4} re\nf\n",
            rgb_fill(bg),
            ann.x - 3.0,
            bottom,
            ann.width + 6.0,
            height,
        ));
    }
    ops.push_str(&format!(
        "{:.4} {:.4} {:.4} rg\nBT\n/{} {:.4} Tf\n",
        ann.color.r_f(),
        ann.color.g_f(),
        ann.color.b_f(),
        fkey,
        ann.font_size,
    ));

    let mut underlines: Vec<(f64, f64, f64)> = Vec::new();

    for (i, line) in lines.iter().enumerate() {
        let line_w = measure(line);
        let x_off = match ann.alignment {
            TextAlignment::Left => 0.0,
            TextAlignment::Center => ((ann.width - line_w) / 2.0).max(0.0),
            TextAlignment::Right => (ann.width - line_w).max(0.0),
        };
        let x = ann.x + x_off;
        let y = ann.y - i as f64 * line_h;

        ops.push_str(&format!("1 0 0 1 {:.4} {:.4} Tm\n{} Tj\n", x, y, face.show(line)));

        if ann.underline {
            underlines.push((x, y - ann.font_size * 0.12, line_w.min(ann.width)));
        }
    }

    ops.push_str("ET\n");

    if !underlines.is_empty() {
        ops.push_str(&format!(
            "{:.4} {:.4} {:.4} RG\n{:.4} w\n",
            ann.color.r_f(),
            ann.color.g_f(),
            ann.color.b_f(),
            ann.font_size * 0.05,
        ));
        for (x, ul_y, ul_len) in underlines {
            ops.push_str(&format!("{:.4} {:.4} m\n{:.4} {:.4} l\nS\n", x, ul_y, x + ul_len, ul_y));
        }
    }

    ops.push_str("Q\n");
    buf.extend_from_slice(ops.as_bytes());
}

pub fn write_image(
    buf: &mut Vec<u8>,
    ann: &SignatureAnnotation,
    doc: &mut Document,
) -> Result<(String, ObjectId, Option<ObjectId>), String> {
    let b64 = ann.image_data.split_once(',').map_or(ann.image_data.as_str(), |(_, data)| data);
    let bytes =
        base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| format!("base64 decode error: {e}"))?;

    let (img_id, smask_id) = embed_image(doc, &bytes)?;

    static IMG_COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = IMG_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let xobj_name = format!("Sig{n}");

    let ops =
        format!("q\n{:.4} 0 0 {:.4} {:.4} {:.4} cm\n/{} Do\nQ\n", ann.width, ann.height, ann.x, ann.y, xobj_name,);
    buf.extend_from_slice(ops.as_bytes());

    Ok((xobj_name, img_id, smask_id))
}

fn write_vector_ok(v: &InkVector) -> bool {
    v.w > 0.0
        && v.h > 0.0
        && !v.segs.is_empty()
        && v.segs.len().is_multiple_of(9)
        && v.segs.iter().all(|n| n.is_finite())
}

pub fn write_signature_vector(buf: &mut Vec<u8>, ann: &SignatureAnnotation) {
    let Some(v) = ann.vector.as_ref() else { return };
    let ink = match &ann.color {
        Some(c) => format!("{:.4} {:.4} {:.4} RG", c.r_f(), c.g_f(), c.b_f()),
        None => "0.0588 0.0588 0.1373 RG".to_string(),
    };
    let mut ops = format!(
        "q\n{ink}\n1 J\n1 j\n{:.6} 0 0 {:.6} {:.4} {:.4} cm\n",
        ann.width / v.w,
        -ann.height / v.h,
        ann.x,
        ann.y + ann.height,
    );
    for s in v.segs.as_chunks::<9>().0 {
        ops.push_str(&format!(
            "{:.3} w\n{:.2} {:.2} m\n{:.2} {:.2} {:.2} {:.2} {:.2} {:.2} c\nS\n",
            s[8], s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7],
        ));
    }
    ops.push_str("Q\n");
    buf.extend_from_slice(ops.as_bytes());
}

pub fn embed_image(doc: &mut Document, bytes: &[u8]) -> Result<(ObjectId, Option<ObjectId>), String> {
    let reader = ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format().map_err(|e| e.to_string())?;
    if reader.format() == Some(image::ImageFormat::Jpeg) {
        use image::ImageDecoder;
        let dec = image::codecs::jpeg::JpegDecoder::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
        let (w, h) = dec.dimensions();
        if dec.color_type() == image::ColorType::Rgb8 {
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
                bytes.to_vec(),
            );
            img.allows_compression = false;
            return Ok((doc.add_object(img), None));
        }
    }

    let img = ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?
        .to_rgba8();

    let (w, h) = img.dimensions();
    let mut rgb_data: Vec<u8> = Vec::with_capacity((w * h * 3) as usize);
    let mut alpha_data: Vec<u8> = Vec::with_capacity((w * h) as usize);
    for pixel in img.pixels() {
        rgb_data.extend_from_slice(&pixel.0[..3]);
        alpha_data.push(pixel[3]);
    }
    let opaque = alpha_data.iter().all(|&a| a == 255);

    let smask_id = if opaque {
        None
    } else {
        let mut smask = Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => i64::from(w),
                "Height" => i64::from(h),
                "ColorSpace" => "DeviceGray",
                "BitsPerComponent" => 8,
            },
            alpha_data,
        );
        let _ = smask.compress();
        Some(doc.add_object(smask))
    };

    let mut dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => i64::from(w),
        "Height" => i64::from(h),
        "ColorSpace" => "DeviceRGB",
        "BitsPerComponent" => 8,
    };
    if let Some(id) = smask_id {
        dict.set("SMask", Object::Reference(id));
    }
    let mut stream = Stream::new(dict, rgb_data);
    let _ = stream.compress();
    Ok((doc.add_object(stream), smask_id))
}

// Hand-drawn stamp marks: filled outlines in a unit box, y up. Same data as src/stamp-marks.ts.
const STAMP_CHECK_0: &[(f64, f64)] = &[
    (0.124, 0.549),
    (0.158, 0.522),
    (0.195, 0.488),
    (0.232, 0.450),
    (0.270, 0.406),
    (0.308, 0.358),
    (0.346, 0.303),
    (0.384, 0.244),
    (0.388, 0.208),
    (0.316, 0.211),
    (0.339, 0.249),
    (0.362, 0.288),
    (0.386, 0.327),
    (0.410, 0.367),
    (0.435, 0.406),
    (0.460, 0.445),
    (0.486, 0.485),
    (0.513, 0.524),
    (0.540, 0.562),
    (0.569, 0.601),
    (0.597, 0.638),
    (0.627, 0.676),
    (0.657, 0.712),
    (0.687, 0.748),
    (0.718, 0.783),
    (0.750, 0.816),
    (0.782, 0.849),
    (0.815, 0.881),
    (0.848, 0.911),
    (0.882, 0.940),
    (0.916, 0.968),
    (0.931, 0.975),
    (0.947, 0.976),
    (0.962, 0.969),
    (0.972, 0.957),
    (0.977, 0.941),
    (0.974, 0.925),
    (0.964, 0.912),
    (0.933, 0.884),
    (0.903, 0.854),
    (0.873, 0.823),
    (0.844, 0.791),
    (0.816, 0.757),
    (0.788, 0.723),
    (0.760, 0.688),
    (0.733, 0.652),
    (0.707, 0.615),
    (0.682, 0.577),
    (0.656, 0.539),
    (0.632, 0.501),
    (0.608, 0.462),
    (0.585, 0.423),
    (0.562, 0.383),
    (0.541, 0.343),
    (0.519, 0.304),
    (0.499, 0.264),
    (0.479, 0.225),
    (0.460, 0.185),
    (0.443, 0.146),
    (0.332, 0.072),
    (0.257, 0.161),
    (0.219, 0.217),
    (0.183, 0.267),
    (0.150, 0.314),
    (0.119, 0.355),
    (0.090, 0.392),
    (0.063, 0.423),
    (0.036, 0.451),
    (0.019, 0.475),
    (0.014, 0.504),
    (0.022, 0.532),
    (0.042, 0.554),
    (0.069, 0.566),
    (0.099, 0.564),
];
const STAMP_CROSS_0: &[(f64, f64)] = &[
    (0.221, 0.898),
    (0.253, 0.866),
    (0.285, 0.835),
    (0.316, 0.803),
    (0.348, 0.770),
    (0.379, 0.738),
    (0.409, 0.705),
    (0.440, 0.672),
    (0.470, 0.639),
    (0.500, 0.606),
    (0.530, 0.572),
    (0.560, 0.539),
    (0.590, 0.505),
    (0.620, 0.471),
    (0.650, 0.436),
    (0.680, 0.402),
    (0.710, 0.368),
    (0.740, 0.333),
    (0.771, 0.299),
    (0.802, 0.264),
    (0.833, 0.230),
    (0.865, 0.195),
    (0.898, 0.161),
    (0.912, 0.140),
    (0.916, 0.116),
    (0.908, 0.092),
    (0.891, 0.074),
    (0.868, 0.065),
    (0.843, 0.067),
    (0.822, 0.079),
    (0.785, 0.110),
    (0.748, 0.142),
    (0.712, 0.174),
    (0.677, 0.207),
    (0.642, 0.239),
    (0.608, 0.272),
    (0.575, 0.306),
    (0.543, 0.339),
    (0.511, 0.373),
    (0.480, 0.407),
    (0.450, 0.441),
    (0.420, 0.476),
    (0.391, 0.510),
    (0.362, 0.545),
    (0.333, 0.580),
    (0.305, 0.615),
    (0.277, 0.650),
    (0.249, 0.684),
    (0.222, 0.719),
    (0.194, 0.754),
    (0.167, 0.788),
    (0.139, 0.822),
    (0.126, 0.844),
    (0.125, 0.869),
    (0.134, 0.892),
    (0.152, 0.909),
    (0.176, 0.916),
    (0.201, 0.912),
];
const STAMP_CROSS_1: &[(f64, f64)] = &[
    (0.916, 0.797),
    (0.887, 0.770),
    (0.859, 0.744),
    (0.830, 0.716),
    (0.800, 0.688),
    (0.771, 0.659),
    (0.741, 0.630),
    (0.710, 0.600),
    (0.679, 0.569),
    (0.648, 0.539),
    (0.615, 0.508),
    (0.583, 0.476),
    (0.549, 0.445),
    (0.515, 0.413),
    (0.480, 0.381),
    (0.445, 0.349),
    (0.409, 0.316),
    (0.372, 0.284),
    (0.334, 0.251),
    (0.296, 0.218),
    (0.257, 0.185),
    (0.218, 0.152),
    (0.178, 0.119),
    (0.157, 0.107),
    (0.132, 0.105),
    (0.109, 0.114),
    (0.092, 0.132),
    (0.084, 0.156),
    (0.088, 0.180),
    (0.102, 0.201),
    (0.138, 0.238),
    (0.173, 0.275),
    (0.208, 0.312),
    (0.243, 0.348),
    (0.278, 0.383),
    (0.312, 0.418),
    (0.347, 0.453),
    (0.381, 0.486),
    (0.415, 0.520),
    (0.448, 0.552),
    (0.482, 0.584),
    (0.516, 0.614),
    (0.550, 0.645),
    (0.583, 0.674),
    (0.616, 0.703),
    (0.650, 0.731),
    (0.683, 0.758),
    (0.715, 0.784),
    (0.748, 0.810),
    (0.780, 0.835),
    (0.813, 0.860),
    (0.844, 0.883),
    (0.867, 0.894),
    (0.891, 0.895),
    (0.914, 0.884),
    (0.930, 0.865),
    (0.936, 0.841),
    (0.931, 0.817),
];
const STAMP_CHECK: &[&[(f64, f64)]] = &[STAMP_CHECK_0];
const STAMP_CROSS: &[&[(f64, f64)]] = &[STAMP_CROSS_0, STAMP_CROSS_1];

pub fn write_stamp(buf: &mut Vec<u8>, ann: &StampAnnotation) {
    let (x, y, w, h) = (ann.x, ann.y, ann.width, ann.height);
    let outlines = match ann.mark {
        StampMark::Check => STAMP_CHECK,
        StampMark::Cross => STAMP_CROSS,
    };
    let mut path = String::new();
    for outline in outlines {
        for (i, (u, v)) in outline.iter().enumerate() {
            path.push_str(&format!("{:.4} {:.4} {}\n", x + u * w, y + v * h, if i == 0 { "m" } else { "l" }));
        }
        path.push_str("h\n");
    }
    let ops = format!("q\n{}{}f\nQ\n", rgb_fill(&ann.color), path);
    buf.extend_from_slice(ops.as_bytes());
}

fn add_font_to_page(doc: &mut Document, page_id: ObjectId, fkey: &str, base_font: &str) -> Result<(), String> {
    let font_obj = dictionary! {
        "Type" => Object::Name(b"Font".to_vec()),
        "Subtype" => Object::Name(b"Type1".to_vec()),
        "BaseFont" => Object::Name(base_font.as_bytes().to_vec()),
    };
    let font_id = doc.add_object(Object::Dictionary(font_obj));
    add_font_ref_to_page(doc, page_id, fkey, font_id)
}

fn add_font_ref_to_page(doc: &mut Document, page_id: ObjectId, fkey: &str, font_id: ObjectId) -> Result<(), String> {
    let page = doc.get_object_mut(page_id).map_err(|e| e.to_string())?;
    let page_dict = match page {
        Object::Dictionary(d) => d,
        _ => return Err("page is not a dictionary".into()),
    };

    if !page_dict.has(b"Resources") {
        page_dict.set("Resources", Object::Dictionary(lopdf::Dictionary::new()));
    }

    let resources = page_dict.get_mut(b"Resources").map_err(|e| e.to_string())?;
    let res_dict = match resources {
        Object::Dictionary(d) => d,
        _ => return Err("Resources is not an inline dict (inherited); cannot modify".into()),
    };

    if !res_dict.has(b"Font") {
        res_dict.set("Font", Object::Dictionary(lopdf::Dictionary::new()));
    }

    let font_dict = res_dict.get_mut(b"Font").map_err(|e| e.to_string())?;
    if let Object::Dictionary(d) = font_dict {
        d.set(fkey.as_bytes().to_vec(), Object::Reference(font_id));
    }

    Ok(())
}

fn add_xobject_to_page(doc: &mut Document, page_id: ObjectId, name: &str, xobj_id: ObjectId) -> Result<(), String> {
    let page = doc.get_object_mut(page_id).map_err(|e| e.to_string())?;
    let page_dict = match page {
        Object::Dictionary(d) => d,
        _ => return Err("page is not a dictionary".into()),
    };

    if !page_dict.has(b"Resources") {
        page_dict.set("Resources", Object::Dictionary(lopdf::Dictionary::new()));
    }

    let resources = page_dict.get_mut(b"Resources").map_err(|e| e.to_string())?;
    let res_dict = match resources {
        Object::Dictionary(d) => d,
        _ => return Err("Resources is not an inline dict".into()),
    };

    if !res_dict.has(b"XObject") {
        res_dict.set("XObject", Object::Dictionary(lopdf::Dictionary::new()));
    }

    let xobj_dict = res_dict.get_mut(b"XObject").map_err(|e| e.to_string())?;
    if let Object::Dictionary(d) = xobj_dict {
        d.set(name.as_bytes().to_vec(), Object::Reference(xobj_id));
    }

    Ok(())
}

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

fn append_content_stream(doc: &mut Document, page_id: ObjectId, new_ops: Vec<u8>) -> Result<ObjectId, String> {
    let new_stream = Stream::new(dictionary! {}, new_ops);
    let new_id = doc.add_object(Object::Stream(new_stream));

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

    let page = doc.get_object_mut(page_id).map_err(|e| e.to_string())?;
    if let Object::Dictionary(d) = page {
        d.set("Contents", Object::Array(refs));
    }

    Ok(new_id)
}

pub fn write_annotations_for_page(
    doc: &mut Document,
    page_id: ObjectId,
    annotations: &[Annotation],
    existing_stream_id: Option<ObjectId>,
) -> Result<Option<ObjectId>, String> {
    let mut ops: Vec<u8> = Vec::new();
    let mut fonts_needed: HashMap<&'static str, &'static str> = HashMap::new();
    let mut embedded: Vec<(String, sysfont::EmbeddedFont)> = Vec::new();
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
                let font = t
                    .font_name
                    .as_deref()
                    .and_then(|name| sysfont::find(name, t.bold, t.italic))
                    .and_then(|data| sysfont::EmbeddedFont::new(data, &t.content));
                if let Some(font) = font {
                    let fkey = format!("EzF{}_{}", page_id.0, embedded.len());
                    write_text_in(&mut ops, t, &fkey, &TextFace::Embedded(&font));
                    embedded.push((fkey, font));
                } else {
                    let (fkey, fname) = write_text(&mut ops, t);
                    fonts_needed.insert(fkey, fname);
                }
                None
            }
            Annotation::Signature(s) if s.vector.as_ref().is_some_and(write_vector_ok) => {
                write_signature_vector(&mut ops, s);
                None
            }
            Annotation::Signature(s) | Annotation::Image(s) => {
                let (name, img_id, _smask_id) = write_image(&mut ops, s, doc)?;
                xobjects.push((name, img_id));
                None
            }
            Annotation::Stamp(st) => {
                write_stamp(&mut ops, st);
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
        if let Some(sid) = existing_stream_id {
            let obj = doc.get_object_mut(sid).map_err(|e| e.to_string())?;
            if let Object::Stream(s) = obj {
                set_raw_content(s, vec![]);
            }
            return Ok(Some(sid));
        }
        return Ok(None);
    }

    for (fkey, fname) in &fonts_needed {
        add_font_to_page(doc, page_id, fkey, fname)?;
    }
    for (fkey, font) in &embedded {
        let font_id = font.write(doc)?;
        add_font_ref_to_page(doc, page_id, fkey, font_id)?;
    }

    for (name, xobj_id) in xobjects {
        add_xobject_to_page(doc, page_id, &name, xobj_id)?;
    }

    for a in alphas {
        add_extgstate_to_page(doc, page_id, a)?;
    }

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

pub use super::forms::{write_form_fields, FormFieldValue};

pub(crate) fn set_raw_content(s: &mut lopdf::Stream, content: Vec<u8>) {
    s.dict.remove(b"Filter");
    s.dict.remove(b"DecodeParms");
    s.set_content(content);
}

#[cfg(test)]
fn clear_annotation_streams(doc: &mut Document, meta: &AnnotationMeta) -> Result<(), String> {
    for (_, sid) in meta.layers() {
        if let Ok(Object::Stream(s)) = doc.get_object_mut(sid) {
            set_raw_content(s, vec![]);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_standard_font_has_its_own_name_and_key() {
        let mut names = std::collections::HashSet::new();
        let mut keys = std::collections::HashSet::new();
        for family in [FontFamily::Helvetica, FontFamily::Times, FontFamily::Courier] {
            for bold in [false, true] {
                for italic in [false, true] {
                    assert!(names.insert(font_name(family, bold, italic)));
                    assert!(keys.insert(font_key(family, bold, italic)));
                }
            }
        }
        assert_eq!(names.len(), 12);
        assert!(names.contains("Times-BoldItalic") && names.contains("Courier"));
    }
    use crate::pdf::models::PdfRect;
    use crate::pdf::models::{RgbColor, TextAlignment};
    use lopdf::StringFormat;

    fn red() -> RgbColor {
        RgbColor { r: 255, g: 0, b: 0 }
    }
    fn black() -> RgbColor {
        RgbColor { r: 0, g: 0, b: 0 }
    }

    fn text_ann(content: &str) -> TextAnnotation {
        TextAnnotation {
            page: 1,
            x: 100.0,
            y: 500.0,
            width: 80.0,
            content: content.into(),
            color: black(),
            font_size: 12.0,
            bold: false,
            italic: false,
            underline: false,
            alignment: TextAlignment::Left,
            font_family: FontFamily::Helvetica,
            font_name: None,
            background_color: None,
            cover: None,
        }
    }

    #[test]
    fn test_edited_text_paints_its_cover_first() {
        let mut ann = text_ann("New words");
        ann.cover = Some(crate::pdf::models::TextCover {
            x: 99.0,
            y: 496.0,
            width: 120.0,
            height: 14.0,
            color: RgbColor { r: 250, g: 250, b: 245 },
        });
        let mut buf = Vec::new();
        write_text(&mut buf, &ann);
        let s = String::from_utf8(buf).unwrap();
        let cover = s.find("99.0000 496.0000 120.0000 14.0000 re").expect("cover rectangle");
        assert!(cover < s.find("BT").unwrap(), "cover must be painted under the text");
        assert!(s.contains("0.9804 0.9804 0.9608 rg"), "cover uses the page colour: {s}");
    }

    #[test]
    fn test_stamps_are_filled_marker_strokes() {
        let mut ann = StampAnnotation {
            page: 1,
            x: 10.0,
            y: 20.0,
            width: 20.0,
            height: 20.0,
            mark: StampMark::Check,
            color: RgbColor { r: 30, g: 58, b: 138 },
        };
        let mut buf = Vec::new();
        write_stamp(&mut buf, &ann);
        let check = String::from_utf8(buf).unwrap();
        assert!(check.contains("0.1176 0.2275 0.5412 rg"), "filled in the stamp colour: {check}");
        assert!(check.ends_with("h\nf\nQ\n"), "closed outlines, filled: {check}");
        assert_eq!(check.matches(" m\n").count(), 1, "a check is one stroke");
        for line in check.lines().filter(|l| l.ends_with(" l") || l.ends_with(" m")) {
            let n: Vec<f64> = line.split(' ').take(2).map(|v| v.parse().unwrap()).collect();
            assert!((10.0..=30.0).contains(&n[0]) && (20.0..=40.0).contains(&n[1]), "inside the box: {line}");
        }

        ann.mark = StampMark::Cross;
        let mut buf = Vec::new();
        write_stamp(&mut buf, &ann);
        let cross = String::from_utf8(buf).unwrap();
        assert_eq!(cross.matches(" m\n").count(), 2, "a cross is two strokes");
    }

    fn encode(img: image::DynamicImage, fmt: image::ImageFormat) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, fmt).unwrap();
        out.into_inner()
    }

    #[test]
    fn test_jpeg_is_embedded_as_is() {
        let jpeg = encode(image::DynamicImage::new_rgb8(40, 30), image::ImageFormat::Jpeg);
        let mut doc = Document::with_version("1.7");
        let (id, smask) = embed_image(&mut doc, &jpeg).unwrap();
        assert!(smask.is_none());
        let st = doc.get_object(id).unwrap().as_stream().unwrap();
        assert_eq!(st.dict.get(b"Filter").unwrap().as_name().unwrap(), b"DCTDecode");
        assert_eq!(st.content, jpeg, "the JPEG bytes pass through untouched");
        assert_eq!(st.dict.get(b"Width").unwrap().as_i64().unwrap(), 40);
    }

    #[test]
    fn test_png_gets_an_smask_only_when_translucent() {
        let opaque = encode(image::DynamicImage::new_rgb8(8, 8), image::ImageFormat::Png);
        let mut doc = Document::with_version("1.7");
        let (id, smask) = embed_image(&mut doc, &opaque).unwrap();
        assert!(smask.is_none(), "an opaque picture needs no mask");
        let st = doc.get_object(id).unwrap().as_stream().unwrap();
        assert_eq!(st.dict.get(b"Filter").unwrap().as_name().unwrap(), b"FlateDecode");

        let clear = encode(image::DynamicImage::new_rgba8(8, 8), image::ImageFormat::Png);
        let (id, smask) = embed_image(&mut doc, &clear).unwrap();
        let smask = smask.expect("transparent picture keeps its alpha");
        let st = doc.get_object(id).unwrap().as_stream().unwrap();
        assert_eq!(st.dict.get(b"SMask").unwrap().as_reference().unwrap(), smask);
    }

    #[test]
    fn test_write_rect_contains_operators() {
        let ann = RectAnnotation {
            page: 1,
            x: 100.0,
            y: 200.0,
            width: 50.0,
            height: 30.0,
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
        assert!(s.contains("1.0000"), "red channel not 1.0");
    }

    #[test]
    fn filled_shapes_fill_and_stroke_or_only_fill() {
        let mut ann = RectAnnotation {
            page: 1,
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
            color: red(),
            stroke_width: 2.0,
            fill_color: Some(black()),
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
            page: 1,
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
            color: red(),
            stroke_width: 1.0,
            fill_color: Some(red()),
            opacity: None,
        };
        let mut buf = Vec::new();
        write_circle(&mut buf, &circle);
        assert!(String::from_utf8(buf).unwrap().contains("\nB\nQ"));
    }

    #[test]
    fn translucent_shapes_use_a_graphics_state() {
        let ann = RectAnnotation {
            page: 1,
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
            color: red(),
            stroke_width: 1.0,
            fill_color: None,
            opacity: Some(0.5),
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
            page: 1,
            x: 100.0,
            y: 100.0,
            width: 50.0,
            height: 20.0,
            points: vec![[0.0, 0.0], [0.5, 1.0], [1.0, 0.0]],
            color: black(),
            stroke_width: 2.0,
            fill_color: None,
            opacity: None,
            arrow: false,
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
            page: 1,
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 1.0,
            points: vec![[0.0, 0.5], [1.0, 0.5]],
            color: red(),
            stroke_width: 2.0,
            fill_color: None,
            opacity: None,
            arrow: true,
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
            page: 1,
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
            rects: vec![PdfRect { x: 1.0, y: 2.0, width: 3.0, height: 4.0 }],
            color: red(),
            opacity: 0.45,
        };
        let mut buf = Vec::new();
        let a = write_highlight(&mut buf, &ann).unwrap();
        assert!(a.name().ends_with('M'));
        assert!(String::from_utf8(buf).unwrap().contains("1.0000 2.0000 3.0000 4.0000 re"));
    }

    #[test]
    fn note_fills_its_square_and_writes_its_text() {
        let ann = NoteAnnotation {
            page: 1,
            x: 10.0,
            y: 10.0,
            width: 120.0,
            height: 80.0,
            content: "Call back".into(),
            color: red(),
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
            page: 1,
            x: 50.0,
            y: 300.0,
            width: 100.0,
            content: "Hi".into(),
            color: black(),
            font_size: 12.0,
            bold: false,
            italic: false,
            underline: false,
            alignment: TextAlignment::Left,
            font_family: FontFamily::Helvetica,
            font_name: None,
            background_color: Some(red()),
            cover: None,
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
            x: 100.0,
            y: 100.0,
            width: 60.0,
            height: 60.0,
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
            x: 50.0,
            y: 300.0,
            width: 200.0,
            content: "Hello".to_string(),
            color: black(),
            font_size: 12.0,
            bold: false,
            italic: false,
            underline: false,
            alignment: TextAlignment::Left,
            font_family: FontFamily::Helvetica,
            font_name: None,
            background_color: None,
            cover: None,
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
            x: 0.0,
            y: 0.0,
            width: 100.0,
            content: "Bold".to_string(),
            color: black(),
            font_size: 10.0,
            bold: true,
            italic: true,
            underline: false,
            alignment: TextAlignment::Center,
            font_family: FontFamily::Helvetica,
            font_name: None,
            background_color: None,
            cover: None,
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
            x: 0.0,
            y: 0.0,
            width: 100.0,
            content: "Serif".to_string(),
            color: black(),
            font_size: 10.0,
            bold: false,
            italic: true,
            underline: false,
            alignment: TextAlignment::Left,
            font_family: FontFamily::Times,
            font_name: None,
            background_color: None,
            cover: None,
        };
        let mut buf = Vec::new();
        let (fkey, fname) = write_text(&mut buf, &ann);
        assert_eq!(fkey, "TimesI");
        assert_eq!(fname, "Times-Italic");
    }

    #[test]
    fn a_font_not_installed_falls_back_to_the_standard_one() {
        let mut ann = text_ann("Hello");
        ann.font_name = Some("No Such Font".into());
        let (mut doc, _) = make_doc_with_catalog();
        let page_id = doc.add_object(dictionary! { "Type" => "Page", "Resources" => dictionary! {} });
        let sid = write_annotations_for_page(&mut doc, page_id, &[Annotation::Text(ann)], None).unwrap().unwrap();
        let s = String::from_utf8(doc.get_object(sid).unwrap().as_stream().unwrap().content.clone()).unwrap();
        assert!(s.contains("/Helv 12.0000 Tf"), "{s}");
        assert!(s.contains("(Hello) Tj"), "{s}");
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
        use image::{DynamicImage, ImageBuffer, Rgba};
        let mut img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::new(2, 2);
        for p in img.pixels_mut() {
            *p = Rgba([255, 0, 0, 255]);
        }
        let mut png_buf: Vec<u8> = Vec::new();
        DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png_buf), image::ImageFormat::Png)
            .unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png_buf);

        let ann = SignatureAnnotation {
            page: 1,
            x: 10.0,
            y: 10.0,
            width: 50.0,
            height: 20.0,
            image_data: b64,
            vector: None,
            color: None,
        };

        let mut doc = Document::new();
        let mut ops_buf: Vec<u8> = Vec::new();
        let (name, _img_id, _smask) = write_image(&mut ops_buf, &ann, &mut doc).unwrap();

        let s = String::from_utf8(ops_buf).unwrap();
        assert!(s.contains("Do"), "missing XObject Do operator");
        assert!(s.contains(" cm\n"), "missing transformation matrix");
        assert!(s.contains(&name), "resource name not in content stream");
    }

    #[test]
    fn a_drawn_signature_is_written_as_curves_not_a_picture() {
        let ann = SignatureAnnotation {
            page: 1,
            x: 10.0,
            y: 20.0,
            width: 100.0,
            height: 40.0,
            image_data: String::new(),
            vector: Some(InkVector { w: 50.0, h: 20.0, segs: vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 2.5] }),
            color: None,
        };
        assert!(write_vector_ok(ann.vector.as_ref().unwrap()));
        let mut buf = Vec::new();
        write_signature_vector(&mut buf, &ann);
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("2.000000 0 0 -2.000000 10.0000 60.0000 cm"), "{s}");
        assert!(s.contains("2.500 w\n1.00 2.00 m\n3.00 4.00 5.00 6.00 7.00 8.00 c\nS"), "{s}");
        assert!(s.contains("1 J"));
        assert!(!s.contains("Do"));
    }

    #[test]
    fn a_broken_vector_falls_back_to_the_picture() {
        let bad = |w: f64, segs: Vec<f64>| InkVector { w, h: 1.0, segs };
        assert!(!write_vector_ok(&bad(0.0, vec![0.0; 9])));
        assert!(!write_vector_ok(&bad(1.0, vec![0.0; 8])));
        assert!(!write_vector_ok(&bad(1.0, vec![])));
        assert!(!write_vector_ok(&bad(1.0, [vec![0.0; 8], vec![f64::NAN]].concat())));
    }

    #[test]
    fn signatures_without_a_vector_still_read() {
        let json = r#"{"page":1,"x":0,"y":0,"width":1,"height":1,"imageData":"AAAA"}"#;
        let ann: SignatureAnnotation = serde_json::from_str(json).unwrap();
        assert!(ann.vector.is_none());
        assert!(!serde_json::to_string(&ann).unwrap().contains("vector"));
    }

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

    #[test]
    fn test_write_form_fields_inline_acroform() {
        use lopdf::dictionary;

        let (mut doc, cat_id) = make_doc_with_catalog();

        let text_field_id = doc.add_object(dictionary! {
            b"T" => Object::String(b"Field1".to_vec(), StringFormat::Literal),
            b"FT" => Object::Name(b"Tx".to_vec()),
        });

        if let Ok(Object::Dictionary(cat)) = doc.get_object_mut(cat_id) {
            cat.set(
                b"AcroForm",
                dictionary! {
                    b"Fields" => vec![Object::Reference(text_field_id)],
                },
            );
        }

        let fields = vec![FormFieldValue { name: "Field1".into(), value: "Bob".into() }];
        write_form_fields(&mut doc, &fields).unwrap();

        let tf = doc.get_object(text_field_id).unwrap().as_dict().unwrap();
        match tf.get(b"V").unwrap() {
            Object::String(s, _) => assert_eq!(s, b"Bob"),
            other => panic!("expected String for text /V, got {:?}", other),
        }
    }

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

        let fields = vec![FormFieldValue { name: "Name1".into(), value: "Hello World".into() }];
        write_form_fields(&mut doc, &fields).unwrap();

        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        let doc2 = Document::load_mem(&buf).unwrap();

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

    #[test]
    fn test_write_form_fields_pdfdocencoding_name() {
        use lopdf::dictionary;

        let (mut doc, cat_id) = make_doc_with_catalog();

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

        let fields = vec![FormFieldValue { name: "\u{00C9}tat".into(), value: "test".into() }];
        write_form_fields(&mut doc, &fields).unwrap();

        let tf = doc.get_object(text_field_id).unwrap().as_dict().unwrap();
        match tf.get(b"V").unwrap() {
            Object::String(s, _) => assert_eq!(s, b"test"),
            other => panic!("expected String for text /V, got {:?}", other),
        }
    }

    #[test]
    fn test_write_form_fields_utf16be_name() {
        use lopdf::dictionary;

        let (mut doc, cat_id) = make_doc_with_catalog();

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

        let fields = vec![FormFieldValue { name: "\u{00C9}tat".into(), value: "test16".into() }];
        write_form_fields(&mut doc, &fields).unwrap();

        let tf = doc.get_object(text_field_id).unwrap().as_dict().unwrap();
        match tf.get(b"V").unwrap() {
            Object::String(s, _) => assert_eq!(s, b"test16"),
            other => panic!("expected String for text /V, got {:?}", other),
        }
    }

    #[test]
    fn test_save_strip_roundtrip() {
        use lopdf::dictionary;

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
            page: 1,
            x: 50.0,
            y: 300.0,
            width: 200.0,
            content: "Hello".to_string(),
            color: black(),
            font_size: 12.0,
            bold: false,
            italic: false,
            underline: false,
            alignment: TextAlignment::Left,
            font_family: FontFamily::Helvetica,
            font_name: None,
            background_color: None,
            cover: None,
        });

        let mut meta = load_meta(&doc);
        let existing = meta.layer(1);
        let sid = write_annotations_for_page(&mut doc, page_id, std::slice::from_ref(&ann), existing)
            .unwrap()
            .expect("should return a stream id");

        meta.annotations = vec![ann];
        meta.set_layers([(1, sid)]);
        save_meta(&mut doc, &meta).unwrap();

        let tmp = std::env::temp_dir().join("test_roundtrip.pdf");
        doc.save(&tmp).unwrap();
        let doc2 = Document::load(&tmp).unwrap();

        let meta2 = load_meta(&doc2);
        assert_eq!(meta2.annotations.len(), 1, "should read back 1 annotation");
        assert!(meta2.layer(1).is_some(), "should have stream id for page 1");

        let sid2 = meta2.layer(1).unwrap();
        let stream_obj = doc2.get_object(sid2).unwrap();
        let stream = stream_obj.as_stream().unwrap();
        assert!(!stream.content.is_empty(), "annotation stream should have content before strip");

        let mut doc3 = Document::load(&tmp).unwrap();
        let meta3 = load_meta(&doc3);
        clear_annotation_streams(&mut doc3, &meta3).unwrap();
        let stream_obj3 = doc3.get_object(sid2).unwrap();
        let stream3 = stream_obj3.as_stream().unwrap();
        assert!(stream3.content.is_empty(), "annotation stream should be empty after strip");

        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn test_double_save_no_duplicate_streams() {
        use lopdf::dictionary;

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
            page: 1,
            x: 50.0,
            y: 300.0,
            width: 200.0,
            content: "Hello".to_string(),
            color: black(),
            font_size: 12.0,
            bold: false,
            italic: false,
            underline: false,
            alignment: TextAlignment::Left,
            font_family: FontFamily::Helvetica,
            font_name: None,
            background_color: None,
            cover: None,
        });

        let mut meta = load_meta(&doc);
        let existing = meta.layer(1);
        let sid = write_annotations_for_page(&mut doc, page_id, std::slice::from_ref(&ann), existing).unwrap().unwrap();
        meta.annotations = vec![ann.clone()];
        meta.set_layers([(1, sid)]);
        save_meta(&mut doc, &meta).unwrap();

        let tmp = std::env::temp_dir().join("test_double_save.pdf");
        doc.save(&tmp).unwrap();

        let mut doc2 = Document::load(&tmp).unwrap();
        let meta2 = load_meta(&doc2);
        let pages2 = doc2.get_pages();
        let page_id2 = *pages2.get(&1).unwrap();
        let existing2 = meta2.layer(1);
        let sid2 =
            write_annotations_for_page(&mut doc2, page_id2, std::slice::from_ref(&ann), existing2).unwrap().unwrap();
        let new_meta = AnnotationMeta::new(vec![ann], [(1, sid2)]);
        save_meta(&mut doc2, &new_meta).unwrap();
        doc2.save(&tmp).unwrap();

        let doc3 = Document::load(&tmp).unwrap();
        let pages3 = doc3.get_pages();
        let page_id3 = *pages3.get(&1).unwrap();
        let page_dict = doc3.get_object(page_id3).unwrap().as_dict().unwrap();
        let contents = page_dict.get(b"Contents").unwrap();
        match contents {
            Object::Array(arr) => {
                assert_eq!(
                    arr.len(),
                    2,
                    "Contents should have exactly 2 entries (original + annotation), got {}",
                    arr.len()
                );
            }
            _ => panic!("Contents should be an array after append"),
        }

        let mut doc4 = Document::load(&tmp).unwrap();
        let meta4 = load_meta(&doc4);
        assert_eq!(meta4.annotations.len(), 1);
        clear_annotation_streams(&mut doc4, &meta4).unwrap();
        let sid4 = meta4.layer(1).unwrap();
        let s = doc4.get_object(sid4).unwrap().as_stream().unwrap();
        assert!(s.content.is_empty(), "annotation stream should be empty after strip");

        let _ = std::fs::remove_file(&tmp);
    }
}
