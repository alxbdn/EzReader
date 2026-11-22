use std::collections::HashSet;

use image::{DynamicImage, ExtendedColorType, ImageEncoder};
use lopdf::{Document, Object, ObjectId};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImageSettings {
    pub dpi: f64,
    pub quality: u8,
}

pub const BALANCED: ImageSettings = ImageSettings { dpi: 150.0, quality: 75 };
pub const MAXIMUM: ImageSettings = ImageSettings { dpi: 96.0, quality: 55 };
pub const LADDER: [ImageSettings; 8] = [
    ImageSettings { dpi: 300.0, quality: 85 },
    ImageSettings { dpi: 200.0, quality: 80 },
    BALANCED,
    ImageSettings { dpi: 150.0, quality: 60 },
    ImageSettings { dpi: 120.0, quality: 55 },
    MAXIMUM,
    ImageSettings { dpi: 96.0, quality: 40 },
    ImageSettings { dpi: 72.0, quality: 30 },
];

fn single_filter(dict: &lopdf::Dictionary) -> Option<Vec<u8>> {
    match dict.get(b"Filter").ok()? {
        Object::Name(n) => Some(n.clone()),
        Object::Array(a) if a.len() == 1 => a[0].as_name().ok().map(<[u8]>::to_vec),
        _ => None,
    }
}

fn longest_page_side(doc: &Document) -> f64 {
    let mut longest: f64 = 0.0;
    for page_id in doc.get_pages().into_values() {
        let mut node = Some(page_id);
        let mut depth = 0;
        while let Some(id) = node {
            let Ok(dict) = doc.get_dictionary(id) else { break };
            if let Ok(arr) = dict.get(b"MediaBox").and_then(Object::as_array) {
                let v: Vec<f64> = arr.iter().filter_map(|o| o.as_float().ok().map(f64::from)).collect();
                if v.len() == 4 {
                    longest = longest.max((v[2] - v[0]).abs()).max((v[3] - v[1]).abs());
                }
                break;
            }
            node = dict.get(b"Parent").and_then(Object::as_reference).ok();
            depth += 1;
            if depth > 32 {
                break;
            }
        }
    }
    if longest > 0.0 {
        longest
    } else {
        842.0
    }
}

fn mask_ids(doc: &Document) -> HashSet<ObjectId> {
    let mut masks = HashSet::new();
    for obj in doc.objects.values() {
        if let Object::Stream(s) = obj {
            for key in [b"SMask".as_slice(), b"Mask"] {
                if let Ok(id) = s.dict.get(key).and_then(Object::as_reference) {
                    masks.insert(id);
                }
            }
        }
    }
    masks
}

/// `max_side` lets a JPEG 2000 picture skip the resolution levels that would be thrown away anyway.
fn decode_picture(stream: &lopdf::Stream, max_side: u32) -> Option<DynamicImage> {
    let dict = &stream.dict;
    let int = |k: &[u8]| dict.get(k).ok().and_then(|o| o.as_i64().ok());
    if dict.get(b"ImageMask").ok().and_then(|o| o.as_bool().ok()) == Some(true) || dict.has(b"Decode") {
        return None;
    }
    let filter = single_filter(dict)?;
    if filter == b"JPXDecode" {
        return decode_jpx(stream, max_side);
    }
    let channels = match dict.get(b"ColorSpace").ok()?.as_name().ok()? {
        b"DeviceRGB" => 3,
        b"DeviceGray" => 1,
        _ => return None,
    };
    if int(b"BitsPerComponent") != Some(8) {
        return None;
    }
    let (w, h) = (u32::try_from(int(b"Width")?).ok()?, u32::try_from(int(b"Height")?).ok()?);
    match filter.as_slice() {
        b"DCTDecode" => {
            let img = image::load_from_memory_with_format(&stream.content, image::ImageFormat::Jpeg).ok()?;
            Some(if channels == 1 {
                DynamicImage::ImageLuma8(img.to_luma8())
            } else {
                DynamicImage::ImageRgb8(img.to_rgb8())
            })
        }
        b"FlateDecode" => {
            let raw = stream.decompressed_content().ok()?;
            if raw.len() != (w as usize) * (h as usize) * channels {
                return None;
            }
            if channels == 1 {
                image::GrayImage::from_raw(w, h, raw).map(DynamicImage::ImageLuma8)
            } else {
                image::RgbImage::from_raw(w, h, raw).map(DynamicImage::ImageRgb8)
            }
        }
        _ => None,
    }
}

