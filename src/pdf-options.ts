import { PDFJS_ASSETS_DIR, type PdfjsAssetDir } from "./pdf-assets";

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
