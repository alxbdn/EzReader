//! Text recognition (OCR): uses the engine built into Windows 10 and 11
//! (`Windows.Media.Ocr`) on Windows, and Tesseract CLI (`tesseract`) on Linux
//! and other Unix platforms.

use serde::Serialize;

/// A recognized word; the box is in fractions of the picture (0 to 1), so
/// it maps onto a page whatever the resolution it was rendered at.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrWord {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrLine {
    pub text: String,
    pub words: Vec<OcrWord>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrResult {
    /// The lines, one per line of text.
    pub text: String,
    pub lines: Vec<OcrLine>,
    /// Tag of the language used (e.g. "fr-FR" on Windows or "fra" on Tesseract).
    pub language: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrLanguage {
    pub tag: String,
    /// The language's readable name.
    pub name: String,
}

/// Resizes small images up so text reaches a comfortable height, clamps to
/// `max_side`, and composites transparent pixels over white paper.
pub(crate) fn prepare_rgba(bytes: &[u8], max_side: u32) -> Result<image::RgbaImage, String> {
    let img = image::load_from_memory(bytes).map_err(|e| e.to_string())?;
    let (w, h) = (img.width().max(1), img.height().max(1));
    let side = w.max(h);
    let scale = (if side < 1600 { 2.0f32 } else { 1.0 }).min(max_side as f32 / side as f32);
    let img = if (scale - 1.0).abs() > f32::EPSILON {
        let nw = ((w as f32 * scale).round() as u32).max(1);
        let nh = ((h as f32 * scale).round() as u32).max(1);
        img.resize_exact(nw, nh, image::imageops::FilterType::CatmullRom)
    } else {
        img
    };
    let mut rgba = img.to_rgba8();
    // Transparent areas read as white paper.
    for p in rgba.pixels_mut() {
        let a = p[3] as u32;
        if a < 255 {
            for c in 0..3 {
                p[c] = ((p[c] as u32 * a + 255 * (255 - a)) / 255) as u8;
            }
            p[3] = 255;
        }
    }
    Ok(rgba)
}

/// The picture as Windows OCR wants it: BGRA pixels, small text enlarged
/// (it reads text from about 20 px high best) and the whole thing within
/// `max_side`.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn prepare(bytes: &[u8], max_side: u32) -> Result<(Vec<u8>, u32, u32), String> {
    let rgba = prepare_rgba(bytes, max_side)?;
    let (w, h) = rgba.dimensions();
    let mut bgra = rgba.into_raw();
    for px in bgra.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
    }
    Ok((bgra, w, h))
}

/// The prepared picture encoded as PNG bytes, along with its pixel dimensions,
/// for engines that consume standard image files/streams (such as Tesseract).
#[cfg_attr(windows, allow(dead_code))]
pub fn prepare_png(bytes: &[u8], max_side: u32) -> Result<(Vec<u8>, u32, u32), String> {
    let rgba = prepare_rgba(bytes, max_side)?;
    let (w, h) = rgba.dimensions();
    let mut out = Vec::new();
    rgba.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok((out, w, h))
}

/// Joins recognized lines into the text shown to the user.
pub fn join_lines(lines: &[OcrLine]) -> String {
    lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join("\n")
}

#[cfg(windows)]
mod engine {
    use super::*;
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::DataWriter;

    fn init() {
        // WinRT needs the thread in a COM apartment; "already initialized"
        // (in any mode) is fine.
        unsafe {
            let _ = windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED);
        }
    }

    pub fn languages() -> Result<Vec<OcrLanguage>, String> {
        init();
        let list = OcrEngine::AvailableRecognizerLanguages().map_err(|e| e.message())?;
        Ok(list
            .into_iter()
            .map(|l| OcrLanguage {
                tag: l.LanguageTag().map(|s| s.to_string()).unwrap_or_default(),
                name: l.DisplayName().map(|s| s.to_string()).unwrap_or_default(),
            })
            .filter(|l| !l.tag.is_empty())
            .collect())
    }

    pub fn recognize(bytes: &[u8], language: Option<&str>) -> Result<OcrResult, String> {
        init();
        let engine = match language.filter(|t| !t.is_empty()) {
            Some(tag) => {
                let lang = Language::CreateLanguage(&HSTRING::from(tag)).map_err(|e| e.message())?;
                OcrEngine::TryCreateFromLanguage(&lang)
            }
            None => OcrEngine::TryCreateFromUserProfileLanguages(),
        }
        .map_err(|_| "no-ocr-language".to_string())?;

        let max_side = OcrEngine::MaxImageDimension().unwrap_or(4000).max(1000);
        let (bgra, w, h) = prepare(bytes, max_side)?;
        let writer = DataWriter::new().map_err(|e| e.message())?;
        writer.WriteBytes(&bgra).map_err(|e| e.message())?;
        let buffer = writer.DetachBuffer().map_err(|e| e.message())?;
        let bitmap = SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Bgra8, w as i32, h as i32)
            .map_err(|e| e.message())?;
        let result = engine
            .RecognizeAsync(&bitmap)
            .and_then(|op| op.get())
            .map_err(|e| e.message())?;

        let (fw, fh) = (w as f32, h as f32);
        let mut lines = Vec::new();
        for line in result.Lines().map_err(|e| e.message())? {
            let mut words = Vec::new();
            for word in line.Words().map_err(|e| e.message())? {
                let r = word.BoundingRect().map_err(|e| e.message())?;
                words.push(OcrWord {
                    text: word.Text().map(|s| s.to_string()).unwrap_or_default(),
                    x: r.X / fw,
                    y: r.Y / fh,
                    w: r.Width / fw,
                    h: r.Height / fh,
                });
            }
            lines.push(OcrLine { text: line.Text().map(|s| s.to_string()).unwrap_or_default(), words });
        }
        let language = engine
            .RecognizerLanguage()
            .and_then(|l| l.LanguageTag())
            .map(|s| s.to_string())
            .unwrap_or_default();
        Ok(OcrResult { text: join_lines(&lines), lines, language })
    }
}

