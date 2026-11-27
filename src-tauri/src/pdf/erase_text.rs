use std::collections::{BTreeMap, HashSet};

use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};

#[derive(Debug, Clone, Copy)]
pub struct Area {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

impl Area {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Area { x0: x.min(x + width), y0: y.min(y + height), x1: x.max(x + width), y1: y.max(y + height) }
    }
}

const MAX_CONTENT: usize = 64 * 1024 * 1024;

type Matrix = [f64; 6];
const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

fn mul(a: &Matrix, b: &Matrix) -> Matrix {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

fn apply(m: &Matrix, x: f64, y: f64) -> (f64, f64) {
    (x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5])
}

fn num(o: &Object) -> Option<f64> {
    match o {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(f64::from(*r)),
        _ => None,
    }
}

fn nums<const N: usize>(ops: &[Object]) -> Option<[f64; N]> {
    if ops.len() < N {
        return None;
    }
    let mut out = [0.0; N];
    for (i, o) in ops[ops.len() - N..].iter().enumerate() {
        out[i] = num(o)?;
    }
    Some(out)
}

struct Widths {
    two_byte: bool,
    simple: BTreeMap<u32, f64>,
    cid: Vec<(u32, u32, f64)>,
    default: f64,
}

impl Widths {
    fn of(doc: &Document, font: &Dictionary) -> Self {
        let deref = |o: &Object| -> Option<Object> {
            match o {
                Object::Reference(id) => doc.get_object(*id).ok().cloned(),
                other => Some(other.clone()),
            }
        };
        let is_type0 = font.get(b"Subtype").and_then(Object::as_name).is_ok_and(|n| n == b"Type0");
        if is_type0 {
            let mut w = Widths { two_byte: true, simple: BTreeMap::new(), cid: Vec::new(), default: 1000.0 };
            let descendant = font
                .get(b"DescendantFonts")
                .ok()
                .and_then(deref)
                .and_then(|a| a.as_array().ok().and_then(|a| a.first().cloned()))
                .and_then(|d| deref(&d))
                .and_then(|d| d.as_dict().ok().cloned());
            if let Some(d) = descendant {
                if let Some(dw) = d.get(b"DW").ok().and_then(num) {
                    w.default = dw;
                }
                if let Some(Object::Array(arr)) = d.get(b"W").ok().and_then(deref) {
                    let mut i = 0;
                    while i < arr.len() {
                        let Some(first) = num(&arr[i]) else { break };
                        match arr.get(i + 1).and_then(deref) {
                            Some(Object::Array(list)) => {
                                for (k, v) in list.iter().enumerate() {
                                    if let Some(v) = num(v) {
                                        let c = first as u32 + k as u32;
                                        w.cid.push((c, c, v));
                                    }
                                }
                                i += 2;
                            }
                            Some(last) => {
                                if let (Some(last), Some(v)) = (num(&last), arr.get(i + 2).and_then(num)) {
                                    w.cid.push((first as u32, last as u32, v));
                                }
                                i += 3;
                            }
                            None => break,
                        }
                    }
                }
            }
            return w;
        }
        let mut w = Widths { two_byte: false, simple: BTreeMap::new(), cid: Vec::new(), default: 500.0 };
        let first = font.get(b"FirstChar").ok().and_then(num).unwrap_or(0.0) as u32;
        if let Some(Object::Array(arr)) = font.get(b"Widths").ok().and_then(deref) {
            for (k, v) in arr.iter().enumerate() {
                if let Some(v) = deref(v).as_ref().and_then(num) {
                    w.simple.insert(first + k as u32, v);
                }
            }
        }
        if let Some(mw) = font
            .get(b"FontDescriptor")
            .ok()
            .and_then(deref)
            .and_then(|d| d.as_dict().ok().and_then(|d| d.get(b"MissingWidth").ok().and_then(num)))
        {
            w.default = mw;
        }
        w
    }

    fn codes(&self, bytes: &[u8]) -> Vec<u32> {
        if self.two_byte {
            bytes
                .chunks(2)
                .map(|c| if c.len() == 2 { u32::from(c[0]) << 8 | u32::from(c[1]) } else { u32::from(c[0]) })
                .collect()
        } else {
            bytes.iter().map(|&b| u32::from(b)).collect()
        }
    }

    fn width(&self, code: u32) -> f64 {
        if self.two_byte {
            self.cid.iter().find(|(a, b, _)| *a <= code && code <= *b).map(|(_, _, w)| *w).unwrap_or(self.default)
        } else {
            self.simple.get(&code).copied().unwrap_or(self.default)
        }
    }
}

