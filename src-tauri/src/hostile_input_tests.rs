use proptest::prelude::*;

use crate::commands::compress::{compress_to_bytes, Job};
use crate::commands::files::{load_picture, picture_from_bytes};
use crate::commands::pdf::get_page_count;
use crate::error::ErrorCode;
use crate::test_util::{fixture, tmp};

fn damaged(base: Vec<u8>) -> impl Strategy<Value = Vec<u8>> {
    let len = base.len();
    (
        prop::collection::vec((0..len, any::<u8>()), 1..24),
        prop::option::of(0..len),
        prop::option::of((0..len, prop::collection::vec(any::<u8>(), 1..64))),
    )
        .prop_map(move |(flips, cut, splice)| {
            let mut b = base.clone();
            for (i, v) in flips {
                b[i] = v;
            }
            if let Some((at, junk)) = splice {
                b.splice(at..at, junk);
            }
            if let Some(n) = cut {
                b.truncate(n);
            }
            b
        })
}

fn read(name: &str) -> Vec<u8> {
    std::fs::read(fixture(name)).unwrap()
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 64, ..ProptestConfig::default() })]

    #[test]
    fn a_damaged_pdf_never_panics(bytes in damaged(read("objstm-indirect-length.pdf"))) {
        if let Ok(doc) = lopdf::Document::load_mem(&bytes) {
            let _ = crate::pdf::writer::load_meta(&doc);
            let _ = compress_to_bytes(&doc, None, &Job::silent(), (0.0, 1.0));
        }
        let _ = lopdf::IncrementalDocument::load_mem(&bytes);
    }

    #[test]
    fn a_damaged_picture_never_panics(bytes in damaged(read("ocr-hello.png"))) {
        let _ = picture_from_bytes(&bytes);
        let _ = crate::ocr::prepare_rgba(&bytes, 4096);
    }

    #[test]
    fn random_bytes_are_not_a_pdf_or_a_picture(bytes in prop::collection::vec(any::<u8>(), 0..2048)) {
        let _ = lopdf::Document::load_mem(&bytes);
        let _ = picture_from_bytes(&bytes);
    }
}

#[test]
fn a_file_that_is_not_a_pdf_is_an_error() {
    for (name, bytes) in [("empty.pdf", &b""[..]), ("text.pdf", b"hello"), ("png.pdf", &read("ocr-hello.png"))] {
        let path = tmp(name);
        std::fs::write(&path, bytes).unwrap();
        assert!(get_page_count(path.clone()).is_err(), "{name}");
        let _ = std::fs::remove_file(path);
    }
}

#[test]
fn an_oversized_picture_is_refused_before_reading() {
    let path = tmp("huge.png");
    std::fs::File::create(&path).unwrap().set_len(65 * 1024 * 1024).unwrap();
    assert_eq!(load_picture(path.clone()).unwrap_err().code, ErrorCode::TooLarge);
    let _ = std::fs::remove_file(path);
}

#[test]
fn a_picture_named_like_another_file_is_refused() {
    let path = tmp("script.bat");
    std::fs::write(&path, read("ocr-hello.png")).unwrap();
    assert_eq!(load_picture(path.clone()).unwrap_err().code, ErrorCode::NotAnImage);
    let _ = std::fs::remove_file(path);
}
