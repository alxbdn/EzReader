//! PDF compatibility corpus: every file in `tests/corpus/` (and the huge
//! document built here) must open, take annotations and form values, and
//! save without damage, through the same commands the app calls.
//!
//! "Without damage" is checked three ways: lopdf reads the result back with
//! the same pages and the annotations, every stream's `/Length` matches its
//! bytes, and (in CI) `qpdf --check` and pdf.js read each saved file, see
//! `scripts/corpus-check.mjs`. Set `EZREADER_CORPUS_OUT` to a folder to keep
//! the saved files for those checks.
//!
//! `tests/corpus/generate.py` builds the corpus and says what each file is.

use std::path::{Path, PathBuf};
use std::time::Instant;

use lopdf::{dictionary, Document, Object, Stream};

use crate::commands::pdf::{get_page_count, read_annotations, save_annotated_pdf, strip_annotation_streams};
use crate::commands::security::decrypt_pdf;
use crate::pdf::models::Annotation;
use crate::pdf::writer::FormFieldValue;
use crate::test_util::assert_lengths_consistent;

/// The user password of every encrypted file of the corpus. Kept beside the
/// files (written by generate.py): it is fixture data, not a secret.
fn password() -> String {
    std::fs::read_to_string(corpus_dir().join("password.txt")).unwrap().trim().to_string()
}

/// Each corpus file and its page count (as qpdf counts them).
const CORPUS: &[(&str, u32)] = &[
    ("damaged-xref-offsets.pdf", 4),
    ("encrypted-aes-128.pdf", 2),
    ("encrypted-aes-256.pdf", 2),
    ("encrypted-owner-only.pdf", 2),
    ("encrypted-rc4-128.pdf", 2),
    ("encrypted-rc4-40.pdf", 2),
    ("foreign-annotations.pdf", 1),
    ("form-acroform.pdf", 1),
    ("incremental-updates.pdf", 2),
    ("linearized.pdf", 4),
    ("pdf13-ghostscript.pdf", 4),
    ("pdf14-mixed-sizes-rotated.pdf", 4),
    ("pdf15-object-streams.pdf", 4),
    ("pdf20.pdf", 4),
    ("scanned-ccitt-g4.pdf", 1),
    ("scanned-jpeg.pdf", 2),
    ("unicode-links-outlines.pdf", 3),
];

/// Pages of the huge document built by [`huge_document`].
const HUGE_PAGES: u32 = 2000;

fn corpus_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("corpus")
}

