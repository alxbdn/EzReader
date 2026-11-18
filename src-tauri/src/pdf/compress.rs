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

fn decode_picture(stream: &lopdf::Stream) -> Option<DynamicImage> {
    let dict = &stream.dict;
    let int = |k: &[u8]| dict.get(k).ok().and_then(|o| o.as_i64().ok());
    if dict.get(b"ImageMask").ok().and_then(|o| o.as_bool().ok()) == Some(true) || dict.has(b"Decode") {
        return None;
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
    match single_filter(dict)?.as_slice() {
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
        let Some(mut img) = decode_picture(stream) else { continue };
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
