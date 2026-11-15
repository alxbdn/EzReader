//! Text recognition on Linux: the PaddleOCR models RapidOCR uses (PP-OCR
//! text detection + PP-OCRv5 Latin recognition, ONNX), run by ONNX Runtime
//! linked into the app. The models are built into the binary: nothing to
//! install or download, and nothing leaves the computer.

use crate::ocr::{OcrLine, OcrWord};
use image::{imageops::FilterType, RgbImage};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use std::sync::{Mutex, OnceLock};

const DET_MODEL: &[u8] = include_bytes!("../ocr-models/det.onnx");
const REC_MODEL: &[u8] = include_bytes!("../ocr-models/rec.onnx");
const REC_DICT: &str = include_str!("../ocr-models/dict.txt");

/// Detection: pixels above this are text.
const DET_THRESH: f32 = 0.3;
/// Detection: a region whose mean score is below this is noise.
const BOX_THRESH: f32 = 0.6;
/// Detection: how much a region is grown back (DB shrinks text when training).
const UNCLIP_RATIO: f32 = 1.6;
/// Detection: the picture's long side is kept within this (multiple of 32).
const DET_MAX_SIDE: u32 = 1920;
/// Recognition: height of a line fed to the model.
const REC_HEIGHT: u32 = 48;
/// Recognition: lines read with less confidence are dropped.
const REC_MIN_SCORE: f32 = 0.5;

struct Engine {
    det: Session,
    rec: Session,
    /// Index 0 is the CTC blank; then the dictionary; then the space.
    chars: Vec<String>,
}

fn engine() -> Result<&'static Mutex<Engine>, String> {
    static ENGINE: OnceLock<Result<Mutex<Engine>, String>> = OnceLock::new();
    ENGINE
        .get_or_init(|| {
            let threads = std::thread::available_parallelism().map_or(2, |n| n.get().min(4));
            let env = ort::init().with_name("ezreader-ocr").build().map_err(|e| e.to_string())?;
            let load = |model: &[u8]| -> Result<Session, String> {
                let err = |e: ort::Error<_>| e.to_string();
                Session::builder(&env)
                    .map_err(|e| e.to_string())?
                    .with_optimization_level(GraphOptimizationLevel::Level3)
                    .map_err(err)?
                    .with_intra_threads(threads)
                    .map_err(err)?
                    .commit_from_memory(model)
                    .map_err(|e| e.to_string())
            };
            Ok(Mutex::new(Engine { det: load(DET_MODEL)?, rec: load(REC_MODEL)?, chars: dictionary(REC_DICT) }))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// The model's classes: blank, the dictionary's characters, then the space.
pub(crate) fn dictionary(dict: &str) -> Vec<String> {
    let mut chars = vec![String::new()];
    chars.extend(dict.lines().map(|l| l.trim_end_matches('\r').to_string()));
    chars.push(" ".into());
    chars
}

/// A text region found by detection, in pixels of the picture.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Region {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
}

/// Size the detector sees: within `DET_MAX_SIDE`, both sides multiples of 32.
pub(crate) fn det_size(w: u32, h: u32) -> (u32, u32) {
    let scale = (DET_MAX_SIDE as f32 / w.max(h) as f32).min(1.0);
    let r = |v: u32| (((v as f32 * scale) / 32.0).round() as u32).max(1) * 32;
    (r(w), r(h))
}

/// Text regions of a detection map (`w` × `h` scores, 0 to 1): the connected
/// areas above the threshold, kept when confident enough, grown back by the
/// unclip ratio, as boxes in the map's pixels.
pub(crate) fn regions(map: &[f32], w: usize, h: usize) -> Vec<Region> {
    let mut seen = vec![false; w * h];
    let mut out = Vec::new();
    let mut stack = Vec::new();
    for start in 0..w * h {
        if seen[start] || map[start] <= DET_THRESH {
            continue;
        }
        seen[start] = true;
        stack.push(start);
        let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
        let (mut sum, mut n) = (0f32, 0usize);
        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
            sum += map[i];
            n += 1;
            let mut push = |j: usize| {
                if !seen[j] && map[j] > DET_THRESH {
                    seen[j] = true;
                    stack.push(j);
                }
            };
            if x > 0 { push(i - 1); }
            if x + 1 < w { push(i + 1); }
            if y > 0 { push(i - w); }
            if y + 1 < h { push(i + w); }
        }
        let (bw, bh) = ((x1 - x0 + 1) as f32, (y1 - y0 + 1) as f32);
        if bw.min(bh) < 3.0 || sum / (n as f32) < BOX_THRESH {
            continue;
        }
        // Grow by area × ratio / perimeter, as DB's "unclip" does.
        let d = bw * bh * UNCLIP_RATIO / (2.0 * (bw + bh));
        let grow = |v: usize, by: f32, max: usize, up: bool| -> u32 {
            let v = if up { v as f32 + by } else { v as f32 - by };
            v.round().clamp(0.0, (max - 1) as f32) as u32
        };
        out.push(Region {
            x0: grow(x0, d, w, false),
            y0: grow(y0, d, h, false),
            x1: grow(x1, d, w, true),
            y1: grow(y1, d, h, true),
        });
    }
    // Reading order: top to bottom, then left to right on the same row.
    out.sort_by(|a, b| {
        let same_row = a.y0.abs_diff(b.y0) < (a.y1 - a.y0).min(b.y1 - b.y0) / 2;
        if same_row { a.x0.cmp(&b.x0) } else { a.y0.cmp(&b.y0) }
    });
    out
}

