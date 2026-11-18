import { describe, expect, it } from "vitest";
import { joinGlyphs, type Box, type Glyph } from "../highlight-text";

const glyphs = (text: string, left: number, top: number, w = 6, h = 12): Glyph[] =>
  [...text].map((c, i) => ({ text: c, box: { left: left + i * w, top, right: left + (i + 1) * w, bottom: top + h } }));

describe("joinGlyphs", () => {
  it("keeps only the characters under the highlight", () => {
    const line = glyphs("String motDePasse", 0, 0);
    const box: Box = { left: 42, top: 0, right: 102, bottom: 12 };
    expect(joinGlyphs(line, [box])).toBe("motDePasse");
  });

  it("puts a line break between lines and a space across gaps", () => {
    const all = [...glyphs("foo", 0, 0), ...glyphs("bar", 40, 0), ...glyphs("baz", 0, 20)];
    const boxes: Box[] = [{ left: 0, top: 0, right: 60, bottom: 12 }, { left: 0, top: 20, right: 60, bottom: 32 }];
    expect(joinGlyphs(all, boxes)).toBe("foo bar\nbaz");
  });

  it("returns nothing when no character is covered", () => {
    expect(joinGlyphs(glyphs("abc", 0, 0), [{ left: 100, top: 100, right: 120, bottom: 120 }])).toBe("");
  });
});
