import { describe, expect, it } from "vitest";
import { backgroundColorFrom, matchPdfFont, textColorFrom } from "../font-match";

describe("matchPdfFont", () => {
  const installed = ["Arial", "Calibri", "Times New Roman", "Georgia"];

  it("finds an installed system font behind a subset tag and PostScript suffixes", () => {
    expect(matchPdfFont({ name: "ABCDEF+TimesNewRomanPS-BoldItalicMT" }, installed))
      .toEqual({ fontFamily: "times", fontName: "Times New Roman", bold: true, italic: true });
    expect(matchPdfFont({ name: "QWERTY+Calibri" }, installed))
      .toEqual({ fontFamily: "helvetica", fontName: "Calibri", bold: false, italic: false });
    expect(matchPdfFont({ name: "Arial,Bold" }, installed))
      .toEqual({ fontFamily: "helvetica", fontName: "Arial", bold: true, italic: false });
  });

  it("falls back to the built-in family when the font is not installed", () => {
    expect(matchPdfFont({ name: "Cambria-Italic" }, installed))
      .toEqual({ fontFamily: "times", fontName: null, bold: false, italic: true });
    expect(matchPdfFont({ name: "Courier-Oblique" }, installed))
      .toEqual({ fontFamily: "courier", fontName: null, bold: false, italic: true });
    expect(matchPdfFont({ name: "Helvetica" }, installed).fontFamily).toBe("helvetica");
  });

  it("uses the font flags and pdf.js's generic family for unknown fonts", () => {
    expect(matchPdfFont({ name: "XYZABC+F1", bold: true, generic: "serif" }, installed))
      .toEqual({ fontFamily: "times", fontName: null, bold: true, italic: false });
    expect(matchPdfFont({ generic: "monospace" }, installed).fontFamily).toBe("courier");
    expect(matchPdfFont({}, installed)).toEqual({ fontFamily: "helvetica", fontName: null, bold: false, italic: false });
  });
});

describe("textColorFrom", () => {
  const px = (...cs: [number, number, number][]) => new Uint8ClampedArray(cs.flatMap(([r, g, b]) => [r, g, b, 255]));
  const white = { r: 255, g: 255, b: 255 };

  it("picks the commonest colour that stands out from the background", () => {
    const c = textColorFrom(px([255, 255, 255], [255, 255, 255], [200, 30, 30], [200, 30, 30], [120, 120, 120]), white);
    expect(Math.abs(c.r - 200)).toBeLessThan(8);
    expect(Math.abs(c.g - 30)).toBeLessThan(8);
  });

  it("snaps near-black to black and falls back to black with no ink", () => {
    expect(textColorFrom(px([10, 10, 12], [10, 10, 12]), white)).toEqual({ r: 0, g: 0, b: 0 });
    expect(textColorFrom(px([255, 255, 255]), white)).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe("matchPdfFont with the newer fonts", () => {
  it("knows Calibri Light, Aptos and Myriad Pro", () => {
    const installed = ["Calibri Light", "Aptos", "Myriad Pro"];
    expect(matchPdfFont({ name: "ABCDEF+CalibriLight" }, installed).fontName).toBe("Calibri Light");
    expect(matchPdfFont({ name: "Aptos-Bold" }, installed)).toMatchObject({ fontName: "Aptos", bold: true });
    expect(matchPdfFont({ name: "MyriadPro-Regular" }, installed).fontName).toBe("Myriad Pro");
  });
});

describe("backgroundColorFrom", () => {
  const px = (...cs: [number, number, number][]) => new Uint8ClampedArray(cs.flatMap(([r, g, b]) => [r, g, b, 255]));
  const many = (n: number, c: [number, number, number]) => Array.from({ length: n }, () => c);

  it("takes the cell colour behind the glyphs, not the ink", () => {
    const orange: [number, number, number] = [244, 177, 131];
    const c = backgroundColorFrom(px(...many(30, orange), ...many(10, [0, 0, 0]), [120, 90, 70], [200, 140, 100]));
    expect(c).toEqual({ r: 244, g: 177, b: 131 });
  });

  it("averages slightly noisy background pixels", () => {
    const c = backgroundColorFrom(px([168, 208, 141], [170, 209, 142], [169, 210, 140], [0, 0, 0]));
    expect(Math.abs(c.r - 169)).toBeLessThanOrEqual(1);
    expect(Math.abs(c.g - 209)).toBeLessThanOrEqual(1);
  });

  it("falls back to white when nothing is opaque", () => {
    expect(backgroundColorFrom(new Uint8ClampedArray([10, 10, 10, 0]))).toEqual({ r: 255, g: 255, b: 255 });
  });
});
