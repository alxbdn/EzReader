//! Filling AcroForm fields (PDF 32000-1 §12.7): the values typed in the
//! viewer are written to the fields, check boxes and radio buttons get the
//! state of each of their widgets, and text fields and combo boxes get a new
//! appearance, so the values show in every reader (macOS Preview, phones,
//! printers), not only in the ones that honour `/NeedAppearances`.
//!
//! Appearances are drawn in Helvetica with WinAnsi encoding, which covers
//! French and the other Western European languages. A value it can't draw
//! (Greek, Cyrillic, CJK…), a rotated widget or a list box keeps its value
//! and the form asks readers to redraw it (`/NeedAppearances true`).

use std::collections::HashMap;

use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream, StringFormat};

/// A form field name/value pair sent from the frontend.
#[derive(serde::Deserialize, Clone)]
pub struct FormFieldValue {
    pub name: String,
    /// Plain text for Tx/Ch, "true"/"false" for checkboxes, export value for radios.
    pub value: String,
}

// Field flags (§12.7.3.1, §12.7.4).
const FF_MULTILINE: i64 = 1 << 12;
const FF_PASSWORD: i64 = 1 << 13;
const FF_PUSHBUTTON: i64 = 1 << 16;
const FF_COMBO: i64 = 1 << 17;
const FF_COMB: i64 = 1 << 24;

/// One terminal field, with what it inherits from its ancestors.
struct Field {
    id: ObjectId,
    full_name: String,
    partial_name: String,
    ft: String,
    flags: i64,
    da: Option<String>,
    q: i64,
    max_len: i64,
    /// Widget annotations: the field itself when they are merged.
    widgets: Vec<ObjectId>,
}

#[derive(Clone)]
struct Inherited {
    name: String,
    ft: String,
    flags: i64,
    da: Option<String>,
    q: i64,
    max_len: i64,
}

/// Write user-supplied form field values into the document's AcroForm structure.
/// Silently succeeds if the document has no AcroForm or `fields` is empty.
pub fn write_form_fields(doc: &mut Document, fields: &[FormFieldValue]) -> Result<(), String> {
    if fields.is_empty() {
        return Ok(());
    }
    let values: HashMap<&str, &str> = fields.iter().map(|f| (f.name.as_str(), f.value.as_str())).collect();

    let Some(acroform_id) = acroform_id(doc)? else { return Ok(()) };

    let (field_refs, root) = {
        let dict = doc.get_object(acroform_id).and_then(Object::as_dict).map_err(|e| e.to_string())?;
        let refs = match dict.get(b"Fields") {
            Ok(Object::Array(arr)) => arr.clone(),
            _ => return Ok(()),
        };
        let root = Inherited {
            name: String::new(),
            ft: String::new(),
            flags: 0,
            da: dict.get(b"DA").ok().and_then(text_of),
            q: dict.get(b"Q").and_then(Object::as_i64).unwrap_or(0),
            max_len: 0,
        };
        (refs, root)
    };

    let mut terminals = Vec::new();
    let mut seen = std::collections::HashSet::new();
    collect_fields(doc, &field_refs, &root, &mut terminals, &mut seen, 0);

    let mut font: Option<ObjectId> = None;
    let mut needs_redraw = false;
    for field in &terminals {
        let value = values
            .get(field.full_name.as_str())
            .or_else(|| values.get(field.partial_name.as_str()))
            .copied();
        let Some(value) = value else { continue };
        match field.ft.as_str() {
            "Btn" => set_button(doc, field, value)?,
            "Tx" | "Ch" if !set_text(doc, field, value, &mut font)? => needs_redraw = true,
            _ => {}
        }
    }

    if needs_redraw {
        if let Ok(Object::Dictionary(d)) = doc.get_object_mut(acroform_id) {
            d.set(b"NeedAppearances", Object::Boolean(true));
        }
    }
    Ok(())
}

