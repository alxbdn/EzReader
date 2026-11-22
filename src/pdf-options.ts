import { PDFJS_ASSETS_DIR, type PdfjsAssetDir } from "./pdf-assets";

/**
 * Absolute, because pdf.js fetches some of these from inside its worker, whose base URL is the
 * worker script's and not the page's.
 */
const assetUrl = (dir: PdfjsAssetDir) =>
  typeof document === "undefined" ? undefined : new URL(`${PDFJS_ASSETS_DIR}${dir}/`, document.baseURI).href;

export const SAFE_PDF = {
  isEvalSupported: false,
  wasmUrl: assetUrl("wasm"),
  cMapUrl: assetUrl("cmaps"),
  cMapPacked: true,
  standardFontDataUrl: assetUrl("standard_fonts"),
  iccUrl: assetUrl("iccs"),
} as const;
