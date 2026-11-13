//! Plain text, HTML, XML and RTF.

use super::{blocks, xml_escape, Block, TextDoc};
use std::fmt::Write;

/// Plain text, one paragraph per line, table cells separated by tabs and a
/// blank line between paragraphs. Windows line endings, for Notepad.
pub fn txt(doc: &TextDoc) -> String {
    let mut out = String::new();
    for (i, page) in doc.pages.iter().enumerate() {
        if i > 0 {
            out.push_str("\r\n");
        }
        for b in blocks(page) {
            match b {
                Block::Para { text, .. } => {
                    out.push_str(&text);
                    out.push_str("\r\n\r\n");
                }
                Block::Table { rows } => {
                    for r in rows {
                        out.push_str(r.join("\t").trim_end());
                        out.push_str("\r\n");
                    }
                    out.push_str("\r\n");
                }
            }
        }
    }
    out
}

/// A web page: one section per PDF page, titles as headings, tables as
/// tables.
pub fn html(doc: &TextDoc) -> String {
    let title = if doc.title.is_empty() { "Document" } else { doc.title.as_str() };
    let mut out = String::new();
    let _ = write!(
        out,
        "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <meta name=\"generator\" content=\"EzReader\">\n<title>{}</title>\n<style>\n\
         body {{ font-family: Segoe UI, Arial, sans-serif; line-height: 1.5; max-width: 50em; margin: 2em auto; padding: 0 1em; color: #222; }}\n\
         section {{ padding-bottom: 1.5em; margin-bottom: 1.5em; border-bottom: 1px solid #ddd; }}\n\
         section:last-child {{ border-bottom: 0; }}\n\
         table {{ border-collapse: collapse; margin: 1em 0; }}\n\
         td {{ border: 1px solid #ccc; padding: .25em .6em; vertical-align: top; }}\n\
         </style>\n</head>\n<body>\n",
        xml_escape(title)
    );
    for page in &doc.pages {
        let _ = writeln!(out, "<section id=\"page-{0}\" data-page=\"{0}\">", page.number);
        for b in blocks(page) {
            match b {
                Block::Para { text, heading, .. } => {
                    let tag = match heading {
                        1 => "h1",
                        2 => "h2",
                        _ => "p",
                    };
                    let _ = writeln!(out, "<{tag}>{}</{tag}>", xml_escape(&text));
                }
                Block::Table { rows } => {
                    out.push_str("<table>\n");
                    for r in rows {
                        out.push_str("<tr>");
                        for c in r {
                            let _ = write!(out, "<td>{}</td>", xml_escape(&c));
                        }
                        out.push_str("</tr>\n");
                    }
                    out.push_str("</table>\n");
                }
            }
        }
        out.push_str("</section>\n");
    }
    out.push_str("</body>\n</html>\n");
    out
}

/// The text with its structure: pages, headings, paragraphs and tables.
pub fn xml(doc: &TextDoc) -> String {
    let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    let _ = writeln!(
        out,
        "<document title=\"{}\" pages=\"{}\">",
        xml_escape(&doc.title),
        doc.pages.len()
    );
    for page in &doc.pages {
        let _ = writeln!(
            out,
            "  <page number=\"{}\" width=\"{}\" height=\"{}\">",
            page.number,
            page.width.round(),
            page.height.round()
        );
        for b in blocks(page) {
            match b {
                Block::Para { text, heading: 0, .. } => {
                    let _ = writeln!(out, "    <paragraph>{}</paragraph>", xml_escape(&text));
                }
                Block::Para { text, heading, .. } => {
                    let _ = writeln!(out, "    <heading level=\"{heading}\">{}</heading>", xml_escape(&text));
                }
                Block::Table { rows } => {
                    out.push_str("    <table>\n");
                    for r in rows {
                        out.push_str("      <row>");
                        for c in r {
                            let _ = write!(out, "<cell>{}</cell>", xml_escape(&c));
                        }
                        out.push_str("</row>\n");
                    }
                    out.push_str("    </table>\n");
                }
            }
        }
        out.push_str("  </page>\n");
    }
    out.push_str("</document>\n");
    out
}

/// Text for an RTF file: ASCII as is, everything else as `\uN?`.
fn rtf_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '{' => out.push_str("\\{"),
            '}' => out.push_str("\\}"),
            '\t' => out.push_str("\\tab "),
            '\n' | '\r' => out.push_str("\\line "),
            c if (c as u32) < 0x20 => {}
            c if c.is_ascii() => out.push(c),
            c => {
                let mut buf = [0u16; 2];
                for unit in c.encode_utf16(&mut buf) {
                    // RTF takes signed 16-bit numbers.
                    let _ = write!(out, "\\u{}?", *unit as i16);
                }
            }
        }
    }
    out
}

