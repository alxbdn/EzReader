use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RgbColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl RgbColor {
    pub fn r_f(&self) -> f64 {
        self.r as f64 / 255.0
    }
    pub fn g_f(&self) -> f64 {
        self.g as f64 / 255.0
    }
    pub fn b_f(&self) -> f64 {
        self.b as f64 / 255.0
    }
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
    #[serde(default)]
    pub fill_color: Option<RgbColor>,
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
    #[serde(default)]
    pub fill_color: Option<RgbColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
}

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
    #[serde(default)]
    pub font_family: FontFamily,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_color: Option<RgbColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<TextCover>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TextCover {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub color: RgbColor,
}

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
    pub image_data: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vector: Option<InkVector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<RgbColor>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InkVector {
    pub w: f64,
    pub h: f64,
    pub segs: Vec<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StampMark {
    Check,
    Cross,
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_kind_reports_and_moves_its_page() {
        let color = json!({ "r": 1, "g": 2, "b": 3 });
        let base = json!({ "page": 2, "x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0 });
        let with = |kind: &str, extra: serde_json::Value| {
            let mut v = base.clone();
            v["kind"] = json!(kind);
            for (k, val) in extra.as_object().unwrap() {
                v[k] = val.clone();
            }
            serde_json::from_value::<Annotation>(v).unwrap()
        };
        let shape = json!({ "color": color, "strokeWidth": 1.0 });
        let picture = json!({ "imageData": "" });
        let all = [
            with("rect", shape.clone()),
            with("circle", shape.clone()),
            with("ink", json!({ "color": color, "strokeWidth": 1.0, "points": [[0.0, 0.0], [1.0, 1.0]] })),
            with("highlight", json!({ "color": color, "opacity": 0.5, "rects": [] })),
            with("note", json!({ "color": color, "content": "n" })),
            with(
                "text",
                json!({ "color": color, "content": "t", "fontSize": 12.0, "bold": false, "italic": false, "underline": false, "alignment": "left" }),
            ),
            with("signature", picture.clone()),
            with("image", picture),
            with("stamp", json!({ "color": color, "mark": "check" })),
        ];
        for mut ann in all {
            assert_eq!(ann.page(), 2);
            ann.set_page(5);
            assert_eq!(ann.page(), 5);
        }
    }
}
