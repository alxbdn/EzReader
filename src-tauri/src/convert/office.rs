//! Word (.docx) and Excel (.xlsx): Office Open XML packages, written
//! directly (a handful of XML parts in a ZIP).

use super::text::half_points;
use super::{blocks, xml_escape, zip::zip, Block, TextDoc};
use std::fmt::Write;

const XML_HEAD: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";
const REL_DOC: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

fn root_rels(target: &str) -> String {
    format!(
        "{XML_HEAD}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"{REL_DOC}\" Target=\"{target}\"/></Relationships>"
    )
}

fn content_types(overrides: &[(String, &str)]) -> String {
    let mut s = format!(
        "{XML_HEAD}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
         <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
         <Default Extension=\"xml\" ContentType=\"application/xml\"/>"
    );
    for (part, ty) in overrides {
        let _ = write!(s, "<Override PartName=\"{part}\" ContentType=\"{ty}\"/>");
    }
    s.push_str("</Types>");
    s
}

fn run(text: &str, half_pt: u32, bold: bool) -> String {
    format!(
        "<w:r><w:rPr>{}<w:sz w:val=\"{half_pt}\"/><w:szCs w:val=\"{half_pt}\"/></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r>",
        if bold { "<w:b/>" } else { "" },
        xml_escape(text)
    )
}

/// A Word document: titles in bold (and in Word's navigation pane), tables
/// with borders, one page break between PDF pages. The page size is the
/// first PDF page's.
pub fn docx(doc: &TextDoc) -> Vec<u8> {
    const TEXT_WIDTH: u32 = 9000; // twips, about 16 cm
    let mut body = String::new();
    for (i, page) in doc.pages.iter().enumerate() {
        if i > 0 {
            body.push_str("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>");
        }
        for b in blocks(page) {
            match b {
                Block::Para { text, size, heading } => {
                    body.push_str("<w:p><w:pPr><w:spacing w:after=\"160\"/>");
                    if heading > 0 {
                        let _ = write!(body, "<w:keepNext/><w:outlineLvl w:val=\"{}\"/>", heading - 1);
                    }
                    body.push_str("</w:pPr>");
                    body.push_str(&run(&text, half_points(size, heading), heading > 0));
                    body.push_str("</w:p>");
                }
                Block::Table { rows } => {
                    let cols = rows.iter().map(Vec::len).max().unwrap_or(1).max(1);
                    let w = TEXT_WIDTH / cols as u32;
                    body.push_str(
                        "<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblBorders>\
                         <w:top w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/>\
                         <w:left w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/>\
                         <w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/>\
                         <w:right w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/>\
                         <w:insideH w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/>\
                         <w:insideV w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/>\
                         </w:tblBorders></w:tblPr><w:tblGrid>",
                    );
                    for _ in 0..cols {
                        let _ = write!(body, "<w:gridCol w:w=\"{w}\"/>");
                    }
                    body.push_str("</w:tblGrid>");
                    for r in rows {
                        body.push_str("<w:tr>");
                        for k in 0..cols {
                            let cell = r.get(k).map(String::as_str).unwrap_or("");
                            let _ = write!(
                                body,
                                "<w:tc><w:tcPr><w:tcW w:w=\"{w}\" w:type=\"dxa\"/></w:tcPr><w:p>{}</w:p></w:tc>",
                                if cell.is_empty() { String::new() } else { run(cell, 20, false) }
                            );
                        }
                        body.push_str("</w:tr>");
                    }
                    // Word needs a paragraph between two tables.
                    body.push_str("</w:tbl><w:p/>");
                }
            }
        }
    }
    let (w, h) = doc
        .pages
        .first()
        .filter(|p| p.width > 72.0 && p.height > 72.0 && p.width < 14400.0 && p.height < 14400.0)
        .map(|p| ((p.width * 20.0).round() as u32, (p.height * 20.0).round() as u32))
        .unwrap_or((11906, 16838)); // A4
    let margin = 1134; // 2 cm
    let document = format!(
        "{XML_HEAD}<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>{body}\
         <w:sectPr><w:pgSz w:w=\"{w}\" w:h=\"{h}\"/><w:pgMar w:top=\"{margin}\" w:right=\"{margin}\" w:bottom=\"{margin}\" \
         w:left=\"{margin}\" w:header=\"708\" w:footer=\"708\" w:gutter=\"0\"/></w:sectPr></w:body></w:document>"
    );
    let core = core_props(&doc.title);
    let types = content_types(&[
        (
            "/word/document.xml".into(),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        ),
        ("/docProps/core.xml".into(), "application/vnd.openxmlformats-package.core-properties+xml"),
    ]);
    zip(&[
        ("[Content_Types].xml", types.as_bytes()),
        ("_rels/.rels", rels_with_core("word/document.xml").as_bytes()),
        ("word/document.xml", document.as_bytes()),
        ("docProps/core.xml", core.as_bytes()),
    ])
}