#[cfg(not(windows))]
mod engine {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    /// Maps a Tesseract language code to a human-readable display name.
    fn display_name(tag: &str) -> String {
        match tag {
            "eng" => "English",
            "fra" => "Français",
            "deu" => "Deutsch",
            "spa" => "Español",
            "ita" => "Italiano",
            "por" => "Português",
            "rus" => "Русский",
            "ukr" => "Українська",
            "nld" => "Nederlands",
            "pol" => "Polski",
            "tur" => "Türkçe",
            "ara" => "العربية",
            "hin" => "हिन्दी",
            "ben" => "বাংলা",
            "urd" => "اردو",
            "ind" => "Bahasa Indonesia",
            "swa" => "Kiswahili",
            "mar" => "मराठी",
            "tel" => "తెలుగు",
            "tam" => "தமிழ்",
            "vie" => "Tiếng Việt",
            "jpn" => "日本語",
            "kor" => "한국어",
            "chi_sim" => "中文 (简体)",
            "chi_tra" => "中文 (繁體)",
            _ => return tag.to_string(),
        }
        .to_string()
    }

    /// Maps a BCP-47 / POSIX locale prefix (e.g. `"fr-FR"`, `"en_US.UTF-8"`)
    /// to the corresponding Tesseract 3-letter traineddata code.
    fn bcp47_to_tesseract(code: &str) -> Option<&'static str> {
        let trimmed = code.trim();
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("zh-tw")
            || lower.starts_with("zh_tw")
            || lower.starts_with("zh-hk")
            || lower.starts_with("zh-hant")
        {
            return Some("chi_tra");
        }
        let prefix = lower
            .split(['.', '_', '-'])
            .next()
            .unwrap_or("");
        match prefix {
            "en" => Some("eng"),
            "fr" => Some("fra"),
            "de" => Some("deu"),
            "es" => Some("spa"),
            "it" => Some("ita"),
            "pt" => Some("por"),
            "ru" => Some("rus"),
            "uk" => Some("ukr"),
            "nl" => Some("nld"),
            "pl" => Some("pol"),
            "tr" => Some("tur"),
            "ar" => Some("ara"),
            "hi" => Some("hin"),
            "bn" => Some("ben"),
            "ur" => Some("urd"),
            "id" => Some("ind"),
            "sw" => Some("swa"),
            "mr" => Some("mar"),
            "te" => Some("tel"),
            "ta" => Some("tam"),
            "vi" => Some("vie"),
            "ja" => Some("jpn"),
            "ko" => Some("kor"),
            "zh" => Some("chi_sim"),
            _ => None,
        }
    }

    /// Parses the language codes returned by `tesseract --list-langs`.
    pub(super) fn parse_lang_list(output: &str) -> Vec<OcrLanguage> {
        output
            .lines()
            .map(str::trim)
            .filter(|line| {
                !line.is_empty()
                    && !line.contains("List of available languages")
                    && *line != "osd"
                    && *line != "equ"
                    && line.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            })
            .map(|tag| OcrLanguage {
                tag: tag.to_string(),
                name: display_name(tag),
            })
            .collect()
    }

    pub fn languages() -> Result<Vec<OcrLanguage>, String> {
        let Ok(out) = Command::new("tesseract").arg("--list-langs").output() else {
            return Ok(Vec::new());
        };
        if !out.status.success() {
            return Ok(Vec::new());
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        let mut langs = parse_lang_list(&stdout);
        if langs.is_empty() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            langs = parse_lang_list(&stderr);
        }
        Ok(langs)
    }

    /// Chooses the installed Tesseract language matching `requested` (if any)
    /// or falls back to system locale / `"eng"` / `"fra"` / first installed.
    fn resolve_language(avail: &[OcrLanguage], requested: Option<&str>) -> Result<String, String> {
        if avail.is_empty() {
            return Err("no-ocr-language".into());
        }
        let find_avail = |tag: &str| avail.iter().find(|l| l.tag == tag).map(|l| l.tag.clone());

        if let Some(req) = requested.map(str::trim).filter(|t| !t.is_empty()) {
            if let Some(exact) = find_avail(req) {
                return Ok(exact);
            }
            if let Some(mapped) = bcp47_to_tesseract(req).and_then(find_avail) {
                return Ok(mapped);
            }
            return Err("no-ocr-language".into());
        }

        for var in ["LC_ALL", "LANG"] {
            if let Ok(val) = std::env::var(var) {
                let raw = val.split('.').next().unwrap_or("");
                if let Some(found) = find_avail(raw)
                    .or_else(|| bcp47_to_tesseract(raw).and_then(find_avail))
                {
                    return Ok(found);
                }
            }
        }
        Ok(find_avail("eng")
            .or_else(|| find_avail("fra"))
            .unwrap_or_else(|| avail[0].tag.clone()))
    }

    /// Parses Tesseract's TSV output into lines and normalized word bounding boxes.
    pub(super) fn parse_tsv(tsv: &str, img_w: u32, img_h: u32) -> Vec<OcrLine> {
        let fw = img_w.max(1) as f32;
        let fh = img_h.max(1) as f32;
        let mut lines: Vec<OcrLine> = Vec::new();
        let mut current_key: Option<(u32, u32, u32, u32)> = None;
        let mut current_words: Vec<OcrWord> = Vec::new();

        let flush = |words: &mut Vec<OcrWord>, out: &mut Vec<OcrLine>| {
            if words.is_empty() {
                return;
            }
            let text = words
                .iter()
                .map(|w| w.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            out.push(OcrLine {
                text,
                words: std::mem::take(words),
            });
        };

        for raw in tsv.lines() {
            let line = raw.trim_end_matches('\r');
            let mut cols = line.splitn(12, '\t');
            let (
                Some(level),
                Some(page),
                Some(block),
                Some(par),
                Some(line_no),
                Some(_word_no),
                Some(left),
                Some(top),
                Some(width),
                Some(height),
                Some(conf),
                Some(text),
            ) = (
                cols.next(),
                cols.next(),
                cols.next(),
                cols.next(),
                cols.next(),
                cols.next(),
                cols.next(),
                cols.next(),
                cols.next(),
                cols.next(),
                cols.next(),
                cols.next(),
            )
            else {
                continue;
            };
            if level.trim() != "5" {
                continue;
            }
            if conf.trim().parse::<f32>().unwrap_or(-1.0) < 0.0 {
                continue;
            }
            let word_text = text.trim();
            if word_text.is_empty() {
                continue;
            }
            let (Ok(pg), Ok(bl), Ok(pr), Ok(ln)) = (
                page.trim().parse::<u32>(),
                block.trim().parse::<u32>(),
                par.trim().parse::<u32>(),
                line_no.trim().parse::<u32>(),
            ) else {
                continue;
            };
            let (Ok(l), Ok(t), Ok(w), Ok(h)) = (
                left.trim().parse::<f32>(),
                top.trim().parse::<f32>(),
                width.trim().parse::<f32>(),
                height.trim().parse::<f32>(),
            ) else {
                continue;
            };
            let key = (pg, bl, pr, ln);
            if current_key != Some(key) {
                flush(&mut current_words, &mut lines);
                current_key = Some(key);
            }
            current_words.push(OcrWord {
                text: word_text.to_string(),
                x: (l / fw).clamp(0.0, 1.0),
                y: (t / fh).clamp(0.0, 1.0),
                w: (w / fw).clamp(0.0, 1.0),
                h: (h / fh).clamp(0.0, 1.0),
            });
        }
        flush(&mut current_words, &mut lines);
        lines
    }

    pub fn recognize(bytes: &[u8], language: Option<&str>) -> Result<OcrResult, String> {
        let avail = languages()?;
        let lang_tag = resolve_language(&avail, language)?;
        let (png_bytes, w, h) = prepare_png(bytes, 4000)?;

        let mut child = Command::new("tesseract")
            .args(["stdin", "stdout", "-l", &lang_tag, "--psm", "3", "tsv"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| "no-ocr-language".to_string())?;

        if let Some(mut stdin) = child.stdin.take() {
            // Ignore BrokenPipe in case Tesseract already exited; wait_with_output reports status.
            let _ = stdin.write_all(&png_bytes);
        }

        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if err.is_empty() {
                "tesseract failed".into()
            } else {
                err
            });
        }

        let tsv = String::from_utf8_lossy(&out.stdout);
        let lines = parse_tsv(&tsv, w, h);
        Ok(OcrResult {
            text: join_lines(&lines),
            lines,
            language: lang_tag,
        })
    }
}