#[derive(Clone)]
struct TextState {
    font: Option<Vec<u8>>,
    size: f64,
    char_space: f64,
    word_space: f64,
    scale: f64,
    leading: f64,
}

impl Default for TextState {
    fn default() -> Self {
        TextState { font: None, size: 0.0, char_space: 0.0, word_space: 0.0, scale: 1.0, leading: 0.0 }
    }
}

struct Walker<'a> {
    doc: &'a Document,
    fonts: BTreeMap<Vec<u8>, &'a Dictionary>,
    widths: BTreeMap<Vec<u8>, Widths>,
    areas: &'a [Area],
    ctm: Matrix,
    stack: Vec<(Matrix, TextState)>,
    ts: TextState,
    tm: Matrix,
    tlm: Matrix,
    erased: usize,
}

impl<'a> Walker<'a> {
    fn widths(&mut self) -> &Widths {
        let key = self.ts.font.clone().unwrap_or_default();
        if !self.widths.contains_key(&key) {
            let w = match self.fonts.get(&key) {
                Some(f) => Widths::of(self.doc, f),
                None => Widths { two_byte: false, simple: BTreeMap::new(), cid: Vec::new(), default: 500.0 },
            };
            self.widths.insert(key.clone(), w);
        }
        &self.widths[&key]
    }

    fn advance(&mut self, bytes: &[u8]) -> f64 {
        let (size, cs, ws) = (self.ts.size, self.ts.char_space, self.ts.word_space);
        let w = self.widths();
        let two = w.two_byte;
        w.codes(bytes)
            .into_iter()
            .map(|c| w.width(c) / 1000.0 * size + cs + if !two && c == 32 { ws } else { 0.0 })
            .sum()
    }

    fn shift(&mut self, tx: f64) {
        self.tm = mul(&[1.0, 0.0, 0.0, 1.0, tx * self.ts.scale, 0.0], &self.tm);
    }

    fn hidden(&self, adv: f64) -> bool {
        let m = mul(&self.tm, &self.ctm);
        let (sx, sy) = apply(&m, 0.0, 0.0);
        let (ex, ey) = apply(&m, adv * self.ts.scale, 0.0);
        let len = ((ex - sx).powi(2) + (ey - sy).powi(2)).sqrt();
        self.areas.iter().any(|a| {
            let my = (sy + ey) / 2.0;
            if my < a.y0 || my > a.y1 {
                return false;
            }
            if len < 0.01 {
                return sx >= a.x0 && sx <= a.x1;
            }
            let (lo, hi) = (sx.min(ex), sx.max(ex));
            let inside = (hi.min(a.x1) - lo.max(a.x0)).max(0.0);
            inside >= (hi - lo) * 0.5
        })
    }

    fn show(&mut self, bytes: &[u8]) -> Object {
        let adv = self.advance(bytes);
        let hide = self.hidden(adv);
        self.shift(adv);
        if hide && self.ts.size.abs() > f64::EPSILON {
            self.erased += 1;
            Object::Real((-(adv * 1000.0 / self.ts.size)) as f32)
        } else {
            Object::String(bytes.to_vec(), lopdf::StringFormat::Literal)
        }
    }

    fn next_line(&mut self) {
        self.tlm = mul(&[1.0, 0.0, 0.0, 1.0, 0.0, -self.ts.leading], &self.tlm);
        self.tm = self.tlm;
    }