fn rels_with_core(target: &str) -> String {
    root_rels(target).replace(
        "</Relationships>",
        "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/></Relationships>",
    )
}

fn core_props(title: &str) -> String {
    format!(
        "{XML_HEAD}<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" \
         xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>{}</dc:title><dc:creator>EzReader</dc:creator></cp:coreProperties>",
        xml_escape(title)
    )
}

/// "A", "B", … "Z", "AA", … for column `i` (0-based).
fn column_name(mut i: usize) -> String {
    let mut s = Vec::new();
    loop {
        s.push(b'A' + (i % 26) as u8);
        if i < 26 {
            break;
        }
        i = i / 26 - 1;
    }
    s.reverse();
    String::from_utf8(s).unwrap()
}

/// A number Excel can compute with: "12", "-3.5", "1,234.50" (US) or
/// "1 234,50" (European). Anything else stays text.
fn as_number(s: &str) -> Option<f64> {
    let t: String = s.trim().chars().filter(|c| !matches!(c, ' ' | '\u{a0}' | '\u{202f}')).collect();
    if t.is_empty() || t.len() > 18 || !t.chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | '.' | ',')) {
        return None;
    }
    if t.starts_with('0') && t.len() > 1 && !t.starts_with("0.") && !t.starts_with("0,") {
        return None; // codes such as 0612 keep their zero
    }
    let normalized = match (t.rfind('.'), t.rfind(',')) {
        (Some(d), Some(c)) if c > d => t.replace('.', "").replacen(',', ".", 1),
        (Some(_), Some(_)) => t.replace(',', ""),
        (None, Some(c)) if t.len() - c - 1 == 3 && !matches!(&t[..c], "" | "0" | "-0" | "-") => {
            // "1,234" thousands separator; "1,5" decimal comma
            t.replace(',', "")
        }
        (None, Some(_)) => {
            if t.matches(',').count() > 1 {
                return None;
            }
            t.replace(',', ".")
        }
        _ => t,
    };
    if normalized.matches('-').count() > 1 || (normalized.contains('-') && !normalized.starts_with('-')) {
        return None;
    }
    normalized.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// An Excel workbook: one sheet per page, one row per line, the cells in