/// Where a test's saved files go: `EZREADER_CORPUS_OUT` (kept for the CI
/// checks) or a temp folder of this run, one sub-folder per test.
fn out_dir(test: &str) -> PathBuf {
    let dir = match std::env::var_os("EZREADER_CORPUS_OUT") {
        Some(d) => PathBuf::from(d),
        None => std::env::temp_dir().join(format!("ezreader-corpus-{}", std::process::id())),
    }
    .join(test);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// What the toolbar tools add: one of each common kind, on `page`.
fn annotations(page: u32) -> Vec<Annotation> {
    let json = serde_json::json!([
        { "kind": "rect", "page": page, "x": 60, "y": 80, "width": 120, "height": 60,
          "color": { "r": 229, "g": 57, "b": 53 }, "strokeWidth": 2 },
        { "kind": "ink", "page": page, "x": 200, "y": 80, "width": 80, "height": 40,
          "points": [[200, 80], [240, 120], [280, 90]], "color": { "r": 30, "g": 30, "b": 200 }, "strokeWidth": 3 },
        { "kind": "highlight", "page": page, "x": 60, "y": 200, "width": 200, "height": 14,
          "rects": [{ "x": 60, "y": 200, "width": 200, "height": 14 }], "color": { "r": 255, "g": 235, "b": 59 }, "opacity": 0.4 },
        { "kind": "text", "page": page, "x": 60, "y": 260, "width": 220, "content": "Corpus annoté ✓",
          "color": { "r": 0, "g": 0, "b": 0 }, "fontSize": 14, "bold": false, "italic": false,
          "underline": false, "alignment": "left" },
    ]);
    serde_json::from_value(json).unwrap()
}

/// What the app works on: the file itself, or its unlocked copy when it has
/// a password (see `openProtected` in main.ts).
fn working_copy(src: &Path, out: &Path, name: &str) -> PathBuf {
    let raw = std::fs::read(src).unwrap();
    let needs_password = name.starts_with("encrypted-") && name != "encrypted-owner-only.pdf";
    if !needs_password {
        return src.to_path_buf();
    }
    assert!(raw.windows(8).any(|w| w == b"/Encrypt"), "{name} should be encrypted");
    let plain = out.join(format!("unlocked-{name}"));
    decrypt_pdf(s(src), s(&plain), password()).unwrap_or_else(|e| panic!("{name}: cannot unlock: {e:?}"));
    plain
}

/// Opens, annotates, saves, re-opens and saves again, as a user would.
fn round_trip(name: &str, src: &Path, pages: u32, out: &Path) {
    let stem = name.trim_end_matches(".pdf");
    let input = working_copy(src, out, name);

    // Open: what loadPdf asks the backend.
    assert_eq!(
        get_page_count(s(&input)).unwrap_or_else(|e| panic!("{name}: cannot open: {e:?}")),
        pages,
        "{name}: page count"
    );
    assert!(read_annotations(s(&input)).unwrap().is_empty(), "{name}: no EzReader annotations yet");
    let display = out.join(format!("{stem}.display.pdf"));
    strip_annotation_streams(s(&input), s(&display)).unwrap();

    // Annotate the first and last pages, fill the form, save.
    let mut anns = annotations(1);
    if pages > 1 {
        anns.extend(annotations(pages));
    }
    let fields = if name.starts_with("form-") {
        vec![
            FormFieldValue { name: "nom".into(), value: "Martin".into() },
            FormFieldValue { name: "accepte".into(), value: "true".into() },
            FormFieldValue { name: "pays".into(), value: "Suisse".into() },
        ]
    } else {
        vec![]
    };
    let saved = out.join(format!("{stem}.saved.pdf"));
    save_annotated_pdf(s(&input), s(&saved), anns.clone(), 0, fields)
        .unwrap_or_else(|e| panic!("{name}: save failed: {e:?}"));
    check_saved(name, &input, &saved, pages, anns.len());

    // Saved again with fewer annotations and a rotation: still sound.
    let resaved = out.join(format!("{stem}.resaved.pdf"));
    let fewer = annotations(1);
    save_annotated_pdf(s(&saved), s(&resaved), fewer.clone(), 90, vec![])
        .unwrap_or_else(|e| panic!("{name}: second save failed: {e:?}"));
    check_saved(name, &saved, &resaved, pages, fewer.len());
    let doc = Document::load(&resaved).unwrap();
    for (_, id) in doc.get_pages() {
        let rotate = doc.get_dictionary(id).unwrap().get(b"Rotate").and_then(Object::as_i64).unwrap_or(0);
        assert_eq!(rotate % 90, 0, "{name}: rotation");
    }
    std::fs::remove_file(display).ok();
}

fn check_saved(name: &str, before: &Path, after: &Path, pages: u32, annotation_count: usize) {
    let old = Document::load(before).unwrap();
    let new = Document::load(after).unwrap_or_else(|e| panic!("{name}: saved file does not open: {e}"));
    assert_eq!(new.get_pages().len() as u32, pages, "{name}: saved page count");
    // What EzReader writes must read as written, even from a damaged file:
    // other readers do not all repair a wrong cross-reference table.
    assert_eq!(new.xref_recovery, None, "{name}: the saved file's cross-reference table needed repair");
    assert_eq!(read_annotations(s(after)).unwrap().len(), annotation_count, "{name}: annotations read back");
    assert_lengths_consistent(&s(after));
    // Page sizes and the other viewers' annotations are kept.
    for ((n, a), (_, b)) in old.get_pages().into_iter().zip(new.get_pages()) {
        let size = |d: &Document, id| d.get_dictionary(id).ok().and_then(|p| p.get(b"MediaBox").ok().cloned());
        assert_eq!(format!("{:?}", size(&old, a)), format!("{:?}", size(&new, b)), "{name}: page {n} size");
        let annots = |d: &Document, id| match d.get_dictionary(id).ok().and_then(|p| p.get(b"Annots").ok()) {
            Some(Object::Array(a)) => a.len(),
            Some(Object::Reference(r)) => d.get_object(*r).and_then(Object::as_array).map_or(0, Vec::len),
            _ => 0,
        };
        assert!(annots(&new, b) >= annots(&old, a), "{name}: page {n} lost its links or annotations");
    }
    // No decryption leftovers: an unlocked copy must not keep /Encrypt.
    if name.starts_with("encrypted-") && name != "encrypted-owner-only.pdf" {
        assert!(new.trailer.get(b"Encrypt").is_err(), "{name}: still marked encrypted after unlocking");
    }
}

#[test]
fn every_corpus_file_opens_and_saves_without_damage() {
    let dir = corpus_dir();
    let out = out_dir("files");
    let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.ends_with(".pdf"))
        .collect();
    on_disk.sort();
    let listed: Vec<&str> = CORPUS.iter().map(|(n, _)| *n).collect();
    assert_eq!(on_disk, listed, "every corpus file needs its page count in CORPUS");

    let mut failures = Vec::new();
    for (name, pages) in CORPUS {
        let result = std::panic::catch_unwind(|| round_trip(name, &dir.join(name), *pages, &out));
        if let Err(e) = result {
            let why = e
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default();
            failures.push(format!("{name}: {why}"));
        }
    }
    // Plus the app's older fixture written by an online tool.
    round_trip(
        "objstm-indirect-length.pdf",
        Path::new(&crate::test_util::fixture("objstm-indirect-length.pdf")),
        2,
        &out,
    );
    assert!(failures.is_empty(), "{} corpus file(s) failed:\n{}", failures.len(), failures.join("\n"));
    if std::env::var_os("EZREADER_CORPUS_OUT").is_none() {
        std::fs::remove_dir_all(&out).ok();
    }
}