/// The AcroForm's object id, promoting an inline AcroForm to an object of its own.
fn acroform_id(doc: &mut Document) -> Result<Option<ObjectId>, String> {
    let cat_id = doc
        .trailer
        .get(b"Root")
        .and_then(Object::as_reference)
        .map_err(|_| "No catalog".to_string())?;
    let inline = {
        let dict = doc.get_object(cat_id).and_then(Object::as_dict).map_err(|e| e.to_string())?;
        match dict.get(b"AcroForm") {
            Ok(Object::Reference(id)) => return Ok(Some(*id)),
            Ok(Object::Dictionary(d)) => d.clone(),
            _ => return Ok(None),
        }
    };
    let new_id = doc.add_object(Object::Dictionary(inline));
    if let Ok(Object::Dictionary(cat)) = doc.get_object_mut(cat_id) {
        cat.set(b"AcroForm", Object::Reference(new_id));
    }
    Ok(Some(new_id))
}

/// Walks the field tree: a node with `/T` is a field, a kid without one is a
/// widget of its parent field.
fn collect_fields(
    doc: &Document,
    refs: &[Object],
    parent: &Inherited,
    out: &mut Vec<Field>,
    seen: &mut std::collections::HashSet<ObjectId>,
    depth: usize,
) {
    if depth > 32 {
        return; // a hostile tree
    }
    for r in refs {
        let Ok(id) = r.as_reference() else { continue };
        if !seen.insert(id) {
            continue;
        }
        let Ok(dict) = doc.get_object(id).and_then(Object::as_dict) else { continue };

        let partial = dict.get(b"T").ok().and_then(text_of).unwrap_or_default();
        let name = match (parent.name.is_empty(), partial.is_empty()) {
            (true, _) => partial.clone(),
            (false, true) => parent.name.clone(),
            (false, false) => format!("{}.{}", parent.name, partial),
        };
        let here = Inherited {
            name,
            ft: dict
                .get(b"FT")
                .and_then(Object::as_name)
                .ok()
                .map(|n| String::from_utf8_lossy(n).into_owned())
                .unwrap_or_else(|| parent.ft.clone()),
            flags: dict.get(b"Ff").and_then(Object::as_i64).unwrap_or(parent.flags),
            da: dict.get(b"DA").ok().and_then(text_of).or_else(|| parent.da.clone()),
            q: dict.get(b"Q").and_then(Object::as_i64).unwrap_or(parent.q),
            max_len: dict.get(b"MaxLen").and_then(Object::as_i64).unwrap_or(parent.max_len),
        };

        let kids: Vec<Object> = match dict.get(b"Kids") {
            Ok(Object::Array(a)) => a.clone(),
            Ok(Object::Reference(kid_ref)) => match doc.get_object(*kid_ref) {
                Ok(Object::Array(a)) => a.clone(),
                _ => Vec::new(),
            },
            _ => Vec::new(),
        };
        let kid_is_field = |o: &Object| {
            o.as_reference()
                .ok()
                .and_then(|k| doc.get_object(k).and_then(Object::as_dict).ok())
                .is_some_and(|d| d.has(b"T"))
        };

        if kids.is_empty() {
            out.push(make_field(id, &partial, &here, vec![id]));
        } else if kids.iter().any(kid_is_field) {
            collect_fields(doc, &kids, &here, out, seen, depth + 1);
        } else {
            let widgets = kids.iter().filter_map(|k| k.as_reference().ok()).collect();
            out.push(make_field(id, &partial, &here, widgets));
        }
    }
}

fn make_field(id: ObjectId, partial: &str, inh: &Inherited, widgets: Vec<ObjectId>) -> Field {
    Field {
        id,
        full_name: inh.name.clone(),
        partial_name: partial.to_string(),
        ft: inh.ft.clone(),
        flags: inh.flags,
        da: inh.da.clone(),
        q: inh.q,
        max_len: inh.max_len,
        widgets,
    }
}

// ── Check boxes and radio buttons ─────────────────────────────────────────────

/// The appearance states of a widget other than `Off`.
fn on_states(dict: &Dictionary) -> Vec<Vec<u8>> {
    let Ok(Object::Dictionary(ap)) = dict.get(b"AP") else { return Vec::new() };
    let Ok(Object::Dictionary(n)) = ap.get(b"N") else { return Vec::new() };
    n.iter().map(|(k, _)| k.clone()).filter(|k| k.as_slice() != b"Off").collect()
}

