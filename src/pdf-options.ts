import { PDFJS_WASM_DIR } from "./pdf-wasm";

/**
 * Absolute, because pdf.js fetches some modules from inside its worker, whose base URL is the
 * worker script's and not the page's.
 */
const wasmUrl = typeof document === "undefined" ? undefined : new URL(PDFJS_WASM_DIR, document.baseURI).href;

export const SAFE_PDF = { isEvalSupported: false, wasmUrl } as const;
