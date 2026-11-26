use crate::error::{CmdResult, ErrorCode, PdfError};
use std::path::Path;

use tauri::AppHandle;

pub(crate) fn rename_no_clobber(from: &Path, to: &Path) -> CmdResult<()> {
    if from.parent() != to.parent() {
        return Err(PdfError::new(ErrorCode::InvalidName, "invalid"));
    }
    match to.file_name().and_then(|n| n.to_str()) {
        Some(name) if !name.trim().is_empty() && !name.contains(['/', '\\']) => {}
        _ => return Err(PdfError::new(ErrorCode::InvalidName, "invalid")),
    }
    if from == to {
        return Ok(());
    }
    let same_file = is_same_file(from, to);
    if to.exists() && !same_file {
        return Err(PdfError::new(ErrorCode::Exists, "exists"));
    }
    std::fs::rename(from, to).map_err(|e| e.to_string()).map_err(PdfError::from)
}

#[cfg(windows)]
fn is_same_file(from: &Path, to: &Path) -> bool {
    from.to_string_lossy().eq_ignore_ascii_case(&to.to_string_lossy())
}

#[cfg(unix)]
fn is_same_file(from: &Path, to: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(from), std::fs::metadata(to)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

#[tauri::command]
pub fn rename_file(app: AppHandle, from: String, to: String) -> CmdResult<()> {
    if !crate::grants::is_granted_file(&from) {
        return Err(PdfError::new(ErrorCode::NotAllowed, "not a file you opened"));
    }
    rename_no_clobber(Path::new(&from), Path::new(&to))?;
    crate::allow_viewing(&app, &to);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "ezreader-rename-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn renames_a_file() {
        let d = dir();
        let a = d.join("a.pdf");
        let b = d.join("b.pdf");
        std::fs::write(&a, b"x").unwrap();
        rename_no_clobber(&a, &b).unwrap();
        assert!(!a.exists());
        assert_eq!(std::fs::read(&b).unwrap(), b"x");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn refuses_to_overwrite() {
        let d = dir();
        let a = d.join("a.pdf");
        let b = d.join("b.pdf");
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&b, b"b").unwrap();
        assert_eq!(rename_no_clobber(&a, &b), Err(PdfError::new(ErrorCode::Exists, "exists")));
        assert_eq!(std::fs::read(&b).unwrap(), b"b");
        assert!(a.exists());
        let _ = std::fs::remove_dir_all(d);
    }

    #[cfg(not(windows))]
    #[test]
    fn case_only_renames_follow_the_disk() {
        let d = dir();
        let lower = d.join("a.pdf");
        let upper = d.join("A.pdf");
        std::fs::write(&lower, b"lower").unwrap();
        std::fs::write(&upper, b"upper").unwrap();
        if std::fs::read(&lower).unwrap() == b"upper" {
            assert_eq!(rename_no_clobber(&lower, &upper), Ok(()));
            let names: Vec<_> = std::fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name()).collect();
            assert_eq!(names, ["A.pdf"]);
            let _ = std::fs::remove_dir_all(d);
            return;
        }
        assert_eq!(rename_no_clobber(&lower, &upper), Err(PdfError::new(ErrorCode::Exists, "exists")));
        assert_eq!(std::fs::read(&upper).unwrap(), b"upper");
        assert!(lower.exists());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn refuses_other_folders_and_empty_names() {
        let d = dir();
        let a = d.join("a.pdf");
        std::fs::write(&a, b"a").unwrap();
        let elsewhere = d.join("sub").join("b.pdf");
        assert_eq!(rename_no_clobber(&a, &elsewhere), Err(PdfError::new(ErrorCode::InvalidName, "invalid")));
        assert_eq!(rename_no_clobber(&a, &d.join(" ")), Err(PdfError::new(ErrorCode::InvalidName, "invalid")));
        assert!(a.exists());
        let _ = std::fs::remove_dir_all(d);
    }

    fn picture_file(d: &std::path::Path, name: &str, w: u32, h: u32, format: image::ImageFormat) -> String {
        let path = d.join(name);
        image::RgbImage::from_pixel(w, h, image::Rgb([200, 40, 40])).save_with_format(&path, format).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn a_small_png_is_kept_byte_for_byte() {
        use base64::Engine;
        let d = dir();
        let path = picture_file(&d, "small.png", 30, 20, image::ImageFormat::Png);
        let pic = load_picture(path.clone()).unwrap();
        assert_eq!((pic.width, pic.height), (30, 20));
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(pic.data).unwrap(), std::fs::read(path).unwrap());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn other_formats_become_png_and_large_pictures_shrink() {
        use base64::Engine;
        let d = dir();
        let bmp = load_picture(picture_file(&d, "pic.bmp", 40, 10, image::ImageFormat::Bmp)).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(&bmp.data).unwrap();
        assert_eq!(image::guess_format(&bytes).unwrap(), image::ImageFormat::Png);
        assert_eq!((bmp.width, bmp.height), (40, 10));

        let big = load_picture(picture_file(&d, "big.jpg", 5000, 2500, image::ImageFormat::Jpeg)).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(&big.data).unwrap();
        assert_eq!(image::guess_format(&bytes).unwrap(), image::ImageFormat::Jpeg, "a photo stays a JPEG");
        assert_eq!((big.width, big.height), (4096, 2048));

        let text = d.join("notes.txt");
        std::fs::write(&text, b"hello").unwrap();
        assert_eq!(load_picture(text.to_string_lossy().into_owned()).unwrap_err().code, ErrorCode::NotAnImage);
        let _ = std::fs::remove_dir_all(d);
    }
}

const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;

pub fn read_image_bytes(path: &str) -> CmdResult<Vec<u8>> {
    let p = std::path::Path::new(path);
    let ext = p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    if !crate::commands::dialog::IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(PdfError::new(ErrorCode::NotAnImage, "not an image"));
    }
    let len = std::fs::metadata(p).map_err(|e| e.to_string())?.len();
    if len > MAX_IMAGE_BYTES {
        return Err(PdfError::new(ErrorCode::TooLarge, "too large"));
    }
    std::fs::read(p).map_err(|e| e.to_string()).map_err(PdfError::from)
}

