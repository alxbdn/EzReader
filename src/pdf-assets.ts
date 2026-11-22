/**
 * Data files pdf.js fetches at run time. Without them it silently degrades:
 * - wasm: JPEG 2000 (JPXDecode), JBIG2 and ICC decoders; scanned books render as blank pages.
 * - cmaps: CJK text in PDFs that do not embed their fonts goes missing or garbled.
 * - standard_fonts: non-embedded Helvetica/Times/Courier/Symbol fall back to whatever the system has.
 * - iccs: the CMYK profile used for print-ready colours.
 *
 * The build copies them from pdfjs-dist to `dist/pdfjs/<dir>/` (see vite.config.ts).
 * QuickJS (pdf.js scripting) is deliberately left out of `wasm`: a PDF's JavaScript must never run.
 */
export const PDFJS_ASSETS_DIR = "pdfjs/";

export const PDFJS_ASSETS = {
  wasm: ["openjpeg.wasm", "jbig2.wasm", "qcms_bg.wasm"],
  cmaps: "*.bcmap",
  standard_fonts: "*",
  iccs: ["CGATS001Compat-v2-micro.icc"],
} as const satisfies Record<string, readonly string[] | "*" | "*.bcmap">;

export type PdfjsAssetDir = keyof typeof PDFJS_ASSETS;

/** Picks the files of one pdfjs-dist directory that the app ships. */
export function shippedFiles(dir: PdfjsAssetDir, available: readonly string[]): string[] {
  const rule = PDFJS_ASSETS[dir];
  if (rule === "*") return [...available];
  if (rule === "*.bcmap") return available.filter((name) => name.endsWith(".bcmap"));
  return (rule as readonly string[]).filter((name) => available.includes(name));
}
