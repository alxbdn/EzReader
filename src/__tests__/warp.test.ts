import { describe, expect, it } from "vitest";
import { affine3, apply3, contentBounds, invert3, mul3, squareToQuad, straightenMap, warpToRect, type Pixels } from "../warp";

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