/// A JPEG 2000 picture as plain gray or RGB, or `None` when re-encoding it could change how it
/// looks: transparency inside the codestream, or a colour space other than gray / RGB.
fn decode_jpx(stream: &lopdf::Stream, max_side: u32) -> Option<DynamicImage> {
    let dict = &stream.dict;
    let in_data_mask = dict.get(b"SMaskInData").ok().and_then(|o| o.as_i64().ok()).unwrap_or(0);
    let declared = match dict.get(b"ColorSpace") {
        Err(_) => None,
        Ok(o) => Some(match o.as_name().ok()? {
            b"DeviceRGB" => 3,
            b"DeviceGray" => 1,
            _ => return None,
        }),
    };
    if in_data_mask != 0 {
        return None;
    }
    let int = |k: &[u8]| dict.get(k).ok().and_then(|o| o.as_i64().ok()).and_then(|v| u32::try_from(v).ok());
    let target_resolution = match (int(b"Width"), int(b"Height")) {
        (Some(w), Some(h)) if w.max(h) > max_side => {
            let k = f64::from(max_side) / f64::from(w.max(h));
            Some(((f64::from(w) * k).ceil() as u32, (f64::from(h) * k).ceil() as u32))
        }
        _ => None,
    };
    let settings = hayro_jpeg2000::DecodeSettings { target_resolution, ..Default::default() };
    let image = hayro_jpeg2000::Image::new(&stream.content, &settings).ok()?;
    let channels = match image.color_space() {
        hayro_jpeg2000::ColorSpace::Gray => 1,
        hayro_jpeg2000::ColorSpace::RGB => 3,
        _ => return None,
    };
    if image.has_alpha() || declared.is_some_and(|d| d != channels) {
        return None;
    }
    let img = DynamicImage::from_decoder(image).ok()?;
    Some(if channels == 1 { DynamicImage::ImageLuma8(img.to_luma8()) } else { DynamicImage::ImageRgb8(img.to_rgb8()) })
}

fn encode_jpeg(img: &DynamicImage, quality: u8) -> Option<Vec<u8>> {
    let mut out = std::io::Cursor::new(Vec::<u8>::new());
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality);
    match img {
        DynamicImage::ImageLuma8(g) => {
            encoder.write_image(g.as_raw(), g.width(), g.height(), ExtendedColorType::L8).ok()?
        }
        other => {
            let rgb = other.to_rgb8();
            encoder.write_image(rgb.as_raw(), rgb.width(), rgb.height(), ExtendedColorType::Rgb8).ok()?;
        }
    }
    Some(out.into_inner())
}

