use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RgbColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl RgbColor {
    /// Normalize channel to 0.0–1.0 for PDF operators.
    pub fn r_f(&self) -> f64 { self.r as f64 / 255.0 }
    pub fn g_f(&self) -> f64 { self.g as f64 / 255.0 }
    pub fn b_f(&self) -> f64 { self.b as f64 / 255.0 }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub enum TextAlignment {
    Left,
    Center,
    Right,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RectAnnotation {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub color: RgbColor,
    pub stroke_width: f64,
    /// Interior colour; `None` (and files saved before fills existed) means hollow.
    #[serde(default)]
    pub fill_color: Option<RgbColor>,
    /// 0–1; absent means opaque.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CircleAnnotation {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub color: RgbColor,
    pub stroke_width: f64,
    /// Interior colour; `None` (and files saved before fills existed) means hollow.
    #[serde(default)]
    pub fill_color: Option<RgbColor>,
    /// 0–1; absent means opaque.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
}

/// One of the PDF standard fonts, which every viewer has without embedding.
#[derive(Debug, Serialize, Deserialize, Clone, Copy, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FontFamily {
    #[default]
    Helvetica,
    Times,
    Courier,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TextAnnotation {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub content: String,
    pub color: RgbColor,
    pub font_size: f64,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub alignment: TextAlignment,
    /// Absent in files saved before font choice existed.
    #[serde(default)]
    pub font_family: FontFamily,
    /// Box colour behind the text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_color: Option<RgbColor>,
    /// Edited text: the area of the original words, painted over first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<TextCover>,
}

/// Area painted with the page's own colour under edited text, so the
/// original words no longer show.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TextCover {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub color: RgbColor,
}

/// Pencil stroke, straight line or arrow. `points` are relative to the box
/// (0–1 from its left and bottom edges).
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InkAnnotation {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub points: Vec<[f64; 2]>,
    pub color: RgbColor,
    pub stroke_width: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill_color: Option<RgbColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    #[serde(default)]
    pub arrow: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PdfRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Highlighted text, one rectangle per line (absolute PDF points).
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HighlightAnnotation {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rects: Vec<PdfRect>,
    pub color: RgbColor,
    pub opacity: f64,
}

/// Sticky note: a coloured square with text.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoteAnnotation {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub content: String,
    pub color: RgbColor,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SignatureAnnotation {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Base64-encoded PNG (no data: URI prefix).
    pub image_data: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StampMark {
    Check,
    Cross,
}

/// A check mark or a cross, drawn in its box.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StampAnnotation {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub mark: StampMark,
    pub color: RgbColor,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Annotation {
    Rect(RectAnnotation),
    Circle(CircleAnnotation),
    Ink(InkAnnotation),
    Highlight(HighlightAnnotation),
    Note(NoteAnnotation),
    Text(TextAnnotation),
    Signature(SignatureAnnotation),
    /// A picture placed on the page (same fields as a signature).
    Image(SignatureAnnotation),
    Stamp(StampAnnotation),
}

impl Annotation {
    pub fn page(&self) -> u32 {
        match self {
            Annotation::Rect(a) => a.page,
            Annotation::Circle(a) => a.page,
            Annotation::Ink(a) => a.page,
            Annotation::Highlight(a) => a.page,
            Annotation::Note(a) => a.page,
            Annotation::Text(a) => a.page,
            Annotation::Signature(a) | Annotation::Image(a) => a.page,
            Annotation::Stamp(a) => a.page,
        }
    }

    pub fn set_page(&mut self, p: u32) {
        match self {
            Annotation::Rect(a) => a.page = p,
            Annotation::Circle(a) => a.page = p,
            Annotation::Ink(a) => a.page = p,
            Annotation::Highlight(a) => a.page = p,
            Annotation::Note(a) => a.page = p,
            Annotation::Text(a) => a.page = p,
            Annotation::Signature(a) | Annotation::Image(a) => a.page = p,
            Annotation::Stamp(a) => a.page = p,
        }
    }
}