    fn step(&mut self, op: Operation) -> Vec<Operation> {
        let o = &op.operands;
        match op.operator.as_str() {
            "q" => self.stack.push((self.ctm, self.ts.clone())),
            "Q" => {
                if let Some((m, ts)) = self.stack.pop() {
                    self.ctm = m;
                    self.ts = ts;
                }
            }
            "cm" => {
                if let Some(m) = nums::<6>(o) {
                    self.ctm = mul(&m, &self.ctm);
                }
            }
            "BT" => {
                self.tm = IDENTITY;
                self.tlm = IDENTITY;
            }
            "Tf" => {
                if let (Some(Object::Name(n)), Some(s)) = (o.first(), o.get(1).and_then(num)) {
                    self.ts.font = Some(n.clone());
                    self.ts.size = s;
                }
            }
            "Tc" => self.ts.char_space = nums::<1>(o).map_or(0.0, |v| v[0]),
            "Tw" => self.ts.word_space = nums::<1>(o).map_or(0.0, |v| v[0]),
            "Tz" => self.ts.scale = nums::<1>(o).map_or(100.0, |v| v[0]) / 100.0,
            "TL" => self.ts.leading = nums::<1>(o).map_or(0.0, |v| v[0]),
            "Td" | "TD" => {
                if let Some([tx, ty]) = nums::<2>(o) {
                    if op.operator == "TD" {
                        self.ts.leading = -ty;
                    }
                    self.tlm = mul(&[1.0, 0.0, 0.0, 1.0, tx, ty], &self.tlm);
                    self.tm = self.tlm;
                }
            }
            "Tm" => {
                if let Some(m) = nums::<6>(o) {
                    self.tm = m;
                    self.tlm = m;
                }
            }
            "T*" => self.next_line(),
            "Tj" | "'" | "\"" => {
                let mut pre = Vec::new();
                if op.operator == "\"" {
                    if let Some([aw, ac]) = o.get(..2).and_then(nums::<2>) {
                        self.ts.word_space = aw;
                        self.ts.char_space = ac;
                    }
                }
                if op.operator != "Tj" {
                    self.next_line();
                }
                let Some(Object::String(bytes, _)) = o.last() else { return vec![op] };
                let kept = self.show(&bytes.clone());
                if matches!(kept, Object::String(..)) {
                    return vec![op];
                }
                if op.operator == "\"" {
                    pre.push(Operation::new("Tw", vec![o[0].clone()]));
                    pre.push(Operation::new("Tc", vec![o[1].clone()]));
                }
                if op.operator != "Tj" {
                    pre.push(Operation::new("T*", vec![]));
                }
                pre.push(Operation::new("TJ", vec![Object::Array(vec![kept])]));
                return pre;
            }
            "TJ" => {
                let Some(Object::Array(items)) = o.first() else { return vec![op] };
                let before = self.erased;
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    match item {
                        Object::String(bytes, _) => {
                            let kept = self.show(bytes);
                            out.push(if matches!(kept, Object::String(..)) { item.clone() } else { kept });
                        }
                        other => {
                            if let Some(n) = num(other) {
                                self.shift(-n / 1000.0 * self.ts.size);
                            }
                            out.push(other.clone());
                        }
                    }
                }
                if self.erased == before {
                    return vec![op];
                }
                return vec![Operation::new("TJ", vec![Object::Array(out)])];
            }
            _ => {}
        }
        vec![op]
    }
}