#[derive(Debug, serde::Serialize, PartialEq)]
pub struct Picture {
    pub data: String,
    pub width: u32,
    pub height: u32,
}

const MAX_PICTURE_SIDE: u32 = 4096;

#[tauri::command(async)]
pub fn load_picture(path: String) -> CmdResult<Picture> {
    crate::grants::check(&path)?;
    picture_from_bytes(&read_image_bytes(&path)?)
}

pub(crate) fn picture_from_bytes(bytes: &[u8]) -> CmdResult<Picture> {
    use base64::Engine;
    let not_an_image = |e: image::ImageError| PdfError::new(ErrorCode::NotAnImage, e.to_string());
    let format = image::guess_format(bytes).map_err(not_an_image)?;
    let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
    let keep = matches!(format, image::ImageFormat::Png | image::ImageFormat::Jpeg);
    if keep {
        let (width, height) = image::ImageReader::with_format(std::io::Cursor::new(bytes), format)
            .into_dimensions()
            .map_err(not_an_image)?;
        if width.max(height) <= MAX_PICTURE_SIDE {
            return Ok(Picture { data: b64(bytes), width, height });
        }
    }
    let mut img = image::load_from_memory_with_format(bytes, format).map_err(not_an_image)?;
    if img.width().max(img.height()) > MAX_PICTURE_SIDE {
        img = img.resize(MAX_PICTURE_SIDE, MAX_PICTURE_SIDE, image::imageops::FilterType::Triangle);
    }
    let mut out = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut out);
    if format == image::ImageFormat::Jpeg {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 92)
            .encode_image(&img.to_rgb8())
            .map_err(not_an_image)?;
    } else {
        img.write_to(&mut cursor, image::ImageFormat::Png).map_err(not_an_image)?;
    }
    Ok(Picture { data: b64(&out), width: img.width(), height: img.height() })
}

const MAX_SVG_BYTES: u64 = 2 * 1024 * 1024;

/// An SVG picture for a stamp, as base64. The interface only draws it through an `<img>`,
/// where scripts and outside links never run.
#[tauri::command(async)]
pub fn load_svg(path: String) -> CmdResult<String> {
    crate::grants::check(&path)?;
    svg_from_file(std::path::Path::new(&path))
}