fn set_button(doc: &mut Document, field: &Field, value: &str) -> Result<(), String> {
    if field.flags & FF_PUSHBUTTON != 0 {
        return Ok(());
    }
    let states: Vec<Vec<Vec<u8>>> = field
        .widgets
        .iter()
        .map(|w| doc.get_object(*w).and_then(Object::as_dict).map(on_states).unwrap_or_default())
        .collect();

    // "true" is a check box turned on: its own on state (often /Yes, not always).
    let chosen: Vec<u8> = match value {
        "false" | "" | "Off" => b"Off".to_vec(),
        "true" => states.iter().flatten().next().cloned().unwrap_or_else(|| b"Yes".to_vec()),
        export => export.as_bytes().to_vec(),
    };
    let latin1 = latin1_bytes(value);

    if let Ok(Object::Dictionary(d)) = doc.get_object_mut(field.id) {
        d.set(b"V", Object::Name(chosen.clone()));
    }
    for (widget, on) in field.widgets.iter().zip(states.iter()) {
        let state = on
            .iter()
            .find(|s| **s == chosen || latin1.as_ref() == Some(*s))
            .cloned()
            .unwrap_or_else(|| b"Off".to_vec());
        if let Ok(Object::Dictionary(d)) = doc.get_object_mut(*widget) {
            if d.has(b"AP") || d.has(b"AS") {
                d.set(b"AS", Object::Name(state));
            }
        }
    }
    Ok(())
}

// ── Text fields and choice fields ─────────────────────────────────────────────

/// Sets the value and redraws each widget. False when a widget couldn't be
/// redrawn and readers must do it themselves.
fn set_text(doc: &mut Document, field: &Field, value: &str, font: &mut Option<ObjectId>) -> Result<bool, String> {
    let is_choice = field.ft == "Ch";
    let shown = if is_choice { choice_display(doc, field.id, value) } else { value.to_string() };

    if let Ok(Object::Dictionary(d)) = doc.get_object_mut(field.id) {
        d.set(b"V", text_string(value));
        // A rich text value would be shown instead of the new plain one.
        d.remove(b"RV");
        if is_choice {
            d.remove(b"I");
        }
    }

    if is_choice && field.flags & FF_COMBO == 0 {
        return Ok(false); // list box: readers draw the selection
    }
    let Some(encoded) = win_ansi(&shown) else { return Ok(false) };

    let mut all_drawn = true;
    for widget in &field.widgets {
        let Some(ap) = text_appearance(doc, *widget, field, &encoded) else {
            all_drawn = false;
            continue;
        };
        let font_id = *font.get_or_insert_with(|| {
            doc.add_object(dictionary! {
                "Type" => "Font",
                "Subtype" => "Type1",
                "BaseFont" => "Helvetica",
                "Encoding" => "WinAnsiEncoding",
            })
        });
        let (w, h, content) = ap;
        let stream = Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), Object::Real(w as f32), Object::Real(h as f32)],
                "Resources" => dictionary! { "Font" => dictionary! { "Helv" => font_id } },
            },
            content,
        );
        let ap_id = doc.add_object(stream);
        if let Ok(Object::Dictionary(d)) = doc.get_object_mut(*widget) {
            d.set(b"AP", dictionary! { "N" => ap_id });
        }
    }
    Ok(all_drawn)
}

/// What a combo box shows for an export value: its `/Opt` display text.
fn choice_display(doc: &Document, id: ObjectId, value: &str) -> String {
    let opts = doc
        .get_object(id)
        .and_then(Object::as_dict)
        .and_then(|d| d.get(b"Opt"))
        .and_then(|o| match o {
            Object::Reference(r) => doc.get_object(*r),
            o => Ok(o),
        })
        .and_then(Object::as_array);
    if let Ok(opts) = opts {
        for opt in opts {
            if let Ok(pair) = opt.as_array() {
                if pair.len() >= 2 && text_of(&pair[0]).as_deref() == Some(value) {
                    return text_of(&pair[1]).unwrap_or_else(|| value.to_string());
                }
            }
        }
    }
    value.to_string()
}

