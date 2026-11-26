import { describe, expect, it } from "vitest";
import { cutOut, fitScale, hasTransparency, paperColor, recolor, visibleBounds, type Pixels } from "../stamp-maker";
import { StampStore } from "../stamp-store";
import { pictureKind, stampName } from "../stamp-maker-modal";
import { defaultScope, scopePages } from "../adjust-view";

function picture(w: number, h: number, fill: number[], ink?: { color: number[]; inside: (x: number, y: number) => boolean }): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = ink && ink.inside(x, y) ? ink.color : fill;
      data.set(c.length === 4 ? c : [...c, 255], (y * w + x) * 4);
    }
  }
  return { data, width: w, height: h };
}

const at = (px: Pixels, x: number, y: number) => [...px.data.slice((y * px.width + x) * 4, (y * px.width + x) * 4 + 4)];
const square = (x: number, y: number) => x >= 8 && x < 12 && y >= 8 && y < 12;

describe("stamp maker", () => {
  it("finds the paper colour on the edges, whatever the ink in the middle", () => {
    const px = picture(20, 20, [240, 232, 214], { color: [30, 60, 200], inside: square });
    expect(paperColor(px)).toEqual({ r: 240, g: 232, b: 214 });
  });

  it("finds no paper on a picture that is already see-through", () => {
    const px = picture(20, 20, [0, 0, 0, 0], { color: [30, 60, 200, 255], inside: square });
    expect(paperColor(px)).toBeNull();
    expect(hasTransparency(px)).toBe(true);
    expect(hasTransparency(picture(20, 20, [255, 255, 255]))).toBe(false);
  });

  it("makes the paper transparent and keeps the ink", () => {
    const px = picture(20, 20, [240, 232, 214], { color: [30, 60, 200], inside: square });
    cutOut(px, paperColor(px)!, 50);
    expect(at(px, 0, 0)[3]).toBe(0);
    expect(at(px, 10, 10)).toEqual([30, 60, 200, 255]);
  });

  it("keeps light ink at a low strength and drops it at a high one", () => {
    const light = { color: [200, 200, 235], inside: square };
    const weak = picture(20, 20, [255, 255, 255], light);
    cutOut(weak, { r: 255, g: 255, b: 255 }, 0);
    expect(at(weak, 10, 10)[3]).toBe(255);
    const strong = picture(20, 20, [255, 255, 255], light);
    cutOut(strong, { r: 255, g: 255, b: 255 }, 100);
    expect(at(strong, 10, 10)[3]).toBe(0);
  });

  it("unmixes half-faded pixels from the paper, so no light halo is left", () => {
    const px = picture(1, 1, [190, 190, 230]);
    cutOut(px, { r: 255, g: 255, b: 255 }, 50);
    const [r, g, b, a] = at(px, 0, 0);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(255);
    expect(r).toBeLessThan(190);
    expect(b).toBeLessThanOrEqual(255);
    expect(g).toBe(r);
  });

  it("recolours the ink and keeps its transparency", () => {
    const px = picture(2, 1, [0, 0, 0, 0], { color: [30, 60, 200, 128], inside: (x) => x === 1 });
    recolor(px, { r: 220, g: 38, b: 38 });
    expect(at(px, 1, 0)).toEqual([220, 38, 38, 128]);
    expect(at(px, 0, 0)[3]).toBe(0);
  });

  it("keeps the drawing of a picture when recolouring it", () => {
    // An orange tile with a white sign in it: the tile takes the colour, the sign fades out.
    const px = picture(10, 10, [230, 80, 30, 255], { color: [255, 255, 255, 255], inside: (x, y) => x >= 4 && x < 6 && y >= 4 && y < 6 });
    recolor(px, { r: 30, g: 60, b: 140 });
    expect(at(px, 0, 0)).toEqual([30, 60, 140, 255]);
    expect(at(px, 5, 5)[3]).toBe(0);
  });

  it("finds the box around what shows", () => {
    expect(visibleBounds(picture(20, 20, [0, 0, 0, 0], { color: [0, 0, 0, 255], inside: square }))).toEqual({ x: 8, y: 8, w: 4, h: 4 });
    expect(visibleBounds(picture(4, 4, [0, 0, 0, 0]))).toBeNull();
  });

  it("brings big pictures down to the stamp size only", () => {
    expect(fitScale(1200, 600)).toBe(0.5);
    expect(fitScale(300, 200)).toBe(1);
  });

  it("tells PNG from JPEG and names the stamp after its file", () => {
    expect(pictureKind("/9j/4AAQ")).toBe("jpeg");
    expect(pictureKind("iVBORw0K")).toBe("png");
    expect(stampName("C:\\Users\\me\\tampon-agence.jpg")).toBe("tampon-agence");
    expect(stampName("/home/me/recu.final.svg")).toBe("recu.final");
  });
});

describe("stamp store", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
  };
  const PNG = "data:image/png;base64,AAAA";

  it("keeps the stamps, newest first, across restarts", () => {
    const storage = memory();
    const a = new StampStore(storage);
    a.add("First", PNG, 1);
    a.add("  Second  ", PNG, 0.5);
    const b = new StampStore(storage);
    expect(b.getAll().map((s) => s.name)).toEqual(["Second", "First"]);
    b.delete(b.getAll()[0]!.id);
    expect(new StampStore(storage).getAll().map((s) => s.name)).toEqual(["First"]);
  });

  it("refuses more than the maximum", () => {
    const s = new StampStore(memory());
    for (let i = 0; i < StampStore.MAX; i++) expect(s.add(`S${i}`, PNG, 1)).not.toBeNull();
    expect(s.full).toBe(true);
    expect(s.add("one too many", PNG, 1)).toBeNull();
  });

  it("drops anything that isn't a PNG stamp when loading", () => {
    const storage = memory();
    storage.setItem(StampStore.KEY, JSON.stringify([
      { id: "a", name: "ok", dataUrl: PNG, ratio: 1 },
      { id: "b", name: "svg", dataUrl: "data:image/svg+xml;base64,AAAA", ratio: 1 },
      { id: "c", name: "broken" },
    ]));
    expect(new StampStore(storage).getAll().map((s) => s.id)).toEqual(["a"]);
  });

  it("gives the stamp back when storage refuses it", () => {
    const s = new StampStore({ getItem: () => null, setItem: () => { throw new Error("quota"); } });
    expect(s.add("x", PNG, 1)).toBeNull();
    expect(s.getAll()).toEqual([]);
  });
});

describe("crop and straighten pages", () => {
  const p = { current: 2, selection: [4, 3], total: 5 };

  it("lists the pages of each choice", () => {
    expect(scopePages("this", p)).toEqual([2]);
    expect(scopePages("selection", p)).toEqual([3, 4]);
    expect(scopePages("all", p)).toEqual([1, 2, 3, 4, 5]);
    expect(scopePages("selection", { ...p, selection: [] })).toEqual([2]);
  });

  it("starts on the selection only when it holds other pages", () => {
    expect(defaultScope(p)).toBe("selection");
    expect(defaultScope({ ...p, selection: [2] })).toBe("this");
    expect(defaultScope({ ...p, selection: [] })).toBe("this");
  });
});