pub fn compress_images(
    doc: &mut Document,
    settings: ImageSettings,
    on_image: &mut dyn FnMut(usize, usize) -> bool,
) -> Result<(u64, u64), Cancelled> {
    let max_side = ((longest_page_side(doc) / 72.0) * settings.dpi).ceil().max(16.0) as u32;
    let masks = mask_ids(doc);
    let is_image = |o: &Object| {
        matches!(o, Object::Stream(s)
        if s.dict.get(b"Subtype").ok().and_then(|o| o.as_name().ok()) == Some(b"Image".as_slice()))
    };
    let ids: Vec<_> =
        doc.objects.iter().filter(|(id, o)| !masks.contains(id) && is_image(o)).map(|(id, _)| *id).collect();

    let mut original_total: u64 = 0;
    let mut compressed_total: u64 = 0;
    let total = ids.len();
    for (done, id) in ids.into_iter().enumerate() {
        if !on_image(done, total) {
            return Err(Cancelled);
        }
        let Some(Object::Stream(stream)) = doc.objects.get_mut(&id) else { continue };
        let Some(mut img) = decode_picture(stream, max_side) else { continue };
        let original_size = stream.content.len() as u64;
        original_total += original_size;

        if img.width().max(img.height()) > max_side {
            let k = f64::from(max_side) / f64::from(img.width().max(img.height()));
            let nw = ((f64::from(img.width()) * k).round() as u32).max(1);
            let nh = ((f64::from(img.height()) * k).round() as u32).max(1);
            img = img.resize_exact(nw, nh, image::imageops::FilterType::Triangle);
        }
        match encode_jpeg(&img, settings.quality) {
            Some(bytes) if (bytes.len() as u64) < original_size => {
                compressed_total += bytes.len() as u64;
                stream.dict.set("Filter", Object::Name(b"DCTDecode".to_vec()));
                stream.dict.remove(b"DecodeParms");
                stream.dict.set("Width", i64::from(img.width()));
                stream.dict.set("Height", i64::from(img.height()));
                stream.dict.set("BitsPerComponent", 8);
                // A JPEG 2000 picture may leave these to its codestream; a JPEG one may not.
                let space: &[u8] = if matches!(img, DynamicImage::ImageLuma8(_)) { b"DeviceGray" } else { b"DeviceRGB" };
                stream.dict.set("ColorSpace", Object::Name(space.to_vec()));
                stream.dict.remove(b"SMaskInData");
                stream.set_content(bytes);
                stream.allows_compression = false;
            }
            _ => compressed_total += original_size,
        }
    }
    Ok((original_total, compressed_total))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cancelled;

pub fn compress_streams(doc: &mut Document) {
    doc.compress();
}

pub fn strip_metadata(doc: &mut Document) {
    let info_id = doc.trailer.get(b"Info").and_then(|o| o.as_reference()).ok();
    if let Some(id) = info_id {
        doc.objects.remove(&id);
    }
    doc.trailer.remove(b"Info");

    let catalog_id = doc.trailer.get(b"Root").and_then(|o| o.as_reference()).ok();
    if let Some(cid) = catalog_id {
        let meta_id = doc
            .objects
            .get(&cid)
            .and_then(|o| o.as_dict().ok())
            .and_then(|d| d.get(b"Metadata").ok())
            .and_then(|m| m.as_reference().ok());
        if let Some(mid) = meta_id {
            doc.objects.remove(&mid);
            if let Some(obj) = doc.objects.get_mut(&cid) {
                if let Ok(dict) = obj.as_dict_mut() {
                    dict.remove(b"Metadata");
                }
            }
        }
    }

    let page_ids: Vec<_> = doc.get_pages().into_values().collect();
    for page_id in page_ids {
        if let Some(obj) = doc.objects.get_mut(&page_id) {
            if let Ok(dict) = obj.as_dict_mut() {
                dict.remove(b"Thumb");
            }
        }
    }
}

pub fn prune_dead_objects(doc: &mut Document) {
    doc.prune_objects();
    doc.delete_zero_length_streams();
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Stream};

    fn flate(mut dict: lopdf::Dictionary, raw: &[u8]) -> Stream {
        use std::io::Write;
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        z.write_all(raw).unwrap();
        dict.set("Filter", "FlateDecode");
        Stream::new(dict, z.finish().unwrap())
    }

    #[test]
    fn decodes_flate_gray_and_rgb_pictures() {
        let gray = flate(
            dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8, "Width" => 2, "Height" => 2 },
            &[0, 64, 128, 255],
        );
        assert_eq!(decode_picture(&gray, u32::MAX).unwrap().width(), 2);
        let rgb = flate(
            dictionary! { "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8, "Width" => 1, "Height" => 2 },
            &[255, 0, 0, 0, 255, 0],
        );
        assert_eq!(decode_picture(&rgb, u32::MAX).unwrap().height(), 2);
    }

    #[test]
    fn leaves_pictures_it_cannot_rewrite() {
        let short = flate(
            dictionary! { "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8, "Width" => 4, "Height" => 4 },
            &[1, 2, 3],
        );
        assert!(decode_picture(&short, u32::MAX).is_none());
        let cmyk = flate(
            dictionary! { "ColorSpace" => "DeviceCMYK", "BitsPerComponent" => 8, "Width" => 1, "Height" => 1 },
            &[0, 0, 0, 0],
        );
        assert!(decode_picture(&cmyk, u32::MAX).is_none());
        let mask = flate(
            dictionary! { "ImageMask" => true, "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8, "Width" => 1, "Height" => 1 },
            &[0],
        );
        assert!(decode_picture(&mask, u32::MAX).is_none());
        let one_bit = flate(
            dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 1, "Width" => 8, "Height" => 1 },
            &[0],
        );
        assert!(decode_picture(&one_bit, u32::MAX).is_none());
    }

    fn jpx(name: &str, dict: lopdf::Dictionary) -> Stream {
        let mut dict = dict;
        dict.set("Type", "XObject");
        dict.set("Subtype", "Image");
        dict.set("Filter", "JPXDecode");
        let data = std::fs::read(crate::test_util::fixture(name)).unwrap();
        let mut s = Stream::new(dict, data);
        s.allows_compression = false;
        s
    }

    #[test]
    fn decodes_jpeg_2000_pictures_whose_colours_it_can_keep() {
        // Colour space and depth left to the codestream, as JPXDecode allows.
        let img = decode_picture(&jpx("red-8.jp2", dictionary! { "Width" => 8, "Height" => 8 }), u32::MAX).unwrap();
        assert_eq!((img.width(), img.height()), (8, 8));
        let p = img.to_rgb8().get_pixel(4, 4).0;
        assert!(p[0] > 200 && p[1] < 40 && p[2] < 40, "{p:?}");

        let says_gray = dictionary! { "ColorSpace" => "DeviceGray", "Width" => 8, "Height" => 8 };
        assert!(decode_picture(&jpx("red-8.jp2", says_gray), u32::MAX).is_none());
        let own_mask = dictionary! { "SMaskInData" => 1, "Width" => 8, "Height" => 8 };
        assert!(decode_picture(&jpx("red-8.jp2", own_mask), u32::MAX).is_none());
        let garbage = Stream::new(dictionary! { "Filter" => "JPXDecode", "Width" => 8, "Height" => 8 }, vec![0; 32]);
        assert!(decode_picture(&garbage, u32::MAX).is_none());
    }

    #[test]
    fn a_jpeg_2000_picture_becomes_a_jpeg_with_an_explicit_colour_space() {
        let mut doc = Document::with_version("1.5");
        let image = doc.add_object(jpx("noise-48.jp2", dictionary! { "Width" => 48, "Height" => 48, "SMaskInData" => 0 }));
        let content = doc.add_object(Stream::new(dictionary! {}, b"q 48 0 0 48 0 0 cm /Im0 Do Q".to_vec()));
        let pages = doc.new_object_id();
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages, "MediaBox" => vec![0.into(), 0.into(), 48.into(), 48.into()],
            "Contents" => content, "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image } },
        });
        doc.objects.insert(pages, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }));
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        doc.trailer.set("Root", catalog);

        let (before, after) = compress_images(&mut doc, BALANCED, &mut |_, _| true).unwrap();
        assert!(after < before, "{before} -> {after}");
        let dict = &doc.get_object(image).unwrap().as_stream().unwrap().dict;
        assert_eq!(dict.get(b"Filter").unwrap().as_name().unwrap(), b"DCTDecode");
        assert_eq!(dict.get(b"ColorSpace").unwrap().as_name().unwrap(), b"DeviceRGB");
        assert!(!dict.has(b"SMaskInData"));
    }

    #[test]
    fn a_filter_array_of_one_counts_as_that_filter() {
        let d = dictionary! { "Filter" => vec![Object::Name(b"DCTDecode".to_vec())] };
        assert_eq!(single_filter(&d).as_deref(), Some(b"DCTDecode".as_slice()));
        let two = dictionary! { "Filter" => vec![Object::Name(b"A".to_vec()), Object::Name(b"B".to_vec())] };
        assert_eq!(single_filter(&two), None);
    }

    #[test]
    fn a_document_without_pages_uses_a4_and_loses_its_metadata() {
        let mut doc = Document::with_version("1.7");
        assert_eq!(longest_page_side(&doc), 842.0);
        let info = doc.add_object(dictionary! { "Title" => Object::string_literal("secret") });
        let meta = doc.add_object(Stream::new(dictionary! { "Type" => "Metadata" }, b"<x/>".to_vec()));
        let pages = doc.add_object(dictionary! { "Type" => "Pages", "Kids" => vec![], "Count" => 0 });
        let root = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages, "Metadata" => meta });
        doc.trailer.set("Root", root);
        doc.trailer.set("Info", info);
        strip_metadata(&mut doc);
        assert!(doc.trailer.get(b"Info").is_err());
        assert!(!doc.objects.contains_key(&meta));
        assert!(doc.get_dictionary(root).unwrap().get(b"Metadata").is_err());
    }
}