fn num(o: &Object) -> Option<f64> {
    match o {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(*r as f64),
        _ => None,
    }
}

fn color_op(o: Option<&Object>, fill: bool) -> Option<String> {
    let arr = o?.as_array().ok()?;
    let c: Vec<f64> = arr.iter().filter_map(num).collect();
    let (g, rgb, k) = if fill { ("g", "rg", "k") } else { ("G", "RG", "K") };
    match c.len() {
        1 => Some(format!("{:.3} {g}\n", c[0])),
        3 => Some(format!("{:.3} {:.3} {:.3} {rgb}\n", c[0], c[1], c[2])),
        4 => Some(format!("{:.3} {:.3} {:.3} {:.3} {k}\n", c[0], c[1], c[2], c[3])),
        _ => None,
    }
}

/// Font size and text color from a default appearance string ("/Helv 10 Tf 0 g").
fn parse_da(da: &str) -> (f64, String) {
    let toks: Vec<&str> = da.split_whitespace().collect();
    let mut size = 0.0;
    let mut color = String::from("0 g\n");
    for (i, t) in toks.iter().enumerate() {
        let back = |n: usize| -> Option<Vec<f64>> {
            (i >= n).then(|| toks[i - n..i].iter().filter_map(|s| s.parse().ok()).collect::<Vec<f64>>()).filter(|v| v.len() == n)
        };
        match *t {
            "Tf" => size = back(1).map(|v| v[0]).unwrap_or(0.0),
            "g" => if let Some(v) = back(1) { color = format!("{:.3} g\n", v[0]) },
            "rg" => if let Some(v) = back(3) { color = format!("{:.3} {:.3} {:.3} rg\n", v[0], v[1], v[2]) },
            "k" => if let Some(v) = back(4) { color = format!("{:.3} {:.3} {:.3} {:.3} k\n", v[0], v[1], v[2], v[3]) },
            _ => {}
        }
    }
    (size, color)
}

