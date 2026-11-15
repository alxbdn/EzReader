# Text-recognition models (Linux)

Built into the Linux app by `src/rapid_ocr.rs` (`include_bytes!`), so text
recognition works offline with nothing to install. Windows uses the OCR engine
built into Windows instead and does not include these files.

| File | Model | Source | SHA-256 |
|---|---|---|---|
| `det.onnx` | PP-OCRv3 mobile text detection (English/Latin), as shipped by RapidOCR | https://huggingface.co/SWHL/RapidOCR/blob/main/PP-OCRv4/en_PP-OCRv3_det_infer.onnx | `f139598bc2af4e4b6fe98dec11574e30edfdd91fc94ac1425c18ace3bd5a866b` |
| `rec.onnx` | PP-OCRv5 mobile Latin text recognition (32 languages) | https://huggingface.co/monkt/paddleocr-onnx/blob/main/languages/latin/rec.onnx | `614ffc2d6d3902d360fad7f1b0dd455ee45e877069d14c4e51a99dc4ef144409` |
| `dict.txt` | Its character list (`ppocrv5_latin_dict.txt`) | https://huggingface.co/monkt/paddleocr-onnx/blob/main/languages/latin/dict.txt | `3c0a8a79b612653c25f765271714f71281e4e955962c153e272b7b8c1d2b13ff` |

The models come from [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)
(Apache-2.0), converted to ONNX.