/// A recognized line: its text and, for each character, the model step it
/// was read at (to place the words), with the mean confidence.
#[derive(Debug, PartialEq)]
pub(crate) struct Decoded {
    pub chars: Vec<(String, usize)>,
    pub score: f32,
}

/// Greedy CTC decoding of `steps` × `classes` scores.
pub(crate) fn ctc_decode(probs: &[f32], steps: usize, classes: usize, dict: &[String]) -> Decoded {
    let mut chars = Vec::new();
    let mut scores = Vec::new();
    let mut prev = 0usize;
    for t in 0..steps {
        let row = &probs[t * classes..(t + 1) * classes];
        let (best, p) = row
            .iter()
            .enumerate()
            .fold((0usize, f32::MIN), |acc, (i, &v)| if v > acc.1 { (i, v) } else { acc });
        if best != 0 && best != prev {
            if let Some(c) = dict.get(best) {
                chars.push((c.clone(), t));
                scores.push(p);
            }
        }
        prev = best;
    }
    let score = if scores.is_empty() { 0.0 } else { scores.iter().sum::<f32>() / scores.len() as f32 };
    Decoded { chars, score }
}

/// Splits a decoded line into words with their boxes, in fractions of the
/// picture. The line spans `region` (pixels of a `pw` × `ph` picture) and
/// was read in `steps` model steps across its width.
pub(crate) fn words_of(d: &Decoded, steps: usize, region: Region, pw: u32, ph: u32) -> Vec<OcrWord> {
    let lw = (region.x1 - region.x0 + 1) as f32;
    let step_w = lw / steps.max(1) as f32;
    let mut words = Vec::new();
    let mut cur: Option<(String, usize, usize)> = None;
    let mut flush = |cur: &mut Option<(String, usize, usize)>| {
        if let Some((text, a, b)) = cur.take() {
            let x = region.x0 as f32 + a as f32 * step_w;
            let w = ((b + 1 - a) as f32 * step_w).min(region.x1 as f32 + 1.0 - x);
            words.push(OcrWord {
                text,
                x: x / pw as f32,
                y: region.y0 as f32 / ph as f32,
                w: w.max(1.0) / pw as f32,
                h: (region.y1 - region.y0 + 1) as f32 / ph as f32,
            });
        }
    };
    for (c, t) in &d.chars {
        if c.trim().is_empty() {
            flush(&mut cur);
            continue;
        }
        match &mut cur {
            Some((text, _, end)) => {
                text.push_str(c);
                *end = *t;
            }
            None => cur = Some((c.clone(), *t, *t)),
        }
    }
    flush(&mut cur);
    words
}

/// Detection input: the picture in BGR order, normalized as PaddleOCR does.
fn det_input(img: &RgbImage, w: u32, h: u32) -> Vec<f32> {
    let img = image::imageops::resize(img, w, h, FilterType::Triangle);
    const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
    const STD: [f32; 3] = [0.229, 0.224, 0.225];
    let plane = (w * h) as usize;
    let mut data = vec![0f32; 3 * plane];
    for (i, p) in img.pixels().enumerate() {
        for c in 0..3 {
            data[c * plane + i] = (p[2 - c] as f32 / 255.0 - MEAN[c]) / STD[c];
        }
    }
    data
}

/// Recognition input: one line, `REC_HEIGHT` px high, values in -1..1.
fn rec_input(line: &RgbImage) -> (Vec<f32>, u32) {
    let ratio = line.width() as f32 / line.height().max(1) as f32;
    let w = ((REC_HEIGHT as f32 * ratio).round() as u32).clamp(16, 3200);
    let img = image::imageops::resize(line, w, REC_HEIGHT, FilterType::Triangle);
    let plane = (w * REC_HEIGHT) as usize;
    let mut data = vec![0f32; 3 * plane];
    for (i, p) in img.pixels().enumerate() {
        for c in 0..3 {
            data[c * plane + i] = (p[2 - c] as f32 / 255.0 - 0.5) / 0.5;
        }
    }
    (data, w)
}

fn run(session: &mut Session, shape: [usize; 4], data: Vec<f32>) -> Result<(Vec<usize>, Vec<f32>), String> {
    let input = Tensor::from_array((shape, data.into_boxed_slice())).map_err(|e| e.to_string())?;
    let outputs = session.run(ort::inputs![input]).map_err(|e| e.to_string())?;
    let (shape, values) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
    Ok((shape.iter().map(|&d| d.max(0) as usize).collect(), values.to_vec()))
}