/// The appearance stream of one text widget: (width, height, content).
fn text_appearance(doc: &Document, widget: ObjectId, field: &Field, text: &[u8]) -> Option<(f64, f64, Vec<u8>)> {
    let dict = doc.get_object(widget).and_then(Object::as_dict).ok()?;
    let rect: Vec<f64> = dict.get(b"Rect").ok()?.as_array().ok()?.iter().filter_map(num).collect();
    if rect.len() != 4 {
        return None;
    }
    let (w, h) = ((rect[2] - rect[0]).abs(), (rect[3] - rect[1]).abs());
    if w < 1.0 || h < 1.0 {
        return None;
    }
    let mk = dict.get(b"MK").ok().and_then(|o| o.as_dict().ok());
    if mk.and_then(|m| m.get(b"R").ok()).and_then(num).is_some_and(|r| r.rem_euclid(360.0) != 0.0) {
        return None; // rotated widget: let the reader draw it
    }
    let da = dict.get(b"DA").ok().and_then(text_of).or_else(|| field.da.clone()).unwrap_or_default();
    let (da_size, color) = parse_da(&da);
    let q = dict.get(b"Q").and_then(Object::as_i64).unwrap_or(field.q);

    let border_color = mk.and_then(|m| color_op(m.get(b"BC").ok(), false));
    let border_w = dict
        .get(b"BS")
        .ok()
        .and_then(|o| o.as_dict().ok())
        .and_then(|bs| bs.get(b"W").ok())
        .and_then(num)
        .unwrap_or(if border_color.is_some() { 1.0 } else { 0.0 });

    let masked: Vec<u8>;
    let text = if field.flags & FF_PASSWORD != 0 {
        masked = vec![b'*'; text.len()];
        &masked[..]
    } else {
        text
    };

    let mut ops = String::new();
    if let Some(bg) = mk.and_then(|m| color_op(m.get(b"BG").ok(), true)) {
        ops.push_str(&format!("{bg}0 0 {w:.2} {h:.2} re f\n"));
    }
    if let (Some(bc), true) = (&border_color, border_w > 0.0) {
        let half = border_w / 2.0;
        ops.push_str(&format!(
            "{bc}{border_w:.2} w {half:.2} {half:.2} {:.2} {:.2} re S\n",
            w - border_w,
            h - border_w
        ));
    }

    let pad = border_w.max(1.0) + 1.0;
    let inner_w = (w - 2.0 * pad).max(1.0);
    let mut body = format!("/Tx BMC\nq\n{pad:.2} {pad:.2} {inner_w:.2} {:.2} re W n\nBT\n", (h - 2.0 * pad).max(1.0));

    if field.flags & FF_MULTILINE != 0 && field.ft == "Tx" {
        let size = if da_size > 0.0 { da_size } else { 12.0_f64.min((h - 2.0 * pad) * 0.8).max(4.0) };
        let lines = wrap(text, inner_w, size);
        let lead = size * 1.15;
        body.push_str(&format!("/Helv {size:.2} Tf\n{color}"));
        let mut y = h - pad - size * 0.9;
        for line in lines {
            let x = align_x(q, pad, inner_w, width_of(&line, size));
            body.push_str(&format!("1 0 0 1 {x:.2} {y:.2} Tm\n({}) Tj\n", escape(&line)));
            y -= lead;
        }
    } else if field.flags & FF_COMB != 0 && field.max_len > 0 && field.ft == "Tx" {
        let cell = w / field.max_len as f64;
        let size = if da_size > 0.0 { da_size } else { ((h - 2.0 * pad) * 0.7).clamp(4.0, 12.0) };
        let y = baseline(h, size);
        body.push_str(&format!("/Helv {size:.2} Tf\n{color}"));
        for (i, ch) in text.iter().take(field.max_len as usize).enumerate() {
            let cw = width_of(&[*ch], size);
            let x = i as f64 * cell + (cell - cw) / 2.0;
            body.push_str(&format!("1 0 0 1 {x:.2} {y:.2} Tm\n({}) Tj\n", escape(&[*ch])));
        }
    } else {
        // One line; "auto" size fills the height and shrinks to fit the width.
        let size = if da_size > 0.0 {
            da_size
        } else {
            let by_height = ((h - 2.0 * pad) * 0.7).clamp(4.0, 14.0);
            let tw = width_of(text, 1.0);
            if tw > 0.0 { by_height.min(inner_w / tw).max(4.0) } else { by_height }
        };
        let x = align_x(q, pad, inner_w, width_of(text, size));
        let y = baseline(h, size);
        body.push_str(&format!("/Helv {size:.2} Tf\n{color}1 0 0 1 {x:.2} {y:.2} Tm\n({}) Tj\n", escape(text)));
    }
    body.push_str("ET\nQ\nEMC\n");
    ops.push_str(&body);
    Some((w, h, ops.into_bytes()))
}

fn baseline(h: f64, size: f64) -> f64 {
    // Center the cap height (≈0.72 em) with a little room for descenders.
    (h - size * 0.72) / 2.0 + size * 0.05
}

fn align_x(q: i64, pad: f64, inner_w: f64, text_w: f64) -> f64 {
    match q {
        1 => pad + (inner_w - text_w) / 2.0,
        2 => pad + inner_w - text_w,
        _ => pad,
    }
}

fn wrap(text: &[u8], max_w: f64, size: f64) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    for para in text.split(|&b| b == b'\n') {
        let para: Vec<u8> = para.iter().copied().filter(|&b| b != b'\r').collect();
        let mut line: Vec<u8> = Vec::new();
        for word in para.split(|&b| b == b' ') {
            let mut candidate = line.clone();
            if !candidate.is_empty() {
                candidate.push(b' ');
            }
            candidate.extend_from_slice(word);
            if !line.is_empty() && width_of(&candidate, size) > max_w {
                out.push(std::mem::take(&mut line));
                line.extend_from_slice(word);
            } else {
                line = candidate;
            }
        }
        out.push(line);
    }
    out
}

/// Helvetica advance widths (AFM, 1/1000 em) for WinAnsi bytes 32..=126.
const HELV: [u16; 95] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // ' '../
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0..?
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // @..O
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P.._
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // `..o
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // p..~
];

