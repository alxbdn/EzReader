use crate::error::{CmdResult, ErrorCode, PdfError};
use std::path::Path;

use tauri::AppHandle;

/// Moves `from` to `to` unless `to` already exists, so a rename never
/// overwrites another file. Both paths must be in the same folder.
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
    // A case-only change ("a.pdf" -> "A.pdf") is the same file on Windows.
    let same_file = from
        .to_string_lossy()
        .eq_ignore_ascii_case(&to.to_string_lossy());
    if to.exists() && !same_file {
        return Err(PdfError::new(ErrorCode::Exists, "exists"));
    }
    std::fs::rename(from, to).map_err(|e| e.to_string()).map_err(PdfError::from)
}

/// Renames the open document on disk (the title bar rename, applied on save).
/// Fails with [`ErrorCode::Exists`] when another file already has that name.
#[tauri::command]
pub fn rename_file(app: AppHandle, from: String, to: String) -> CmdResult<()> {
    // Only a document the user opened or saved can be renamed (and only
    // within its folder: see `rename_no_clobber`).
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
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
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

/// Largest picture accepted from disk.
const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;

/// The bytes of a picture file, checked by extension and size.
pub fn read_image_bytes(path: &str) -> CmdResult<Vec<u8>> {
    let p = std::path::Path::new(path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !crate::commands::dialog::IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(PdfError::new(ErrorCode::NotAnImage, "not an image"));
    }
    let len = std::fs::metadata(p).map_err(|e| e.to_string())?.len();
    if len > MAX_IMAGE_BYTES {
        return Err(PdfError::new(ErrorCode::TooLarge, "too large"));
    }
    std::fs::read(p).map_err(|e| e.to_string()).map_err(PdfError::from)
}

/// A picture ready to place on a page: base64 PNG or JPEG, and its size in pixels.
#[derive(Debug, serde::Serialize, PartialEq)]
pub struct Picture {
    pub data: String,
    pub width: u32,
    pub height: u32,
}

/// Longest side kept for a picture; larger ones are scaled down.
const MAX_PICTURE_SIDE: u32 = 4096;

/// Reads the picture at `path` for placing on a page. PNG and JPEG files
/// that are not too large are kept byte for byte; other formats (WebP, GIF,
/// BMP) and very large pictures are re-encoded: as JPEG when they were
/// JPEG, as PNG otherwise (the PDF writer takes both).
#[tauri::command(async)]
pub fn load_picture(path: String) -> CmdResult<Picture> {
    use base64::Engine;
    crate::grants::check(&path)?;
    let bytes = read_image_bytes(&path)?;
    let not_an_image = |e: image::ImageError| PdfError::new(ErrorCode::NotAnImage, e.to_string());
    let format = image::guess_format(&bytes).map_err(not_an_image)?;
    let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
    let keep = matches!(format, image::ImageFormat::Png | image::ImageFormat::Jpeg);
    if keep {
        let (width, height) = image::ImageReader::with_format(std::io::Cursor::new(&bytes), format)
            .into_dimensions()
            .map_err(not_an_image)?;
        if width.max(height) <= MAX_PICTURE_SIDE {
            return Ok(Picture { data: b64(&bytes), width, height });
        }
    }
    let mut img = image::load_from_memory_with_format(&bytes, format).map_err(not_an_image)?;
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

/// What this app's temp file names start with, after `ezreader-`: the
/// app removes them on exit (see [`crate::tempfiles`]).
#[tauri::command]
pub fn temp_tag() -> String {
    crate::tempfiles::tag()
}

/// Which of `paths` already exist (export asks before replacing them).
/// Only paths the export may write are looked at.
#[tauri::command]
pub fn existing_files(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| crate::grants::check(p).is_ok() && std::path::Path::new(p).exists())
        .collect()
}

/// Writes base64 `data` (a page picture of an export) to `path`, atomically.
/// Only PNG and JPEG files can be written this way.
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
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("invalid image data: {e}"))?;
    crate::fsutil::write_atomic(&path, |tmp| std::fs::write(tmp, &bytes).map_err(|e| e.to_string())).map_err(PdfError::from)
}