/// the page columns they line up with. Numbers are stored as numbers.
pub fn xlsx(doc: &TextDoc) -> Vec<u8> {
    let mut sheets: Vec<(String, String)> = Vec::new(); // (name, xml)
    for page in &doc.pages {
        let mut rows = String::new();
        let mut widths: Vec<usize> = Vec::new();
        let mut r = 0;
        for line in &page.lines {
            if line.cells.iter().all(|c| c.text.trim().is_empty()) {
                continue;
            }
            r += 1;
            let _ = write!(rows, "<row r=\"{r}\">");
            let mut cells: Vec<(usize, String)> = Vec::new();
            for c in &line.cells {
                let col = c.col as usize;
                match cells.last_mut() {
                    Some((last, text)) if *last >= col => {
                        text.push(' ');
                        text.push_str(c.text.trim());
                    }
                    _ => cells.push((col, c.text.trim().to_string())),
                }
            }
            for (col, text) in cells {
                if widths.len() <= col {
                    widths.resize(col + 1, 0);
                }
                widths[col] = widths[col].max(text.chars().count());
                let ref_ = format!("{}{r}", column_name(col));
                match as_number(&text) {
                    Some(v) => {
                        let _ = write!(rows, "<c r=\"{ref_}\"><v>{v}</v></c>");
                    }
                    None => {
                        let _ = write!(
                            rows,
                            "<c r=\"{ref_}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
                            xml_escape(&text)
                        );
                    }
                }
            }
            rows.push_str("</row>");
        }
        let mut cols = String::new();
        if !widths.is_empty() {
            cols.push_str("<cols>");
            for (i, w) in widths.iter().enumerate() {
                let width = (*w as f32 * 1.1 + 2.0).clamp(8.0, 80.0);
                let _ = write!(cols, "<col min=\"{0}\" max=\"{0}\" width=\"{width:.1}\" customWidth=\"1\"/>", i + 1);
            }
            cols.push_str("</cols>");
        }
        let xml = format!(
            "{XML_HEAD}<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">{cols}<sheetData>{rows}</sheetData></worksheet>"
        );
        sheets.push((format!("Page {}", page.number), xml));
    }
    if sheets.is_empty() {
        sheets.push((
            "Page 1".into(),
            format!("{XML_HEAD}<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData/></worksheet>"),
        ));
    }

    let mut workbook = format!(
        "{XML_HEAD}<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" \
         xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets>"
    );
    let mut wb_rels = format!("{XML_HEAD}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">");
    let mut overrides = vec![(
        "/xl/workbook.xml".to_string(),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    )];
    let mut names = Vec::new();
    for (i, (name, _)) in sheets.iter().enumerate() {
        let n = i + 1;
        let _ = write!(workbook, "<sheet name=\"{}\" sheetId=\"{n}\" r:id=\"rId{n}\"/>", xml_escape(name));
        let _ = write!(
            wb_rels,
            "<Relationship Id=\"rId{n}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{n}.xml\"/>"
        );
        overrides.push((
            format!("/xl/worksheets/sheet{n}.xml"),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
        ));
        names.push(format!("xl/worksheets/sheet{n}.xml"));
    }
    workbook.push_str("</sheets></workbook>");
    wb_rels.push_str("</Relationships>");
    overrides.push(("/docProps/core.xml".into(), "application/vnd.openxmlformats-package.core-properties+xml"));

    let types = content_types(&overrides);
    let rels = rels_with_core("xl/workbook.xml");
    let core = core_props(&doc.title);
    let mut entries: Vec<(&str, &[u8])> = vec![
        ("[Content_Types].xml", types.as_bytes()),
        ("_rels/.rels", rels.as_bytes()),
        ("xl/workbook.xml", workbook.as_bytes()),
        ("xl/_rels/workbook.xml.rels", wb_rels.as_bytes()),
        ("docProps/core.xml", core.as_bytes()),
    ];
    for (name, (_, xml)) in names.iter().zip(&sheets) {
        entries.push((name.as_str(), xml.as_bytes()));
    }
    zip(&entries)
}

#[cfg(test)]
mod tests {
    use super::super::tests::sample;
    use super::super::zip::unzip;
    use super::*;

    fn part(z: &[(String, Vec<u8>)], name: &str) -> String {
        String::from_utf8(z.iter().find(|(n, _)| n == name).unwrap_or_else(|| panic!("{name} missing")).1.clone()).unwrap()
    }

    #[test]
    fn writes_a_word_package() {
        let z = unzip(&docx(&sample()));
        let names: Vec<_> = z.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "docProps/core.xml"]);
        let d = part(&z, "word/document.xml");
        assert!(d.contains("<w:outlineLvl w:val=\"0\"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val=\"40\"/>"));
        assert!(d.contains(">The team is international &amp; small.</w:t>"));
        assert!(d.contains("<w:br w:type=\"page\"/>"));
        assert_eq!(d.matches("<w:tr>").count(), 2);
        assert_eq!(d.matches("<w:tc>").count(), 6);
        assert!(d.contains("<w:pgSz w:w=\"11900\" w:h=\"16840\"/>"));
        assert!(part(&z, "docProps/core.xml").contains("<dc:title>Report &lt;1&gt;</dc:title>"));
    }

    #[test]
    fn writes_an_excel_package() {
        let z = unzip(&xlsx(&sample()));
        let wb = part(&z, "xl/workbook.xml");
        assert!(wb.contains("<sheet name=\"Page 1\" sheetId=\"1\" r:id=\"rId1\"/><sheet name=\"Page 2\" sheetId=\"2\" r:id=\"rId2\"/>"));
        let s1 = part(&z, "xl/worksheets/sheet1.xml");
        assert!(s1.contains("<row r=\"5\"><c r=\"A5\" t=\"inlineStr\"><is><t xml:space=\"preserve\">Name</t></is></c><c r=\"C5\" t=\"inlineStr\">"));
        assert!(s1.contains("<c r=\"B6\"><v>12</v></c><c r=\"C6\"><v>42.5</v></c>"));
        assert!(part(&z, "[Content_Types].xml").contains("/xl/worksheets/sheet2.xml"));
        assert!(part(&z, "xl/worksheets/sheet2.xml").contains("Été €"));
    }

    #[test]
    fn an_empty_document_still_has_a_sheet() {
        let z = unzip(&xlsx(&TextDoc { title: String::new(), pages: vec![] }));
        assert!(part(&z, "xl/workbook.xml").contains("Page 1"));
    }

    #[test]
    fn names_columns() {
        assert_eq!(column_name(0), "A");
        assert_eq!(column_name(25), "Z");
        assert_eq!(column_name(26), "AA");
        assert_eq!(column_name(27), "AB");
        assert_eq!(column_name(701), "ZZ");
        assert_eq!(column_name(702), "AAA");
    }

    #[test]
    fn reads_numbers_in_both_conventions() {
        assert_eq!(as_number("12"), Some(12.0));
        assert_eq!(as_number("-3.5"), Some(-3.5));
        assert_eq!(as_number("1,234.50"), Some(1234.5));
        assert_eq!(as_number("1.234,50"), Some(1234.5));
        assert_eq!(as_number("1 234,50"), Some(1234.5));
        assert_eq!(as_number("1,5"), Some(1.5));
        assert_eq!(as_number("12,345"), Some(12345.0));
        assert_eq!(as_number("0.25"), Some(0.25));
        assert_eq!(as_number("0,125"), Some(0.125));
        assert_eq!(as_number("0612"), None);
        assert_eq!(as_number("2024-01-02"), None);
        assert_eq!(as_number("1,2,3"), None);
        assert_eq!(as_number("abc"), None);
        assert_eq!(as_number(""), None);
    }
}