fn glyph_width(b: u8) -> u16 {
    match b {
        32..=126 => HELV[(b - 32) as usize],
        0x8C => 1000,                     // Œ
        0x9C => 944,                      // œ
        0xC0..=0xC5 | 0xC8..=0xCB | 0xDD => 667, // À…Å È…Ë Ý
        0xC7 | 0xD1 | 0xD9..=0xDC => 722, // Ç Ñ Ù…Ü
        0xCC..=0xCF | 0xEC..=0xEF => 278, // Ì…Ï ì…ï
        0xD2..=0xD6 | 0xD8 => 778,        // Ò…Ö Ø
        0xE7 | 0xFD | 0xFF => 500,        // ç ý ÿ
        _ => 556,
    }
}

fn width_of(text: &[u8], size: f64) -> f64 {
    text.iter().map(|&b| glyph_width(b) as f64).sum::<f64>() * size / 1000.0
}

fn escape(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len());
    for &b in bytes {
        match b {
            b'(' | b')' | b'\\' => {
                s.push('\\');
                s.push(b as char);
            }
            32..=126 => s.push(b as char),
            _ => s.push_str(&format!("\\{b:03o}")),
        }
    }
    s
}

/// Encodes text in WinAnsi, or None if a character has no WinAnsi code.
fn win_ansi(text: &str) -> Option<Vec<u8>> {
    text.chars()
        .map(|c| {
            let u = c as u32;
            match u {
                0x0A | 0x0D | 0x20..=0x7E | 0xA0..=0xFF => Some(u as u8),
                0x09 => Some(b' '),
                _ => Some(match c {
                    '€' => 0x80, '‚' => 0x82, 'ƒ' => 0x83, '„' => 0x84, '…' => 0x85, '†' => 0x86,
                    '‡' => 0x87, 'ˆ' => 0x88, '‰' => 0x89, 'Š' => 0x8A, '‹' => 0x8B, 'Œ' => 0x8C,
                    'Ž' => 0x8E, '‘' => 0x91, '’' => 0x92, '“' => 0x93, '”' => 0x94, '•' => 0x95,
                    '–' => 0x96, '—' => 0x97, '˜' => 0x98, '™' => 0x99, 'š' => 0x9A, '›' => 0x9B,
                    'œ' => 0x9C, 'ž' => 0x9E, 'Ÿ' => 0x9F,
                    _ => return None,
                }),
            }
        })
        .collect()
}

fn latin1_bytes(text: &str) -> Option<Vec<u8>> {
    text.chars().map(|c| u8::try_from(c as u32).ok()).collect()
}

/// A PDF text string: plain bytes for ASCII, UTF-16BE with a BOM otherwise
/// (raw UTF-8 bytes would be read back as PDFDocEncoding: "Ã©" for "é").
fn text_string(text: &str) -> Object {
    if text.is_ascii() {
        return Object::String(text.as_bytes().to_vec(), StringFormat::Literal);
    }
    let mut bytes = vec![0xFE, 0xFF];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_be_bytes());
    }
    Object::String(bytes, StringFormat::Hexadecimal)
}