/// A long report or a scanned book: many pages sharing one picture.
fn huge_document(path: &Path) {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" });
    let w = 600u32;
    let h = 800u32;
    let pixels: Vec<u8> = (0..w * h).map(|i| ((i % w) ^ (i / w)) as u8).collect();
    let mut image = Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => w as i64, "Height" => h as i64,
            "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
        },
        pixels,
    );
    image.compress().unwrap();
    let image = doc.add_object(image);
    let resources = doc.add_object(dictionary! {
        "Font" => dictionary! { "F1" => font }, "XObject" => dictionary! { "Im1" => image },
    });
    let mut kids = Vec::new();
    for n in 1..=HUGE_PAGES {
        let ops = format!("q 300 0 0 400 150 300 cm /Im1 Do Q BT /F1 24 Tf 72 760 Td (Page {n}) Tj ET");
        let mut content = Stream::new(dictionary! {}, ops.into_bytes());
        content.compress().unwrap();
        let content = doc.add_object(content);
        kids.push(Object::Reference(doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            "Contents" => content, "Resources" => resources,
        })));
    }
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => kids, "Count" => HUGE_PAGES as i64,
        }),
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    doc.save(path).unwrap();
}

#[test]
fn a_huge_document_opens_and_saves_in_reasonable_time() {
    let out = out_dir("huge");
    let src = out.join("huge-2000-pages.pdf");
    huge_document(&src);
    let started = Instant::now();
    round_trip("huge-2000-pages.pdf", &src, HUGE_PAGES, &out);
    let took = started.elapsed();
    // Generous (debug build, slow runners): catches a save that went quadratic.
    assert!(took.as_secs() < 120, "huge document round trip took {took:?}");
    if std::env::var_os("EZREADER_CORPUS_OUT").is_none() {
        std::fs::remove_dir_all(&out).ok();
    }
}

/// A filled form reads back as typed, in every reader: values in the fields
/// (accents included), each radio and check box widget in its state, and an
/// appearance drawn for the text fields and the combo box.
#[test]
fn filled_form_reads_back_with_its_appearances() {
    let out = out_dir("filled-form");
    let input = corpus_dir().join("form-acroform.pdf");
    let saved = out.join("form-acroform.filled.pdf");
    let fields = vec![
        FormFieldValue { name: "nom".into(), value: "Lefèvre (Élodie)".into() },
        FormFieldValue { name: "accepte".into(), value: "true".into() },
        FormFieldValue { name: "civilite".into(), value: "mme".into() },
        FormFieldValue { name: "pays".into(), value: "Belgique".into() },
    ];
    save_annotated_pdf(s(&input), s(&saved), vec![], 0, fields).unwrap();
    assert_lengths_consistent(&s(&saved));

    let doc = Document::load(&saved).unwrap();
    let cat = doc.catalog().unwrap();
    let form = doc.dereference(cat.get(b"AcroForm").unwrap()).unwrap().1.as_dict().unwrap();
    let mut seen = 0;
    for f in form.get(b"Fields").unwrap().as_array().unwrap() {
        let field = doc.dereference(f).unwrap().1.as_dict().unwrap();
        let name = match field.get(b"T").unwrap() {
            Object::String(b, _) => String::from_utf8_lossy(b).into_owned(),
            _ => continue,
        };
        let widgets: Vec<&lopdf::Dictionary> = match field.get(b"Kids") {
            Ok(Object::Array(k)) => k.iter().map(|k| doc.dereference(k).unwrap().1.as_dict().unwrap()).collect(),
            _ => vec![field],
        };
        let ap_text = |w: &lopdf::Dictionary| {
            let n = w.get(b"AP").unwrap().as_dict().unwrap().get(b"N").unwrap();
            let mut stream = doc.dereference(n).unwrap().1.as_stream().unwrap().clone();
            stream.decompress().ok();
            String::from_utf8_lossy(&stream.content).into_owned()
        };
        match name.as_str() {
            "nom" => {
                let Object::String(v, _) = field.get(b"V").unwrap() else { panic!() };
                assert_eq!(&v[..2], &[0xFE, 0xFF], "accented value stored as UTF-16");
                assert!(ap_text(widgets[0]).contains("Lef\\350vre \\(\\311lodie\\)"));
                seen += 1;
            }
            "accepte" => {
                assert_ne!(widgets[0].get(b"AS").unwrap().as_name().unwrap(), b"Off");
                seen += 1;
            }
            "civilite" => {
                assert_eq!(field.get(b"V").unwrap().as_name().unwrap(), b"mme");
                let states: Vec<&[u8]> = widgets.iter().map(|w| w.get(b"AS").unwrap().as_name().unwrap()).collect();
                assert_eq!(states, vec![&b"Off"[..], &b"mme"[..]]);
                seen += 1;
            }
            "pays" => {
                assert!(ap_text(widgets[0]).contains("(Belgique) Tj"));
                seen += 1;
            }
            _ => {}
        }
    }
    assert_eq!(seen, 4, "every filled field found");
}
