export const PDFJS_ASSETS_DIR = "pdfjs/";

export const PDFJS_ASSETS = {
  wasm: ["openjpeg.wasm", "jbig2.wasm", "qcms_bg.wasm"],
  cmaps: "*.bcmap",
  standard_fonts: "*",
  iccs: ["CGATS001Compat-v2-micro.icc"],
} as const satisfies Record<string, readonly string[] | "*" | "*.bcmap">;

export type PdfjsAssetDir = keyof typeof PDFJS_ASSETS;

export function shippedFiles(dir: PdfjsAssetDir, available: readonly string[]): string[] {
  const rule = PDFJS_ASSETS[dir];
  if (rule === "*") return [...available];
  if (rule === "*.bcmap") return available.filter((name) => name.endsWith(".bcmap"));
  return (rule as readonly string[]).filter((name) => available.includes(name));
}