/// Decodes a PDF text string: UTF-16BE with a BOM, else UTF-8, else PDFDocEncoding (≈ Latin-1).
fn text_of(o: &Object) -> Option<String> {
    let Object::String(bytes, _) = o else { return None };
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let units: Vec<u16> = rest.as_chunks::<2>().0.iter().map(|&c| u16::from_be_bytes(c)).collect();
        return String::from_utf16(&units).ok();
    }
    Some(String::from_utf8(bytes.clone()).unwrap_or_else(|_| bytes.iter().map(|&b| b as char).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(t: &str) -> Object {
        Object::String(t.as_bytes().to_vec(), StringFormat::Literal)
    }

    /// A one-page form: a text field, a check box whose on state is /Oui,
    /// a radio group with two widgets, a combo box, a comb field.
    fn form() -> (Document, [ObjectId; 7]) {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let rect = |x: i64, y: i64, w: i64, h: i64| vec![x.into(), y.into(), (x + w).into(), (y + h).into()];
        let on_off = |on: &str| {
            let mut n = Dictionary::new();
            n.set(on.as_bytes().to_vec(), Object::Null);
            n.set(b"Off".to_vec(), Object::Null);
            dictionary! { "N" => n }
        };
        let text = doc.add_object(dictionary! {
            "FT" => "Tx", "T" => s("nom"), "Type" => "Annot", "Subtype" => "Widget",
            "Rect" => rect(100, 700, 200, 20), "DA" => s("/Helv 0 Tf 0 g"),
            "MK" => dictionary! { "BG" => vec![Object::Real(0.9)], "BC" => vec![0.into()] },
        });
        let check = doc.add_object(dictionary! {
            "FT" => "Btn", "T" => s("ok"), "Type" => "Annot", "Subtype" => "Widget",
            "Rect" => rect(100, 650, 12, 12), "V" => "Off", "AS" => "Off", "AP" => on_off("Oui"),
        });
        let radio = doc.new_object_id();
        let r1 = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Widget", "Parent" => radio,
            "Rect" => rect(100, 600, 12, 12), "AS" => "m", "AP" => on_off("m"),
        });
        let r2 = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Widget", "Parent" => radio,
            "Rect" => rect(130, 600, 12, 12), "AS" => "Off", "AP" => on_off("mme"),
        });
        doc.objects.insert(radio, Object::Dictionary(dictionary! {
            "FT" => "Btn", "T" => s("civilite"), "Ff" => 1 << 15, "V" => "m",
            "Kids" => vec![r1.into(), r2.into()],
        }));
        let combo = doc.add_object(dictionary! {
            "FT" => "Ch", "T" => s("pays"), "Ff" => FF_COMBO, "Type" => "Annot", "Subtype" => "Widget",
            "Rect" => rect(100, 550, 150, 20), "DA" => s("/Helv 10 Tf 0 0 1 rg"),
            "Opt" => vec![Object::Array(vec![s("FR"), s("France")]), Object::Array(vec![s("BE"), s("Belgique")])],
        });
        let comb = doc.add_object(dictionary! {
            "FT" => "Tx", "T" => s("cp"), "Ff" => FF_COMB, "MaxLen" => 5, "Type" => "Annot", "Subtype" => "Widget",
            "Rect" => rect(100, 500, 100, 20), "DA" => s("/Helv 10 Tf 0 g"),
        });
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            "Annots" => vec![text.into(), check.into(), r1.into(), r2.into(), combo.into(), comb.into()],
        });
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }));
        let cat = doc.add_object(dictionary! {
            "Type" => "Catalog", "Pages" => pages_id,
            "AcroForm" => dictionary! { "Fields" => vec![text.into(), check.into(), radio.into(), combo.into(), comb.into()] },
        });
        doc.trailer.set(b"Root", cat);
        (doc, [text, check, radio, r1, r2, combo, comb])
    }

    fn fill(doc: &mut Document, pairs: &[(&str, &str)]) {
        let fields: Vec<FormFieldValue> =
            pairs.iter().map(|(n, v)| FormFieldValue { name: n.to_string(), value: v.to_string() }).collect();
        write_form_fields(doc, &fields).unwrap();
    }

    fn get(doc: &Document, id: ObjectId) -> &Dictionary {
        doc.get_object(id).unwrap().as_dict().unwrap()
    }

    fn appearance(doc: &Document, widget: ObjectId) -> String {
        let ap = get(doc, widget).get(b"AP").unwrap().as_dict().unwrap();
        let id = ap.get(b"N").unwrap().as_reference().unwrap();
        let stream = doc.get_object(id).unwrap().as_stream().unwrap();
        String::from_utf8_lossy(&stream.content).into_owned()
    }

    fn need_appearances(doc: &Document) -> bool {
        let cat = get(doc, doc.trailer.get(b"Root").unwrap().as_reference().unwrap());
        let af = get(doc, cat.get(b"AcroForm").unwrap().as_reference().unwrap());
        af.get(b"NeedAppearances").and_then(Object::as_bool).unwrap_or(false)
    }

    #[test]
    fn accented_text_is_stored_as_utf16_and_drawn_in_winansi() {
        let (mut doc, [text, ..]) = form();
        fill(&mut doc, &[("nom", "Élodie Lefèvre (né)")]);
        assert_eq!(text_of(get(&doc, text).get(b"V").unwrap()).unwrap(), "Élodie Lefèvre (né)");
        let ap = appearance(&doc, text);
        assert!(ap.contains("\\311lodie Lef\\350vre \\(n\\351\\)"), "{ap}");
        assert!(ap.contains("/Tx BMC"), "{ap}");
        assert!(ap.contains("0.900 g"), "background kept: {ap}");
        assert!(!need_appearances(&doc), "every field has its appearance");
    }

    #[test]
    fn check_box_uses_its_own_on_state() {
        let (mut doc, [_, check, ..]) = form();
        fill(&mut doc, &[("ok", "true")]);
        assert_eq!(get(&doc, check).get(b"V").unwrap().as_name().unwrap(), b"Oui");
        assert_eq!(get(&doc, check).get(b"AS").unwrap().as_name().unwrap(), b"Oui");
        fill(&mut doc, &[("ok", "false")]);
        assert_eq!(get(&doc, check).get(b"AS").unwrap().as_name().unwrap(), b"Off");
    }

    #[test]
    fn radio_turns_every_widget_of_the_group() {
        let (mut doc, [_, _, radio, r1, r2, ..]) = form();
        fill(&mut doc, &[("civilite", "mme")]);
        assert_eq!(get(&doc, radio).get(b"V").unwrap().as_name().unwrap(), b"mme");
        assert_eq!(get(&doc, r1).get(b"AS").unwrap().as_name().unwrap(), b"Off");
        assert_eq!(get(&doc, r2).get(b"AS").unwrap().as_name().unwrap(), b"mme");
    }

    #[test]
    fn combo_box_shows_the_display_text_in_its_color() {
        let (mut doc, [.., combo, _]) = form();
        fill(&mut doc, &[("pays", "BE")]);
        assert_eq!(text_of(get(&doc, combo).get(b"V").unwrap()).unwrap(), "BE");
        let ap = appearance(&doc, combo);
        assert!(ap.contains("(Belgique) Tj") && ap.contains("0.000 0.000 1.000 rg") && ap.contains("/Helv 10.00 Tf"), "{ap}");
    }

    #[test]
    fn comb_field_puts_one_character_per_cell() {
        let (mut doc, [.., comb]) = form();
        fill(&mut doc, &[("cp", "75011")]);
        let ap = appearance(&doc, comb);
        assert_eq!(ap.matches(") Tj").count(), 5, "{ap}");
    }

    #[test]
    fn text_winansi_cannot_draw_asks_readers_to_redraw() {
        let (mut doc, [text, ..]) = form();
        fill(&mut doc, &[("nom", "Ελένη")]);
        assert_eq!(text_of(get(&doc, text).get(b"V").unwrap()).unwrap(), "Ελένη");
        assert!(get(&doc, text).get(b"AP").is_err(), "no appearance drawn");
        assert!(need_appearances(&doc));
    }

    #[test]
    fn values_survive_save_and_reload() {
        let (mut doc, [text, check, ..]) = form();
        fill(&mut doc, &[("nom", "Œuvre — été"), ("ok", "true")]);
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        let doc2 = Document::load_mem(&buf).unwrap();
        assert_eq!(text_of(get(&doc2, text).get(b"V").unwrap()).unwrap(), "Œuvre — été");
        assert_eq!(get(&doc2, check).get(b"AS").unwrap().as_name().unwrap(), b"Oui");
        assert!(appearance(&doc2, text).contains("\\214uvre \\227 \\351t\\351"));
    }

    #[test]
    fn hostile_cyclic_tree_terminates() {
        let (mut doc, [text, ..]) = form();
        if let Ok(Object::Dictionary(d)) = doc.get_object_mut(text) {
            d.set(b"Kids", vec![Object::Reference(text)]);
        }
        fill(&mut doc, &[("nom", "x")]);
    }
}
