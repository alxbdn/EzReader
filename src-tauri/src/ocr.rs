//! Text recognition (OCR) with the engine built into Windows 10 and 11
//! (`Windows.Media.Ocr`): nothing to bundle, and it reads every language
//! whose OCR pack is installed in Windows (usually the display languages).

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
    /// BCP-47 tag of the language used ("fr-FR").
    pub language: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrLanguage {
    pub tag: String,
    /// The language's name, in the Windows display language.
    pub name: String,
}

/// The picture as Windows OCR wants it: BGRA pixels, small text enlarged
/// (it reads text from about 20 px high best) and the whole thing within
/// `max_side`.
pub fn prepare(bytes: &[u8], max_side: u32) -> Result<(Vec<u8>, u32, u32), String> {
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
    let (w, h) = rgba.dimensions();
    let mut bgra = rgba.into_raw();
    for px in bgra.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
    }
    Ok((bgra, w, h))
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

    pub fn languages() -> Result<Vec<OcrLanguage>, String> {
        Ok(Vec::new())
    }

    pub fn recognize(_bytes: &[u8], _language: Option<&str>) -> Result<OcrResult, String> {
        Err("no-ocr-language".into())
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

    /// Reads a real picture of text when Windows has an OCR language
    /// (skipped elsewhere, and on machines without one).
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
