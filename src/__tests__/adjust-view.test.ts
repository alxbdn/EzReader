import { describe, expect, it } from "vitest";
import { changesPage, mirrorRect, type PageSetting } from "../adjust-view";

const base = (): PageSetting => ({
  page: 1, mode: "crop", crop: { l: 0, t: 0, r: 1, b: 1 }, flipH: false, flipV: false,
  quad: [[0, 0], [1, 0], [1, 1], [0, 1]],
});

describe("adjust view settings", () => {
  it("an untouched page changes nothing", () => {
    expect(changesPage(base())).toBe(false);
    expect(changesPage({ ...base(), mode: "straighten" })).toBe(false);
  });

  it("a crop, a flip or a moved corner changes the page", () => {
    expect(changesPage({ ...base(), crop: { l: 0.1, t: 0, r: 1, b: 1 } })).toBe(true);
    expect(changesPage({ ...base(), flipV: true })).toBe(true);
    expect(changesPage({ ...base(), mode: "straighten", quad: [[0.05, 0], [1, 0], [1, 1], [0, 1]] })).toBe(true);
  });

  it("only the active mode counts", () => {
    expect(changesPage({ ...base(), mode: "straighten", flipH: true })).toBe(false);
  });

  it("mirrors a box with the page", () => {
    const box = { l: 0.1, t: 0.2, r: 0.5, b: 0.6 };
    expect(mirrorRect(box, false, false)).toEqual(box);
    const h = mirrorRect(box, true, false);
    expect(h.l).toBeCloseTo(0.5); expect(h.r).toBeCloseTo(0.9); expect(h.t).toBeCloseTo(0.2);
    const v = mirrorRect(box, false, true);
    expect(v.t).toBeCloseTo(0.4); expect(v.b).toBeCloseTo(0.8); expect(v.l).toBeCloseTo(0.1);
  });
});
