#![no_main]

libfuzzer_sys::fuzz_target!(|data: &[u8]| ezreader_lib::fuzzing::ocr_image(data));
