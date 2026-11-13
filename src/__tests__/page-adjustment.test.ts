import { describe, expect, it } from "vitest";
import {
  affine3, apply3, buildPageAdjustments, contentBounds, cropAdjustment, invert3, moveTextRuns, mul3, pageMap,
  reproject, squareToQuad, straightenMap, warpToRect, type AdjustSetting, type DocLike, type Mat3, type Pixels, type ViewportLike,
} from "../page-adjustment";

function blank(w: number, h: number, v = 255): Pixels {
  return { data: new Uint8ClampedArray(w * h * 4).fill(v), width: w, height: h };
}
function paint(p: Pixels, x: number, y: number, v: number): void {
  const i = (y * p.width + x) * 4;
  p.data[i] = p.data[i + 1] = p.data[i + 2] = v;
}

describe("squareToQuad", () => {
  it("sends the square's corners to the quad's", () => {
    const quad: [number, number][] = [[10, 20], [110, 5], [130, 160], [0, 140]];
    const map = squareToQuad(quad as never);
    const corners = [map(0, 0), map(1, 0), map(1, 1), map(0, 1)];
    corners.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(quad[i][0], 6);
      expect(y).toBeCloseTo(quad[i][1], 6);
    });
  });

  it("is a plain scale for a rectangle", () => {
    const map = squareToQuad([[0, 0], [200, 0], [200, 100], [0, 100]]);
    expect(map(0.5, 0.25)).toEqual([100, 25]);
  });
});

describe("warpToRect", () => {
  it("straightens a tilted dark square into the whole picture", () => {
    const src = blank(40, 40);
    const quad: [number, number][] = [[10, 8], [30, 12], [28, 32], [8, 28]];
    // Darken the inside of the quad (roughly).
    for (let y = 12; y < 27; y++) for (let x = 12; x < 27; x++) paint(src, x, y, 0);
    const out = warpToRect(src, quad as never, 20, 20);
    expect(out.width).toBe(20);
    // The middle of the result comes from the dark middle of the quad.
    expect(out.data[(10 * 20 + 10) * 4]).toBeLessThan(30);
    expect(out.data[(10 * 20 + 10) * 4 + 3]).toBe(255);
  });
});

describe("contentBounds", () => {
  it("finds the drawn area, with a small margin", () => {
    const p = blank(100, 200);
    paint(p, 20, 30, 0);
    paint(p, 79, 169, 0);
    const b = contentBounds(p, 40, 0)!;
    expect(b).toEqual({ l: 0.2, t: 0.15, r: 0.8, b: 0.85 });
  });

  it("returns null for a blank page", () => {
    expect(contentBounds(blank(10, 10))).toBeNull();
  });
});

describe("straightenMap", () => {
  const quad: [number, number][] = [[0.1, 0.05], [0.85, 0.12], [0.9, 0.95], [0.05, 0.88]];
  const W = 400, H = 600;

  it("sends the quad's corners to the picture's corners", () => {
    const m = straightenMap(quad as never, W, H);
    const corners = [[0, 0], [W, 0], [W, H], [0, H]];
    quad.forEach(([x, y], i) => {
      const [px, py] = apply3(m, [x * W, y * H]);
      expect(px).toBeCloseTo(corners[i][0], 6);
      expect(py).toBeCloseTo(corners[i][1], 6);
    });
  });

  it("is where warpToRect draws what it samples", () => {
    const m = straightenMap(quad as never, W, H);
    const sample = squareToQuad(quad.map(([x, y]) => [x * W, y * H]) as never);
    for (const [u, v] of [[0.3, 0.4], [0.75, 0.2], [0.5, 0.9]]) {
      const [x, y] = apply3(m, sample(u, v));
      expect(x).toBeCloseTo(u * W, 6);
      expect(y).toBeCloseTo(v * H, 6);
    }
  });

  it("composes with affine transforms", () => {
    const t = affine3([2, 0, 0, -2, 10, 800]);
    const back = mul3(invert3(t), t);
    back.forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0, 0, 1, 0, 0, 0, 1][i], 9));
  });
});

const identity: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

describe("moveTextRuns", () => {
  it("keeps a run in place when nothing moves", () => {
    const runs = moveTextRuns([{ str: "Hello", transform: [12, 0, 0, 12, 72, 700], width: 30, height: 12 }], identity);
    expect(runs).toEqual([{ text: "Hello", x0: 72, y0: 700, x1: 102, y1: 700, size: 12 }]);
  });

  it("scales a run with the page", () => {
    const double: Mat3 = [2, 0, 0, 0, 2, 0, 0, 0, 1];
    const [run] = moveTextRuns([{ str: "Hi", transform: [10, 0, 0, 10, 5, 5], width: 8, height: 10 }], double);
    expect(run).toMatchObject({ x0: 10, y0: 10, x1: 26, y1: 10, size: 20 });
  });

  it("leaves out blank runs", () => {
    expect(moveTextRuns([{ str: "  ", transform: [10, 0, 0, 10, 0, 0], width: 5, height: 10 }], identity)).toEqual([]);
  });
});

