//! "Convert": the text of a PDF written as Word, Excel, RTF, HTML, plain
//! text or XML.
//!
//! The frontend reads the text with pdf.js (it knows the fonts and their
//! encodings) and sends it here already split into lines and cells, with
//! the page geometry. This module groups the lines into paragraphs,
//! headings and tables ([`blocks`]) and writes the chosen format.
//!
//! The result is a simplified, editable copy of the text: no pictures,
//! drawings or exact positions.

mod office;
mod text;
pub mod zip;

use serde::Deserialize;

/// The text of a document, as the frontend extracted it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDoc {
    /// Shown as the title of HTML / Word files.
    #[serde(default)]
    pub title: String,
    pub pages: Vec<TextPage>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPage {
    pub number: u32,
    /// Page size in points.
    pub width: f32,
    pub height: f32,
    pub lines: Vec<TextLine>,
}

/// One line of text, top to bottom (other fields the frontend sends, such
/// as positions, are ignored). A line with several cells is a row of
/// a table (text separated by wide gaps).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLine {
    pub cells: Vec<TextCell>,
    /// Font size in points.
    pub size: f32,
    /// True when the line starts a new paragraph (a wider gap above it).
    #[serde(default)]
    pub para_start: bool,
    /// 1 or 2 for a title (larger text), 0 for body text.
    #[serde(default)]
    pub heading: u8,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextCell {
    pub text: String,
    /// Column of the page the cell lines up with (0 = leftmost).
    #[serde(default)]
    pub col: u32,
}

/// What a page is made of once its lines are grouped.
#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Para { text: String, size: f32, heading: u8 },
    Table { rows: Vec<Vec<String>> },
}

/// The formats [`convert`] writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Docx,
    Xlsx,
    Rtf,
    Html,
    Txt,
    Xml,
}

impl Format {
    pub fn parse(s: &str) -> Option<Format> {
        Some(match s.to_ascii_lowercase().as_str() {
            "docx" => Format::Docx,
            "xlsx" => Format::Xlsx,
            "rtf" => Format::Rtf,
            "html" | "htm" => Format::Html,
            "txt" => Format::Txt,
            "xml" => Format::Xml,
            _ => return None,
        })
    }

    pub fn extension(self) -> &'static str {
        match self {
            Format::Docx => "docx",
            Format::Xlsx => "xlsx",
            Format::Rtf => "rtf",
            Format::Html => "html",
            Format::Txt => "txt",
            Format::Xml => "xml",
        }
    }
}

/// The file contents of `doc` in `format`.
pub fn convert(doc: &TextDoc, format: Format) -> Vec<u8> {
    match format {
        Format::Docx => office::docx(doc),
        Format::Xlsx => office::xlsx(doc),
        Format::Rtf => text::rtf(doc).into_bytes(),
        Format::Html => text::html(doc).into_bytes(),
        Format::Txt => text::txt(doc).into_bytes(),
        Format::Xml => text::xml(doc).into_bytes(),
    }
}

/// Joins two lines of the same paragraph: "inter-" + "national" gives
/// "international", anything else is joined with a space.
fn join_line(para: &mut String, next: &str) {
    let next = next.trim();
    if next.is_empty() {
        return;
    }
    if para.is_empty() {
        para.push_str(next);
        return;
    }
    let mut prev = para.chars().rev();
    let hyphenated = prev.next() == Some('-')
        && prev.next().is_some_and(char::is_alphabetic)
        && next.chars().next().is_some_and(char::is_lowercase);
    if hyphenated {
        para.pop();
    } else if !para.ends_with(char::is_whitespace) {
        para.push(' ');
    }
    para.push_str(next);
}

