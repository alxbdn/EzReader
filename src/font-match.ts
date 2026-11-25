import { SYSTEM_FONTS, type FontFamilyValue } from "./models";

/** What the PDF says about the font a run of text is drawn with. */
export interface PdfFontFacts {
  /** The PDF's BaseFont, e.g. "ABCDEF+TimesNewRomanPS-BoldItalicMT"; may be missing. */
  name?: string | null;
  bold?: boolean;
  italic?: boolean;
  /** pdf.js's generic family for the run: "serif", "sans-serif" or "monospace". */
  generic?: string | null;
}

/** The text tool settings closest to a PDF font. */
export interface MatchedFont {
  fontFamily: FontFamilyValue;
  /** An installed system font to write with, or null for the built-in family. */
  fontName: string | null;
  bold: boolean;
  italic: boolean;
}

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Drops the subset tag ("ABCDEF+") and the PostScript suffixes ("MT", "PS"). */
function baseName(name: string): { family: string; style: string } {
  const bare = name.replace(/^[A-Z]{6}\+/, "");
  const cut = bare.search(/[-,]/);
  let family = cut === -1 ? bare : bare.slice(0, cut);
  const style = cut === -1 ? "" : bare.slice(cut + 1);
  family = family.replace(/(PSMT|PS|MT)$/, "");
  return { family, style };
}

const BASE14: [RegExp, FontFamilyValue][] = [
  [/^(helvetica|arial)/, "helvetica"],
  [/^times/, "times"],
  [/^courier/, "courier"],
];

/**
 * Matches a PDF font to the text tool's fonts: an installed system font when its name
 * is one we know, otherwise the nearest built-in family. Bold and italic come from the
 * font's flags or its name ("Arial-BoldItalicMT").
 */
export function matchPdfFont(facts: PdfFontFacts, installed: readonly string[]): MatchedFont {
  const { family, style } = baseName(facts.name ?? "");
  const bold = !!facts.bold || /bold|black|heavy|demi/i.test(style);
  const italic = !!facts.italic || /italic|oblique/i.test(style);
  const key = squash(family);

  const known = key ? SYSTEM_FONTS.find((f) => squash(f.name) === key) : undefined;
  if (known && installed.includes(known.name)) {
    return { fontFamily: known.fallback, fontName: known.name, bold, italic };
  }
  if (known) return { fontFamily: known.fallback, fontName: null, bold, italic };
  for (const [re, fam] of BASE14) if (re.test(key)) return { fontFamily: fam, fontName: null, bold, italic };

  const generic = facts.generic ?? "";
  if (/mono|courier/i.test(generic) || /mono|consol|code/i.test(key)) return { fontFamily: "courier", fontName: null, bold, italic };
  if (/serif/i.test(generic) && !/sans/i.test(generic)) return { fontFamily: "times", fontName: null, bold, italic };
  return { fontFamily: "helvetica", fontName: null, bold, italic };
}

/**
 * The colour behind text, from the pixels inside its own box: the most common colour there.
 * Glyphs cover only a small part of their box, so the cell or page colour wins even when
 * the neighbouring rows or cells are another colour. Falls back to white.
 */
export function backgroundColorFrom(pixels: Uint8ClampedArray): { r: number; g: number; b: number } {
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    // Quantise a little so dithering and JPEG noise vote together.
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let bin = counts.get(key);
    if (!bin) { bin = { n: 0, r: 0, g: 0, b: 0 }; counts.set(key, bin); }
    bin.n++; bin.r += r; bin.g += g; bin.b += b;
    if (!best || bin.n > best.n) best = bin;
  }
  if (!best) return { r: 255, g: 255, b: 255 };
  return { r: Math.round(best.r / best.n), g: Math.round(best.g / best.n), b: Math.round(best.b / best.n) };
}

/**
 * The colour text is drawn in, from the pixels inside its box: the most common colour
 * that is clearly not the background. Falls back to black.
 */
export function textColorFrom(pixels: Uint8ClampedArray, background: { r: number; g: number; b: number }): { r: number; g: number; b: number } {
  const counts = new Map<number, number>();
  let best = -1, bestN = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const d = Math.abs(r - background.r) + Math.abs(g - background.g) + Math.abs(b - background.b);
    if (d < 180) continue;
    // Quantise a little so anti-aliased edges vote with the glyph's core colour.
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > bestN) { bestN = n; best = key; }
  }
  if (best < 0) return { r: 0, g: 0, b: 0 };
  const expand = (v: number): number => Math.min(255, (v << 3) + 4);
  const c = { r: expand(best >> 10), g: expand((best >> 5) & 31), b: expand(best & 31) };
  // Snap near-black and near-white to the exact value: most documents use them.
  if (c.r < 24 && c.g < 24 && c.b < 24) return { r: 0, g: 0, b: 0 };
  return c;
}