pub fn erase_text(
    doc: &mut Document,
    page_id: ObjectId,
    areas: &[Area],
    keep: &HashSet<ObjectId>,
) -> Result<usize, String> {
    if areas.is_empty() {
        return Ok(0);
    }
    let streams = doc.get_page_contents(page_id);
    let (ours, theirs): (Vec<ObjectId>, Vec<ObjectId>) = streams.iter().partition(|id| keep.contains(id));
    if theirs.is_empty() {
        return Ok(0);
    }
    let mut data = Vec::new();
    for id in &theirs {
        let Ok(stream) = doc.get_object(*id).and_then(Object::as_stream) else { return Ok(0) };
        let bytes = if stream.dict.has(b"Filter") {
            match stream.decompressed_content_with_limit(MAX_CONTENT.saturating_sub(data.len())) {
                Ok(b) => b,
                Err(_) => return Ok(0),
            }
        } else {
            stream.content.clone()
        };
        data.extend_from_slice(&bytes);
        data.push(b'\n');
        if data.len() > MAX_CONTENT {
            return Ok(0);
        }
    }
    let Ok(content) = Content::decode(&data) else { return Ok(0) };
    if content.operations.iter().any(|op| op.operator == "BI") {
        return Ok(0);
    }

    let fonts = doc.get_page_fonts(page_id).unwrap_or_default();
    let mut walker = Walker {
        doc,
        fonts,
        widths: BTreeMap::new(),
        areas,
        ctm: IDENTITY,
        stack: Vec::new(),
        ts: TextState::default(),
        tm: IDENTITY,
        tlm: IDENTITY,
        erased: 0,
    };
    let mut ops = Vec::with_capacity(content.operations.len());
    for op in content.operations {
        ops.extend(walker.step(op));
    }
    let erased = walker.erased;
    if erased == 0 {
        return Ok(0);
    }

    let encoded = Content { operations: ops }.encode().map_err(|e| e.to_string())?;
    let mut stream = Stream::new(Dictionary::new(), encoded);
    let _ = stream.compress();
    let new_id = doc.add_object(Object::Stream(stream));
    let mut refs = vec![Object::Reference(new_id)];
    refs.extend(ours.into_iter().map(Object::Reference));
    let page = doc.get_object_mut(page_id).and_then(Object::as_dict_mut).map_err(|e| e.to_string())?;
    page.set("Contents", Object::Array(refs));
    Ok(erased)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    fn page_with(content: &str) -> (Document, ObjectId) {
        let mut doc = Document::with_version("1.7");
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
            "FirstChar" => 32,
            "Widths" => (32..=126).map(|_| Object::Integer(500)).collect::<Vec<_>>(),
        });
        let content_id = doc.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
        let pages_id = doc.new_object_id();
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 600.into(), 800.into()],
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font_id } },
            "Contents" => content_id,
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1,
            }),
        );
        let cat = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", cat);
        (doc, page_id)
    }

    fn text_of(doc: &Document, page_id: ObjectId) -> String {
        String::from_utf8_lossy(&doc.get_page_content(page_id)).into_owned()
    }

    #[test]
    fn removes_the_covered_line_and_keeps_the_others() {
        let (mut doc, page) = page_with("BT /F1 10 Tf 100 500 Td (Secret) Tj 0 -20 Td (Public) Tj ET");
        let n = erase_text(&mut doc, page, &[Area::new(99.0, 497.0, 32.0, 12.0)], &HashSet::new()).unwrap();
        assert_eq!(n, 1);
        let s = text_of(&doc, page);
        assert!(!s.contains("Secret"), "{s}");
        assert!(s.contains("Public"), "{s}");
    }

    #[test]
    fn keeps_the_rest_of_a_line_in_place() {
        let (mut doc, page) = page_with("BT /F1 10 Tf 1 0 0 1 100 500 Tm [(Hello ) -200 (world)] TJ ET");
        erase_text(&mut doc, page, &[Area::new(99.0, 497.0, 31.0, 12.0)], &HashSet::new()).unwrap();
        let s = text_of(&doc, page);
        assert!(!s.contains("Hello"), "{s}");
        assert!(s.contains("world"), "{s}");
        assert!(s.contains("-300"), "the removed string becomes a 300 move: {s}");
    }

    #[test]
    fn follows_the_transform_and_leaves_other_streams() {
        let (mut doc, page) = page_with("q 1 0 0 1 50 50 cm BT /F1 10 Tf 50 450 Td (Moved) Tj ET Q");
        let layer = doc.add_object(Stream::new(dictionary! {}, b"BT /F1 10 Tf 100 500 Td (Mine) Tj ET".to_vec()));
        let original = doc.get_page_contents(page)[0];
        doc.get_object_mut(page)
            .and_then(Object::as_dict_mut)
            .unwrap()
            .set("Contents", vec![original.into(), layer.into()]);
        let keep: HashSet<ObjectId> = [layer].into_iter().collect();
        let n = erase_text(&mut doc, page, &[Area::new(99.0, 497.0, 30.0, 12.0)], &keep).unwrap();
        assert_eq!(n, 1);
        let s = text_of(&doc, page);
        assert!(!s.contains("Moved"), "{s}");
        assert!(s.contains("Mine"), "our own layer stays: {s}");
    }

    #[test]
    fn leaves_text_outside_the_areas_alone() {
        let (mut doc, page) = page_with("BT /F1 10 Tf 100 500 Td (Keep) Tj ET");
        let before = doc.get_page_contents(page);
        assert_eq!(erase_text(&mut doc, page, &[Area::new(300.0, 100.0, 20.0, 10.0)], &HashSet::new()).unwrap(), 0);
        assert_eq!(doc.get_page_contents(page), before);
    }

    fn page_with_font(content: &str, font: Dictionary) -> (Document, ObjectId) {
        let (mut doc, page) = page_with(content);
        let font_id = doc.add_object(font);
        let page_dict = doc.get_object_mut(page).unwrap().as_dict_mut().unwrap();
        page_dict.set("Resources", dictionary! { "Font" => dictionary! { "F1" => font_id } });
        (doc, page)
    }

    #[test]
    fn measures_two_byte_fonts_from_their_widths() {
        let mut doc = Document::with_version("1.7");
        let widths = doc.add_object(Object::Array(vec![
            1.into(),
            Object::Array(vec![600.into(), 700.into()]),
            10.into(),
            20.into(),
            400.into(),
        ]));
        let descendant =
            doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "CIDFontType2", "DW" => 1000, "W" => widths });
        let font = dictionary! { "Type" => "Font", "Subtype" => "Type0", "BaseFont" => "Noto", "DescendantFonts" => vec![descendant.into()] };
        let w = Widths::of(&doc, &font);
        assert!(w.two_byte);
        assert_eq!(w.codes(&[0, 1, 0, 2, 0, 15, 7]), vec![1, 2, 15, 7]);
        assert_eq!(w.width(1), 600.0);
        assert_eq!(w.width(2), 700.0);
        assert_eq!(w.width(15), 400.0);
        assert_eq!(w.width(99), 1000.0);

        let content = "BT /F1 10 Tf 100 500 Td <00010002> Tj 0 -20 Td <000A000B> Tj ET";
        let (mut doc, page) = page_with_font(
            content,
            dictionary! { "Type" => "Font", "Subtype" => "Type0", "BaseFont" => "Noto", "DescendantFonts" => vec![Object::Dictionary(dictionary! { "DW" => 500 })] },
        );
        let mostly_outside = Area::new(96.0, 497.0, 7.0, 12.0);
        assert_eq!(erase_text(&mut doc, page, &[mostly_outside], &HashSet::new()).unwrap(), 0);
        let n = erase_text(&mut doc, page, &[Area::new(99.0, 497.0, 12.0, 12.0)], &HashSet::new()).unwrap();
        assert_eq!(n, 1);
        let content = Content::decode(&doc.get_page_content(page)).unwrap();
        let strings: Vec<Vec<u8>> = content
            .operations
            .iter()
            .flat_map(|op| op.operands.iter())
            .flat_map(|o| match o {
                Object::Array(a) => a.clone(),
                other => vec![other.clone()],
            })
            .filter_map(|o| if let Object::String(b, _) = o { Some(b) } else { None })
            .collect();
        assert_eq!(strings, vec![vec![0, 10, 0, 11]]);
    }

    #[test]
    fn simple_fonts_fall_back_to_the_missing_width() {
        let mut doc = Document::with_version("1.7");
        let widths = doc.add_object(Object::Array(vec![250.into(), Object::Real(333.5)]));
        let descriptor = doc.add_object(dictionary! { "MissingWidth" => 777 });
        let font = dictionary! { "Subtype" => "TrueType", "FirstChar" => 65, "Widths" => widths, "FontDescriptor" => descriptor };
        let w = Widths::of(&doc, &font);
        assert!(!w.two_byte);
        assert_eq!(w.width(65), 250.0);
        assert_eq!(w.width(66), 333.5);
        assert_eq!(w.width(67), 777.0);
    }

    #[test]
    fn follows_line_operators_to_find_each_line() {
        let content = "BT /F1 10 Tf 14 TL 100 500 Td (Keep) Tj T* (Lose) Tj (Gone) ' 2 1 (Also) \" 0 -14 TD (Stay) Tj T* (Last) Tj ET";
        let (mut doc, page) = page_with(content);
        let n = erase_text(
            &mut doc,
            page,
            &[
                Area::new(99.0, 483.0, 30.0, 12.0),
                Area::new(99.0, 469.0, 30.0, 12.0),
                Area::new(99.0, 455.0, 30.0, 12.0),
            ],
            &HashSet::new(),
        )
        .unwrap();
        assert_eq!(n, 3);
        let s = text_of(&doc, page);
        for kept in ["Keep", "Stay", "Last"] {
            assert!(s.contains(kept), "{kept} missing: {s}");
        }
        for gone in ["Lose", "Gone", "Also"] {
            assert!(!s.contains(gone), "{gone} still there: {s}");
        }
        assert!(s.contains("Tw") && s.contains("Tc"), "the \\\" spacing is kept: {s}");
    }

    #[test]
    fn leaves_pages_it_cannot_safely_rewrite() {
        let (mut doc, page) = page_with("BT /F1 10 Tf 100 500 Td (Secret) Tj ET");
        assert_eq!(erase_text(&mut doc, page, &[], &HashSet::new()).unwrap(), 0);
        let contents = doc.get_page_contents(page);
        let keep: HashSet<ObjectId> = contents.iter().copied().collect();
        assert_eq!(erase_text(&mut doc, page, &[Area::new(0.0, 0.0, 600.0, 800.0)], &keep).unwrap(), 0);

        let (mut doc, page) = page_with("BT /F1 10 Tf 100 500 Td (Secret) Tj ET BI /W 1 /H 1 /CS /G /BPC 8 ID \x00 EI");
        assert_eq!(erase_text(&mut doc, page, &[Area::new(0.0, 0.0, 600.0, 800.0)], &HashSet::new()).unwrap(), 0);
        assert!(text_of(&doc, page).contains("Secret"));
    }
}
