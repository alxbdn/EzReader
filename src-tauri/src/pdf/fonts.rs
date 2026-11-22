//! The fonts a document uses, for the document info panel.

use std::collections::BTreeSet;

use lopdf::{Document, Object};

/// A font's name as people know it: "ABCDEF+Calibri-Bold" → "Calibri Bold".
pub fn display_name(base_font: &[u8]) -> String {
    let raw = String::from_utf8_lossy(base_font);
    let bare = match raw.split_once('+') {
        Some((tag, rest)) if tag.len() == 6 && tag.chars().all(|c| c.is_ascii_uppercase()) => rest,
        _ => &raw,
    };
    bare.replace("#20", " ").replace([',', '-'], " ").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Every named font in the document, once each, sorted. Descendant CID fonts repeat their
/// Type 0 parent's name and Type 3 fonts have none, so neither adds a line.
pub fn font_names(doc: &Document) -> Vec<String> {
    let mut names = BTreeSet::new();
    for obj in doc.objects.values() {
        let Ok(dict) = obj.as_dict() else { continue };
        if !dict.get(b"Type").and_then(Object::as_name).is_ok_and(|t| t == b"Font") {
            continue;
        }
        if let Ok(base) = dict.get(b"BaseFont").and_then(Object::as_name) {
            let name = display_name(base);
            if !name.is_empty() {
                names.insert(name);
            }
        }
    }
    names.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    #[test]
    fn names_fonts_once_without_subset_tags() {
        assert_eq!(display_name(b"ABCDEF+Calibri-Bold"), "Calibri Bold");
        assert_eq!(display_name(b"TimesNewRomanPS-BoldItalicMT"), "TimesNewRomanPS BoldItalicMT");
        assert_eq!(display_name(b"Arial,Bold"), "Arial Bold");
        assert_eq!(display_name(b"Abc+Font"), "Abc+Font");

        let mut doc = Document::with_version("1.7");
        doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" });
        doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type0", "BaseFont" => "QWERTY+Calibri" });
        doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "CIDFontType2", "BaseFont" => "QWERTY+Calibri" });
        doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type3" });
        assert_eq!(font_names(&doc), vec!["Calibri".to_string(), "Helvetica".to_string()]);
    }
}