pub(crate) fn svg_from_file(p: &std::path::Path) -> CmdResult<String> {
    use base64::Engine;
    let ext = p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    if ext != "svg" {
        return Err(PdfError::new(ErrorCode::NotAnImage, "not an SVG picture"));
    }
    let len = std::fs::metadata(p).map_err(|e| e.to_string())?.len();
    if len > MAX_SVG_BYTES {
        return Err(PdfError::new(ErrorCode::TooLarge, "too large"));
    }
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    let text = std::str::from_utf8(&bytes).map_err(|_| PdfError::new(ErrorCode::NotAnImage, "not an SVG picture"))?;
    if !text.contains("<svg") {
        return Err(PdfError::new(ErrorCode::NotAnImage, "not an SVG picture"));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[cfg(test)]
mod svg_tests {
    use super::*;

    fn file(name: &str, body: &[u8]) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ezreader-svg-{}-{}", std::process::id(), name));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join(name);
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn reads_an_svg_file() {
        let p = file("stamp.svg", br#"<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>"#);
        assert!(svg_from_file(&p).unwrap().starts_with("PHN2Zy"));
    }

    #[test]
    fn refuses_other_files() {
        assert_eq!(svg_from_file(&file("a.txt", b"<svg/>")).unwrap_err().code, ErrorCode::NotAnImage);
        assert_eq!(svg_from_file(&file("b.svg", b"hello")).unwrap_err().code, ErrorCode::NotAnImage);
        assert_eq!(svg_from_file(&file("c.svg", &[0xff, 0xfe, 0])).unwrap_err().code, ErrorCode::NotAnImage);
    }
}

#[tauri::command]
pub fn temp_tag() -> String {
    crate::tempfiles::tag()
}

#[tauri::command]
pub fn existing_files(paths: Vec<String>) -> Vec<String> {
    paths.into_iter().filter(|p| crate::grants::check(p).is_ok() && std::path::Path::new(p).exists()).collect()
}

#[tauri::command(async)]
pub fn write_image_file(path: String, data: String) -> CmdResult<()> {
    use base64::Engine;
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg") {
        return Err(PdfError::new(ErrorCode::NotAnImage, "only PNG and JPEG pictures can be written"));
    }
    crate::grants::check(&path)?;
    let b64 = data.split_once(',').map_or(data.as_str(), |(_, d)| d);
    let bytes =
        base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| format!("invalid image data: {e}"))?;
    crate::fsutil::write_atomic(&path, |tmp| std::fs::write(tmp, &bytes).map_err(|e| e.to_string()))
        .map_err(PdfError::from)
}

#[cfg(test)]
mod export_tests {
    use super::*;
    use base64::Engine;

    fn dir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "ezreader-export-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn writes_png_and_jpeg_pictures_from_base64() {
        let d = dir();
        let png = d.join("page.png").to_string_lossy().into_owned();
        let data = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(b"png bytes"));
        write_image_file(png.clone(), data).unwrap();
        assert_eq!(std::fs::read(&png).unwrap(), b"png bytes");

        let jpg = d.join("page.JPG").to_string_lossy().into_owned();
        write_image_file(jpg.clone(), base64::engine::general_purpose::STANDARD.encode(b"jpg")).unwrap();
        assert_eq!(std::fs::read(&jpg).unwrap(), b"jpg");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn refuses_other_extensions_and_bad_data() {
        let d = dir();
        let exe = d.join("page.exe").to_string_lossy().into_owned();
        assert_eq!(write_image_file(exe.clone(), String::new()).unwrap_err().code, ErrorCode::NotAnImage);
        assert!(!Path::new(&exe).exists());
        let png = d.join("page.png").to_string_lossy().into_owned();
        assert!(write_image_file(png.clone(), "not base64!".into()).is_err());
        assert!(!Path::new(&png).exists());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn lists_only_the_files_that_exist() {
        let d = dir();
        let there = d.join("there.png").to_string_lossy().into_owned();
        let missing = d.join("missing.png").to_string_lossy().into_owned();
        std::fs::write(&there, b"x").unwrap();
        assert_eq!(existing_files(vec![there.clone(), missing]), vec![there]);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn temp_tag_matches_the_temp_files() {
        assert_eq!(temp_tag(), crate::tempfiles::tag());
    }

    #[test]
    fn reads_picture_bytes_within_limits() {
        let d = dir();
        let png = d.join("a.png");
        std::fs::write(&png, b"bytes").unwrap();
        assert_eq!(read_image_bytes(&png.to_string_lossy()).unwrap(), b"bytes");
        assert_eq!(read_image_bytes(&d.join("a.txt").to_string_lossy()).unwrap_err().code, ErrorCode::NotAnImage);
        assert!(read_image_bytes(&d.join("gone.png").to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(d);
    }
}

/// Largest entry an EPUB may unpack to (same limit as the interface's ZIP reader).
const MAX_INFLATED: u64 = 64 * 1024 * 1024;

/// Unpacks one deflated ZIP entry of an EPUB, for webviews without `DecompressionStream`
/// (the WebKit of macOS 11 to 13). Raw bytes in, raw bytes out.
#[tauri::command]
pub fn inflate_raw(request: tauri::ipc::Request<'_>) -> CmdResult<tauri::ipc::Response> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err(PdfError::new(ErrorCode::Other, "expected raw bytes"));
    };
    inflate_limited(data).map(tauri::ipc::Response::new)
}

pub(crate) fn inflate_limited(data: &[u8]) -> CmdResult<Vec<u8>> {
    use std::io::Read;
    let mut out = Vec::new();
    flate2::read::DeflateDecoder::new(data)
        .take(MAX_INFLATED + 1)
        .read_to_end(&mut out)
        .map_err(|e| PdfError::new(ErrorCode::Other, e.to_string()))?;
    if out.len() as u64 > MAX_INFLATED {
        return Err(PdfError::new(ErrorCode::TooLarge, "entry too large"));
    }
    Ok(out)
}

#[cfg(test)]
mod inflate_tests {
    use super::inflate_limited;
    use std::io::Write;

    #[test]
    fn inflates_a_deflated_entry() {
        let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(b"<html>chapter one</html>").unwrap();
        let packed = enc.finish().unwrap();
        assert_eq!(inflate_limited(&packed).unwrap(), b"<html>chapter one</html>");
    }

    #[test]
    fn refuses_garbage() {
        assert!(inflate_limited(&[0xff, 0xff, 0xff, 0xff]).is_err());
    }
}