/// Reads the lines of text of a picture.
pub fn read(img: &RgbImage) -> Result<Vec<OcrLine>, String> {
    let (pw, ph) = img.dimensions();
    if pw < 8 || ph < 8 {
        return Ok(Vec::new());
    }
    let mut engine = engine()?.lock().map_err(|e| e.to_string())?;
    let engine = &mut *engine;

    let (dw, dh) = det_size(pw, ph);
    let (shape, map) = run(&mut engine.det, [1, 3, dh as usize, dw as usize], det_input(img, dw, dh))?;
    let (mh, mw) = (shape[shape.len() - 2], shape[shape.len() - 1]);
    let (sx, sy) = (pw as f32 / mw as f32, ph as f32 / mh as f32);

    let mut lines = Vec::new();
    for r in regions(&map, mw, mh) {
        let region = Region {
            x0: (r.x0 as f32 * sx) as u32,
            y0: (r.y0 as f32 * sy) as u32,
            x1: (((r.x1 + 1) as f32 * sx) as u32).min(pw) - 1,
            y1: (((r.y1 + 1) as f32 * sy) as u32).min(ph) - 1,
        };
        let crop = image::imageops::crop_imm(img, region.x0, region.y0, region.x1 - region.x0 + 1, region.y1 - region.y0 + 1).to_image();
        let (data, w) = rec_input(&crop);
        let (shape, probs) = run(&mut engine.rec, [1, 3, REC_HEIGHT as usize, w as usize], data)?;
        let (steps, classes) = (shape[1], shape[2]);
        let decoded = ctc_decode(&probs, steps, classes, &engine.chars);
        if decoded.score < REC_MIN_SCORE {
            continue;
        }
        let words = words_of(&decoded, steps, region, pw, ph);
        if words.is_empty() {
            continue;
        }
        let text = decoded.chars.iter().map(|(c, _)| c.as_str()).collect::<String>().trim().to_string();
        lines.push(OcrLine { text, words });
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dictionary_has_blank_first_and_space_last() {
        let d = dictionary("a\nb\r\n");
        assert_eq!(d, vec!["", "a", "b", " "]);
        assert_eq!(dictionary(REC_DICT).len(), REC_DICT.lines().count() + 2);
    }

    #[test]
    fn detector_sizes_are_multiples_of_32_within_the_limit() {
        assert_eq!(det_size(100, 50), (96, 64));
        let (w, h) = det_size(2400, 1700);
        assert!(w <= DET_MAX_SIDE && w % 32 == 0 && h % 32 == 0);
    }

    #[test]
    fn finds_and_grows_text_regions_in_reading_order() {
        let (w, h) = (40, 20);
        let mut map = vec![0f32; w * h];
        let mut fill = |x0: usize, y0: usize, x1: usize, y1: usize| {
            for y in y0..=y1 { for x in x0..=x1 { map[y * w + x] = 0.9; } }
        };
        fill(22, 4, 35, 7); // right, same row
        fill(2, 4, 15, 7); // left
        fill(2, 12, 15, 15); // next row
        fill(30, 17, 30, 17); // a speck: dropped
        let r = regions(&map, w, h);
        assert_eq!(r.len(), 3);
        assert!(r[0].x0 < 2 && r[0].y0 < 4 && r[0].x1 > 15);
        assert!(r[1].x0 > 15);
        assert!(r[2].y0 > 8);
    }

    #[test]
    fn decodes_ctc_and_places_words() {
        let dict = dictionary("a\nb");
        // classes: blank, a, b, space
        let rows = [[0., 1., 0., 0.], [0., 1., 0., 0.], [1., 0., 0., 0.], [0., 1., 0., 0.], [0., 0., 0., 1.], [0., 0., 1., 0_f32]];
        let probs: Vec<f32> = rows.iter().flatten().copied().collect();
        let d = ctc_decode(&probs, 6, 4, &dict);
        let text: String = d.chars.iter().map(|(c, _)| c.as_str()).collect();
        assert_eq!(text, "aa b");
        assert!((d.score - 1.0).abs() < 1e-6);
        let words = words_of(&d, 6, Region { x0: 0, y0: 10, x1: 59, y1: 19 }, 100, 100);
        assert_eq!(words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(), ["aa", "b"]);
        assert!((words[0].x - 0.0).abs() < 1e-6 && (words[0].w - 0.4).abs() < 1e-6);
        assert!((words[1].x - 0.5).abs() < 1e-6 && (words[1].y - 0.1).abs() < 1e-6);
    }

    #[test]
    fn reads_a_line_of_text() {
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/ocr-hello.png")).unwrap();
        let img = crate::ocr::prepare_rgba(&bytes, 4000).unwrap();
        let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
        let text = read(&rgb).unwrap().iter().map(|l| l.text.clone()).collect::<Vec<_>>().join(" ");
        assert!(text.to_lowercase().contains("hello"), "read: {text}");
    }
}
