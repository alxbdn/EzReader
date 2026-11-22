import { describe, expect, it } from "vitest";
import { matchPdfFont, textColorFrom } from "../font-match";

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