/// Font size in half points, kept readable.
pub(super) fn half_points(size: f32, heading: u8) -> u32 {
    let pt = if size.is_finite() && size > 0.0 { size } else { 11.0 };
    let (lo, hi) = if heading > 0 { (12.0, 36.0) } else { (8.0, 16.0) };
    (pt.clamp(lo, hi) * 2.0).round() as u32
}

/// Rich text: opens in WordPad, Word and LibreOffice.
pub fn rtf(doc: &TextDoc) -> String {
    let mut out = String::from(
        "{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl{\\f0\\fswiss Calibri;}}\\viewkind4\n",
    );
    if !doc.title.is_empty() {
        let _ = writeln!(out, "{{\\info{{\\title {}}}}}", rtf_escape(&doc.title));
    }
    for (i, page) in doc.pages.iter().enumerate() {
        if i > 0 {
            out.push_str("\\page\n");
        }
        for b in blocks(page) {
            match b {
                Block::Para { text, size, heading } => {
                    let bold = if heading > 0 { "\\b" } else { "" };
                    let _ = writeln!(
                        out,
                        "\\pard\\sa160\\f0\\fs{}{bold} {}{}\\par",
                        half_points(size, heading),
                        rtf_escape(&text),
                        if heading > 0 { "\\b0" } else { "" }
                    );
                }
                Block::Table { rows } => {
                    let cols = rows.iter().map(Vec::len).max().unwrap_or(1).max(1);
                    let width = 9000 / cols;
                    for r in rows {
                        out.push_str("\\trowd\\trgaph108");
                        for k in 1..=cols {
                            let _ = write!(
                                out,
                                "\\clbrdrt\\brdrs\\clbrdrl\\brdrs\\clbrdrb\\brdrs\\clbrdrr\\brdrs\\cellx{}",
                                width * k
                            );
                        }
                        out.push('\n');
                        for k in 0..cols {
                            let cell = r.get(k).map(String::as_str).unwrap_or("");
                            let _ = write!(out, "\\pard\\intbl\\f0\\fs20 {}\\cell ", rtf_escape(cell));
                        }
                        out.push_str("\\row\n");
                    }
                    out.push_str("\\pard\\sa160\\par\n");
                }
            }
        }
    }
    out.push('}');
    out
}

#[cfg(test)]
mod tests {
    use super::super::tests::sample;
    use super::*;

    #[test]
    fn writes_plain_text() {
        let t = txt(&sample());
        assert_eq!(
            t,
            "Annual report\r\n\r\nThe team is international & small.\r\n\r\nSecond paragraph.\r\n\r\n\
             Name\t\tTotal\r\nAlice\t12\t42.5\r\n\r\n\r\nÉté €\r\n\r\n"
        );
    }

    #[test]
    fn writes_html() {
        let h = html(&sample());
        assert!(h.starts_with("<!DOCTYPE html>"));
        assert!(h.contains("<title>Report &lt;1&gt;</title>"));
        assert!(h.contains("<h1>Annual report</h1>"));
        assert!(h.contains("<p>The team is international &amp; small.</p>"));
        assert!(h.contains("<tr><td>Alice</td><td>12</td><td>42.5</td></tr>"));
        assert!(h.contains("<section id=\"page-2\" data-page=\"2\">\n<p>Été €</p>"));
        assert!(h.ends_with("</html>\n"));
    }

    #[test]
    fn writes_xml() {
        let x = xml(&sample());
        assert!(x.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<document title=\"Report &lt;1&gt;\" pages=\"2\">"));
        assert!(x.contains("<page number=\"1\" width=\"595\" height=\"842\">"));
        assert!(x.contains("<heading level=\"1\">Annual report</heading>"));
        assert!(x.contains("<row><cell>Name</cell><cell></cell><cell>Total</cell></row>"));
        assert!(x.ends_with("</document>\n"));
    }

    #[test]
    fn writes_rtf() {
        let r = rtf(&sample());
        assert!(r.starts_with("{\\rtf1"));
        assert!(r.ends_with('}'));
        assert!(r.contains("\\fs40\\b Annual report\\b0\\par"));
        assert!(r.contains("\\page\n"));
        // É, é, € as Unicode escapes.
        assert!(r.contains("\\u201?t\\u233? \\u8364?"));
        assert_eq!(r.matches("\\row").count(), 2);
        let opens = r.matches('{').count() - r.matches("\\{").count();
        let closes = r.matches('}').count() - r.matches("\\}").count();
        assert_eq!(opens, closes);
    }

    #[test]
    fn rtf_escapes_braces_and_astral_characters() {
        assert_eq!(rtf_escape("{a}\\"), "\\{a\\}\\\\");
        assert_eq!(rtf_escape("😀"), "\\u-10179?\\u-8704?");
    }

    #[test]
    fn font_sizes_stay_readable() {
        assert_eq!(half_points(4.0, 0), 16);
        assert_eq!(half_points(11.0, 0), 22);
        assert_eq!(half_points(80.0, 1), 72);
        assert_eq!(half_points(f32::NAN, 0), 22);
    }
}