/// Groups the lines of `page` into paragraphs, titles and tables.
///
/// Consecutive lines with several cells form a table; its columns are the
/// page columns the cells line up with. Other lines are joined into
/// paragraphs until a line starts a new one or the title level changes.
pub fn blocks(page: &TextPage) -> Vec<Block> {
    let mut out: Vec<Block> = Vec::new();
    let mut table: Vec<&TextLine> = Vec::new();

    let flush_table = |table: &mut Vec<&TextLine>, out: &mut Vec<Block>| {
        if table.is_empty() {
            return;
        }
        let mut cols: Vec<u32> = table.iter().flat_map(|l| l.cells.iter().map(|c| c.col)).collect();
        cols.sort_unstable();
        cols.dedup();
        let rows = table
            .iter()
            .map(|l| {
                let mut row = vec![String::new(); cols.len()];
                for c in &l.cells {
                    let i = cols.binary_search(&c.col).unwrap_or(0);
                    join_line(&mut row[i], &c.text);
                }
                row
            })
            .collect();
        out.push(Block::Table { rows });
        table.clear();
    };

    let mut open_para = false;
    for line in &page.lines {
        let text: Vec<&str> = line.cells.iter().map(|c| c.text.trim()).filter(|t| !t.is_empty()).collect();
        if text.is_empty() {
            continue;
        }
        if text.len() > 1 {
            table.push(line);
            open_para = false;
            continue;
        }
        flush_table(&mut table, &mut out);
        let joined = text[0];
        if open_para && !line.para_start {
            if let Some(Block::Para { text, heading, .. }) = out.last_mut() {
                if *heading == line.heading {
                    join_line(text, joined);
                    continue;
                }
            }
        }
        out.push(Block::Para { text: joined.to_string(), size: line.size, heading: line.heading });
        open_para = true;
    }
    flush_table(&mut table, &mut out);
    out
}

/// Characters XML 1.0 cannot hold (control characters) are dropped.
fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\t' | '\n' | '\r' => out.push(c),
            c if (c as u32) < 0x20 || c == '\u{FFFE}' || c == '\u{FFFF}' => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn line(text: &str, size: f32, para_start: bool, heading: u8) -> TextLine {
        TextLine {
            cells: vec![TextCell { text: text.into(), col: 0 }],
            size,
            para_start,
            heading,
        }
    }

    pub fn row(cells: &[(&str, u32)]) -> TextLine {
        TextLine {
            cells: cells.iter().map(|(t, c)| TextCell { text: (*t).into(), col: *c }).collect(),
            size: 10.0,
            para_start: false,
            heading: 0,
        }
    }

    pub fn sample() -> TextDoc {
        TextDoc {
            title: "Report <1>".into(),
            pages: vec![
                TextPage {
                    number: 1,
                    width: 595.0,
                    height: 842.0,
                    lines: vec![
                        line("Annual report", 20.0, true, 1),
                        line("The team is inter-", 10.0, true, 0),
                        line("national & small.", 10.0, false, 0),
                        line("Second paragraph.", 10.0, true, 0),
                        row(&[("Name", 0), ("Total", 2)]),
                        row(&[("Alice", 0), ("12", 1), ("42.5", 2)]),
                    ],
                },
                TextPage { number: 2, width: 595.0, height: 842.0, lines: vec![line("Été €", 10.0, true, 0)] },
            ],
        }
    }

    #[test]
    fn groups_lines_into_paragraphs_titles_and_tables() {
        let b = blocks(&sample().pages[0]);
        assert_eq!(
            b,
            vec![
                Block::Para { text: "Annual report".into(), size: 20.0, heading: 1 },
                Block::Para { text: "The team is international & small.".into(), size: 10.0, heading: 0 },
                Block::Para { text: "Second paragraph.".into(), size: 10.0, heading: 0 },
                Block::Table {
                    rows: vec![
                        vec!["Name".into(), String::new(), "Total".into()],
                        vec!["Alice".into(), "12".into(), "42.5".into()],
                    ]
                },
            ]
        );
    }

    #[test]
    fn a_title_level_change_starts_a_new_paragraph() {
        let page = TextPage {
            number: 1,
            width: 100.0,
            height: 100.0,
            lines: vec![line("Title", 18.0, true, 1), line("body", 10.0, false, 0)],
        };
        assert_eq!(blocks(&page).len(), 2);
    }

    #[test]
    fn keeps_real_hyphens() {
        let mut s = "well-".to_string();
        join_line(&mut s, "Known");
        assert_eq!(s, "well- Known");
        let mut s = "pages 1-".to_string();
        join_line(&mut s, "3");
        assert_eq!(s, "pages 1- 3");
    }

    #[test]
    fn empty_lines_are_skipped() {
        let page = TextPage { number: 1, width: 1.0, height: 1.0, lines: vec![line("  ", 10.0, true, 0)] };
        assert!(blocks(&page).is_empty());
    }

    #[test]
    fn parses_formats() {
        for f in ["docx", "XLSX", "rtf", "html", "txt", "xml"] {
            let parsed = Format::parse(f).unwrap();
            assert_eq!(parsed.extension(), f.to_ascii_lowercase());
        }
        assert_eq!(Format::parse("pdf"), None);
    }

    #[test]
    fn xml_escape_drops_control_characters() {
        assert_eq!(xml_escape("a<b>&\"'\u{1}c"), "a&lt;b&gt;&amp;&quot;&apos;c");
    }
}