pub use engine::{languages, recognize};

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32, px: [u8; 4]) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(w, h, image::Rgba(px));
        let mut out = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).unwrap();
        out
    }

    #[test]
    fn enlarges_small_pictures_and_swaps_to_bgra() {
        let (bgra, w, h) = prepare(&png(100, 50, [10, 20, 30, 255]), 10000).unwrap();
        assert_eq!((w, h), (200, 100));
        assert_eq!(&bgra[..4], &[30, 20, 10, 255]);
        assert_eq!(bgra.len(), 200 * 100 * 4);
    }

    #[test]
    fn keeps_large_pictures_within_the_engine_limit() {
        let (_, w, h) = prepare(&png(3000, 1000, [0, 0, 0, 255]), 2000).unwrap();
        assert_eq!((w, h), (2000, 667));
        let (_, w, _) = prepare(&png(1700, 10, [0, 0, 0, 255]), 10000).unwrap();
        assert_eq!(w, 1700);
    }

    #[test]
    fn transparent_pixels_become_white() {
        let (bgra, _, _) = prepare(&png(2, 2, [0, 0, 0, 0]), 10000).unwrap();
        assert_eq!(&bgra[..4], &[255, 255, 255, 255]);
    }

    #[test]
    fn refuses_what_is_not_a_picture() {
        assert!(prepare(b"not a picture", 1000).is_err());
    }

    #[test]
    fn joins_lines() {
        let l = |t: &str| OcrLine { text: t.into(), words: vec![] };
        assert_eq!(join_lines(&[l("a b"), l("c")]), "a b\nc");
    }

    #[cfg(not(windows))]
    #[test]
    fn parses_tesseract_lang_list_and_tsv() {
        let langs = engine::parse_lang_list(
            "List of available languages in \"/usr/share/tesseract-ocr/5/tessdata/\" (4):\neng\nfra\nosd\nequ\n",
        );
        assert_eq!(langs.len(), 2);
        assert_eq!(langs[0].tag, "eng");
        assert_eq!(langs[0].name, "English");
        assert_eq!(langs[1].tag, "fra");
        assert_eq!(langs[1].name, "Français");

        let tsv = concat!(
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n",
            "4\t1\t1\t1\t1\t0\t10\t20\t200\t40\t-1\t\n",
            "5\t1\t1\t1\t1\t1\t10\t20\t80\t40\t95\tHello\n",
            "5\t1\t1\t1\t1\t2\t100\t20\t110\t40\t96\tEzReader\n",
            "5\t1\t1\t1\t2\t1\t10\t80\t60\t30\t90\tWorld\n",
        );
        let lines = engine::parse_tsv(tsv, 400, 200);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text, "Hello EzReader");
        assert_eq!(lines[0].words.len(), 2);
        assert!((lines[0].words[0].x - 0.025).abs() < 1e-5);
        assert!((lines[0].words[0].y - 0.1).abs() < 1e-5);
        assert_eq!(lines[1].text, "World");
    }

    #[test]
    fn prepare_png_encodes_scaled_png() {
        let (out, w, h) = prepare_png(&png(100, 50, [10, 20, 30, 255]), 10000).unwrap();
        assert_eq!((w, h), (200, 100));
        assert_eq!(image::guess_format(&out).unwrap(), image::ImageFormat::Png);
    }

    /// Reads a real picture of text when an OCR language is installed
    /// (skipped on machines without one).
    #[test]
    fn recognizes_text_on_windows() {
        if languages().map(|l| l.is_empty()).unwrap_or(true) {
            eprintln!("no OCR language installed: skipped");
            return;
        }
        let bytes = include_bytes!("../tests/fixtures/ocr-hello.png");
        let r = recognize(bytes, None).unwrap();
        let text = r.text.to_lowercase();
        assert!(text.contains("hello"), "got {:?}", r.text);
        assert!(text.contains("ezreader"), "got {:?}", r.text);
        let first = &r.lines[0].words[0];
        assert!(first.x > 0.0 && first.x < 0.5 && first.w > 0.0 && first.y >= 0.0 && first.h > 0.0);
    }
}