describe("pageMap", () => {
  it("sends the quad's corners to the page's corners, in user space", () => {
    // A 100 × 200 pt page rendered at 2× with y pointing down.
    const shown = [2, 0, 0, -2, 0, 400];
    const quad: [number, number][] = [[0.1, 0.1], [0.9, 0.05], [0.95, 0.9], [0.05, 0.95]];
    const m = pageMap(shown, quad as never, 200, 400);
    // Top left of the quad (fraction 0.1, 0.1 of the picture) is user (10, 180).
    const [x, y] = apply3(m, [10, 180]);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(200, 6);
  });
});

// ── Crop / flip conversion ───────────────────────────────────────────────────

/** A pdf.js-like viewport of a `w` × `h` pt page (origin bottom left) shown with `rotation`. */
function viewport(w: number, h: number, rotation: number): ViewportLike {
  const sideways = rotation % 180 !== 0;
  return {
    width: sideways ? h : w,
    height: sideways ? w : h,
    convertToPdfPoint(x, y) {
      switch (rotation) {
        case 90: return [y, x];
        case 180: return [w - x, y];
        case 270: return [w - y, h - x];
        default: return [x, h - y];
      }
    },
  };
}

const setting = (over: Partial<AdjustSetting>): AdjustSetting => ({
  page: 1, mode: "crop", crop: { l: 0, t: 0, r: 1, b: 1 }, flipH: false, flipV: false,
  quad: [[0, 0], [1, 0], [1, 1], [0, 1]], ...over,
});

describe("cropAdjustment", () => {
  it("leaves the box out when the whole page is kept", () => {
    expect(cropAdjustment(setting({ flipH: true }), viewport(600, 800, 0), 0)).toEqual({ page: 1, flipH: true, flipV: false });
  });

  it("turns screen fractions into a PDF user-space box", () => {
    const adj = cropAdjustment(setting({ crop: { l: 0.1, t: 0.25, r: 0.5, b: 1 } }), viewport(600, 800, 0), 0);
    expect(adj.crop).toEqual([60, 0, 300, 600]);
  });

  it("swaps the flips on a page shown sideways", () => {
    const adj = cropAdjustment(setting({ flipH: true }), viewport(600, 800, 90), 90);
    expect(adj).toMatchObject({ flipH: false, flipV: true });
  });

  it("maps the box through the shown rotation", () => {
    // Shown at 90°: the top half on screen is the left half of the page.
    const adj = cropAdjustment(setting({ crop: { l: 0, t: 0, r: 1, b: 0.5 } }), viewport(600, 800, 90), 90);
    expect(adj.crop).toEqual([0, 0, 300, 800]);
  });
});

describe("buildPageAdjustments", () => {
  const doc = (rotate: number): DocLike => ({
    getPage: async () => ({ rotate, getViewport: ({ rotation }) => viewport(600, 800, rotation) }),
  });

  it("adds the view rotation to the page's own /Rotate", async () => {
    const { crops } = await buildPageAdjustments(doc(90), 270, [setting({ flipH: true })]);
    expect(crops[0]).toMatchObject({ flipH: true, flipV: false }); // 90 + 270 = upright
    const turned = await buildPageAdjustments(doc(0), 90, [setting({ flipH: true })]);
    expect(turned.crops[0]).toMatchObject({ flipH: false, flipV: true });
  });

  it("sends straightened pages apart, with their corners", async () => {
    const quad: AdjustSetting["quad"] = [[0.1, 0], [1, 0], [1, 1], [0, 1]];
    const { crops, warps } = await buildPageAdjustments(doc(0), 0, [setting({ page: 2, mode: "straighten", quad }), setting({ page: 3 })]);
    expect(warps).toEqual([{ page: 2, quad }]);
    expect(crops.map((c) => c.page)).toEqual([3]);
  });
});

describe("reproject", () => {
  it("redraws a picture rendered at 90° in the page's own orientation", () => {
    // 100 × 200 pt page, scale 1: upright and turned a quarter.
    const flat = [1, 0, 0, -1, 0, 200];
    const shown = [0, 1, 1, 0, 0, 0];
    const m = reproject(shown, flat);
    const at = (x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    // User-space (10, 20) is at (20, 10) shown and at (10, 180) upright.
    expect(at(20, 10)).toEqual([10, 180]);
  });
});
