/**
 * pdf.js decodes JPEG 2000 (JPXDecode), JBIG2 and ICC colour profiles with WebAssembly modules
 * that it fetches at run time from `wasmUrl`. Without them those images are skipped and scanned
 * books (Internet Archive scans are JPEG 2000 + JBIG2 on every page) render as blank pages.
 *
 * The build copies these files from pdfjs-dist/wasm to `dist/${PDFJS_WASM_DIR}` (see vite.config.ts).
 * QuickJS (pdf.js scripting) is deliberately left out: a PDF's JavaScript must never run.
 */
export const PDFJS_WASM_DIR = "pdfjs-wasm/";
export const PDFJS_WASM_FILES = ["openjpeg.wasm", "jbig2.wasm", "qcms_bg.wasm"] as const;
